import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { QQBotInboundMessage, QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import {
  AgyStreamClient,
  consumeAgyStreamLine,
  createAntigravityBridge,
  defaultAgyStreamProcessRunner,
  formatStreamBridgePrompt,
} from '../src/bridge/index.ts';
import type { ParsedAgyStreamState } from '../src/bridge/index.ts';
import { createGatewayRuntime } from '../src/gateway-entry.ts';
import {
  QQBOT_DELEGATE_TOOL_NAME,
  createMcpServer,
  postCallbackDelegate,
} from '../src/mcp/index.ts';
import { createQqGateway } from '../src/qq/index.ts';
import type { QqBotClient, QqSdkStreamController } from '../src/qq/index.ts';
import { loadRuntimeConfig } from '../src/shared/config.ts';

test('consumeAgyStreamLine accumulates multi-step deltas cleanly and handles result fallback', () => {
  const state: ParsedAgyStreamState = { accumulatedText: '' };

  assert.equal(
    consumeAgyStreamLine('{"event":"init","conversation_id":"conv-abc"}', state),
    '',
  );
  assert.equal(state.conversationId, 'conv-abc');

  const d1 = consumeAgyStreamLine(
    '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"第一段话"}}',
    state,
  );
  assert.equal(d1, '第一段话');

  const d2 = consumeAgyStreamLine(
    '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"继续补充"}}',
    state,
  );
  assert.equal(d2, '继续补充');
  assert.equal(state.accumulatedText, '第一段话继续补充');

  // Tool step ignored
  assert.equal(
    consumeAgyStreamLine(
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_name":"read_file"}}',
      state,
    ),
    '',
  );

  // Next agent_response step inserts paragraph break when previous did not end with newline
  const d3 = consumeAgyStreamLine(
    '{"event":"step_update","step_update":{"step_index":3,"step_type":"agent_response","text_delta":"看完文件后的结论"}}',
    state,
  );
  assert.equal(d3, '\n\n看完文件后的结论');
  assert.equal(state.accumulatedText, '第一段话继续补充\n\n看完文件后的结论');
});

test('defaultAgyStreamProcessRunner and AgyStreamClient stream real UTF-8 NDJSON child process output', async () => {
  const progressSnapshots: string[] = [];
  const script = [
    'const lines = [',
    '  JSON.stringify({ event: "init", conversation_id: "cli-conv-99" }),',
    '  JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "晚上好，" } }),',
    '  JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "家旗。" } }),',
    '  JSON.stringify({ event: "result", result: { conversation_id: "cli-conv-99", status: "SUCCESS", response: "晚上好，家旗。" } })',
    '];',
    'for (const l of lines) process.stdout.write(l + "\\n");',
  ].join(' ');

  const client = new AgyStreamClient({
    executable: process.execPath,
    runner: (req) =>
      defaultAgyStreamProcessRunner({
        ...req,
        args: ['-e', script],
      }),
  });

  const turn = await client.runStreamingTurn('测试', {
    onTextProgress: (full) => {
      progressSnapshots.push(full);
    },
  });

  assert.equal(turn.conversationId, 'cli-conv-99');
  assert.equal(turn.text, '晚上好，家旗。');
  assert.deepEqual(progressSnapshots, ['晚上好，', '晚上好，家旗。']);
});

test('openReplyStream streams C2C frames in-place and falls back cleanly on error or group scope', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-stream-gw-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const streamUpdates: string[] = [];
  let streamCompleted = 0;
  let streamCancelled = 0;
  let typingCalls = 0;
  let failStream = false;
  const staticTexts: string[] = [];
  let messageHandler: ((ctx: unknown, msg: QQBotInboundMessage) => Promise<void>) | undefined;

  const cfg = loadRuntimeConfig({
    QQBOT_APPID: 'app-stream',
    QQBOT_SECRET: 'sec-stream',
    QQBOT_DATA_DIR: tempRoot,
  });

  const gw = createQqGateway(cfg, {
    botFactory: (_opts: QQBotOptions): QqBotClient => {
      let finishStart: (() => void) | undefined;
      return {
        appId: 'app-stream',
        use: () => undefined,
        on: (ev, handler) => {
          if (ev === 'ready') {
            queueMicrotask(() => (handler as (d: unknown) => void)({}));
          }
          if (ev === 'message') {
            messageHandler = handler as unknown as (
              ctx: unknown,
              msg: QQBotInboundMessage,
            ) => Promise<void>;
          }
          return undefined;
        },
        start: () =>
          new Promise<void>((resolveStart) => {
            finishStart = resolveStart;
          }),
        stop: () => {
          finishStart?.();
        },
        send: async () => ({ id: '1', timestamp: '' }),
        sendText: async (_target, content) => {
          staticTexts.push(content);
          return { id: 'static-1', timestamp: '' };
        },
        sendMarkdown: async () => ({ id: '2', timestamp: '' }),
        sendTyping: async () => {
          typingCalls += 1;
          return {};
        },
        openStream: (): QqSdkStreamController => ({
          update: async (fullText: string) => {
            if (failStream) {
              throw new Error('stream permission denied');
            }
            streamUpdates.push(fullText);
          },
          complete: async () => {
            if (failStream) {
              throw new Error('stream complete denied');
            }
            streamCompleted += 1;
            return { id: 'stream-msg-1', timestamp: '' };
          },
          cancel: () => {
            streamCancelled += 1;
          },
        }),
      };
    },
  });

  await gw.start();
  t.after(async () => {
    await gw.stop();
  });

  // Record valid inbound C2C msgId
  await messageHandler?.(
    { receivedAt: Date.now() },
    {
      kind: 'c2c',
      messageId: 'm-in-1',
      senderId: 'u-1',
      content: 'hi',
      timestamp: new Date().toISOString(),
      replyTarget: { scope: 'c2c', targetId: 'u-1', msgId: 'm-in-1' },
    } as unknown as QQBotInboundMessage,
  );

  // 1. Happy path C2C streaming (including trailing newline in mid-stream vs trimmed finalText)
  const s1 = gw.openReplyStream!({ scope: 'c2c', targetId: 'u-1', msgId: 'm-in-1' });
  await s1.update('增量1');
  await s1.update('增量1+增量2\n');
  await s1.complete('增量1+增量2');

  assert.equal(typingCalls, 1);
  assert.deepEqual(streamUpdates, ['增量1', '增量1+增量2']);
  assert.equal(streamCompleted, 1);
  assert.equal(staticTexts.length, 0);

  // 2. Stream API error -> automatically cancels stream and falls back to static sendText
  failStream = true;
  const s2 = gw.openReplyStream!({ scope: 'c2c', targetId: 'u-1', msgId: 'm-in-1' });
  await s2.update('尝试流式');
  await s2.complete('降级静态全文');

  assert.ok(streamCancelled >= 1);
  assert.deepEqual(staticTexts, ['降级静态全文']);

  // 3. Group scope -> skips C2C stream and delivers via static sendText
  const sGrp = gw.openReplyStream!({ scope: 'group', targetId: 'g-1', msgId: 'm-grp' });
  await sGrp.update('群聊片段');
  await sGrp.complete('群聊最终回复');
  assert.deepEqual(staticTexts, ['降级静态全文', '群聊最终回复']);
});

