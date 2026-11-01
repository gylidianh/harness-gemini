/**
 * Semantic snapshot and native input for the built-in browser.
 *
 * The model never guesses coordinates. SNAPSHOT_PAGE_SCRIPT tags every visible
 * interactive element with a short ref (`h1`, `h2`, ...) and reports its role, name
 * and rectangle. Each action then re-resolves that ref inside the page immediately
 * before a native input event is dispatched, so a click is never fired at a position
 * a re-rendering framework has already moved.
 *
 * Coordinates need one conversion: the page reports CSS pixels, while a native input
 * event is positioned in the view's own DIP. Zoom, device emulation and clipping each
 * change that ratio, so it is measured from the live page instead of assumed.
 *
 * This module is shared: the server validates a request before it reaches the
 * renderer, and the desktop main process performs it. Nothing here touches Electron,
 * and the page only ever receives a script as text.
 */

export const MAX_SNAPSHOT_ELEMENTS = 120;
export const MAX_ACTION_TEXT = 4_000;
export const MAX_ACTION_POINTS = 40;
export const MAX_SCROLL_PIXELS = 20_000;
export const MAX_PRESS_KEYS = 4;
export const REF_PATTERN = /^h[1-9][0-9]{0,3}$/;
export const BROWSER_ACTION_KINDS = new Set(['click', 'type', 'press', 'scroll', 'drag']);

const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
const UNEDITABLE_INPUT = ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'];

/**
 * Report the interactive surface of the current document. It is deliberately a
 * compact list rather than page markup: the model receives roles, names and
 * rectangles, never raw HTML.
 */
export const SNAPSHOT_PAGE_SCRIPT = `(() => {
  try {
    const clean = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const LIMIT = ${MAX_SNAPSHOT_ELEMENTS};
    for (const stale of document.querySelectorAll('[data-harness-ref]')) stale.removeAttribute('data-harness-ref');
    const rectOf = element => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return null;
      if (Number(style.opacity || 1) < 0.05) return null;
      return rect;
    };
    const nameOf = element => {
      const own = clean(element.getAttribute('aria-label'));
      if (own) return own.slice(0, 120);
      const labelled = element.getAttribute('aria-labelledby');
      if (labelled) {
        const text = labelled.split(/\\s+/).map(id => { const node = document.getElementById(id); return node ? clean(node.textContent) : ''; }).filter(Boolean).join(' ');
        if (text) return text.slice(0, 120);
      }
      const fallback = clean(element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder'));
      if (fallback) return fallback.slice(0, 120);
      if (element.labels && element.labels.length) {
        const text = clean(Array.from(element.labels).map(node => node.textContent).join(' '));
        if (text) return text.slice(0, 120);
      }
      return clean(element.textContent || '').slice(0, 120);
    };
    const roleOf = element => {
      const explicit = clean(element.getAttribute('role'));
      if (explicit) return explicit.slice(0, 40);
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (element.isContentEditable === true) return 'textbox';
      return 'generic';
    };
    const elements = [];
    let truncated = false;
    // The whole document is scanned, not only the visible area: an element below the fold is
    // still a valid target, because resolving its ref scrolls it into view before any input.
    // Visible elements are listed first so the size limit never pushes them out.
    const inView = rect => !(rect.bottom < -4 || rect.right < -4 || rect.top > innerHeight + 4 || rect.left > innerWidth + 4);
    const visibleCandidates = [];
    const offscreenCandidates = [];
    for (const element of document.querySelectorAll('${SELECTOR}')) {
      const rect = rectOf(element);
      if (!rect) continue;
      const role = roleOf(element);
      if (role === 'generic' && !element.hasAttribute('onclick') && element.isContentEditable !== true) continue;
      const visible = inView(rect);
      const bucket = visible ? visibleCandidates : offscreenCandidates;
      if (bucket.length < LIMIT) bucket.push({ element, rect, role, visible });
      else truncated = true;
      if (visibleCandidates.length + offscreenCandidates.length > LIMIT) truncated = true;
      // Once LIMIT visible targets are retained, later entries cannot enter the result.
      if (visibleCandidates.length >= LIMIT) { truncated = true; break; }
    }
    const ordered = visibleCandidates.concat(offscreenCandidates);
    for (const { element, rect, role, visible } of ordered.slice(0, LIMIT)) {
      const ref = 'h' + (elements.length + 1);
      element.setAttribute('data-harness-ref', ref);
      const item = {
        ref, role, tag: element.tagName.toLowerCase(), name: nameOf(element),
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      };
      if (!visible) item.inViewport = false;
      if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') item.disabled = true;
      if (role === 'checkbox' || role === 'radio') item.checked = element.checked === true;
      const type = clean(element.getAttribute('type')).toLowerCase();
      if (type) item.type = type.slice(0, 20);
      // A password field's contents are never part of a snapshot.
      if (type !== 'password' && typeof element.value === 'string' && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) item.value = element.value.slice(0, 120);
      if (element.tagName === 'SELECT') item.options = Array.from(element.options).slice(0, 40).map(option => ({ value: String(option.value).slice(0, 120), label: clean(option.textContent).slice(0, 120), selected: option.selected === true }));
      elements.push(item);
    }
    const root = document.documentElement;
    return {
      url: location.href,
      title: typeof document.title === 'string' ? document.title.slice(0, 300) : '',
      viewport: {
        width: innerWidth, height: innerHeight,
        scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
        scrollWidth: root ? root.scrollWidth : innerWidth, scrollHeight: root ? root.scrollHeight : innerHeight,
      },
      elements, truncated,
    };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
})()`;

