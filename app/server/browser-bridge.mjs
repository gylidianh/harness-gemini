import { randomUUID } from 'node:crypto';
import { abortError, checkAbort, HttpError, isObject } from './util.mjs';

/**
 * The model's built-in-browser tools run in the desktop renderer, not in this
 * process. A request is announced on the run's SSE stream and the renderer
 * answers on its own HTTP call, so the same code serves the Electron app and the
 * development preview without either one reaching into the other's internals.
 */
export const BROWSER_ACTIONS = new Set(['open', 'navigate', 'read', 'snapshot', 'act', 'screenshot']);
export const MAX_BROWSER_TEXT = 200_000;
export const MAX_BROWSER_LINKS = 20;
export const MAX_SNAPSHOT_ELEMENTS = 120;
const MAX_URL = 4_096;
const MAX_TITLE = 300;
const MAX_ERROR = 500;
/** A screenshot travels as one bounded data URL, checked before it reaches the model. */
const SCREENSHOT_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_SCREENSHOT_CHARS = 8 * 1024 * 1024;

function cleanText(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return null;
  if (!allowEmpty && !value.trim()) return null;
  return value;
}

/**
 * Page text is truncated rather than rejected: a long label is still a useful label,
 * and dropping it would silently hide an element the model needs to act on.
 */
function clipText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function cleanUrl(value) {
  const text = cleanText(value, MAX_URL, { allowEmpty: true });
  return text ?? '';
}

function failureMessage(value) {
  const message = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
  return message ? message.slice(0, MAX_ERROR) : '内置浏览器未能完成此操作。';
}

