// 1.8.0: "Agent Teams 协作看板" — one lane per member, one card per work item, one line per
// hand-off, live while the team is still working.
//
// Why this is a self-contained module instead of a component inside the React bundle: the
// bundle is shipped compiled (dist/assets/*.js, 877 KB minified) and has no source in this tree,
// so a new screen cannot be added to it without string-surgery on minified code. A module
// mounted on document.body, fed by the read-only /api/teams endpoints, gets the same view with
// none of that risk — and it keeps working when the conversation re-renders.
//
// The layout follows the product idea of cc-haha's Agent Teams workspace (member lanes, task
// cards, dependency lines, a hand-off feed). Implementation is independent; see server/teams.mjs
// for why no cc-haha source is used.

import {
  activityFeed, buildLanes, dependencyEdges, elapsedOf, formatElapsed, headlineOf,
  initialsOf, memberSelection, memberToolLine, memberWakeLabel, modeLabel, pendingApprovals, progressOf, shortTime, signatureOf, statusOf,
} from './team-view.js';

const ROOT_ID = 'hg-team-panel';
const KEY_OPEN = 'hg.team.open';
const KEY_DISMISSED = 'hg.team.dismissed';
const FAST_POLL = 1_200;
const SLOW_POLL = 4_000;
const IDLE_POLL = 8_000;
const HIDDEN_POLL = 5_000;
const FEED_LIMIT = 16;

// 1.9.9: keep direct references to our own DOM nodes. When React switches the right panel to the
// built-in browser (`we === 'browser'`), `.workspace-tab-panel` is unmounted from `document`,
// detaching any docked tab/panel inside it; `document.getElementById` alone would then return null
// forever and make the Team tab and configuration screen disappear.
let rootNode = null;
let cardNode = null;
let launcherNode = null;
let countNode = null;

const state = {
  mounted: false,
  summary: null,
  team: null,
  teamId: null,
  open: readFlag(KEY_OPEN) !== 'closed',
  dismissed: readFlag(KEY_DISMISSED) || '',
  error: '',
  signature: '',
  lanes: [],
  selectedMember: '',
  configuration: null,
  configurationDraft: {},
  configurationError: '',
  configurationSending: false,
  timer: null,
  busy: false,
};

