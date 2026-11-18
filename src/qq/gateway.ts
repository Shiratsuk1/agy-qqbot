import {
  MsgType,
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from '@tencent-connect/qqbot-nodejs';
import type {
  GatewayDisconnect,
  InlineKeyboard,
  InteractionEvent,
  Logger,
  Middleware,
  QQBotEventMap,
  QQBotInboundMessage,
  QQBotOptions,
  ReconnectPolicy,
  ReplyTarget as SdkReplyTarget,
  SendMessageOptions,
  MessageResponse,
} from '@tencent-connect/qqbot-nodejs';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import type {
  AppLogger,
  ChatScope,
  InboundAttachmentItem,
  InboundMessage,
  MediaKind,
  OutboundMedia,
  OutboundReply,
  ReplyTarget,
  RuntimeConfig,
} from '../shared/types.ts';
import { resolveQqCredentials } from './credentials.ts';
import type { ResolveQqCredentialsOptions, ResolvedQqCredentials } from './credentials.ts';
import { MsgIdCache } from './msg-id-cache.ts';
import { ReplyLimiter } from './reply-limiter.ts';
import { chunkMarkdownText, chunkText } from './text-chunk.ts';

export type InboundHandler = (message: InboundMessage) => Promise<void> | void;

export interface QqSdkStreamController {
  update(fullText: string): Promise<void>;
  complete(): Promise<MessageResponse | undefined>;
  cancel(): void;
}

export interface QqReplyStream {
  /** Push the cumulative text generated so far. */
  update(fullText: string): Promise<void>;
  /** Finalize the stream with the complete reply text (falls back to sendReply if needed). */
  complete(finalText: string): Promise<void>;
  /** Cancel an in-progress stream without sending a fallback reply. */
  cancel(): void;
}

export interface QqGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(reply: OutboundReply): Promise<void>;
  sendMedia?(media: OutboundMedia): Promise<{ mediaType: MediaKind }>;
  openReplyStream?(target: ReplyTarget, options?: { throttleMs?: number }): QqReplyStream;
  onInbound(handler: InboundHandler): () => void;
}

