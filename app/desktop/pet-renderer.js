const bridge = window.harnessPet;
const root = document.getElementById('pet-root');
const mascot = document.getElementById('mascot');
const toolbar = document.getElementById('pet-toolbar');
const tooltip = document.getElementById('tooltip-text');
const statusText = document.getElementById('status-text');
const activityCount = document.getElementById('activity-count');
const toggle = document.getElementById('activity-toggle');
const panel = document.getElementById('activity-panel');
const list = document.getElementById('activity-list');
const empty = document.getElementById('empty-activity');
const caption = document.getElementById('panel-caption');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');
const resetScale = document.getElementById('reset-scale');
const opacitySlider = document.getElementById('opacity-slider');
const opacityValue = document.getElementById('opacity-value');
const resetOpacity = document.getElementById('reset-opacity');
const toggleMascot = document.getElementById('toggle-mascot');
const FRAMES = {};
for (const frame of document.querySelectorAll('svg.duo-art .fr')) (FRAMES[frame.dataset.a] ??= [])[Number(frame.dataset.i)] = frame;
let shownFrame;
const PET_NAME = '嘟嘟布布';
const LABELS = { idle: '随时待命', running: '正在工作', waiting: '需要你处理', failed: '遇到问题', review: '任务已完成', waving: '你好呀' };
let snapshot = { activity: { state: 'idle', sessionId: null, items: [] } };
let expanded = false;
let drag;
let suppressClickUntil = 0;
let lastTapAt = 0;
let jumpTimer;
let waveTimer;
let lastItems = '';
let hitFrame;
let lastSettingsRequest = 0;
let opacityTimer;
let pendingOpacity;
let editingOpacity = false;
let opacityWrites = 0;
let scaleTimer;
let pendingScale;
let editingScale = false;
let scaleWrites = 0;

// Gaze, modelled on the 1.1.6 robot: the whole face layer of each bear (eyes, mouth, cheeks,
// closed-eye arcs) shifts towards the cursor, the eyes travel further inside it, and the pair
// leans a touch. Each bear aims from its own face centre (atlas units, 192x208).
//
// Screen-wide mapping: every axis is normalised against the distance from the face to the edge
// of the pet's display, so the gaze keeps changing all the way to the screen border, while a
// near-field term keeps small movements around the pet clearly visible.
let lastLocalPointerAt = -1e9;
const EYE_ANCHORS = { dudu: [61, 97], bubu: [131, 100] };
const NEAR_RANGE = 110;          // px: near-field response around the face
const NEAR_WEIGHT = 0.35;        // share of travel driven by the near field; the rest spans the screen
const FACE_TRAVEL = [6.5, 4.8];  // atlas units the whole face moves at full gaze
const EYE_TRAVEL = [2.4, 1.9];   // extra eye travel inside the moving face
const LEAN_DEG = 3.2;
const EASE_MS = 30;              // smoothing time constant
// Display edges relative to the pet window (window/client px); updated from the main process.
let screenEdges = { left: -960, top: -540, right: 1280, bottom: 840 };
const gaze = { dudu: { tx: 0, ty: 0, x: 0, y: 0 }, bubu: { tx: 0, ty: 0, x: 0, y: 0 } };
let gazeFrame;
let gazeTimer;
let gazeAt = 0;
// requestAnimationFrame gives 60 fps; the timer keeps the gaze moving if frames are throttled.
function scheduleGaze() {
  if (gazeFrame !== undefined) return;
  gazeFrame = requestAnimationFrame(runGaze);
  gazeTimer = setTimeout(runGaze, 34);
}
function runGaze() {
  cancelAnimationFrame(gazeFrame);
  clearTimeout(gazeTimer);
  gazeFrame = undefined;
  stepGaze(performance.now());
}

function setScreenEdges(look) {
  if (![look?.dl, look?.dt, look?.dr, look?.db].every(Number.isFinite)) return;
  if (look.dr - look.dl < 200 || look.db - look.dt < 200) return;
  screenEdges = { left: look.dl, top: look.dt, right: look.dr, bottom: look.db };
}

