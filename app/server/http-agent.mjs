// A keep-alive-aware HTTP agent for model requests.
//
// Node's built-in fetch (undici) applies its own 300-second `bodyTimeout` and `headersTimeout` to
// every request. `bodyTimeout` measures the gap between two body chunks, so a Claude reply that
// spends five minutes thinking before its first visible token is killed by Node itself with
// `UND_ERR_BODY_TIMEOUT` ("terminated"), even though this app's own watchdog would have waited ten
// minutes. That is the interruption users see: the stream dies mid-thinking, not on a real error.
//
// The agent below turns that hidden ceiling off. Liveness is still policed, but by this app's own
// watchdogs in provider.mjs, which measure silence on the wire and report a reason in Chinese
// rather than a bare undici code. `headersTimeout` is left generous for the same reason: a gateway
// queueing a large request is not a dead one.
import { Agent } from 'undici';

/** How long to wait for response headers before giving up on a request that never started. */
const HEADERS_TIMEOUT = 300_000;

export const streamDispatcher = new Agent({
  // 0 disables the per-chunk body watchdog entirely; requestSignal owns the timeouts instead.
  bodyTimeout: 0,
  headersTimeout: HEADERS_TIMEOUT,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});
