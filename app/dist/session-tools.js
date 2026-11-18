// 1.4.2: Ctrl+F正文搜索与跳转、会话置顶、会话锁定、一键彻底删除（含全部关联数据）
// 1.7.4: “分叉自 …”来源标识（branch 字段由服务端给出），点击可回到父对话。
// 1.8.1: Ctrl+F 面板同时是“对话地图”：没输关键词时按提问列出整段对话（时间 + 回复摘要），
//        点击卡片直接跳到那条消息；输入关键词就用同一份正文匹配结果过滤卡片并高亮。
// 1.8.4: 地图与搜索搬进「工作空间 → 工作区」面板 —— 这里不再渲染浮条，只把状态交给
//        conversation-map.js；Ctrl+F 变成“打开工作区面板并聚焦搜索框”。
import { branchHost } from './branch-ui.js';

export function sortSessions(list) {
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => {
    const ap = Boolean(a?.pinned);
    const bp = Boolean(b?.pinned);
    if (ap !== bp) return bp ? 1 : -1;
    if (ap && bp) {
      const at = String(a?.pinnedAt || a?.updatedAt || a?.createdAt || '');
      const bt = String(b?.pinnedAt || b?.updatedAt || b?.createdAt || '');
      if (bt !== at) return bt.localeCompare(at);
    }
    return new Date(b?.updatedAt || b?.createdAt || 0) - new Date(a?.updatedAt || a?.createdAt || 0);
  });
}

export function mergeSessionIntoList(session, list) {
  const prev = Array.isArray(list) ? list.find(item => item?.id === session?.id) : null;
  const merged = {
    ...session,
    messages: undefined,
    messageCount: Array.isArray(session?.messages) ? session.messages.length : (session?.messageCount ?? prev?.messageCount ?? 0),
    pinned: session?.pinned !== undefined ? Boolean(session.pinned) : Boolean(prev?.pinned),
    pinnedAt: session?.pinnedAt !== undefined ? session.pinnedAt : (prev?.pinnedAt ?? null),
    locked: session?.locked !== undefined ? Boolean(session.locked) : Boolean(prev?.locked),
    lockedAt: session?.lockedAt !== undefined ? session.lockedAt : (prev?.lockedAt ?? null),
  };
  const rest = Array.isArray(list) ? list.filter(item => item?.id !== session?.id) : [];
  return sortSessions([merged, ...rest]);
}

const EXCLUDED_TEXT_ANCESTORS = '.code-toolbar, .user-attachments, .user-skill-tag, .user-bubble-empty, .katex-mathml, button, script, style, svg, [aria-hidden="true"]';

function clearCssHighlights(contentRoot) {
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('hg-find-all');
      CSS.highlights.delete('hg-find-current');
    }
  } catch { /* ignore */ }
  if (contentRoot) {
    for (const el of contentRoot.querySelectorAll('.message[data-find-active="true"]')) {
      el.removeAttribute('data-find-active');
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectDomMatches(contentRoot, rawQuery, caseSensitive) {
  if (!contentRoot || !rawQuery) return [];
  const pattern = escapeRegExp(rawQuery);
  if (!pattern) return [];
  const flags = caseSensitive ? 'g' : 'gi';
  const matches = [];
  const messageEls = contentRoot.querySelectorAll('.message');
  for (const messageEl of messageEls) {
    const messageId = messageEl.getAttribute('data-message-id') || '';
    let occurrenceInMessage = 0;
    const zones = messageEl.querySelectorAll('.user-bubble, .markdown-body, .reasoning-body');
    for (const zone of zones) {
      const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(EXCLUDED_TEXT_ANCESTORS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let textNode;
      while ((textNode = walker.nextNode())) {
        const raw = textNode.nodeValue;
        const re = new RegExp(pattern, flags);
        let match;
        while ((match = re.exec(raw)) !== null) {
          const matchLen = match[0].length;
          if (matchLen === 0) {
            re.lastIndex += 1;
            continue;
          }
          const idx = match.index;
          try {
            const range = document.createRange();
            range.setStart(textNode, idx);
            range.setEnd(textNode, idx + matchLen);
            matches.push({
              range,
              messageEl,
              messageId,
              occurrenceInMessage,
            });
            occurrenceInMessage += 1;
          } catch { /* ignore detached node */ }
        }
      }
    }
  }
  return matches;
}

function applyDomHighlights(contentRoot, matches, activeIndex) {
  if (contentRoot) {
    for (const el of contentRoot.querySelectorAll('.message[data-find-active="true"]')) {
      el.removeAttribute('data-find-active');
    }
  }
  if (!matches.length) {
    clearCssHighlights(contentRoot);
    return;
  }
  const clamped = ((activeIndex % matches.length) + matches.length) % matches.length;
  const active = matches[clamped];
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function') {
      CSS.highlights.set('hg-find-all', new Highlight(...matches.map(m => m.range)));
      if (active?.range) {
        CSS.highlights.set('hg-find-current', new Highlight(active.range));
      } else {
        CSS.highlights.delete('hg-find-current');
      }
    }
  } catch { /* ignore */ }
  if (active?.messageEl) {
    active.messageEl.setAttribute('data-find-active', 'true');
  }
}

function scrollMatchIntoView(match, scroller, onStopFollowing) {
  if (!match) return;
  onStopFollowing?.();
  if (!scroller) {
    match.messageEl?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    return;
  }
  let rect = null;
  try {
    rect = match.range.getBoundingClientRect();
  } catch { rect = null; }
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    rect = match.messageEl?.getBoundingClientRect?.() || null;
  }
  if (!rect) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetTop = scroller.scrollTop + (rect.top - scrollerRect.top) - Math.max(40, (scrollerRect.height - rect.height) * 0.35);
  const clampedTop = Math.max(0, targetTop);
  const distance = Math.abs(clampedTop - scroller.scrollTop);
  scroller.scrollTo({
    top: clampedTop,
    behavior: distance > scrollerRect.height * 2.5 ? 'auto' : 'smooth',
  });
}

