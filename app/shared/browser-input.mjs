/**
 * Semantic snapshot and native input for the built-in browser.
 *
 * The model never guesses coordinates. A snapshot registers every visible interactive
 * element under a short ref (`h1`, `h2`, ...) and reports its role, name, rectangle and the
 * row/list item it sits in. Each action re-resolves the ref inside the page immediately
 * before a native input event is dispatched, checks that the element still is the one the
 * snapshot described, and hit-tests the click point so an event never lands on another
 * element.
 *
 * 1.4.1-browserfix:
 *  - refs are kept in an in-page registry, so elements inside open shadow roots and
 *    same-origin iframes can be addressed (document.querySelector cannot see them);
 *  - an open modal dialog is listed first, so its fields are never pushed out by the limit;
 *  - each element carries `context` (its row / list item text) and the resolve step refuses a
 *    ref whose row or name changed since the snapshot;
 *  - a click is hit-tested: if another element covers the target, nothing is sent;
 *  - scroll reports the container that really scrolled (often an inner div, not window);
 *  - press reports the element that actually has focus and can insert a whole string.
 *
 * All in-page logic is one real function serialized with Function#toString, so there is no
 * hand-escaped script text. Only JSON-encoded arguments are interpolated.
 */

export const MAX_SNAPSHOT_ELEMENTS = 120;
export const MAX_ACTION_TEXT = 4_000;
export const MAX_ACTION_POINTS = 40;
export const MAX_SCROLL_PIXELS = 20_000;
export const MAX_PRESS_KEYS = 4;
export const MAX_CONTEXT = 80;
export const REF_PATTERN = /^h[1-9][0-9]{0,3}$/;
export const BROWSER_ACTION_KINDS = new Set(['click', 'type', 'press', 'scroll', 'drag']);

const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
const UNEDITABLE_INPUT = ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'];

/* eslint-disable no-undef */
/**
 * Runs inside the page. Must stay self-contained: it is serialized and evaluated there.
 */
