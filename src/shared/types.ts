/**
 * 跨模块共享核心类型定义。
 *
 * 约定：保持纯类型声明，不引入运行时第三方依赖，
 * 以便 src/qq、src/bridge、src/mcp 各自独立演进与测试。
 */

export type ChatScope = 'c2c' | 'group';

export type BackendMode = 'agentapi' | 'agy-stream';

export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
  eventId?: string;
  forceProactive?: boolean;
}

export interface InboundAttachmentItem {
  contentType: string;
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  asrReferText?: string;
}

export interface DownloadedAttachment {
  contentType: string;
  url: string;
  filename: string;
  localPath?: string;
  size?: number;
  asrReferText?: string;
  error?: string;
}

export interface InboundMessage {
  messageId: string;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  senderName?: string;
  botId?: string;
  text: string;
  attachments?: InboundAttachmentItem[];
  receivedAt: number;
  replyTarget: ReplyTarget;
}

export interface OutboundReply {
  target: ReplyTarget;
  text: string;
  replyToken?: string;
}

export type MediaKind = 'image' | 'file' | 'voice' | 'video';

export interface OutboundMedia {
  target: ReplyTarget;
  mediaType?: MediaKind;
  localPath?: string;
  url?: string;
  fileName?: string;
  caption?: string;
  replyToken?: string;
}

export interface BridgeSession {
  sessionKey: string;
  conversationId: string;
  scope: ChatScope;
  peerId: string;
  botId?: string;
  workspaceDir?: string;
  lastActiveAt: number;
}

export interface AppLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export interface CallbackReplyRequest {
  replyToken: string;
  text: string;
}

export interface CallbackReplyResponse {
  ok: boolean;
  error?: string;
  chunksSent?: number;
  deliveredAt?: number;
}

export interface CallbackDelegateRequest {
  delegateToken: string;
  title: string;
  prompt: string;
  workingDirectory?: string;
}

export interface CallbackDelegateResponse {
  ok: boolean;
  error?: string;
  taskId?: string;
  acceptedAt?: number;
}

export interface CallbackMediaRequest {
  replyToken: string;
  mediaType?: MediaKind;
  localPath?: string;
  url?: string;
  fileName?: string;
  caption?: string;
}

export interface CallbackMediaResponse {
  ok: boolean;
  error?: string;
  mediaType?: MediaKind;
  deliveredAt?: number;
}

export interface CallbackHealthResponse {
  ok: boolean;
  uptimeMs: number;
}

export interface RuntimeConfig {
  appId: string;
  appSecret: string;
  callbackHost: string;
  callbackPort: number;
  dataDir: string;
  workspaceRoot: string;
  projectId?: string;
  apiBaseUrl: string;
  tokenBaseUrl: string;
  markdownSupport: boolean;
  requireMentionInGroup: boolean;
  textChunkLimit: number;
  passiveReplyLimit: number;
  debug: boolean;
  qrSource?: string;
  agentModel?: string;
  agentProfile?: string;
  memoryDirs?: string[];
  backendMode?: BackendMode;
  agyExecutable?: string;
}
