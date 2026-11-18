// Remote-connection settings owned by the desktop shell.
//
// One place decides what the remote link is allowed to do, so the settings page, the link and
// the audit trail can never disagree. Everything here is plain Node: the module is testable
// without Electron, and the shell only supplies the loopback origin and the harness.
//
// Two modes, one config file, one device list:
//
//   direct  phone → this app over Wi-Fi, or phone → Cloudflare tunnel → this app. No server of
//           your own, nothing to deploy, works out of the box.
//   relay   phone → your VPS (a dumb pipe) → this app dials out. Kept because it is the only
//           mode with background notifications, and because some networks block everything
//           except an ordinary HTTPS port on a host you control.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomSecret, sha256Hex } from '../shared/relay-protocol.mjs';
import { DEFAULT_PORT } from '../server/remote-direct.mjs';
import { createTunnel, downloadCloudflared, findCloudflared } from './remote-tunnel.mjs';

const CONFIG_NAME = 'relay-config.json';
const CONFIG_MODE = 0o600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEVICES = 8;
const MAX_TOKEN = 512;
const MAX_PATH = 1_024;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const FOUND_TTL_MS = 5_000;
const RELAY_SYNC_TIMEOUT_MS = 3_000;
export const REMOTE_MODES = Object.freeze(['direct', 'relay']);

function bad(message) { return new Error(message); }

/** A relay address, normalised: no credentials, no trailing slash, http(s) only. */
export function normalizeRelayUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw bad('请填写中继地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw bad('中继地址不是有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw bad('中继地址必须是 http 或 https。');
  if (url.username || url.password) throw bad('中继地址里不要带账号或密码。');
  if (url.search || url.hash) throw bad('中继地址不要带查询参数或片段。');
  const clean = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return clean;
}

/** A listening port the direct host can use: never privileged, never zero. */
export function normalizeDirectPort(value) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw bad('直连端口要在 1024–65535 之间。');
  return port;
}

/**
 * Reads a candidate config into the exact shape the clients expect, or throws with a message
 * that says which field is wrong. `previous` keeps a pairing secret across unrelated saves.
 */
export function normalizeRelayConfig(raw, previous = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('远程连接配置格式不正确。');
  const secret = typeof raw.pairSecret === 'string' && SECRET_SHAPE.test(raw.pairSecret)
    ? raw.pairSecret
    : previous?.pairSecret;
  if (!secret) throw bad('缺少配对密钥。');
  const devices = [];
  for (const entry of Array.isArray(raw.devices) ? raw.devices : []) {
    const deviceId = typeof entry === 'string' ? entry : entry?.deviceId;
    if (typeof deviceId !== 'string' || !UUID.test(deviceId)) continue;
    const key = deviceId.toLowerCase();
    if (devices.some(device => device.deviceId === key)) continue;
    const token = typeof entry?.token === 'string' && SECRET_SHAPE.test(entry.token) ? entry.token : '';
    const transport = entry?.transport === 'plain' ? 'plain' : entry?.transport === 'sealed' ? 'sealed' : '';
    devices.push({ deviceId: key, ...(token ? { token } : {}), ...(transport ? { transport } : {}) });
  }
  // An older file has a relay url and no mode: that is a relay config, not a direct one.
  const mode = REMOTE_MODES.includes(raw.mode)
    ? raw.mode
    : (previous?.mode ?? (raw.url || raw.relayToken ? 'relay' : 'direct'));
  const port = normalizeDirectPort(raw.directPort);
  const tunnelPath = typeof raw.tunnelPath === 'string' ? raw.tunnelPath.trim().slice(0, MAX_PATH) : '';
  return {
    mode,
    enabled: raw.enabled === true,
    url: raw.url === undefined || raw.url === '' ? '' : normalizeRelayUrl(raw.url),
    relayToken: typeof raw.relayToken === 'string' ? raw.relayToken.trim().slice(0, MAX_TOKEN) : '',
    pairSecret: secret,
    dispatchEnabled: raw.dispatchEnabled === true,
    devices: devices.slice(0, MAX_DEVICES),
    directPort: port ?? previous?.directPort ?? DEFAULT_PORT,
    allowPlainLan: raw.allowPlainLan === undefined ? previous?.allowPlainLan !== false : raw.allowPlainLan === true,
    tunnelEnabled: raw.tunnelEnabled === true,
    tunnelPath: tunnelPath || (previous?.tunnelPath ?? ''),
  };
}

