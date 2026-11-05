import { randomUUID } from 'node:crypto';
import { abortError, checkAbort, isObject, safeError } from './util.mjs';
import { REASONING_BODY_FIELDS, reasoningRequestVariants } from '../shared/reasoning-effort.mjs';
// Node's fetch applies a hidden 300s body watchdog of its own, which killed a thinking model's
// reply mid-stream; this agent replaces it with the watchdogs defined below.
import { providerFetch, errorCauseChain, hasPermanentFailure } from './http-agent.mjs';
// 1.4.8: a connection's own headers, extra body fields, proxy and limits.
import { withExtraBody, withExtraHeaders } from './provider-extra.mjs';
import { acquireConcurrency, takeRate } from './provider-limits.mjs';

const MAX_RESPONSE = 64 * 1024 * 1024;
const MAX_TOOL_ARGUMENTS = 256_000;
const ANTHROPIC_VERSION = '2023-06-01';
// The output ceiling a Claude reply is given. 8192 was too low for the way this app is used: a
// long answer hit it and stopped mid-sentence, which reads exactly like a broken connection. The
// historical value is kept as a fallback, because an older model or a strict gateway may only
// accept that much, and asking for room to write is not the same as asking for something
// unsupported: a rejection naming max_tokens is answered by lowering it instead of failing.
export const ANTHROPIC_MAX_TOKENS = 32_000;
export const ANTHROPIC_MAX_TOKENS_FALLBACK = 8_192;

// How long a trailing metadata frame may take after the reply itself was declared finished.
const TRAILING_REPORT_GRACE = 2_000;

// A reasoning model can spend many minutes thinking before it emits its first
// visible token, so a wall-clock limit on the whole request would abort a healthy
// reply. The watchdog below therefore measures silence: `touch()` is called for
// every byte the upstream sends. ZCode's product default for the same guard is a
// 600s SSE idle timeout, so that value is used here too.
//
// Any byte counts, not only recognised content: this harness talks straight to a
// user-configured endpoint, and thinking formats vary between gateways, so a byte
// on the wire is the one liveness signal that cannot be misread. The absolute
// ceiling is the backstop for a socket that only ever sends keep-alives.
const IDLE_TIMEOUT = 600_000;
const ABSOLUTE_TIMEOUT = 4 * 60 * 60_000;
// A connection that is up but silent looks exactly like a hang, so the window before the first
// content block gets its own guard: a minute without a token and without a tool call means the
// socket is dropped and the request is started again instead of the user waiting on a dead stream.
// A minute rather than ten seconds, because a Claude model with thinking enabled, and a gateway
// that is still queueing the request, both routinely stay quiet for longer than ten seconds.
// Calling that silence a failure is what made replies restart in the middle and then break: the
// watchdog fired, the request was re-sent, and the answer the reader had already started reading
// was thrown away. Once anything has arrived the guard is released and the long idle timeout above
// takes over, so a slow but healthy answer is never cut in half.
const FIRST_OUTPUT_TIMEOUT = 60_000;
// 1.3.3: a reasoning model that does not stream its thinking (OpenAI o-series, gpt-5 and similar)
// sends nothing at all while it thinks. A minute was routinely too short for a hard question: the
// request was dropped and re-sent from scratch, up to ten times, and never answered. When the
// request asks for reasoning, or the model is one that always reasons, the window is five minutes.
const REASONING_FIRST_OUTPUT_TIMEOUT = 300_000;
const ALWAYS_REASONING_MODELS = /(?:^|[/:])(?:o\d(?:-|$)|o\d-mini|gpt-5|gpt-oss)|deepseek-r1|reasoner|thinking|qwq/i;
/** How many times one request may be restarted while it has produced nothing. */
const OUTPUT_RETRIES = 10;
// fix3: a request that timed out waiting for its first output is most often a model thinking in
// silence, not a dead connection. Each retry therefore waits four times longer (up to the idle
// timeout), and only a few such retries are made: the same window was used for all ten before, so
// a model that needed more than the window could never answer however often it was asked again.
const SILENT_RETRIES = 3;
const SILENT_WINDOW_GROWTH = 4;
const SILENT_WINDOW_MAX = 600_000;
// A dropped connection (a relay resetting the socket, "fetch failed", undici's "terminated") is a
// different failure from a silent one: it is reported at once, so it gets its own, smaller budget
// and a short back-off between attempts instead of being thrown straight at the reader.
// 1.5.2: total attempts including the first one, i.e. 5 retries before giving up.
const TRANSPORT_RETRIES = 6;
const TRANSPORT_BACKOFF_MAX = 8_000;

/** The protocols a connection can speak. Old profiles default to Chat Completions. */
export const API_PROTOCOLS = ['chat', 'anthropic', 'responses'];
const PROTOCOLS = new Set(API_PROTOCOLS);

export function protocolOf(settings) {
  return PROTOCOLS.has(settings?.protocol) ? settings.protocol : 'chat';
}

/**
 * The endpoint one protocol lives at. The configured address is the API root
 * (usually ending in /v1), matching how Chat Completions was already addressed.
 */