export interface QqBotClient {
  readonly appId: string;
  use(...middleware: Middleware[]): unknown;
  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): unknown;
  start(externalSignal?: AbortSignal): Promise<void>;
  stop(): void;
  send(opts: SendMessageOptions): Promise<MessageResponse>;
  sendText(target: SdkReplyTarget, content: string): Promise<MessageResponse>;
  sendMarkdown(
    target: SdkReplyTarget,
    content: string,
    opts?: { keyboard?: InlineKeyboard },
  ): Promise<MessageResponse>;
  sendImage?(
    target: SdkReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { content?: string; onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: unknown; message: MessageResponse | undefined }>;
  sendFile?(
    target: SdkReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { fileName?: string; content?: string; onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: unknown; message: MessageResponse | undefined }>;
  sendVoice?(
    target: SdkReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: unknown; message: MessageResponse | undefined }>;
  sendVideo?(
    target: SdkReplyTarget,
    source: { url?: string; buffer?: Buffer; localPath?: string },
    opts?: { content?: string; onProgress?: (uploaded: number, total: number) => void },
  ): Promise<{ upload: unknown; message: MessageResponse | undefined }>;
  sendTyping?(target: SdkReplyTarget, durationSec?: number): Promise<{ refIdx?: string }>;
  openStream?(opts: {
    target: SdkReplyTarget;
    eventId?: string;
    throttleMs?: number;
  }): QqSdkStreamController;
}

export interface CreateQqGatewayOptions {
  logger?: AppLogger;
  credentials?: ResolvedQqCredentials;
  credentialOptions?: ResolveQqCredentialsOptions;
  msgIdCache?: MsgIdCache;
  replyLimiter?: ReplyLimiter;
  userAgent?: string;
  botFactory?: (options: QQBotOptions) => QqBotClient;
  intents?: number;
  reconnect?: Partial<ReconnectPolicy>;
  sessionPersistence?: QQBotOptions['sessionPersistence'];
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onDisconnected?: (event: GatewayDisconnect) => void;
  onError?: (error: Error) => void;
  onInteraction?: (event: InteractionEvent) => Promise<void> | void;
}

interface ResolvedSendRef {
  msgId?: string;
  eventId?: string;
  limiterKey?: string;
  fallbackReason?: string;
}

const DEFAULT_PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

function readPackageVersion(projectRoot: string = DEFAULT_PROJECT_ROOT): string {
  try {
    const pkgPath = resolve(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export function buildQqUserAgent(projectRoot?: string): string {
  return `antigravity-qqbot/${readPackageVersion(projectRoot)} (Node/${process.versions.node}; ${platform()})`;
}

function createConsoleLogger(debugEnabled: boolean): AppLogger {
  return {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
    ...(debugEnabled ? { debug: (msg: string) => console.debug(msg) } : {}),
  };
}

function toSdkLogger(logger: AppLogger, debugEnabled: boolean): Logger {
  return {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
    ...(debugEnabled
      ? {
          debug: (msg: string) => {
            if (logger.debug) {
              logger.debug(msg);
            } else {
              logger.info(msg);
            }
          },
        }
      : {}),
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function extractInboundAttachments(msg: QQBotInboundMessage): InboundAttachmentItem[] {
  const rawList: Array<{
    content_type?: string;
    url?: string;
    filename?: string;
    width?: number;
    height?: number;
    size?: number;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }> = [];

  if (Array.isArray(msg.attachments)) {
    rawList.push(...msg.attachments);
  }
  if (Array.isArray(msg.msgElements)) {
    for (const element of msg.msgElements) {
      if (Array.isArray(element?.attachments)) {
        rawList.push(...element.attachments);
      }
    }
  }

  const seenUrls = new Set<string>();
  const mapped: InboundAttachmentItem[] = [];

  for (const att of rawList) {
    const rawUrl = (att?.voice_wav_url?.trim() || att?.url?.trim() || '');
    if (!rawUrl || seenUrls.has(rawUrl)) {
      continue;
    }
    seenUrls.add(rawUrl);

    const contentType = att?.content_type?.trim() || 'application/octet-stream';
    const filename = att?.filename?.trim() || undefined;
    const asrReferText = att?.asr_refer_text?.trim() || undefined;

    mapped.push({
      contentType,
      url: rawUrl,
      ...(filename ? { filename } : {}),
      ...(typeof att?.width === 'number' && Number.isFinite(att.width) ? { width: att.width } : {}),
      ...(typeof att?.height === 'number' && Number.isFinite(att.height) ? { height: att.height } : {}),
      ...(typeof att?.size === 'number' && Number.isFinite(att.size) ? { size: att.size } : {}),
      ...(asrReferText ? { asrReferText } : {}),
    });
  }

  return mapped;
}

/**
 * Map a `@tencent-connect/qqbot-nodejs` inbound C2C or Group message into the shared `InboundMessage`.
 */
export function mapInboundMessage(
  msg: QQBotInboundMessage,
  fallbackReceivedAt: number = Date.now(),
  botId?: string,
): InboundMessage | null {
  const rawScope = msg.replyTarget?.scope ?? (msg.kind === 'c2c' || msg.kind === 'group' ? msg.kind : undefined);
  if (rawScope !== 'c2c' && rawScope !== 'group') {
    return null;
  }

  const peerId =
    rawScope === 'c2c'
      ? msg.replyTarget?.targetId || msg.senderId
      : msg.replyTarget?.targetId || msg.groupOpenid || '';
  if (!peerId) {
    return null;
  }

  const parsedTs = msg.timestamp ? Date.parse(msg.timestamp) : Number.NaN;
  const receivedAt = Number.isFinite(parsedTs) ? parsedTs : fallbackReceivedAt;
  const replyMsgId = msg.replyTarget?.msgId || msg.messageId || undefined;
  const senderName = msg.senderName?.trim() || undefined;
  const normalizedBotId = botId?.trim() || undefined;
  const attachments = extractInboundAttachments(msg);

  return {
    messageId: msg.messageId,
    scope: rawScope,
    peerId,
    senderId: msg.senderId,
    ...(senderName ? { senderName } : {}),
    ...(normalizedBotId ? { botId: normalizedBotId } : {}),
    text: msg.content,
    ...(attachments.length > 0 ? { attachments } : {}),
    receivedAt,
    replyTarget: {
      scope: rawScope,
      targetId: peerId,
      ...(replyMsgId ? { msgId: replyMsgId } : {}),
    },
  };
}

function mapInteractionRef(event: InteractionEvent): {
  scope: ChatScope;
  targetId: string;
  eventId: string;
  msgId?: string;
} | null {
  const eventId = event.id?.trim();
  if (!eventId) {
    return null;
  }

  const msgId = event.data?.resolved?.message_id?.trim() || undefined;
  if (event.group_openid) {
    return {
      scope: 'group',
      targetId: event.group_openid,
      eventId,
      ...(msgId ? { msgId } : {}),
    };
  }
  if (event.user_openid) {
    return {
      scope: 'c2c',
      targetId: event.user_openid,
      eventId,
      ...(msgId ? { msgId } : {}),
    };
  }
  return null;
}

/**
 * Create a reusable QQ WebSocket gateway integrating credential resolution,
 * SDK middlewares, passive `msgId`/`eventId` caching, rate-limit fallback, and chunked sending.
 */
export function createQqGateway(
  config: RuntimeConfig,
  options: CreateQqGatewayOptions = {},
): QqGateway {
  const logger = options.logger ?? createConsoleLogger(config.debug);
  const sdkLogger = toSdkLogger(logger, config.debug);
  const msgIdCache = options.msgIdCache ?? new MsgIdCache();
  const replyLimiter = options.replyLimiter ?? new ReplyLimiter({ limit: config.passiveReplyLimit });
  const userAgent = options.userAgent ?? buildQqUserAgent(options.credentialOptions?.projectRoot);

  const inboundHandlers = new Set<InboundHandler>();
  const sendQueues = new Map<string, Promise<void>>();

  let activeBot: QqBotClient | null = null;
  let abortController: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  let startingPromise: Promise<void> | null = null;
  let stopRequested = false;
  let onStopHook: (() => void) | null = null;

  const enqueueForTarget = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = sendQueues.get(key) ?? Promise.resolve();
    const current = prev.then(task, task);
    const cleanup = current.then(
      () => {
        if (sendQueues.get(key) === cleanup) {
          sendQueues.delete(key);
        }
      },
      () => {
        if (sendQueues.get(key) === cleanup) {
          sendQueues.delete(key);
        }
      },
    );
    sendQueues.set(key, cleanup);
    return current;
  };

  const resolveSendTarget = (target: ReplyTarget): ResolvedSendRef => {
    if (target.forceProactive) {
      return { fallbackReason: 'force_proactive' };
    }

    let fallbackReason: string | undefined;

    if (target.msgId) {
      if (msgIdCache.isMsgIdExpired(target.scope, target.targetId, target.msgId)) {
        fallbackReason = 'expired';
      } else {
        const check = replyLimiter.checkLimit(target.msgId);
        if (check.allowed) {
          return { msgId: target.msgId, limiterKey: target.msgId };
        }
        fallbackReason = check.fallbackReason;
      }
    }

    if (target.eventId) {
      if (msgIdCache.isEventIdExpired(target.scope, target.targetId, target.eventId)) {
        fallbackReason = fallbackReason ?? 'expired';
      } else {
        const eventKey = `event:${target.eventId}`;
        const check = replyLimiter.checkLimit(eventKey);
        if (check.allowed) {
          return {
            eventId: target.eventId,
            limiterKey: eventKey,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }
    }

    const cachedEntries = msgIdCache.getValidEntries(target.scope, target.targetId);
    for (const entry of cachedEntries) {
      if (entry.msgId) {
        const check = replyLimiter.checkLimit(entry.msgId);
        if (check.allowed) {
          return {
            msgId: entry.msgId,
            limiterKey: entry.msgId,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }

      if (entry.eventId) {
        const eventKey = `event:${entry.eventId}`;
        const check = replyLimiter.checkLimit(eventKey);
        if (check.allowed) {
          return {
            eventId: entry.eventId,
            limiterKey: eventKey,
            ...(fallbackReason ? { fallbackReason } : {}),
          };
        }
        fallbackReason = fallbackReason ?? check.fallbackReason;
      }
    }

    return {
      fallbackReason: fallbackReason ?? 'no_cached_msg_id',
    };
  };

  const dispatchInbound = async (mapped: InboundMessage): Promise<void> => {
    for (const handler of [...inboundHandlers]) {
      try {
        await handler(mapped);
      } catch (err) {
        const error = toError(err);
        logger.error(`[qq:gateway] inbound handler failed: ${error.message}`);
        options.onError?.(error);
      }
    }
  };

  return {
    async start(): Promise<void> {
      if (activeBot || startingPromise) {
        throw new Error('QqGateway is already started');
      }

      stopRequested = false;
      const controller = new AbortController();
      abortController = controller;

      const startWork = (async (): Promise<void> => {
        try {
          const creds =
            options.credentials ??
            (await resolveQqCredentials(config, {
              ...options.credentialOptions,
              signal: options.credentialOptions?.signal ?? controller.signal,
              logger,
            }));

          if (stopRequested || controller.signal.aborted) {
            return;
          }

          const botOptions: QQBotOptions = {
            appId: creds.appId,
            appSecret: creds.appSecret,
            transport: 'websocket',
            baseUrl: config.apiBaseUrl,
            tokenBaseUrl: config.tokenBaseUrl,
            markdownSupport: config.markdownSupport,
            userAgent,
            logger: sdkLogger,
            ...(options.intents !== undefined ? { intents: options.intents } : {}),
            ...(options.reconnect ? { reconnect: options.reconnect } : {}),
            ...(options.sessionPersistence ? { sessionPersistence: options.sessionPersistence } : {}),
          };

          const createBot = options.botFactory ?? ((opts: QQBotOptions) => new QQBot(opts));
          const bot = createBot(botOptions);

          bot.use(messageFilter({ skipSelfEcho: true }));
          bot.use(mentionGate({ requireMentionInGroup: config.requireMentionInGroup }));
          bot.use(contentSanitizer({ parseFaceTags: true }));

          let markReady = (): void => {};

          bot.on('ready', (data) => {
            logger.info(`[qq:gateway] WebSocket gateway READY (appId=${creds.appId})`);
            markReady();
            options.onReady?.(data);
          });

          bot.on('resumed', (data) => {
            logger.info(`[qq:gateway] WebSocket gateway RESUMED (appId=${creds.appId})`);
            markReady();
            options.onResumed?.(data);
          });

          bot.on('disconnected', (event) => {
            const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
            if (event.willReconnect) {
              logger.warn(`[qq:gateway] Disconnected (${detail}), reconnecting...`);
            } else {
              logger.error(`[qq:gateway] Permanently disconnected (${detail})`);
            }
            options.onDisconnected?.(event);
          });

          bot.on('error', (err) => {
            logger.error(`[qq:gateway] Gateway error: ${err.message}`);
            options.onError?.(err);
          });

          bot.on('interaction', async (_ctx, event) => {
            const ref = mapInteractionRef(event);
            if (ref) {
              msgIdCache.record(ref.scope, ref.targetId, {
                eventId: ref.eventId,
                ...(ref.msgId ? { msgId: ref.msgId } : {}),
              });
            }
            if (options.onInteraction) {
              try {
                await options.onInteraction(event);
              } catch (err) {
                const error = toError(err);
                logger.error(`[qq:gateway] interaction handler failed: ${error.message}`);
                options.onError?.(error);
              }
            }
          });

          bot.on('message', async (ctx, msg) => {
            const mapped = mapInboundMessage(msg, ctx?.receivedAt, creds.appId);
            if (!mapped) {
              logger.debug?.(`[qq:gateway] Ignoring unsupported inbound message kind=${msg.kind}`);
              return;
            }

            msgIdCache.record(mapped.scope, mapped.peerId, {
              msgId: mapped.replyTarget.msgId ?? mapped.messageId,
            });
            await dispatchInbound(mapped);
          });

          activeBot = bot;

          await new Promise<void>((resolveReady, rejectReady) => {
            let settled = false;
            const finishReady = (): void => {
              if (settled) return;
              settled = true;
              onStopHook = null;
              resolveReady();
            };
            const failReady = (err: unknown): void => {
              if (settled) return;
              settled = true;
              onStopHook = null;
              rejectReady(toError(err));
            };

            markReady = finishReady;
            onStopHook = finishReady;

            const run = Promise.resolve().then(() => bot.start(controller.signal));
            runPromise = run;
            run.then(
              () => {
                if (stopRequested) {
                  if (activeBot === bot) activeBot = null;
                  if (abortController === controller) abortController = null;
                  if (runPromise === run) runPromise = null;
                }
                finishReady();
              },
              (err: unknown) => {
                const error = toError(err);
                if (activeBot === bot) activeBot = null;
                if (abortController === controller) abortController = null;
                if (runPromise === run) runPromise = null;

                if (!settled) {
                  failReady(error);
                } else if (!stopRequested) {
                  logger.error(`[qq:gateway] Gateway stopped with error: ${error.message}`);
                  options.onError?.(error);
                }
              },
            );
          });
        } catch (err) {
          if (abortController === controller) {
            abortController = null;
          }
          activeBot = null;
          runPromise = null;
          throw err;
        }
      })();

      startingPromise = startWork;
      try {
        await startWork;
      } finally {
        if (startingPromise === startWork) {
          startingPromise = null;
        }
      }
    },

    async stop(): Promise<void> {
      stopRequested = true;
      const bot = activeBot;
      const controller = abortController;
      const run = runPromise;
      const pendingStart = startingPromise;

      onStopHook?.();

      if (controller && !controller.signal.aborted) {
        controller.abort();
      }

      if (bot) {
        try {
          bot.stop();
        } catch (err) {
          logger.warn(`[qq:gateway] bot.stop() threw: ${toError(err).message}`);
        }
      }

      if (pendingStart) {
        await pendingStart.catch(() => {});
      }

      if (run) {
        await run.catch(() => {});
      }

      if (activeBot === bot) {
        activeBot = null;
      }
      if (abortController === controller) {
        abortController = null;
      }
      if (runPromise === run) {
        runPromise = null;
      }
    },

    async sendReply(reply: OutboundReply): Promise<void> {
      if (!activeBot) {
        throw new Error('QqGateway is not started; call start() before sendReply()');
      }

      if (!reply.text || !reply.text.trim()) {
        logger.warn(
          `[qq:gateway] Skipping empty reply for ${reply.target.scope}:${reply.target.targetId}`,
        );
        return;
      }

      const queueKey = `${reply.target.scope}:${reply.target.targetId}`;
      await enqueueForTarget(queueKey, async () => {
        const bot = activeBot;
        if (!bot) {
          throw new Error('QqGateway stopped while sending reply');
        }

        const chunks = config.markdownSupport
          ? chunkMarkdownText(reply.text, config.textChunkLimit)
          : chunkText(reply.text, config.textChunkLimit);

        for (const chunk of chunks) {
          if (!chunk.trim()) {
            continue;
          }

          const resolved = resolveSendTarget(reply.target);
          if (resolved.fallbackReason) {
            logger.debug?.(
              `[qq:gateway] Reply target fallback for ${queueKey} (${resolved.fallbackReason}): using ${resolved.msgId ? `msgId=${resolved.msgId}` : resolved.eventId ? `eventId=${resolved.eventId}` : 'proactive'}`,
            );
          }

          const sdkTarget: SdkReplyTarget = {
            scope: reply.target.scope,
            targetId: reply.target.targetId,
            ...(resolved.msgId ? { msgId: resolved.msgId } : {}),
          };

          if (resolved.eventId) {
            await bot.send(
              config.markdownSupport
                ? {
                    target: sdkTarget,
                    msgType: MsgType.MARKDOWN,
                    markdown: { content: chunk },
                    extra: { event_id: resolved.eventId },
                  }
                : {
                    target: sdkTarget,
                    msgType: MsgType.TEXT,
                    content: chunk,
                    extra: { event_id: resolved.eventId },
                  },
            );
          } else if (config.markdownSupport) {
            await bot.sendMarkdown(sdkTarget, chunk);
          } else {
            await bot.sendText(sdkTarget, chunk);
          }

          if (resolved.limiterKey) {
            replyLimiter.record(resolved.limiterKey);
          }
        }
      });
    },

    async sendMedia(media: OutboundMedia): Promise<{ mediaType: MediaKind }> {
      if (!activeBot) {
        throw new Error('QqGateway is not started; call start() before sendMedia()');
      }

      const localPath = media.localPath?.trim();
      const remoteUrl = media.url?.trim();
      if (!localPath && !remoteUrl) {
        throw new Error('sendMedia requires either localPath or url');
      }
      if (localPath && !existsSync(localPath)) {
        throw new Error(`Media file does not exist: ${localPath}`);
      }

      const extSource = localPath || remoteUrl || '';
      const cleanPath = extSource.split(/[?#]/)[0] ?? '';
      const ext = extname(cleanPath).toLowerCase();
      const inferredType: MediaKind =
        media.mediaType ??
        (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
          ? 'image'
          : ['.mp4', '.mov', '.webm'].includes(ext)
            ? 'video'
            : ['.silk', '.wav', '.mp3', '.ogg', '.amr'].includes(ext)
              ? 'voice'
              : 'file');

      const source = localPath ? { localPath } : { url: remoteUrl! };
      const caption = media.caption?.trim() || undefined;
      const fileName =
        media.fileName?.trim() || (localPath ? basename(localPath) : undefined);

      const queueKey = `${media.target.scope}:${media.target.targetId}`;
      await enqueueForTarget(queueKey, async () => {
        const bot = activeBot;
        if (!bot) {
          throw new Error('QqGateway stopped while sending media');
        }

        const resolved = resolveSendTarget(media.target);
        const sdkTarget: SdkReplyTarget = {
          scope: media.target.scope,
          targetId: media.target.targetId,
          ...(resolved.msgId ? { msgId: resolved.msgId } : {}),
        };

        if (inferredType === 'image') {
          if (typeof bot.sendImage !== 'function') {
            throw new Error('Active QQBot client does not support sendImage');
          }
          await bot.sendImage(sdkTarget, source, caption ? { content: caption } : undefined);
        } else if (inferredType === 'voice') {
          if (typeof bot.sendVoice !== 'function') {
            throw new Error('Active QQBot client does not support sendVoice');
          }
          await bot.sendVoice(sdkTarget, source);
        } else if (inferredType === 'video') {
          if (typeof bot.sendVideo !== 'function') {
            throw new Error('Active QQBot client does not support sendVideo');
          }
          await bot.sendVideo(sdkTarget, source, caption ? { content: caption } : undefined);
        } else {
          if (typeof bot.sendFile !== 'function') {
            throw new Error('Active QQBot client does not support sendFile');
          }
          await bot.sendFile(sdkTarget, source, {
            ...(fileName ? { fileName } : {}),
            ...(caption ? { content: caption } : {}),
          });
        }

        if (resolved.limiterKey) {
          replyLimiter.record(resolved.limiterKey);
        }
      });

      return { mediaType: inferredType };
    },

    openReplyStream(target: ReplyTarget, streamOpts?: { throttleMs?: number }): QqReplyStream {
      let sdkStream: QqSdkStreamController | null = null;
      let streamBroken = false;
      let streamStarted = false;
      let lastSentStreamText = '';
      let finished = false;
      let resolvedMsgId: string | undefined;
      let resolvedLimiterKey: string | undefined;

      const bot = activeBot;
      if (bot && target.scope === 'c2c' && !target.forceProactive) {
        const resolved = resolveSendTarget(target);
        resolvedMsgId = resolved.msgId;
        resolvedLimiterKey = resolved.limiterKey;

        const typingTarget: SdkReplyTarget = {
          scope: 'c2c',
          targetId: target.targetId,
          ...(resolvedMsgId ? { msgId: resolvedMsgId } : {}),
        };
        bot.sendTyping?.(typingTarget, 60).catch(() => {
          // 忽略输入状态提示异常
        });

        if (resolvedMsgId && typeof bot.openStream === 'function') {
          try {
            sdkStream = bot.openStream({
              target: {
                scope: 'c2c',
                targetId: target.targetId,
                msgId: resolvedMsgId,
              },
              ...(resolved.eventId ? { eventId: resolved.eventId } : {}),
              ...(streamOpts?.throttleMs !== undefined ? { throttleMs: streamOpts.throttleMs } : {}),
            });
          } catch (err) {
            streamBroken = true;
            logger.warn(
              `[qq:gateway] Failed to initialize C2C stream, falling back to static send: ${toError(err).message}`,
            );
          }
        }
      }

      const sendStaticFallback = async (text: string): Promise<void> => {
        if (!text.trim()) {
          return;
        }
        if (!activeBot) {
          throw new Error('QqGateway is not started; call start() before completing stream');
        }
        const queueKey = `${target.scope}:${target.targetId}`;
        await enqueueForTarget(queueKey, async () => {
          const currentBot = activeBot;
          if (!currentBot) {
            throw new Error('QqGateway stopped while sending fallback reply');
          }
          const chunks = config.markdownSupport
            ? chunkMarkdownText(text, config.textChunkLimit)
            : chunkText(text, config.textChunkLimit);
          for (const chunk of chunks) {
            const resolved = resolveSendTarget(target);
            const sdkTarget: SdkReplyTarget = {
              scope: target.scope,
              targetId: target.targetId,
              ...(resolved.msgId ? { msgId: resolved.msgId } : {}),
            };
            if (resolved.eventId) {
              await currentBot.send(
                config.markdownSupport
                  ? {
                      target: sdkTarget,
                      msgType: MsgType.MARKDOWN,
                      markdown: { content: chunk },
                      extra: { event_id: resolved.eventId },
                    }
                  : {
                      target: sdkTarget,
                      msgType: MsgType.TEXT,
                      content: chunk,
                      extra: { event_id: resolved.eventId },
                    },
              );
            } else if (config.markdownSupport) {
              await currentBot.sendMarkdown(sdkTarget, chunk);
            } else {
              await currentBot.sendText(sdkTarget, chunk);
            }
            if (resolved.limiterKey) {
              replyLimiter.record(resolved.limiterKey);
            }
          }
        });
      };

      return {
        async update(fullText: string): Promise<void> {
          if (finished || streamBroken || !sdkStream) {
            return;
          }
          const sanitized = fullText.trimEnd();
          if (!sanitized.trim()) {
            return;
          }
          const capped =
            sanitized.length > config.textChunkLimit
              ? sanitized.slice(0, config.textChunkLimit)
              : sanitized;
          if (!capped.startsWith(lastSentStreamText) || capped.length === lastSentStreamText.length) {
            return;
          }
          try {
            await sdkStream.update(capped);
            lastSentStreamText = capped;
            streamStarted = true;
          } catch (err) {
            streamBroken = true;
            sdkStream.cancel();
            logger.warn(
              `[qq:gateway] Stream frame update failed, will fall back on completion: ${toError(err).message}`,
            );
          }
        },

        async complete(finalText: string): Promise<void> {
          if (finished) {
            return;
          }
          finished = true;

          const sanitizedFinal = finalText.trimEnd();
          if (!sanitizedFinal.trim() && !lastSentStreamText) {
            sdkStream?.cancel();
            return;
          }

          if (sdkStream && !streamBroken) {
            // Preserve QQ stream_messages strict prefix-immutability invariant
            const monotonicText = sanitizedFinal.startsWith(lastSentStreamText)
              ? sanitizedFinal
              : lastSentStreamText;
            const firstPart =
              monotonicText.length > config.textChunkLimit
                ? monotonicText.slice(0, config.textChunkLimit)
                : monotonicText;
            const overflowPart =
              monotonicText.length > config.textChunkLimit
                ? monotonicText.slice(config.textChunkLimit).trim()
                : '';

            try {
              if (firstPart.length > lastSentStreamText.length) {
                await sdkStream.update(firstPart);
                lastSentStreamText = firstPart;
              }
              await sdkStream.complete();
              if (resolvedLimiterKey) {
                replyLimiter.record(resolvedLimiterKey);
              }
              if (overflowPart) {
                await sendStaticFallback(overflowPart);
              }
              return;
            } catch (err) {
              streamBroken = true;
              sdkStream.cancel();
              logger.warn(
                `[qq:gateway] Stream completion failed (started=${String(streamStarted)}), falling back to static send: ${toError(err).message}`,
              );
            }
          }

          await sendStaticFallback(sanitizedFinal || lastSentStreamText);
        },

        cancel(): void {
          finished = true;
          sdkStream?.cancel();
        },
      };
    },

    onInbound(handler: InboundHandler): () => void {
      inboundHandlers.add(handler);
      return () => {
        inboundHandlers.delete(handler);
      };
    },
  };
}
