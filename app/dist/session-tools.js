// 1.4.2: Ctrl+F正文搜索与跳转、会话置顶、会话锁定、一键彻底删除（含全部关联数据）

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

function collectDomMatches(contentRoot, rawQuery, caseSensitive) {
  if (!contentRoot || !rawQuery) return [];
  const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
  if (!needle) return [];
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
        const hay = caseSensitive ? raw : raw.toLowerCase();
        let from = 0;
        while (from <= hay.length - needle.length) {
          const idx = hay.indexOf(needle, from);
          if (idx === -1) break;
          try {
            const range = document.createRange();
            range.setStart(textNode, idx);
            range.setEnd(textNode, idx + rawQuery.length);
            matches.push({
              range,
              messageEl,
              messageId,
              occurrenceInMessage,
            });
            occurrenceInMessage += 1;
          } catch { /* ignore detached node */ }
          from = idx + Math.max(1, needle.length);
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
    return null;
  }

  function highlightSnippet(text, query, caseSensitive) {
    if (!text || !query) return text || '';
    const needle = caseSensitive ? query : query.toLowerCase();
    const hay = caseSensitive ? text : text.toLowerCase();
    const idx = hay.indexOf(needle);
    if (idx === -1) return text;
    return [
      text.slice(0, idx),
      h('mark', { key: 'hit' }, text.slice(idx, idx + query.length)),
      text.slice(idx + query.length),
    ];
  }

  function ChatHeaderFindButton({ open, onToggle }) {
    return h('button', {
      type: 'button',
      className: `icon-button ${open ? 'selected' : ''}`,
      title: '搜索正文关键词 (Ctrl+F)',
      'aria-label': '搜索正文关键词',
      'aria-pressed': Boolean(open),
      onClick: onToggle,
    }, h(SvgIcon, { name: 'search', size: 17 }));
  }

  function ChatHeadingBadges({ session }) {
    if (!session || (!session.pinned && !session.locked)) return null;
    return h('span', { className: 'chat-heading-badges' },
      session.pinned && h('span', { className: 'chat-heading-badge pinned', title: '此对话已置顶' },
        h(SvgIcon, { name: 'pin-filled', size: 11 }), '置顶'
      ),
      session.locked && h('span', { className: 'chat-heading-badge locked', title: '此对话已锁定，防止误删' },
        h(SvgIcon, { name: 'lock', size: 11 }), '已锁定'
      )
    );
  }

  function ChatFindBar({
    open,
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
    const [query, setQuery] = React.useState('');
    const [caseSensitive, setCaseSensitive] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [matchTotal, setMatchTotal] = React.useState(0);
    const [showGlobal, setShowGlobal] = React.useState(false);
    const [globalState, setGlobalState] = React.useState({ loading: false, results: [], totalMatches: 0 });

    const inputRef = React.useRef(null);
    const matchesRef = React.useRef([]);
    const pendingJumpRef = React.useRef(null);

    React.useEffect(() => {
      if (!open) {
        matchesRef.current = [];
        setMatchTotal(0);
        setActiveIndex(0);
        clearCssHighlights(contentContainerRef?.current);
        return;
      }
      if (seedText && typeof seedText === 'string' && seedText.trim()) {
        setQuery(seedText.trim());
      }
      const raf = requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
      return () => cancelAnimationFrame(raf);
    }, [open, focusTick, seedText]);

    // Re-scan current conversation DOM whenever query, caseSensitive, session, or messages change
    React.useEffect(() => {
      if (!open) return;
      const trimmed = query;
      if (!trimmed) {
        matchesRef.current = [];
        setMatchTotal(0);
        setActiveIndex(0);
        clearCssHighlights(contentContainerRef?.current);
        return;
      }
      const timer = requestAnimationFrame(() => {
        const root = contentContainerRef?.current;
        const found = collectDomMatches(root, trimmed, caseSensitive);
        matchesRef.current = found;
        setMatchTotal(found.length);

        let nextIdx = 0;
        const jump = pendingJumpRef.current;
        if (jump && jump.sessionId === activeSessionId && found.length > 0) {
          const targetIdx = found.findIndex(
            m => m.messageId === jump.messageId && m.occurrenceInMessage === (jump.occurrenceInMessage ?? 0)
          );
          const fallbackIdx = targetIdx >= 0 ? targetIdx : found.findIndex(m => m.messageId === jump.messageId);
          nextIdx = fallbackIdx >= 0 ? fallbackIdx : 0;
          pendingJumpRef.current = null;
          setActiveIndex(nextIdx);
          applyDomHighlights(root, found, nextIdx);
          scrollMatchIntoView(found[nextIdx], scrollContainerRef?.current, onStopFollowing);
          return;
        }

        setActiveIndex(prev => {
          const clamped = found.length ? Math.min(prev, found.length - 1) : 0;
          applyDomHighlights(root, found, clamped);
          if (found.length && prev === 0) {
            scrollMatchIntoView(found[clamped], scrollContainerRef?.current, onStopFollowing);
          }
          return clamped;
        });
      });
      return () => cancelAnimationFrame(timer);
    }, [open, query, caseSensitive, activeSessionId, messages]);

    // Clean up highlights on unmount
    React.useEffect(() => () => clearCssHighlights(contentContainerRef?.current), []);

    // Cross-session search via backend
    React.useEffect(() => {
      if (!open) return;
      const q = query.trim();
      if (!q || typeof api.searchSessions !== 'function') {
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
      const found = collectDomMatches(contentContainerRef?.current, query, caseSensitive);
      matchesRef.current = found;
      setMatchTotal(found.length);
      if (!found.length) return;
      const next = ((activeIndex + delta) % found.length + found.length) % found.length;
      setActiveIndex(next);
      applyDomHighlights(contentContainerRef?.current, found, next);
      scrollMatchIntoView(found[next], scrollContainerRef?.current, onStopFollowing);
    };

    const handleJumpToHit = (sessionItem, hit) => {
      if (!sessionItem?.sessionId) return;
      if (sessionItem.sessionId === activeSessionId) {
        const found = collectDomMatches(contentContainerRef?.current, query, caseSensitive);
        matchesRef.current = found;
        setMatchTotal(found.length);
        if (!found.length) return;
        let idx = found.findIndex(
          m => m.messageId === hit.messageId && m.occurrenceInMessage === (hit.occurrenceInMessage ?? 0)
        );
        if (idx < 0) idx = found.findIndex(m => m.messageId === hit.messageId);
        if (idx < 0) idx = 0;
        setActiveIndex(idx);
        applyDomHighlights(contentContainerRef?.current, found, idx);
        scrollMatchIntoView(found[idx], scrollContainerRef?.current, onStopFollowing);
      } else {
        pendingJumpRef.current = {
          sessionId: sessionItem.sessionId,
          messageId: hit.messageId,
          occurrenceInMessage: hit.occurrenceInMessage ?? 0,
        };
        onSelectSession?.(sessionItem.sessionId);
      }
    };

    if (!open) return null;

    const hasQuery = Boolean(query);
    const otherSessionResults = globalState.results.filter(r => r.sessionId !== activeSessionId);
    const shouldShowResults = hasQuery && (showGlobal || (matchTotal === 0 && otherSessionResults.length > 0));

    return h('div', {
      className: 'hg-find-bar',
      role: 'search',
      'aria-label': '正文关键词搜索',
      onKeyDown: e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
          return;
        }
        if (e.key === 'Enter' || e.key === 'F3') {
          e.preventDefault();
          stepMatch(e.shiftKey ? -1 : 1);
          return;
        }
        if (e.key === 'ArrowDown' && !e.altKey) {
          e.preventDefault();
          stepMatch(1);
          return;
        }
        if (e.key === 'ArrowUp' && !e.altKey) {
          e.preventDefault();
          stepMatch(-1);
        }
      },
    },
      h('div', { className: 'hg-find-row' },
        h('div', { className: 'hg-find-input-wrap' },
          h(SvgIcon, { name: 'search', size: 14 }),
          h('input', {
            ref: inputRef,
            type: 'text',
            className: 'hg-find-input',
            value: query,
            onChange: e => { setQuery(e.target.value); setActiveIndex(0); },
            placeholder: '搜索正文关键词，Enter 下一个 / Shift+Enter 上一个…',
            'aria-label': '搜索正文关键词',
          }),
          hasQuery && h('span', {
            className: `hg-find-count ${matchTotal === 0 ? 'no-match' : ''}`,
            'aria-live': 'polite',
          }, matchTotal > 0 ? `${activeIndex + 1} / ${matchTotal}` : '0 / 0')
        ),
        h('div', { className: 'hg-find-controls' },
          h('button', {
            type: 'button',
            className: `hg-find-btn ${caseSensitive ? 'active' : ''}`,
            title: '区分大小写',
            'aria-label': '区分大小写',
            'aria-pressed': caseSensitive,
            onClick: () => setCaseSensitive(v => !v),
          }, 'Aa'),
          h('button', {
            type: 'button',
            className: 'hg-find-btn',
            title: '上一个匹配 (Shift+Enter)',
            'aria-label': '上一个匹配',
            disabled: matchTotal === 0,
            onClick: () => stepMatch(-1),
          }, h(SvgIcon, { name: 'up', size: 15 })),
          h('button', {
            type: 'button',
            className: 'hg-find-btn',
            title: '下一个匹配 (Enter)',
            'aria-label': '下一个匹配',
            disabled: matchTotal === 0,
            onClick: () => stepMatch(1),
          }, h(SvgIcon, { name: 'down', size: 15 })),
          h('button', {
            type: 'button',
            className: `hg-find-btn hg-find-scope-btn ${showGlobal ? 'active' : ''}`,
            title: '在全部会话正文中搜索并跳转',
            'aria-pressed': showGlobal,
            onClick: () => setShowGlobal(v => !v),
          }, `全部对话${hasQuery && globalState.results.length ? ` (${globalState.results.length})` : ''}`),
          h('button', {
            type: 'button',
            className: 'hg-find-btn',
            title: '关闭搜索 (Esc)',
            'aria-label': '关闭搜索',
            onClick: onClose,
          }, h(SvgIcon, { name: 'close', size: 15 }))
        )
      ),
      shouldShowResults && h('div', { className: 'hg-find-results', role: 'listbox', 'aria-label': '跨对话正文搜索结果' },
        h('div', { className: 'hg-find-results-head' },
          h('span', null,
            matchTotal === 0 && !showGlobal
              ? `当前对话无匹配；其他 ${otherSessionResults.length} 个对话包含关键词（点击跳转）：`
              : globalState.loading
                ? '正在搜索全部对话…'
                : globalState.results.length
                  ? `在 ${globalState.results.length} 个对话中找到 ${globalState.totalMatches} 处匹配（点击跳转定位）：`
                  : '全部对话中均未找到匹配内容'
          )
        ),
        (showGlobal ? globalState.results : otherSessionResults).flatMap(sessionItem =>
          (sessionItem.matches || []).slice(0, 5).map((hit, idx) =>
            h('button', {
              key: `${sessionItem.sessionId}-${hit.messageId || 'title'}-${idx}`,
              type: 'button',
              className: `hg-find-result-item ${sessionItem.sessionId === activeSessionId ? 'current' : ''}`,
              onClick: () => handleJumpToHit(sessionItem, hit),
            },
              h('div', { className: 'hg-find-result-top' },
                h('span', null, sessionItem.title || '新对话'),
                sessionItem.sessionId === activeSessionId && h('span', { className: 'hg-find-result-badge' }, '当前对话'),
                h('span', { className: 'hg-find-result-role' },
                  hit.role === 'title' ? '标题' : hit.role === 'user' ? '我的提问' : '助手回复'
                )
              ),
              h('div', { className: 'hg-find-result-snippet' },
                highlightSnippet(hit.snippet || '', query.trim(), caseSensitive)
              )
            )
          )
        )
      )
    );
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
    if (!session?.pinned && !session?.locked) return null;
    return h('span', { className: 'session-status-badges' },
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
