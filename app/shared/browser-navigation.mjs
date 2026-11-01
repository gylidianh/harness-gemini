// Shared by the desktop browser and the sandboxed web development preview.
export const MAX_BROWSER_INPUT = 4_096;
const effectivePort = url => url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');

/**
 * A local file address, in the only shape the browser is allowed to load.
 *
 * Only the plain `file:` form is accepted: no credentials, no remote host, and no encoded
 * traversal that would name a different volume than the one that was typed. Windows drive
 * letters and POSIX paths both normalise to the same `file:///...` shape.
 */
export function normalizeFileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim().replace(/\\/g, '/');
  let url;
  if (/^file:/i.test(input)) {
    try { url = new URL(input); } catch { return null; }
    // `file://host/share` names a network share; that is a remote resource, not a local file.
    if (url.hostname && url.hostname !== 'localhost') return null;
  } else if (/^[a-zA-Z]:\//.test(input)) {
    // An OS path names literal characters: #, ? and % must not become URL syntax.
    try { url = new URL(`file:///${input.slice(0, 2)}${input.slice(2).split('/').map(encodeURIComponent).join('/')}`); } catch { return null; }
  } else if (input.startsWith('//')) {
    // A UNC path such as \\server\share\file is deliberately not accepted: it reaches the
    // network, and the built-in browser is for local files.
    return null;
  } else if (input.startsWith('/')) {
    try { url = new URL(`file://${input.split('/').map(encodeURIComponent).join('/')}`); } catch { return null; }
  } else return null;
  if (url.protocol !== 'file:' || url.username || url.password) return null;
  if (url.hostname && url.hostname !== 'localhost') return null;
  // Encoded separators are ambiguous across URL and Windows path parsers; reject them
  // instead of letting one layer interpret them as a path separator.
  if (/%2f|%5c/i.test(input) || /%2f|%5c/i.test(url.pathname)) return null;
  return url.href;
}

/**
 * The address one browser tool may act on: a public page or, when the user allows it, a local
 * file. Anything else keeps the public-web rules, so this can never widen the fetch tools.
 */
export function normalizeBrowserAddress(value) {
  const local = normalizeFileUrl(value);
  if (local) return local;
  return null;
}

/** True when the address is a local file the browser may load or embed. */
export function isLocalFileUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && !url.username && !url.password && (!url.hostname || url.hostname === 'localhost');
  } catch { return false; }
}

/** Limit local file subresources to the directory containing the trusted page. */
export function localResourceAllowed(resourceUrl, pageUrl) {
  if (!isLocalFileUrl(resourceUrl)) return !/^file:/i.test(String(resourceUrl));
  if (!isLocalFileUrl(pageUrl)) return false;
  let resource, page;
  try { resource=decodeURIComponent(new URL(resourceUrl).pathname).replace(/\\/g,'/'); page=decodeURIComponent(new URL(pageUrl).pathname).replace(/\\/g,'/'); } catch { return false; }
  const dir=page.slice(0,page.lastIndexOf('/')+1);
  if (!dir || !resource.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(resource)) return false;
  const fold=x=>/^\/[A-Za-z]:\//.test(dir)?x.toLowerCase():x;
  if (!fold(resource).startsWith(fold(dir))) return false;
  if (dir==='/' || /^\/[A-Za-z]:\/$/.test(dir)) return !resource.slice(dir.length).includes('/');
  return true;
}
/** An IPv4 literal (already normalised by the URL parser) outside the global unicast space; null when not IPv4. */
function privateIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(part => part > 255)) return null;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || (a === 168 && b === 63 && c === 129 && d === 16);
}

/** The eight hextets of an IPv6 literal, or null when the host is not one. */
function ipv6Hextets(host) {
  if (!host.includes(':') || !/^[0-9a-f:.]+$/i.test(host)) return null;
  let text = host;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const n = dotted.slice(1).map(Number);
    if (n.some(part => part > 255)) return null;
    text = text.slice(0, dotted.index) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return parts.map(part => parseInt(part, 16));
}

