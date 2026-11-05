/**
 * 1.4.8: a connection's advanced options.
 *
 * Ported from magpie (yetone/magpie) — `internal/provider/extrabody.go`,
 * `internal/provider/requestheaders.go` and its provider proxy settings — with the same
 * semantics, because a private relay is usually what needs them:
 *
 *  - **Request headers**: extra HTTP headers sent to the vendor *after* the API key is put
 *    on the request, so a gateway with its own auth scheme can be given one. A name that
 *    collides with a header this app already sends replaces it, except for the handful the
 *    connection itself owns (Host, Content-Length, hop-by-hop headers), which can never be
 *    set from here.
 *  - **Extra body**: JSON fields added to the top level of every request body, whatever
 *    protocol it speaks. A field the body already carries is kept, and the user's value only
 *    fills in what is missing; a name written with a leading `!` is forced instead. The
 *    fields that carry the conversation, the model and the stream are refused, because this
 *    app decides them for routing and reads the reply by them.
 *  - **Placeholders**: a session id in a header value or in a string inside the extra body
 *    (at any depth) is the conversation's id, a thread id the same conversation's thread, and
 *    a sub-agent id the child a delegated request is of (empty on the conversation's own
 *    turns). A fixed string would put every conversation on one prompt-cache key.
 *  - **Proxy**: the global proxy from the settings, none at all, or one of its own.
 *  - **Concurrency and requests a minute**: how many requests may be out at the vendor at
 *    once, and how many may be sent a minute. 0 or blank means no limit; a request over the
 *    concurrency limit waits in a first-in, first-out queue (see provider-limits.mjs).
 */
import { HttpError } from './util.mjs';

/** The body fields the extra body can never set: the conversation, the model and the stream. */
export const EXTRA_BODY_RESERVED = [
  'model', 'stream', 'messages', 'input', 'contents', 'system', 'systemInstruction', 'system_instruction',
  'instructions', 'tools',
];

/** How many extra headers one connection may keep, and how long one value may be. */
export const MAX_HEADERS = 24;
const MAX_HEADER_VALUE = 4096;
/** How long the extra body text may be. */
export const MAX_EXTRA_BODY = 16 * 1024;
/** Bounds on the two limits, as magpie bounds them (0 = no limit). */
export const MAX_CONCURRENCY = 1000;
export const MAX_RPM = 10000;
/** The three proxy choices: follow the global proxy, go direct, or use one of its own. */
export const PROXY_MODES = ['global', 'direct', 'custom'];

/** The token names that stand for the ids of one conversation. */
export const PLACEHOLDER_NAMES = ['sessionId', 'threadId', 'subagentId'];

/** A header name, as HTTP allows it (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,120}$/;
/** Headers the connection itself owns: setting them from the editor would break the request. */
const RESERVED_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'expect', 'te', 'trailer',
  'accept-encoding', 'proxy-authorization', 'proxy-authenticate',
]);

const PLACEHOLDER = new RegExp('\\$\\{(' + PLACEHOLDER_NAMES.join('|') + ')\\}', 'g');

/** The example shown in the editor, written without a template literal so it stays literal. */
export const EXTRA_BODY_EXAMPLE = '{"prompt_cache_key": "${sessionId}"}';

/** True when a name may be sent as a header name at all. */
export function isHeaderName(name) {
  return HEADER_NAME.test(String(name ?? ''));
}

/**
 * The ids a header value or an extra body string may name.
 *
 * `sessionId` is the conversation this request belongs to; a conversation has one thread, so
 * `threadId` is the same id; `subagentId` is the child a delegated request is of, and empty on
 * the conversation's own turns.
 */
export function placeholderContext(settings) {
  const sessionId = typeof settings?.sessionId === 'string' ? settings.sessionId : '';
  return {
    sessionId,
    threadId: typeof settings?.threadId === 'string' && settings.threadId ? settings.threadId : sessionId,
    subagentId: typeof settings?.subagentId === 'string' ? settings.subagentId : '',
  };
}

