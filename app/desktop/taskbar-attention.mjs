// 1.5.2/1.5.3: Windows' flash + error-progress states paint the taskbar button both as a
// highlighted (flashing) tile and with a red underline. This is an unread-message signal,
// NOT a task failure, and is independent of the toast setting.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = value => value && UUID.test(value.sessionId ?? '') && UUID.test(value.messageId ?? '')
  && ['chat', 'agent', 'image'].includes(value.mode) && ['done', 'error'].includes(value.status);

export function createTaskbarAttention({ getWindow, isSuppressed = () => false, platform = process.platform }) {
  const seen = new Set();
  let unread = false;
  let disposed = false;
  let attached;
  // Tracked separately: the underline and the flashing highlight are different OS states and
  // one of them may already be in the wanted state when the other is not.
  let painted = false;
  let flashed = false;
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
  /** Never steals focus: the tile flashes so the user can see it, the window stays where it is. */
  function paint(window, red) {
    if (!window || platform !== 'win32') return;
    try {
      if (painted !== red) {
        window.setProgressBar(red ? 1 : -1, red ? { mode: 'error' } : undefined);
        painted = red;
      }
      if (flashed !== red) {
        window.flashFrame(red);
        flashed = red;
      }
    } catch { /* Destroyed window / unsupported shell: never interrupt a completion. */ }
  }
  function detach() {
    for (const remove of listeners.splice(0)) remove();
    const window = currentWindow();
    if (window === attached) paint(window, false);
    attached = undefined;
    painted = false;
    flashed = false;
  }
  function attach() {
    const window = currentWindow();
    if (disposed || window === attached) return;
    detach();
    if (!window) return;
    attached = window;
    const refreshAfterEvent = () => {
      refresh();
      // Some native show/restore events precede the state transition.
      queueMicrotask(() => { if (!disposed && attached === window) refresh(); });
    };
    // Windows stops flashing on its own once the window is focused, but the underline is ours
    // to remove, so every path back to the foreground is checked here.
    for (const event of ['focus', 'show', 'restore']) {
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
      if (isSuppressed()) return false;
      if (foreground(window)) unread = false;
      paint(window, unread);
      return unread;
    } catch { return false; }
  }
  function notify(completion) {
    if (disposed || platform !== 'win32' || !valid(completion)) return false;
    const id = completion.messageId.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value);
    // A completion can arrive before the window exists or while a quit dialog is open.
    // Retain it until attach/refresh; do not depend on the OS delivering a toast.
    unread = true;
    attach();
    return refresh();
  }
  function dispose() {
    if (disposed) return;
    unread = false;
    detach();
    seen.clear();
    disposed = true;
  }
  return { notify, attach, refresh, dispose };
}
