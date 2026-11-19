import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SessionStore,
  createAntigravityBridge,
  extractAgentApiTranscriptDigest,
  parseAgyModelsOutput,
  resolveAdaptiveModel,
  syncModelWithEffort,
} from '../src/bridge/index.ts';
import type { AgentApiRunRequest, AgyStreamRunRequest } from '../src/bridge/index.ts';
import { createGatewayRuntime } from '../src/gateway-entry.ts';
import { postCallbackDelegate, postCallbackReply } from '../src/mcp/index.ts';
import { createQqGateway } from '../src/qq/index.ts';
import type { QqBotClient, QqSdkStreamController } from '../src/qq/index.ts';
import { loadRuntimeConfig } from '../src/shared/config.ts';
import type { InboundMessage, ReplyTarget } from '../src/shared/types.ts';

function makeTempDir(t: test.TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeC2cInbound(text: string, msgId = `msg-${Date.now()}`): InboundMessage {
  return {
    messageId: msgId,
    scope: 'c2c',
    peerId: 'friend-openid-1',
    senderId: 'friend-openid-1',
    senderName: '友友',
    botId: 'bot-friend',
    text,
    receivedAt: Date.now(),
    replyTarget: {
      scope: 'c2c',
      targetId: 'friend-openid-1',
      msgId,
    },
  };
}

function writeTranscriptFile(appDataDir: string, conversationId: string, lines: object[]): void {
  const logsDir = join(appDataDir, 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'transcript.jsonl'),
    `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );
}

test('QqGateway.sendTyping triggers C2C sendTyping with cached msgId and skips group/proactive targets', async () => {
  const typingCalls: Array<{ target: { scope: string; targetId: string; msgId?: string }; duration?: number }> = [];

  class FakeBot extends EventEmitter implements QqBotClient {
    readonly appId = 'app-typing';
    use(): unknown {
      return this;
    }
    async start(): Promise<void> {
      queueMicrotask(() => this.emit('ready', {}));
    }
    stop(): void {}
    async send(): Promise<Record<string, never>> {
      return {};
    }
    async sendText(): Promise<Record<string, never>> {
      return {};
    }
    async sendMarkdown(): Promise<Record<string, never>> {
      return {};
    }
    async sendTyping(target: { scope: 'c2c' | 'group'; targetId: string; msgId?: string }, durationSec?: number) {
      typingCalls.push({ target, duration: durationSec });
      return {};
    }
    openStream(): QqSdkStreamController {
      return {
        async update(): Promise<void> {},
        async complete() {
          return undefined;
        },
        cancel(): void {},
      };
    }
  }

  const gw = createQqGateway(loadRuntimeConfig({ QQBOT_APPID: 'app-typing', QQBOT_SECRET: 'sec' }), {
    botFactory: () => new FakeBot(),
  });
  await gw.start();
  try {
    await gw.sendTyping?.({ scope: 'c2c', targetId: 'u-1', msgId: 'm-100' }, 60);
    await gw.sendTyping?.({ scope: 'group', targetId: 'g-1', msgId: 'm-200' }, 60);
    await gw.sendTyping?.({ scope: 'c2c', targetId: 'u-1', msgId: 'm-100', forceProactive: true }, 60);

    assert.equal(typingCalls.length, 1);
    assert.deepEqual(typingCalls[0], {
      target: { scope: 'c2c', targetId: 'u-1', msgId: 'm-100' },
      duration: 60,
    });
  } finally {
    await gw.stop();
  }
});

test('extractAgentApiTranscriptDigest strips bridge metadata headers and extracts qqbot_reply texts', (t) => {
  const appDataDir = makeTempDir(t, 'qqbot-appdata-');
  writeTranscriptFile(appDataDir, 'conv-desktop-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '[QQ c2c message]\npeerId: u1\nsender: Bob (u1)\nreplyToken: tok-secret\nworkspace: C:\\ws\n\n帮我整理桌面月报',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'call_mcp_tool',
          arguments: {
            ServerName: 'antigravity-qqbot_antigravity-qqbot',
            ToolName: 'qqbot_reply',
            Arguments: { replyToken: 'tok-secret', text: '已为你整理好月报至 C:\\ws\\report.xlsx。' },
          },
        },
      ],
    },
    {
      step_index: 2,
      type: 'USER_INPUT',
      content: '[QQ c2c message]\npeerId: u1\nsender: Bob (u1)\nreplyToken: tok-2\n\n加上同比列',
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      content: '已完成同比列补充。',
    },
  ]);

  const digest = extractAgentApiTranscriptDigest('conv-desktop-1', { appDataDir });
  assert.equal(digest.found, true);
  assert.equal(digest.turns.length, 4);
  assert.equal(digest.digestText.includes('tok-secret'), false);
  assert.match(digest.digestText, /帮我整理桌面月报/);
  assert.match(digest.digestText, /report\.xlsx/);
  assert.match(digest.digestText, /加上同比列/);
  assert.match(digest.digestText, /已完成同比列补充/);
});

test('agentapi mode parity: sendTyping, /compact handoff, /model+/think session rotation, subtasks report, and error handling', async (t) => {
  const root = makeTempDir(t, 'qqbot-agentapi-parity-');
  const dataDir = join(root, 'data');
  const workspaceRoot = join(root, 'ws');
  const appDataDir = join(root, 'agy-appdata');

  const typingEvents: Array<{ target: ReplyTarget; duration?: number }> = [];
  const deliveredReplies: string[] = [];
  const agentCalls: AgentApiRunRequest[] = [];
  const agyCliCalls: AgyStreamRunRequest[] = [];
  let convSeq = 0;

  const bridge = createAntigravityBridge({
    dataDir,
    workspaceRoot,
    antigravityAppDataDir: appDataDir,
    backendMode: 'agentapi',
    callbackHost: '127.0.0.1',
    callbackPort: 0,
    agyExecutable: 'agy-mock',
    onNotifyTyping: (target, duration) => {
      typingEvents.push({ target, duration });
    },
    onDeliverReply: async ({ text }) => {
      deliveredReplies.push(text);
    },
    runner: async (req) => {
      agentCalls.push(req);
      if (req.args.includes('new-conversation')) {
        convSeq += 1;
        return { exitCode: 0, stdout: JSON.stringify({ conversationId: `desktop-conv-${convSeq}` }), stderr: '' };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    },
    agyStreamRunner: async (req) => {
      agyCliCalls.push(req);
      if (req.args[0] === 'models') {
        await req.onStdoutLine?.('gemini-4-neon-low\tGemini 4 Neon (Low)');
        await req.onStdoutLine?.('gemini-4-neon-medium\tGemini 4 Neon (Medium)');
        await req.onStdoutLine?.('gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)');
        await req.onStdoutLine?.('gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)');
        return { exitCode: 0, stderr: '' };
      }
      if (req.args.includes('--dangerously-skip-permissions')) {
        await req.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'sub-1' }));
        await req.onStdoutLine?.(
          JSON.stringify({ event: 'result', result: { conversation_id: 'sub-1', status: 'SUCCESS', response: '子任务扫描完毕。' } }),
        );
        return { exitCode: 0, stderr: '' };
      }
      // Summary CLI call during /compact
      await req.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'sum-1' }));
      await req.onStdoutLine?.(
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'sum-1', status: 'SUCCESS', response: '核心检查点：正在构建桌面端同步架构。' },
        }),
      );
      return { exitCode: 0, stderr: '' };
    },
  });

  await bridge.start();
  try {
    // 1. First C2C turn triggers onNotifyTyping and creates desktop-conv-1
    const s1 = await bridge.dispatchInbound(makeC2cInbound('先梳理项目结构', 'm-1'));
    assert.equal(s1.conversationId, 'desktop-conv-1');
    assert.equal(typingEvents.length, 1);
    assert.equal(typingEvents[0]?.target.msgId, 'm-1');
    assert.equal(typingEvents[0]?.duration, 60);

    // 2. /compact when transcript is missing warns honestly and keeps active session
    await bridge.dispatchInbound(makeC2cInbound('/compact', 'm-2'));
    assert.match(deliveredReplies.at(-1) ?? '', /未能在本地读取到桌面会话/);
    assert.equal(bridge.getSession('c2c', 'friend-openid-1', 'bot-friend')?.conversationId, 'desktop-conv-1');

    // 3. Once transcript.jsonl exists, /compact generates AI summary checkpoint and rotates session
    writeTranscriptFile(appDataDir, 'desktop-conv-1', [
      { step_index: 0, type: 'USER_INPUT', content: '[QQ c2c message]\npeerId: x\nreplyToken: t\n\n先梳理项目结构' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: '已完成模块目录梳理。' },
    ]);
    await bridge.dispatchInbound(makeC2cInbound('/compact 保留目录结论', 'm-3'));
    assert.match(deliveredReplies.at(-1) ?? '', /上下文压缩检查点已生成/);
    assert.match(deliveredReplies.at(-1) ?? '', /AI 精炼摘要/);
    assert.equal(bridge.getSession('c2c', 'friend-openid-1', 'bot-friend'), undefined);

    // 4. Subsequent /model 4h + /think xh preserves existing /compact handoff AND pins model for next newConversation
    await bridge.dispatchInbound(makeC2cInbound('/model 4h', 'm-4'));
    await bridge.dispatchInbound(makeC2cInbound('/think xh', 'm-5'));
    assert.match(deliveredReplies.at(-1) ?? '', /gemini-4-hydrogen-xhigh/);

    // 5. Simulate Desktop agent delegating background subagent using replyToken from turn m-6
    const s2 = await bridge.dispatchInbound(makeC2cInbound('继续重构并准备发图', 'm-6'));
    assert.equal(s2.conversationId, 'desktop-conv-2');
    assert.equal(s2.model, 'gemini-4-hydrogen-xhigh');

    const newConvReq = agentCalls.at(-1)!;
    assert.ok(newConvReq.args.includes('new-conversation'));
    assert.ok(newConvReq.args.includes('--model=gemini-4-hydrogen-xhigh'));
    const newPrompt = newConvReq.args.at(-1) ?? '';
    assert.match(newPrompt, /\[Session Checkpoint \/ Previous Context\]/);
    assert.match(newPrompt, /核心检查点：正在构建桌面端同步架构/);

    // Extract replyToken injected into desktop-conv-2, trigger /delegate then /reply
    const tokMatch = /replyToken:\s*(\S+)/.exec(newPrompt);
    assert.ok(tokMatch?.[1]);
    const cbUrl = new URL(bridge.getCallbackUrl());
    const cbOpts = { callbackHost: cbUrl.hostname, callbackPort: Number.parseInt(cbUrl.port, 10) };

    const delRes = await postCallbackDelegate(
      { delegateToken: tokMatch[1], title: '异步检查', prompt: '执行异步检查' },
      cbOpts,
    );
    assert.equal(delRes.ok, true);
    await bridge.waitForBackgroundTasks?.();

    const replyRes = await postCallbackReply({ replyToken: tokMatch[1], text: '主会话先回复你了' }, cbOpts);
    assert.equal(replyRes.ok, true);

    // 6. Next C2C turn in agentapi mode injects [Completed Background Subagent Reports]
    await bridge.dispatchInbound(makeC2cInbound('子任务做完没', 'm-7'));
    const turn7Prompt = agentCalls.at(-1)?.args.at(-1) ?? '';
    assert.match(turn7Prompt, /\[Completed Background Subagent Reports\]/);
    assert.match(turn7Prompt, /子任务扫描完毕/);

    // 7. Mid-conversation /model 4n (Neon alias) rotates desktop-conv-2 carrying its transcript summary!
    writeTranscriptFile(appDataDir, 'desktop-conv-2', [
      { step_index: 0, type: 'USER_INPUT', content: '[QQ c2c message]\nreplyToken: t\n\n继续重构' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: '已完成重构与异步检查。' },
    ]);
    await bridge.dispatchInbound(makeC2cInbound('/model 4n', 'm-8'));
    assert.match(deliveredReplies.at(-1) ?? '', /gemini-4-neon-medium/);
    assert.match(deliveredReplies.at(-1) ?? '', /已暂存旧会话 desktop-conv-2 的上下文摘要/);

    const s3 = await bridge.dispatchInbound(makeC2cInbound('用 Neon 继续聊', 'm-9'));
    assert.equal(s3.conversationId, 'desktop-conv-3');
    const turn9Args = agentCalls.at(-1)!.args;
    assert.ok(turn9Args.includes('--model=gemini-4-neon-medium'));
    assert.match(turn9Args.at(-1) ?? '', /已完成重构与异步检查/);

    // Verify persisted SessionStore keeps model field across reloads
    const reloadedSessions = new SessionStore({ dataDir });
    assert.equal(reloadedSessions.get('c2c', 'friend-openid-1', 'bot-friend')?.model, 'gemini-4-neon-medium');
  } finally {
    await bridge.stop();
  }
});

test('createGatewayRuntime wires sendTyping and sends C2C error feedback when agentapi dispatch fails', async (t) => {
  const dir = makeTempDir(t, 'qqbot-rt-agentapi-err-');
  writeFileSync(
    join(dir, '.env'),
    [
      'QQBOT_APPID=app-rt',
      'QQBOT_SECRET=sec-rt',
      'QQBOT_CALLBACK_HOST=127.0.0.1',
      'QQBOT_CALLBACK_PORT=0',
      'QQBOT_BACKEND=agentapi',
      `QQBOT_DATA_DIR=${join(dir, 'data')}`,
    ].join('\n'),
    'utf8',
  );

  let inboundHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  const sentReplies: Array<{ target: ReplyTarget; text: string }> = [];
  const typingSent: Array<{ target: ReplyTarget; durationSec?: number }> = [];

  const runtime = createGatewayRuntime({
    projectRoot: dir,
    baseEnv: {},
    createGateway: () => ({
      start: async () => {},
      stop: async () => {},
      sendReply: async (reply) => {
        sentReplies.push({ target: reply.target, text: reply.text });
      },
      sendTyping: async (target, durationSec) => {
        typingSent.push({ target, durationSec });
      },
      onInbound: (handler) => {
        inboundHandler = handler;
        return () => {
          inboundHandler = null;
        };
      },
    }),
    bridgeOptions: {
      runner: async () => {
        throw new Error('language_server crashed');
      },
    },
  });

  await runtime.start();
  try {
    assert.ok(inboundHandler);
    await inboundHandler!(makeC2cInbound('触发失败', 'm-err-1'));

    assert.equal(typingSent.length, 1);
    assert.equal(typingSent[0]?.target.msgId, 'm-err-1');
    assert.equal(sentReplies.length, 1);
    assert.match(sentReplies[0]?.text ?? '', /本地桥接执行异常：.*language_server crashed/);
  } finally {
    await runtime.stop();
  }
});

test('resolveAdaptiveModel and syncModelWithEffort support live Neon / Opus 5.5 / Sonnet 5.5 catalogs', () => {
  const liveCatalog = parseAgyModelsOutput(
    [
      'gemini-4-neon-low\tGemini 4 Neon (Low)',
      'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
      'gemini-4-neon-high\tGemini 4 Neon (High)',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
    ].join('\n'),
  );

  assert.equal(resolveAdaptiveModel('4c', undefined, liveCatalog).match?.entry.id, 'gemini-4-neon-medium');
  assert.equal(resolveAdaptiveModel('4n-high', undefined, liveCatalog).match?.entry.id, 'gemini-4-neon-high');
  assert.equal(resolveAdaptiveModel('opus', undefined, liveCatalog).match?.entry.id, 'claude-opus-5-5-high');
  assert.equal(resolveAdaptiveModel('sonnet', undefined, liveCatalog).match?.entry.id, 'claude-sonnet-5-5-medium');
  assert.equal(syncModelWithEffort(undefined, 'low', liveCatalog), 'gemini-4-neon-low');
});
