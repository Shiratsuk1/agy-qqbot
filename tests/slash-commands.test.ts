import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AgyStreamClient,
  DEFAULT_MODEL_CATALOG,
  PeerPreferencesStore,
  createAntigravityBridge,
  parseAgyModelsOutput,
  parseBridgeSlashCommand,
  parseThinkingEffort,
  resolveAdaptiveModel,
  runRepoSelfUpdate,
  syncModelWithEffort,
} from '../src/bridge/index.ts';
import type { AgyStreamRunRequest } from '../src/bridge/index.ts';
import { postCallbackDelegate } from '../src/mcp/index.ts';
import type { InboundMessage } from '../src/shared/types.ts';

function makeC2cMessage(text: string, messageId = 'msg-1'): InboundMessage {
  return {
    messageId,
    scope: 'c2c',
    peerId: 'user-jiaqi',
    senderId: 'user-jiaqi',
    senderName: 'Jiaqi',
    botId: 'bot-1',
    text,
    receivedAt: 1_700_000_000_000,
    replyTarget: {
      scope: 'c2c',
      targetId: 'user-jiaqi',
      msgId: messageId,
    },
  };
}

test('resolveAdaptiveModel handles shorthand aliases, families, combined effort, and indices', () => {
  // Shorthand families default to medium (or current effort)
  assert.equal(resolveAdaptiveModel('4c').match?.entry.id, 'gemini-4-carbon-medium');
  assert.equal(resolveAdaptiveModel('4a').match?.entry.id, 'gemini-4-argon-medium');
  assert.equal(resolveAdaptiveModel('4h').match?.entry.id, 'gemini-4-hydrogen-medium');
  assert.equal(resolveAdaptiveModel('3.8f').match?.entry.id, 'gemini-3.8-flash-medium');
  assert.equal(
    resolveAdaptiveModel('gemini-4-hydrogen', 'high').match?.entry.id,
    'gemini-4-hydrogen-high',
  );

  // Combined model + effort shorthands
  const hXh = resolveAdaptiveModel('4h xhigh');
  assert.equal(hXh.match?.entry.id, 'gemini-4-hydrogen-xhigh');
  assert.equal(hXh.match?.inferredEffort, 'xhigh');

  const cLow = resolveAdaptiveModel('4c-low');
  assert.equal(cLow.match?.entry.id, 'gemini-4-carbon-low');
  assert.equal(cLow.match?.inferredEffort, 'low');

  const aCompact = resolveAdaptiveModel('4al');
  assert.equal(aCompact.match?.entry.id, 'gemini-4-argon-low');
  assert.equal(aCompact.match?.inferredEffort, 'low');

  // Direct model aliases
  assert.equal(resolveAdaptiveModel('sonnet').match?.entry.id, 'claude-sonnet-4-6');
  assert.equal(resolveAdaptiveModel('opus').match?.entry.id, 'claude-opus-4-6-thinking');
  assert.equal(resolveAdaptiveModel('orch').match?.entry.id, 'gemini-pro-orchestrator');

  // 1-based numeric index
  const idx1 = resolveAdaptiveModel('1');
  assert.equal(idx1.match?.entry.id, DEFAULT_MODEL_CATALOG[0]!.id);
  assert.equal(idx1.match?.inferredEffort, 'low');
});

test('syncModelWithEffort and parseThinkingEffort keep model tiers aligned', () => {
  assert.equal(parseThinkingEffort('l'), 'low');
  assert.equal(parseThinkingEffort('xh'), 'xhigh');
  assert.equal(parseThinkingEffort('MAX'), 'max');
  assert.equal(parseThinkingEffort('invalid'), null);

  assert.equal(
    syncModelWithEffort('gemini-4-hydrogen-medium', 'xhigh'),
    'gemini-4-hydrogen-xhigh',
  );
  assert.equal(
    syncModelWithEffort('gemini-4-carbon-high', 'low'),
    'gemini-4-carbon-low',
  );
  // Carbon does not have xhigh; falls back to carbon-high cleanly
  assert.equal(
    syncModelWithEffort('gemini-4-carbon-low', 'xhigh'),
    'gemini-4-carbon-high',
  );
  // Non-tiered Claude stays unchanged
  assert.equal(
    syncModelWithEffort('claude-opus-4-6-thinking', 'high'),
    'claude-opus-4-6-thinking',
  );
});

