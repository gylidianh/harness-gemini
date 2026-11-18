// Harness Gemini 1.4.9: explicit per-request model proxy routing.
// Deliberately do not replace global fetch or the browser's/session's proxy: localhost APIs,
// downloads and web tools have separate security/routing policies.
import net from 'node:net';
import tls from 'node:tls';
import { Agent, ProxyAgent, Socks5ProxyAgent, EnvHttpProxyAgent, Pool, fetch as undiciFetch } from 'undici';
import { normalizeProxyUrl } from './provider-extra.mjs';

const AGENT_OPTIONS = {
  bodyTimeout: 0, headersTimeout: 300_000,
  keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000,
};
const SOCKS_PROTOCOLS = new Set(['socks5:', 'socks5h:', 'socks:']);
const kSocksDispatch = Object.getOwnPropertySymbols(Socks5ProxyAgent.prototype)
  .find(sym => sym.description === 'dispatch') ?? Symbol('socks-dispatch');
const kSocksClose = Object.getOwnPropertySymbols(Socks5ProxyAgent.prototype)
  .find(sym => sym.description === 'close');
const kSocksDestroy = Object.getOwnPropertySymbols(Socks5ProxyAgent.prototype)
  .find(sym => sym.description === 'destroy');

export const streamDispatcher = new Agent(AGENT_OPTIONS);
const proxyAgents = new Map();
let systemProxyResolver = null;
let environmentAgent;

/** Decode percent-encoded credentials once, falling back to raw text on literal `%` (URIError). */
export function safeDecodeURIComponent(value) {
  const text = String(value ?? '');
  if (!text) return '';
  try { return decodeURIComponent(text); }
  catch { return text; }
}

function sanitizeProxyError(error, rawProxyUrl) {
  if (!(error instanceof Error)) return new Error('代理配置无效。');
  const secrets = [];
  if (typeof rawProxyUrl === 'string' && rawProxyUrl) {
    try {
      const parsed = new URL(rawProxyUrl);
      for (const item of [
        parsed.password,
        safeDecodeURIComponent(parsed.password),
        parsed.username,
        safeDecodeURIComponent(parsed.username),
      ]) {
        if (item) secrets.push(item);
      }
    } catch {
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]+)@/i.exec(rawProxyUrl.trim());
      if (m?.[1]) {
        secrets.push(m[1]);
        for (const part of m[1].split(':')) {
          if (part) {
            secrets.push(part, safeDecodeURIComponent(part));
          }
        }
      }
    }
  }
  let msg = String(error.message ?? '');
  for (const secret of secrets) {
    if (secret) msg = msg.split(secret).join('[REDACTED]');
  }
  msg = msg.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/gi, '$1');
  if (msg === error.message) return error;
  const sanitized = new Error(msg);
  if (error.code) sanitized.code = error.code;
  if (error.status) sanitized.status = error.status;
  if (error.permanent) sanitized.permanent = error.permanent;
  return sanitized;
}

/**
 * Custom Socks5ProxyAgent subclass because undici@7.30.x's ProxyAgent drops AGENT_OPTIONS
 * (reverting Pool/Client bodyTimeout to 300s) and passes raw percent-encoded credentials that
 * short-circuit Socks5ProxyAgent's own decodeURIComponent, while Socks5ProxyAgent.[kDispatch]
 * itself constructs `new Pool(origin, { pipelining, connections, connect })` without forwarding
 * bodyTimeout / headersTimeout / keepAlive options.
 */
class ConfiguredSocks5ProxyAgent extends Socks5ProxyAgent {
  #poolOptions;
  #requestTls;
  #fallbackPools = new Map();

