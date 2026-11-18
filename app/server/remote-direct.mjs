// The direct remote link: the phone talks to this app over the local network, no VPS involved.
//
// It serves the same phone page and speaks the same protocol as the relay, so the two modes can
// never disagree about what a phone may do. What changes is the route:
//
//   relay mode   phone → your VPS (dumb pipe) → this app dials out
//   direct mode  phone → this app, over Wi-Fi        (or phone → Cloudflare → this app)
//
// The reasons this is a separate listener rather than "open the main service to the LAN":
//
//   1. the app's own service stays on 127.0.0.1, untouched, with no new route on the public
//      internet that could be confused with it;
//   2. this listener only answers the phone routes below — it has no session, file, settings
//      or model API at all;
//   3. pairing, the device list, revocation, the replay guard and the dispatch gates are the
//      same code the relay client uses (`control-plane.mjs`), so there is one place to audit.
//
// A phone on `http://192.168…` has no WebCrypto, so this host also accepts the plaintext
// envelope described in `shared/relay-protocol.mjs`. Over HTTPS (Cloudflare tunnel) the page
// seals everything exactly as it does against the relay, and the plaintext path is never used.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveDeviceKey, isId, isPlainEnvelope, open, openPlain, randomSecret, ReplayGuard, seal, sealPlain,
} from '../shared/relay-protocol.mjs';
import { createControlPlane } from './control-plane.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The phone page, its service worker and its IndexedDB helper, shipped inside the app. */
export const ASSET_DIR = path.join(HERE, '..', 'remote');
export const DEFAULT_PORT = 8791;
const MAX_BODY = 64 * 1024;
const MAX_ENVELOPE = 12 * 1024;
const MAX_DEVICES = 8;
const PING_MS = 20_000;
// How many replies may wait for a phone that has no event stream yet. A phone reconnects within
// seconds; 32 covers every request a page can have in flight with a wide margin, and the cap is
// what keeps a phone that never comes back from growing this host's memory.
const MAX_OUTBOX = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameText(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求内容过大。'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch { reject(Object.assign(new Error('请求内容格式不正确。'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function sendFile(res, source, contentType) {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(source);
}

/** One long-lived SSE response. A dead socket is dropped by the write itself. */
function createStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  return {
    send(event, data) {
      if (res.writableEnded) return false;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { return false; }
      return true;
    },
    close() { try { res.end(); } catch { /* already gone */ } },
    get closed() { return res.writableEnded || res.destroyed; },
  };
}

function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(at => now - at < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 512) {
      for (const [existing, times] of hits) {
        if (!times.some(at => now - at < windowMs)) hits.delete(existing);
      }
    }
    return true;
  };
}

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

/**
 * Every address a phone could reach this app on, most likely first.
 *
 * Ordered by how often it is the right one: a home router hands out 192.168.x, an office
 * usually 10.x, a container or hotspot 172.16-31. Link-local (169.254) is never useful.
 */
export function lanUrls(port, interfaces = networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${entry.family}`;
      if (family !== 'IPv4' || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      found.push({ name, address: entry.address, private: isPrivateIPv4(entry.address) });
    }
  }
  const rank = item => (item.address.startsWith('192.168.') ? 0 : item.address.startsWith('10.') ? 1 : item.private ? 2 : 3);
  found.sort((left, right) => rank(left) - rank(right) || left.address.localeCompare(right.address));
  return found.map(item => `http://${item.address}:${port}`);
}

/**
 * @param {object} options
 * @param {string} options.origin      loopback origin of this app, e.g. http://127.0.0.1:4318
 * @param {object} options.harness     app.locals.harness
 * @param {string} options.dataDir     where the local audit trail is appended
 * @param {object|(() => object)} options.config
 * @param {(device: {deviceId: string, token: string, transport: string}) => Promise<void>} [options.onPaired]
 */
