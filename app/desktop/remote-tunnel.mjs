// Cloudflare Tunnel, when the phone is not on the same Wi-Fi.
//
// The reference project (cc-haha) makes the same choice: the desktop runs the connector itself,
// so there is no server of yours in the middle and nothing to rent. Two shapes exist and only
// the first is supported here:
//
//   * quick tunnel   `cloudflared tunnel --url http://127.0.0.1:<port>` → a random
//                    https://<name>.trycloudflare.com, no account, no domain. It stays up as
//                    long as the process runs and the address changes when it restarts.
//   * named tunnel   needs a Cloudflare account and a domain; the user can still point one at
//                    the same local port by hand, and this app does not need to know about it.
//
// What this module adds on top of spawning a process:
//   * it finds the connector (configured path → tools directory → PATH) and never installs
//     anything without the user asking;
//   * it reads the assigned address out of the connector's own output instead of guessing;
//   * it checks the address actually answers before the UI says "ready";
//   * it stops the whole process tree, so no connector is left holding the port after quit.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

/** Quick tunnels always hand out one of these. */
export const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/i;
export const TOOLS_DIR = 'tools';
const MAX_LOG_LINES = 40;
const MAX_LINE = 300;
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const DOWNLOAD_ASSET = Object.freeze({
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-arm64.exe',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
});

export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export function toolsPath(dataDir, platform = process.platform) {
  return path.join(path.resolve(dataDir), TOOLS_DIR, binaryName(platform));
}

/** Finds a connector without installing one: configured path, then the tools dir, then PATH. */
export function findCloudflared({ dataDir, configured = '', platform = process.platform, pathValue = process.env.PATH ?? '' }) {
  if (typeof configured === 'string' && configured.trim() && existsSync(configured.trim())) {
    return { path: configured.trim(), source: 'configured' };
  }
  const local = toolsPath(dataDir, platform);
  if (existsSync(local)) return { path: local, source: 'tools' };
  const name = binaryName(platform);
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return { path: candidate, source: 'path' };
  }
  return null;
}

export function parseQuickUrl(text) {
  const match = QUICK_TUNNEL_URL.exec(String(text ?? ''));
  return match ? match[0].toLowerCase() : null;
}

