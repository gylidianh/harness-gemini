// Responsive viewport behavior adapted from ZCode's browserViewportZoom.ts,
// ResponsiveBrowserViewport.tsx and browserGuestManager.ts at
// aac4755666d09fdcd70272fcf063c077a639015f. Modified to use a clipped
// WebContentsView with native device emulation and Harness's restricted IPC.
// Apache-2.0: see third-party/ZCode-LICENSE.txt and ZCode-NOTICE.md.
import { defaultPresentation, normalizePresentation, readPresentation, savePresentation, validLogicalViewport } from './browser-presentation.mjs';
import { installContextMenu } from './context-menu.mjs';
import { createDebuggerSession } from './debugger-session.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserUrlAllowed, isPrivateWebUrl, normalizeBrowserInput, isLocalFileUrl } from '../shared/browser-navigation.mjs';
import { createBrowserNetworkPolicy, createLocalRoot, createOfflineProxy, localFileInRoot } from './browser-network-policy.mjs';
import { MAX_SNAPSHOT_ELEMENTS, REF_PATTERN, SNAPSHOT_PAGE_SCRIPT, createBrowserInput, normalizeRequest } from '../shared/browser-input.mjs';
export { browserUrlAllowed, normalizeBrowserInput } from '../shared/browser-navigation.mjs';

export const BROWSER_COMMAND_CHANNEL = 'harness:browser-command';
export const BROWSER_STATE_CHANNEL = 'harness:browser-state';
export const BROWSER_DOWNLOADS_CHANNEL = 'harness:browser-downloads';
export const BROWSER_DOWNLOAD_COMMAND_CHANNEL = 'harness:browser-download-command';
/** 1.4.4: downloads now run side by side; the old one-at-a-time gate could block every
 *  later click forever once a single item stayed pending. */
export const MAX_ACTIVE_DOWNLOADS = 6;
export const BROWSER_PARTITION = 'persist:harness-browser';
/**
 * fix3: local pages run in their own in-memory session whose only proxy refuses everything. A page
 * the model wrote into the workspace could read the files beside it; it can no longer send them
 * anywhere, because it has no network at all.
 */
export const LOCAL_BROWSER_PARTITION = 'harness-browser-local-files';
const LOCAL_PAGE_OFFLINE = '本地页面不能访问网络地址；如需打开网页，请在地址栏中直接输入。';
export const MAX_BROWSER_TABS = 32;
export const MAX_CLOSED_TABS = 10;
export const MAX_PAGE_TEXT = 200_000;
export const MAX_PAGE_LINKS = 20;
/** A screenshot is re-sent with every later request in the turn, so it stays small. */
export const MAX_SCREENSHOT_EDGE = 1_600;
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const TAB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract the rendered document. A plain HTTP fetch cannot see what a page built
 * with JavaScript, so this runs in the loaded page and reports what is on screen.
 * The page is untrusted: the result is plain text and links, never markup.
 */
export const READ_PAGE_SCRIPT = `(() => {
  try {
    const clean = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (links.length >= ${MAX_PAGE_LINKS}) break;
      let href;
      try { href = new URL(anchor.getAttribute('href'), location.href).href; } catch { continue; }
      if (!/^(?:https?|file):/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: clean(anchor.textContent || anchor.getAttribute('title') || href).slice(0, 200), url: href.slice(0, 4096) });
    }
    const title = typeof document.title === 'string' ? document.title : '';
    if (!document.body) return { url: location.href, title, text: '', links };
    const clone = document.body.cloneNode(true);
    for (const node of clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,svg,canvas,nav,footer,[hidden],[aria-hidden="true"]')) node.remove();
    for (const node of clone.querySelectorAll('br')) node.replaceWith('\\n');
    for (const node of clone.querySelectorAll('p,div,section,article,main,h1,h2,h3,h4,h5,h6,li,pre,blockquote,tr,hr,dt,dd')) { node.prepend('\\n'); node.append('\\n'); }
    const text = String(clone.textContent || '').replace(/[\\t\\f\\v ]+/g, ' ').replace(/[ ]*\\n[ ]*/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { url: location.href, title, text, links };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 500) };
  }
})()`;

const emptyPage = () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null });
const emptyState = () => ({ ...emptyPage(), openRequested: 0, desktopZoomFactor: 1, presentation: defaultPresentation(), activeTabId: null, tabs: [] });
const unavailableState = () => ({ ...emptyState(), error: '浏览器暂时不可用。' });

/** Convert DOM CSS pixels into native DIP bounds, keeping the view inside the window. */
export function normalizeViewport(value, contentSize, zoomFactor = 1) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['x', 'y', 'width', 'height', 'visible', 'clip', 'emulation'].includes(key))
    || typeof value.visible !== 'boolean' || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 100_000)
    || value.width < 0 || value.height < 0 || !Number.isFinite(zoomFactor) || zoomFactor <= 0
    || (value.clip !== undefined && (!value.clip || Object.keys(value.clip).sort().join(',') !== 'height,width,x,y'
      || !['x', 'y', 'width', 'height'].every(key => typeof value.clip[key] === 'number' && Number.isFinite(value.clip[key]) && Math.abs(value.clip[key]) <= 100_000)
      || value.clip.width < 0 || value.clip.height < 0))
    || (value.emulation != null && !validLogicalViewport(value.emulation))) return null;
  const left = Math.max(0, Math.min(contentSize.width, Math.ceil(value.x * zoomFactor)));
  const top = Math.max(0, Math.min(contentSize.height, Math.ceil(value.y * zoomFactor)));
  const right = Math.max(left, Math.min(contentSize.width, Math.floor((value.x + value.width) * zoomFactor)));
  const bottom = Math.max(top, Math.min(contentSize.height, Math.floor((value.y + value.height) * zoomFactor)));
  return { x: left, y: top, width: right - left, height: bottom - top, visible: value.visible && right > left && bottom > top };
}

/** Keep full page geometry separate from the visible native crop. All values are DIP. */
export function resolveNativeBrowserLayout(value, contentSize, zoomFactor = 1) {
  const validated = normalizeViewport(value, contentSize, zoomFactor);
  if (!validated) return null;
  const rect = input => ({ x: Math.round(input.x * zoomFactor), y: Math.round(input.y * zoomFactor), width: Math.max(0, Math.round(input.width * zoomFactor)), height: Math.max(0, Math.round(input.height * zoomFactor)) });
  const intersect = (left, right) => {
    const x = Math.max(left.x, right.x);
    const y = Math.max(left.y, right.y);
    return { x, y, width: Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x), height: Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y) };
  };
  const frame = rect(value);
  const windowBounds = { x: 0, y: 0, width: contentSize.width, height: contentSize.height };
  const canvas = value.clip ? intersect(rect(value.clip), windowBounds) : windowBounds;
  const clip = intersect(frame, canvas);
  const scale = value.emulation && value.width > 0 ? value.width * zoomFactor / value.emulation.width : 1;
  if (value.emulation && value.width > 0 && value.height > 0 && (scale <= 0 || scale > 2.01 * Math.max(1, zoomFactor) || Math.abs(value.height * zoomFactor - value.emulation.height * scale) > 2 * Math.max(1, zoomFactor, scale) + 1)) return null;
  return {
    clip, frame,
    child: { x: frame.x - clip.x, y: frame.y - clip.y, width: frame.width, height: frame.height },
    emulation: value.emulation ?? null, scale,
    visible: value.visible && clip.width > 0 && clip.height > 0,
  };
}

function downloadName(value) {
  const name = String(value ?? 'download').split(/[\\/]/).at(-1).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  return !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'download' : name;
}

