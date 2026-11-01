import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function abortError() {
  const error = new Error('操作已停止。');
  error.name = 'AbortError';
  return error;
}

export function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value) {
  if (!isObject(value)) throw new HttpError(400, '请求内容必须是 JSON 对象。');
  return value;
}

export function boundedString(value, name, { max = 120_000, empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) {
    throw new HttpError(400, `${name} 必须是${empty ? '有效' : '非空'}文本，且不超过 ${max} 个字符。`);
  }
  return value;
}

export function safeError(error, secret = '') {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join('[已隐藏密钥]');
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1_000);
}

/**
 * 1.3.4: the temporary file is flushed to disk before it replaces the target, and the directory
 * entry afterwards where the platform allows it. Without the flush a power loss right after the
 * rename could leave the target full of NUL bytes even though the rename itself is atomic.
 */
export async function atomicWrite(filename, data, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, filename); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await syncDirectory(path.dirname(filename));
}

/** Best effort: Windows cannot flush a directory handle, and the rename is already durable there. */
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch { /* Not every file system supports flushing a directory. */ }
  finally { await handle?.close().catch(() => {}); }
}

/**
 * Waits for a spawned process to finish and reports how it ended.
 *
 * `close` is the usual signal, but a command that leaves a background process behind can never
 * produce it: on Windows the grandchild inherits the parent's stdio pipes, so they stay open
 * after the shell itself has exited and `close` never fires. The process exiting is what really
 * ends the command, so the remaining output gets a short drain window and the pipes are then
 * closed here. Without this, one `run_command` that starts a background server would hang its
 * run — and every stop request waiting on that run — for as long as the server lives.
 */
export function waitForChildExit(child, { drainMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let drain;
    const settle = (exitCode, signal) => {
      clearTimeout(drain);
      resolve({ exitCode, signal });
    };
    child.once('error', error => { clearTimeout(drain); reject(error); });
    child.once('close', settle);
    child.once('exit', (exitCode, signal) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exitCode, signal);
      }, drainMs);
      drain.unref?.();
    });
  });
}

export async function readJson(filename, fallback) {
  try { return JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function validateFilePath(value) {
  if (process.platform !== 'win32') return;
  if (/^[\\/]{2}[.?][\\/]/.test(value)) throw new HttpError(400, '文件工具不支持 Windows 设备路径。');
  const absolute = path.resolve(value);
  const parts = absolute.slice(path.parse(absolute).root.length).split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part.includes(':') || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new HttpError(400, '文件工具仅支持普通文件路径，不能使用设备名或备用数据流。');
  }
}

function displayPath(root, absolute) {
  return inside(root, absolute) ? path.relative(root, absolute).split(path.sep).join('/') || '.' : absolute;
}

/** Resolve every existing component, including symlinks, before a file tool uses it. */
export async function workspacePath(root, requested = '.', { allowMissing = false, allowExternal = false, expectedPath } = {}) {
  boundedString(requested || '.', '文件路径', { max: 4_096 });
  allowExternal = allowExternal === true;
  validateFilePath(requested || '.');
  const canonicalRoot = await fs.realpath(root);
  const lexicalRoot = path.resolve(root);
  const lexical = path.resolve(lexicalRoot, requested || '.');
  let external = !inside(lexicalRoot, lexical);
  if (external && !allowExternal) throw new HttpError(403, '只能访问当前工作目录内的路径；外部路径需要批准。');
  const anchor = external ? path.parse(lexical).root : lexicalRoot;
  const parts = path.relative(anchor, lexical).split(path.sep).filter(Boolean);
  let current = external ? await fs.realpath(anchor) : canonicalRoot;
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(next); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      current = path.join(next, ...parts.slice(index + 1));
      break;
    }
    current = stat.isSymbolicLink() ? await fs.realpath(next) : next;
    external ||= !inside(canonicalRoot, current);
    if (external && !allowExternal) throw new HttpError(403, '符号链接指向工作目录之外，需要批准后才能访问。');
    if (index < parts.length - 1 && !(await fs.stat(current)).isDirectory()) {
      throw new HttpError(400, '路径的父级不是文件夹。');
    }
  }
  external ||= !inside(canonicalRoot, current);
  if (external && !allowExternal) throw new HttpError(403, '只能访问当前工作目录内的路径；外部路径需要批准。');
  if (expectedPath !== undefined && !samePath(expectedPath, current)) throw new HttpError(403, '目标的真实路径已变化，请重新确认后再操作。');
  return { root: canonicalRoot, absolute: current, relative: displayPath(canonicalRoot, current), external };
}

/**
 * 1.3.0: Electron's asar layer reports a fresh inode on every stat of a path inside an archive,
 * so the usual dev/ino identity check could never pass there. Inside an archive (read-only by
 * construction) the identity is compared by kind and size instead.
 */
export function insideAsar(target) {
  return Boolean(process.versions?.electron) && /\.asar(?:[\\/]|$)/i.test(String(target ?? ''));
}

function sameIdentity(left, right, target) {
  if (insideAsar(target)) return left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile() && left.size === right.size;
  return left.dev === right.dev && left.ino === right.ino;
}

export async function listDirectory(root, requested = '.', access = {}) {
  const resolved = await workspacePath(root, requested, access);
  const before = await fs.stat(resolved.absolute);
  if (!before.isDirectory()) throw new HttpError(400, '该路径不是文件夹。');
  const children = await fs.readdir(resolved.absolute, { withFileTypes: true });
  const selected = children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 1_000);
  const entries = await Promise.all(selected.map(async child => {
    const entry = {
      name: child.name,
      path: displayPath(resolved.root, path.join(resolved.absolute, child.name)),
      type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
    };
    // 1.3.0: one entry that cannot be inspected (C:\\DumpStack.log.tmp, pagefile.sys) is reported
    // as such instead of failing the whole listing.
    if (child.isFile()) {
      try { entry.size = (await fs.lstat(path.join(resolved.absolute, child.name))).size; }
      catch (error) { entry.error = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) ? '无权限读取大小' : '无法读取大小'; }
    }
    return entry;
  }));
  const checked = await workspacePath(root, requested, { ...access, expectedPath: resolved.absolute });
  const after = await fs.stat(checked.absolute);
  if (!sameIdentity(before, after, checked.absolute)) throw new HttpError(409, '文件夹在读取期间发生变化，请重试。');
  return { root: resolved.root, path: resolved.relative, entries, truncated: children.length > 1_000 };
}

export async function readWorkspaceFile(root, requested, maxBytes = 200_000, access = {}) {
  if (isObject(maxBytes)) { access = maxBytes; maxBytes = 200_000; }
  const resolved = await workspacePath(root, requested, access);
  const file = await fs.open(resolved.absolute, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HttpError(400, '该路径不是普通文件。');
    const checked = await workspacePath(root, requested, { ...access, expectedPath: resolved.absolute });
    const namedFile = await fs.lstat(checked.absolute);
    if (!namedFile.isFile() || !sameIdentity(stat, namedFile, checked.absolute)) throw new HttpError(409, '文件在读取前发生变化，请重试。');
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new HttpError(415, '此预览仅支持 UTF-8 文本文件。');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: stat.size > bytesRead }); }
    catch { throw new HttpError(415, '此预览仅支持 UTF-8 文本文件。'); }
    await workspacePath(root, requested, { ...access, expectedPath: resolved.absolute });
    return { path: resolved.relative, content, truncated: stat.size > bytesRead };
  } finally { await file.close(); }
}