function axisGaze(delta, before, after) {
  const span = Math.max(80, delta < 0 ? before : after);
  const far = Math.max(-1, Math.min(1, delta / span));
  return NEAR_WEIGHT * Math.tanh(delta / NEAR_RANGE) + (1 - NEAR_WEIGHT) * far;
}

function aimEyes(clientX, clientY) {
  const rect = mascot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  for (const [who, [ax, ay]] of Object.entries(EYE_ANCHORS)) {
    const fx = rect.left + rect.width * ax / 192;
    const fy = rect.top + rect.height * ay / 208;
    let gx = axisGaze(clientX - fx, fx - screenEdges.left, screenEdges.right - fx);
    let gy = axisGaze(clientY - fy, fy - screenEdges.top, screenEdges.bottom - fy);
    // Square-to-disk mapping keeps distinct positions distinct (no hard clamp at the corners).
    [gx, gy] = [gx * Math.sqrt(1 - gy * gy / 2), gy * Math.sqrt(1 - gx * gx / 2)];
    gaze[who].tx = gx;
    gaze[who].ty = gy;
  }
  if (gazeFrame === undefined) { if (performance.now() - gazeAt > 100) gazeAt = performance.now(); scheduleGaze(); }
}

function stepGaze(now) {
  const elapsed = Math.min(100, Math.max(0, now - gazeAt));
  gazeAt = now;
  const still = document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const k = still ? 1 : 1 - Math.exp(-elapsed / EASE_MS);
  const style = document.documentElement.style;
  let moving = false;
  for (const [who, g] of Object.entries(gaze)) {
    g.x += (g.tx - g.x) * k;
    g.y += (g.ty - g.y) * k;
    if (Math.abs(g.tx - g.x) < 0.002 && Math.abs(g.ty - g.y) < 0.002) { g.x = g.tx; g.y = g.ty; } else moving = true;
    style.setProperty(`--${who}-fx`, `${(g.x * FACE_TRAVEL[0]).toFixed(2)}px`);
    style.setProperty(`--${who}-fy`, `${(g.y * FACE_TRAVEL[1]).toFixed(2)}px`);
    style.setProperty(`--${who}-ex`, `${(g.x * EYE_TRAVEL[0]).toFixed(2)}px`);
    style.setProperty(`--${who}-ey`, `${(g.y * EYE_TRAVEL[1]).toFixed(2)}px`);
  }
  style.setProperty('--duo-lean', `${((gaze.dudu.x + gaze.bubu.x) / 2 * LEAN_DEG).toFixed(2)}deg`);
  if (moving) scheduleGaze();
}

function showOpacity(value) {
  const percentage = Math.max(30, Math.min(100, Math.round((Number.isFinite(value) ? value : 1) * 100)));
  opacitySlider.value = String(percentage);
  opacityValue.value = `${percentage}%`;
  opacityValue.textContent = `${percentage}%`;
  opacitySlider.setAttribute('aria-valuetext', `${percentage}%`);
  opacitySlider.style.setProperty('--setting-fill', `${(percentage - 30) / 70 * 100}%`);
  resetOpacity.disabled = percentage === 100;
}

function showScale(value) {
  const percentage = Math.max(30, Math.min(100, Math.round((Number.isFinite(value) ? value : 1) * 100)));
  const scale = percentage / 100;
  const previous = root.style.getPropertyValue('--mascot-scale');
  scaleSlider.value = String(percentage);
  scaleValue.value = `${percentage}%`;
  scaleValue.textContent = `${percentage}%`;
  scaleSlider.setAttribute('aria-valuetext', `${percentage}%`);
  scaleSlider.style.setProperty('--setting-fill', `${(percentage - 30) / 70 * 100}%`);
  resetScale.disabled = percentage === 100;
  root.style.setProperty('--mascot-scale', String(scale));
  if (previous !== String(scale)) scheduleRegions();
}

