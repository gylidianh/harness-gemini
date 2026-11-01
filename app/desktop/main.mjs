import { app, BrowserWindow, Menu, Notification, View, WebContentsView, clipboard, dialog, ipcMain, nativeImage, safeStorage, screen, session, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkDesktopService, serviceHasStopped, writeSmokeReport } from './smoke.mjs';
import { createCompletionNotifications, installNotificationTestHandler, isProtocolLaunch, OPEN_SESSION_CHANNEL, sessionFromProtocolArgs } from './completion-notifications.mjs';
import { createEmbeddedBrowser } from './browser.mjs';
import { installContextMenu } from './context-menu.mjs';
import { createDesktopPet } from './pet.mjs';
import { createTitleBarKeys } from './titlebar-keys.mjs';

// The visible app name follows the product; explicit legacy paths below preserve user data.
app.setName('Harness Gemini');
app.setAppUserModelId('app.localharness.desktop');

const argv = process.argv.slice(1);
/** fix3: the link a Windows completion toast launches; see completionToastXml. */
const NOTIFICATION_PROTOCOL = 'harness-gemini';
const normalUserData = path.join(app.getPath('appData'), 'Local Harness');
let flags;
let mainWindow;
let server;
let completionNotifications;
// Retain launches before the service/window/notification manager exists. A newer click wins.
let pendingNotificationLaunch = isProtocolLaunch(argv, NOTIFICATION_PROTOCOL)
  ? { sessionId: sessionFromProtocolArgs(argv, NOTIFICATION_PROTOCOL) ?? undefined } : undefined;
let embeddedBrowser;
let desktopPet;
let origin;
let dataDir;
let workspace;
let quitting;
let finalExit = false;
let quitConfirmationOpen = false;
const lifecycle = { didFinishLoad: false, readyToShow: false, renderProcessGone: false, uncaughtScriptError: false, consoleErrorCount: 0 };

function option(name) {
  const prefix = `--${name}=`;
  const equals = argv.find(value => value.startsWith(prefix));
  if (equals !== undefined) return equals.slice(prefix.length);
  const position = argv.indexOf(`--${name}`);
  return position < 0 ? undefined : argv[position + 1];
}

function absoluteOption(name) {
  const value = option(name);
  if (value === undefined) return undefined;
  if (!value || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`INVALID_${name.toUpperCase().replaceAll('-', '_')}`);
  return path.resolve(value);
}

function parseFlags() {
  const result = { smokeTest: absoluteOption('smoke-test'), dataDir: absoluteOption('data-dir'), workspaceDir: absoluteOption('workspace-dir'), profileDir: absoluteOption('profile-dir') };
  if (result.smokeTest && (!result.dataDir || !result.workspaceDir)) throw new Error('SMOKE_REQUIRES_ISOLATED_DIRECTORIES');
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (result.smokeTest && canonical(result.dataDir) === canonical(path.join(normalUserData, 'data'))) throw new Error('SMOKE_CANNOT_USE_PRODUCTION_DATA');
  return result;
}

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 1.2.7-titlebar: the system caption and menu bar are replaced by one row drawn by the page
 * (preload.cjs). Windows still paints the minimise/maximise/close buttons through
 * titleBarOverlay; the menus themselves stay native and keep their accelerators - the page
 * only asks for one of them to be popped up under the button that was clicked.
 */
const TITLE_BAR_HEIGHT = 36;
const TITLE_BAR_INFO_CHANNEL = 'harness:titlebar-info';
const TITLE_BAR_MENU_CHANNEL = 'harness:titlebar-menu';
const TITLE_BAR_COLORS_CHANNEL = 'harness:titlebar-colors';
const TITLE_BAR_FOCUS_CHANNEL = 'harness:titlebar-focus';
const TITLE_BAR_KEYS_CHANNEL = 'harness:titlebar-keys';
// The overlay stops one pixel short so the bar's bottom border runs under the window buttons too.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
let titleBarColors = { color: '#ffffff', symbolColor: '#202124' };

function titleBarSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents && ownUrl(mainWindow.webContents.getURL()));
}

function titleBarMenus() {
  return (Menu.getApplicationMenu()?.items ?? []).filter(item => item.submenu && item.visible !== false);
}

function installTitleBarHandlers(appIcon) {
  let iconUrl = '';
  try { if (appIcon) iconUrl = appIcon.resize({ width: 32, height: 32, quality: 'best' }).toDataURL(); } catch { iconUrl = ''; }
  ipcMain.handle(TITLE_BAR_INFO_CHANNEL, event => {
    if (!titleBarSender(event)) return null;
    return { title: 'Harness Gemini', icon: iconUrl, height: TITLE_BAR_HEIGHT, focused: mainWindow.isFocused(), menus: titleBarMenus().map(item => String(item.label).slice(0, 20)) };
  });
  ipcMain.handle(TITLE_BAR_MENU_CHANNEL, (event, index, x, y) => new Promise(resolve => {
    if (!titleBarSender(event) || quitting) { resolve(false); return; }
    const menus = titleBarMenus();
    if (!Number.isInteger(index) || index < 0 || index >= menus.length || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20_000 || Math.abs(y) > 20_000) { resolve(false); return; }
    const zoom = mainWindow.webContents.getZoomFactor() || 1;
    try {
      menus[index].submenu.popup({ window: mainWindow, x: Math.max(0, Math.round(x * zoom)), y: Math.max(0, Math.round(y * zoom)), callback: () => resolve(true) });
    } catch { resolve(false); }
  }));
  ipcMain.on(TITLE_BAR_COLORS_CHANNEL, (event, value) => {
    if (!titleBarSender(event) || process.platform === 'darwin') return;
    if (!HEX_COLOR.test(value?.color ?? '') || !HEX_COLOR.test(value?.symbolColor ?? '')) return;
    if (value.color === titleBarColors.color && value.symbolColor === titleBarColors.symbolColor) return;
    titleBarColors = { color: value.color, symbolColor: value.symbolColor };
    try { mainWindow.setTitleBarOverlay({ ...titleBarColors, height: TITLE_BAR_HEIGHT - 1 }); } catch { /* Overlay colours are cosmetic. */ }
  });
}

