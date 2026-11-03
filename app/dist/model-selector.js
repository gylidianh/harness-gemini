import { PROVIDER_BRANDS } from './provider-brand-data.js';

const MODEL_FIELDS = Object.freeze({ chat: 'chatModel', agent: 'agentModel', image: 'imageModel', video: 'videoModel' });
const MODE_LABELS = Object.freeze({ chat: '聊天', agent: '编程', image: '生图', video: '视频' });

export function validModel(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

export function modelChoices(profile, models) {
  const saved = Object.values(MODEL_FIELDS).map(field => profile?.[field]);
  const remote = Array.isArray(models) ? models.map(model => model?.id) : [];
  const candidates = profile?.modelVisibility === 'selected' ? profile.selectedModels || [] : [...saved, ...remote];
  return [...new Set(candidates.filter(validModel).map(value => value.trim()))];
}

export function modelPatch(mode, model) {
  if (!Object.hasOwn(MODEL_FIELDS, mode) || !validModel(model)) throw new Error('请选择有效的模型名称。');
  return { [MODEL_FIELDS[mode]]: model.trim() };
}

export function connectionModelPatch(mode, model, profileId) {
  if (typeof profileId !== 'string' || !profileId.trim()) throw new Error('请选择有效的供应商连接。');
  return { activeProfileId: profileId, ...modelPatch(mode, model) };
}

export function modelPopoverPosition(rect, viewportWidth, viewportHeight, bounds) {
  const hasBounds = Boolean(bounds && Number.isFinite(bounds.left) && Number.isFinite(bounds.right) && (bounds.right - bounds.left) >= 280);
  const minLeft = hasBounds ? Math.max(12, Math.round(bounds.left + 12)) : 12;
  const maxRight = hasBounds ? Math.min(viewportWidth - 12, Math.round(bounds.right - 12)) : Math.max(12, viewportWidth - 12);
  const availableWidth = Math.max(0, maxRight - minLeft);
  const minimumWidth = Math.min(320, availableWidth);
  const width = hasBounds
    ? Math.min(480, availableWidth)
    : Math.min(480, availableWidth, Math.max(minimumWidth, maxRight - (rect.left ?? 0)));
  const topInset = bounds && Number.isFinite(bounds.topInset) ? Math.max(0, bounds.topInset) : 0;
  const above = Math.max(0, (rect.top ?? 0) - topInset - 20);
  const below = Math.max(0, viewportHeight - (rect.bottom ?? 0) - 20);
  const openAbove = above > below;
  return {
    width,
    left: Math.max(minLeft, Math.min(rect.left ?? minLeft, maxRight - width)),
    ...(openAbove ? { bottom: viewportHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
    maxHeight: Math.min(560, openAbove ? above : below),
  };
}

export async function saveModelSettings(api, patch) {
  try {
    const saved = await api.saveSettings(patch);
    return Array.isArray(saved?.profiles) ? saved : await api.settings();
  } catch (cause) {
    const error = new Error(cause?.message || '无法保存模型配置。');
    let settings;
    try { settings = await api.settings(); }
    catch { error.uncertain = true; throw error; }
    if (Object.entries(patch).every(([field, value]) => settings[field] === value)) return settings;
    error.settings = settings;
    throw error;
  }
}

export function providerAppearance(profile) {
  let host = '';
  try { host = new URL(profile?.baseUrl).hostname; } catch {}
  const name = profile?.name || '';
  const brands = [
    ['deepseek', /(^|\.)deepseek\.com$/i, /deepseek/i, 'D'],
    ['claude', /(^|\.)anthropic\.com$/i, /anthropic|claude/i, 'A'],
    ['gemini', /(^|\.)(googleapis\.com|google\.com)$/i, /gemini|google/i, 'G'],
    ['openai', /(^|\.)openai\.com$/i, /openai|(?:^|\/)gpt[- /]/i, 'O'],
    ['openrouter', /(^|\.)openrouter\.ai$/i, /openrouter/i, 'R'],
    ['qwen', /(^|\.)aliyuncs\.com$/i, /qwen|通义|千问/i, 'Q'],
    ['kimi', /(^|\.)moonshot\.(cn|ai)$/i, /moonshot|kimi/i, 'K'],
  ];
  const found = brands.find(([, domain]) => domain.test(host)) || brands.find(([, , pattern]) => pattern.test(name));
  return { kind: found?.[0] || 'custom', mark: found?.[3] || [...name.trim()][0]?.toUpperCase() || 'C', host };
}

export function createProviderIcon(React) {
  const h = React.createElement;
  function renderBrand([tag, attributes, children], scope, key = 'root') {
    const props = { ...attributes, key };
    // Repeated Gemini icons must not share gradient IDs across hidden panels.
    if (props.id) props.id = `${scope}-${props.id}`;
    if (props.fill?.startsWith('url(#')) props.fill = props.fill.replace('url(#', `url(#${scope}-`);
    if (tag === 'svg') Object.assign(props, { width: 24, height: 24, 'aria-hidden': true, focusable: false });
    return h(tag, props, children.map((child, index) => renderBrand(child, scope, index)));
  }
  function ProviderIcon({ profile, grid = false }) {
    const scope = `provider-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const brand = providerAppearance(profile);
    const svg = (children, props = {}) => h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, ...props }, children);
    let content = brand.mark;
    if (grid) content = svg([2, 13].flatMap(x => [2, 13].map(y => h('rect', { key: `${x}-${y}`, x, y, width: 8, height: 8, rx: 1.5 }))));
    else if (PROVIDER_BRANDS[brand.kind]) content = renderBrand(PROVIDER_BRANDS[brand.kind], scope);
    return h('span', { className: `model-provider-icon provider-${grid ? 'all' : brand.kind}`, 'aria-hidden': true }, content);
  }
  return ProviderIcon;
}

// Reuse the bundled React instance and API client; do not create a second React root.
export function createModelCatalogCache() {
  const catalogs = new Map();
  const keyFor = profile => JSON.stringify([profile.id, profile.baseUrl, profile.protocol]);
  return {
    read(profile) { return catalogs.get(keyFor(profile))?.models; },
    load(profile, fetchModels) {
      const key = keyFor(profile);
      const entry = catalogs.get(key) || {};
      if (entry.pending) return entry.pending;
      catalogs.set(key, entry);
      entry.pending = (async () => {
        try {
          const result = await fetchModels(profile.id);
          const models = result?.models || result?.data || [];
          entry.models = Array.isArray(models) ? models : [];
          return entry.models;
        } finally { entry.pending = null; }
      })();
      // Only model IDs live in memory; never persist credentials or API responses to disk.
      if (catalogs.size > 100) {
        for (const [oldKey, oldEntry] of catalogs) {
          if (oldKey !== key && !oldEntry.pending) { catalogs.delete(oldKey); break; }
        }
      }
      return entry.pending;
    },
  };
}

export function createHeaderModelSelector(React, api, createPortal) {
  const { createElement: h, useEffect, useLayoutEffect, useId, useRef, useState } = React;
  const ProviderIcon = createProviderIcon(React);
  const catalogs = createModelCatalogCache();
  return function HeaderModelSelector({ profile, profiles = [], mode, value, runningModel, hasRunning, disabled, busy, onChange, onSettings }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [, updateCatalog] = useState(0);
    const [viewedId, setViewedId] = useState(profile.id);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [position, setPosition] = useState({});
    const root = useRef(null);
    const popup = useRef(null);
    const trigger = useRef(null);
    const search = useRef(null);
    const saving = useRef(false);
    const restoreTriggerFocus = useRef(false);
    const alive = useRef(true);
    const id = useId();
    const label = MODE_LABELS[mode] || '当前模式';
    const connections = profiles.length ? profiles : [profile];
    const viewed = connections.find(connection => connection.id === viewedId) || profile;
    const optionsFor = connection => modelChoices(connection, catalogs.read(connection) || []);
    const groups = (viewedId === 'all' ? connections : [viewed]).map(connection => ({
      connection, models: optionsFor(connection).filter(model => `${model} ${connection.name}`.toLowerCase().includes(query.trim().toLowerCase())),
    }));
    const count = groups.reduce((sum, group) => sum + group.models.length, 0);
    const restricted = viewed.modelVisibility === 'selected';
    const custom = !restricted && validModel(query) && !optionsFor(viewed).includes(query.trim());
    const blocked = disabled || busy;
    const close = (restoreFocus = false) => {
      restoreTriggerFocus.current = restoreFocus;
      setOpen(false);
    };

    useLayoutEffect(() => {
      if (!open && !blocked && restoreTriggerFocus.current) {
        restoreTriggerFocus.current = false;
        trigger.current?.focus();
      }
    }, [open, blocked]);

    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => { if (disabled && !busy) setOpen(false); }, [disabled, busy]);

    

    useEffect(() => {
      if (!open) return;
      let current = true;
      setError('');
      if (restricted) { setLoading(false); return; }
      setLoading(true);
      catalogs.load(viewed, id => api.models(id)).then(list => {
        if (!current) return;
        updateCatalog(n => n + 1);
        if (!modelChoices(null, list).length) setError('服务未返回模型列表，可选择已配置的模型，或输入模型 ID。');
      }).catch(error => {
        if (current) setError((catalogs.read(viewed)?.length ? '更新失败，仍显示上次获取的模型。' : '') + (error?.message || '读取模型列表失败，请刷新重试。'));
      }).finally(() => { if (current) setLoading(false); });
      return () => { current = false; };
    }, [open, refresh, viewed.id, viewed.baseUrl, viewed.protocol, restricted]);

    useLayoutEffect(() => {
      if (!open) return;
      const mainPanel = trigger.current?.closest('.main-panel');
      const place = () => {
        const rect = trigger.current?.getBoundingClientRect();
        if (!rect) return;
        const mainRect = mainPanel?.getBoundingClientRect();
        const topInset = document.getElementById('hg-titlebar')?.getBoundingClientRect()?.bottom || 0;
        const bounds = mainRect
          ? { left: mainRect.left, right: mainRect.right, topInset }
          : { left: 0, right: window.innerWidth, topInset };
        setPosition(modelPopoverPosition(rect, window.innerWidth, window.innerHeight, bounds));
      };
      const outside = event => {
        if (!root.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false);
      };
      place();
      search.current?.focus();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      const observer = new ResizeObserver(place);
      observer.observe(trigger.current);
      if (mainPanel) observer.observe(mainPanel);
      document.addEventListener('pointerdown', outside);
      document.addEventListener('focusin', outside);
      return () => {
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
        observer.disconnect();
        document.removeEventListener('pointerdown', outside);
        document.removeEventListener('focusin', outside);
      };
    }, [open]);

    async function choose(model, connection = viewed) {
      if (blocked || saving.current) return;
      if (model === value && connection.id === profile.id) { close(true); return; }
      saving.current = true;
      setSaveError('');
      try {
        const saved = await onChange(model, connection.id);
        if (!alive.current) return;
        if (saved) close(true);
        else setSaveError('未能完成切换，请检查连接后重试。');
      } catch (error) {
        if (alive.current) setSaveError(error?.message || '保存模型失败，请重试。');
      } finally { saving.current = false; }
    }

    function navigate(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      // The picker now lives inside the composer form; searching must never send its draft.
      if (event.key === 'Enter' && event.target === search.current) { event.preventDefault(); event.stopPropagation(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.target === search.current && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const selector = event.target.closest('.model-provider-rail') ? '.model-provider-tab:not(:disabled)' : '.model-selector-option:not(:disabled)';
      const buttons = [...popup.current.querySelectorAll(selector)];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
      buttons[next].focus();
    }

    return h('div', { className: 'header-model-control', ref: root, onKeyDown: open ? navigate : undefined },
      h('button', {
        type: 'button', ref: trigger, className: 'header-model model-selector-trigger', disabled: blocked,
        'aria-label': '选择模型', 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
        title: `${profile.name || '当前供应商'} · ${label}模型：${value || '未配置'} · 点击切换${hasRunning ? '，从下一条消息生效' : ''}`,
        onClick: () => { setQuery(''); setSaveError(''); setViewedId(profile.id); setOpen(current => !current); },
      }, h(ProviderIcon, { profile }), h('span', { className: 'model-selector-current' }, busy ? '正在切换…' : value || '选择模型'),
      h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'm4 6 4 4 4-4' }))),
      // Escape the composer's stacking context while retaining the active theme tokens.
      open && createPortal(h('section', { ref: popup, id, role: 'dialog', 'aria-label': `选择${label}模型`, className: 'model-selector-popover', style: position },
        h('div', { className: 'model-selector-searchbar' },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('circle', { cx: 10, cy: 10, r: 6 }), h('path', { d: 'm15 15 5 5' })),
          h('input', { ref: search, type: 'search', className: 'model-selector-search', 'aria-label': '搜索模型', placeholder: restricted ? '筛选指定的模型…' : '筛选，或输入任意模型 ID…', value: query, maxLength: 256, autoComplete: 'off', spellCheck: false,
            onChange: event => setQuery(event.target.value) })),
        h('div', { className: 'model-selector-body' },
          h('nav', { className: 'model-provider-rail', 'aria-label': '供应商连接' },
            h('button', { type: 'button', className: 'model-provider-tab', title: '全部连接', 'aria-label': '全部连接', 'aria-pressed': viewedId === 'all', disabled: blocked, onClick: () => { setViewedId('all'); setSaveError(''); } }, h(ProviderIcon, { grid: true })),
            h('div', { className: 'model-provider-divider' }),
            ...connections.map(connection => h('button', {
              key: connection.id, type: 'button', className: 'model-provider-tab', title: `${connection.name}\n${providerAppearance(connection).host}`, 'aria-label': `供应商：${connection.name}`,
              'aria-pressed': viewedId === connection.id, disabled: blocked,
              onClick: () => { setViewedId(connection.id); setSaveError(''); },
            }, h(ProviderIcon, { profile: connection }), connection.id === profile.id && h('i', { className: 'model-provider-active', 'aria-hidden': true }))),
            h('button', { type: 'button', className: 'model-provider-tab model-provider-add', title: '管理模型连接', 'aria-label': '管理模型连接', disabled: blocked, onClick: () => { close(); onSettings(); } }, '+')),
          h('div', { className: 'model-selector-main' },
            h('div', { className: 'model-selector-heading' },
              h('div', null, h('strong', null, viewedId === 'all' ? '全部连接' : viewed.name || '当前连接'), h('small', null, `${label}模型 · ${viewedId === 'all' ? '已配置模型及已读取的列表' : providerAppearance(viewed).host}`)),
              !restricted && h('button', { type: 'button', className: 'model-selector-link', disabled: loading || blocked, onClick: () => setRefresh(n => n + 1), 'aria-label': '刷新模型列表' }, loading ? '读取中…' : '刷新')),
            h('div', { className: 'model-selector-status', role: 'status', 'aria-live': 'polite' }, loading ? catalogs.read(viewed) ? `共 ${count} 个模型 · 正在更新…` : '正在读取此连接的模型列表…' : error || `共 ${count} 个模型`),
            saveError && h('p', { className: 'model-selector-error', role: 'alert' }, saveError),
            h('div', { className: 'model-selector-options', role: 'group', 'aria-label': '可用模型' },
              ...groups.filter(group => group.models.length).map(({ connection, models }) => h('div', { key: connection.id, className: 'model-selector-group' },
                viewedId === 'all' && h('div', { className: 'model-selector-group-label' }, connection.name),
                ...models.map(model => h('button', {
                  key: model, type: 'button', className: 'model-selector-option', title: `${model}\n${connection.name}`, 'aria-label': model, 'aria-pressed': model === value && connection.id === profile.id, disabled: blocked,
                  onClick: () => choose(model, connection),
                }, h('span', { className: 'model-selector-name' }, model),
                model === value && connection.id === profile.id && h('span', { className: 'model-selector-check', 'aria-hidden': true }, '✓'))))),
              custom && h('button', { type: 'button', className: 'model-selector-option model-selector-custom', title: `${query.trim()}\n${viewed.name}`, disabled: blocked, onClick: () => choose(query.trim()) },
                h('span', { className: 'model-selector-name' }, `使用自定义模型${viewedId === 'all' ? `（${viewed.name}）` : ''}：${query.trim()}`)),
              !count && !custom && h('p', { className: 'model-selector-empty' }, restricted ? '暂无匹配的指定模型，可在连接设置中修改显示范围。' : '暂无匹配的模型，可输入模型 ID 或切换左侧供应商。')),
            h('div', { className: 'model-selector-footer' },
              restricted && viewedId !== 'all' && h('p', null, '只显示此连接指定的模型，可在设置中调整。'),
              h('p', null, runningModel && runningModel !== value ? `当前回复仍使用 ${runningModel}；新选择从下一条消息生效。` : hasRunning ? '正在生成的回复不变，新选择从下一条消息生效。' : `选择模型后切换连接与${label}模型。请确认模型支持此模式。`))))), root.current.closest('.app-shell')));
  };
}
