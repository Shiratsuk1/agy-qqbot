import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AgyStreamClient } from '../src/bridge/index.ts';
import type { AgyWarmProcessHandle } from '../src/bridge/index.ts';

interface MockWarmChild {
  args: readonly string[];
  stdinLines: string[];
  killed: boolean;
  ended: boolean;
  emitStdoutJson: (obj: unknown) => void;
  crash: (code?: number, stderrText?: string) => void;
  handle: AgyWarmProcessHandle;
}

function createMockWarmChild(args: readonly string[]): MockWarmChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const stdinLines: string[] = [];
  let stdinBuf = '';
  let killed = false;
  let ended = false;

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    stdinBuf += chunk;
    let nl = stdinBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (line) {
        stdinLines.push(line);
      }
      nl = stdinBuf.indexOf('\n');
    }
  });
  stdin.on('end', () => {
    ended = true;
  });

  const handle: AgyWarmProcessHandle = {
    stdin,
    stdout,
    stderr,
    kill() {
      killed = true;
      emitter.emit('close', 0, 'SIGTERM');
      return true;
    },
    once(event: 'error' | 'close', listener: (...evArgs: any[]) => void) {
      emitter.once(event, listener);
      return handle;
    },
  };

  return {
    args,
    stdinLines,
    get killed() {
      return killed;
    },
    get ended() {
      return ended;
    },
    emitStdoutJson(obj: unknown) {
      stdout.write(`${JSON.stringify(obj)}\n`);
    },
    crash(code = 1, stderrText = 'worker pipe broken') {
      if (stderrText) {
        stderr.write(stderrText);
      }
      emitter.emit('close', code, null);
    },
    handle,
  };
}

test('AgyStreamClient warm pool reuses pre-warmed worker across turns and rotates on model/effort change', async () => {
  const spawned: MockWarmChild[] = [];
  let convSeq = 0;

  const client = new AgyStreamClient({
    executable: 'agy-mock',
    warmSpawner: (req) => {
      const mock = createMockWarmChild(req.args);
      spawned.push(mock);

      const convIdx = req.args.indexOf('--conversation');
      const convId = convIdx >= 0 ? req.args[convIdx + 1]! : `warm-conv-${++convSeq}`;

      queueMicrotask(() => {
        mock.emitStdoutJson({ event: 'init', conversation_id: convId });
      });

      mock.handle.stdin.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const line of text.split('\n').filter((l) => l.trim())) {
          const parsed = JSON.parse(line) as {
            event: string;
            message: { role: string; content: string };
          };
          assert.equal(parsed.event, 'user');
          assert.equal(parsed.message.role, 'user');
          queueMicrotask(() => {
            const reply = `echo:${parsed.message.content}`;
            mock.emitStdoutJson({
              event: 'step_update',
              step_update: {
                conversation_id: convId,
                step_index: 1,
                step_type: 'agent_response',
                text_delta: reply,
              },
            });
            mock.emitStdoutJson({
              event: 'result',
              result: {
                conversation_id: convId,
                status: 'SUCCESS',
                response: reply,
              },
            });
          });
        }
      });

      return mock.handle;
    },
  });

  try {
    // 1. Prewarm a fresh session before user sends anything
    client.prewarm({
      poolKey: 'sess-1',
      model: 'gemini-4-hydrogen-low',
      effort: 'low',
    });
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.args.includes('--input-format'));
    assert.ok(spawned[0]!.args.includes('stream-json'));

    // 2. Turn 1 (new conversation) reuses the prewarmed worker (spawned.length stays 1!)
    const t1 = await client.runStreamingTurn('hello 1', {
      poolKey: 'sess-1',
      model: 'gemini-4-hydrogen-low',
      effort: 'low',
    });
    assert.equal(spawned.length, 1);
    assert.equal(t1.conversationId, 'warm-conv-1');
    assert.equal(t1.text, 'echo:hello 1');

    // 3. Turn 2 (resuming warm-conv-1 with same model & effort) reuses the SAME worker!
    const t2 = await client.runStreamingTurn('hello 2', {
      poolKey: 'sess-1',
      conversationId: 'warm-conv-1',
      model: 'gemini-4-hydrogen-low',
      effort: 'low',
    });
    assert.equal(spawned.length, 1);
    assert.equal(t2.conversationId, 'warm-conv-1');
    assert.equal(t2.text, 'echo:hello 2');
    assert.equal(spawned[0]!.stdinLines.length, 2);

    // 4. Switching effort to 'high' disposes worker 0 and spawns worker 1
    const t3 = await client.runStreamingTurn('hello 3', {
      poolKey: 'sess-1',
      conversationId: 'warm-conv-1',
      model: 'gemini-4-hydrogen-high',
      effort: 'high',
    });
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0]!.killed, true);
    assert.ok(spawned[1]!.args.includes('gemini-4-hydrogen-high'));
    assert.ok(spawned[1]!.args.includes('high'));
    assert.equal(t3.text, 'echo:hello 3');
  } finally {
    client.close();
    assert.ok(spawned.every((s) => s.killed));
  }
});

