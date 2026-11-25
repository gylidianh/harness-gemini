// A pending user action and an unread completion are independent. In the background,
// show the blue overlay first; a deferred completion still gets its original red underline.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = value => value && UUID.test(value.sessionId ?? '') && UUID.test(value.messageId ?? '')
  && ['chat', 'agent', 'image'].includes(value.mode) && ['done', 'error'].includes(value.status);

export function createTaskbarAttention({ getWindow, waitingIcon, isSuppressed = () => false, platform = process.platform }) {
  const seen = new Set();
  let unread = false;
  let waiting = false;
  let disposed = false;
  let attached;
  let painted = false;
  let flashed = false;
  let badged = false;
  const listeners = [];
  function currentWindow() {
    try {
      const window = getWindow();
      return window && !window.isDestroyed() && !window.webContents?.isDestroyed() ? window : null;
    } catch { return null; }
  }
  function foreground(window) {
    return window.isVisible() && !window.isMinimized() && window.isFocused();
  }
  /** Neither indicator activates the window. Keep the native states independent and idempotent. */
  function paint(window, blue, red) {
    if (!window || platform !== 'win32') return;
    if (painted !== red) {
      try { window.setProgressBar(red ? 1 : -1, red ? { mode: 'error' } : undefined); painted = red; } catch { /* Best effort. */ }
    }
    if (flashed !== red) {
      try { window.flashFrame(red); flashed = red; } catch { /* Best effort. */ }
    }
    if (badged !== blue) {
      try { window.setOverlayIcon(blue ? waitingIcon : null, blue ? '等待你的操作' : ''); badged = blue; } catch { /* Best effort. */ }
    }
  }
  function detach() {
    for (const remove of listeners.splice(0)) remove();
    if (attached && !attached.isDestroyed()) paint(attached, false, false);
    attached = undefined;
    painted = flashed = badged = false;
  }
  function attach() {
    const window = currentWindow();
    if (disposed || platform !== 'win32' || window === attached) return;
    detach();
    if (!window) return;
    attached = window;
    const refreshAfterEvent = () => {
      refresh();
      // Some native window events precede the corresponding state transition.
      queueMicrotask(() => { if (!disposed && attached === window) refresh(); });
    };
    for (const event of ['focus', 'blur', 'show', 'hide', 'restore', 'minimize']) {
      window.on(event, refreshAfterEvent);
      listeners.push(() => window.off(event, refreshAfterEvent));
    }
    const closed = () => { unread = false; detach(); };
    window.once('closed', closed);
    listeners.push(() => window.off('closed', closed));
    refresh();
  }
  function refresh() {
    if (disposed || platform !== 'win32') return false;
    const window = currentWindow();
    if (!window) return false;
    try {
      // Don't acknowledge an unread completion merely because a modal quit dialog is open.
      if (isSuppressed()) { paint(window, false, false); return false; }
      const background = !foreground(window);
      if (!background) unread = false;
      paint(window, background && waiting, background && !waiting && unread);
      return background && (waiting || unread);
    } catch { return false; }
  }
  function setWaiting(value) {
    if (disposed || platform !== 'win32' || typeof value !== 'boolean') return false;
    waiting = value;
    attach();
    return refresh();
  }
  function notify(completion) {
    if (disposed || platform !== 'win32' || !valid(completion)) return false;
    const id = completion.messageId.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value);
    unread = true;
    attach();
    return refresh();
  }
  function dispose() {
    if (disposed) return;
    waiting = unread = false;
    detach();
    seen.clear();
    disposed = true;
  }
  return { notify, setWaiting, attach, refresh, dispose };
}
