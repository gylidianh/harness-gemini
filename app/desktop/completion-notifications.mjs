export const OPEN_SESSION_CHANNEL = 'harness:open-completed-session';
export const TEST_NOTIFICATION_CHANNEL = 'harness:test-system-notification';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const isUuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const MODES = new Set(['chat', 'agent', 'image']);
const MAX_REMEMBERED = 512;
const MAX_VISIBLE = 12;
const SHOW_ACK_TIMEOUT_MS = 5_000;
/** Extra in-process listeners for notifications that moved into the Windows Action Center. */
const MAX_PARKED = 20;

function notificationScheme(protocol) {
  return typeof protocol === 'string' && protocol === protocol.trim() && SCHEME.test(protocol) ? protocol.toLowerCase() : null;
}

/**
 * A registered Windows protocol makes an Action Center item independent of the lifetime of its
 * in-process click listener. Registration/OS delivery are best effort, not an acknowledgement.
 */
export function completionToastXml({ title, body, protocol, sessionId }) {
  const scheme = notificationScheme(protocol);
  if (!scheme) throw new TypeError('Invalid notification protocol');
  const escape = value => String(value ?? '').toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);
  const launch = typeof sessionId === 'string' && isUuid(sessionId) ? `${scheme}://open-session/${sessionId.toLowerCase()}` : `${scheme}://open`;
  return `<toast launch="${escape(launch)}" activationType="protocol"><visual><binding template="ToastGeneric"><text>${escape(title)}</text><text>${escape(body)}</text></binding></visual><audio silent="true"/></toast>`;
}

/** Do not URL-normalize untrusted launch arguments: that would accept credentials, dot paths,
 * escapes or whitespace that our toast never generates. Scheme/host are case insensitive;
 * the UUID path and separators must be exact. */
function protocolLaunchFromArgs(args, protocol) {
  const scheme = notificationScheme(protocol);
  if (!Array.isArray(args) || !scheme) return null;
  for (const value of args) {
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u0020\u007f\\]/.test(value)) continue;
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/[^?#]*)?$/i.exec(value);
    if (!match || match[1].toLowerCase() !== scheme) continue;
    const host = match[2].toLowerCase();
    const pathname = match[3] ?? '';
    if (host === 'open' && (pathname === '' || pathname === '/')) return { sessionId: undefined };
    if (host !== 'open-session') continue;
    const id = /^\/([0-9a-fA-F-]+)\/?$/.exec(pathname)?.[1];
    if (id && isUuid(id)) return { sessionId: id.toLowerCase() };
  }
  return null;
}

/** The session a validated notification protocol launch names, or null. */
export function sessionFromProtocolArgs(args, protocol) {
  return protocolLaunchFromArgs(args, protocol)?.sessionId ?? null;
}

/** True only for a supported, validated notification protocol launch (including the test toast). */
export function isProtocolLaunch(args, protocol) {
  return protocolLaunchFromArgs(args, protocol) !== null;
}

function validCompletion(value) {
  return value && typeof value.sessionId === 'string' && isUuid(value.sessionId)
    && typeof value.messageId === 'string' && isUuid(value.messageId)
    && MODES.has(value.mode) && ['done', 'error'].includes(value.status);
}

