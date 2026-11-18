import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CallbackServer, ReplyTokenRegistry } from '../src/bridge/index.ts';
import {
  QQBOT_SEND_MEDIA_TOOL_NAME,
  createMcpServer,
  postCallbackMedia,
} from '../src/mcp/index.ts';
import { createQqGateway } from '../src/qq/index.ts';
import type { QqBotClient } from '../src/qq/index.ts';
import { loadRuntimeConfig } from '../src/shared/config.ts';

test('QqGateway.sendMedia dispatches local image and file via underlying QQBot client', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'qqbot-media-gw-'));
  const imgPath = join(tempDir, 'chart.png');
  const txtPath = join(tempDir, 'report.txt');
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(txtPath, 'hello report', 'utf8');

  const imageCalls: Array<{ target: unknown; source: unknown; opts?: unknown }> = [];
  const fileCalls: Array<{ target: unknown; source: unknown; opts?: unknown }> = [];

  let triggerStartReady!: () => void;
  const gw = createQqGateway(
    loadRuntimeConfig({ QQBOT_APPID: 'app-m', QQBOT_SECRET: 'sec-m' }),
    {
      credentials: { appId: 'app-m', appSecret: 'sec-m', source: 'env' },
      botFactory: () => {
        const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
        let resolveStart!: () => void;
        const client: QqBotClient = {
          appId: 'app-m',
          use: () => client,
          on: (evt, handler) => {
            const list = listeners.get(String(evt)) ?? [];
            list.push(handler as (...args: unknown[]) => unknown);
            listeners.set(String(evt), list);
            return client;
          },
          start: () =>
            new Promise<void>((res) => {
              resolveStart = res;
              triggerStartReady = () => {
                for (const h of listeners.get('ready') ?? []) h({});
              };
              queueMicrotask(triggerStartReady);
            }),
          stop: () => {
            resolveStart?.();
          },
          send: async () => ({ id: 'm1', timestamp: '2026-11-19T00:00:00Z' }),
          sendText: async () => ({ id: 'm2', timestamp: '2026-11-19T00:00:00Z' }),
          sendMarkdown: async () => ({ id: 'm3', timestamp: '2026-11-19T00:00:00Z' }),
          sendImage: async (target, source, opts) => {
            imageCalls.push({ target, source, opts });
            return { upload: { file_uuid: 'u1' }, message: { id: 'img-1', timestamp: 'now' } };
          },
          sendFile: async (target, source, opts) => {
            fileCalls.push({ target, source, opts });
            return { upload: { file_uuid: 'u2' }, message: { id: 'file-1', timestamp: 'now' } };
          },
        };
        return client;
      },
    },
  );

  await gw.start();
  try {
    const res1 = await gw.sendMedia!({
      target: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
      localPath: imgPath,
      caption: '最新图表',
    });
    assert.equal(res1.mediaType, 'image');
    assert.equal(imageCalls.length, 1);
    assert.deepEqual(imageCalls[0]!.source, { localPath: imgPath });
    assert.deepEqual(imageCalls[0]!.opts, { content: '最新图表' });

    const res2 = await gw.sendMedia!({
      target: { scope: 'c2c', targetId: 'user-1' },
      localPath: txtPath,
      caption: '导出报告',
    });
    assert.equal(res2.mediaType, 'file');
    assert.equal(fileCalls.length, 1);
    assert.deepEqual(fileCalls[0]!.source, { localPath: txtPath });
    assert.deepEqual(fileCalls[0]!.opts, { fileName: 'report.txt', content: '导出报告' });

    await assert.rejects(
      () =>
        gw.sendMedia!({
          target: { scope: 'c2c', targetId: 'user-1' },
          localPath: join(tempDir, 'missing.png'),
        }),
      /does not exist/,
    );
  } finally {
    await gw.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('MCP qqbot_send_media round-trips via CallbackServer /media endpoint', async () => {
  const replyTokens = new ReplyTokenRegistry();
  const token = replyTokens.issue({ scope: 'c2c', targetId: 'u-media', msgId: 'msg-media' });
  const received: Array<{ targetId: string; url?: string; mediaType?: string; caption?: string }> = [];

  const server = new CallbackServer({
    host: '127.0.0.1',
    port: 0,
    replyTokens,
    onDeliverMedia: async ({ target, url, mediaType, caption }) => {
      received.push({ targetId: target.targetId, url, mediaType, caption });
      return { mediaType: mediaType ?? 'image', deliveredAt: 123456 };
    },
  });

  await server.start();
  try {
    const addr = server.getAddress();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const mcp = createMcpServer({
      stdin,
      stdout,
      callback: { callbackHost: addr.host, callbackPort: addr.port },
    });

    const outLines: string[] = [];
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) {
        if (l.trim()) outLines.push(l);
      }
    });

    await mcp.start();
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: QQBOT_SEND_MEDIA_TOOL_NAME,
          arguments: {
            replyToken: token,
            url: 'https://example.com/demo.png',
            mediaType: 'image',
            caption: '远程图',
          },
        },
      })}\n`,
    );

    await new Promise((r) => setTimeout(r, 80));
    await mcp.stop();

    const listResp = JSON.parse(outLines[0]!) as { result: { tools: Array<{ name: string }> } };
    assert.ok(listResp.result.tools.some((t) => t.name === QQBOT_SEND_MEDIA_TOOL_NAME));

    const callResp = JSON.parse(outLines[1]!) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(callResp.result.isError, undefined);
    assert.match(callResp.result.content[0]!.text, /Media \(image\) delivered to QQ/);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.targetId, 'u-media');
    assert.equal(received[0]!.url, 'https://example.com/demo.png');

    // Direct postCallbackMedia invalid token check
    const badRes = await postCallbackMedia(
      { replyToken: 'expired-token', url: 'https://example.com/a.png' },
      { callbackHost: addr.host, callbackPort: addr.port },
    );
    assert.equal(badRes.ok, false);
    assert.equal(badRes.statusCode, 404);
  } finally {
    await server.stop();
  }
});
