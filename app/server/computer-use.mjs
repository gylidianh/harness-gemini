import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { abortError, checkAbort, waitForChildExit } from './util.mjs';

/**
 * Desktop control, Windows only, for now.
 *
 * The contract is deliberately the same as windows-applications.ps1: the script travels in on
 * stdin (read explicitly as UTF-8 via a UTF-16LE `-EncodedCommand` bootstrap so Windows ANSI/OEM
 * code pages such as CP936 never mangle characters), every value is environment data, and exactly
 * one `LOCAL_HARNESS_COMPUTER_RESULT:` line comes back. Nothing the model supplies is ever
 * concatenated into a command line or into the script text, so a coordinate or a typed string can
 * never become code.
 */

const SCRIPT_URL = new URL('./computer-use.ps1', import.meta.url);
/** A whole-desktop PNG averages ~3 MB; base64 inflates it by a third, so refuse well before memory. */
const MAX_PNG_BYTES = 6 * 1024 * 1024;
const PREFIX = 'LOCAL_HARNESS_COMPUTER_RESULT:';
const DEFAULT_TIMEOUT_MS = 25_000;
const BOOTSTRAP_ENCODED_COMMAND = Buffer.from([
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  '$__lhReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))',
  '$__lhScript = $__lhReader.ReadToEnd()',
  '$__lhReader.Dispose()',
  '& ([scriptblock]::Create($__lhScript))',
].join('\n'), 'utf16le').toString('base64');
let scriptPromise = null;

export function computerUseSupported() {
  return process.platform === 'win32';
}

/** PowerShell wording is not shown to the model; each code becomes one sentence it can act on. */
const FAILURES = Object.freeze({
  WINDOW_NOT_FOUND: '找不到这个窗口，它可能已经关闭或换了句柄；请重新调用 computer_windows。',
  WINDOW_RECT_FAILED: '无法读取这个窗口的位置与大小。',
  FOREGROUND_DENIED: '系统没有允许把这个窗口切到前台：先点击它的可见区域，或换一个窗口。',
  REGION_TOO_LARGE: '截图区域太大，请改为截取某个窗口（传 window）。',
  CURSOR_REJECTED: '系统拒绝了光标移动。',
  INPUT_REJECTED: '系统拒绝了这次输入注入，目标窗口可能需要以管理员身份运行。',
  OUTPUT_PATH_INVALID: '截图保存位置不正确。',
  UNKNOWN_COMPUTER_COMMAND: '不支持的桌面控制命令。',
});

function failure(code, detail) {
  const known = FAILURES[code];
  if (known) return new Error(known);
  if (typeof code === 'string' && code.startsWith('UNKNOWN_COMPUTER_ACTION:')) {
    return new Error(`不支持的桌面操作：${code.slice('UNKNOWN_COMPUTER_ACTION:'.length)}。`);
  }
  return new Error(typeof detail === 'string' && detail.trim() ? detail.trim() : '桌面操作失败。');
}

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function runComputerAction(action, payload = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, run = spawn } = {}) {
  if (!computerUseSupported()) throw new Error('桌面控制目前只在 Windows 上可用；请改用内置浏览器或其他工具。');
  checkAbort(signal);
  const script = await (scriptPromise ??= fs.readFile(SCRIPT_URL, 'utf8').catch(error => {
    scriptPromise = null;
    throw error;
  }));
  checkAbort(signal);

  const outputPath = action === 'screenshot' ? path.join(os.tmpdir(), `harness-computer-${randomUUID()}.png`) : '';
  const child = run(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-EncodedCommand', BOOTSTRAP_ENCODED_COMMAND], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCAL_HARNESS_COMPUTER_ACTION: action,
      LOCAL_HARNESS_COMPUTER_PAYLOAD: JSON.stringify(payload ?? {}),
      LOCAL_HARNESS_COMPUTER_OUTPUT: outputPath,
    },
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const decoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const onAbort = () => stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  timer.unref?.();
  const receive = (text, stream) => {
    if (stream === 'stdout') { stdout += text; if (stdout.length > 262_144) stop(); }
    else { stderr += text; if (stderr.length > 65_536) stop(); }
  };
  child.stdout.on('data', chunk => receive(decoder.write(chunk), 'stdout'));
  child.stderr.on('data', chunk => receive(errDecoder.write(chunk), 'stderr'));
  child.stdin.on('error', () => {});
  child.stdin.end(Buffer.from(`${script}\n`, 'utf8'));

  try {
    const { exitCode } = await waitForChildExit(child);
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('桌面操作超时，已停止等待。');
    stdout += decoder.end();
    stderr += errDecoder.end();
    const line = stdout.split(/\r?\n/).reverse().find(candidate => candidate.startsWith(PREFIX));
    let result;
    try { result = JSON.parse(line?.slice(PREFIX.length) ?? ''); } catch { /* handled below */ }
    if (!result) throw new Error(stderr.trim() ? '桌面控制脚本无法运行，请确认它没有被打包工具改动。' : '桌面控制没有返回结果。');
    if (result.status === 'error') throw failure(result.code, result.detail);
    if (exitCode !== 0) throw new Error('桌面控制失败，请重试。');

    if (action === 'screenshot') {
      const bytes = await fs.readFile(outputPath).catch(() => null);
      if (!bytes?.length) throw new Error('截图没有生成。');
      if (bytes.length > MAX_PNG_BYTES) throw new Error('截图太大（超过 6 MB），请改为截取某个窗口。');
      return {
        screen: result.screen,
        region: result.region,
        width: result.width,
        height: result.height,
        bytes: bytes.length,
        windowTitle: typeof result.windowTitle === 'string' ? result.windowTitle : '',
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    }
    if (action === 'windows') {
      const windows = Array.isArray(result.windows) ? result.windows : [];
      return {
        screen: result.screen,
        count: Number(result.count) || windows.length,
        truncated: result.truncated === true,
        windows: windows.map(item => ({
          handle: String(item?.handle ?? ''),
          title: String(item?.title ?? ''),
          process: String(item?.process ?? ''),
          x: Number(item?.x) || 0, y: Number(item?.y) || 0,
          width: Number(item?.width) || 0, height: Number(item?.height) || 0,
          minimized: item?.minimized === true,
          foreground: item?.foreground === true,
        })).filter(item => /^0x[0-9a-f]+$/i.test(item.handle)),
      };
    }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}