/** The live page size, used to convert CSS pixels into the view's DIP exactly. */
export const MEASURE_PAGE_SCRIPT = `(() => {
  try { return { width: innerWidth, height: innerHeight }; }
  catch (error) { return { error: String((error && error.message) || error).slice(0, 500) }; }
})()`;

/**
 * Resolve one ref to its current position. The element is scrolled into view when it
 * sits outside the visible area, and the rectangle is measured after that scroll, so
 * the coordinates describe where the element actually is now.
 */
export function resolveRefScript(ref) {
  return `(() => {
  try {
    const element = document.querySelector('[data-harness-ref="${ref}"]');
    if (!element) return { found: false };
    const before = element.getBoundingClientRect();
    let scrolled = false;
    if (before.top < 8 || before.bottom > innerHeight - 8 || before.left < 8 || before.right > innerWidth - 8) {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      scrolled = true;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const clean = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return {
      found: true, scrolled,
      visible: rect.width >= 2 && rect.height >= 2 && style.visibility !== 'hidden' && style.display !== 'none',
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      editable: element.isContentEditable === true || tag === 'textarea' || (tag === 'input' && ${JSON.stringify(UNEDITABLE_INPUT)}.indexOf(type) < 0),
      role: clean(element.getAttribute('role') || tag).slice(0, 40),
      name: clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').slice(0, 120),
      centerX: Math.round(rect.x + rect.width / 2), centerY: Math.round(rect.y + rect.height / 2),
      left: Math.round(rect.x), top: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
})()`;
}

/** Focus a keyboard target without activating a button/link as a click would. */
export function focusRefScript(ref) {
  return `(() => {
  try {
    const element = document.querySelector('[data-harness-ref="${ref}"]');
    if (!element) return { focused: false };
    if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return { focused: false };
    element.focus({ preventScroll: true });
    return { focused: element.isConnected && (document.activeElement === element || element.contains(document.activeElement)) };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
})()`;
}

/** Jump to the very top or the very bottom of the document in one round trip. */
export function scrollScript(mode) {
  const target = mode === 'top' ? '0' : '(document.documentElement ? document.documentElement.scrollHeight : 0)';
  return `(() => {
  try {
    window.scrollTo({ top: ${target}, left: 0, behavior: 'instant' });
    return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0 };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
})()`;
}

/** Where the document sits after a wheel scroll, so the tool reports a real effect. */
export const SCROLL_POSITION_SCRIPT = `(() => {
  try { return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0 }; }
  catch (error) { return { error: String((error && error.message) || error).slice(0, 500) }; }
})()`;

const NAMED_KEYS = new Map(Object.entries({
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
}));
const MODIFIER_NAMES = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta' };

function fail(message) { throw new Error(message); }

/** A ref must be one this app generated; nothing else is ever interpolated into a script. */
export function browserRef(value, label = 'ref') {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) fail(`${label} 必须是 browser_snapshot 返回的 ref，例如 h3。`);
  return value;
}

function finiteCoordinate(value, label) {
  if (!Number.isInteger(value) || Math.abs(value) > 100_000) fail(`${label} 必须是 -100000 到 100000 之间的整数。`);
  return value;
}

