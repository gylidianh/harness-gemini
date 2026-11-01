const { contextBridge, ipcRenderer } = require('electron');

const COMMAND = 'harness:pet-command';
const STATE = 'harness:pet-state';
const ACTIONS = new Set(['ready', 'hide', 'open-main', 'context-menu', 'drag-start', 'drag-move', 'drag-end', 'pointer-regions', 'set-opacity', 'set-scale', 'set-mascot-visible']);
const STATES = new Set(['idle', 'running', 'waiting', 'failed', 'review', 'waving']);
const subscribers = new Set();
let latest;

const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
const number = (value, minimum, maximum, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
const sessionId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : null;

function item(value) {
  return Object.freeze({ sessionId: sessionId(value?.sessionId), title: text(value?.title, 160), state: STATES.has(value?.state) ? value.state : 'idle', statusText: text(value?.statusText, 100) });
}

function state(value) {
  if (!value || typeof value !== 'object' || !value.activity || typeof value.activity !== 'object') return null;
  const activity = item(value.activity);
  return Object.freeze({
    visible: value.visible === true,
    activity: Object.freeze({ ...activity, activeCount: Math.round(number(value.activity.activeCount, 0, 999)), items: Object.freeze(Array.isArray(value.activity.items) ? value.activity.items.slice(0, 3).map(item) : []) }),
    look: Object.freeze({ x: number(value.look?.x, -1, 1), y: number(value.look?.y, -1, 1), ...Object.fromEntries(['cx', 'cy', 'dl', 'dt', 'dr', 'db'].filter(key => Number.isFinite(value.look?.[key])).map(key => [key, number(value.look[key], -100000, 100000)])) }),
    dragging: value.dragging === true,
    dragDirection: value.dragDirection === 'left' ? 'left' : 'right',
    reducedMotion: value.reducedMotion === true,
    opacity: number(value.opacity, 0.3, 1, 1),
    scale: number(value.scale, 0.3, 1, 1),
    mascotVisible: value.mascotVisible !== false,
    settingsRequest: Number.isSafeInteger(value.settingsRequest) && value.settingsRequest >= 0 ? value.settingsRequest : 0,
  });
}

function payload(action, value) {
  if (action === 'set-opacity') {
    if (typeof value?.value !== 'number' || !Number.isFinite(value.value) || value.value < 0.3 || value.value > 1) return null;
    return { value: value.value };
  }
  if (action === 'set-scale') {
    if (typeof value?.value !== 'number' || !Number.isFinite(value.value) || value.value < 0.3 || value.value > 1) return null;
    return { value: value.value };
  }
  if (action === 'set-mascot-visible') return typeof value?.visible === 'boolean' ? { visible: value.visible } : null;
  if (action === 'open-main') return sessionId(value?.sessionId) ? { sessionId: value.sessionId } : {};
  if (action.startsWith('drag-')) {
    if (!['screenX', 'screenY'].every(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 1_000_000)) return null;
    return { screenX: value.screenX, screenY: value.screenY, ...(action === 'drag-end' ? { velocityX: number(value.velocityX, -3, 3), velocityY: number(value.velocityY, -3, 3) } : {}) };
  }
  if (action === 'pointer-regions') {
    if (!Array.isArray(value?.rects)) return null;
    return { rects: value.rects.slice(0, 16).filter(rect => ['x', 'y', 'width', 'height'].every(key => typeof rect?.[key] === 'number' && Number.isFinite(rect[key]))).map(rect => ({ x: number(rect.x, 0, 320), y: number(rect.y, 0, 300), width: number(rect.width, 0, 320), height: number(rect.height, 0, 300) })) };
  }
  return undefined;
}

function command(action, value) {
  if (!ACTIONS.has(action)) return Promise.reject(new Error('桌宠操作不可用。'));
  const clean = payload(action, value);
  if (clean === null) return Promise.reject(new Error('桌宠操作参数无效。'));
  return ipcRenderer.invoke(COMMAND, action, clean).then(result => {
    const snapshot = state(result);
    if (snapshot) return snapshot;
    return Object.freeze({ ok: result?.ok !== false });
  });
}

ipcRenderer.on(STATE, (_event, value) => {
  const snapshot = state(value);
  if (!snapshot) return;
  latest = snapshot;
  for (const callback of subscribers) { try { callback(snapshot); } catch { /* An isolated UI callback cannot break the bridge. */ } }
});

contextBridge.exposeInMainWorld('harnessPet', Object.freeze({
  ready: () => command('ready'),
  command,
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback);
    if (latest) { try { callback(latest); } catch { /* Keep the state channel available. */ } }
    return () => subscribers.delete(callback);
  },
}));
