// 1.4.1: a debugging connection is attached only while a command needs it, and
// dropped again once the page has been idle.
//
// Adapted from ZCode's browserGuestManager.ts (Apache-2.0; see
// third-party/ZCode-NOTICE.md), which releases its per-guest debugger 1.5s after
// the last command. A connection that stays up for the whole session is what
// Cloudflare's Turnstile rejects, so a screenshot must not leave one behind.
//
// Kept free of Electron imports so the idle timing can be exercised in tests.

export const DEBUGGER_IDLE_MS = 1_500;

/**
 * One debugging session per page. `attach` and `detach` come from the page's
 * own debugger; `now` and `schedule` are injected so tests need no timers.
 */
export function createDebuggerSession({ attach, detach, isAttached, now = () => Date.now(), schedule, idleMs = DEBUGGER_IDLE_MS } = {}) {
  let releaseAt = 0;
  let timer = null;

  function connected() {
    try { return isAttached() === true; } catch { return false; }
  }

  function drop() {
    timer = null;
    releaseAt = 0;
    try { if (connected()) detach(); } catch { /* The page already closed. */ }
  }

  let generation = 0;

  function arm() {
    // A newer command must win: the release scheduled by the previous one is
    // stale and has to be ignored, or it disconnects mid-command.
    if (timer && typeof timer.cancel === 'function') timer.cancel();
    const ticket = ++generation;
    releaseAt = now() + idleMs;
    timer = schedule(() => { if (ticket === generation) drop(); }, idleMs);
  }

  /** Run one command, connecting for it and disconnecting once the page is idle. */
  async function run(command) {
    const openedHere = !connected();
    if (openedHere) attach();
    try {
      return await command();
    } finally {
      if (openedHere || releaseAt) arm();
    }
  }

  function release() {
    if (timer && typeof timer.cancel === 'function') timer.cancel();
    drop();
  }

  return {
    run,
    release,
    /** When the connection is due to drop, or 0 when none is held. */
    pendingRelease: () => releaseAt,
  };
}