test('E2E createGatewayRuntime in agy-stream backend streams deltas live and isolates @stream session store', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-rt-stream-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const liveFrames: string[] = [];
  let finalizedText = '';
  const recordedArgs: Array<readonly string[]> = [];
  let runCount = 0;

  const bridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data'),
    workspaceRoot: join(tempRoot, 'ws'),
    memoryDirs: [join(tempRoot, 'mem')],
    backendMode: 'agy-stream',
    agyExecutable: 'agy-mock',
    callbackPort: 0,
    onOpenReplyStream: () => ({
      update: async (full) => {
        liveFrames.push(full);
      },
      complete: async (final) => {
        finalizedText = final;
      },
      cancel: () => undefined,
    }),
    agyStreamRunner: async (req) => {
      runCount += 1;
      recordedArgs.push(req.args);
      await req.onStdoutLine?.(
        JSON.stringify({ event: 'init', conversation_id: 'stream-conv-777' }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 1, step_type: 'agent_response', text_delta: '正在为你' },
        }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 1, step_type: 'agent_response', text_delta: '流式推演。' },
        }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'stream-conv-777',
            status: 'SUCCESS',
            response: '正在为你流式推演。',
          },
        }),
      );
      return { exitCode: 0, stderr: '' };
    },
  });

  await bridge.start();
  t.after(async () => {
    await bridge.stop();
  });

  const s1 = await bridge.dispatchInbound({
    messageId: 'm-1',
    botId: '1906424664',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '流式测试',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi', msgId: 'm-1' },
  });

  assert.equal(s1.conversationId, 'stream-conv-777');
  assert.equal(s1.botId, '1906424664@stream');
  assert.deepEqual(liveFrames, ['正在为你', '正在为你流式推演。']);
  assert.equal(finalizedText, '正在为你流式推演。');
  assert.equal(recordedArgs[0]?.includes('--conversation'), false);
  assert.ok(recordedArgs[0]?.includes('--add-dir'));
  const settingsIdx = recordedArgs[0]?.indexOf('--settings') ?? -1;
  assert.ok(settingsIdx >= 0);
  const settingsPayload = recordedArgs[0]?.[settingsIdx + 1] ?? '';
  assert.equal(settingsPayload.includes('nonWorkspaceFileAccessPolicy'), false);
  assert.ok(settingsPayload.includes('qqbot_delegate_task'));

  // 2nd turn resumes stream-conv-777 automatically
  await bridge.dispatchInbound({
    messageId: 'm-2',
    botId: '1906424664',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '第二句',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi', msgId: 'm-2' },
  });

  assert.equal(runCount, 2);
  const convIdx = recordedArgs[1]?.indexOf('--conversation') ?? -1;
  assert.ok(convIdx >= 0);
  assert.equal(recordedArgs[1]?.[convIdx + 1], 'stream-conv-777');

  // Verify formatStreamBridgePrompt omits replyToken and instructs direct-stream
  const streamPrompt = formatStreamBridgePrompt({
    messageId: 'm-3',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '你好',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi' },
  });
  assert.match(streamPrompt, /\[QQ c2c stream\]/);
  assert.equal(streamPrompt.includes('replyToken:'), false);
  assert.match(streamPrompt, /mode: direct-stream/);

  // Ensure createGatewayRuntime wires openReplyStream cleanly
  assert.equal(typeof createGatewayRuntime, 'function');
});

