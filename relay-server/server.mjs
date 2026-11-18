// Harness remote relay for a VPS.
//
// A dumb pipe and nothing else:
//   * it never decrypts a payload, so it cannot read an approval, a command or a title;
//   * it keeps no database and writes no file, so a stolen disk contains nothing;
//   * it routes by deviceId only, and refuses every message it cannot attribute.
//
// The pairing secret never reaches this process: the desktop registers a SHA-256 of it, and a
// phone proves knowledge by sending the same hash. A compromised relay therefore learns one
// hash per pairing, not a key.
//
// Run: RELAY_TOKEN=... PAIR_CODE_HASH=... [TRUST_PROXY=1] node server.mjs
// TLS is terminated in front of this process (see Caddyfile.example).

import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVapidKeyPair, parseSubscription, sendPush, validateVapidKeys } from './push.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_ENVELOPE = 12 * 1024;
/** A push service need not accept more than 4 KiB; the sealed hint is far smaller. */
const MAX_PUSH = 3 * 1024;
const MAX_DEVICES = 8;
const PING_MS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hashSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function normalizeDeviceId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extractDeviceId(entry) {
  const raw = typeof entry === 'string'
    ? entry
    : (typeof entry?.deviceId === 'string' ? entry.deviceId : entry?.id);
  return normalizeDeviceId(raw);
}

function validPortText(text) {
  if (!/^\d{1,5}$/.test(text)) return false;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Normalises a raw IP string (socket remoteAddress, X-Forwarded-For hop, or X-Real-IP):
 * strips brackets, `:port`, IPv6 `%zone`, and `::ffff:` IPv4-mapped prefixes, and canonicalises
 * IPv6 representation so equivalent notations share one rate-limit bucket.
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return '';
    const rest = text.slice(close + 1);
    if (rest && (!rest.startsWith(':') || !validPortText(rest.slice(1)))) return '';
    text = text.slice(1, close);
  } else {
    const colon = text.lastIndexOf(':');
    if (colon > 0 && text.indexOf(':') === colon) {
      const hostPart = text.slice(0, colon);
      const portPart = text.slice(colon + 1);
      if (validPortText(portPart) && isIP(hostPart) === 4) {
        text = hostPart;
      }
    }
  }
  const zone = text.indexOf('%');
  if (zone > 0) text = text.slice(0, zone);
  if (/^::ffff:/i.test(text)) {
    const v4 = text.slice(7);
    if (isIP(v4) === 4) return v4;
  }
  const version = isIP(text);
  if (version === 4) return text;
  if (version === 6) {
    try {
      const canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1).toLowerCase();
      if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(canonical)) {
        const words = canonical.slice(7).split(':').map(part => parseInt(part, 16));
        return `${(words[0] >> 8) & 0xff}.${words[0] & 0xff}.${(words[1] >> 8) & 0xff}.${words[1] & 0xff}`;
      }
      return canonical;
    } catch {
      return text.toLowerCase();
    }
  }
  return '';
}

function ipv4ToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    value = ((value << 8) | byte) >>> 0;
  }
  return value;
}

export function isLoopbackIp(ip) {
  if (!ip) return false;
  if (ip === '::1') return true;
  return isIP(ip) === 4 && ip.startsWith('127.');
}

export function isLocalOrPrivateIp(ip) {
  if (isLoopbackIp(ip)) return true;
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }
  if (version === 6) {
    if (/^f[cd][0-9a-f]{0,2}:/i.test(ip)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]?:/i.test(ip)) return true; // fe80::/10 link-local
  }
  return false;
}