export function endpointFor(baseUrl, protocol = 'chat') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (protocol === 'anthropic') return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  if (protocol === 'responses') return /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`;
  return `${base}/chat/completions`;
}

function modelsEndpoint(baseUrl, protocol) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (protocol !== 'chat' && !/\/v1$/.test(base)) return `${base}/v1/models`;
  return `${base}/models`;
}

export function requestSignal(signal, { idle = IDLE_TIMEOUT, absolute = ABSOLUTE_TIMEOUT, firstOutput = 0 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let idleTimer; let firstTimer; let absoluteTimer; let timedOut = null;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = 'idle'; controller.abort(); }, idle);
    idleTimer.unref?.();
  };
  // Armed before the first content block and disarmed by output(); it is the guard that turns
  // "connected but silent" into a fast, retryable failure rather than an indefinite wait.
  const armFirst = () => {
    if (!(firstOutput > 0)) return;
    clearTimeout(firstTimer);
    firstTimer = setTimeout(() => { timedOut = 'no_output'; controller.abort(); }, firstOutput);
    firstTimer.unref?.();
  };
  if (idle > 0) arm();
  armFirst();
  if (absolute > 0) { absoluteTimer = setTimeout(() => { timedOut = 'absolute'; abort(); }, absolute); absoluteTimer.unref?.(); }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    /** Any upstream byte counts as liveness, whether or not it carries content. */
    touch() { if (idle > 0 && timedOut === null) arm(); },
    /** The first token, reasoning fragment, or tool call: this request is demonstrably alive. */
    output() { clearTimeout(firstTimer); firstTimer = undefined; if (idle > 0 && timedOut === null) arm(); },
    cleanup() { clearTimeout(idleTimer); clearTimeout(firstTimer); clearTimeout(absoluteTimer); signal?.removeEventListener('abort', abort); },
  };
}

async function responseText(response, maximum = MAX_RESPONSE, onChunk) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('上游响应超出大小限制。');
      chunks.push(value);
      onChunk?.();
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/**
 * HTTP statuses that mean "busy or briefly unavailable", not "this request is wrong". The reply
 * has not started, so sending the same request again cannot duplicate any output.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
/** A 429 that means the account is out of quota will not recover by waiting. */
const PERMANENT_LIMIT = /insufficient[_ ]?quota|quota[_ ]?exceeded|exceeded your current quota|billing|credit balance|余额不足|欠费|额度已用完/i;
/** Retries for a transient HTTP status, on top of the first attempt. */
const HTTP_RETRIES = 5;
const HTTP_BACKOFF_MAX = 30_000;
const RETRY_AFTER_MAX = 60_000;

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_MAX) : null;
}

async function upstreamError(response, key) {
  let detail = '';
  try {
    const text = await responseText(response, 16_384);
    const body = JSON.parse(text);
    detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message ?? '';
  } catch { /* Never expose an HTML error page, response headers, or credentials. */ }
  const error = new Error(`上游接口返回 HTTP ${response.status}${detail ? `：${safeError(String(detail), key).slice(0, 500)}` : '。'}`);
  error.status = response.status;
  if (RETRYABLE_HTTP_STATUS.has(response.status) && !PERMANENT_LIMIT.test(String(detail))) {
    error.retryable = true;
    error.httpRetry = true;
    const wait = retryAfterMs(response);
    if (wait !== null) error.retryAfterMs = wait;
  }
  return error;
}

function headers(settings, stream = false, protocol = 'chat') {
  const base = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
  };
  if (!settings.apiKey) return withExtraHeaders(base, settings.headers, settings);
  // Anthropic and most Anthropic-compatible gateways read x-api-key; the Bearer
  // header is also sent because many local relays only understand that form.
  if (protocol === 'anthropic') {
    return withExtraHeaders({ ...base, 'x-api-key': settings.apiKey, 'anthropic-version': ANTHROPIC_VERSION, Authorization: `Bearer ${settings.apiKey}` }, settings.headers, settings);
  }
  // 1.4.8: the connection's own headers are applied last, after the key, so a private
  // gateway with its own auth scheme both keeps its place and can replace the Bearer form.
  return withExtraHeaders({ ...base, Authorization: `Bearer ${settings.apiKey}` }, settings.headers, settings);
}

/**
 * A rejection of the reasoning field itself.
 *
 * The reasoning level is chosen per connection, and a gateway may still refuse the spelling this
 * protocol uses — an older relay that only knows Chat Completions, or a model whose family matched
 * the version rule but which never enabled thinking. Recognising that specific refusal lets the
 * request be re-sent without the field instead of failing the turn.
 */
function rejectsReasoning(status, message) {
  if (![400, 422].includes(status)) return false;
  if (!/reasoning|thinking|thought/i.test(message)) return false;
  // 'requires' / 'must' / 'omit' / 'adaptive' cover the newer refusals that name the spelling the
  // model wants instead, e.g. 'requires adaptive thinking; omit thinking or use thinking.type=adaptive'.
  return /unrecognized|unknown|unsupported|not supported|does not support|not permitted|invalid|extra (?:field|input|parameter)|unexpected|not allowed|cannot|only|requires?|required|must|omit|adaptive|deprecated|no longer|budget_tokens|output_config|effort/i.test(message);
}

/** True when this body carries a reasoning field that could be dropped and re-sent. */
function hasReasoningField(body) {
  return Boolean(body && REASONING_BODY_FIELDS.some(field => field in body));
}

/** The body with every reasoning field removed, then the given spelling applied. */
function withReasoningVariant(body, variant) {
  const next = { ...body };
  for (const field of REASONING_BODY_FIELDS) delete next[field];
  return variant ? { ...next, ...variant } : next;
}

/**
 * Sends a request, and on a refusal of the reasoning field walks through the remaining spellings
 * (variants[1..]) before finally sending without any reasoning field. Each spelling is tried once,
 * so the worst case is variants.length + 1 requests, all rejected before generation started.
 * 'adjust(payload, variant)' lets a protocol fix fields that depend on the spelling (max_tokens).
 */
async function sendWithReasoningFallback({ body, variants, send, apiKey, signal, onNotice, adjust = payload => payload, extraRetry }) {
  let payload = body;
  let next = 1;
  // 1.3.3: a protocol-specific adjustment (Chat's stream_options, Anthropic's max_tokens and
  // tool_choice) may be needed more than once in a row, so it gets a small budget, not one try.
  let extraLeft = 3;
  let response = await send(payload);
  while (!response.ok) {
    const rejected = await upstreamError(response, apiKey);
    const extra = extraLeft > 0 ? extraRetry?.(response.status, rejected.message, payload) ?? null : null;
    const dropReasoning = !extra && rejectsReasoning(response.status, rejected.message) && hasReasoningField(payload);
    if (!dropReasoning && !extra) throw rejected;
    checkAbort(signal);
    if (extra) { payload = extra; extraLeft -= 1; }
    if (dropReasoning) {
      const variant = next < variants.length ? variants[next] : null;
      next += 1;
      payload = adjust(withReasoningVariant(payload, variant), variant);
      if (!variant) await onNotice?.({ message: DROPPED_REASONING_NOTE });
    }
    response = await send(payload);
  }
  return response;
}

/** What the user is told when their chosen level could not be used for this request. */
const DROPPED_REASONING_NOTE = '上游接口不接受本次的推理等级设置，已在这次请求中去掉该参数并重新发送，回答不受影响。可以在此连接的设置中把推理等级改回「使用模型默认值」。';

function rejectsStreamUsage(status, message) {
  // A validation rejection occurs before generation. Never retry quota/server
  // failures, partial replies, or unrelated 400 responses: they may have run.
  return [400, 422].includes(status)
    && /\b(?:stream_options|include_usage)\b/i.test(message)
    && /unrecognized|unknown|unsupported|not supported|does not support|not permitted|extra (?:field|input|parameter)|unexpected|not allowed/i.test(message);
}

/**
 * The names providers give the thinking a model produces before its answer. Gateways disagree,
 * so every common spelling is accepted: `reasoning_content` (DeepSeek and most
 * OpenAI-compatible gateways), `reasoning` (OpenRouter and friends), `thinking` /
 * `thinking_content` / `thought` (Claude-style relays and gateways that rename the field).
 */
const REASONING_FIELDS = [
  'reasoning_content', 'reasoning', 'thinking_content', 'thinking', 'thought', 'thoughts', 'reasoning_text',
];
/** Content-block types that carry thinking rather than the answer. */
const REASONING_TYPES = new Set(['thinking', 'thought', 'reasoning', 'analysis', 'reasoning_content']);

function isReasoningPart(part) {
  if (!isObject(part)) return false;
  // Gemini marks a thought part with a flag instead of a type.
  if (part.thought === true) return true;
  return typeof part.type === 'string' && REASONING_TYPES.has(part.type.toLowerCase());
}

/** One field's worth of thinking, in any of the shapes a gateway may send it in. */
function reasoningValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(reasoningValue).join('');
  if (!isObject(value)) return '';
  for (const key of ['text', 'content', 'thinking', 'thought', 'reasoning', 'reasoning_content', 'summary', 'delta']) {
    const nested = reasoningValue(value[key]);
    if (nested) return nested;
  }
  return '';
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    // A thinking block inside `content` belongs to the thinking chain, not to the answer.
    if (isReasoningPart(part)) return [];
    if (typeof part?.text === 'string') return [part.text];
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return [`\n![image](${part.image_url.url})\n`];
    return [];
  });
}

function contentText(content) {
  return textParts(content).join('');
}

/**
 * Reasoning (thinking) text a model streams before its answer. Providers disagree on the field
 * name and on the shape, so every common form is accepted: a plain string, an object carrying
 * `content`/`text`, a `reasoning_details` array, or a `content` array whose parts are typed
 * as thinking. An empty string means the provider sent no thinking at all, and the interface
 * then shows no thinking chain rather than an empty one.
 */
function reasoningParts(message) {
  if (!isObject(message)) return '';
  for (const field of REASONING_FIELDS) {
    const text = reasoningValue(message[field]);
    if (text) return text;
  }
  if (message.reasoning_details !== undefined) {
    const text = reasoningValue(message.reasoning_details);
    if (text) return text;
  }
  if (Array.isArray(message.content)) {
    const text = message.content.filter(isReasoningPart).map(reasoningValue).join('');
    if (text) return text;
  }
  return '';
}

function mergeUsage(previous, incoming) {
  if (!isObject(incoming)) return previous;
  const merged = { ...(previous || {}), ...incoming };
  const prompt = Number.isFinite(merged.prompt_tokens) ? merged.prompt_tokens : Number.isFinite(merged.input_tokens) ? merged.input_tokens : null;
  const completion = Number.isFinite(merged.completion_tokens) ? merged.completion_tokens : Number.isFinite(merged.output_tokens) ? merged.output_tokens : null;
  // 1.3.3: a field the upstream never reported stays absent. Filled in as 0, a missing output
  // count read as "the model wrote nothing" and the speed readout showed 0 instead of an estimate.
  if (prompt !== null) merged.prompt_tokens = prompt;
  if (completion !== null) merged.completion_tokens = completion;
  else delete merged.completion_tokens;
  merged.total_tokens = Number.isFinite(incoming.total_tokens) ? incoming.total_tokens : (prompt ?? 0) + (completion ?? 0);
  return merged;
}

/**
 * 1.2.6-usage-fix: Anthropic reports `input_tokens` as only the *uncached* part of the prompt;
 * cache reads and cache writes arrive in their own fields. The whole prompt is the sum of all
 * three, which is what the OpenAI-compatible `prompt_tokens` means. Counting only
 * `input_tokens` made the context readout collapse to a few hundred tokens and pinned the cache
 * hit rate at 100%.
 *
 * A later `message_delta` may repeat the input fields as zeros (or omit them); it must not wipe
 * out the prompt size that `message_start` already reported for the same request.
 */
function anthropicUsage(value, previous = null) {
  if (!isObject(value)) return null;
  const mapped = {};
  const uncached = Number.isFinite(value.input_tokens) ? value.input_tokens : null;
  const cacheRead = Number.isFinite(value.cache_read_input_tokens) ? value.cache_read_input_tokens : null;
  const cacheWrite = Number.isFinite(value.cache_creation_input_tokens) ? value.cache_creation_input_tokens : null;
  if (uncached !== null || cacheRead !== null || cacheWrite !== null) {
    const prompt = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    const known = Number.isFinite(previous?.prompt_tokens) ? previous.prompt_tokens : 0;
    if (prompt > 0 || known === 0) {
      mapped.prompt_tokens = prompt;
      mapped.prompt_tokens_details = { cached_tokens: cacheRead ?? 0 };
      if (cacheWrite) mapped.cache_creation_input_tokens = cacheWrite;
    }
  }
  if (Number.isFinite(value.output_tokens)) mapped.completion_tokens = value.output_tokens;
  if (!Object.keys(mapped).length) return null;
  return mapped;
}

function responsesUsage(value) {
  if (!isObject(value)) return null;
  const mapped = {};
  if (Number.isFinite(value.input_tokens)) mapped.prompt_tokens = value.input_tokens;
  if (Number.isFinite(value.output_tokens)) mapped.completion_tokens = value.output_tokens;
  if (Number.isFinite(value.total_tokens)) mapped.total_tokens = value.total_tokens;
  if (!Object.keys(mapped).length) return null;
  const cached = Number(value.input_tokens_details?.cached_tokens) || 0;
  const reasoning = Number(value.output_tokens_details?.reasoning_tokens) || 0;
  if (cached) mapped.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning) mapped.completion_tokens_details = { reasoning_tokens: reasoning };
  return mapped;
}

/**
 * True only when the upstream declared a JSON body.
 *
 * Everything else is read as an event stream. Relays regularly answer a streaming request with
 * text/plain, or with no content type at all, and treating one of those as a JSON body failed a
 * turn whose reply was arriving perfectly well.
 */
function isJsonResponse(response) {
  return (response.headers.get('content-type')?.toLowerCase() ?? '').includes('json');
}

/**
 * Reads one event stream and hands every packet to onPacket, returning whether the upstream ever
 * declared the end of the reply.
 *
 * Written for what a relay actually sends rather than for what the specification allows:
 *
 * - Comment and keep-alive lines (a leading colon) are ignored instead of being parsed.
 * - A data field with nothing after it is a heartbeat, not a JSON error. It used to be handed to
 *   JSON.parse as an empty string, which failed the whole turn on a live connection.
 * - An event name is carried onto a payload that does not name its own type, because some relays
 *   send the type only in the event field.
 * - A payload that cannot be parsed is skipped rather than thrown, so one malformed frame cannot
 *   destroy an answer that is still arriving.
 * - A payload is not expected to be JSON at all unless it starts like JSON, which keeps a relay's
 *   plain-text error line from being read as a packet.
 *
 * onPacket may answer 'done' to finish reading immediately (the reply is over and the socket may
 * be held open afterwards) or 'complete' to record that the reply was declared finished while
 * still reading any trailing metadata, such as the usage report OpenAI-compatible gateways send
 * after the finish reason.
 */
async function streamPackets(response, timeout, onPacket) {
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let data = []; let event = ''; let received = 0; let completed = false; let stopped = false;
  // How long the trailing metadata may take once the reply itself is declared finished.
  let graceTimer; let graceExpired;
  const grace = new Promise(resolve => { graceExpired = resolve; });
  const dispatch = async () => {
    if (!data.length && !event) return;
    const text = data.join('\n'); const name = event;
    data = []; event = '';
    if (text.trim() === '[DONE]') { completed = true; stopped = true; return; }
    if (!text.trim()) {
      // A heartbeat frame: a bare event name, or a data field with nothing after it. Liveness was
      // already recorded by touch(), and there is nothing to parse.
      if (name === 'error') throw new Error('上游在流中途发送了一个空的错误事件。');
      return;
    }
    const looksJson = text.startsWith('{') || text.startsWith('[');
    if (!looksJson) return;
    let packet;
    try { packet = JSON.parse(text); } catch { return; }
    if (name && name !== 'message' && isObject(packet) && packet.type === undefined && packet.error === undefined) packet.type = name;
    const verdict = await onPacket(packet);
    if (verdict === 'done') { completed = true; stopped = true; }
    else if (verdict === 'complete' && !completed) {
      // The reply is finished, but a trailing report may still be coming. Keep reading for a
      // moment, and stop waiting if the upstream prefers to hold the socket open instead.
      completed = true;
      graceTimer = setTimeout(() => { stopped = true; graceExpired(); }, TRAILING_REPORT_GRACE);
      graceTimer.unref?.();
    }
  };
  const line = async value => {
    const normalized = value.endsWith('\r') ? value.slice(0, -1) : value;
    if (!normalized) return dispatch();
    if (normalized.startsWith(':')) return;
    if (normalized.startsWith('event:')) { event = normalized.slice(6).trim(); return; }
    if (normalized.startsWith('data:')) data.push(normalized.slice(5).replace(/^ /, ''));
  };
  try {
    while (!stopped) {
      // Once the reply is finished, the read races the grace window, so a socket that is kept open
      // afterwards cannot stall a turn whose answer has already arrived in full.
      const next = completed ? await Promise.race([reader.read(), grace.then(() => null)]) : await reader.read();
      if (next === null) break;
      const { value, done } = next;
      if (done) { pending += decoder.decode(); break; }
      received += value.byteLength;
      timeout.touch();
      if (received > MAX_RESPONSE) throw new Error('上游回复超过 64 MB，已停止接收。');
      pending += decoder.decode(value, { stream: true });
      // 1.3.3: the event-stream format allows CRLF, LF and a bare CR as line ends. A relay that used
      // bare CR was never read at all: no line ever ended, so the reply looked empty and the same
      // request was sent ten times. A CR at the very end may still be the first half of a CRLF.
      for (;;) {
        const match = /\r\n|\r|\n/.exec(pending);
        if (!match || (match[0] === '\r' && match.index === pending.length - 1)) break;
        const current = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        await line(current);
        if (stopped) break;
      }
    }
    if (!stopped) {
      for (const rest of pending.split(/\r\n|\r|\n/)) { if (stopped) break; await line(rest); }
      if (!stopped) await dispatch();
    }
  } finally { clearTimeout(graceTimer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { completed };
}

function callId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value || '') ? value : `call_${randomUUID().replaceAll('-', '')}`;
}

function toolCall(name, args, id) {
  const argumentsText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  if (argumentsText.length > MAX_TOOL_ARGUMENTS) throw new Error('工具请求超出大小限制。');
  return { id: callId(id), type: 'function', function: { name: String(name || 'unknown').slice(0, 256), arguments: argumentsText } };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

/**
 * Replays stored thinking as `reasoning_content`, the field DeepSeek and most
 * OpenAI-compatible gateways accept back. A gateway that does not understand it ignores it;
 * an assistant turn without stored thinking is sent unchanged.
 */
function withChatReasoning(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    if (message?.role !== 'assistant') return message;
    // Anthropic thinking blocks are only meaningful to the Messages API.
    const { thinking_blocks: _blocks, ...plain } = message;
    if (typeof plain.reasoning !== 'string' || !plain.reasoning) return plain;
    const { reasoning, ...rest } = plain;
    return { ...rest, reasoning_content: reasoning };
  });
}

async function chatCompletion({ settings, model, messages, tools, stream = true, signal, onText, onReasoning, onUsage, onNotice, firstOutput = 0, toolChoice = 'auto' }) {
  // A non-streaming request sends nothing until the whole answer exists, so the first-output
  // guard only applies to a stream; otherwise a slow image or title request would be killed.
  const timeout = requestSignal(signal, { firstOutput: stream ? firstOutput : 0 });
  // The configured reasoning level only reaches a model that accepts one; a plain chat model
  // gets no such field at all, because an unknown parameter is rejected outright.
  const reasoningVariants = reasoningRequestVariants(settings.reasoningEffort, model, 'chat');
  const body = { model, messages: withChatReasoning(messages), stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(tools?.length ? { tools, tool_choice: toolChoice === 'none' ? 'none' : 'auto' } : {}), ...(reasoningVariants[0] ?? {}) };
  const calls = new Map(); let finishReason = null; let usage;
  // IDs identify a call across chunks; packet positions are used only for a stable group.
  const callSlots = new Map();
  const startsNewCall = (current, name) => {
    if (!current?.function?.name) return false;
    if (current.function.name !== name) return true;
    const text = String(current.function.arguments ?? '').trim();
    if (!text) return false;
    try { JSON.parse(text); return true; } catch { return false; }
  };
  let positionalSlots = [];
  let sequentialSlot = null;
  const updateCalls = (items, delta) => {
    if (!Array.isArray(items) || !items.length) return;
    const packetSlots = [];
    const callsAtStart = calls.size;
    for (const [position, incoming] of items.entries()) {
      if (!isObject(incoming)) continue;
      const id = typeof incoming.id === 'string' ? incoming.id : '';
      let index;
      if (Number.isInteger(incoming.index)) index = incoming.index;
      else if (!delta) index = position;
      else if (id && callSlots.has(id)) index = callSlots.get(id);
      else if (id) index = calls.size ? Math.max(...calls.keys()) + 1 : 0;
      else if (items.length > 1 && positionalSlots.length === items.length) index = positionalSlots[position];
      else if (items.length > 1 && !id && callsAtStart === 0) index = position;
      // fix3: a fragment that names a function starts a new call when the call it would continue
      // already has its name and either a different name or complete JSON arguments. This used to
      // apply only while one call existed, so a third call (and a repeat of the same tool) was
      // glued onto the second.
      else if (calls.size && !id && typeof incoming.function?.name === 'string' && incoming.function.name
        && startsNewCall(calls.get(sequentialSlot ?? Math.max(...calls.keys())), incoming.function.name)) index = Math.max(...calls.keys()) + 1;
      else if (calls.size === 1) index = calls.keys().next().value;
      else if (items.length === 1 && sequentialSlot !== null) index = sequentialSlot;
      else if (!calls.size) index = position;
      else throw new Error('上游工具分片缺少 index 和 id，无法确定它属于哪个并行调用；已停止而未执行这些调用。');
      if (!Number.isInteger(index) || index < 0 || index >= 16) throw new Error('一次回复请求的工具过多或序号无效。');
      const existing = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (id) {
        // Indexed streams may split their id; unindexed IDs are whole identifiers by definition.
        existing.id = delta && Number.isInteger(incoming.index) && existing.id && existing.id !== id ? existing.id + id : id;
        callSlots.set(existing.id, index);
        callSlots.set(id, index);
      }
      const fn = incoming.function;
      if (typeof fn?.name === 'string' && fn.name) existing.function.name = delta && existing.function.name && existing.function.name !== fn.name ? existing.function.name + fn.name : fn.name;
      if (typeof fn?.arguments === 'string') existing.function.arguments = delta ? existing.function.arguments + fn.arguments : fn.arguments;
      else if (isObject(fn?.arguments)) existing.function.arguments = JSON.stringify(fn.arguments);
      if (existing.function.arguments.length > MAX_TOOL_ARGUMENTS || existing.function.name.length > 256 || existing.id.length > 256) throw new Error('工具请求超出大小限制。');
      calls.set(index, existing);
      packetSlots[position] = index;
    }
    if (items.length > 1) { positionalSlots = packetSlots; sequentialSlot = null; }
    else if (packetSlots.length) sequentialSlot = packetSlots[0];
  };
  let sawContent = false;
  const consume = async (packet, delta) => {
    if (packet?.error) throw upstreamStreamError(packet.error, { produced: sawContent, key: settings.apiKey });
    if (packet?.usage) { usage = packet.usage; await onUsage?.(usage); }
    const choice = packet?.choices?.[0];
    if (!choice) return packet?.usage && finishReason !== null ? 'done' : undefined;
    const message = delta ? choice.delta : choice.message;
    // 1.3.3: the first chunk of almost every OpenAI-compatible stream is role + content "". That
    // empty string used to count as output, which turned off the retry for a connection that broke
    // before any real text and released the first-output watchdog straight away.
    const parts = textParts(message?.content).filter(text => typeof text === 'string' && text !== '');
    for (const text of parts) { sawContent = true; checkAbort(signal); await onText?.(text); }
    const reasoning = reasoningParts(message);
    if (reasoning) { sawContent = true; checkAbort(signal); await onReasoning?.(reasoning); }
    // A tool call is content too: a model that only asks for a tool has not gone silent.
    if (parts.length || reasoning || (Array.isArray(message?.tool_calls) && message.tool_calls.length)) { sawContent = true; timeout.output(); }
    updateCalls(message?.tool_calls, delta);
    // A finish reason ends the reply, so a gateway that never sends the [DONE] sentinel is still
    // understood. The usage report arrives after it, so reading stops only once that has landed;
    // a gateway that sends no report ends the socket instead and is completed on the way out.
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finishReason = choice.finish_reason;
      // 1.3.3-fix2: usage from an earlier chunk may not be the final report; wait briefly for it.
      return packet?.usage ? 'done' : 'complete';
    }
    return usage !== undefined && finishReason !== null ? 'done' : undefined;
  };
  try {
    const url = endpointFor(settings.baseUrl, 'chat');
    // 1.4.8: every attempt goes through this connection's proxy, carries its extra headers,
    // has its extra body fields merged in, and counts against its requests-a-minute limit.
    const request = async payload => {
      await takeRate(settings, timeout.signal);
      return providerFetch(url, {
        method: 'POST', headers: headers(settings, stream, 'chat'), body: JSON.stringify(withExtraBody(payload, settings)), signal: timeout.signal, redirect: 'error', 
      }, settings);
    };
    // Two optional things may be refused by an endpoint that otherwise accepts the request: the
    // usage report, and the reasoning spelling. The usage report is dropped once; the reasoning
    // field first falls back to a stricter spelling and only then is dropped, so a strict gateway
    // costs a note instead of the whole answer.
    const response = await sendWithReasoningFallback({
      body, variants: reasoningVariants, send: request, apiKey: settings.apiKey, signal, onNotice,
      extraRetry: (status, message, payload) => {
        if (!stream || !('stream_options' in payload) || !rejectsStreamUsage(status, message)) return null;
        const { stream_options: _usage, ...rest } = payload;
        return rest;
      },
    });
    timeout.touch();
    if (!isJsonResponse(response)) {
      const { completed } = await streamPackets(response, timeout, packet => consume(packet, true));
      if (!completed) throw incompleteStreamError({ produced: sawContent });
    } else {
      let packet;
      try { packet = JSON.parse(await responseText(response, MAX_RESPONSE, () => timeout.touch())); } catch (error) { throw new Error(`无法读取上游 JSON 回复：${safeError(error, settings.apiKey)}`); }
      await consume(packet, false);
    }
    checkAbort(signal);
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      ...call, id: callId(call.id),
    }));
    return { toolCalls, finishReason, usage };
  } catch (error) {
    throw completionError(error, { signal, timeout, key: settings.apiKey });
  } finally { timeout.cleanup(); }
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicImagePart(part) {
  const url = part?.image_url?.url;
  if (typeof url !== 'string' || !url) return null;
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function anthropicContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (typeof part?.text === 'string') return [{ type: 'text', text: part.text }];
    if (part?.type === 'image_url') {
      const image = anthropicImagePart(part);
      return image ? [image] : [];
    }
    return [];
  });
}

function anthropicMessages(messages) {
  const system = messages.filter(message => message.role === 'system').map(message => contentText(message.content)).filter(Boolean).join('\n\n');
  const turns = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = turns.at(-1);
    // Anthropic requires user/assistant alternation; tool results are user turns and
    // consecutive same-role turns are merged instead of rejected by the endpoint.
    if (last?.role === role) last.content.push(...parts);
    else turns.push({ role, content: [...parts] });
  };
  for (const message of messages) {
    if (!message || message.role === 'system') continue;
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: contentText(message.content) || ' ' }]);
      continue;
    }
    if (message.role === 'assistant') {
      // With thinking on, a tool-use turn must be replayed with the thinking blocks (and their
      // signatures) that preceded it, or the Messages API refuses the follow-up request.
      const parts = anthropicThinkingBlocks(message.thinking_blocks);
      const text = contentText(message.content);
      if (text) parts.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
        parts.push({ type: 'tool_use', id: String(call.id || ''), name: String(call.function?.name || 'unknown'), input: isObject(input) ? input : {} });
      }
      push('assistant', parts);
      continue;
    }
    const parts = anthropicContent(message.content);
    push('user', parts.length ? parts : [{ type: 'text', text: ' ' }]);
  }
  // The Messages API rejects a conversation that opens with an assistant turn.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length) turns.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  return { system, messages: turns };
}

/** Signed thinking blocks kept from an Anthropic reply, in the exact shape the API returned. */
function anthropicThinkingBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap(block => {
    if (block?.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
      return [{ type: 'thinking', thinking: String(block.thinking || ''), signature: block.signature }];
    }
    if (block?.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
      return [{ type: 'redacted_thinking', data: block.data }];
    }
    return [];
  });
}

function anthropicTools(tools) {
  return (tools || []).filter(tool => tool?.function?.name).map(tool => ({
    name: String(tool.function.name).slice(0, 256),
    description: tool.function.description || '',
    input_schema: isObject(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
  }));
}

/** Output limits Anthropic documents below the default request (Claude Opus 4 and 4.1: 32,000). */
const CLAUDE_32K_OUTPUT = [/claude-opus-4(?:[.\-]1)?(?:[.\-]\d{8}|(?![.\-]?\d))/i, /claude-4(?:[.\-]1)?-opus/i];
export function anthropicOutputLimit(model) {
  const name = String(model ?? '');
  return CLAUDE_32K_OUTPUT.some(pattern => pattern.test(name)) ? 32_000 : null;
}

function anthropicStopReason(reason) {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'stop_sequence' || reason === 'end_turn') return 'stop';
  return reason || null;
}

async function anthropicCompletion({ settings, model, messages, tools, stream = true, signal, onText, onReasoning, onUsage, onNotice, firstOutput = 0, toolChoice = 'auto' }) {
  const timeout = requestSignal(signal, { firstOutput: stream ? firstOutput : 0 });
  // Declared here, before anything reads it: the request body below is built with maxTokensFor().
  let maxTokensCeiling = ANTHROPIC_MAX_TOKENS;
  const { system, messages: turns } = anthropicMessages(messages);
  const requestTools = anthropicTools(tools);
  // Extended thinking is opt-in on the Messages API. Newer Claude takes the adaptive form
  // (`thinking.type=adaptive` + `output_config.effort`); older Claude takes a token budget, which
  // has to stay below max_tokens, so the ceiling is raised only for that spelling.
  const reasoningVariants = reasoningRequestVariants(settings.reasoningEffort, model, 'anthropic');
  const thinking = reasoningVariants[0] ?? {};
  // fix3: a model whose output limit is known gets a request that fits it from the start (the
  // thinking budget stays below max_tokens), instead of a guaranteed first refusal.
  const knownLimit = anthropicOutputLimit(model);
  const maxTokensFor = variant => {
    const total = maxTokensCeiling + (Number(variant?.thinking?.budget_tokens) || 0);
    return knownLimit ? Math.min(total, knownLimit) : total;
  };
  const body = {
    model,
    max_tokens: maxTokensFor(thinking),
    messages: turns,
    stream,
    // 1.5.0: Anthropic supports string and text-block system forms, but the tested AnyRouter
    // gateway rejects our string form with 503. Use text blocks for relay compatibility;
    // preserve the exact system text and ordering. No Claude Code identity/cloak is injected.
    ...(system ? { system: [{ type: 'text', text: system }] } : {}),
    ...(requestTools.length ? { tools: requestTools } : {}),
    // 1.3.3: a request whose history holds tool_use blocks must define tools, so a turn that must
    // not call any (a sub-agent's last round) sends them with tool_choice none instead of none at all.
    ...(requestTools.length && toolChoice === 'none' ? { tool_choice: { type: 'none' } } : {}),
    ...thinking,
  };
  const calls = []; const blocks = new Map(); const finished = new Set(); let finishReason = null; let usage = null;
  // Whether anything has actually reached the caller. It decides whether an interrupted stream may
  // simply be started again, or must be reported as a reply that is already half delivered.
  let sawContent = false;
  const recordUsage = async value => {
    const mapped = anthropicUsage(value, usage);
    if (!mapped) return;
    usage = mergeUsage(usage, mapped);
    await onUsage?.(usage);
  };
  const addBlock = async (index, block) => {
    if (!block) return;
    blocks.set(index, { type: block.type, id: block.id, name: block.name, json: '', input: block.input, thinking: block.thinking || '', signature: block.signature || '', data: block.data || '' });
    if (block.type === 'text' && block.text) { sawContent = true; checkAbort(signal); await onText?.(block.text); }
    if (block.type === 'thinking' && block.thinking) { sawContent = true; checkAbort(signal); await onReasoning?.(block.thinking); }
  };
  const finishBlock = index => {
    const block = blocks.get(index);
    if (block?.type !== 'tool_use' || finished.has(index)) return;
    finished.add(index);
    const argumentsText = block.json || JSON.stringify(block.input ?? {});
    calls.push(toolCall(block.name, argumentsText, block.id));
  };
  const consume = async packet => {
    // An error event arrives after HTTP 200. An overloaded_error before any content is a busy
    // server, not a bad request, so it is worth another attempt; one that arrives after text has
    // streamed must not be replayed, and is reported as it stands.
    if (packet?.type === 'error') throw upstreamStreamError(packet.error ?? packet, { produced: sawContent, key: settings.apiKey });
    if (packet?.error) throw upstreamStreamError(packet.error, { produced: sawContent, key: settings.apiKey });
    if (packet?.type === 'message_start') {
      if (packet.message?.usage) {
        // fix3: the output count at the start is a placeholder (1 on the official API). Kept, a
        // relay that never reports the final count showed a speed of about 1 token per second.
        const { output_tokens: placeholder, ...start } = packet.message.usage;
        await recordUsage(Number(placeholder) > 8 ? packet.message.usage : start);
      }
      return;
    }
    if (packet?.type === 'content_block_start') {
      // A thinking block can open and then stay quiet for a while; opening it already proves
      // the request is being served, so the first-output guard is released here too.
      timeout.output();
      await addBlock(packet.index ?? 0, packet.content_block);
      return;
    }
    if (packet?.type === 'content_block_delta') {
      const block = blocks.get(packet.index ?? 0);
      const delta = packet.delta || {};
      if (delta.type === 'text_delta' && delta.text) { sawContent = true; timeout.output(); checkAbort(signal); await onText?.(delta.text); }
      else if (delta.type === 'thinking_delta' && delta.thinking) {
        sawContent = true;
        timeout.output();
        if (block) block.thinking += delta.thinking;
        checkAbort(signal); await onReasoning?.(delta.thinking);
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        if (block) block.signature += delta.signature;
      }
      else if (delta.type === 'input_json_delta') {
        if (!block) return;
        sawContent = true;
        timeout.output();
        block.json += delta.partial_json || '';
        if (block.json.length > MAX_TOOL_ARGUMENTS) throw new Error('工具请求超出大小限制。');
      }
      return;
    }
    if (packet?.type === 'content_block_stop') { finishBlock(packet.index ?? 0); return; }
    if (packet?.type === 'message_delta') {
      if (packet.delta?.stop_reason) finishReason = anthropicStopReason(packet.delta.stop_reason);
      if (packet.usage) await recordUsage(packet.usage);
      // A stop reason ends the reply: only message_stop follows, and it carries no content. A
      // relay that never forwards message_stop is therefore still read as finished.
      return finishReason === null ? undefined : 'done';
    }
    // The declared end of the reply. Treating it as the end, rather than waiting for the socket to
    // close, is also what stops a relay that holds the connection open afterwards from hanging.
    if (packet?.type === 'message_stop') return 'done';
    return undefined;
  };
  // 1.4.8: proxy, extra headers, extra body fields and the requests-a-minute limit, per attempt.
  const send = async payload => {
    await takeRate(settings, timeout.signal);
    return providerFetch(endpointFor(settings.baseUrl, 'anthropic'), {
      method: 'POST', headers: headers(settings, stream, 'anthropic'), body: JSON.stringify(withExtraBody(payload, settings)), signal: timeout.signal, redirect: 'error', 
    }, settings);
  };
  try {
    // The raised max_tokens exists only to leave room for a thinking budget, so it follows the
    // spelling being tried and returns to the standard ceiling when thinking is dropped.
    const response = await sendWithReasoningFallback({
      body, variants: reasoningVariants, send, apiKey: settings.apiKey, signal, onNotice,
      adjust: (payload, variant) => ({ ...payload, max_tokens: maxTokensFor(variant) }),
      // A model or gateway that accepts only the historical ceiling is answered by lowering it,
      // instead of failing a turn whose only problem was asking for room to write.
      extraRetry: (status, message, payload) => {
        // A relay that does not know tool_choice none: the request is sent without it, and the
        // caller ignores any tool call the model makes anyway.
        if ([400, 422].includes(status) && payload.tool_choice && /tool_choice/i.test(message)) {
          const { tool_choice: _choice, ...rest } = payload;
          return rest;
        }
        if (!rejectsMaxTokens(status, message)) return null;
        // 1.3.3: claude-opus-4 / 4.1 with a high thinking budget asked for 8,192 + 24,576 = 32,768
        // after the first refusal, which is still above their 32,000 limit, and the turn failed.
        // The limit the upstream names is used directly, and the thinking budget shrinks with it.
        const limit = outputTokenLimit(message);
        const budget = Number(payload?.thinking?.budget_tokens) || 0;
        if (limit && payload.max_tokens > limit) {
          const nextBudget = budget ? Math.max(1_024, Math.min(budget, limit - 4_096)) : 0;
          maxTokensCeiling = Math.max(1_024, limit - nextBudget);
          return { ...payload, max_tokens: limit, ...(budget ? { thinking: { ...payload.thinking, budget_tokens: nextBudget } } : {}) };
        }
        if (maxTokensCeiling === ANTHROPIC_MAX_TOKENS_FALLBACK) {
          // fix3: a refusal that names no limit, with a thinking budget still large: the budget
          // itself shrinks once (8,192 + 4,096), which fits every Claude that thinks.
          if (budget > 4_096) return { ...payload, max_tokens: ANTHROPIC_MAX_TOKENS_FALLBACK + 4_096, thinking: { ...payload.thinking, budget_tokens: 4_096 } };
          return null;
        }
        maxTokensCeiling = ANTHROPIC_MAX_TOKENS_FALLBACK;
        return { ...payload, max_tokens: maxTokensFor(payload) };
      },
    });
    timeout.touch();
    if (!isJsonResponse(response)) {
      // A relay that answers with text/plain, or with no content type at all, is still sending an
      // event stream; reading it as a JSON body failed a reply that was arriving fine.
      const { completed } = await streamPackets(response, timeout, consume);
      if (!completed) throw incompleteStreamError({ produced: sawContent });
      // 1.3.3: a relay that drops content_block_stop used to lose every tool call of the reply
      // (finish reason tool_calls, no calls). Blocks still open at the end are completed here.
      for (const index of [...blocks.keys()].sort((a, b) => a - b)) finishBlock(index);
    } else {
      let packet;
      try { packet = JSON.parse(await responseText(response, MAX_RESPONSE, () => timeout.touch())); } catch (error) { throw new Error(`无法读取上游 JSON 回复：${safeError(error, settings.apiKey)}`); }
      for (const [index, block] of (packet.content || []).entries()) await addBlock(index, block);
      for (const index of blocks.keys()) finishBlock(index);
      if (packet.stop_reason) finishReason = anthropicStopReason(packet.stop_reason);
      if (packet.usage) await recordUsage(packet.usage);
    }
    checkAbort(signal);
    const thinkingBlocks = anthropicThinkingBlocks([...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block));
    return { toolCalls: calls, finishReason, usage, ...(thinkingBlocks.length ? { thinkingBlocks } : {}) };
  } catch (error) {
    throw completionError(error, { signal, timeout, key: settings.apiKey });
  } finally { timeout.cleanup(); }
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

function responsesContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap(part => {
    if (typeof part?.text === 'string') return [{ type: 'input_text', text: part.text }];
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      return [{ type: 'input_image', image_url: part.image_url.url }];
    }
    return [];
  });
  return parts.length ? parts : '';
}

function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'system') {
      input.push({ role: 'system', content: contentText(message.content) });
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || ''), output: contentText(message.content) || ' ' });
      continue;
    }
    if (message.role === 'assistant') {
      const text = contentText(message.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const call of message.tool_calls || []) {
        input.push({ type: 'function_call', call_id: String(call.id || ''), name: String(call.function?.name || 'unknown'), arguments: String(call.function?.arguments || '{}') });
      }
      continue;
    }
    const content = responsesContent(message.content);
    input.push({ role: 'user', content: content || ' ' });
  }
  return input;
}

function responsesTools(tools) {
  return (tools || []).filter(tool => tool?.function?.name).map(tool => ({
    type: 'function',
    name: String(tool.function.name).slice(0, 256),
    description: tool.function.description || '',
    parameters: isObject(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
  }));
}

function responsesReasoning(item) {
  if (!isObject(item)) return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.summary)) return item.summary.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('');
  if (Array.isArray(item.content)) return item.content.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('');
  return '';
}

async function responsesCompletion({ settings, model, messages, tools, stream = true, signal, onText, onReasoning, onUsage, onNotice, firstOutput = 0, toolChoice = 'auto' }) {
  const timeout = requestSignal(signal, { firstOutput: stream ? firstOutput : 0 });
  const requestTools = responsesTools(tools);
  const body = {
    model,
    input: responsesInput(messages),
    stream,
    store: false,
    ...(requestTools.length ? { tools: requestTools, tool_choice: toolChoice === 'none' ? 'none' : 'auto' } : {}),
    ...(reasoningRequestVariants(settings.reasoningEffort, model, 'responses')[0] ?? {}),
  };
  const calls = new Map(); let finishReason = null; let usage = null;
  let sawContent = false;
  const recordUsage = async value => {
    const mapped = responsesUsage(value);
    if (!mapped) return;
    usage = mergeUsage(usage, mapped);
    await onUsage?.(usage);
  };
  const upsertCall = (item, extra = {}) => {
    if (!item) return null;
    const key = item.id || item.call_id || randomUUID();
    const existing = calls.get(key) || { id: item.call_id || item.id, name: item.name, arguments: '' };
    if (item.call_id) existing.id = item.call_id;
    if (item.name) existing.name = item.name;
    if (typeof item.arguments === 'string' && item.arguments) existing.arguments = item.arguments;
    existing.arguments += extra.arguments || '';
    if (existing.arguments.length > MAX_TOOL_ARGUMENTS) throw new Error('工具请求超出大小限制。');
    calls.set(key, existing);
    return existing;
  };
  const consume = async packet => {
    if (!packet?.type) return;
    if (packet.type === 'error' || packet.type === 'response.failed') {
      // 1.3.3: the official error event carries code and message at the top level; reading only
      // packet.error lost the reason ("上游回复失败。") and the chance to retry a rate limit.
      const topLevel = packet.type === 'error' && (packet.message || packet.code) ? { type: packet.code ?? packet.type, message: packet.message ?? packet.code } : null;
      throw upstreamStreamError(packet.error ?? topLevel ?? packet.response?.error ?? { message: '上游回复失败。' }, { produced: sawContent, key: settings.apiKey });
    }
    // The upstream has demonstrably started on this request; a reasoning model may now think in
    // silence for minutes, so the first-output guard is released.
    if (packet.type === 'response.in_progress' || packet.type === 'response.output_item.added') timeout.output();
    if (packet.type === 'response.output_text.delta') {
      if (packet.delta) { sawContent = true; timeout.output(); checkAbort(signal); await onText?.(packet.delta); }
      return undefined;
    }
    if (packet.type === 'response.reasoning_summary_text.delta' || packet.type === 'response.reasoning_text.delta') {
      if (packet.delta) { sawContent = true; timeout.output(); checkAbort(signal); await onReasoning?.(packet.delta); }
      return undefined;
    }
    if (packet.type === 'response.function_call_arguments.delta') { sawContent = true; timeout.output(); }
    if (packet.type === 'response.output_item.added') {
      if (packet.item?.type === 'function_call') upsertCall(packet.item);
      if (packet.item?.type === 'reasoning') {
        const reasoning = responsesReasoning(packet.item);
        if (reasoning) { sawContent = true; checkAbort(signal); await onReasoning?.(reasoning); }
      }
      return undefined;
    }
    if (packet.type === 'response.function_call_arguments.delta') {
      const existing = calls.get(packet.item_id);
      if (existing) {
        existing.arguments += packet.delta || '';
        if (existing.arguments.length > MAX_TOOL_ARGUMENTS) throw new Error('工具请求超出大小限制。');
      }
      return;
    }
    if (packet.type === 'response.function_call_arguments.done') {
      const existing = calls.get(packet.item_id);
      if (existing && typeof packet.arguments === 'string') existing.arguments = packet.arguments;
      return;
    }
    if (packet.type === 'response.output_item.done') {
      if (packet.item?.type === 'function_call') upsertCall(packet.item);
      return;
    }
    if (packet.type === 'response.completed') {
      if (packet.response?.usage) await recordUsage(packet.response.usage);
      finishReason = calls.size ? 'tool_calls' : 'stop';
      return 'done';
    }
    if (packet.type === 'response.incomplete') {
      if (packet.response?.usage) await recordUsage(packet.response.usage);
      finishReason = /max_output_tokens|max_tokens/i.test(packet.response?.incomplete_details?.reason || '') ? 'length' : 'stop';
      return 'done';
    }
  };
  // 1.4.8: proxy, extra headers, extra body fields and the requests-a-minute limit, per attempt.
  const send = async payload => {
    await takeRate(settings, timeout.signal);
    return providerFetch(endpointFor(settings.baseUrl, 'responses'), {
      method: 'POST', headers: headers(settings, stream, 'responses'), body: JSON.stringify(withExtraBody(payload, settings)), signal: timeout.signal, redirect: 'error', 
    }, settings);
  };
  try {
    const response = await sendWithReasoningFallback({
      body, variants: reasoningRequestVariants(settings.reasoningEffort, model, 'responses'), send, apiKey: settings.apiKey, signal, onNotice,
    });
    timeout.touch();
    if (!isJsonResponse(response)) {
      // A relay that answers with text/plain, or with no content type at all, is still sending an
      // event stream; reading it as a JSON body failed a reply that was arriving fine.
      const { completed } = await streamPackets(response, timeout, consume);
      if (!completed) throw incompleteStreamError({ produced: sawContent });
    } else {
      let packet;
      try { packet = JSON.parse(await responseText(response, MAX_RESPONSE, () => timeout.touch())); } catch (error) { throw new Error(`无法读取上游 JSON 回复：${safeError(error, settings.apiKey)}`); }
      for (const item of packet.output || []) {
        if (item?.type === 'message') {
          for (const part of item.content || []) {
            const text = typeof part?.text === 'string' ? part.text : '';
            if (text) { checkAbort(signal); await onText?.(text); }
          }
        } else if (item?.type === 'function_call') {
          upsertCall(item);
        } else if (item?.type === 'reasoning') {
          const reasoning = responsesReasoning(item);
          if (reasoning) { checkAbort(signal); await onReasoning?.(reasoning); }
        }
      }
      if (packet.usage) await recordUsage(packet.usage);
      finishReason = calls.size ? 'tool_calls' : packet.status === 'incomplete' ? 'length' : 'stop';
    }
    checkAbort(signal);
    const toolCalls = [...calls.values()].map(call => toolCall(call.name, call.arguments || '{}', call.id));
    return { toolCalls, finishReason, usage };
  } catch (error) {
    throw completionError(error, { signal, timeout, key: settings.apiKey });
  } finally { timeout.cleanup(); }
}

// Socket-level codes that mean "the connection broke", not "the request was wrong". Header and
// body timeouts are deliberately absent: they already waited minutes and must not be repeated.
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETRESET', 'ENETDOWN', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
]);
const TRANSPORT_NAMES = new Set(['SocketError', 'ConnectTimeoutError', 'ClientClosedError']);
// Message text as well as a bare code, because every layer words the same break differently:
// undici wording changed between Node versions (terminated, other side closed), and a relay
// reports it in its own words: connection lost mid-reply, the socket connection was closed
// unexpectedly, network error. Telling a broken connection apart from a rejected request is
// what decides whether a half-written reply is continued or thrown away.
// 1.3.0: relays also word it as a closed or ended stream ("upstream stream closed before
// message_stop", "unexpected end of stream"); those are the same broken connection.
const TRANSPORT_MESSAGES = /(fetch failed|terminated|socket hang up|other side closed|connection (?:was )?(?:lost|closed|reset|aborted|refused)|socket connection was closed|premature close|network (?:error|is unreachable)|stream (?:was )?(?:closed|ended|interrupted|disconnected)|closed before (?:message_stop|\[DONE\]|completion|the response)|before message_stop|unexpected (?:end|eof)|incomplete chunked|EAI_AGAIN|ECONNRESET|ECONNABORTED|ETIMEDOUT|UND_ERR_SOCKET)/i;

/**
 * Recognises a broken connection anywhere in an error's cause chain and describes it with the
 * innermost cause, which is where undici puts the real reason ("fetch failed" alone says nothing).
 */
export function transportFailure(error) {
  // 1.5.7: permanent proxy errors must not be reclassified by a generic fetch wrapper.
  if (hasPermanentFailure(error)) return null;
  const chain = errorCauseChain(error);
  const hit = chain.some(item => TRANSPORT_CODES.has(String(item.code ?? ''))
    || TRANSPORT_NAMES.has(String(item.name ?? ''))
    || TRANSPORT_MESSAGES.test(String(item.message ?? '')));
  if (!hit) return null;
  const outer = chain[0]; const root = chain[chain.length - 1];
  const inner = root !== outer ? [root.code, root.message].filter(Boolean).join(' ') : '';
  return { message: inner ? `${outer.message}（${inner}）` : String(outer.message ?? ''), code: root.code ?? outer.code, root };
}

function pause(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** An error the caller is allowed to answer by starting the same request over. */
/**
 * An error that says the connection broke, not that the request was wrong.
 *
 * partial is what makes it actionable: the reply exists up to that point, so the caller can
 * carry it on instead of losing the round. Without any content there is nothing to carry, and
 * the request is simply replayed.
 */
function interruptedError(message, { produced = false } = {}) {
  const error = new Error(message);
  error.transport = true;
  if (produced) error.partial = true; else error.retryable = true;
  return error;
}

/** Whether a reply was cut off by a broken connection and can be continued from its text. */
export function isInterrupted(error) {
  if (!error || hasPermanentFailure(error)) return false;
  if (error.transport === true || error.interrupted === true || error.partial === true) return true;
  // An answer with an HTTP status is a refusal, not a connection that broke mid-reply.
  if (Number.isInteger(error.status)) return false;
  const msg = String(error.message ?? '');
  return /(mid-reply|mid-response|interrupted|truncated|断流|中断|socket connection was closed unexpectedly)/i.test(msg) || Boolean(transportFailure(error));
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

/**
 * An error the upstream reported inside the stream, after HTTP 200.
 *
 * One that arrives before any content is a busy server rather than a bad request, so it is worth
 * another attempt; one that arrives after text has already streamed must not be replayed, because
 * starting over would duplicate or lose work, so it is reported as it stands.
 */
function upstreamStreamError(value, { produced, key }) {
  const detail = safeError(value?.message ?? value, key) || '上游在流中途报告了错误。';
  // fix3: Responses' response.failed names the kind in error.code (server_error, rate_limit_exceeded).
  const kind = `${value?.type ?? ''} ${value?.code ?? ''}`.trim();
  // A relay that reports connection lost, mid-reply, inside the stream after HTTP 200 is sending
  // the same news as a socket that died: no more of this reply is coming. Marked as a broken
  // connection, the answer is continued from where it stopped instead of being discarded.
  if (TRANSPORT_MESSAGES.test(kind + " " + detail)) return interruptedError("与模型服务的网络连接中断：" + detail, { produced });
  if (!produced && /overloaded|rate_limit|timeout|unavailable|server_error|api_error|internal/i.test(`${kind} ${detail}`)) {
    return retryableError(`上游暂时不可用（${detail}），正在重新连接。`);
  }
  return new Error(detail);
}

/**
 * The stream stopped without the upstream ever declaring the end of the reply.
 *
 * A relay that times out, or one that closes the socket straight after the last content block,
 * produces exactly this: text arrived, and then the connection ended with no message_stop, no
 * [DONE] and no finish reason. Treating that as success is what let a half-written answer look
 * complete. Nothing produced yet means the request can simply be started again; anything already
 * streamed is kept, and the reader is told the reply may be incomplete.
 */
function incompleteStreamError({ produced }) {
  // Nothing produced: the request can simply be started again. Something produced: the connection
  // broke mid-reply, so it carries the same mark as a dropped socket and the reply is continued
  // from the text already received instead of the reader being asked to type 继续.
  if (produced) return interruptedError('上游没有发送结束标记，回复在返回途中中断。', { produced: true });
  return retryableError('上游连接在返回任何内容之前就结束了，正在重新连接。');
}

/** The output limit an upstream names when it refuses max_tokens ("32768 > 32000", "at most 32000"). */
function outputTokenLimit(message) {
  const text = String(message ?? '');
  const pair = /(\d{3,7})\s*>\s*(\d{3,7})/.exec(text);
  if (pair && Number(pair[1]) > Number(pair[2])) return Number(pair[2]);
  const named = /(?:less than or equal to|at most|maximum(?: allowed)?(?: value)?(?: is| of)?|limit(?: is| of)?|up to)\s*:?\s*(\d{3,7})/i.exec(text);
  return named ? Number(named[1]) : null;
}

/** A rejection of the output ceiling itself, which is answered by asking for less. */
function rejectsMaxTokens(status, message) {
  if (![400, 422].includes(status)) return false;
  if (!/max[_ ]?tokens|max output tokens|output tokens/i.test(message)) return false;
  return /too large|exceed|greater than|at most|maximum|limit|invalid|less than or equal/i.test(message);
}

function completionError(error, { signal, timeout, key }) {
  if (signal?.aborted) return abortError();
  if (timeout.timedOut === 'no_output') return Object.assign(retryableError('连接已建立但迟迟没有返回内容，正在重新连接。'), { noOutput: true });
  if (timeout.timedOut === 'idle') return new Error('上游长时间没有返回任何数据，已停止等待；模型可能仍在思考，请检查网络后重试。');
  if (timeout.timedOut === 'absolute') return new Error('上游请求持续时间过长，已停止等待。');
  // An error the reader already classified keeps what it decided, so "may be retried" and "the
  // reply is partial" are not lost when the message is rewritten. The message is still redacted, so
  // no credential reaches the interface.
  // An error that already knows the connection broke keeps its own wording; one that only looks
  // like a socket failure from the outside is recognised and described here, once.
  const broken = error?.transport === true;
  // 1.3.3: a 400 whose body says "Unexpected end of JSON input" or "subscription terminated" came
  // back as an HTTP answer; matching its words as a socket failure replayed it five times.
  const proxy = errorCauseChain(error).find(cause => cause.proxyFailure === true);
  if (proxy) {
    // 1.5.7: preserve the safe category and a chain's permanent veto through every wrapper.
    const reported = new Error(safeError(proxy, key));
    reported.proxyFailure = true;
    if (proxy.proxyFailureKind) reported.proxyFailureKind = proxy.proxyFailureKind;
    if (proxy.code) reported.code = String(proxy.code);
    if (proxy.cause) reported.cause = proxy.cause;
    if (hasPermanentFailure(error)) reported.permanent = true;
    else { reported.transport = true; reported.retryable = true; }
    return reported;
  }
  if (hasPermanentFailure(error)) {
    const reported = new Error(safeError(error, key));
    reported.permanent = true;
    if (error.code) reported.code = String(error.code);
    if (error.cause) reported.cause = error.cause;
    return reported;
  }
  const transport = broken || error?.retryable === true || Number.isInteger(error?.status) ? null : transportFailure(error);
  const reported = new Error(transport ? '与模型服务的网络连接中断：' + safeError(transport.message, key) : safeError(error, key));
  if (transport || broken) {
    reported.transport = true;
    const code = transport?.code ?? error?.code;
    if (code) reported.code = String(code);
    // Kept so the error log records the socket-level reason instead of an empty cause.
    const cause = transport ? transport.root : error?.cause;
    if (cause) reported.cause = cause;
  }
  if (error?.retryable === true) reported.retryable = true;
  if (error?.partial === true) reported.partial = true;
  if (error?.httpRetry === true) reported.httpRetry = true;
  if (Number.isInteger(error?.status)) reported.status = error.status;
  if (Number.isFinite(error?.retryAfterMs)) reported.retryAfterMs = error.retryAfterMs;
  return reported;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Starts a request again when it died before producing anything.
 *
 * Only a silent connection is retried. Once a token, a thinking fragment, or a tool call has
 * reached the caller, restarting would duplicate or lose work, so that error is passed straight
 * through and the caller decides what to do with it.
 */
async function withOutputRetry(run, options) {
  const attempts = Math.max(1, Number(options.retries ?? OUTPUT_RETRIES));
  const transportAttempts = Math.max(1, Math.min(attempts, Number(options.transportRetries ?? TRANSPORT_RETRIES)));
  const httpAttempts = Math.max(1, Math.min(attempts, Number(options.httpRetries ?? HTTP_RETRIES + 1)));
  let lastError = null; let transportFailures = 0; let httpFailures = 0; let silentFailures = 0;
  const baseWindow = firstOutputWindow(options);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let produced = false; let producedText = false;
    // Only something the reader can see counts as produced; an empty fragment is not output.
    const wrap = (handler, text) => (typeof handler === 'function' ? async value => { if (value) { produced = true; if (text) producedText = true; } return handler(value); } : handler);
    try {
      return await run({
        ...options,
        firstOutput: baseWindow > 0 ? Math.min(baseWindow * SILENT_WINDOW_GROWTH ** silentFailures, Math.max(baseWindow, SILENT_WINDOW_MAX)) : baseWindow,
        onText: wrap(options.onText, true),
        onReasoning: wrap(options.onReasoning, false),
        // A dropped reasoning field is a note about this attempt, not generated content, so it is
        // deliberately not wrapped: a notice must never mark the request as having produced output.
        onNotice: options.onNotice,
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      // Permanent auth/certificate failures veto all transport/HTTP/general retry flags.
      if (hasPermanentFailure(error)) throw error;
      lastError = error;
      if (error?.transport === true) {
        // A broken socket is replayed as long as no answer text reached the reader. Reasoning
        // shown so far is only thinking, and tool calls are assembled in full before they run,
        // so starting over cannot duplicate any work.
        transportFailures++;
        if (producedText) throw error;
        if (transportFailures >= transportAttempts) {
          error.message = `${String(error.message ?? '').replace(/[。.]+$/, '')}。已自动重试 ${transportFailures - 1} 次仍失败，请检查网络、代理或接口服务是否稳定后重试。`;
          throw error;
        }
        // 1.3.3-fix2: every kind of retry shares one attempt budget; the last one still explains itself.
        if (attempt >= attempts) { error.message = `${String(error.message ?? '').replace(/[。.]+$/, '')}。已自动重试 ${attempt - 1} 次仍失败，请检查网络、代理或接口服务是否稳定后重试。`; throw error; }
        await options.onRetry?.({ attempt: transportFailures, attempts: transportAttempts, error: safeError(error, options.settings?.apiKey), transport: true });
        await pause(Math.min(1_000 * 2 ** (transportFailures - 1), TRANSPORT_BACKOFF_MAX), options.signal);
        if (options.signal?.aborted) throw abortError();
        continue;
      }
      if (error?.httpRetry === true && !produced) {
        // Rate limiting and a briefly unavailable gateway answer before generation starts, so the
        // same request is sent again after a pause (the server's Retry-After when it gives one).
        httpFailures++;
        if (httpFailures >= httpAttempts) {
          if (httpFailures > 1) error.message = `${error.message}。已自动重试 ${httpFailures - 1} 次仍失败，上游可能正在限流或维护，请稍后重试。`;
          throw error;
        }
        if (attempt >= attempts) { error.message = `${error.message}。已自动重试 ${attempt - 1} 次仍失败，上游可能正在限流或维护，请稍后重试。`; throw error; }
        await options.onRetry?.({ attempt: httpFailures, attempts: httpAttempts - 1, error: safeError(error, options.settings?.apiKey), http: true, status: error.status });
        const wait = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : Math.min(2_000 * 2 ** (httpFailures - 1), HTTP_BACKOFF_MAX);
        await pause(wait, options.signal);
        if (options.signal?.aborted) throw abortError();
        continue;
      }
      if (!produced && error?.noOutput === true) {
        silentFailures++;
        if (silentFailures > SILENT_RETRIES || attempt >= attempts) {
          const waited = Math.round(Math.min(baseWindow * SILENT_WINDOW_GROWTH ** (silentFailures - 1), Math.max(baseWindow, SILENT_WINDOW_MAX)) / 1000);
          error.message = `上游连接已建立，但连续 ${silentFailures} 次都没有返回任何内容（最后一次等待了 ${waited} 秒）。模型可能仍在长时间思考，或接口服务没有响应；请稍后重试，或调低推理等级。`;
          throw error;
        }
      }
      if (!produced && error?.retryable === true && attempt >= attempts && attempts > 1) {
        // 1.3.3: the last attempt's message still said "reconnecting" while the request had in
        // fact been given up.
        error.message = `${String(error.message ?? '').replace(/[，,]?\s*正在重新连接[。.]?\s*$/, '')}。已自动重试 ${attempts - 1} 次仍失败，请检查网络或稍后重试。`.replace(/。。/g, '。');
      }
      if (produced || error?.retryable !== true || attempt >= attempts) throw error;
      await options.onRetry?.({ attempt, attempts, error: safeError(error, options.settings?.apiKey) });
      // Each silent attempt already waited a minute for its first byte, so replaying it at once
      // is what makes a busy upstream look hammered; the pause grows, but stays short enough to
      // be worth waiting through.
      await pause(Math.min(500 * 2 ** (attempt - 1), TRANSPORT_BACKOFF_MAX), options.signal);
      if (options.signal?.aborted) throw abortError();
    }
  }
  throw lastError;
}

/** How long one request may stay silent before its first output (see REASONING_FIRST_OUTPUT_TIMEOUT). */
function firstOutputWindow(options) {
  if (Number.isFinite(options.firstOutputTimeout)) return options.firstOutputTimeout;
  const model = String(options.model ?? '');
  const level = options.settings?.reasoningEffort;
  const asked = Boolean(level) && reasoningRequestVariants(level, model, protocolOf(options.settings)).length > 0;
  return asked || ALWAYS_REASONING_MODELS.test(model) ? REASONING_FIRST_OUTPUT_TIMEOUT : FIRST_OUTPUT_TIMEOUT;
}

export async function completion(options) {
  checkAbort(options.signal);
  if (!options.settings.baseUrl || !options.model) throw new Error('请先在设置中填写 API 地址和模型名称。');
  const protocol = protocolOf(options.settings);
  const run = protocol === 'anthropic' ? anthropicCompletion : protocol === 'responses' ? responsesCompletion : chatCompletion;
  // 1.4.8: a connection may cap how many requests are out at the vendor at once. The slot is
  // held for the whole request (retries and the streaming read included) and a request over
  // the limit waits its turn instead of failing.
  const release = await acquireConcurrency(options.settings, options.signal);
  try {
    return await withOutputRetry(run, options);
  } finally { release(); }
}

export async function listModels(settings, signal) {
  if (!settings.baseUrl) throw new Error('请先设置 API 地址。');
  const protocol = protocolOf(settings);
  const timeout = requestSignal(signal, { idle: 20_000, absolute: 20_000 });
  try {
    // 1.4.8: the model list goes out the same way a reply does: this connection's proxy and headers.
    const response = await providerFetch(modelsEndpoint(settings.baseUrl, protocol), { headers: headers(settings, false, protocol), signal: timeout.signal, redirect: 'error', }, settings);
    if (!response.ok) throw await upstreamError(response, settings.apiKey);
    const body = JSON.parse(await responseText(response, 4 * 1024 * 1024));
    const values = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : isObject(body?.models) ? Object.keys(body.models) : [];
    const ids = new Set(values.map(value => typeof value === 'string' ? value : value?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256));
    return { models: [...ids].slice(0, 2_000).map(id => ({ id })) };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timeout.timedOut !== null) throw new Error('读取模型列表超时。');
    throw new Error(safeError(error, settings.apiKey));
  } finally { timeout.cleanup(); }
}