/** A value with every placeholder replaced, at any depth of an object or array. */
export function expandPlaceholders(value, context) {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_, name) => context?.[name] ?? '');
  if (Array.isArray(value)) return value.map(item => expandPlaceholders(item, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandPlaceholders(item, context);
    return out;
  }
  return value;
}

/** A stored extra body text as the object it holds, or null when it holds none. */
const parsedExtraBodies = new Map();
export function extraBodyFields(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (parsedExtraBodies.has(text)) return parsedExtraBodies.get(text);
  let fields = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed;
  } catch { fields = null; }
  // Bounded: one entry per connection in practice, and the texts are short.
  if (parsedExtraBodies.size > 128) parsedExtraBodies.clear();
  parsedExtraBodies.set(text, fields);
  return fields;
}

/** One header row of the editor, as `{ name, value }`, or null when the row cannot be sent. */
function headerRow(name, value, strict) {
  const headerName = typeof name === 'string' ? name.trim() : '';
  const text = value === undefined || value === null ? '' : String(value);
  if (!headerName && !text.trim()) return null;
  if (!isHeaderName(headerName)) {
    if (strict) throw new HttpError(400, '请求头“' + (headerName || text.slice(0, 40)) + '”不是合法的请求头名称；名称只能使用字母、数字和 - _ . 等符号。');
    return null;
  }
  if (RESERVED_HEADERS.has(headerName.toLowerCase())) {
    if (strict) throw new HttpError(400, '请求头 ' + headerName + ' 不能在这里设置：它由连接本身决定。');
    return null;
  }
  if (/[\r\n]/.test(text)) {
    if (strict) throw new HttpError(400, '请求头 ' + headerName + ' 的值不能包含换行。');
    return null;
  }
  if (text.length > MAX_HEADER_VALUE) {
    if (strict) throw new HttpError(400, '请求头 ' + headerName + ' 的值过长（上限 ' + MAX_HEADER_VALUE + ' 个字符）。');
    return null;
  }
  return { name: headerName, value: text };
}

/** One row typed as "Name: value", or as a bare name. */
function headerLine(text, strict) {
  const line = String(text).trim();
  if (!line) return null;
  const at = line.indexOf(':');
  if (at < 0) return headerRow(line, '', strict);
  return headerRow(line.slice(0, at), line.slice(at + 1).replace(/^\s+/, ''), strict);
}

/**
 * A connection's extra headers as they are kept: trimmed, one per name (the last row wins),
 * what cannot be sent dropped. Accepts the editor's rows, a `{ name: value }` map, or
 * `"Name: value"` lines.
 */
export function normalizeHeaders(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const rows = [];
  const push = row => { if (row) rows.push(row); };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'string') push(headerLine(item, strict));
      else if (typeof item === 'object') push(headerRow(item.name ?? item.key ?? item.header, item.value ?? item.val ?? '', strict));
    }
  } else if (typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) push(headerRow(name, item, strict));
  } else if (strict) {
    throw new HttpError(400, '请求头必须是一组名称与值。');
  }
  const out = [];
  for (const row of rows) {
    const at = out.findIndex(existing => existing.name.toLowerCase() === row.name.toLowerCase());
    if (at !== -1) out.splice(at, 1);
    out.push(row);
  }
  if (out.length > MAX_HEADERS) {
    if (strict) throw new HttpError(400, '一个连接最多可以设置 ' + MAX_HEADERS + ' 个请求头。');
    return out.slice(0, MAX_HEADERS);
  }
  return out;
}

/**
 * A connection's extra body as it is kept: the JSON text, `''` for none. Accepts JSON text or
 * an already parsed object; the fields that cannot be set are refused when saving.
 */
