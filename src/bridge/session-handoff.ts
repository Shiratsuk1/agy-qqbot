import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppLogger } from '../shared/types.ts';

export interface TranscriptDigestTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptDigestResult {
  found: boolean;
  transcriptPath: string;
  totalEntries: number;
  turns: TranscriptDigestTurn[];
  digestText: string;
}

export interface HandoffEntry {
  sessionKey: string;
  reason: 'compact' | 'model-switch';
  summaryText: string;
  sourceConversationId?: string;
  createdAt: number;
}

export interface HandoffBuildResult {
  created: boolean;
  summaryText: string;
  turnCount: number;
  usedCliSummarizer: boolean;
}

const BRIDGE_HEADER_LINE_RE =
  /^(?:\[QQ (?:c2c|group) (?:message|stream)\]|botId:|peerId:|sender:|replyToken:|delegateToken:|workspace:|memoryDirs:|mode:)/;

/**
 * 解析 Antigravity Desktop 的会话 `brain/<conversationId>` 目录路径。
 */
export function resolveAntigravityBrainDir(
  conversationId: string,
  options?: { appDataDir?: string; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  const appDataDir =
    options?.appDataDir?.trim() ||
    env.ANTIGRAVITY_APP_DATA_DIR?.trim() ||
    join(homedir(), '.gemini', 'antigravity');
  return join(appDataDir, 'brain', conversationId.trim());
}

/**
 * 从桥接器注入的 prompt 中剥离路由头字段，只保留实际用户消息与附件摘要。
 */
export function sanitizeInboundPromptForDigest(rawContent: string): string {
  const normalized = rawContent.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('[QQ ')) {
    const splitIdx = normalized.indexOf('\n\n');
    if (splitIdx > 0) {
      const headLines = normalized.slice(0, splitIdx).split('\n');
      if (headLines.every((line) => !line.trim() || BRIDGE_HEADER_LINE_RE.test(line.trim()))) {
        return normalized.slice(splitIdx + 2).trim();
      }
    }
  }

  return normalized;
}

function tryParseJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractQqReplyTextsFromToolCalls(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const extracted: string[] = [];
  for (const call of toolCalls) {
    const callObj = tryParseJsonRecord(call);
    if (!callObj) continue;
    const fnName = typeof callObj.name === 'string' ? callObj.name : '';
    const argsObj = tryParseJsonRecord(callObj.arguments);

    if (fnName === 'qqbot_reply' || fnName.endsWith('qqbot_reply')) {
      const text = typeof argsObj?.text === 'string' ? argsObj.text.trim() : '';
      if (text) extracted.push(text);
      continue;
    }

    if (fnName === 'call_mcp_tool' && argsObj) {
      const mcpTool =
        typeof argsObj.ToolName === 'string'
          ? argsObj.ToolName
          : typeof argsObj.tool_name === 'string'
            ? argsObj.tool_name
            : '';
      if (mcpTool === 'qqbot_reply') {
        const innerArgs = tryParseJsonRecord(argsObj.Arguments ?? argsObj.arguments);
        const text = typeof innerArgs?.text === 'string' ? innerArgs.text.trim() : '';
        if (text) extracted.push(text);
      }
    }
  }
  return extracted;
}

/**
 * 读取 Antigravity Desktop 本地 `transcript.jsonl` 并提取用户提问与助手回复摘要。
 */
export function extractAgentApiTranscriptDigest(
  conversationId: string,
  options?: {
    appDataDir?: string;
    env?: NodeJS.ProcessEnv;
    maxTurns?: number;
    maxChars?: number;
  },
): TranscriptDigestResult {
  const brainDir = resolveAntigravityBrainDir(conversationId, options);
  const transcriptPath = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) {
    return {
      found: false,
      transcriptPath,
      totalEntries: 0,
      turns: [],
      digestText: '',
    };
  }

  let rawText = '';
  try {
    rawText = readFileSync(transcriptPath, 'utf8');
  } catch {
    return {
      found: false,
      transcriptPath,
      totalEntries: 0,
      turns: [],
      digestText: '',
    };
  }

  const collected: TranscriptDigestTurn[] = [];
  let totalEntries = 0;

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    totalEntries += 1;
    const stepType = typeof obj.type === 'string' ? obj.type : '';

    if (stepType === 'USER_INPUT' && typeof obj.content === 'string') {
      const cleaned = sanitizeInboundPromptForDigest(obj.content);
      if (cleaned) {
        collected.push({ role: 'user', text: cleaned });
      }
      continue;
    }

    if (stepType === 'PLANNER_RESPONSE') {
      const replyTexts = extractQqReplyTextsFromToolCalls(obj.tool_calls);
      if (replyTexts.length > 0) {
        for (const replyText of replyTexts) {
          collected.push({ role: 'assistant', text: replyText });
        }
      } else if (typeof obj.content === 'string' && obj.content.trim()) {
        const cleaned = obj.content.trim();
        const prev = collected.at(-1);
        if (!prev || prev.role !== 'assistant' || !prev.text.includes(cleaned)) {
          collected.push({ role: 'assistant', text: cleaned });
        }
      }
    }
  }

  const maxTurns = options?.maxTurns ?? 16;
  const maxChars = options?.maxChars ?? 6000;
  const recent = collected.slice(-maxTurns);

  const formattedLines: string[] = [];
  let currentLength = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i]!;
    const prefix = turn.role === 'user' ? '用户' : '助手';
    const clippedBody =
      turn.text.length > 1000 ? `${turn.text.slice(0, 1000).trimEnd()}…` : turn.text;
    const formatted = `- [${prefix}] ${clippedBody.replace(/\n+/g, '\n  ')}`;
    if (formattedLines.length > 0 && currentLength + formatted.length + 1 > maxChars) {
      break;
    }
    formattedLines.unshift(formatted);
    currentLength += formatted.length + 1;
  }

  return {
    found: true,
    transcriptPath,
    totalEntries,
    turns: recent,
    digestText: formattedLines.join('\n'),
  };
}