export function createDirectHost({
  origin,
  harness,
  dataDir,
  config,
  onPaired,
  log = () => {},
  fetchImpl = globalThis.fetch,
  assetsDir = ASSET_DIR,
  pollMs = 1_500,
  host = '0.0.0.0',
}) {
  if (!harness) throw new Error('直连缺少本机服务引用。');
  // Read through a function: the settings page edits the config while the link is up, and a
  // frozen snapshot is how "允许派发" silently stops working until the next restart.
  const readConfig = typeof config === 'function' ? config : () => config;
  const plane = createControlPlane({
    harness,
    origin,
    dataDir,
    fetchImpl,
    dispatchEnabled: () => readConfig()?.dispatchEnabled === true,
  });
  const guard = new ReplayGuard();
  const devices = new Map(); // deviceId -> { token, transport, key, stream, latest }
  const limitPair = rateLimiter({ limit: 5, windowMs: 10 * 60_000 });
  const limitInvoke = rateLimiter({ limit: 60, windowMs: 60_000 });
  const staticFiles = new Map();
  let server = null;
  let port = 0;
  let poller = null;
  let lastSnapshot = '';
  const status = { state: 'offline', error: '', urls: [], devices: 0 };

  /** Plaintext is for a trusted Wi-Fi; the user can turn it off and require HTTPS everywhere. */
  const plainAllowed = () => readConfig()?.allowPlainLan !== false;

  function staticRoute(route) {
    if (route === '/') return [path.join(assetsDir, 'phone.html'), 'text/html; charset=utf-8'];
    if (route === '/phone/relay-protocol.mjs') return [path.join(HERE, '..', 'shared', 'relay-protocol.mjs'), 'text/javascript; charset=utf-8'];
    if (route === '/phone/device-store.mjs') return [path.join(assetsDir, 'device-store.mjs'), 'text/javascript; charset=utf-8'];
    if (route === '/sw.js') return [path.join(assetsDir, 'sw.js'), 'text/javascript; charset=utf-8'];
    return null;
  }

  async function readAsset(route) {
    const entry = staticRoute(route);
    if (!entry) return null;
    const [file, type] = entry;
    if (!staticFiles.has(file)) staticFiles.set(file, await readFile(file, 'utf8'));
    return { source: staticFiles.get(file), type };
  }

  async function sealFor(device, type, payload) {
    return device.transport === 'plain' ? sealPlain(type, payload) : seal(device.key, type, payload);
  }

  /** One envelope onto the live stream, if there is one. Never queues. */
  function sendEnvelope(device, envelope) {
    const stream = device.stream;
    if (!stream || stream.closed) return false;
    if (!stream.send('message', { envelope })) { device.stream = null; return false; }
    return true;
  }

  /**
   * Keep one reply for the moment the phone is listening again.
   *
   * What waits in the queue is the *message* (type + payload), not a sealed envelope. The page
   * re-detects its transport on every load — sealed over https, plaintext on a LAN `http://`
   * address — so a frame sealed under the transport of an earlier connection is unreadable on the
   * next one. That mismatch is exactly how a phone that paired over the tunnel ended up with an
   * empty session list. Re-sealing at send time makes the framing follow the connection the reply
   * actually travels on.
   */
  function enqueueReply(device, type, payload) {
    const outbox = device.outbox;
    if (!Array.isArray(outbox)) return;
    outbox.push({ type, payload });
    while (outbox.length > MAX_OUTBOX) {
      outbox.shift();
      log(`direct outbox full (${MAX_OUTBOX}), dropped the oldest queued reply`);
    }
  }

  /**
   * Hand one reply to the phone: at once when the stream is up, otherwise into the outbox.
   *
   * The page cannot await a socket it is still opening, so its first `sessions.list` normally
   * arrives before `/phone/stream` is connected. "No stream yet" is therefore a normal state and
   * has to mean "wait", never "drop" — dropping the first reply is what left the session tab
   * empty until a revoke forced the page to reconnect.
   */
  async function deliver(device, type, payload) {
    const stream = device.stream;
    if (stream && !stream.closed) {
      try {
        if (sendEnvelope(device, await sealFor(device, type, payload))) return true;
      } catch (error) { log('direct reply seal failed', error); }
    }
    enqueueReply(device, type, payload);
    return false;
  }

  /**
   * Replay everything that was produced while the phone was away, oldest first.
   *
   * Each frame is sealed now, for the transport this connection just declared, so a phone that
   * moved from the tunnel to the LAN gets frames it can actually open. A write that fails (the
   * socket died mid-replay) leaves the rest queued, still ahead of anything produced during the
   * flush, so the next connection resumes the same order instead of scrambling it.
   */
  async function flushOutbox(device) {
    const outbox = device.outbox;
    if (!Array.isArray(outbox) || !outbox.length) return 0;
    const queued = outbox.splice(0, outbox.length);
    let sent = 0;
    for (let index = 0; index < queued.length; index += 1) {
      const item = queued[index];
      let envelope;
      try { envelope = await sealFor(device, item.type, item.payload); }
      catch (error) { log('direct queued reply unsealable', error); continue; }
      if (!sendEnvelope(device, envelope)) {
        outbox.unshift(...queued.slice(index));
        break;
      }
      sent += 1;
    }
    return sent;
  }

  /** One snapshot for everybody: sealed per device, and only when it actually changed. */
  async function pushSnapshot({ force = false, only = null } = {}) {
    if (!only && !devices.size) return;
    let snapshot;
    try { snapshot = plane.snapshot(); }
    catch (error) { log('direct snapshot failed', error); return; }
    const fingerprint = JSON.stringify(snapshot);
    if (!force && !only && fingerprint === lastSnapshot) return;
    if (!only) lastSnapshot = fingerprint;
    for (const device of only ? [only] : devices.values()) {
      try {
        const envelope = await sealFor(device, 'pending.snapshot', snapshot);
        // A snapshot is a whole state, not a step in a sequence: the newest one replaces every
        // older one. So a snapshot produced while the phone is away waits in `latest` (replayed
        // when the stream opens) instead of filling the reply queue with states nobody will read.
        device.latest = envelope;
        sendEnvelope(device, envelope);
      } catch (error) { log('direct push failed', error); }
    }
  }

  async function pair(req, res, ip) {
    if (!limitPair(ip)) return send(res, 429, { error: '配对尝试过于频繁。' });
    const secret = readConfig()?.pairSecret;
    if (!secret) return send(res, 503, { error: '这台电脑还没有生成配对密钥。' });
    const body = await readJson(req);
    const offered = typeof body.codeHash === 'string' ? body.codeHash.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(offered) || !sameText(offered, hashSecret(secret))) {
      return send(res, 401, { error: '配对码不正确。' });
    }
    if (devices.size >= MAX_DEVICES) return send(res, 429, { error: '已配对的设备过多，请先在电脑上撤销。' });
    const deviceId = randomUUID().toLowerCase();
    const token = randomSecret(32);
    const transport = body.transport === 'plain' && plainAllowed() ? 'plain' : 'sealed';
    const device = {
      token, transport, key: await deriveDeviceKey(secret, deviceId), stream: null, latest: null, outbox: [],
    };
    devices.set(deviceId, device);
    status.devices = devices.size;
    if (typeof onPaired === 'function') {
      try { await onPaired({ deviceId, token, transport }); }
      catch (error) { log('direct persist failed', error); }
    }
    await pushSnapshot({ force: true, only: device });
    log(`paired ${deviceId} (${transport})`);
    return send(res, 201, { deviceId, token, transport });
  }

  /** The one place a device is authenticated: id + token, compared without timing leaks. */
  function authenticate(body, headers) {
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
    const token = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!UUID.test(deviceId)) return null;
    const device = devices.get(deviceId);
    if (!device || !TOKEN_SHAPE.test(token) || !sameText(device.token, token)) return null;
    return { deviceId, device };
  }

  async function invoke(req, res) {
    const body = await readJson(req);
    const auth = authenticate(body, req.headers);
    if (!auth) return send(res, 401, { error: '设备令牌不正确，请重新扫码配对。' });
    if (!limitInvoke(auth.deviceId)) return send(res, 429, { error: '操作过于频繁。' });
    const envelope = body.envelope;
    if (!envelope || typeof envelope !== 'object' || JSON.stringify(envelope).length > MAX_ENVELOPE) {
      return send(res, 400, { error: '中继消息不符合格式。' });
    }
    const { device } = auth;
    let message;
    try {
      if (isPlainEnvelope(envelope)) {
        // A phone on `http://` has no WebCrypto; the host says so via /healthz, and the token
        // checked above is then the credential. Sealing stays the default everywhere else.
        if (!plainAllowed()) throw new Error('这台电脑不允许局域网明文直连。');
        message = openPlain(envelope);
      } else {
        message = await open(device.key, envelope);
      }
    } catch (error) {
      log('direct invoke rejected', error);
      return send(res, 400, { error: error?.message ?? '中继消息无法验证。' });
    }
    // Framing follows the request, not the pairing record: the page re-detects its transport on
    // every load (https → sealed, LAN http → plain), while relay-config.json only remembers how
    // this phone paired the first time. Answering a plaintext request with a sealed frame is how
    // a LAN phone ended up with an empty session list — it has no WebCrypto to open one.
    const framing = isPlainEnvelope(envelope) ? 'plain' : 'sealed';
    if (!guard.accept(message.id, message.ts)) return send(res, 409, { error: '重复或过期的中继消息。' });
    if (body.replyMode === 'http') {
      // HTTP RPC must not depend on a persistent stream (Quick Tunnels do not support SSE).
      // Capture framing from this request, never from mutable per-device connection state.
      const sealReply = payload => framing === 'plain'
        ? sealPlain('result', payload)
        : seal(device.key, 'result', payload);
      let reply;
      try {
        const data = await plane.execute({
          action: message.payload.action,
          params: message.payload.params,
          deviceId: auth.deviceId,
        });
        reply = await sealReply({ replyTo: message.id, ok: true, data });
      } catch (error) {
        reply = await sealReply({ replyTo: message.id, ok: false, message: error?.message ?? '远程操作失败。' });
      }
      return send(res, 200, { envelope: reply });
    }
    // A frame sealed under the previous transport cannot be opened under this one, so the stored
    // snapshot goes with it; the forced push at the end of this request writes a fresh one.
    if (framing !== device.transport) device.latest = null;
    device.transport = framing;
    send(res, 202, { accepted: true });
    // Answered after the HTTP hop: a slow approval must not hold the phone's request open.
    void (async () => {
      const reply = { replyTo: message.id };
      try {
        const data = await plane.execute({
          action: message.payload.action,
          params: message.payload.params,
          deviceId: auth.deviceId,
        });
        await deliver(device, 'result', { ...reply, ok: true, data });
      } catch (error) {
        const reason = typeof error?.message === 'string' ? error.message : '远程操作失败。';
        try { await deliver(device, 'result', { ...reply, ok: false, message: reason }); }
        catch (fault) { log('direct reply failed', fault); }
      }
      await pushSnapshot({ force: true, only: device });
    })();
    return undefined;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://harness.local');
    const route = url.pathname;
    const ip = req.socket.remoteAddress ?? 'unknown';
    // Path only: a device token is a credential and must never reach an access log.
    log(`${req.method} ${route}`);
    try {
      if (route === '/healthz' && req.method === 'GET') {
        // What the phone page reads to decide between the sealed and the plaintext transport.
        return send(res, 200, {
          ok: true,
          mode: 'direct',
          rpcVersion: 1,
          plainText: plainAllowed(),
          devices: devices.size,
          serverTime: new Date().toISOString(),
        });
      }

      if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }

      if (req.method === 'GET') {
        const file = await readAsset(route);
        if (file) return sendFile(res, file.source, file.type);
      }

      if (route === '/pair' && req.method === 'POST') return await pair(req, res, ip);

      if (route === '/phone/stream' && req.method === 'GET') {
        const deviceId = (url.searchParams.get('deviceId') ?? '').toLowerCase();
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const device = UUID.test(deviceId) ? devices.get(deviceId) : null;
        if (!device || !TOKEN_SHAPE.test(token) || !sameText(device.token, token)) {
          return send(res, 401, { error: '设备令牌不正确，请重新扫码配对。' });
        }
        // The page says which framing it can read. A phone that paired over the tunnel and now
        // opens the LAN address must not keep receiving sealed frames it cannot open.
        const asked = url.searchParams.get('transport');
        if (!plainAllowed() && (asked === 'plain' || (asked !== 'sealed' && device.transport === 'plain'))) {
          return send(res, 403, { error: '这台电脑不允许局域网明文直连。' });
        }
        const wanted = asked === 'sealed' ? 'sealed' : asked === 'plain' && plainAllowed() ? 'plain' : '';
        if (wanted && wanted !== device.transport) {
          device.transport = wanted;
          device.latest = null;
        }
        const stream = createStream(res);
        device.stream?.close();
        device.stream = stream;
        stream.send('hello', { deviceId, serverTime: new Date().toISOString() });
        if (device.latest) stream.send('message', { envelope: device.latest });
        const ping = setInterval(() => { if (!stream.send('ping', { at: Date.now() })) stream.close(); }, PING_MS);
        ping.unref?.();
        res.on('close', () => { clearInterval(ping); if (device.stream === stream) device.stream = null; });
        // Replies produced before this socket existed leave the queue now, in order and sealed for
        // the framing just declared; the fresh snapshot follows them, so the page sees the state
        // that already includes them.
        void (async () => {
          try {
            await flushOutbox(device);
            // A connection that died mid-replay puts the remainder back in the queue. If this one
            // is still the live stream, drain it now rather than wait for a reconnect that a page
            // sitting on an open socket will never make.
            if (device.stream === stream && device.outbox.length) await flushOutbox(device);
          } catch (error) { log('direct outbox flush failed', error); }
          await pushSnapshot({ force: true, only: device });
        })();
        return undefined;
      }

      if (route === '/phone/invoke' && req.method === 'POST') return await invoke(req, res);

      if (route === '/push/key' || route === '/phone/subscribe' || route === '/phone/unsubscribe') {
        // An honest refusal rather than a silent failure: there is no push service behind a
        // LAN socket, and a Cloudflare quick tunnel address changes too often to bind one to.
        return send(res, 501, {
          error: '直连模式没有后台推送。需要锁屏通知时，请改用「自建中继（VPS）」模式。',
        });
      }

      return send(res, 404, { error: '没有这个接口。' });
    } catch (error) {
      const state = error?.status ?? 500;
      if (state === 500) log(`error ${route}: ${error?.message}`);
      try { send(res, state, { error: state === 500 ? '直连处理失败。' : error.message }); } catch { /* socket gone */ }
      return undefined;
    }
  }

  /** Rebuild the device table from the config: a restart must not force every phone to re-pair. */
  async function loadDevices() {
    devices.clear();
    const current = readConfig() ?? {};
    const secret = current.pairSecret;
    if (!secret) return;
    for (const entry of Array.isArray(current.devices) ? current.devices : []) {
      const normalizedId = typeof entry?.deviceId === 'string' ? entry.deviceId.toLowerCase() : '';
      if (!isId(normalizedId) || !TOKEN_SHAPE.test(String(entry?.token ?? ''))) continue;
      try {
        devices.set(normalizedId, {
          token: entry.token,
          transport: entry.transport === 'plain' ? 'plain' : 'sealed',
          key: await deriveDeviceKey(secret, normalizedId),
          stream: null,
          latest: null,
          outbox: [],
        });
      } catch (error) { log('direct device key failed', error); }
    }
    status.devices = devices.size;
  }

  return {
    async start({ listenPort = readConfig()?.directPort ?? DEFAULT_PORT } = {}) {
      if (server) return this.status();
      await loadDevices();
      server = createServer((req, res) => { void handle(req, res); });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(listenPort, host, () => resolve());
        });
      } catch (error) {
        server = null;
        status.state = 'error';
        status.error = error?.code === 'EADDRINUSE'
          ? `端口 ${listenPort} 已被占用，请换一个端口。`
          : (error?.code === 'EACCES' ? `没有权限监听端口 ${listenPort}。` : (error?.message ?? '直连启动失败。'));
        throw new Error(status.error);
      }
      port = server.address().port;
      status.state = 'listening';
      status.error = '';
      status.urls = lanUrls(port);
      poller = setInterval(() => { void pushSnapshot(); }, pollMs);
      poller.unref?.();
      return this.status();
    },

    async stop() {
      clearInterval(poller);
      poller = null;
      for (const device of devices.values()) {
        device.stream?.close();
        device.stream = null;
        device.latest = null;
        // A stopped host has no phone to hand these to, and the next start rebuilds from config.
        if (Array.isArray(device.outbox)) device.outbox.length = 0;
      }
      devices.clear();
      lastSnapshot = '';
      status.devices = 0;
      const running = server;
      server = null;
      port = 0;
      status.urls = [];
      status.state = 'offline';
      if (!running) return this.status();
      await new Promise(resolve => { running.close(() => resolve()); running.closeAllConnections?.(); });
      return this.status();
    },

    status() {
      return { ...status, urls: [...status.urls], port, enabled: readConfig()?.enabled === true };
    },

    /** Immediate, like the relay: the key disappears, so the next frame is unopenable. */
    revoke(deviceId) {
      const key = typeof deviceId === 'string' ? deviceId.toLowerCase() : '';
      const device = devices.get(key);
      if (!device) return false;
      // Nothing queued for a revoked phone may survive: the token is gone, so all an outbox could
      // still do is leak replies from the old pairing to whoever holds the id next.
      if (Array.isArray(device.outbox)) device.outbox.length = 0;
      device.latest = null;
      device.stream?.close();
      devices.delete(key);
      status.devices = devices.size;
      return true;
    },

    /** Used by the settings page for the addresses, and by the tunnel to learn the port. */
    describe() {
      return {
        port,
        urls: [...status.urls],
        devices: [...devices.keys()],
        plainText: plainAllowed(),
        dispatchEnabled: readConfig()?.dispatchEnabled === true,
      };
    },

    /** Test hook: how many replies are still waiting for each phone (counts, never content). */
    outboxDepths: () => Object.fromEntries(
      [...devices].map(([deviceId, device]) => [deviceId, Array.isArray(device.outbox) ? device.outbox.length : 0]),
    ),

    /** Callback route for the tests: force a push without waiting for the poll timer. */
    flush: () => pushSnapshot({ force: true }),
  };
}
