// 1.8.4: 对话地图 + 搜索，作为「工作空间」面板里的独立标签页。
//
// 1.8.1 把地图塞进了 Ctrl+F 那条浮动搜索条；这一版整条搬到右侧面板，并且**单独一个标签页**：
//   「产物 / 子代理 / 工作区 / 对话地图」——地图有自己的位置，不再挤在工作区文件列表上面。
//   · 地图卡片（提问 + 时间 + 回复摘要）占满面板，点一下跳到那条消息；
//   · 搜索框、Aa 区分大小写、上/下一条、「全部对话」跨会话搜索都在这个页面里；
//   · Ctrl+F 或对话头部的放大镜，就是把「对话地图」这个标签页点开并聚焦搜索框。
//
// 业务逻辑仍然只有一份：session-tools.js 的 ChatFindBar 里算 messages → 卡片、命中、
// 滚动定位、跨会话搜索，它把状态和动作通过 window.hgConversationMap.publish() 交给这里，
// 这里只做渲染和事件转交，两边不会各算一套。

const DOCK_ID = 'hg-cmap-dock';
const TAB_ID = 'hg-cmap-tab';
const ACTIVE_CLASS = 'hg-cmap-active';
const FOLD_KEY = 'hg.cmap.folded';
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_SVG = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.6 15.6 21 21"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  sparkle: '<path d="M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3z"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  fold: '<path d="m6 9 6 6 6-6"/>',
};

const state = {
  published: null,
  api: null,
  signature: '',
  cursor: -1,
  focusTick: -1,
  folded: readFold(),
};

let tab = null;
let view = null;
let parts = null;
let attachTimer = 0;
let panelObserver = null;
let ensureScheduled = false;

/* --------------------------------------------------------------- helpers */

function readFold() {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}

function writeFold(folded) {
  try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch { /* 忽略 */ }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, size = 13) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_SVG[name] || '';
  return svg;
}

/** 卡片右上角的时间：2026/11/15 11:43（和手机上看到的写法一致）。 */
function formatTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把 mapSnippet 给出的 {text,start,len} 变成“命中高亮”的片段。 */
function renderHit(segment) {
  const text = String(segment?.text ?? '');
  const start = Number(segment?.start);
  const len = Number(segment?.len);
  if (!text) return document.createTextNode('');
  if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0) return document.createTextNode(text);
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.append(document.createTextNode(text.slice(0, start)));
  fragment.append(el('mark', { text: text.slice(start, start + len) }));
  if (start + len < text.length) fragment.append(document.createTextNode(text.slice(start + len)));
  return fragment;
}

function signatureOf(data) {
  if (!data) return 'none';
  const items = (data.items || []).map(item => [
    item.entry?.key,
    item.entry?.time || '',
    item.entry?.pending ? 1 : 0,
    item.question?.text || '',
    item.question?.start ?? -1,
    item.question?.len ?? 0,
    item.answer?.text || '',
    item.answer?.start ?? -1,
    item.answer?.len ?? 0,
  ].join('|')).join(';');
  const results = (data.globalState?.results || []).map(session => [
    session.sessionId,
    session.title || '',
    JSON.stringify(session.matches || []),
  ].join(':')).join(',');
  return [
    data.query || '',
    data.caseSensitive ? 1 : 0,
    data.matchTotal,
    data.activeIndex,
    data.mapCursor,
    data.showGlobal ? 1 : 0,
    data.globalState?.loading ? 1 : 0,
    data.hasMessages ? 1 : 0,
    data.activeSessionId || '',
    state.folded ? 1 : 0,
    results,
    items,
  ].join('#');
}

/* ------------------------------------------------------------------ 视图 */

