/**
 * Harness Gemini UI - Local REST API, SSE Stream & File/Attachment Utilities
 * License: MIT
 */

import { sortSessions as hgSortSessions } from '../session-tools.js';

const PREVIEWABLE_RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const NATIVE_FILE_ACTIONS = ['default', 'choose', 'reveal'];

const RASTER_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i;

const COPY_ERR_INVALID_URL = '这个地址不是可以复制的图片。';
const COPY_ERR_TOO_LARGE = '图片太大，无法复制到剪贴板。';
const COPY_ERR_FAILED = '复制失败，请改用下载后手动复制。';
const COPY_ERR_PNG_CONVERT = '这张图片无法转换成可复制的 PNG。';

/**
 * Structured error returned by the local Harness HTTP service.
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseApiError(response) {
  let message = `请求未完成（${response.status}）`;
  try {
    const body = await response.json();
    message =
      typeof body.error === 'string'
        ? body.error
        : body.error?.message || body.message || message;
  } catch {
    // Keep fallback status message when response body is not JSON.
  }
  return new ApiError(message, response.status);
}

export async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('暂时无法连接本地服务。请确认工作台仍在运行，然后重试。', 0);
  }
  if (!response.ok) {
    throw await parseApiError(response);
  }
  return response.status === 204 ? null : response.json();
}

function withSessionQuery(url, { sessionId, ...fetchOptions } = {}) {
  const fullUrl =
    typeof sessionId === 'string' && sessionId
      ? `${url}${url.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
      : url;
  return [fullUrl, fetchOptions];
}

/**
 * Unified local REST API client.
 */
