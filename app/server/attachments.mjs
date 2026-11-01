/**
 * Composer attachments: images, documents and archives a user picks, pastes or drops into the
 * message box.
 *
 * The rules follow ZCode's V4 composer attachments (Apache-2.0; see THIRD-PARTY-NOTICES.md):
 * a file is bounded before it is read, an image is validated as real raster content, a supplied
 * name is never trusted as a path, and only images travel inline to the provider while every
 * other file stays a path reference the agent opens with its own tools.
 *
 * Harness Gemini stores one session's attachments inside that session's own working directory,
 * so they are readable by the same tools, isolated from other conversations, and durable across
 * restarts without any base64 ever entering the conversation record.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_IMAGE_BYTES, validateImageBytes } from './media.mjs';
import { atomicWrite, HttpError, isObject, workspacePath } from './util.mjs';

/** ZCode's attachment ceiling: one file at most 20 MiB, at most 8 files per message. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** One message may not carry more than this in total, so a single request stays bounded. */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 24 * 1024 * 1024;
/**
 * Images are the one attachment kind the provider itself reads, so they travel as image parts.
 * Their size is capped well below the file limit: base64 inflates by a third, and a turn's
 * history is rebuilt on every round of the same request.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_IMAGE_MESSAGES = 3;
/** The JSON body an upload may use: base64 of the total ceiling, plus envelope room. */
export const ATTACHMENT_BODY_LIMIT = '36mb';
export const ATTACHMENT_DIRECTORY = 'attachments';
/** `<32 hex id>__<safe name>`: the id is generated here, the name can never contain a path. */
export const ATTACHMENT_REF = /^[a-f0-9]{32}__[^\\/:*?"<>|\u0000-\u001f\u007f]{1,120}$/;

const MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
  json: 'application/json', jsonl: 'application/jsonl', xml: 'text/xml', html: 'text/html', htm: 'text/html', css: 'text/css', yml: 'text/yaml', yaml: 'text/yaml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', cs: 'text/x-csharp',
  sh: 'text/x-shellscript', bash: 'text/x-shellscript', ps1: 'text/x-powershell', bat: 'text/x-batch', sql: 'text/x-sql', toml: 'text/toml', ini: 'text/plain', env: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', odt: 'application/vnd.oasis.opendocument.text',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', bz2: 'application/x-bzip2', xz: 'application/x-xz',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,80}\/[a-z0-9][a-z0-9.+-]{0,80}$/;
/** The raster types that travel inline to the provider; every other image is an ordinary file. */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const DATA_URI = /^data:([a-z0-9][a-z0-9.+-]{0,80}\/[a-z0-9][a-z0-9.+-]{0,80});base64,([A-Za-z0-9+/]*={0,2})$/i;