function harnessPage(req) {
  try {
    const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const registry = window.__harnessRefs || (window.__harnessRefs = { map: new Map(), scrollTarget: null });
    const deref = entry => (entry && entry.el && typeof entry.el.deref === 'function' ? entry.el.deref() : entry && entry.el) || null;

    // ---- composed-tree helpers (cross shadow roots and same-origin frames) ----
    const parentOf = node => {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode ? node.getRootNode() : null;
      if (root && root.host) return root.host;
      try { const view = node.ownerDocument && node.ownerDocument.defaultView; if (view && view !== window && view.frameElement) return view.frameElement; } catch { /* cross-origin */ }
      return null;
    };
    const closestComposed = (node, selector) => {
      for (let current = node; current; current = parentOf(current)) {
        try { if (current.matches && current.matches(selector)) return current; } catch { return null; }
      }
      return null;
    };
    const containsComposed = (outer, inner) => {
      for (let current = inner; current; current = parentOf(current)) if (current === outer) return true;
      return false;
    };
    const frameOffset = element => {
      let x = 0; let y = 0;
      try {
        let view = element.ownerDocument.defaultView;
        while (view && view !== window) {
          const frame = view.frameElement;
          if (!frame) break;
          const rect = frame.getBoundingClientRect();
          x += rect.x + frame.clientLeft; y += rect.y + frame.clientTop;
          view = frame.ownerDocument.defaultView;
        }
      } catch { /* cross-origin parent */ }
      return { x, y };
    };
    const rectOf = element => {
      const rect = element.getBoundingClientRect();
      const offset = frameOffset(element);
      return { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height, right: rect.right + offset.x, bottom: rect.bottom + offset.y };
    };
    const shown = element => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const view = element.ownerDocument.defaultView || window;
      const style = view.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (Number(style.opacity || 1) < 0.05) return false;
      return true;
    };
    const byId = (element, id) => {
      const root = element.getRootNode ? element.getRootNode() : element.ownerDocument;
      return (root && root.getElementById ? root.getElementById(id) : null) || element.ownerDocument.getElementById(id);
    };
    const nameOf = element => {
      const own = clean(element.getAttribute('aria-label'));
      if (own) return own.slice(0, 120);
      const labelled = element.getAttribute('aria-labelledby');
      if (labelled) {
        const text = labelled.split(/\s+/).map(id => { const node = byId(element, id); return node ? clean(node.textContent) : ''; }).filter(Boolean).join(' ');
        if (text) return text.slice(0, 120);
      }
      const fallback = clean(element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder'));
      if (fallback) return fallback.slice(0, 120);
      if (element.labels && element.labels.length) {
        const text = clean(Array.from(element.labels).map(node => node.textContent).join(' '));
        if (text) return text.slice(0, 120);
      }
      const tag = element.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return clean(element.getAttribute('name') || element.getAttribute('id') || '').slice(0, 120);
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
        if (type === 'hidden') return 'generic';
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (element.isContentEditable === true) return 'textbox';
      return 'generic';
    };
    const ROW = 'tr,[role="row"],li,[role="listitem"],[role="option"],[role="treeitem"],[role="article"],article,fieldset,[role="group"]';
    const contextOf = (element, name) => {
      const row = closestComposed(parentOf(element), ROW);
      if (!row) return '';
      const text = clean(row.innerText || row.textContent || '');
      if (!text || text === name) return '';
      return text.slice(0, req.maxContext || 80);
    };
    const editableOf = element => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return element.isContentEditable === true || tag === 'textarea' || (tag === 'input' && req.uneditable.indexOf(type) < 0);
    };
    const isPassword = element => (element.getAttribute('type') || '').toLowerCase() === 'password';
    const valueOf = element => {
      if (isPassword(element)) return null;
      if (typeof element.value === 'string') return element.value;
      if (element.isContentEditable === true) return element.innerText || element.textContent || '';
      return null;
    };
    const refOf = element => {
      for (const [ref, entry] of registry.map) if (deref(entry) === element) return ref;
      return '';
    };
    const describe = element => {
      if (!element || element === document.body || element === document.documentElement) return null;
      const name = nameOf(element);
      const out = { ref: refOf(element), role: roleOf(element), tag: element.tagName.toLowerCase(), name, editable: editableOf(element) };
      const context = contextOf(element, name);
      if (context) out.context = context;
      return out;
    };
    const deepHit = (x, y) => {
      let doc = document; let offX = 0; let offY = 0;
      let hit = doc.elementFromPoint(x, y);
      for (let guard = 0; hit && guard < 20; guard++) {
        if (hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
          const inner = hit.shadowRoot.elementFromPoint(x - offX, y - offY);
          if (inner && inner !== hit) { hit = inner; continue; }
        }
        const tag = hit.tagName ? hit.tagName.toLowerCase() : '';
        if (tag === 'iframe' || tag === 'frame') {
          let inner = null;
          try { inner = hit.contentDocument; } catch { inner = null; }
          if (inner) {
            const rect = hit.getBoundingClientRect();
            offX += rect.x + hit.clientLeft; offY += rect.y + hit.clientTop;
            const next = inner.elementFromPoint(x - offX, y - offY);
            if (next) { doc = inner; hit = next; continue; }
          }
        }
        break;
      }
      return hit;
    };
    const deepActive = () => {
      let active = document.activeElement;
      for (let guard = 0; active && guard < 20; guard++) {
        if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
        const tag = active.tagName ? active.tagName.toLowerCase() : '';
        if (tag === 'iframe' || tag === 'frame') {
          let inner = null;
          try { inner = active.contentDocument; } catch { inner = null; }
          if (inner && inner.activeElement && inner.activeElement !== inner.body) { active = inner.activeElement; continue; }
        }
        break;
      }
      return active;
    };
    const scrollable = element => {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument.defaultView || window;
      const style = view.getComputedStyle(element);
      return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    };
    const pageScroller = () => document.scrollingElement || document.documentElement;
    const scrollerAt = (x, y) => {
      for (let current = deepHit(x, y); current; current = parentOf(current)) {
        if (current === document.body || current === document.documentElement) break;
        if (scrollable(current)) return current;
      }
      const root = pageScroller();
      if (root && root.scrollHeight > root.clientHeight + 1) return root;
      // The page itself does not scroll: a full-height app shell usually has one big inner scroller.
      let best = null; let bestArea = 0;
      for (const element of document.querySelectorAll('body *')) {
        if (!scrollable(element)) continue;
        const rect = element.getBoundingClientRect();
        const area = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
        if (area > bestArea) { best = element; bestArea = area; }
      }
      return best || root;
    };
    const scrollInfo = element => {
      const isPage = !element || element === pageScroller() || element === document.body || element === document.documentElement;
      const target = isPage ? pageScroller() : element;
      const info = {
        container: isPage ? 'window' : { tag: target.tagName.toLowerCase(), role: clean(target.getAttribute('role')), name: clean(target.getAttribute('aria-label') || (target.id ? '#' + target.id : '') || (target.className && typeof target.className === 'string' ? '.' + target.className.split(/\s+/)[0] : '')).slice(0, 80) },
        scrollTop: Math.round(isPage ? scrollY : target.scrollTop),
        scrollHeight: Math.round(target ? target.scrollHeight : 0),
        clientHeight: Math.round(isPage ? innerHeight : target.clientHeight),
      };
      if (!isPage && target.id) info.containerId = String(target.id).slice(0, 80);
      info.atTop = info.scrollTop <= 1;
      info.atBottom = info.scrollTop + info.clientHeight >= info.scrollHeight - 2;
      return info;
    };

    // ---- operations ----
    if (req.op === 'measure') return { width: innerWidth, height: innerHeight };

    if (req.op === 'snapshot') {
      registry.map = new Map();
      for (const stale of document.querySelectorAll('[data-harness-ref]')) stale.removeAttribute('data-harness-ref');
      const LIMIT = req.limit;
      const candidates = [];
      const seenDocs = new Set();
      const visit = (root, depth) => {
        if (depth > 6 || !root || seenDocs.has(root)) return;
        seenDocs.add(root);
        let all;
        try { all = root.querySelectorAll('*'); } catch { return; }
        for (const element of all) {
          if (element.shadowRoot) visit(element.shadowRoot, depth + 1);
          const tag = element.tagName.toLowerCase();
          if (tag === 'iframe' || tag === 'frame') {
            let inner = null;
            try { inner = element.contentDocument; } catch { inner = null; }
            if (inner && shown(element)) visit(inner, depth + 1);
            continue;
          }
          let match = false;
          try { match = element.matches(req.selector); } catch { match = false; }
          if (match) candidates.push(element);
        }
      };
      visit(document, 0);
      // Modal dialogs: the topmost open one is the user's (and the model's) focus.
      const modals = [];
      for (const element of candidates.concat(Array.from(document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]')))) {
        let isModal = false;
        try { isModal = element.matches('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]'); } catch { isModal = false; }
        if (isModal && shown(element) && modals.indexOf(element) < 0) modals.push(element);
      }
      // Prefer real modals, then the last (most recently opened / topmost) one.
      modals.sort((a, b) => Number(b.getAttribute('aria-modal') === 'true' || b.tagName === 'DIALOG') - Number(a.getAttribute('aria-modal') === 'true' || a.tagName === 'DIALOG'));
      const modal = modals.length ? modals[modals.length - 1 - 0] : null;
      const topModal = modals.find(item => item.getAttribute('aria-modal') === 'true' || item.tagName === 'DIALOG') || modal;
      const inView = rect => !(rect.bottom < -4 || rect.right < -4 || rect.y > innerHeight + 4 || rect.x > innerWidth + 4);
      const buckets = [[], [], []];
      let truncated = false;
      for (const element of candidates) {
        if (!shown(element)) continue;
        const role = roleOf(element);
        if (role === 'generic' && !element.hasAttribute('onclick') && element.isContentEditable !== true) continue;
        if (element === topModal) continue;
        const rect = rectOf(element);
        const visible = inView(rect);
        const inModal = Boolean(topModal && containsComposed(topModal, element));
        const bucket = inModal ? buckets[0] : visible ? buckets[1] : buckets[2];
        if (bucket.length < LIMIT) bucket.push({ element, rect, role, visible, inModal });
        else truncated = true;
      }
      const ordered = buckets[0].concat(buckets[1], buckets[2]);
      if (ordered.length > LIMIT) truncated = true;
      const elements = [];
      const seenNames = new Map();
      for (const { element, rect, role, visible, inModal } of ordered.slice(0, LIMIT)) {
        const ref = 'h' + (elements.length + 1);
        const name = nameOf(element);
        const context = contextOf(element, name);
        const editable = editableOf(element);
        registry.map.set(ref, { el: typeof WeakRef === 'function' ? new WeakRef(element) : element, role, name: editable ? '' : name, context });
        try { element.setAttribute('data-harness-ref', ref); } catch { /* read-only node */ }
        const item = {
          ref, role, tag: element.tagName.toLowerCase(), name,
          x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        };
        if (context) item.context = context;
        if (inModal) item.modal = true;
        if (element.ownerDocument !== document) item.frame = true;
        else if (element.getRootNode && element.getRootNode() !== document) item.shadow = true;
        if (!visible) item.inViewport = false;
        if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') item.disabled = true;
        if (role === 'checkbox' || role === 'radio') item.checked = element.checked === true;
        const type = clean(element.getAttribute('type')).toLowerCase();
        if (type) item.type = type.slice(0, 20);
        // A password field's contents are never part of a snapshot.
        if (type !== 'password' && typeof element.value === 'string' && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) item.value = element.value.slice(0, 120);
        if (element.tagName === 'SELECT') item.options = Array.from(element.options).slice(0, 40).map(option => ({ value: String(option.value).slice(0, 120), label: clean(option.textContent).slice(0, 120), selected: option.selected === true }));
        const key = role + '\u0000' + name;
        seenNames.set(key, (seenNames.get(key) || 0) + 1);
        item.nth = seenNames.get(key);
        elements.push(item);
      }
      // nth only matters when two elements share role and name (e.g. two "操作" buttons).
      const totals = new Map();
      for (const item of elements) { const key = item.role + '\u0000' + item.name; totals.set(key, (totals.get(key) || 0) + 1); }
      for (const item of elements) {
        const count = totals.get(item.role + '\u0000' + item.name);
        if (count > 1) item.duplicates = count; else delete item.nth;
      }
      const root = document.documentElement;
      const main = scrollInfo(scrollerAt(innerWidth / 2, innerHeight / 2));
      const result = {
        url: location.href,
        title: typeof document.title === 'string' ? document.title.slice(0, 300) : '',
        viewport: {
          width: innerWidth, height: innerHeight,
          scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
          scrollWidth: root ? root.scrollWidth : innerWidth, scrollHeight: root ? root.scrollHeight : innerHeight,
        },
        scroll: main,
        elements, truncated,
      };
      if (topModal) result.modal = { name: nameOf(topModal).slice(0, 120), elements: buckets[0].length };
      return result;
    }

    const entry = registry.map.get(req.ref);
    let element = deref(entry);
    // Fallback for pages snapshotted before this script version: the plain attribute.
    if (!entry && req.ref) element = document.querySelector('[data-harness-ref="' + req.ref + '"]');

    if (req.op === 'resolve') {
      if (!element || !element.isConnected) return { found: false };
      const name = nameOf(element);
      const role = roleOf(element);
      const context = contextOf(element, name);
      const editable = editableOf(element);
      const out = { found: true, role, name, context, editable };
      if (entry) {
        const changes = [];
        if (entry.role && entry.role !== role) changes.push('角色从“' + entry.role + '”变为“' + role + '”');
        if (entry.name && !editable && entry.name !== name) changes.push('名称从“' + entry.name.slice(0, 40) + '”变为“' + name.slice(0, 40) + '”');
        if (entry.context && entry.context !== context) changes.push('所在行从“' + entry.context.slice(0, 40) + '”变为“' + context.slice(0, 40) + '”');
        if (changes.length) out.changed = changes.join('；');
      }
      let rect = rectOf(element);
      out.scrolled = false;
      if (req.scroll !== false && (rect.y < 8 || rect.bottom > innerHeight - 8 || rect.x < 8 || rect.right > innerWidth - 8)) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        out.scrolled = true;
        rect = rectOf(element);
      }
      out.visible = shown(element);
      out.disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true';
      out.centerX = Math.round(rect.x + rect.width / 2); out.centerY = Math.round(rect.y + rect.height / 2);
      out.left = Math.round(rect.x); out.top = Math.round(rect.y); out.width = Math.round(rect.width); out.height = Math.round(rect.height);
      if (req.hitTest) {
        const hit = deepHit(out.centerX, out.centerY);
        const labelHit = hit && element.labels && Array.from(element.labels).some(label => containsComposed(label, hit));
        out.hit = Boolean(hit && (containsComposed(element, hit) || labelHit));
        if (!out.hit) out.covering = hit ? describe(hit) : null;
      }
      return out;
    }
    if (req.op === 'focus') {
      if (!element || !element.isConnected) return { focused: false };
      if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return { focused: false };
      element.focus({ preventScroll: true });
      const active = deepActive();
      return { focused: Boolean(active && (active === element || containsComposed(element, active))) };
    }
    if (req.op === 'active') {
      const active = deepActive();
      const described = describe(active);
      return { focused: described };
    }
    if (req.op === 'value') {
      if (!element || !element.isConnected) return { found: false };
      const value = valueOf(element);
      return { found: true, password: isPassword(element), value: value == null ? null : String(value).slice(0, 4000) };
    }
    if (req.op === 'scrollProbe') {
      const target = element && element.isConnected ? (scrollable(element) ? element : (() => { const r = rectOf(element); return scrollerAt(r.x + r.width / 2, r.y + r.height / 2); })()) : scrollerAt(req.x, req.y);
      registry.scrollTarget = target;
      return scrollInfo(target);
    }
    if (req.op === 'scrollRead') return scrollInfo(registry.scrollTarget && registry.scrollTarget.isConnected ? registry.scrollTarget : pageScroller());
    if (req.op === 'scrollJump') {
      const target = registry.scrollTarget && registry.scrollTarget.isConnected ? registry.scrollTarget : pageScroller();
      const isPage = target === pageScroller();
      const top = req.mode === 'top' ? 0 : target.scrollHeight;
      if (isPage) window.scrollTo({ top, left: scrollX, behavior: 'instant' });
      else target.scrollTo({ top, behavior: 'instant' });
      return scrollInfo(target);
    }
    return { error: 'unknown op' };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
}
/* eslint-enable no-undef */