/**
 * 基于历史轨迹与可选保留指令生成可供新桌面会话无缝继承的压缩检查点文本。
 */
export async function buildCompactedSessionHandoff(params: {
  conversationId: string;
  reason: 'compact' | 'model-switch';
  instructions?: string;
  previousModel?: string;
  targetModel?: string;
  existingHandoff?: string;
  digest: TranscriptDigestResult;
  summarizeWithCli?: (prompt: string) => Promise<string | undefined>;
  alwaysUseCli?: boolean;
  logger?: AppLogger;
}): Promise<HandoffBuildResult> {
  const { digest } = params;
  const baseSegments: string[] = [];
  if (params.existingHandoff?.trim()) {
    baseSegments.push(`[前期压缩摘要]\n${params.existingHandoff.trim()}`);
  }
  if (digest.digestText.trim()) {
    baseSegments.push(`[最近对话轨迹]\n${digest.digestText.trim()}`);
  }

  const combinedRaw = baseSegments.join('\n\n').trim();
  if (!combinedRaw) {
    return {
      created: false,
      summaryText: '',
      turnCount: 0,
      usedCliSummarizer: false,
    };
  }

  const focus = params.instructions?.trim();
  const shouldUseCli =
    typeof params.summarizeWithCli === 'function' &&
    (Boolean(params.alwaysUseCli) ||
      Boolean(focus) ||
      digest.turns.length > 6 ||
      combinedRaw.length > 1800);

  if (shouldUseCli && params.summarizeWithCli) {
    const summaryPrompt = [
      '请把下面的对话上下文浓缩为一个精准、紧凑的中文「会话检查点摘要」（不超过 900 字），供新开启的 Antigravity 桌面会话立即无缝接力：',
      '- 保留所有已确认的技术事实、结论、本地完整绝对路径、关键命令与约定；',
      '- 保留尚未完成的待办事项与用户明确偏好；',
      ...(focus ? [`- 额外优先保留重点：${focus}`] : []),
      '- 只输出客观检查点内容本身，不要寒暄或解释。',
      '',
      combinedRaw,
    ].join('\n');

    try {
      const cliText = (await params.summarizeWithCli(summaryPrompt))?.trim();
      if (cliText) {
        return {
          created: true,
          summaryText: cliText,
          turnCount: digest.turns.length,
          usedCliSummarizer: true,
        };
      }
    } catch (err) {
      params.logger?.warn?.(
        `[bridge:handoff] CLI summarization failed, falling back to transcript digest: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    created: true,
    summaryText: focus ? `[用户指定保留重点: ${focus}]\n\n${combinedRaw}` : combinedRaw,
    turnCount: digest.turns.length,
    usedCliSummarizer: false,
  };
}

/**
 * 持久化待注入下一次桌面新会话的上下文交接检查点（`<dataDir>/handoffs.json`）。
 */
export class HandoffStore {
  readonly filePath: string;
  private readonly entries = new Map<string, HandoffEntry>();
  private readonly logger: AppLogger | undefined;

  constructor(options: { dataDir?: string; filePath?: string; logger?: AppLogger } = {}) {
    const resolvedDir = options.dataDir?.trim() || join(homedir(), '.antigravity-qqbot');
    this.filePath = options.filePath?.trim() || join(resolvedDir, 'handoffs.json');
    this.logger = options.logger;
    this.reload();
  }

  get(sessionKey: string): HandoffEntry | undefined {
    const found = this.entries.get(sessionKey);
    return found ? { ...found } : undefined;
  }

  set(entry: HandoffEntry): HandoffEntry {
    const normalized: HandoffEntry = {
      ...entry,
      summaryText: entry.summaryText.trim(),
    };
    this.entries.set(normalized.sessionKey, normalized);
    this.saveToDisk();
    return { ...normalized };
  }

  delete(sessionKey: string): boolean {
    const existed = this.entries.delete(sessionKey);
    if (existed) {
      this.saveToDisk();
    }
    return existed;
  }

  clear(): void {
    this.entries.clear();
    this.saveToDisk();
  }

  reload(): void {
    this.entries.clear();
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as { handoffs?: Record<string, HandoffEntry> };
      if (parsed && parsed.handoffs && typeof parsed.handoffs === 'object') {
        for (const [k, v] of Object.entries(parsed.handoffs)) {
          if (v && typeof v === 'object' && typeof v.summaryText === 'string' && v.summaryText.trim()) {
            this.entries.set(k, { ...v, sessionKey: k });
          }
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[bridge:handoff] Failed to load ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const serialized = `${JSON.stringify(
      {
        version: 1,
        handoffs: Object.fromEntries(this.entries.entries()),
      },
      null,
      2,
    )}\n`;
    const tmpFile = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmpFile, serialized, 'utf8');
    renameSync(tmpFile, this.filePath);
  }
}
