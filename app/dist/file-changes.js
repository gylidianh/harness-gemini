// 1.4.5 / 1.4.7: "文件改动" — the files the agent changed in this conversation, shown above the images in
// the 产物 tab. Each turn can be reverted (and re-applied) as a whole or file by file, and each
// file opens an inline diff. Can be disabled in Settings -> 工作区 (fileChangesEnabled: false).
// The layout follows ZCode's MessageChangeSummaryPanel (a collapsible "N 个文件已更改 +x -y" card
// with a 撤销 action and per-file 审查 rows); ZCode is Copyright 2026 Z.AI Co., Ltd, Apache License 2.0,
// see THIRD-PARTY-NOTICES.md.

const KIND_LABEL = { created: '新建', modified: '修改', downloaded: '下载' };

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch {
    throw new Error('暂时无法连接本地服务。');
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new Error((body && (body.error || body.message)) || `请求未完成（${response.status}）`);
  return body;
}

const base = sessionId => `/api/sessions/${encodeURIComponent(sessionId)}/file-changes`;

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function folderOf(relative) {
  const clean = String(relative || '').replace(/\\/g, '/');
  const index = clean.lastIndexOf('/');
  return index > 0 ? clean.slice(0, index) : '';
}

export function createFileChangesUI(React) {
  const h = React.createElement;

  function Icon({ name, size = 14 }) {
    const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
    if (name === 'chevron') return h('svg', common, h('path', { d: 'm9 18 6-6-6-6' }));
    if (name === 'undo') return h('svg', common, h('path', { d: 'M9 14 4 9l5-5' }), h('path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11' }));
    if (name === 'redo') return h('svg', common, h('path', { d: 'm15 14 5-5-5-5' }), h('path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13' }));
    if (name === 'refresh') return h('svg', common, h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }), h('path', { d: 'M21 3v5h-5' }), h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }), h('path', { d: 'M8 16H3v5' }));
    if (name === 'diff') return h('svg', common, h('path', { d: 'M12 3v14' }), h('path', { d: 'M5 10h14' }), h('path', { d: 'M5 21h14' }));
    if (name === 'file') return h('svg', common, h('path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }), h('path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }));
    if (name === 'changes') return h('svg', common, h('path', { d: 'M12 20h9' }), h('path', { d: 'M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z' }));
    return null;
  }

  function Stats({ added, removed, text = true }) {
    if (!text) return null;
    return h('span', { className: 'hgfc-stats' },
      h('span', { className: 'hgfc-added' }, `+${added || 0}`),
      h('span', { className: 'hgfc-removed' }, `-${removed || 0}`));
  }

  function DiffView({ sessionId, turnId, file }) {
    const [state, setState] = React.useState({ loading: true, data: null, error: '' });
    React.useEffect(() => {
      let alive = true;
      setState({ loading: true, data: null, error: '' });
      requestJson(`${base(sessionId)}/${encodeURIComponent(turnId)}/diff?path=${encodeURIComponent(file.path)}`)
        .then(data => { if (alive) setState({ loading: false, data, error: '' }); })
        .catch(error => { if (alive) setState({ loading: false, data: null, error: error.message }); });
      return () => { alive = false; };
    }, [sessionId, turnId, file.path, file.state]);
    if (state.loading) return h('div', { className: 'hgfc-diff hgfc-diff-note' }, '正在读取差异…');
    if (state.error) return h('div', { className: 'hgfc-diff hgfc-diff-note error' }, state.error);
    const data = state.data;
    if (!data.diffable) return h('div', { className: 'hgfc-diff hgfc-diff-note' }, data.message || '无法显示差异。', data.afterSize ? ` · ${formatBytes(data.beforeSize ?? 0)} → ${formatBytes(data.afterSize)}` : '');
    if (!data.hunks.length) return h('div', { className: 'hgfc-diff hgfc-diff-note' }, '内容没有变化。');
    return h('div', { className: 'hgfc-diff', role: 'region', 'aria-label': `${file.name} 的差异` },
      data.approximate && h('div', { className: 'hgfc-diff-banner' }, '改动范围过大，按整段删除/新增显示。'),
      data.hunks.map((hunk, index) => h('div', { className: 'hgfc-hunk', key: index },
        index > 0 && h('div', { className: 'hgfc-hunk-gap' }, '⋯'),
        hunk.lines.map((line, lineIndex) => h('div', {
          key: lineIndex,
          className: `hgfc-line ${line.t === '+' ? 'add' : line.t === '-' ? 'del' : ''}`,
        },
        h('span', { className: 'hgfc-ln' }, line.o ?? ''),
        h('span', { className: 'hgfc-ln' }, line.n ?? ''),
        h('span', { className: 'hgfc-sign' }, line.t === ' ' ? '' : line.t),
        h('span', { className: 'hgfc-code' }, line.s || ' '))))),
      data.truncated && h('div', { className: 'hgfc-diff-banner' }, '差异过长，只显示前一部分。'));
  }

  function FileRow({ sessionId, turn, file, busy, onApply }) {
    const [open, setOpen] = React.useState(false);
    const reverted = file.state === 'reverted';
    const folder = folderOf(file.relative);
    return h('div', { className: `hgfc-file ${reverted ? 'reverted' : ''}` },
      h('div', { className: 'hgfc-file-row' },
        h('button', {
          type: 'button', className: 'hgfc-file-main', title: file.path, 'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        },
        h('span', { className: `hgfc-kind ${file.kind}` }, KIND_LABEL[file.kind] || '修改'),
        h('span', { className: 'hgfc-file-text' },
          h('span', { className: 'hgfc-file-name' }, file.name),
          folder && h('span', { className: 'hgfc-file-dir' }, folder)),
        file.text ? h(Stats, { added: file.added, removed: file.removed }) : h('span', { className: 'hgfc-size' }, formatBytes(file.afterSize))),
        h('div', { className: 'hgfc-file-actions' },
          h('button', { type: 'button', className: `hgfc-icon-btn ${open ? 'active' : ''}`, title: open ? '收起差异' : '查看差异', 'aria-label': open ? '收起差异' : '查看差异', onClick: () => setOpen(value => !value) }, h(Icon, { name: 'diff' })),
          reverted
            ? h('button', { type: 'button', className: 'hgfc-icon-btn', disabled: busy || !file.canReapply, title: '恢复这次改动', 'aria-label': '恢复这次改动', onClick: () => onApply(turn, 'reapply', [file.path]) }, h(Icon, { name: 'redo' }))
            : h('button', { type: 'button', className: 'hgfc-icon-btn', disabled: busy || !file.canRevert, title: file.canRevert ? (file.kind === 'modified' ? '撤回：恢复成修改前的内容' : '撤回：删除这个新建的文件') : file.reason, 'aria-label': '撤回这个文件', onClick: () => onApply(turn, 'revert', [file.path]) }, h(Icon, { name: 'undo' })))),
      reverted && h('div', { className: 'hgfc-file-note' }, file.kind === 'modified' ? '已撤回，文件已恢复成修改前的内容' : '已撤回，文件已删除'),
      !reverted && !file.canRevert && file.reason && h('div', { className: 'hgfc-file-note warn' }, file.reason),
      open && h(DiffView, { sessionId, turnId: turn.turnId, file }));
  }

  function TurnCard({ sessionId, turn, defaultOpen, busy, conflict, onApply, onForce, onDismiss }) {
    const [open, setOpen] = React.useState(defaultOpen);
    const reverted = turn.fileState === 'reverted';
    const label = turn.userText ? turn.userText : `第 ${turn.turnIndex} 轮`;
    return h('div', { className: `hgfc-turn ${reverted ? 'reverted' : ''}` },
      h('div', { className: 'hgfc-turn-head' },
        h('button', { type: 'button', className: 'hgfc-turn-toggle', 'aria-expanded': open, onClick: () => setOpen(value => !value), title: open ? '收起' : '展开' },
          h('span', { className: `hgfc-chevron ${open ? 'open' : ''}` }, h(Icon, { name: 'chevron', size: 13 })),
          h('span', { className: 'hgfc-turn-title' },
            h('span', { className: 'hgfc-turn-label' }, label),
            h('span', { className: 'hgfc-turn-meta' }, `${turn.fileCount} 个文件 · ${formatTime(turn.createdAt)}${turn.fileState === 'partial' ? ' · 部分已撤回' : ''}`)),
          !reverted && h(Stats, { added: turn.added, removed: turn.removed })),
        reverted
          ? h('button', { type: 'button', className: 'hgfc-turn-btn', disabled: busy, onClick: () => onApply(turn, 'reapply', null), title: '把这一轮的改动重新应用到文件上' }, h(Icon, { name: 'redo', size: 13 }), '恢复')
          : h('button', { type: 'button', className: 'hgfc-turn-btn', disabled: busy, onClick: () => onApply(turn, 'revert', null), title: '把这一轮改过的文件恢复到改之前' }, h(Icon, { name: 'undo', size: 13 }), turn.fileState === 'partial' ? '撤回其余' : '撤回本轮')),
      conflict && h('div', { className: 'hgfc-conflict', role: 'alert' },
        h('div', null, `${conflict.items.length} 个文件在这之后又被修改过，${conflict.action === 'revert' ? '撤回' : '恢复'}会覆盖这些较新的内容：`),
        h('ul', null, conflict.items.slice(0, 6).map(item => h('li', { key: item.path, title: item.path }, `${item.relative} — ${item.reason}`))),
        conflict.items.length > 6 && h('div', null, `…另有 ${conflict.items.length - 6} 个`),
        h('div', { className: 'hgfc-conflict-actions' },
          h('button', { type: 'button', className: 'hgfc-turn-btn danger', disabled: busy, onClick: onForce }, `仍然${conflict.action === 'revert' ? '撤回' : '恢复'}`),
          h('button', { type: 'button', className: 'hgfc-turn-btn', disabled: busy, onClick: onDismiss }, '保留现状'))),
      open && h('div', { className: 'hgfc-files' },
        turn.files.map(file => h(FileRow, { key: file.path, sessionId, turn, file, busy, onApply }))));
  }

  function FileChangesSection({ sessionId, revision = 0, onToast, enabled = true }) {
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [conflicts, setConflicts] = React.useState({});
    const [collapsed, setCollapsed] = React.useState(false);
    const ticket = React.useRef(0);
    const toast = React.useCallback((message, type) => { try { onToast?.(message, type); } catch { /* ignore */ } }, [onToast]);

    const load = React.useCallback(async () => {
      if (!sessionId || !enabled) { setData(null); return; }
      const mine = ++ticket.current;
      try {
        const next = await requestJson(base(sessionId));
        if (mine === ticket.current) { setData(next); setError(''); }
      } catch (err) {
        if (mine === ticket.current) setError(err.message);
      }
    }, [sessionId, enabled]);

    React.useEffect(() => { setData(null); setConflicts({}); setError(''); }, [sessionId, enabled]);
    React.useEffect(() => { load(); }, [load, revision]);

    const apply = async (turn, action, paths, force = false) => {
      if (!sessionId || busy || !enabled) return;
      setBusy(true);
      try {
        const result = await requestJson(`${base(sessionId)}/${encodeURIComponent(turn.turnId)}/apply`, {
          method: 'POST', body: JSON.stringify({ action, ...(paths ? { paths } : {}), ...(force ? { force: true } : {}) }),
        });
        const verb = action === 'revert' ? '撤回' : '恢复';
        setConflicts(prev => {
          const next = { ...prev };
          if (result.conflicts?.length) next[turn.turnId] = { action, paths, items: result.conflicts };
          else delete next[turn.turnId];
          return next;
        });
        const problems = [...(result.failed || []), ...(result.unavailable || [])];
        if (result.done?.length) toast(`已${verb} ${result.done.length} 个文件`, 'info');
        if (problems.length) toast(`${problems.length} 个文件未能${verb}：${problems[0].relative} — ${problems[0].reason}`, 'error');
        if (!result.done?.length && !problems.length && !result.conflicts?.length) toast(`没有需要${verb}的文件`, 'info');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        setBusy(false);
      }
    };

    if (!sessionId || !enabled || data?.enabled === false) return null;
    const turns = data?.turns || [];
    const has = turns.length > 0;
    return h('section', { className: 'hgfc-section', 'data-has-changes': has ? 'true' : 'false', 'aria-label': '文件改动' },
      h('div', { className: 'hgfc-head' },
        h('button', { type: 'button', className: 'hgfc-head-toggle', onClick: () => setCollapsed(value => !value), 'aria-expanded': !collapsed, disabled: !has },
          h(Icon, { name: 'changes', size: 13 }),
          h('span', { className: 'hgfc-head-title' }, '文件改动'),
          has && h('span', { className: 'hgfc-head-count' }, `${data.fileCount} 个文件 · ${data.turnCount} 轮`),
          has && h('span', { className: `hgfc-chevron ${collapsed ? '' : 'open'}` }, h(Icon, { name: 'chevron', size: 12 }))),
        h('button', { type: 'button', className: 'hgfc-icon-btn', title: '刷新', 'aria-label': '刷新文件改动', onClick: load }, h(Icon, { name: 'refresh', size: 13 }))),
      error && h('div', { className: 'hgfc-empty error' }, error),
      !error && !has && h('div', { className: 'hgfc-empty' }, data ? 'agent 在这个对话里还没有写入或下载文件。改动会记在这里，可以整轮或逐个文件撤回。' : '正在读取…'),
      has && !collapsed && h('div', { className: 'hgfc-turns' },
        turns.map((turn, index) => h(TurnCard, {
          key: turn.turnId, sessionId, turn, defaultOpen: index === 0, busy,
          conflict: conflicts[turn.turnId] || null,
          onApply: (t, action, paths) => apply(t, action, paths),
          onForce: () => { const c = conflicts[turn.turnId]; if (c) apply(turn, c.action, c.items.map(item => item.path), true); },
          onDismiss: () => setConflicts(prev => { const next = { ...prev }; delete next[turn.turnId]; return next; }),
        })),
        h('div', { className: 'hgfc-footnote' }, '只记录 write_file 与 download_file 的改动；run_command 运行的命令改动的文件不在其中。')));
  }

  return { FileChangesSection };
}