/**
 * 1.2.8-titlebar-focus/keys: two things only the main process knows.
 *
 * The window's own focus decides whether the drawn bar looks inactive. The page's blur event
 * also fires when focus moves into the embedded browser's WebContentsView, which greyed the bar
 * out while the window was still the active one.
 *
 * The native menu bar is hidden, so Alt (tapped on its own), F10 and Alt+letter are routed from
 * before-input-event to the row in the page; the row pops the same native menu a click pops, so
 * the arrow keys inside it keep working.
 */
/** 1.3.0: set by installTitleBarWindowState; the embedded browser routes its keys through it. */
let titleBarGuestInput = null;

function installTitleBarWindowState(window) {
  const contents = window.webContents;
  const report = focused => {
    if (window.isDestroyed()) return;
    try { contents.send(TITLE_BAR_FOCUS_CHANNEL, focused); } catch { /* The window is closing. */ }
  };
  const decide = createTitleBarKeys();
  window.on('focus', () => { decide.reset(); report(true); });
  window.on('blur', () => { decide.reset(); report(false); });
  contents.on('before-input-event', (event, input) => {
    const action = decide(input, { labels: titleBarMenus().map(item => String(item.label)), fromPage: true });
    if (!action) return;
    event.preventDefault();
    try { contents.send(TITLE_BAR_KEYS_CHANNEL, action); } catch { /* The window is closing. */ }
  });
  // 1.3.0: with focus inside the embedded browser, Alt and F10 still reach the menu row (the
  // page keeps its own Alt+letter access keys). The app page takes focus first, as a click would.
  titleBarGuestInput = (event, input) => {
    if (window.isDestroyed()) return;
    const action = decide(input, { labels: titleBarMenus().map(item => String(item.label)), fromPage: false });
    if (!action) return;
    event.preventDefault();
    try { contents.focus(); contents.send(TITLE_BAR_KEYS_CHANNEL, action); } catch { /* The window is closing. */ }
  };
}

function ownUrl(value) {
  try { return Boolean(origin) && new URL(value).origin === origin; } catch { return false; }
}

function dispatchNotificationLaunch() {
  if (flags?.smokeTest || finalExit) { pendingNotificationLaunch = undefined; return false; }
  const launch = pendingNotificationLaunch;
  if (!launch || !completionNotifications || !completionNotifications.openSessionById(launch.sessionId)) return false;
  if (pendingNotificationLaunch === launch) pendingNotificationLaunch = undefined;
  return true;
}

function queueNotificationLaunch(args) {
  if (!isProtocolLaunch(args, NOTIFICATION_PROTOCOL)) return false;
  pendingNotificationLaunch = { sessionId: sessionFromProtocolArgs(args, NOTIFICATION_PROTOCOL) ?? undefined };
  dispatchNotificationLaunch();
  return true;
}

function externalHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function openExternalRequested(value) {
  const url = externalHttpUrl(value);
  if (!url || quitting || !mainWindow || mainWindow.isDestroyed()) return;
  embeddedBrowser?.open(url);
}

function navigationUrl(event, detail) {
  return typeof detail === 'string' ? detail : detail?.url ?? event.url ?? '';
}