export const api = {
  status: () => requestJson('/api/status'),
  settings: () => requestJson('/api/settings'),
  saveSettings: (payload) =>
    requestJson('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  skills: () => requestJson('/api/skills'),
  createSkill: (payload) =>
    requestJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateSkill: (id, payload) =>
    requestJson(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteSkill: (id) =>
    requestJson(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  externalSkills: () => requestJson('/api/external-skills'),
  setExternalSkill: (name, enabled) =>
    requestJson(`/api/external-skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  openExternalSkillsFolder: () =>
    requestJson('/api/external-skills/open-folder', {
      method: 'POST',
      body: '{}',
    }),
  models: (profileId) =>
    requestJson(`/api/models${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`),
  modelsForDraft: (draft) =>
    requestJson('/api/models', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  sessions: () => requestJson('/api/sessions'),
  session: (id) => requestJson(`/api/sessions/${encodeURIComponent(id)}`),
  sessionContext: (id) => requestJson(`/api/sessions/${encodeURIComponent(id)}/context`),
  activateSession: (id) =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: '{}',
    }),
  createSession: () =>
    requestJson('/api/sessions', {
      method: 'POST',
      body: '{}',
    }),
  deleteSession: (id) =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  updateSessionFlags: (id, flags) =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/flags`, {
      method: 'POST',
      body: JSON.stringify(flags),
    }),
  bulkDeleteSessions: (options) =>
    requestJson('/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify(options || {}),
    }),
  searchSessions: (query, caseSensitive = false) =>
    requestJson(
      `/api/sessions/search?q=${encodeURIComponent(query)}${caseSensitive ? '&caseSensitive=1' : ''}`,
    ),
  stop: (id) =>
    requestJson(`/api/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: '{}',
    }),
  approve: (approvalId, approved) =>
    requestJson(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    }),
  browserResult: (requestId, payload) =>
    requestJson(`/api/browser/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadAttachment: (sessionId, payload) =>
    requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  workspace: (relPath = '', options) =>
    requestJson(...withSessionQuery(`/api/workspace?path=${encodeURIComponent(relPath)}`, options)),
  file: (relPath, options) =>
    requestJson(
      ...withSessionQuery(`/api/workspace/file?path=${encodeURIComponent(relPath)}`, options),
    ),
  fileInfo: (relPath, options) =>
    requestJson(
      ...withSessionQuery(`/api/workspace/file-info?path=${encodeURIComponent(relPath)}`, options),
    ),
  fileApplications: (relPath, options) =>
    requestJson(
      ...withSessionQuery(
        `/api/workspace/applications?path=${encodeURIComponent(relPath)}`,
        options,
      ),
    ),
  openFile: (filePath, action, applicationId, sessionId) =>
    requestJson('/api/workspace/open-file', {
      method: 'POST',
      body: JSON.stringify({
        path: filePath,
        action,
        ...(action === 'application' ? { applicationId } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    }),
};

/**
 * Send a user turn to `/api/sessions/:id/messages` and consume SSE events.
 */
export async function streamTurn(sessionId, payload, { signal, onEvent }) {
  let response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('与本地服务的连接已断开。已收到的内容会保留。', 0);
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }
  if (!response.body) {
    throw new ApiError('服务没有返回可读取的内容，请重试。', 0);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchFrame = (rawBlock) => {
    let eventName = 'message';
    const dataLines = [];
    for (const line of rawBlock.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (!dataLines.length || dataLines.join('\n') === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      throw new ApiError('收到的消息格式不完整。请重新打开会话查看已保存的内容。', 0);
    }
    onEvent(eventName === 'message' && parsed.type ? parsed.type : eventName, parsed);
  };

  const drainBuffer = () => {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      dispatchFrame(block);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drainBuffer();
    }
    buffer += decoder.decode();
    drainBuffer();
    if (buffer.trim()) {
      dispatchFrame(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

export function sanitizeWorkspacePreviewUrl(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/api/workspace/file-content?') ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return '';
  }
  try {
    const parsed = new URL(value, 'http://workspace.local');
    if (
      parsed.origin !== 'http://workspace.local' ||
      parsed.pathname !== '/api/workspace/file-content' ||
      !parsed.searchParams.get('path') ||
      parsed.hash
    ) {
      return '';
    }
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

export function workspaceRelativeImageUrl(rawPath, sessionId) {
  if (typeof rawPath !== 'string' || !sessionId) return '';
  const cleaned = rawPath.trim().replace(/^\.\//, '');
  if (
    !cleaned ||
    cleaned.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/i.test(cleaned) ||
    cleaned.includes('..') ||
    cleaned.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(cleaned)
  ) {
    return '';
  }
  return `/api/workspace/file-content?path=${encodeURIComponent(cleaned)}&sessionId=${encodeURIComponent(sessionId)}`;
}

export function normalizeWorkspaceFileInfo(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof raw.path !== 'string' ||
    !raw.path ||
    typeof raw.name !== 'string' ||
    !raw.name
  ) {
    throw new Error('文件信息不完整，请重新读取。');
  }
  const kind = ['text', 'image'].includes(raw.kind) ? raw.kind : 'other';
  const mime = typeof raw.mime === 'string' ? raw.mime.toLowerCase() : '';
  const previewUrl =
    kind === 'image' && PREVIEWABLE_RASTER_MIMES.has(mime)
      ? sanitizeWorkspacePreviewUrl(raw.previewUrl)
      : '';

  return {
    path: raw.path,
    name: raw.name,
    size: Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : null,
    kind,
    mime,
    previewUrl,
    canPreview: kind === 'text' || Boolean(previewUrl),
    actions: Object.fromEntries(
      NATIVE_FILE_ACTIONS.map((action) => [action, raw.actions?.[action] === true]),
    ),
  };
}

export function formatClockTime(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(+(bytes < 10240))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function stringifyToolValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

export function basenameOrWorkspace(filePath) {
  return filePath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工作目录';
}

export function sortSessionList(list) {
  return hgSortSessions(list);
}

export function sanitizeImageSrc(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\.svg(?:[?#]|$)/i.test(trimmed)) return '';
  if (/^\/api\/artifacts\/[^/?#]+(?:\?[^#]*)?$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/api/workspace/file-content?')) {
    return sanitizeWorkspacePreviewUrl(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? trimmed
      : '';
  } catch {
    return '';
  }
}

export function safeMarkdownUrlTransform(url, key) {
  if (key === 'src') return sanitizeImageSrc(url);
  if (
    url.startsWith('/api/artifacts/') ||
    url.startsWith('#') ||
    url.startsWith('/api/workspace/file-content?')
  ) {
    return url;
  }
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

export function artifactDownloadUrl(artifact) {
  if (artifact.downloadUrl && sanitizeImageSrc(artifact.downloadUrl)) {
    return artifact.downloadUrl;
  }
  if (artifact.url?.startsWith('/api/artifacts/')) {
    return `${artifact.url}${artifact.url.includes('?') ? '&' : '?'}download=1`;
  }
  return sanitizeImageSrc(artifact.url);
}

export function classifyAttachmentKind(item) {
  const mime = String(item?.mime || item?.type || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  const name = String(item?.name || '');

  if (mime.startsWith('image/') || RASTER_EXTENSION_RE.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.(?:xlsx?|xlsm|ods|csv|tsv)$/i.test(name) || /spreadsheet|ms-excel|csv/.test(mime)) {
    return 'sheet';
  }
  if (
    /\.(?:zip|gz|tgz|tar|7z|rar|bz2|xz)$/i.test(name) ||
    /zip|gzip|tar|x-7z|rar/.test(mime)
  ) {
    return 'archive';
  }
  if (/\.(?:docx?|odt|rtf)$/i.test(name) || /word|opendocument\.text/.test(mime)) {
    return 'document';
  }
  if (/\.(?:pptx?|ppt|odp)$/i.test(name) || /presentation/.test(mime)) {
    return 'slide';
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    /\.(?:txt|md|json|jsonl|log|ya?ml|xml|html?|css|js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|c|h|cpp|cs|sh|bash|ps1|bat|sql|toml|ini|env)$/i.test(
      name,
    )
  ) {
    return 'text';
  }
  return 'file';
}

export function validateAttachmentFile(file) {
  if (!file || typeof file.name !== 'string' || !file.name.trim()) {
    return '这个文件没有可用的名称，无法添加。';
  }
  if (!file.size) {
    return `${file.name} 是空文件，无法添加。`;
  }
  if (file.size > 20971520) {
    return `${file.name} 超过 20 MB，暂不支持添加。`;
  }
  if (classifyAttachmentKind(file) === 'image' && file.size > 15728640) {
    return `${file.name} 超过 15 MB，图片暂不支持添加。`;
  }
  return '';
}

export async function fileToDataUrl(file) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  const mime =
    String(file.type || '')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'application/octet-stream';
  return `data:${mime};base64,${btoa(binary)}`;
}

export function createPastedTextFile(text, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([text], `粘贴文本-${stamp}.txt`, { type: 'text/plain' });
}

export function attachmentPreviewUrl(attachment, sessionId) {
  if (!attachment?.path || !sessionId) return '';
  return `/api/workspace/file-content?path=${encodeURIComponent(attachment.path)}&sessionId=${encodeURIComponent(sessionId)}`;
}

function resolveCopyableImageUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 4096 || url.startsWith('//')) {
    return null;
  }
  if (url.startsWith('/')) return url;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? url
      : null;
  } catch {
    return null;
  }
}

async function convertBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  let canvas;
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(bitmap.width || 1, bitmap.height || 1);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width || 1;
    canvas.height = bitmap.height || 1;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(COPY_ERR_PNG_CONVERT);
  }
  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') {
    bitmap.close();
  }
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (pngBlob) => (pngBlob ? resolve(pngBlob) : reject(new Error(COPY_ERR_PNG_CONVERT))),
      'image/png',
    );
  });
}

export async function copyImageToClipboard(url, deps = {}) {
  const targetUrl = resolveCopyableImageUrl(url);
  if (!targetUrl) {
    throw new Error(COPY_ERR_INVALID_URL);
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const clipboard = deps.clipboard ?? globalThis.navigator?.clipboard;
  const ClipboardItemCtor = deps.ClipboardItemCtor ?? globalThis.ClipboardItem;
  const desktop = deps.desktop ?? globalThis.window?.harnessDesktop;
  const toPngBlob = deps.toPngBlob ?? convertBlobToPng;

  if (typeof desktop?.copyImage === 'function') {
    try {
      await desktop.copyImage(targetUrl);
      return { via: 'desktop' };
    } catch {
      // Fall back to browser Clipboard API when native copy fails.
    }
  }

  try {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const response = await fetchImpl(targetUrl, { credentials: 'same-origin' });
    if (!response || response.ok !== true) throw new Error('the image response was not ok');
    const blob = await response.blob();
    if (!blob || typeof blob.size !== 'number' || typeof blob.type !== 'string') {
      throw new Error('the image response was not a blob');
    }
    if (blob.size > 20971520) {
      throw new Error(COPY_ERR_TOO_LARGE);
    }
    const pngBlob = blob.type === 'image/png' ? blob : await toPngBlob(blob);
    if (!pngBlob || typeof pngBlob.size !== 'number') {
      throw new Error('the image could not be converted');
    }
    if (typeof clipboard?.write !== 'function' || typeof ClipboardItemCtor !== 'function') {
      throw new Error('the browser clipboard is unavailable');
    }
    await clipboard.write([new ClipboardItemCtor({ 'image/png': pngBlob })]);
    return { via: 'clipboard' };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === COPY_ERR_TOO_LARGE || err.message === COPY_ERR_INVALID_URL)
    ) {
      throw err;
    }
    throw new Error(COPY_ERR_FAILED);
  }
}
