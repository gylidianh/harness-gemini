/**
 * 1.4.8: the advanced half of one connection's settings, as its own module.
 *
 * The settings dialog itself is a compiled bundle; this file is loaded beside it (like
 * settings-layout.js and file-changes.js) so the advanced options stay readable source:
 * extra request headers, extra body fields with the conversation's id in them, a proxy of
 * the connection's own, and the two limits — requests out at once, and requests a minute.
 *
 * The rules match magpie's (yetone/magpie, internal/provider/extrabody.go and
 * requestheaders.go), and the server enforces them again in server/provider-extra.mjs; what
 * is repeated here is only so the editor can say what is wrong before saving.
 */

/** The proxy choices, in the order the editor shows them. */
export const PROXY_CHOICES = [
  { id: 'global', label: '全局代理', hint: '跟随设置里的代理' },
  { id: 'direct', label: '直连', hint: '不经过任何代理' },
  { id: 'custom', label: '自定义', hint: '只让这个连接走指定代理' },
];

/** The body fields the extra body may never set: model, stream and the conversation itself. */
const RESERVED_FIELDS = [
  'model', 'stream', 'messages', 'input', 'contents', 'system', 'systemInstruction', 'system_instruction',
  'instructions', 'tools',
];

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,120}$/;
const RESERVED_HEADERS = [
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'expect', 'te', 'trailer',
  'accept-encoding', 'proxy-authorization', 'proxy-authenticate',
];
const MAX_HEADERS = 24;
const MAX_CONCURRENCY = 1000;
const MAX_RPM = 10000;

/** The example the editor shows before anything is typed. */
export const EXTRA_BODY_EXAMPLE = '{"prompt_cache_key": "${sessionId}"}';

/** A limit as the editor holds it: text, empty for "no limit". */
function limitText(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isSafeInteger(number) && number > 0 ? String(number) : '';
}

/** The advanced fields of one connection as the editor keeps them. */
export function advancedDefaultsForProfile(profile) {
  const headers = Array.isArray(profile?.headers) ? profile.headers : [];
  return {
    headers: headers
      .filter(row => row && typeof row === 'object')
      .map(row => ({ name: typeof row.name === 'string' ? row.name : '', value: typeof row.value === 'string' ? row.value : '' })),
    extraBody: typeof profile?.extraBody === 'string' ? profile.extraBody : '',
    proxyMode: PROXY_CHOICES.some(choice => choice.id === profile?.proxyMode) ? profile.proxyMode : 'global',
    proxyUrl: typeof profile?.proxyUrl === 'string' ? profile.proxyUrl : '',
    maxConcurrency: limitText(profile?.maxConcurrency),
    maxRpm: limitText(profile?.maxRpm),
  };
}

/** The advanced fields as they are sent to the server for saving. */
export function advancedSavePatch(profile) {
  const defaults = advancedDefaultsForProfile(profile);
  return {
    headers: defaults.headers
      .map(row => ({ name: row.name.trim(), value: row.value }))
      .filter(row => row.name),
    extraBody: defaults.extraBody.trim(),
    proxyMode: defaults.proxyMode,
    proxyUrl: defaults.proxyUrl.trim(),
    maxConcurrency: Number(limitText(profile?.maxConcurrency) || 0),
    maxRpm: Number(limitText(profile?.maxRpm) || 0),
  };
}

/** True when the editor's advanced fields differ from what is saved. */
export function advancedIsDirty(editor, saved) {
  const a = advancedSavePatch(editor);
  const b = advancedSavePatch(saved);
  return JSON.stringify(a) !== JSON.stringify(b);
}