function buildCidrMatcher(token) {
  const slash = token.indexOf('/');
  if (slash <= 0) return null;
  const baseIp = normalizeIp(token.slice(0, slash));
  const prefixText = token.slice(slash + 1).trim();
  if (!baseIp || !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (isIP(baseIp) === 4 && prefix >= 0 && prefix <= 32) {
    const baseNum = ipv4ToUint32(baseIp);
    if (baseNum === null) return null;
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
    const network = (baseNum & mask) >>> 0;
    return candidate => {
      if (isIP(candidate) !== 4) return false;
      const num = ipv4ToUint32(candidate);
      return num !== null && ((num & mask) >>> 0) === network;
    };
  }
  return null;
}

/**
 * Compiles a `TRUST_PROXY` setting into an immutable policy object.
 * Default is disabled (`off`) so direct-to-internet deployments ignore spoofed headers.
 * Supported values:
 *   - false / 0 / "" / "false" / "0" / "off" / "no" -> disabled
 *   - "loopback" -> trust loopback reverse proxies (127.0.0.0/8, ::1)
 *   - true / "true" / "yes" / "on" / "private" / "uniquelocal" -> trust loopback & private proxies
 *   - positive integer N (e.g. 1, "1", 2, "2") -> require local/private direct proxy and walk N hops right-to-left
 *   - comma-separated proxy IPs / IPv4 CIDRs / keywords ("127.0.0.1, ::1, 10.0.0.2")
 */
export function parseTrustProxy(spec) {
  if (spec && typeof spec === 'object' && spec.__compiledTrustProxy === true) return spec;
  if (spec === undefined || spec === null || spec === false || spec === 0) {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'off', hops: 0, isTrusted: () => false });
  }
  if (spec === true) {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'trusted', hops: 0, isTrusted: isLocalOrPrivateIp });
  }
  if (typeof spec === 'number') {
    if (Number.isInteger(spec) && spec > 0) {
      return Object.freeze({ __compiledTrustProxy: true, mode: 'hops', hops: spec, isTrusted: isLocalOrPrivateIp });
    }
    return Object.freeze({ __compiledTrustProxy: true, mode: 'off', hops: 0, isTrusted: () => false });
  }
  const raw = Array.isArray(spec) ? spec.join(',') : String(spec).trim();
  const lower = raw.toLowerCase();
  if (!lower || ['0', 'false', 'off', 'no', 'none'].includes(lower)) {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'off', hops: 0, isTrusted: () => false });
  }
  if (['true', 'yes', 'on', 'private', 'uniquelocal'].includes(lower)) {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'trusted', hops: 0, isTrusted: isLocalOrPrivateIp });
  }
  if (lower === 'loopback') {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'trusted', hops: 0, isTrusted: isLoopbackIp });
  }
  if (/^\d+$/.test(lower)) {
    const hops = Number(lower);
    if (Number.isInteger(hops) && hops > 0) {
      return Object.freeze({ __compiledTrustProxy: true, mode: 'hops', hops, isTrusted: isLocalOrPrivateIp });
    }
    return Object.freeze({ __compiledTrustProxy: true, mode: 'off', hops: 0, isTrusted: () => false });
  }
  const matchers = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const tokenLower = token.toLowerCase();
    if (tokenLower === 'loopback') { matchers.push(isLoopbackIp); continue; }
    if (tokenLower === 'private' || tokenLower === 'uniquelocal') { matchers.push(isLocalOrPrivateIp); continue; }
    const cidr = buildCidrMatcher(token);
    if (cidr) { matchers.push(cidr); continue; }
    const exact = normalizeIp(token);
    if (exact) matchers.push(candidate => candidate === exact);
  }
  if (!matchers.length) {
    return Object.freeze({ __compiledTrustProxy: true, mode: 'off', hops: 0, isTrusted: () => false });
  }
  return Object.freeze({
    __compiledTrustProxy: true,
    mode: 'trusted',
    hops: 0,
    isTrusted: ip => matchers.some(fn => fn(ip)),
  });
}

/**
 * Extracts the normalized client IP for rate limiting.
 * Only inspects `X-Forwarded-For` (right-to-left) and `X-Real-IP` when `TRUST_PROXY` is enabled
 * AND the direct peer socket (`req.socket.remoteAddress`) is a trusted reverse proxy.
 */
export function getClientIp(req, trustProxy = process.env.TRUST_PROXY ?? '') {
  const policy = parseTrustProxy(trustProxy);
  const remoteIp = normalizeIp(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '');
  if (policy.mode === 'off' || !remoteIp || !policy.isTrusted(remoteIp)) {
    return remoteIp || 'unknown';
  }

  const rawXff = req?.headers?.['x-forwarded-for'];
  const xffText = Array.isArray(rawXff) ? rawXff.join(',') : (typeof rawXff === 'string' ? rawXff : '');
  if (xffText.trim()) {
    const parts = xffText.split(',');
    if (policy.mode === 'hops') {
      let chosen = '';
      const maxSteps = Math.min(policy.hops, parts.length);
      for (let step = 1; step <= maxSteps; step += 1) {
        const candidate = normalizeIp(parts[parts.length - step]);
        if (!candidate) break;
        chosen = candidate;
      }
      if (chosen) return chosen;
    } else {
      let fallbackTrusted = '';
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const candidate = normalizeIp(parts[index]);
        if (!candidate) break;
        if (!policy.isTrusted(candidate)) return candidate;
        fallbackTrusted = candidate;
      }
      if (fallbackTrusted) return fallbackTrusted;
    }
  }

  const rawReal = req?.headers?.['x-real-ip'];
  const realText = Array.isArray(rawReal) ? rawReal[rawReal.length - 1] : rawReal;
  const realIp = normalizeIp(realText);
  if (realIp) return realIp;

  return remoteIp || 'unknown';
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
  });
  res.end(text);
}

