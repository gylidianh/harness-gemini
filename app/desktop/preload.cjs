const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Only named, validated desktop capabilities reach the app's sandboxed renderer.
const OPEN_SESSION_CHANNEL = 'harness:open-completed-session';
const BROWSER_COMMAND_CHANNEL = 'harness:browser-command';
const BROWSER_STATE_CHANNEL = 'harness:browser-state';
const COPY_IMAGE_CHANNEL = 'harness:copy-image';
const REVEAL_API_KEY_CHANNEL = 'harness:reveal-api-key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const subscribers = new Set();
let pendingSessionId;
const browserSubscribers = new Set();
let lastBrowserState;

function browserTabs(payload) {
  if (!Array.isArray(payload.tabs) || payload.tabs.length > 32) return null;
  const ids = new Set();
  const tabs = [];
  for (const tab of payload.tabs) {
    if (!tab || typeof tab.id !== 'string' || !UUID.test(tab.id) || ids.has(tab.id)
      || typeof tab.url !== 'string' || tab.url.length > 4_096 || typeof tab.title !== 'string' || tab.title.length > 512
      || typeof tab.loading !== 'boolean' || !(tab.error === null || (typeof tab.error === 'string' && tab.error.length <= 512))) return null;
    ids.add(tab.id);
    tabs.push(Object.freeze({ id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, error: tab.error }));
  }
  if (tabs.length ? !ids.has(payload.activeTabId) : payload.activeTabId !== null) return null;
  return Object.freeze(tabs);
}

function browserState(payload) {
  if (!payload || typeof payload.url !== 'string' || payload.url.length > 4_096
    || typeof payload.title !== 'string' || payload.title.length > 512
    || !['loading', 'canGoBack', 'canGoForward'].every(key => typeof payload[key] === 'boolean')
    || !(payload.error === null || (typeof payload.error === 'string' && payload.error.length <= 512))
    || !Number.isSafeInteger(payload.openRequested) || payload.openRequested < 0
    || typeof payload.desktopZoomFactor !== 'number' || !Number.isFinite(payload.desktopZoomFactor) || payload.desktopZoomFactor <= 0
    || !['normal', 'responsive'].includes(payload.presentation?.mode)
    || !['fit', '50', '75', '100', '125', '150', '200'].includes(payload.presentation?.zoom)
    || !Number.isInteger(payload.presentation?.viewport?.width) || payload.presentation.viewport.width < 320 || payload.presentation.viewport.width > 3840
    || !Number.isInteger(payload.presentation?.viewport?.height) || payload.presentation.viewport.height < 320 || payload.presentation.viewport.height > 2160) return null;
  const tabs = browserTabs(payload);
  if (!tabs) return null;
  return Object.freeze({
    url: payload.url, title: payload.title, loading: payload.loading,
    canGoBack: payload.canGoBack, canGoForward: payload.canGoForward,
    error: payload.error, openRequested: payload.openRequested,
    desktopZoomFactor: payload.desktopZoomFactor,
    presentation: Object.freeze({ mode: payload.presentation.mode, zoom: payload.presentation.zoom, viewport: Object.freeze({ width: payload.presentation.viewport.width, height: payload.presentation.viewport.height }) }),
    tabs, activeTabId: payload.activeTabId,
  });
}

function browserCommand(command, ...args) {
  return ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, command, ...args).then(payload => {
    const state = browserState(payload);
    if (!state) throw new Error('浏览器暂时不可用。');
    return state;
  });
}

/** The rendered page the model asked for: plain text and links, never markup. */
function pageContent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.url !== 'string' || payload.url.length > 4_096) return null;
  if (typeof payload.title !== 'string' || payload.title.length > 512) return null;
  if (typeof payload.text !== 'string' || payload.text.length > 200_000) return null;
  if (typeof payload.truncated !== 'boolean') return null;
  if (!(payload.error === null || (typeof payload.error === 'string' && payload.error.length <= 512))) return null;
  if (!Array.isArray(payload.links) || payload.links.length > 20) return null;
  for (const link of payload.links) {
    if (!link || typeof link.text !== 'string' || link.text.length > 200 || typeof link.url !== 'string' || link.url.length > 4_096) return null;
  }
  return Object.freeze({
    url: payload.url, title: payload.title, text: payload.text, truncated: payload.truncated, error: payload.error,
    links: Object.freeze(payload.links.map(link => Object.freeze({ text: link.text, url: link.url }))),
  });
}

/** A captured page image, bounded before it is handed to the renderer. */
function screenshotResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.ok !== 'boolean') return null;
  if (!payload.ok) return Object.freeze({ ok: false, error: typeof payload.error === 'string' ? payload.error.slice(0, 500) : '内置浏览器未能完成截屏。' });
  const result = payload.result;
  if (!result || typeof result !== 'object') return null;
  if (typeof result.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image)) return null;
  if (result.image.length > 8 * 1024 * 1024) return null;
  return Object.freeze({
    ok: true,
    result: Object.freeze({
      url: typeof result.url === 'string' ? result.url.slice(0, 4_096) : '',
      title: typeof result.title === 'string' ? result.title.slice(0, 512) : '',
      image: result.image,
      width: Number.isInteger(result.width) ? result.width : 0,
      height: Number.isInteger(result.height) ? result.height : 0,
      bytes: Number.isInteger(result.bytes) ? result.bytes : 0,
      mime: 'image/png',
      fullPage: result.fullPage === true,
    }),
  });
}