function readDockState() {
  if (typeof document === 'undefined') return { hasHost: false, active: false };
  const rightPanel = document.querySelector('aside.right-panel');
  const workspacePanel = document.querySelector('.workspace-tab-panel');
  if (!rightPanel && !workspacePanel) {
    return { hasHost: false, active: false };
  }
  if (rightPanel) {
    if (rightPanel.hidden || rightPanel.style?.display === 'none') {
      return { hasHost: true, active: false };
    }
    try {
      if (typeof getComputedStyle === 'function' && getComputedStyle(rightPanel).display === 'none') {
        return { hasHost: true, active: false };
      }
    } catch { /* ignore */ }
  }
  const active = Boolean(workspacePanel && workspacePanel.classList?.contains('hg-cmap-active'));
  return { hasHost: true, active };
}

/* ---- 1.8.1 对话地图：把 messages 折成“一条提问一张卡片” ---- */

const MAP_QUESTION_CHARS = 96;
const MAP_ANSWER_CHARS = 150;

function mapText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(mapText).filter(Boolean).join(' ');
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

function flattenText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 地图卡片右上角的时间：2026/11/15 11:43（本地时区，和手机上看到的写法一致）。 */
export function formatMapTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一段文字按关键词裁成“命中及其上下文”，返回 {text, start, len}：start 为正文里 mark 的起点，
 * -1 表示这段没有命中（只是摘要）。裁剪永远在命中附近，长回复不会把关键词裁掉。
 */
function mapSnippet(text, query, caseSensitive, max) {
  const flat = flattenText(text);
  if (!flat) return { text: '', start: -1, len: 0 };
  const clip = () => (flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + '…' : flat);
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw) return { text: clip(), start: -1, len: 0 };
  const match = new RegExp(escapeRegExp(raw), caseSensitive ? '' : 'i').exec(flat);
  if (!match || match[0].length === 0) return { text: clip(), start: -1, len: 0 };
  const idx = match.index;
  const hitLen = match[0].length;
  let start = Math.max(0, idx - Math.floor((max - hitLen) / 2));
  let end = Math.min(flat.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  const head = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  return {
    text: head + flat.slice(start, end) + tail,
    start: idx - start + head.length,
    len: hitLen,
  };
}

/**
 * 会话 messages → 地图条目。一条 user 消息开启一张卡片，紧跟的 assistant 消息成为它的回复摘要
 * （没有提问在前面时，assistant 消息自己成为一张“摘要”卡片）。
 */
export function buildConversationMap(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const entries = [];
  let turn = null;
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    const id = message.id != null ? String(message.id) : null;
    const time = message.createdAt ?? message.at ?? null;
    const text = flattenText(mapText(message.text));
    if (message.role === 'user') {
      turn = {
        key: id ?? 'turn-' + entries.length,
        messageId: id,
        time,
        question: text,
        answer: '',
        answerMessageId: null,
        pending: false,
        searchText: text,
      };
      entries.push(turn);
      continue;
    }
    const answerText = text || flattenText(mapText(message.reasoning));
    if (!turn) {
      turn = {
        key: id ?? 'turn-' + entries.length,
        messageId: id,
        time,
        question: '（对话摘要 / 系统消息）',
        answer: answerText,
        answerMessageId: id,
        pending: false,
        searchText: answerText,
      };
      entries.push(turn);
      continue;
    }
    if (!turn.answerMessageId) {
      turn.answerMessageId = id;
      turn.answer = answerText;
      turn.pending = message.status === 'running';
    }
    turn.searchText = turn.searchText ? turn.searchText + '\n' + answerText : answerText;
  }
  return entries.map((entry, index) => ({
    ...entry,
    index,
    question: entry.question || '（附件 / 图片消息）',
  }));
}

/**
 * 关键词过滤 + 命中裁剪。返回 [{entry, question:{text,start,len}, answer:{...}}]，
 * 顺序和地图一致；query 为空时就是整张地图（start 全为 -1）。
 */
export function filterConversationMap(entries, query, caseSensitive = false) {
  const list = Array.isArray(entries) ? entries : [];
  const raw = typeof query === 'string' ? query.trim() : '';
  const matcher = raw ? new RegExp(escapeRegExp(raw), caseSensitive ? '' : 'i') : null;
  const out = [];
  for (const entry of list) {
    if (matcher && !matcher.test(entry.searchText || '')) continue;
    out.push({
      entry,
      question: mapSnippet(entry.question, raw, caseSensitive, MAP_QUESTION_CHARS),
      answer: mapSnippet(entry.answer, raw, caseSensitive, MAP_ANSWER_CHARS),
      filtering: Boolean(matcher),
    });
  }
  return out;
}

/** 地图里哪一条卡片装着这条消息（提问或回复）：给“跳到第 N 个匹配”时同步高亮用。 */
export function mapEntryIndexForMessage(entries, messageId) {
  if (!messageId) return -1;
  const id = String(messageId);
  const list = Array.isArray(entries) ? entries : [];
  return list.findIndex(entry => entry.messageId === id || entry.answerMessageId === id);
}