test('parseBridgeSlashCommand ignores messages with media attachments and parses arguments', () => {
  assert.deepEqual(parseBridgeSlashCommand('/model 4h xhigh'), {
    name: 'model',
    args: '4h xhigh',
  });
  assert.deepEqual(parseBridgeSlashCommand('/compact 保留核心配置路径'), {
    name: 'compact',
    args: '保留核心配置路径',
  });
  assert.equal(parseBridgeSlashCommand('/model 4c', true), null);
  assert.equal(parseBridgeSlashCommand('普通聊天文本'), null);
});

test('PeerPreferencesStore persists and reloads preferences atomically across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-prefs-'));
  try {
    const store1 = new PeerPreferencesStore({ dataDir: dir });
    store1.update('c2c:u1', {
      model: 'gemini-4-hydrogen-high',
      effort: 'high',
      subagentModel: 'claude-opus-4-6-thinking',
    });

    const store2 = new PeerPreferencesStore({ dataDir: dir });
    const loaded = store2.get('c2c:u1');
    assert.equal(loaded?.model, 'gemini-4-hydrogen-high');
    assert.equal(loaded?.effort, 'high');
    assert.equal(loaded?.subagentModel, 'claude-opus-4-6-thinking');

    store2.update('c2c:u1', { model: null });
    assert.equal(store2.get('c2c:u1')?.model, undefined);
    assert.equal(store2.get('c2c:u1')?.effort, 'high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyStreamClient.runCompactConversation omits --disable-slash-commands and succeeds on checkpoint + exitCode 1', async () => {
  const recordedRequests: AgyStreamRunRequest[] = [];
  const client = new AgyStreamClient({
    executable: 'agy.exe',
    runner: async (req) => {
      recordedRequests.push(req);
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'init',
          conversation_id: 'conv-compact-1',
          expanded_commands: [{ name: 'compact', type: 'system' }],
        }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: 'conv-compact-1',
            step_type: 'checkpoint',
            state: 'DONE',
            duration_seconds: 3.45,
            usage: { total_tokens: 1820 },
          },
        }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-compact-1',
            status: 'SUCCESS',
            response: '',
          },
        }),
      );
      return {
        exitCode: 1,
        stderr: 'warning: run ended with no output and no recorded error\n',
      };
    },
  });

  const res = await client.runCompactConversation('conv-compact-1', '保留架构结论', {
    model: 'gemini-4-carbon-low',
    effort: 'low',
  });

  assert.equal(res.conversationId, 'conv-compact-1');
  assert.equal(res.checkpointDurationSec, 3.45);
  assert.equal(res.totalTokens, 1820);
  assert.equal(recordedRequests.length, 1);
  const args = recordedRequests[0]!.args;
  assert.equal(args.includes('--disable-slash-commands'), false);
  assert.ok(args.includes('--conversation'));
  assert.ok(args.includes('conv-compact-1'));
  assert.ok(args.includes('--print=/compact 保留架构结论'));
});

