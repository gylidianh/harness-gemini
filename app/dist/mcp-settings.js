/**
 * 1.9.9: 「MCP」设置分区。
 *
 * 支持跨厂商通用 Model Context Protocol 服务：
 * - Streamable HTTP（远程 JSON-RPC / SSE，自动处理 initialize 会话与无状态回退）
 * - 本地 stdio（本机子进程 npx / uvx / node / python 等，随服务关闭自动回收进程树）
 *
 * 密钥与敏感环境变量由后端加密落盘，前端仅接收掩码；面板独立注入样式表，不改动受保护的 index.html。
 */

const STYLE_HREF = '/mcp-settings.css';

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[data-harness="${STYLE_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.harness = STYLE_HREF;
  document.head.appendChild(link);
}

export function emptyMcpDraft(overrides = {}) {
  return {
    id: '',
    name: '',
    description: '',
    transport: 'http',
    enabled: true,
    readOnly: false,
    trustReadOnlyHints: false,
    timeoutMs: '60000',
    preset: '',
    endpoint: '',
    allowInsecureHttp: false,
    authType: 'none',
    authHeader: '',
    apiKey: '',
    clearApiKey: false,
    hasApiKey: false,
    apiKeyEnv: '',
    stateless: false,
    headersText: '',
    command: '',
    argsText: '',
    cwd: '',
    envText: '',
    ...overrides,
  };
}

export function serverToDraft(server) {
  return emptyMcpDraft({
    id: server.id || '',
    name: server.name || '',
    description: server.description || '',
    transport: server.transport === 'stdio' ? 'stdio' : 'http',
    enabled: server.enabled !== false,
    readOnly: server.readOnly === true,
    trustReadOnlyHints: server.trustReadOnlyHints === true,
    timeoutMs: String(server.timeoutMs || 60000),
    preset: server.preset || '',
    endpoint: server.endpoint || '',
    allowInsecureHttp: server.allowInsecureHttp === true,
    authType: server.authType || 'none',
    authHeader: server.authHeader || '',
    apiKey: server.apiKey || '',
    clearApiKey: false,
    hasApiKey: server.hasApiKey === true,
    apiKeyEnv: server.apiKeyEnv || '',
    stateless: server.stateless === true,
    headersText: Array.isArray(server.headers)
      ? server.headers.map(h => `${h.name}: ${h.value ?? ''}`).join('\n')
      : '',
    command: server.command || '',
    argsText: Array.isArray(server.args) ? server.args.join('\n') : '',
    cwd: server.cwd || '',
    envText: Array.isArray(server.env)
      ? server.env.map(e => `${e.name}=${e.value ?? ''}`).join('\n')
      : '',
  });
}

