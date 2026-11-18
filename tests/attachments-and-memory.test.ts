import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { installLocalPlugin, parseInstallCliArgs } from '../scripts/install-plugin.ts';
import {
  createAntigravityBridge,
  downloadInboundAttachments,
  formatBridgePrompt,
  normalizeAttachmentUrl,
  sniffImageExtension,
} from '../src/bridge/index.ts';
import { mapInboundMessage } from '../src/qq/index.ts';
import { loadRuntimeConfig, parseDirectoryList } from '../src/shared/config.ts';

// 1x1 PNG minimal header + payload bytes
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

test('normalizeAttachmentUrl normalizes QQ protocol-relative / bare host URLs and blocks unsafe schemes', () => {
  assert.equal(
    normalizeAttachmentUrl('//multimedia.nt.qq.com.cn/download?appid=1&fileid=abc'),
    'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=abc',
  );
  assert.equal(
    normalizeAttachmentUrl('multimedia.nt.qq.com.cn/download?fileid=xyz'),
    'https://multimedia.nt.qq.com.cn/download?fileid=xyz',
  );
  assert.equal(
    normalizeAttachmentUrl('https://cdn.example.com/a.png'),
    'https://cdn.example.com/a.png',
  );
  assert.equal(normalizeAttachmentUrl('file:///etc/passwd'), null);
  assert.equal(normalizeAttachmentUrl('javascript:alert(1)'), null);
  assert.equal(normalizeAttachmentUrl('   '), null);
});