test('parseAgyModelsOutput parses live tab-separated agy models output', () => {
  const sample = [
    'Fetching available models...',
    'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
    'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  ].join('\n');
  const parsed = parseAgyModelsOutput(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.id, 'gemini-4-carbon-low');
  assert.equal(parsed[0]!.family, 'carbon');
  assert.equal(parsed[1]!.id, 'gemini-4-hydrogen-xhigh');
  assert.equal(parsed[1]!.tier, 'xhigh');
});

test('Bridge end-to-end slash commands: /model, /think, /new, /compact, /submodel, /status, /tasks, /cancel', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-slash-e2e-'));
  const deliveredReplies: string[] = [];
  const streamFrames: Array<{ updates: string[]; final?: string }> = [];
  const recordedCalls: AgyStreamRunRequest[] = [];
  let convCounter = 0;

  let blockSubtaskResolve: (() => void) | undefined;
  let shouldBlockSubtask = false;

  const bridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data'),
    workspaceRoot: join(tempRoot, 'workspaces'),
    backendMode: 'agy-stream',
    callbackHost: '127.0.0.1',
    callbackPort: 0,
    agyExecutable: 'agy-mock',
    agyStreamRunner: async (req) => {
      recordedCalls.push(req);

      if (req.args[0] === 'models') {
        await req.onStdoutLine?.('gemini-4-carbon-low\tGemini 4 Carbon (Low)');
        await req.onStdoutLine?.('gemini-4-carbon-medium\tGemini 4 Carbon (Medium)');
        await req.onStdoutLine?.('gemini-4-carbon-high\tGemini 4 Carbon (High)');
        await req.onStdoutLine?.('gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)');
        await req.onStdoutLine?.('gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)');
        await req.onStdoutLine?.('gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)');
        await req.onStdoutLine?.('claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)');
        return { exitCode: 0, stderr: '' };
      }

      const printArg = req.args.find((a) => a.startsWith('--print=')) ?? '';
      const isCompact = printArg.startsWith('--print=/compact');
      const convFlagIdx = req.args.indexOf('--conversation');
      const convId =
        convFlagIdx >= 0 ? req.args[convFlagIdx + 1]! : `conv-${++convCounter}`;

      if (isCompact) {
        await req.onStdoutLine?.(
          JSON.stringify({
            event: 'step_update',
            step_update: {
              conversation_id: convId,
              step_type: 'checkpoint',
              state: 'DONE',
              duration_seconds: 2.1,
              usage: { total_tokens: 900 },
            },
          }),
        );
        await req.onStdoutLine?.(
          JSON.stringify({
            event: 'result',
            result: { conversation_id: convId, status: 'SUCCESS', response: '' },
          }),
        );
        return { exitCode: 1, stderr: '' };
      }

      if (req.args.includes('--dangerously-skip-permissions') && shouldBlockSubtask) {
        await new Promise<void>((resolve, reject) => {
          blockSubtaskResolve = resolve;
          req.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('subtask aborted'));
            },
            { once: true },
          );
        });
      }

      // Extract delegateToken if main chat wants to delegate
      const tokenMatch = /delegateToken:\s*(\S+)/.exec(printArg);
      if (tokenMatch?.[1] && printArg.includes('请派后台任务')) {
        const cbUrl = new URL(bridge.getCallbackUrl());
        const delRes = await postCallbackDelegate(
          {
            delegateToken: tokenMatch[1],
            title: '深度代码扫描',
            prompt: '扫描全部模块',
          },
          {
            callbackHost: cbUrl.hostname,
            callbackPort: Number.parseInt(cbUrl.port, 10),
          },
        );
        assert.equal(delRes.ok, true);
      }

      await req.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: convId }));
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 1, step_type: 'agent_response', text_delta: '收到。' },
        }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'result',
          result: { conversation_id: convId, status: 'SUCCESS', response: '收到。' },
        }),
      );
      return { exitCode: 0, stderr: '' };
    },
    onDeliverReply: async ({ text }) => {
      deliveredReplies.push(text);
    },
    onOpenReplyStream: () => {
      const record: { updates: string[]; final?: string } = { updates: [] };
      streamFrames.push(record);
      return {
        async update(fullText) {
          record.updates.push(fullText);
        },
        async complete(finalText) {
          record.final = finalText;
        },
        cancel() {},
      };
    },
  });

  await bridge.start();
  try {
    // 1. /help
    await bridge.dispatchInbound(makeC2cMessage('/help'));
    assert.ok(deliveredReplies.at(-1)?.includes('/model'));

    // 2. /model 4h + /think xh
    await bridge.dispatchInbound(makeC2cMessage('/model 4h'));
    assert.ok(deliveredReplies.at(-1)?.includes('gemini-4-hydrogen-medium'));

    await bridge.dispatchInbound(makeC2cMessage('/think xh'));
    assert.ok(deliveredReplies.at(-1)?.includes('xhigh'));
    assert.ok(deliveredReplies.at(-1)?.includes('gemini-4-hydrogen-xhigh'));

    // 3. Normal chat turn uses selected model & effort
    const turn1 = await bridge.dispatchInbound(makeC2cMessage('你好'));
    assert.equal(turn1.conversationId, 'conv-1');
    const chatReq1 = recordedCalls.at(-1)!;
    assert.ok(chatReq1.args.includes('gemini-4-hydrogen-xhigh'));
    assert.ok(chatReq1.args.includes('--effort'));
    assert.ok(chatReq1.args.includes('xhigh'));

    // 4. /compact preserves monotonic stream prefix
    await bridge.dispatchInbound(makeC2cMessage('/compact 保留核心设定'));
    const compactStream = streamFrames.at(-1)!;
    assert.equal(compactStream.updates.length, 1);
    assert.ok(compactStream.final?.startsWith(compactStream.updates[0]!));
    assert.ok(compactStream.final?.includes('上下文压缩完成'));

    // 5. /new clears conversationId while preserving model & effort preferences
    await bridge.dispatchInbound(makeC2cMessage('/new'));
    assert.ok(deliveredReplies.at(-1)?.includes('已开启全新对话上下文'));
    assert.ok(deliveredReplies.at(-1)?.includes('gemini-4-hydrogen-xhigh'));
    assert.equal(bridge.getSession('c2c', 'user-jiaqi', 'bot-1'), undefined);

    const turn2 = await bridge.dispatchInbound(makeC2cMessage('新话题'));
    assert.equal(turn2.conversationId, 'conv-2');
    const chatReq2 = recordedCalls.at(-1)!;
    assert.equal(chatReq2.args.includes('--conversation'), false);
    assert.ok(chatReq2.args.includes('gemini-4-hydrogen-xhigh'));

    // 6. /submodel opus + /tasks + /cancel
    await bridge.dispatchInbound(makeC2cMessage('/submodel opus'));
    assert.ok(deliveredReplies.at(-1)?.includes('claude-opus-4-6-thinking'));

    shouldBlockSubtask = true;
    await bridge.dispatchInbound(makeC2cMessage('请派后台任务'));
    const subReq = recordedCalls.find((r) => r.args.includes('--dangerously-skip-permissions'));
    assert.ok(subReq);
    assert.ok(subReq.args.includes('claude-opus-4-6-thinking'));

    await bridge.dispatchInbound(makeC2cMessage('/tasks'));
    assert.ok(deliveredReplies.at(-1)?.includes('subtask-1'));

    await bridge.dispatchInbound(makeC2cMessage('/status'));
    assert.ok(deliveredReplies.at(-1)?.includes('subtask-1'));

    await bridge.dispatchInbound(makeC2cMessage('/cancel subtask-1'));
    assert.ok(deliveredReplies.at(-1)?.includes('已终止后台子任务 subtask-1'));
    blockSubtaskResolve?.();

    // 7. Group chat forbids admin /model command
    await bridge.dispatchInbound({
      messageId: 'grp-1',
      scope: 'group',
      peerId: 'group-100',
      senderId: 'member-2',
      text: '/model opus',
      receivedAt: Date.now(),
      replyTarget: { scope: 'group', targetId: 'group-100', msgId: 'grp-1' },
    });
    assert.ok(deliveredReplies.at(-1)?.includes('仅限私聊'));
  } finally {
    await bridge.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('runRepoSelfUpdate and /update trigger git pull, plugin sync, and hot-restart callback when new commits arrive', async () => {
  const executedCmds: string[] = [];
  let revCalls = 0;

  const updateRes = await runRepoSelfUpdate({
    repoRoot: '/mock/repo',
    execCmd: async (file, args) => {
      executedCmds.push(`${file} ${args.join(' ')}`);
      if (file === 'git' && args[0] === 'rev-parse') {
        revCalls += 1;
        return { stdout: revCalls === 1 ? 'a1b2c3d\n' : 'e4f5g6h\n', stderr: '' };
      }
      if (file === 'git' && args[0] === 'log') {
        return { stdout: 'feat: add warm worker pool\n', stderr: '' };
      }
      if (file === 'git' && args[0] === 'diff') {
        return { stdout: 'src/bridge/bridge.ts\npackage.json\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(updateRes.updated, true);
  assert.equal(updateRes.previousCommit, 'a1b2c3d');
  assert.equal(updateRes.currentCommit, 'e4f5g6h');
  assert.equal(updateRes.subject, 'feat: add warm worker pool');
  assert.ok(executedCmds.some((c) => c.includes('git pull --ff-only')));
  assert.ok(executedCmds.some((c) => c.includes('install --no-audit --no-fund')));
  assert.ok(executedCmds.some((c) => c.includes('scripts/install-plugin.ts')));

  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-update-cmd-'));
  const replies: string[] = [];
  let restarted = false;

  const bridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data'),
    workspaceRoot: join(tempRoot, 'ws'),
    backendMode: 'agy-stream',
    callbackHost: '127.0.0.1',
    callbackPort: 0,
    onSelfUpdate: async () => updateRes,
    onRestartProcess: () => {
      restarted = true;
    },
    onDeliverReply: async ({ text }) => {
      replies.push(text);
    },
  });

  await bridge.start();
  try {
    await bridge.dispatchInbound(makeC2cMessage('/update'));
    assert.equal(restarted, true);
    assert.ok(replies.at(-1)?.includes('a1b2c3d → e4f5g6h'));
  } finally {
    await bridge.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