export function draftToPayload(draft, { sync = false } = {}) {
  const rawTimeout = String(draft.timeoutMs ?? '').trim();
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : 60000;
  const base = {
    name: (draft.name || '').trim(),
    description: (draft.description || '').trim(),
    transport: draft.transport === 'stdio' ? 'stdio' : 'http',
    enabled: draft.enabled !== false,
    readOnly: draft.readOnly === true,
    trustReadOnlyHints: draft.trustReadOnlyHints === true,
    timeoutMs: Number.isFinite(parsedTimeout) ? Math.round(parsedTimeout) : 60000,
    preset: draft.preset || '',
    sync: sync === true,
  };
  if (base.transport === 'http') {
    const authType = draft.authType || 'none';
    const hasAuth = authType !== 'none';
    const headers = String(draft.headersText || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    return {
      ...base,
      endpoint: (draft.endpoint || '').trim(),
      allowInsecureHttp: draft.allowInsecureHttp === true,
      authType,
      authHeader: authType === 'custom-header' ? (draft.authHeader || '').trim() : '',
      apiKey: (!hasAuth || draft.clearApiKey) ? '' : (draft.apiKey || '').trim(),
      clearApiKey: !hasAuth ? true : draft.clearApiKey === true,
      apiKeyEnv: hasAuth ? (draft.apiKeyEnv || '').trim() : '',
      stateless: draft.stateless === true,
      headers,
    };
  }
  const args = String(draft.argsText ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const env = String(draft.envText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return {
    ...base,
    command: (draft.command || '').trim(),
    args,
    cwd: (draft.cwd || '').trim(),
    env,
  };
}

const STATUS_META = {
  ready: { label: '已就绪', tone: 'ready' },
  error: { label: '连接异常', tone: 'error' },
  needs_sync: { label: '待同步工具', tone: '' },
  disabled: { label: '已停用', tone: '' },
};

const IMPORT_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"]
    },
    "hsciq": {
      "url": "https://www.hsciq.com/mcp/rpc",
      "headers": { "X-API-Key": "在此填写密钥" }
    }
  }
}`;

export function createMcpSettingsPanel(React) {
  const h = React.createElement;

  function EditorCard({ draft, busy, actions }) {
    const isHttp = draft.transport !== 'stdio';
    const editing = Boolean(draft.id);
    return h('div', { className: 'mcp-panel-box', role: 'region', 'aria-label': editing ? '编辑 MCP 服务' : '添加 MCP 服务' },
      h('div', { className: 'mcp-panel-head' },
        h('strong', null, editing ? `编辑 MCP 服务：${draft.name || '未命名'}` : '添加 MCP 服务'),
        draft.preset === 'hsciq' && h('span', { className: 'mcp-badge accent' }, 'HSCIQ 官方预设')),

      h('div', { className: 'mcp-transport-tabs', role: 'group', 'aria-label': '传输方式' },
        h('button', {
          type: 'button',
          className: `mcp-transport-tab${isHttp ? ' active' : ''}`,
          'aria-pressed': isHttp,
          disabled: !!busy,
          onClick: () => actions.setDraftField('transport', 'http'),
        }, h('strong', null, 'Streamable HTTP（远程服务）'), h('small', null, '标准 HTTP/SSE MCP 网关、SaaS 厂商与 HSCIQ')),
        h('button', {
          type: 'button',
          className: `mcp-transport-tab${!isHttp ? ' active' : ''}`,
          'aria-pressed': !isHttp,
          disabled: !!busy,
          onClick: () => actions.setDraftField('transport', 'stdio'),
        }, h('strong', null, '本地 stdio（本机进程）'), h('small', null, '通过 npx、uvx、node、python 启动本地 MCP'))),

      h('div', { className: 'mcp-grid-2' },
        h('label', { className: 'mcp-field' },
          h('span', null, '服务名称'),
          h('input', {
            type: 'text',
            value: draft.name,
            maxLength: 80,
            placeholder: isHttp ? '例如：HSCIQ 海关归类 / GitHub MCP' : '例如：Filesystem / Playwright',
            onChange: e => actions.setDraftField('name', e.target.value),
          })),
        h('label', { className: 'mcp-field' },
          h('span', null, '单次超时（毫秒）'),
          h('input', {
            type: 'number',
            min: 1000,
            max: 600000,
            step: 1000,
            value: draft.timeoutMs,
            onChange: e => actions.setDraftField('timeoutMs', e.target.value),
          }))),

      isHttp
        ? h(React.Fragment, null,
          h('label', { className: 'mcp-field' },
            h('span', null, 'MCP Endpoint 地址（HTTPS）'),
            h('input', {
              type: 'text',
              value: draft.endpoint,
              placeholder: 'https://example.com/mcp 或 https://www.hsciq.com/mcp/rpc',
              onChange: e => actions.setDraftField('endpoint', e.target.value),
            }),
            h('small', null, '自动完成标准 MCP initialize 会话协商与 Mcp-Session-Id 跟踪；遇到无状态网关自动回退直连。')),

          h('div', { className: 'mcp-grid-2' },
            h('label', { className: 'mcp-field' },
              h('span', null, '认证方式'),
              h('select', {
                value: draft.authType,
                onChange: e => actions.setDraftField('authType', e.target.value),
              },
                h('option', { value: 'none' }, '无需认证'),
                h('option', { value: 'bearer' }, 'Authorization: Bearer'),
                h('option', { value: 'x-api-key' }, 'X-API-Key 请求头'),
                h('option', { value: 'custom-header' }, '自定义认证请求头'))),

            draft.authType === 'custom-header'
              ? h('label', { className: 'mcp-field' },
                h('span', null, '自定义请求头名称'),
                h('input', {
                  type: 'text',
                  value: draft.authHeader,
                  placeholder: '例如：X-MCP-Token',
                  onChange: e => actions.setDraftField('authHeader', e.target.value),
                }))
              : draft.authType !== 'none' && h('label', { className: 'mcp-field' },
                h('span', null, '或从环境变量读取密钥（可选）'),
                h('input', {
                  type: 'text',
                  value: draft.apiKeyEnv,
                  placeholder: '例如：HSCIQ_API_KEY（留空则用下方已存密钥）',
                  onChange: e => actions.setDraftField('apiKeyEnv', e.target.value),
                }))),

          draft.authType === 'custom-header' && h('label', { className: 'mcp-field' },
            h('span', null, '或从环境变量读取密钥（可选）'),
            h('input', {
              type: 'text',
              value: draft.apiKeyEnv,
              placeholder: '例如：HSCIQ_API_KEY（留空则用下方已存密钥）',
              onChange: e => actions.setDraftField('apiKeyEnv', e.target.value),
            })),

          draft.authType !== 'none' && h('label', { className: 'mcp-field' },
            h('span', null, 'API 密钥 / Token（加密存储）'),
            h('input', {
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              value: draft.clearApiKey ? '' : draft.apiKey,
              placeholder: draft.hasApiKey ? '已加密保存，留空或保持掩码不变' : '粘贴密钥（留空则使用上方环境变量）',
              onChange: e => {
                actions.setDraftField('clearApiKey', false);
                actions.setDraftField('apiKey', e.target.value);
              },
            }),
            draft.hasApiKey && h('small', null,
              draft.clearApiKey ? '保存后将清除已存密钥。' : '当前已保存密钥（仅显示掩码）。',
              ' ',
              h('button', {
                type: 'button',
                className: 'text-button',
                onClick: () => actions.setDraftField('clearApiKey', !draft.clearApiKey),
              }, draft.clearApiKey ? '撤销清除' : '清除已存密钥'))),

          h('label', { className: 'mcp-field' },
            h('span', null, '额外 HTTP 请求头（可选，每行 Name: Value）'),
            h('textarea', {
              value: draft.headersText,
              placeholder: 'X-Workspace-Id: demo\nX-Custom-Version: 2025-03-26',
              onChange: e => actions.setDraftField('headersText', e.target.value),
            })))
        : h(React.Fragment, null,
          h('div', { className: 'mcp-grid-2' },
            h('label', { className: 'mcp-field' },
              h('span', null, '启动命令（Command）'),
              h('input', {
                type: 'text',
                value: draft.command,
                placeholder: '例如：npx、uvx、node、python',
                onChange: e => actions.setDraftField('command', e.target.value),
              })),
            h('label', { className: 'mcp-field' },
              h('span', null, '进程工作目录（可选）'),
              h('input', {
                type: 'text',
                value: draft.cwd,
                placeholder: '留空默认使用当前会话工作目录',
                onChange: e => actions.setDraftField('cwd', e.target.value),
              }))),

          h('label', { className: 'mcp-field' },
            h('span', null, '启动参数（Args，每行一个参数）'),
            h('textarea', {
              value: draft.argsText,
              placeholder: '-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\Public',
              onChange: e => actions.setDraftField('argsText', e.target.value),
            }),
            h('small', null, 'Windows 下自动兼容 npx / npm (.cmd) 与可执行程序，不经过不安全的 shell 拼接。')),

          h('label', { className: 'mcp-field' },
            h('span', null, '进程环境变量（可选，每行 KEY=VALUE）'),
            h('textarea', {
              value: draft.envText,
              placeholder: 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...\nLOG_LEVEL=info',
              onChange: e => actions.setDraftField('envText', e.target.value),
            }),
            h('small', null, '包含 KEY / TOKEN / SECRET / PASSWORD 等敏感名称的变量将自动加密保存并脱敏。'))),

      h('label', { className: 'mcp-field' },
        h('span', null, '备注说明（可选）'),
        h('input', {
          type: 'text',
          value: draft.description,
          maxLength: 500,
          placeholder: '帮助区分用途，例如：查询海关编码与申报要素',
          onChange: e => actions.setDraftField('description', e.target.value),
        })),

      h('div', { className: 'mcp-checks' },
        h('label', { className: 'mcp-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.readOnly === true,
            onChange: e => actions.setDraftField('readOnly', e.target.checked),
          }),
          h('span', null, '设为只读服务',
            h('small', null, '允许在只读「聊天」模式中提供，并在「帮我批准」模式下免弹窗运行。仅对确认无副作用的服务勾选。'))),
        isHttp && h('label', { className: 'mcp-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.trustReadOnlyHints === true,
            onChange: e => actions.setDraftField('trustReadOnlyHints', e.target.checked),
          }),
          h('span', null, '信任服务端 readOnlyHint 工具注解',
            h('small', null, '开启后，远程服务标记为 readOnlyHint=true 的查询工具按只读工具治理（HSCIQ 预设已内置白名单，无需勾选）。'))),
        isHttp && h('label', { className: 'mcp-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.stateless === true,
            onChange: e => actions.setDraftField('stateless', e.target.checked),
          }),
          h('span', null, '无状态直连模式（跳过 initialize 握手）',
            h('small', null, '适用于 HSCIQ 等纯无状态 JSON-RPC 端点；未勾选时遇到不支持握手的网关也会自动回退。'))),
        isHttp && h('label', { className: 'mcp-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.allowInsecureHttp === true,
            onChange: e => actions.setDraftField('allowInsecureHttp', e.target.checked),
          }),
          h('span', null, '允许非本机明文 HTTP（仅限受信任内网自建服务）',
            h('small', null, '默认远程地址强制要求 HTTPS；127.0.0.1 / localhost 本机调试无需勾选。')))),

      h('div', { className: 'mcp-editor-actions' },
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: actions.cancelEdit,
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: () => actions.saveDraft(false),
        }, busy === 'save' ? '保存中…' : '仅保存'),
        h('button', {
          type: 'button',
          className: 'button mcp-primary-btn',
          disabled: !!busy,
          onClick: () => actions.saveDraft(true),
        }, busy === 'save-sync' ? '正在连接并同步工具…' : '保存并同步工具')));
  }

  function ImportCard({ importText, busy, actions }) {
    return h('div', { className: 'mcp-panel-box', role: 'region', 'aria-label': '导入 MCP JSON 配置' },
      h('div', { className: 'mcp-panel-head' },
        h('strong', null, '导入标准 mcpServers JSON 配置')),
      h('label', { className: 'mcp-field' },
        h('span', null, '兼容 Claude Desktop、Cursor、VS Code (.vscode/mcp.json)、Windsurf、Cline 等通用格式'),
        h('textarea', {
          value: importText,
          rows: 9,
          placeholder: IMPORT_EXAMPLE,
          onChange: e => actions.setImportText(e.target.value),
        }),
        h('small', null, '同名服务将按新配置更新；包含 Authorization / X-API-Key 或敏感环境变量的字段会自动提取并加密保存。')),
      h('div', { className: 'mcp-editor-actions' },
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: actions.closeImport,
        }, '收起'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy || !String(importText || '').trim(),
          onClick: () => actions.submitImport(false),
        }, busy === 'import' ? '导入中…' : '仅导入配置'),
        h('button', {
          type: 'button',
          className: 'button mcp-primary-btn',
          disabled: !!busy || !String(importText || '').trim(),
          onClick: () => actions.submitImport(true),
        }, busy === 'import-sync' ? '导入并连接中…' : '导入并同步工具')));
  }

  function ServerCard({ server, busy, confirmingDelete, actions }) {
    const statusInfo = STATUS_META[server.status] || STATUS_META.needs_sync;
    const isBusy = Boolean(busy);
    const targetText = server.transport === 'stdio'
      ? [server.command, ...(server.args || [])].join(' ')
      : server.endpoint;
    const authHint = server.transport === 'http'
      ? (server.authType === 'none'
        ? '无认证'
        : server.hasApiKey
          ? `${server.authType} · 已保存密钥 (${server.apiKey})`
          : server.apiKeyEnv
            ? `${server.authType} · 环境变量 ${server.apiKeyEnv}`
            : `${server.authType} · 待填密钥`)
      : (server.env?.length ? `${server.env.length} 个环境变量` : '默认环境');

    return h('li', { className: `mcp-card${server.enabled ? '' : ' off'}` },
      h('div', { className: 'mcp-card-head' },
        h('strong', { className: 'mcp-card-title', title: server.name }, server.name),
        h('span', { className: 'mcp-badge accent' }, server.transport === 'stdio' ? '本地 stdio' : 'HTTP'),
        server.preset === 'hsciq' && h('span', { className: 'mcp-badge accent' }, 'HSCIQ'),
        h('span', { className: 'mcp-badge' }, server.readOnly ? '只读' : `只读 ${server.readOnlyToolCount}/${server.enabledToolCount}`),
        h('span', { className: `mcp-badge${statusInfo.tone ? ` ${statusInfo.tone}` : ''}` },
          server.status === 'ready' ? `${statusInfo.label} · ${server.enabledToolCount} 工具` : statusInfo.label),
        h('label', { className: 'skill-toggle', title: '切换是否向模型启用该 MCP 服务' },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            checked: server.enabled === true,
            disabled: isBusy,
            'aria-label': `启用 ${server.name}`,
            onChange: e => actions.toggleServer(server.id, e.target.checked),
          }),
          h('span', null, busy === `toggle:${server.id}` ? '保存中' : server.enabled ? '已启用' : '已停用'))),

      h('p', { className: 'mcp-card-target' }, `${targetText}  ·  ${authHint}`),
      server.description && h('p', { className: 'mcp-card-desc' }, server.description),
      server.lastSyncError && h('p', { className: 'field-error', role: 'alert' }, `同步异常：${server.lastSyncError}`),

      h('div', { className: 'mcp-card-actions' },
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: isBusy,
          onClick: () => actions.syncServer(server.id),
        }, busy === `sync:${server.id}` ? '正在同步工具…' : '测试并同步工具'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: isBusy,
          onClick: () => actions.startEdit(server),
        }, '编辑'),
        confirmingDelete === server.id
          ? h(React.Fragment, null,
            h('button', {
              type: 'button',
              className: 'button button-quiet danger',
              disabled: isBusy,
              onClick: () => actions.deleteServer(server.id),
            }, busy === `delete:${server.id}` ? '删除中…' : '确认删除？'),
            h('button', {
              type: 'button',
              className: 'button button-quiet',
              disabled: isBusy,
              onClick: actions.clearConfirm,
            }, '取消'))
          : h('button', {
            type: 'button',
            className: 'button button-quiet danger',
            disabled: isBusy,
            onClick: () => actions.confirmDelete(server.id),
          }, '删除')),

      Array.isArray(server.tools) && server.tools.length > 0 && h('details', { className: 'mcp-tools-details' },
        h('summary', null, `已发现 ${server.tools.length} 个工具（已启用 ${server.enabledToolCount} 个）`),
        h('ul', { className: 'mcp-tools-grid' }, server.tools.map(tool => h('li', { key: tool.name, className: 'mcp-tool-item' },
          h('div', { className: 'mcp-tool-copy' },
            h('code', null, `${tool.name}  →  ${tool.exposedName}`),
            h('span', null, tool.description)),
          h('div', { className: 'mcp-tool-controls' },
            h('span', { className: `mcp-badge${tool.readOnly ? ' ready' : ''}` }, tool.readOnly ? '只读' : '需审批'),
            !server.readOnly && server.preset !== 'hsciq' && h('label', { title: '将此工具标记为只读（可在聊天模式使用）' },
              h('input', {
                type: 'checkbox',
                checked: (server.readOnlyTools || []).includes(tool.name),
                disabled: isBusy,
                onChange: e => actions.toggleToolReadOnly(server, tool.name, e.target.checked),
              }),
              '只读'),
            h('label', { title: '是否向模型公开此工具' },
              h('input', {
                type: 'checkbox',
                checked: tool.enabled !== false,
                disabled: isBusy,
                onChange: e => actions.toggleToolEnabled(server, tool.name, e.target.checked),
              }),
              '启用')))))));
  }

  function McpSettingsView({ servers = [], draft = null, showImport = false, importText = '', busy = '', error = '', notice = '', confirmingDelete = '', actions }) {
    const enabledServers = servers.filter(s => s.enabled);
    const activeTools = enabledServers.reduce((sum, s) => sum + (s.enabledToolCount || 0), 0);

    return h('div', { className: 'mcp-settings' },
      h('p', { className: 'mcp-intro' },
        '连接任意厂商符合 Model Context Protocol 标准的远程 Streamable HTTP 服务或本地 stdio 工具进程。',
        '已同步的工具将以 mcp__<服务>__<工具> 形式提供给模型：只读「聊天」模式仅暴露只读工具，「编程」模式按当前权限模式（请求批准 / 帮我批准 / 完全访问）严格治理。'),

      h('div', { className: 'mcp-toolbar' },
        h('button', {
          type: 'button',
          className: 'button mcp-primary-btn',
          disabled: !!busy,
          onClick: actions.startCreate,
        }, '+ 添加 MCP 服务'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: actions.startHsciqPreset,
        }, '+ 添加 HSCIQ 海关预设'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: actions.openImport,
        }, '导入 mcpServers JSON'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          disabled: !!busy,
          onClick: actions.refresh,
        }, busy === 'refresh' ? '读取中…' : '刷新'),
        h('span', { className: 'mcp-summary-stat', role: 'status' },
          `已启用 ${enabledServers.length} / ${servers.length} 个服务 · 共 ${activeTools} 个可用工具`)),

      error && h('p', { className: 'field-error', role: 'alert' }, error),
      notice && h('p', { className: 'mcp-notice', role: 'status' }, notice),

      draft && h(EditorCard, { draft, busy, actions }),
      showImport && h(ImportCard, { importText, busy, actions }),

      servers.length === 0 && !draft && !showImport
        ? h('div', { className: 'mcp-empty' },
          h('strong', null, '还没有添加 MCP 服务'),
          h('span', null, '点击上方「+ 添加 MCP 服务」配置远程 Streamable HTTP 或本地 stdio 进程，或点「导入 mcpServers JSON」直接粘贴 Claude / Cursor / VS Code 的配置片段，也可一键添加 HSCIQ 海关服务。'))
        : h('ul', { className: 'mcp-list' }, servers.map(server => h(ServerCard, {
          key: server.id,
          server,
          busy,
          confirmingDelete,
          actions,
        }))));
  }

  function McpSettings({ disabled }) {
    const [state, setState] = React.useState({
      loading: true,
      servers: [],
      draft: null,
      showImport: false,
      importText: '',
      busy: '',
      error: '',
      notice: '',
      confirmingDelete: '',
    });
    const alive = React.useRef(false);

    const requestJson = async (url, options = {}) => {
      const response = await fetch(url, {
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        ...options,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || body?.error || `请求未完成（${response.status}）`);
      return body;
    };

    const refresh = async () => {
      setState(s => ({ ...s, busy: 'refresh', error: '' }));
      try {
        const data = await requestJson('/api/mcp/servers', { method: 'GET', headers: {} });
        if (alive.current) setState(s => ({ ...s, loading: false, busy: '', servers: data.servers || [], error: '' }));
      } catch (error) {
        if (alive.current) setState(s => ({ ...s, loading: false, busy: '', error: error.message }));
      }
    };

    React.useEffect(() => {
      alive.current = true;
      void refresh();
      return () => { alive.current = false; };
    }, []);

    const actions = {
      refresh: () => { if (!disabled) void refresh(); },
      startCreate: () => setState(s => ({ ...s, draft: emptyMcpDraft(), showImport: false, error: '', notice: '', confirmingDelete: '' })),
      startHsciqPreset: () => setState(s => ({
        ...s,
        showImport: false,
        error: '',
        notice: '已填充 HSCIQ 官方参数，请填写 API 密钥（或设置环境变量 HSCIQ_API_KEY）后点「保存并同步工具」。',
        confirmingDelete: '',
        draft: emptyMcpDraft({
          name: 'HSCIQ 海关编码与归类',
          description: '官方海关编码、税率、申报要素、归类实例、总署公告与船司公告查询及智能归类',
          transport: 'http',
          endpoint: 'https://www.hsciq.com/mcp/rpc',
          authType: 'x-api-key',
          apiKeyEnv: 'HSCIQ_API_KEY',
          stateless: true,
          preset: 'hsciq',
        }),
      })),
      startEdit: server => setState(s => ({ ...s, draft: serverToDraft(server), showImport: false, error: '', notice: '', confirmingDelete: '' })),
      cancelEdit: () => setState(s => ({ ...s, draft: null, error: '' })),
      setDraftField: (field, value) => setState(s => s.draft ? ({ ...s, draft: { ...s.draft, [field]: value } }) : s),
      openImport: () => setState(s => ({ ...s, showImport: true, draft: null, error: '', notice: '', confirmingDelete: '' })),
      closeImport: () => setState(s => ({ ...s, showImport: false, error: '' })),
      setImportText: text => setState(s => ({ ...s, importText: text })),
      confirmDelete: id => setState(s => ({ ...s, confirmingDelete: id, error: '', notice: '' })),
      clearConfirm: () => setState(s => ({ ...s, confirmingDelete: '' })),

      saveDraft: async sync => {
        if (disabled || !state.draft) return;
        const editingId = state.draft.id;
        setState(s => ({ ...s, busy: sync ? 'save-sync' : 'save', error: '', notice: '' }));
        try {
          const payload = draftToPayload(state.draft, { sync });
          const data = await requestJson(
            editingId ? `/api/mcp/servers/${encodeURIComponent(editingId)}` : '/api/mcp/servers',
            { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) },
          );
          if (!alive.current) return;
          const syncFailed = sync && data.ok === false;
          setState(s => ({
            ...s,
            busy: '',
            servers: data.servers || s.servers,
            draft: syncFailed ? serverToDraft(data.server) : null,
            error: syncFailed ? `配置已保存，但同步工具失败：${data.error}` : '',
            notice: syncFailed ? '' : (sync ? `已保存并同步 ${data.server?.toolCount ?? 0} 个工具。` : 'MCP 服务配置已保存。'),
          }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      submitImport: async sync => {
        if (disabled) return;
        setState(s => ({ ...s, busy: sync ? 'import-sync' : 'import', error: '', notice: '' }));
        try {
          const data = await requestJson('/api/mcp/import', {
            method: 'POST',
            body: JSON.stringify({ config: state.importText, sync }),
          });
          if (!alive.current) return;
          setState(s => ({
            ...s,
            busy: '',
            servers: data.servers || s.servers,
            showImport: false,
            importText: '',
            notice: `已成功导入 ${data.imported ?? 0} 个 MCP 服务${sync ? '并尝试同步工具' : ''}。`,
          }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      toggleServer: async (id, enabled) => {
        if (disabled) return;
        setState(s => ({ ...s, busy: `toggle:${id}`, error: '', notice: '' }));
        try {
          const data = await requestJson(`/api/mcp/servers/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
          });
          if (!alive.current) return;
          setState(s => ({
            ...s,
            busy: '',
            servers: data.servers || s.servers,
            error: data.ok === false ? `已切换状态，但同步工具失败：${data.error}` : '',
            notice: data.ok === false ? '' : (enabled ? 'MCP 服务已启用。' : 'MCP 服务已停用。'),
          }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      syncServer: async id => {
        if (disabled) return;
        setState(s => ({ ...s, busy: `sync:${id}`, error: '', notice: '' }));
        try {
          const data = await requestJson(`/api/mcp/servers/${encodeURIComponent(id)}/sync`, {
            method: 'POST',
            body: '{}',
          });
          if (!alive.current) return;
          setState(s => ({
            ...s,
            busy: '',
            servers: data.servers || s.servers,
            error: data.ok === false ? `连接或读取工具失败：${data.error}` : '',
            notice: data.ok === false ? '' : `同步成功：共发现 ${data.server?.toolCount ?? 0} 个工具。`,
          }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      deleteServer: async id => {
        if (disabled) return;
        setState(s => ({ ...s, busy: `delete:${id}`, error: '', notice: '' }));
        try {
          const data = await requestJson(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (!alive.current) return;
          setState(s => ({
            ...s,
            busy: '',
            confirmingDelete: '',
            servers: data.servers || [],
            draft: s.draft?.id === id ? null : s.draft,
            notice: '已删除该 MCP 服务。',
          }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      toggleToolEnabled: async (server, toolName, enabled) => {
        if (disabled) return;
        const current = new Set(server.disabledTools || []);
        if (enabled) current.delete(toolName);
        else current.add(toolName);
        setState(s => ({ ...s, busy: `tool:${server.id}`, error: '' }));
        try {
          const data = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ disabledTools: [...current] }),
          });
          if (alive.current) setState(s => ({ ...s, busy: '', servers: data.servers || s.servers }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },

      toggleToolReadOnly: async (server, toolName, readOnly) => {
        if (disabled) return;
        const current = new Set(server.readOnlyTools || []);
        if (readOnly) current.add(toolName);
        else current.delete(toolName);
        setState(s => ({ ...s, busy: `tool:${server.id}`, error: '' }));
        try {
          const data = await requestJson(`/api/mcp/servers/${encodeURIComponent(server.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ readOnlyTools: [...current] }),
          });
          if (alive.current) setState(s => ({ ...s, busy: '', servers: data.servers || s.servers }));
        } catch (error) {
          if (alive.current) setState(s => ({ ...s, busy: '', error: error.message }));
        }
      },
    };

    ensureStylesheet();
    if (state.loading) {
      return h('div', { className: 'mcp-settings' },
        h('p', { className: 'mcp-intro' }, '正在读取 MCP 服务列表…'),
        state.error && h('p', { className: 'field-error', role: 'alert' }, state.error));
    }
    return h(McpSettingsView, {
      servers: state.servers,
      draft: state.draft,
      showImport: state.showImport,
      importText: state.importText,
      busy: state.busy,
      error: state.error,
      notice: state.notice,
      confirmingDelete: state.confirmingDelete,
      actions,
    });
  }

  return { McpSettings, McpSettingsView };
}