test('sniffImageExtension detects PNG, JPEG, GIF, and WEBP magic bytes', () => {
  assert.equal(sniffImageExtension(PNG_BYTES), '.png');
  assert.equal(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), '.jpg');
  assert.equal(sniffImageExtension(Buffer.from('GIF89a', 'ascii')), '.gif');
  assert.equal(sniffImageExtension(Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary')), '.webp');
  assert.equal(sniffImageExtension(Buffer.from('hello world', 'utf8')), undefined);
});

test('mapInboundMessage extracts direct and quoted attachments with deduplication while preserving plain messages', () => {
  const plain = mapInboundMessage({
    kind: 'c2c',
    messageId: 'm-plain',
    senderId: 'u-1',
    content: 'just text',
    timestamp: '2026-11-18T00:00:00.000Z',
  } as unknown as QQBotInboundMessage);

  assert.ok(plain);
  assert.equal('attachments' in plain, false);

  const withMedia = mapInboundMessage({
    kind: 'c2c',
    messageId: 'm-img',
    senderId: 'u-1',
    content: '',
    timestamp: '2026-11-18T00:00:01.000Z',
    attachments: [
      {
        content_type: 'image/png',
        url: '//multimedia.nt.qq.com.cn/download?fileid=1',
        filename: 'cat.png',
        width: 800,
        height: 600,
        size: 1024,
      },
    ],
    msgElements: [
      {
        attachments: [
          // Duplicate URL should be deduplicated
          {
            content_type: 'image/png',
            url: '//multimedia.nt.qq.com.cn/download?fileid=1',
          },
          // Quoted historical image should be included
          {
            content_type: 'image/jpeg',
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=quoted-2',
            filename: 'quoted.jpg',
          },
        ],
      },
    ],
  } as unknown as QQBotInboundMessage);

  assert.ok(withMedia?.attachments);
  assert.equal(withMedia.attachments.length, 2);
  assert.equal(withMedia.attachments[0]?.filename, 'cat.png');
  assert.equal(withMedia.attachments[0]?.width, 800);
  assert.equal(withMedia.attachments[1]?.filename, 'quoted.jpg');
});

test('downloadInboundAttachments saves real HTTP images with magic-byte extension and degrades gracefully on failure', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-att-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const server = createServer((req, res) => {
    if (req.url === '/raw-qq-img') {
      // Simulate QQ CDN returning octet-stream without filename extension
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(PNG_BYTES);
      return;
    }
    if (req.url === '/too-big') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(2048, 1));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => {
    server.close();
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const downloaded = await downloadInboundAttachments(
    [
      {
        contentType: 'application/octet-stream',
        url: `${baseUrl}/raw-qq-img`,
        filename: '0',
      },
      {
        contentType: 'image/png',
        url: `${baseUrl}/too-big`,
        filename: 'huge.png',
      },
      {
        contentType: 'image/jpeg',
        url: `${baseUrl}/missing`,
        filename: '404.jpg',
      },
    ],
    tempRoot,
    {
      maxBytes: 512,
      messageId: 'msg-99',
      now: () => 1700000000000,
    },
  );

  assert.equal(downloaded.length, 3);

  // 1st succeeded and sniffed .png + image/png
  const okItem = downloaded[0];
  assert.ok(okItem?.localPath);
  assert.ok(okItem.localPath.endsWith('.png'));
  assert.equal(okItem.contentType, 'image/png');
  assert.deepEqual(readFileSync(okItem.localPath), PNG_BYTES);

  // 2nd failed max size check without throwing
  assert.equal(downloaded[1]?.localPath, undefined);
  assert.match(downloaded[1]?.error ?? '', /exceeds max size/);

  // 3rd failed HTTP 404 without throwing
  assert.equal(downloaded[2]?.localPath, undefined);
  assert.match(downloaded[2]?.error ?? '', /HTTP 404/);
});

test('createAntigravityBridge downloads inbound images into session attachments dir and scopes memoryDirs to C2C only', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-e2e-media-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const memoryDir = join(tempRoot, 'local-memory-notes');
  const capturedPrompts: string[] = [];

  const bridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data'),
    workspaceRoot: join(tempRoot, 'workspaces'),
    memoryDirs: [memoryDir],
    callbackPort: 0,
    fetchImpl: async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    runner: async (req) => {
      const sepIdx = req.args.indexOf('--');
      const prompt = req.args.includes('new-conversation')
        ? (req.args[sepIdx + 1] ?? '')
        : (req.args[sepIdx + 2] ?? '');
      capturedPrompts.push(prompt);
      return { exitCode: 0, stdout: '{"conversationId":"conv-media-1"}', stderr: '' };
    },
  });

  await bridge.start();
  t.after(async () => {
    await bridge.stop();
  });

  // 1. C2C image-only message (empty text) -> downloads image + includes memoryDirs + read_file hint
  const c2cSession = await bridge.dispatchInbound({
    messageId: 'm-c2c-img',
    scope: 'c2c',
    peerId: 'user-jiaqi',
    senderId: 'user-jiaqi',
    text: '',
    attachments: [
      {
        contentType: 'image/png',
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=img1',
        filename: 'screen.png',
      },
    ],
    receivedAt: 1700000000000,
    replyTarget: { scope: 'c2c', targetId: 'user-jiaqi', msgId: 'm-c2c-img' },
  });

  const c2cPrompt = capturedPrompts[0] ?? '';
  assert.match(c2cPrompt, /memoryDirs:/);
  assert.ok(c2cPrompt.includes(memoryDir));
  assert.match(c2cPrompt, /\[Attachments\]/);
  assert.match(c2cPrompt, /read_file/);
  assert.match(c2cPrompt, /\[User sent attachment\(s\) without additional text\.\]/);

  const expectedAttDir = join(c2cSession.workspaceDir!, 'attachments');
  assert.equal(existsSync(expectedAttDir), true);

  // 2. Group message -> must NOT expose private memoryDirs
  await bridge.dispatchInbound({
    messageId: 'm-grp-1',
    scope: 'group',
    peerId: 'grp-public',
    senderId: 'member-x',
    text: 'hello group',
    receivedAt: 1700000001000,
    replyTarget: { scope: 'group', targetId: 'grp-public', msgId: 'm-grp-1' },
  });

  const groupPrompt = capturedPrompts[1] ?? '';
  assert.equal(groupPrompt.includes('memoryDirs:'), false);
  assert.equal(groupPrompt.includes(memoryDir), false);

  // Also check formatBridgePrompt directly when text + image are both present
  const mixed = formatBridgePrompt(
    {
      messageId: 'm-2',
      scope: 'c2c',
      peerId: 'u-1',
      senderId: 'u-1',
      text: '帮我看看这张图',
      receivedAt: 1700000002000,
      replyTarget: { scope: 'c2c', targetId: 'u-1' },
    },
    'tok-abc',
    'C:\\ws\\c2c-u1',
    {
      memoryDirs: ['C:\\notes'],
      downloadedAttachments: [
        {
          contentType: 'image/png',
          url: 'https://example.com/a.png',
          filename: 'a.png',
          localPath: 'C:\\ws\\c2c-u1\\attachments\\a.png',
        },
      ],
    },
  );
  assert.ok(mixed.includes('memoryDirs: C:\\notes'));
  assert.ok(mixed.includes('C:\\ws\\c2c-u1\\attachments\\a.png'));
  assert.ok(mixed.endsWith('\n\n帮我看看这张图'));

  // 3. Voice message with built-in QQ ASR transcript -> MUST skip .wav download and inline [Voice message]
  let voiceFetchCount = 0;
  const voiceBridge = createAntigravityBridge({
    dataDir: join(tempRoot, 'data-voice'),
    workspaceRoot: join(tempRoot, 'workspaces-voice'),
    callbackPort: 0,
    fetchImpl: async () => {
      voiceFetchCount += 1;
      throw new Error('Should not fetch .wav when asrReferText is present');
    },
    runner: async (req) => {
      const sepIdx = req.args.indexOf('--');
      const prompt = req.args[sepIdx + 1] ?? '';
      capturedPrompts.push(prompt);
      return { exitCode: 0, stdout: '{"conversationId":"conv-voice-1"}', stderr: '' };
    },
  });
  await voiceBridge.start();
  t.after(async () => {
    await voiceBridge.stop();
  });

  const voiceSession = await voiceBridge.dispatchInbound({
    messageId: 'm-voice-1',
    scope: 'c2c',
    peerId: 'user-jiaqi',
    senderId: 'user-jiaqi',
    text: '',
    attachments: [
      {
        contentType: 'audio/x-wav',
        url: 'https://multimedia.nt.qq.com.cn/download?fileid=voice1.wav',
        filename: 'voice1.wav',
        asrReferText: '有点累，干了好多活。',
      },
    ],
    receivedAt: 1700000003000,
    replyTarget: { scope: 'c2c', targetId: 'user-jiaqi', msgId: 'm-voice-1' },
  });

  assert.equal(voiceFetchCount, 0);
  const voicePrompt = capturedPrompts[2] ?? '';
  assert.equal(voicePrompt.includes('[Attachments]'), false);
  assert.equal(voicePrompt.includes('.wav'), false);
  assert.match(voicePrompt, /\[Voice message\] 有点累，干了好多活。/);
  assert.equal(existsSync(join(voiceSession.workspaceDir!, 'attachments')), false);
});

