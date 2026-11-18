import { mkdirSync } from 'node:fs';
import { loadRuntimeConfig } from '../shared/config.ts';
import type {
  AppLogger,
  BackendMode,
  BridgeSession,
  ChatScope,
  DownloadedAttachment,
  InboundMessage,
  ReplyTarget,
  RuntimeConfig,
} from '../shared/types.ts';
import { AgentApiClient } from './agentapi-client.ts';
import type { AgentApiInvocation, AgentApiRunner } from './agentapi-client.ts';
import {
  AgyStreamClient,
  DEFAULT_AGY_SUBAGENT_TIMEOUT_MS,
} from './agy-stream-runner.ts';
import type { AgyStreamProcessRunner } from './agy-stream-runner.ts';
import { downloadInboundAttachments, isImageAttachment } from './attachments.ts';
import { CallbackServer } from './callback-server.ts';
import type { DelegateTaskParams, DeliverReplyHandler } from './callback-server.ts';
import { ReplyTokenRegistry } from './reply-tokens.ts';
import { SessionStore, makeSessionKey } from './session-store.ts';
import {
  PeerPreferencesStore,
  detectModelFamilyAndTier,
  formatModelCatalogText,
  formatModelDisplay,
  formatSlashHelpText,
  parseBridgeSlashCommand,
  parseThinkingEffort,
  resolveAdaptiveModel,
  runRepoSelfUpdate,
  syncModelWithEffort,
} from './slash-commands.ts';
import type { ParsedSlashCommand, SelfUpdateResult } from './slash-commands.ts';
import { ensureSessionWorkspace } from './workspace.ts';

export interface ReplyStreamSink {
  update(fullText: string): Promise<void>;
  complete(finalText: string): Promise<void>;
  cancel(): void;
}

export type OpenReplyStreamHandler = (target: ReplyTarget) => ReplyStreamSink;

export interface AntigravityBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatchInbound(message: InboundMessage): Promise<BridgeSession>;
  getSession(scope: ChatScope, peerId: string, botId?: string): BridgeSession | undefined;
  getCallbackUrl(): string;
  waitForBackgroundTasks?(): Promise<void>;
}

export interface FormatBridgePromptOptions {
  downloadedAttachments?: readonly DownloadedAttachment[];
  voiceTranscripts?: readonly string[];
  memoryDirs?: readonly string[];
  delegateToken?: string;
  completedSubtasks?: readonly string[];
}

export interface CreateAntigravityBridgeOptions {
  config?: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  workspaceRoot?: string;
  memoryDirs?: readonly string[];
  callbackHost?: string;
  callbackPort?: number;
  maxBodyBytes?: number;
  agentModel?: string;
  agentProfile?: string;
  commandTimeoutMs?: number;
  subagentTimeoutMs?: number;
  replyTokenTtlMs?: number;
  attachmentMaxBytes?: number;
  attachmentTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  fallbackToNewConversationOnSendError?: boolean;
  backendMode?: BackendMode;
  agyExecutable?: string;
  agyStreamClient?: AgyStreamClient;
  agyStreamRunner?: AgyStreamProcessRunner;
  sessionStore?: SessionStore;
  preferencesStore?: PeerPreferencesStore;
  agentApi?: AgentApiClient;
  invocation?: AgentApiInvocation;
  runner?: AgentApiRunner;
  replyTokens?: ReplyTokenRegistry;
  callbackServer?: CallbackServer;
  onDeliverReply?: DeliverReplyHandler;
  onOpenReplyStream?: OpenReplyStreamHandler;
  onSelfUpdate?: () => Promise<SelfUpdateResult>;
  onRestartProcess?: () => void;
  formatTitle?: (message: InboundMessage) => string | undefined;
  now?: () => number;
  logger?: AppLogger;
}

function formatAttachmentLine(att: DownloadedAttachment): string {
  const kind = isImageAttachment(att) ? 'image' : 'file';
  const asrSuffix = att.asrReferText ? ` (transcript: "${att.asrReferText}")` : '';
  if (att.localPath) {
    return `- [${kind}] (${att.contentType}) ${att.localPath}${asrSuffix}`;
  }
  const errDetail = att.error ? ` — download failed: ${att.error}` : '';
  return `- [${kind}] (${att.contentType}) ${att.filename}${asrSuffix}${errDetail}`;
}

/**
 * 构造发送给 Antigravity 会话的格式化提示词上下文。
 */
export function formatBridgePrompt(
  message: InboundMessage,
  replyToken: string,
  workspaceDir?: string,
  extra?: FormatBridgePromptOptions,
): string {
  const sender = message.senderName ? `${message.senderName} (${message.senderId})` : message.senderId;
  const memoryDirs =
    message.scope === 'c2c'
      ? (extra?.memoryDirs?.map((d) => d.trim()).filter(Boolean) ?? [])
      : [];
  const attachments = extra?.downloadedAttachments ?? [];
  const voiceTranscripts =
    extra?.voiceTranscripts?.map((t) => t.trim()).filter(Boolean) ??
    (message.attachments
      ?.map((att) => att.asrReferText?.trim() ?? '')
      .filter(Boolean) ?? []);

  const headerLines = [
    `[QQ ${message.scope} message]`,
    ...(message.botId ? [`botId: ${message.botId}`] : []),
    `peerId: ${message.peerId}`,
    `sender: ${sender}`,
    `replyToken: ${replyToken}`,
    ...(workspaceDir ? [`workspace: ${workspaceDir}`] : []),
    ...(memoryDirs.length > 0 ? [`memoryDirs: ${memoryDirs.join('; ')}`] : []),
  ];

  const bodySegments: string[] = [];
  if (attachments.length > 0) {
    const hasLocalImage = attachments.some((att) => Boolean(att.localPath) && isImageAttachment(att));
    const attachmentBlock = [
      '[Attachments]',
      ...attachments.map(formatAttachmentLine),
      ...(hasLocalImage
        ? ['(Use `read_file` on the local image path(s) above to view image content directly.)']
        : []),
    ].join('\n');
    bodySegments.push(attachmentBlock);
  }

  const voiceBlock =
    voiceTranscripts.length === 1
      ? `[Voice message] ${voiceTranscripts[0]}`
      : voiceTranscripts.map((t, idx) => `[Voice ${idx + 1}] ${t}`).join('\n');

  const trimmedText = message.text.trim();
  if (voiceBlock && trimmedText) {
    bodySegments.push(`${voiceBlock}\n${message.text}`);
  } else if (voiceBlock) {
    bodySegments.push(voiceBlock);
  } else if (trimmedText || attachments.length === 0) {
    bodySegments.push(message.text);
  } else {
    bodySegments.push('[User sent attachment(s) without additional text.]');
  }

  return `${headerLines.join('\n')}\n\n${bodySegments.join('\n\n')}`;
}