function buildView() {
  const input = el('input', {
    type: 'text',
    class: 'hg-find-input',
    'aria-label': '搜索消息与对话地图',
    placeholder: '搜索消息…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  input.addEventListener('input', () => {
    state.api?.setQuery?.(input.value);
  });
  // Keyboard handling is delegated once to the root (avoid double navigation).

  const clearBtn = el('button', { type: 'button', class: 'hg-find-btn hg-cmap-clear', title: '清除搜索 (Esc)', 'aria-label': '清除搜索', onClick: () => { state.api?.setQuery?.(''); input.focus(); } }, '×');
  const counter = el('span', { class: 'hg-find-count', 'aria-live': 'polite' });
  const count = el('span', { class: 'hg-map-count' });
  const caseBtn = el('button', {
    type: 'button',
    class: 'hg-find-btn',
    title: '区分大小写',
    'aria-label': '区分大小写',
    onClick: () => state.api?.toggleCase?.(),
  }, 'Aa');
  const upBtn = el('button', {
    type: 'button',
    class: 'hg-find-btn',
    title: '上一条 (Shift+Enter)',
    'aria-label': '上一条',
    onClick: () => stepBy(-1),
  }, icon('up', 15));
  const downBtn = el('button', {
    type: 'button',
    class: 'hg-find-btn',
    title: '下一条 (Enter)',
    'aria-label': '下一条',
    onClick: () => stepBy(1),
  }, icon('down', 15));
  const globalBtn = el('button', {
    type: 'button',
    class: 'hg-find-btn hg-find-scope-btn',
    title: '在全部会话正文中搜索并跳转',
    'aria-pressed': 'false',
    onClick: () => {
      state.api?.setShowGlobal?.(!(state.published?.showGlobal));
    },
  }, '全部对话');
  const foldBtn = el('button', {
    type: 'button',
    class: 'hg-map-close hg-cmap-fold',
    title: state.folded ? '展开对话地图' : '收起对话地图',
    'aria-label': state.folded ? '展开对话地图' : '收起对话地图',
    onClick: () => {
      state.folded = !state.folded;
      writeFold(state.folded);
      render(true);
    },
  }, icon('fold', 14));

  const list = el('div', { class: 'hg-map-list hg-cmap-list', id: 'hg-cmap-list', role: 'group', 'aria-label': '按提问排列的对话节点' });
  const results = el('div', { class: 'hg-find-results hg-cmap-results', role: 'region', 'aria-label': '跨对话搜索结果' });

  const position = el('span', { class: 'hg-cmap-position', 'aria-live': 'polite' });
  const footer = el('div', { class: 'hg-cmap-footer' }, [position, el('span', { text: '↑↓ 选择 · Enter 定位' })]);
  const root = el('div', {
    class: 'hg-cmap hg-cmap-view',
    id: DOCK_ID,
    role: 'search',
    'aria-label': '对话地图与消息搜索',
  }, [
    el('div', { class: 'hg-cmap-head' }, [
      el('span', { class: 'hg-map-heading' }, [icon('list', 13), el('span', { text: '对话地图' })]),
      count,
      el('span', { class: 'hg-cmap-hint', text: 'Ctrl+F' }),
      foldBtn,
    ]),
    el('p', { class: 'hg-cmap-description', text: '按提问梳理对话，点击节点回到消息。' }),
    el('div', { class: 'hg-find-input-wrap hg-cmap-search' }, [icon('search', 14), input, clearBtn, counter]),
    el('div', { class: 'hg-cmap-tools' }, [caseBtn, upBtn, downBtn, globalBtn]),
    list,
    results,
    footer,
  ]);
  root.addEventListener('keydown', onKeyDown);

  return {
    root, input, counter, count, list, results, clearBtn, position,
    caseBtn, upBtn, downBtn, globalBtn, foldBtn,
  };
}

function buildTab() {
  const button = el('button', {
    type: 'button',
    class: 'hg-cmap-tab',
    id: TAB_ID,
    'aria-controls': DOCK_ID,
    'aria-selected': 'false',
    onClick: () => {
      if (isActive()) return;
      activate();
    },
  }, [icon('list', 14), el('span', { text: '对话地图' })]);
  return button;
}

