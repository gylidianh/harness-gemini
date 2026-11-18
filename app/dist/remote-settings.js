/**
 * 「远程连接」设置分区。
 *
 * 设置对话框本身是编译后的 bundle；这个文件和 settings-layout.js 相邻，由它挂进
 * `settings-remote` 分区，所以面板是可读源码，而不是打包产物的一部分。
 *
 * 四条约定：
 * 1. 配对链接带着密钥，只在用户点「显示配对二维码」时向主进程要一次，收起即清空；
 * 2. 所有动作都走 preload 的 `remote` 命名空间，页面不直接碰 IPC，也不碰配置文件；
 * 3. 渲染与状态分开（RemoteSettingsView / RemoteSettings），所以布局能被离线测试渲染，
 *    不需要启动 Electron 就能发现字段名对不上这类问题；
 * 4. 两种模式共用一个设备列表、一个派发开关、一把配对密钥——换模式不等于重新认识手机。
 *
 * 默认模式是「免服务器直连」：手机和电脑在同一个 Wi-Fi 直接连，出门时由桌面端自己跑一个
 * Cloudflare 隧道；「自建中继」原样保留，因为它是唯一能后台推送的模式。
 */
import { qrPath } from './qr-code.js';

const POLL_MS = 3_000;

const STATE_TEXT = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  offline: '未连接',
  error: '连接失败',
};

const TUNNEL_TEXT = {
  stopped: '未开启',
  starting: '正在连接 Cloudflare…',
  ready: '已就绪',
  error: '连接失败',
  missing: '没找到 cloudflared',
};

const MODE_TEXT = {
  direct: '免服务器直连',
  relay: '自建中继',
};

const SCOPE_NOTE = '手机上能做的只有：看待批准的调用、批准或拒绝、回答提问、停止任务。';

/** Loads the panel stylesheet once; index.html stays untouched. */
function ensureStylesheet() {
  if (typeof document === 'undefined' || document.getElementById('remote-settings-css')) return;
  const link = document.createElement('link');
  link.id = 'remote-settings-css';
  link.rel = 'stylesheet';
  link.href = '/remote-settings.css';
  document.head.appendChild(link);
}

