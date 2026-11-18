// Service worker: turns a relay wake-up into a notification the user can act on.
//
// The push payload is sealed with this device's key, exactly like every other relayed message,
// so this file — not the relay — is what decides whether a notification says "批准" or "回答".
// A message that cannot be decrypted still produces a neutral notification rather than nothing:
// silence would look like "nothing is waiting".

import { readDevice } from './phone/device-store.mjs';
import { deriveDeviceKey, fromBase64Url, open } from './phone/relay-protocol.mjs';

const TAG = 'harness-pending';

function scopeUrl(relativePath = './') {
  const base = self.registration?.scope || new URL('./', self.location.href).href;
  return new URL(relativePath, base).href;
}

async function scopedClients() {
  const scopePrefix = scopeUrl('./');
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter(client => {
    try { return new URL(client.url).href.startsWith(scopePrefix); }
    catch { return false; }
  });
}

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

function describe(payload) {
  const first = payload?.first ?? {};
  const approvals = Number(payload?.approvals) || 0;
  const questions = Number(payload?.questions) || 0;
  const total = approvals + questions;
  const kind = first.kind === 'question' ? 'question' : 'approval';
  const heading = kind === 'question' ? '需要你回答' : '需要你批准';
  const title = total > 1 ? `${total} 项待处理 · ${heading}` : heading;
  const detail = [first.title, first.text].filter(Boolean).join(' · ');
  return {
    title,
    body: String(detail || '打开查看这条请求。').slice(0, 180),
    kind,
  };
}

async function notificationFor(event) {
  const fallback = { title: 'Harness 有新消息', body: '打开查看等待你处理的事情。', kind: 'approval' };
  const raw = event.data ? event.data.text() : '';
  if (!raw) return fallback;
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return fallback; }
  const device = await readDevice();
  // A phone that forgot its pairing cannot read the payload. Nudge anyway, and let the page
  // explain that it needs pairing again.
  if (!device) return { title: 'Harness 需要重新配对', body: '这台手机已解除配对，打开页面重新扫码。', kind: 'approval' };
  try {
    const key = await deriveDeviceKey(device.secret, device.deviceId);
    const message = await open(key, envelope);
    if (message?.type !== 'push.hint') return fallback;
    return describe(message.payload);
  } catch {
    return fallback;
  }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const notice = await notificationFor(event);
    await self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: TAG,
      // Re-alert on every new item; the tag keeps the tray to one Harness entry.
      renotify: true,
      // An approval waits for a person, so it should not slide away on its own.
      requireInteraction: notice.kind === 'approval',
      data: { url: scopeUrl('./') },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = event.notification?.data?.url || scopeUrl('./');
    const clients = await scopedClients();
    for (const client of clients) {
      try { await client.focus(); return; }
      catch { /* a closing client is skipped */ }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

async function renewSubscription(event, device) {
  let subscription = event.newSubscription ?? null;
  if (!subscription && self.registration?.pushManager) {
    let applicationServerKey = event.oldSubscription?.options?.applicationServerKey ?? null;
    if (!applicationServerKey) {
      const keyResponse = await fetch(scopeUrl('./push/key'));
      const keyBody = await keyResponse.json().catch(() => ({}));
      if (keyResponse.ok && typeof keyBody.key === 'string' && keyBody.key) {
        applicationServerKey = fromBase64Url(keyBody.key);
      }
    }
    if (applicationServerKey) {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
  }
  if (!subscription) return false;
  const payload = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  const response = await fetch(scopeUrl('./phone/subscribe'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${device.token}`,
    },
    body: JSON.stringify({ deviceId: device.deviceId, subscription: payload }),
  });
  return response.ok;
}

// The browser rotated or invalidated the push endpoint. Never clear the paired device or E2EE
// secret in IndexedDB: try to re-subscribe with the stored device token directly, and otherwise
// ask open client pages to refresh the push subscription while preserving pairing state.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    let updated = false;
    try {
      const device = await readDevice();
      if (device?.deviceId && device?.token) {
        updated = await renewSubscription(event, device);
      }
    } catch {
      updated = false;
    }
    const clients = await scopedClients();
    const message = { type: updated ? 'push-subscription-updated' : 'push-subscription-refresh' };
    for (const client of clients) {
      try { client.postMessage(message); } catch { /* closing */ }
    }
  })());
});