function stepBy(delta) {
  const data = state.published;
  if (!data) return;
  if ((data.query || '').trim()) state.api?.step?.(delta);
  else state.api?.moveCursor?.(delta);
}

function onKeyDown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  // Keep Enter/Space native on cards and toolbar buttons.
  const button = event.target?.closest?.('button');
  if (button && event.key !== 'Escape' && event.key !== 'F3' && (!button.classList.contains('hg-map-card') || !['ArrowUp', 'ArrowDown'].includes(event.key))) return;
  const data = state.published;
  if (!data) return;
  const query = (data.query || '').trim();
  const browsing = !query;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (query) state.api?.setQuery?.('');
    else parts?.input?.blur();
    return;
  }
  if (event.key === 'Enter' || event.key === 'F3') {
    event.preventDefault();
    if (browsing) state.api?.jumpToItem?.(data.mapCursor);
    else state.api?.step?.(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === 'ArrowDown' && !event.altKey) {
    event.preventDefault();
    if (browsing) state.api?.moveCursor?.(1);
    else state.api?.step?.(1);
    return;
  }
  if (event.key === 'ArrowUp' && !event.altKey) {
    event.preventDefault();
    if (browsing) state.api?.moveCursor?.(-1);
    else state.api?.step?.(-1);
  }
}

/* ------------------------------------------------------------------ 渲染 */

function render(force = false) {
  if (!view || !parts) return;
  const data = state.published;
  if (!data) {
    parts.list.replaceChildren(el('div', { class: 'hg-map-empty', text: '正在读取对话…' }));
    return;
  }
  const signature = signatureOf(data);
  if (!force && signature === state.signature) return;
  state.signature = signature;

  const query = data.query || '';
  const filtering = Boolean(query.trim());
  parts.count.textContent = filtering ? `匹配 ${data.items.length} 条` : `共 ${data.items.length} 条`;
  parts.counter.textContent = filtering
    ? (data.matchTotal > 0 ? `${data.activeIndex + 1} / ${data.matchTotal}` : '0 / 0')
    : String(data.items.length);
  parts.counter.classList.toggle('no-match', filtering && data.matchTotal === 0);
  parts.caseBtn.classList.toggle('active', Boolean(data.caseSensitive));
  parts.globalBtn.classList.toggle('active', Boolean(data.showGlobal));
  parts.globalBtn.textContent = filtering && data.globalState?.results?.length
    ? `全部对话 (${data.globalState.results.length})`
    : '全部对话';
  parts.upBtn.disabled = parts.downBtn.disabled = filtering ? data.matchTotal === 0 : !data.items.length;
  parts.caseBtn.setAttribute('aria-pressed', String(Boolean(data.caseSensitive)));
  parts.globalBtn.setAttribute('aria-pressed', String(Boolean(data.showGlobal)));
  parts.clearBtn.hidden = !query;
  parts.position.textContent = state.folded ? '地图已收起' : data.items.length ? `节点 ${Math.min(data.items.length, Math.max(0, data.mapCursor + 1))} / ${data.items.length}` : '暂无节点';
  parts.foldBtn.setAttribute('aria-expanded', String(!state.folded));
  parts.foldBtn.setAttribute('aria-controls', 'hg-cmap-list');
  parts.foldBtn.title = state.folded ? '展开对话地图' : '收起对话地图';
  parts.foldBtn.setAttribute('aria-label', parts.foldBtn.title);
  parts.foldBtn.classList.toggle('is-folded', state.folded);
  view.dataset.folded = state.folded ? 'true' : 'false';

  if (parts.input.value !== query) parts.input.value = query;

  // 卡片
  if (!data.items.length) {
    parts.list.replaceChildren(el('div', { class: 'hg-map-empty' }, [
      el('span', { class: 'hg-cmap-empty-icon' }, icon(filtering ? 'search' : 'list', 24)),
      el('strong', { text: filtering ? '没有找到匹配的节点' : '从第一条提问开始' }),
      el('span', { text: filtering ? '试试更短的关键词，或搜索全部对话。' : '发送消息后，提问与回复摘要会按顺序出现在这里。' }),
      filtering ? el('button', { type: 'button', class: 'hg-find-btn', onClick: () => state.api?.setQuery?.('') }, '清除搜索') : null,
    ]));
  } else {
    const fragment = document.createDocumentFragment();
    data.items.forEach((item, index) => fragment.append(buildCard(item, index, data)));
    const focusedKey = parts.list.contains(document.activeElement) ? document.activeElement?.dataset?.key : null;
    const focusedIndex = parts.list.contains(document.activeElement) ? document.activeElement?.dataset?.index : null;
    parts.list.replaceChildren(fragment);
    if (focusedKey != null) {
      const moved = state.cursor !== data.mapCursor;
      const next = moved ? parts.list.children[data.mapCursor] : [...parts.list.children].find(card => card.dataset.key === focusedKey && card.dataset.index === focusedIndex);
      next?.focus({ preventScroll: true });
    }
    state.cursor = data.mapCursor;
    const current = parts.list.children[data.mapCursor];
    if (current && state.folded === false) {
      const box = parts.list.getBoundingClientRect();
      const rect = current.getBoundingClientRect();
      if (rect.top < box.top) parts.list.scrollTop -= box.top - rect.top;
      else if (rect.bottom > box.bottom) parts.list.scrollTop += rect.bottom - box.bottom;
    }
  }

  renderResults(data, filtering);

  // 标签上的计数：没有消息时不显示，免得新对话上挂个 0。
  if (tab) {
    const badge = tab.querySelector('.hg-cmap-tab-count');
    const total = data.items.length;
    if (!total) badge?.remove();
    else if (badge) badge.textContent = String(total);
    else tab.append(el('span', { class: 'hg-cmap-tab-count', text: String(total) }));
  }
}