/** One long-lived SSE response. Dead sockets are dropped by the write itself. */
function createStream(res, writeHead = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...writeHead,
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

export function startRelay({
  port = 8790,
  host = '127.0.0.1',
  relayToken = process.env.RELAY_TOKEN ?? '',
  pairCodeHash = process.env.PAIR_CODE_HASH ?? '',
  trustProxy = process.env.TRUST_PROXY ?? '',
  sharedDir = path.join(HERE, '..', 'app', 'shared'),
  vapid: vapidKeys = null,
  vapidSubject = '',
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  if (!relayToken) throw new Error('缺少 RELAY_TOKEN。');
  const proxyPolicy = parseTrustProxy(trustProxy);
  const devices = new Map(); // deviceId (lowercase) -> { token, pairedAt, ackedByDesktop, stream?, subscription? }
  const knownDevices = new Set(); // deviceIds declared by desktop allowlist (occupy MAX_DEVICES slots)
  const latest = new Map();  // deviceId (lowercase) -> last sealed envelope
  let desktop = null;
  let codeHash = typeof pairCodeHash === 'string' ? pairCodeHash.trim().toLowerCase() : '';
  const limitPair = rateLimiter({ limit: 5, windowMs: 10 * 60_000 });
  const limitInvoke = rateLimiter({ limit: 60, windowMs: 60_000 });
  const limitPush = rateLimiter({ limit: 120, windowMs: 60_000 });

  function pairedSlotCount() {
    if (!knownDevices.size) return devices.size;
    const union = new Set(devices.keys());
    for (const id of knownDevices) union.add(id);
    return union.size;
  }

  function dropDevice(rawDeviceId) {
    const id = extractDeviceId(rawDeviceId);
    if (!UUID.test(id)) return false;
    const hadKnown = knownDevices.delete(id);
    const existing = devices.get(id);
    latest.delete(id);
    if (!existing) return hadKnown;
    existing.stream?.close();
    devices.delete(id);
    return true;
  }

  function clearAllDevices() {
    const allIds = new Set([...devices.keys(), ...knownDevices]);
    for (const entry of devices.values()) {
      entry.stream?.close();
    }
    devices.clear();
    knownDevices.clear();
    latest.clear();
    return allIds.size;
  }

  // VAPID identifies this relay to a push service, and every existing subscription is bound to
  // the public half: replacing it silently would break phones that are working today. So an
  // operator supplies the pair; the generated fallback exists only for a first run and says so.
  let vapid = vapidKeys;
  if (!vapid) {
    const fromEnv = {
      publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
      privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    };
    if (fromEnv.publicKey && fromEnv.privateKey) vapid = validateVapidKeys(fromEnv);
    else {
      vapid = createVapidKeyPair();
      log('未设置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY：本次临时生成，重启后手机需要重新开启通知。');
    }
  } else {
    validateVapidKeys(vapid);
  }
  const pushSubject = vapidSubject || process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay'}`);
    const route = url.pathname;
    const ip = getClientIp(req, proxyPolicy);
    // Path only: a pairing code or a device token must never land in an access log.
    log(`${req.method} ${route}`);

    try {
      if (route === '/healthz') {
        return send(res, 200, { ok: true, desktop: Boolean(desktop && !desktop.closed), devices: devices.size });
      }

      if (route === '/' && req.method === 'GET') {
        const page = await readFile(path.join(HERE, 'phone.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }

      // The phone page imports the very same protocol module the desktop uses, so the two can
      // never drift apart on sealing, replay or size rules.
      if (route === '/phone/relay-protocol.mjs' && req.method === 'GET') {
        const source = await readFile(path.join(sharedDir, 'relay-protocol.mjs'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(source);
      }

      // The service worker and the IndexedDB helper are served from this process so the phone
      // needs no build step and no second host.
      if ((route === '/sw.js' || route === '/phone/device-store.mjs') && req.method === 'GET') {
        const name = route === '/sw.js' ? 'sw.js' : 'device-store.mjs';
        const source = await readFile(path.join(HERE, name), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(source);
      }

      if (route === '/pair' && req.method === 'POST') {
        if (!limitPair(ip)) return send(res, 429, { error: '配对尝试过于频繁。' });
        if (!codeHash) return send(res, 503, { error: '这台中继还没有登记配对码。' });
        const body = await readJson(req);
        const offered = typeof body.codeHash === 'string' ? body.codeHash.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(offered) || !sameSecret(offered, codeHash)) {
          return send(res, 401, { error: '配对码不正确。' });
        }
        if (pairedSlotCount() >= MAX_DEVICES) return send(res, 429, { error: '已配对的设备过多，请先在电脑上撤销。' });
        const deviceId = randomUUID().toLowerCase();
        const token = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
        devices.set(deviceId, { token, pairedAt: new Date().toISOString(), ackedByDesktop: false });
        if (desktop && !desktop.closed) desktop.send('paired', { deviceId });
        knownDevices.add(deviceId);
        log(`paired ${deviceId}`);
        return send(res, 201, { deviceId, token });
      }

      if (route === '/harness/register' && req.method === 'POST') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        const body = await readJson(req);
        const offered = typeof body.codeHash === 'string' ? body.codeHash.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(offered)) return send(res, 400, { error: '配对码哈希格式不正确。' });
        // Secret rotation or explicit clear wipes all devices; an explicit `devices` allowlist
        // drops stale entries removed while offline while keeping valid active phones intact;
        // `revokedDevices` removes specific offline-revoked IDs (compatible alongside `devices`).
        const rotated = Boolean(codeHash && !sameSecret(offered, codeHash));
        const clearAll = body.clearDevices === true || body.rotate === true;
        let removed = 0;
        if (rotated || clearAll) {
          removed = clearAllDevices();
        } else {
          if (Array.isArray(body.devices)) {
            const allowlist = new Set();
            for (const entry of body.devices) {
              const id = extractDeviceId(entry);
              if (UUID.test(id) && allowlist.size < MAX_DEVICES) allowlist.add(id);
            }
            for (const id of allowlist) {
              const existing = devices.get(id);
              if (existing) existing.ackedByDesktop = true;
            }
            const preserveUnacked = body.preserveUnacked === true;
            let keptCount = allowlist.size;
            for (const existingId of new Set([...devices.keys(), ...knownDevices])) {
              if (allowlist.has(existingId)) continue;
              const liveEntry = devices.get(existingId);
              if (preserveUnacked && liveEntry && !liveEntry.ackedByDesktop && keptCount < MAX_DEVICES) {
                keptCount += 1;
                continue;
              }
              if (dropDevice(existingId)) removed += 1;
            }
            knownDevices.clear();
            for (const id of allowlist) knownDevices.add(id);
            for (const id of devices.keys()) {
              if (knownDevices.size < MAX_DEVICES) knownDevices.add(id);
            }
          }
          if (Array.isArray(body.revokedDevices)) {
            for (const entry of body.revokedDevices) {
              if (dropDevice(entry)) removed += 1;
            }
          }
        }
        codeHash = offered;
        return send(res, 200, { ok: true, rotated, removed, devices: devices.size, pairedSlots: pairedSlotCount() });
      }

      if (route === '/harness/stream' && req.method === 'GET') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        const stream = createStream(res);
        if (desktop && !desktop.closed) desktop.close(); // one desk, one link: a newer launch wins
        desktop = stream;
        stream.send('hello', { serverTime: new Date().toISOString() });
        for (const [deviceId, entry] of devices) {
          if (!entry.ackedByDesktop) stream.send('paired', { deviceId });
        }
        const ping = setInterval(() => { if (!stream.send('ping', { at: Date.now() })) stream.close(); }, PING_MS);
        ping.unref?.();
        req.on('close', () => { clearInterval(ping); if (desktop === stream) desktop = null; });
        return undefined;
      }

      if (route === '/harness/revoke' && req.method === 'POST') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        const body = await readJson(req);
        if (body.all === true) {
          const removed = clearAllDevices();
          return send(res, 200, { ok: true, removed, devices: devices.size });
        }
        if (Array.isArray(body.deviceIds)) {
          let removed = 0;
          for (const rawId of body.deviceIds) {
            const id = extractDeviceId(rawId);
            if (!UUID.test(id)) return send(res, 400, { error: '设备编号不正确。' });
            if (dropDevice(id)) removed += 1;
          }
          return send(res, 200, { ok: true, removed, devices: devices.size });
        }
        const deviceId = extractDeviceId(body.deviceId);
        if (!UUID.test(deviceId)) return send(res, 400, { error: '设备编号不正确。' });
        const removed = dropDevice(deviceId);
        log(`revoked ${deviceId} (removed=${removed})`);
        return send(res, 200, { ok: true, removed, devices: devices.size });
      }

      if (route === '/harness/devices' && req.method === 'DELETE') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        const removed = clearAllDevices();
        return send(res, 200, { ok: true, removed, devices: devices.size });
      }

      if (route.startsWith('/harness/devices/') && req.method === 'DELETE') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        let rawId = '';
        try { rawId = decodeURIComponent(route.slice('/harness/devices/'.length)); }
        catch { return send(res, 400, { error: '设备编号不正确。' }); }
        const deviceId = normalizeDeviceId(rawId);
        if (!UUID.test(deviceId)) return send(res, 400, { error: '设备编号不正确。' });
        const removed = dropDevice(deviceId);
        log(`revoked ${deviceId} (removed=${removed})`);
        return send(res, 200, { ok: true, removed, devices: devices.size });
      }

      if (route === '/harness/push' && req.method === 'POST') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        const body = await readJson(req);
        const deviceId = normalizeDeviceId(body.deviceId);
        const envelope = body.envelope;
        if (!UUID.test(deviceId) || !devices.has(deviceId)) return send(res, 404, { error: '未知设备。' });
        if (!envelope || typeof envelope !== 'object' || JSON.stringify(envelope).length > MAX_ENVELOPE) {
          return send(res, 400, { error: '中继消息不符合格式。' });
        }
        latest.set(deviceId, envelope);
        const phone = devices.get(deviceId).stream;
        phone?.send('message', { envelope });
        return send(res, 202, { delivered: Boolean(phone && !phone.closed) });
      }

      if (route === '/phone/stream' && req.method === 'GET') {
        const deviceId = normalizeDeviceId(url.searchParams.get('deviceId') ?? '');
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const device = UUID.test(deviceId) ? devices.get(deviceId) : undefined;
        if (!device || !sameSecret(device.token, token)) return send(res, 401, { error: '设备令牌不正确。' });
        const stream = createStream(res);
        device.stream?.close();
        device.stream = stream;
        stream.send('hello', { deviceId, serverTime: new Date().toISOString() });
        if (latest.has(deviceId)) stream.send('message', { envelope: latest.get(deviceId) });
        const ping = setInterval(() => { if (!stream.send('ping', { at: Date.now() })) stream.close(); }, PING_MS);
        ping.unref?.();
        req.on('close', () => { clearInterval(ping); if (device.stream === stream) device.stream = null; });
        return undefined;
      }

      if (route === '/phone/invoke' && req.method === 'POST') {
        const body = await readJson(req);
        const deviceId = normalizeDeviceId(body.deviceId);
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const device = UUID.test(deviceId) ? devices.get(deviceId) : undefined;
        if (!device || !sameSecret(device.token, token)) return send(res, 401, { error: '设备令牌不正确。' });
        if (!limitInvoke(deviceId)) return send(res, 429, { error: '操作过于频繁。' });
        const envelope = body.envelope;
        if (!envelope || typeof envelope !== 'object' || JSON.stringify(envelope).length > MAX_ENVELOPE) {
          return send(res, 400, { error: '中继消息不符合格式。' });
        }
        if (!desktop || desktop.closed) return send(res, 503, { error: '电脑不在线。' });
        desktop.send('invoke', { deviceId, envelope });
        return send(res, 202, { accepted: true });
      }

      // The public half of the VAPID pair. Public by definition, and useless without the key.
      if (route === '/push/key' && req.method === 'GET') {
        return send(res, 200, { key: vapid.publicKey, subject: pushSubject });
      }

      if (route === '/phone/subscribe' && req.method === 'POST') {
        const body = await readJson(req);
        const deviceId = normalizeDeviceId(body.deviceId);
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const device = UUID.test(deviceId) ? devices.get(deviceId) : undefined;
        if (!device || !sameSecret(device.token, token)) return send(res, 401, { error: '设备令牌不正确。' });
        let subscription;
        try { subscription = parseSubscription(body.subscription); }
        catch (error) { return send(res, 400, { error: error.message }); }
        // Kept in memory only, like everything else here: a stolen disk holds no subscriptions.
        device.subscription = {
          endpoint: subscription.endpoint,
          keys: { ...body.subscription.keys },
        };
        return send(res, 200, { ok: true, endpoint: new URL(subscription.endpoint).host });
      }

      if (route === '/phone/unsubscribe' && req.method === 'POST') {
        const body = await readJson(req);
        const deviceId = normalizeDeviceId(body.deviceId);
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const device = UUID.test(deviceId) ? devices.get(deviceId) : undefined;
        if (!device || !sameSecret(device.token, token)) return send(res, 401, { error: '设备令牌不正确。' });
        device.subscription = null;
        return send(res, 200, { ok: true });
      }

      if (route === '/harness/notify' && req.method === 'POST') {
        if (!sameSecret(`Bearer ${relayToken}`, req.headers.authorization ?? '')) return send(res, 401, { error: '中继令牌不正确。' });
        if (!limitPush(ip)) return send(res, 429, { error: '通知发送过于频繁。' });
        const body = await readJson(req);
        const deviceId = normalizeDeviceId(body.deviceId);
        const device = UUID.test(deviceId) ? devices.get(deviceId) : undefined;
        if (!device) return send(res, 404, { error: '未知设备。' });
        const envelope = body.envelope;
        // Same shape rule as every other relayed message: if it is not a small object, it is
        // not ours, and it never reaches a push service.
        if (!envelope || typeof envelope !== 'object' || JSON.stringify(envelope).length > MAX_PUSH) {
          return send(res, 400, { error: '通知内容不符合格式。' });
        }
        if (!device.subscription) return send(res, 200, { pushed: false, reason: '未订阅通知。' });
        let result;
        try {
          result = await sendPush({
            subscription: device.subscription,
            plaintext: JSON.stringify(envelope),
            vapid,
            subject: pushSubject,
            fetchImpl,
          });
        } catch (error) {
          log(`push failed: ${error?.message}`);
          return send(res, 200, { pushed: false, reason: '推送服务不可用。' });
        }
        // 404/410 means the browser dropped the subscription; forget it so the next attempt
        // does not waste a round trip, and let the page ask for a new one.
        if (result.gone) {
          device.subscription = null;
          return send(res, 200, { pushed: false, reason: '订阅已失效。' });
        }
        return send(res, 200, {
          pushed: result.ok,
          status: result.status,
          ...(result.ok ? {} : { reason: `推送服务返回 ${result.status}。` }),
        });
      }

      return send(res, 404, { error: '没有这个接口。' });
    } catch (error) {
      const status = error?.status ?? 500;
      send(res, status, { error: status === 500 ? '中继处理失败。' : error.message });
      if (status === 500) log(`error ${route}: ${error?.message}`);
      return undefined;
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        stats: () => ({
          desktop: Boolean(desktop && !desktop.closed),
          devices: devices.size,
          pairedSlots: pairedSlotCount(),
          subscribed: [...devices.values()].filter(device => device.subscription).length,
        }),
        pushKey: () => vapid.publicKey,
        setPairCodeHash: value => {
          const next = typeof value === 'string' ? value.trim().toLowerCase() : '';
          if (codeHash && next && !sameSecret(next, codeHash)) clearAllDevices();
          codeHash = next;
        },
        close: () => new Promise(done => {
          desktop?.close();
          for (const device of devices.values()) device.stream?.close();
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await startRelay({
    port: Number(process.env.PORT ?? 8790),
    host: process.env.HOST ?? '127.0.0.1',
    trustProxy: process.env.TRUST_PROXY ?? '',
    log: line => console.log(`${new Date().toISOString()} ${line}`),
  });
  console.log(`relay listening on ${relay.url}`);
  const stop = async () => { await relay.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
