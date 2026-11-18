// 1.7.4: 分叉（fork）——把一段对话在任意一条消息处复制成新对话，两条分支互不影响。
//
// 语义参考 ZCode 的 session fork（apps/zcode-cli .../runtime/methods/session-fork.ts）：
// 分叉点是用户看得见的历史，子对话拿到全新的消息 ID，记住父对话与分叉点，不继承父对话
// 正在进行的请求、等待中的提问与审批，也不替用户自动发起新一轮请求；子对话标题显示来源，
// 列表里能看出它是从哪条对话分出来的。ZCode is Copyright 2026 Z.AI Co., Ltd,
// Apache License 2.0, see THIRD-PARTY-NOTICES.md.
//
// The conversation itself lives in the app's React state, so this module draws the button, asks the
// server to fork, and hands the result back through the callbacks the app binds below. It never
// touches React internals of the app and never keeps its own copy of a session.

const EMPTY_HOST = { openSession: null, refresh: null, toast: null };

/** Bound by the app once per render (the functions are stable), so the module can open the result. */
const host = { ...EMPTY_HOST };

export function bindBranchHost(next = {}) {
  for (const key of Object.keys(EMPTY_HOST)) {
    if (typeof next[key] === 'function') host[key] = next[key];
  }
}

/** The same object the branch badge in the session list uses to jump to a parent conversation. */
export function branchHost() {
  return host;
}

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

export function createBranchUI(React) {
  const h = React.createElement;

  function ForkIcon({ size = 14 }) {
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M6 18 18 6' }),
      h('path', { d: 'M18 11.5V6h-5.5' }),
      h('path', { d: 'M6 12.5V18h5.5' }),
      h('path', { d: 'M9.4 16.2a3.4 3.4 0 0 0 0-4.8' })
    );
  }

  /**
   * 消息操作栏上的“分叉”。一次只发一个请求：服务端负责把分叉点之前的可见历史复制成新对话，
   * 前端只负责告诉用户结果并把界面切到新对话。
   */
  function MessageBranchButton({ sessionId, message, disabled = false }) {
    const [busy, setBusy] = React.useState(false);
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);

    const fork = async () => {
      if (busy || disabled || !sessionId || !message?.id) return;
      setBusy(true);
      try {
        const session = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, {
          method: 'POST',
          body: JSON.stringify({ messageId: message.id }),
        });
        if (!alive.current) return;
        // The sidebar list and the open conversation both come from app state: refresh the list,
        // then let the app load the child from the server like any other conversation.
        try { await host.refresh?.(); } catch { /* a stale list still resolves on the next open */ }
        if (!alive.current) return;
        host.openSession?.(session?.id);
        host.toast?.(`已分叉出新对话${session?.title ? `：${session.title}` : ''}`, 'success');
      } catch (error) {
        if (alive.current) host.toast?.(error?.message || '分叉没有完成。', 'error');
      } finally {
        if (alive.current) setBusy(false);
      }
    };

    return h('button', {
      type: 'button',
      className: `icon-button small hg-branch-btn${busy ? ' is-busy' : ''}`,
      title: busy ? '正在分叉…' : '分叉：从这条消息开一个新对话',
      'aria-label': '分叉',
      'aria-busy': busy ? 'true' : undefined,
      disabled: busy || disabled,
      onClick: fork,
    }, h(ForkIcon, { size: 14 }));
  }

  return { MessageBranchButton };
}
