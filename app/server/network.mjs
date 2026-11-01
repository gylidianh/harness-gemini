import http from 'node:http';
import https from 'node:https';
import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { abortError, boundedString, checkAbort, HttpError } from './util.mjs';
import { readFile as readTextFile } from 'node:fs/promises';

/** The release actually running, so the public user agent never claims a stale version. */
const VERSION = JSON.parse(await readTextFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_ALLOWED_BYTES = 1024 * 1024 * 1024;
const IPV6_GLOBAL_UNICAST = ipaddr.parse('2000::');

export function normalizeWebUrl(value) {
  boundedString(value, '网页地址', { max: 8_192 });
  const input = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(input)) throw new HttpError(400, '网页地址不能包含空白或控制字符。');
  let url;
  try { url = new URL(input); } catch { throw new HttpError(400, '请提供完整的 HTTP 或 HTTPS 网页地址。'); }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input)?.[1] ?? '';
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || authority.includes('@')) {
    throw new HttpError(400, '联网工具仅支持 HTTP/HTTPS，地址中不能带账号或密码。');
  }
  if (url.port === '0') throw new HttpError(400, '网页端口不正确。');
  url.hash = '';
  return url.href;
}

function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata';
}

function publicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast' && (parsed.kind() === 'ipv4' || parsed.match(IPV6_GLOBAL_UNICAST, 3));
  }
  catch { return false; }
}

function abortReason(signal) { return signal.reason instanceof Error ? signal.reason : abortError(); }

function withAbort(task, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, abortReason(signal));
    const finish = (settle, value) => { signal.removeEventListener('abort', onAbort); settle(value); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) onAbort();
  });
}

async function verifiedAddress(url, { lookup, allowPrivateNetworks, signal }) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateNetworks && blockedHostname(hostname)) throw new HttpError(403, '联网工具不能访问本机、私有网络或云元数据地址。');
  let records;
  if (isIP(hostname)) records = [{ address: hostname }];
  else {
    try { records = await withAbort(Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })), signal); }
    catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new HttpError(502, '无法解析目标网站的网络地址。');
    }
  }
  if (!Array.isArray(records)) records = records ? [records] : [];
  if (!records.length || records.length > 64) throw new HttpError(502, '目标网站没有可用的网络地址。');
  const addresses = records.map(record => {
    const address = typeof record?.address === 'string' ? record.address : '';
    return { address, family: isIP(address) };
  });
  if (addresses.some(record => !record.family)) throw new HttpError(502, '目标网站返回了无效的网络地址。');
  // Reject mixed public/private answers rather than allowing a later family choice to bypass the check.
  if (!allowPrivateNetworks && addresses.some(record => !publicAddress(record.address))) {
    throw new HttpError(403, '联网工具不能访问本机、私有、保留网络或云元数据地址。');
  }
  return addresses.find(record => record.family === 4) ?? addresses[0];
}

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => {
      if (options?.all) callback(null, [{ ...address }]);
      else callback(null, address.address, address.family);
    });
  };
}

function requestResponse(url, address, { signal, requestImpl }) {
  return new Promise((resolve, reject) => {
    const requestFunction = requestImpl ?? (url.protocol === 'https:' ? https.request : http.request);
    let request;
    const options = {
      method: 'GET', agent: false, family: address.family, autoSelectFamily: false,
      lookup: pinnedLookup(address), rejectUnauthorized: true, signal,
      ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: url.hostname }),
      headers: {
        'User-Agent': `Harness-Gemini/${VERSION} Public-Web-Tools`,
        Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    };
    const onAbort = () => request?.destroy(abortReason(signal));
    try {
      request = requestFunction(url, options, response => queueMicrotask(() => resolve({ request, response })));
      request.once('error', reject);
      request.once('close', () => signal.removeEventListener('abort', onAbort));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      else request.end();
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      request?.destroy();
      reject(error);
    }
  });
}

