import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { abortError, checkAbort, waitForChildExit } from './util.mjs';

const SCRIPT_URL = new URL('./windows-file-actions.ps1', import.meta.url);
const APPLICATIONS_SCRIPT_URL = new URL('./windows-applications.ps1', import.meta.url);
let scriptPromise;
let applicationsScriptPromise;

async function runWindowsFileAction(action, { absolutePath, workspace, signal, applicationId }) {
  checkAbort(signal);
  if (action === 'application' && (typeof applicationId !== 'string' || !/^app_[a-f0-9]{64}$/.test(applicationId))) {
    throw new Error('请选择应用列表中的有效应用。');
  }
  const applicationAction = action === 'applications' || action === 'application';
  const script = await (applicationAction
    ? (applicationsScriptPromise ??= fs.readFile(APPLICATIONS_SCRIPT_URL, 'utf8'))
    : (scriptPromise ??= fs.readFile(SCRIPT_URL, 'utf8')));
  checkAbort(signal);
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The script is static and may live inside app.asar. User paths are environment data, never code or arguments.
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-Command', '-'], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCAL_HARNESS_FILE_PATH: absolutePath, LOCAL_HARNESS_FILE_ROOT: workspace, LOCAL_HARNESS_FILE_ACTION: action, LOCAL_HARNESS_APPLICATION_ID: action === 'application' ? applicationId : '' },
  });
  const timeoutMs = 30_000;
  let stdout = ''; let stderrBytes = 0; let timedOut = false;
  const outputDecoder = new StringDecoder('utf8');
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const onAbort = () => stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timer.unref?.();
  const receiveOutput = text => {
    stdout += text;
    if (stdout.length > 16_384) stop();
  };
  child.stdout.on('data', chunk => receiveOutput(outputDecoder.write(chunk)));
  child.stdout.on('end', () => receiveOutput(outputDecoder.end()));
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16_384) stop(); });
  child.stdin.on('error', () => {});
  child.stdin.end(script + '\n');
  try {
    const { exitCode: code } = await waitForChildExit(child);
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('系统打开操作超时，请重试。');
    const payload = stdout.split(/\r?\n/).reverse().find(line => line.startsWith('LOCAL_HARNESS_FILE_RESULT:'));
    let result;
    try { result = JSON.parse(payload?.slice('LOCAL_HARNESS_FILE_RESULT:'.length) ?? ''); } catch {}
    if (result?.status === 'error' && result.code === 'FOREGROUND_DENIED') throw new Error('已找到资源管理器窗口，但系统未允许将其切到前台。');
    if (result?.status === 'error' && result.code === 'EXPLORER_WINDOW_NOT_FOUND') throw new Error('已请求打开资源管理器，但尚未找到选中文件的窗口。');
    if (result?.status === 'error' && result.code === 'APPLICATION_NOT_FOUND') throw new Error('所选应用不可用或安装位置已变化，请刷新应用列表后重试。');
    if (code !== 0 || !result || result.status === 'error') throw new Error(result?.code ? `系统无法完成打开操作（错误码 ${String(result.code).slice(0, 32)}）。` : '系统无法完成打开操作。');
    if (!['done', 'cancelled'].includes(result.status)) throw new Error('系统返回了无法识别的打开结果。');
    if (action === 'applications') {
      if (!Array.isArray(result.applications) || result.applications.length > 64 || result.applications.some(app => !app || typeof app.id !== 'string' || !/^app_[a-f0-9]{64}$/.test(app.id) || typeof app.name !== 'string' || !app.name.trim() || app.name.length > 128)) {
        throw new Error('系统返回了无法识别的应用列表。');
      }
      return { applications: result.applications.map(({ id, name, recommended }) => ({ id, name, recommended: recommended === true })) };
    }
    return { status: result.status };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

export function nativeWorkspaceFileActions() {
  if (process.platform !== 'win32') return {};
  return {
    ...Object.fromEntries(['default', 'reveal', 'application'].map(action => [action, file => runWindowsFileAction(action, file)])),
    listApplications: file => runWindowsFileAction('applications', file),
  };
}
