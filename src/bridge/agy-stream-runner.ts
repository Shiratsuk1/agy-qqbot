import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppLogger } from '../shared/types.ts';
import {
  DEFAULT_MODEL_CATALOG,
  parseAgyModelsOutput,
} from './slash-commands.ts';
import type { ModelCatalogEntry, ThinkingEffort } from './slash-commands.ts';

export const DEFAULT_AGY_STREAM_TIMEOUT_MS = 180_000;
export const DEFAULT_AGY_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_AGY_WARM_IDLE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_AGY_MAX_WARM_WORKERS = 4;
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAIN_CHAT_CLI_SETTINGS_JSON = JSON.stringify({
  permissions: {
    allow: [
      'mcp(antigravity-qqbot_antigravity-qqbot/qqbot_delegate_task)',
      'mcp(antigravity-qqbot_antigravity-qqbot/*)',
    ],
  },
});

export interface AgyStreamRunRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
}

export interface AgyStreamRunResult {
  exitCode: number | null;
  stderr: string;
}

export type AgyStreamProcessRunner = (request: AgyStreamRunRequest) => Promise<AgyStreamRunResult>;

export interface AgyWarmProcessHandle {
  stdin: Pick<NodeJS.WritableStream, 'write' | 'end'>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error', listener: (err: Error) => void): unknown;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type AgyWarmProcessSpawner = (request: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) => AgyWarmProcessHandle;

export interface AgyTurnOptions {
  poolKey?: string;
  conversationId?: string;
  cwd?: string;
  addDirs?: readonly string[];
  model?: string;
  effort?: ThinkingEffort;
  skipPermissions?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTextProgress?: (fullTextSoFar: string, delta: string) => void | Promise<void>;
}

export interface AgyPrewarmOptions {
  poolKey: string;
  conversationId?: string;
  cwd?: string;
  addDirs?: readonly string[];
  model?: string;
  effort?: ThinkingEffort;
}

export interface AgyTurnResult {
  conversationId: string;
  text: string;
}

export interface AgyCompactOptions {
  poolKey?: string;
  cwd?: string;
  addDirs?: readonly string[];
  model?: string;
  effort?: ThinkingEffort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgyCompactResult {
  conversationId: string;
  checkpointDurationSec?: number;
  totalTokens?: number;
}

export interface AgyStreamClientOptions {
  executable?: string;
  runner?: AgyStreamProcessRunner;
  warmSpawner?: AgyWarmProcessSpawner;
  enableWarmPool?: boolean;
  warmIdleTtlMs?: number;
  maxWarmWorkers?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  defaultModel?: string;
  logger?: AppLogger;
}

/**
 * 解析本机 `agy` CLI 可执行文件路径。
 */
export function resolveAgyExecutable(
  explicitExe?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArg = explicitExe?.trim() || env.QQBOT_AGY_EXE?.trim();
  if (fromArg) {
    return fromArg;
  }

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    const winCandidate = join(localAppData, 'agy', 'bin', 'agy.exe');
    if (existsSync(winCandidate)) {
      return winCandidate;
    }
  } else {
    const unixCandidate = join(homedir(), '.local', 'bin', 'agy');
    if (existsSync(unixCandidate)) {
      return unixCandidate;
    }
  }

