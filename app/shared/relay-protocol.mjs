// Remote relay protocol.
//
// One file shared by the desktop main process and the phone page: it only uses
// globalThis.crypto.subtle, TextEncoder and TextDecoder, so the exact same code runs in
// Electron and in a browser tab.
//
// Why the payload is sealed here rather than on the VPS: the relay is a dumb pipe. It routes
// by deviceId and never sees an approval, a command, or a title. A compromised VPS can drop or
// delay messages (denial of service, which is unavoidable for any relay) but cannot read them,
// forge an approval, or answer a question on the user's behalf.
//
// Two transports exist because a phone that opens `http://192.168.x.x:port` on the same Wi-Fi
// gets no WebCrypto: not on iOS, not on Android, not on desktop Chrome. In that case the page
// says so and the LAN host accepts a plaintext envelope that carries no ciphertext at all —
// the device token is then the whole credential, so plaintext is only ever used on a network
// the user trusts. Over `https://` (a relay behind Caddy, or a Cloudflare tunnel to the direct
// host) nothing changes: the sealed path below is the one that runs.

export const PROTOCOL_VERSION = 1;

/** The largest plaintext JSON we will agree to send in one message. */
export const MAX_PLAINTEXT_BYTES = 8 * 1024;
/** The largest sealed envelope we will accept, base64 included. */
export const MAX_ENVELOPE_BYTES = 12 * 1024;
/** Envelopes older or newer than this are refused; the phone and the desktop share a clock
 *  only loosely, so five minutes of slack keeps a slightly-off phone usable. */
export const CLOCK_SKEW_MS = 5 * 60_000;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** The only message kinds that may cross the relay. Anything else is a protocol error. */
export const MESSAGE_TYPES = Object.freeze({
  HELLO: 'hello',
  SNAPSHOT: 'pending.snapshot',
  INVOKE: 'invoke',
  RESULT: 'result',
  PING: 'ping',
  // Carried to a sleeping phone as a Web Push payload; the relay forwards it without reading it.
  PUSH_HINT: 'push.hint',
});
export const TYPES = new Set(Object.values(MESSAGE_TYPES));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function isId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A fresh message id.
 *
 * crypto.randomUUID() is a secure-context API: on the LAN address a phone opens
 * (http://192.168…) it is simply undefined, while crypto.getRandomValues is still there.
 * Throwing there is not a cosmetic failure — sealPlain() cannot build an envelope, so the page
 * never sends a single request: no session list, no approvals, no dispatch. The desktop only ever
 * sends server-side, so nothing on this side ever noticed.
 *
 * So: use the platform generator when it exists, and assemble a UUIDv4 by hand when it does not.
 */
export function newId() {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') {
    try { return source.randomUUID(); } catch { /* fall through to the manual path */ }
  }
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function utf8(value) {
  return new TextEncoder().encode(value);
}

export function fromUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256 in plain JavaScript, used only where `crypto.subtle` does not exist.
 *
 * Pairing hashes the pairing code before it leaves the phone, and a phone on `http://192.168…`
 * has no WebCrypto at all — without this fallback the page cannot even ask to be paired. Kept
 * to exactly what the protocol needs: one digest over a small string.
 */
export function sha256Bytes(bytes) {
  const size = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(size);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(size - 8, Math.floor(bits / 4294967296));
  view.setUint32(size - 4, bits >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15];
      const y = w[index - 2];
      const first = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const second = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[index] = (w[index - 16] + first + w[index - 7] + second) >>> 0;
    }
    let a = state[0]; let b = state[1]; let c = state[2]; let d = state[3];
    let e = state[4]; let f = state[5]; let g = state[6]; let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + choose + SHA256_K[index] + w[index]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let index = 0; index < 8; index += 1) out.setUint32(index * 4, state[index]);
  return digest;
}

function hex(bytes) {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** The one hash both pairing flows use; WebCrypto when it exists, the fallback otherwise. */
export async function sha256Hex(value) {
  const bytes = utf8(String(value ?? ''));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return hex(new Uint8Array(digest));
  }
  return hex(sha256Bytes(bytes));
}

/** Text comparison that does not leak length or content through timing. */
export function sameText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a.length || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** base64url without padding: safe inside a JSON field and inside an SSE data line. */
export function toBase64Url(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += index + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '';
    out += index + 2 < bytes.length ? B64[c & 63] : '';
  }
  return out;
}

/** Strict decoder: rejects padding, foreign alphabets and impossible lengths instead of
 *  silently producing a shorter buffer that would then fail authentication anyway. */