function isProxyUrl(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'socks5:', 'socks:'].includes(url.protocol) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** What is wrong with one connection's advanced fields, '' when nothing is. */
export function advancedValidationError(profile) {
  const fields = advancedDefaultsForProfile(profile);
  const named = fields.headers.filter(row => row.name.trim() || row.value.trim());
  if (named.length > MAX_HEADERS) return `一个连接最多可以设置 ${MAX_HEADERS} 个请求头。`;
  for (const row of named) {
    const name = row.name.trim();
    if (!name) return '请求头需要名称；只有值的一行会被忽略，请补上名称或删掉这一行。';
    if (!HEADER_NAME.test(name)) return `请求头“${name}”不是合法的请求头名称。`;
    if (RESERVED_HEADERS.includes(name.toLowerCase())) return `请求头 ${name} 不能在这里设置：它由连接本身决定。`;
    if (/[\r\n]/.test(row.value)) return `请求头 ${name} 的值不能包含换行。`;
    if (row.value.length > 4096) return `请求头 ${name} 的值过长。`;
  }
  const body = fields.extraBody.trim();
  if (body) {
    if (body.length > 16 * 1024) return '额外请求体过大（上限 16 KB）。';
    let parsed;
    try { parsed = JSON.parse(body); } catch { return '额外请求体不是合法的 JSON，请检查引号、逗号与括号。'; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '额外请求体必须是一个 JSON 对象，例如 ' + EXTRA_BODY_EXAMPLE + '。';
    const seen = new Set();
    for (const rawName of Object.keys(parsed)) {
      const name = (rawName.startsWith('!') ? rawName.slice(1) : rawName).trim();
      if (!name) return '额外请求体里的每个字段都需要名称。';
      if (RESERVED_FIELDS.includes(name)) return `额外请求体不能设置 ${name}：模型、流式与对话本身由程序决定。`;
      if (seen.has(name)) return `额外请求体里的 ${name} 出现了两次。`;
      seen.add(name);
    }
  }
  if (fields.proxyMode === 'custom') {
    if (!fields.proxyUrl.trim()) return '选择“自定义”代理时，请填写代理地址，例如 http://127.0.0.1:7890。';
    if (!isProxyUrl(fields.proxyUrl)) return '代理地址必须是有效的 HTTP、HTTPS 或 SOCKS5 地址，例如 http://127.0.0.1:7890。';
  }
  for (const [field, label, maximum] of [['maxConcurrency', '并发上限', MAX_CONCURRENCY], ['maxRpm', '每分钟请求数', MAX_RPM]]) {
    const text = String(fields[field] ?? '').trim();
    if (!text) continue;
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < 0 || number > maximum) return `${label}必须是 0 到 ${maximum} 之间的整数；留空表示不限制。`;
  }
  return '';
}

/** What is wrong with the app-wide proxy address, '' when nothing is. */
export function globalProxyError(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!isProxyUrl(text)) return '全局代理地址必须是有效的 HTTP、HTTPS 或 SOCKS5 地址，例如 http://127.0.0.1:7890；留空跟随系统代理。';
  return '';
}

/**
 * Builds the two pieces of interface the settings dialog shows: the 高级 block of one
 * connection, and the app-wide proxy field under 全局工作区.
 */