  constructor(proxyUrl, options = {}) {
    const {
      bodyTimeout,
      headersTimeout,
      keepAliveTimeout,
      keepAliveMaxTimeout,
      connectTimeout,
      pipelining,
      connections,
      ...socksOptions
    } = options;
    super(proxyUrl, options);
    this.#requestTls = socksOptions.requestTls;
    this.#poolOptions = {
      ...(bodyTimeout !== undefined ? { bodyTimeout } : {}),
      ...(headersTimeout !== undefined ? { headersTimeout } : {}),
      ...(keepAliveTimeout !== undefined ? { keepAliveTimeout } : {}),
      ...(keepAliveMaxTimeout !== undefined ? { keepAliveMaxTimeout } : {}),
      ...(connectTimeout !== undefined ? { connectTimeout } : {}),
      ...(pipelining !== undefined ? { pipelining } : {}),
      ...(connections !== undefined ? { connections } : {}),
    };
  }

  #poolsMap() {
    const sym = Object.getOwnPropertySymbols(this)
      .find(s => s.description === 'pools' && this[s] instanceof Map);
    return sym ? this[sym] : this.#fallbackPools;
  }

  getPoolForOrigin(origin, opts = {}) {
    const pools = this.#poolsMap();
    const originKey = String(origin);
    let pool = pools.get(originKey);
    if (!pool || pool.destroyed || pool.closed) {
      pool = new Pool(origin, {
        ...this.#poolOptions,
        ...(opts.pipelining !== undefined ? { pipelining: opts.pipelining } : {}),
        ...(opts.connections !== undefined ? { connections: opts.connections } : {}),
        connect: async (_connectOpts, callback) => {
          let rawSocket;
          let tlsSocket;
          try {
            const targetUrl = new URL(origin);
            const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
            const targetPort = Number.parseInt(targetUrl.port, 10) || (targetUrl.protocol === 'https:' ? 443 : 80);
            rawSocket = await this.createSocks5Connection(targetHost, targetPort);
            if (targetUrl.protocol !== 'https:') {
              callback(null, rawSocket);
              return;
            }
            const defaultServername = net.isIP(targetHost) === 0 ? targetHost : undefined;
            const servername = this.#requestTls?.servername || defaultServername;
            tlsSocket = tls.connect({
              ...this.#requestTls,
              socket: rawSocket,
              ...(servername ? { servername } : {}),
            });
            await new Promise((resolve, reject) => {
              const onSecure = () => { tlsSocket.removeListener('error', onError); resolve(); };
              const onError = err => { tlsSocket.removeListener('secureConnect', onSecure); reject(err); };
              tlsSocket.once('secureConnect', onSecure);
              tlsSocket.once('error', onError);
            });
            callback(null, tlsSocket);
          } catch (err) {
            try { tlsSocket?.destroy(); } catch {}
            try { rawSocket?.destroy(); } catch {}
            callback(err);
          }
        },
      });
      pools.set(originKey, pool);
    }
    return pool;
  }

  [kSocksDispatch](opts, handler) {
    try {
      const pool = this.getPoolForOrigin(opts.origin, opts);
      return pool.dispatch({
        ...(this.#poolOptions.bodyTimeout !== undefined && opts.bodyTimeout === undefined
          ? { bodyTimeout: this.#poolOptions.bodyTimeout } : {}),
        ...(this.#poolOptions.headersTimeout !== undefined && opts.headersTimeout === undefined
          ? { headersTimeout: this.#poolOptions.headersTimeout } : {}),
        ...opts,
      }, handler);
    } catch (err) {
      if (typeof handler?.onResponseError === 'function') {
        handler.onResponseError(null, err);
        return false;
      }
      if (typeof handler?.onError === 'function') {
        handler.onError(err);
        return false;
      }
      throw err;
    }
  }

  async close(...args) {
    if (this.#fallbackPools.size) {
      const closing = [...this.#fallbackPools.values()].map(p => p.close());
      this.#fallbackPools.clear();
      await Promise.all(closing);
    }
    return super.close(...args);
  }

  async destroy(...args) {
    if (this.#fallbackPools.size) {
      const err = args[0] instanceof Error ? args[0] : undefined;
      const destroying = [...this.#fallbackPools.values()].map(p => p.destroy(err));
      this.#fallbackPools.clear();
      await Promise.all(destroying);
    }
    return super.destroy(...args);
  }
}

/** Desktop injects Chromium's per-URL system/PAC resolver after app.whenReady(). */
export function setSystemProxyResolver(resolver) {
  if (resolver !== null && typeof resolver !== 'function') throw new TypeError('Invalid system proxy resolver');
  systemProxyResolver = resolver;
}

export function redactProxyAddress(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
  } catch { return '[代理地址]'; }
}

export function proxyDispatcher(proxyUrl) {
  const address = normalizeProxyUrl(proxyUrl, { strict: true });
  if (!address) return streamDispatcher;
  let agent = proxyAgents.get(address);
  if (!agent) {
    try {
      const url = new URL(address);
      // Strip credentials from URL passed into undici so internal decodeURIComponent is never
      // invoked on already-decoded or literal-`%` passwords and credentials never sit in kProxy.uri.
      const cleanUrl = new URL(url.href);
      cleanUrl.username = '';
      cleanUrl.password = '';
      if (SOCKS_PROTOCOLS.has(url.protocol)) {
        if (cleanUrl.protocol === 'socks5h:') cleanUrl.protocol = 'socks5:';
        const username = url.username ? safeDecodeURIComponent(url.username) : null;
        const password = url.password ? safeDecodeURIComponent(url.password) : null;
        agent = new ConfiguredSocks5ProxyAgent(cleanUrl, {
          ...AGENT_OPTIONS,
          ...(username !== null ? { username } : {}),
          ...(password !== null ? { password } : {}),
        });
      } else {
        // Send even a username with an empty password; undici's implicit auth requires both.
        const token = ['http:', 'https:'].includes(url.protocol) && (url.username || url.password)
          ? 'Basic ' + Buffer.from(`${safeDecodeURIComponent(url.username)}:${safeDecodeURIComponent(url.password)}`).toString('base64')
          : undefined;
        agent = new ProxyAgent({ uri: cleanUrl.href, ...AGENT_OPTIONS, ...(token ? { token } : {}) });
      }
    } catch (error) {
      throw sanitizeProxyError(error, proxyUrl);
    }
    proxyAgents.set(address, agent);
  }
  return agent;
}

/** Explicit modes. An empty custom address must never silently send API keys directly. */
export function dispatcherFor(settings) {
  if (settings?.proxyMode === 'direct') return streamDispatcher;
  if (settings?.proxyMode === 'custom') {
    if (!String(settings.proxyUrl ?? '').trim()) throw new Error('选择“自定义”代理时，请填写代理地址并保存。');
    return proxyDispatcher(settings.proxyUrl);
  }
  return proxyDispatcher(settings?.globalProxyUrl);
}

/** Chromium returns DIRECT / PROXY host:port / HTTPS host:port / SOCKS5 host:port / SOCKS host:port. */
export function systemProxyAddress(result) {
  const first = String(result ?? '').split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error('系统代理返回了不支持的代理类型；请在设置中填写 HTTP、HTTPS 或 SOCKS5 全局代理地址。');
  const protocol = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS: 'socks5' }[match[1].toUpperCase()];
  return normalizeProxyUrl(`${protocol}://${match[2]}`, { strict: true });
}

function canonicalizeNoProxyHost(host) {
  const lower = String(host ?? '').toLowerCase();
  if (!lower) return '';
  if (net.isIPv6(lower)) {
    try { return new URL(`http://[${lower}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
    catch { return lower; }
  }
  return lower;
}

export function shouldBypassNoProxy(targetUrl, noProxyRaw) {
  const raw = String(noProxyRaw ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  let parsedTarget;
  try { parsedTarget = new URL(String(targetUrl)); } catch { return false; }
  const hostname = canonicalizeNoProxyHost(parsedTarget.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (!hostname) return false;
  const defaultPort = parsedTarget.protocol === 'https:' || parsedTarget.protocol === 'wss:' ? 443
    : parsedTarget.protocol === 'http:' || parsedTarget.protocol === 'ws:' ? 80 : 0;
  const port = Number.parseInt(parsedTarget.port, 10) || defaultPort;
  const targetIsIp = net.isIP(hostname) !== 0;

  for (const token of raw.split(/[,\s]+/)) {
    if (!token) continue;
    if (token === '*') return true;
    let entryHost = '';
    let entryPort = 0;
    let hasPort = false;

    if (token.startsWith('[')) {
      const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(token);
      if (!m) continue;
      entryHost = canonicalizeNoProxyHost(m[1]);
      if (m[2] !== undefined) {
        hasPort = true;
        entryPort = Number.parseInt(m[2], 10);
      }
    } else if (token.indexOf(':') !== -1 && token.indexOf(':') !== token.lastIndexOf(':')) {
      entryHost = canonicalizeNoProxyHost(token);
    } else if (token.includes(':')) {
      const m = /^([^:]+):(\d+)$/.exec(token);
      if (!m) continue;
      entryHost = m[1].replace(/^\*?\./, '').toLowerCase();
      hasPort = true;
      entryPort = Number.parseInt(m[2], 10);
    } else {
      entryHost = token.replace(/^\*?\./, '').toLowerCase();
    }

    if (!entryHost) continue;
    if (hasPort && (entryPort < 1 || entryPort > 65535 || entryPort !== port)) continue;
    if (hostname === entryHost) return true;
    if (!targetIsIp && net.isIP(entryHost) === 0 && hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

function resolveEnvProxyForUrl(targetUrl) {
  let protocol = 'http:';
  try { protocol = new URL(String(targetUrl)).protocol; } catch {}
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const allProxy = process.env.all_proxy ?? process.env.ALL_PROXY;
  const candidate = (protocol === 'https:' ? (httpsProxy || httpProxy || allProxy) : (httpProxy || allProxy)) ?? '';
  const trimmed = String(candidate).trim();
  if (!trimmed) return null;
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
  if (shouldBypassNoProxy(targetUrl, noProxy)) return '';
  return trimmed;
}

async function routeFor(url, settings) {
  if (settings?.proxyMode === 'direct') return { dispatcher: streamDispatcher, address: '' };
  if (settings?.proxyMode === 'custom' || String(settings?.globalProxyUrl ?? '').trim()) {
    return { dispatcher: dispatcherFor(settings), address: settings?.proxyMode === 'custom' ? settings.proxyUrl : settings.globalProxyUrl };
  }
  if (systemProxyResolver) {
    const address = systemProxyAddress(await systemProxyResolver(String(url)));
    return { dispatcher: proxyDispatcher(address), address };
  }
  // Standalone Node has no Chromium/system PAC service. Honour its conventional env proxies
  // (including NO_PROXY); route valid HTTP/HTTPS/SOCKS env proxies through proxyDispatcher so
  // SOCKS5 timeouts and literal-`%` credentials work identically here too.
  const envProxy = resolveEnvProxyForUrl(url);
  if (envProxy === '') return { dispatcher: streamDispatcher, address: '' };
  if (envProxy) {
    const normalized = normalizeProxyUrl(envProxy);
    if (normalized) return { dispatcher: proxyDispatcher(normalized), address: normalized };
    try {
      environmentAgent ??= new EnvHttpProxyAgent(AGENT_OPTIONS);
      return { dispatcher: environmentAgent, address: envProxy };
    } catch (error) {
      throw sanitizeProxyError(error, envProxy);
    }
  }
  return { dispatcher: streamDispatcher, address: null };
}

// 1.5.7: TLS is a transport, not proof that certificate verification failed.
// Classify concrete causes; never disable verification or silently fall back to direct routing.
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'CERT_SIGNATURE_FAILURE',
  'INVALID_CA', 'INVALID_PURPOSE', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED',
  'HOSTNAME_MISMATCH', 'DANE_NO_MATCH', 'EE_KEY_TOO_SMALL', 'CA_KEY_TOO_SMALL', 'CA_MD_TOO_WEAK',
]);
const CERTIFICATE_MESSAGE = /\b(?:self[- ]signed certificate|certificate (?:has expired|is not yet valid|verify failed|verification failed|has been revoked|is untrusted)|unable to (?:verify the first certificate|get (?:local )?issuer certificate)|hostname[^\r\n]*does not match (?:the )?certificate|host(?:name)?\/ip does not match certificate)/i;
const RESET_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ENETRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const RESET_MESSAGE = /socket hang up|other side closed|connection (?:was )?(?:reset|aborted|closed)|disconnected before secure TLS connection was established/i;
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Bounded, cycle-safe cause traversal shared by classification and retry guards. */
export function errorCauseChain(error) {
  const chain = [], seen = new Set();
  for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause) && chain.length < 32; cause = cause.cause) {
    seen.add(cause); chain.push(cause);
  }
  return chain;
}

export function hasPermanentFailure(error) {
  return errorCauseChain(error).some(cause => cause.permanent === true);
}

/** Return only safe categories and an error code, never arbitrary upstream text or credentials. */
export function classifyProxyFailure(error) {
  const chain = errorCauseChain(error);
  const codeOf = cause => String(cause.code ?? '').toUpperCase();
  const messageOf = cause => String(cause.message ?? '');
  // Concrete verification errors win over generic wrappers like "fetch failed" or ECONNRESET.
  const certificate = chain.find(cause => CERTIFICATE_CODES.has(codeOf(cause))
    || /^ERR_TLS_CERT_/.test(codeOf(cause)) || /^ERR_SSL_(?:CERTIFICATE_VERIFY_FAILED|SSLV3_ALERT_CERTIFICATE_EXPIRED|SSLV3_ALERT_CERTIFICATE_REVOKED|SSLV3_ALERT_BAD_CERTIFICATE|TLSV1_ALERT_UNKNOWN_CA)$/.test(codeOf(cause)))
    ?? chain.find(cause => CERTIFICATE_MESSAGE.test(messageOf(cause)));
  const reset = chain.find(cause => RESET_CODES.has(codeOf(cause)) || RESET_MESSAGE.test(messageOf(cause)));
  const timeout = chain.find(cause => TIMEOUT_CODES.has(codeOf(cause)) || /\btimeout\b|timed out/i.test(messageOf(cause)));
  // A protocol-level rejection wins, but an auth-phase timeout/reset is still transient.
  const authentication = chain.find(cause => Number(cause.status ?? cause.statusCode) === 407
    || ['UND_ERR_SOCKS5_AUTH_REJECTED', 'UND_ERR_SOCKS5_AUTH_FAILED', 'UND_ERR_SOCKS5_AUTH_METHOD'].includes(codeOf(cause))
    || /\bproxy authentication required\b|\bno acceptable authentication methods?\b|\busername and password required for authentication\b|\bproxy (?:response|status)(?: code)?\s*[:(]?\s*407\b|\b(?:HTTP\s+)?CONNECT\s+(?:(?:response|status)(?: code)?\s*[:(]?\s*)?407\b/i.test(messageOf(cause)))
    ?? (!reset && !timeout ? chain.find(cause => /\b(?:proxy authentication failed|authentication failed|auth failed)\b/i.test(messageOf(cause))) : null);
  const refused = chain.find(cause => codeOf(cause) === 'ECONNREFUSED');
  const dns = chain.find(cause => ['ENOTFOUND', 'EAI_AGAIN'].includes(codeOf(cause)));
  const tlsErr = chain.find(cause => /\b(?:TLS|SSL)\b/i.test(messageOf(cause)) || /^ERR_(?:TLS|SSL)_/.test(codeOf(cause)));
  const selected = certificate ?? authentication ?? reset ?? timeout ?? refused ?? dns ?? tlsErr;
  const kind = certificate ? 'certificate' : authentication ? 'authentication' : reset ? 'connection-reset'
    : timeout ? 'timeout' : refused ? 'connection-refused' : dns ? 'dns' : tlsErr ? 'tls-handshake' : 'connection';
  const coded = selected?.code ? selected : [...chain].reverse().find(cause => cause.code);
  return { kind, permanent: Boolean(certificate || authentication) || hasPermanentFailure(error), code: coded?.code ? String(coded.code) : undefined };
}

function proxyFailure(error, address) {
  const classification = classifyProxyFailure(error);
  const reasons = {
    certificate: '代理或目标的 TLS 证书校验失败，请检查证书、系统时间和证书信任链',
    authentication: '代理认证失败，请检查用户名和密码',
    'connection-reset': '代理或目标连接被重置或中断（可能发生在 TLS 握手期间）',
    'connection-refused': '端口拒绝连接，请确认代理软件已启动且 HTTP/SOCKS 端口正确',
    dns: '代理或目标域名解析失败',
    timeout: '连接代理或代理连接目标超时',
    'tls-handshake': '代理或目标的 TLS 握手失败（未确认是证书校验错误），请检查代理类型、端口和目标服务',
    connection: '代理连接或上游连接失败，请检查代理类型、端口和目标服务',
  };
  // Never echo the proxy URL's username/password or upstream's arbitrary error text.
  const reported = new Error(`经代理 ${redactProxyAddress(address)} 请求失败：${reasons[classification.kind]}。`, { cause: sanitizeProxyError(error, address) });
  reported.proxyFailure = true;
  reported.proxyFailureKind = classification.kind;
  if (classification.permanent) reported.permanent = true;
  if (classification.code) reported.code = classification.code;
  return reported;
}

/** Use the installed undici fetch and dispatcher together, on every protocol/list request. */
export async function providerFetch(url, init, settings) {
  let dispatcher, address;
  try {
    ({ dispatcher, address } = await routeFor(url, settings));
  } catch (error) {
    const candidate = settings?.proxyMode === 'custom' ? settings?.proxyUrl : settings?.globalProxyUrl;
    throw sanitizeProxyError(error, candidate);
  }
  if (init?.signal?.aborted) throw init.signal.reason;
  try { return await undiciFetch(url, { ...init, dispatcher }); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    if (!address) throw sanitizeProxyError(error, '');
    throw proxyFailure(error, address);
  }
}

/** For isolated tests/shutdown. Do not destroy shared agents while other requests are active. */
export async function closeProxyDispatchers() {
  const agents = [...proxyAgents.values()]; proxyAgents.clear();
  if (environmentAgent) { agents.push(environmentAgent); environmentAgent = undefined; }
  await Promise.all(agents.map(agent => agent.destroy()));
}
