import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchUrlBytes, normalizeWebUrl } from './network.mjs';
import { boundedString, checkAbort, HttpError, requireObject, samePath, workspacePath } from './util.mjs';

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT = 120_000;

export function normalizeDownloadArgs(args) {
  requireObject(args);
  const url = normalizeWebUrl(args.url);
  const requested = boundedString(args.path, '保存文件路径', { max: 4_096 });
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new HttpError(400, 'overwrite 必须是布尔值。');
  const timeoutMs = args.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new HttpError(400, '下载时限必须在 1 到 300 秒之间。');
  return { url, path: requested, overwrite: args.overwrite === true, timeoutMs };
}

async function existingFile(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function validateDownloadDestination(args, { workspace, access = {} }) {
  const normalized = normalizeDownloadArgs(args);
  const target = await workspacePath(workspace, normalized.path, { ...access, allowMissing: true });
  if (samePath(target.root, target.absolute)) throw new HttpError(400, '请填写保存的文件名，不能把工作目录替换为文件。');
  const existing = await existingFile(target.absolute);
  if (existing && !existing.isFile()) throw new HttpError(400, '下载目标不是普通文件。');
  if (existing && (!normalized.overwrite || access.mustBeNew === true)) throw new HttpError(409, '同名文件已存在；请选择其他文件名，或明确请求覆盖。');
  return { ...target, exists: Boolean(existing) };
}

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

/**
 * Codes a volume without hard links reports for fs.link: FAT32/exFAT (USB drives) answer
 * ERROR_INVALID_FUNCTION, which libuv reports as EISDIR; some network shares answer EPERM,
 * EACCES or ENOTSUP.
 */
const NO_HARD_LINK = new Set(['EISDIR', 'ENOTSUP', 'EPERM', 'EACCES', 'EXDEV', 'ENOSYS', 'EINVAL', 'UNKNOWN']);

/**
 * 1.3.4: publish without a hard link. The target is created exclusively (so a file that appeared
 * meanwhile is still never replaced), the verified bytes are copied in and flushed, and a target
 * this function created is removed again if the copy fails.
 */
async function publishByCopy(temporary, destination, expectedBytes, signal) {
  let output;
  try { output = await fs.open(destination, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new HttpError(409, '下载期间出现了同名文件，未覆盖它。');
    throw error;
  }
  const created = await output.stat();
  try {
    const input = await fs.open(temporary, 'r');
    let position = 0;
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        // 1.5.6: FileHandle.write may write fewer bytes than requested.
        let offset = 0;
        while (offset < bytesRead) {
          checkAbort(signal);
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, position + offset);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytesRead - offset) throw new Error('下载文件复制未能完整写入，未保存目标文件。');
          offset += bytesWritten;
        }
        position += bytesRead;
      }
    } finally { await input.close(); }
    if (position !== expectedBytes || (await output.stat()).size !== expectedBytes) throw new Error('下载文件复制不完整，未保存目标文件。');
    checkAbort(signal);
    await output.sync();
    await output.close(); output = null;
  } catch (error) {
    await output?.close().catch(() => {});
    const named = await fs.lstat(destination).catch(() => null);
    if (named?.isFile() && sameFile(created, named)) await fs.unlink(destination).catch(() => {});
    throw error;
  }
}

/** Keep binary data on disk; publish the completed file only after verification. */
export async function downloadFile(args, { workspace, signal, access = {}, fetcher = fetchUrlBytes, onProgress } = {}) {
  checkAbort(signal);
  const normalized = normalizeDownloadArgs(args);
  const target = await validateDownloadDestination(normalized, { workspace, access });
  const parent = path.dirname(target.absolute);
  checkAbort(signal);
  await fs.mkdir(parent, { recursive: true });
  await workspacePath(workspace, normalized.path, { ...access, allowMissing: true, expectedPath: target.absolute });
  const parentStat = await fs.stat(parent);
  const temporary = path.join(parent, `.${path.basename(target.absolute)}.${randomUUID()}.part`);
  let handle;
  let opened;
  let bytes = 0;
  const hash = createHash('sha256');

  const checkDestination = async () => {
    const checked = await workspacePath(workspace, normalized.path, { ...access, allowMissing: true, expectedPath: target.absolute });
    if (!sameFile(parentStat, await fs.stat(parent)) || !samePath(parent, await fs.realpath(parent))) throw new HttpError(409, '下载目录在执行期间发生变化，请重新确认。');
    const named = await fs.lstat(temporary);
    if (!named.isFile() || !sameFile(opened, named)) throw new HttpError(409, '下载临时文件发生变化，已停止保存。');
    return checked;
  };

  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    opened = await handle.stat();
    await checkDestination();
    const reply = await fetcher(normalized.url, {
      signal, timeoutMs: normalized.timeoutMs, maxBytes: MAX_DOWNLOAD_BYTES,
      onChunk: async chunk => {
        checkAbort(signal);
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error('下载服务返回了无效的文件数据。');
        if (bytes + chunk.byteLength > MAX_DOWNLOAD_BYTES) throw new HttpError(413, '单个下载文件不能超过 100 MB。');
        await handle.writeFile(chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
      },
      onProgress: async progress => {
        checkAbort(signal);
        const totalBytes = Number.isSafeInteger(progress?.totalBytes) && progress.totalBytes >= bytes && progress.totalBytes <= MAX_DOWNLOAD_BYTES ? progress.totalBytes : null;
        await onProgress?.({ bytes, totalBytes });
      },
    });
    checkAbort(signal);
    if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status >= 300) throw new HttpError(502, `下载服务器返回 HTTP ${reply.status ?? '未知'}，未保存目标文件。`);
    if (reply.status === 206) throw new HttpError(502, '下载服务器只返回了部分文件，未保存为完整下载。');
    if (reply.bytes !== bytes) throw new Error('下载文件未完整接收，未保存目标文件。');
    await handle.sync();
    await handle.close(); handle = null;
    const checked = await checkDestination();
    const existing = await existingFile(checked.absolute);
    if (existing && !existing.isFile()) throw new HttpError(409, '下载目标已变为其他类型，未替换它。');
    checkAbort(signal);
    if (!normalized.overwrite || access.mustBeNew === true) {
      // A hard link publishes a complete file and atomically refuses any race
      // that creates the same filename. Both paths are on the same volume.
      try { await fs.link(temporary, checked.absolute); }
      catch (error) {
        if (error.code === 'EEXIST') throw new HttpError(409, '下载期间出现了同名文件，未覆盖它。');
        // 1.3.4: a USB drive (FAT32/exFAT) has no hard links, so every default download failed there.
        if (!NO_HARD_LINK.has(error.code)) throw error;
        checkAbort(signal);
        await checkDestination();
        await publishByCopy(temporary, checked.absolute, bytes, signal);
      }
    } else {
      for (let attempt = 0; ; attempt++) {
        checkAbort(signal);
        await checkDestination();
        try { await fs.rename(temporary, checked.absolute); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await delay(30 * (attempt + 1));
        }
      }
    }
    return {
      downloaded: true, path: checked.relative, fileName: path.basename(checked.absolute),
      bytes, sha256: hash.digest('hex'), url: reply.url,
      contentType: typeof reply.headers?.['content-type'] === 'string' ? reply.headers['content-type'].slice(0, 200) : 'application/octet-stream',
    };
  } finally {
    await handle?.close().catch(() => {});
    if (opened) {
      const current = await fs.lstat(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (current?.isFile() && sameFile(opened, current)) await fs.unlink(temporary);
    }
  }
}
