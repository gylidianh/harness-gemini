import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  ACTIONS,
  MAX_RESPONSE_DATA_BYTES,
  RESPONSE_WRAPPER_RESERVE,
  createControlPlane,
  sliceTextByJsonBytes,
} from '../app/server/control-plane.mjs';
import { createDirectHost } from '../app/server/remote-direct.mjs';
import { createRelayClient } from '../app/desktop/relay-client.mjs';
import { startRelay } from '../relay-server/server.mjs';
import * as protocol from '../app/shared/relay-protocol.mjs';

const {
  MAX_ENVELOPE_BYTES,
  MAX_PLAINTEXT_BYTES,
  deriveDeviceKey,
  envelopeBytes,
  open,
  openPlain,
  randomSecret,
  seal,
  sealPlain,
} = protocol;

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function waitFor(predicate, { timeout = 8_000, interval = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

async function openStream(url, headers, onEvent) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length) await onEvent(event, JSON.parse(data.join('\n')));
        }
      }
    } catch { /* closed */ }
  })();
  return { close: () => controller.abort() };
}

test('Plan A protocol limits and surrogate-safe UTF-8 JSON byte slicing', () => {
  assert.equal(MAX_PLAINTEXT_BYTES, 8 * 1024);
  assert.equal(MAX_ENVELOPE_BYTES, 12 * 1024);
  assert.ok(RESPONSE_WRAPPER_RESERVE >= 300);
  assert.equal(MAX_RESPONSE_DATA_BYTES, MAX_PLAINTEXT_BYTES - RESPONSE_WRAPPER_RESERVE);
  assert.ok(ACTIONS.has('session.messages'));
  assert.ok(ACTIONS.has('session.message.read'));

  const emojiRich = Array.from({ length: 600 }, (_, i) => `段落${i}: 🚀😀🎉 "quoted\\line"\n`).join('');
  for (const budget of [17, 64, 513, 7500]) {
    let offset = 0;
    let rebuilt = '';
    let chunks = 0;
    while (offset !== null) {
      const slice = sliceTextByJsonBytes(emojiRich, offset, budget);
      assert.equal(hasLoneSurrogate(slice.text), false);
      assert.ok(Buffer.byteLength(JSON.stringify(slice.text), 'utf8') <= budget);
      rebuilt += slice.text;
      chunks += 1;
      assert.ok(chunks < 5000);
      if (slice.nextOffset !== null) assert.ok(slice.nextOffset > offset);
      offset = slice.nextOffset;
    }
    assert.equal(rebuilt, emojiRich);
  }

  const snapped = sliceTextByJsonBytes('A😀B🚀C', 2, 100);
  assert.equal(snapped.start, 1);
  assert.equal(snapped.text, '😀B🚀C');
  assert.equal(hasLoneSurrogate(snapped.text), false);
});

