import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPetActivityMemory, collectPetActivity, acceptPetCompletion, clearPetActivity } from './pet-activity.mjs';
import { verifyNativeAffinity } from './native-affinity.mjs';

export const PET_COMMAND_CHANNEL = 'harness:pet-command';
export const PET_STATE_CHANNEL = 'harness:pet-state';
const WIDTH = 320;
const HEIGHT = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const directory = path.dirname(fileURLToPath(import.meta.url));
const petUrl = pathToFileURL(path.join(directory, 'pet.html')).href;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function constrainPetBounds(bounds, area) {
  return {
    x: Math.round(clamp(Number.isFinite(bounds?.x) ? bounds.x : area.x + area.width - WIDTH - 24, area.x, area.x + Math.max(0, area.width - WIDTH))),
    y: Math.round(clamp(Number.isFinite(bounds?.y) ? bounds.y : area.y + area.height - HEIGHT - 24, area.y, area.y + Math.max(0, area.height - HEIGHT))),
    width: WIDTH, height: HEIGHT,
  };
}

/** A separate, sandboxed local window. Only that exact renderer can issue pet commands. */
export function createDesktopPet({ BrowserWindow, Menu, screen, ipcMain, storagePath, getHarness, onOpenSession, onVisibilityChange = () => {}, isSuppressed = () => false }) {
  const memory = createPetActivityMemory();
  let window;
  let creating;
  let loaded = false;
  let enabled = false;
  let disposed = false;
  let wantedVisible = false;
  let settings = { schemaVersion: 1, enabled: false, positions: {}, opacity: 1, scale: 1, mascotVisible: true };
  let persistence = Promise.resolve();
  let saveTimer;
  let pollTimer;
  let momentum;
  let dragging;
  let pointerRegions = [];
  let nativeWindowShape = false;
  let transparentWindow = false;
  let ignoringMouse;
  let activity = collectPetActivity(getHarness(), memory);
  let lastState = '';
  let lastActivityAt = 0;
  let contextOpen = false;
  let look = { x: 0, y: 0 };
  let dragDirection = 'right';
  let opacity = 1;
  let scale = 1;
  let mascotVisible = true;
  let settingsRequest = 0;
  const live = () => window && !window.isDestroyed() && !window.webContents.isDestroyed();
  const visible = () => Boolean(live() && window.isVisible());

  function display() {
    return live() ? screen.getDisplayMatching(window.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  function displayKey(value) { return `${value.id}:${value.workArea.width}x${value.workArea.height}`; }
  function state() { return { visible: visible(), activity, look, dragging: Boolean(dragging), dragDirection, reducedMotion: false, opacity, scale, mascotVisible, settingsRequest }; }
  function send(force = false) {
    if (!live() || !loaded) return;
    const value = state();
    const serial = JSON.stringify(value);
    if (force || serial !== lastState) { lastState = serial; window.webContents.send(PET_STATE_CHANNEL, value); }
  }
  function refreshActivity() {
    activity = collectPetActivity(getHarness(), memory);
    lastActivityAt = Date.now();
    send();
  }
  function writeSettings() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const data = JSON.stringify({ ...settings, enabled }, null, 2);
    persistence = persistence.then(async () => {
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      const temporary = `${storagePath}.tmp`;
      await fs.writeFile(temporary, data, 'utf8');
      await fs.rename(temporary, storagePath);
    }).catch(() => {});
    return persistence;
  }
  function rememberPosition() {
    if (!live()) return;
    const current = display();
    const bounds = window.getBounds();
    settings.positions[displayKey(current)] = { x: bounds.x, y: bounds.y };
    settings.lastDisplay = String(current.id);
    const keys = Object.keys(settings.positions);
    for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete settings.positions[key];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettings, 200);
    saveTimer.unref?.();
  }
  function changeOpacity(payload) {
    const value = payload?.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 1) return false;
    opacity = Math.round(value * 100) / 100;
    settings.opacity = opacity;
    if (live()) window.setOpacity(opacity);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettings, 200);
    saveTimer.unref?.();
    send(true);
    return true;
  }
  function changeScale(payload) {
    const value = payload?.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 1) return false;
    scale = Math.round(value * 100) / 100;
    settings.scale = scale;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettings, 200);
    saveTimer.unref?.();
    send(true);
    return true;
  }
  function changeMascotVisibility(payload) {
    if (typeof payload?.visible !== 'boolean') return false;
    mascotVisible = payload.visible;
    settings.mascotVisible = mascotVisible;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettings, 200);
    saveTimer.unref?.();
    send(true);
    return true;
  }
  function stopMomentum() { clearInterval(momentum); momentum = undefined; }
  function setIgnoring(value, force = false) {
    if (!live() || (!force && ignoringMouse === value)) return;
    ignoringMouse = value;
    // Global cursor polling handles re-entry, so a forwarding mouse hook is not
    // needed. Reassert interactive regions even if Windows changed native styles.
    window.setIgnoreMouseEvents(value);
  }
  function updatePointer() {
    if (!visible()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const area = screen.getDisplayMatching(bounds).bounds;
    // The renderer positions the mascot around this anchor. A vector, rather than a
    // mouse hook, gives it an inexpensive 16-direction-like gaze across applications.
    look = { x: Math.round(clamp((x - WIDTH / 2) / 180, -1, 1) * 20) / 20, y: Math.round(clamp((y - 128) / 180, -1, 1) * 20) / 20, cx: Math.round(x), cy: Math.round(y), dl: area.x - bounds.x, dt: area.y - bounds.y, dr: area.x + area.width - bounds.x, db: area.y + area.height - bounds.y };
    const hit = pointerRegions.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
    const ignoresInput = process.platform !== 'win32' && !dragging && !contextOpen && !hit;
    setIgnoring(ignoresInput, !ignoresInput);
    if (dragging) {
      const next = constrainPetBounds({ x: dragging.bounds.x + cursor.x - dragging.cursor.x, y: dragging.bounds.y + cursor.y - dragging.cursor.y }, screen.getDisplayNearestPoint(cursor).workArea);
      const previous = window.getBounds();
      if (next.x !== previous.x) dragDirection = next.x < previous.x ? 'left' : 'right';
      window.setPosition(next.x, next.y, false);
      if (Date.now() - dragging.lastEventAt > 15_000) endDrag({});
    }
    send();
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (disposed || !visible()) return;
      if (Date.now() - lastActivityAt >= 750) refreshActivity();
      updatePointer();
    }, 16);
    pollTimer.unref?.();
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = undefined; }
  function changeVisible(value) {
    enabled = value;
    settings.enabled = value;
    void writeSettings();
    onVisibilityChange(value);
    send(true);
  }
  function applyRegions(payload) {
    if (!Array.isArray(payload?.rects) || payload.rects.length > 16) return false;
    const rects = [];
    for (const rect of payload.rects) {
      if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) return false;
      const x = clamp(Math.floor(rect.x), 0, WIDTH);
      const y = clamp(Math.floor(rect.y), 0, HEIGHT);
      const width = clamp(Math.ceil(rect.width), 0, WIDTH - x);
      const height = clamp(Math.ceil(rect.height), 0, HEIGHT - y);
      if (width && height) rects.push({ x, y, width, height });
    }
    pointerRegions = rects;
    // Windows gets an ordinary interactive HWND clipped with its standard window
    // region. It never uses WS_EX_TRANSPARENT or a mouse forwarding hook. This
    // also lets a click arriving directly from outside the window work instantly.
    if (live() && process.platform === 'win32' && typeof window.setShape === 'function' && rects.length) {
      const padded = rects.map(rect => ({
        x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 12),
        width: Math.min(WIDTH, rect.x + rect.width + 10) - Math.max(0, rect.x - 10),
        height: Math.min(HEIGHT, rect.y + rect.height + 12) - Math.max(0, rect.y - 12),
      }));
      // Reserve the compact status bubble above the mascot for hover and alerts.
      padded.push({ x: 25, y: 20, width: 270, height: 32 });
      try { window.setShape(padded); nativeWindowShape = true; } catch { nativeWindowShape = false; }
    }
    ignoringMouse = undefined;
    updatePointer();
    return true;
  }
  async function ensureWindow() {
    if (creating) return creating;
    if (live()) return window;
    creating = (async () => {
      const screens = screen.getAllDisplays();
      const selected = screens.find(item => String(item.id) === settings.lastDisplay) ?? display();
      const bounds = constrainPetBounds(settings.positions[displayKey(selected)], selected.workArea);
      const windowOptions = {
        ...bounds, title: 'Harness 桌宠', frame: false, transparent: true, backgroundColor: '#00000000',
        alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
        fullscreenable: false, hasShadow: false, thickFrame: false, roundedCorners: false,
        focusable: true, show: false,
        webPreferences: {
          preload: path.join(directory, 'pet-preload.cjs'), partition: 'harness-pet',
          nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
          webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: true,
          devTools: false, spellcheck: false,
        },
      };
      const current = new BrowserWindow(windowOptions);
      transparentWindow = windowOptions.transparent === true && windowOptions.backgroundColor === '#00000000';
      window = current;
      loaded = false;
      ignoringMouse = undefined;
      pointerRegions = [];
      nativeWindowShape = false;
      current.setMenu(null);
      current.setOpacity(opacity);
      // Keep the floating companion visible locally while excluding its whole
      // window (including controls) from supported Windows screenshot APIs.
      current.setContentProtection(true);
      current.setAlwaysOnTop(true, 'floating');
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      current.webContents.on('will-navigate', event => event.preventDefault());
      current.webContents.on('will-redirect', event => event.preventDefault());
      current.webContents.on('will-attach-webview', event => event.preventDefault());
      current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      current.webContents.session.setPermissionCheckHandler(() => false);
      current.webContents.session.setDevicePermissionHandler(() => false);
      current.webContents.session.on('will-download', event => event.preventDefault());
      current.on('close', event => { if (!disposed) { event.preventDefault(); hide(); } });
      current.on('closed', () => { loaded = false; if (window === current) window = undefined; });
      current.on('move', () => { if (!disposed && visible()) rememberPosition(); });
      current.webContents.on('render-process-gone', () => { hide(); current.destroy(); });
      try {
        await current.loadFile(path.join(directory, 'pet.html'));
        if (disposed) { current.destroy(); return null; }
        loaded = true;
        refreshActivity();
        send(true);
        return current;
      } catch (error) { current.destroy(); throw error; }
    })();
    try { return await creating; } finally { creating = undefined; }
  }
  async function show() {
    if (disposed || isSuppressed()) return false;
    wantedVisible = true;
    const current = await ensureWindow();
    if (!current || disposed || !wantedVisible || isSuppressed()) return false;
    stopMomentum();
    const bounded = constrainPetBounds(current.getBounds(), display().workArea);
    current.setBounds(bounded);
    setIgnoring(false, true);
    current.webContents.setBackgroundThrottling(false);
    current.showInactive();
    current.setAlwaysOnTop(true, 'floating');
    current.moveTop();
    // Windows applies native visibility/topmost changes asynchronously, especially
    // when launched by a portable wrapper. Reassert after the first mapped frame.
    setTimeout(() => {
      if (!disposed && window === current && !current.isDestroyed() && wantedVisible) {
        current.showInactive(); current.setAlwaysOnTop(true, 'floating');
        ignoringMouse = undefined; updatePointer();
      }
    }, 100).unref?.();
    refreshActivity();
    updatePointer();
    startPolling();
    changeVisible(true);
    return true;
  }
  function hide() {
    wantedVisible = false;
    stopMomentum();
    dragging = undefined;
    if (live()) {
      if (visible()) rememberPosition();
      window.hide();
      setIgnoring(false, true);
      window.webContents.setBackgroundThrottling(true);
    }
    stopPolling();
    if (!disposed) changeVisible(false);
  }
  function openMain(payload) {
    let id = payload?.sessionId ?? activity.sessionId;
    if (id != null && (typeof id !== 'string' || !UUID.test(id))) return false;
    if (id) clearPetActivity(memory, id);
    onOpenSession(id ?? undefined);
    refreshActivity();
    return true;
  }
  function startDrag() {
    if (!visible()) return false;
    stopMomentum();
    dragging = { cursor: screen.getCursorScreenPoint(), bounds: window.getBounds(), lastEventAt: Date.now() };
    setIgnoring(false, true);
    send(true);
    return true;
  }
  function endDrag(payload) {
    if (!dragging) return false;
    dragging = undefined;
    let vx = clamp(Number.isFinite(payload?.velocityX) ? payload.velocityX : 0, -2.4, 2.4);
    let vy = clamp(Number.isFinite(payload?.velocityY) ? payload.velocityY : 0, -2.4, 2.4);
    stopMomentum();
    if (Math.hypot(vx, vy) > 0.12 && visible()) {
      momentum = setInterval(() => {
        if (!visible() || disposed) { stopMomentum(); return; }
        const previous = window.getBounds();
        const area = display().workArea;
        const next = constrainPetBounds({ x: previous.x + vx * 16, y: previous.y + vy * 16 }, area);
        if (next.x === area.x || next.x === area.x + area.width - WIDTH) vx *= -0.3;
        if (next.y === area.y || next.y === area.y + area.height - HEIGHT) vy *= -0.3;
        window.setPosition(next.x, next.y, false);
        vx *= 0.88; vy *= 0.88;
        if (Math.hypot(vx, vy) < 0.06) { stopMomentum(); rememberPosition(); }
      }, 16);
      momentum.unref?.();
    } else rememberPosition();
    updatePointer();
    send(true);
    return true;
  }
  function contextMenu() {
    if (!visible()) return false;
    contextOpen = true;
    setIgnoring(false, true);
    const menu = Menu.buildFromTemplate([
      { label: '返回 Harness', click: () => openMain({}) },
      { type: 'separator' },
      { label: '桌宠设置…', click: () => { settingsRequest++; send(true); } },
      { label: mascotVisible ? '隐藏嘟嘟布布' : '显示嘟嘟布布', click: () => changeMascotVisibility({ visible: !mascotVisible }) },
      { label: '重置桌宠位置', click: () => { const area = display().workArea; window.setBounds(constrainPetBounds(null, area)); rememberPosition(); } },
      { label: '关闭桌宠', click: hide },
    ]);
    menu.popup({ window, callback: () => { contextOpen = false; updatePointer(); } });
    return true;
  }
  ipcMain.handle(PET_COMMAND_CHANNEL, (event, action, payload) => {
    if (disposed || !live() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== petUrl) return { ok: false };
    switch (action) {
      case 'ready': send(true); return state();
      case 'hide': hide(); return { ok: true };
      case 'open-main': return { ok: openMain(payload) };
      case 'context-menu': return { ok: contextMenu() };
      case 'pointer-regions': return { ok: applyRegions(payload) };
      case 'set-opacity': return { ok: changeOpacity(payload), opacity };
      case 'set-scale': return { ok: changeScale(payload), scale };
      case 'set-mascot-visible': return { ok: changeMascotVisibility(payload), mascotVisible };
      case 'drag-start': return { ok: startDrag() };
      case 'drag-move': if (dragging) dragging.lastEventAt = Date.now(); updatePointer(); return { ok: Boolean(dragging) };
      case 'drag-end': return { ok: endDrag(payload) };
      default: return { ok: false };
    }
  });
  const onDisplaysChanged = () => {
    if (!live() || dragging) return;
    window.setBounds(constrainPetBounds(window.getBounds(), display().workArea));
    if (visible()) rememberPosition();
  };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, onDisplaysChanged);

  return {
    show, hide, isVisible: visible,
    onRunFinished(completion) { acceptPetCompletion(memory, completion); refreshActivity(); },
    async restore() {
      try {
        const input = JSON.parse(await fs.readFile(storagePath, 'utf8'));
        if (input?.schemaVersion === 1) {
          const positions = {};
          if (input.positions && typeof input.positions === 'object') for (const [key, value] of Object.entries(input.positions).slice(-20)) {
            if (key.length <= 100 && Number.isFinite(value?.x) && Number.isFinite(value?.y)) positions[key] = { x: value.x, y: value.y };
          }
          const storedOpacity = typeof input.opacity === 'number' && Number.isFinite(input.opacity) && input.opacity >= 0.3 && input.opacity <= 1 ? Math.round(input.opacity * 100) / 100 : 1;
          const storedScale = typeof input.scale === 'number' && Number.isFinite(input.scale) && input.scale >= 0.3 && input.scale <= 1 ? Math.round(input.scale * 100) / 100 : 1;
          const storedMascotVisible = input.mascotVisible !== false;
          settings = { schemaVersion: 1, enabled: input.enabled === true, positions, lastDisplay: String(input.lastDisplay ?? '').slice(0, 30), opacity: storedOpacity, scale: storedScale, mascotVisible: storedMascotVisible };
          opacity = storedOpacity;
          scale = storedScale;
          mascotVisible = storedMascotVisible;
        }
      } catch { /* First launch or an interrupted settings write. */ }
      enabled = settings.enabled;
      if (enabled && !isSuppressed()) await show();
    },
    async smokeCheck() {
      const current = await ensureWindow();
      const page = await current.webContents.executeJavaScript('({bridge: Object.keys(window.harnessPet ?? {}).sort(), hasPet: !!document.querySelector("svg.duo-art .fr"), hasSizeControl: document.querySelector("#scale-slider[type=range]")?.min === "30" && document.querySelector("#scale-slider[type=range]")?.max === "100", hasMascotToggle: document.querySelector("#toggle-mascot") !== null, title: document.title, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, text: document.body.innerText.slice(0, 300)})');
      const prefs = current.webContents.getLastWebPreferences();
      const menu = Menu.getApplicationMenu();
      // A hidden Windows HWND can report a deferred topmost style until mapped.
      // Exercise the actual show path briefly, without activating the main app. The style can
      // arrive a moment later on a busy machine, so poll for a bounded while instead of trusting
      // one sample - a false failure here would fail a release for no reason.
      let topmost = false;
      for (let attempt = 0; attempt < 10 && !topmost; attempt++) {
        current.showInactive();
        current.setAlwaysOnTop(true, 'floating');
        await new Promise(resolve => setTimeout(resolve, 150));
        topmost = current.isAlwaysOnTop();
      }
      const backgroundColor = current.getBackgroundColor();
      // Electron normalizes getBackgroundColor() to opaque black on some Windows
      // builds even when the native window was created as transparent. Keep this
      // check pixel-free and verify the exact creation options used above.
      const transparent = transparentWindow;
      const nativeAffinity = process.platform === 'win32'
        ? await verifyNativeAffinity(current.getNativeWindowHandle())
        : { ok: false, error: 'WINDOW_AFFINITY_REQUIRES_WINDOWS' };
      current.hide();
      const result = {
        page, hidden: !current.isVisible(), backgroundColor, transparent, alwaysOnTop: topmost, nativeWindowShape,
        contentProtection: current.isContentProtected(), nativeAffinity,
        contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration,
        openMenu: menu?.getMenuItemById('pet-show')?.label === '打开桌宠', closeMenu: menu?.getMenuItemById('pet-hide')?.label === '关闭桌宠',
      };
      result.ok = result.hidden && result.transparent && result.alwaysOnTop && result.contentProtection === true && nativeAffinity.ok === true && result.contextIsolation === true && result.sandbox === true && result.nodeIntegration === false && result.openMenu && result.closeMenu && page.hasPet && page.hasSizeControl && page.hasMascotToggle && page.bridge.join(',') === 'command,onState,ready';
      return result;
    },
    async dispose() {
      disposed = true; wantedVisible = false;
      clearTimeout(saveTimer);
      if (saveTimer) await writeSettings();
      stopPolling(); stopMomentum();
      ipcMain.removeHandler(PET_COMMAND_CHANNEL);
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.off(event, onDisplaysChanged);
      if (live()) window.destroy();
      await persistence;
    },
  };
}