  return 'agy';
}

/**
 * 默认子进程流式执行器：逐行切分 UTF-8 `stdout` 实时回调 `onStdoutLine`。
 */
export function defaultAgyStreamProcessRunner(
  request: AgyStreamRunRequest,
): Promise<AgyStreamRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const maxStderrBytes = 512 * 1024;
    let stdoutRemainder = '';
    let lineChain: Promise<void> = Promise.resolve();
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timeoutMs = request.timeoutMs ?? DEFAULT_AGY_STREAM_TIMEOUT_MS;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminateChild = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2_000);
      killTimer.unref?.();
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      terminateChild();
    };

    if (request.signal) {
      if (request.signal.aborted) {
        aborted = true;
        terminateChild();
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const cleanupTimers = (): void => {
      if (request.signal) {
        request.signal.removeEventListener('abort', onAbort);
      }
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, timeoutMs);
    }

    const enqueueLine = (rawLine: string): void => {
      const trimmed = rawLine.replace(/\r$/, '');
      if (!trimmed.trim() || !request.onStdoutLine) {
        return;
      }
      lineChain = lineChain
        .then(() => request.onStdoutLine!(trimmed))
        .catch(() => {
          // 忽略单行回调异常，避免中断子进程收尾
        });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutRemainder += chunk;
      let nlIndex = stdoutRemainder.indexOf('\n');
      while (nlIndex >= 0) {
        const line = stdoutRemainder.slice(0, nlIndex);
        stdoutRemainder = stdoutRemainder.slice(nlIndex + 1);
        enqueueLine(line);
        nlIndex = stdoutRemainder.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxStderrBytes) {
        const remaining = maxStderrBytes - stderrBytes;
        stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      }
      stderrBytes += chunk.length;
    });

    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      rejectPromise(
        new Error(`Failed to execute ${request.executable}: ${err.message}`, { cause: err }),
      );
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();

      if (stdoutRemainder.trim()) {
        enqueueLine(stdoutRemainder);
        stdoutRemainder = '';
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      void lineChain.finally(() => {
        if (aborted) {
          rejectPromise(new Error(`${request.executable} aborted`));
          return;
        }
        if (timedOut) {
          rejectPromise(new Error(`${request.executable} timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === null && signal) {
          rejectPromise(new Error(`${request.executable} terminated by signal ${signal}`));
          return;
        }
        resolvePromise({ exitCode: code, stderr });
      });
    });
  });
}

export interface ParsedAgyStreamState {
  conversationId?: string;
  activeStepIndex?: number;
  accumulatedText: string;
  resultText?: string;
  resultStatus?: string;
  errorMessage?: string;
}

/**
 * 解析单行 `agy --output-format stream-json` NDJSON 事件并更新累积状态。
 * 返回本帧新增的可见文本增量（若有）。
 */
export function consumeAgyStreamLine(line: string, state: ParsedAgyStreamState): string {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '';
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return '';
  }

  const eventType = obj.event;
  if (typeof obj.conversation_id === 'string' && obj.conversation_id.trim()) {
    state.conversationId = obj.conversation_id.trim();
  }

  if (eventType === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
    const step = obj.step_update as Record<string, unknown>;
    if (typeof step.conversation_id === 'string' && step.conversation_id.trim()) {
      state.conversationId = step.conversation_id.trim();
    }

    if (step.state === 'ERROR' || (typeof step.error === 'string' && step.error.trim())) {
      const stepErr = typeof step.error === 'string' ? step.error.trim() : '';
      if (stepErr) {
        state.errorMessage = stepErr;
      } else if (!state.errorMessage) {
        state.errorMessage = `step ${String(step.step_type ?? 'execution')} failed`;
      }
    }

    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
      const delta = step.text_delta;
      if (!delta) {
        return '';
      }
      const stepIdx = typeof step.step_index === 'number' ? step.step_index : undefined;
      let prefix = '';
      if (
        stepIdx !== undefined &&
        state.activeStepIndex !== undefined &&
        stepIdx !== state.activeStepIndex &&
        state.accumulatedText.trim().length > 0 &&
        !state.accumulatedText.endsWith('\n')
      ) {
        prefix = '\n\n';
      }
      if (stepIdx !== undefined) {
        state.activeStepIndex = stepIdx;
      }
      const effectiveDelta = prefix + delta;
      state.accumulatedText += effectiveDelta;
      return effectiveDelta;
    }
    return '';
  }

  if (eventType === 'result' && obj.result && typeof obj.result === 'object') {
    const res = obj.result as Record<string, unknown>;
    if (typeof res.conversation_id === 'string' && res.conversation_id.trim()) {
      state.conversationId = res.conversation_id.trim();
    }
    if (typeof res.status === 'string') {
      state.resultStatus = res.status;
    }
    if (typeof res.response === 'string') {
      state.resultText = res.response;
    }
    if (typeof res.error === 'string' && res.error.trim()) {
      state.errorMessage = res.error.trim();
    }
  }

  return '';
}

export function defaultWarmProcessSpawner(request: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): AgyWarmProcessHandle {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child as unknown as AgyWarmProcessHandle;
}

function collectAddDirs(cwd?: string, addDirs?: readonly string[]): string[] {
  const dirSet = new Set<string>();
  if (cwd?.trim()) {
    dirSet.add(cwd.trim());
  }
  for (const extraDir of addDirs ?? []) {
    const trimmed = extraDir.trim();
    if (trimmed) {
      dirSet.add(trimmed);
    }
  }
  return [...dirSet];
}

function buildWarmConfigSignature(params: {
  cwd?: string;
  addDirs?: readonly string[];
  model?: string;
  effort?: ThinkingEffort;
}): string {
  const dirs = collectAddDirs(params.cwd, params.addDirs).sort();
  return JSON.stringify({
    cwd: params.cwd?.trim() || '',
    dirs,
    model: params.model?.trim() || '',
    effort: params.effort || '',
  });
}

interface ActiveWarmTurn {
  parseState: ParsedAgyStreamState;
  emittedDelta: boolean;
  onTextProgress?: (fullTextSoFar: string, delta: string) => void | Promise<void>;
  resolve: (result: AgyTurnResult) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

/**
 * 单个常驻 `agy --input-format stream-json --output-format stream-json` 热进程实例。
 * 消除每轮重复的 ~4.6s CLI/MCP 冷启动与 ~1.0s 进程销毁开销，并保持云端 Prompt Cache 热态。
 */
class WarmAgyWorker {
  readonly poolKey: string;
  readonly configSignature: string;
  readonly requestedConversationId?: string;
  conversationId?: string;
  lastUsedAt: number;

  private readonly executable: string;
  private readonly child: AgyWarmProcessHandle;
  private readonly idleTtlMs: number;
  private readonly onEvict: (worker: WarmAgyWorker) => void;
  private readonly logger?: AppLogger;

  private closed = false;
  private completedTurns = 0;
  private stdoutRemainder = '';
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private lineChain: Promise<void> = Promise.resolve();
  private initSettled = false;
  private resolveInit!: () => void;
  private rejectInit!: (err: Error) => void;
  private readonly initPromise: Promise<void>;
  private activeTurn: ActiveWarmTurn | null = null;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(params: {
    poolKey: string;
    configSignature: string;
    executable: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    requestedConversationId?: string;
    spawner: AgyWarmProcessSpawner;
    idleTtlMs: number;
    onEvict: (worker: WarmAgyWorker) => void;
    logger?: AppLogger;
  }) {
    this.poolKey = params.poolKey;
    this.configSignature = params.configSignature;
    this.executable = params.executable;
    this.requestedConversationId = params.requestedConversationId;
    this.conversationId = params.requestedConversationId;
    this.idleTtlMs = params.idleTtlMs;
    this.onEvict = params.onEvict;
    this.logger = params.logger;
    this.lastUsedAt = Date.now();

    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    // Prevent unhandled rejection when prewarm fails in background before any turn awaits it
    this.initPromise.catch(() => undefined);

    this.child = params.spawner({
      executable: params.executable,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
    });

    const maxStderrBytes = 256 * 1024;
    if ('setEncoding' in this.child.stdout && typeof this.child.stdout.setEncoding === 'function') {
      this.child.stdout.setEncoding('utf8');
    }

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stdoutRemainder += str;
      let nlIdx = this.stdoutRemainder.indexOf('\n');
      while (nlIdx >= 0) {
        const line = this.stdoutRemainder.slice(0, nlIdx).replace(/\r$/, '');
        this.stdoutRemainder = this.stdoutRemainder.slice(nlIdx + 1);
        if (line.trim()) {
          this.enqueueStdoutLine(line);
        }
        nlIdx = this.stdoutRemainder.indexOf('\n');
      }
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (this.stderrBytes < maxStderrBytes) {
        const rem = maxStderrBytes - this.stderrBytes;
        this.stderrChunks.push(buf.length > rem ? buf.subarray(0, rem) : buf);
      }
      this.stderrBytes += buf.length;
    });

    this.child.once('error', (err: Error) => {
      this.handleFatalExit(
        new Error(`Failed to execute ${this.executable}: ${err.message}`, { cause: err }),
      );
    });

    this.child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.stdoutRemainder.trim()) {
        this.enqueueStdoutLine(this.stdoutRemainder.replace(/\r$/, ''));
        this.stdoutRemainder = '';
      }
      const stderrText = Buffer.concat(this.stderrChunks).toString('utf8').trim();
      const reason =
        stderrText ||
        (signal
          ? `${this.executable} terminated by signal ${signal}`
          : `${this.executable} exited with code ${String(code)}`);
      void this.lineChain.finally(() => {
        this.handleFatalExit(new Error(`agy stream failed: ${reason}`));
      });
    });

    this.scheduleIdleTimer();
  }

  isClosed(): boolean {
    return this.closed;
  }

  isBusy(): boolean {
    return this.activeTurn !== null;
  }

  hasCompletedTurns(): boolean {
    return this.completedTurns > 0;
  }

  waitUntilReady(): Promise<void> {
    return this.initPromise;
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.closed || this.activeTurn || !Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (!this.activeTurn && !this.closed) {
        this.logger?.info?.(`[bridge:agy-warm] Idle TTL expired for ${this.poolKey}, closing warm worker`);
        this.dispose();
      }
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private enqueueStdoutLine(line: string): void {
    this.lineChain = this.lineChain
      .then(() => this.processStdoutLine(line))
      .catch(() => undefined);
  }

  private async processStdoutLine(line: string): Promise<void> {
    let parsedObj: Record<string, unknown> | undefined;
    try {
      const raw: unknown = JSON.parse(line);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsedObj = raw as Record<string, unknown>;
      }
    } catch {
      return;
    }
    if (!parsedObj) {
      return;
    }

    if (typeof parsedObj.conversation_id === 'string' && parsedObj.conversation_id.trim()) {
      this.conversationId = parsedObj.conversation_id.trim();
    }

    if (parsedObj.event === 'init') {
      if (!this.initSettled) {
        this.initSettled = true;
        this.resolveInit();
      }
      return;
    }

    const turn = this.activeTurn;
    if (!turn) {
      return;
    }

    const delta = consumeAgyStreamLine(line, turn.parseState);
    if (turn.parseState.conversationId) {
      this.conversationId = turn.parseState.conversationId;
    }
    if (delta) {
      turn.emittedDelta = true;
      if (turn.onTextProgress) {
        await turn.onTextProgress(turn.parseState.accumulatedText, delta);
      }
    }

    if (parsedObj.event === 'result') {
      this.activeTurn = null;
      turn.cleanup();

      const finalText = (
        turn.parseState.accumulatedText.trim() ||
        turn.parseState.resultText?.trim() ||
        ''
      ).trim();
      const convId = turn.parseState.conversationId || this.conversationId || '';

      if ((turn.parseState.resultStatus === 'ERROR' || turn.parseState.errorMessage) && !finalText) {
        const errMsg = turn.parseState.errorMessage || 'agy returned ERROR status';
        if (turn.parseState.resultStatus === 'ERROR') {
          this.dispose();
        } else {
          this.completedTurns += 1;
          this.lastUsedAt = Date.now();
          this.scheduleIdleTimer();
        }
        turn.reject(new Error(`agy stream failed: ${errMsg}`));
        return;
      }

      if (!convId) {
        this.dispose();
        turn.reject(new Error('agy stream finished without returning a conversation_id'));
        return;
      }

      this.completedTurns += 1;
      this.lastUsedAt = Date.now();
      this.scheduleIdleTimer();
      turn.resolve({
        conversationId: convId,
        text: finalText,
      });
    }
  }

  async runTurn(
    prompt: string,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      onTextProgress?: (fullTextSoFar: string, delta: string) => void | Promise<void>;
    },
  ): Promise<{ result: AgyTurnResult; emittedDelta: boolean }> {
    if (this.closed) {
      throw new Error('Warm agy worker is already closed');
    }
    if (this.activeTurn) {
      throw new Error(`Warm agy worker (${this.poolKey}) is already executing an active turn`);
    }

    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    let emittedDelta = false;
    const result = await new Promise<AgyTurnResult>((resolve, reject) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = (): void => {
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
      };

      const failAndDispose = (err: Error): void => {
        if (settled) return;
        settled = true;
        if (this.activeTurn?.reject === rejectWrapped) {
          this.activeTurn = null;
        }
        cleanup();
        this.dispose(err);
        reject(err);
      };

      const onAbort = (): void => {
        failAndDispose(new Error(`${this.executable} aborted`));
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          failAndDispose(new Error(`${this.executable} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      const resolveWrapped = (res: AgyTurnResult): void => {
        if (settled) return;
        settled = true;
        emittedDelta = turnRecord.emittedDelta;
        resolve(res);
      };

      const rejectWrapped = (err: Error): void => {
        if (settled) return;
        settled = true;
        emittedDelta = turnRecord.emittedDelta;
        reject(err);
      };

      const turnRecord: ActiveWarmTurn = {
        parseState: { accumulatedText: '' },
        emittedDelta: false,
        onTextProgress: options.onTextProgress,
        resolve: resolveWrapped,
        reject: rejectWrapped,
        cleanup,
      };
      this.activeTurn = turnRecord;

      this.initPromise
        .then(() => {
          if (settled || this.closed) {
            return;
          }
          const payload = JSON.stringify({
            event: 'user',
            message: {
              role: 'user',
              content: prompt,
            },
          });
          this.child.stdin.write(`${payload}\n`);
        })
        .catch((initErr: unknown) => {
          failAndDispose(initErr instanceof Error ? initErr : new Error(String(initErr)));
        });
    }).catch((err: unknown) => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      (wrapped as Error & { emittedDelta?: boolean }).emittedDelta = emittedDelta;
      throw wrapped;
    });

    return { result, emittedDelta };
  }

  private handleFatalExit(err: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.killTimer !== undefined) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    if (!this.initSettled) {
      this.initSettled = true;
      this.rejectInit(err);
    }
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      turn.cleanup();
      turn.reject(err);
    }
    if (!wasClosed) {
      this.onEvict(this);
    }
  }

  dispose(reason?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (!this.initSettled) {
      this.initSettled = true;
      this.rejectInit(reason ?? new Error('Warm agy worker disposed'));
    }
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      turn.cleanup();
      turn.reject(reason ?? new Error('Warm agy worker disposed'));
    }
    this.onEvict(this);

    try {
      this.child.stdin.end();
    } catch {
      // ignore closed pipe
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore kill failure
    }
    this.killTimer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // ignore kill failure
      }
    }, 1_500);
    this.killTimer.unref?.();
  }
}