/** The interactive surface the model acts on: refs, roles, names, rectangles. */
/** 1.4.1-browserfix: bounded plain-data copy for the new optional fields. */
function jsonCopy(value) {
  try {
    const text = JSON.stringify(value);
    return text && text.length <= 20_000 ? JSON.parse(text) : null;
  } catch { return null; }
}

function snapshotResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.url !== 'string' || payload.url.length > 4_096) return null;
  if (typeof payload.title !== 'string' || payload.title.length > 512) return null;
  if (typeof payload.truncated !== 'boolean') return null;
  if (!(payload.error === null || (typeof payload.error === 'string' && payload.error.length <= 512))) return null;
  if (!Array.isArray(payload.elements) || payload.elements.length > 120) return null;
  const viewport = payload.viewport;
  if (!viewport || typeof viewport !== 'object') return null;
  if (!['width', 'height', 'scrollX', 'scrollY', 'scrollWidth', 'scrollHeight'].every(key => Number.isInteger(viewport[key]) && Math.abs(viewport[key]) <= 10_000_000)) return null;
  const elements = [];
  for (const element of payload.elements) {
    if (!element || typeof element !== 'object') return null;
    if (typeof element.ref !== 'string' || !/^h[1-9][0-9]{0,3}$/.test(element.ref)) return null;
    if (typeof element.role !== 'string' || element.role.length > 40 || typeof element.tag !== 'string' || element.tag.length > 20 || typeof element.name !== 'string' || element.name.length > 120) return null;
    if (!['x', 'y', 'width', 'height'].every(key => Number.isInteger(element[key]) && Math.abs(element[key]) <= 200_000)) return null;
    elements.push(Object.freeze({
      ...(typeof element.context === 'string' && element.context ? { context: element.context.slice(0, 80) } : {}),
      ...(element.modal === true ? { modal: true } : {}),
      ...(element.frame === true ? { frame: true } : {}),
      ...(element.shadow === true ? { shadow: true } : {}),
      ...(element.inViewport === false ? { inViewport: false } : {}),
      ...(Number.isInteger(element.nth) ? { nth: element.nth } : {}),
      ...(Number.isInteger(element.duplicates) ? { duplicates: element.duplicates } : {}),
      ref: element.ref, role: element.role, tag: element.tag, name: element.name,
      x: element.x, y: element.y, width: element.width, height: element.height,
      disabled: element.disabled === true, checked: element.checked === true,
      type: typeof element.type === 'string' ? element.type.slice(0, 20) : '',
      value: typeof element.value === 'string' ? element.value.slice(0, 120) : '',
      options: Array.isArray(element.options) ? Object.freeze(element.options.slice(0, 40).map(option => Object.freeze({
        value: typeof option?.value === 'string' ? option.value.slice(0, 120) : '',
        label: typeof option?.label === 'string' ? option.label.slice(0, 120) : '',
        selected: option?.selected === true,
      }))) : Object.freeze([]),
    }));
  }
  return Object.freeze({
    extra: jsonCopy({ scroll: payload.scroll ?? null, modal: payload.modal ?? null, pendingInputs: payload.pendingInputs ?? [], visible: payload.visible === true, hiddenReason: typeof payload.hiddenReason === 'string' ? payload.hiddenReason.slice(0, 200) : '' }),
    url: payload.url, title: payload.title, truncated: payload.truncated, error: payload.error,
    viewport: Object.freeze({ width: viewport.width, height: viewport.height, scrollX: viewport.scrollX, scrollY: viewport.scrollY, scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight }),
    elements: Object.freeze(elements),
  });
}

// ---------------------------------------------------------------- 1.2.7-titlebar
// The native menus share the top row with the existing React conversation header. Keep the
// header in React so its title, model, status and buttons retain their normal event handlers.
// Menu and caption-button clearances are measured in page coordinates, including page zoom.
const TITLE_BAR_INFO_CHANNEL = 'harness:titlebar-info';
const TITLE_BAR_MENU_CHANNEL = 'harness:titlebar-menu';
const TITLE_BAR_COLORS_CHANNEL = 'harness:titlebar-colors';
// 1.2.8-titlebar: window focus and the keyboard shortcuts for the drawn menus come from the
// main process, the only place that knows when the window itself stops being the active one.
const TITLE_BAR_FOCUS_CHANNEL = 'harness:titlebar-focus';
const TITLE_BAR_KEYS_CHANNEL = 'harness:titlebar-keys';
const TITLE_BAR_FALLBACK_HEIGHT = 36;