function secureWindow(window) {
  const contents = window.webContents;
  const session = contents.session;
  const clipboardAllowed = (webContents, permission, requestedOrigin) => webContents === contents && permission === 'clipboard-sanitized-write' && ownUrl(requestedOrigin);
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => clipboardAllowed(webContents, permission, requestingOrigin));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => callback(clipboardAllowed(webContents, permission, details?.requestingUrl ?? webContents.getURL())));
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.on('will-download', (event, item, webContents) => {
    if (webContents !== contents || !ownUrl(item.getURL())) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  // Right-clicking an editable field or a selection gets the native editing menu. Its items are
  // Electron roles with this application's own labels, so cut/copy/paste behave natively while
  // the wording follows the interface rather than the operating system.
  installContextMenu(contents, { Menu, BrowserWindow, getLocale: () => 'zh-CN' });
  contents.on('will-navigate', (event, detail) => {
    const target = navigationUrl(event, detail);
    if (!ownUrl(target)) { event.preventDefault(); void openExternalRequested(target); }
  });
  contents.on('will-frame-navigate', event => {
    // Main-frame links reach will-navigate and open the isolated browser panel.
    if (!event.isMainFrame && !ownUrl(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, detail) => {
    if (!ownUrl(navigationUrl(event, detail))) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => { void openExternalRequested(url); return { action: 'deny' }; });
  contents.on('did-finish-load', () => {
    lifecycle.didFinishLoad = true;
    try { dispatchNotificationLaunch(); completionNotifications?.flushDeferred(); } catch { /* Window may be closing. */ }
  });
  contents.on('did-fail-load', (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) lifecycle.mainFrameLoadError = errorCode;
  });
  contents.on('render-process-gone', (_event, details) => {
    lifecycle.renderProcessGone = true;
    lifecycle.renderExitReason = details.reason;
  });
  contents.on('console-message', (event, detail, legacyMessage) => {
    // Count runtime errors without writing renderer text, prompts, or credentials to a log.
    const level = event.level ?? (typeof detail === 'object' ? detail.level : detail);
    const message = event.message ?? (typeof detail === 'object' ? detail.message : legacyMessage);
    if (level === 'error' || level === 3) lifecycle.consoleErrorCount++;
    if (typeof message === 'string' && /(?:Uncaught|SyntaxError:|ReferenceError:)/.test(message)) lifecycle.uncaughtScriptError = true;
  });
}

/**
 * The window icon as a decoded bitmap.
 *
 * Windows takes a running window's taskbar mark from the window itself, not from the executable,
 * and it cannot open a path that only exists inside app.asar. Two consequences shaped this:
 * the file has to be readable from disk, and the decoded bitmap has to be handed to the window
 * before it is shown. `extraResources` puts a plain copy at the root of the resources directory,
 * which is the first candidate; the archive and unpacked locations remain as fallbacks.
 */
async function loadWindowIcon() {
  const resources = process.resourcesPath;
  const candidates = [
    resources && path.join(resources, 'icon.ico'),
    resources && path.join(resources, 'app.asar.unpacked', 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    resources && path.join(resources, 'build', 'icon.ico'),
    path.join(path.dirname(process.execPath), 'build', 'icon.ico'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('\0')) continue;
    try {
      await fs.access(candidate);
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch { /* Try the next location; a missing icon must never stop the app. */ }
  }
  return null;
}

async function openDirectory(directory) {
  if (flags?.smokeTest || quitting) return;
  const error = await shell.openPath(directory);
  if (error && mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, { type: 'error', title: '无法打开文件夹', message: '无法打开该目录，请检查它是否仍然存在。' });
  }
}

/** The folder holding errors.log; created on demand so the menu entry always opens something. */
async function openErrorLog() {
  if (!dataDir) return;
  const directory = path.join(dataDir, 'logs');
  await fs.mkdir(directory, { recursive: true }).catch(() => {});
  await openDirectory(directory);
}

/** A failure before the service exists cannot use its log, so it is appended here directly. */
async function recordStartupFailure(error) {
  try {
    const base = dataDir ?? path.join(normalUserData, 'data');
    const directory = path.join(base, 'logs');
    await fs.mkdir(directory, { recursive: true });
    const entry = { time: new Date().toISOString(), version: app.getVersion(), source: 'startup', message: String(error?.message ?? error ?? '启动失败').slice(0, 2_000), ...(error?.code ? { code: String(error.code) } : {}), ...(typeof error?.stack === 'string' ? { stack: error.stack.slice(0, 6_000) } : {}) };
    await fs.appendFile(path.join(directory, 'errors.log'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* Logging a startup failure must never hide the dialog that reports it. */ }
}

function currentWorkspace() { return server?.app?.locals?.harness?.store?.settings?.workspace ?? workspace; }

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开数据目录', click: () => { void openDirectory(dataDir); } },
      { label: '打开错误日志', click: () => { void openErrorLog(); } },
      { label: '打开工作目录', click: () => { void openDirectory(currentWorkspace()); } },
      { type: 'separator' },
      { label: '关闭', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => { void requestQuit(); } },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
      { role: 'delete', label: '删除' }, { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ] },
    { label: '查看', submenu: [
      { label: '返回主界面', click: () => { if (mainWindow && !quitting) void mainWindow.loadURL(origin).catch(() => {}); } },
      { label: '内置浏览器', accelerator: 'CmdOrCtrl+Shift+B', click: () => { if (!quitting) embeddedBrowser?.open(); } },
      { role: 'reload', label: '重新载入', accelerator: 'CmdOrCtrl+R' }, { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
    ] },
    { label: '帮助', submenu: [
      { label: '关于 Harness Gemini', click: () => { if (mainWindow) void dialog.showMessageBox(mainWindow, { type: 'info', title: '关于 Harness Gemini', message: `Harness Gemini ${app.getVersion()}`, detail: '聊天、图片、编程与内置浏览器。会话与图片保存在本机，模型请求发送到你在设置中配置的接口。' }); } },
    ] },
    { label: '桌宠', submenu: [
      { id: 'pet-show', label: '打开桌宠', enabled: !desktopPet?.isVisible(), click: () => {
        void desktopPet?.show().catch(() => { if (mainWindow && !quitting) void dialog.showMessageBox(mainWindow, { type: 'error', title: '桌宠暂时不可用', message: '无法打开桌宠，请重新启动 Harness Gemini 后重试。' }); });
      } },
      { id: 'pet-hide', label: '关闭桌宠', enabled: Boolean(desktopPet?.isVisible()), click: () => desktopPet?.hide() },
    ] },
  ]));
}

/** A tool that ignores cancellation must not keep a hidden window's process alive forever. */
const SHUTDOWN_TIMEOUT_MS = 20_000;

async function stopService() {
  if (!server) return;
  let deadline;
  const ceiling = new Promise((_resolve, reject) => {
    deadline = setTimeout(() => {
      server.closeAllConnections?.();
      const error = new Error('SHUTDOWN_TIMEOUT'); error.code = 'SHUTDOWN_TIMEOUT';
      reject(error);
    }, SHUTDOWN_TIMEOUT_MS);
  });
  ceiling.catch(() => {});
  try {
    // Save and cancel model/tool work before terminating lingering HTTP/download connections.
    // harness.close() is memoised, so server.stop() below waits for this same shutdown.
    await Promise.race([server.app.locals.harness.close(), ceiling]);
    const closingServer = server.stop();
    const timer = setTimeout(() => server.closeAllConnections?.(), 3_000);
    timer.unref?.();
    try { await Promise.race([closingServer, ceiling]); } finally { clearTimeout(timer); }
  } finally { clearTimeout(deadline); }
}

function requestQuit({ confirmActive = true, exitCode = 0, smokeReport } = {}) {
  if (quitting) return quitting;
  quitting = (async () => {
    // Assign the suppression promise before a native confirmation can fail/re-enter synchronously.
    await Promise.resolve();
    const active = server?.app?.locals?.harness?.runs?.size ?? 0;
    if (confirmActive && active > 0 && !flags?.smokeTest && mainWindow && !mainWindow.isDestroyed()) {
      quitConfirmationOpen = true;
      let result;
      try {
        result = await dialog.showMessageBox(mainWindow, { type: 'question', title: '任务正在运行', message: '停止当前任务并关闭 Harness Gemini？', detail: '已收到的文字、图片和工具记录会保存在本机。', buttons: ['继续等待', '停止并关闭'], defaultId: 0, cancelId: 0, noLink: true });
      } catch { result = { response: 0 }; } // A failed confirmation must leave the app usable.
      finally { quitConfirmationOpen = false; }
      if (result?.response !== 1) {
        quitting = null;
        // fix3: completions that finished while the dialog was open are announced now.
        setImmediate(() => { try { dispatchNotificationLaunch(); completionNotifications?.flushDeferred(); } catch { /* Best effort. */ } });
        return;
      }
    }
    completionNotifications?.dispose();
    embeddedBrowser?.dispose();
    await desktopPet?.dispose();
    mainWindow?.hide();
    let shutdownError;
    try { await stopService(); }
    catch (error) { shutdownError = error?.code ?? error?.name ?? 'SHUTDOWN_FAILED'; exitCode = 1; server?.closeAllConnections?.(); }
    if (smokeReport && flags?.smokeTest) {
      smokeReport.serviceStopped = origin ? await serviceHasStopped(origin) : !server;
      smokeReport.finishedAt = new Date().toISOString();
      if (shutdownError) smokeReport.shutdownError = shutdownError;
      smokeReport.ok = Boolean(smokeReport.ok && smokeReport.serviceStopped && !shutdownError);
      if (!smokeReport.ok && !smokeReport.error) smokeReport.error = shutdownError ?? (smokeReport.serviceStopped ? 'SMOKE_CHECKS_FAILED' : 'SMOKE_SERVICE_DID_NOT_STOP');
      exitCode = smokeReport.ok ? 0 : 1;
      try { await writeSmokeReport(flags.smokeTest, smokeReport); }
      catch { exitCode = 1; }
    } else if (shutdownError && !flags?.smokeTest) {
      dialog.showErrorBox('关闭时遇到问题', '未能确认所有记录均已保存。请重新打开应用检查最近的会话。');
    }
    finalExit = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.exit(exitCode);
  })();
  return quitting;
}

function baseSmokeReport() {
  return { schemaVersion: 1, ok: false, mode: 'desktop-smoke', pid: process.pid, url: origin ?? null, appPath: app.getAppPath(), userData: app.getPath('userData'), normalUserData, dataDir: dataDir ?? flags?.dataDir, workspace: workspace ?? flags?.workspaceDir, startedAt: new Date().toISOString(), modelRequestsPerformed: false };
}

async function launch() {
  flags = parseFlags();
  const userData = flags.smokeTest ? path.join(flags.dataDir, 'desktop-smoke-profile') : flags.profileDir ?? normalUserData;
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  if (!app.requestSingleInstanceLock()) { finalExit = true; app.exit(0); return; }
  app.on('second-instance', (_event, commandLine) => {
    if (flags.smokeTest || finalExit) return;
    // Queue even during startup/loading/a confirmation, instead of falling back to focus and
    // losing the conversation. The manager sends only to a loaded, trusted main page.
    if (queueNotificationLaunch(commandLine)) return;
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });
  app.on('activate', () => { if (mainWindow && !mainWindow.isDestroyed() && !flags.smokeTest && !quitting) mainWindow.show(); });
  app.on('before-quit', event => { if (!finalExit) { event.preventDefault(); void requestQuit(); } });
  app.on('window-all-closed', () => { if (!finalExit) void requestQuit({ confirmActive: false }); });
  process.once('SIGINT', () => { void requestQuit({ confirmActive: false }); });
  process.once('SIGTERM', () => { void requestQuit({ confirmActive: false }); });
  await app.whenReady();
  dataDir = flags.dataDir ?? path.join(app.getPath('userData'), 'data');
  workspace = flags.workspaceDir ?? path.join(app.getPath('documents'), 'Local Harness', 'workspace');
  const { startServer } = await import('../server/index.mjs');
  const { safeStorageCodec } = await import('../server/secret.mjs');
  // API keys are sealed with the OS keychain, so settings.json never holds a usable key.
  const secrets = safeStorageCodec(safeStorage);
  // fix3: the toast's protocol link only works while it is registered to this executable. The
  // packaged app checks/registers its own link. This is best effort, not proof of OS delivery.
  let notificationProtocol = null;
  if (process.platform === 'win32' && app.isPackaged && !flags.smokeTest) {
    try {
      // electron-builder portable apps run an extracted exe that can disappear on exit. Bind
      // the protocol to the persistent launcher, not that temporary child process. Do not fall
      // back to registering a transient path if the wrapper advertises an invalid launcher.
      const portable = process.env?.PORTABLE_EXECUTABLE_FILE;
      let executable;
      if (portable !== undefined) {
        if (typeof portable !== 'string' || !path.isAbsolute(portable) || portable.includes('\0') || path.extname(portable).toLowerCase() !== '.exe'
          || !(await fs.stat(portable)).isFile()) throw new Error('INVALID_PORTABLE_NOTIFICATION_LAUNCHER');
        executable = path.resolve(portable);
      }
      const protocolArgs = executable ? [NOTIFICATION_PROTOCOL, executable] : [NOTIFICATION_PROTOCOL];
      if (app.isDefaultProtocolClient(...protocolArgs) || app.setAsDefaultProtocolClient(...protocolArgs)) notificationProtocol = NOTIFICATION_PROTOCOL;
    } catch { notificationProtocol = null; }
  }
  completionNotifications = createCompletionNotifications({
    Notification,
    getWindow: () => mainWindow,
    isEnabled: () => server?.app?.locals?.harness?.store?.settings?.completionNotification !== false,
    isSuppressed: () => Boolean(flags.smokeTest || quitConfirmationOpen || quitting || finalExit),
    isOwnUrl: ownUrl,
    protocol: notificationProtocol,
  });
  installNotificationTestHandler({ ipcMain, getWindow: () => mainWindow, isOwnUrl: ownUrl, manager: completionNotifications });
  dispatchNotificationLaunch();
  // Only the main window may ask, only for an image this application itself serves, and the
  // renderer never receives an exception - just a short reason it can show next to the button.
  ipcMain.handle('harness:copy-image', async (event, value) => {
    const refuse = error => ({ ok: false, error });
    try {
      if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) return refuse('只能复制本机图片。');
      if (typeof value !== 'string' || !value || value.length > 4_096) return refuse('只能复制本机图片。');
      let href;
      try { href = new URL(value, origin).href; } catch { return refuse('只能复制本机图片。'); }
      if (!ownUrl(href)) return refuse('只能复制本机图片。');
      const response = await fetch(href, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return refuse('复制失败，请稍后重试。');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_CLIPBOARD_IMAGE_BYTES) return refuse('图片太大，无法复制到剪贴板。');
      if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) return refuse('只能复制图片文件。');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return refuse('图片太大，无法复制到剪贴板。');
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return refuse('这张图片无法读取。');
      clipboard.writeImage(image);
      return { ok: true };
    } catch {
      return refuse('复制失败，请稍后重试。');
    }
  });
  // 1.3.4: the settings API only shows masked keys. The full key of one connection is handed to
  // the app's own window, on request, through this bridge; no other local process can ask for it.
  ipcMain.handle('harness:reveal-api-key', async (event, value) => {
    const refuse = error => ({ ok: false, error });
    try {
      if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) return refuse('只能在设置页显示密钥。');
      if (event.senderFrame && (event.senderFrame !== mainWindow.webContents.mainFrame || !ownUrl(event.senderFrame.url))) return refuse('只能在设置页显示密钥。');
      const store = server?.app?.locals?.harness?.store;
      if (!store) return refuse('本机服务尚未就绪。');
      return { ok: true, apiKey: store.revealApiKey(typeof value === 'string' ? value : '') };
    } catch (error) {
      return refuse(error?.status === 404 ? '这个连接还没有保存，无法显示密钥。' : error?.status === 400 ? '连接 ID 不正确。' : '暂时无法显示密钥。');
    }
  });
  server = await startServer({ port: 0, dataDir, defaultWorkspace: workspace, distDir: path.join(app.getAppPath(), 'dist'), onRunFinished: completion => {
    completionNotifications.notify(completion);
    desktopPet?.onRunFinished(completion);
  }, secrets, authorizeBrowserNavigation: async (url, access) => {
    if (!embeddedBrowser) throw new Error('内置浏览器尚未准备好，请稍后重试。');
    await embeddedBrowser.authorizeToolNavigation(url, access);
  } });
  origin = `http://127.0.0.1:${server.address().port}`;
  workspace = currentWorkspace();
  if (flags.smokeTest && server.app.locals.harness.store.settings.baseUrl) throw new Error('SMOKE_REQUIRES_UNCONFIGURED_DATA');
  const preloadPath = path.join(app.getAppPath(), 'desktop', 'preload.cjs');
  const preferences = {
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, navigateOnDragDrop: false, safeDialogs: true,
    preload: preloadPath, backgroundThrottling: false,
    devTools: !app.isPackaged && !flags.smokeTest,
  };
  const appIcon = await loadWindowIcon();
  installTitleBarHandlers(appIcon);
  mainWindow = new BrowserWindow({
    width: 1_200, height: 820, minWidth: 880, minHeight: 600, title: 'Harness Gemini', backgroundColor: '#ffffff', show: false,
    ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden', titleBarOverlay: { ...titleBarColors, height: TITLE_BAR_HEIGHT - 1 } }),
    ...(appIcon ? { icon: appIcon } : {}), webPreferences: preferences,
  });
  // A path inside app.asar cannot be opened by the shell, and a portable build runs from an
  // extracted directory, so the bitmap is attached to the window itself as well.
  if (appIcon) mainWindow.setIcon(appIcon);
  secureWindow(mainWindow);
  embeddedBrowser = createEmbeddedBrowser({ onBeforeInput: (event, input) => titleBarGuestInput?.(event, input), confirmPrivateNavigation: async url => {
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return false;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: '允许访问本机或内网地址？',
      message: '内置浏览器请求访问一个本机或内网地址。', detail: `${String(url).slice(0, 500)}\n\n仅授权当前标签页访问此来源（协议、主机和端口），不授权其他标签页。`,
      buttons: ['取消', '允许当前标签页访问'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  }, window: mainWindow, appOrigin: origin, View, WebContentsView, session, ipcMain, Menu, BrowserWindow, nativeImage, presentationPath: path.join(app.getPath('userData'), 'browser-presentation.json'), openExternalUrl: url => shell.openExternal(url) });
  desktopPet = createDesktopPet({
    BrowserWindow, Menu, screen, ipcMain,
    storagePath: path.join(app.getPath('userData'), 'desktop-pet.json'),
    getHarness: () => server?.app?.locals?.harness,
    isSuppressed: () => Boolean(flags.smokeTest || quitting || finalExit),
    onVisibilityChange: visible => {
      const menu = Menu.getApplicationMenu();
      const open = menu?.getMenuItemById('pet-show');
      const close = menu?.getMenuItemById('pet-hide');
      if (open) open.enabled = !visible;
      if (close) close.enabled = visible;
    },
    onOpenSession: sessionId => {
      if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      if (sessionId) mainWindow.webContents.send(OPEN_SESSION_CHANNEL, { sessionId });
    },
  });
  const readyToShow = new Promise(resolve => mainWindow.once('ready-to-show', () => {
    lifecycle.readyToShow = true;
    // The shell builds the taskbar button while the window is being shown; re-applying the icon
    // here is what stops it from sitting on the generic placeholder until Explorer refreshes.
    if (appIcon) mainWindow.setIcon(appIcon);
    if (!flags.smokeTest && !quitting) mainWindow.show();
    resolve();
  }));
  mainWindow.on('close', event => { if (!finalExit) { event.preventDefault(); if (!quitConfirmationOpen) void requestQuit(); } });
  installMenu();
  // The menu stays installed so its accelerators keep working; the row in the page shows it.
  if (process.platform !== 'darwin') {
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(false);
    installTitleBarWindowState(mainWindow);
  }
  await mainWindow.loadURL(origin);
  if (!flags.smokeTest) {
    if (!mainWindow.isVisible() && !quitting) mainWindow.show();
    // No timing guess: preload buffers a session until the renderer subscribes. did-finish-load
    // drains clicks received before/during load, including a cold protocol launch.
    dispatchNotificationLaunch();
    completionNotifications?.flushDeferred();
    await desktopPet.restore();
    return;
  }
  await Promise.race([readyToShow, new Promise(resolve => setTimeout(resolve, 3_000))]);
  const workspaceStartsClosed = await mainWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('.right-panel')).display === 'none' && !document.querySelector('.app-shell').classList.contains('has-right-panel')");
  // Exercise explicitly opening the panel as well as its closed startup state.
  await mainWindow.webContents.executeJavaScript("document.querySelector('.chat-header button[aria-label=\"打开右侧面板\"]')?.click()");
  await new Promise(resolve => setTimeout(resolve, 300));
  const effective = mainWindow.webContents.getLastWebPreferences();
  const security = {
    nodeIntegration: effective.nodeIntegration,
    contextIsolation: effective.contextIsolation,
    sandbox: effective.sandbox,
    webSecurity: effective.webSecurity,
    // Electron 44 omits preload and throttling from getLastWebPreferences.
    // Validate the configured file, absence of extra session scripts, and the live bridge below.
    preloadConfigured: Boolean(preferences.preload),
    preloadIsExpected: preferences.preload === preloadPath && (effective.preload === undefined || effective.preload === preloadPath),
    sessionPreloadCount: mainWindow.webContents.session.getPreloadScripts().length,
    backgroundThrottling: mainWindow.webContents.getBackgroundThrottling(),
    webviewTag: effective.webviewTag,
    noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
    debugPortConfigured: app.commandLine.hasSwitch('remote-debugging-port'),
    rendererOrigin: origin,
    permissions: 'own-origin clipboard-sanitized-write only',
  };
  const desktopBridge = await mainWindow.webContents.executeJavaScript('(async () => ({ keys: Object.keys(window.harnessDesktop ?? {}).sort(), completionNotifications: window.harnessDesktop?.completionNotifications, copyImage: typeof window.harnessDesktop?.copyImage, revealApiKey: typeof window.harnessDesktop?.revealApiKey, onOpenSession: typeof window.harnessDesktop?.onOpenSession, testCompletionNotification: typeof window.harnessDesktop?.testCompletionNotification, browserKeys: Object.keys(window.harnessDesktop?.browser ?? {}).sort(), browserState: await window.harnessDesktop?.browser?.getState(), attachmentTray: document.querySelector(".composer-attachments") !== null, attachmentInput: document.querySelector(".attachment-input[type=file]")?.multiple === true, titleBar: await new Promise(r => setTimeout(r, 300)).then(() => { const bar = document.getElementById("hg-titlebar"); const root = document.getElementById("root"); return bar ? { menus: [...bar.querySelectorAll(".hg-tb-menu")].map(b => b.textContent), title: bar.querySelector(".hg-tb-title")?.textContent ?? "", barBottom: Math.round(bar.getBoundingClientRect().bottom), rootTop: Math.round(root?.getBoundingClientRect().top ?? -1) } : null; }) }))()');
  // The conversation header and native menus now occupy the same top row. Keep fixed
  // descendants contained, and check that live controls clear the menus/caption buttons.
  const titleBarLayout = await mainWindow.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('hg-titlebar');
    const root = document.getElementById('root');
    if (!bar || !root) return null;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    root.appendChild(probe);
    const probeTop = Math.round(probe.getBoundingClientRect().top);
    probe.remove();
    const style = getComputedStyle(root);
    const rootStyle = getComputedStyle(document.documentElement);
    const header = document.querySelector('.chat-header');
    const heading = header?.querySelector('.chat-heading');
    const actions = header?.querySelector('.chat-header-actions');
    const zoom = 1 / Number(rootStyle.getPropertyValue('--hg-tb-inverse-zoom') || 1);
    return {
      contain: style.contain, position: style.position,
      barBottom: Math.round(bar.getBoundingClientRect().bottom),
      rootTop: Math.round(root.getBoundingClientRect().top),
      probeTop,
      headerTop: Math.round(header?.getBoundingClientRect().top ?? -1),
      headerBottom: Math.round(header?.getBoundingClientRect().bottom ?? -1),
      headingLeft: Math.round(heading?.getBoundingClientRect().left ?? -1),
      menuRight: Math.round(bar.getBoundingClientRect().right),
      actionsRight: Math.round(actions?.getBoundingClientRect().right ?? -1),
      captionLeft: Math.round(window.innerWidth - 138 / zoom),
      dangerStrong: rootStyle.getPropertyValue('--danger-strong').trim(),
      warningSurface: rootStyle.getPropertyValue('--warning-surface').trim(),
      textSecondary: rootStyle.getPropertyValue('--text-secondary').trim(),
    };
  })()`);
  // Narrow the window until the right panel turns into an overlay: that panel is what used to
  // sit on top of the caption row and swallow the window buttons.
  mainWindow.setSize(900, 640);
  await new Promise(resolve => setTimeout(resolve, 700));
  const titleBarOverlay = await mainWindow.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('hg-titlebar');
    const panel = document.querySelector('.app-shell.panel-overlay .right-panel');
    const shade = document.querySelector('.app-shell.panel-overlay .right-mobile-shade');
    const barBottom = Math.round(bar?.getBoundingClientRect().bottom ?? -1);
    const rect = element => element ? { top: Math.round(element.getBoundingClientRect().top), bottom: Math.round(element.getBoundingClientRect().bottom) } : null;
    const hit = document.elementFromPoint(Math.max(1, window.innerWidth - 200), Math.max(1, barBottom - 8));
    return {
      overlay: Boolean(panel), barBottom, windowHeight: window.innerHeight,
      panel: rect(panel), shade: rect(shade),
      panelContentTop: Math.round(panel?.querySelector('.right-panel-header')?.getBoundingClientRect().top ?? -1),
      topRightDraggable: Boolean(hit?.closest('.chat-header') || (panel && getComputedStyle(panel, '::before').display !== 'none' && getComputedStyle(panel, '::before').getPropertyValue('-webkit-app-region') === 'drag')),
      topRight: hit ? String(hit.id || hit.className || hit.tagName) : '',
    };
  })()`);
  mainWindow.setSize(1_200, 820);
  await new Promise(resolve => setTimeout(resolve, 300));
  // F10 must reach the row, Escape must hand focus back.
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F10' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F10' });
  await new Promise(resolve => setTimeout(resolve, 400));
  const keyboardFocused = await mainWindow.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('hg-titlebar');
    const active = document.activeElement;
    return { inBar: Boolean(bar && active && bar.contains(active)), label: String(active?.textContent ?? '').slice(0, 20) };
  })()`);
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise(resolve => setTimeout(resolve, 300));
  const keyboardLeft = await mainWindow.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById('hg-titlebar');
    const active = document.activeElement;
    return { inBar: Boolean(bar && active && bar.contains(active)) };
  })()`);
  const titleBarZoom = [];
  for (const zoom of [0.8, 1.25, 1.5]) {
    // Browser presentation restoration may finish after the initial page load. Allow its
    // initial zoom update to settle before sampling this explicit test zoom.
    for (let attempt = 0; attempt < 3; attempt++) {
      mainWindow.webContents.setZoomFactor(zoom);
      await new Promise(resolve => setTimeout(resolve, 500));
      const inverse = await mainWindow.webContents.executeJavaScript("Number(getComputedStyle(document.documentElement).getPropertyValue('--hg-tb-inverse-zoom'))");
      if (Math.abs(mainWindow.webContents.getZoomFactor() - zoom) < 0.01 && Math.abs(inverse - 1 / zoom) < 0.01) break;
    }
    const geometry = await mainWindow.webContents.executeJavaScript(`(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
      const bar = rect('#hg-titlebar');
      const header = rect('.chat-header');
      const heading = rect('.chat-heading');
      const actions = rect('.chat-header>.chat-header-actions');
      const zoom = 1 / Number(getComputedStyle(document.documentElement).getPropertyValue('--hg-tb-inverse-zoom') || 1);
      return { zoom, barBottom: bar?.bottom, headerTop: header?.top, headerBottom: header?.bottom,
        menuRight: bar?.right, headingLeft: heading?.left, actionsRight: actions?.right,
        captionLeft: window.innerWidth - 138 / zoom };
    })()`);
    titleBarZoom.push({ requestedZoom: zoom, ...geometry });
  }
  mainWindow.webContents.setZoomFactor(1);
  await new Promise(resolve => setTimeout(resolve, 300));
  const titleBarThemes = await mainWindow.webContents.executeJavaScript("(() => {\n  const html = document.documentElement, shell = document.querySelector('.app-shell');\n  const savedHtml = html.dataset.skin, savedShell = shell.dataset.skin;\n  const results = ['classic', 'claude', 'gemini-dark', 'luxe-noir', 'luxe-ivory'].map(skin => {\n    html.dataset.skin = shell.dataset.skin = skin;\n    const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;\n    const sidebarStyle = getComputedStyle(document.querySelector('.sidebar'));\n    const sidebar = sidebarStyle.backgroundImage.match(/rgba?\\([^)]+\\)/)?.[0] ?? color('.sidebar');\n    return { skin, sidebar, menu: color('#hg-titlebar'), chat: color('.chat-header'),\n      caption: getComputedStyle(document.querySelector('.right-panel'), '::before').backgroundColor };\n  });\n  html.dataset.skin = savedHtml; shell.dataset.skin = savedShell;\n  return results;\n})()");
  const checks = await checkDesktopService({ origin, dataDir, workspace });
  const portUi = await (await import('./ui-port-check.mjs')).checkPortUi({ window: mainWindow, store: server.app.locals.harness.store, origin, outputDir: path.dirname(flags.smokeTest) });
  const pet = await desktopPet.smokeCheck();
  const report = {
    ...baseSmokeReport(),
    ...checks,
    portUi,
    pet,
    rendererTitle: mainWindow.webContents.getTitle().slice(0, 160),
    pageLoaded: lifecycle.didFinishLoad,
    lifecycle: { ...lifecycle },
    nodeIntegration: security.nodeIntegration, contextIsolation: security.contextIsolation, sandbox: security.sandbox,
    security,
    desktopBridge,
    titleBarLayout,
    titleBarOverlay,
    titleBarZoom,
    workspaceStartsClosed,
    titleBarThemes,
    titleBarKeyboard: { ...keyboardFocused, leftBar: keyboardLeft.inBar === false },
    browserStartsWithoutGuest: embeddedBrowser.getWebContents() === null,
    browserStartsWithBlankTab: desktopBridge.browserState?.tabs?.length === 1 && desktopBridge.browserState.tabs[0].id === desktopBridge.browserState.activeTabId && desktopBridge.browserState.tabs[0].url === '',
    iconIncluded: Boolean(appIcon),
    iconSize: appIcon ? appIcon.getSize() : null,
  };
  report.ok = Boolean(checks.ok && lifecycle.didFinishLoad && !lifecycle.mainFrameLoadError && !lifecycle.renderProcessGone && !lifecycle.uncaughtScriptError && security.nodeIntegration === false && security.contextIsolation === true && security.sandbox === true && security.webSecurity === true && security.preloadConfigured && security.preloadIsExpected && security.sessionPreloadCount === 0 && security.backgroundThrottling === false && desktopBridge.keys.join(',') === 'browser,completionNotifications,copyImage,onOpenSession,revealApiKey,testCompletionNotification' && desktopBridge.copyImage === 'function' && desktopBridge.revealApiKey === 'function' && desktopBridge.completionNotifications === true && desktopBridge.onOpenSession === 'function' && desktopBridge.testCompletionNotification === 'function' && desktopBridge.browserKeys.join(',') === 'act,activateTab,back,closeTab,forward,getState,home,navigate,newTab,onState,openDevTools,openExternal,readPage,reload,reopenTab,screenshot,setPresentation,setViewport,snapshot,stop' && desktopBridge.browserState?.url === '' && desktopBridge.browserState?.loading === false && desktopBridge.browserState?.desktopZoomFactor > 0 && desktopBridge.browserState?.presentation?.mode === 'normal' && desktopBridge.attachmentTray === true && desktopBridge.attachmentInput === true && desktopBridge.titleBar?.menus?.join(',') === '文件,编辑,查看,帮助,桌宠' && desktopBridge.titleBar.title === '' && desktopBridge.titleBar.rootTop === 0 && desktopBridge.titleBar.barBottom > 0 && report.browserStartsWithoutGuest && report.browserStartsWithBlankTab && !security.noSandboxSwitch && !security.debugPortConfigured);
  const titleBarOk = Boolean(
    workspaceStartsClosed && titleBarThemes.every(item => item.menu === item.sidebar && item.chat === item.sidebar && item.caption === item.sidebar) &&
    titleBarLayout?.contain?.includes('layout') && titleBarLayout.contain.includes('paint')
    && titleBarLayout.probeTop === 0 && titleBarLayout.rootTop === 0
    && titleBarLayout.headerTop === 0 && Math.abs(titleBarLayout.headerBottom - titleBarLayout.barBottom) <= 1
    && titleBarLayout.headingLeft >= titleBarLayout.menuRight
    && titleBarLayout.actionsRight <= titleBarLayout.captionLeft
    && titleBarLayout.dangerStrong && titleBarLayout.warningSurface && titleBarLayout.textSecondary
    && (!titleBarOverlay?.overlay || (titleBarOverlay.panelContentTop >= titleBarOverlay.barBottom
      && titleBarOverlay.shade?.top >= titleBarOverlay.barBottom
      && titleBarOverlay.panel?.bottom <= titleBarOverlay.windowHeight))
    && titleBarOverlay.topRightDraggable
    && titleBarZoom.every(item => Math.abs(item.zoom - item.requestedZoom) < 0.01
      && item.headerTop === 0 && Math.abs(item.headerBottom - item.barBottom) < 1
      && item.headingLeft >= item.menuRight && item.actionsRight <= item.captionLeft)
    && keyboardFocused?.inBar === true && keyboardFocused.label === '文件' && keyboardLeft?.inBar === false);
  report.titleBarOk = titleBarOk;
  if (report.ok && !titleBarOk) {
    report.ok = false;
    report.titleBarError = { titleBarLayout, titleBarOverlay, keyboardFocused, keyboardLeft };
  }
  if (!report.ok) report.error = checks.ok ? 'SMOKE_WINDOW_OR_SECURITY_CHECK_FAILED' : 'SMOKE_SERVICE_CHECK_FAILED';
  if (!pet.ok) { report.ok = false; report.error = 'SMOKE_PET_CHECK_FAILED'; }
  if (!portUi.ok) { report.ok = false; report.error = 'SMOKE_PORT_UI_CHECK_FAILED'; }
  await requestQuit({ confirmActive: false, smokeReport: report, exitCode: report.ok ? 0 : 1 });
}

