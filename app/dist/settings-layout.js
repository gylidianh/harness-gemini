import { useDialogFocus } from './dialog-focus.js';
import { createProviderIcon, providerAppearance } from './model-selector.js';

export const SETTINGS_SECTIONS = [
  { id: 'settings-models', label: '供应商', detail: '模型连接 API 密钥 地址 模型', group: '人工智能', icon: 'connection' },
  { id: 'settings-workspace', label: '工作区', detail: '工作目录 工具调用 上下文压缩', group: '工作台', icon: 'folder' },
  { id: 'settings-reminders', label: '任务提醒', detail: '气泡提示音 系统通知', group: '工作台', icon: 'bell' },
  { id: 'settings-skills', label: '技能', detail: '技能目录 启用状态', group: '人工智能', icon: 'book' },
  { id: 'settings-appearance', label: '外观', detail: '界面皮肤 主题 颜色', group: '偏好设置', icon: 'palette' },
];

export function createSettingsLayout(React) {
  const h = React.createElement;
  const ProviderIcon = createProviderIcon(React);
  const paths = {
    connection: ['M4 5l6 6-6 6', 'M13 19h7'], folder: ['M3 7V5h6l2 2h10v12H3Z'],
    bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
    book: ['M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z', 'M12 5v15'],
    palette: ['M21 12a9 9 0 1 0-9 9h1a2 2 0 0 0 1-4 2 2 0 0 1 2-3h3a2 2 0 0 0 2-2Z', 'M7 8h.01M12 6h.01M17 8h.01M6 13h.01'],
  };
  function Icon({ type }) {
    return h('svg', { width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths[type].map((d, i) => h('path', { d, key: i })));
  }
  function SettingsNavigation({ active, onSelect, profiles = [], selectedId, onSelectProvider, disabled }) {
    const [query, setQuery] = React.useState('');
    const needle = query.trim().toLowerCase();
    const matchingProfiles = profiles.filter(p => `${p.name} ${providerAppearance(p).host}`.toLowerCase().includes(needle));
    const visible = SETTINGS_SECTIONS.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(needle) || (item.id === 'settings-models' && matchingProfiles.length));
    return h('aside', { className: 'settings-nav', 'aria-label': '设置分类' },
      h('div', { className: 'settings-nav-heading' }, '设置'),
      h('label', { className: 'settings-nav-search' },
        h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('circle', { cx: 10, cy: 10, r: 6 }), h('path', { d: 'm15 15 5 5' })),
        h('input', { type: 'search', value: query, onChange: e => setQuery(e.target.value), placeholder: '搜索设置', 'aria-label': '搜索设置分类' })),
      h('nav', { className: 'settings-nav-items' },
        ['工作台', '人工智能', '偏好设置'].map(group => {
          const items = visible.filter(item => item.group === group);
          return items.length ? h('div', { className: 'settings-nav-group', key: group },
            items.map(item => h(React.Fragment, { key: item.id },
              h('button', { type: 'button', className: `settings-nav-item${active === item.id ? ' active' : ''}`, onClick: () => onSelect(item.id), 'aria-current': active === item.id ? 'page' : undefined },
                h(Icon, { type: item.icon }), h('span', { className: 'settings-nav-copy' }, item.label)),
              item.id === 'settings-models' && matchingProfiles.length > 0 && h('div', { className: 'settings-nav-providers' }, matchingProfiles.map(profile =>
                h('button', { key: profile.id, type: 'button', disabled, className: `settings-nav-provider${active === item.id && selectedId === profile.id ? ' selected' : ''}`, title: profile.name, 'aria-label': `编辑供应商 ${profile.name || '未命名连接'}`, 'aria-pressed': active === item.id && selectedId === profile.id,
                  onClick: () => { onSelect(item.id); onSelectProvider?.(profile.id); } },
                h(ProviderIcon, { profile }), h('span', null, profile.name || '未命名连接'))))))) : null;
        }),
        !visible.length && h('p', { className: 'settings-nav-empty' }, '没有匹配的分类')));
  }
  function ProviderConnections({ profiles, selectedId, activeId, dirtyIds = [], disabled, onSelect, onAdd, onRemove }) {
    return h('div', { className: 'settings-providers' },
      h('div', { className: 'settings-provider-toolbar' },
        h('span', null, `${profiles.length} 个供应商`),
        h('button', { type: 'button', className: 'text-button', disabled: disabled || profiles.length >= 50, onClick: onAdd, 'aria-label': '新增连接配置' }, '+ 添加供应商')),
      h('div', { className: 'settings-provider-list', 'aria-label': '已添加的供应商' }, profiles.map(profile =>
        h('button', { key: profile.id, type: 'button', disabled, className: `settings-provider-card${profile.id === selectedId ? ' selected' : ''}`, 'aria-pressed': profile.id === selectedId, onClick: () => onSelect(profile.id) },
          h(ProviderIcon, { profile }), h('span', { className: 'settings-provider-copy' },
            h('strong', { title: profile.name }, profile.name || '未命名连接'),
            h('small', null, providerAppearance(profile).host || '待填写地址'),
            h('span', { className: 'settings-provider-status' }, profile.id === activeId ? '当前使用' : '可切换', dirtyIds.includes(profile.id) ? ' · 未保存' : ''))))),
      h('div', { className: 'settings-provider-caption' }, h('span', null, '点击编辑，切换时保留未保存的修改。'),
        h('button', { type: 'button', className: 'text-button', disabled: disabled || profiles.length <= 1, onClick: onRemove, 'aria-label': '删除此连接配置' }, '移除此供应商')));
  }
  function SettingsContent({ active, children }) {
    const ref = React.useRef(null);
    React.useEffect(() => { if (ref.current) ref.current.scrollTop = 0; }, [active]);
    let section = SETTINGS_SECTIONS[0].id;
    const groups = Object.fromEntries(SETTINGS_SECTIONS.map(s => [s.id, []]));
    React.Children.forEach(children, child => {
      if (child?.props?.['data-settings-section']) section = child.props['data-settings-section'];
      groups[section].push(child);
    });
    return h('div', { ref, className: 'settings-scroll' }, SETTINGS_SECTIONS.map(item =>
      h('section', { key: item.id, id: item.id, hidden: active !== item.id, className: 'settings-category', 'aria-label': item.label }, groups[item.id])));
  }
  function useSettingsDialog() {
    const ref = React.useRef(null); useDialogFocus(React, ref); return ref;
  }
  return { SettingsNavigation, SettingsContent, ProviderConnections, useSettingsDialog };
}