function buildCard(item, index, data) {
  const entry = item.entry || {};
  const answerText = item.answer?.text || (entry.pending ? '正在回复…' : '');
  const active = index === data.mapCursor;
  const card = el('button', {
    type: 'button',
    class: 'hg-map-card' + (active ? ' is-current' : ''),
    dataset: { key: entry.key || String(index), index: String(index) },
    title: `${entry.question || '这条提问'}（点击跳到这条消息）`,
    onClick: () => state.api?.jumpToItem?.(index),
  }, [
    el('div', { class: 'hg-map-card-top' }, [
      el('span', { class: 'hg-cmap-node-number', text: String((entry.index ?? index) + 1).padStart(2, '0') }),
      el('span', { class: 'hg-cmap-node-label', text: '提问' }),
      entry.time ? el('span', { class: 'hg-map-card-time', text: formatTime(entry.time) }) : null,
      active ? el('span', { class: 'hg-cmap-current-label', text: '当前' }) : null,
    ]),
    el('span', { class: 'hg-map-card-question' }, [item.question?.text ? renderHit(item.question) : document.createTextNode(entry.question || '附件 / 多模态提问')]),
    answerText
      ? el('div', { class: 'hg-map-card-answer' }, [
          el('span', { class: 'hg-cmap-answer-label' + (entry.pending ? ' is-pending' : ''), text: entry.pending ? '回复中' : '回复' }),
          el('span', { class: 'hg-map-card-preview' }, [item.answer?.text ? renderHit(item.answer) : document.createTextNode(answerText)]),
        ])
      : null,
  ]);
  if (active) card.setAttribute('aria-current', 'true');
  return card;
}

