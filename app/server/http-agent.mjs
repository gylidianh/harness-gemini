// Harness Gemini 1.4.9: explicit per-request model proxy routing.
// Deliberately do not replace global fetch or the browser's/session's proxy: localhost APIs,
// downloads and web tools have separate security/routing policies.
import { Agent, ProxyAgent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizeProxyUrl } from './provider-extra.mjs';

const AGENT_OPTIONS = {
  bodyTimeout: 0, headersTimeout: 300_000,
  keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000,
};
export const streamDispatcher = new Agent(AGENT_OPTIONS);
const proxyAgents = new Map();
let systemProxyResolver = null;
let environmentAgent;

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
    const url = new URL(address);
    // Send even a username with an empty password; undici's implicit auth requires both.
    const token = ['http:', 'https:'].includes(url.protocol) && (url.username || url.password)
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64') : undefined;
    agent = new ProxyAgent({ uri: address, ...AGENT_OPTIONS, ...(token ? { token } : {}) });
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

/** Chromium returns DIRECT / PROXY host:port / HTTPS host:port / SOCKS5 host:port. */
export function systemProxyAddress(result) {
  const first = String(result ?? '').split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error('系统代理返回了不支持的代理类型；请在设置中填写 HTTP、HTTPS 或 SOCKS5 全局代理地址。');
  const protocol = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5' }[match[1].toUpperCase()];
  return normalizeProxyUrl(`${protocol}://${match[2]}`, { strict: true });
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
  // (including NO_PROXY); an environment without proxy variables still connects directly.
  environmentAgent ??= new EnvHttpProxyAgent(AGENT_OPTIONS);
  return { dispatcher: environmentAgent, address: null };
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
  const tls = chain.find(cause => /\b(?:TLS|SSL)\b/i.test(messageOf(cause)) || /^ERR_(?:TLS|SSL)_/.test(codeOf(cause)));
  const selected = certificate ?? authentication ?? reset ?? timeout ?? refused ?? dns ?? tls;
  const kind = certificate ? 'certificate' : authentication ? 'authentication' : reset ? 'connection-reset'
    : timeout ? 'timeout' : refused ? 'connection-refused' : dns ? 'dns' : tls ? 'tls-handshake' : 'connection';
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
  const reported = new Error(`经代理 ${redactProxyAddress(address)} 请求失败：${reasons[classification.kind]}。`, { cause: error });
  reported.proxyFailure = true;
  reported.proxyFailureKind = classification.kind;
  if (classification.permanent) reported.permanent = true;
  if (classification.code) reported.code = classification.code;
  return reported;
}

/** Use the installed undici fetch and dispatcher together, on every protocol/list request. */
export async function providerFetch(url, init, settings) {
  const { dispatcher, address } = await routeFor(url, settings);
  if (init?.signal?.aborted) throw init.signal.reason;
  try { return await undiciFetch(url, { ...init, dispatcher }); }
  catch (error) {
    if (init?.signal?.aborted || !address) throw error;
    throw proxyFailure(error, address);
  }
}

/** For isolated tests/shutdown. Do not destroy shared agents while other requests are active. */
export async function closeProxyDispatchers() {
  const agents = [...proxyAgents.values()]; proxyAgents.clear();
  if (environmentAgent) { agents.push(environmentAgent); environmentAgent = undefined; }
  await Promise.all(agents.map(agent => agent.destroy()));
}