/**
 * 基于官方 `agy --output-format stream-json` 的无头流式会话客户端。
 *
 * - 共享本机已登录的 Antigravity 账号额度（无需单独配置 GEMINI_API_KEY）
 * - 运行于独立无头 CLI 进程，不触发桌面版 Electron 完成提示音
 * - 主对话默认采用 `--input-format stream-json` 常驻热进程池，消除每轮冷启动与销毁延迟
 */
export class AgyStreamClient {
  private readonly executable: string;
  private readonly runner: AgyStreamProcessRunner;
  private readonly warmSpawner: AgyWarmProcessSpawner;
  private readonly useWarmPool: boolean;
  private readonly warmIdleTtlMs: number;
  private readonly maxWarmWorkers: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly defaultModel?: string;
  private readonly logger?: AppLogger;
  private readonly warmWorkers = new Map<string, WarmAgyWorker>();
  private cachedModels?: { entries: ModelCatalogEntry[]; expiresAt: number };

  constructor(options: AgyStreamClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.executable = resolveAgyExecutable(options.executable, this.env);
    this.runner = options.runner ?? defaultAgyStreamProcessRunner;
    this.warmSpawner = options.warmSpawner ?? defaultWarmProcessSpawner;
    // 默认真实运行时（未注入单次 mock runner）自动开启常驻热进程池；若显式传入 warmSpawner 或 enableWarmPool 也按显式值生效
    this.useWarmPool =
      options.enableWarmPool ?? (options.warmSpawner !== undefined || options.runner === undefined);
    this.warmIdleTtlMs = options.warmIdleTtlMs ?? DEFAULT_AGY_WARM_IDLE_TTL_MS;
    this.maxWarmWorkers = Math.max(1, options.maxWarmWorkers ?? DEFAULT_AGY_MAX_WARM_WORKERS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AGY_STREAM_TIMEOUT_MS;
    this.defaultModel = options.defaultModel?.trim() || undefined;
    this.logger = options.logger;
  }

  supportsWarmPool(): boolean {
    return this.useWarmPool;
  }

  private buildWarmArgs(params: {
    conversationId?: string;
    cwd?: string;
    addDirs?: readonly string[];
    model?: string;
    effort?: ThinkingEffort;
  }): string[] {
    const args: string[] = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--settings',
      DEFAULT_MAIN_CHAT_CLI_SETTINGS_JSON,
    ];
    if (params.conversationId?.trim()) {
      args.push('--conversation', params.conversationId.trim());
    }
    const model = params.model?.trim() || this.defaultModel;
    if (model) {
      args.push('--model', model);
    }
    if (params.effort) {
      args.push('--effort', params.effort);
    }
    for (const dir of collectAddDirs(params.cwd, params.addDirs)) {
      args.push('--add-dir', dir);
    }
    return args;
  }