function titleBarCss(height) {
  return `
:root{--hg-tb-height:${height}px;--hg-tb-inverse-zoom:1;--hg-titlebar-background:var(--sidebar,#f8f9fa)}
/* The noir sidebar has a vertical gradient; continue its upper edge across the caption. */
html[data-skin=luxe-noir]{--hg-titlebar-background:#14130f}
#hg-titlebar{position:fixed;top:0;left:0;width:max-content;max-width:calc(100% - 138px);height:${height}px;zoom:var(--hg-tb-inverse-zoom);box-sizing:border-box;display:flex;align-items:center;gap:2px;margin:0;padding:0 6px;background:var(--hg-titlebar-background);color:var(--text,#202124);border-bottom:1px solid var(--line,#e8eaed);font:13px/1 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;-webkit-user-select:none;user-select:none;-webkit-app-region:drag;app-region:drag;z-index:2147483000;overflow:hidden;white-space:nowrap}
#hg-titlebar .hg-tb-menus{display:flex;align-items:center;gap:2px;flex:none}
#hg-titlebar .hg-tb-menu{-webkit-app-region:no-drag;app-region:no-drag;height:26px;padding:0 8px;margin:0;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:default;outline:none}
#hg-titlebar .hg-tb-menu:hover,#hg-titlebar .hg-tb-menu.hg-tb-open{background:color-mix(in srgb,currentColor 10%,transparent)}
#hg-titlebar .hg-tb-menu:focus-visible{box-shadow:0 0 0 2px var(--accent,#1a73e8)}
#hg-titlebar.hg-tb-inactive .hg-tb-menu{opacity:.55}
:root{--hg-top-inset:calc(var(--hg-tb-height) * var(--hg-tb-inverse-zoom));--hg-chat-left-padding:16px;--hg-chat-right-padding:150px}
#root{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:auto!important;height:auto!important;contain:layout paint!important}
.app-shell{height:100%!important}
.app-shell>.sidebar,.app-shell>.right-panel{padding-top:var(--hg-top-inset)!important}
.app-shell>.right-panel::before{content:"";position:absolute;top:0;left:0;right:0;height:var(--hg-top-inset);background:var(--hg-titlebar-background);border-bottom:1px solid var(--line,#e8eaed);-webkit-app-region:drag;app-region:drag}
.app-shell.panel-overlay>.right-panel{top:var(--hg-top-inset)!important;padding-top:0!important}
.app-shell.panel-overlay>.right-panel::before{display:none}
.main-panel>.chat-header{height:var(--hg-top-inset)!important;min-height:var(--hg-top-inset)!important;flex:0 0 var(--hg-top-inset);padding:0 var(--hg-chat-right-padding) 0 var(--hg-chat-left-padding)!important;gap:12px!important;background:var(--hg-titlebar-background)!important;-webkit-app-region:drag;app-region:drag;overflow:hidden}
.chat-header button,.chat-header input,.chat-header select,.chat-header a,.chat-header .header-model{-webkit-app-region:no-drag;app-region:no-drag}
.chat-header .chat-heading{flex:1;min-width:0;gap:6px}
.chat-header .chat-heading>div{display:flex;align-items:center;gap:8px;min-width:0}
.chat-header .chat-heading h1{max-width:none;font-size:14px;line-height:1.3}
.chat-header .chat-heading>div>span{margin-top:0;font-size:10px;white-space:nowrap;flex-shrink:0}
.chat-header>.chat-header-actions{flex:none;gap:4px}
.chat-header .icon-button{width:min(30px,calc(var(--hg-top-inset) - 4px));height:min(30px,calc(var(--hg-top-inset) - 4px))}
.chat-header .icon-button svg{max-width:80%;max-height:80%}
.chat-header .header-model{height:min(28px,calc(var(--hg-top-inset) - 6px));max-width:clamp(80px,16vw,180px);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.modal-backdrop,.image-modal-backdrop,.settings-drawer,.sidebar-mobile-shade,.right-mobile-shade{top:var(--hg-top-inset)!important}
`;
}