/**
 * @param {object} options
 * @param {string} options.dataDir        where relay-config.json lives (next to settings.json)
 * @param {() => string} options.getOrigin loopback origin, available only after the service starts
 * @param {() => object} options.getHarness app.locals.harness
 */
export function createRemoteSettings({
  dataDir,
  getOrigin,
  getHarness,
  log = () => {},
  platform = process.platform,
  fetchImpl = globalThis.fetch,
}) {
  const file = path.join(path.resolve(dataDir), CONFIG_NAME);
  let config = null;
  let relayClient = null;
  let directHost = null;
  let tunnel = null;
  let lastError = '';
  let found = { at: 0, value: null };
  let pending = Promise.resolve();
  let linkGeneration = 0;
  let installation = null;

  // Serialize the entire read/validate/modify/write/apply transaction, not just writes.
  // Private helpers never enqueue: awaiting another queued operation here would deadlock.
  // Keep the caller's rejection, but recover the tail so a failed save cannot poison it.
  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  function persistPaired(device, generation) {
    return enqueue(async () => {
      // A stopped/replaced link must not resurrect a revoked or rotated device.
      if (generation !== linkGeneration || !config?.enabled) return false;
      const key = typeof device?.deviceId === 'string' ? device.deviceId.toLowerCase() : '';
      if (!UUID.test(key)) return false;
      if (config.devices.some(entry => entry.deviceId === key)) return true;
      if (config.devices.length >= MAX_DEVICES) {
        log(`remote pairing refused: device limit (${MAX_DEVICES}) reached, revoking ${key}`);
        relayClient?.revoke(key, { sync: false });
        directHost?.revoke(key);
        if (config.mode === 'relay') await syncRelayRevoke(config, key);
        return false;
      }
      await save({ ...config, devices: [...config.devices, { ...device, deviceId: key }] });
      return true;
    });
  }

  /**
   * Best-effort immediate sync of `codeHash` (and device list / rotation flag) to the VPS relay.
   * Never throws: offline edits must still persist locally, and `relayClient.connect()` will also
   * re-register whenever the link comes up.
   */
  async function syncRelayRegister(target, { clearDevices = false } = {}) {
    if (typeof fetchImpl !== 'function') return;
    const url = typeof target?.url === 'string' ? target.url.trim() : '';
    const token = typeof target?.relayToken === 'string' ? target.relayToken.trim() : '';
    const secret = typeof target?.pairSecret === 'string' ? target.pairSecret : '';
    if (!url || !token || !secret) return;
    try {
      const codeHash = await sha256Hex(secret);
      const devices = clearDevices
        ? []
        : (Array.isArray(target.devices)
          ? target.devices
            .map(entry => (typeof entry === 'string' ? entry : entry?.deviceId))
            .filter(id => typeof id === 'string' && UUID.test(id))
            .map(id => id.toLowerCase())
            .slice(0, MAX_DEVICES)
          : []);
      const response = await fetchImpl(new URL('/harness/register', `${url.replace(/\/+$/, '')}/`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          codeHash,
          devices,
          ...(clearDevices ? { clearDevices: true } : { preserveUnacked: true }),
        }),
        signal: AbortSignal.timeout(RELAY_SYNC_TIMEOUT_MS),
      });
      if (!response?.ok) log(`relay register returned ${response?.status}`);
    } catch (error) {
      log('relay register sync deferred until connect', error);
    }
  }

  /** Best-effort immediate device revocation on the VPS relay so MAX_DEVICES slots are freed. */
  async function syncRelayRevoke(target, deviceId) {
    if (typeof fetchImpl !== 'function') return;
    const url = typeof target?.url === 'string' ? target.url.trim() : '';
    const token = typeof target?.relayToken === 'string' ? target.relayToken.trim() : '';
    const normalized = typeof deviceId === 'string' ? deviceId.toLowerCase() : '';
    if (!url || !token || !UUID.test(normalized)) return;
    try {
      const response = await fetchImpl(new URL('/harness/revoke', `${url.replace(/\/+$/, '')}/`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: normalized }),
        signal: AbortSignal.timeout(RELAY_SYNC_TIMEOUT_MS),
      });
      if (!response?.ok) log(`relay revoke returned ${response?.status}`);
    } catch (error) {
      log('relay revoke sync deferred until reconnect', error);
    }
  }

  async function readConfig() {
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw bad('relay-config.json 不是有效的 JSON。'); }
    return normalizeRelayConfig(parsed, config);
  }

  /** Written to a sibling temp file first: a half-written config would break the next start. */
  async function writeConfig(next) {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: CONFIG_MODE });
    await fs.rename(temporary, file);
    try { await fs.chmod(file, CONFIG_MODE); } catch { /* Windows ignores POSIX modes. */ }
  }

  async function save(next) {
    await writeConfig(next);
    config = next;
    found = { at: 0, value: null };
    return config;
  }

  function proxyUrl() {
    try { return String(getHarness()?.store?.settings?.globalProxyUrl ?? ''); }
    catch { return ''; }
  }

  /** One stat sweep per five seconds at most: status() is polled every three. */
  function cloudflared() {
    if (Date.now() - found.at < FOUND_TTL_MS) return found.value;
    let value = null;
    try { value = findCloudflared({ dataDir, configured: config?.tunnelPath ?? '', platform }); }
    catch { value = null; }
    found = { at: Date.now(), value };
    return value;
  }

  function startTunnel() {
    if (!directHost || config?.mode !== 'direct' || tunnel) return;
    const { port } = directHost.describe();
    if (!port) return;
    tunnel = createTunnel({
      dataDir,
      port,
      configured: config.tunnelPath,
      platform,
      fetchImpl,
      log,
      proxyUrl: proxyUrl(),
    });
    tunnel.start();
  }

  async function stopLinks() {
    linkGeneration += 1;
    tunnel?.stop();
    tunnel = null;
    relayClient?.stop();
    relayClient = null;
    const host = directHost;
    directHost = null;
    if (host) { try { await host.stop(); } catch (error) { log('direct host stop failed', error); } }
  }

  async function apply() {
    await stopLinks();
    if (config?.enabled !== true) return;
    const origin = getOrigin();
    const harness = getHarness();
    const generation = linkGeneration;
    if (!origin || !harness) throw bad('本机服务尚未就绪，无法启用远程连接。');
    if (config.mode === 'relay') {
      const { createRelayClient } = await import('./relay-client.mjs');
      relayClient = createRelayClient({
        origin, harness, dataDir,
        // A live getter: "允许派发" is a switch in the settings page, and it has to take effect
        // on the link that is already up.
        config: () => config,
        log,
        fetchImpl,
        // A paired phone is persisted immediately: the settings page must be able to revoke a
        // device that was added while it happened to be closed.
        onPaired: deviceId => persistPaired({ deviceId: String(deviceId ?? '').toLowerCase() }, generation),
      });
      relayClient.start();
      return;
    }
    const { createDirectHost } = await import('../server/remote-direct.mjs');
    directHost = createDirectHost({
      origin, harness, dataDir,
      config: () => config,
      log,
      fetchImpl,
      onPaired: device => persistPaired({
        deviceId: String(device.deviceId ?? '').toLowerCase(), token: device.token, transport: device.transport,
      }, generation),
    });
    await directHost.start({ listenPort: config.directPort });
    if (config.tunnelEnabled) startTunnel();
  }

  /** The one status shape the settings page and the tests both read. */
  function status() {
    let relay = { state: 'offline', error: '', devices: 0 };
    try { relay = { ...relay, ...(relayClient?.status?.() ?? {}) }; } catch { /* never throw from status */ }
    let direct = { state: 'offline', error: '', urls: [], port: 0, devices: 0 };
    try {
      if (directHost) direct = { ...direct, ...directHost.status(), plainText: directHost.describe().plainText };
    } catch { /* never throw from status */ }
    let tunnelState = { state: 'stopped', url: '', reachable: false, error: '', binary: '', source: '', lines: [] };
    try { if (tunnel) tunnelState = tunnel.status(); } catch { /* never throw from status */ }

    const mode = config?.mode ?? 'direct';
    const known = Array.isArray(config?.devices) ? config.devices : [];
    const liveIds = new Set([
      ...(relayClient?.describe?.().devices ?? []).map(id => String(id).toLowerCase()),
      ...(directHost?.describe?.().devices ?? []).map(id => String(id).toLowerCase()),
    ]);
    const directUrls = Array.isArray(direct.urls) ? direct.urls : [];
    const tunnelReady = tunnelState.state === 'ready' && Boolean(tunnelState.url);
    const primary = mode === 'relay'
      ? (config?.url ?? '')
      : (tunnelReady ? tunnelState.url : (directUrls[0] ?? ''));
    const state = mode === 'relay'
      ? (typeof relay.state === 'string' ? relay.state : 'offline')
      : (direct.state === 'listening' ? 'connected' : direct.state === 'error' ? 'error' : 'offline');
    const configured = mode === 'relay'
      ? Boolean(config?.url && config?.relayToken)
      : Boolean(directHost && direct.state === 'listening');
    const available = cloudflared();
    return {
      mode,
      enabled: config?.enabled === true,
      configured,
      hasSecret: Boolean(config?.pairSecret),
      url: primary,
      state,
      error: (typeof direct.error === 'string' && direct.error ? direct.error : '')
        || (typeof relay.error === 'string' && relay.error ? relay.error : '')
        || lastError,
      dispatchEnabled: config?.dispatchEnabled === true,
      deviceLimit: MAX_DEVICES,
      allowPlainLan: config?.allowPlainLan !== false,
      directPort: config?.directPort ?? DEFAULT_PORT,
      devices: known.map(device => {
        const normalizedId = String(device.deviceId ?? '').toLowerCase();
        return {
          deviceId: normalizedId,
          label: `手机 ${normalizedId.slice(0, 4)}·${normalizedId.slice(-4)}`,
          live: liveIds.has(normalizedId),
          transport: device.transport === 'plain' ? 'plain' : device.transport === 'sealed' ? 'sealed' : '',
        };
      }),
      direct: {
        state: direct.state,
        port: direct.port ?? 0,
        urls: directUrls,
        devices: direct.devices ?? 0,
        plainText: direct.plainText !== false,
        error: direct.error ?? '',
      },
      relay: {
        url: config?.url ?? '',
        tokenSet: Boolean(config?.relayToken),
        state: relay.state ?? 'offline',
        error: relay.error ?? '',
        devices: relay.devices ?? 0,
      },
      tunnel: {
        state: tunnelState.state,
        url: tunnelState.url,
        reachable: tunnelState.reachable === true,
        error: tunnelState.error ?? '',
        binary: tunnelState.binary || available?.path || '',
        source: tunnelState.source || available?.source || '',
        installed: Boolean(available),
        lines: Array.isArray(tunnelState.lines) ? tunnelState.lines.slice(-6) : [],
      },
      tunnelEnabled: config?.tunnelEnabled === true,
    };
  }

  const api = {
    /** Never throws: a broken config must not stop the app from starting. */
    async start() {
      await stopLinks();
      try {
        const loaded = await readConfig();
        config = loaded;
        lastError = '';
        if (loaded?.enabled) await apply();
      } catch (error) {
        lastError = typeof error?.message === 'string' ? error.message : '远程连接配置无法读取。';
        config = null;
        log('remote settings unavailable', error);
      }
      return status();
    },

    async stop() {
      await stopLinks();
    },

    status,

    /** The pairing link, secret included. Only handed out after the user asks to see it. */
    pairLink() {
      if (config?.enabled !== true || !config.pairSecret) throw bad('远程连接未启用。');
      if (config.mode === 'relay') {
        return { link: `${config.url.replace(/\/+$/, '')}/#c=${config.pairSecret}`, url: config.url, urls: [config.url] };
      }
      const urls = directHost?.describe?.().urls ?? [];
      const tunnelState = tunnel?.status?.() ?? null;
      // The tunnel wins when it is up: an https address is the one that works off the Wi-Fi,
      // and it is also the one whose payloads are sealed rather than plain.
      const tunnelUrl = tunnelState?.state === 'ready' ? tunnelState.url : '';
      const primary = tunnelUrl || urls[0] || '';
      if (!primary) throw bad('直连还没有可用的地址，请先开启局域网直连。');
      return { link: `${primary}/#c=${config.pairSecret}`, url: primary, urls: tunnelUrl ? [tunnelUrl, ...urls] : urls };
    },

    /**
     * Turns the link on. `mode` decides which one; the other mode's settings are kept, so
     * switching back and forth never asks the user to fill anything in again. An old-style
     * call with just a relay url and token means relay mode.
     */
    async enable(input) {
      const requested = input?.mode;
      const mode = requested === 'relay' || requested === 'direct'
        ? requested
        : (requested ? (config?.mode ?? 'direct') : (input?.url ? 'relay' : (config?.mode ?? 'direct')));
      const url = mode === 'relay' ? normalizeRelayUrl(input?.url ?? config?.url) : (config?.url ?? '');
      const relayToken = mode === 'relay'
        ? String(input?.relayToken ?? config?.relayToken ?? '').trim()
        : (config?.relayToken ?? '');
      if (mode === 'relay' && !relayToken) throw bad('请填写中继令牌。');
      const requestedPort = normalizeDirectPort(input?.port);
      if (!/^https?:\/\//.test(config?.url ?? '') && url.startsWith('http://')) {
        // Not refused: a VPS behind a tunnel or a LAN address is a legitimate first try.
        log('remote relay uses plain http; pairing traffic will not be encrypted in transit');
      }
      const next = normalizeRelayConfig({
        ...(config ?? {}),
        mode,
        enabled: true,
        url,
        relayToken,
        pairSecret: config?.pairSecret ?? randomSecret(),
        devices: config?.devices ?? [],
        directPort: requestedPort ?? config?.directPort,
      }, config);
      await save(next);
      lastError = '';
      if (next.mode === 'relay') await syncRelayRegister(next);
      await apply();
      return status();
    },

    async disable() {
      if (config) await save({ ...config, enabled: false });
      await stopLinks();
      return status();
    },

    async revoke(deviceId) {
      if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw bad('设备编号不正确。');
      const key = deviceId.toLowerCase();
      if (!config || !config.devices.some(device => device.deviceId === key)) {
        throw bad('这台设备不在列表里。');
      }
      await save({ ...config, devices: config.devices.filter(device => device.deviceId !== key) });
      // The key is dropped from the live link too, so the next frame from that device is
      // unopenable immediately — it does not wait for a restart or a reconnect.
      relayClient?.revoke(key, { sync: false });
      directHost?.revoke(key);
      await syncRelayRevoke(config, key);
      return status();
    },

    async setDispatch(enabled) {
      if (config?.enabled !== true) throw bad('请先启用远程连接。');
      await save({ ...config, dispatchEnabled: enabled === true });
      return status();
    },

    /** The LAN transport: sealed payloads need WebCrypto, which only https has (LAN ip does not). */
    async setPlainLan(enabled) {
      if (!config) throw bad('远程连接尚未配置。');
      await save({ ...config, allowPlainLan: enabled === true });
      if (config.enabled && config.mode === 'direct') await apply();
      return status();
    },

    /** Off by default: a tunnel is a public address, so it is always an explicit choice. */
    async setTunnel(enabled) {
      if (!config) throw bad('远程连接尚未配置。');
      if (config.mode !== 'direct') throw bad('只有「免服务器直连」可以开启 Cloudflare 隧道。');
      if (config.enabled !== true) throw bad('请先启用远程连接。');
      await save({ ...config, tunnelEnabled: enabled === true });
      if (enabled) {
        if (!directHost) await apply();
        else startTunnel();
      } else if (tunnel) {
        tunnel.stop();
        tunnel = null;
      }
      return status();
    },

    /** Downloads the connector on request, then remembers where it is. */
    async installTunnel() {
      // Download outside the config queue: a slow network must not hold stop/revoke hostage.
      // Share one download to avoid racing the connector's own temporary file.
      if (!installation) {
        installation = downloadCloudflared({ dataDir, platform, fetchImpl, log })
          .finally(() => { installation = null; });
      }
      const result = await installation;
      return enqueue(async () => {
        if (config) await save({ ...config, tunnelPath: result.path });
        return { ...status(), installed: result };
      });
    },

    /** A new secret invalidates every paired phone, which is the point of rotating it. */
    async rotateSecret() {
      if (!config) throw bad('远程连接尚未配置。');
      await save({ ...config, pairSecret: randomSecret(), devices: [] });
      await syncRelayRegister(config, { clearDevices: true });
      if (config.enabled) await apply();
      const next = status();
      return { ...next, link: config?.enabled ? this.pairLink().link : '' };
    },
  };

  // Only async public entry points own a transaction. status/pairLink remain synchronous;
  // rotateSecret can read pairLink without recursively waiting on this same queue.
  for (const name of [
    'start', 'stop', 'enable', 'disable', 'revoke', 'setDispatch', 'setPlainLan',
    'setTunnel', 'rotateSecret',
  ]) {
    const operation = api[name];
    api[name] = (...args) => enqueue(() => operation.apply(api, args));
  }
  return api;
}