export function createRemoteSettingsPanel(React) {
  const h = React.createElement;

  function ModeTabs({ mode, busy, actions }) {
    const tab = (id, label, detail) => h('button', {
      type: 'button',
      className: `remote-mode${mode === id ? ' on' : ''}`,
      disabled: !!busy,
      'aria-pressed': mode === id,
      onClick: () => actions.setMode(id),
    }, h('strong', null, label), h('small', null, detail));
    return h('div', { className: 'remote-modes', role: 'tablist' },
      tab('direct', '免服务器直连', '同一 Wi-Fi 直接连，出门用 Cloudflare'),
      tab('relay', '自建中继（VPS）', '你自己的服务器转发，可后台推送'));
  }

  function PairCard({ link, actions }) {
    if (!link) return null;
    let pair = null;
    try { pair = qrPath(link); } catch { pair = null; }
    if (!pair) return null;
    return h('div', { className: 'remote-pair' },
      h('div', { className: 'remote-qr-wrap' },
        h('svg', {
          className: 'remote-qr', viewBox: `0 0 ${pair.total} ${pair.total}`,
          width: 208, height: 208, role: 'img', 'aria-label': '配对二维码', shapeRendering: 'crispEdges',
        },
          h('rect', { key: 'background', width: pair.total, height: pair.total, fill: '#ffffff' }),
          h('path', { key: 'modules', d: pair.path, fill: '#16202c' }))),
      h('div', { className: 'remote-pair-copy' },
        h('ol', { className: 'remote-steps' },
          h('li', null, '用手机相机扫描这个二维码，会打开这台电脑上的手机页。'),
          h('li', null, '页面自动完成配对，配对码不会经过服务器。'),
          h('li', null, '配对成功后这里会多出一台设备，随时可以撤销。')),
        h('label', { className: 'field' }, h('span', null, '或者手动打开这个链接'),
          h('div', { className: 'remote-link-row' },
            h('input', { type: 'text', readOnly: true, value: link, onFocus: event => event.target.select() }),
            h('button', { type: 'button', className: 'button button-quiet small-button', onClick: actions.copyLink }, '复制'))),
        h('p', { className: 'remote-hint' }, '这个链接等同于一把钥匙：发给别人等于让对方能批准你的工具调用。')));
  }

  function AddressList({ value, busy, actions }) {
    const urls = Array.isArray(value.direct?.urls) ? value.direct.urls : [];
    const tunnelUrl = value.tunnel?.url || '';
    const tunnelState = value.tunnel?.state || 'stopped';
    return h('div', { className: 'remote-card' },
      h('div', { className: 'remote-card-heading' },
        h('strong', null, '这台电脑的地址'),
        h('span', { className: 'remote-meta' }, `端口 ${value.direct?.port || '—'}`)),
      urls.length
        ? h('ul', { className: 'remote-urls' }, urls.map((url, index) => h('li', { key: url, className: 'remote-url-row' },
          h('code', null, url),
          index === 0 ? h('span', { className: 'remote-badge live' }, '推荐') : null,
          h('button', {
            type: 'button', className: 'button button-quiet small-button',
            onClick: () => actions.copy(url),
          }, '复制'))))
        : h('p', { className: 'remote-empty' }, '还没有局域网地址：电脑可能没有连上 Wi-Fi，或者端口没有开。'),
      h('p', { className: 'remote-hint' },
        '手机要和电脑连同一个 Wi-Fi，用上面的地址打开页面。换网络或插拔网线后地址可能变化，'
        + '以这里显示的为准。'),

      h('div', { className: 'remote-tunnel' },
        h('div', { className: 'remote-card-heading' },
          h('strong', null, 'Cloudflare 出门连接'),
          h('span', { className: `remote-badge${tunnelState === 'ready' ? ' live' : ''}` }, TUNNEL_TEXT[tunnelState] ?? tunnelState)),
        tunnelUrl
          ? h('div', { className: 'remote-url-row' },
            h('code', null, tunnelUrl),
            h('button', { type: 'button', className: 'button button-quiet small-button', onClick: () => actions.copy(tunnelUrl) }, '复制'))
          : null,
        h('p', { className: 'remote-hint' },
          '不在同一 Wi-Fi 时用这个地址：桌面端自己运行 Cloudflare 连接程序，不需要 VPS。'
          + '地址是临时的，每次重新开启都会变；也随时可能被 Cloudflare 限速。'),
        tunnelState === 'error' && value.tunnel?.error
          ? h('p', { className: 'field-error', role: 'status' }, value.tunnel.error)
          : null,
        tunnelState === 'error' && Array.isArray(value.tunnel?.lines) && value.tunnel.lines.length
          ? h('details', { className: 'remote-details' },
            h('summary', null, '连接程序日志'),
            h('pre', { className: 'remote-log' }, value.tunnel.lines.join('\n')))
          : null,
        h('div', { className: 'remote-toolbar' },
          h('button', {
            type: 'button', className: 'button button-quiet small-button',
            disabled: !!busy, onClick: actions.toggleTunnel,
          }, busy === 'tunnel' ? '正在处理…' : (value.tunnelEnabled ? '关闭出门连接' : '开启出门连接')),
          value.tunnel?.installed
            ? null
            : h('button', {
              type: 'button', className: 'button button-quiet small-button',
              disabled: !!busy, onClick: actions.installTunnel,
            }, busy === 'install' ? '正在下载…' : '下载 cloudflared')),
        !value.tunnel?.installed && value.tunnel?.source !== 'path'
          ? h('p', { className: 'remote-hint' },
            '没找到 cloudflared。点「下载 cloudflared」会从 Cloudflare 官方发布页下载到本机数据目录；'
            + '你也可以自己安装，或填一个已经存在的路径。')
          : null));
  }

  function Devices({ value, busy, confirming, actions }) {
    const devices = Array.isArray(value.devices) ? value.devices : [];
    return h('div', { className: 'remote-card' },
      h('div', { className: 'remote-card-heading' },
        h('strong', null, '已配对设备'),
        h('span', { className: 'remote-meta' }, `${devices.length} / ${value.deviceLimit}`)),
      devices.length
        ? h('ul', { className: 'remote-devices' }, devices.map(device =>
          h('li', { key: device.deviceId, className: 'remote-device' },
            h('span', { className: 'remote-device-name' }, device.label),
            device.transport === 'plain' ? h('span', { className: 'remote-badge' }, '局域网明文') : null,
            h('span', { className: `remote-badge${device.live ? ' live' : ''}` }, device.live ? '在线' : '离线'),
            h('button', {
              type: 'button',
              className: `button small-button ${confirming === device.deviceId ? 'button-danger' : 'button-quiet'}`,
              disabled: !!busy,
              onClick: () => actions.revoke(device.deviceId),
              onBlur: actions.clearConfirm,
            }, confirming === device.deviceId ? '确认撤销？' : '撤销'))))
        : h('p', { className: 'remote-empty' }, '还没有设备。点「显示配对二维码」，用手机扫一下。'));
  }

  /**
   * Pure view: everything it needs arrives as props, so a test can render any state.
   * @param {object} props.value       status payload from the main process, null while loading
   * @param {object} props.actions     callbacks; the view never talks to the bridge itself
   */
  function RemoteSettingsView({ value, busy = '', error = '', link = '', form, confirming = '', actions }) {
    if (!value) {
      return h('div', { className: 'remote-settings' },
        h('p', { className: 'remote-intro' }, '让手机接入这台电脑：审批工具调用、回答提问、停止任务。不装 App，也不用买服务器。'),
        error
          ? h('p', { className: 'field-error', role: 'alert' }, error)
          : h('p', { className: 'remote-loading', role: 'status' }, '正在读取远程连接状态…'));
    }

    // An older status payload has no mode: that is a relay config, and it must keep rendering
    // exactly as it did before this panel learned about direct mode.
    const mode = value.mode === 'direct' ? 'direct' : 'relay';
    const enabled = value.enabled === true;
    // The tab follows the user's last click, not the mode the main process reported: reading
    // `mode` here made the other card look dead — clicking it changed nothing at all. A missing
    // form.mode (older embeds, the offline tests) still falls back to the running mode.
    const picked = form?.mode === 'direct' || form?.mode === 'relay' ? form.mode : mode;
    // Enabled, but the user is looking at the other mode: that is a real switch, not a preview.
    const switching = enabled && picked !== mode;
    const direct = mode === 'direct';
    const state = STATE_TEXT[value.state] ? value.state : 'offline';
    const devices = Array.isArray(value.devices) ? value.devices : [];
    const meta = direct
      ? [value.direct?.state === 'listening' ? `本机端口 ${value.direct.port}` : '尚未开启',
        Array.isArray(value.direct?.urls) ? `${value.direct.urls.length} 个局域网地址` : '',
        devices.length ? `${devices.length} / ${value.deviceLimit} 台设备` : ''].filter(Boolean).join(' · ')
      : [value.configured ? value.url : '尚未配置',
        devices.length ? `${devices.length} / ${value.deviceLimit} 台设备` : ''].filter(Boolean).join(' · ');

    return h('div', { className: 'remote-settings' },
      h('p', { className: 'remote-intro' }, picked === 'direct'
        ? '手机和电脑在同一个 Wi-Fi 就直接连；出门时让桌面端开一条 Cloudflare 隧道。都不需要 VPS。'
        : '手机通过你自己的服务器接入这台电脑。任务始终在电脑上跑，离开工位也能审批和查看。'),
      h('p', { className: 'remote-hint' }, SCOPE_NOTE),

      h(ModeTabs, { mode: picked, busy, actions }),

      h('div', { className: 'remote-status', role: 'status' },
        h('span', { className: `remote-dot ${state}`, 'aria-hidden': true }),
        h('strong', null, STATE_TEXT[state]),
        h('span', { className: 'remote-meta' }, meta)),

      error && h('p', { className: 'field-error', role: 'alert' }, error),
      value.error && h('p', { className: 'remote-error', role: 'status' }, value.error),

      !enabled && picked === 'direct' && h('div', { className: 'remote-form' },
        h('p', { className: 'remote-hint' },
          '开启后这台电脑会监听一个局域网端口，只有手机页、配对和设备接口，没有设置、文件或模型接口。'
          + '第一次开启时 Windows 防火墙可能会问一次，允许「专用网络」即可。'),
        h('label', { className: 'field' }, h('span', null, '端口'),
          h('input', {
            type: 'number', min: 1024, max: 65535, value: form.port,
            onChange: event => actions.setField('port', event.target.value),
          }),
          h('small', null, '默认 8791。换端口后局域网地址跟着变；改完需要重新启用。')),
        h('div', { className: 'remote-toolbar' },
          h('button', {
            type: 'button', className: 'button button-primary small-button',
            disabled: !!busy, onClick: actions.enable,
          }, busy === 'enable' ? '正在开启…' : '开启免服务器直连'))),

      !enabled && picked === 'relay' && h('div', { className: 'remote-form' },
        h('label', { className: 'field' }, h('span', null, '中继地址'),
          h('input', {
            type: 'url', value: form.url, placeholder: 'https://relay.example.com',
            onChange: event => actions.setField('url', event.target.value),
          }),
          h('small', null, '你 VPS 上的中继服务地址。用 HTTPS 时，配对码和审批内容在传输中都是加密的。')),
        h('label', { className: 'field' }, h('span', null, '中继令牌'),
          h('input', {
            type: 'password', value: form.token, placeholder: '与 VPS 上的 RELAY_TOKEN 一致',
            onChange: event => actions.setField('token', event.target.value),
          }),
          h('small', null, '只用于桌面端连上中继，手机看不到它。')),
        h('div', { className: 'remote-toolbar' },
          h('button', {
            type: 'button', className: 'button button-primary small-button',
            disabled: !!busy || !form.url.trim() || !form.token.trim(),
            onClick: actions.enable,
          }, busy === 'enable' ? '正在连接…' : '启用远程连接'))),

      // Enabled and the user picked the other mode: say what happens, then do it in one click.
      switching && h('div', { className: 'remote-form remote-mode-switch' },
        h('div', { className: 'remote-card-heading' },
          h('strong', null, '切换连接方式'),
          h('span', { className: 'remote-badge' }, `当前：${MODE_TEXT[mode]}`)),
        h('p', { className: 'remote-hint' },
          `远程连接现在以「${MODE_TEXT[mode]}」启用。切到「${MODE_TEXT[picked]}」会先停用当前连接，`
          + '再用新的方式重新开启；已配对的手机和配对密钥都保留，不需要重新扫码。'),
        picked === 'direct' && h('label', { className: 'field' }, h('span', null, '端口'),
          h('input', {
            type: 'number', min: 1024, max: 65535, value: form.port,
            onChange: event => actions.setField('port', event.target.value),
          }),
          h('small', null, '默认 8791。换端口后局域网地址跟着变。')),
        picked === 'relay' && h(React.Fragment, null,
          h('label', { className: 'field' }, h('span', null, '中继地址'),
            h('input', {
              type: 'url', value: form.url, placeholder: 'https://relay.example.com',
              onChange: event => actions.setField('url', event.target.value),
            })),
          h('label', { className: 'field' }, h('span', null, '中继令牌'),
            h('input', {
              type: 'password', value: form.token, placeholder: '留空则沿用已保存的令牌',
              onChange: event => actions.setField('token', event.target.value),
            }),
            h('small', null, '只用于桌面端连上中继，手机看不到它。'))),
        h('div', { className: 'remote-toolbar' },
          h('button', {
            type: 'button', className: 'button button-primary small-button',
            disabled: !!busy || (picked === 'relay' && !form.url.trim()),
            onClick: actions.switchMode,
          }, busy === 'switch' ? '正在切换…' : `停用并切换到${MODE_TEXT[picked]}`))),

      enabled && h(React.Fragment, null,
        h('div', { className: 'remote-toolbar' },
          h('button', {
            type: 'button', className: 'button button-quiet small-button',
            disabled: !!busy || !value.configured, onClick: actions.toggleLink,
          }, link ? '收起二维码' : busy === 'link' ? '正在生成…' : '显示配对二维码'),
          h('button', { type: 'button', className: 'button button-quiet small-button', disabled: !!busy, onClick: actions.refresh }, '刷新状态'),
          h('button', {
            type: 'button', className: 'button button-quiet small-button',
            disabled: !!busy, onClick: actions.disable,
          }, busy === 'disable' ? '正在停用…' : '停用远程连接')),

        h(PairCard, { link, actions }),
        direct ? h(AddressList, { value, busy, actions }) : null,
        h(Devices, { value, busy, confirming, actions }),

        h('div', { className: 'remote-card' },
          h('label', { className: 'remote-switch' },
            h('input', {
              type: 'checkbox', role: 'switch', checked: value.dispatchEnabled,
              disabled: !!busy, onChange: event => actions.setDispatch(event.target.checked),
            }),
            h('span', null, '允许手机派发新任务')),
          h('p', { className: 'remote-hint' },
            '默认关闭。开启后手机可以往已有会话里发一条消息，但桌面处于「完整访问」模式时会直接拒绝——'
            + '那种模式下手机发一句话就等于无审批执行命令。每次派发都会写入本机审计日志。')),

        direct && h('div', { className: 'remote-card' },
          h('label', { className: 'remote-switch' },
            h('input', {
              type: 'checkbox', role: 'switch', checked: value.allowPlainLan !== false,
              disabled: !!busy, onChange: event => actions.setPlainLan(event.target.checked),
            }),
            h('span', null, '允许局域网明文直连')),
          h('p', { className: 'remote-hint' },
            '手机用 http://192.168… 打开时浏览器没有加密接口，只能走明文——此时令牌就是全部凭据，'
            + '同一网络里能抓包的人可能拿到它。关掉这个开关就只剩 https（Cloudflare 隧道）能连，'
            + '审批内容在浏览器和电脑之间端到端加密。')),

        h('div', { className: 'remote-card remote-danger' },
          h('div', { className: 'remote-card-heading' }, h('strong', null, '配对密钥')),
          h('p', { className: 'remote-hint' }, '怀疑链接外泄时轮换一次：所有手机需要重新配对，旧链接立刻失效。'),
          h('div', { className: 'remote-toolbar' },
            h('button', {
              type: 'button',
              className: `button small-button ${confirming === 'rotate' ? 'button-danger' : 'button-quiet'}`,
              disabled: !!busy, onClick: actions.rotate, onBlur: actions.clearConfirm,
            }, confirming === 'rotate' ? '确认轮换？所有设备会掉线' : '轮换配对密钥')))));
  }

  function RemoteSettings() {
    ensureStylesheet();
    const bridge = globalThis.harnessDesktop?.remote ?? null;
    const [value, setValue] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState('');
    const [link, setLink] = React.useState('');
    const [form, setForm] = React.useState({ mode: 'direct', url: '', token: '', port: '8791' });
    const [confirming, setConfirming] = React.useState('');
    const alive = React.useRef(false);
    const pending = React.useRef(false);
    const modeSynced = React.useRef(false);

    const call = React.useCallback(async (action, payload) => {
      if (!bridge) throw new Error('远程连接只在这个桌面应用里可用。');
      const reply = await bridge[action](payload);
      if (!reply?.ok) throw new Error(reply?.error ?? '远程设置暂时不可用。');
      return reply.data;
    }, [bridge]);

    const refresh = React.useCallback(async () => {
      if (pending.current) return;
      pending.current = true;
      try {
        const data = await call('status');
        if (alive.current) {
          setValue(data);
          setError('');
          // Follow the mode the main process reports, so reopening the page shows the truth
          // rather than whichever tab was last clicked in a previous session.
          // Only the first read decides the tab. The three-second poll used to reset it to the
          // reported mode, so a click survived one second and then snapped back.
          if (!modeSynced.current) {
            modeSynced.current = true;
            setForm(current => ({ ...current, mode: data.mode === 'direct' ? 'direct' : 'relay' }));
          }
          setForm(current => (String(current.port) === String(data.directPort ?? current.port)
            ? current
            : { ...current, port: String(data.directPort ?? current.port) }));
          setForm(current => (data.relay?.url && !current.url
            ? { ...current, url: data.relay.url }
            : current));
        }
      } catch (fault) {
        if (alive.current) setError(fault.message);
      } finally { pending.current = false; }
    }, [call]);

    React.useEffect(() => {
      alive.current = true;
      void refresh();
      const timer = setInterval(() => { void refresh(); }, POLL_MS);
      return () => {
        alive.current = false;
        clearInterval(timer);
        // 链接里带着配对密钥：面板关掉时不要留在内存里。
        setLink('');
      };
    }, [refresh]);

    const act = async (label, work) => {
      setBusy(label); setError('');
      try {
        const data = await work();
        if (alive.current && data) setValue(data);
      } catch (fault) {
        if (alive.current) setError(fault.message);
      } finally { if (alive.current) setBusy(''); }
    };

    const toggleLink = async () => {
      if (link) { setLink(''); return; }
      setBusy('link'); setError('');
      try {
        const data = await call('pairLink');
        if (alive.current) setLink(data.link);
      } catch (fault) {
        if (alive.current) setError(fault.message);
      } finally { if (alive.current) setBusy(''); }
    };

    const copy = async text => {
      try { await navigator.clipboard.writeText(text); }
      catch { setError('复制失败，请手动选中。'); }
    };

    const actions = {
      setField: (name, text) => setForm(current => ({ ...current, [name]: text })),
      setMode: next => {
        setForm(current => ({ ...current, mode: next }));
        // Switching the tab is a view change, not a config change: nothing is written until the
        // user presses the button for that mode.
        setLink('');
        setError('');
      },
      enable: () => act('enable', () => call('enable', {
        mode: form.mode,
        url: form.mode === 'relay' ? form.url : undefined,
        relayToken: form.mode === 'relay' ? form.token : undefined,
        port: form.mode === 'direct' ? Number(form.port) : undefined,
      })),
      disable: () => act('disable', () => call('disable')),
      // Two calls, one click: the old listener has to be stopped before the new one can take
      // the port. Devices and the pairing secret are kept, so the phone stays paired.
      switchMode: async () => {
        const target = form.mode === 'relay' ? 'relay' : 'direct';
        setLink('');
        await act('switch', async () => {
          await call('disable');
          return call('enable', {
            mode: target,
            url: target === 'relay' ? (form.url.trim() || undefined) : undefined,
            relayToken: target === 'relay' ? (form.token.trim() || undefined) : undefined,
            port: target === 'direct' ? Number(form.port) : undefined,
          });
        });
      },
      refresh,
      toggleLink,
      copy,
      copyLink: () => copy(link),
      // 撤销和轮换都要点两次：一次误触不该让手机再也连不上。
      revoke: async deviceId => {
        if (confirming !== deviceId) { setConfirming(deviceId); return; }
        setConfirming('');
        await act('revoke', () => call('revoke', { deviceId }));
      },
      rotate: async () => {
        if (confirming !== 'rotate') { setConfirming('rotate'); return; }
        setConfirming('');
        setLink('');
        await act('rotate', () => call('rotateSecret'));
      },
      clearConfirm: () => setConfirming(current => (current ? '' : current)),
      setDispatch: enabled => act('dispatch', () => call('setDispatch', enabled)),
      setPlainLan: enabled => act('plain', () => call('setPlainLan', enabled)),
      toggleTunnel: () => act('tunnel', () => call('setTunnel', { enabled: !value?.tunnelEnabled })),
      installTunnel: () => act('install', () => call('installTunnel')),
    };

    return h(RemoteSettingsView, { value, busy, error, link, form, confirming, actions });
  }

  return { RemoteSettings, RemoteSettingsView };
}
