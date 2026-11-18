// Web Push sending side: RFC 8291 payload encryption and RFC 8292 VAPID.
//
// Only the *sender* half lives here. A browser holds the subscription's private key and
// performs the RFC 8291 decryption itself; the service worker is handed the plaintext. So this
// file has to be byte-exact against the specification, and it is checked against the published
// test vector in tests/push-rfc8291.mjs rather than against itself.
//
// Everything here uses node:crypto only — no dependency, nothing to supply-chain.

import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** RFC 8291 §4: a push service is not required to accept more than 4096 octets. */
export const MAX_PUSH_PAYLOAD = 4096;
const RECORD_SIZE = 4096;
const PUBLIC_KEY_BYTES = 65;

const utf8 = value => Buffer.from(String(value), 'utf8');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64url');
  return Buffer.alloc(0);
}

/** HKDF-Expand with a single block: every value here is shorter than one SHA-256 block. */
function hkdfExpand(prk, info, length) {
  const block = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return block.subarray(0, length);
}

function hkdfExtract(salt, ikm) {
  return createHmac('sha256', salt).update(ikm).digest();
}

/**
 * A subscription as the browser reports it, checked for the shapes RFC 8291 requires.
 * An endpoint that is not https is refused: a push endpoint over plain http would let anyone
 * on the path learn which device just received a notification.
 */
export function parseSubscription(value) {
  if (!value || typeof value !== 'object') throw new Error('订阅信息不是对象。');
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : '';
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('订阅地址不是有效的网址。'); }
  if (url.protocol !== 'https:') throw new Error('订阅地址必须是 https。');
  if (endpoint.length > 2048) throw new Error('订阅地址过长。');
  const keys = value.keys && typeof value.keys === 'object' ? value.keys : {};
  const p256dh = toBuffer(keys.p256dh);
  const auth = toBuffer(keys.auth);
  if (p256dh.length !== PUBLIC_KEY_BYTES || p256dh[0] !== 0x04) throw new Error('订阅公钥格式不正确。');
  if (auth.length !== 16) throw new Error('订阅认证密钥长度不正确。');
  return { endpoint, p256dh, auth };
}

/**
 * RFC 8291 §3.4. `sender` exists for the test vector: production always generates a fresh
 * key pair per message, because reusing one would leak the relationship between messages.
 */
export function encryptPush({ plaintext, subscription, salt, sender } = {}) {
  const { p256dh, auth } = parseSubscription(subscription);
  const body = Buffer.isBuffer(plaintext) ? plaintext : utf8(plaintext);
  if (!body.length) throw new Error('推送内容为空。');
  if (body.length > MAX_PUSH_PAYLOAD) throw new Error('推送内容过大。');

  let keys = sender;
  if (!keys) {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    keys = { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
  }
  const asPrivate = toBuffer(keys.privateKey);
  const asPublic = toBuffer(keys.publicKey);
  if (asPrivate.length !== 32 || asPublic.length !== PUBLIC_KEY_BYTES) throw new Error('发送方密钥格式不正确。');

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(asPrivate);
  const ecdhSecret = ecdh.computeSecret(p256dh);

  const usedSalt = salt ? toBuffer(salt) : randomBytes(16);
  if (usedSalt.length !== 16) throw new Error('盐值长度不正确。');

  const prkKey = hkdfExtract(auth, ecdhSecret);
  const keyInfo = Buffer.concat([utf8('WebPush: info'), Buffer.from([0]), p256dh, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(usedSalt, ikm);
  const cek = hkdfExpand(prk, Buffer.concat([utf8('Content-Encoding: aes128gcm'), Buffer.from([0])]), 16);
  const nonce = hkdfExpand(prk, Buffer.concat([utf8('Content-Encoding: nonce'), Buffer.from([0])]), 12);

  // RFC 8188 §2: the last (here only) record carries a 0x02 padding delimiter.
  const padded = Buffer.concat([body, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([usedSalt, recordSize, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

/** A VAPID key pair, both halves as base64url text so they survive an env file. */
export function createVapidKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return {
    publicKey: raw.toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

/**
 * The `Authorization` header for one push (RFC 8292 §3). The audience is the origin of the
 * endpoint, not our own URL: a token minted for one push service is refused by another.
 */
export function vapidAuthorization({ endpoint, keys, subject = 'mailto:admin@example.com', now = Date.now() }) {
  const audience = new URL(endpoint).origin;
  const privateKey = createPrivateKey({
    key: Buffer.from(String(keys.privateKey), 'base64url'), format: 'der', type: 'pkcs8',
  });
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  // JWS wants r||s, not the DER sequence node signs with by default.
  const signature = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${signature.toString('base64url')},k=${keys.publicKey}`;
}

export function validateVapidKeys(keys) {
  if (!keys || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
    throw new Error('缺少 VAPID 密钥。');
  }
  const raw = Buffer.from(keys.publicKey, 'base64url');
  if (raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) throw new Error('VAPID 公钥格式不正确。');
  // Parsing now means a bad key fails at startup, not on the first approval.
  createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  return keys;
}

/**
 * Sends one encrypted message. 404/410 mean the subscription is dead and the caller should
 * forget it; anything else is retried by nobody, because an approval that arrives late is
 * worse than one the phone simply reads from the page.
 */
export async function sendPush({
  subscription, plaintext, vapid, subject, ttl = 600, urgency = 'high',
  fetchImpl = globalThis.fetch, now = Date.now(),
}) {
  const body = encryptPush({ plaintext: plaintext ?? '', subscription });
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization({ endpoint: subscription.endpoint, keys: vapid, subject, now }),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const status = response.status;
  return {
    status,
    ok: status === 201 || status === 200,
    gone: status === 404 || status === 410,
  };
}