test('remote session reading: chunk reconstruction, live deltas, redaction, direct RPC & unmodified relay', async t => {
  const sessionId = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  const m3 = randomUUID();
  const m4 = randomUUID();
  const longReply = [
    '# 详细分析报告 🚀',
    '',
    '```js',
    'const greeting = "hello\\nworld";',
    '```',
    '',
    ...Array.from({ length: 450 }, (_, i) => `第 ${i + 1} 行：中文正文与表情🔥✅ "引号" 和 \\反斜杠\\ 测试内容。`),
  ].join('\n');
  const longReasoning = Array.from({ length: 300 }, (_, i) => `思考步骤 ${i + 1}：分析边界条件与性能权衡 🧠。`).join('\n');

  const sessionRecord = {
    id: sessionId,
    title: '长回复与实时正文测试',
    updatedAt: '2026-11-28T10:00:00.000Z',
    messages: [
      { id: m1, role: 'user', text: '第一条历史问题', status: 'done', createdAt: '2026-11-28T09:50:00.000Z' },
      { id: m2, role: 'assistant', text: '第一条历史回答', status: 'done', createdAt: '2026-11-28T09:51:00.000Z' },
      {
        id: m3, role: 'user', text: '请输出一份超长带表情的报告', status: 'done',
        createdAt: '2026-11-28T09:52:00.000Z',
        attachments: [{ ref: 'a.pdf', name: 'a.pdf', data: 'SHOULD_NEVER_LEAK_BASE64' }],
      },
      {
        id: m4, role: 'assistant', text: longReply, reasoning: longReasoning, status: 'done',
        createdAt: '2026-11-28T09:53:00.000Z',
        tools: [{
          name: 'read_file', status: 'done',
          args: { path: 'secret.env', apiKey: 'placeholder-credential-value' },
          output: 'TOP_SECRET_TOOL_OUTPUT_DO_NOT_LEAK',
        }],
        artifacts: [{ url: '/api/artifacts/0123456789abcdef0123456789abcdef0123.png' }],
        notice: '已保留完整输出',
      },
    ],
  };

  const liveSessionId = randomUUID();
  const liveMsgId = randomUUID();
  const liveAssistant = {
    id: liveMsgId, role: 'assistant', text: '正在流式生成第一段😀', reasoning: '先检查依赖',
    status: 'running', createdAt: '2026-11-28T10:05:00.000Z',
    tools: [{ name: 'run_command', status: 'running', output: 'SECRET_STDOUT' }],
    artifacts: [],
  };
  const liveRun = {
    id: liveSessionId,
    finished: false,
    mode: 'agent',
    assistant: liveAssistant,
    session: {
      id: liveSessionId,
      title: '实时流式会话',
      messages: [
        { id: randomUUID(), role: 'user', text: '实时跑一下', status: 'done', createdAt: '2026-11-28T10:04:59.000Z' },
        liveAssistant,
      ],
    },
  };

  const sessionsMap = new Map([
    [sessionId, sessionRecord],
    [liveSessionId, { id: liveSessionId, title: '旧磁盘副本', messages: [] }],
  ]);
  const harness = {
    runs: new Map([[liveSessionId, liveRun]]),
    approvals: { pending: new Map() },
    questions: { pending: new Map() },
    store: {
      settings: { approvalMode: 'ask' },
      listSessions: async () => [
        { id: liveSessionId, title: '实时流式会话', updatedAt: '2026-11-28T10:05:00.000Z' },
        { id: sessionId, title: '长回复与实时正文测试', updatedAt: '2026-11-28T10:00:00.000Z' },
      ],
      getSession: async id => {
        const hit = sessionsMap.get(id);
        if (!hit) throw Object.assign(new Error('会话不存在。'), { status: 404 });
        return hit;
      },
    },
  };

  const dataDir = await mkdtemp(path.join(tmpdir(), 'harness-session-content-'));
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  t.after(async () => {
    await new Promise(resolve => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const plane = createControlPlane({ harness, origin, dataDir });
  const page1 = await plane.execute({ action: 'session.messages', params: { sessionId }, deviceId: 'dev-1' });
  assert.ok(Buffer.byteLength(JSON.stringify(page1), 'utf8') <= MAX_RESPONSE_DATA_BYTES);
  const latestEntry = page1.messages.at(-1);
  assert.equal(latestEntry.id, m4);
  assert.ok(Number.isSafeInteger(latestEntry.nextOffset));
  assert.equal(hasLoneSurrogate(latestEntry.text), false);

  let reconstructed = latestEntry.text;
  let nextOffset = latestEntry.nextOffset;
  while (nextOffset !== null) {
    const chunk = await plane.execute({
      action: 'session.message.read',
      params: { sessionId, messageId: m4, offset: nextOffset, field: 'text' },
      deviceId: 'dev-1',
    });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk), 'utf8') <= MAX_RESPONSE_DATA_BYTES);
    assert.equal(hasLoneSurrogate(chunk.chunk), false);
    assert.equal(chunk.offset, reconstructed.length);
    reconstructed += chunk.chunk;
    nextOffset = chunk.nextOffset;
  }
  assert.equal(reconstructed, longReply);

  let reasoningRebuilt = '';
  let rOffset = 0;
  while (rOffset !== null) {
    const chunk = await plane.execute({
      action: 'session.message.read',
      params: { sessionId, messageId: m4, offset: rOffset, field: 'reasoning' },
      deviceId: 'dev-1',
    });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk), 'utf8') <= MAX_RESPONSE_DATA_BYTES);
    reasoningRebuilt += chunk.chunk;
    rOffset = chunk.nextOffset;
  }
  assert.equal(reasoningRebuilt, longReasoning);

  const older = await plane.execute({
    action: 'session.messages',
    params: { sessionId, beforeIndex: page1.startIndex },
    deviceId: 'dev-1',
  });
  assert.equal(older.messages.length, page1.startIndex);
  assert.equal(older.messages[0].id, m1);
  assert.equal(older.hasMoreBefore, false);

  const combinedDump = JSON.stringify({ page1, older });
  assert.equal(combinedDump.includes('TOP_SECRET_TOOL_OUTPUT'), false);
  assert.equal(combinedDump.includes('placeholder-credential-value'), false);
  assert.equal(combinedDump.includes('SHOULD_NEVER_LEAK_BASE64'), false);
  assert.equal(latestEntry.tools[0].name, 'read_file');
  assert.equal(latestEntry.artifactCount, 1);

  const livePage = await plane.execute({ action: 'session.messages', params: { sessionId: liveSessionId }, deviceId: 'dev-1' });
  assert.equal(livePage.running, true);
  assert.equal(livePage.messages.at(-1).text, '正在流式生成第一段😀');
  liveAssistant.text += '\n第二段新增内容🚀';
  const delta1 = await plane.execute({
    action: 'session.message.read',
    params: { sessionId: liveSessionId, messageId: liveMsgId, offset: livePage.messages.at(-1).text.length },
    deviceId: 'dev-1',
  });
  assert.equal(delta1.chunk, '\n第二段新增内容🚀');
  assert.equal(delta1.running, true);
  liveAssistant.status = 'done';
  liveRun.finished = true;
  const delta2 = await plane.execute({
    action: 'session.message.read',
    params: { sessionId: liveSessionId, messageId: liveMsgId, offset: liveAssistant.text.length },
    deviceId: 'dev-1',
  });
  assert.equal(delta2.chunk, '');
  assert.equal(delta2.running, false);

  for (const [action, params, status] of [
    ['session.messages', { sessionId: 'bad' }, 400],
    ['session.messages', { sessionId: randomUUID() }, 404],
    ['session.messages', { sessionId, beforeIndex: 999 }, 400],
    ['session.message.read', { sessionId, messageId: m4, field: 'tools' }, 400],
    ['session.message.read', { sessionId, messageId: m4, offset: -1 }, 400],
    ['session.message.read', { sessionId, messageId: randomUUID() }, 404],
  ]) {
    await assert.rejects(() => plane.execute({ action, params, deviceId: 'dev-1' }), err => err?.status === status);
  }

  // Direct HTTP RPC (sealed & plain)
  const secret = randomSecret(32);
  const directDeviceId = randomUUID();
  const directToken = randomSecret(32);
  const directKey = await deriveDeviceKey(secret, directDeviceId);
  const directHost = createDirectHost({
    origin, harness, dataDir, host: '127.0.0.1', pollMs: 100_000,
    config: { enabled: true, pairSecret: secret, allowPlainLan: true, devices: [{ deviceId: directDeviceId, token: directToken, transport: 'sealed' }] },
  });
  await directHost.start({ listenPort: 0 });
  const directBase = `http://127.0.0.1:${directHost.describe().port}`;
  try {
    async function directRpc(plain, action, params) {
      const env = plain ? sealPlain('invoke', { action, params }) : await seal(directKey, 'invoke', { action, params });
      const res = await fetch(`${directBase}/phone/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${directToken}` },
        body: JSON.stringify({ deviceId: directDeviceId, envelope: env, replyMode: 'http' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(envelopeBytes(body.envelope) <= MAX_ENVELOPE_BYTES);
      const opened = plain ? openPlain(body.envelope) : await open(directKey, body.envelope);
      assert.equal(opened.payload.ok, true);
      return opened.payload.data;
    }

    for (const plain of [false, true]) {
      const first = await directRpc(plain, 'session.messages', { sessionId });
      let full = first.messages.at(-1).text;
      let cursor = first.messages.at(-1).nextOffset;
      while (cursor !== null) {
        const part = await directRpc(plain, 'session.message.read', { sessionId, messageId: m4, offset: cursor });
        full += part.chunk;
        cursor = part.nextOffset;
      }
      assert.equal(full, longReply);
    }
  } finally {
    await directHost.stop();
  }

  // Unmodified VPS relay E2E
  const relay = await startRelay({ port: 0, relayToken: 'relay-content-test', pairCodeHash: sha256(secret) });
  const relayClient = createRelayClient({
    origin, harness, dataDir,
    config: { enabled: true, url: relay.url, relayToken: 'relay-content-test', pairSecret: secret, devices: [] },
  });
  relayClient.start();
  let relayStream = null;
  try {
    assert.ok(await waitFor(() => relay.stats().desktop));
    const paired = await (await fetch(new URL('/pair', relay.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codeHash: sha256(secret) }),
    })).json();
    const relayKey = await deriveDeviceKey(secret, paired.deviceId);
    const relayReplies = new Map();
    relayStream = await openStream(
      new URL(`/phone/stream?deviceId=${paired.deviceId}`, relay.url),
      { authorization: `Bearer ${paired.token}`, accept: 'text/event-stream' },
      async (event, data) => {
        if (event !== 'message' || !data.envelope) return;
        assert.ok(envelopeBytes(data.envelope) <= MAX_ENVELOPE_BYTES);
        const msg = await open(relayKey, data.envelope);
        if (msg.type === 'result') relayReplies.set(msg.payload.replyTo, msg.payload);
      },
    );

    async function relayInvoke(action, params) {
      const env = await seal(relayKey, 'invoke', { action, params });
      const res = await fetch(new URL('/phone/invoke', relay.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${paired.token}` },
        body: JSON.stringify({ deviceId: paired.deviceId, envelope: env }),
      });
      assert.equal(res.status, 202);
      assert.ok(await waitFor(() => relayReplies.has(env.id)));
      const reply = relayReplies.get(env.id);
      assert.equal(reply.ok, true);
      return reply.data;
    }

    const relayFirst = await relayInvoke('session.messages', { sessionId });
    let relayFull = relayFirst.messages.at(-1).text;
    let relayCursor = relayFirst.messages.at(-1).nextOffset;
    while (relayCursor !== null) {
      const part = await relayInvoke('session.message.read', { sessionId, messageId: m4, offset: relayCursor });
      relayFull += part.chunk;
      relayCursor = part.nextOffset;
    }
    assert.equal(relayFull, longReply);
  } finally {
    relayStream?.close();
    relayClient.stop();
    await relay.close();
  }
});

test('phone.html parity and XSS-safe markdown rendering', async () => {
  const phoneHtml = await readFile(new URL('../app/remote/phone.html', import.meta.url), 'utf8');
  const relayHtml = await readFile(new URL('../relay-server/phone.html', import.meta.url), 'utf8');
  assert.equal(phoneHtml.replace(/\r\n/g, '\n'), relayHtml.replace(/\r\n/g, '\n'));

  const scriptSource = phoneHtml.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
  const logic = scriptSource.slice(0, scriptSource.lastIndexOf('transport = await detectTransport();'));
  const mockNodes = new Map();
  const makeNode = () => ({
    textContent: '', innerHTML: '', value: '', disabled: false, style: {}, dataset: {}, open: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll() { return []; }, replaceChildren() {}, remove() {},
    querySelector() { return makeNode(); },
  });
  const ctx = vm.createContext({
    ...protocol, console, crypto: globalThis.crypto, isSecureContext: true,
    AbortController, URLSearchParams, TextDecoderStream, fetch: async () => { throw new Error('unused'); },
    document: {
      hidden: false, documentElement: { scrollHeight: 1000 },
      getElementById(id) { if (!mockNodes.has(id)) mockNodes.set(id, makeNode()); return mockNodes.get(id); },
      querySelectorAll() { return []; }, addEventListener() {}, createElement: makeNode,
    },
    window: { addEventListener() {}, scrollTo() {}, innerHeight: 800, scrollY: 200 },
    navigator: {}, location: { hash: '', search: '', pathname: '/', reload() {} },
    history: { replaceState() {} }, localStorage: { getItem() { return null; } },
    clearDevice: async () => {}, readDevice: async () => null, writeDevice: async () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(logic, ctx);
  const rendered = vm.runInContext(`renderMarkdownSafe('<script>alert(1)<\\/script> **粗体** \`code\`\\n\`\`\`js\\n<b>x</b>\\n\`\`\`\\n![img](/api/artifacts/0123456789abcdef0123456789abcdef0123.png)')`, ctx);
  assert.equal(rendered.includes('<script>'), false);
  assert.ok(rendered.includes('&lt;script&gt;'));
  assert.ok(rendered.includes('<strong>粗体</strong>'));
  assert.ok(rendered.includes('<code class="md-code">code</code>'));
  assert.ok(rendered.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(rendered.includes('图片附件'));
});