function cssHex(value) {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(String(value).trim());
  if (!match) return null;
  if (match[4] !== undefined && parseFloat(match[4]) === 0) return null;
  return '#' + match.slice(1, 4).map(part => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0')).join('');
}

function installTitleBar() {
  let height = TITLE_BAR_FALLBACK_HEIGHT;
  let bar;
  let menus;
  let openMenu = false;
  let lastColors = '';
  let lastFocus;
  let altWithPointer = false;
  let layoutFrame = 0;
  let zoomTimer;
  let observedMain;
  let layoutObserver;
  try { webFrame.insertCSS(titleBarCss(height)); } catch { return; }

  const syncLayout = () => {
    layoutFrame = 0;
    const main = document.querySelector('.main-panel');
    if (!bar || !main) return;
    if (observedMain !== main) {
      if (observedMain) layoutObserver?.unobserve(observedMain);
      observedMain = main;
      layoutObserver?.observe(main);
    }
    const zoom = webFrame.getZoomFactor() || 1;
    document.documentElement.style.setProperty('--hg-tb-inverse-zoom', String(1 / zoom));
    const rect = main.getBoundingClientRect();
    const menuRight = bar.getBoundingClientRect().right;
    // Windows caption buttons occupy three 46-DIP slots. Overlay API rectangles are
    // unzoomed DIPs in Electron; DOM rectangles here are page CSS pixels.
    const captionLeft = window.innerWidth - 138 / zoom;
    document.documentElement.style.setProperty('--hg-chat-left-padding', `${Math.max(16, Math.ceil(menuRight - rect.left + 12))}px`);
    document.documentElement.style.setProperty('--hg-chat-right-padding', `${Math.max(12, Math.ceil(rect.right - captionLeft + 12))}px`);
  };
  const scheduleLayout = () => {
    // A background/hidden window can suspend animation frames even with Electron's
    // background throttling disabled. Layout must also settle before its first show.
    if (!layoutFrame) layoutFrame = setTimeout(syncLayout, 0);
  };
  const syncZoom = () => {
    const zoom = webFrame.getZoomFactor() || 1;
    document.documentElement.style.setProperty('--hg-tb-inverse-zoom', String(1 / zoom));
    scheduleLayout();
    // Resize can precede Chromium committing its new page zoom, especially in a hidden
    // window. Reconcile once after that commit as well as through ResizeObserver.
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(scheduleLayout, 80);
  };
  const syncColors = () => {
    if (!bar) return;
    const style = getComputedStyle(bar);
    const color = cssHex(style.backgroundColor) ?? cssHex(getComputedStyle(document.documentElement).backgroundColor) ?? '#ffffff';
    const symbolColor = cssHex(style.color) ?? '#202124';
    const key = color + symbolColor;
    if (key === lastColors) return;
    lastColors = key;
    ipcRenderer.send(TITLE_BAR_COLORS_CHANNEL, { color, symbolColor });
  };
  const popup = async (index, button) => {
    if (openMenu) return;
    openMenu = true;
    button.classList.add('hg-tb-open');
    const rect = button.getBoundingClientRect();
    try { await ipcRenderer.invoke(TITLE_BAR_MENU_CHANNEL, index, rect.left, rect.bottom); } catch { /* The menu is optional. */ }
    finally { button.classList.remove('hg-tb-open'); openMenu = false; }
  };
  /**
   * 1.2.8-titlebar-keys: the native menu bar is hidden, so the row has to be usable without a
   * mouse. Alt (tapped on its own), F10 and Alt+letter arrive from the main process; the arrow
   * keys, Home, End, Enter, Space, Escape and Tab are handled here. Opening a menu uses the same
   * native popup a click uses, so the accelerators inside it keep working.
   */
  const menuButtons = () => [...(menus?.querySelectorAll('.hg-tb-menu') ?? [])];
  const focusMenu = index => {
    const buttons = menuButtons();
    if (!buttons.length) return;
    const target = Math.min(Math.max(index, 0), buttons.length - 1);
    if (!bar || !bar.contains(document.activeElement)) lastFocus = document.activeElement;
    buttons.forEach((button, position) => { button.tabIndex = position === target ? 0 : -1; });
    buttons[target].focus();
  };
  const leaveBar = () => {
    const candidate = lastFocus && lastFocus !== document.body && lastFocus !== document.documentElement && document.contains(lastFocus) ? lastFocus : null;
    const previous = candidate && typeof candidate.focus === 'function' ? candidate : null;
    lastFocus = null;
    menuButtons().forEach((button, position) => { button.tabIndex = position === 0 ? 0 : -1; });
    if (previous && !bar?.contains(previous) && typeof previous.focus === 'function') previous.focus();
    else if (document.activeElement && bar?.contains(document.activeElement)) document.activeElement.blur();
  };
  const stepMenu = (position, delta) => {
    const count = menuButtons().length;
    if (count) focusMenu((position + delta + count) % count);
  };
  // 1.3.0: a menu opened from the keyboard acts where the user was working, exactly like one
  // opened with the mouse (whose mousedown never moves focus). Focus goes back to that element
  // before the native menu opens, so 编辑 › 全选/粘贴/撤销 reach the input, not the menu button.
  const openMenuAt = (index, button) => {
    leaveBar();
    void popup(index, button);
  };
  const menuKey = (event, index, button) => {
    const buttons = menuButtons();
    const position = Math.max(0, buttons.indexOf(button));
    if (event.key === 'ArrowRight') { event.preventDefault(); stepMenu(position, 1); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); stepMenu(position, -1); return; }
    if (event.key === 'Home') { event.preventDefault(); focusMenu(0); return; }
    if (event.key === 'End') { event.preventDefault(); focusMenu(buttons.length - 1); return; }
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenuAt(index, button); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); leaveBar(); return; }
    if (event.key === 'Tab') leaveBar();
  };
  const fill = info => {
    if (!info || !Array.isArray(info.menus)) return;
    menus.replaceChildren(...info.menus.slice(0, 12).map((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hg-tb-menu';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu');
      button.textContent = String(label).slice(0, 20);
      // Roving tabindex: one stop for Tab, the arrow keys move between the menus.
      button.tabIndex = index === 0 ? 0 : -1;
      button.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
      button.addEventListener('click', () => { void popup(index, button); });
      button.addEventListener('keydown', event => menuKey(event, index, button));
      return button;
    }));
    scheduleLayout();
  };
  const build = () => {
    if (document.getElementById('hg-titlebar') || !document.body) return;
    bar = document.createElement('div');
    bar.id = 'hg-titlebar';
    menus = document.createElement('div');
    menus.className = 'hg-tb-menus';
    menus.setAttribute('role', 'menubar');
    bar.append(menus);
    document.body.prepend(bar);
    layoutObserver = new ResizeObserver(scheduleLayout);
    layoutObserver.observe(bar);
    const root = document.getElementById('root');
    if (root) new MutationObserver(scheduleLayout).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    navigator.windowControlsOverlay?.addEventListener('geometrychange', scheduleLayout);
    syncZoom();
    syncColors();
    // Skins change html[data-skin] and its inline colours; the native buttons follow them.
    new MutationObserver(() => requestAnimationFrame(syncColors)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'style', 'class'] });
    window.addEventListener('resize', syncZoom);
    // 1.3.0: Escape that leaves the row belongs to the row. Registered by the preload, so it runs
    // before any listener of the page: an open settings drawer or side panel is not closed by it.
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !bar || !bar.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      leaveBar();
    }, true);
    // 1.3.0: Alt held for a click or wheel is a modifier, not a request for the menu row. The main
    // process sees no mouse input, so the page drops that Alt release itself.
    window.addEventListener('keydown', event => { if (event.key === 'Alt' && !event.repeat) altWithPointer = false; }, true);
    for (const type of ['mousedown', 'pointerdown', 'wheel']) {
      window.addEventListener(type, event => { if (event.altKey) altWithPointer = true; }, { capture: true, passive: true });
    }
    // 1.2.8-titlebar-focus: dimming follows the window, not the page. A page blur also fires when
    // focus moves into the embedded browser, which used to grey the bar out during normal use.
    ipcRenderer.on(TITLE_BAR_FOCUS_CHANNEL, (_event, focused) => { if (bar) bar.classList.toggle('hg-tb-inactive', focused === false); });
    ipcRenderer.on(TITLE_BAR_KEYS_CHANNEL, (_event, action) => {
      if (!bar || !action || !Number.isInteger(action.index)) return;
      if (action.source === 'alt' && altWithPointer) { altWithPointer = false; return; }
      const buttons = menuButtons();
      if (!buttons.length) return;
      const index = Math.min(Math.max(action.index, 0), buttons.length - 1);
      if (action.open) { focusMenu(index); openMenuAt(index, buttons[index]); return; }
      if (action.toggle) { if (bar.contains(document.activeElement)) leaveBar(); else focusMenu(index); }
    });
    ipcRenderer.invoke(TITLE_BAR_INFO_CHANNEL).then(info => {
      fill(info);
      if (bar && info) bar.classList.toggle('hg-tb-inactive', info.focused === false);
    }).catch(() => {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
  else build();
}

if (process.platform !== 'darwin') installTitleBar();

ipcRenderer.on(BROWSER_STATE_CHANNEL, (_event, payload) => {
  const state = browserState(payload);
  if (!state) return;
  lastBrowserState = state;
  for (const callback of browserSubscribers) {
    try { callback(state); } catch { /* A UI callback must not break the bridge. */ }
  }
});

ipcRenderer.on(OPEN_SESSION_CHANNEL, (_event, payload) => {
  if (typeof payload?.sessionId !== 'string' || !UUID.test(payload.sessionId)) return;
  const sessionId = payload.sessionId.toLowerCase();
  if (!subscribers.size) { pendingSessionId = sessionId; return; }
  for (const callback of subscribers) {
    try { callback(sessionId); } catch { /* A UI callback must not break the bridge. */ }
  }
});

const BROWSER_DOWNLOADS_CHANNEL = 'harness:browser-downloads';
const BROWSER_DOWNLOAD_COMMAND_CHANNEL = 'harness:browser-download-command';
const downloadSubscribers = new Set();

// ---- 1.4.4: download progress panel ----------------------------------------
// The built-in browser's page area is a native view that paints above the page,
// so this panel is anchored just OUTSIDE the page canvas (to its left) where it
// cannot be covered. It is built here rather than in the bundled UI so a small
// patch stays readable.
const DOWNLOAD_PANEL_ID = 'hg-downloads';
let downloadPanel;
let lastDownloads = null;

function downloadBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function downloadSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed <= 0) return '';
  return `${downloadBytes(speed)}/s`;
}