export function extensionOf(name) {
  const extension = path.extname(String(name ?? '')).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

export function mimeForName(name, fallback = 'application/octet-stream') {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? fallback;
}

/** Keep the UTF-16 length bound used by attachment refs without splitting a character. */
function truncateName(value, length) {
  const prefix = value.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/**
 * A supplied name is reduced to a bare file name: no directory part, no reserved or control
 * characters, no Windows device name and a bounded length. The caller's name is only ever used
 * for display and for the extension it declares.
 */
export function safeAttachmentName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '附件名称不正确。');
  const base = path.basename(value.toWellFormed().replace(/\\/g, '/').trim());
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    // 1.3.0: Windows drops trailing dots and spaces, and the workspace path check rejects them.
    .replace(/[ .]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new HttpError(400, '附件名称不正确。');
  if (WINDOWS_DEVICE.test(cleaned)) throw new HttpError(400, '附件名称不能使用系统保留的设备名。');
  if (cleaned.length <= 120) return cleaned;
  const extension = extensionOf(cleaned);
  const stem = extension ? cleaned.slice(0, -(extension.length + 1)) : cleaned;
  const suffix = extension ? `.${extension}` : '';
  const shortened = truncateName(stem, 120 - suffix.length).replace(/[ .]+$/, '') || 'attachment';
  return `${shortened}${suffix}`;
}

/** The four raster formats the image validator accepts, recognised from their leading bytes. */
export function looksLikeRaster(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false;
  return bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG'
    || bytes[0] === 0xff && bytes[1] === 0xd8
    || ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function replaceExtension(name, extension) {
  const current = extensionOf(name);
  const stem = current ? name.slice(0, -(current.length + 1)) : name;
  const suffix = `.${extension}`;
  return `${truncateName(stem, 120 - suffix.length)}${suffix}`;
}

function decodeUpload({ name, mime, data }) {
  if (typeof data !== 'string' || !data) throw new HttpError(400, '附件内容必须是 Base64 数据。');
  const match = DATA_URI.exec(data);
  if (!match) throw new HttpError(400, '附件内容必须是 data:<类型>;base64,<内容> 格式。');
  const declaredMime = match[1].toLowerCase();
  const encoded = match[2];
  if (!encoded.length) throw new HttpError(400, '附件内容为空。');
  // The encoded length is checked first, so an oversized upload is never decoded in memory.
  if (Math.floor((encoded.length * 3) / 4) > MAX_ATTACHMENT_BYTES + 3) throw new HttpError(413, `附件不能超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB。`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new HttpError(400, '附件的 Base64 编码不正确。');
  if (!bytes.length) throw new HttpError(400, '附件内容为空。');
  const named = safeAttachmentName(name);
  const declared = typeof mime === 'string' && MIME_PATTERN.test(mime.trim().toLowerCase()) ? mime.trim().toLowerCase() : '';
  const type = declared || declaredMime || mimeForName(named);
  // A declared image is validated strictly: a text file renamed to .png must be refused rather
  // than stored as an image. A file that was merely named as text but really holds a raster
  // image is recognised from its content instead, so it previews and reaches the model as one.
  // 1.3.3: only the four raster types are images here. An SVG, BMP, ICO, AVIF or TIFF used to be
  // refused outright because its browser type starts with image/; it is now kept as an ordinary
  // file the agent can open (never inlined and never served back as an image).
  const image = INLINE_IMAGE_TYPES.has(type) || looksLikeRaster(bytes);
  if (image) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, `图片不能超过 ${MAX_IMAGE_BYTES / (1024 * 1024)} MB。`);
    let validated;
    try { validated = validateImageBytes(bytes); }
    catch { throw new HttpError(422, '图片内容或格式不正确；仅支持有效的 PNG、JPEG、WebP 或 GIF 图片。'); }
    // The validated content decides the stored type and extension, not the name that was sent.
    return { bytes, mime: validated.mime, name: replaceExtension(named, validated.extension) };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `附件不能超过 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB。`);
  return { bytes, mime: type.startsWith('image/') ? 'application/octet-stream' : type, name: named };
}

/** Store one uploaded attachment inside the session's own directory. */
export async function saveAttachment(workspace, upload) {
  if (!isObject(upload)) throw new HttpError(400, '附件内容必须是 JSON 对象。');
  if (Object.keys(upload).some(field => !['name', 'mime', 'data'].includes(field))) throw new HttpError(400, '上传附件仅接受 name、mime 和 data。');
  const decoded = decodeUpload(upload);
  const id = randomBytes(16).toString('hex');
  const ref = `${id}__${decoded.name}`;
  const directory = await workspacePath(workspace, ATTACHMENT_DIRECTORY, { allowMissing: true });
  await fs.mkdir(directory.absolute, { recursive: true, mode: 0o700 });
  const target = await workspacePath(workspace, `${ATTACHMENT_DIRECTORY}/${ref}`, { allowMissing: true });
  await atomicWrite(target.absolute, decoded.bytes);
  return { id, ref, name: decoded.name, mime: decoded.mime, size: decoded.bytes.length, path: `${ATTACHMENT_DIRECTORY}/${ref}` };
}

/**
 * Resolve the references one message carries. Every reference is checked on disk inside the
 * session workspace, so a caller cannot name a file it did not upload into this session.
 */
export async function resolveMessageAttachments(workspace, requested) {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) throw new HttpError(400, '附件列表必须是数组。');
  if (requested.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new HttpError(400, `一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。`);
  const seen = new Set();
  const attachments = [];
  let total = 0;
  for (const value of requested) {
    if (typeof value !== 'string' || !ATTACHMENT_REF.test(value)) throw new HttpError(400, '附件引用不正确，请重新添加附件。');
    if (seen.has(value)) continue;
    seen.add(value);
    let target;
    try { target = await workspacePath(workspace, `${ATTACHMENT_DIRECTORY}/${value}`); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new HttpError(404, '附件已不存在，请重新添加。');
      throw error;
    }
    const stat = await fs.lstat(target.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(400, '附件必须是工作目录内的普通文件。');
    total += stat.size;
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new HttpError(413, `一条消息的附件总大小不能超过 ${MAX_MESSAGE_ATTACHMENT_BYTES / (1024 * 1024)} MB。`);
    const name = value.slice(34);
    attachments.push({ id: value.slice(0, 32), ref: value, name, mime: mimeForName(name), size: stat.size, path: `${ATTACHMENT_DIRECTORY}/${value}` });
  }
  return attachments;
}

export function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The text one user turn contributes for its attachments. It states the workspace-relative path
 * and the type, so the model opens the file with its own tools instead of guessing at contents.
 */
export function attachmentContextText(attachments, { inlined = null } = {}) {
  const items = (attachments ?? []).filter(attachment => attachment?.path);
  if (!items.length) return '';
  return `附件（已保存在本会话工作目录，可用工具打开）：\n${items
    .map(attachment => {
      const note = inlined?.has(attachment.ref) ? '，图片内容已随消息附上' : '';
      return `- ${attachment.path}（${attachment.mime || '未知类型'}，${formatAttachmentSize(attachment.size)}${note}）`;
    })
    .join('\n')}`;
}


/**
 * The image parts one message may send upstream. `budget.remaining` is shared by the whole
 * request, so a long conversation cannot accumulate unbounded inline bytes. A file that is too
 * large, that no longer looks like a raster image, or that cannot be read is skipped and
 * reported rather than sent as garbage.
 */
export async function inlineImagesForTurn(workspace, attachments, budget) {
  const parts = [];
  const refs = [];
  const omitted = [];
  for (const attachment of attachments ?? []) {
    if (!INLINE_IMAGE_TYPES.has(String(attachment?.mime ?? ''))) continue;
    const name = attachment.name || '图片';
    if (attachment.size > MAX_INLINE_IMAGE_BYTES) { omitted.push({ name, reason: 'too_large' }); continue; }
    if (budget.remaining < attachment.size) { omitted.push({ name, reason: 'budget' }); continue; }
    try {
      const target = await workspacePath(workspace, attachment.path);
      const bytes = await fs.readFile(target.absolute);
      if (bytes.length !== attachment.size || !looksLikeRaster(bytes)) throw new Error('图片内容已变化。');
      budget.remaining -= bytes.length;
      refs.push(attachment.ref);
      parts.push({ type: 'image_url', image_url: { url: `data:${attachment.mime};base64,${bytes.toString('base64')}` } });
    } catch {
      omitted.push({ name, reason: 'unreadable' });
    }
  }
  return { parts, refs, omitted };
}