/**
 * 构造无头流式模式（`agy-stream`）专用的提示词：
 * 不注入 `replyToken`，直接将模型输出的文本增量实时推流至 QQ。
 */
export function formatStreamBridgePrompt(
  message: InboundMessage,
  workspaceDir?: string,
  extra?: FormatBridgePromptOptions,
): string {
  const sender = message.senderName ? `${message.senderName} (${message.senderId})` : message.senderId;
  const memoryDirs =
    message.scope === 'c2c'
      ? (extra?.memoryDirs?.map((d) => d.trim()).filter(Boolean) ?? [])
      : [];
  const attachments = extra?.downloadedAttachments ?? [];
  const voiceTranscripts =
    extra?.voiceTranscripts?.map((t) => t.trim()).filter(Boolean) ??
    (message.attachments
      ?.map((att) => att.asrReferText?.trim() ?? '')
      .filter(Boolean) ?? []);

  const headerLines = [
    `[QQ ${message.scope} stream]`,
    ...(message.botId ? [`botId: ${message.botId}`] : []),
    `peerId: ${message.peerId}`,
    `sender: ${sender}`,
    ...(workspaceDir ? [`workspace: ${workspaceDir}`] : []),
    ...(memoryDirs.length > 0 ? [`memoryDirs: ${memoryDirs.join('; ')}`] : []),
    ...(message.scope === 'c2c' && extra?.delegateToken
      ? [`delegateToken: ${extra.delegateToken}`]
      : []),
    'mode: direct-stream (Main QQ chat session: output your natural reply directly as assistant text; it streams live to QQ. Do NOT call qqbot_reply or run_command here. Use read_file / list_dir / find_by_name / grep_search for quick image or memory lookups. NEVER execute long-running, multi-step, research, coding, or file-writing tasks in this main chat session — immediately delegate them via qqbot_delegate_task using delegateToken, tell the user briefly that a background subagent is handling it, and end your turn so chat stays non-blocking.)',
  ];

  const bodySegments: string[] = [];
  if (extra?.completedSubtasks && extra.completedSubtasks.length > 0) {
    bodySegments.push(
      ['[Completed Background Subagent Reports]', ...extra.completedSubtasks].join('\n'),
    );
  }
  if (attachments.length > 0) {
    const hasLocalImage = attachments.some((att) => Boolean(att.localPath) && isImageAttachment(att));
    const attachmentBlock = [
      '[Attachments]',
      ...attachments.map(formatAttachmentLine),
      ...(hasLocalImage
        ? ['(Call `read_file` on the local image path(s) above first to view image content directly.)']
        : []),
    ].join('\n');
    bodySegments.push(attachmentBlock);
  }

  const voiceBlock =
    voiceTranscripts.length === 1
      ? `[Voice message] ${voiceTranscripts[0]}`
      : voiceTranscripts.map((t, idx) => `[Voice ${idx + 1}] ${t}`).join('\n');

  const trimmedText = message.text.trim();
  if (voiceBlock && trimmedText) {
    bodySegments.push(`${voiceBlock}\n${message.text}`);
  } else if (voiceBlock) {
    bodySegments.push(voiceBlock);
  } else if (trimmedText || attachments.length === 0) {
    bodySegments.push(message.text);
  } else {
    bodySegments.push('[User sent attachment(s) without additional text.]');
  }

  return `${headerLines.join('\n')}\n\n${bodySegments.join('\n\n')}`;
}