function downloadStateText(record) {
  if (record.state === 'completed') return '已完成';
  if (record.state === 'cancelled') return '已取消';
  if (record.state === 'interrupted') return '已中断';
  return '';
}

function ensureDownloadPanel() {
  if (downloadPanel && downloadPanel.isConnected) return downloadPanel;
  if (!document.body) return null;
  const root = document.createElement('section');
  root.id = DOWNLOAD_PANEL_ID;
  root.className = 'hg-dl';
  root.setAttribute('aria-label', '下载');
  root.hidden = true;
  const style = document.createElement('style');
  style.textContent = [
    '#hg-downloads{position:fixed;z-index:2147483000;width:320px;max-width:calc(100vw - 32px);box-sizing:border-box;display:flex;flex-direction:column;',
    'background:var(--surface-raised,#ffffff);color:var(--text,#202124);border:1px solid var(--line-strong,rgba(0,0,0,.16));border-radius:12px;',
    'box-shadow:var(--shadow-4,0 12px 32px rgba(0,0,0,.18));font:12px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden;color-scheme:inherit}',
    '#hg-downloads[hidden]{display:none}',
    '#hg-downloads .hg-dl-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line,rgba(0,0,0,.1));font-weight:600;color:var(--text,#202124);flex:none}',
    '#hg-downloads .hg-dl-head .hg-dl-count{font-weight:500;color:var(--muted,#5f6368)}',
    '#hg-downloads .hg-dl-head .hg-dl-spacer{flex:1}',
    '#hg-downloads .hg-dl-head button{border:0;background:transparent;color:var(--accent,#1a73e8);cursor:pointer;font:inherit;font-weight:500;padding:2px 6px;border-radius:6px}',
    '#hg-downloads .hg-dl-head button:hover{background:var(--hover-strong,rgba(127,127,127,.14))}',
    '#hg-downloads .hg-dl-list{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:0;list-style:none}',
    '#hg-downloads .hg-dl-item{padding:8px 10px;border-top:1px solid var(--line,rgba(0,0,0,.07))}',
    '#hg-downloads .hg-dl-item:first-child{border-top:0}',
    '#hg-downloads .hg-dl-name{font-weight:600;color:var(--text,#202124);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#hg-downloads .hg-dl-bar{position:relative;height:4px;margin:6px 0 4px;border-radius:2px;background:var(--hover-strong,rgba(127,127,127,.22));overflow:hidden}',
    '#hg-downloads .hg-dl-bar i{position:absolute;inset:0 auto 0 0;background:var(--accent,#1a73e8);border-radius:2px;transition:width .2s linear}',
    '#hg-downloads .hg-dl-bar.done i{background:var(--green,#188038)}',
    '#hg-downloads .hg-dl-bar.indeterminate i{width:35%!important;animation:hg-dl-slide 1.1s ease-in-out infinite}',
    '@keyframes hg-dl-slide{0%{left:-35%}100%{left:100%}}',
    '#hg-downloads .hg-dl-meta{color:var(--muted,#5f6368);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#hg-downloads .hg-dl-err{color:var(--red,#d93025);margin-top:2px}',
    '#hg-downloads .hg-dl-actions{display:flex;gap:6px;margin-top:6px}',
    '#hg-downloads .hg-dl-actions button{border:1px solid var(--line-strong,rgba(0,0,0,.16));background:var(--surface,transparent);color:var(--text,#202124);',
    'border-radius:7px;padding:3px 10px;font:inherit;cursor:pointer}',
    '#hg-downloads .hg-dl-actions button:hover{background:var(--accent-tonal,rgba(127,127,127,.14));border-color:var(--accent,#1a73e8)}',
    '#hg-downloads .hg-dl-notice{padding:6px 10px;background:var(--red-tonal,rgba(221,51,51,.1));color:var(--red,#c22);border-top:1px solid var(--danger-border,rgba(221,51,51,.2));flex:none}',
  ].join('');
  root.append(style);
  document.body.appendChild(root);
  downloadPanel = root;
  root.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-dl-action]') : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.dlAction;
    const id = button.dataset.dlId || '';
    if (action === 'hide') { root.hidden = true; return; }
    if (!['clear', 'cancel', 'reveal'].includes(action)) return;
    button.disabled = true;
    ipcRenderer.invoke(BROWSER_DOWNLOAD_COMMAND_CHANNEL, action, id.slice(0, 32))
      .then(result => { if (result && result.ok === false) showDownloadNotice(result.error || '操作没有完成。'); })
      .catch(() => showDownloadNotice('操作没有完成，请重试。'))
      .finally(() => { button.disabled = false; });
  });
  return root;
}

