/**
 * 1.4.8: the two limits one connection may put on its own traffic.
 *
 * Ported from magpie — `internal/gateway/concurrency.go`, `internal/provider/concurrency.go`
 * and `internal/gateway/rpm.go` — where a provider's keys each get a lane:
 *
 *  - **Concurrency**: how many requests may be out at the vendor at once. A request that
 *    arrives over the limit waits in a first-in, first-out queue instead of being refused, so
 *    a free plan's two-at-once relay is used to the full rather than failing the third turn.
 *    The lane belongs to the connection, not to one conversation: a sub-agent and the parent
 *    that spawned it count against the same number.
 *  - **Requests a minute**: how many requests may leave in any rolling minute. A request over
 *    the limit waits until the oldest one in the window is a minute old, then goes.
 *
 * Both are counted where they matter: the concurrency slot covers one model request end to end
 * (including its retries, which reuse the slot), and the per-minute count covers every HTTP
 * request actually sent, retries included, because that is what the vendor bills and limits.
 *
 * 0 or a blank field is no limit, which is the default and the behaviour of every version
 * before this one.
 */
import { abortError } from './util.mjs';

/** Bound on how many requests one connection may keep waiting for a slot. */
const MAX_WAITERS = 200;
/** The rolling window a "requests a minute" limit is measured over. */
const WINDOW_MS = 60_000;

/** One connection's lane: who is out, who is waiting, and what was sent when. */
function laneFor(key) {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { active: 0, waiters: [], stamps: [] };
    lanes.set(key, lane);
  }
  return lane;
}
const lanes = new Map();

/** The key a connection's limits are counted under: its saved id, or none for a draft request. */
export function laneKey(settings) {
  return typeof settings?.profileId === 'string' && settings.profileId ? settings.profileId : '';
}

/** A limit as it is counted: a positive whole number, else 0 for none. */
function active(limit) {
  const value = Number(limit);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    // 1.5.6: remove the same listener on both success and cancellation.
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const done = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The next waiter is let out whenever a slot comes free. */
function drain(lane, limit) {
  while (lane.waiters.length && lane.active < limit) {
    const waiter = lane.waiters.shift();
    waiter.release();
  }
}

/**
 * Waits for one of the connection's slots and returns the function that gives it back. A
 * connection with no limit answers at once with a function that does nothing.
 */
export async function acquireConcurrency(settings, signal) {
  const key = laneKey(settings);
  const limit = active(settings?.maxConcurrency);
  if (!key || !limit) return () => {};
  const lane = laneFor(key);
  if (!lane.waiters.length && lane.active < limit) {
    lane.active += 1;
    return releaser(lane, limit);
  }
  if (lane.waiters.length >= MAX_WAITERS) throw new Error('这个连接的并发队列已排满，请稍后再试，或在连接设置中调高并发上限。');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const waiter = {
      release: () => {
        signal?.removeEventListener('abort', onAbort);
        lane.active += 1;
        resolve(releaser(lane, limit));
      },
    };
    const onAbort = () => {
      const at = lane.waiters.indexOf(waiter);
      if (at !== -1) lane.waiters.splice(at, 1);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    lane.waiters.push(waiter);
  });
}

/** Gives a slot back once, and lets the next waiting request in. */
function releaser(lane, limit) {
  let given = false;
  return () => {
    if (given) return;
    given = true;
    lane.active = Math.max(0, lane.active - 1);
    drain(lane, limit);
  };
}

/**
 * Waits until the connection may send one more request this minute, then counts it. Called once
 * per HTTP request that actually leaves, so a retried request is counted again as the vendor
 * sees it.
 */
export async function takeRate(settings, signal) {
  const key = laneKey(settings);
  const limit = active(settings?.maxRpm);
  if (!key || !limit) return;
  const lane = laneFor(key);
  for (;;) {
    if (signal?.aborted) throw abortError();
    const now = Date.now();
    while (lane.stamps.length && now - lane.stamps[0] >= WINDOW_MS) lane.stamps.shift();
    if (lane.stamps.length < limit) {
      lane.stamps.push(now);
      return;
    }
    // The oldest request in the window falls out of it a minute after it was sent.
    const wait = Math.min(WINDOW_MS, Math.max(50, WINDOW_MS - (now - lane.stamps[0]) + 25));
    await sleep(wait, signal);
  }
}

/** What one connection's lanes look like now, for the error log and for tests. */
export function laneSnapshot(settings) {
  const key = laneKey(settings);
  if (!key) return null;
  const lane = lanes.get(key);
  if (!lane) return { active: 0, waiting: 0, sentLastMinute: 0 };
  const now = Date.now();
  return {
    active: lane.active,
    waiting: lane.waiters.length,
    sentLastMinute: lane.stamps.filter(stamp => now - stamp < WINDOW_MS).length,
  };
}

/** Lets a stopped conversation out of the queue of every lane it was waiting in. */
export function forgetLanes() {
  lanes.clear();
}
