/**
 * Harness Gemini UI - Built-in Multi-Tab Browser Panel, Responsive Viewport Emulation
 * & Desktop Browser Bridge
 * License: MIT
 */

import {
  React,
  jsx,
  jsxs,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Earth,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  GripHorizontal,
  GripVertical,
  LoaderCircle,
  PanelRightClose,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
} from '../vendor/vendor-deps.js';

export const VIEWPORT_LIMITS = Object.freeze({
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
});

export const ZOOM_PRESETS = Object.freeze(['fit', '50', '75', '100', '125', '150', '200']);

export const DEFAULT_PRESENTATION = Object.freeze({
  mode: 'normal',
  viewport: Object.freeze({ width: 393, height: 852 }),
  zoom: 'fit',
});

const PRESENTATION_STORAGE_KEY = 'harness.browser.presentation.v1';
const MAX_ADDRESS_LENGTH = 4096;
const MAX_CLOSED_HISTORY = 10;

const RESIZE_HANDLES = [
  { id: 'left', widthDirection: -1, heightDirection: 0, orientation: 'vertical' },
  { id: 'right', widthDirection: 1, heightDirection: 0, orientation: 'vertical' },
  { id: 'top', widthDirection: 0, heightDirection: -1, orientation: 'horizontal' },
  { id: 'bottom', widthDirection: 0, heightDirection: 1, orientation: 'horizontal' },
  { id: 'top-left', widthDirection: -1, heightDirection: -1 },
  { id: 'top-right', widthDirection: 1, heightDirection: -1 },
  { id: 'bottom-left', widthDirection: -1, heightDirection: 1 },
  { id: 'bottom-right', widthDirection: 1, heightDirection: 1 },
];

export function isValidViewportDimension(dimension, value) {
  return (
    Number.isInteger(value) &&
    (dimension === 'width'
      ? value >= VIEWPORT_LIMITS.minWidth && value <= VIEWPORT_LIMITS.maxWidth
      : dimension === 'height' &&
        value >= VIEWPORT_LIMITS.minHeight &&
        value <= VIEWPORT_LIMITS.maxHeight)
  );
}

export function normalizeBrowserPresentation(raw) {
  if (
    !raw ||
    !['normal', 'responsive'].includes(raw.mode) ||
    !ZOOM_PRESETS.includes(raw.zoom) ||
    !isValidViewportDimension('width', raw.viewport?.width) ||
    !isValidViewportDimension('height', raw.viewport?.height)
  ) {
    return null;
  }
  return {
    mode: raw.mode,
    viewport: {
      width: raw.viewport.width,
      height: raw.viewport.height,
    },
    zoom: raw.zoom,
  };
}

function sanitizePositiveScale(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function computeVisualScale({ canvasSize, desktopZoomFactor = 1, viewportSize, zoom }) {
  if (zoom !== 'fit' && ZOOM_PRESETS.includes(zoom)) {
    return Number(zoom) / 100;
  }
  if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) return 1;
  const dpr = sanitizePositiveScale(desktopZoomFactor);
  const availWidth = Math.max(0, canvasSize.width - 32) * dpr;
  const availHeight = Math.max(0, canvasSize.height - 32) * dpr;
  if (!availWidth || !availHeight || !viewportSize?.width || !viewportSize?.height) return 1;
  return Math.min(1, availWidth / viewportSize.width, availHeight / viewportSize.height);
}

function computeRendererScale({ desktopZoomFactor, visualScale }) {
  return visualScale / sanitizePositiveScale(desktopZoomFactor);
}

function clampViewportSize(size) {
  const numOrFallback = (val, fallback) => (Number.isFinite(val) ? val : fallback);
  return {
    width: Math.min(
      VIEWPORT_LIMITS.maxWidth,
      Math.max(
        VIEWPORT_LIMITS.minWidth,
        Math.round(numOrFallback(size.width, DEFAULT_PRESENTATION.viewport.width)),
      ),
    ),
    height: Math.min(
      VIEWPORT_LIMITS.maxHeight,
      Math.max(
        VIEWPORT_LIMITS.minHeight,
        Math.round(numOrFallback(size.height, DEFAULT_PRESENTATION.viewport.height)),
      ),
    ),
  };
}

function computeDraggedViewport({
  startSize,
  deltaX,
  deltaY,
  widthDirection,
  heightDirection,
  rendererScale,
}) {
  const scale = sanitizePositiveScale(rendererScale);
  return clampViewportSize({
    width: startSize.width + (deltaX / scale) * widthDirection,
    height: startSize.height + (deltaY / scale) * heightDirection,
  });
}

function computeKeyboardViewport({ size, key, shiftKey, widthDirection, heightDirection }) {
  const step = shiftKey ? 10 : 1;
  if (widthDirection && ['ArrowLeft', 'ArrowRight'].includes(key)) {
    return clampViewportSize({
      ...size,
      width: size.width + (key === 'ArrowRight' ? step : -step) * widthDirection,
    });
  }
  if (heightDirection && ['ArrowUp', 'ArrowDown'].includes(key)) {
    return clampViewportSize({
      ...size,
      height: size.height + (key === 'ArrowDown' ? step : -step) * heightDirection,
    });
  }
  return null;
}

function computeClippedBounds({ rect, clientWidth, clientHeight, clientLeft = 0, clientTop = 0 }) {
  return {
    x: rect.x + clientLeft,
    y: rect.y + clientTop,
    width: Math.max(0, Math.min(clientWidth, rect.width - clientLeft)),
    height: Math.max(0, Math.min(clientHeight, rect.height - clientTop)),
  };
}

function rectsIntersect(a, b) {
  return Boolean(
    a &&
      b &&
      a.width > 0 &&
      a.height > 0 &&
      b.width > 0 &&
      b.height > 0 &&
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y,
  );
}

const effectivePort = (parsedUrl) =>
  parsedUrl.port || (['https:', 'wss:'].includes(parsedUrl.protocol) ? '443' : '80');

function normalizeLocalFileUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const trimmed = input.trim().replace(/\\/g, '/');
  let parsed;
  if (/^file:/i.test(trimmed)) {
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.hostname && parsed.hostname !== 'localhost') return null;
  } else if (/^[a-zA-Z]:\//.test(trimmed)) {
    try {
      parsed = new URL(`file:///${trimmed}`);
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('//')) {
    return null;
  } else if (trimmed.startsWith('/')) {
    try {
      parsed = new URL(`file://${trimmed}`);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (
    parsed.protocol !== 'file:' ||
    parsed.username ||
    parsed.password ||
    (parsed.hostname && parsed.hostname !== 'localhost')
  ) {
    return null;
  }
  return parsed.href;
}

function isSafeLocalFileUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'file:' &&
      !parsed.username &&
      !parsed.password &&
      (!parsed.hostname || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function isAllowedBrowserTarget(url, appOrigin, { resource = false, blank = false } = {}) {
  if (typeof url !== 'string' || url.length > (resource ? 2097152 : MAX_ADDRESS_LENGTH)) {
    return false;
  }
  if (url === 'about:blank') return blank || resource;
  if (isSafeLocalFileUrl(url)) return true;

  try {
    const parsed = new URL(url);
    if (resource && parsed.protocol === 'data:') return true;
    if (resource && parsed.protocol === 'blob:') {
      return isAllowedBrowserTarget(parsed.pathname, appOrigin);
    }
    const allowedProtocols = resource
      ? ['http:', 'https:', 'ws:', 'wss:']
      : ['http:', 'https:'];
    if (
      !allowedProtocols.includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.port === '0'
    ) {
      return false;
    }
    const originUrl = new URL(appOrigin);
    return parsed.origin !== originUrl.origin && effectivePort(parsed) !== effectivePort(originUrl);
  } catch {
    return false;
  }
}

export function resolveNavigableInput(rawInput, appOrigin) {
  if (
    typeof rawInput !== 'string' ||
    rawInput.length > MAX_ADDRESS_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(rawInput)
  ) {
    throw new Error('请输入有效的网址或搜索内容。');
  }

  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  const maybeFileUrl = /^(?:file:|[a-zA-Z]:[\\/]|\/\/|\\\\|\/)/.test(trimmed)
    ? normalizeLocalFileUrl(trimmed)
    : null;
  if (maybeFileUrl) return maybeFileUrl;
  if (/^(?:file:|[a-zA-Z]:[\\/])/i.test(trimmed)) {
    throw new Error('这个本地文件地址不正确，请使用完整的 file:/// 路径。');
  }

  let resolvedUrl;
  if (/^https?:/i.test(trimmed)) {
    try {
      resolvedUrl = new URL(trimmed).href;
    } catch {
      throw new Error('这个网址格式不正确。');
    }
  } else {
    const hasHostPort =
      /^(?:localhost|\[[0-9a-f:]+\]|[\p{L}\p{N}._-]+):\d+(?:[/?#]|$)/iu.test(trimmed);
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !hasHostPort) {
      throw new Error('内置浏览器仅支持 HTTP、HTTPS 和本地 file:// 文件。');
    }
    if (
      !/\s/.test(trimmed) &&
      (trimmed.includes('.') ||
        hasHostPort ||
        /^localhost(?:[/?#]|$)/i.test(trimmed) ||
        trimmed.startsWith('[') ||
        trimmed.startsWith('//'))
    ) {
      try {
        resolvedUrl = new URL(
          trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`,
        ).href;
      } catch {
        throw new Error('这个网址格式不正确。');
      }
    } else {
      resolvedUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    }
  }

  if (!isAllowedBrowserTarget(resolvedUrl, appOrigin)) {
    throw new Error('此地址不能在内置浏览器中打开。');
  }
  return resolvedUrl;
}

function createAddressDraftStore() {
  const drafts = new Map();
  let state = { tabs: [], activeTabId: null };

  const project = () => ({
    ...state,
    tabs: (state.tabs || []).map((tab) => ({
      ...tab,
      addressDraft: drafts.get(tab.id)?.value ?? tab.url ?? '',
    })),
    addressDraft: drafts.get(state.activeTabId)?.value ?? state.url ?? '',
  });

  return {
    receive(nextState) {
      state = nextState;
      const aliveIds = new Set();
      for (const tab of nextState.tabs || []) {
        aliveIds.add(tab.id);
        const existing = drafts.get(tab.id);
        if (existing) {
          existing.url = tab.url || '';
          if (!existing.dirty) existing.value = existing.url;
        } else {
          drafts.set(tab.id, {
            url: tab.url || '',
            value: tab.url || '',
            dirty: false,
            revision: 0,
          });
        }
      }
      for (const id of drafts.keys()) {
        if (!aliveIds.has(id)) drafts.delete(id);
      }
      return project();
    },

    edit(value, tabId = state.activeTabId) {
      const entry = drafts.get(tabId);
      if (entry && typeof value === 'string') {
        entry.value = value.slice(0, MAX_ADDRESS_LENGTH);
        entry.dirty = entry.value !== entry.url;
        entry.revision += 1;
      }
      return project();
    },

    revision(tabId) {
      return drafts.get(tabId)?.revision;
    },

    commit(tabId, rev, latestState) {
      const entry = drafts.get(tabId);
      const tab = latestState?.tabs?.find((item) => item.id === tabId);
      if (entry && tab && !tab.error && entry.revision === rev) {
        entry.dirty = false;
        entry.value = entry.url;
      }
      return project();
    },
  };
}

function createWebPreviewFallbackBridge(appOrigin) {
  const listeners = new Set();
  let seq = 0;
  const closedUrls = [];

  const makeTab = () => ({
    id: globalThis.crypto?.randomUUID?.() || `preview-tab-${++seq}`,
    url: '',
    addressDraft: '',
    title: '',
    loading: false,
    error: null,
    previewNavigationId: 0,
    previewStatus: 'idle',
    entries: [],
    index: -1,
  });

  const tabs = [makeTab()];
  let activeTabId = tabs[0].id;
  let presentation = null;

  const getActiveTab = () => tabs.find((tab) => tab.id === activeTabId);
  const stripHistory = ({ entries, index, ...publicFields }) => ({ ...publicFields });

  const snapshot = () => {
    const current = getActiveTab();
    return {
      ...stripHistory(current),
      canGoBack: current.index > 0,
      canGoForward: current.index >= 0 && current.index < current.entries.length - 1,
      tabs: tabs.map(stripHistory),
      activeTabId,
      openRequested: 0,
      desktopZoomFactor: 1,
      presentation: normalizeBrowserPresentation(presentation),
    };
  };

  const emit = () => {
    for (const listener of listeners) listener(snapshot());
    return snapshot();
  };

  const applyUrl = (tab, targetUrl) => {
    Object.assign(tab, {
      url: targetUrl,
      addressDraft: targetUrl,
      title: '',
      loading: Boolean(targetUrl),
      error: null,
      previewNavigationId: tab.previewNavigationId + 1,
      previewStatus: targetUrl ? 'loading' : 'idle',
    });
    return emit();
  };

  const pushHistory = (tab, targetUrl) => {
    tab.entries = tab.entries.slice(0, tab.index + 1);
    if (tab.entries.at(-1) !== targetUrl) tab.entries.push(targetUrl);
    tab.index = tab.entries.length - 1;
    return applyUrl(tab, targetUrl);
  };

  return Object.freeze({
    kind: 'web-preview',
    getState: async () => snapshot(),
    getSnapshot: snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAddressDraft(value, tabId = activeTabId) {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab && typeof value === 'string') {
        tab.addressDraft = value.slice(0, MAX_ADDRESS_LENGTH);
        emit();
      }
    },
    async newTab(initialUrl) {
      if (tabs.length >= 32) throw new Error('最多同时打开 32 个标签页。');
      const targetUrl =
        initialUrl === undefined ? '' : resolveNavigableInput(initialUrl, appOrigin);
      const tab = makeTab();
      tabs.push(tab);
      activeTabId = tab.id;
      return targetUrl ? pushHistory(tab, targetUrl) : emit();
    },
    async activateTab(tabId) {
      if (tabs.some((item) => item.id === tabId)) activeTabId = tabId;
      return emit();
    },
    async closeTab(tabId) {
      const idx = tabs.findIndex((item) => item.id === tabId);
      if (idx < 0) return snapshot();
      const removed = tabs[idx];
      if (removed?.url) {
        closedUrls.push(removed.url);
        if (closedUrls.length > MAX_CLOSED_HISTORY) closedUrls.shift();
      }
      tabs.splice(idx, 1);
      if (!tabs.length) tabs.push(makeTab());
      if (activeTabId === tabId) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
      }
      return emit();
    },
    async navigate(rawInput) {
      const targetUrl = resolveNavigableInput(rawInput, appOrigin);
      return targetUrl ? pushHistory(getActiveTab(), targetUrl) : snapshot();
    },
    async back() {
      const tab = getActiveTab();
      return tab.index > 0 ? applyUrl(tab, tab.entries[--tab.index]) : snapshot();
    },
    async forward() {
      const tab = getActiveTab();
      return tab.index + 1 < tab.entries.length
        ? applyUrl(tab, tab.entries[++tab.index])
        : snapshot();
    },
    async reload() {
      const tab = getActiveTab();
      return tab.url ? applyUrl(tab, tab.url) : snapshot();
    },
    async stop() {
      const tab = getActiveTab();
      tab.loading = false;
      tab.previewStatus = 'idle';
      return emit();
    },
    async screenshot() {
      throw new Error('网页预览环境无法截屏，请在 Harness Gemini 桌面版中使用内置浏览器截屏。');
    },
    async reopenTab() {
      const reopenedUrl = closedUrls.pop();
      if (!reopenedUrl) throw new Error('没有可以重新打开的标签页。');
      if (tabs.length >= 32) {
        closedUrls.push(reopenedUrl);
        throw new Error('最多同时打开 32 个标签页。');
      }
      const tab = makeTab();
      tabs.push(tab);
      activeTabId = tab.id;
      return pushHistory(tab, reopenedUrl);
    },
    async setPresentation(next) {
      const valid = normalizeBrowserPresentation(next);
      if (!valid) return snapshot();
      presentation = valid;
      return emit();
    },
    didLoad(tabId, navId) {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab && navId === tab.previewNavigationId && tab.url) {
        Object.assign(tab, { loading: false, previewStatus: 'unverified' });
        emit();
      }
    },
    didFail(tabId, navId) {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab && navId === tab.previewNavigationId && tab.url) {
        Object.assign(tab, { loading: false, previewStatus: 'error' });
        emit();
      }
    },
  });
}

const EMPTY_BROWSER_STATE = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  openRequested: 0,
  desktopZoomFactor: 1,
  presentation: null,
  tabs: [],
  activeTabId: null,
};

function readInitialPresentation(initial) {
  const valid = normalizeBrowserPresentation(initial);
  if (valid) return valid;
  try {
    const saved = normalizeBrowserPresentation(
      JSON.parse(localStorage.getItem(PRESENTATION_STORAGE_KEY)),
    );
    if (saved) return saved;
  } catch {
    // Ignore invalid JSON or storage error.
  }
  return normalizeBrowserPresentation(DEFAULT_PRESENTATION);
}

export function useBrowserBridge(onOpenRequested) {
  const desktopBrowser = window.harnessDesktop?.browser;
  const fallbackRef = React.useRef(null);
  if (!desktopBrowser && !fallbackRef.current) {
    fallbackRef.current = createWebPreviewFallbackBridge(window.location.origin);
  }

  const [state, setState] = React.useState(() =>
    desktopBrowser ? EMPTY_BROWSER_STATE : fallbackRef.current.getSnapshot(),
  );
  const rawStateRef = React.useRef(EMPTY_BROWSER_STATE);
  const draftStoreRef = React.useRef(null);
  draftStoreRef.current ||= createAddressDraftStore();

  const bridge =
    React.useMemo(() => {
      if (!desktopBrowser) return null;
      const wrapped = {
        ...desktopBrowser,
        setAddressDraft(value, tabId = rawStateRef.current.activeTabId) {
          setState(draftStoreRef.current.edit(value, tabId));
        },
      };
      for (const method of ['navigate', 'back', 'forward', 'reload']) {
        if (typeof desktopBrowser[method] === 'function') {
          wrapped[method] = async (...args) => {
            const tabId = rawStateRef.current.activeTabId;
            const rev = draftStoreRef.current.revision(tabId);
            const result = await desktopBrowser[method](...args);
            setState(draftStoreRef.current.commit(tabId, rev, result));
            return result;
          };
        }
      }
      return wrapped;
    }, [desktopBrowser]) || fallbackRef.current;

  const lastOpenRequestedRef = React.useRef(0);

  React.useEffect(() => {
    if (!bridge) return;
    let active = true;
    const handleState = (incoming) => {
      if (!active || !incoming || typeof incoming !== 'object') return;
      const merged = { ...EMPTY_BROWSER_STATE, ...incoming };
      if (desktopBrowser) {
        rawStateRef.current = merged;
        setState(draftStoreRef.current.receive(merged));
      } else {
        setState(merged);
      }
      if (
        Number.isFinite(incoming.openRequested) &&
        incoming.openRequested > lastOpenRequestedRef.current
      ) {
        lastOpenRequestedRef.current = incoming.openRequested;
        onOpenRequested();
      }
    };

    const unsubscribe = bridge.onState(handleState);
    bridge
      .getState()
      .then(handleState)
      .catch(() => {
        if (active) {
          setState((prev) => ({ ...prev, error: '浏览器暂时无法连接，请重新打开应用。' }));
        }
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, desktopBrowser, onOpenRequested]);

  return { bridge, state };
}

function isOccludedByOverlay(viewportRect) {
  if (
    document.querySelector(
      '[aria-modal="true"], dialog[open], .modal-backdrop, .image-modal-backdrop',
    ) ||
    document.querySelector('.sidebar-mobile-shade')?.getClientRects().length
  ) {
    return true;
  }
  const floatingPopovers = document.querySelectorAll(
    '.toast, .completion-stack, .permission-menu, .browser-popover, .model-selector-popover, .composer-mode-menu, .reasoning-menu, .skill-menu, .context-panel, .hg-find-cross-panel',
  );
  return Array.from(floatingPopovers).some((el) =>
    rectsIntersect(viewportRect, el.getBoundingClientRect()),
  );
}

function usePopoverDismiss(open, containerRef, onDismiss) {
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev) => {
      if (!containerRef.current?.contains(ev.target)) onDismiss();
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onDismiss(true);
      }
    };
    const onWindowBlur = () => onDismiss();

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, containerRef, onDismiss]);
}

function getTabDisplayTitle(tab) {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    return '新标签页';
  }
}

function BrowserTabStrip({
  tabs,
  activeTabId,
  onActivate,
  onNew,
  onCloseTab,
  onClose,
  onWorkspace,
  canManage,
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const pickerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const tabButtonRefs = React.useRef(new Map());

  const closeMenu = React.useCallback((restoreFocus) => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  usePopoverDismiss(menuOpen, pickerRef, closeMenu);

  React.useLayoutEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId, tabs.length]);

  React.useLayoutEffect(() => {
    if (menuOpen) {
      menuRef.current?.querySelector('[aria-checked="true"]')?.focus();
    }
  }, [menuOpen]);

  const activateAndFocus = (tabId, focusTab = false) => {
    onActivate(tabId);
    if (focusTab) {
      requestAnimationFrame(() => tabButtonRefs.current.get(tabId)?.focus());
    }
  };

  const closeAndRefocus = (tabId, focusAdjacent = false) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    const nextId = tabs[idx + 1]?.id || tabs[idx - 1]?.id;
    onCloseTab(tabId).then(() => {
      if (focusAdjacent) {
        requestAnimationFrame(() =>
          (tabButtonRefs.current.get(nextId) || tabButtonRefs.current.values().next().value)?.focus(),
        );
      }
    });
  };

  return jsxs('div', {
    className: 'browser-tab-strip',
    children: [
      jsxs('div', {
        className: 'browser-tab-picker',
        ref: pickerRef,
        children: [
          jsxs('button', {
            ref: triggerRef,
            type: 'button',
            className: 'browser-icon-button browser-tab-picker-trigger',
            title: '标签页列表',
            'aria-label': '标签页列表',
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen,
            onClick: () => setMenuOpen((prev) => !prev),
            children: [jsx(Earth, { size: 15 }), jsx(ChevronDown, { size: 10 })],
          }),
          menuOpen &&
            jsxs('div', {
              ref: menuRef,
              className: 'browser-popover browser-tab-menu',
              role: 'menu',
              'aria-label': '已打开的标签页',
              onKeyDown: (ev) => {
                if (ev.key === 'Tab') {
                  closeMenu();
                  return;
                }
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return;
                ev.preventDefault();
                const buttons = Array.from(
                  menuRef.current?.querySelectorAll('button:not(:disabled)') || [],
                );
                const cur = buttons.indexOf(document.activeElement);
                const nextIdx =
                  ev.key === 'Home'
                    ? 0
                    : ev.key === 'End'
                      ? buttons.length - 1
                      : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                buttons[nextIdx]?.focus();
              },
              children: [
                tabs.map((tab) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitemradio',
                      'aria-checked': tab.id === activeTabId,
                      onClick: () => {
                        activateAndFocus(tab.id);
                        closeMenu(true);
                      },
                      children: [
                        jsx(Earth, { size: 14 }),
                        jsx('span', { children: getTabDisplayTitle(tab) }),
                        tab.id === activeTabId && jsx(Check, { size: 14 }),
                      ],
                    },
                    tab.id,
                  ),
                ),
                onWorkspace &&
                  jsxs('button', {
                    type: 'button',
                    role: 'menuitem',
                    className: 'browser-tab-workspace',
                    onClick: () => {
                      closeMenu();
                      onWorkspace();
                    },
                    children: [
                      jsx(FolderOpen, { size: 14 }),
                      jsx('span', { children: '工作空间' }),
                    ],
                  }),
              ],
            }),
        ],
      }),
      jsx('div', {
        className: 'browser-tabs',
        role: 'tablist',
        'aria-label': '网页标签页',
        children: tabs.map((tab, idx) =>
          jsxs(
            'div',
            {
              className: `browser-tab-item ${tab.id === activeTabId ? 'active' : ''}`,
              children: [
                jsxs('button', {
                  ref: (el) => {
                    if (el) tabButtonRefs.current.set(tab.id, el);
                    else tabButtonRefs.current.delete(tab.id);
                  },
                  type: 'button',
                  className: 'browser-web-tab',
                  id: `browser-web-tab-${tab.id}`,
                  role: 'tab',
                  'aria-selected': tab.id === activeTabId,
                  'aria-controls': 'browser-active-page',
                  tabIndex: tab.id === activeTabId ? 0 : -1,
                  title: tab.title || tab.url || '新标签页',
                  onClick: () => activateAndFocus(tab.id),
                  onAuxClick: (ev) => {
                    if (ev.button === 1 && canManage) {
                      ev.preventDefault();
                      closeAndRefocus(tab.id);
                    }
                  },
                  onKeyDown: (ev) => {
                    if (ev.key === 'Delete' && canManage) {
                      ev.preventDefault();
                      closeAndRefocus(tab.id, true);
                      return;
                    }
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
                    ev.preventDefault();
                    const nextIdx =
                      ev.key === 'Home'
                        ? 0
                        : ev.key === 'End'
                          ? tabs.length - 1
                          : (idx + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    activateAndFocus(tabs[nextIdx].id, true);
                  },
                  children: [
                    tab.loading
                      ? jsx(LoaderCircle, { size: 14, className: 'spin' })
                      : tab.error
                        ? jsx(CircleAlert, { size: 14 })
                        : jsx(Earth, { size: 14 }),
                    jsx('span', { children: getTabDisplayTitle(tab) }),
                  ],
                }),
                jsx('button', {
                  type: 'button',
                  className: 'browser-tab-close',
                  'aria-label': `关闭标签页：${getTabDisplayTitle(tab)}`,
                  title: '关闭标签页',
                  tabIndex: tab.id === activeTabId ? 0 : -1,
                  disabled: !canManage,
                  onClick: () => closeAndRefocus(tab.id),
                  children: jsx(X, { size: 12 }),
                }),
              ],
            },
            tab.id,
          ),
        ),
      }),
      jsx('button', {
        type: 'button',
        className: 'browser-icon-button browser-new-tab',
        'aria-label': '新建标签页',
        title: tabs.length >= 32 ? '最多打开 32 个标签页' : '新建标签页',
        disabled: !canManage || tabs.length >= 32,
        onClick: onNew,
        children: jsx(Plus, { size: 16 }),
      }),
      jsx('div', { className: 'browser-tab-strip-spacer' }),
      onClose &&
        jsx('button', {
          type: 'button',
          className: 'browser-icon-button browser-collapse',
          'aria-label': '收起浏览器面板',
          title: '收起面板',
          onClick: onClose,
          children: jsx(PanelRightClose, { size: 16 }),
        }),
    ],
  });
}

function BrowserModeSelect({ value, onChange }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const listboxRef = React.useRef(null);
  const listboxId = React.useId();

  const options = [
    {
      value: 'normal',
      label: '适应窗口',
      description: '网页铺满面板，随面板宽高自动布局。',
    },
    {
      value: 'responsive',
      label: '自由尺寸',
      description: '指定网页宽高，单独调整预览缩放。',
    },
  ];

  const selected = options.find((opt) => opt.value === value) || options[0];

  const closeMenu = React.useCallback((restoreFocus) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  usePopoverDismiss(open, containerRef, closeMenu);

  React.useLayoutEffect(() => {
    if (open) {
      listboxRef.current?.querySelector('[aria-selected="true"]')?.focus();
    }
  }, [open]);

  return jsxs('div', {
    className: 'browser-mode-select',
    ref: containerRef,
    children: [
      jsxs('button', {
        ref: triggerRef,
        type: 'button',
        className: 'browser-mode-trigger',
        'aria-label': `浏览器显示模式：${selected.label}`,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': open ? listboxId : undefined,
        'data-browser-mode-value': value,
        onClick: () => setOpen((prev) => !prev),
        onKeyDown: (ev) => {
          if (['ArrowUp', 'ArrowDown'].includes(ev.key)) {
            ev.preventDefault();
            setOpen(true);
          }
        },
        children: [jsx('span', { children: selected.label }), jsx(ChevronDown, { size: 14 })],
      }),
      open &&
        jsx('div', {
          ref: listboxRef,
          id: listboxId,
          className: 'browser-popover browser-mode-options',
          role: 'listbox',
          'aria-label': '浏览器显示模式',
          onKeyDown: (ev) => {
            if (ev.key === 'Tab') {
              closeMenu();
              return;
            }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return;
            ev.preventDefault();
            const items = Array.from(listboxRef.current?.querySelectorAll('[role="option"]') || []);
            const cur = items.indexOf(document.activeElement);
            const nextIdx =
              ev.key === 'Home'
                ? 0
                : ev.key === 'End'
                  ? items.length - 1
                  : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[nextIdx]?.focus();
          },
          children: options.map((opt) =>
            jsxs(
              'button',
              {
                type: 'button',
                role: 'option',
                tabIndex: -1,
                'aria-selected': opt.value === value,
                'data-browser-mode-option': opt.value,
                onClick: () => {
                  if (opt.value !== value) onChange(opt.value);
                  closeMenu(true);
                },
                children: [
                  jsxs('span', {
                    children: [
                      jsx('strong', { children: opt.label }),
                      jsx('small', { children: opt.description }),
                    ],
                  }),
                  opt.value === value && jsx(Check, { size: 14 }),
                ],
              },
              opt.value,
            ),
          ),
        }),
    ],
  });
}

function BrowserZoomSelect({ value, onChange }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const listboxRef = React.useRef(null);
  const listboxId = React.useId();

  const closeMenu = React.useCallback((restoreFocus) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  usePopoverDismiss(open, containerRef, closeMenu);

  React.useLayoutEffect(() => {
    if (open) {
      listboxRef.current?.querySelector('[aria-selected="true"]')?.focus();
    }
  }, [open]);

  return jsxs('div', {
    className: 'browser-zoom-select',
    ref: containerRef,
    children: [
      jsxs('button', {
        ref: triggerRef,
        type: 'button',
        className: 'browser-zoom-trigger',
        'aria-label': '浏览器预览缩放',
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': open ? listboxId : undefined,
        'data-value': value,
        onClick: () => setOpen((prev) => !prev),
        onKeyDown: (ev) => {
          if (['ArrowUp', 'ArrowDown'].includes(ev.key)) {
            ev.preventDefault();
            setOpen(true);
          }
        },
        children: [
          jsx('span', { children: value === 'fit' ? '缩放以适应' : `${value}%` }),
          jsx(ChevronDown, { size: 14 }),
        ],
      }),
      open &&
        jsx('div', {
          ref: listboxRef,
          id: listboxId,
          className: 'browser-popover browser-zoom-options',
          role: 'listbox',
          'aria-label': '浏览器预览缩放',
          onKeyDown: (ev) => {
            if (ev.key === 'Tab') {
              closeMenu();
              return;
            }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return;
            ev.preventDefault();
            const items = Array.from(listboxRef.current?.querySelectorAll('[role="option"]') || []);
            const cur = items.indexOf(document.activeElement);
            const nextIdx =
              ev.key === 'Home'
                ? 0
                : ev.key === 'End'
                  ? items.length - 1
                  : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[nextIdx]?.focus();
          },
          children: ZOOM_PRESETS.map((preset) =>
            jsxs(
              'button',
              {
                type: 'button',
                role: 'option',
                tabIndex: -1,
                'aria-selected': preset === value,
                'data-zoom-option': preset,
                onClick: () => {
                  onChange(preset);
                  closeMenu(true);
                },
                children: [
                  jsx('span', { children: preset === 'fit' ? '缩放以适应' : `${preset}%` }),
                  preset === value && jsx(Check, { size: 14 }),
                ],
              },
              preset,
            ),
          ),
        }),
    ],
  });
}

function BrowserDimensionInput({ dimension, value, onChange }) {
  const [draft, setDraft] = React.useState(String(value));
  const [invalid, setInvalid] = React.useState(false);
  const skipBlurRef = React.useRef(false);
  const errorId = React.useId();

  const isWidth = dimension === 'width';
  const minVal = isWidth ? VIEWPORT_LIMITS.minWidth : VIEWPORT_LIMITS.minHeight;
  const maxVal = isWidth ? VIEWPORT_LIMITS.maxWidth : VIEWPORT_LIMITS.maxHeight;

  React.useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const parsed = Number(draft.trim());
    if (isValidViewportDimension(dimension, parsed)) {
      setInvalid(false);
      setDraft(String(parsed));
      if (value !== parsed) onChange(parsed);
    } else {
      setInvalid(true);
    }
  };

  return jsxs('div', {
    className: 'browser-dimension',
    children: [
      jsx('input', {
        'aria-label': `浏览器视口${isWidth ? '宽度' : '高度'}`,
        'aria-invalid': invalid || undefined,
        'aria-describedby': invalid ? errorId : undefined,
        inputMode: 'numeric',
        min: minVal,
        max: maxVal,
        spellCheck: false,
        value: draft,
        onChange: (ev) => {
          setDraft(ev.target.value);
          if (invalid) {
            setInvalid(!isValidViewportDimension(dimension, Number(ev.target.value.trim())));
          }
        },
        onBlur: () => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
          } else {
            commit();
          }
        },
        onKeyDown: (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            setDraft(String(value));
            setInvalid(false);
            skipBlurRef.current = true;
            ev.currentTarget.blur();
          }
        },
      }),
      invalid &&
        jsxs('span', {
          id: errorId,
          className: 'browser-popover browser-dimension-error',
          role: 'alert',
          children: ['请输入 ', minVal, ' 到 ', maxVal, ' 之间的整数'],
        }),
    ],
  });
}

function BrowserMoreMenu({ actions, onAction, disabled, note }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);

  const closeMenu = React.useCallback((restoreFocus) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  usePopoverDismiss(open, containerRef, closeMenu);

  React.useLayoutEffect(() => {
    if (open) {
      menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    }
  }, [open]);

  if (!actions.length) return null;

  return jsxs('div', {
    className: 'browser-more',
    ref: containerRef,
    children: [
      jsx('button', {
        ref: triggerRef,
        type: 'button',
        className: 'browser-icon-button',
        title: '更多',
        'aria-label': '浏览器更多操作',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((prev) => !prev),
        children: jsx(Ellipsis, { size: 16 }),
      }),
      open &&
        jsxs('div', {
          ref: menuRef,
          className: 'browser-popover browser-more-menu',
          role: 'menu',
          'aria-label': '浏览器更多操作',
          onKeyDown: (ev) => {
            if (ev.key === 'Tab') {
              closeMenu();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
            ev.preventDefault();
            const items = Array.from(
              menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [],
            );
            const cur = items.indexOf(document.activeElement);
            const nextIdx =
              ev.key === 'Home'
                ? 0
                : ev.key === 'End'
                  ? items.length - 1
                  : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[nextIdx]?.focus();
          },
          children: [
            note && jsx('p', { className: 'browser-more-note', children: note }),
            actions.map(({ method, label, Icon, href }) =>
              href
                ? jsxs(
                    'a',
                    {
                      role: 'menuitem',
                      href,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      onClick: () => closeMenu(true),
                      children: [jsx(Icon, { size: 16 }), jsx('span', { children: label })],
                    },
                    method,
                  )
                : jsxs(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      disabled,
                      onClick: () => {
                        closeMenu(true);
                        onAction(method);
                      },
                      children: [jsx(Icon, { size: 16 }), jsx('span', { children: label })],
                    },
                    method,
                  ),
            ),
          ],
        }),
    ],
  });
}

export function BrowserPanel({
  bridge,
  state,
  focusRequest,
  blocked = false,
  onClose,
  onWorkspace,
}) {
  const canvasRef = React.useRef(null);
  const frameRef = React.useRef(null);
  const addressInputRef = React.useRef(null);
  const editingAddressRef = React.useRef(false);
  const prevTabIdRef = React.useRef(state.activeTabId);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const [addressInput, setAddressInput] = React.useState(state.addressDraft ?? state.url ?? '');
  const [actionError, setActionError] = React.useState('');
  const [presentation, setPresentation] = React.useState(() =>
    readInitialPresentation(state.presentation),
  );
  const [canvasSize, setCanvasSize] = React.useState(null);

  const presentationRef = React.useRef(presentation);
  const syncedBridgeRef = React.useRef(
    normalizeBrowserPresentation(state.presentation) ? bridge : null,
  );
  const userTouchedPresentationRef = React.useRef(false);
  const pendingPresentationRef = React.useRef(null);
  const persistTimerRef = React.useRef(null);
  const dragSessionRef = React.useRef(null);
  const dragRafRef = React.useRef(null);
  const dragSizeRef = React.useRef(null);
  const lastViewportSentRef = React.useRef(null);

  const hasValidPage = Boolean(state.url && !state.error);
  const isWebPreview = bridge?.kind === 'web-preview';
  const tabs = state.tabs?.length
    ? state.tabs
    : [
        {
          id: 'initial',
          url: state.url || '',
          title: state.title || '',
          loading: state.loading,
          error: state.error,
        },
      ];
  const activeTabId = state.activeTabId || tabs[0].id;
  const isResponsive = presentation.mode === 'responsive';
  const desktopZoom = sanitizePositiveScale(state.desktopZoomFactor);
  const visualScale = isResponsive
    ? computeVisualScale({
        canvasSize,
        desktopZoomFactor: desktopZoom,
        viewportSize: presentation.viewport,
        zoom: presentation.zoom,
      })
    : 1;
  const rendererScale = isResponsive
    ? computeRendererScale({ desktopZoomFactor: desktopZoom, visualScale })
    : 1;

  presentationRef.current = presentation;

  const flushPresentation = React.useCallback(() => {
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const pending = pendingPresentationRef.current;
    pendingPresentationRef.current = null;
    if (pending) {
      try {
        localStorage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(pending));
      } catch {
        // Ignore storage error.
      }
      if (typeof bridge?.setPresentation === 'function') {
        bridge.setPresentation(pending).catch(() => {});
      }
    }
  }, [bridge]);

  const updatePresentation = React.useCallback(
    (next, reason = 'mode') => {
      const normalized = normalizeBrowserPresentation(next);
      if (!normalized) return;
      userTouchedPresentationRef.current = true;
      presentationRef.current = normalized;
      setPresentation(normalized);
      pendingPresentationRef.current = normalized;
      clearTimeout(persistTimerRef.current);
      if (reason === 'viewport') {
        persistTimerRef.current = setTimeout(flushPresentation, 200);
      } else {
        flushPresentation();
      }
    },
    [flushPresentation],
  );

  React.useEffect(() => {
    if (!bridge || syncedBridgeRef.current === bridge) return;
    const normalized = normalizeBrowserPresentation(state.presentation);
    if (normalized) {
      syncedBridgeRef.current = bridge;
      if (!userTouchedPresentationRef.current) {
        presentationRef.current = normalized;
        setPresentation(normalized);
      }
    }
  }, [bridge, state.presentation]);

  React.useEffect(() => () => flushPresentation(), [flushPresentation]);

  React.useEffect(() => {
    if (prevTabIdRef.current !== state.activeTabId) {
      prevTabIdRef.current = state.activeTabId;
      editingAddressRef.current = false;
      setActionError('');
    }
    if (!editingAddressRef.current) {
      setAddressInput(state.addressDraft ?? state.url ?? '');
    }
  }, [state.activeTabId, state.url, state.addressDraft]);

  React.useEffect(() => {
    if (!focusRequest) return;
    const raf = requestAnimationFrame(() => {
      addressInputRef.current?.focus();
      addressInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequest]);

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const next = { width: canvas.clientWidth, height: canvas.clientHeight };
      if (next.width > 0 && next.height > 0) {
        setCanvasSize((prev) =>
          prev?.width === next.width && prev?.height === next.height ? prev : next,
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [isResponsive, desktopZoom]);

  React.useLayoutEffect(() => {
    if (typeof bridge?.setViewport !== 'function' || !canvasRef.current || !frameRef.current) {
      return;
    }
    let rafId;
    let lastSentJson = '';

    const syncViewport = () => {
      const frame = frameRef.current;
      const canvas = canvasRef.current;
      if (!frame || !canvas) return;

      const frameRect = frame.getBoundingClientRect();
      const clipRect = computeClippedBounds({
        rect: canvas.getBoundingClientRect(),
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        clientLeft: canvas.clientLeft,
        clientTop: canvas.clientTop,
      });
      const interX = Math.max(frameRect.x, clipRect.x);
      const interY = Math.max(frameRect.y, clipRect.y);
      const intersection = {
        x: interX,
        y: interY,
        width: Math.max(0, Math.min(frameRect.right, clipRect.x + clipRect.width) - interX),
        height: Math.max(0, Math.min(frameRect.bottom, clipRect.y + clipRect.height) - interY),
      };

      const visible = Boolean(
        hasValidPage &&
          !blocked &&
          !document.hidden &&
          rectsIntersect(frameRect, clipRect) &&
          !isOccludedByOverlay(intersection),
      );

      const payload = {
        x: frameRect.x,
        y: frameRect.y,
        width: frameRect.width,
        height: frameRect.height,
        visible,
        clip: clipRect,
        emulation: isResponsive ? { ...presentationRef.current.viewport } : null,
      };

      const serialized = JSON.stringify(payload);
      if (serialized !== lastSentJson) {
        lastSentJson = serialized;
        lastViewportSentRef.current = payload;
        bridge.setViewport(payload).catch(() => {});
      }
    };

    const scheduleSync = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncViewport);
    };

    const forceResync = () => {
      lastSentJson = '';
      scheduleSync();
    };

    const resizeObserver = new ResizeObserver(forceResync);
    resizeObserver.observe(canvasRef.current);
    resizeObserver.observe(frameRef.current);

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'open', 'hidden', 'class', 'style'],
    });

    const canvasEl = canvasRef.current;
    canvasEl.addEventListener('scroll', scheduleSync, { passive: true });
    window.addEventListener('resize', forceResync);
    window.visualViewport?.addEventListener('resize', forceResync);
    document.addEventListener('visibilitychange', forceResync);
    syncViewport();

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      canvasEl.removeEventListener('scroll', scheduleSync);
      window.removeEventListener('resize', forceResync);
      window.visualViewport?.removeEventListener('resize', forceResync);
      document.removeEventListener('visibilitychange', forceResync);
      const hiddenPayload = lastViewportSentRef.current
        ? { ...lastViewportSentRef.current, visible: false }
        : { x: 0, y: 0, width: 0, height: 0, visible: false };
      bridge.setViewport(hiddenPayload).catch(() => {});
    };
  }, [
    bridge,
    hasValidPage,
    blocked,
    isResponsive,
    rendererScale,
    desktopZoom,
    presentation.viewport.width,
    presentation.viewport.height,
    state.activeTabId,
  ]);

  const applyViewportSize = React.useCallback(
    (nextViewport) => {
      const cur = presentationRef.current;
      if (
        cur.viewport.width !== nextViewport.width ||
        cur.viewport.height !== nextViewport.height
      ) {
        updatePresentation({ ...cur, viewport: nextViewport }, 'viewport');
      }
    },
    [updatePresentation],
  );

  const endResizeDrag = React.useCallback(
    (pointerId, shouldCommit = true) => {
      const session = dragSessionRef.current;
      if (!session || (pointerId !== undefined && pointerId !== session.pointerId)) return;
      dragSessionRef.current = null;
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
      const pendingSize = dragSizeRef.current;
      dragSizeRef.current = null;
      if (shouldCommit && pendingSize) {
        applyViewportSize(pendingSize);
      }
      try {
        if (session.target.hasPointerCapture(session.pointerId)) {
          session.target.releasePointerCapture(session.pointerId);
        }
      } catch {
        // Ignore releasePointerCapture error.
      }
    },
    [applyViewportSize],
  );

  React.useEffect(() => {
    if (!isResponsive) {
      endResizeDrag(undefined, false);
      return;
    }
    const onPointerEnd = (ev) => endResizeDrag(ev.pointerId);
    const onBlur = () => endResizeDrag();
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onBlur);
      endResizeDrag(undefined, false);
    };
  }, [isResponsive, endResizeDrag]);

  const handleResizePointerDown = (handleSpec, ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    endResizeDrag();
    ev.currentTarget.focus();
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // Ignore pointer capture failure.
    }
    dragSessionRef.current = {
      ...handleSpec,
      pointerId: ev.pointerId,
      target: ev.currentTarget,
      x: ev.clientX,
      y: ev.clientY,
      size: { ...presentationRef.current.viewport },
      scale: rendererScale,
    };
  };

  const handleResizePointerMove = (ev) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== ev.pointerId) return;
    if (ev.pointerType === 'mouse' && !(ev.buttons & 1)) {
      endResizeDrag(ev.pointerId);
      return;
    }
    ev.preventDefault();
    dragSizeRef.current = computeDraggedViewport({
      startSize: session.size,
      deltaX: ev.clientX - session.x,
      deltaY: ev.clientY - session.y,
      widthDirection: session.widthDirection,
      heightDirection: session.heightDirection,
      rendererScale: session.scale,
    });
    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        const size = dragSizeRef.current;
        dragSizeRef.current = null;
        if (size && dragSessionRef.current) {
          applyViewportSize(size);
        }
      });
    }
  };

  const handleResizeKeyDown = (handleSpec, ev) => {
    const nextSize = computeKeyboardViewport({
      size: presentationRef.current.viewport,
      key: ev.key,
      shiftKey: ev.shiftKey,
      widthDirection: handleSpec.widthDirection,
      heightDirection: handleSpec.heightDirection,
    });
    if (nextSize) {
      ev.preventDefault();
      applyViewportSize(nextSize);
    }
    if (ev.key === 'Escape') {
      endResizeDrag();
    }
  };

  const callBridgeMethod = React.useCallback(
    async (method, ...args) => {
      if (typeof bridge?.[method] !== 'function') return;
      setActionError('');
      const prev = stateRef.current;
      try {
        const result = await bridge[method](...args);
        const failedTransition =
          result?.error &&
          ((method === 'newTab' && result.activeTabId === prev.activeTabId) ||
            (method === 'activateTab' && result.activeTabId !== args[0]) ||
            (method === 'closeTab' &&
              (result.tabs?.some((t) => t.id === args[0]) ||
                !prev.tabs?.some((t) => t.id === args[0]))) ||
            (method === 'reopenTab' && result.activeTabId === prev.activeTabId));
        if (failedTransition) {
          setActionError(result.error);
          return null;
        }
        return result;
      } catch (err) {
        setActionError(
          bridge?.kind === 'web-preview' && err instanceof Error
            ? err.message
            : '操作未完成，请重试。',
        );
        return null;
      }
    },
    [bridge],
  );

  const moreActions = isWebPreview
    ? [
        {
          method: 'previewExternal',
          label: '在新标签页打开',
          Icon: ExternalLink,
          href: state.url,
        },
      ]
    : [
        { method: 'reopenTab', label: '重新打开关闭的标签页', Icon: RotateCcw },
        { method: 'openExternal', label: '在默认浏览器中打开', Icon: ExternalLink },
        { method: 'openDevTools', label: '打开调试工具', Icon: Bug },
        { method: 'clearSiteData', label: '清空本站数据并刷新', Icon: Bug },
      ].filter((item) => typeof bridge?.[item.method] === 'function');

  return jsxs('section', {
    className: 'browser-panel',
    id: 'browser-panel',
    'aria-label': '内置浏览器',
    'data-browser-mode': presentation.mode,
    children: [
      jsx(BrowserTabStrip, {
        tabs,
        activeTabId,
        canManage: typeof bridge?.newTab === 'function',
        onActivate: (tabId) => callBridgeMethod('activateTab', tabId),
        onCloseTab: (tabId) => callBridgeMethod('closeTab', tabId),
        onNew: async () => {
          if (await callBridgeMethod('newTab')) {
            requestAnimationFrame(() => {
              addressInputRef.current?.focus();
              addressInputRef.current?.select();
            });
          }
        },
        onClose,
        onWorkspace,
      }),
      jsxs('form', {
        className: 'browser-toolbar',
        onSubmit: (ev) => {
          ev.preventDefault();
          if (addressInput.trim()) {
            editingAddressRef.current = false;
            addressInputRef.current?.blur();
            callBridgeMethod('navigate', addressInput);
          } else {
            addressInputRef.current?.focus();
          }
        },
        children: [
          jsx('button', {
            className: 'browser-icon-button',
            type: 'button',
            disabled: !bridge || !state.canGoBack,
            onClick: () => callBridgeMethod('back'),
            title: '后退',
            'aria-label': '网页后退',
            children: jsx(ChevronLeft, { size: 16 }),
          }),
          jsx('button', {
            className: 'browser-icon-button',
            type: 'button',
            disabled: !bridge || !state.canGoForward,
            onClick: () => callBridgeMethod('forward'),
            title: '前进',
            'aria-label': '网页前进',
            children: jsx(ChevronRight, { size: 16 }),
          }),
          state.loading
            ? jsx('button', {
                className: 'browser-icon-button',
                type: 'button',
                disabled: !bridge,
                onClick: () => callBridgeMethod('stop'),
                title: '停止加载',
                'aria-label': '停止加载网页',
                children: jsx(X, { size: 16 }),
              })
            : jsx('button', {
                className: 'browser-icon-button',
                type: 'button',
                disabled: !bridge || !state.url,
                onClick: () => callBridgeMethod('reload'),
                title: '刷新',
                'aria-label': '刷新网页',
                children: jsx(RefreshCw, { size: 16 }),
              }),
          jsx('div', {
            className: 'browser-address',
            children: jsx('input', {
              ref: addressInputRef,
              'aria-label': '网址或搜索内容',
              placeholder: '输入网址后回车',
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              maxLength: MAX_ADDRESS_LENGTH,
              value: addressInput,
              onChange: (ev) => {
                setAddressInput(ev.target.value);
                bridge?.setAddressDraft?.(ev.target.value, state.activeTabId);
              },
              onFocus: () => {
                editingAddressRef.current = true;
              },
              onBlur: () => {
                editingAddressRef.current = false;
              },
              onKeyDown: (ev) => {
                if (ev.key === 'Escape') {
                  setAddressInput(state.url || '');
                  bridge?.setAddressDraft?.(state.url || '', state.activeTabId);
                  ev.currentTarget.blur();
                }
                if (
                  ev.key === 'Enter' &&
                  (ev.nativeEvent.isComposing || ev.keyCode === 229)
                ) {
                  ev.preventDefault();
                }
              },
            }),
          }),
          jsx(BrowserModeSelect, {
            value: presentation.mode,
            onChange: (nextMode) => {
              endResizeDrag();
              const cur = presentationRef.current;
              updatePresentation({
                ...cur,
                mode: nextMode,
                zoom: nextMode === 'responsive' ? 'fit' : cur.zoom,
              });
            },
          }),
          jsx(BrowserMoreMenu, {
            actions: moreActions,
            disabled: !state.url || Boolean(state.error),
            onAction: callBridgeMethod,
            note: isWebPreview
              ? state.previewStatus === 'error'
                ? '预览未能载入，可在新标签页打开。'
                : '网页预览：部分网站禁止嵌入，可在新标签页打开。'
              : '摄像头、麦克风、定位和屏幕共享权限不会授予网页。',
          }),
        ],
      }),
      isResponsive &&
        jsxs('div', {
          className: 'browser-responsive-toolbar',
          'aria-label': '自由尺寸设置',
          children: [
            jsx(BrowserDimensionInput, {
              dimension: 'width',
              value: presentation.viewport.width,
              onChange: (width) =>
                applyViewportSize({ ...presentationRef.current.viewport, width }),
            }),
            jsx('span', {
              'aria-hidden': 'true',
              className: 'browser-dimension-times',
              children: '×',
            }),
            jsx(BrowserDimensionInput, {
              dimension: 'height',
              value: presentation.viewport.height,
              onChange: (height) =>
                applyViewportSize({ ...presentationRef.current.viewport, height }),
            }),
            jsx(BrowserZoomSelect, {
              value: presentation.zoom,
              onChange: (zoom) => updatePresentation({ ...presentationRef.current, zoom }, 'zoom'),
            }),
          ],
        }),
      actionError &&
        jsxs('div', {
          className: 'browser-action-error',
          role: 'alert',
          children: [
            jsx(CircleAlert, { size: 13 }),
            jsx('span', { children: actionError }),
            jsx('button', {
              type: 'button',
              className: 'browser-icon-button',
              'aria-label': '关闭浏览器提示',
              onClick: () => setActionError(''),
              children: jsx(X, { size: 12 }),
            }),
          ],
        }),
      jsx('div', {
        className: `browser-canvas ${isResponsive ? 'responsive' : ''}`,
        ref: canvasRef,
        'data-responsive-browser-mode': isResponsive ? 'active' : 'inactive',
        children: jsx('div', {
          className: 'browser-canvas-content',
          children: jsxs('div', {
            className: 'browser-frame',
            ref: frameRef,
            style: isResponsive
              ? {
                  width: `${presentation.viewport.width * rendererScale}px`,
                  height: `${presentation.viewport.height * rendererScale}px`,
                }
              : undefined,
            'data-responsive-width': isResponsive ? presentation.viewport.width : undefined,
            'data-responsive-height': isResponsive ? presentation.viewport.height : undefined,
            'data-responsive-scale': isResponsive ? visualScale : undefined,
            children: [
              jsx('div', {
                className: 'browser-page-clip',
                children: jsxs('div', {
                  className: 'browser-page',
                  id: 'browser-active-page',
                  role: 'tabpanel',
                  'aria-labelledby': `browser-web-tab-${activeTabId}`,
                  style: isResponsive
                    ? {
                        width: `${presentation.viewport.width}px`,
                        height: `${presentation.viewport.height}px`,
                        transform: `scale(${rendererScale})`,
                        transformOrigin: 'top left',
                      }
                    : undefined,
                  children: [
                    isWebPreview &&
                      tabs
                        .filter((tab) => tab.url)
                        .map((tab) =>
                          jsx(
                            'iframe',
                            {
                              className: 'browser-preview-frame',
                              title: `网页预览：${getTabDisplayTitle(tab)}`,
                              'aria-busy': tab.loading,
                              hidden: tab.id !== activeTabId,
                              'data-preview-tab-id': tab.id,
                              src: tab.url,
                              sandbox: 'allow-forms allow-scripts',
                              referrerPolicy: 'no-referrer',
                              allow:
                                "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'",
                              onLoad: () => bridge.didLoad(tab.id, tab.previewNavigationId),
                              onError: () => bridge.didFail(tab.id, tab.previewNavigationId),
                            },
                            `${tab.id}:${tab.previewNavigationId}`,
                          ),
                        ),
                    state.error
                      ? jsxs('div', {
                          className: 'browser-empty browser-failure',
                          role: 'alert',
                          children: [
                            jsx(CircleAlert, { size: 64, strokeWidth: 1.5 }),
                            jsx('h2', { children: '暂时无法打开网页' }),
                            jsx('p', { children: state.error }),
                            jsxs('button', {
                              className: 'browser-retry',
                              type: 'button',
                              onClick: () => callBridgeMethod(state.url ? 'reload' : 'home'),
                              children: [jsx(RefreshCw, { size: 14 }), '重新加载'],
                            }),
                          ],
                        })
                      : state.url
                        ? !isWebPreview &&
                          jsx('div', {
                            className: 'browser-page-placeholder',
                            'aria-hidden': 'true',
                            children:
                              state.loading && jsx(LoaderCircle, { size: 22, className: 'spin' }),
                          })
                        : jsxs('div', {
                            className: 'browser-empty',
                            children: [
                              jsx(Earth, { size: 64, strokeWidth: 1.5 }),
                              jsx('h2', { children: '浏览器' }),
                              jsx('p', { children: '粘贴或输入 URL 以打开网页。' }),
                            ],
                          }),
                  ],
                }),
              }),
              isResponsive &&
                RESIZE_HANDLES.map((spec) => {
                  const isEdge = Boolean(spec.orientation);
                  const isVertical = spec.orientation === 'vertical';
                  return jsx(
                    'div',
                    {
                      className: `browser-resize-handle browser-resize-${spec.id} ${isEdge ? 'edge' : 'corner'}`,
                      'data-resize-handle': spec.id,
                      tabIndex: 0,
                      role: isEdge ? 'separator' : 'button',
                      'aria-label': isEdge
                        ? `调整浏览器视口${isVertical ? '宽度' : '高度'}`
                        : `调整浏览器视口宽度和高度（${spec.id}）`,
                      'aria-orientation': spec.orientation,
                      'aria-valuenow': isEdge
                        ? presentation.viewport[isVertical ? 'width' : 'height']
                        : undefined,
                      'aria-valuemin': isEdge ? 320 : undefined,
                      'aria-valuemax': isEdge ? (isVertical ? 3840 : 2160) : undefined,
                      onPointerDown: (ev) => handleResizePointerDown(spec, ev),
                      onPointerMove: handleResizePointerMove,
                      onPointerUp: (ev) => endResizeDrag(ev.pointerId),
                      onPointerCancel: (ev) => endResizeDrag(ev.pointerId),
                      onLostPointerCapture: (ev) => endResizeDrag(ev.pointerId),
                      onKeyDown: (ev) => handleResizeKeyDown(spec, ev),
                      children:
                        isEdge &&
                        (isVertical
                          ? jsx(GripVertical, { size: 16 })
                          : jsx(GripHorizontal, { size: 16 })),
                    },
                    spec.id,
                  );
                }),
            ],
          }),
        }),
      }),
    ],
  });
}