/** Electron dependencies are injected so boundary tests cannot create windows. */
export function createEmbeddedBrowser({ window, appOrigin, WebContentsView, View, session, ipcMain, presentationPath, openExternalUrl, Menu, BrowserWindow, nativeImage, onBeforeInput = null, confirmPrivateNavigation = null, downloadsDirectory = '', revealDownloadPath = null }) {
  let state = { openRequested: 0, desktopZoomFactor: 1, presentation: readPresentation(presentationPath) };
  let guestSession;
  let sessionReady = null;
  let localSession;
  let localSessionReady = null;
  const networkPolicy = createBrowserNetworkPolicy({ appOrigin });
  const offlineProxy = createOfflineProxy();
  const originFor = value => { try { return networkPolicy.originOf(value); } catch { return null; } };
  let viewport = { x: 0, y: 0, width: 0, height: 0, visible: false };
  // The renderer's most recent request, kept separately: a minimized window clears
  // visibility without changing the renderer's geometry, so the geometry has to come
  // from here when the window comes back and no fresh viewport arrives.
  let lastRequested = null;
  // 1.3.1-window-move: the content size the active view was last laid out for, and the timer that
  // re-applies the last viewport once the window stops moving or resizing.
  let lastContentSize = null;
  let windowSettleTimer;
  // Where the active view was last laid out. Native input events are positioned in
  // this view's own DIP space, and a clipped or hidden view accepts none of them.
  let inputArea = null;
  let disposed = false;
  const tabs = [];
  const closedTabs = [];
  const captureGuests = new Set();
  const downloads = new Map();
  let downloadSequence = 0;
  let downloadTimer = null;
  const listeners = [];
  const main = window.webContents;
  const ownUrl = value => { try { return new URL(value).origin === appOrigin; } catch { return false; } };
  const alive = () => !disposed && !window.isDestroyed() && !main.isDestroyed();
  // fix3: privateOrigins holds the local-network origins approved for this tab. An approval no longer
  // opens that address to every page of the browser session, only to this tab's own pages.
  const makeTab = () => ({ id: randomUUID(), page: emptyPage(), listeners: [], closed: false, loadSequence: 0, emulationActive: false, fitZoom: 1, fitTimer: undefined, pageWidth: null, localRoot: null, privateOrigins: new Set(), viewLocal: false, viewRoot: null, committedUrl: '', hostNavigation: null, navigationSequence: 0, viewGeneration: 0, historyEntries: [], historyIndex: -1, historyTravel: null });
  tabs.push(makeTab());
  let activeTabId = tabs[0].id;
  const findTab = id => typeof id === 'string' && TAB_ID.test(id) ? tabs.find(tab => tab.id === id) : undefined;
  const activeTab = () => findTab(activeTabId);
  const tabAlive = tab => alive() && tab && !tab.closed && tabs.includes(tab);
  // fix3: a view being replaced (crossing into or out of the offline session) may briefly have no contents.
  const guest = (tab = activeTab()) => { const contents = tab?.view?.webContents; try { return contents && !contents.isDestroyed() ? contents : null; } catch { return null; } };
  const on = (emitter, event, callback, cleanup = listeners) => { emitter.on(event, callback); cleanup.push(() => emitter.off(event, callback)); };

  // URL/root/session history belongs to the host, not to a renderer that is destroyed when
  // crossing the offline boundary. Native entries are used when that renderer still exists.
  function history(tab = activeTab()) {
    return { canGoBack: Boolean(tab && tab.historyIndex > 0), canGoForward: Boolean(tab && tab.historyIndex + 1 < tab.historyEntries.length) };
  }

  function recordHistory(tab, url, contents) {
    if (!url || (!tab.historyEntries.length && url === 'about:blank')) return;
    const entry = { url, localRoot: tab.localRoot, viewGeneration: tab.viewGeneration, nativeIndex: contents.navigationHistory.getActiveIndex() };
    if (tab.historyTravel != null) {
      tab.historyIndex = tab.historyTravel;
      tab.historyEntries[tab.historyIndex] = entry;
      tab.historyTravel = null;
      return;
    }
    const existing = tab.historyEntries.findIndex(item => item.viewGeneration === entry.viewGeneration && item.nativeIndex === entry.nativeIndex);
    if (existing >= 0) {
      tab.historyEntries[existing] = entry;
      tab.historyIndex = existing;
    } else {
      tab.historyEntries.splice(tab.historyIndex + 1);
      tab.historyEntries.push(entry);
      tab.historyIndex = tab.historyEntries.length - 1;
    }
  }

  function getState() {
    return {
      ...(activeTab()?.page ?? emptyPage()), ...history(), ...state,
      desktopZoomFactor: !main.isDestroyed() ? main.getZoomFactor() : state.desktopZoomFactor,
      presentation: { ...state.presentation, viewport: { ...state.presentation.viewport } },
      activeTabId,
      tabs: tabs.map(({ id, page }) => ({ id, url: page.url, title: page.title, loading: page.loading, error: page.error })),
    };
  }

  function hideTab(tab) {
    tab.view?.setVisible(false);
    tab.clipView?.setVisible(false);
  }

  function applyViewport() {
    if (!alive()) return;
    inputArea = null;
    const tab = activeTab();
    for (const other of tabs) if (other !== tab) hideTab(other);
    const contents = guest(tab);
    if (!tab?.view || !contents) return;
    const hostZoom = main.getZoomFactor();
    const contentBounds = window.getContentBounds();
    lastContentSize = { width: contentBounds.width, height: contentBounds.height };
    const layout = resolveNativeBrowserLayout(viewport, contentBounds, hostZoom);
    if (!layout) { hideTab(tab); return; }
    const visible = Boolean(layout?.visible && tab.page.url && !tab.page.error && ownUrl(main.getURL()) && !main.isLoadingMainFrame());
    // With a clip view the view keeps its full frame and only part of it shows;
    // without one the view is sized to the clip. Input coordinates belong to the
    // view, so both the page ratio and the visible part are measured against it.
    const view = tab.clipView ? layout.frame : layout.clip;
    inputArea = visible && view.width > 1 && view.height > 1 ? {
      bounds: { width: view.width, height: view.height },
      visible: {
        x: Math.max(0, layout.clip.x - view.x), y: Math.max(0, layout.clip.y - view.y),
        width: layout.clip.width, height: layout.clip.height,
      },
    } : null;
    if (!visible) hideTab(tab);
    if (layout?.frame.width && layout.frame.height) {
      const key = JSON.stringify([layout.emulation, layout.scale, layout.emulation ? 1 : hostZoom]);
      if (!layout.emulation && tab.emulationActive) { contents.disableDeviceEmulation(); tab.emulationActive = false; }
      if (!layout.emulation) tab.viewWidth = layout.clip.width;
      const targetZoom = layout.emulation ? 1 : hostZoom * (tab.fitZoom ?? 1);
      if (contents.getZoomFactor() !== targetZoom) contents.setZoomFactor(targetZoom);
      if (tab.clipView) {
        tab.clipView.setBounds(layout.clip);
        tab.view.setBounds(layout.child);
      } else tab.view.setBounds(layout.clip);
      if (layout.emulation && key !== tab.emulationKey) {
        contents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { ...layout.emulation }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, viewSize: { ...layout.emulation }, scale: layout.scale });
        tab.emulationActive = true;
      }
      tab.emulationKey = key;
    }
    if (visible) { tab.clipView?.setVisible(true); tab.view.setVisible(true); hiddenReason = ''; notifyVisibility(); }
  }

  // A page wider than a narrow panel (fixed-width sites) is scaled down so its whole
  // layout stays visible; widening the panel restores the natural scale.
  function scheduleFit(tab, delay) {
    if (!tabAlive(tab)) return;
    clearTimeout(tab.fitTimer);
    tab.fitTimer = setTimeout(() => { tab.fitTimer = undefined; void measureFit(tab).catch(() => {}); }, delay);
    tab.fitTimer.unref?.();
  }

  async function measureFit(tab) {
    try {
      const contents = guest(tab);
      if (!contents || !tabAlive(tab) || tab.emulationActive) return;
      const url = contents.getURL();
      if (!url || url === 'about:blank' || !browserUrlAllowed(url, appOrigin)) return;
      const width = Math.round(tab.viewWidth ?? 0);
      if (!(width > 120)) return;
      const hostZoom = main.isDestroyed() ? 1 : main.getZoomFactor();
      const natural = hostZoom > 0 ? hostZoom : 1;
      if (tab.pageWidth == null) {
        // A fresh page loads at its natural zoom, so one measurement of the widest
        // layout is stable; the fitted zoom itself is then derived arithmetically and
        // never re-measured right after a zoom change.
        const measured = await contents.executeJavaScript('(() => { const d = document.documentElement; const cw = d ? d.clientWidth : 0; const sw = Math.max(d ? d.scrollWidth : 0, document.body ? document.body.scrollWidth : 0); return { cw, sw }; })()', false);
        if (!tabAlive(tab) || contents !== guest(tab)) return;
        const cw = Number(measured?.cw);
        const sw = Number(measured?.sw);
        if (!Number.isFinite(cw) || !Number.isFinite(sw) || cw <= 0 || sw <= 0) return;
        if (sw < cw + 16) return;
        tab.pageWidth = Math.round(sw);
      }
      const fitsNatural = tab.pageWidth * natural <= width + 16;
      const next = fitsNatural ? 1 : Math.min(1, Math.max(0.2, width / tab.pageWidth) / natural);
      if (next >= 0.98) {
        if ((tab.fitZoom ?? 1) !== 1) { tab.fitZoom = 1; applyViewport(); }
        return;
      }
      if (Math.abs(next - (tab.fitZoom ?? 1)) < 0.02) return;
      tab.fitZoom = next;
      applyViewport();
    } catch { /* Pages mid-navigation cannot be measured; the next load or resize re-measures. */ }
  }

  function emitState() {
    if (disposed) return getState();
    applyViewport();
    if (alive() && ownUrl(main.getURL())) {
      try { main.send(BROWSER_STATE_CHANNEL, getState()); } catch { /* Renderer may be reloading. */ }
    }
    return getState();
  }

  function publish(update = {}, tab = activeTab()) {
    if (!tabAlive(tab)) return getState();
    tab.page = { ...tab.page, ...history(tab), ...update };
    return emitState();
  }

  function publishGlobal(update) {
    if (disposed) return getState();
    state = { ...state, ...update };
    return emitState();
  }

  /** 1.4.1-browserfix: why the page is not on screen, so a refused action can say so. */
  let hiddenReason = '';
  const visibilityWaiters = new Set();
  function notifyVisibility() {
    if (!inputArea) return;
    for (const resolve of visibilityWaiters) resolve(true);
    visibilityWaiters.clear();
  }
  function describeHidden() {
    if (inputArea) return '';
    try {
      if (window.isMinimized()) return '应用窗口已最小化';
      if (!window.isVisible()) return '应用窗口被隐藏';
    } catch { return '应用窗口不可用'; }
    const tab = activeTab();
    if (!tab?.page.url) return '浏览器当前没有打开的网页';
    if (tab.page.error) return '页面加载出错';
    if (hiddenReason) return hiddenReason;
    if (!lastRequested) return '浏览器面板还没有显示过';
    if (!lastRequested.visible) return '浏览器面板已被收起，或右侧切换到了其他面板';
    return '浏览器面板正在重新布局';
  }
  /** Wait until the native view is really laid out on screen, then one more frame. */
  function waitVisible(timeoutMs = 4_000) {
    if (inputArea) return new Promise(resolve => setTimeout(() => resolve({ visible: Boolean(inputArea), reason: describeHidden() }), 34));
    return new Promise(resolve => {
      let timer;
      const done = ok => { clearTimeout(timer); visibilityWaiters.delete(onShow); setTimeout(() => resolve({ visible: ok && Boolean(inputArea), reason: describeHidden() }), ok ? 34 : 0); };
      const onShow = () => done(true);
      visibilityWaiters.add(onShow);
      timer = setTimeout(() => done(false), Math.max(200, Math.min(10_000, Number(timeoutMs) || 4_000)));
      timer.unref?.();
    });
  }
  /** Ask the renderer to bring the browser panel forward, and wait for it. */
  async function ensureVisible(timeoutMs) {
    if (inputArea) return { visible: true, reason: '' };
    try { if (window.isMinimized()) window.restore(); } catch { /* ignore */ }
    publishGlobal({ openRequested: state.openRequested + 1 });
    if (lastRequested && !viewport.visible && lastRequested.visible) resumeAfterWindowState();
    return waitVisible(timeoutMs);
  }

  function hideForRendererChange(reason = '应用界面正在刷新布局') {
    if (typeof reason === 'string') hiddenReason = reason;
    viewport = { ...viewport, visible: false };
    for (const tab of tabs) hideTab(tab);
  }

  /**
   * 1.3.1-window-move: Windows reports every step of a title-bar drag as a resize as well, with the
   * content size unchanged. Hiding the page on each of them left it hidden for good: the renderer
   * measured nothing new, so it never sent another viewport, and dragging the window turned the
   * browser panel white. Only a real size change hides the page now (a rounding step of a pixel
   * or two is not one), and whenever the window settles with the page still hidden although the
   * renderer last asked for it to be shown, that request is applied again.
   */
  function windowResized() {
    if (!alive()) return;
    const { width, height } = window.getContentBounds();
    const changed = !lastContentSize || Math.abs(lastContentSize.width - width) > 2 || Math.abs(lastContentSize.height - height) > 2;
    if (changed) hideForRendererChange('窗口大小正在变化');
    settleAfterWindowChange();
  }

  function settleAfterWindowChange() {
    clearTimeout(windowSettleTimer);
    for (const timer of debuggerTimers) clearTimeout(timer);
    debuggerTimers.clear();
    windowSettleTimer = setTimeout(() => {
      windowSettleTimer = undefined;
      if (disposed || !alive() || viewport.visible || !lastRequested?.visible) return;
      try { if (window.isMinimized()) return; } catch { return; }
      resumeAfterWindowState();
    }, 250);
    windowSettleTimer.unref?.();
  }

  /**
   * Coming back from a minimized (or hidden) window. The window manager stops compositing the
   * native views while it is minimized, and restoring it does not move anything in the renderer,
   * so the renderer sends no new viewport. Re-apply the last request it made and ask the page to
   * repaint its surface, otherwise the panel stays blank even though the page is still loaded.
   */
  function resumeAfterWindowState() {
    if (!alive()) return;
    if (lastRequested) {
      viewport = { ...lastRequested, ...(lastRequested.clip ? { clip: { ...lastRequested.clip } } : {}), ...(lastRequested.emulation ? { emulation: { ...lastRequested.emulation } } : {}) };
    }
    applyViewport();
    const contents = guest();
    if (contents) { try { contents.invalidate(); } catch { /* A destroyed guest cannot repaint. */ } }
  }

  /**
   * fix6: nothing on the network is refused. The address rules that remain are about shape only
   * (see browserUrlAllowed): an unsupported scheme, a URL carrying credentials, or this app's own
   * service port. What is still kept apart is this computer's content — see LOCAL_PAGE_OFFLINE.
   */
  function restrictedAddress() {
    return false;
  }

  /** Never use the address-bar/pending URL as an authority. Opaque, missing, stale or
   * worker-only source contexts are deliberately not granted private-network access. */
  function frameOrigin(frame) {
    try {
      if (!frame || frame.isDestroyed?.()) return null;
      const origin = originFor(frame.origin);
      return origin && originFor(frame.url) === origin ? origin : null;
    } catch { return null; }
  }

  function privateAllowedFrom(tab, value, sourceOrigin) {
    const target = originFor(value);
    return Boolean(target && sourceOrigin && networkPolicy.isPrivateOriginAuthorized(value)
      && tab?.privateOrigins?.has(target) && tab.privateOrigins.has(sourceOrigin));
  }

  function requestSource(tab, details) {
    try {
      const contents = tab.view?.webContents;
      const frame = details.frame;
      if (!contents || contents.isDestroyed() || !frame || frame.top !== contents.mainFrame) return null;
      const source = frameOrigin(frame);
      const top = frameOrigin(frame.top);
      // Electron 44 supplies initiatorOrigin for renderer requests, including associated
      // dedicated workers. Do not fall back to referrer (page-controlled) or tab.page.url.
      const initiator = originFor(details.initiatorOrigin);
      if (!source || !top || !initiator || source !== initiator || !tab.privateOrigins.has(top)) return null;
      return source;
    } catch { return null; }
  }

  function hostRequestAllowed(tab, details) {
    const grant = tab?.hostNavigation;
    if (!grant || details.resourceType !== 'mainFrame' || !tab.privateOrigins.has(originFor(details.url))) return false;
    try {
      if (details.frame !== tab.view.webContents.mainFrame) return false;
      const url = new URL(details.url); url.hash = '';
      if (grant.requestId == null) {
        // A loadURL/history operation from the host has no renderer initiator. Bind the
        // one-shot grant to its request id; a pending grant is never a subresource grant.
        if (details.initiatorOrigin != null || url.href !== grant.url) return false;
        grant.requestId = details.id;
      }
      return grant.requestId === details.id && originFor(details.url) === grant.origin;
    } catch { return false; }
  }

  function beginHostNavigation(tab, url) {
    const target = new URL(url); target.hash = '';
    tab.hostNavigation = { url: target.href, origin: originFor(url), requestId: null };
  }

  function blockedNavigation(tab, event, value, isMainFrame = true) {
    const local = isLocalFileUrl(value);
    let allowed;
    if (tab.localRoot) {
      // A local page stays offline: only its own directory and inline content.
      allowed = local ? localFileInRoot(value, tab.localRoot)
        : /^about:(?:blank|srcdoc)$/.test(value) || (!isMainFrame && /^(?:data|blob):/i.test(value));
    } else {
      // fix6: a web tab opens any address a browser may show — localhost, the LAN, the internet.
      allowed = !local && browserUrlAllowed(value, appOrigin, { resource: !isMainFrame, blank: value === 'about:blank' });
    }
    if (allowed) return;
    event.preventDefault();
    if (isMainFrame) publish({ loading: false, error: tab.localRoot && !local ? LOCAL_PAGE_OFFLINE : '此地址不能在内置浏览器中打开。' }, tab);
  }

  /**
   * fix6: nothing is authorised in advance any more; the answer only has to be well formed.
   * The renderer asks this before a tool navigation, and a failure here must not stop the page.
   */
  async function authorizeToolNavigation(value) {
    if (value === 'about:blank' || isLocalFileUrl(value)) return { origin: '', allowPrivateNetwork: false };
    let origin = '';
    try { origin = originFor(value) ?? ''; } catch { origin = ''; }
    return { origin, allowPrivateNetwork: false };
  }

  /**
   * fix6: opening a page asks nothing. The address only has to be one a browser may show; where
   * it points — this machine, the local network, the internet — is no longer judged here.
   */
  async function prepareNavigation(tab, value) {
    if (!browserUrlAllowed(value, appOrigin, { blank: value === 'about:blank' })) throw new Error('此地址不能在内置浏览器中打开。');
    if (value === 'about:blank' || isLocalFileUrl(value)) {
      if (isLocalFileUrl(value) && (!tab.localRoot || !localFileInRoot(value, tab.localRoot))) tab.localRoot = createLocalRoot(value);
      return true;
    }
    tab.localRoot = null;
    return true;
  }

  function ownerOf(details) {
    try { return [...tabs, ...captureGuests].find(tab => !tab.closed && (tab.view?.webContents === details.webContents || tab.view?.webContents?.id === details.webContentsId)) ?? null; } catch { return null; }
  }

  function lockDown(target) {
    target.setPermissionCheckHandler(() => false);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setDevicePermissionHandler(() => false);
    target.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  }

  /** fix3: the offline session local pages run in. See LOCAL_BROWSER_PARTITION. */
  function ensureLocalSession() {
    if (localSession) return localSession;
    localSession = session.fromPartition(LOCAL_BROWSER_PARTITION, { cache: false });
    lockDown(localSession);
    localSessionReady = offlineProxy.start().then(proxy => localSession.setProxy({
      proxyRules: 'http://' + proxy.host + ':' + proxy.port,
      proxyBypassRules: '<-loopback>',
    }));
    localSession.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url ?? '');
      let allowed = false;
      let frameValid = true;
      // fix3: like the web session, a request from a frame that is gone or unknown is refused.
      try { if (details.frame === null || details.frame?.detached === true) frameValid = false; } catch { frameValid = false; }
      if (disposed || !frameValid) allowed = false;
      else if (isLocalFileUrl(url)) {
        const owner = ownerOf(details);
        allowed = Boolean(owner?.localRoot && localFileInRoot(url, owner.localRoot));
      } else if (/^about:(?:blank|srcdoc)$/.test(url) || /^devtools:/i.test(url)) allowed = true;
      else if (/^(?:data|blob):/i.test(url)) allowed = details.resourceType !== 'mainFrame';
      // Everything else (http, https, ws, ftp, any other scheme) is refused: a local page is offline.
      callback({ cancel: !allowed });
    });
    on(localSession, 'will-download', event => event.preventDefault());
    return localSession;
  }

  function ensureSession() {
    if (guestSession) return guestSession;
    guestSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    lockDown(guestSession);
    // fix5: this computer reaches the internet through a proxy (Clash, a company gateway). The
    // panel used to send every request to its own checking proxy and connect from here, which
    // bypassed that route: a page that is only reachable through the proxy never opened at all.
    // When a system proxy exists the panel uses it, and the policy verifies the name instead of
    // pinning an address the proxy is going to resolve itself. Loopback stays direct, so the
    // checks below still see (and refuse) a request into this machine.
    //
    // 1.3.4: fix5 asked once, at start-up and for https://example.com/ only, which proxy to use,
    // and fixed that answer for the whole session: a proxy switched on or off later was never
    // noticed (with Clash closed the panel stayed offline), a PAC script that routes by address
    // was reduced to one answer, and HTTPS/SOCKS4 proxies were rewritten as http:// and socks5://.
    // The session now uses Chromium's own system proxy mode, which watches the system settings,
    // evaluates PAC per request and speaks every proxy type. The panel's forwarding proxy checks
    // nothing since fix6, so it is not needed in between. Chromium never proxies loopback, so a
    // request into this machine still goes direct and still passes the request hook below.
    sessionReady = guestSession.setProxy({ mode: 'system' });
    guestSession.webRequest.onBeforeRequest((details, callback) => {
      const resource = details.resourceType !== 'mainFrame';
      const owner = ownerOf(details);
      const validOwner = () => {
        try { return !disposed && owner && !owner.closed && details.frame && !details.frame.detached && details.frame.top === owner.view.webContents.mainFrame; }
        catch { return false; }
      };
      // fix6: any http/https/ws destination is allowed, this machine and the LAN included. The
      // only refusal left is a file: request from a web page: that would read this computer's own
      // content, and a web page has no business doing that. The app's own service port is still
      // excluded by browserUrlAllowed, because that is where the user's data and keys live.
      const allowed = validOwner() && browserUrlAllowed(details.url, appOrigin, { resource, blank: details.url === 'about:blank' });
      callback({ cancel: !allowed || /^file:/i.test(details.url) });
    });
    const finishRequest = details => {
      for (const tab of [...tabs, ...captureGuests]) if (tab.hostNavigation?.requestId === details.id) tab.hostNavigation = null;
    };
    guestSession.webRequest.onCompleted(finishRequest);
    guestSession.webRequest.onErrorOccurred(finishRequest);
    // One shared-session listener routes downloads to their owner instead of
    // allowing one tab's source check to cancel downloads from every other tab.
    on(guestSession, 'will-download', (event, item, source) => {
      const owner = source && tabs.find(tab => !tab.closed && guest(tab) === source);
      if (disposed) {
        event.preventDefault();
        return;
      }
      // 1.4.4: a refused download says why instead of dying silently.
      if (!browserUrlAllowed(item.getURL(), appOrigin, { resource: true })) {
        event.preventDefault();
        downloadNotice('这个下载地址不能在内置浏览器中保存，已取消。');
        return;
      }
      // 1.4.4: a tab that already closed must not lose the file it asked for.
      const started = startDownload(item, owner);
      if (!started.ok) {
        event.preventDefault();
        downloadNotice(started.error);
      }
    });
    return guestSession;
  }

  // Electron exposes this on WebContents, not Session. Apply and verify before the first load of
  // a guest that shows a local file, including offscreen screenshot guests, because such a page
  // can read the files beside it and must not have a second way out. No optional no-op there.
  // An ordinary web page keeps Chromium's default: a call or a video stream on a website has to
  // keep working, and it has no local file to leak.
  function hardenGuest(contents, { local = false } = {}) {
    if (!local) return;
    try {
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      if (contents.getWebRTCIPHandlingPolicy() !== 'disable_non_proxied_udp') throw new Error('WebRTC policy not applied');
    } catch {
      try { contents.close({ waitForBeforeUnload: false }); } catch { /* not loaded */ }
      throw new Error('无法应用浏览器离线网络策略；已拒绝加载。');
    }
  }

  function ensureView(tab) {
    if (guest(tab)) return guest(tab);
    if (!tabAlive(tab)) throw new Error('浏览器暂时不可用。');
    tab.viewLocal = Boolean(tab.localRoot);
    tab.viewRoot = tab.localRoot;
    tab.viewGeneration++;
    tab.committedUrl = '';
    tab.view = new WebContentsView({ webPreferences: {
      session: tab.viewLocal ? ensureLocalSession() : ensureSession(),
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true,
      spellcheck: false, backgroundThrottling: false,
      // Direct sockets/WebTransport must not create an alternative to the proxy boundary.
      disableBlinkFeatures: 'DirectSockets,WebTransport',
    } });
    const contents = tab.view.webContents;
    hardenGuest(contents, { local: tab.viewLocal });
    // 1.3.0: the guest reports menu coordinates relative to its own view; the menu is placed in
    // window coordinates, so the view's offset inside the window is added.
    installContextMenu(contents, { Menu, BrowserWindow, getLocale: () => 'zh-CN', offset: () => {
      const child = tab.view?.getBounds?.() ?? { x: 0, y: 0 };
      const clip = tab.clipView?.getBounds?.() ?? { x: 0, y: 0 };
      return { x: child.x + (tab.clipView ? clip.x : 0), y: child.y + (tab.clipView ? clip.y : 0) };
    } });
    // 1.3.0: Alt/F10 reach the app's menu row from a focused page too, but never the keys the
    // agent itself sends while it operates the page.
    if (typeof onBeforeInput === 'function') {
      contents.on('before-input-event', (event, input) => { if (!tab.automating) onBeforeInput(event, input); });
      // fix3 (#18): before-input-event carries keys only, so a click or a wheel turn with Alt held
      // inside a page never told the title-bar logic that Alt was a modifier; releasing Alt then
      // moved focus to the 文件 menu. Pointer input is reported through input-event instead.
      contents.on('input-event', (_event, input) => {
        if (tab.automating) return;
        const type = input?.type;
        if (type === 'mouseDown' || type === 'mouseWheel' || type === 'gestureScrollBegin' || type === 'touchStart') {
          onBeforeInput({ preventDefault() {} }, { type: type === 'mouseDown' || type === 'touchStart' ? 'mouseDown' : 'mouseWheel' });
        }
      });
    }
    tab.view.setBackgroundColor('#ffffff');
    tab.view.setVisible(false);
    if (View) {
      tab.clipView = new View();
      tab.clipView.setBorderRadius(0);
      tab.clipView.setVisible(false);
      window.contentView.addChildView(tab.clipView);
      tab.clipView.addChildView(tab.view);
    } else window.contentView.addChildView(tab.view);
    const userAgent = contents.getUserAgent().replace(/\s(?:Local-?Harness|Harness-?Gemini|local-harness)\/\S+/gi, '');
    contents.setUserAgent(userAgent);
    const watch = (event, callback) => on(contents, event, callback, tab.listeners);
    const update = value => publish(value, tab);
    watch('will-attach-webview', event => event.preventDefault());
    watch('will-navigate', (event, url) => blockedNavigation(tab, event, event.url ?? url));
    watch('will-frame-navigate', event => blockedNavigation(tab, event, event.url, event.isMainFrame));
    watch('will-redirect', (event, url, _inPlace, isMainFrame) => blockedNavigation(tab, event, event.url ?? url, event.isMainFrame ?? isMainFrame, true));
    contents.setWindowOpenHandler(({ url }) => {
      const local = isLocalFileUrl(url);
      const allowed = tab.localRoot
        ? local && localFileInRoot(url, tab.localRoot)
        : !local && (url === 'about:blank' || browserUrlAllowed(url, appOrigin));
      if (allowed) {
        queueMicrotask(() => {
          if (tabAlive(tab)) createTab(url, activeTabId === tab.id, tab.localRoot);
        });
      } else if (tab.localRoot && !local) publish({ error: LOCAL_PAGE_OFFLINE }, tab);
      return { action: 'deny' };
    });
    watch('will-prevent-unload', event => event.preventDefault());
    watch('dom-ready', () => { tab.emulationKey = undefined; if (tabAlive(tab)) applyViewport(); });
    watch('did-start-navigation', (event, url, _inPlace, isMainFrame) => {
      if (!(event.isMainFrame ?? isMainFrame)) return;
      // A new document loads at its natural zoom; its fitted width is measured afresh.
      tab.pageWidth = null;
      tab.fitZoom = 1;
      const target = event.url ?? url;
      if (browserUrlAllowed(target, appOrigin, { blank: true })) update({ url: target === 'about:blank' ? '' : target, title: '', loading: target !== 'about:blank', error: null });
    });
    watch('did-navigate', (_event, url) => {
      tab.committedUrl = url;
      recordHistory(tab, url, contents);
      update({ url: url === 'about:blank' ? '' : url, title: url === 'about:blank' ? '' : contents.getTitle().slice(0, 512) });
    });
    watch('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.committedUrl = url;
      recordHistory(tab, url, contents);
      update({ url: url === 'about:blank' ? '' : url });
    });
    watch('did-start-loading', () => update({ loading: Boolean(tab.page.url) }));
    watch('did-stop-loading', () => {
      tab.hostNavigation = null;
      tab.historyTravel = null;
      // An aborted/blocked pending address is presentation only, never the document.
      update({ url: tab.committedUrl === 'about:blank' ? '' : tab.committedUrl, loading: false });
      scheduleFit(tab, 300);
    });
    watch('page-title-updated', (_event, title) => update({ title: tab.page.url ? String(title).slice(0, 512) : '' }));
    watch('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && (!url || url === tab.page.url)) update({ loading: false, error: '网页未能加载，请检查网址和网络后重试。' });
    });
    watch('render-process-gone', () => { tab.committedUrl = ''; tab.hostNavigation = null; update({ loading: false, error: '网页进程已停止，请重新加载。' }); });
    return contents;
  }

  async function load(url, tab = activeTab()) {
    let contents;
    // fix3: a tab whose page moves between a local file and the web gets a view in the matching session.
    if (tab.view && (Boolean(tab.viewLocal) !== Boolean(tab.localRoot) || (tab.localRoot && tab.viewRoot !== tab.localRoot))) { destroyTab(tab); tab.closed = false; }
    try { contents = ensureView(tab); await (tab.viewLocal ? localSessionReady : sessionReady); }
    catch (error) { return publish({ loading: false, error: error?.message || '浏览器暂时不可用。' }, tab); }
    const sequence = ++tab.loadSequence;
    beginHostNavigation(tab, url);
    publish({ url: url === 'about:blank' ? '' : url, title: '', loading: url !== 'about:blank', error: null }, tab);
    void contents.loadURL(url).catch(error => {
      if (sequence === tab.loadSequence) { tab.hostNavigation = null; tab.historyTravel = null; }
      if (tabAlive(tab) && sequence === tab.loadSequence && error?.code !== 'ERR_ABORTED' && error?.errno !== -3) {
        publish({ loading: false, error: '网页未能加载，请检查网址和网络后重试。' }, tab);
      }
    });
    return getState();
  }

  async function navigate(input) {
    if (!alive()) return unavailableState();
    const tab = activeTab();
    let url;
    try { url = normalizeBrowserInput(input, appOrigin); }
    catch (error) {
      ++tab.loadSequence;
      guest(tab)?.stop();
      return publish({ loading: false, error: error.message }, tab);
    }
    if (!url) return home();
    try {
      await prepareNavigation(tab, url);
      return load(url, tab);
    } catch (error) {
      ++tab.loadSequence;
      guest(tab)?.stop();
      return publish({ loading: false, error: error?.message || '此地址不能在内置浏览器中打开。' }, tab);
    }
  }

  function createTab(url, activate = true, inheritedRoot = null, inheritedPrivate = null) {
    if (!alive()) return unavailableState();
    if (tabs.length >= MAX_BROWSER_TABS) return { ...getState(), error: '最多同时打开 32 个浏览器标签页。' };
    const tab = makeTab();
    tab.localRoot = inheritedRoot;
    if (inheritedPrivate) for (const origin of inheritedPrivate) tab.privateOrigins.add(origin);
    tabs.push(tab);
    if (activate) activeTabId = tab.id;
    emitState();
    return url ? load(url, tab) : getState();
  }

  async function newTab(input) {
    if (!alive()) return unavailableState();
    let url;
    try { url = input === undefined ? 'about:blank' : normalizeBrowserInput(input, appOrigin) || 'about:blank'; }
    catch (error) { return { ...getState(), error: error.message }; }
    if (tabs.length >= MAX_BROWSER_TABS) return { ...getState(), error: '最多同时打开 32 个浏览器标签页。' };
    const tab = makeTab();
    tabs.push(tab);
    activeTabId = tab.id;
    emitState();
    try { await prepareNavigation(tab, url); }
    catch (error) { return publish({ loading: false, error: error?.message || '此地址已阻止。' }, tab); }
    if (tabAlive(tab)) await load(url, tab);
    return getState();
  }

  function activateTab(id) {
    if (!alive()) return unavailableState();
    if (!findTab(id)) return { ...getState(), error: '找不到这个浏览器标签页。' };
    activeTabId = id;
    return emitState();
  }

  function destroyTab(tab) {
    tab.closed = true;
    ++tab.loadSequence;
    tab.committedUrl = '';
    tab.hostNavigation = null;
    clearTimeout(tab.fitTimer);
    tab.fitTimer = undefined;
    hideTab(tab);
    for (const remove of tab.listeners.splice(0)) remove();
    // 1.4.4: closing a tab no longer cancels the downloads it started.
    if (tab.view) {
      try { if (!window.isDestroyed()) window.contentView.removeChildView(tab.clipView ?? tab.view); } catch { /* Window is closing. */ }
      const contents = guest(tab);
      if (contents) contents.close({ waitForBeforeUnload: false });
      tab.view = undefined;
      tab.clipView = undefined;
    }
  }

  function closeTab(id) {
    if (!alive()) return unavailableState();
    const tab = findTab(id);
    if (!tab) return { ...getState(), error: '找不到这个浏览器标签页。' };
    const index = tabs.indexOf(tab);
    const wasActive = id === activeTabId;
    rememberClosed(tab);
    destroyTab(tab);
    tabs.splice(index, 1);
    if (!tabs.length) tabs.push(makeTab());
    if (wasActive) activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
    return emitState();
  }

  // A closed page keeps only its address; blank tabs are not worth restoring.
  function rememberClosed(tab) {
    if (!tab.page.url) return;
    closedTabs.push({ url: tab.page.url, localRoot: tab.localRoot, privateOrigins: [...(tab.privateOrigins ?? [])] });
    if (closedTabs.length > MAX_CLOSED_TABS) closedTabs.shift();
  }

  function reopenTab() {
    if (!alive()) return unavailableState();
    const entry = closedTabs.pop();
    if (!entry) return { ...getState(), error: '没有可以重新打开的标签页。' };
    const url = typeof entry === 'string' ? entry : entry.url;
    if (!browserUrlAllowed(url, appOrigin)) return { ...getState(), error: '这个标签页的地址已不能在内置浏览器中打开。' };
    return createTab(url, true, typeof entry === 'string' ? null : entry.localRoot, typeof entry === 'string' ? null : entry.privateOrigins);
  }

  function home() {
    if (!alive()) return unavailableState();
    const tab = activeTab();
    if (!guest(tab)) return publish(emptyPage(), tab);
    return load('about:blank', tab);
  }

  async function travel(direction) {
    const tab = activeTab();
    if (!tabAlive(tab)) return getState();
    const index = tab.historyIndex + (direction === 'back' ? -1 : 1);
    const entry = tab.historyEntries[index];
    if (!entry) return getState();
    const sequence = ++tab.navigationSequence;
    try { await prepareNavigation(tab, entry.url); }
    catch (error) { return publish({ loading: false, error: error?.message || '此地址已阻止。' }, tab); }
    if (!tabAlive(tab) || tab.navigationSequence !== sequence) return getState();
    if (entry.localRoot && isLocalFileUrl(entry.url)) tab.localRoot = entry.localRoot;
    const contents = guest(tab);
    const native = contents?.navigationHistory;
    if (contents && Boolean(tab.viewLocal) === Boolean(tab.localRoot) && entry.viewGeneration === tab.viewGeneration
      && native.getEntryAtIndex(entry.nativeIndex)?.url === entry.url) {
      tab.historyTravel = index;
      beginHostNavigation(tab, entry.url);
      native.goToIndex(entry.nativeIndex);
      return publish();
    }
    // Do not import network entries into the offline session. Recreate only the target
    // view and replay the selected host entry; the other direction remains available.
    tab.historyTravel = index;
    await load(entry.url, tab);
    return getState();
  }

  function reload() {
    const tab = activeTab();
    const contents = guest(tab);
    if (!contents) return publish();
    const url = contents.getURL();
    if (!url || url === 'about:blank') return publish();
    tab.historyTravel = tab.historyIndex >= 0 ? tab.historyIndex : null;
    beginHostNavigation(tab, url);
    contents.reload();
    return publish({ error: null }, tab);
  }

  /**
   * 1.4.1: drop everything the current page stored and load it again, so a site
   * stuck on stale data (a dead service worker, an old cookie) can be reset
   * without wiping the rest of the browser. Scoped to that site only.
   */
  async function clearSiteData() {
    const tab = activeTab();
    const contents = guest(tab);
    if (!alive() || !contents) return { ...getState(), error: '内置浏览器暂时不可用。' };
    const url = contents.getURL();
    if (!url || url === 'about:blank' || isLocalFileUrl(url)) return { ...getState(), error: '当前页面没有可清除的网站数据。' };
    let origin;
    try { origin = new URL(url).origin; } catch { return { ...getState(), error: '无法识别当前网页的地址。' }; }
    try {
      await contents.session.clearData({ origins: [origin], originMatchingMode: 'origin-in-all-contexts' });
    } catch {
      return { ...getState(), error: '清除本站数据失败，请稍后重试。' };
    }
    tab.historyTravel = tab.historyIndex >= 0 ? tab.historyIndex : null;
    beginHostNavigation(tab, url);
    contents.reloadIgnoringCache();
    return publish({ error: null }, tab);
  }

  function stop() {
    const tab = activeTab();
    if (tab) { tab.hostNavigation = null; tab.historyTravel = null; tab.navigationSequence++; }
    guest(tab)?.stop();
    return publish(tab ? { loading: false, url: tab.committedUrl === 'about:blank' ? '' : tab.committedUrl } : undefined, tab);
  }

  function waitForLoad(contents, timeoutMs) {
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        contents.off('did-stop-loading', done);
        contents.off('did-fail-load', done);
        contents.off('destroyed', done);
        resolve();
      };
      contents.once('did-stop-loading', done);
      contents.once('did-fail-load', done);
      contents.once('destroyed', done);
      timer = setTimeout(done, timeoutMs);
      timer.unref?.();
    });
  }

  /** Read the active page's rendered text for the model. Waits for a loading page on request. */
  async function readPage(timeoutMs = 0) {
    const tab = activeTab();
    const contents = guest(tab);
    const empty = { url: '', title: '', text: '', links: [], truncated: false, error: null };
    if (!alive() || !contents) return { ...empty, error: '内置浏览器暂时不可用。' };
    if (!tab.page.url) return { ...empty, error: '内置浏览器当前没有打开的网页。' };
    const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.floor(timeoutMs), 60_000) : 0;
    if (wait && contents.isLoading()) await waitForLoad(contents, wait);
    let raw;
    try { raw = await contents.executeJavaScript(READ_PAGE_SCRIPT, false); }
    catch { raw = null; }
    if (!raw || typeof raw !== 'object') return { ...empty, url: tab.page.url, error: '无法读取这个页面的内容，请重新加载后再试。' };
    if (typeof raw.error === 'string' && raw.error) return { ...empty, url: tab.page.url, error: raw.error.slice(0, 500) };
    const full = typeof raw.text === 'string' ? raw.text : '';
    let text = full.slice(0, MAX_PAGE_TEXT);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const links = Array.isArray(raw.links) ? raw.links.slice(0, MAX_PAGE_LINKS).filter(link => link && typeof link.url === 'string' && link.url).map(link => ({ text: String(link.text ?? '').slice(0, 200), url: link.url.slice(0, 4096) })) : [];
    return {
      url: typeof raw.url === 'string' && raw.url ? raw.url.slice(0, 4096) : tab.page.url,
      title: (typeof raw.title === 'string' ? raw.title : tab.page.title).slice(0, 512),
      text, links, truncated: full.length > MAX_PAGE_TEXT, error: null,
    };
  }

  function setViewport(value) {
    if (!alive()) return unavailableState();
    if (!resolveNativeBrowserLayout(value, window.getContentBounds(), main.getZoomFactor())) return { ...getState(), error: '浏览器显示区域无效。' };
    const requested = { ...value, ...(value.clip ? { clip: { ...value.clip } } : {}), ...(value.emulation ? { emulation: { ...value.emulation } } : {}) };
    if (!requested.visible) hiddenReason = (activeTab()?.automating ?? 0) > 0 ? '代理操作期间浏览器面板被收起（切换会话、折叠面板或切换右侧标签）' : '浏览器面板已被收起，或右侧切换到了其他面板';
    viewport = requested;
    lastRequested = requested;
    applyViewport();
    scheduleFit(activeTab(), 400);
    if (state.desktopZoomFactor !== main.getZoomFactor()) publishGlobal({ desktopZoomFactor: main.getZoomFactor() });
    return getState();
  }

  function setPresentation(value) {
    if (!alive()) return unavailableState();
    const presentation = normalizePresentation(value);
    if (!presentation) return { ...getState(), error: '浏览器显示设置无效。' };
    try { savePresentation(presentationPath, presentation); }
    catch { return { ...getState(), error: '无法保存浏览器显示设置。' }; }
    return publishGlobal({ presentation });
  }

  async function openExternal() {
    const url = activeTab()?.page.url;
    if (!alive() || typeof openExternalUrl !== 'function' || !browserUrlAllowed(url, appOrigin)) return getState();
    await openExternalUrl(url);
    return getState();
  }

  function openDevTools() {
    const contents = guest();
    // 1.4.1: our own debugging connection and the DevTools window both attach to
    // the same page, and only one can. Release ours first so the window always opens.
    if (contents) releaseDebugger(contents);
    if (alive() && contents && browserUrlAllowed(activeTab()?.page.url, appOrigin)) contents.openDevTools({ mode: 'detach', activate: true });
    return getState();
  }

  async function open(url) {
    if (!alive() || (url !== undefined && !browserUrlAllowed(url, appOrigin))) return getState();
    publishGlobal({ openRequested: state.openRequested + 1 });
    if (url === undefined) { await waitVisible(4_000); return getState(); }
    const blank = tabs.find(tab => !tab.page.url && !guest(tab));
    const tab = blank ?? makeTab();
    if (!blank) tabs.push(tab);
    activeTabId = tab.id;
    try { await prepareNavigation(tab, url); return load(url, tab); }
    catch (error) { return publish({ loading: false, error: error?.message || '此地址不能在内置浏览器中打开。' }, tab); }
  }

  /**
   * The page is untrusted, so every field is bounded and the ref must be one this
   * app generated before it can be used in a script or an input event.
   */
  function snapshotElement(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.ref !== 'string' || !REF_PATTERN.test(value.ref)) return null;
    const text = (input, max) => typeof input === 'string' ? input.slice(0, max) : '';
    const integer = input => Number.isInteger(input) && Math.abs(input) <= 200_000 ? input : 0;
    const element = {
      ref: value.ref,
      role: text(value.role, 40),
      tag: text(value.tag, 20),
      name: text(value.name, 120),
      x: integer(value.x), y: integer(value.y),
      width: Math.max(0, integer(value.width)), height: Math.max(0, integer(value.height)),
    };
    if (value.disabled === true) element.disabled = true;
    if (value.checked === true) element.checked = true;
    if (value.inViewport === false) element.inViewport = false;
    const context = text(value.context, 80);
    if (context) element.context = context;
    if (value.modal === true) element.modal = true;
    if (value.frame === true) element.frame = true;
    if (value.shadow === true) element.shadow = true;
    if (Number.isInteger(value.nth) && value.nth > 0 && value.nth < 1000) element.nth = value.nth;
    if (Number.isInteger(value.duplicates) && value.duplicates > 1 && value.duplicates < 1000) element.duplicates = value.duplicates;
    const type = text(value.type, 20);
    if (type) element.type = type;
    const current = text(value.value, 120);
    if (current) element.value = current;
    if (Array.isArray(value.options)) {
      element.options = value.options.slice(0, 40).filter(option => option && typeof option === 'object' && !Array.isArray(option))
        .map(option => ({ value: text(option.value, 120), label: text(option.label, 120), selected: option.selected === true }));
    }
    return element;
  }

  /** Read the interactive surface of the page: refs, roles, names and rectangles. */
  async function snapshot() {
    const tab = activeTab();
    const contents = guest(tab);
    const empty = { url: '', title: '', viewport: null, elements: [], truncated: false, error: null };
    if (!alive() || !contents) return { ...empty, error: '内置浏览器暂时不可用。' };
    if (!tab.page.url) return { ...empty, error: '内置浏览器当前没有打开的网页。' };
    if (contents.isLoading()) await waitForLoad(contents, 5_000);
    let raw;
    try { raw = await contents.executeJavaScript(SNAPSHOT_PAGE_SCRIPT, false); }
    catch { raw = null; }
    if (!raw || typeof raw !== 'object') return { ...empty, url: tab.page.url, error: '无法读取这个页面的结构，请重新加载后再试。' };
    if (typeof raw.error === 'string' && raw.error) return { ...empty, url: tab.page.url, error: raw.error.slice(0, 500) };
    const viewportInfo = raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {};
    const text = (input, max) => typeof input === 'string' ? input.slice(0, max) : '';
    const number = (input, fallback) => Number.isInteger(input) && Math.abs(input) <= 10_000_000 ? input : fallback;
    const elements = (Array.isArray(raw.elements) ? raw.elements : []).slice(0, MAX_SNAPSHOT_ELEMENTS).map(snapshotElement).filter(Boolean);
    return {
      url: typeof raw.url === 'string' && raw.url ? raw.url.slice(0, 4096) : tab.page.url,
      title: (typeof raw.title === 'string' ? raw.title : tab.page.title).slice(0, 512),
      viewport: {
        width: number(viewportInfo.width, 0), height: number(viewportInfo.height, 0),
        scrollX: number(viewportInfo.scrollX, 0), scrollY: number(viewportInfo.scrollY, 0),
        scrollWidth: number(viewportInfo.scrollWidth, 0), scrollHeight: number(viewportInfo.scrollHeight, 0),
      },
      elements, truncated: raw.truncated === true, error: null,
      scroll: raw.scroll && typeof raw.scroll === 'object' ? {
        container: raw.scroll.container === 'window' ? 'window' : text(raw.scroll.container?.name || raw.scroll.container?.tag, 80) || 'element',
        scrollTop: number(raw.scroll.scrollTop, 0), scrollHeight: number(raw.scroll.scrollHeight, 0), clientHeight: number(raw.scroll.clientHeight, 0),
      } : null,
      modal: raw.modal && typeof raw.modal === 'object' ? { name: text(raw.modal.name, 120), elements: number(raw.modal.elements, 0) } : null,
      pendingInputs: pendingList(tab),
      visible: Boolean(inputArea), hiddenReason: describeHidden(),
    };
  }

  /**
   * Capture the page as an image for the model.
   *
   * capturePage() photographs the guest's own surface, so what the model receives is what the
   * reader sees: a chart, a layout, a rendered canvas. The bitmap is bounded here rather than
   * later, because an image is a base64 payload on every request that carries it.
   */
  const debuggerSessions = new WeakMap();
  const debuggerTimers = new Set();

  function debuggerSessionFor(contents) {
    let session = debuggerSessions.get(contents);
    if (session) return session;
    session = createDebuggerSession({
      isAttached: () => contents.debugger.isAttached(),
      attach: () => contents.debugger.attach('1.3'),
      detach: () => contents.debugger.detach(),
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        debuggerTimers.add(timer);
        return { cancel: () => { clearTimeout(timer); debuggerTimers.delete(timer); } };
      },
    });
    debuggerSessions.set(contents, session);
    return session;
  }

  function releaseDebugger(contents) {
    debuggerSessions.get(contents)?.release();
    debuggerSessions.delete(contents);
  }

  async function captureLiveHidden(contents) {
    if (!nativeImage || !contents.debugger) return null;
    let timer;
    try {
      const capture = debuggerSessionFor(contents).run(() => contents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      }));
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Hidden capture timeout')), 2_000);
        timer.unref?.();
      });
      const result = await Promise.race([capture, deadline]);
      return result?.data ? nativeImage.createFromBuffer(Buffer.from(result.data, 'base64')) : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  async function captureOffscreen(tab, contents) {
    if (!BrowserWindow) return null;
    const area = lastRequested?.clip ?? lastRequested;
    const width = Math.round(Math.min(1600, Math.max(320, Number(tab.viewWidth) || Number(area?.width) || 1280)));
    const height = Math.round(Math.min(1600, Math.max(320, Number(area?.height) || 900)));
    let scroll = { x: 0, y: 0 };
    try {
      const value = await contents.executeJavaScript('({ x: scrollX, y: scrollY })', false);
      if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) scroll = value;
    } catch { /* Start at the top. */ }
    const shot = new BrowserWindow({
      show: false, width, height, useContentSize: true, frame: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true, session: tab.viewLocal ? ensureLocalSession() : ensureSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, javascript: true,
        disableDialogs: true, backgroundThrottling: false, devTools: false, spellcheck: false,
        disableBlinkFeatures: 'DirectSockets,WebTransport',
      },
    });
    const view = shot.webContents;
    const captureTab = { view: { webContents: view }, viewLocal: tab.viewLocal, localRoot: tab.localRoot, privateOrigins: new Set(), hostNavigation: null };
    if (restrictedAddress(contents.getURL()) && privateAllowedFrom(tab, contents.getURL(), frameOrigin(contents.mainFrame))) captureTab.privateOrigins.add(originFor(contents.getURL()));
    beginHostNavigation(captureTab, contents.getURL());
    captureGuests.add(captureTab);
    let painted = null;
    let loadTimer;
    try {
      hardenGuest(view, { local: tab.viewLocal });
      await (tab.viewLocal ? localSessionReady : sessionReady);
      view.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.on('will-navigate', event => event.preventDefault());
      view.on('will-redirect', event => { if (!browserUrlAllowed(event.url, appOrigin)) event.preventDefault(); });
      view.on('paint', (_event, _dirty, image) => { if (!image.isEmpty()) painted = image; });
      view.setFrameRate(30);
      if (contents.getZoomFactor() > 0) view.setZoomFactor(tab.emulationActive ? 1 : contents.getZoomFactor());
      const loaded = view.loadURL(contents.getURL());
      const timeout = new Promise((_resolve, reject) => { loadTimer = setTimeout(() => reject(new Error('offscreen load timeout')), 15_000); loadTimer.unref?.(); });
      await Promise.race([loaded, timeout]);
      clearTimeout(loadTimer);
      if (scroll.x || scroll.y) await view.executeJavaScript(`scrollTo(${Math.round(scroll.x)}, ${Math.round(scroll.y)})`, false).catch(() => {});
      // Let late layout, fonts and images settle, then force a fresh frame.
      await new Promise(resolve => { const t = setTimeout(resolve, 450); t.unref?.(); });
      view.invalidate();
      await new Promise(resolve => { const t = setTimeout(resolve, 200); t.unref?.(); });
      let image = await view.capturePage().catch(() => null);
      if (!image || image.isEmpty()) image = painted;
      return image && !image.isEmpty() ? image : null;
    } finally {
      clearTimeout(loadTimer);
      captureGuests.delete(captureTab);
      if (!shot.isDestroyed()) shot.destroy();
    }
  }

  async function captureScreenshot() {
    const tab = activeTab();
    const contents = guest(tab);
    if (!alive() || !contents) return { ok: false, error: '内置浏览器暂时不可用。' };
    if (!tab.page.url) return { ok: false, error: '内置浏览器当前没有打开的网页。' };
    try {
      if (contents.isLoading()) await waitForLoad(contents, 8_000);
      const onScreen = Boolean(inputArea) && window.isVisible() && !window.isMinimized();
      let image = null;
      if (!onScreen) {
        try {
          contents.invalidate();
          image = await contents.capturePage(undefined, { stayAwake: true });
        } catch { image = null; }
      }
      if (onScreen) {
        try {
          contents.invalidate();
          image = await contents.capturePage();
          if (image.isEmpty()) {
            await new Promise(resolve => setTimeout(resolve, 250));
            contents.invalidate();
            image = await contents.capturePage();
          }
        } catch { image = null; }
      }
      // Capture the live document first, including form/canvas/DOM state, even while hidden.
      // A fresh offscreen renderer remains available if Chromium cannot capture that surface.
      if (!image || image.isEmpty()) image = await captureLiveHidden(contents);
      if (!image || image.isEmpty()) image = await captureOffscreen(tab, contents);
      if (!image || image.isEmpty()) return { ok: false, error: '截屏为空；页面可能还没有完成绘制，请稍后重试。' };
      const size = image.getSize();
      // Keep the long edge within a sane limit: the model does not gain detail from a
      // larger bitmap, and every later request in the turn re-sends these bytes.
      const scale = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(size.width, size.height, 1));
      if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' });
      const png = image.toPNG();
      if (!png.length || png.length > MAX_SCREENSHOT_BYTES) {
        return { ok: false, error: '截屏图片超出大小限制，请缩小浏览器窗口后重试。' };
      }
      const final = image.getSize();
      return {
        ok: true,
        result: {
          url: contents.getURL().slice(0, 4096),
          title: String(contents.getTitle() || '').slice(0, 512),
          width: final.width, height: final.height,
          bytes: png.length,
          mime: 'image/png',
          image: `data:image/png;base64,${png.toString('base64')}`,
        },
      };
    } catch (error) {
      const text = error && error.message ? String(error.message) : String(error ?? '');
      return { ok: false, error: text.slice(0, 500) || '内置浏览器未能完成截屏。' };
    }
  }

  /**
   * Perform one real user input. The ref is resolved inside the page immediately
   * before the event is dispatched, so a click never lands where a re-rendering
   * framework has already moved the element.
   */
  function pendingList(tab) {
    if (!tab?.pendingInputs?.size) return [];
    if (tab.pendingInputsUrl && tab.pendingInputsUrl !== tab.page.url) { tab.pendingInputs.clear(); return []; }
    return [...tab.pendingInputs.values()].slice(0, 10);
  }
  function pendingText(list) {
    if (!list.length) return '';
    const items = list.map(item => `${item.ref} ${item.role || ''}“${String(item.name || '').slice(0, 30)}”${item.context ? `（${item.context.slice(0, 30)}）` : ''}${item.hidden ? '' : ` = “${String(item.value).slice(0, 60)}”`}`).join('；');
    return ` 注意：页面上还有未提交的输入：${items}。这些值只是填进了输入框，尚未通过点击保存/提交生效；请先让面板显示后完成提交，或告诉用户这些修改没有生效（不要根据输入框里显示的值判断已生效）。`;
  }

  async function act(request) {
    const tab = activeTab();
    const contents = guest(tab);
    if (!alive() || !contents) return { ok: false, error: '内置浏览器暂时不可用。' };
    if (!tab.page.url) return { ok: false, error: '内置浏览器当前没有打开的网页。' + pendingText(pendingList(tab)) };
    try {
      const normalized = normalizeRequest(request);
      if (contents.isLoading()) await waitForLoad(contents, 5_000);
      // 1.4.1-browserfix: one rule for every input action. Real input needs the panel on
      // screen, so bring it up first and only refuse when it truly cannot be shown.
      if (!inputArea) {
        const shown = await ensureVisible(4_000);
        if (!shown.visible) {
          return { ok: false, error: `内置浏览器面板当前没有显示（原因：${shown.reason || '未知'}），已尝试自动打开但没有成功，本次 ${normalized.kind} 没有执行。请让用户展开右侧浏览器面板后重试。` + pendingText(pendingList(tab)) };
        }
      }
      const input = createBrowserInput({
        bounds: inputArea?.bounds ?? { width: 0, height: 0 },
        visible: inputArea?.visible,
        evaluate: script => contents.executeJavaScript(script, false),
        sendInput: event => contents.sendInputEvent(event),
        insertText: text => contents.insertText(text),
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      tab.automating = (tab.automating ?? 0) + 1;
      let result;
      try { result = await input[normalized.kind](normalized); }
      finally { setTimeout(() => { tab.automating = Math.max(0, (tab.automating ?? 1) - 1); }, 250).unref?.(); }
      const url = contents.getURL().slice(0, 4096);
      if (!tab.pendingInputs || tab.pendingInputsUrl !== url) { tab.pendingInputs = new Map(); tab.pendingInputsUrl = url; }
      if (normalized.kind === 'type') {
        if (result.submitted || !result.stillPresent) tab.pendingInputs.delete(normalized.ref);
        else tab.pendingInputs.set(normalized.ref, { ref: normalized.ref, role: result.target?.role ?? '', name: result.target?.name ?? '', context: result.target?.context ?? '', value: result.valueAfter ?? normalized.text, hidden: result.valueHidden === true });
      } else if (normalized.kind === 'press' && normalized.text !== undefined && result.focusedElement?.ref) {
        tab.pendingInputs.set(result.focusedElement.ref, { ref: result.focusedElement.ref, role: result.focusedElement.role, name: result.focusedElement.name, context: result.focusedElement.context ?? '', value: normalized.text });
      } else if (normalized.kind === 'press' && normalized.keys.some(key => key.key === 'Return')) {
        tab.pendingInputs.clear();
      }
      // A click may well be the submit; keep the list but let the model know to verify.
      return { ok: true, result: { ...result, url, pendingInputs: pendingList(tab) } };
    } catch (error) {
      const text = error && error.message ? String(error.message) : String(error ?? '');
      return { ok: false, error: (text.slice(0, 400) || '内置浏览器未能完成这个操作。') + pendingText(pendingList(tab)) };
    }
  }

  /** The panel's real visibility, for browser_open and the model. */
  async function visibility(timeoutMs) {
    const result = await waitVisible(Number.isFinite(timeoutMs) ? timeoutMs : 4_000);
    return { ...getState(), visible: result.visible, hiddenReason: result.reason };
  }

  // ---- 1.4.4: downloads with real progress, cancellation and "show in folder" ----
  function downloadFolder() {
    return typeof downloadsDirectory === 'string' && downloadsDirectory ? downloadsDirectory : '';
  }

  function uniqueDownloadTarget(directory, filename) {
    if (!directory) return '';
    const base = downloadName(filename);
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : '';
    const stem = dot > 0 ? base.slice(0, dot) : base;
    let candidate = path.join(directory, base);
    for (let index = 1; index < 10_000 && fs.existsSync(candidate); index += 1) {
      candidate = path.join(directory, `${stem} (${index})${ext}`);
    }
    return candidate;
  }

  function downloadSnapshot() {
    return [...downloads.values()].map(record => ({ ...record }));
  }

  function publishDownloads(immediate = false) {
    if (disposed) return;
    const flush = () => {
      downloadTimer = null;
      if (disposed) return;
      try { main.send(BROWSER_DOWNLOADS_CHANNEL, { downloads: downloadSnapshot() }); } catch { /* Renderer may be reloading. */ }
    };
    if (immediate) {
      if (downloadTimer) { clearTimeout(downloadTimer); downloadTimer = null; }
      flush();
      return;
    }
    if (downloadTimer) return;
    downloadTimer = setTimeout(flush, 250);
    downloadTimer.unref?.();
  }

  function downloadNotice(message) {
    if (disposed) return;
    try { main.send(BROWSER_DOWNLOADS_CHANNEL, { downloads: downloadSnapshot(), notice: String(message).slice(0, 200) }); } catch { /* Renderer may be reloading. */ }
  }

  function sampleDownload(record, item, state) {
    const received = Math.max(0, Number(item.getReceivedBytes?.() ?? 0));
    const total = Math.max(0, Number(item.getTotalBytes?.() ?? 0));
    const now = Date.now();
    const elapsed = now - (record.sampledAt ?? record.startedAt);
    if (elapsed >= 400) {
      const delta = received - (record.sampledBytes ?? 0);
      record.speed = delta > 0 ? Math.round(delta / (elapsed / 1000)) : 0;
      record.sampledAt = now;
      record.sampledBytes = received;
    }
    record.received = received;
    record.total = total;
    if (state) record.state = state;
  }

  /** 1.4.4: no native save dialog. A dialog could open behind the window and make the click
   *  look dead forever; the file goes into the Downloads folder under a free name instead. */
  function startDownload(item, owner) {
    const active = [...downloads.values()].filter(record => record.state === 'progressing').length;
    if (active >= MAX_ACTIVE_DOWNLOADS) return { ok: false, error: `同时下载的文件太多（最多 ${MAX_ACTIVE_DOWNLOADS} 个），已取消这一个。` };
    let savePath = '';
    try { savePath = uniqueDownloadTarget(downloadFolder(), item.getFilename()); } catch { savePath = ''; }
    if (!savePath) return { ok: false, error: '无法确定下载的保存位置（找不到“下载”文件夹），已取消这个下载。' };
    item.setSavePath(savePath);
    const record = {
      id: `d${++downloadSequence}`,
      name: downloadName(item.getFilename()),
      url: String(item.getURL() ?? '').slice(0, 2_048),
      savePath,
      state: 'progressing',
      received: 0,
      total: Math.max(0, Number(item.getTotalBytes?.() ?? 0)),
      speed: 0,
      startedAt: Date.now(),
      sampledAt: Date.now(),
      sampledBytes: 0,
      tabId: owner?.id ?? null,
      error: '',
    };
    downloads.set(item, record);
    item.on('updated', () => { sampleDownload(record, item); publishDownloads(); });
    item.once('done', (_event, state) => {
      sampleDownload(record, item, state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted');
      if (state === 'completed') { try { record.savePath = item.getSavePath() || record.savePath; } catch { /* keep the planned name. */ } }
      if (state === 'interrupted') record.error = '下载中断，可以重新下载。';
      publishDownloads(true);
    });
    publishDownloads(true);
    return { ok: true };
  }

  function findDownload(id) {
    if (typeof id !== 'string') return null;
    for (const [item, record] of downloads) if (record.id === id) return { item, record };
    return null;
  }

  function cancelDownload(id) {
    const found = findDownload(id);
    if (!found) return { ok: false, error: '找不到这个下载。' };
    try { found.item.cancel(); } catch { /* Already finished. */ }
    return { ok: true };
  }

  function revealDownload(id) {
    const target = findDownload(id)?.record.savePath;
    if (!target) return { ok: false, error: '这个下载还没有保存成文件。' };
    if (typeof revealDownloadPath !== 'function') return { ok: false, error: '当前无法打开文件所在位置。' };
    if (!fs.existsSync(target)) return { ok: false, error: '文件已经不在原来的位置（可能被移动或删除）。' };
    try { revealDownloadPath(target); return { ok: true }; } catch { return { ok: false, error: '无法打开文件所在位置。' }; }
  }

  function clearDownloads() {
    for (const [item, record] of [...downloads]) if (record.state !== 'progressing') downloads.delete(item);
    publishDownloads(true);
    return { ok: true };
  }

  const commands = { getState, visibility, navigate, newTab, activateTab, closeTab, reopenTab, back: () => travel('back'), forward: () => travel('forward'), reload, stop, readPage, snapshot, act, screenshot: captureScreenshot, home, setViewport, setPresentation, openExternal, openDevTools, clearSiteData };
  ipcMain.handle(BROWSER_COMMAND_CHANNEL, (event, command, ...args) => {
    const expectedArgs = ['navigate', 'setViewport', 'setPresentation', 'activateTab', 'closeTab', 'readPage', 'act', 'screenshot', 'visibility'].includes(command) ? 1 : 0;
    const validArgs = command === 'newTab' ? args.length <= 1 : command === 'screenshot' ? args.length <= 1 : args.length === expectedArgs;
    if (!alive() || event.sender !== main || event.senderFrame !== main.mainFrame || !ownUrl(event.senderFrame?.url)
      || typeof command !== 'string' || !Object.hasOwn(commands, command) || !validArgs) return unavailableState();
    return commands[command](...args);
  });
  ipcMain.handle(BROWSER_DOWNLOAD_COMMAND_CHANNEL, (event, action, id) => {
    if (!alive() || event.sender !== main || event.senderFrame !== main.mainFrame || !ownUrl(event.senderFrame?.url)) return { ok: false, error: "浏览器暂时不可用。" };
    if (action === 'cancel') return cancelDownload(id);
    if (action === 'reveal') return revealDownload(id);
    if (action === 'clear') return clearDownloads();
    return { ok: false, error: "未知的下载操作。" };
  });
  on(main, 'did-start-navigation', (event, _url, _inPlace, isMainFrame) => { if (event.isMainFrame ?? isMainFrame) hideForRendererChange(); });
  on(main, 'render-process-gone', () => hideForRendererChange('应用界面进程崩溃'));
  on(main, 'did-start-loading', () => hideForRendererChange('应用界面正在重新加载'));
  on(main, 'did-stop-loading', applyViewport);
  on(window, 'resize', windowResized);
  on(window, 'moved', settleAfterWindowChange);
  on(window, 'minimize', () => hideForRendererChange('应用窗口已最小化'));
  on(window, 'restore', resumeAfterWindowState);
  on(window, 'show', resumeAfterWindowState);
  on(main, 'zoom-changed', () => { hideForRendererChange('界面缩放正在变化'); settleAfterWindowChange(); scheduleFit(activeTab(), 300); });
  on(window, 'closed', dispose);

  function dispose() {
    if (disposed) return;
    disposed = true;
    networkPolicy.close();
    void offlineProxy.close();
    clearTimeout(windowSettleTimer);
    ipcMain.removeHandler(BROWSER_COMMAND_CHANNEL);
    ipcMain.removeHandler(BROWSER_DOWNLOAD_COMMAND_CHANNEL);
    if (downloadTimer) { clearTimeout(downloadTimer); downloadTimer = null; }
    for (const remove of listeners.splice(0)) remove();
    for (const tab of tabs) destroyTab(tab);
    tabs.length = 0;
    activeTabId = null;
    // Keep the root request blocker until all guests have closed. Cookies remain
    // in the browser's dedicated persistent session, separate from the app UI.
  }

  return { ...commands, open, dispose, authorizeToolNavigation, getWebContents: id => guest(id === undefined ? activeTab() : findTab(id) ?? null) };
}