function renderResults(data, filtering) {
  if (!parts) return;
  const all = data.globalState?.results || [];
  const others = all.filter(session => session.sessionId !== data.activeSessionId);
  const shouldShow = filtering && (data.showGlobal || (data.matchTotal === 0 && others.length > 0));
  if (!shouldShow) {
    parts.results.replaceChildren();
    parts.results.hidden = true;
    return;
  }
  const sessionList = data.showGlobal ? all : others;
  const rows = [];
  let total = 0;
  for (const session of sessionList) {
    for (const hit of (session.matches || []).slice(0, 5)) {
      total += 1;
      rows.push(el('button', {
        type: 'button',
        class: 'hg-find-result-item' + (session.sessionId === data.activeSessionId ? ' current' : ''),
        onClick: () => state.api?.jumpToHit?.(session, hit),
      }, [
        el('div', { class: 'hg-find-result-top' }, [
          el('span', { text: session.title || '新对话' }),
          session.sessionId === data.activeSessionId ? el('span', { class: 'hg-find-result-badge', text: '当前对话' }) : null,
          el('span', {
            class: 'hg-find-result-role',
            text: hit.role === 'title' ? '标题' : hit.role === 'user' ? '我的提问' : '助手回复',
          }),
        ]),
        el('div', { class: 'hg-find-result-snippet' }, highlightSnippet(hit.snippet || '', (data.query || '').trim(), Boolean(data.caseSensitive))),
      ]));
    }
  }
  const head = el('div', { class: 'hg-find-results-head' }, [
    el('span', {
      text: data.globalState?.loading
        ? '正在搜索全部对话…'
        : all.length
          ? `在 ${all.length} 个对话中找到 ${data.globalState?.totalMatches ?? total} 处匹配（点击跳转定位）：`
          : '全部对话中均未找到匹配内容',
    }),
  ]);
  parts.results.replaceChildren(head, ...rows);
  parts.results.hidden = false;
}

function highlightSnippet(text, query, caseSensitive) {
  const raw = String(text || '');
  const needle = String(query || '');
  if (!raw || !needle) return document.createTextNode(raw);
  const hay = caseSensitive ? raw : raw.toLowerCase();
  const find = caseSensitive ? needle : needle.toLowerCase();
  const fragment = document.createDocumentFragment();
  let from = 0;
  while (from <= hay.length - find.length && find.length) {
    const index = hay.indexOf(find, from);
    if (index < 0) break;
    if (index > from) fragment.append(document.createTextNode(raw.slice(from, index)));
    fragment.append(el('mark', { text: raw.slice(index, index + needle.length) }));
    from = index + needle.length;
  }
  if (from < raw.length) fragment.append(document.createTextNode(raw.slice(from)));
  return fragment;
}

/* ------------------------------------------------------- attach / observe */

function findPanel() {
  return document.querySelector('.workspace-tab-panel');
}

function bindPanel(panel) {
  if (!panel || panel.__hgCmapBound) return;
  panel.__hgCmapBound = true;
  // 点了「产物 / 子代理 / 工作区」就把自己的标签页让出来（React 的内容重新显现）。
  panel.addEventListener('click', event => {
    const button = event.target?.closest?.('.right-tabs > button');
    if (!button || button === tab) return;
    deactivate();
  }, true);
}

function ensureMounted() {
  if (!tab || !view) return;
  const panel = findPanel();
  if (!panel) return;
  bindPanel(panel);
  const tabs = panel.querySelector('.right-tabs');
  if (!tabs) return;
  if (tab.parentNode !== tabs || tabs.lastElementChild !== tab) tabs.append(tab);
  if (view.parentNode !== panel || panel.lastElementChild !== view) panel.append(view);
  if (!isActive() && tab.classList.contains('active')) tab.classList.remove('active');
  watchPanel(panel);
}

function watchPanel(panel) {
  if (!panel || panelObserver?.__target === panel) return;
  panelObserver?.disconnect?.();
  if (typeof MutationObserver !== 'function') return;
  panelObserver = new MutationObserver(() => scheduleEnsure());
  panelObserver.__target = panel;
  panelObserver.observe(panel, { childList: true });
}