function flushOpacity() {
  clearTimeout(opacityTimer);
  opacityTimer = undefined;
  if (pendingOpacity === undefined) return;
  const value = pendingOpacity;
  pendingOpacity = undefined;
  opacityWrites++;
  Promise.resolve(send('set-opacity', { value })).then(result => {
    if (result?.activity) renderState(result);
  }).finally(() => {
    opacityWrites--;
    if (!editingOpacity && pendingOpacity === undefined && opacityWrites === 0) showOpacity(snapshot.opacity);
  });
}

function queueOpacity() {
  editingOpacity = true;
  const percentage = Number(opacitySlider.value);
  showOpacity(percentage / 100);
  pendingOpacity = percentage / 100;
  opacityTimer ??= setTimeout(flushOpacity, 50);
}

function flushScale() {
  clearTimeout(scaleTimer);
  scaleTimer = undefined;
  if (pendingScale === undefined) return;
  const value = pendingScale;
  pendingScale = undefined;
  scaleWrites++;
  Promise.resolve(send('set-scale', { value })).then(result => {
    if (result?.activity) renderState(result);
  }).finally(() => {
    scaleWrites--;
    if (!editingScale && pendingScale === undefined && scaleWrites === 0) showScale(snapshot.scale);
  });
}

function queueScale() {
  editingScale = true;
  const percentage = Number(scaleSlider.value);
  showScale(percentage / 100);
  pendingScale = percentage / 100;
  scaleTimer ??= setTimeout(flushScale, 50);
}

function showMascot(value) {
  const shown = value !== false;
  const wasHidden = root.classList.contains('mascot-hidden');
  root.classList.toggle('mascot-hidden', !shown);
  toggleMascot.dataset.hidden = String(!shown);
  toggleMascot.setAttribute('aria-label', shown ? `隐藏${PET_NAME}` : `显示${PET_NAME}`);
  toggleMascot.title = shown ? `隐藏${PET_NAME}` : `显示${PET_NAME}`;
  if (wasHidden !== !shown) scheduleRegions();
}

function send(action, payload) {
  return bridge?.command(action, payload).catch(() => undefined);
}

function publishRegions() {
  hitFrame = undefined;
  const rects = [...document.querySelectorAll('[data-hit]')].filter(element => !element.hidden && element.getClientRects().length).map(element => {
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.floor(rect.left));
    const y = Math.max(0, Math.floor(rect.top));
    return { x, y, width: Math.max(0, Math.min(320, Math.ceil(rect.right)) - x), height: Math.max(0, Math.min(300, Math.ceil(rect.bottom)) - y) };
  }).filter(rect => rect.width > 0 && rect.height > 0).slice(0, 16);
  void send('pointer-regions', { rects });
}

function scheduleRegions() { if (hitFrame === undefined) hitFrame = requestAnimationFrame(publishRegions); }

function openSession(sessionId = snapshot.activity?.sessionId) {
  void send('open-main', sessionId ? { sessionId } : undefined);
}

function renderItems(activity) {
  const items = Array.isArray(activity.items) ? activity.items.slice(0, 3) : [];
  const fingerprint = JSON.stringify(items);
  if (fingerprint !== lastItems) {
    lastItems = fingerprint;
    list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'activity-item';
      row.title = `${item.title || '对话'} · ${item.statusText || LABELS[item.state] || '待命'}`;
      const dot = document.createElement('span');
      dot.className = 'item-status';
      dot.dataset.state = item.state;
      dot.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'item-copy';
      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = item.title || '对话';
      const detail = document.createElement('span');
      detail.className = 'item-detail';
      detail.textContent = LABELS[item.state] || item.statusText || '待命';
      copy.append(title, detail);
      row.append(dot, copy);
      row.addEventListener('click', () => openSession(item.sessionId));
      list.append(row);
    }
    empty.hidden = items.length > 0;
    caption.textContent = items.length ? `${items.length} 项动态` : '最近的工作';
    scheduleRegions();
  }
}