export function createSessionToolsUI(React, api) {
  const h = React.createElement;

  function SvgIcon({ name, size = 14 }) {
    const common = {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    };
    if (name === 'pin') {
      return h('svg', common,
        h('path', { d: 'M12 17v5' }),
        h('path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z' })
      );
    }
    if (name === 'pin-filled') {
      return h('svg', { ...common, fill: 'currentColor' },
        h('path', { d: 'M12 17v5' }),
        h('path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z' })
      );
    }
    if (name === 'lock') {
      return h('svg', common,
        h('rect', { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }),
        h('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' })
      );
    }
    if (name === 'unlock') {
      return h('svg', common,
        h('rect', { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }),
        h('path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' })
      );
    }
    if (name === 'trash') {
      return h('svg', common,
        h('path', { d: 'M3 6h18' }),
        h('path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }),
        h('path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' })
      );
    }
    if (name === 'search') {
      return h('svg', common,
        h('circle', { cx: 11, cy: 11, r: 8 }),
        h('path', { d: 'm21 21-4.3-4.3' })
      );
    }
    if (name === 'up') {
      return h('svg', common, h('path', { d: 'm18 15-6-6-6 6' }));
    }
    if (name === 'down') {
      return h('svg', common, h('path', { d: 'm6 9 6 6 6-6' }));
    }
    if (name === 'close') {
      return h('svg', common,
        h('path', { d: 'M18 6 6 18' }),
        h('path', { d: 'm6 6 12 12' })
      );
    }
    if (name === 'list') {
      return h('svg', common,
        h('path', { d: 'M8 6h13' }),
        h('path', { d: 'M8 12h13' }),
        h('path', { d: 'M8 18h13' }),
        h('path', { d: 'M3.5 6h.01' }),
        h('path', { d: 'M3.5 12h.01' }),
        h('path', { d: 'M3.5 18h.01' })
      );
    }
    if (name === 'sparkle') {
      return h('svg', common,
        h('path', { d: 'M12 4.5 13.6 9 18 10.6 13.6 12.2 12 16.7 10.4 12.2 6 10.6 10.4 9z' }),
        h('path', { d: 'M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z' })
      );
    }
    if (name === 'fork') {
      return h('svg', common,
        h('path', { d: 'M6 18 18 6' }),
        h('path', { d: 'M18 11.5V6h-5.5' }),
        h('path', { d: 'M6 12.5V18h5.5' })
      );
    }
    return null;
  }

  function highlightSnippet(text, query, caseSensitive) {
    if (!text || !query) return text || '';
    const match = new RegExp(escapeRegExp(query), caseSensitive ? '' : 'i').exec(text);
    if (!match || match[0].length === 0) return text;
    const idx = match.index;
    const hitLen = match[0].length;
    return [
      text.slice(0, idx),
      h('mark', { key: 'hit' }, text.slice(idx, idx + hitLen)),
      text.slice(idx + hitLen),
    ];
  }

  function renderMapHit(segment) {
    if (!segment || !segment.text) return null;
    if (segment.start < 0) return segment.text;
    return [
      segment.text.slice(0, segment.start),
      h('mark', { key: 'hit' }, segment.text.slice(segment.start, segment.start + segment.len)),
      segment.text.slice(segment.start + segment.len),
    ];
  }

  /** 搜索行下面的对话地图：一条提问一张卡片，和手机上的“搜索消息”列表同一个样子。 */
  function ChatMessageMap({ items, cursor, filtering, hasMessages, onJump, onCollapse }) {
    const listRef = React.useRef(null);

    // 键盘走过的卡片要跟着滚，但只滚地图自己，别惊动下面的会话正文。
    React.useEffect(() => {
      const list = listRef.current;
      const card = list?.children?.[cursor];
      if (!list || !card) return;
      const box = list.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      if (rect.top < box.top) list.scrollTop -= box.top - rect.top;
      else if (rect.bottom > box.bottom) list.scrollTop += rect.bottom - box.bottom;
    }, [cursor, items.length]);

    return h('div', { className: 'hg-map', role: 'group', 'aria-label': '对话地图' },
      h('div', { className: 'hg-map-head' },
        h('span', { className: 'hg-map-heading' },
          h(SvgIcon, { name: 'list', size: 13 }),
          h('span', null, '对话地图')
        ),
        h('span', { className: 'hg-map-count' }, filtering ? `匹配 ${items.length} 条` : `共 ${items.length} 条`),
        h('span', { className: 'hg-map-hint' },
          filtering ? '点击卡片跳到命中处' : '点击卡片跳转 · ↑↓ 选择 · Enter 打开'
        ),
        h('button', {
          type: 'button',
          className: 'hg-map-close',
          title: '收起对话地图',
          'aria-label': '收起对话地图',
          onClick: onCollapse,
        }, h(SvgIcon, { name: 'close', size: 12 }))
      ),
      items.length === 0
        ? h('div', { className: 'hg-map-empty' },
            hasMessages ? '没有匹配的消息，换个关键词试试。' : '这个对话还没有消息，提问后地图会自动生成。'
          )
        : h('div', { className: 'hg-map-list', ref: listRef, role: 'list' },
            items.map((item, index) => {
              const entry = item.entry;
              const active = index === cursor;
              const answerText = item.answer.text || (entry.pending ? '正在回复…' : '');
              return h('button', {
                key: entry.key,
                type: 'button',
                role: 'listitem',
                className: 'hg-map-card' + (active ? ' is-current' : ''),
                'aria-current': active ? 'true' : undefined,
                title: entry.question + '（点击跳到这条消息）',
                onClick: () => onJump(item, index),
              },
                h('div', { className: 'hg-map-card-top' },
                  h('span', { className: 'hg-map-card-question' }, renderMapHit(item.question)),
                  entry.time ? h('span', { className: 'hg-map-card-time' }, formatMapTime(entry.time)) : null
                ),
                answerText ? h('div', { className: 'hg-map-card-answer' },
                  h(SvgIcon, { name: 'sparkle', size: 12 }),
                  h('span', { className: 'hg-map-card-preview' },
                    item.answer.text ? renderMapHit(item.answer) : answerText
                  )
                ) : null
              );
            })
          )
    );
  }

  function ChatHeaderFindButton({ open, onToggle }) {
    return h('button', {
      type: 'button',
      className: `icon-button ${open ? 'selected' : ''}`,
      title: '搜索消息 / 对话地图 (Ctrl+F)',
      'aria-label': '搜索消息与对话地图',
      'aria-pressed': Boolean(open),
      onClick: () => {
      onToggle?.();
      // 1.8.4: 真正的地图在工作区面板里，按钮只负责把那边叫出来。
      window.dispatchEvent(new CustomEvent('hg:conversation-map'));
    },
    }, h(SvgIcon, { name: 'search', size: 17 }));
  }

  /** A branched conversation says where it came from; the parent is one click away. */
  function BranchOriginBadge({ branch, compact = false }) {
    if (!branch?.parentSessionId) return null;
    const parentTitle = branch.parentTitle?.trim() || '父对话';
    const label = compact ? null : `分叉自「${parentTitle}」`;
    const jump = event => {
      event.stopPropagation();
      branchHost().openSession?.(branch.parentSessionId);
    };
    return h('button', {
      type: 'button',
      className: `hg-branch-badge${compact ? ' compact' : ''}`,
      title: `分叉自「${parentTitle}」，点击打开父对话`,
      'aria-label': `分叉自「${parentTitle}」`,
      onClick: jump,
    },
      h(SvgIcon, { name: 'fork', size: 11 }),
      label && h('span', null, label)
    );
  }

  function ChatHeadingBadges({ session }) {
    const branch = session?.branch?.parentSessionId ? session.branch : null;
    if (!session || (!session.pinned && !session.locked && !branch)) return null;
    return h('span', { className: 'chat-heading-badges' },
      branch && h(BranchOriginBadge, {
        branch,
        // 标题里已经写着“分叉自「X」”时只留图标，图标带完整提示。
        compact: String(session.title ?? '').includes(branch.parentTitle ?? '\u0000'),
      }),
      session.pinned && h('span', { className: 'chat-heading-badge pinned', title: '此对话已置顶' },
        h(SvgIcon, { name: 'pin-filled', size: 11 }), '置顶'
      ),
      session.locked && h('span', { className: 'chat-heading-badge locked', title: '此对话已锁定，防止误删' },
        h(SvgIcon, { name: 'lock', size: 11 }), '已锁定'
      )
    );
  }

  function ChatFindBar({
    open: openProp,
    focusTick,
    seedText,
    onClose,
    activeSessionId,
    messages,
    scrollContainerRef,
    contentContainerRef,
    onStopFollowing,
    onSelectSession,
  }) {
    const [dockState, setDockState] = React.useState(() => readDockState());
    const [openingGrace, setOpeningGrace] = React.useState(false);
    const open = dockState.hasHost ? (dockState.active || openingGrace) : Boolean(openProp);

    const [query, setQuery] = React.useState('');
    const [caseSensitive, setCaseSensitive] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [matchTotal, setMatchTotal] = React.useState(0);
    const [searchIntentRev, setSearchIntentRev] = React.useState(0);
    const [showGlobal, setShowGlobal] = React.useState(false);
    const [globalState, setGlobalState] = React.useState({ loading: false, results: [], totalMatches: 0 });
    const [mapOpen, setMapOpen] = React.useState(true);
    const [mapCursor, setMapCursor] = React.useState(0);
    const jumpGuardRef = React.useRef(0);
    const mapEntries = React.useMemo(() => buildConversationMap(messages), [messages]);
    const mapItems = React.useMemo(
      () => filterConversationMap(mapEntries, query, caseSensitive),
      [mapEntries, query, caseSensitive]
    );

    const inputRef = React.useRef(null);
    const matchesRef = React.useRef([]);
    const activeIndexRef = React.useRef(0);
    activeIndexRef.current = activeIndex;
    const queryRef = React.useRef(query);
    queryRef.current = query;
    const pendingJumpRef = React.useRef(null);
    const shouldScrollRef = React.useRef(false);
    const prevSessionIdRef = React.useRef(activeSessionId);
    const prevOpenRef = React.useRef(open);
    const prevOpenPropRef = React.useRef(Boolean(openProp));
    const prevFocusTickRef = React.useRef(focusTick);
    const lastSeedTickRef = React.useRef(
      !open && (!focusTick || focusTick === 0) && !(typeof seedText === 'string' && seedText.trim()) ? (focusTick ?? 0) : -1
    );
    const graceTimerRef = React.useRef(0);
    const dockObserverRef = React.useRef(null);
    const dockObservedNodeRef = React.useRef(null);

    const clearSearchState = React.useCallback((options = {}) => {
      const { keepQuery = false } = options;
      matchesRef.current = [];
      activeIndexRef.current = 0;
      shouldScrollRef.current = false;
      setMatchTotal(0);
      setActiveIndex(0);
      if (!keepQuery) {
        queryRef.current = '';
        pendingJumpRef.current = null;
        setQuery('');
        setShowGlobal(false);
        setGlobalState({ loading: false, results: [], totalMatches: 0 });
      }
      clearCssHighlights(contentContainerRef?.current);
    }, [contentContainerRef]);

    const syncDock = React.useCallback(() => {
      if (typeof document === 'undefined') return { hasHost: false, active: false };
      const target = document.querySelector('aside.right-panel') || document.querySelector('.workspace-tab-panel');
      if (target && target !== dockObservedNodeRef.current && typeof MutationObserver === 'function') {
        dockObserverRef.current?.disconnect?.();
        const observer = new MutationObserver(() => {
          const next = readDockState();
          setDockState(prev => (prev.hasHost === next.hasHost && prev.active === next.active ? prev : next));
          if (next.active) {
            if (graceTimerRef.current) {
              clearTimeout(graceTimerRef.current);
              graceTimerRef.current = 0;
            }
            setOpeningGrace(false);
          }
        });
        observer.observe(target, {
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden'],
          childList: true,
          subtree: true,
        });
        dockObserverRef.current = observer;
        dockObservedNodeRef.current = target;
      }
      const next = readDockState();
      setDockState(prev => (prev.hasHost === next.hasHost && prev.active === next.active ? prev : next));
      if (next.active) {
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = 0;
        }
        setOpeningGrace(false);
      }
      return next;
    }, []);

    const startOpeningGrace = React.useCallback(() => {
      const current = syncDock();
      if (!current.hasHost || current.active) return;
      setOpeningGrace(true);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = 0;
        setOpeningGrace(false);
      }, 800);
    }, [syncDock]);

    // Observe the right-panel / conversation-map tab visibility so `open` reflects actual UI state.
    React.useEffect(() => {
      syncDock();
      const onRevealEvent = () => startOpeningGrace();
      if (typeof window !== 'undefined') {
        window.addEventListener('hg:conversation-map', onRevealEvent);
      }
      return () => {
        dockObserverRef.current?.disconnect?.();
        dockObserverRef.current = null;
        dockObservedNodeRef.current = null;
        if (typeof window !== 'undefined') {
          window.removeEventListener('hg:conversation-map', onRevealEvent);
        }
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = 0;
        }
      };
    }, [syncDock, startOpeningGrace]);

    // Coordinate parent openProp / focusTick transitions (Ctrl+F open & Escape close)
    React.useEffect(() => {
      const wasOpenProp = prevOpenPropRef.current;
      const nowOpenProp = Boolean(openProp);
      const tickChanged = focusTick !== prevFocusTickRef.current;
      prevOpenPropRef.current = nowOpenProp;
      prevFocusTickRef.current = focusTick;

      if ((!wasOpenProp && nowOpenProp) || (tickChanged && nowOpenProp)) {
        startOpeningGrace();
        return;
      }
      if (wasOpenProp && !nowOpenProp) {
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = 0;
        }
        setOpeningGrace(false);
        clearSearchState();
      }
    }, [openProp, focusTick, startOpeningGrace, clearSearchState]);

    // Clear highlights and reset search state when the find panel closes
    React.useEffect(() => {
      const wasOpen = prevOpenRef.current;
      prevOpenRef.current = open;
      if (wasOpen && !open) {
        clearSearchState();
        if (openProp) onClose?.();
      }
    }, [open, openProp, onClose, clearSearchState]);

    // Session isolation: clear highlights and reset search state on activeSessionId switch
    React.useEffect(() => {
      if (prevSessionIdRef.current === activeSessionId) return;
      prevSessionIdRef.current = activeSessionId;
      const isCrossSessionJump = Boolean(
        pendingJumpRef.current && pendingJumpRef.current.sessionId === activeSessionId
      );
      clearSearchState({ keepQuery: isCrossSessionJump });
      if (!isCrossSessionJump) {
        setMapCursor(0);
      }
    }, [activeSessionId, clearSearchState]);

    const syncMapCursorToMessage = messageId => {
      const index = mapEntryIndexForMessage(mapEntries, messageId);
      if (index < 0) return;
      const visible = mapItems.findIndex(item => item.entry.index === index);
      setMapCursor(visible >= 0 ? visible : index);
    };

    React.useEffect(() => {
      if (!open) {
        matchesRef.current = [];
        activeIndexRef.current = 0;
        shouldScrollRef.current = false;
        setMatchTotal(0);
        setActiveIndex(0);
        clearCssHighlights(contentContainerRef?.current);
        return;
      }
      if (focusTick !== lastSeedTickRef.current) {
        lastSeedTickRef.current = focusTick;
        if (seedText && typeof seedText === 'string' && seedText.trim()) {
          const nextSeed = seedText.trim();
          queryRef.current = nextSeed;
          shouldScrollRef.current = true;
          activeIndexRef.current = 0;
          setQuery(nextSeed);
          setActiveIndex(0);
          setMapCursor(0);
          setSearchIntentRev(v => v + 1);
        }
      }
      const raf = requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
      return () => cancelAnimationFrame(raf);
    }, [open, focusTick, seedText]);

    // Re-scan current conversation DOM when open and query is non-empty.
    // Streaming `messages` updates only refresh highlights & clamped index, NEVER hijacking scroll.
    React.useEffect(() => {
      const trimmed = (queryRef.current || '').trim();
      if (!open || !trimmed) {
        shouldScrollRef.current = false;
        if (matchesRef.current.length > 0) {
          matchesRef.current = [];
        }
        setMatchTotal(0);
        setActiveIndex(0);
        activeIndexRef.current = 0;
        clearCssHighlights(contentContainerRef?.current);
        return;
      }
      const timer = requestAnimationFrame(() => {
        const root = contentContainerRef?.current;
        const found = collectDomMatches(root, trimmed, caseSensitive);
        matchesRef.current = found;
        setMatchTotal(found.length);

        const jump = pendingJumpRef.current;
        if (jump && jump.sessionId === activeSessionId && found.length > 0) {
          const targetIdx = found.findIndex(
            m => m.messageId === jump.messageId && m.occurrenceInMessage === (jump.occurrenceInMessage ?? 0)
          );
          const fallbackIdx = targetIdx >= 0 ? targetIdx : found.findIndex(m => m.messageId === jump.messageId);
          const nextIdx = fallbackIdx >= 0 ? fallbackIdx : 0;
          pendingJumpRef.current = null;
          shouldScrollRef.current = false;
          activeIndexRef.current = nextIdx;
          setActiveIndex(nextIdx);
          applyDomHighlights(root, found, nextIdx);
          scrollMatchIntoView(found[nextIdx], scrollContainerRef?.current, onStopFollowing);
          syncMapCursorToMessage(found[nextIdx]?.messageId);
          return;
        }

        const shouldScroll = shouldScrollRef.current;
        shouldScrollRef.current = false;
        const prev = activeIndexRef.current;
        const clamped = found.length ? Math.min(Math.max(0, prev), found.length - 1) : 0;
        activeIndexRef.current = clamped;
        setActiveIndex(clamped);
        applyDomHighlights(root, found, clamped);
        if (shouldScroll && found.length > 0) {
          scrollMatchIntoView(found[clamped], scrollContainerRef?.current, onStopFollowing);
          syncMapCursorToMessage(found[clamped]?.messageId);
        }
      });
      return () => cancelAnimationFrame(timer);
    }, [open, query, caseSensitive, searchIntentRev, activeSessionId, messages]);

    // Clean up highlights and transient refs on unmount
    React.useEffect(() => () => {
      matchesRef.current = [];
      pendingJumpRef.current = null;
      shouldScrollRef.current = false;
      clearCssHighlights(contentContainerRef?.current);
    }, []);

    // Cross-session search via backend
    React.useEffect(() => {
      const q = (queryRef.current || '').trim();
      if (!open || !q || typeof api.searchSessions !== 'function') {
        setGlobalState({ loading: false, results: [], totalMatches: 0 });
        return;
      }
      let alive = true;
      setGlobalState(s => ({ ...s, loading: true }));
      const timer = setTimeout(async () => {
        try {
          const data = await api.searchSessions(q, caseSensitive);
          if (!alive) return;
          const results = Array.isArray(data?.results) ? data.results : [];
          const totalMatches = results.reduce((sum, item) => sum + (item.matchCount || 0), 0);
          setGlobalState({ loading: false, results, totalMatches });
        } catch {
          if (alive) setGlobalState({ loading: false, results: [], totalMatches: 0 });
        }
      }, 150);
      return () => { alive = false; clearTimeout(timer); };
    }, [open, query, caseSensitive]);

    const stepMatch = delta => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const found = collectDomMatches(contentContainerRef?.current, trimmed, caseSensitive);
      matchesRef.current = found;
      setMatchTotal(found.length);
      if (!found.length) return;
      const current = activeIndexRef.current;
      const next = ((current + delta) % found.length + found.length) % found.length;
      activeIndexRef.current = next;
      setActiveIndex(next);
      applyDomHighlights(contentContainerRef?.current, found, next);
      scrollMatchIntoView(found[next], scrollContainerRef?.current, onStopFollowing);
      syncMapCursorToMessage(found[next]?.messageId);
    };

    /** 把会话正文滚到某条消息，并给它加上和 Ctrl+F 一样的当前命中描边。 */
    const revealMessage = messageId => {
      const root = contentContainerRef?.current;
      if (!root || !messageId) return;
      jumpGuardRef.current = Date.now() + 700;
      const id = String(messageId);
      let target = null;
      try {
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
        target = root.querySelector(`.message[data-message-id="${escaped}"]`);
      } catch { target = null; }
      if (!target) return;
      for (const stale of root.querySelectorAll('.message[data-find-active="true"]')) stale.removeAttribute('data-find-active');
      target.setAttribute('data-find-active', 'true');
      scrollMatchIntoView({ messageEl: target, range: null, messageId: id }, scrollContainerRef?.current, onStopFollowing);
    };

    const jumpToMapItem = (item, index) => {
      if (!item) return;
      setMapCursor(typeof index === 'number' ? index : item.entry.index);
      const entry = item.entry;
      const found = matchesRef.current;
      if (query.trim() && found.length) {
        const hitIndex = found.findIndex(
          match => match.messageId === entry.messageId || match.messageId === entry.answerMessageId
        );
        if (hitIndex >= 0) {
          jumpGuardRef.current = Date.now() + 700;
          activeIndexRef.current = hitIndex;
          setActiveIndex(hitIndex);
          applyDomHighlights(contentContainerRef?.current, found, hitIndex);
          scrollMatchIntoView(found[hitIndex], scrollContainerRef?.current, onStopFollowing);
          return;
        }
      }
      revealMessage(entry.messageId || entry.answerMessageId);
    };

    const moveMapCursor = delta => {
      if (!mapItems.length) return;
      setMapCursor(prev => (prev + delta + mapItems.length) % mapItems.length);
    };

    // 打开搜索面板：从最后一条（读者通常就在底部）开始；带关键词打开则停在第 1 条命中。
    React.useEffect(() => {
      if (!open) return;
      const hasQuery = Boolean((queryRef.current || '').trim());
      setMapCursor(hasQuery ? 0 : Math.max(0, mapItems.length - 1));
    }, [open, focusTick]);

    // 没在搜索时，地图跟着阅读位置走：当前看到的那个回合始终是亮的。
    React.useEffect(() => {
      if (!open || !mapOpen || query.trim()) return;
      const scroller = scrollContainerRef?.current;
      const root = contentContainerRef?.current;
      if (!scroller || !root) return;
      let frame = 0;
      const sync = () => {
        frame = 0;
        // 跳转的平滑滚动还在进行时别改高亮，否则会把刚选中的卡片拽回上一个位置。
        if (Date.now() < jumpGuardRef.current) return;
        const line = scroller.getBoundingClientRect().top + Math.min(140, scroller.clientHeight * 0.4);
        // 停在底部时（读者就在最新那一轮），当前回合就是最后一条：阈值别把高亮推回上一轮。
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 32;
        let index = atBottom && mapEntries.length ? mapEntries.length - 1 : -1;
        for (const node of atBottom ? [] : root.querySelectorAll('.message[data-message-id]')) {
          if (node.getBoundingClientRect().bottom < line) continue;
          const found = mapEntryIndexForMessage(mapEntries, node.getAttribute('data-message-id'));
          if (found >= 0) { index = found; break; }
        }
        try {
          const log = (window.__hgMapSync = window.__hgMapSync || []);
          log.push({
            index, atBottom, top: Math.round(scroller.scrollTop),
            gap: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
            line: Math.round(line), t: Date.now(),
          });
          if (log.length > 64) log.splice(0, log.length - 32);
        } catch { /* debug */ }
        if (index >= 0) setMapCursor(prev => (prev === index ? prev : index));
      };
      const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
      scroller.addEventListener('scroll', onScroll, { passive: true });
      // 插入面板会改变正文的可视高度，app 自己还会把正文重新贴到底部（有时靠滚动锚定），
      // 所以既观察尺寸，也在打开后补两次判断，保证“当前回合”落在读者真正看到的那一条。
      const boots = [260, 700, 1400].map(ms => setTimeout(sync, ms));
      const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : null;
      if (watcher) { watcher.observe(scroller); watcher.observe(root); }
      return () => {
        for (const id of boots) clearTimeout(id);
        if (watcher) watcher.disconnect();
        scroller.removeEventListener('scroll', onScroll);
        if (frame) cancelAnimationFrame(frame);
      };
    }, [open, mapOpen, query, mapEntries, messages]);

    const handleJumpToHit = (sessionItem, hit) => {
      if (!sessionItem?.sessionId) return;
      const trimmed = query.trim();
      if (sessionItem.sessionId === activeSessionId) {
        const found = collectDomMatches(contentContainerRef?.current, trimmed, caseSensitive);
        matchesRef.current = found;
        setMatchTotal(found.length);
        if (!found.length) return;
        let idx = found.findIndex(
          m => m.messageId === hit.messageId && m.occurrenceInMessage === (jumpOccurrence(hit))
        );
        if (idx < 0) idx = found.findIndex(m => m.messageId === hit.messageId);
        if (idx < 0) idx = 0;
        activeIndexRef.current = idx;
        setActiveIndex(idx);
        applyDomHighlights(contentContainerRef?.current, found, idx);
        scrollMatchIntoView(found[idx], scrollContainerRef?.current, onStopFollowing);
        syncMapCursorToMessage(found[idx]?.messageId);
      } else {
        pendingJumpRef.current = {
          sessionId: sessionItem.sessionId,
          messageId: hit.messageId,
          occurrenceInMessage: hit.occurrenceInMessage ?? 0,
        };
        onSelectSession?.(sessionItem.sessionId);
      }
    };

    function jumpOccurrence(hit) {
      return hit?.occurrenceInMessage ?? 0;
    }

    // 1.8.4: 地图与搜索框由 conversation-map.js 渲染在「工作空间 → 工作区」面板里，
    // 这里只把“状态 + 动作”发出去。业务逻辑（消息折卡、命中裁剪、滚动定位、跨会话
    // 搜索）仍然只有这一份，工作区那边不重算任何东西。
    React.useEffect(() => {
      const bridge = typeof window !== 'undefined' ? window.hgConversationMap : null;
      if (!bridge || typeof bridge.publish !== 'function') return;
      bridge.publish({
        open,
        focusTick,
        query,
        caseSensitive,
        matchTotal,
        activeIndex,
        mapCursor,
        mapOpen,
        items: mapItems,
        hasMessages: mapEntries.length > 0,
        globalState,
        showGlobal,
        activeSessionId,
      }, {
        setQuery: value => {
          const next = String(value ?? '');
          const nextTrimmed = next.trim();
          syncDock();
          queryRef.current = next;
          shouldScrollRef.current = Boolean(nextTrimmed);
          activeIndexRef.current = 0;
          setQuery(next);
          setActiveIndex(0);
          setMapCursor(0);
          if (nextTrimmed) {
            setSearchIntentRev(v => v + 1);
          } else {
            matchesRef.current = [];
            setMatchTotal(0);
            clearCssHighlights(contentContainerRef?.current);
          }
        },
        toggleCase: () => {
          syncDock();
          if ((queryRef.current || '').trim()) {
            shouldScrollRef.current = true;
            activeIndexRef.current = 0;
            setActiveIndex(0);
            setSearchIntentRev(v => v + 1);
          }
          setCaseSensitive(v => !v);
        },
        step: delta => stepMatch(delta),
        moveCursor: delta => moveMapCursor(delta),
        jumpToItem: index => jumpToMapItem(mapItems[index], index),
        setShowGlobal: value => setShowGlobal(value),
        setMapOpen: value => setMapOpen(value),
        close: () => {
          clearSearchState();
          onClose?.();
        },
        jumpToHit: (sessionItem, hit) => handleJumpToHit(sessionItem, hit),
      });
    });

    return null;
  }

  function SidebarListHeader({ searching, filteredCount, totalCount, unlockedCount, disabled, onRequestBulkDelete }) {
    return h('div', { className: 'session-list-label' },
      h('div', { className: 'session-list-label-left' },
        h('span', null, searching ? '搜索结果' : '最近对话'),
        filteredCount > 0 && h('span', { className: 'session-list-count' }, filteredCount)
      ),
      totalCount > 0 && h('button', {
        type: 'button',
        className: 'session-clear-all-btn',
        disabled: Boolean(disabled),
        title: unlockedCount > 0
          ? `一键删除全部未锁定对话及其会话数据（可清理 ${unlockedCount} 个）`
          : '全部对话均已锁定，无法一键删除',
        'aria-label': '一键删除未锁定对话',
        onClick: onRequestBulkDelete,
      },
        h(SvgIcon, { name: 'trash', size: 12 }),
        h('span', null, '一键删除')
      )
    );
  }

  function SessionStatusBadges({ session }) {
    const branch = session?.branch?.parentSessionId ? session.branch : null;
    if (!session?.pinned && !session?.locked && !branch) return null;
    return h('span', { className: 'session-status-badges' },
      branch && h(BranchOriginBadge, { branch, compact: true }),
      session.pinned && h('span', { className: 'session-badge-icon pinned', title: '已置顶' },
        h(SvgIcon, { name: 'pin-filled', size: 12 })
      ),
      session.locked && h('span', { className: 'session-badge-icon locked', title: '已锁定（防删保护）' },
        h(SvgIcon, { name: 'lock', size: 12 })
      )
    );
  }

  function SessionRowActions({ session, title, onTogglePin, onToggleLock, onDeleteClick }) {
    const pinned = Boolean(session?.pinned);
    const locked = Boolean(session?.locked);
    return h('div', { className: 'session-actions', onClick: e => e.stopPropagation() },
      h('button', {
        type: 'button',
        className: `session-action-btn pin-btn ${pinned ? 'is-active' : ''}`,
        title: pinned ? '取消置顶' : '置顶对话',
        'aria-label': `${pinned ? '取消置顶' : '置顶'} ${title}`,
        'aria-pressed': pinned,
        onClick: e => { e.stopPropagation(); onTogglePin?.(session); },
      }, h(SvgIcon, { name: pinned ? 'pin-filled' : 'pin', size: 13 })),
      h('button', {
        type: 'button',
        className: `session-action-btn lock-btn ${locked ? 'is-active' : ''}`,
        title: locked ? '解锁对话（解锁后可删除）' : '锁定对话（防止删除与一键清理）',
        'aria-label': `${locked ? '解锁' : '锁定'} ${title}`,
        'aria-pressed': locked,
        onClick: e => { e.stopPropagation(); onToggleLock?.(session); },
      }, h(SvgIcon, { name: locked ? 'lock' : 'unlock', size: 13 })),
      h('button', {
        type: 'button',
        className: `session-action-btn delete-btn ${locked ? 'is-locked-disabled' : ''}`,
        title: locked ? '此对话已锁定，请先解锁后再删除' : '删除对话及会话数据（Shift+点击可直接删除）',
        'aria-label': `删除对话 ${title}`,
        onClick: e => { e.stopPropagation(); onDeleteClick?.(session, e); },
      }, h(SvgIcon, { name: 'trash', size: 13 }))
    );
  }

  function SessionDeleteModal({
    target,
    sessions,
    runningMap,
    busy,
    onCancel,
    onConfirmSingle,
    onConfirmBulk,
  }) {
    const [keepPinned, setKeepPinned] = React.useState(false);

    React.useEffect(() => {
      setKeepPinned(false);
    }, [target]);

    if (!target) return null;

    if (target.mode === 'bulk') {
      const all = Array.isArray(sessions) ? sessions : [];
      const lockedList = all.filter(s => s.locked);
      const unlockedPinned = all.filter(s => !s.locked && s.pinned);
      const victims = all.filter(s => !s.locked && !(keepPinned && s.pinned));
      const runningCount = victims.filter(s => runningMap?.[s.id]).length;

      return h('div', {
        className: 'modal-backdrop confirm-backdrop',
        onMouseDown: e => { if (e.target === e.currentTarget && !busy) onCancel?.(); },
      },
        h('section', {
          className: 'confirm-dialog',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': 'delete-title',
        },
          h('span', { className: 'confirm-icon' }, h(SvgIcon, { name: 'trash', size: 22 })),
          h('h2', { id: 'delete-title' }, '一键删除对话及数据？'),
          h('p', null,
            victims.length > 0
              ? `将彻底删除 ${victims.length} 个未锁定对话，连同它们的聊天记录、会话专属工作目录文件、上传附件与生成图片一并清除，不可恢复。`
              : '当前没有符合删除条件的对话。',
            runningCount > 0 ? ` 其中 ${runningCount} 个正在运行的任务也会先停止。` : ''
          ),
          (lockedList.length > 0 || unlockedPinned.length > 0) && h('div', { className: 'hg-delete-meta' },
            lockedList.length > 0 && h('div', { className: 'hg-delete-meta-note' },
              h(SvgIcon, { name: 'lock', size: 13 }),
              h('span', null, `已锁定的 ${lockedList.length} 个对话将自动保护保留`)
            ),
            unlockedPinned.length > 0 && h('label', { className: 'hg-delete-checkbox' },
              h('input', {
                type: 'checkbox',
                checked: keepPinned,
                disabled: busy,
                onChange: e => setKeepPinned(e.target.checked),
              }),
              h('span', null, `同时保留已置顶的对话（${unlockedPinned.length} 个）`)
            )
          ),
          h('div', null,
            h('button', {
              type: 'button',
              className: 'button button-quiet',
              disabled: busy,
              onClick: onCancel,
            }, '取消'),
            h('button', {
              type: 'button',
              className: 'button button-danger',
              disabled: busy || victims.length === 0,
              onClick: () => onConfirmBulk?.({ includePinned: !keepPinned }),
            },
              h(SvgIcon, { name: 'trash', size: 14 }),
              busy ? '正在清理…' : `确认一键删除 (${victims.length})`
            )
          )
        )
      );
    }

    const session = target;
    const title = session.title?.trim() || '新对话';
    const isRunning = Boolean(runningMap?.[session.id]);

    return h('div', {
      className: 'modal-backdrop confirm-backdrop',
      onMouseDown: e => { if (e.target === e.currentTarget && !busy) onCancel?.(); },
    },
      h('section', {
        className: 'confirm-dialog',
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'delete-title',
      },
        h('span', { className: 'confirm-icon' }, h(SvgIcon, { name: 'trash', size: 22 })),
        h('h2', { id: 'delete-title' }, '彻底删除这段对话？'),
        h('p', null,
          `“${title}”及其所有关联数据（聊天记录、本会话工作目录文件、上传附件与生成图片）将被永久删除，不可恢复。`,
          isRunning ? ' 正在进行的任务也会停止。' : ''
        ),
        h('div', null,
          h('button', {
            type: 'button',
            className: 'button button-quiet',
            disabled: busy,
            onClick: onCancel,
          }, '保留对话'),
          h('button', {
            type: 'button',
            className: 'button button-danger',
            disabled: busy,
            onClick: () => onConfirmSingle?.(session),
          },
            h(SvgIcon, { name: 'trash', size: 14 }),
            busy ? '正在删除…' : '确认彻底删除'
          )
        )
      )
    );
  }

  return {
    ChatHeaderFindButton,
    ChatHeadingBadges,
    ChatFindBar,
    SidebarListHeader,
    SessionStatusBadges,
    SessionRowActions,
    SessionDeleteModal,
  };
}