export function createAdvancedSettingsUI(React) {
  const h = React.createElement;

  function HeaderRow({ row, index, disabled, onRow, onRemove }) {
    return h('div', { className: 'advanced-header-row', key: index },
      h('input', {
        value: row.name, placeholder: '请求头名称', disabled, spellCheck: false, autoComplete: 'off',
        'aria-label': `第 ${index + 1} 个请求头的名称`,
        onChange: event => onRow({ ...row, name: event.target.value }),
      }),
      h('input', {
        value: row.value, placeholder: '值', disabled, spellCheck: false, autoComplete: 'off',
        'aria-label': `第 ${index + 1} 个请求头的值`,
        onChange: event => onRow({ ...row, value: event.target.value }),
      }),
      h('button', {
        type: 'button', className: 'icon-button small advanced-header-remove', disabled,
        title: '删除此请求头', 'aria-label': '删除此请求头', onClick: onRemove,
      }, h('span', { 'aria-hidden': true }, '×')),
    );
  }

  function AdvancedConnectionSettings({ profile, disabled, onChange, globalProxyUrl }) {
    const fields = advancedDefaultsForProfile(profile);
    const rows = fields.headers;
    const setRows = next => onChange('headers', next);
    const choice = PROXY_CHOICES.find(item => item.id === fields.proxyMode) || PROXY_CHOICES[0];
    const followGlobal = String(globalProxyUrl ?? '').trim();
    return h('div', { className: 'advanced-settings' },
      h('div', { className: 'settings-section-title advanced-section-title' },
        h('span', null, '高级'),
        h('span', { className: 'section-line' })),

      h('div', { className: 'field advanced-field' },
        h('span', null, '请求头'),
        rows.length
          ? h('div', { className: 'advanced-header-list' }, rows.map((row, index) => h(HeaderRow, {
            key: index, row, index, disabled,
            onRow: next => setRows(rows.map((item, at) => (at === index ? next : item))),
            onRemove: () => setRows(rows.filter((_, at) => at !== index)),
          })))
          : null,
        h('button', {
          type: 'button', className: 'text-button advanced-add-header', disabled: disabled || rows.length >= MAX_HEADERS,
          onClick: () => setRows([...rows, { name: '', value: '' }]),
        }, '+ 添加请求头'),
        h('small', null, '发给供应商的额外 HTTP 请求头，在鉴权后应用，用于需要私有鉴权方案的网关。名称留空的行会被忽略。')),

      h('label', { className: 'field advanced-field' },
        h('span', null, '额外请求体'),
        h('textarea', {
          className: 'advanced-textarea', rows: 4, value: fields.extraBody, disabled, spellCheck: false,
          placeholder: EXTRA_BODY_EXAMPLE, 'aria-label': '额外请求体 JSON',
          onChange: event => onChange('extraBody', event.target.value),
        }),
        h('small', null,
          '加进发往供应商的每个请求体里的 JSON 字段。请求里已有的字段会保留；写成 "!name" 则替换它。',
          ' ${sessionId} 是会话的 ID，${threadId} 是同一会话的线程，${subagentId} 是子代理的 ID（主对话为空）。')),

      h('div', { className: 'field advanced-field' },
        h('span', null, '代理'),
        h('div', { className: 'tool-round-options advanced-proxy-choices' }, PROXY_CHOICES.map(item => h('label', {
          key: item.id, className: `tool-round-choice${fields.proxyMode === item.id ? ' selected' : ''}`, title: item.hint,
        },
        h('input', {
          type: 'radio', name: `advanced_proxy_${profile?.id ?? 'connection'}`, checked: fields.proxyMode === item.id, disabled,
          onChange: () => onChange('proxyMode', item.id),
        }),
        h('span', null, item.label)))),
        fields.proxyMode === 'custom'
          ? h('input', {
            value: fields.proxyUrl, placeholder: 'http://127.0.0.1:7890', disabled, spellCheck: false, autoComplete: 'off',
            'aria-label': '自定义代理地址', onChange: event => onChange('proxyUrl', event.target.value),
          })
          : null,
        h('small', null, fields.proxyMode === 'global'
          ? (followGlobal ? `跟随设置里的代理：${followGlobal}` : '跟随设置里的代理；全局代理留空时跟随系统代理（桌面版）。')
          : fields.proxyMode === 'direct' ? '这个连接不经过任何代理。' : '只让这个连接走上面填写的代理；保存后对下一条消息生效。请确认端口与代理软件一致。')),

      h('label', { className: 'field advanced-field' },
        h('span', null, '并发上限'),
        h('input', {
          className: 'advanced-limit', type: 'number', min: 0, max: MAX_CONCURRENCY, step: 1,
          value: fields.maxConcurrency, placeholder: '不限制', disabled,
          'aria-label': '并发上限', onChange: event => onChange('maxConcurrency', event.target.value),
        }),
        h('small', null, '超出的请求会按顺序排队，不会直接失败；0 或留空为不限制。')),

      h('label', { className: 'field advanced-field' },
        h('span', null, '每分钟请求数'),
        h('input', {
          className: 'advanced-limit', type: 'number', min: 0, max: MAX_RPM, step: 1,
          value: fields.maxRpm, placeholder: '不限制', disabled,
          'aria-label': '每分钟请求数', onChange: event => onChange('maxRpm', event.target.value),
        }),
        h('small', null, '任意一分钟内最多发出的请求数，超出的请求会等到有空位再发；0 或留空为不限制。')),
    );
  }

  function GlobalProxyField({ value, disabled, onChange }) {
    return h('label', { className: 'field' },
      h('span', null, '全局代理'),
      h('input', {
        value: value ?? '', placeholder: 'http://127.0.0.1:7890', disabled, spellCheck: false, autoComplete: 'off',
        'aria-label': '全局代理地址', onChange: event => onChange(event.target.value),
      }),
      h('small', null, '连接选择「全局代理」时使用；留空跟随系统代理（桌面版）；无系统代理时直连。支持 HTTP、HTTPS 与 SOCKS5，可带账号密码。'));
  }

  return { AdvancedConnectionSettings, GlobalProxyField };
}