/** Either a ref or an explicit page coordinate pair. */
function point(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是 { ref } 或 { x, y }。`);
  const keys = Object.keys(value);
  if (value.ref !== undefined) {
    if (keys.some(key => key !== 'ref')) fail(`${label} 只能包含 ref，或同时包含 x 与 y。`);
    return { ref: browserRef(value.ref, `${label} 的 ref`) };
  }
  if (keys.some(key => key !== 'x' && key !== 'y') || value.x === undefined || value.y === undefined) fail(`${label} 必须同时给出 x 与 y。`);
  return { x: finiteCoordinate(value.x, `${label} 的 x`), y: finiteCoordinate(value.y, `${label} 的 y`) };
}

function keysOf(value) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!list || !list.length || list.length > MAX_PRESS_KEYS) fail(`按键必须是文本或不超过 ${MAX_PRESS_KEYS} 项的文本数组，例如 "Enter" 或 "Control+A"。`);
  return list.map(combo => {
    if (typeof combo !== 'string' || !combo.trim() || combo.length > 40) fail('按键必须是长度不超过 40 的文本，例如 "Enter" 或 "Control+A"。');
    // A separator with an empty side is a typo, not a combination to guess at.
    const parts = combo.split('+').map(part => part.trim());
    if (parts.some(part => !part)) fail(`无法识别按键：${combo.slice(0, 40)}。`);
    const modifiers = [];
    for (const part of parts.slice(0, -1)) {
      const name = MODIFIER_NAMES[part.toLowerCase()];
      if (!name) fail(`无法识别修饰键：${part.slice(0, 20)}。可使用 Control、Shift、Alt、Meta。`);
      if (!modifiers.includes(name)) modifiers.push(name);
    }
    const raw = parts.at(-1);
    const lower = raw.toLowerCase();
    const key = NAMED_KEYS.get(lower) ?? (/^f([1-9]|1[0-2])$/.test(lower) ? `F${lower.slice(1)}` : raw.length === 1 ? raw : null);
    if (!key) fail(`无法识别按键：${raw.slice(0, 20)}。可使用单个字符、F1–F12，或 Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、Space。`);
    return { key, modifiers, label: combo.trim() };
  });
}

/** Turn the model's arguments into one validated request, or explain what is wrong. */
export function normalizeRequest(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const kind = input.action;
  if (kind === 'click') {
    const clickCount = input.clickCount === undefined ? 1 : input.clickCount;
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) fail('clickCount 必须是 1 到 3 的整数。');
    return { kind, ref: browserRef(input.ref), clickCount };
  }
  if (kind === 'type') {
    const text = input.text === undefined ? '' : input.text;
    if (typeof text !== 'string' || text.length > MAX_ACTION_TEXT) fail(`输入内容必须是长度不超过 ${MAX_ACTION_TEXT} 的文本。`);
    return { kind, ref: browserRef(input.ref), text, submit: input.submit === true, replace: input.replace !== false };
  }
  if (kind === 'press') return { kind, keys: keysOf(input.keys), ref: input.ref === undefined ? undefined : browserRef(input.ref) };
  if (kind === 'scroll') {
    const direction = input.direction === undefined ? 'down' : input.direction;
    if (!['up', 'down', 'top', 'bottom'].includes(direction)) fail('direction 必须是 up、down、top 或 bottom。');
    const amount = input.amount === undefined ? 600 : input.amount;
    if (!Number.isInteger(amount) || amount < 40 || amount > MAX_SCROLL_PIXELS) fail(`amount 必须是 40 到 ${MAX_SCROLL_PIXELS} 之间的整数。`);
    return { kind, direction, amount, ref: input.ref === undefined ? undefined : browserRef(input.ref) };
  }
  if (kind === 'drag') return { kind, from: point(input.from, '起点'), to: point(input.to, '终点') };
  fail('不支持的内置浏览器操作。');
}

function message(error) {
  const text = error && error.message ? String(error.message) : String(error ?? '');
  return text.slice(0, 500) || '内置浏览器未能完成这个操作。';
}

/**
 * The native input sequence. Every dependency is injected so the ordering, the
 * coordinate scaling and the honest failure modes are testable without Electron.
 *
 * `bounds` is the view's own size in DIP and `measure` reports the live page size in
 * CSS pixels; their ratio is the conversion this page needs right now. `visible` is
 * the part of the view the user can actually see, in view coordinates, so a click is
 * never aimed at a clipped-away region.
 */
export function createBrowserInput({ evaluate, sendInput, insertText, measure, bounds, visible, delay }) {
  const area = visible && visible.width > 1 && visible.height > 1 ? visible : { x: 0, y: 0, width: bounds?.width ?? 0, height: bounds?.height ?? 0 };
  const usable = () => bounds && bounds.width > 1 && bounds.height > 1 && area.width > 1 && area.height > 1;
  let cached;

  async function ratio() {
    if (!usable()) fail('内置浏览器面板当前没有显示，无法像真实用户一样操作页面。');
    if (cached) return cached;
    const page = measure ? await measure() : await evaluate(MEASURE_PAGE_SCRIPT);
    if (!page || typeof page !== 'object' || page.error) fail('无法测量内置浏览器中的页面，请重新加载后再试。');
    const width = Number(page.width);
    const height = Number(page.height);
    if (!(width > 0) || !(height > 0)) fail('内置浏览器中的页面尺寸无效，无法定位元素。');
    const scale = bounds.width / width;
    if (!(scale > 0.1) || scale > 8) fail('内置浏览器的显示比例异常，无法定位元素。');
    cached = { scale, width, height };
    return cached;
  }

  async function devicePoint(x, y) {
    const { scale } = await ratio();
    return { x: Math.round(x * scale), y: Math.round(y * scale) };
  }

  function inside(position, label) {
    if (position.x < area.x || position.y < area.y || position.x > area.x + area.width - 1 || position.y > area.y + area.height - 1) {
      fail(`${label}不在内置浏览器的可见区域内，请先滚动页面或调整面板大小后重试。`);
    }
  }

  function targetOf(resolved) {
    return { role: resolved.role || '', name: resolved.name || '' };
  }

  async function resolveTarget(ref) {
    const value = await evaluate(resolveRefScript(ref));
    if (!value || typeof value !== 'object') fail('无法在内置浏览器中确认这个元素的位置。');
    if (value.error) fail(message(value.error));
    if (value.found !== true) fail('页面已经变化，这个 ref 不再对应任何元素；请重新调用 browser_snapshot 获取新的 ref。');
    if (value.visible !== true) fail('这个元素当前不可见，无法操作；请重新调用 browser_snapshot 查看页面现状。');
    return value;
  }

  async function resolvePoint(value, label) {
    if (value.ref !== undefined) {
      const resolved = await resolveTarget(value.ref);
      const position = await devicePoint(resolved.centerX, resolved.centerY);
      inside(position, label);
      return { position, resolved };
    }
    const position = await devicePoint(value.x, value.y);
    inside(position, label);
    return { position, resolved: null };
  }

  async function pressKeys(combos) {
    for (const combo of combos) {
      sendInput({ type: 'keyDown', keyCode: combo.key, modifiers: combo.modifiers });
      await delay(16);
      sendInput({ type: 'keyUp', keyCode: combo.key, modifiers: combo.modifiers });
      await delay(24);
    }
  }

  /** A native click on a resolved element, checked against the page afterwards. */
  async function click({ ref, clickCount }) {
    const before = await resolveTarget(ref);
    if (before.disabled) fail('这个元素当前处于禁用状态，点击不会有任何效果。');
    const position = await devicePoint(before.centerX, before.centerY);
    inside(position, '这个元素');
    sendInput({ type: 'mouseMove', x: position.x, y: position.y });
    await delay(12);
    for (let count = 1; count <= clickCount; count++) {
      sendInput({ type: 'mouseDown', x: position.x, y: position.y, button: 'left', clickCount: count });
      await delay(24);
      sendInput({ type: 'mouseUp', x: position.x, y: position.y, button: 'left', clickCount: count });
      if (count < clickCount) await delay(24);
    }
    await delay(120);
    const after = await evaluate(resolveRefScript(ref));
    const moved = Boolean(after && after.found === true && (Math.abs((after.centerX ?? 0) - before.centerX) > 2 || Math.abs((after.centerY ?? 0) - before.centerY) > 2));
    return {
      action: 'click', ref, target: targetOf(before), scrolled: before.scrolled === true,
      moved, stillPresent: Boolean(after && after.found === true),
    };
  }

  /** Focus the field natively, replace or append text, optionally submit. */
  async function type({ ref, text, submit, replace }) {
    const before = await resolveTarget(ref);
    if (before.disabled) fail('这个输入框当前处于禁用状态，无法输入。');
    if (before.editable !== true) fail('这个元素不能输入文字；如果是按钮或链接，请改用 browser_act 的 click。');
    const position = await devicePoint(before.centerX, before.centerY);
    inside(position, '这个输入框');
    sendInput({ type: 'mouseMove', x: position.x, y: position.y });
    await delay(12);
    sendInput({ type: 'mouseDown', x: position.x, y: position.y, button: 'left', clickCount: 1 });
    await delay(20);
    sendInput({ type: 'mouseUp', x: position.x, y: position.y, button: 'left', clickCount: 1 });
    await delay(60);
    if (replace) await pressKeys([{ key: 'A', modifiers: ['control'] }]);
    if (text) insertText(text);
    else if (replace) await pressKeys([{ key: 'Backspace', modifiers: [] }]);
    await delay(80);
    if (submit) {
      await pressKeys([{ key: 'Return', modifiers: [] }]);
      await delay(200);
    }
    const after = await evaluate(resolveRefScript(ref));
    return {
      action: 'type', ref, target: targetOf(before), characters: text.length,
      submitted: submit === true, replaced: replace === true, stillPresent: Boolean(after && after.found === true),
    };
  }

  async function press({ keys, ref }) {
    if (ref !== undefined) {
      const target = await resolvePoint({ ref }, '这个元素');
      if (target.resolved.disabled) fail('这个元素当前处于禁用状态，无法接收按键。');
      const focus = await evaluate(focusRefScript(ref));
      if (!focus || focus.focused !== true) fail(focus?.error ? message(focus.error) : '无法聚焦这个元素，未发送按键；请重新调用 browser_snapshot 确认目标。');
    }
    await pressKeys(keys);
    await delay(160);
    return { action: 'press', keys: keys.map(combo => combo.label), focused: ref !== undefined };
  }

  async function scroll({ direction, amount, ref }) {
    if (direction === 'top' || direction === 'bottom') {
      const value = await evaluate(scrollScript(direction));
      if (!value || typeof value !== 'object') fail('无法滚动这个页面。');
      if (value.error) fail(message(value.error));
      return { action: 'scroll', direction, scrollY: Math.round(value.scrollY ?? 0), scrollHeight: Math.round(value.scrollHeight ?? 0) };
    }
    const anchor = ref === undefined
      ? { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) }
      : (await resolvePoint({ ref }, '滚动位置')).position;
    inside(anchor, '滚动位置');
    const delta = direction === 'up' ? -amount : amount;
    sendInput({ type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY: delta, wheelTicksX: 0, wheelTicksY: delta / 100, canScroll: true, hasPreciseScrollingDeltas: true });
    await delay(200);
    const after = await evaluate(SCROLL_POSITION_SCRIPT);
    return { action: 'scroll', direction, amount, scrollY: after && typeof after.scrollY === 'number' ? Math.round(after.scrollY) : null };
  }

  /** Press, move in steps, release. A drag needs intermediate moves to be recognised. */
  async function drag({ from, to }) {
    const start = await resolvePoint(from, '起点');
    const end = await resolvePoint(to, '终点');
    const distance = Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y);
    const steps = Math.max(6, Math.min(MAX_ACTION_POINTS, Math.ceil(distance / 24)));
    sendInput({ type: 'mouseMove', x: start.position.x, y: start.position.y });
    await delay(16);
    sendInput({ type: 'mouseDown', x: start.position.x, y: start.position.y, button: 'left', clickCount: 1 });
    await delay(24);
    for (let step = 1; step <= steps; step++) {
      const x = Math.round(start.position.x + (end.position.x - start.position.x) * step / steps);
      const y = Math.round(start.position.y + (end.position.y - start.position.y) * step / steps);
      sendInput({ type: 'mouseMove', x, y, button: 'left' });
      await delay(14);
    }
    sendInput({ type: 'mouseUp', x: end.position.x, y: end.position.y, button: 'left', clickCount: 1 });
    await delay(160);
    return {
      action: 'drag', steps,
      from: start.resolved ? targetOf(start.resolved) : null,
      to: end.resolved ? targetOf(end.resolved) : null,
    };
  }

  return { click, type, press, scroll, drag };
}
