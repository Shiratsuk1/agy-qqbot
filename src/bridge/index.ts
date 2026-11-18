export {
  AgentApiClient,
  defaultAgentApiRunner,
  parseConversationId,
  resolveAgentApiCommand,
} from './agentapi-client.ts';
export type {
  AgentApiClientOptions,
  AgentApiInvocation,
  AgentApiRunRequest,
  AgentApiRunResult,
  AgentApiRunner,
  NewConversationOptions,
  SendMessageOptions,
} from './agentapi-client.ts';

export {
  createAntigravityBridge,
  formatBridgePrompt,
  formatStreamBridgePrompt,
} from './bridge.ts';
export type {
  AntigravityBridge,
  CreateAntigravityBridgeOptions,
  FormatBridgePromptOptions,
  OpenReplyStreamHandler,
  ReplyStreamSink,
} from './bridge.ts';

export {
  AgyStreamClient,
  DEFAULT_AGY_MAX_WARM_WORKERS,
  DEFAULT_AGY_STREAM_TIMEOUT_MS,
  DEFAULT_AGY_SUBAGENT_TIMEOUT_MS,
  DEFAULT_AGY_WARM_IDLE_TTL_MS,
  consumeAgyStreamLine,
  defaultAgyStreamProcessRunner,
  defaultWarmProcessSpawner,
  resolveAgyExecutable,
} from './agy-stream-runner.ts';
export type {
  AgyCompactOptions,
  AgyCompactResult,
  AgyPrewarmOptions,
  AgyStreamClientOptions,
  AgyStreamProcessRunner,
  AgyStreamRunRequest,
  AgyStreamRunResult,
  AgyTurnOptions,
  AgyTurnResult,
  AgyWarmProcessHandle,
  AgyWarmProcessSpawner,
  ParsedAgyStreamState,
} from './agy-stream-runner.ts';

export {
  DEFAULT_MODEL_CATALOG,
  PeerPreferencesStore,
  detectModelFamilyAndTier,
  formatModelCatalogText,
  formatModelDisplay,
  formatSlashHelpText,
  parseAgyModelsOutput,
  parseBridgeSlashCommand,
  parseThinkingEffort,
  resolveAdaptiveModel,
  runRepoSelfUpdate,
  syncModelWithEffort,
} from './slash-commands.ts';
export type {
  AdaptiveModelMatch,
  ModelCatalogEntry,
  ParsedSlashCommand,
  PeerModelPreferences,
  SelfUpdateResult,
  ThinkingEffort,
} from './slash-commands.ts';

export {
  DEFAULT_ATTACHMENT_TIMEOUT_MS,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  downloadInboundAttachments,
  isImageAttachment,
  normalizeAttachmentUrl,
  sniffImageExtension,
} from './attachments.ts';
export type { DownloadAttachmentsOptions } from './attachments.ts';

export {
  CallbackServer,
  DEFAULT_CALLBACK_HOST,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_MAX_BODY_BYTES,
} from './callback-server.ts';
export type {
  CallbackServerAddress,
  CallbackServerOptions,
  DelegateTaskHandler,
  DelegateTaskParams,
  DelegateTaskResult,
  DeliverMediaHandler,
  DeliverMediaParams,
  DeliverMediaResult,
  DeliverReplyHandler,
  DeliverReplyParams,
  DeliverReplyResult,
} from './callback-server.ts';

export { DEFAULT_REPLY_TOKEN_TTL_MS, ReplyTokenRegistry } from './reply-tokens.ts';
export type { ReplyTokenEntry, ReplyTokenRegistryOptions } from './reply-tokens.ts';

export { SessionStore, makeSessionKey } from './session-store.ts';
export type { SessionStoreOptions, SessionUpsertInput } from './session-store.ts';

export {
  ensureSessionWorkspace,
  resolveSessionWorkspaceDir,
  sanitizeWorkspaceSegment,
} from './workspace.ts';
export type {
  ResolveSessionWorkspaceOptions,
  SessionWorkspacePaths,
} from './workspace.ts';