test('qqbot_delegate_task runs background subagent with --dangerously-skip-permissions without blocking main QQ chat and blocks group escalation', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-delegate-e2e-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  let releaseSubagent!: () => void;
  const subagentGate = new Promise<void>((r) => {
    releaseSubagent = r;
  });

  const pushedSubagentReplies: string[] = [];
  const mainChatOutputs: string[] = [];
  const subagentInvocations: Array<{ args: readonly string[]; cwd?: string }> = [];
  const mainPrompts: string[] = [];

  let callbackPort = 0;

  const bridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data'),
    workspaceRoot: join(tempRoot, 'ws'),
    memoryDirs: [join(tempRoot, 'mem')],
    backendMode: 'agy-stream',
    agyExecutable: 'agy-mock',
    callbackHost: '127.0.0.1',
    callbackPort: 0,
    onDeliverReply: async ({ text }) => {
      pushedSubagentReplies.push(text);
    },
    onOpenReplyStream: () => ({
      update: async () => undefined,
      complete: async (final) => {
        mainChatOutputs.push(final);
      },
      cancel: () => undefined,
    }),
    agyStreamRunner: async (req) => {
      // Background subagent invocation has --dangerously-skip-permissions
      if (req.args.includes('--dangerously-skip-permissions')) {
        subagentInvocations.push({ args: req.args, cwd: req.cwd });
        await subagentGate;
        await req.onStdoutLine?.(
          JSON.stringify({ event: 'init', conversation_id: 'subagent-conv-1' }),
        );
        await req.onStdoutLine?.(
          JSON.stringify({
            event: 'step_update',
            step_update: {
              step_index: 1,
              step_type: 'agent_response',
              text_delta: '已整理完7篇日记并落盘。',
            },
          }),
        );
        return { exitCode: 0, stderr: '' };
      }

      // Main chat turn
      const lastArg = req.args[req.args.length - 1] ?? '';
      const prompt = lastArg.startsWith('--print=') ? lastArg.slice('--print='.length) : lastArg;
      mainPrompts.push(prompt);
      const tokenMatch = /delegateToken:\s*(\S+)/.exec(prompt);

      if (prompt.includes('帮我整理本周日记') && tokenMatch?.[1]) {
        // Call real MCP server -> HTTP /delegate endpoint!
        const mcp = createMcpServer({
          callback: { callbackHost: '127.0.0.1', callbackPort },
        });
        const rpcRes = (await mcp.handleMessage({
          jsonrpc: '2.0',
          id: 'del-1',
          method: 'tools/call',
          params: {
            name: QQBOT_DELEGATE_TOOL_NAME,
            arguments: {
              delegateToken: tokenMatch[1],
              title: '整理本周记忆日记',
              prompt: '扫描最近7天记录并写入汇总文档',
              workingDirectory: join(tempRoot, 'custom-work'),
            },
          },
        })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
        assert.equal(rpcRes.result.isError, undefined);
        assert.match(rpcRes.result.content[0]?.text ?? '', /subtask-1/);

        await req.onStdoutLine?.(
          JSON.stringify({ event: 'init', conversation_id: 'main-conv-1' }),
        );
        await req.onStdoutLine?.(
          JSON.stringify({
            event: 'step_update',
            step_update: {
              step_index: 1,
              step_type: 'agent_response',
              text_delta: '已派后台子工位去整理了，我们接着聊。',
            },
          }),
        );
        return { exitCode: 0, stderr: '' };
      }

      if (prompt.includes('后台子代理全景数据采集报告')) {
        await req.onStdoutLine?.(
          JSON.stringify({ event: 'init', conversation_id: 'main-conv-1' }),
        );
        await req.onStdoutLine?.(
          JSON.stringify({
            event: 'step_update',
            step_update: {
              step_index: 1,
              step_type: 'agent_response',
              text_delta: '（桑多涅审查全景报告）日记整理全景核对完毕，7篇已按规范归档。',
            },
          }),
        );
        return { exitCode: 0, stderr: '' };
      }

      // Normal fast chat turn while subagent is still running!
      await req.onStdoutLine?.(
        JSON.stringify({ event: 'init', conversation_id: 'main-conv-1' }),
      );
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            step_type: 'agent_response',
            text_delta: '我在呢，秒回不卡顿！',
          },
        }),
      );
      return { exitCode: 0, stderr: '' };
    },
  });

  await bridge.start();
  t.after(async () => {
    await bridge.stop();
  });

  callbackPort = Number.parseInt(new URL(bridge.getCallbackUrl()).port, 10);

  // Turn 1: User asks for a heavy task -> main chat delegates in <10ms and finishes immediately!
  await bridge.dispatchInbound({
    messageId: 'm-heavy',
    botId: '1906424664',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '帮我整理本周日记',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi', msgId: 'm-heavy' },
  });

  assert.equal(mainChatOutputs[0], '已派后台子工位去整理了，我们接着聊。');
  assert.equal(subagentInvocations.length, 1);
  const subagentPrintedArg = subagentInvocations[0]?.args.find((a) => a.startsWith('--print=')) ?? '';
  assert.match(subagentPrintedArg, /绝对禁止直接联系用户/);
  assert.match(subagentPrintedArg, /send_message/);
  assert.match(subagentPrintedArg, /极尽细致的全景数据采集/);
  assert.equal(pushedSubagentReplies.length, 0); // Subagent is STILL running in background!

  // Turn 2: While background subagent is STILL blocked on subagentGate, user sends casual chat -> ZERO blocking!
  await bridge.dispatchInbound({
    messageId: 'm-casual',
    botId: '1906424664',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '今天咖啡好喝吗？',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi', msgId: 'm-casual' },
  });
  assert.equal(mainChatOutputs[1], '我在呢，秒回不卡顿！');

  // Now let background subagent finish -> reports panoramic data to main session, which organizes reply for QQ!
  releaseSubagent();
  await bridge.waitForBackgroundTasks?.();

  // Subagent NEVER pushes directly to QQ (pushedSubagentReplies remains 0, avoiding MD format breakage)
  assert.equal(pushedSubagentReplies.length, 0);

  // Main session received the panoramic report and streamed an in-character, QQ-friendly reply!
  assert.equal(mainChatOutputs.length, 3);
  assert.equal(mainChatOutputs[2], '（桑多涅审查全景报告）日记整理全景核对完毕，7篇已按规范归档。');

  // Verify the prompt sent to the main session contained the panoramic report from the subagent
  const reportPrompt = mainPrompts.find((p) => p.includes('后台子代理全景数据采集报告'));
  assert.ok(reportPrompt);
  assert.match(reportPrompt, /整理本周记忆日记/);
  assert.match(reportPrompt, /已整理完7篇日记并落盘/);

  // Turn 3: Next main chat turn automatically receives [Completed Background Subagent Reports] context!
  await bridge.dispatchInbound({
    messageId: 'm-after',
    botId: '1906424664',
    scope: 'c2c',
    peerId: 'u-jiaqi',
    senderId: 'u-jiaqi',
    text: '刚才那个活干完了吧？',
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'u-jiaqi', msgId: 'm-after' },
  });
  const afterPrompt = mainPrompts.at(-1) ?? '';
  assert.match(afterPrompt, /\[Completed Background Subagent Reports\]/);
  assert.match(afterPrompt, /整理本周记忆日记/);

  // Verify invalid token returns 404 cleanly via postCallbackDelegate
  const badRes = await postCallbackDelegate(
    {
      delegateToken: 'non-existent',
      title: 'x',
      prompt: 'y',
    },
    { callbackHost: '127.0.0.1', callbackPort },
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.statusCode, 404);
});