function readFlag(key) {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function writeFlag(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, children = []) {
  // document.createElement('svg') produces an HTML unknown element, which renders as nothing.
  // The edges are real SVG, so the namespace has to be right from the first node.
  const node = tag === 'svg' ? document.createElementNS(SVG_NS, 'svg') : document.createElement(tag);
  const isSvg = node.namespaceURI === SVG_NS;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') { if (isSvg) node.setAttribute('class', value); else node.className = value; }
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') {
      if (isSvg) for (const [name, entry] of Object.entries(value)) node.setAttribute(`data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(entry));
      else Object.assign(node.dataset, value);
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('暂时无法连接本地服务。');
  }
  if (!response.ok) throw new Error(`请求未完成（${response.status}）`);
  return response.json();
}

/* ------------------------------------------------------------------ mount */

const ESCAPE_BOUND = Symbol.for('hg.team.escapeBound');

function onRootKeyDown(event) {
  if (event.key === 'Escape') close();
}

function bindRootEscape(node) {
  if (!node || node[ESCAPE_BOUND]) return;
  node.removeEventListener('keydown', onRootKeyDown);
  node.addEventListener('keydown', onRootKeyDown);
  node[ESCAPE_BOUND] = true;
}

function mount() {
  if (state.mounted && rootNode) {
    bindRootEscape(rootNode);
    if (!rootNode.isConnected && !dockPanel() && document.body) {
      rootNode.classList.remove(DOCK_CLASS);
      document.body.append(rootNode);
    }
    dockEnsure();
    return;
  }
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    rootNode = existing;
    cardNode = existing.querySelector('.hg-team-card');
    launcherNode = existing.querySelector('.hg-team-launcher') ?? document.getElementById('hg-team-tab');
    countNode = launcherNode?.querySelector('.hg-team-launcher-count') ?? null;
    bindRootEscape(rootNode);
    state.mounted = true;
    render();
    schedule(600);
    return;
  }
  countNode = el('span', { class: 'hg-team-launcher-count', text: '0' });
  launcherNode = el('button', {
    type: 'button', class: 'hg-team-launcher', 'aria-expanded': 'false', 'aria-controls': 'hg-team-card',
    title: 'Agent Teams 协作看板', onclick: () => toggle(),
  }, [
    el('span', { class: 'hg-team-launcher-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'hg-team-launcher-text', text: '团队' }),
    countNode,
  ]);
  cardNode = el('section', {
    class: 'hg-team-card', id: 'hg-team-card', role: 'region', 'aria-label': 'Agent Teams 协作看板', hidden: true,
  });
  rootNode = el('div', { id: ROOT_ID, class: 'hg-team', 'data-has-team': 'false', 'data-open': 'false' }, [cardNode, launcherNode]);
  bindRootEscape(rootNode);
  document.body.append(rootNode);
  state.mounted = true;
  render();
  schedule(600);
}

/* --------------------------------------------------------------- polling */

function schedule(ms) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => { void tick(); }, ms);
}

async function tick() {
  if (state.busy) { schedule(FAST_POLL); return; }
  state.busy = true;
  try {
    if (document.hidden) { state.busy = false; schedule(HIDDEN_POLL); return; }
    const setup = await getJson('/api/team-configurations');
    const configuration = Array.isArray(setup?.configurations) ? setup.configurations[0] : null;
    if (configuration?.id !== state.configuration?.id) {
      state.configuration = configuration;
      state.configurationDraft = Object.fromEntries((configuration?.members ?? []).map(member => [member.id, { profile: member.profile || '', model: member.model || '' }]));
      state.configurationError = '';
      state.signature = '';
      if (configuration) {
        state.open = true;
        writeFlag(KEY_OPEN, 'open');
        // A pending team_run blocks until the user confirms or cancels: bring the Workspace -> Team
        // tab into view even if the right panel was collapsed or showing the built-in browser.
        dockState.revealPending = 6;
      }
    }
    const list = await getJson('/api/teams?limit=1');
    const summary = Array.isArray(list?.teams) ? list.teams[0] : null;
    if (!summary) {
      state.summary = null; state.team = null; state.teamId = null; state.error = '';
      state.busy = false;
      render();
      dockEnsure();
      schedule(state.configuration ? FAST_POLL : SLOW_POLL);
      return;
    }
    state.summary = summary;
    state.error = '';
    const changed = summary.id !== state.teamId;
    if (changed) {
      state.teamId = summary.id;
      state.signature = '';
      state.selectedMember = '';
    }
    // A running team is worth a full snapshot every tick; a finished one only when its card is
    // open. The list endpoint is cheap enough to keep the launcher badge honest either way.
    if (changed || state.open || summary.status === 'running') {
      state.team = await getJson(`/api/teams/${encodeURIComponent(summary.id)}`);
      if (changed) autoOpen(summary);
    }
    state.busy = false;
    render();
    dockEnsure();
    const running = state.team?.status === 'running' || summary.status === 'running';
    schedule(running ? FAST_POLL : state.open ? SLOW_POLL : IDLE_POLL);
  } catch (error) {
    state.busy = false;
    state.error = error?.message || '读取团队状态失败。';
    render();
    dockEnsure();
    schedule(SLOW_POLL);
  }
}

function autoOpen(summary) {
  if (state.dismissed === summary.id) return;
  if (summary.status !== 'running') return;
  state.open = true;
  writeFlag(KEY_OPEN, 'open');
}

function toggle() {
  if (state.open) close();
  else openPanel();
}

function openPanel() {
  state.open = true;
  writeFlag(KEY_OPEN, 'open');
  if (state.teamId) { state.dismissed = ''; writeFlag(KEY_DISMISSED, ''); }
  render();
  schedule(120);
}

function close() {
  state.open = false;
  writeFlag(KEY_OPEN, 'closed');
  if (state.teamId) { state.dismissed = state.teamId; writeFlag(KEY_DISMISSED, state.teamId); }
  render();
}

/* ---------------------------------------------------------------- render */

/**
 * The app has six colour themes and this panel lives outside its theme root, so the palette is
 * picked from the page it is drawn on instead of from the operating system's preference.
 */
function detectTheme(root) {
  try {
    const raw = getComputedStyle(document.body).backgroundColor || '';
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(raw);
    if (!match) return;
    if (match[4] !== undefined && Number(match[4]) < 0.4) return;
    const luminance = 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]);
    root.dataset.theme = luminance < 128 ? 'dark' : 'light';
  } catch { /* keep the light default */ }
}

function render() {
  if (!state.mounted) return;
  const root = rootNode ?? document.getElementById(ROOT_ID);
  if (!root) return;
  if (!root.isConnected && !dockPanel() && document.body) {
    // Keep the node parked in document.body (hidden via CSS :not(.hg-team-docked)) while
    // `.workspace-tab-panel` is unmounted, so DOM queries and state updates stay alive.
    root.classList.remove(DOCK_CLASS);
    document.body.append(root);
  }
  detectTheme(root);
  const card = cardNode ?? root.querySelector('.hg-team-card');
  const launcher = launcherNode ?? root.querySelector('.hg-team-launcher');
  const count = countNode
    ?? root.querySelector('.hg-team-launcher-count')
    ?? document.getElementById('hg-team-tab')?.querySelector('.hg-team-launcher-count')
    ?? null;
  const team = state.team;
  const hasTeam = Boolean(team || state.summary || state.configuration);

  root.dataset.hasTeam = hasTeam ? 'true' : 'false';
  root.dataset.open = state.open && hasTeam ? 'true' : 'false';
  root.dataset.status = state.configuration ? 'pending' : team?.status ?? state.summary?.status ?? 'idle';
  const tabButton = launcher ?? document.getElementById('hg-team-tab');
  tabButton?.setAttribute('aria-expanded', state.open && hasTeam ? 'true' : 'false');
  if (tabButton) tabButton.hidden = false;
  if (count) {
    const running = (team?.members ?? []).filter(member => member.status === 'running').length;
    count.textContent = String(state.configuration?.members?.length ?? team?.members?.length ?? state.summary?.members ?? 0);
    count.dataset.running = String(running);
  }
  if (!card) return;
  card.hidden = !(state.open && hasTeam);
  if (card.hidden) { state.signature = ''; return; }

  const signature = state.configuration ? `setup:${state.configuration.id}|${state.configurationError}|${state.configurationSending}` : `${signatureOf(team)}|${state.open}|${state.error}|${state.selectedMember}`;
  if (signature === state.signature) {
    // Still redraw the clock: elapsed time changes without a new snapshot.
    paintClocks(card, team);
    return;
  }
  state.signature = signature;
  paintCard(card, team);
}

function paintCard(card, team) {
  // Polling must not steal keyboard focus or reset a reader's scroll position.
  const focusedKey = card.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey : null;
  const previousScroll = [...card.querySelectorAll('[data-scroll-key]')].map(node => [node.dataset.scrollKey, node.scrollTop, node.scrollLeft]);
  card.textContent = '';
  if (state.configuration) { card.append(buildConfiguration(state.configuration)); return; }
  if (!team) {
    card.append(el('div', { class: 'hg-team-empty' }, [
      el('strong', { text: state.error ? '暂时读不到团队看板' : '还没有团队' }),
      el('p', { text: state.error || '让 Agent 用 team_run 组建一个团队：这里会实时显示每名成员的工作、任务卡和交接留言。' }),
    ]));
    return;
  }
  const status = statusOf(team);
  const progress = progressOf(team);
  const lanes = buildLanes(team);
  const selection = memberSelection(lanes, state.selectedMember);
  state.selectedMember = selection.id;
  state.lanes = selection.lanes;
  card.dataset.memberFocus = selection.id ? 'true' : 'false';
  const feed = activityFeed(team, FEED_LIMIT);

  card.dataset.status = team.status;
  card.append(
    el('header', { class: 'hg-team-head' }, [
      el('div', { class: 'hg-team-heading' }, [
        el('strong', { class: 'hg-team-name', text: team.name || '团队' }),
        el('span', { class: 'hg-team-chip', dataset: { tone: status.tone }, text: status.label }),
        // 1.8.2: whether the members keep working after the tool call returns. It changes what
        // "协作中" means for the reader, so it is said out loud instead of being implied.
        el('span', {
          class: 'hg-team-chip', dataset: { tone: 'mode' }, text: modeLabel(team),
          title: team.mode === 'background' ? '成员在后台并行工作，队长同时做自己的部分' : '这一轮会等到成员全部返回',
        }),
        el('span', { class: 'hg-team-clock', 'data-team-clock': 'true', text: formatElapsed(teamElapsed(team)) }),
      ]),
      el('div', { class: 'hg-team-actions' }, [
        el('span', { class: 'hg-team-count', text: `${progress.done}/${progress.total} 项完成` }),
        el('button', { type: 'button', class: 'hg-team-close', 'aria-label': '收起协作看板', title: '收起（Esc）', onclick: () => close(), text: '×' }),
      ]),
    ]),
    el('p', { class: 'hg-team-goal', text: team.goal || '' }),
    el('div', { class: 'hg-team-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress.percent), 'aria-label': '任务完成度' }, [
      el('span', { class: 'hg-team-meter-bar', style: `width:${progress.percent}%` }),
    ]),
    el('div', { class: 'hg-team-meta' }, [
      el('span', { class: 'hg-team-headline', 'aria-live': 'polite', text: headlineOf(team) }),
      state.error ? el('span', { class: 'hg-team-warn', text: state.error }) : null,
      progress.failed ? el('span', { class: 'hg-team-warn', text: `${progress.failed} 项失败` }) : null,
    ]),
    buildMemberPicker(lanes, selection),
    el('div', { class: 'hg-team-body', dataset: { scrollKey: 'body' } }, [
      buildBoard(selection.lanes),
      // The inbox is a sibling of the scrolled log, not its first entry: a permission that needs
      // a person must never scroll out of sight behind the hand-offs.
      el('div', { class: 'hg-team-side' }, [
        el('h3', { class: 'hg-team-section-title', text: '团队动态' }),
        el('p', { class: 'hg-team-section-hint', text: '始终显示所有成员的审批与交接，不受成员筛选影响' }),
        buildApprovals(team),
        buildFeed(feed),
      ]),
    ]),
    el('footer', { class: 'hg-team-foot' }, [
      el('span', { text: `成员 ${lanes.filter(lane => lane.kind === 'member').length} · 任务 ${progress.total}` }),
      el('span', { class: 'hg-team-legend' }, [
        el('i', { class: 'hg-dot', dataset: { tone: 'running' } }), '进行中',
        el('i', { class: 'hg-dot', dataset: { tone: 'done' } }), '完成',
        el('i', { class: 'hg-dot', dataset: { tone: 'failed' } }), '失败',
      ]),
      el('span', { class: 'hg-team-hint', text: '成员每步操作仍按当前权限模式单独批准' }),
    ]),
  );

  const feedNode = card.querySelector('.hg-team-feed');
  if (feedNode && !previousScroll.some(([key]) => key === 'feed')) feedNode.scrollTop = feedNode.scrollHeight;
  for (const [key, top, left] of previousScroll) {
    const node = [...card.querySelectorAll('[data-scroll-key]')].find(item => item.dataset.scrollKey === key);
    if (node) { node.scrollTop = top; node.scrollLeft = left; }
  }
  if (focusedKey) {
    const target = [...card.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusedKey) ?? card.querySelector('.hg-member-option[aria-pressed="true"]');
    target?.focus({ preventScroll: true });
  }
  // Not requestAnimationFrame: the board is also drawn inside an iframe and in a background
  // tab, where the compositor may never run a frame. A zero-delay task always lands after this
  // paint, which is all the measurement needs.
  setTimeout(() => { drawEdges(card); paintClocks(card, team); }, 0);
}

// A team_run is paused on the server until the user confirms these exact members.
// This form never changes names, roles, tasks or tools assigned by the leader.
function buildConfiguration(configuration) {
  const profiles = Array.isArray(configuration.profiles) ? configuration.profiles : [];
  const form = el('form', { class: 'hg-team-configuration', 'aria-label': '组队前确认连接与模型', onsubmit: event => { event.preventDefault(); void submitConfiguration(false); } }, [
    el('header', { class: 'hg-setup-heading' }, [
      el('span', { class: 'hg-team-chip', dataset: { tone: 'running' }, text: '等待你的配置' }),
      el('h2', { text: '为团员选择连接与模型' }),
      el('p', { text: '队长已分配任务。确认后才会启动团队；这里不会更改成员分工和工具权限。' }),
    ]),
    el('div', { class: 'hg-setup-goal' }, [
      el('strong', { text: configuration.name || '新团队' }),
      el('p', { text: configuration.goal || '' }),
      el('small', { class: 'hg-setup-field-hint', text: '所属会话 · ' + configuration.sessionId + (configuration.expiresAt ? ' · 请在 ' + shortTime(configuration.expiresAt) + ' 前确认' : '') }),
    ]),
  ]);
  for (const member of configuration.members ?? []) {
    const draft = state.configurationDraft[member.id] ?? (state.configurationDraft[member.id] = { profile: member.profile || '', model: member.model || '' });
    const profileId = 'hg-setup-profile-' + member.id;
    const modelId = 'hg-setup-model-' + member.id;
    const modelInput = el('input', {
      id: modelId, type: 'text', class: 'hg-setup-input', value: draft.model, autocomplete: 'off', maxLength: 120,
      'aria-describedby': modelId + '-hint', list: modelId + '-options', disabled: state.configurationSending,
      oninput: event => { draft.model = event.target.value; },
    });
    const hint = el('small', { id: modelId + '-hint', class: 'hg-setup-field-hint' });
    function updateModelHint() {
      const profile = profiles.find(item => item.id === draft.profile || item.name === draft.profile);
      const defaultModel = draft.profile ? profile?.defaultModel : configuration.leaderModel;
      modelInput.placeholder = defaultModel ? '默认：' + defaultModel : '留空使用连接默认模型';
      hint.textContent = defaultModel ? '留空使用 ' + defaultModel + '；也可填写该连接支持的模型 ID。' : '留空继承所选连接的默认模型；自定义模型请填写完整模型 ID。';
    }
    const select = el('select', { id: profileId, class: 'hg-setup-input', disabled: state.configurationSending,
      onchange: event => { draft.profile = event.target.value; updateModelHint(); },
    }, [
      el('option', { value: '', text: '沿用队长连接' + (configuration.leaderProfileName ? ' · ' + configuration.leaderProfileName : '') }),
      ...profiles.map(profile => el('option', { value: profile.id, text: profile.name || profile.id })),
    ]);
    // Requests can carry a connection name; the API accepts both name and id.
    const resolved = profiles.find(profile => profile.id === draft.profile || profile.name === draft.profile);
    if (resolved) draft.profile = resolved.id;
    else if (draft.profile) select.append(el('option', { value: draft.profile, text: draft.profile + '（请确认连接可用）' }));
    select.value = draft.profile;
    updateModelHint();
    form.append(el('section', { class: 'hg-setup-member' }, [
      el('div', { class: 'hg-setup-member-head' }, [
        el('span', { class: 'hg-lane-avatar', 'aria-hidden': 'true', text: initialsOf(member.name) }),
        el('div', {}, [el('strong', { text: member.name }), el('small', { text: member.role || '成员' })]),
      ]),
      el('details', { class: 'hg-setup-task' }, [el('summary', { text: '队长分配的任务' }), el('p', { text: member.task || '未提供任务描述' })]),
      el('label', { for: profileId, text: '连接' }), select,
      el('label', { for: modelId, text: '模型' }), modelInput,
      el('datalist', { id: modelId + '-options' }, [...new Set([configuration.leaderModel, ...profiles.map(profile => profile.defaultModel)].filter(Boolean))].map(model => el('option', { value: model }))), hint,
    ]));
  }
  form.append(
    ...(state.configurationError ? [el('p', { class: 'hg-setup-error', role: 'alert', text: state.configurationError })] : []),
    el('div', { class: 'hg-setup-actions' }, [
      el('button', { type: 'button', class: 'hg-setup-cancel', disabled: state.configurationSending, text: '取消本次组队', onclick: () => void submitConfiguration(true) }),
      el('button', { type: 'submit', class: 'hg-setup-confirm', disabled: state.configurationSending, text: state.configurationSending ? '正在提交…' : '确认配置并启动' }),
    ]),
    el('p', { class: 'hg-setup-footer', text: '仅使用设置中已有的连接。连接密钥不会显示在此处；操作仍遵循当前权限模式。' }),
  );
  return form;
}

async function submitConfiguration(cancel) {
  if (state.configurationSending || !state.configuration) return;
  const configuration = state.configuration;
  const members = configuration.members.map(member => ({ id: member.id, profile: (state.configurationDraft[member.id]?.profile || '').trim(), model: (state.configurationDraft[member.id]?.model || '').trim() }));
  state.configurationSending = true;
  state.configurationError = '';
  render();
  try {
    const response = await fetch('/api/team-configurations/' + encodeURIComponent(configuration.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cancel ? { cancel: true, sessionId: configuration.sessionId } : { members, sessionId: configuration.sessionId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '提交失败（' + response.status + '），请重试。');
    state.configuration = null;
    state.configurationDraft = {};
    state.signature = '';
    schedule(100);
  } catch (error) {
    state.configurationError = error?.message || '无法提交配置，请检查本地服务。';
  } finally {
    state.configurationSending = false;
    render();
  }
}

function selectMember(id) {
  state.selectedMember = id;
  render();
}

function buildMemberPicker(lanes, selection) {
  const members = lanes.filter(lane => lane.kind === 'member');
  const options = [{ id: '', name: '全部成员', role: '团队总览', tone: 'pending', statusLabel: String(members.length) }, ...lanes];
  return el('section', { class: 'hg-team-members', 'aria-label': '选择团队成员' }, [
    el('div', { class: 'hg-team-section-head' }, [
      el('h3', { class: 'hg-team-section-title', text: '成员工作台' }),
      el('span', { class: 'hg-team-section-hint', text: members.length + ' 位成员 · 点击切换查看' }),
    ]),
    el('div', { class: 'hg-member-picker', role: 'group', 'aria-label': '查看成员', dataset: { scrollKey: 'picker' } }, options.map(lane => el('button', {
      type: 'button', class: 'hg-member-option', 'aria-pressed': String(selection.id === lane.id),
      title: lane.name + ' · ' + lane.role, dataset: { focusKey: 'member:' + lane.id, tone: lane.tone },
      onclick: () => selectMember(lane.id),
    }, [
      el('span', { class: 'hg-member-option-avatar', 'aria-hidden': 'true', text: lane.id ? initialsOf(lane.name) : '全' }),
      el('span', { class: 'hg-member-option-info' }, [
        el('strong', { text: lane.name }),
        el('small', { text: lane.id ? lane.statusLabel : members.length + ' 位成员' }),
      ]),
      el('span', { class: 'hg-member-option-dot', 'aria-hidden': 'true' }),
    ]))),
    selection.member ? el('div', { class: 'hg-member-context' }, [
      el('span', { text: '正在查看 ' + selection.member.name + ' · ' + selection.member.tasks.length + ' 项任务' }),
      el('button', { type: 'button', class: 'hg-member-reset', text: '返回总览', dataset: { focusKey: 'reset' }, onclick: () => selectMember('') }),
    ]) : el('p', { class: 'hg-team-section-hint', text: '选择成员查看完整任务与输出；此操作不会改变团队分工或运行配置。' }),
  ]);
}

function buildBoard(lanes) {
  const board = el('div', { class: 'hg-team-board', dataset: { scrollKey: 'board' } }, [
    el('svg', { class: 'hg-team-edges', 'aria-hidden': 'true' }),
  ]);
  if (!lanes.length) {
    board.append(el('p', { class: 'hg-team-board-empty', text: '看板上还没有任务。' }));
    return board;
  }
  for (const lane of lanes) {
    const laneNode = el('section', {
      class: 'hg-lane', dataset: { member: lane.id, status: lane.status, kind: lane.kind }, 'aria-label': lane.name + '的工作',
    }, [
      el('header', { class: 'hg-lane-head' }, [
        el('span', { class: 'hg-lane-avatar', 'aria-hidden': 'true', text: initialsOf(lane.name) }),
        el('div', { class: 'hg-lane-title' }, [
          el('button', { type: 'button', class: 'hg-lane-select', text: lane.name, title: '查看' + lane.name + '的完整工作', dataset: { focusKey: 'lane:' + lane.id }, onclick: () => selectMember(lane.id) }),
          el('small', { text: lane.role }),
        ]),
        el('span', { class: 'hg-lane-status', dataset: { tone: lane.tone }, text: lane.statusLabel }),
      ]),
      el('p', { class: 'hg-lane-meta', text: laneSubtitle(lane) }),
      // 1.8.2: which model and how many tools this member actually got. The tool list is in the
      // title, because a lane is not the place for twelve names.
      lane.kind === 'member' ? el('p', {
        class: 'hg-lane-model', title: memberToolLine(lane),
      }, [
        el('span', { class: 'hg-lane-model-name', text: lane.model }),
        lane.wakes ? el('span', { class: 'hg-lane-tools', dataset: { tone: 'wake' }, title: '答复新留言而重新运行的次数', text: memberWakeLabel(lane) }) : null,
        lane.tools.length ? el('span', { class: 'hg-lane-tools', text: `${lane.tools.length} 工具` }) : null,
        lane.toolsDropped.length ? el('span', { class: 'hg-lane-tools', dataset: { tone: 'warn' }, text: `忽略 ${lane.toolsDropped.length}` }) : null,
      ]) : null,
      state.selectedMember && lane.kind === 'member' ? el('div', { class: 'hg-member-runtime' }, [
        el('p', { text: '角色 · ' + lane.role }),
        el('p', { text: '连接 · ' + (lane.profile || '沿用队长连接') }),
        el('p', { text: '模型 · ' + lane.model }),
        el('p', { text: memberToolLine(lane) }),
      ]) : null,
      lane.activity ? el('p', { class: 'hg-lane-activity', text: lane.activity }) : null,
      lane.error ? el('p', { class: 'hg-lane-error', text: lane.error }) : null,
      el('ol', { class: 'hg-lane-tasks' }, lane.tasks.length
        ? lane.tasks.map(task => buildTask(task, lane))
        : [el('li', { class: 'hg-task-empty', text: '还没有自己的任务卡' })]),
      lane.text ? el('p', { class: 'hg-lane-text', text: lane.text }) : null,
      lane.inbox ? el('p', { class: 'hg-lane-inbox', text: `有 ${lane.inbox} 条留言将在下一轮送到` }) : null,
    ]);
    board.append(laneNode);
  }
  return board;
}

function laneSubtitle(lane) {
  const parts = [];
  if (lane.rounds) parts.push(`${lane.rounds} 轮`);
  if (lane.steps) parts.push(`${lane.steps} 步`);
  // Recomputed from the member's own timestamps, so a lane that has been running for two
  // minutes says two minutes even when the board itself has not changed.
  if (lane.kind === 'member') parts.push(formatElapsed(elapsedOf({ startedAt: lane.startedAt, finishedAt: lane.finishedAt })));
  return parts.join(' · ');
}

function buildTask(task, lane) {
  const card = el('li', {
    class: 'hg-task', dataset: { taskId: task.id, status: task.status, member: lane.id },
    title: task.detail || task.title,
  }, [
    el('div', { class: 'hg-task-head' }, [
      el('span', { class: 'hg-task-status', dataset: { tone: task.tone }, text: task.statusLabel }),
      el('span', { class: 'hg-task-title', text: task.title }),
    ]),
  ]);
  if (state.selectedMember && task.detail) card.append(el('p', { class: 'hg-task-detail', text: task.detail }));
  if (task.result) card.append(el('p', { class: 'hg-task-result', text: task.result }));
  if (Array.isArray(task.dependsOn) && task.dependsOn.length) {
    card.dataset.blocked = 'true';
    card.append(el('p', { class: 'hg-task-deps', text: `依赖 ${task.dependsOn.length} 项前置任务` }));
  }
  return card;
}

function buildFeed(feed) {
  return el('aside', { class: 'hg-team-feed', 'aria-label': '团队交接记录', dataset: { scrollKey: 'feed' } }, feed.length ? feed.map(item => el('div', {
    class: 'hg-feed-item', dataset: { kind: item.kind },
  }, [
    el('div', { class: 'hg-feed-head' }, [
      el('span', { class: 'hg-feed-kind', text: item.label }),
      el('span', { class: 'hg-feed-from', text: item.from }),
      el('span', { class: 'hg-feed-arrow', 'aria-hidden': 'true', text: '→' }),
      el('span', { class: 'hg-feed-to', text: item.to }),
      el('time', { class: 'hg-feed-time', text: item.time }),
    ]),
    el('p', { class: 'hg-feed-text', text: item.text }),
  ])) : [el('p', { class: 'hg-team-board-empty', text: '还没有交接记录。' })]);
}

/**
 * 1.8.2: the permissions a background member is waiting for.
 *
 * A member that outlives its turn has no SSE stream left, so its approval would otherwise sit
 * invisible until the 15 minute timeout. The panel answers it through the same endpoint the
 * transcript uses, and the member continues in place.
 */
function buildApprovals(team) {
  const pending = pendingApprovals(team);
  if (!pending.length) return null;
  return el('section', { class: 'hg-team-approvals', 'aria-label': '待批准的操作' }, [
    el('h3', { class: 'hg-team-approvals-title', text: `${pending.length} 个操作等待批准` }),
    ...pending.map(item => el('div', { class: 'hg-approval', dataset: { approval: item.approvalId } }, [
      el('div', { class: 'hg-approval-head' }, [
        el('strong', { class: 'hg-approval-member', text: item.member }),
        el('span', { class: 'hg-approval-tool', text: item.tool }),
        el('time', { class: 'hg-approval-time', text: item.time }),
      ]),
      el('p', { class: 'hg-approval-summary', text: item.summary }),
      el('div', { class: 'hg-approval-actions' }, [
        el('button', { type: 'button', class: 'hg-approval-allow', text: '批准', onclick: event => decide(item.approvalId, true, event) }),
        el('button', { type: 'button', class: 'hg-approval-deny', text: '拒绝', onclick: event => decide(item.approvalId, false, event) }),
      ]),
    ])),
    el('p', { class: 'hg-approval-hint', text: '后台团队成员会等在这里；15 分钟没有回答会自动拒绝。' }),
  ]);
}

async function decide(approvalId, approved, event) {
  const wrapper = event?.currentTarget?.closest?.('.hg-approval') ?? null;
  if (wrapper) wrapper.dataset.state = 'sending';
  for (const button of wrapper ? wrapper.querySelectorAll('button') : []) button.disabled = true;
  try {
    const response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    if (!response.ok) throw new Error(`请求未完成（${response.status}）`);
    state.error = '';
    if (wrapper) wrapper.dataset.state = approved ? 'approved' : 'denied';
    state.signature = '';
    schedule(150);
  } catch (error) {
    // The decision failed, so the request is still pending: say why and put the buttons back.
    state.error = `批准没有送达：${error?.message || '未知原因'}`;
    if (wrapper) delete wrapper.dataset.state;
    for (const button of wrapper ? wrapper.querySelectorAll('button') : []) button.disabled = false;
    state.signature = '';
    render();
  }
}

function teamElapsed(team) {
  if (!team) return 0;
  return elapsedOf({ createdAt: team.createdAt, startedAt: team.createdAt, finishedAt: team.finishedAt });
}

function paintClocks(root, team) {
  const node = root.querySelector('[data-team-clock]');
  if (node && team) node.textContent = formatElapsed(teamElapsed(team));
  for (const laneNode of root.querySelectorAll('.hg-lane')) {
    const lane = state.lanes.find(item => String(item.id) === laneNode.dataset.member);
    const meta = laneNode.querySelector('.hg-lane-meta');
    if (lane && meta) meta.textContent = laneSubtitle(lane);
  }
}

/* ----------------------------------------------------------------- edges */

function drawEdges(card) {
  const board = card.querySelector('.hg-team-board');
  const svg = card.querySelector('.hg-team-edges');
  if (!board || !svg) return;
  const edges = dependencyEdges(state.lanes).filter(edge => edge.from.lane !== edge.to.lane);
  svg.textContent = '';
  if (!edges.length) { svg.removeAttribute('viewBox'); return; }
  const boardRect = board.getBoundingClientRect();
  const width = Math.max(board.scrollWidth, boardRect.width);
  const height = Math.max(board.scrollHeight, boardRect.height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  // The 1.8.0 regression: as an absolutely positioned child of a grid container this SVG was
  // laid out at 0x0, so the viewBox collapsed every path to nothing and no dependency line was
  // ever visible. An explicit pixel size is what actually decides the viewport.
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  const locate = id => {
    const node = board.querySelector(`[data-task-id="${cssEscape(id)}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left - boardRect.left + board.scrollLeft,
      right: rect.right - boardRect.left + board.scrollLeft,
      middle: rect.top - boardRect.top + board.scrollTop + rect.height / 2,
    };
  };
  // Built node by node instead of through innerHTML: an HTML fragment parser inside an SVG
  // context lowercases viewBox/refX and produces attributes the renderer ignores.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'hg-team-arrow');
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '5');
  marker.setAttribute('markerHeight', '5');
  marker.setAttribute('orient', 'auto-start-reverse');
  const head = document.createElementNS(SVG_NS, 'path');
  head.setAttribute('d', 'M0 0 L8 4 L0 8 z');
  head.setAttribute('fill', 'currentColor');
  marker.append(head);
  defs.append(marker);
  svg.append(defs);
  for (const edge of edges) {
    const from = locate(edge.from.taskId);
    const to = locate(edge.to.taskId);
    if (!from || !to) continue;
    // Forward means "dependency sits in a lane to the left"; the curve then leaves the right
    // edge of the card and enters the left edge of the dependent one, staying in the gutter.
    const forward = edge.to.lane > edge.from.lane;
    const x1 = forward ? from.right : from.left;
    const x2 = forward ? to.left : to.right;
    const bend = Math.min(46, Math.max(12, Math.abs(x2 - x1) / 2));
    const direction = forward ? 1 : -1;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${x1} ${from.middle} C ${x1 + direction * bend} ${from.middle}, ${x2 - direction * bend} ${to.middle}, ${x2} ${to.middle}`);
    path.setAttribute('class', 'hg-edge');
    path.dataset.tone = 'cross';
    path.setAttribute('marker-end', 'url(#hg-team-arrow)');
    svg.append(path);
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ boot */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  window.addEventListener('resize', () => {
    const card = cardNode ?? document.querySelector('#hg-team-card');
    if (card && !card.hidden) drawEdges(card);
  });
}

/* --------------------------------------------------------------- 1.8.5 dock */
// 看板住进「工作空间」：launcher → 「团队」标签页，card → 面板里的一页。
// 看板自己的逻辑（轮询、渲染、批准、Esc）全部复用，这里只做搬运和"哪一页在前"的同步。

const DOCK_CLASS = 'hg-team-docked';
const DOCK_ACTIVE = 'hg-team-active';
const DOCK_HINT_CLASS = 'hg-team-dock-hint';
const dockState = {
  lastActive: false,
  lastOpen: false,
  hint: false,
  observing: false,
  treeObserving: false,
  ensureQueued: false,
  revealPending: 0,
  timer: 0,
};

function dockRoot() {
  return rootNode ?? document.getElementById(ROOT_ID);
}

function dockPanel() {
  return document.querySelector('.workspace-tab-panel');
}

function dockLauncher(node) {
  const root = node ?? dockRoot();
  return launcherNode ?? root?.querySelector('.hg-team-launcher') ?? document.getElementById('hg-team-tab') ?? null;
}

/**
 * 五个标签挤在 360px 宽的面板里时，图标会把「对话地图」挤成两行。这里按标签栏的真实宽度
 * 决定要不要收掉图标（窄了只留文字），宽了再放回来；只动 class，不改任何按钮的结构。
 */
function dockTightTabs(tabs) {
  if (!tabs) return;
  const crowded = tabs.clientWidth > 0 && tabs.clientWidth < 440 && tabs.children.length >= 5;
  tabs.classList.toggle('hg-tabs-tight', crowded);
  if (!tabs.dataset.hgTeamTightBound) {
    tabs.dataset.hgTeamTightBound = 'true';
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => dockTightTabs(tabs)).observe(tabs);
  }
}

function scheduleDockEnsure() {
  if (dockState.ensureQueued) return;
  dockState.ensureQueued = true;
  requestAnimationFrame(() => {
    dockState.ensureQueued = false;
    dockEnsure();
  });
}

function dockEnsure() {
  const root = dockRoot();
  if (!root) return;
  const panel = dockPanel();
  if (!panel) {
    if (!root.isConnected && document.body) {
      root.classList.remove(DOCK_CLASS);
      document.body.append(root);
    }
    if (dockState.revealPending > 0 && state.open && root.dataset.hasTeam === 'true') {
      dockState.revealPending -= 1;
      dockOpenRightPanel({ leaveBrowser: true });
    }
    return;
  }
  const tabs = panel.querySelector('.right-tabs');
  const launcher = dockLauncher(root);
  const card = cardNode ?? root.querySelector('.hg-team-card');
  if (!tabs || !launcher || !card) return;

  // 1.8.5b:「子代理」保持原样，团队是它右边新加的一格，不当替身。
  const subagents = [...tabs.querySelectorAll('button')]
    .find(button => button !== launcher && (button.textContent || '').trim().startsWith('子代理')) ?? null;
  dockTightTabs(tabs);

  if (!launcher.classList.contains('hg-team-tab')) {
    launcher.classList.add('hg-team-tab');
    launcher.id = 'hg-team-tab';
    launcher.title = '团队看板：成员泳道、任务卡、交接留言与待批准操作';
  }
  // render() 会按有没有团队设 hidden；作为标签页它必须一直在，这里先兜一层，
  // CSS 里还有 display:inline-flex 兜第二层。
  launcher.hidden = false;

  if (launcher.parentElement !== tabs || (subagents && launcher.previousElementSibling !== subagents)) {
    if (subagents && subagents.parentElement === tabs) tabs.insertBefore(launcher, subagents.nextSibling);
    else tabs.append(launcher);
  }
  dockTightTabs(tabs);

  root.classList.add(DOCK_CLASS);
  if (root.parentElement !== panel) panel.append(root);

  if (!dockState.observing) {
    dockState.observing = true;
    new MutationObserver(() => dockOnRootChange()).observe(root, {
      attributes: true,
      attributeFilter: ['data-open', 'data-has-team', 'data-status'],
    });
  }
  if (!panel.dataset.hgTeamBound) {
    panel.dataset.hgTeamBound = 'true';
    panel.addEventListener('click', dockOnPanelClick, true);
  }
  if (dockState.revealPending > 0) dockState.revealPending = 0;
  dockSync();
}

/** 右侧面板被收起时打开它；等待团队配置确认时若正停在内置浏览器，则切回「工作空间」。 */
function dockOpenRightPanel({ leaveBrowser = false } = {}) {
  const aside = document.querySelector('aside.right-panel');
  if (!aside) return;
  if (getComputedStyle(aside).display === 'none') {
    const opener = [...document.querySelectorAll('button[title]')]
      .find(button => String(button.title).includes('打开工作空间'));
    opener?.click();
  }
  if (!leaveBrowser || dockPanel()) return;
  const direct = [...aside.querySelectorAll('button')]
    .find(button => button.classList.contains('browser-tab-workspace') || ['工作空间'].includes((button.textContent || '').trim()));
  if (direct) { direct.click(); return; }
  const picker = aside.querySelector('.browser-tab-picker-trigger');
  if (picker) {
    if (picker.getAttribute('aria-expanded') !== 'true') picker.click();
    requestAnimationFrame(() => {
      document.querySelector('.browser-tab-workspace')?.click();
      scheduleDockEnsure();
    });
  }
}

function dockSync() {
  const root = dockRoot();
  const panel = dockPanel();
  const launcher = dockLauncher(root);
  if (!root || !panel || !launcher) return;
  const hasTeam = root.dataset.hasTeam === 'true';
  const open = root.dataset.open === 'true';
  const active = open || dockState.hint;

  launcher.classList.toggle('active', active);
  launcher.setAttribute('aria-expanded', String(active));

  if (active && !dockState.lastActive) dockOpenRightPanel({ leaveBrowser: Boolean(state.configuration) });
  dockState.lastActive = active;
  dockState.lastOpen = open;

  if (active) {
    // 对话地图那一页让位（它自己也监听标签点击，这里覆盖自动展开的情况）
    panel.classList.remove('hg-cmap-active');
    document.getElementById('hg-cmap-tab')?.classList.remove('active');
  }
  panel.classList.toggle(DOCK_ACTIVE, active);

  // 没有团队时看板本体是 hidden 的，别让标签页点开是一片空白
  let hint = panel.querySelector('.' + DOCK_HINT_CLASS);
  const needHint = active && !hasTeam;
  if (needHint && !hint) {
    hint = el('div', { class: DOCK_HINT_CLASS }, [
      el('span', { class: 'hg-team-empty-mark', 'aria-hidden': 'true', text: '协作' }),
      el('strong', { text: state.error ? '暂时读不到团队看板' : '让合适的成员，一起完成任务' }),
      el('p', { class: 'hg-team-empty-description', text: state.error || '团队启动后，在这里选择成员、查看分工与完整输出，跟踪任务进度和审批。' }),
      el('div', { class: 'hg-team-empty-guide' }, [
        el('b', { text: '如何开始' }),
        el('p', { text: '在「编程」模式的对话中描述目标与希望的成员分工，让 Agent 用 team_run 组建团队。' }),
        el('small', { text: '例如：请组建团队，由前端负责界面、测试负责回归，一起完成这个功能。' }),
      ]),
      el('p', { class: 'hg-team-empty-note', text: '成员可使用已配置的连接与模型；实际分工和工具权限以启动后的记录为准。' }),
    ]);
    panel.append(hint);
  }
  if (hint) hint.hidden = !needHint;
}

function dockOnPanelClick(event) {
  const button = event.target?.closest?.('.right-tabs > button');
  if (!button) return;
  const root = dockRoot();
  if (button.id === 'hg-team-tab') {
    // 没有团队时 launcher 的 toggle() 不会打开任何东西，自己记一下"点了"
    if (root?.dataset.hasTeam !== 'true') dockState.hint = !dockState.hint;
    else dockState.hint = false;
    dockSync();
    return;
  }
  // 点了别的标签页 = 收起看板（等同原来点 × / Esc）
  dockState.hint = false;
  if (root?.dataset.open === 'true') dockLauncher(root)?.click();
  dockSync();
}

function dockOnRootChange() {
  const root = dockRoot();
  if (!root) return;
  const open = root.dataset.open === 'true';
  if (open && !dockState.lastOpen) {
    dockState.hint = false;
    dockEnsure();
    if (!dockPanel()) dockOpenRightPanel({ leaveBrowser: Boolean(state.configuration) });
    setTimeout(dockEnsure, 150);
  }
  dockState.lastOpen = open;
  dockSync();
}

function dockBoot() {
  dockEnsure();
  if (!dockState.treeObserving && typeof MutationObserver === 'function' && document.body) {
    dockState.treeObserving = true;
    // Re-dock on the very next animation frame whenever React unmounts/remounts `.workspace-tab-panel`
    // (for example when leaving the built-in browser or switching sessions).
    new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.addedNodes.length || m.removedNodes.length) {
          if (!launcherNode?.isConnected || !rootNode?.isConnected || (dockPanel() && rootNode?.parentElement !== dockPanel())) {
            scheduleDockEnsure();
          }
          break;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (dockState.timer) clearInterval(dockState.timer);
  // 面板会随「收起 / 打开浏览器 / 换会话」重建，这里只管把看板重新接回去。
  dockState.timer = setInterval(dockEnsure, 700);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(dockBoot, 40), { once: true });
  else setTimeout(dockBoot, 40);
}

export { state as teamPanelState, render as renderTeamPanel, mount as mountTeamPanel, shortTime };
