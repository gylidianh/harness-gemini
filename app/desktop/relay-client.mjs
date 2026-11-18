// Outbound relay client.
//
// The desktop connects out to the VPS and holds one long-lived SSE response open; it never
// listens on a public address and the local service keeps its 127.0.0.1-only rule. If the VPS
// disappears the app is unaffected: approvals stay in the local queue and the phone simply sees
// a stale snapshot until the link returns.

import { clip, deriveDeviceKey, isId, newId, open, ReplayGuard, seal, sha256Hex } from '../shared/relay-protocol.mjs';
import { createControlPlane } from '../server/control-plane.mjs';

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const WATCHDOG_MS = 45_000;
const PUSH_TIMEOUT_MS = 10_000;
const POLL_MS = 1_500;
const MAX_DEVICES = 8;

function normalizeDeviceId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Splits an SSE byte stream into `{ event, data }` frames. The relay only ever sends one JSON
 * value per frame, so a frame is kept whole rather than accumulated across events.
 *
 * Reverse proxies (IIS/ARR, Cloudflare, corporate gateways) may rewrite `\n` to `\r\n` and split
 * chunks right between `\r` and `\n`. A trailing `\r` is held until the next decoded chunk before
 * normalising line endings to `\n`, so `\r\n\r\n` across chunk boundaries is never torn apart.
 */
export async function* readEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let carryCr = false;

  function* drain() {
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
      if (data.length) yield { event, data: data.join('\n') };
    }
  }

  for await (const chunk of stream) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (!text) continue;
    if (carryCr) {
      text = `\r${text}`;
      carryCr = false;
    }
    if (text.endsWith('\r')) {
      carryCr = true;
      text = text.slice(0, -1);
    }
    if (!text) continue;
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.length > 256 * 1024) throw new Error('中继数据流异常。');
    yield* drain();
  }

  let tail = decoder.decode();
  if (carryCr) {
    tail = `\r${tail}`;
    carryCr = false;
  }
  if (tail) {
    buffer += tail.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.length > 256 * 1024) throw new Error('中继数据流异常。');
    yield* drain();
  }
}

function relayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('中继地址不是有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('中继地址必须是 http 或 https。');
  }
  return url;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已停止。')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('已停止。')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function configuredDeviceIds(entries) {
  const ids = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawId = typeof entry === 'string' ? entry : entry?.deviceId;
    const id = normalizeDeviceId(rawId);
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_DEVICES) break;
  }
  return ids;
}

/**
 * Decides whether a snapshot deserves a wake-up, and for what.
 *
 * Exported and almost pure — it only updates the set it is handed — because "notified exactly
 * once" is the kind of rule that is only trustworthy when a test can call it. The first
 * snapshot after start *primes* the set instead of pushing: a restart while something is
 * already pending must not fire a notification for work the user is looking at right now.
 */
export function planNotifications(state, snapshot) {
  const approvals = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
  const questions = Array.isArray(snapshot?.questions) ? snapshot.questions : [];
  const fresh = [
    ...approvals
      .filter(item => !state.notified.has(item.approvalId))
      .map(item => ({ id: item.approvalId, kind: 'approval', title: item.title, text: item.preview || item.reason })),
    ...questions
      .filter(item => !state.notified.has(item.questionId))
      .map(item => ({ id: item.questionId, kind: 'question', title: item.title, text: item.question })),
  ];
  // Forget what is no longer pending, so the set stays small and a re-asked approval — which
  // arrives with a new id — notifies again.
  const live = new Set([...approvals.map(item => item.approvalId), ...questions.map(item => item.questionId)]);
  for (const id of state.notified) if (!live.has(id)) state.notified.delete(id);
  if (!state.armed) {
    for (const item of fresh) state.notified.add(item.id);
    state.armed = true;
    return null;
  }
  if (!fresh.length) return null;
  for (const item of fresh) state.notified.add(item.id);
  return {
    approvals: approvals.length,
    questions: questions.length,
    first: { kind: fresh[0].kind, title: clip(fresh[0].title, 40), text: clip(fresh[0].text, 140) },
  };
}

/**
 * @param {object} options
 * @param {string} options.origin   loopback origin of this app, e.g. http://127.0.0.1:4318
 * @param {object} options.harness  app.locals.harness
 * @param {string} options.dataDir  where the local audit trail is appended
 * @param {object|Function} options.config  { enabled, url, relayToken, pairSecret, devices[], dispatchEnabled }
 * @param {(deviceId: string) => Promise<boolean|void>|boolean|void} [options.onPaired]
 */