test('AgyStreamClient warm pool transparently retries once if an idle reused worker crashes before first token', async () => {
  const spawned: MockWarmChild[] = [];
  let shouldCrashNextStdinOnFirstWorker = false;

  const client = new AgyStreamClient({
    executable: 'agy-mock',
    warmSpawner: (req) => {
      const idx = spawned.length;
      const mock = createMockWarmChild(req.args);
      spawned.push(mock);

      queueMicrotask(() => {
        mock.emitStdoutJson({ event: 'init', conversation_id: 'conv-recover' });
      });

      mock.handle.stdin.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!text.trim()) return;
        if (idx === 0 && shouldCrashNextStdinOnFirstWorker) {
          queueMicrotask(() => mock.crash(1, 'unexpected EOF'));
          return;
        }
        queueMicrotask(() => {
          mock.emitStdoutJson({
            event: 'step_update',
            step_update: {
              conversation_id: 'conv-recover',
              step_index: 1,
              step_type: 'agent_response',
              text_delta: 'recovered-ok',
            },
          });
          mock.emitStdoutJson({
            event: 'result',
            result: {
              conversation_id: 'conv-recover',
              status: 'SUCCESS',
              response: 'recovered-ok',
            },
          });
        });
      });

      return mock.handle;
    },
  });

  try {
    const first = await client.runStreamingTurn('turn 1', {
      poolKey: 'sess-r',
      conversationId: 'conv-recover',
    });
    assert.equal(first.text, 'recovered-ok');
    assert.equal(spawned.length, 1);

    shouldCrashNextStdinOnFirstWorker = true;
    const second = await client.runStreamingTurn('turn 2', {
      poolKey: 'sess-r',
      conversationId: 'conv-recover',
    });
    assert.equal(second.text, 'recovered-ok');
    assert.equal(spawned.length, 2);
  } finally {
    client.close();
  }
});

test('defaultWarmProcessSpawner drives a real persistent Node child process across multiple turns on a single PID', async () => {
  const childScript = [
    'process.stdout.write(JSON.stringify({ event: "init", conversation_id: "real-pid-conv" }) + "\\n");',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => {',
    '  buf += d;',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i).trim();',
    '    buf = buf.slice(i + 1);',
    '    if (!line) continue;',
    '    const req = JSON.parse(line);',
    '    const out = `pid=${process.pid}:${req.message.content}`;',
    '    process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: out } }) + "\\n");',
    '    process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "real-pid-conv", status: "SUCCESS", response: out } }) + "\\n");',
    '  }',
    '});',
  ].join(' ');

  const { defaultWarmProcessSpawner } = await import('../src/bridge/index.ts');
  const client = new AgyStreamClient({
    executable: process.execPath,
    warmSpawner: (req) =>
      defaultWarmProcessSpawner({
        ...req,
        args: ['-e', childScript],
      }),
  });

  try {
    const r1 = await client.runStreamingTurn('ping-1', { poolKey: 'real-1' });
    const r2 = await client.runStreamingTurn('ping-2', {
      poolKey: 'real-1',
      conversationId: 'real-pid-conv',
    });

    const pid1 = /^pid=(\d+):ping-1$/.exec(r1.text)?.[1];
    const pid2 = /^pid=(\d+):ping-2$/.exec(r2.text)?.[1];
    assert.ok(pid1);
    assert.equal(pid1, pid2);
  } finally {
    client.close();
  }
});

test('AgyStreamClient warm worker allows qqbot_delegate_task via --settings and surfaces step_update ERROR instead of empty silence', async () => {
  const spawned: MockWarmChild[] = [];
  const client = new AgyStreamClient({
    executable: 'agy-mock',
    warmSpawner: (req) => {
      const mock = createMockWarmChild(req.args);
      spawned.push(mock);
      queueMicrotask(() => {
        mock.emitStdoutJson({ event: 'init', conversation_id: 'conv-err-1' });
      });
      mock.handle.stdin.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!text.trim()) return;
        queueMicrotask(() => {
          mock.emitStdoutJson({
            event: 'step_update',
            step_update: {
              conversation_id: 'conv-err-1',
              step_index: 30,
              step_type: 'tool',
              state: 'ERROR',
              error: 'permission check failed for mcp',
            },
          });
          mock.emitStdoutJson({
            event: 'result',
            result: {
              conversation_id: 'conv-err-1',
              status: 'SUCCESS',
              response: '',
            },
          });
        });
      });
      return mock.handle;
    },
  });

  try {
    await assert.rejects(
      () => client.runStreamingTurn('修改规则文件', { poolKey: 'err-pool' }),
      /permission check failed for mcp/,
    );
    assert.equal(spawned.length, 1);
    const settingsIdx = spawned[0]!.args.indexOf('--settings');
    assert.ok(settingsIdx >= 0);
    const parsedSettings = JSON.parse(spawned[0]!.args[settingsIdx + 1]!) as {
      permissions?: { allow?: string[] };
    };
    assert.ok(
      parsedSettings.permissions?.allow?.includes(
        'mcp(antigravity-qqbot_antigravity-qqbot/qqbot_delegate_task)',
      ),
    );
  } finally {
    client.close();
  }
});