  private canReuseWorker(worker: WarmAgyWorker, configSignature: string, requestedConvId?: string): boolean {
    if (worker.isClosed() || worker.isBusy()) {
      return false;
    }
    if (worker.configSignature !== configSignature) {
      return false;
    }
    const trimmedReq = requestedConvId?.trim() || undefined;
    if (trimmedReq) {
      return worker.conversationId === trimmedReq;
    }
    // 新建会话（requestedConvId 为空）：仅可复用尚未执行过任何轮次的空白预热进程
    return !worker.hasCompletedTurns() && !worker.requestedConversationId;
  }

  private enforceMaxWarmWorkers(excludeKey?: string): void {
    while (this.warmWorkers.size >= this.maxWarmWorkers) {
      let oldestKey: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, w] of this.warmWorkers.entries()) {
        if (key === excludeKey || w.isBusy()) continue;
        if (w.lastUsedAt < oldestTime) {
          oldestTime = w.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        break;
      }
      this.warmWorkers.get(oldestKey)?.dispose();
      this.warmWorkers.delete(oldestKey);
    }
  }

  private getOrSpawnWarmWorker(params: {
    poolKey: string;
    conversationId?: string;
    cwd?: string;
    addDirs?: readonly string[];
    model?: string;
    effort?: ThinkingEffort;
  }): { worker: WarmAgyWorker; reused: boolean } {
    const model = params.model?.trim() || this.defaultModel;
    const configSignature = buildWarmConfigSignature({
      cwd: params.cwd,
      addDirs: params.addDirs,
      model,
      effort: params.effort,
    });
    const existing = this.warmWorkers.get(params.poolKey);
    if (existing && this.canReuseWorker(existing, configSignature, params.conversationId)) {
      return { worker: existing, reused: true };
    }
    if (existing) {
      existing.dispose();
      this.warmWorkers.delete(params.poolKey);
    }

    this.enforceMaxWarmWorkers(params.poolKey);

    const requestedConversationId = params.conversationId?.trim() || undefined;
    const args = this.buildWarmArgs({
      conversationId: requestedConversationId,
      cwd: params.cwd,
      addDirs: params.addDirs,
      model,
      effort: params.effort,
    });

    this.logger?.info?.(
      `[bridge:agy-warm] Spawning warm agy worker (key=${params.poolKey}, conv=${requestedConversationId ?? 'new'}, model=${model ?? 'default'}, effort=${params.effort ?? 'default'})`,
    );

    const worker = new WarmAgyWorker({
      poolKey: params.poolKey,
      configSignature,
      executable: this.executable,
      args,
      cwd: params.cwd,
      env: this.env,
      requestedConversationId,
      spawner: this.warmSpawner,
      idleTtlMs: this.warmIdleTtlMs,
      logger: this.logger,
      onEvict: (evicted) => {
        if (this.warmWorkers.get(params.poolKey) === evicted) {
          this.warmWorkers.delete(params.poolKey);
        }
      },
    });
    this.warmWorkers.set(params.poolKey, worker);
    return { worker, reused: false };
  }

  /**
   * 后台非阻塞预热常驻 CLI 进程（用于 Sidecar 启动、`/model`、`/think`、`/new`、`/compact` 后提前完成 `init`）。
   */
  prewarm(options: AgyPrewarmOptions): void {
    if (!this.useWarmPool) {
      return;
    }
    const poolKey = options.poolKey.trim();
    if (!poolKey) {
      return;
    }
    try {
      this.getOrSpawnWarmWorker({
        poolKey,
        conversationId: options.conversationId,
        cwd: options.cwd,
        addDirs: options.addDirs,
        model: options.model,
        effort: options.effort,
      });
    } catch (err) {
      this.logger?.warn?.(
        `[bridge:agy-warm] Prewarm failed for ${poolKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 驱逐并安全关闭指定 `poolKey` 的常驻进程（用于 `/new`、`/compact` 前释放会话锁）。
   */
  evictWarmWorker(poolKey: string): void {
    const found = this.warmWorkers.get(poolKey.trim());
    if (found) {
      this.warmWorkers.delete(poolKey.trim());
      found.dispose();
    }
  }

  /**
   * 关闭全部常驻热进程（用于桥接网关停止时清理所有子进程）。
   */
  close(): void {
    const workers = [...this.warmWorkers.values()];
    this.warmWorkers.clear();
    for (const worker of workers) {
      worker.dispose();
    }
  }

  async runStreamingTurn(prompt: string, options: AgyTurnOptions = {}): Promise<AgyTurnResult> {
    if (!options.skipPermissions && this.useWarmPool) {
      const poolKey =
        options.poolKey?.trim() ||
        options.conversationId?.trim() ||
        options.cwd?.trim() ||
        'default';
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const { worker, reused } = this.getOrSpawnWarmWorker({
        poolKey,
        conversationId: options.conversationId,
        cwd: options.cwd,
        addDirs: options.addDirs,
        model: options.model,
        effort: options.effort,
      });

      try {
        const { result } = await worker.runTurn(prompt, {
          timeoutMs,
          signal: options.signal,
          onTextProgress: options.onTextProgress,
        });
        return result;
      } catch (err) {
        const emittedDelta = Boolean((err as { emittedDelta?: boolean }).emittedDelta);
        if (reused && !emittedDelta && !options.signal?.aborted) {
          this.logger?.warn?.(
            `[bridge:agy-warm] Reused warm worker (${poolKey}) failed before first token, retrying with fresh worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          const fresh = this.getOrSpawnWarmWorker({
            poolKey,
            conversationId: options.conversationId,
            cwd: options.cwd,
            addDirs: options.addDirs,
            model: options.model,
            effort: options.effort,
          });
          const retryOutcome = await fresh.worker.runTurn(prompt, {
            timeoutMs,
            signal: options.signal,
            onTextProgress: options.onTextProgress,
          });
          return retryOutcome.result;
        }
        throw err;
      }
    }

    return this.runOneShotTurn(prompt, options);
  }

  private async runOneShotTurn(prompt: string, options: AgyTurnOptions = {}): Promise<AgyTurnResult> {
    const args: string[] = ['--output-format', 'stream-json', '--disable-slash-commands'];

    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--settings', DEFAULT_MAIN_CHAT_CLI_SETTINGS_JSON);
    }

    if (options.conversationId?.trim()) {
      args.push('--conversation', options.conversationId.trim());
    }

    const model = options.model?.trim() || this.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    if (options.effort) {
      args.push('--effort', options.effort);
    }

    for (const dir of collectAddDirs(options.cwd, options.addDirs)) {
      args.push('--add-dir', dir);
    }

    args.push(`--print=${prompt}`);

    const parseState: ParsedAgyStreamState = {
      accumulatedText: '',
    };

    const runResult = await this.runner({
      executable: this.executable,
      args,
      cwd: options.cwd,
      env: this.env,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      onStdoutLine: async (line: string) => {
        const delta = consumeAgyStreamLine(line, parseState);
        if (delta && options.onTextProgress) {
          await options.onTextProgress(parseState.accumulatedText, delta);
        }
      },
    });

    const finalText = (parseState.accumulatedText.trim() || parseState.resultText?.trim() || '').trim();
    const conversationId = parseState.conversationId || options.conversationId?.trim() || '';

    if ((runResult.exitCode !== 0 || parseState.errorMessage) && !finalText) {
      const detail =
        parseState.errorMessage ||
        runResult.stderr.trim() ||
        `agy exited with code ${String(runResult.exitCode)}`;
      this.logger?.warn?.(`[bridge:agy-stream] Streaming turn failed: ${detail}`);
      throw new Error(`agy stream failed: ${detail}`);
    }

    if (!conversationId) {
      throw new Error('agy stream finished without returning a conversation_id');
    }

    return {
      conversationId,
      text: finalText,
    };
  }

  /**
   * 对指定已有会话执行原生 `/compact` 上下文压缩（不能附带 `--disable-slash-commands`）。
   * 注意：`agy` 在 `/compact` 成功后会输出 `checkpoint` 完成事件及 `result.status === "SUCCESS"`，
   * 但因无可见 assistant 文本可能返回 `exitCode === 1`（伴随 `warning: run ended with no output`），需按 `SUCCESS` 判定。
   */
  async runCompactConversation(
    conversationId: string,
    instructions?: string,
    options: AgyCompactOptions = {},
  ): Promise<AgyCompactResult> {
    const convId = conversationId.trim();
    if (!convId) {
      throw new Error('runCompactConversation requires a non-empty conversationId');
    }

    if (options.poolKey?.trim()) {
      this.evictWarmWorker(options.poolKey.trim());
    }
    for (const [k, w] of this.warmWorkers.entries()) {
      if (w.conversationId === convId) {
        this.warmWorkers.delete(k);
        w.dispose();
      }
    }

    const args: string[] = ['--output-format', 'stream-json', '--conversation', convId];

    const model = options.model?.trim() || this.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    if (options.effort) {
      args.push('--effort', options.effort);
    }

    const dirSet = new Set<string>();
    if (options.cwd?.trim()) {
      dirSet.add(options.cwd.trim());
    }
    for (const extraDir of options.addDirs ?? []) {
      const trimmed = extraDir.trim();
      if (trimmed) {
        dirSet.add(trimmed);
      }
    }
    for (const dir of dirSet) {
      args.push('--add-dir', dir);
    }

    const trimmedInstructions = instructions?.trim() ?? '';
    const compactPrompt = trimmedInstructions ? `/compact ${trimmedInstructions}` : '/compact';
    args.push(`--print=${compactPrompt}`);

    const parseState: ParsedAgyStreamState = {
      accumulatedText: '',
    };
    let checkpointDone = false;
    let checkpointDurationSec: number | undefined;
    let totalTokens: number | undefined;

    const runResult = await this.runner({
      executable: this.executable,
      args,
      cwd: options.cwd,
      env: this.env,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      onStdoutLine: (line: string) => {
        consumeAgyStreamLine(line, parseState);
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.event === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
            const step = obj.step_update as Record<string, unknown>;
            if (step.step_type === 'checkpoint' && step.state === 'DONE') {
              checkpointDone = true;
              if (typeof step.duration_seconds === 'number') {
                checkpointDurationSec = step.duration_seconds;
              }
              if (step.usage && typeof step.usage === 'object') {
                const usage = step.usage as Record<string, unknown>;
                if (typeof usage.total_tokens === 'number') {
                  totalTokens = usage.total_tokens;
                }
              }
            }
          }
        } catch {
          // ignore malformed line
        }
      },
    });

    const succeeded =
      checkpointDone ||
      parseState.resultStatus === 'SUCCESS' ||
      (runResult.exitCode === 0 && !parseState.errorMessage);

    if (!succeeded) {
      const detail =
        parseState.errorMessage ||
        runResult.stderr.trim() ||
        `agy /compact exited with code ${String(runResult.exitCode)}`;
      this.logger?.warn?.(`[bridge:agy-stream] /compact failed: ${detail}`);
      throw new Error(`agy /compact failed: ${detail}`);
    }

    return {
      conversationId: parseState.conversationId || convId,
      ...(checkpointDurationSec !== undefined ? { checkpointDurationSec } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  /**
   * 动态查询本机 `agy models` 可用模型目录（带 5 分钟内存缓存，失败时平滑降级为内置目录）。
   */
  async listModels(options: { forceRefresh?: boolean; timeoutMs?: number } = {}): Promise<ModelCatalogEntry[]> {
    const now = Date.now();
    if (!options.forceRefresh && this.cachedModels && this.cachedModels.expiresAt > now) {
      return [...this.cachedModels.entries];
    }

    const stdoutLines: string[] = [];
    try {
      const res = await this.runner({
        executable: this.executable,
        args: ['models'],
        env: this.env,
        timeoutMs: options.timeoutMs ?? 10_000,
        onStdoutLine: (line) => {
          stdoutLines.push(line);
        },
      });
      if (res.exitCode === 0 && stdoutLines.length > 0) {
        const parsed = parseAgyModelsOutput(stdoutLines.join('\n'));
        this.cachedModels = {
          entries: parsed,
          expiresAt: now + MODEL_CATALOG_CACHE_TTL_MS,
        };
        return [...parsed];
      }
    } catch (err) {
      this.logger?.warn?.(
        `[bridge:agy-stream] Failed to list models dynamically, using default catalog: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return [...DEFAULT_MODEL_CATALOG];
  }
}
