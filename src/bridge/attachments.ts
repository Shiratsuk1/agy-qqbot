import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type {
  AppLogger,
  DownloadedAttachment,
  InboundAttachmentItem,
} from '../shared/types.ts';

export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 9;
export const DEFAULT_ATTACHMENT_TIMEOUT_MS = 15_000;

export interface DownloadAttachmentsOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxCount?: number;
  timeoutMs?: number;
  messageId?: string;
  now?: () => number;
  logger?: AppLogger;
}

const MIME_EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function isStrictlyInside(parentDir: string, childPath: string): boolean {
  const rel = relative(parentDir, childPath);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 规范化 QQ 开放平台下发的附件 URL。
 *
 * 兼容平台偶发返回的协议相对路径（`//multimedia.nt.qq.com.cn/...`）或
 * 裸域名路径（`multimedia.nt.qq.com.cn/...`），并拒绝非 http(s) 协议。
 */
export function normalizeAttachmentUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * 通过文件头魔数推断常见图片格式后缀（兜底 QQ CDN 返回 application/octet-stream 或无后缀文件名）。
 */
export function sniffImageExtension(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return '.png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return '.gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return '.webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return '.bmp';
  }
  return undefined;
}

function normalizeMime(raw: string | undefined): string {
  if (!raw) return 'application/octet-stream';
  const base = raw.split(';')[0]?.trim().toLowerCase();
  return base || 'application/octet-stream';
}

function sanitizeFileStem(rawName: string | undefined, fallback: string): string {
  if (!rawName?.trim()) {
    return fallback;
  }
  const base = basename(rawName.trim());
  const ext = extname(base);
  const stem = (ext ? base.slice(0, -ext.length) : base)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  return stem || fallback;
}

function resolveExtension(
  rawFilename: string | undefined,
  url: string,
  contentType: string,
  bytes: Uint8Array,
): string {
  const sniffed = sniffImageExtension(bytes);
  if (sniffed) {
    return sniffed;
  }

  const fromMime = MIME_EXT_MAP[contentType];
  if (fromMime) {
    return fromMime;
  }

  if (rawFilename) {
    const ext = extname(basename(rawFilename)).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
      return ext;
    }
  }

  try {
    const urlPathExt = extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(urlPathExt)) {
      return urlPathExt;
    }
  } catch {
    // ignore URL parse error
  }

  return contentType.startsWith('image/') ? '.jpg' : '.bin';
}

export function isImageAttachment(att: Pick<DownloadedAttachment, 'contentType' | 'localPath'>): boolean {
  if (att.contentType.toLowerCase().startsWith('image/')) {
    return true;
  }
  if (att.localPath) {
    return IMAGE_EXTENSIONS.has(extname(att.localPath).toLowerCase());
  }
  return false;
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Attachment exceeds max size (${declared} > ${maxBytes} bytes)`);
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Attachment exceeds max size (${buf.byteLength} > ${maxBytes} bytes)`);
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`Attachment exceeds max size (>${maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 将入站消息携带的图片/媒体附件下载到当前会话隔离工作区的 `attachments/` 目录中，
 * 以便 Antigravity 原生 `read_file` 工具直接走多模态视觉通道读取本地图片文件。
 */
export async function downloadInboundAttachments(
  attachments: readonly InboundAttachmentItem[] | undefined,
  sessionDir: string,
  options: DownloadAttachmentsOptions = {},
): Promise<DownloadedAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxCount = options.maxCount ?? DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  const resolvedSessionDir = resolve(sessionDir);
  const attachmentsDir = resolve(resolvedSessionDir, 'attachments');
  if (!isStrictlyInside(resolvedSessionDir, attachmentsDir)) {
    throw new Error(`Attachments directory escapes sessionDir: ${attachmentsDir}`);
  }
  mkdirSync(attachmentsDir, { recursive: true });

  const slice = attachments.slice(0, maxCount);
  const results: DownloadedAttachment[] = [];
  const msgTag = createHash('sha256')
    .update(`${options.messageId ?? ''}:${now()}`)
    .digest('hex')
    .slice(0, 8);

  for (let index = 0; index < slice.length; index += 1) {
    const item = slice[index];
    if (!item) continue;

    const declaredMime = normalizeMime(item.contentType);
    const fallbackFilename = item.filename?.trim() || `attachment-${index + 1}`;
    const normalizedUrl = normalizeAttachmentUrl(item.url);

    if (!normalizedUrl) {
      results.push({
        contentType: declaredMime,
        url: item.url,
        filename: fallbackFilename,
        ...(item.asrReferText ? { asrReferText: item.asrReferText } : {}),
        error: 'Invalid or unsupported attachment URL',
      });
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(normalizedUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const bytes = await readResponseWithLimit(response, maxBytes);
      const responseMime = normalizeMime(response.headers.get('content-type') ?? undefined);
      const effectiveMime =
        responseMime !== 'application/octet-stream' ? responseMime : declaredMime;

      const ext = resolveExtension(item.filename, normalizedUrl, effectiveMime, bytes);
      const sniffedMime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : effectiveMime;

      const stem = sanitizeFileStem(item.filename, `att-${index + 1}`);
      const finalFilename = `${msgTag}-${index + 1}-${stem}${ext}`;
      const localPath = resolve(attachmentsDir, finalFilename);
      if (!isStrictlyInside(attachmentsDir, localPath)) {
        throw new Error('Resolved attachment path escapes attachments directory');
      }

      writeFileSync(localPath, bytes);
      results.push({
        contentType: sniffedMime,
        url: normalizedUrl,
        filename: finalFilename,
        localPath,
        size: bytes.byteLength,
        ...(item.asrReferText ? { asrReferText: item.asrReferText } : {}),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger?.warn?.(`[bridge:attachments] Failed to download attachment #${index + 1}: ${errMsg}`);
      results.push({
        contentType: declaredMime,
        url: normalizedUrl,
        filename: fallbackFilename,
        ...(item.asrReferText ? { asrReferText: item.asrReferText } : {}),
        error: errMsg,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}