function showDownloadNotice(message) {
  const root = ensureDownloadPanel();
  if (!root) return;
  root.hidden = false;
  const notice = document.createElement('div');
  notice.className = 'hg-dl-notice';
  notice.textContent = String(message || '').slice(0, 200);
  root.appendChild(notice);
  setTimeout(() => { notice.remove(); }, 6_000);
  placeDownloadPanel();
}
function placeDownloadPanel() {
  const root = ensureDownloadPanel();
  if (!root || root.hidden) return;
  const canvas = document.querySelector('#browser-panel .browser-canvas');
  const rect = canvas?.getBoundingClientRect();
  const width = window.innerWidth || 1_200;
  if (rect && rect.width > 80 && rect.height > 80) {
    root.style.left = 'auto';
    root.style.right = `${Math.max(12, Math.round(width - rect.left + 12))}px`;
    root.style.top = `${Math.max(56, Math.round(rect.top))}px`;
    root.style.maxHeight = `${Math.max(160, Math.round(rect.height - 24))}px`;
  } else {
    root.style.left = 'auto';
    root.style.right = '16px';
    root.style.top = '72px';
    root.style.maxHeight = '60vh';
  }
}

function renderDownloads(payload) {
  const list = Array.isArray(payload?.downloads) ? payload.downloads : [];
  const root = ensureDownloadPanel();
  if (!root) return;
  const active = list.filter(record => record.state === 'progressing');
  if (!list.length && !payload?.notice) { root.hidden = true; return; }
  root.hidden = false;
  const head = root.querySelector('.hg-dl-head') || root.appendChild(Object.assign(document.createElement('div'), { className: 'hg-dl-head' }));
  const activeCount = active.length;
  head.textContent = '';
  const title = document.createElement('span');
  title.textContent = activeCount ? `正在下载 ${activeCount} 项` : '下载';
  const count = document.createElement('span');
  count.className = 'hg-dl-count';
  count.textContent = list.length > activeCount ? `共 ${list.length} 项` : '';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.dataset.dlAction = 'clear';
  clear.textContent = '清除已完成';
  clear.hidden = list.length <= activeCount;
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.dataset.dlAction = 'hide';
  hide.textContent = '收起';
  const spacer = document.createElement('span');
  spacer.className = 'hg-dl-spacer';
  head.append(title, count, spacer, clear, hide);
  let body = root.querySelector('.hg-dl-list');
  if (!body) { body = document.createElement('ul'); body.className = 'hg-dl-list'; root.appendChild(body); }
  body.textContent = '';
  for (const record of list.slice().reverse()) {
    const item = document.createElement('li');
    item.className = 'hg-dl-item';
    const name = document.createElement('div');
    name.className = 'hg-dl-name';
    name.textContent = record.name || '下载文件';
    name.title = record.savePath || record.url || '';
    const bar = document.createElement('div');
    bar.className = 'hg-dl-bar';
    const fill = document.createElement('i');
    const total = Number(record.total) || 0;
    const received = Number(record.received) || 0;
    if (record.state === 'progressing' && !total) bar.classList.add('indeterminate');
    fill.style.width = total > 0 ? `${Math.min(100, Math.max(0, (received / total) * 100))}%` : '0%';
    if (record.state === 'completed') { fill.style.width = '100%'; bar.classList.add('done'); }
    if (record.state === 'cancelled' || record.state === 'interrupted') fill.style.background = 'rgba(127,127,127,.5)';
    bar.append(fill);
    const meta = document.createElement('div');
    meta.className = 'hg-dl-meta';
    const pieces = [];
    if (record.state === 'progressing') pieces.push(total > 0 ? `${Math.round((received / total) * 100)}%` : '下载中');
    else pieces.push(downloadStateText(record) || '下载中');
    if (total > 0) pieces.push(`${downloadBytes(received)} / ${downloadBytes(total)}`);
    else if (received > 0) pieces.push(downloadBytes(received));
    const speed = record.state === 'progressing' ? downloadSpeed(record.speed) : '';
    if (speed) pieces.push(speed);
    if (record.url) { try { pieces.push(new URL(record.url).hostname); } catch { /* keep it short */ } }
    meta.textContent = pieces.join(' · ');
    item.append(name, bar, meta);
    if (record.error) {
      const error = document.createElement('div');
      error.className = 'hg-dl-err';
      error.textContent = record.error;
      item.appendChild(error);
    }
    const actions = document.createElement('div');
    actions.className = 'hg-dl-actions';
    if (record.state === 'progressing') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.dataset.dlAction = 'cancel';
      cancel.dataset.dlId = record.id;
      cancel.textContent = '取消';
      actions.appendChild(cancel);
    }
    if (record.state === 'completed' && record.savePath) {
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.dataset.dlAction = 'reveal';
      reveal.dataset.dlId = record.id;
      reveal.textContent = '打开所在文件夹';
      actions.appendChild(reveal);
    }
    if (actions.childElementCount) item.appendChild(actions);
    body.appendChild(item);
  }
  if (payload?.notice) {
    const notice = document.createElement('div');
    notice.className = 'hg-dl-notice';
    notice.textContent = payload.notice;
    root.appendChild(notice);
    setTimeout(() => { notice.remove(); }, 6_000);
  }
  placeDownloadPanel();
}