const PAGE_SOURCE = harnessPage.toString();
const BASE = { selector: SELECTOR, uneditable: UNEDITABLE_INPUT, maxContext: MAX_CONTEXT, limit: MAX_SNAPSHOT_ELEMENTS };

/** Build one in-page script. Only JSON is interpolated. */
export function pageScript(op, extra = {}) {
  if (extra.ref !== undefined && !REF_PATTERN.test(extra.ref)) throw new Error('invalid ref');
  return `(${PAGE_SOURCE})(${JSON.stringify({ ...BASE, ...extra, op })})`;
}

export const SNAPSHOT_PAGE_SCRIPT = pageScript('snapshot');
export const MEASURE_PAGE_SCRIPT = pageScript('measure');
export const ACTIVE_ELEMENT_SCRIPT = pageScript('active');
export const SCROLL_POSITION_SCRIPT = pageScript('scrollRead');
export function resolveRefScript(ref, { hitTest = false, scroll = true } = {}) { return pageScript('resolve', { ref, hitTest, scroll }); }
export function focusRefScript(ref) { return pageScript('focus', { ref }); }
export function valueRefScript(ref) { return pageScript('value', { ref }); }
export function scrollProbeScript({ ref, x, y } = {}) { return pageScript('scrollProbe', ref ? { ref } : { x: x ?? 0, y: y ?? 0 }); }
export function scrollScript(mode) { return pageScript('scrollJump', { mode: mode === 'top' ? 'top' : 'bottom' }); }