export function normalizeExtraBodyText(value, { strict = false } = {}) {
  if (value === undefined || value === null) return '';
  let text;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    text = Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
  } else {
    if (strict) throw new HttpError(400, '额外请求体必须是 JSON 对象文本。');
    return '';
  }
  if (!text) return '';
  if (text.length > MAX_EXTRA_BODY) {
    if (strict) throw new HttpError(400, '额外请求体过大（上限 ' + MAX_EXTRA_BODY + ' 字节）。');
    return '';
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    if (strict) throw new HttpError(400, '额外请求体不是合法的 JSON，请检查引号、逗号与括号。');
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (strict) throw new HttpError(400, '额外请求体必须是一个 JSON 对象，例如 ' + EXTRA_BODY_EXAMPLE + '。');
    return '';
  }
  const seen = new Set();
  for (const rawName of Object.keys(parsed)) {
    const name = (rawName.startsWith('!') ? rawName.slice(1) : rawName).trim();
    if (!name) {
      if (strict) throw new HttpError(400, '额外请求体里的每个字段都需要名称。');
      return '';
    }
    if (EXTRA_BODY_RESERVED.includes(name)) {
      if (strict) throw new HttpError(400, '额外请求体不能设置 ' + name + '：模型、流式与对话本身由程序决定。');
      return '';
    }
    if (seen.has(name)) {
      if (strict) throw new HttpError(400, '额外请求体里的 ' + name + ' 出现了两次（带 ! 与不带 ! 会覆盖同一个字段）。');
      return '';
    }
    seen.add(name);
  }
  return text;
}

/** A stored proxy choice. Anything unknown follows the global proxy. */
export function normalizeProxyMode(value) {
  return PROXY_MODES.includes(value) ? value : 'global';
}

/** A proxy address as it is kept: `''` for none, else an http(s) URL. Credentials are allowed. */
export function normalizeProxyUrl(value, { strict = false, label = '代理地址' } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    if (strict) throw new HttpError(400, label + '必须是文本。');
    return '';
  }
  const text = value.trim();
  if (!text) return '';
  if (text.length > 2048) {
    if (strict) throw new HttpError(400, label + '过长。');
    return '';
  }
  let url;
  try { url = new URL(text); } catch {
    if (strict) throw new HttpError(400, label + '必须是有效的 HTTP 代理地址，例如 http://127.0.0.1:7890。');
    return '';
  }
  if (!['http:', 'https:', 'socks5:', 'socks:'].includes(url.protocol) || url.search || url.hash) {
    if (strict) throw new HttpError(400, label + '仅支持 HTTP、HTTPS 或 SOCKS5 代理，且不能带查询参数或片段。');
    return '';
  }
  return text;
}

/** One of the two limits as it is kept: a whole number from 0 (no limit) to maximum. */
export function normalizeLimit(value, maximum, label = '限制', { strict = false } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    if (strict) throw new HttpError(400, label + '必须是 0 到 ' + maximum + ' 之间的整数；0 或留空表示不限制。');
    return 0;
  }
  return number;
}

/**
 * A request body with the connection's extra fields merged in, as magpie's `WithExtraBody` does:
 * a field the body already has is kept unless its name was written with a leading `!`, and the
 * placeholders in its strings are the conversation's ids. A body that is not a plain object, or
 * a connection with no extra body, is returned as it came.
 */
export function withExtraBody(body, settings) {
  const fields = extraBodyFields(settings?.extraBody);
  if (!fields || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const context = placeholderContext(settings);
  let changed = false;
  const out = { ...body };
  for (const [rawName, value] of Object.entries(fields)) {
    const forced = rawName.startsWith('!');
    const name = (forced ? rawName.slice(1) : rawName).trim();
    if (!name || EXTRA_BODY_RESERVED.includes(name)) continue;
    if (!forced && Object.hasOwn(out, name)) continue;
    out[name] = expandPlaceholders(value, context);
    changed = true;
  }
  return changed ? out : body;
}

/**
 * A request's headers with the connection's extra headers applied last, so they stand after the
 * API key and can carry a private gateway's own auth. Never mutates the headers it is given.
 */
export function withExtraHeaders(base, headers, settings) {
  if (!Array.isArray(headers) || !headers.length) return base;
  const context = placeholderContext(settings);
  const out = { ...base };
  for (const row of headers) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name || !isHeaderName(name) || RESERVED_HEADERS.has(name.toLowerCase())) continue;
    const lowered = name.toLowerCase();
    for (const key of Object.keys(out)) if (key.toLowerCase() === lowered) delete out[key];
    out[name] = expandPlaceholders(String(row.value ?? ''), context);
  }
  return out;
}