function responseHeaders(response) {
  return Object.fromEntries(Object.entries(response.headers).filter(([name]) => name.toLowerCase() !== 'set-cookie').map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
}

function lengthHeader(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function decodersFor(value) {
  const encodings = String(value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(item => item && item !== 'identity');
  if (encodings.length > 3) throw new HttpError(415, '网页使用了过多层压缩编码。');
  if (encodings.some(encoding => !['gzip', 'x-gzip', 'deflate', 'br'].includes(encoding))) throw new HttpError(415, '网页使用了不支持的压缩编码。');
  return encodings.reverse().map(encoding => {
    if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
    if (encoding === 'deflate') return createInflate();
    if (encoding === 'br') return createBrotliDecompress();
    throw new HttpError(415, '网页使用了不支持的压缩编码。');
  });
}

/**
 * Public HTTP(S) GET with a fresh DNS check and a pinned address on every redirect.
 * lookup/requestImpl/allowPrivateNetworks are internal test seams, never model-facing options.
 * maxBytes and bytes refer to decoded content. Streaming callbacks are awaited and body is omitted.
 */
export async function fetchUrlBytes(input, {
  signal, timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024, onChunk, onProgress,
  allowPrivateNetworks = false, lookup = systemLookup, requestImpl,
} = {}) {
  let current = new URL(normalizeWebUrl(input));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new HttpError(400, '联网时限必须在 1 毫秒到 5 分钟之间。');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ALLOWED_BYTES) throw new HttpError(400, '联网大小限制必须是 1 字节到 1 GB 之间的整数。');
  if (onChunk !== undefined && typeof onChunk !== 'function') throw new HttpError(400, '流式接收回调不正确。');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new HttpError(400, '进度回调不正确。');
  if (typeof lookup !== 'function' || (requestImpl !== undefined && typeof requestImpl !== 'function')) throw new HttpError(400, '网络依赖配置不正确。');
  checkAbort(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new HttpError(504, '联网请求超时，已停止等待。')), timeoutMs);
  timer.unref?.();
  let activeRequest; let activeResponse; let activeOutput;
  const invoke = async (callback, value) => {
    if (callback) await withAbort(Promise.resolve().then(() => callback(value)), controller.signal);
  };
  try {
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      const address = await verifiedAddress(current, { lookup, allowPrivateNetworks: allowPrivateNetworks === true, signal: controller.signal });
      const connected = await withAbort(requestResponse(current, address, { signal: controller.signal, requestImpl }), controller.signal);
      activeRequest = connected.request; activeResponse = connected.response;
      const status = activeResponse.statusCode ?? 0;
      const headers = responseHeaders(activeResponse);
      if (REDIRECTS.has(status) && headers.location) {
        activeResponse.destroy(); activeRequest.destroy();
        activeResponse = null; activeRequest = null;
        if (redirects >= MAX_REDIRECTS) throw new HttpError(502, '网页重定向次数过多，最多允许 5 次。');
        let next;
        try { next = new URL(headers.location, current).href; }
        catch { throw new HttpError(502, '网页返回了无效的重定向地址。'); }
        current = new URL(normalizeWebUrl(next));
        continue;
      }
      const decoders = decodersFor(headers['content-encoding']);
      const contentLength = lengthHeader(headers['content-length']);
      const totalBytes = decoders.length ? null : contentLength;
      const wireLimit = maxBytes + 64 * 1024;
      if ((totalBytes !== null && totalBytes > maxBytes) || (contentLength !== null && contentLength > wireLimit)) throw new HttpError(413, '网络资源超过允许的大小限制。');
      let wireBytes = 0;
      const wireCounter = new Transform({
        transform(chunk, _encoding, callback) {
          wireBytes += chunk.length;
          if (wireBytes > wireLimit) callback(new HttpError(413, '网络资源超过允许的大小限制。'));
          else callback(null, chunk);
        },
      });
      activeOutput = new PassThrough({ highWaterMark: 64 * 1024 });
      const piping = pipeline(activeResponse, wireCounter, ...decoders, activeOutput, { signal: controller.signal });
      piping.catch(() => {});
      let bytes = 0;
      const chunks = [];
      await invoke(onProgress, { bytes, totalBytes });
      for await (const chunk of activeOutput) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new HttpError(413, '网络资源超过允许的大小限制。');
        if (onChunk) await invoke(onChunk, chunk);
        else chunks.push(chunk);
        await invoke(onProgress, { bytes, totalBytes });
      }
      await piping;
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return { url: current.href, status, headers, bytes, body: onChunk ? undefined : Buffer.concat(chunks, bytes) };
    }
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    activeOutput?.destroy();
    activeResponse?.destroy();
    activeRequest?.destroy();
  }
}