const NAMED_KEYS = new Map(Object.entries({
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
}));
const MODIFIER_NAMES = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta' };

function fail(message, extra) {
  const error = new Error(message);
  if (extra) Object.assign(error, extra);
  throw error;
}

/** A ref must be one this app generated; nothing else is ever interpolated into a script. */
export function browserRef(value, label = 'ref') {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) fail(`${label} 必须是 browser_snapshot 返回的 ref，例如 h3。`);
  return value;
}

function finiteCoordinate(value, label) {
  if (!Number.isInteger(value) || Math.abs(value) > 100_000) fail(`${label} 必须是 -100000 到 100000 之间的整数。`);
  return value;
}

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
  if (!list || !list.length || list.length > MAX_PRESS_KEYS) fail(`按键必须是文本或不超过 ${MAX_PRESS_KEYS} 项的文本数组，例如 "Enter" 或 "Control+A"。要输入一串文字请用 text 参数。`);
  return list.map(combo => {
    if (typeof combo !== 'string' || !combo.trim() || combo.length > 40) fail('按键必须是长度不超过 40 的文本，例如 "Enter" 或 "Control+A"。');
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
    if (!key) fail(`无法识别按键：${raw.slice(0, 20)}。可使用单个字符、F1–F12，或 Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、Space；要输入一串文字（例如 cpa-origin）请改用 press 的 text 参数或 type。`);
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
  if (kind === 'press') {
    const text = input.text;
    if (text !== undefined && (typeof text !== 'string' || !text || text.length > MAX_ACTION_TEXT)) fail(`press 的 text 必须是长度 1 到 ${MAX_ACTION_TEXT} 的文本。`);
    if (text === undefined && input.keys === undefined) fail('press 需要 keys（按键）或 text（要输入的一串文字）。');
    return {
      kind, keys: input.keys === undefined ? [] : keysOf(input.keys),
      ...(text !== undefined ? { text } : {}),
      ref: input.ref === undefined ? undefined : browserRef(input.ref),
    };
  }
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

function describeTarget(value) {
  if (!value || typeof value !== 'object') return '另一个元素';
  const parts = [value.role, value.name ? `“${String(value.name).slice(0, 40)}”` : '', value.ref ? `(${value.ref})` : ''].filter(Boolean);
  return parts.join(' ') || value.tag || '另一个元素';
}

/** True when the typed text is what the field now holds. */
export function valueMatches(actual, text, replace) {
  if (typeof actual !== 'string') return null;
  const squash = value => value.replace(/\s+/g, ' ').trim();
  return replace ? squash(actual) === squash(text) : squash(actual).endsWith(squash(text));
}

/**
 * The native input sequence. Every dependency is injected so the ordering, the coordinate
 * scaling and the honest failure modes are testable without Electron.
 */
export function createBrowserInput({ evaluate, sendInput, insertText, measure, bounds, visible, delay }) {
  const area = visible && visible.width > 1 && visible.height > 1 ? visible : { x: 0, y: 0, width: bounds?.width ?? 0, height: bounds?.height ?? 0 };
  const usable = () => bounds && bounds.width > 1 && bounds.height > 1 && area.width > 1 && area.height > 1;
  let cached;

  async function ratio() {
    if (!usable()) fail('内置浏览器面板当前没有显示，无法像真实用户一样操作页面。', { code: 'panel-hidden' });
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

  function targetOf(resolved, ref) {
    const target = { role: resolved.role || '', name: resolved.name || '' };
    if (ref) target.ref = ref;
    if (resolved.context) target.context = resolved.context;
    return target;
  }

  async function resolveTarget(ref, { hitTest = false } = {}) {
    const value = await evaluate(resolveRefScript(ref, { hitTest }));
    if (!value || typeof value !== 'object') fail('无法在内置浏览器中确认这个元素的位置。');
    if (value.error) fail(message(value.error));
    if (value.found !== true) fail('页面已经变化，这个 ref 不再对应任何元素；请重新调用 browser_snapshot 获取新的 ref。');
    if (value.changed) fail(`ref ${ref} 对应的元素已经变了（${value.changed}），为避免点错行没有执行；请重新调用 browser_snapshot。`);
    if (value.visible !== true) fail('这个元素当前不可见，无法操作；请重新调用 browser_snapshot 查看页面现状。');
    return value;
  }

  /** Resolve, then confirm the point really lands on this element and not on a neighbour. */
  async function aimAt(ref, label) {
    const resolved = await resolveTarget(ref, { hitTest: true });
    if (resolved.disabled) fail(`${label}当前处于禁用状态，操作不会有任何效果。`);
    const position = await devicePoint(resolved.centerX, resolved.centerY);
    inside(position, label);
    if (resolved.hit === false) {
      fail(`${label}（${describeTarget(targetOf(resolved, ref))}）的中心被${describeTarget(resolved.covering)}遮住，点击会落到别的元素上，已取消；请先关闭遮挡的弹层或重新调用 browser_snapshot。`);
    }
    return { resolved, position };
  }

  async function resolvePoint(value, label) {
    if (value.ref !== undefined) {
      const { resolved, position } = await aimAt(value.ref, label);
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

  async function activeElement() {
    try {
      const value = await evaluate(ACTIVE_ELEMENT_SCRIPT);
      return value && typeof value === 'object' && value.focused && typeof value.focused === 'object' ? value.focused : null;
    } catch { return null; }
  }

  async function readValue(ref) {
    try {
      const value = await evaluate(valueRefScript(ref));
      return value && value.found === true ? value : null;
    } catch { return null; }
  }

  async function nativeClick(position, clickCount) {
    sendInput({ type: 'mouseMove', x: position.x, y: position.y });
    await delay(12);
    for (let count = 1; count <= clickCount; count++) {
      sendInput({ type: 'mouseDown', x: position.x, y: position.y, button: 'left', clickCount: count });
      await delay(24);
      sendInput({ type: 'mouseUp', x: position.x, y: position.y, button: 'left', clickCount: count });
      if (count < clickCount) await delay(24);
    }
  }

  async function click({ ref, clickCount }) {
    const { resolved: before, position } = await aimAt(ref, '这个元素');
    await nativeClick(position, clickCount);
    await delay(120);
    const after = await evaluate(resolveRefScript(ref, { scroll: false }));
    const moved = Boolean(after && after.found === true && (Math.abs((after.centerX ?? 0) - before.centerX) > 2 || Math.abs((after.centerY ?? 0) - before.centerY) > 2));
    return {
      action: 'click', ref, target: targetOf(before, ref), scrolled: before.scrolled === true,
      moved, stillPresent: Boolean(after && after.found === true), hitVerified: true,
      focusedElement: await activeElement(),
    };
  }

  async function type({ ref, text, submit, replace }) {
    const probe = await resolveTarget(ref);
    if (probe.disabled) fail('这个输入框当前处于禁用状态，无法输入。');
    if (probe.editable !== true) fail('这个元素不能输入文字；如果是按钮或链接，请改用 browser_act 的 click。');
    const { resolved: before, position } = await aimAt(ref, '这个输入框');
    await nativeClick(position, 1);
    await delay(60);
    if (replace) await pressKeys([{ key: 'A', modifiers: ['control'] }]);
    if (text) insertText(text);
    else if (replace) await pressKeys([{ key: 'Backspace', modifiers: [] }]);
    await delay(80);
    // Read back before submitting: after Enter the field may be cleared or replaced.
    const typed = await readValue(ref);
    if (submit) {
      await pressKeys([{ key: 'Return', modifiers: [] }]);
      await delay(200);
    }
    const after = await evaluate(resolveRefScript(ref, { scroll: false }));
    const result = {
      action: 'type', ref, target: targetOf(before, ref), characters: text.length,
      submitted: submit === true, replaced: replace === true, stillPresent: Boolean(after && after.found === true),
    };
    if (typed && typed.password) result.valueHidden = true;
    else if (typed && typeof typed.value === 'string') {
      result.valueAfter = typed.value.slice(0, 200);
      result.valueMatches = valueMatches(typed.value, text, replace);
    }
    return result;
  }

  async function press({ keys, text, ref }) {
    if (ref !== undefined) {
      const target = await resolvePoint({ ref }, '这个元素');
      if (target.resolved.disabled) fail('这个元素当前处于禁用状态，无法接收按键。');
      const focus = await evaluate(focusRefScript(ref));
      if (!focus || focus.focused !== true) fail(focus?.error ? message(focus.error) : '无法聚焦这个元素，未发送按键；请重新调用 browser_snapshot 确认目标。');
    }
    const focusedBefore = await activeElement();
    if (text !== undefined) {
      if (!focusedBefore || !focusedBefore.editable) fail('当前获得焦点的不是输入框，未输入文字；请带上输入框的 ref，或改用 type。');
      insertText(text);
      await delay(60);
    }
    await pressKeys(keys);
    await delay(160);
    const focusedElement = await activeElement();
    const result = { action: 'press', keys: keys.map(combo => combo.label), focused: Boolean(focusedElement), focusedElement };
    if (text !== undefined) result.characters = text.length;
    return result;
  }

  async function scroll({ direction, amount, ref }) {
    let anchor;
    let probeArgs;
    if (ref !== undefined) {
      const resolved = await resolveTarget(ref);
      anchor = await devicePoint(resolved.centerX, resolved.centerY);
      probeArgs = { ref };
    } else {
      anchor = { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) };
      const { scale } = await ratio();
      probeArgs = { x: Math.round(anchor.x / scale), y: Math.round(anchor.y / scale) };
    }
    const before = await evaluate(scrollProbeScript(probeArgs));
    if (!before || typeof before !== 'object') fail('无法确定要滚动的区域。');
    if (before.error) fail(message(before.error));
    let after;
    if (direction === 'top' || direction === 'bottom') {
      after = await evaluate(scrollScript(direction));
    } else {
      inside(anchor, '滚动位置');
      const delta = direction === 'up' ? -amount : amount;
      sendInput({ type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY: delta, wheelTicksX: 0, wheelTicksY: delta / 100, canScroll: true, hasPreciseScrollingDeltas: true });
      await delay(220);
      after = await evaluate(SCROLL_POSITION_SCRIPT);
    }
    if (!after || typeof after !== 'object' || after.error) fail(after?.error ? message(after.error) : '无法读取滚动后的位置。');
    return {
      action: 'scroll', direction, ...(direction === 'up' || direction === 'down' ? { amount } : {}),
      scrollY: after.scrollTop, scrollHeight: after.scrollHeight, scrollBefore: before.scrollTop,
      scrolledBy: after.scrollTop - before.scrollTop,
      scrollContainer: after.container === 'window' ? 'window' : describeTarget(after.container),
      atTop: after.atTop === true, atBottom: after.atBottom === true,
    };
  }

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

  return { click, type, press, scroll, drag, ready: async () => { await ratio(); } };
}