function scheduleEnsure() {
  if (ensureScheduled) return;
  ensureScheduled = true;
  requestAnimationFrame(() => {
    ensureScheduled = false;
    ensureMounted();
  });
}

function isActive() {
  return Boolean(findPanel()?.classList.contains(ACTIVE_CLASS));
}

function activate(options = {}) {
  ensureMounted();
  const panel = findPanel();
  if (!panel) return false;
  panel.classList.add(ACTIVE_CLASS);
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  if (options.focus !== false) focusInput(options);
  return true;
}

function deactivate() {
  findPanel()?.classList.remove(ACTIVE_CLASS);
  tab?.classList.remove('active');
  tab?.setAttribute('aria-selected', 'false');
}

function focusInput(options = {}) {
  if (!parts?.input) return;
  parts.input.focus({ preventScroll: true });
  if (options.select !== false) parts.input.select?.();
}

/** 右侧面板收起来了就先点开它（对话头部的按钮和 Ctrl+F 都要能用）。 */
function ensureRightPanelOpen() {
  const aside = document.querySelector('aside.right-panel');
  if (!aside) return;
  const hidden = getComputedStyle(aside).display === 'none' || aside.getBoundingClientRect().width === 0;
  if (!hidden) return;
  const opener = [...document.querySelectorAll('button[title]')]
    .find(button => (button.getAttribute('title') || '').includes('打开工作空间'));
  opener?.click();
}

/** 面板正停在内置浏览器上时，「对话地图」标签页要先回到工作空间视图。 */
function leaveBrowserMode() {
  if (findPanel()) return false;
  const aside = document.querySelector('aside.right-panel');
  if (!aside) return false;
  const target = [...aside.querySelectorAll('button')]
    .find(button => ['工作空间', '工作区'].includes((button.textContent || '').trim()));
  if (!target) return false;
  target.click();
  return true;
}

/** 面板和标签页可能还没渲染出来（收起状态 / 浏览器视图），等它到位再聚焦。 */
function focusWhenReady(options = {}, tries = 0) {
  ensureMounted();
  const ready = activate({ focus: false });
  if (ready) focusInput(options);
  if (ready && document.activeElement === parts?.input) return;
  if (tries < 8) setTimeout(() => focusWhenReady(options, tries + 1), 80);
}

/** 打开「对话地图」标签页并聚焦搜索框：Ctrl+F 与对话头部的放大镜都走这里。 */
function revealDock(options = {}) {
  ensureRightPanelOpen();
  leaveBrowserMode();
  state.folded = false;
  writeFold(false);
  render(true);
  requestAnimationFrame(() => focusWhenReady(options));
}

function mount() {
  if (tab || document.getElementById(TAB_ID)) return;
  parts = buildView();
  view = parts.root;
  tab = buildTab();
  ensureMounted();
  // 面板会在「产物 / 子代理 / 工作区 / 浏览器」之间来回卸载，靠这个定时器把标签页接回去。
  attachTimer = setInterval(() => ensureMounted(), 700);
  window.addEventListener('hg:conversation-map', () => revealDock());
  window.addEventListener('resize', scheduleEnsure);
}

/* ---------------------------------------------------------------- bridge */

const bridge = {
  /** ChatFindBar 每次渲染都会调用：状态 + 动作。 */
  publish(data, api) {
    if (!data) return;
    state.published = data;
    if (api) state.api = api;
    if (data.focusTick !== undefined && data.focusTick !== state.focusTick) {
      const first = state.focusTick === -1;
      state.focusTick = data.focusTick;
      if (!first) revealDock();
    }
    render();
  },
  reveal: revealDock,
  get state() { return state.published; },
};

window.hgConversationMap = bridge;

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
  } else {
    mount();
  }
}