function renderState(value) {
  if (!value?.activity) return;
  snapshot = value;
  const activity = value.activity;
  const state = LABELS[activity.state] ? activity.state : 'idle';
  if (!waveTimer) document.body.dataset.state = state;
  document.body.classList.toggle('reduce-motion', value.reducedMotion === true);
  document.body.classList.toggle('is-dragging', Boolean(drag?.moved || value.dragging));
  document.body.dataset.dragDirection = value.dragDirection === 'left' ? 'left' : 'right';
  setScreenEdges(value.look);
  if (Number.isFinite(value.look?.cx) && Number.isFinite(value.look?.cy) && performance.now() - lastLocalPointerAt > 120) aimEyes(value.look.cx, value.look.cy);
  statusText.textContent = LABELS[state];
  const count = Math.min(99, Math.max(0, activity.activeCount || 0));
  activityCount.hidden = count < 1;
  activityCount.textContent = String(count);
  tooltip.textContent = activity.statusText || (state === 'idle' ? '随时陪你开工' : activity.title || LABELS[state]);
  mascot.setAttribute('aria-label', `${PET_NAME}，${LABELS[state]}。拖动可移动，双击返回 Harness。`);
  toggle.title = activity.title ? `${LABELS[state]} · ${activity.title}` : '查看任务动态';
  if (!editingScale && pendingScale === undefined && scaleWrites === 0) showScale(value.scale);
  if (!editingOpacity && pendingOpacity === undefined && opacityWrites === 0) showOpacity(value.opacity);
  showMascot(value.mascotVisible);
  if (Number.isSafeInteger(value.settingsRequest) && value.settingsRequest > lastSettingsRequest) {
    lastSettingsRequest = value.settingsRequest;
    setExpanded(true, 'settings');
  }
  renderItems(activity);
}

function setExpanded(value, kind = 'activity') {
  expanded = value;
  const activityShown = value && kind === 'activity';
  const settingsShown = value && kind === 'settings';
  panel.hidden = !activityShown;
  settingsPanel.hidden = !settingsShown;
  root.classList.toggle('expanded', value);
  toggle.setAttribute('aria-expanded', String(activityShown));
  toggle.setAttribute('aria-label', activityShown ? '收起任务动态' : '展开任务动态');
  settingsToggle.setAttribute('aria-expanded', String(settingsShown));
  settingsToggle.setAttribute('aria-label', settingsShown ? '收起桌宠设置' : '打开桌宠设置');
  scheduleRegions();
}

function jump() {
  clearTimeout(jumpTimer);
  document.body.classList.remove('is-jumping');
  void mascot.offsetWidth;
  document.body.classList.add('is-jumping');
  jumpTimer = setTimeout(() => document.body.classList.remove('is-jumping'), 840);
}

mascot.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || drag) return;
  event.preventDefault();
  drag = { id: event.pointerId, startX: event.screenX, startY: event.screenY, x: event.screenX, y: event.screenY, at: performance.now(), velocityX: 0, velocityY: 0, moved: false };
  try { mascot.setPointerCapture(event.pointerId); } catch { /* Window-level release still ends the gesture. */ }
});

mascot.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  event.preventDefault();
  const now = performance.now();
  if (!drag.moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >= 4) {
    drag.moved = true;
    lastTapAt = 0;
    document.body.classList.add('is-dragging');
    void send('drag-start', { screenX: drag.startX, screenY: drag.startY });
  }
  const elapsed = Math.max(1, now - drag.at);
  drag.velocityX = elapsed > 100 ? 0 : Math.max(-3, Math.min(3, (event.screenX - drag.x) / elapsed));
  drag.velocityY = elapsed > 100 ? 0 : Math.max(-3, Math.min(3, (event.screenY - drag.y) / elapsed));
  if (event.screenX !== drag.x) document.body.dataset.dragDirection = event.screenX < drag.x ? 'left' : 'right';
  drag.x = event.screenX;
  drag.y = event.screenY;
  drag.at = now;
  if (drag.moved) void send('drag-move', { screenX: event.screenX, screenY: event.screenY });
});

