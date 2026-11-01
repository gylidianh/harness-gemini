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
        }),
      });
    }),
    home: () => browserCommand('home'),
    openExternal: () => browserCommand('openExternal'),
    openDevTools: () => browserCommand('openDevTools'),
    setViewport: value => browserCommand('setViewport', {
      x: value?.x, y: value?.y, width: value?.width, height: value?.height, visible: value?.visible,
      ...(value?.clip !== undefined ? { clip: { x: value.clip?.x, y: value.clip?.y, width: value.clip?.width, height: value.clip?.height } } : {}),
      ...(value?.emulation !== undefined ? { emulation: value.emulation === null ? null : { width: value.emulation?.width, height: value.emulation?.height } } : {}),
    }),
    setPresentation: value => browserCommand('setPresentation', {
      mode: value?.mode, zoom: value?.zoom, viewport: { width: value?.viewport?.width, height: value?.viewport?.height },
    }),
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