/** The proxy is the desktop's, not the phone's: it only covers this machine's connector. */
export function tunnelEnv(proxyUrl = '', base = process.env) {
  const env = { ...base, NO_PROXY: [base.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',') };
  if (!proxyUrl) return env;
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  env.http_proxy = proxyUrl;
  return env;
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {number} options.port        the direct host's port on 127.0.0.1
 * @param {string} [options.configured] user-supplied connector path
 */
export function createTunnel({
  dataDir,
  port,
  configured = '',
  platform = process.platform,
  env = process.env,
  proxyUrl = '',
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  log = () => {},
  readyTimeoutMs = 45_000,
  probeAttempts = 6,
  probeDelayMs = 2_000,
} = {}) {
  let child = null;
  let stopping = false;
  let readyTimer = null;
  const since = () => new Date().toISOString();
  const state = {
    state: 'stopped',
    url: '',
    error: '',
    reachable: false,
    binary: '',
    source: '',
    startedAt: '',
    updatedAt: '',
    lines: [],
  };

  function remember(line) {
    const clean = String(line ?? '').replace(/[^\u0020-\u007e\u4e00-\u9fff]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!clean) return;
    state.lines.push(clean.slice(0, MAX_LINE));
    while (state.lines.length > MAX_LOG_LINES) state.lines.shift();
  }

  async function probe(url) {
    for (let attempt = 0; attempt < probeAttempts; attempt += 1) {
      if (state.state !== 'ready' || state.url !== url) return false;
      try {
        const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(8_000) });
        if (response.ok) {
          state.reachable = true;
          state.error = '';
          state.updatedAt = since();
          return true;
        }
      } catch { /* not propagated yet */ }
      await new Promise(resolve => setTimeout(resolve, probeDelayMs));
    }
    if (state.state === 'ready' && state.url === url) {
      state.reachable = false;
      state.error = '公网地址还没有应答，可能是 Cloudflare 侧尚未生效；稍等再试，或换一个网络。';
      state.updatedAt = since();
    }
    return false;
  }

  function kill(childProcess) {
    if (!childProcess || childProcess.killed) return;
    try {
      if (platform === 'win32' && childProcess.pid) {
        // A connector spawns helpers; /T is the difference between "stopped" and "still running".
        spawnImpl('taskkill', ['/pid', String(childProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      }
      childProcess.kill('SIGTERM');
    } catch { /* already gone */ }
  }

  return {
    start() {
      if (child) return this.status();
      const found = findCloudflared({ dataDir, configured, platform });
      state.binary = found?.path ?? '';
      state.source = found?.source ?? '';
      state.lines = [];
      state.url = '';
      state.reachable = false;
      state.error = '';
      if (!found) {
        state.state = 'missing';
        state.error = '没有找到 cloudflared。点「下载 cloudflared」或自行安装后再开启。';
        state.updatedAt = since();
        return this.status();
      }
      stopping = false;
      state.state = 'starting';
      state.startedAt = since();
      state.updatedAt = state.startedAt;
      let process;
      try {
        process = spawnImpl(found.path, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: tunnelEnv(proxyUrl, env),
        });
      } catch (error) {
        state.state = 'error';
        state.error = error?.message ?? '无法启动 cloudflared。';
        state.updatedAt = since();
        return this.status();
      }
      child = process;
      const onData = chunk => {
        for (const line of String(chunk).split(/\r?\n/)) {
          remember(line);
          const url = parseQuickUrl(line);
          if (!url || state.state === 'ready') continue;
          state.state = 'ready';
          state.url = url;
          state.error = '';
          state.updatedAt = since();
          log(`tunnel ready: ${url}`);
          clearTimeout(readyTimer);
          void probe(url);
        }
      };
      process.stdout?.on?.('data', onData);
      process.stderr?.on?.('data', onData);
      process.on?.('error', error => {
        state.state = 'error';
        state.error = error?.message ?? 'cloudflared 启动失败。';
        state.updatedAt = since();
      });
      process.on?.('exit', code => {
        clearTimeout(readyTimer);
        child = null;
        if (stopping) return;
        state.state = 'error';
        state.url = '';
        state.reachable = false;
        state.error = state.lines.at(-1)
          ? `cloudflared 已退出（${code ?? '未知'}）：${state.lines.at(-1)}`
          : `cloudflared 已退出（${code ?? '未知'}）。`;
        state.updatedAt = since();
        log(`tunnel exited: ${code}`);
      });
      readyTimer = setTimeout(() => {
        if (state.state !== 'starting') return;
        state.state = 'error';
        state.error = '没有在限定时间内拿到公网地址。检查网络或代理，然后重试。';
        state.updatedAt = since();
        // The kill is ours, so its exit event must not replace this message with "exited".
        stopping = true;
        kill(child);
        child = null;
      }, readyTimeoutMs);
      readyTimer.unref?.();
      return this.status();
    },

    stop() {
      stopping = true;
      clearTimeout(readyTimer);
      const process = child;
      child = null;
      kill(process);
      state.state = 'stopped';
      state.url = '';
      state.reachable = false;
      state.error = '';
      state.updatedAt = since();
      return this.status();
    },

    status() {
      return {
        state: state.state,
        url: state.url,
        reachable: state.reachable,
        error: state.error,
        binary: state.binary,
        source: state.source,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        lines: [...state.lines],
      };
    },

    /** The address is only useful once it answers; the settings page reads this to say so. */
    async waitForReady({ timeoutMs = 60_000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (state.state === 'ready' && state.reachable) return this.status();
        if (state.state === 'error' || state.state === 'missing' || state.state === 'stopped') return this.status();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return this.status();
    },
  };
}

/**
 * Downloads the connector on request — never on start, and never silently.
 *
 * Windows and Linux ship a bare executable, so the file can be dropped straight into place.
 * macOS ships a `.tgz`, which is why that platform gets an instruction instead of a download.
 */
export async function downloadCloudflared({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  const key = `${platform}-${arch}`;
  const asset = DOWNLOAD_ASSET[key];
  if (!asset) {
    throw new Error(platform === 'darwin'
      ? 'macOS 请用 `brew install cloudflared` 安装，然后重新打开开关。'
      : `这个平台（${key}）没有可直接下载的连接程序，请自行安装 cloudflared。`);
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`下载 cloudflared 失败（${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('下载到的 cloudflared 是空文件。');
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('下载到的 cloudflared 超过大小上限。');
  const target = toolsPath(dataDir, platform);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, buffer, { mode: 0o755 });
  await fs.chmod(temporary, 0o755).catch(() => {});
  await fs.rename(temporary, target);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await fs.writeFile(`${target}.sha256`, `${sha256}  ${asset}\n`, 'utf8').catch(() => {});
  log(`downloaded cloudflared ${asset} (${buffer.length} bytes)`);
  return { path: target, bytes: buffer.length, sha256 };
}
