// Network policy for the isolated browser. Chromium keeps the system proxy for the
// rest of the application, while this browser session uses a small loopback proxy so
// every HTTP/HTTPS/WebSocket connection can be checked and sent to a checked address.
import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ipaddr from 'ipaddr.js';
import { browserUrlAllowed, isLocalFileUrl, isPrivateWebUrl } from '../shared/browser-navigation.mjs';

const extraV4 = ['192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '168.63.129.16/32'].map(ipaddr.parseCIDR);
const extraV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(ipaddr.parseCIDR);
const globalV6 = ipaddr.parseCIDR('2000::/3');
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
const policyError = (message, code = 'NETWORK_DENIED') => Object.assign(new Error(message), { code });

export function isGlobalPublicAddress(address) {
  try {
    if (String(address).includes('%')) return false;
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv4') return !extraV4.some(range => ip.match(range));
    return ip.match(globalV6) && !extraV6.some(range => ip.match(range));
  } catch { return false; }
}

function localPath(value) {
  if (!isLocalFileUrl(value)) throw new Error('INVALID_LOCAL_FILE');
  const url = new URL(value);
  const decoded = decodeURIComponent(url.pathname);
  if (/[\u0000-\u001f\u007f]/.test(decoded) || /%2f|%5c/i.test(url.pathname)) throw new Error('INVALID_LOCAL_FILE');
  const filename = fileURLToPath(url);
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(filename) || filename.slice(2).includes(':') || filename.split(/[\\/]/).some(part => /[. ]$/.test(part)))) throw new Error('INVALID_LOCAL_FILE');
  return filename;
}

/**
 * fix3: the proxy of the local-file browser session. It refuses every request and every tunnel, so a
 * local page has no network at all: not through fetch or a form, and not through anything that
 * bypasses the request hook either (prefetch, WebRTC over TCP, a beacon sent while unloading).
 */
export function createOfflineProxy() {
  let server;
  let starting;
  const sockets = new Set();
  const refuse = socket => {
    try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
  };
  let stopped = false;
  function start() {
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      server = http.createServer((_req, res) => { res.writeHead(403, { Connection: 'close', 'Content-Length': '0' }); res.end(); });
      server.on('connect', (_req, socket) => refuse(socket));
      server.on('upgrade', (_req, socket) => refuse(socket));
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        if (stopped) { server.close(); reject(new Error('浏览器已关闭。')); return; }
        resolve({ host: '127.0.0.1', port: server.address().port });
      });
    });
    return starting;
  }
  async function close() {
    stopped = true;
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    sockets.clear();
    if (server?.listening) await new Promise(resolve => server.close(() => resolve()));
    if (starting) await starting.catch(() => {});
  }
  return { start, close };
}

export function createLocalRoot(value) {
  const file = realpathSync.native(localPath(value));
  if (!statSync(file).isFile()) throw new Error('请选择一个可读取的本地文件。');
  const directory = path.dirname(file);
  return Object.freeze({ directory, atFilesystemRoot: path.parse(directory).root === directory });
}

export function localFileInRoot(value, root) {
  if (!root?.directory) return false;
  try {
    const actual = realpathSync.native(localPath(value));
    const relative = path.relative(root.directory, actual);
    return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && (!root.atFilesystemRoot || !relative.includes(path.sep)) && statSync(actual).isFile();
  } catch { return false; }
}

export const originOf = value => {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.origin;
};
const hostOf = value => new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
const portOf = value => new URL(value).port || (['https:', 'wss:'].includes(new URL(value).protocol) ? 443 : 80);