export function createRelayClient({
  origin,
  harness,
  dataDir,
  config,
  onPaired: onPairedOption,
  log = () => {},
  fetchImpl = globalThis.fetch,
  watchdogMs = WATCHDOG_MS,
  backoffMinMs = BACKOFF_MIN_MS,
  backoffMaxMs = BACKOFF_MAX_MS,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('中继客户端缺少网络实现。');
  // A live getter: the settings page flips dispatch while this link is already up, and a
  // frozen copy is how that switch silently stops working until the next restart.
  const readConfig = typeof config === 'function' ? config : () => config;
  // Support both top-level `options.onPaired` (used when `config` is a live getter) and legacy `config.onPaired`.
  const onPaired = typeof onPairedOption === 'function'
    ? onPairedOption
    : (typeof config?.onPaired === 'function' ? config.onPaired : null);
  const plane = createControlPlane({
    harness,
    origin,
    dataDir,
    dispatchEnabled: () => readConfig()?.dispatchEnabled === true,
    fetchImpl,
  });
  const guard = new ReplayGuard();
  const devices = new Map();
  const pendingRevokes = new Set();
  let running = false;
  let runGeneration = 0;
  let stopController = null;
  let connController = null;
  let poller = null;
  let lastSnapshot = '';
  let lastFrameAt = 0;
  let backoff = 0;
  const status = { state: 'offline', error: '', devices: 0, lastPushAt: null, lastFrameAt: null };
  const notifyState = { notified: new Set(), armed: false };

  async function prepare(generation, stopSignal) {
    const current = readConfig() ?? {};
    const url = relayUrl(current.url ?? '');
    const token = typeof current.relayToken === 'string' ? current.relayToken.trim() : '';
    if (!token) throw new Error('中继令牌为空。');
    if (!current.pairSecret) throw new Error('配对密钥为空。');
    const nextDevices = new Map();
    for (const deviceId of configuredDeviceIds(current.devices)) {
      if (pendingRevokes.has(deviceId)) continue;
      nextDevices.set(deviceId, await deriveDeviceKey(current.pairSecret, deviceId));
    }
    if (generation !== runGeneration || stopSignal?.aborted) return null;
    devices.clear();
    for (const [deviceId, key] of nextDevices) devices.set(deviceId, key);
    status.devices = devices.size;
    return { url, token };
  }

  async function post(url, token, route, body, signal = undefined) {
    const timeout = AbortSignal.timeout(PUSH_TIMEOUT_MS);
    const mergedSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : (signal ?? timeout);
    const response = await fetchImpl(new URL(route, url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: mergedSignal,
    });
    if (!response.ok) throw new Error(`中继返回 ${response.status}。`);
    return response;
  }

  function revokeOnRelay(url, token, deviceId) {
    if (!isId(deviceId)) return;
    pendingRevokes.add(deviceId);
    void post(url, token, '/harness/revoke', { deviceId })
      .then(() => { pendingRevokes.delete(deviceId); })
      .catch(error => { log('relay revoke sync failed', error); });
  }

  /** Registers the current pairing code SHA-256 and active device allowlist with the VPS relay. */
  async function register(url, token, signal) {
    const current = readConfig() ?? {};
    if (!current.pairSecret) throw new Error('配对密钥为空。');
    for (const deviceId of configuredDeviceIds(current.devices)) {
      if (devices.size >= MAX_DEVICES) break;
      if (!devices.has(deviceId) && !pendingRevokes.has(deviceId)) {
        devices.set(deviceId, await deriveDeviceKey(current.pairSecret, deviceId));
      }
    }
    status.devices = devices.size;
    const codeHash = await sha256Hex(current.pairSecret);
    const activeDevices = [...devices.keys()];
    const revokedDevices = [...pendingRevokes];
    await post(url, token, '/harness/register', {
      codeHash,
      devices: activeDevices,
      preserveUnacked: true,
      ...(revokedDevices.length ? { revokedDevices } : {}),
    }, signal);
    for (const id of revokedDevices) pendingRevokes.delete(id);
  }

  async function push(url, token, rawDeviceId, type, payload) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    const key = devices.get(deviceId);
    if (!key) return false;
    const envelope = await seal(key, type, payload);
    await post(url, token, '/harness/push', { deviceId, envelope });
    status.lastPushAt = new Date().toISOString();
    return true;
  }

  /** Sends a wake-up for new pending work. The decision lives in planNotifications. */
  async function notifyPending(url, token, snapshot) {
    const payload = planNotifications(notifyState, snapshot);
    if (!payload) return;
    // Sealed per device, so a compromised relay learns that *something* happened but not what.
    for (const [deviceId, key] of devices) {
      try {
        await post(url, token, '/harness/notify', { deviceId, envelope: await seal(key, 'push.hint', payload) });
      } catch (error) {
        log('relay notify failed', error);
      }
    }
  }

  async function pushSnapshot(url, token, { force = false } = {}) {
    if (!devices.size) return;
    let snapshot;
    try { snapshot = plane.snapshot(); }
    catch (error) { log('relay snapshot failed', error); return; }
    const fingerprint = JSON.stringify(snapshot);
    if (!force && fingerprint === lastSnapshot) return;
    lastSnapshot = fingerprint;
    await notifyPending(url, token, snapshot);
    for (const deviceId of devices.keys()) {
      try { await push(url, token, deviceId, 'pending.snapshot', snapshot); }
      catch (error) { log('relay push failed', error); }
    }
  }

  /** A phone that proved knowledge of the pairing secret is accepted unless MAX_DEVICES is full;
   *  refused excess devices are immediately revoked on the relay so no ghost device can remain. */
  async function acceptDevice(url, token, rawDeviceId) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    if (!isId(deviceId) || devices.has(deviceId)) return false;
    const current = readConfig() ?? {};
    const persistedCount = configuredDeviceIds(current.devices).length;
    if (devices.size >= MAX_DEVICES || persistedCount >= MAX_DEVICES) {
      log(`relay pairing refused: MAX_DEVICES (${MAX_DEVICES}) reached, revoking ${deviceId}`);
      revokeOnRelay(url, token, deviceId);
      return false;
    }
    const secret = current.pairSecret;
    if (!secret) throw new Error('配对密钥为空。');
    const derivedKey = await deriveDeviceKey(secret, deviceId);
    if (devices.has(deviceId)) return true;
    if (devices.size >= MAX_DEVICES || configuredDeviceIds(readConfig()?.devices).length >= MAX_DEVICES) {
      log(`relay pairing refused: MAX_DEVICES (${MAX_DEVICES}) reached, revoking ${deviceId}`);
      revokeOnRelay(url, token, deviceId);
      return false;
    }
    pendingRevokes.delete(deviceId);
    devices.set(deviceId, derivedKey);
    status.devices = devices.size;
    if (onPaired) {
      let persisted = true;
      try { persisted = await onPaired(deviceId); }
      catch (error) { log('relay persist failed', error); persisted = false; }
      if (persisted === false) {
        devices.delete(deviceId);
        status.devices = devices.size;
        if (running) revokeOnRelay(url, token, deviceId);
        return false;
      }
    }
    await register(url, token).catch(error => { log('relay register ack failed', error); });
    await pushSnapshot(url, token, { force: true });
    return true;
  }

  async function handleInvoke(url, token, rawDeviceId, envelope) {
    const deviceId = normalizeDeviceId(rawDeviceId);
    const key = devices.get(deviceId);
    if (!key) throw new Error('未知设备。');
    // Unverifiable means not ours: no reply is sent, because answering would confirm to an
    // unknown sender that this device id exists.
    const message = await open(key, envelope);
    const reply = { replyTo: message.id };
    try {
      // A duplicate is answered rather than dropped, so a phone never waits on a dead request.
      if (!guard.accept(message.id, message.ts)) throw new Error('重复或过期的中继消息。');
      const data = await plane.execute({ action: message.payload.action, params: message.payload.params, deviceId });
      await push(url, token, deviceId, 'result', { ...reply, ok: true, data });
    } catch (error) {
      const reason = typeof error?.message === 'string' ? error.message : '远程操作失败。';
      await push(url, token, deviceId, 'result', { ...reply, ok: false, message: reason });
    }
  }

  async function connect(url, token, stopSignal, generation) {
    const currentConn = new AbortController();
    connController = currentConn;
    const onStop = () => currentConn.abort();
    if (stopSignal?.aborted) currentConn.abort();
    else stopSignal?.addEventListener('abort', onStop, { once: true });

    let watchdog = null;
    let currentPoller = null;
    try {
      await register(url, token, currentConn.signal);
      const response = await fetchImpl(new URL('/harness/stream', url), {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: currentConn.signal,
      });
      if (!response.ok || !response.body) throw new Error(`中继拒绝连接（${response.status}）。`);
      if (stopSignal?.aborted || generation !== runGeneration) return;
      status.state = 'connected';
      status.error = '';
      backoff = 0;
      lastFrameAt = Date.now();
      status.lastFrameAt = new Date().toISOString();

      const watchdogCheckMs = Math.min(5_000, Math.max(20, Math.floor(watchdogMs / 3)));
      watchdog = setInterval(() => {
        if (Date.now() - lastFrameAt > watchdogMs) currentConn.abort();
      }, watchdogCheckMs);
      watchdog.unref?.();

      currentPoller = setInterval(() => { void pushSnapshot(url, token); }, POLL_MS);
      currentPoller.unref?.();
      poller = currentPoller;

      for await (const frame of readEvents(response.body)) {
        lastFrameAt = Date.now();
        status.lastFrameAt = new Date().toISOString();
        if (frame.event === 'ping') continue;
        let parsed;
        try { parsed = JSON.parse(frame.data); }
        catch { continue; }
        if (frame.event === 'hello') { await pushSnapshot(url, token, { force: true }); continue; }
        if (frame.event !== 'invoke' && frame.event !== 'paired') continue;
        if (frame.event === 'paired') { await acceptDevice(url, token, parsed?.deviceId); continue; }
        try {
          await handleInvoke(url, token, parsed?.deviceId, parsed?.envelope);
        } catch (error) {
          log('relay invoke failed', error);
        }
      }
    } finally {
      clearInterval(watchdog);
      clearInterval(currentPoller);
      if (poller === currentPoller) poller = null;
      stopSignal?.removeEventListener('abort', onStop);
      currentConn.abort();
      if (connController === currentConn) connController = null;
    }
  }

  return {
    start() {
      if (running || readConfig()?.enabled !== true) return this.status();
      const generation = ++runGeneration;
      const currentStop = new AbortController();
      stopController = currentStop;
      running = true;
      backoff = 0;
      void (async () => {
        let failedPrepare = false;
        try {
          let prepared;
          try {
            prepared = await prepare(generation, currentStop.signal);
          } catch (error) {
            if (generation === runGeneration && !currentStop.signal.aborted) {
              failedPrepare = true;
              status.state = 'error';
              status.error = error.message;
              log('relay configuration is unusable', error);
            }
            return;
          }
          if (!prepared) return;
          while (running && !currentStop.signal.aborted && generation === runGeneration) {
            try {
              await connect(prepared.url, prepared.token, currentStop.signal, generation);
            } catch (error) {
              if (!running || currentStop.signal.aborted || generation !== runGeneration) break;
              status.state = 'reconnecting';
              status.error = typeof error?.message === 'string' ? error.message : '中继连接中断。';
              log('relay link down, retrying', error);
            }
            if (!running || currentStop.signal.aborted || generation !== runGeneration) break;
            backoff = Math.min(backoffMaxMs, backoff ? backoff * 2 : backoffMinMs);
            const wait = backoff + Math.floor(Math.random() * Math.min(400, backoffMinMs));
            try { await sleep(wait, currentStop.signal); }
            catch { break; }
          }
        } finally {
          if (generation === runGeneration) {
            running = false;
            if (stopController === currentStop) stopController = null;
            if (!failedPrepare) status.state = 'offline';
          }
        }
      })();
      return this.status();
    },

    stop() {
      runGeneration += 1;
      running = false;
      clearInterval(poller);
      poller = null;
      stopController?.abort();
      stopController = null;
      connController?.abort();
      connController = null;
      status.state = 'offline';
      return this.status();
    },

    status() {
      return { ...status, enabled: readConfig()?.enabled === true, dispatchEnabled: readConfig()?.dispatchEnabled === true };
    },

    /** A revoke must take effect on the live link, not on the next restart. */
    revoke(rawDeviceId, { sync = true } = {}) {
      const deviceId = normalizeDeviceId(rawDeviceId);
      const removed = devices.delete(deviceId);
      if (removed) status.devices = devices.size;
      if (isId(deviceId)) pendingRevokes.add(deviceId);
      if (sync && isId(deviceId)) {
        const current = readConfig() ?? {};
        const token = typeof current.relayToken === 'string' ? current.relayToken.trim() : '';
        if (current.url && token) {
          try {
            const url = relayUrl(current.url);
            void post(url, token, '/harness/revoke', { deviceId })
              .then(() => { pendingRevokes.delete(deviceId); })
              .catch(error => { log('relay revoke sync failed', error); });
          } catch { /* ignore invalid relay url */ }
        }
      }
      return removed;
    },

    /** Used by the settings page to show what a device will be allowed to do. */
    describe() {
      return {
        url: typeof readConfig()?.url === 'string' ? readConfig().url : '',
        devices: [...devices.keys()],
        dispatchEnabled: readConfig()?.dispatchEnabled === true,
      };
    },

    /** Payload builder kept here so a future pairing screen and the tests agree on shape. */
    newRequestId: newId,
  };
}
