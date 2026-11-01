import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_IMAGE_BYTES, validateImageBytes } from './media.mjs';
import { boundedString, checkAbort, HttpError, workspacePath } from './util.mjs';

export const FILE_ACTION_NAMES = ['default', 'choose', 'reveal', 'application'];
const TEXT_PREVIEW_BYTES = 200_000;
const APPLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function fileActionCapabilities(actions) {
  return {
    default: typeof actions.default === 'function',
    choose: typeof actions.choose === 'function' || typeof actions.listApplications === 'function' && typeof actions.application === 'function',
    reveal: typeof actions.reveal === 'function',
  };
}

function fileActionContext(opened, signal) {
  return { absolutePath: opened.target.absolute, path: opened.target.relative, name: path.basename(opened.target.absolute), workspace: opened.target.root, signal };
}

function validApplicationId(value) {
  return typeof value === 'string' && APPLICATION_ID.exec(value)?.[0] === value;
}

async function openCheckedFile(workspace, requested) {
  boundedString(requested, '文件路径', { max: 4_096 });
  const target = await workspacePath(workspace, requested);
  const named = await fs.lstat(target.absolute);
  if (!named.isFile()) throw new HttpError(400, '只能打开工作目录内的普通文件。');
  const file = await fs.open(target.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    const verify = async () => {
      const checked = await workspacePath(workspace, requested, { expectedPath: target.absolute });
      const current = await fs.lstat(checked.absolute);
      if (!stat.isFile() || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
        throw new HttpError(409, '文件在读取期间发生变化，请重新选择。');
      }
    };
    await verify();
    return { file, target, stat, verify };
  } catch (error) { await file.close(); throw error; }
}

async function readBytes(file, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(bytes, offset, length - offset, offset);
    if (!read.bytesRead) break;
    offset += read.bytesRead;
  }
  if (offset !== length) throw new HttpError(409, '文件在读取期间发生变化，请重试。');
  return bytes;
}

function looksLikeRaster(bytes) {
  return bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG'
    || bytes[0] === 0xff && bytes[1] === 0xd8
    || ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function isText(bytes, truncated) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); return true; }
  catch { return false; }
}

export async function workspaceFileInfo(workspace, requested, actions) {
  const opened = await openCheckedFile(workspace, requested);
  try {
    const { file, target, stat, verify } = opened;
    const sample = await readBytes(file, Math.min(stat.size, TEXT_PREVIEW_BYTES));
    let kind = 'other'; let mime = 'application/octet-stream'; let previewUrl;
    if (looksLikeRaster(sample)) {
      if (stat.size <= MAX_IMAGE_BYTES) {
        try {
          const bytes = stat.size === sample.length ? sample : await readBytes(file, stat.size);
          const image = validateImageBytes(bytes);
          kind = 'image'; mime = image.mime;
          previewUrl = `/api/workspace/file-content?path=${encodeURIComponent(target.relative)}`;
        } catch (error) { if (!(error instanceof HttpError) || error.status !== 422) throw error; }
      }
    } else if (isText(sample, stat.size > sample.length)) { kind = 'text'; mime = 'text/plain'; }
    await verify();
    return { path: target.relative, name: path.basename(target.absolute), size: stat.size, kind, mime, ...(previewUrl ? { previewUrl } : {}), actions: fileActionCapabilities(actions) };
  } finally { await opened.file.close(); }
}

export async function workspaceImageContent(workspace, requested) {
  const opened = await openCheckedFile(workspace, requested);
  try {
    if (opened.stat.size > MAX_IMAGE_BYTES) throw new HttpError(413, '图片预览最多支持 15 MB，请使用系统应用打开。');
    const bytes = await readBytes(opened.file, opened.stat.size);
    let image;
    try { image = validateImageBytes(bytes); }
    catch (error) { if (error instanceof HttpError && error.status === 422) throw new HttpError(415, '此文件不是可预览的 PNG、JPEG、WebP 或 GIF 图片。'); throw error; }
    await opened.verify();
    // Stream this validated, bounded snapshot so a later file replacement cannot change its MIME or content.
    return { bytes, mime: image.mime };
  } finally { await opened.file.close(); }
}

export async function workspaceFileApplications(workspace, requested, actions, signal) {
  const opened = await openCheckedFile(workspace, requested);
  try {
    if (typeof actions.listApplications !== 'function' || typeof actions.application !== 'function') throw new HttpError(501, '当前系统不支持应用列表。');
    checkAbort(signal);
    await opened.verify();
    let result;
    try {
      result = await actions.listApplications(fileActionContext(opened, signal));
    } catch (error) {
      if (signal?.aborted) throw new HttpError(409, '读取应用列表已停止。');
      throw new HttpError(502, error instanceof Error ? error.message : '无法读取本机应用列表。');
    }
    if (signal?.aborted) throw new HttpError(409, '读取应用列表已停止。');
    if (!Array.isArray(result?.applications) || result.applications.length > 128) throw new HttpError(502, '系统没有返回有效的应用列表。');
    const ids = new Set();
    const applications = result.applications.map(application => {
      if (!application || !validApplicationId(application.id)
        || typeof application.name !== 'string' || !application.name.trim() || application.name.length > 120
        || /[\u0000-\u001f\u007f]/.test(application.name)
        || application.recommended !== undefined && typeof application.recommended !== 'boolean'
        || ids.has(application.id)) throw new HttpError(502, '系统没有返回有效的应用列表。');
      ids.add(application.id);
      return { id: application.id, name: application.name.trim(), ...(application.recommended === undefined ? {} : { recommended: application.recommended }) };
    });
    await opened.verify();
    return { path: opened.target.relative, applications };
  } finally { await opened.file.close(); }
}

export async function performWorkspaceFileAction(workspace, requested, action, actions, signal, { applicationId } = {}) {
  if (!FILE_ACTION_NAMES.includes(action)) throw new HttpError(400, '打开方式必须是 default、choose、reveal 或 application。');
  if (action === 'application' && !validApplicationId(applicationId)) throw new HttpError(400, '应用标识必须是 1 至 128 个字母、数字、点、下划线或连字符，并以字母或数字开头。');
  const opened = await openCheckedFile(workspace, requested);
  try {
    if (typeof actions[action] !== 'function') throw new HttpError(501, '当前系统不支持此打开方式。');
    checkAbort(signal);
    await opened.verify();
    let result;
    try {
      result = await actions[action]({ ...fileActionContext(opened, signal), ...(action === 'application' ? { applicationId } : {}) });
    } catch (error) {
      if (signal?.aborted) throw new HttpError(409, '打开操作已停止。');
      throw new HttpError(502, error instanceof Error ? error.message : '系统未能打开此文件。');
    }
    if (!['done', 'cancelled'].includes(result?.status)) throw new HttpError(502, '系统没有返回有效的打开结果。');
    return { path: opened.target.relative, action, status: result.status };
  } finally { await opened.file.close(); }
}