function defaultFormatTitle(message: InboundMessage): string {
  const label = (message.senderName?.trim() || message.peerId).replace(/[\r\n]+/g, ' ').trim();
  const title = `QQ ${message.scope}: ${label}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

/**
 * 组合 `SessionStore`、`AgentApiClient`、`ReplyTokenRegistry` 与 `CallbackServer`，
 * 构建完整的 QQ <-> Antigravity 桥接服务。
 */
export function createAntigravityBridge(
  options: CreateAntigravityBridgeOptions = {},
): AntigravityBridge {
  const env = options.env ?? process.env;
  const config = options.config ?? loadRuntimeConfig(env);
  const now = options.now ?? Date.now;
  const logger = options.logger;

  const dataDir = options.dataDir ?? config.dataDir;
  const workspaceRoot =
    options.workspaceRoot?.trim() ||
    (options.dataDir ? `${options.dataDir.replace(/[\\/]+$/, '')}/workspace` : config.workspaceRoot);
  const memoryDirs = options.memoryDirs ?? config.memoryDirs;
  const callbackHost = options.callbackHost ?? config.callbackHost;
  const callbackPort =
    options.callbackPort !== undefined ? options.callbackPort : config.callbackPort;
  const agentModel = options.agentModel ?? config.agentModel;
  const agentProfile = options.agentProfile ?? config.agentProfile;
  const backendMode: BackendMode = options.backendMode ?? config.backendMode ?? 'agentapi';
  const fallbackOnSendError = options.fallbackToNewConversationOnSendError ?? true;

  const sessionStore = options.sessionStore ?? new SessionStore({ dataDir, logger });
  const preferencesStore =
    options.preferencesStore ?? new PeerPreferencesStore({ dataDir, logger });
  const replyTokens =
    options.replyTokens ??
    new ReplyTokenRegistry({
      ttlMs: options.replyTokenTtlMs,
      now,
    });
  const agentApi =
    options.agentApi ??
    new AgentApiClient({
      invocation: options.invocation,
      runner: options.runner,
      env,
      timeoutMs: options.commandTimeoutMs,
      defaultModel: agentModel,
      defaultProfile: agentProfile,
      logger,
    });
  const agyStreamClient =
    options.agyStreamClient ??
    new AgyStreamClient({
      executable: options.agyExecutable ?? config.agyExecutable,
      runner: options.agyStreamRunner,
      env,
      timeoutMs: options.commandTimeoutMs,
      defaultModel: agentModel,
      logger,
    });

  const subagentTimeoutMs = options.subagentTimeoutMs ?? DEFAULT_AGY_SUBAGENT_TIMEOUT_MS;
  const activeSubtasks = new Map<
    string,
    {
      taskId: string;
      title: string;
      peerId: string;
      startedAt: number;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  const activeTurns = new Map<
    string,
    {
      controller: AbortController;
      abortedByUser: boolean;
    }
  >();
  const completedNoticesByPeer = new Map<string, string[]>();
  let subtaskCounter = 0;

  const deliverDirectText = async (target: ReplyTarget, text: string): Promise<void> => {
    if (options.onDeliverReply) {
      await options.onDeliverReply({
        replyToken: 'slash-command',
        target,
        text,
      });
      return;
    }
    if (options.onOpenReplyStream) {
      const sink = options.onOpenReplyStream(target);
      await sink.complete(text);
    }
  };

  const pushCompletedNotice = (peerId: string, summaryLine: string): void => {
    const list = completedNoticesByPeer.get(peerId) ?? [];
    list.push(summaryLine);
    if (list.length > 5) {
      list.splice(0, list.length - 5);
    }
    completedNoticesByPeer.set(peerId, list);
  };

  const drainCompletedNotices = (peerId: string): string[] => {
    const list = completedNoticesByPeer.get(peerId);
    if (!list || list.length === 0) {
      return [];
    }
    completedNoticesByPeer.delete(peerId);
    return list;
  };

  const launchDelegatedSubagent = (params: DelegateTaskParams): { taskId: string; acceptedAt: number } => {
    subtaskCounter += 1;
    const taskId = `subtask-${subtaskCounter}`;
    const acceptedAt = now();
    const controller = new AbortController();

    const botId = config.appId.trim() || undefined;
    const { sessionDir } = ensureSessionWorkspace({
      workspaceRoot,
      scope: 'c2c',
      peerId: params.target.targetId,
      ...(botId ? { botId } : {}),
    });

    const peerPrefs = preferencesStore.get(`c2c:${params.target.targetId}`);
    const selectedSubModel = peerPrefs?.subagentModel ?? peerPrefs?.model ?? agentModel;

    const taskCwd = params.workingDirectory?.trim() || sessionDir;
    const addDirs = [sessionDir, ...(memoryDirs ?? [])];
    const subagentPrompt = [
      `[QQ Background Autonomous Subagent — ${taskId}]`,
      `Task Title: ${params.title}`,
      `Working Directory: ${taskCwd}`,
      ...(memoryDirs && memoryDirs.length > 0 ? [`Memory Directories: ${memoryDirs.join('; ')}`] : []),
      '',
      'Instructions:',
      '- You are an independent background subagent spawned from the main QQ chat so the main conversation remains non-blocking.',
      '- You have full autonomous tool permissions to research, read/write files, and run commands needed to complete this task thoroughly.',
      '- Do NOT call `qqbot_reply` or `qqbot_delegate_task` (your final text output will be delivered to QQ automatically by the bridge).',
      '- End with a concise, mobile-friendly summary of what you accomplished, always citing full local absolute paths (never relative paths) for any created or modified files.',
      '',
      'Task Specification:',
      params.prompt,
    ].join('\n');

    const runPromise = (async (): Promise<void> => {
      logger?.info(`[bridge:subagent] Started ${taskId} ("${params.title}") in ${taskCwd}`);
      try {
        const result = await agyStreamClient.runStreamingTurn(subagentPrompt, {
          cwd: taskCwd,
          addDirs,
          ...(selectedSubModel ? { model: selectedSubModel } : {}),
          skipPermissions: true,
          timeoutMs: subagentTimeoutMs,
          signal: controller.signal,
        });

        const reportBody = result.text.trim() || '任务已执行完毕（无额外文本输出）。';
        const outboundText = `【后台子任务完成 · ${params.title}】\n\n${reportBody}`;
        const brief = reportBody.replace(/\s+/g, ' ').slice(0, 200);
        pushCompletedNotice(params.target.targetId, `- [${taskId}] "${params.title}" DONE: ${brief}`);

        if (options.onDeliverReply && !controller.signal.aborted) {
          await options.onDeliverReply({
            replyToken: params.delegateToken,
            // Omit stale msgId so QqGateway picks the freshest cached C2C msgId or falls back to proactive push
            target: {
              scope: 'c2c',
              targetId: params.target.targetId,
            },
            text: outboundText,
          });
        }
        logger?.info(`[bridge:subagent] Completed ${taskId} ("${params.title}")`);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        logger?.error(`[bridge:subagent] ${taskId} ("${params.title}") failed: ${errMsg}`);
        pushCompletedNotice(params.target.targetId, `- [${taskId}] "${params.title}" FAILED: ${errMsg.slice(0, 160)}`);

        if (options.onDeliverReply) {
          await Promise.resolve(
            options.onDeliverReply({
              replyToken: params.delegateToken,
              target: {
                scope: 'c2c',
                targetId: params.target.targetId,
              },
              text: `【后台子任务异常 · ${params.title}】\n\n执行中断：${errMsg}`,
            }),
          ).catch(() => undefined);
        }
      } finally {
        activeSubtasks.delete(taskId);
      }
    })();

    activeSubtasks.set(taskId, {
      taskId,
      title: params.title,
      peerId: params.target.targetId,
      startedAt: acceptedAt,
      controller,
      promise: runPromise,
    });
    return { taskId, acceptedAt };
  };

  const handleInstantSlashCommand = async (
    slashCmd: ParsedSlashCommand,
    message: InboundMessage,
    sessionKey: string,
    storeBotId: string | undefined,
  ): Promise<BridgeSession | null> => {
    const peerPrefKey = `${message.scope}:${message.peerId}`;
    const existing = sessionStore.get(message.scope, message.peerId, storeBotId);
    const makeSyntheticSession = (convId: string): BridgeSession => ({
      sessionKey,
      conversationId: existing?.conversationId ?? convId,
      scope: message.scope,
      peerId: message.peerId,
      ...(storeBotId ? { botId: storeBotId } : {}),
      lastActiveAt: now(),
    });

    const c2cOnlyCommands = new Set<ParsedSlashCommand['name']>([
      'model',
      'think',
      'submodel',
      'compact',
      'tasks',
      'cancel',
      'update',
    ]);
    if (message.scope !== 'c2c' && c2cOnlyCommands.has(slashCmd.name)) {
      await deliverDirectText(message.replyTarget, '⚠️ 该管理指令仅限私聊（C2C）使用。');
      return makeSyntheticSession('slash-forbidden');
    }

    if (slashCmd.name === 'help') {
      await deliverDirectText(message.replyTarget, formatSlashHelpText());
      return makeSyntheticSession('slash-help');
    }

    if (slashCmd.name === 'status') {
      const catalog = await agyStreamClient.listModels();
      const prefs = preferencesStore.get(peerPrefKey);
      const effectiveModel = prefs?.model ?? agentModel;
      const peerTasks = [...activeSubtasks.values()].filter((t) => t.peerId === message.peerId);
      const runningTurn = activeTurns.has(sessionKey);

      const statusLines = [
        '📊 当前 QQ 桥接状态',
        `• 运行后端：${backendMode}`,
        `• 会话 ID：${existing?.conversationId ?? '（尚未建立，发送消息即自动创建）'}`,
        `• 主对话状态：${runningTurn ? '🔄 正在生成回复中' : '🟢 空闲就绪'}`,
        `• 主对话模型：${formatModelDisplay(effectiveModel, catalog)}`,
        `• 思考强度：${prefs?.effort ?? '默认（跟随模型档位）'}`,
        ...(message.scope === 'c2c'
          ? [
              `• 子智能体模型：${
                prefs?.subagentModel
                  ? formatModelDisplay(prefs.subagentModel, catalog)
                  : '跟随主对话模型'
              }`,
              `• 后台子任务：${
                peerTasks.length === 0
                  ? '无'
                  : peerTasks
                      .map(
                        (t) =>
                          `${t.taskId} ("${t.title}", 已运行 ${Math.max(0, Math.round((now() - t.startedAt) / 1000))}s)`,
                      )
                      .join('；')
              }`,
            ]
          : []),
      ];
      await deliverDirectText(message.replyTarget, statusLines.join('\n'));
      return makeSyntheticSession('slash-status');
    }

    if (slashCmd.name === 'tasks') {
      const peerTasks = [...activeSubtasks.values()].filter((t) => t.peerId === message.peerId);
      if (peerTasks.length === 0) {
        await deliverDirectText(message.replyTarget, '📭 当前没有正在运行的后台子智能体任务。');
      } else {
        const lines = [
          `⚙️ 运行中的后台子任务（共 ${peerTasks.length} 个）：`,
          ...peerTasks.map(
            (t) =>
              `• ${t.taskId} — ${t.title}（已运行 ${Math.max(0, Math.round((now() - t.startedAt) / 1000))}s）`,
          ),
          '',
          '发送 `/cancel <taskId>` 或 `/cancel all` 可立即终止。',
        ];
        await deliverDirectText(message.replyTarget, lines.join('\n'));
      }
      return makeSyntheticSession('slash-tasks');
    }

    if (slashCmd.name === 'cancel') {
      const arg = slashCmd.args.trim().toLowerCase();
      const peerTasks = [...activeSubtasks.values()].filter((t) => t.peerId === message.peerId);
      const runningTurn = activeTurns.get(sessionKey);

      if (!arg || arg === 'all') {
        let cancelledMain = false;
        if (runningTurn) {
          runningTurn.abortedByUser = true;
          runningTurn.controller.abort();
          cancelledMain = true;
        }
        for (const t of peerTasks) {
          t.controller.abort();
          activeSubtasks.delete(t.taskId);
        }
        if (!cancelledMain && peerTasks.length === 0) {
          await deliverDirectText(message.replyTarget, 'ℹ️ 当前没有正在运行的主对话或后台子任务。');
        } else {
          const parts: string[] = [];
          if (cancelledMain) parts.push('当前主对话轮次');
          if (peerTasks.length > 0) parts.push(`${peerTasks.length} 个后台子任务`);
          await deliverDirectText(message.replyTarget, `🛑 已终止：${parts.join(' + ')}。`);
        }
        return makeSyntheticSession('slash-cancel');
      }

      if (arg === 'turn' || arg === 'main') {
        if (runningTurn) {
          runningTurn.abortedByUser = true;
          runningTurn.controller.abort();
          await deliverDirectText(message.replyTarget, '🛑 已终止当前正在生成的主对话轮次。');
        } else {
          await deliverDirectText(message.replyTarget, 'ℹ️ 当前没有正在生成的主对话轮次。');
        }
        return makeSyntheticSession('slash-cancel');
      }

      const matched = peerTasks.find((t) => t.taskId.toLowerCase() === arg);
      if (!matched) {
        await deliverDirectText(
          message.replyTarget,
          `⚠️ 未找到任务 "${slashCmd.args}"。发送 /tasks 查看运行中的任务编号。`,
        );
        return makeSyntheticSession('slash-cancel');
      }
      matched.controller.abort();
      activeSubtasks.delete(matched.taskId);
      await deliverDirectText(
        message.replyTarget,
        `🛑 已终止后台子任务 ${matched.taskId}（"${matched.title}"）。`,
      );
      return makeSyntheticSession('slash-cancel');
    }

    if (slashCmd.name === 'model') {
      const catalog = await agyStreamClient.listModels();
      const prefs = preferencesStore.get(peerPrefKey);
      const rawArg = slashCmd.args.trim();

      if (!rawArg) {
        await deliverDirectText(
          message.replyTarget,
          formatModelCatalogText(catalog, prefs?.model ?? agentModel, prefs?.effort),
        );
        return makeSyntheticSession('slash-model');
      }

      if (['auto', 'default', 'reset', 'clear'].includes(rawArg.toLowerCase())) {
        const updated = preferencesStore.update(peerPrefKey, { model: null }, now());
        if (backendMode === 'agy-stream' && !activeTurns.has(sessionKey)) {
          const botId = message.botId?.trim() || config.appId.trim() || undefined;
          const { sessionDir } = ensureSessionWorkspace({
            workspaceRoot,
            scope: message.scope,
            peerId: message.peerId,
            ...(botId ? { botId } : {}),
          });
          agyStreamClient.prewarm({
            poolKey: sessionKey,
            conversationId: existing?.conversationId,
            cwd: sessionDir,
            addDirs: message.scope === 'c2c' ? (memoryDirs ?? []) : [],
            ...(agentModel ? { model: agentModel } : {}),
            ...(updated.effort ? { effort: updated.effort } : {}),
          });
        }
        await deliverDirectText(
          message.replyTarget,
          `✅ 主对话模型已恢复默认：${formatModelDisplay(agentModel, catalog)}\n当前思考强度：${updated.effort ?? '默认'}`,
        );
        return makeSyntheticSession('slash-model');
      }

      const resolved = resolveAdaptiveModel(rawArg, prefs?.effort, catalog);
      if (resolved.match) {
        const { entry, inferredEffort } = resolved.match;
        const detected = detectModelFamilyAndTier(entry.id);
        const nextEffort = inferredEffort ?? detected.tier ?? prefs?.effort;
        const updated = preferencesStore.update(
          peerPrefKey,
          {
            model: entry.id,
            ...(nextEffort ? { effort: nextEffort } : {}),
          },
          now(),
        );
        if (backendMode === 'agy-stream' && !activeTurns.has(sessionKey)) {
          const botId = message.botId?.trim() || config.appId.trim() || undefined;
          const { sessionDir } = ensureSessionWorkspace({
            workspaceRoot,
            scope: message.scope,
            peerId: message.peerId,
            ...(botId ? { botId } : {}),
          });
          agyStreamClient.prewarm({
            poolKey: sessionKey,
            conversationId: existing?.conversationId,
            cwd: sessionDir,
            addDirs: message.scope === 'c2c' ? (memoryDirs ?? []) : [],
            model: entry.id,
            ...(updated.effort ? { effort: updated.effort } : {}),
          });
        }
        await deliverDirectText(
          message.replyTarget,
          `✅ 已切换主对话模型：${entry.label} [${entry.id}]\n当前思考强度：${updated.effort ?? '默认（跟随模型档位）'}`,
        );
        return makeSyntheticSession('slash-model');
      }

      if (resolved.candidates && resolved.candidates.length > 0) {
        const candidateLines = resolved.candidates.map((c) => {
          const idx = catalog.findIndex((item) => item.id === c.id);
          const prefix = idx >= 0 ? `[${idx + 1}] ` : '• ';
          return `${prefix}${c.label} (${c.id})`;
        });
        await deliverDirectText(
          message.replyTarget,
          `🤔 匹配到多个候选模型，请指定更精确的代号或编号：\n${candidateLines.join('\n')}`,
        );
        return makeSyntheticSession('slash-model');
      }

      await deliverDirectText(
        message.replyTarget,
        `⚠️ 未识别的模型代号 "${rawArg}"。\n常用简写：4c · 4a · 4h · 3.8f · sonnet · opus，或发送 /model 查看完整列表。`,
      );
      return makeSyntheticSession('slash-model');
    }

    if (slashCmd.name === 'think') {
      const catalog = await agyStreamClient.listModels();
      const prefs = preferencesStore.get(peerPrefKey);
      const rawArg = slashCmd.args.trim();

      if (!rawArg) {
        await deliverDirectText(
          message.replyTarget,
          [
            `🧠 当前思考强度：${prefs?.effort ?? '默认（跟随模型档位）'}`,
            `当前主对话模型：${formatModelDisplay(prefs?.model ?? agentModel, catalog)}`,
            '',
            '可选档位：low (l) · medium (m) · high (h) · xhigh (xh) · max · auto',
            '用法示例：`/think low`（秒回模式） · `/think high` · `/think xh`',
          ].join('\n'),
        );
        return makeSyntheticSession('slash-think');
      }

      if (['auto', 'default', 'reset', 'clear'].includes(rawArg.toLowerCase())) {
        const updated = preferencesStore.update(peerPrefKey, { effort: null }, now());
        if (backendMode === 'agy-stream' && !activeTurns.has(sessionKey)) {
          const botId = message.botId?.trim() || config.appId.trim() || undefined;
          const { sessionDir } = ensureSessionWorkspace({
            workspaceRoot,
            scope: message.scope,
            peerId: message.peerId,
            ...(botId ? { botId } : {}),
          });
          const effectiveModel = updated.model ?? agentModel;
          agyStreamClient.prewarm({
            poolKey: sessionKey,
            conversationId: existing?.conversationId,
            cwd: sessionDir,
            addDirs: message.scope === 'c2c' ? (memoryDirs ?? []) : [],
            ...(effectiveModel ? { model: effectiveModel } : {}),
          });
        }
        await deliverDirectText(
          message.replyTarget,
          `✅ 思考强度已恢复默认（跟随模型自身档位）。\n当前主对话模型：${formatModelDisplay(updated.model ?? agentModel, catalog)}`,
        );
        return makeSyntheticSession('slash-think');
      }

      const effort = parseThinkingEffort(rawArg);
      if (!effort) {
        await deliverDirectText(
          message.replyTarget,
          `⚠️ 无效的思考强度 "${rawArg}"。\n可选值：low (l) · medium (m) · high (h) · xhigh (xh) · max · auto`,
        );
        return makeSyntheticSession('slash-think');
      }

      const syncedModel = syncModelWithEffort(prefs?.model ?? agentModel, effort, catalog);
      const updated = preferencesStore.update(
        peerPrefKey,
        {
          effort,
          ...(syncedModel ? { model: syncedModel } : {}),
        },
        now(),
      );
      if (backendMode === 'agy-stream' && !activeTurns.has(sessionKey)) {
        const botId = message.botId?.trim() || config.appId.trim() || undefined;
        const { sessionDir } = ensureSessionWorkspace({
          workspaceRoot,
          scope: message.scope,
          peerId: message.peerId,
          ...(botId ? { botId } : {}),
        });
        const effectiveModel = updated.model ?? agentModel;
        agyStreamClient.prewarm({
          poolKey: sessionKey,
          conversationId: existing?.conversationId,
          cwd: sessionDir,
          addDirs: message.scope === 'c2c' ? (memoryDirs ?? []) : [],
          ...(effectiveModel ? { model: effectiveModel } : {}),
          effort,
        });
      }
      await deliverDirectText(
        message.replyTarget,
        `✅ 思考强度已设为：${effort}\n同步对齐主模型：${formatModelDisplay(updated.model ?? agentModel, catalog)}`,
      );
      return makeSyntheticSession('slash-think');
    }

    if (slashCmd.name === 'submodel') {
      const catalog = await agyStreamClient.listModels();
      const prefs = preferencesStore.get(peerPrefKey);
      const rawArg = slashCmd.args.trim();

      if (!rawArg) {
        await deliverDirectText(
          message.replyTarget,
          [
            `🤖 当前后台子智能体模型：${
              prefs?.subagentModel
                ? formatModelDisplay(prefs.subagentModel, catalog)
                : `跟随主对话模型（${formatModelDisplay(prefs?.model ?? agentModel, catalog)}）`
            }`,
            '用法示例：`/submodel 4h high` · `/submodel opus` · `/submodel auto`',
          ].join('\n'),
        );
        return makeSyntheticSession('slash-submodel');
      }

      if (['auto', 'default', 'reset', 'clear'].includes(rawArg.toLowerCase())) {
        preferencesStore.update(peerPrefKey, { subagentModel: null }, now());
        await deliverDirectText(
          message.replyTarget,
          `✅ 后台子智能体模型已设为：跟随主对话模型（${formatModelDisplay(prefs?.model ?? agentModel, catalog)}）`,
        );
        return makeSyntheticSession('slash-submodel');
      }

      const resolved = resolveAdaptiveModel(rawArg, 'high', catalog);
      if (resolved.match) {
        preferencesStore.update(peerPrefKey, { subagentModel: resolved.match.entry.id }, now());
        await deliverDirectText(
          message.replyTarget,
          `✅ 后台子智能体专属模型已设为：${resolved.match.entry.label} [${resolved.match.entry.id}]`,
        );
        return makeSyntheticSession('slash-submodel');
      }

      await deliverDirectText(
        message.replyTarget,
        `⚠️ 未识别的模型代号 "${rawArg}"。示例：\`/submodel 4h high\`、\`/submodel opus\`、\`/submodel auto\``,
      );
      return makeSyntheticSession('slash-submodel');
    }

    if (slashCmd.name === 'update') {
      await deliverDirectText(message.replyTarget, '🔄 正在检查并拉取 GitHub 远端最新代码…');
      try {
        const updateFn = options.onSelfUpdate ?? (() => runRepoSelfUpdate());
        const res = await updateFn();
        if (!res.updated) {
          await deliverDirectText(
            message.replyTarget,
            `✅ 当前已是最新版本（commit ${res.currentCommit}），无需重启。`,
          );
          return makeSyntheticSession('slash-update');
        }
        const summary = res.subject ? `\n更新说明：${res.subject}` : '';
        await deliverDirectText(
          message.replyTarget,
          `✅ 已同步最新更新（${res.previousCommit ?? 'old'} → ${res.currentCommit}）${summary}\n网关正在自动热重启生效（约 3 秒恢复）…`,
        );
        options.onRestartProcess?.();
        return makeSyntheticSession('slash-update');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await deliverDirectText(
          message.replyTarget,
          `⚠️ 自动更新失败：${errMsg.slice(0, 260)}`,
        );
        return makeSyntheticSession('slash-update');
      }
    }

    return null;
  };

  const callbackServer =
    options.callbackServer ??
    new CallbackServer({
      host: callbackHost,
      port: callbackPort,
      maxBodyBytes: options.maxBodyBytes,
      replyTokens,
      onDeliverReply: options.onDeliverReply,
      onDelegateTask: (params) => launchDelegatedSubagent(params),
      now,
      logger,
    });

  const dispatchQueues = new Map<string, Promise<unknown>>();

  function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = dispatchQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.catch(() => undefined);
    dispatchQueues.set(key, tail);
    void tail.finally(() => {
      if (dispatchQueues.get(key) === tail) {
        dispatchQueues.delete(key);
      }
    });
    return current;
  }

  return {
    async start(): Promise<void> {
      mkdirSync(workspaceRoot, { recursive: true });
      await callbackServer.start();

      // Sidecar 启动时自动后台预热最近活跃的 C2C 流式会话，使首条消息直接命中热进程
      if (backendMode === 'agy-stream' && agyStreamClient.supportsWarmPool()) {
        const recentStreamSession = sessionStore
          .list()
          .filter((s) => s.scope === 'c2c' && Boolean(s.botId?.endsWith('@stream')))
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        if (recentStreamSession) {
          const rawBotId = recentStreamSession.botId?.replace(/@stream$/, '') || undefined;
          const { sessionDir } = ensureSessionWorkspace({
            workspaceRoot,
            scope: 'c2c',
            peerId: recentStreamSession.peerId,
            ...(rawBotId && rawBotId !== 'default' ? { botId: rawBotId } : {}),
          });
          const prefs = preferencesStore.get(`c2c:${recentStreamSession.peerId}`);
          const effectiveModel = prefs?.model ?? agentModel;
          agyStreamClient.prewarm({
            poolKey: recentStreamSession.sessionKey,
            conversationId: recentStreamSession.conversationId,
            cwd: sessionDir,
            addDirs: memoryDirs ?? [],
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(prefs?.effort ? { effort: prefs.effort } : {}),
          });
        }
      }
    },

    async stop(): Promise<void> {
      for (const turn of activeTurns.values()) {
        turn.abortedByUser = true;
        turn.controller.abort();
      }
      activeTurns.clear();
      for (const entry of activeSubtasks.values()) {
        entry.controller.abort();
      }
      if (activeSubtasks.size > 0) {
        await Promise.allSettled([...activeSubtasks.values()].map((e) => e.promise));
        activeSubtasks.clear();
      }
      agyStreamClient.close();
      await callbackServer.stop();
    },

    async waitForBackgroundTasks(): Promise<void> {
      if (activeSubtasks.size > 0) {
        await Promise.allSettled([...activeSubtasks.values()].map((e) => e.promise));
      }
    },

    getSession(scope: ChatScope, peerId: string, botId?: string): BridgeSession | undefined {
      const rawBotId = botId ?? (config.appId.trim() || undefined);
      const effectiveBotId =
        backendMode === 'agy-stream' ? `${rawBotId ?? 'default'}@stream` : rawBotId;
      return sessionStore.get(scope, peerId, effectiveBotId);
    },

    getCallbackUrl(): string {
      return callbackServer.getUrl();
    },

    async dispatchInbound(message: InboundMessage): Promise<BridgeSession> {
      const botId = message.botId?.trim() || config.appId.trim() || undefined;
      const storeBotId = backendMode === 'agy-stream' ? `${botId ?? 'default'}@stream` : botId;
      const sessionKey = makeSessionKey(message.scope, message.peerId, storeBotId);
      const hasMediaAttachments = (message.attachments ?? []).some((att) => !att.asrReferText?.trim());
      const slashCmd = parseBridgeSlashCommand(message.text, hasMediaAttachments);

      if (slashCmd && slashCmd.name !== 'new' && slashCmd.name !== 'compact') {
        const instantResult = await handleInstantSlashCommand(
          slashCmd,
          message,
          sessionKey,
          storeBotId,
        );
        if (instantResult) {
          return instantResult;
        }
      }

      if (slashCmd?.name === 'new') {
        const runningTurn = activeTurns.get(sessionKey);
        if (runningTurn) {
          runningTurn.abortedByUser = true;
          runningTurn.controller.abort();
        }
      }

      return runSerialized(sessionKey, async () => {
        const { sessionDir } = ensureSessionWorkspace({
          workspaceRoot,
          scope: message.scope,
          peerId: message.peerId,
          ...(botId ? { botId } : {}),
        });
        const peerPrefKey = `${message.scope}:${message.peerId}`;
        const peerPrefs = preferencesStore.get(peerPrefKey);

        if (slashCmd?.name === 'new') {
          const prev = sessionStore.get(message.scope, message.peerId, storeBotId);
          sessionStore.delete(message.scope, message.peerId, storeBotId);
          agyStreamClient.evictWarmWorker(sessionKey);
          if (message.scope === 'c2c') {
            drainCompletedNotices(message.peerId);
          }
          if (backendMode === 'agy-stream') {
            const effectiveModel = peerPrefs?.model ?? agentModel;
            agyStreamClient.prewarm({
              poolKey: sessionKey,
              cwd: sessionDir,
              addDirs: message.scope === 'c2c' ? (memoryDirs ?? []) : [],
              ...(effectiveModel ? { model: effectiveModel } : {}),
              ...(peerPrefs?.effort ? { effort: peerPrefs.effort } : {}),
            });
          }
          const catalog = await agyStreamClient.listModels();
          await deliverDirectText(
            message.replyTarget,
            [
              '🆕 已开启全新对话上下文（下一条消息将创建新会话）。',
              ...(prev ? [`• 已归档旧会话：${prev.conversationId}`] : []),
              `• 保留当前模型：${formatModelDisplay(peerPrefs?.model ?? agentModel, catalog)}`,
              `• 保留思考强度：${peerPrefs?.effort ?? '默认（跟随模型档位）'}`,
            ].join('\n'),
          );
          return {
            sessionKey,
            conversationId: 'new',
            scope: message.scope,
            peerId: message.peerId,
            ...(storeBotId ? { botId: storeBotId } : {}),
            workspaceDir: sessionDir,
            lastActiveAt: now(),
          };
        }

        if (slashCmd?.name === 'compact') {
          if (message.scope !== 'c2c') {
            await deliverDirectText(message.replyTarget, '⚠️ 该管理指令仅限私聊（C2C）使用。');
            return {
              sessionKey,
              conversationId: 'slash-forbidden',
              scope: message.scope,
              peerId: message.peerId,
              ...(storeBotId ? { botId: storeBotId } : {}),
              workspaceDir: sessionDir,
              lastActiveAt: now(),
            };
          }
          if (backendMode !== 'agy-stream') {
            await deliverDirectText(
              message.replyTarget,
              '⚠️ `/compact` 仅支持无头流式后端（`QQBOT_BACKEND=agy-stream`）。',
            );
            return {
              sessionKey,
              conversationId: 'slash-unsupported',
              scope: message.scope,
              peerId: message.peerId,
              ...(storeBotId ? { botId: storeBotId } : {}),
              workspaceDir: sessionDir,
              lastActiveAt: now(),
            };
          }
          const existing = sessionStore.get(message.scope, message.peerId, storeBotId);
          if (!existing) {
            await deliverDirectText(
              message.replyTarget,
              'ℹ️ 当前没有活跃会话可供压缩，直接发送消息即可开始新对话。',
            );
            return {
              sessionKey,
              conversationId: 'none',
              scope: message.scope,
              peerId: message.peerId,
              ...(storeBotId ? { botId: storeBotId } : {}),
              workspaceDir: sessionDir,
              lastActiveAt: now(),
            };
          }

          const addDirs = memoryDirs ?? [];
          const banner = '⏳ 正在压缩当前会话上下文 (/compact)…';
          const compactSink = options.onOpenReplyStream
            ? options.onOpenReplyStream(message.replyTarget)
            : null;
          try {
            if (compactSink) {
              await compactSink.update(banner);
            }
            const compactRes = await agyStreamClient.runCompactConversation(
              existing.conversationId,
              slashCmd.args,
              {
                poolKey: sessionKey,
                cwd: sessionDir,
                addDirs,
                ...(peerPrefs?.model ? { model: peerPrefs.model } : {}),
                ...(peerPrefs?.effort ? { effort: peerPrefs.effort } : {}),
              },
            );
            const effectiveModel = peerPrefs?.model ?? agentModel;
            agyStreamClient.prewarm({
              poolKey: sessionKey,
              conversationId: compactRes.conversationId,
              cwd: sessionDir,
              addDirs,
              ...(effectiveModel ? { model: effectiveModel } : {}),
              ...(peerPrefs?.effort ? { effort: peerPrefs.effort } : {}),
            });
            const statsParts: string[] = [];
            if (compactRes.checkpointDurationSec !== undefined) {
              statsParts.push(`耗时 ${compactRes.checkpointDurationSec.toFixed(1)}s`);
            }
            if (compactRes.totalTokens !== undefined) {
              statsParts.push(`摘要消耗 ${compactRes.totalTokens} tokens`);
            }
            const suffix = statsParts.length > 0 ? `（${statsParts.join('，')}）` : '';
            const doneBody = `✅ 上下文压缩完成${suffix}！后续对话将在精简检查点之上继续。`;

            if (compactSink) {
              await compactSink.complete(`${banner}\n\n${doneBody}`);
            } else {
              await deliverDirectText(message.replyTarget, doneBody);
            }
            return sessionStore.upsert({
              scope: message.scope,
              peerId: message.peerId,
              botId: storeBotId,
              conversationId: compactRes.conversationId,
              workspaceDir: sessionDir,
              lastActiveAt: now(),
            });
          } catch (compactErr) {
            compactSink?.cancel();
            throw compactErr;
          }
        }

        const rawAttachments = message.attachments ?? [];
        const voiceTranscripts: string[] = [];
        const attachmentsToDownload = rawAttachments.filter((att) => {
          const transcript = att.asrReferText?.trim();
          if (transcript) {
            voiceTranscripts.push(transcript);
            return false;
          }
          return true;
        });

        const downloadedAttachments =
          attachmentsToDownload.length > 0
            ? await downloadInboundAttachments(attachmentsToDownload, sessionDir, {
                fetchImpl: options.fetchImpl,
                maxBytes: options.attachmentMaxBytes,
                timeoutMs: options.attachmentTimeoutMs,
                messageId: message.messageId,
                now,
                logger,
              })
            : [];

        if (backendMode === 'agy-stream') {
          const delegateToken =
            message.scope === 'c2c' ? replyTokens.issue(message.replyTarget) : undefined;
          const completedSubtasks =
            message.scope === 'c2c' ? drainCompletedNotices(message.peerId) : [];
          const streamPrompt = formatStreamBridgePrompt(message, sessionDir, {
            downloadedAttachments,
            voiceTranscripts,
            memoryDirs,
            ...(delegateToken ? { delegateToken } : {}),
            ...(completedSubtasks.length > 0 ? { completedSubtasks } : {}),
          });
          const existing = sessionStore.get(message.scope, message.peerId, storeBotId);
          const addDirs = message.scope === 'c2c' ? (memoryDirs ?? []) : [];
          const turnEntry = {
            controller: new AbortController(),
            abortedByUser: false,
          };
          activeTurns.set(sessionKey, turnEntry);

          const streamSink: ReplyStreamSink = options.onOpenReplyStream
            ? options.onOpenReplyStream(message.replyTarget)
            : {
                async update(): Promise<void> {},
                async complete(finalText: string): Promise<void> {
                  if (finalText.trim() && options.onDeliverReply) {
                    await options.onDeliverReply({
                      replyToken: 'agy-stream-direct',
                      target: message.replyTarget,
                      text: finalText,
                    });
                  }
                },
                cancel(): void {},
              };

          const commonTurnOpts = {
            poolKey: sessionKey,
            cwd: sessionDir,
            addDirs,
            ...(peerPrefs?.model ? { model: peerPrefs.model } : {}),
            ...(peerPrefs?.effort ? { effort: peerPrefs.effort } : {}),
            signal: turnEntry.controller.signal,
            onTextProgress: async (fullText: string) => {
              await streamSink.update(fullText);
            },
          };

          try {
            let turnResult;
            if (existing) {
              try {
                turnResult = await agyStreamClient.runStreamingTurn(streamPrompt, {
                  ...commonTurnOpts,
                  conversationId: existing.conversationId,
                });
              } catch (resumeErr) {
                if (!fallbackOnSendError || turnEntry.abortedByUser) {
                  throw resumeErr;
                }
                logger?.warn(
                  `[bridge:agy-stream] Resume failed for ${sessionKey} (${existing.conversationId}), starting fresh conversation: ${
                    resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
                  }`,
                );
                turnResult = await agyStreamClient.runStreamingTurn(streamPrompt, commonTurnOpts);
              }
            } else {
              turnResult = await agyStreamClient.runStreamingTurn(streamPrompt, commonTurnOpts);
            }

            const outboundText =
              turnResult.text.trim() ||
              '⚠️ 本轮未收到模型可见文本输出（可能触发了工具权限拦截或内部异常），请重试或发送 /new 重置会话。';
            await streamSink.complete(outboundText);

            return sessionStore.upsert({
              scope: message.scope,
              peerId: message.peerId,
              botId: storeBotId,
              conversationId: turnResult.conversationId,
              workspaceDir: sessionDir,
              lastActiveAt: now(),
            });
          } catch (streamErr) {
            streamSink.cancel();
            if (turnEntry.abortedByUser) {
              return {
                sessionKey,
                conversationId: existing?.conversationId ?? 'cancelled',
                scope: message.scope,
                peerId: message.peerId,
                ...(storeBotId ? { botId: storeBotId } : {}),
                workspaceDir: sessionDir,
                lastActiveAt: now(),
              };
            }
            throw streamErr;
          } finally {
            if (activeTurns.get(sessionKey) === turnEntry) {
              activeTurns.delete(sessionKey);
            }
          }
        }

        const replyToken = replyTokens.issue(message.replyTarget);
        const prompt = formatBridgePrompt(message, replyToken, sessionDir, {
          downloadedAttachments,
          voiceTranscripts,
          memoryDirs,
        });
        const title = (options.formatTitle ? options.formatTitle(message) : defaultFormatTitle(message))?.trim();
        const existing = sessionStore.get(message.scope, message.peerId, storeBotId);
        const selectedAgentModel = peerPrefs?.model ?? agentModel;

        let conversationId: string;
        if (existing) {
          try {
            await agentApi.sendMessage(existing.conversationId, prompt, { cwd: sessionDir });
            conversationId = existing.conversationId;
          } catch (sendErr) {
            if (!fallbackOnSendError) {
              replyTokens.revoke(replyToken);
              throw sendErr;
            }
            logger?.warn(
              `[bridge] sendMessage failed for ${sessionKey} (${existing.conversationId}), falling back to newConversation: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            );
            try {
              conversationId = await agentApi.newConversation(prompt, {
                ...(title ? { title } : {}),
                ...(selectedAgentModel ? { model: selectedAgentModel } : {}),
                cwd: sessionDir,
              });
            } catch (newErr) {
              replyTokens.revoke(replyToken);
              throw newErr;
            }
          }
        } else {
          try {
            conversationId = await agentApi.newConversation(prompt, {
              ...(title ? { title } : {}),
              ...(selectedAgentModel ? { model: selectedAgentModel } : {}),
              cwd: sessionDir,
            });
          } catch (newErr) {
            replyTokens.revoke(replyToken);
            throw newErr;
          }
        }

        return sessionStore.upsert({
          scope: message.scope,
          peerId: message.peerId,
          ...(storeBotId ? { botId: storeBotId } : {}),
          conversationId,
          workspaceDir: sessionDir,
          lastActiveAt: now(),
        });
      });
    },
  };
}