export function createBrowserNetworkPolicy({ appOrigin, lookup = dnsLookup, timeoutMs = 3000, cacheMs = 2000, proxied: initialProxied = false } = {}) {
  const allowedPrivateOrigins = new Set();
  const answers = new Map();
  const sockets = new Set();
  let closed = false;
  // fix5: true while a system proxy (Clash, a company gateway) carries this traffic. See resolve().
  let proxied = initialProxied === true;
  let proxy;
  let proxyPort = 0;
  let proxyStart;

  function target(value) {
    if (closed || !browserUrlAllowed(value, appOrigin, { resource: true })) throw policyError('此地址不能在内置浏览器中打开。');
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw policyError('不支持的网络协议。');
    return { url, hostname: hostOf(value), origin: originOf(value), port: portOf(value) };
  }

  async function dns(hostname, fresh = false) {
    const old = answers.get(hostname);
    if (!fresh && old && Date.now() - old.at < cacheMs) return old.task;
    let timer;
    const task = Promise.race([
      Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(policyError('无法确认目标是公网地址；请直接打开该地址并审批。', 'PRIVATE_NETWORK')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (answers.size > 512) answers.clear();
    answers.set(hostname, { at: Date.now(), task });
    return task;
  }

  async function recordsFor(endpoint, fresh = false) {
    if (net.isIP(endpoint.hostname)) return [{ address: endpoint.hostname }];
    return dns(endpoint.hostname, fresh);
  }

  /**
   * fix6: the browser panel refuses nothing on the network. This only checks the address's shape
   * and the app's own service port (both inside browserUrlAllowed) and reports the origin, so the
   * caller can decide nothing at all. Local files never reach here: they live in their own
   * offline session.
   */
  async function resolve(value) {
    const endpoint = target(value);
    if (closed) throw policyError('浏览器已关闭。');
    return { ...endpoint, address: null, private: false };
  }

  /** Where the panel's own proxy connects. Any address is usable, this machine's included. */
  async function addressFor(value) {
    const endpoint = target(value);
    let records;
    try { records = await recordsFor(endpoint); }
    catch { throw policyError('无法解析目标地址。', 'PRIVATE_NETWORK'); }
    if (closed) throw policyError('浏览器已关闭。');
    if (!Array.isArray(records) || !records.length || records.length > 64) throw policyError('无法确认目标地址。', 'PRIVATE_NETWORK');
    return { endpoint, address: records[0].address };
  }

  /** fix6: there is nothing to approve. The value only has to be a well-formed address. */
  async function authorize(value) {
    const endpoint = target(value);
    return { origin: endpoint.origin, allowPrivateNetwork: false };
  }

  function stripHopHeaders(headers) {
    const connectionTokens = new Set(String(headers?.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
    const result = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      const lower = key.toLowerCase();
      if (HOP_HEADERS.has(lower) || connectionTokens.has(lower) || lower === 'alt-svc') continue;
      result[key] = value;
    }
    return result;
  }

  async function handleHttp(req, res) {
    let destination;
    try { destination = await addressFor(req.url); }
    catch (error) { res.writeHead(error?.code === 'PRIVATE_NETWORK' ? 403 : 400); res.end('Forbidden'); return; }
    if (closed) { try { res.writeHead(503); res.end(); } catch {} return; }
    const { endpoint, address } = destination;
    const headers = stripHopHeaders(req.headers);
    headers.host = endpoint.url.host;
    const request = http.request({ protocol: endpoint.url.protocol, hostname: address, port: endpoint.port, path: `${endpoint.url.pathname}${endpoint.url.search}`, method: req.method, headers, servername: endpoint.hostname, agent: false }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, stripHopHeaders(upstream.headers));
      upstream.pipe(res);
    });
    sockets.add(request);
    request.once('close', () => sockets.delete(request));
    request.once('error', () => { if (!res.headersSent) res.writeHead(502); if (!res.writableEnded) res.end('Bad Gateway'); });
    req.pipe(request);
  }

  function rejectSocket(socket, status = '403 Forbidden') {
    try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
    socket.destroy();
  }

  async function handleConnect(req, socket) {
    let endpoint;
    try {
      const authority = String(req.url ?? '');
      if (!/^\[[0-9a-f:]+\]:[1-9][0-9]{0,4}$/i.test(authority) && !/^[^:]+:[1-9][0-9]{0,4}$/.test(authority)) throw policyError('CONNECT 地址不正确.');
      endpoint = await addressFor(`https://${authority}`);
    } catch { rejectSocket(socket); return; }
    if (closed) { rejectSocket(socket, '503 Service Unavailable'); return; }
    const targetSocket = net.connect(endpoint.endpoint.port, endpoint.address);
    sockets.add(targetSocket);
    targetSocket.once('close', () => sockets.delete(targetSocket));
    targetSocket.once('error', () => socket.destroy());
    targetSocket.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(targetSocket); targetSocket.pipe(socket);
    });
  }

  async function handleUpgrade(req, socket, head) {
    try {
      const endpoint = await addressFor(req.url);
      if (closed) { rejectSocket(socket, '503 Service Unavailable'); return; }
      const headers = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([key]) => !['proxy-connection', 'proxy-authorization', 'proxy-authenticate'].includes(key.toLowerCase())));
      headers.host = endpoint.endpoint.url.host;
      const targetSocket = net.connect(endpoint.endpoint.port, endpoint.address);
      sockets.add(targetSocket);
      targetSocket.once('close', () => sockets.delete(targetSocket));
      targetSocket.once('error', () => socket.destroy());
      targetSocket.setTimeout(5000, () => { targetSocket.destroy(); socket.destroy(); });
      targetSocket.once('connect', () => {
        targetSocket.setTimeout(0); // 1.3.3-fix2: the 5 s limit is for connecting only, not for an idle WebSocket.
        const pathName = `${new URL(req.url).pathname}${new URL(req.url).search}`;
        const lines = [`${req.method} ${pathName} HTTP/${req.httpVersion}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`), '', ''];
        targetSocket.write(lines.join('\r\n'));
        if (head?.length) targetSocket.write(head);
        socket.pipe(targetSocket); targetSocket.pipe(socket);
      });
    } catch { rejectSocket(socket); }
  }

  async function start() {
    if (proxyStart) return proxyStart;
    proxyStart = new Promise((resolve, reject) => {
      proxy = http.createServer((req, res) => { void handleHttp(req, res); });
      proxy.on('connect', (req, socket) => { void handleConnect(req, socket); });
      proxy.on('upgrade', (req, socket, head) => { void handleUpgrade(req, socket, head); });
      proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => {
        if (closed) { proxy.close(); reject(policyError('浏览器已关闭。')); return; }
        proxyPort = proxy.address().port; resolve({ port: proxyPort, host: '127.0.0.1' });
      });
    });
    return proxyStart;
  }

  async function close() {
    if (closed) return;
    closed = true; answers.clear(); allowedPrivateOrigins.clear();
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    sockets.clear();
    if (proxy?.listening) await new Promise(resolve => proxy.close(() => resolve()));
    // A start() still in progress settles (rejected) instead of hanging.
    if (proxyStart) await proxyStart.catch(() => {});
  }

  return {
    resolve, authorize, start, close, originOf,
    /** fix5: the session's traffic goes through a system proxy; names are not pinned locally. */
    setProxied: value => { proxied = value === true; },
    isPrivateOriginAuthorized: value => { try { return allowedPrivateOrigins.has(originOf(value)); } catch { return false; } },
  };
}