export function fromBase64Url(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('中继数据为空。');
  if (text.length % 4 === 1) throw new Error('中继数据长度不正确。');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = B64.indexOf(character);
    if (value < 0) throw new Error('中继数据包含非法字符。');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function randomSecret(bytes = 32) {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** HKDF-SHA256 over the pairing secret, salted with the protocol name and the device id.
 *  Every paired device therefore gets its own key: revoking one device leaves the others
 *  working, and the pairing secret itself never travels as an encryption key. */
export async function deriveDeviceKey(pairSecret, deviceId) {
  if (!isId(deviceId)) throw new Error('设备编号不正确。');
  const material = typeof pairSecret === 'string' ? fromBase64Url(pairSecret) : pairSecret;
  if (!(material instanceof Uint8Array) || material.byteLength < 16) throw new Error('配对密钥不正确。');
  const base = await globalThis.crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('harness-relay-v1'), info: utf8(`device:${deviceId}`) },
    base,
    KEY_BITS,
  );
  return globalThis.crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The header is authenticated as additional data, so a relay cannot retype a message
 *  (say, turn a snapshot into an invoke) without breaking the tag. */
function associatedData(id, ts, type) {
  return utf8(`${PROTOCOL_VERSION}|${id}|${ts}|${type}`);
}

export function envelopeBytes(envelope) {
  return utf8(JSON.stringify(envelope)).byteLength;
}

/** Everything both transports must agree on before a payload is even looked at. */
function checkHeader(envelope, now) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('中继消息格式不正确。');
  if (envelope.v !== PROTOCOL_VERSION) throw new Error('中继消息版本不兼容。');
  if (!isId(envelope.id)) throw new Error('中继消息编号不正确。');
  if (!TYPES.has(envelope.type)) throw new Error('不支持的中继消息类型。');
  if (typeof envelope.ts !== 'string') throw new Error('中继消息缺少时间。');
  const ts = Date.parse(envelope.ts);
  if (!Number.isFinite(ts)) throw new Error('中继消息时间不正确。');
  if (Math.abs(now - ts) > CLOCK_SKEW_MS) throw new Error('中继消息已过期。');
  if (envelopeBytes(envelope) > MAX_ENVELOPE_BYTES) throw new Error('中继消息超过大小上限。');
  return ts;
}

export async function seal(key, type, payload, { now = new Date() } = {}) {
  if (!TYPES.has(type)) throw new Error('不支持的中继消息类型。');
  if (!key || key.usages?.includes('encrypt') !== true) throw new Error('设备密钥不可用。');
  const body = utf8(JSON.stringify(payload ?? {}));
  if (body.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('中继消息超过大小上限。');
  const id = newId();
  const ts = now.toISOString();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(id, ts, type) },
    key,
    body,
  );
  return {
    v: PROTOCOL_VERSION,
    id,
    ts,
    type,
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(sealed)),
  };
}

/**
 * Validates and decrypts one envelope. Returns `{ id, ts, type, payload }`.
 * Every failure throws: a caller must treat a throw as "this message never existed" and must
 * not fall back to a looser parse.
 */
export async function open(key, envelope, { now = Date.now() } = {}) {
  checkHeader(envelope, now);
  if (!key || key.usages?.includes('decrypt') !== true) throw new Error('设备密钥不可用。');
  const iv = fromBase64Url(envelope.iv);
  if (iv.byteLength !== IV_BYTES) throw new Error('中继消息的随机数长度不正确。');
  const ciphertext = fromBase64Url(envelope.ct);
  if (!ciphertext.byteLength) throw new Error('中继消息内容为空。');
  let plain;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(envelope.id, envelope.ts, envelope.type) },
      key,
      ciphertext,
    );
  } catch {
    // Wrong key, edited header, or truncated body: all indistinguishable on purpose.
    throw new Error('中继消息无法验证，已丢弃。');
  }
  let payload;
  try {
    payload = JSON.parse(fromUtf8(new Uint8Array(plain)));
  } catch {
    throw new Error('中继消息内容不是有效的 JSON。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('中继消息内容格式不正确。');
  return { id: envelope.id, ts: envelope.ts, type: envelope.type, payload };
}

/** True for a message that carries its payload as JSON instead of ciphertext. */
export function isPlainEnvelope(envelope) {
  return Boolean(envelope) && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.plain === true;
}

/**
 * The LAN transport: same header, same size and clock rules, no ciphertext.
 *
 * It exists because `http://` on a local network has no `crypto.subtle`, and a phone that
 * cannot decrypt anything is worse than one that is told the truth. A host must opt in by
 * routing these to `openPlain`; the relay never does, and the desktop refuses them over
 * anything but the direct LAN link.
 */
export function sealPlain(type, payload, { now = new Date() } = {}) {
  if (!TYPES.has(type)) throw new Error('不支持的中继消息类型。');
  const body = JSON.stringify(payload ?? {});
  if (utf8(body).byteLength > MAX_PLAINTEXT_BYTES) throw new Error('中继消息超过大小上限。');
  return {
    v: PROTOCOL_VERSION,
    id: newId(),
    ts: now.toISOString(),
    type,
    plain: true,
    pt: JSON.parse(body),
  };
}

export function openPlain(envelope, { now = Date.now() } = {}) {
  if (!isPlainEnvelope(envelope)) throw new Error('这条消息不是局域网明文消息。');
  checkHeader(envelope, now);
  const payload = envelope.pt;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('中继消息内容格式不正确。');
  return { id: envelope.id, ts: envelope.ts, type: envelope.type, payload };
}

/**
 * Rejects a message that has already been handled. A phone that taps "allow" twice, or a relay
 * that replays an old frame, must not approve two different tool calls.
 */
export class ReplayGuard {
  constructor({ limit = 512, windowMs = CLOCK_SKEW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.seen = new Map();
  }

  accept(id, ts, now = Date.now()) {
    const at = Date.parse(ts);
    if (!isId(id) || !Number.isFinite(at)) return false;
    if (Math.abs(now - at) > this.windowMs) return false;
    if (this.seen.has(id)) return false;
    this.seen.set(id, at);
    while (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value);
    return true;
  }
}

/** Text that goes to a phone: bounded and stripped of control characters. */
export function clip(value, max = 200) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length <= max) return clean;
  return `${Array.from(clean).slice(0, Math.max(0, max - 1)).join('')}…`;
}