function installDownloadUi() {
  if (typeof document === 'undefined') return;
  const start = () => {
    try { renderDownloads(lastDownloads); } catch { /* The panel must never break the app. */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener('resize', placeDownloadPanel);
  try {
    const observer = new ResizeObserver(placeDownloadPanel);
    const attach = () => {
      const canvas = document.querySelector('#browser-panel .browser-canvas');
      if (canvas) { observer.observe(canvas); return true; }
      return false;
    };
    if (!attach()) {
      const watcher = new MutationObserver(() => { if (attach()) watcher.disconnect(); });
      watcher.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch { /* Older renderer without ResizeObserver. */ }
}


ipcRenderer.on(BROWSER_DOWNLOADS_CHANNEL, (_event, payload) => {
  if (!payload || typeof payload !== "object") return;
  const downloads = Array.isArray(payload.downloads) ? payload.downloads.filter(record => record && typeof record.id === "string" && typeof record.state === "string").slice(-12) : [];
  lastDownloads = Object.freeze({
    downloads: Object.freeze(downloads.map(record => Object.freeze({
      id: record.id.slice(0, 32), name: String(record.name ?? "").slice(0, 200),
      url: String(record.url ?? "").slice(0, 2_048), savePath: String(record.savePath ?? "").slice(0, 1_024),
      state: record.state.slice(0, 20), received: Number(record.received) || 0, total: Number(record.total) || 0,
      speed: Number(record.speed) || 0, error: String(record.error ?? "").slice(0, 200),
    }))),
    notice: typeof payload.notice === "string" ? payload.notice.slice(0, 200) : "",
  });
  try { renderDownloads(lastDownloads); } catch { /* The panel must never break the app. */ }
  for (const callback of downloadSubscribers) {
    try { callback(lastDownloads); } catch { /* A UI callback must not break the bridge. */ }
  }
});

installDownloadUi();

contextBridge.exposeInMainWorld('harnessDesktop', Object.freeze({
  browser: Object.freeze({
    getState: () => browserCommand('getState'),
    navigate: input => browserCommand('navigate', input),
    newTab: input => input === undefined ? browserCommand('newTab') : browserCommand('newTab', input),
    activateTab: id => browserCommand('activateTab', id),
    closeTab: id => browserCommand('closeTab', id),
    reopenTab: () => browserCommand('reopenTab'),
    back: () => browserCommand('back'),
    forward: () => browserCommand('forward'),
    reload: () => browserCommand('reload'),
    stop: () => browserCommand('stop'),
    readPage: timeoutMs => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, 'readPage', Number.isFinite(timeoutMs) ? timeoutMs : 0).then(payload => {
      const content = pageContent(payload);
      if (!content) throw new Error('内置浏览器暂时无法读取页面。');
      return content;
    }),
    snapshot: () => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, 'snapshot').then(payload => {
      const surface = snapshotResult(payload);
      if (!surface) throw new Error('内置浏览器暂时无法读取页面结构。');
      return surface;
    }),
    screenshot: options => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, 'screenshot', { fullPage: options?.fullPage === true }).then(payload => {
      const capture = screenshotResult(payload);
      if (!capture) throw new Error('内置浏览器暂时无法截屏。');
      return capture;
    }),
    act: request => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, 'act', request).then(payload => {
      if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') return Object.freeze({ ok: false, error: '内置浏览器暂时无法执行这个操作。' });
      if (!payload.ok) return Object.freeze({ ok: false, error: typeof payload.error === 'string' ? payload.error.slice(0, 500) : '内置浏览器未能完成这个操作。' });
      if (!payload.result || typeof payload.result !== 'object') return Object.freeze({ ok: false, error: '内置浏览器没有返回操作结果。' });
      const result = payload.result;
      return Object.freeze({
        ok: true,
        result: Object.freeze({
          action: typeof result.action === 'string' ? result.action.slice(0, 20) : '',
          url: typeof result.url === 'string' ? result.url.slice(0, 4_096) : '',
          target: result.target && typeof result.target === 'object' ? Object.freeze({ role: String(result.target.role ?? '').slice(0, 40), name: String(result.target.name ?? '').slice(0, 120) }) : null,
          scrolled: result.scrolled === true, moved: result.moved === true, stillPresent: result.stillPresent === true,
          characters: Number.isInteger(result.characters) ? result.characters : 0,
          submitted: result.submitted === true, replaced: result.replaced === true, focused: result.focused === true,
          steps: Number.isInteger(result.steps) ? result.steps : 0,
          keys: Array.isArray(result.keys) ? Object.freeze(result.keys.slice(0, 4).map(key => String(key).slice(0, 40))) : Object.freeze([]),
          direction: typeof result.direction === 'string' ? result.direction.slice(0, 20) : '',
          amount: Number.isInteger(result.amount) ? result.amount : 0,
          scrollY: Number.isInteger(result.scrollY) ? result.scrollY : null,
          scrollHeight: Number.isInteger(result.scrollHeight) ? result.scrollHeight : null,
          extra: jsonCopy({
            ref: result.ref, focusedElement: result.focusedElement ?? null, hitVerified: result.hitVerified === true,
            valueAfter: result.valueAfter, valueMatches: result.valueMatches, valueHidden: result.valueHidden === true,
            scrollBefore: result.scrollBefore, scrolledBy: result.scrolledBy, scrollContainer: result.scrollContainer,
            atTop: result.atTop, atBottom: result.atBottom, pendingInputs: result.pendingInputs ?? [],
            target: result.target ?? null,
          }),
        }),
      });
    }),
    visibility: timeoutMs => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, 'visibility', Number.isFinite(timeoutMs) ? timeoutMs : 4000).then(payload => Object.freeze({
      visible: payload?.visible === true,
      hiddenReason: typeof payload?.hiddenReason === 'string' ? payload.hiddenReason.slice(0, 200) : '',
    })),
    home: () => browserCommand('home'),
    openExternal: () => browserCommand('openExternal'),
    openDevTools: () => browserCommand('openDevTools'),
    clearSiteData: () => browserCommand('clearSiteData'),
    setViewport: value => browserCommand('setViewport', {
      x: value?.x, y: value?.y, width: value?.width, height: value?.height, visible: value?.visible,
      ...(value?.clip !== undefined ? { clip: { x: value.clip?.x, y: value.clip?.y, width: value.clip?.width, height: value.clip?.height } } : {}),
      ...(value?.emulation !== undefined ? { emulation: value.emulation === null ? null : { width: value.emulation?.width, height: value.emulation?.height } } : {}),
    }),
    setPresentation: value => browserCommand('setPresentation', {
      mode: value?.mode, zoom: value?.zoom, viewport: { width: value?.viewport?.width, height: value?.viewport?.height },
    }),
    onDownloads(callback) {
      if (typeof callback !== 'function') return () => {};
      downloadSubscribers.add(callback);
      if (lastDownloads) { try { callback(lastDownloads); } catch { /* A UI callback must not break the bridge. */ } }
      return () => downloadSubscribers.delete(callback);
    },
    cancelDownload: id => ipcRenderer.invoke(BROWSER_DOWNLOAD_COMMAND_CHANNEL, 'cancel', typeof id === 'string' ? id.slice(0, 32) : ''),
    revealDownload: id => ipcRenderer.invoke(BROWSER_DOWNLOAD_COMMAND_CHANNEL, 'reveal', typeof id === 'string' ? id.slice(0, 32) : ''),
    clearDownloads: () => ipcRenderer.invoke(BROWSER_DOWNLOAD_COMMAND_CHANNEL, 'clear'),
    onState(callback) {
      if (typeof callback !== 'function') return () => {};
      browserSubscribers.add(callback);
      if (lastBrowserState) { try { callback(lastBrowserState); } catch { /* A UI callback must not break the bridge. */ } }
      return () => browserSubscribers.delete(callback);
    },
  }),
  completionNotifications: true,
  copyImage: url => ipcRenderer.invoke(COPY_IMAGE_CHANNEL, typeof url === 'string' ? url : '').then(payload => {
    if (payload && payload.ok === true) return true;
    throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error.slice(0, 200) : '暂时无法复制这张图片。');
  }),
  // 1.3.4: the full key of one saved connection, shown only when the user presses "显示".
  revealApiKey: id => ipcRenderer.invoke(REVEAL_API_KEY_CHANNEL, typeof id === 'string' ? id.slice(0, 64) : '').then(payload => {
    if (payload && payload.ok === true && typeof payload.apiKey === 'string') return payload.apiKey;
    throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error.slice(0, 200) : '暂时无法显示密钥。');
  }),
  testCompletionNotification() {
    return ipcRenderer.invoke('harness:test-system-notification');
  },
  onOpenSession(callback) {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback);
    if (pendingSessionId) {
      const sessionId = pendingSessionId;
      pendingSessionId = undefined;
      try { callback(sessionId); } catch { /* A UI callback must not break the bridge. */ }
    }
    return () => subscribers.delete(callback);
  },
}));
