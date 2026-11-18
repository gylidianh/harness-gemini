/**
 * 1.7.1: 「桌面控制」设置分区。
 *
 * 这个能力会让模型真的操作这台电脑的鼠标和键盘，所以它单独占一个分区：开关、风险说明和
 * 当前权限模式必须同时看得见。面板自己注入样式表，避免改动被构建校验当作受保护文件的
 * index.html（和「远程连接」同一套做法）。
 */

const STYLE_HREF = '/computer-settings.css';

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[data-harness="${STYLE_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.harness = STYLE_HREF;
  document.head.appendChild(link);
}

const PLATFORM_NOTE = '桌面控制目前只在 Windows 上可用。';

export function createComputerSettingsPanel(React) {
  const h = React.createElement;

  function ComputerSettingsView({ value, busy, error, notice, actions }) {
    const supported = value ? value.supported !== false : true;
    const enabled = value?.enabled === true;
    const mode = value?.approvalMode ?? 'ask';
    const modeText = mode === 'full' ? '完整访问（不再询问）' : mode === 'smart' ? '帮我批准（智能）' : '请求批准';
    return h('div', { className: 'computer-settings' },
      h('p', { className: 'computer-intro' },
        '打开后，模型可以看屏幕、移动真实光标、点击、拖拽、输入文字和按快捷键。',
        '它不能越过审批：每一次操作都会先征求你的同意，除非当前是「完整访问」模式。'),

      !supported && h('p', { className: 'field-error', role: 'alert' }, PLATFORM_NOTE),

      h('div', { className: 'computer-switch-row' },
        h('label', { className: 'computer-switch' },
          h('input', {
            type: 'checkbox', role: 'switch', checked: enabled,
            disabled: busy === 'toggle' || !supported,
            'aria-label': '允许模型操作这台电脑',
            onChange: event => actions.setEnabled(event.target.checked),
          }),
          h('span', null, enabled ? '已开启' : '已关闭')),
        h('span', { className: 'computer-switch-hint' }, enabled ? '桌面控制已打开' : '默认关闭；打开前模型看不到这些工具')),

      error && h('p', { className: 'field-error', role: 'alert' }, error),
      notice && h('p', { className: 'computer-notice', role: 'status' }, notice),

      h('ul', { className: 'computer-warnings' },
        h('li', null, '截屏会拍下屏幕上的全部内容，可能包含密码、聊天记录或别人的窗口。'),
        h('li', null, '操作会移动真实光标并影响前台窗口，正在输入的内容可能被打断。'),
        h('li', null, '「完整访问」模式下桌面操作不再逐次询问；只在你能盯着屏幕时才这样用。'),
        h('li', null, '需要管理员权限的窗口可能拒绝被操作，程序会如实报错而不是假装成功。')),

      h('div', { className: 'computer-meta' },
        h('span', null, '当前权限模式：', h('strong', null, modeText)),
        h('span', { className: 'computer-meta-note' }, mode === 'full'
          ? '桌面操作不会逐次询问。'
          : '每次操作都会要求批准。')),

      h('p', { className: 'computer-footnote' },
        '开启后，编程模式的对话里会多出 computer_windows、computer_screenshot、computer_act 三个工具；',
        '关闭后它们会立刻从下一次请求里消失。'));
  }

  function ComputerSettings({ disabled }) {
    const [state, setState] = React.useState({ loading: true, value: null, error: '', notice: '', busy: '' });
    const alive = React.useRef(false);

    const load = async () => {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error('无法读取设置。');
      const body = await response.json();
      const supported = typeof navigator === 'undefined' || /windows/i.test(navigator.userAgent || '');
      return { enabled: body?.computerUseEnabled === true, approvalMode: body?.approvalMode ?? 'ask', supported };
    };

    React.useEffect(() => {
      alive.current = true;
      void (async () => {
        try {
          const value = await load();
          if (alive.current) setState(s => ({ ...s, loading: false, value }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, loading: false, error: error.message }));
        }
      })();
      return () => { alive.current = false; };
    }, []);

    const setEnabled = async next => {
      if (disabled) return;
      setState(s => ({ ...s, busy: 'toggle', error: '', notice: '' }));
      try {
        const response = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ computerUseEnabled: next === true }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.message || body?.error || '保存失败。');
        if (!alive.current) return;
        setState(s => ({
          ...s, busy: '',
          value: { ...(s.value ?? {}), enabled: body?.computerUseEnabled === true, approvalMode: body?.approvalMode ?? s.value?.approvalMode ?? 'ask' },
          notice: next ? '桌面控制已打开。' : '桌面控制已关闭。',
        }));
      } catch (error) {
        if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
      }
    };

    ensureStylesheet();
    if (state.loading) {
      return h('div', { className: 'computer-settings' },
        h('p', { className: 'computer-intro' }, '正在读取桌面控制状态…'),
        state.error && h('p', { className: 'field-error', role: 'alert' }, state.error));
    }
    return h(ComputerSettingsView, {
      value: state.value, busy: state.busy, error: state.error, notice: state.notice,
      actions: { setEnabled },
    });
  }

  return { ComputerSettings, ComputerSettingsView };
}