function endDrag(event, cancelled = false) {
  if (!drag || event.pointerId !== drag.id) return;
  const current = drag;
  drag = null;
  try { if (mascot.hasPointerCapture(event.pointerId)) mascot.releasePointerCapture(event.pointerId); } catch { /* Native capture may already have been released. */ }
  if (current.moved) {
    suppressClickUntil = performance.now() + 400;
    const stale = performance.now() - current.at > 100;
    void send('drag-end', { screenX: cancelled ? current.x : event.screenX, screenY: cancelled ? current.y : event.screenY, velocityX: cancelled || stale ? 0 : current.velocityX, velocityY: cancelled || stale ? 0 : current.velocityY });
    document.body.classList.remove('is-dragging');
  } else if (!cancelled) {
    const now = performance.now();
    if (lastTapAt > 0 && now - lastTapAt < 360) { lastTapAt = 0; openSession(); }
    else { lastTapAt = now; jump(); }
  }
}

mascot.addEventListener('pointerup', event => endDrag(event));
mascot.addEventListener('pointercancel', event => endDrag(event, true));
window.addEventListener('pointerup', event => { if (drag) endDrag(event); });
window.addEventListener('pointercancel', event => { if (drag) endDrag(event, true); });
mascot.addEventListener('lostpointercapture', event => { if (drag) endDrag(event, true); });
mascot.addEventListener('click', event => { if (performance.now() < suppressClickUntil) event.preventDefault(); });
mascot.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); openSession(); }
  if (event.key === ' ') { event.preventDefault(); jump(); }
});
mascot.addEventListener('pointerenter', () => document.body.classList.add('is-hovering'));
mascot.addEventListener('pointerleave', () => document.body.classList.remove('is-hovering'));
document.addEventListener('contextmenu', event => { event.preventDefault(); void send('context-menu'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); expanded ? setExpanded(false) : void send('hide'); } });
document.getElementById('open-main').addEventListener('click', () => openSession());
toggleMascot.addEventListener('click', () => {
  const next = root.classList.contains('mascot-hidden');
  showMascot(next);
  snapshot = { ...snapshot, mascotVisible: next };
  void send('set-mascot-visible', { visible: next });
});
toggle.addEventListener('click', () => setExpanded(panel.hidden, 'activity'));
settingsToggle.addEventListener('click', () => setExpanded(settingsPanel.hidden, 'settings'));
scaleSlider.addEventListener('input', queueScale);
scaleSlider.addEventListener('change', () => {
  editingScale = false;
  pendingScale = Number(scaleSlider.value) / 100;
  flushScale();
});
scaleSlider.addEventListener('blur', () => { editingScale = false; flushScale(); });
scaleSlider.addEventListener('pointercancel', () => { editingScale = false; flushScale(); });
resetScale.addEventListener('click', () => {
  editingScale = false;
  showScale(1);
  pendingScale = 1;
  flushScale();
});
opacitySlider.addEventListener('input', queueOpacity);
opacitySlider.addEventListener('change', () => {
  editingOpacity = false;
  pendingOpacity = Number(opacitySlider.value) / 100;
  flushOpacity();
});
opacitySlider.addEventListener('blur', () => { editingOpacity = false; flushOpacity(); });
opacitySlider.addEventListener('pointercancel', () => { editingOpacity = false; flushOpacity(); });
resetOpacity.addEventListener('click', () => {
  editingOpacity = false;
  showOpacity(1);
  pendingOpacity = 1;
  flushOpacity();
});