launch().catch(async error => {
  const errorCode = typeof error?.message === 'string' && /^SMOKE_[A-Z_]+$/.test(error.message) ? error.message : error?.code ?? error?.name ?? 'STARTUP_FAILED';
  const smokeRequested = argv.some(value => value === '--smoke-test' || value.startsWith('--smoke-test='));
  if (flags?.smokeTest) {
    await requestQuit({ confirmActive: false, exitCode: 1, smokeReport: { ...baseSmokeReport(), error: errorCode, errorCode, lifecycle: { ...lifecycle } } });
  } else if (smokeRequested) {
    // The smoke-test flags themselves were rejected, so there is no report to write. An
    // unattended run must neither block on a dialog nor add entries to the user's own log.
    try { process.stderr.write(`Harness Gemini smoke test could not start: ${String(error?.message ?? errorCode).slice(0, 200)}\n`); } catch { /* No console attached. */ }
    finalExit = true;
    app.exit(1);
  } else {
    await recordStartupFailure(error);
    dialog.showErrorBox('Harness Gemini 无法启动', '无法启动本机服务或加载应用界面。请检查数据目录权限和安装文件是否完整。详细原因已写入数据目录下的 logs/errors.log。');
    await requestQuit({ confirmActive: false, exitCode: 1 });
  }
});