/** Validate what the renderer sent back before any of it reaches the model. */
export function normalizeBrowserPayload(action, payload) {
  if (!isObject(payload) || typeof payload.ok !== 'boolean') throw new HttpError(400, '浏览器结果格式不正确。');
  if (!payload.ok) throw new HttpError(502, failureMessage(payload.error));
  const result = payload.result;
  if (!isObject(result)) throw new HttpError(502, '内置浏览器没有返回结果。');
  if (action === 'snapshot') return normalizeSnapshotPayload(result);
  if (action === 'act') return normalizeActPayload(result);
  if (action === 'screenshot') return normalizeScreenshotPayload(result);
  if (action === 'open') {
    const title = cleanText(result.title, MAX_TITLE, { allowEmpty: true });
    return { url: cleanUrl(result.url), title: title ?? '', loading: result.loading === true };
  }
  const text = cleanText(result.text, MAX_BROWSER_TEXT, { allowEmpty: true });
  if (text === null) throw new HttpError(502, '内置浏览器返回的页面文字格式不正确。');
  const title = cleanText(result.title, MAX_TITLE, { allowEmpty: true });
  const links = [];
  if (Array.isArray(result.links)) {
    for (const link of result.links.slice(0, MAX_BROWSER_LINKS)) {
      if (!isObject(link)) continue;
      const url = cleanUrl(link.url);
      if (!url) continue;
      links.push({ text: cleanText(link.text, 200, { allowEmpty: true }) ?? url, url });
    }
  }
  return { url: cleanUrl(result.url), title: title ?? '', text, truncated: result.truncated === true, links };
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

/** Validate the page's interactive surface before any of it reaches the model. */
export function normalizeSnapshotPayload(result) {
  const viewport = isObject(result.viewport) ? result.viewport : null;
  if (!viewport) throw new HttpError(502, '内置浏览器没有返回页面尺寸。');
  const size = key => boundedInteger(viewport[key], -10_000_000, 10_000_000);
  const numbers = ['width', 'height', 'scrollX', 'scrollY', 'scrollWidth', 'scrollHeight'].map(size);
  if (numbers.some(value => value === null)) throw new HttpError(502, '内置浏览器返回的页面尺寸不正确。');
  if (!Array.isArray(result.elements)) throw new HttpError(502, '内置浏览器没有返回可交互元素列表。');
  const elements = [];
  for (const element of result.elements.slice(0, MAX_SNAPSHOT_ELEMENTS)) {
    if (!isObject(element)) continue;
    if (typeof element.ref !== 'string' || !/^h[1-9][0-9]{0,3}$/.test(element.ref)) continue;
    const x = boundedInteger(element.x, -200_000, 200_000);
    const y = boundedInteger(element.y, -200_000, 200_000);
    const width = boundedInteger(element.width, 0, 200_000);
    const height = boundedInteger(element.height, 0, 200_000);
    if (x === null || y === null || width === null || height === null) continue;
    const item = {
      ref: element.ref,
      role: clipText(element.role, 40),
      tag: clipText(element.tag, 20),
      name: clipText(element.name, 120),
      x, y, width, height,
    };
    if (element.disabled === true) item.disabled = true;
    if (element.checked === true) item.checked = true;
    if (element.inViewport === false) item.inViewport = false;
    const type = cleanText(element.type, 20, { allowEmpty: true });
    if (type) item.type = type;
    const value = cleanText(element.value, 120, { allowEmpty: true });
    if (value) item.value = value;
    if (Array.isArray(element.options)) {
      item.options = element.options.slice(0, 40).filter(isObject).map(option => ({
        value: clipText(option.value, 120),
        label: clipText(option.label, 120),
        selected: option.selected === true,
      }));
    }
    elements.push(item);
  }
  return {
    url: cleanUrl(result.url), title: cleanText(result.title, MAX_TITLE, { allowEmpty: true }) ?? '',
    viewport: { width: numbers[0], height: numbers[1], scrollX: numbers[2], scrollY: numbers[3], scrollWidth: numbers[4], scrollHeight: numbers[5] },
    elements, truncated: result.truncated === true,
  };
}

/**
 * Validate one captured page image. The bytes are the one field the model itself consumes, so
 * they are checked here: a malformed or oversized payload is refused rather than forwarded.
 */
export function normalizeScreenshotPayload(result) {
  if (typeof result.image !== 'string' || result.image.length > MAX_SCREENSHOT_CHARS || !SCREENSHOT_DATA_URL.test(result.image)) {
    throw new HttpError(502, '内置浏览器返回的截屏图片格式不正确。');
  }
  const size = value => boundedInteger(value, 0, 20_000);
  const width = size(result.width);
  const height = size(result.height);
  if (!width || !height) throw new HttpError(502, '内置浏览器返回的截屏尺寸不正确。');
  return {
    url: cleanUrl(result.url), title: cleanText(result.title, MAX_TITLE, { allowEmpty: true }) ?? '',
    image: result.image, mime: 'image/png', width, height,
    bytes: boundedInteger(result.bytes, 0, MAX_SCREENSHOT_CHARS) ?? 0,
  };
}

/** Validate one performed action's report. */
export function normalizeActPayload(result) {
  const action = cleanText(result.action, 20, { allowEmpty: true });
  if (!action) throw new HttpError(502, '内置浏览器没有返回执行的动作。');
  const keys = Array.isArray(result.keys) ? result.keys.slice(0, 4).map(key => cleanText(key, 40, { allowEmpty: true })).filter(Boolean) : [];
  const target = isObject(result.target)
    ? { role: cleanText(result.target.role, 40, { allowEmpty: true }) ?? '', name: cleanText(result.target.name, 120, { allowEmpty: true }) ?? '' }
    : null;
  const optionalInteger = (value, maximum) => {
    const number = boundedInteger(value, -maximum, maximum);
    return number === null ? undefined : number;
  };
  return {
    action, url: cleanUrl(result.url), target,
    scrolled: result.scrolled === true, moved: result.moved === true, stillPresent: result.stillPresent === true,
    characters: boundedInteger(result.characters, 0, 4_000) ?? 0,
    submitted: result.submitted === true, replaced: result.replaced === true, focused: result.focused === true,
    steps: boundedInteger(result.steps, 0, 40) ?? 0,
    keys,
    direction: cleanText(result.direction, 20, { allowEmpty: true }) ?? '',
    amount: optionalInteger(result.amount, 20_000),
    scrollY: optionalInteger(result.scrollY, 10_000_000),
    scrollHeight: optionalInteger(result.scrollHeight, 10_000_000),
  };
}

export class BrowserBridge {
  constructor() { this.pending = new Map(); }

  /** Ask the renderer to drive the built-in browser and wait for its answer. */
  ask({ runId, action, args, signal, emit, timeoutMs = 90_000 }) {
    checkAbort(signal);
    if (!BROWSER_ACTIONS.has(action)) throw new Error(`不支持的浏览器操作：${String(action).slice(0, 40)}`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('浏览器操作时限不正确。');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, payload) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) { reject(error); return; }
        try { resolve(normalizeBrowserPayload(action, payload)); }
        catch (failure) { reject(failure); }
      };
      const onAbort = () => finish(abortError());
      this.pending.set(id, { id, runId, decide: payload => finish(null, payload) });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(new HttpError(504, '内置浏览器没有在时限内返回结果；页面可能仍在加载，请稍后重试或改用 fetch_url。')), timeoutMs);
      timer.unref?.();
      Promise.resolve(emit({ id, action, args })).catch(error => finish(error));
    });
  }

  resolve(id, payload) {
    const item = this.pending.get(id);
    if (!item) throw new HttpError(404, '该浏览器请求已结束或不存在。');
    item.decide(payload);
  }
}