/** An IPv6 literal outside the global unicast space (same ranges as the desktop network policy); null when not IPv6. */
function privateIPv6(host) {
  const h = ipv6Hextets(host);
  if (!h) return null;
  if (h.slice(0, 5).every(part => part === 0) && h[5] === 0xffff) {
    return privateIPv4([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.')) !== false;
  }
  if (h[0] < 0x2000 || h[0] > 0x3fff) return true;
  if (h[0] === 0x2001 && (h[1] < 0x0200 || h[1] === 0x0db8)) return true;
  if (h[0] === 0x2002) return true;
  if (h[0] === 0x3fff && h[1] < 0x1000) return true;
  return false;
}

/**
 * True when the address names this computer or a local network: an IP literal outside the global
 * unicast space, a local-only name, or a single-label name (hosts file / search domain).
 * 1.3.3-fix2: only IP literals are matched by prefix. A prefix test on every hostname used to call
 * fc2.com or fcbarcelona.com "private", while fd00::/8, 100.64.0.0/10 and [::ffff:7f00:1] slipped
 * through and were refused later with no way to approve them.
 */
export function isPrivateWebUrl(value) {
  let host;
  try { host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { return false; }
  if (!host) return false;
  const v6 = privateIPv6(host);
  if (v6 !== null) return v6;
  const v4 = privateIPv4(host);
  if (v4 !== null) return v4;
  if (host === 'localhost' || host === 'metadata' || /\.(?:localhost|local|internal|lan|intranet|home\.arpa)$/.test(host)) return true;
  return !host.includes('.');
}

/** The browser never gets access to the app service, even through another DNS name. */
export function browserUrlAllowed(value, appOrigin, { resource = false, blank = false } = {}) {
  if (typeof value !== 'string' || value.length > (resource ? 2 * 1024 * 1024 : MAX_BROWSER_INPUT)) return false;
  if (value === 'about:blank') return blank || resource;
  // A local file carries no origin and no port, so it can never reach the app service; it is
  // allowed both as a page and as an embedded resource of another local page.
  if (isLocalFileUrl(value)) return true;
  try {
    const url = new URL(value);
    if (resource && url.protocol === 'data:') return true;
    if (resource && url.protocol === 'blob:') return browserUrlAllowed(url.pathname, appOrigin);
    const protocols = resource ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.port === '0') return false;
    const app = new URL(appOrigin);
    // Blocking the service port on every hostname also closes aliases, redirects,
    // DNS rebinding, WebSockets and embedded requests into the private app API.
    return url.origin !== app.origin && effectivePort(url) !== effectivePort(app);
  } catch { return false; }
}

export function normalizeBrowserInput(value, appOrigin) {
  if (typeof value !== 'string' || value.length > MAX_BROWSER_INPUT || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('请输入有效的网址或搜索内容。');
  const input = value.trim();
  if (!input) return '';
  let url;
  // A local file is recognised before anything else, so `C:\page.html` and `file:///C:/page.html`
  // both open the file instead of being treated as a search term.
  const local = /^(?:file:|[a-zA-Z]:[\\/]|\/\/|\\\\|\/)/.test(input) ? normalizeFileUrl(input) : null;
  if (local) return local;
  if (/^(?:file:|[a-zA-Z]:[\\/])/i.test(input)) throw new Error('这个本地文件地址不正确，请使用完整的 file:/// 路径。');
  if (/^https?:/i.test(input)) {
    try { url = new URL(input).href; } catch { throw new Error('这个网址格式不正确。'); }
  } else {
    const hostWithPort = /^(?:localhost|\[[0-9a-f:]+\]|[\p{L}\p{N}._-]+):\d+(?:[/?#]|$)/iu.test(input);
    if (/^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort) throw new Error('内置浏览器仅支持 HTTP、HTTPS 和本地 file:// 文件。');
    if (!/\s/.test(input) && (input.includes('.') || hostWithPort || /^localhost(?:[/?#]|$)/i.test(input) || input.startsWith('[') || input.startsWith('//'))) {
      try { url = new URL(input.startsWith('//') ? `https:${input}` : `https://${input}`).href; }
      catch { throw new Error('这个网址格式不正确。'); }
    } else url = `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  }
  if (!browserUrlAllowed(url, appOrigin)) throw new Error('此地址不能在内置浏览器中打开。');
  return url;
}

export function browserResourceAllowed(value, appOrigin, authorization, { resource = false, localFileCheck = null } = {}) {
  if (!authorization || !['local','network','blank'].includes(authorization.kind)) return false;
  if (!browserUrlAllowed(value, appOrigin, { resource, blank: value === 'about:blank' })) return false;
  if (isLocalFileUrl(value)) return authorization.kind === 'local'
    && (typeof localFileCheck !== 'function' || localFileCheck(value, authorization.root));
  if (value === 'about:blank') return true;
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol === 'data:') return resource;
  if (url.protocol === 'blob:') return resource;
  return authorization.kind === 'network' && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
}