// Spritesheet animator. Row order and frame timings follow the Codex pet v1 atlas.
const frames = (count, each, last) => Array.from({ length: count }, (_, index) => index === count - 1 ? last : each);
const ANIMATIONS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, durations: frames(8, 120, 220) },
  'running-left': { row: 2, durations: frames(8, 120, 220) },
  waving: { row: 3, durations: frames(4, 140, 280) },
  jumping: { row: 4, durations: frames(5, 140, 280) },
  failed: { row: 5, durations: frames(8, 140, 240) },
  waiting: { row: 6, durations: frames(6, 150, 260) },
  running: { row: 7, durations: frames(6, 120, 220) },
  review: { row: 8, durations: frames(6, 150, 280) },
};
const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let animationKey;
let animationFrame = 0;
let animationTimer;

function currentAnimation() {
  const body = document.body;
  if (body.classList.contains('is-dragging')) return body.dataset.dragDirection === 'left' ? 'running-left' : 'running-right';
  if (body.classList.contains('is-jumping')) return 'jumping';
  return ANIMATIONS[body.dataset.state] ? body.dataset.state : 'idle';
}

function paintFrame() {
  // Working and done reuse the clean sitting pose; CSS adds the motion and overlays.
  // Done reuses the sitting idle pose; failed holds one steady crying pose (the atlas row jumps between scales).
  const pose = animationKey === 'review' ? FRAMES.idle?.[0] : animationKey === 'failed' ? FRAMES.failed?.[4] : undefined;
  const frames = FRAMES[animationKey] ?? FRAMES.idle;
  const next = pose ?? frames[animationFrame] ?? frames[0];
  if (next === shownFrame) return;
  shownFrame?.classList.remove('on');
  next?.classList.add('on');
  shownFrame = next;
}

function animate(advance) {
  clearTimeout(animationTimer);
  animationTimer = undefined;
  const key = currentAnimation();
  if (key !== animationKey) { animationKey = key; animationFrame = 0; }
  else if (advance) animationFrame = (animationFrame + 1) % ANIMATIONS[key].durations.length;
  if (document.body.classList.contains('reduce-motion') || reducedMotionQuery.matches) animationFrame = 0;
  paintFrame();
  if (document.body.classList.contains('reduce-motion') || reducedMotionQuery.matches) return;
  const delay = key === 'idle' && animationFrame === 0 ? 3200 + Math.random() * 3800 : ANIMATIONS[key].durations[animationFrame];
  animationTimer = setTimeout(() => animate(true), delay);
}

new MutationObserver(() => { if (currentAnimation() !== animationKey) animate(false); })
  .observe(document.body, { attributes: true, attributeFilter: ['class', 'data-state', 'data-drag-direction'] });
reducedMotionQuery.addEventListener?.('change', () => animate(false));
animate(false);

const observer = new ResizeObserver(scheduleRegions);
for (const element of [mascot, toolbar, panel, settingsPanel, settingsToggle]) observer.observe(element);
for (const element of [mascot, toolbar, settingsPanel]) element.addEventListener('transitionend', scheduleRegions);
window.addEventListener('resize', scheduleRegions);
window.addEventListener('blur', () => {
  document.body.classList.remove('is-hovering');
  editingScale = false;
  flushScale();
  editingOpacity = false;
  flushOpacity();
  if (drag) endDrag({ pointerId: drag.id, screenX: drag.x, screenY: drag.y }, true);
});
bridge?.onState(renderState);
bridge?.ready().then(value => {
  if (value?.activity) renderState(value);
  if (snapshot.activity.state === 'idle') {
    document.body.dataset.state = 'waving';
    waveTimer = setTimeout(() => { waveTimer = undefined; document.body.dataset.state = snapshot.activity.state; }, 1800);
  }
  scheduleRegions();
}).catch(scheduleRegions);
scheduleRegions();

// Immediate local tracking while the cursor is over the pet window.
window.addEventListener('pointermove', event => {
  lastLocalPointerAt = performance.now();
  aimEyes(event.clientX, event.clientY);
}, { passive: true });