test('installLocalPlugin and config support QQBOT_MEMORY_DIR and inject workspace_uris permissions', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'qqbot-mem-install-'));
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const memA = join(tempRoot, 'mem-A');
  const memB = join(tempRoot, 'mem-B');
  const parsedList = parseDirectoryList(` ${memA} ; ${memB} ; ${memA} `);
  assert.equal(parsedList.length, 2);

  const cfg = loadRuntimeConfig({ QQBOT_MEMORY_DIR: `${memA};${memB}` });
  assert.deepEqual(cfg.memoryDirs, [resolve(memA), resolve(memB)]);

  const cliParsed = parseInstallCliArgs(['--workspace', 'E:\\ws', '--memory-dir', `${memA};${memB}`]);
  assert.equal(cliParsed.workspaceDir, 'E:\\ws');
  assert.deepEqual(cliParsed.memoryDirs, [resolve(memA), resolve(memB)]);

  const repoRoot = resolve(import.meta.dirname, '..');
  const workspaceDir = join(tempRoot, 'ws');
  const targetPluginDir = join(tempRoot, 'plugin-out');

  const res = installLocalPlugin({
    repoRoot,
    targetPluginDir,
    workspaceDir,
    memoryDirs: [memA, memB],
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.deepEqual(res.memoryDirs, [resolve(memA), resolve(memB)]);
  assert.deepEqual(res.workspaceUris, [
    pathToFileURL(resolve(workspaceDir)).href,
    pathToFileURL(resolve(memA)).href,
    pathToFileURL(resolve(memB)).href,
  ]);

  const sidecar = JSON.parse(
    readFileSync(join(targetPluginDir, 'sidecars', 'qqbot-gateway', 'sidecar.json'), 'utf8'),
  ) as {
    env: Record<string, string>;
    agent_permissions: { workspace_uris: string[] };
  };
  assert.equal(sidecar.env.QQBOT_MEMORY_DIR, `${resolve(memA)};${resolve(memB)}`);
  assert.deepEqual(sidecar.agent_permissions.workspace_uris, res.workspaceUris);
});