// Electron dependencies are injected so tests never display an actual OS notification.
export function createCompletionNotifications({ Notification, getWindow, isEnabled, isSuppressed, isOwnUrl, protocol = null, platform = process.platform }) {
  const seen = new Set();
  const visible = new Map();
  const parked = new Map();
  // Keep only small, normalized completion metadata. Do not truncate a dialog's backlog or
  // show 20 items at once and immediately close 8 of them to enforce MAX_VISIBLE.
  const deferred = new Map();
  const toastProtocol = platform === 'win32' ? notificationScheme(protocol) : null;
  let pendingOpen;
  let loadWatch;
  let drainScheduled = false;
  let draining = false;
  let disposed = false;
  let lastTestAt = -Infinity;

  function currentWindow() {
    const window = getWindow();
    return !disposed && window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  }

  function allowedWindow(window) {
    return !disposed && !isSuppressed() && window && currentWindow() === window && isOwnUrl(window.webContents.getURL());
  }

  function clearLoadWatch() {
    if (!loadWatch) return;
    const { contents, onLoaded, onDestroyed } = loadWatch;
    loadWatch = undefined;
    contents.off('did-finish-load', onLoaded);
    contents.off('destroyed', onDestroyed);
  }

  function watchLoadingWindow(window) {
    if (!window || !window.webContents.isLoadingMainFrame()) return;
    const contents = window.webContents;
    if (loadWatch?.contents === contents) return;
    clearLoadWatch();
    const onLoaded = () => {
      clearLoadWatch();
      try { flushDeferred(); } catch { /* Window may be closing. */ }
      // Electron may still report a main-frame load during the event itself. Recheck after
      // that event has unwound rather than waiting for a second did-finish-load that never comes.
      scheduleDrain();
    };
    const onDestroyed = () => clearLoadWatch();
    loadWatch = { contents, onLoaded, onDestroyed };
    contents.once('did-finish-load', onLoaded);
    contents.once('destroyed', onDestroyed);
  }

  function scheduleDrain() {
    if (disposed || drainScheduled || (!pendingOpen && !deferred.size)) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      try { flushDeferred(); } catch { /* A destroyed window must not interrupt shutdown. */ }
    });
  }

  function flushPendingOpen() {
    if (!pendingOpen || disposed || isSuppressed()) return false;
    const window = currentWindow();
    if (!window) return false;
    const contents = window.webContents;
    // A newly-created window can still report about:blank. Keep the intent until its own page
    // has loaded; never send a session ID to a foreign origin, even after did-finish-load.
    if (contents.isLoadingMainFrame()) { watchLoadingWindow(window); return false; }
    if (!allowedWindow(window)) return false;
    const request = pendingOpen;
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (pendingOpen !== request || !allowedWindow(window)) return false;
      if (contents.isLoadingMainFrame()) { watchLoadingWindow(window); return false; }
      if (request.sessionId) contents.send(OPEN_SESSION_CHANNEL, { sessionId: request.sessionId });
      if (pendingOpen === request) pendingOpen = undefined;
      if (!pendingOpen && !deferred.size) clearLoadWatch();
      return true;
    } catch { return false; }
  }

  /** Accept a click even during a quit confirmation or before the window exists. The latest
   * explicit click wins, matching the preload's one pending conversation and one active view. */
  function openSessionById(sessionId) {
    if (disposed || (sessionId !== undefined && (typeof sessionId !== 'string' || !isUuid(sessionId)))) return false;
    pendingOpen = { sessionId: sessionId?.toLowerCase() };
    flushPendingOpen();
    return true;
  }

  function remember(messageId) {
    seen.add(messageId);
    if (seen.size > MAX_REMEMBERED) seen.delete(seen.values().next().value);
  }

  function release(messageId, close = false) {
    const entry = visible.get(messageId) ?? parked.get(messageId);
    if (!entry) return;
    const { notification, settle } = entry;
    clearTimeout(entry.timer);
    visible.delete(messageId);
    parked.delete(messageId);
    settle?.({ sent: false, reason: disposed || isSuppressed() ? 'suppressed' : 'unavailable' });
    notification.removeAllListeners();
    if (close) { try { notification.close(); } catch { /* Already dismissed. */ } }
    scheduleDrain();
  }

  function showNotification(messageId, options, sessionId, receipt) {
    const notification = new Notification(toastProtocol
      ? { ...options, toastXml: completionToastXml({ title: options.title, body: options.body, protocol: toastProtocol, sessionId }) }
      : options);
    let timer;
    let settled = false;
    const settle = receipt ? result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      receipt(result);
    } : undefined;
    const entry = { notification, settle, failed: false, shown: false };
    // A supported OS can silently refuse a toast. An entry that never emits show/failed must
    // not occupy a visible slot forever or become permanently seen.
    timer = setTimeout(() => { settle?.({ sent: false, reason: 'unavailable' }); release(messageId, true); }, SHOW_ACK_TIMEOUT_MS);
    timer.unref?.();
    entry.timer = timer;
    visible.set(messageId, entry);
    notification.once('show', () => {
      clearTimeout(timer);
      entry.shown = true;
      // A constructor/show() failure or an unavailable window is not a delivered completion.
      if (messageId !== 'test') remember(messageId);
      settle?.({ sent: true });
    });
    notification.once('click', () => {
      try { openSessionById(sessionId); } catch { /* Notification actions are best effort. */ }
      finally { release(messageId, true); }
    });
    notification.once('close', (event, details) => {
      const reason = details?.reason ?? event?.reason;
      if (platform !== 'win32' || reason === 'userCanceled' || disposed) { release(messageId); return; }
      const active = visible.get(messageId);
      if (active !== entry) return;
      visible.delete(messageId);
      parked.set(messageId, entry);
      while (parked.size > MAX_PARKED) {
        // With a protocol the OS item stays actionable after our listener is evicted. Without
        // one, explicitly remove the OS item rather than leave an unclickable Action Center item.
        release(parked.keys().next().value, !toastProtocol);
      }
      scheduleDrain();
    });
    notification.once('failed', () => {
      entry.failed = true;
      seen.delete(messageId);
      settle?.({ sent: false, reason: 'failed' });
      release(messageId, true);
    });
    try { notification.show(); }
    catch (error) {
      seen.delete(messageId);
      settle?.({ sent: false, reason: 'failed' });
      release(messageId, true);
      throw error;
    }
    return !entry.failed;
  }

  function notify(completion) {
    let messageId;
    try {
      if (disposed || !validCompletion(completion)) return false;
      messageId = completion.messageId.toLowerCase();
      if (seen.has(messageId) || visible.has(messageId) || parked.has(messageId)) return false;
      if (!isEnabled() || !Notification.isSupported()) return false;
      const normalized = {
        messageId, sessionId: completion.sessionId.toLowerCase(), mode: completion.mode, status: completion.status,
        title: typeof completion.title === 'string' ? completion.title.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 120) : '',
      };
      const window = currentWindow();
      if (isSuppressed() || !allowedWindow(window) || visible.size >= MAX_VISIBLE) {
        deferred.set(messageId, normalized);
        watchLoadingWindow(window);
        return false;
      }
      deferred.delete(messageId);
      return showNotification(messageId, {
        title: completion.status === 'error' ? '任务异常结束 · Harness Gemini' : '任务已完成 · Harness Gemini',
        body: normalized.title || '点击查看对话', silent: true,
      }, normalized.sessionId);
    } catch {
      if (messageId) { seen.delete(messageId); release(messageId, true); }
      return false;
    }
  }

  async function test() {
    if (disposed || isSuppressed()) return { sent: false, reason: 'suppressed' };
    if (!Notification.isSupported()) return { sent: false, reason: 'unsupported' };
    const window = currentWindow();
    if (!allowedWindow(window)) return { sent: false, reason: 'unavailable' };
    if (Date.now() - lastTestAt < 3_000) return { sent: false, reason: 'throttled' };
    lastTestAt = Date.now();
    release('test', true);
    if (visible.size >= MAX_VISIBLE) return { sent: false, reason: 'unavailable' };
    return new Promise(resolve => {
      try {
        showNotification('test', {
          title: 'Harness Gemini · 系统通知测试',
          body: '正常完成和异常结束都会通过 Windows 提醒你，手动停止不提醒。点击返回工作台。', silent: true,
        }, undefined, resolve);
      } catch { resolve({ sent: false, reason: 'failed' }); }
    });
  }

  /** Resume both completion banners and click intents when suppression/loading ends. Queued
   * completions are removed one at a time, and drained as visible slots free up, never truncated. */
  function flushDeferred() {
    if (disposed || isSuppressed() || draining) return 0;
    draining = true;
    let shown = 0;
    try {
      flushPendingOpen();
      if (!isEnabled() || !Notification.isSupported()) { deferred.clear(); return 0; }
      for (const [messageId, completion] of deferred) {
        const window = currentWindow();
        if (isSuppressed() || !allowedWindow(window) || visible.size >= MAX_VISIBLE) {
          watchLoadingWindow(window);
          break;
        }
        deferred.delete(messageId);
        if (notify(completion)) shown++;
      }
      if (!pendingOpen && !deferred.size) clearLoadWatch();
      return shown;
    } finally { draining = false; }
  }

  function dispose() {
    disposed = true;
    deferred.clear();
    pendingOpen = undefined;
    clearLoadWatch();
    for (const messageId of [...visible.keys(), ...parked.keys()]) {
      const entry = visible.get(messageId) ?? parked.get(messageId);
      // Do not explicitly withdraw an already-shown protocol completion on normal shutdown:
      // its Action Center launch is precisely what permits opening a session after a cold start.
      // Pending/native/test notifications are closed because they have no independent session link.
      release(messageId, !(toastProtocol && messageId !== 'test' && entry?.shown));
    }
    seen.clear();
  }

  return { notify, test, dispose, flushDeferred, openSessionById };
}

export function installNotificationTestHandler({ ipcMain, getWindow, isOwnUrl, manager }) {
  ipcMain.handle(TEST_NOTIFICATION_CHANNEL, (event, ...args) => {
    const window = getWindow();
    if (args.length || !window || window.isDestroyed() || event?.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || !isOwnUrl(event.senderFrame?.url)) {
      return { sent: false, reason: 'unavailable' };
    }
    return manager.test();
  });
  return () => ipcMain.removeHandler(TEST_NOTIFICATION_CHANNEL);
}
