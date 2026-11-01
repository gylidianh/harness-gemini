export function createSkillsUI(React, api) {
  const h = React.createElement;
  function Icon({ type }) {
    const paths = { folder: 'M3 7V5h6l2 2h10v12H3Z', refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2', skill: 'M9 3h6v4a3 3 0 1 1 3 3h3v6h-4a3 3 0 1 1-3 3v2H8v-4a3 3 0 1 1-3-3H3V8h6Z' };
    return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[type] }));
  }
  function SkillsList({ skills, busy, disabled, onToggle }) {
    return h('ul', { className: 'skills-list' }, skills.map(skill =>
      h('li', { key: skill.name, className: `skill-card${skill.enabled ? '' : ' off'}` },
        h('div', { className: 'skill-card-heading' },
          h('span', { className: 'skill-symbol' }, h(Icon, { type: 'skill' })),
          h('strong', { title: skill.name }, skill.name),
          h('span', { className: `external-skill-badge${skill.readOnly ? '' : ' write'}` }, skill.readOnly ? '只读' : '可写'),
          h('label', { className: 'skill-toggle', title: skill.manifestEnabled ? '立即保存' : '此技能已在清单中禁用' },
            h('input', { type: 'checkbox', role: 'switch', checked: skill.enabled, disabled: disabled || !!busy || !skill.manifestEnabled, 'aria-label': `启用 ${skill.name}`, onChange: e => onToggle(skill.name, e.target.checked) }),
            h('span', null, busy === skill.name ? '保存中' : skill.enabled ? '已启用' : '已停用'))),
        h('p', { className: 'skill-description' }, skill.description),
        h('details', { className: 'skill-details' }, h('summary', null, '详情'),
          h('p', null, skill.description),
          h('dl', null, h('dt', null, '工具'), h('dd', null, h('code', null, skill.tool)),
            h('dt', null, '脚本'), h('dd', null, (skill.command || []).join(' ')),
            h('dt', null, '参数'), h('dd', null, skill.parameters?.join('、') || '无'))))));
  }
  function SkillsSettings({ disabled, onToast }) {
    const [state, setState] = React.useState({ loading: true, directory: '', skills: [], errors: [], error: '' });
    const [busy, setBusy] = React.useState('');
    const [query, setQuery] = React.useState('');
    const pending = React.useRef(false), alive = React.useRef(false);
    const apply = value => setState({ loading: false, directory: value.directory || '', skills: value.skills || [], errors: value.errors || [], error: '' });
    const refresh = async () => {
      if (pending.current) return;
      pending.current = true; setState(s => ({ ...s, loading: true, error: '' }));
      try { const result = await api.externalSkills(); if (alive.current) apply(result); }
      catch (error) { if (alive.current) setState(s => ({ ...s, loading: false, error: error.message })); }
      finally { pending.current = false; }
    };
    React.useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, []);
    const action = async (name, run) => {
      if (pending.current) return;
      pending.current = true; setBusy(name);
      try { const result = await run(); if (alive.current && result?.skills) apply(result); }
      catch (error) { if (alive.current) { setState(s => ({ ...s, error: error.message })); onToast?.(error.message, 'error'); } }
      finally { pending.current = false; if (alive.current) setBusy(''); }
    };
    const needle = query.trim().toLowerCase();
    const filtered = state.skills.filter(s => `${s.name} ${s.description} ${s.tool}`.toLowerCase().includes(needle));
    return h('div', { className: 'skills-settings' },
      h('p', { className: 'skills-intro' }, '启用后，模型会在需要时调用技能。开关即时保存。'),
      h('div', { className: 'skills-toolbar' },
        h('button', { type: 'button', className: 'button button-quiet small-button', disabled: disabled || state.loading || !!busy, onClick: () => action('open', () => api.openExternalSkillsFolder()) }, h(Icon, { type: 'folder' }), '打开技能文件夹'),
        h('button', { type: 'button', className: 'button button-quiet small-button', disabled: disabled || state.loading || !!busy, onClick: refresh }, h(Icon, { type: 'refresh' }), state.loading ? '读取中' : '刷新'),
        h('span', { className: 'skills-count', role: 'status' }, `已启用 ${state.skills.filter(s => s.enabled).length} / ${state.skills.length}`)),
      state.directory && h('details', { className: 'skills-directory' }, h('summary', null, '技能文件夹路径'), h('code', null, state.directory)),
      h('input', { type: 'search', className: 'skills-search', value: query, onChange: e => setQuery(e.target.value), placeholder: '搜索技能名称或说明', 'aria-label': '搜索技能' }),
      state.error && h('p', { className: 'field-error', role: 'alert' }, state.error),
      !state.loading && !filtered.length && h('p', { className: 'skills-empty' }, state.skills.length ? '没有匹配的技能。' : '还没有技能。打开技能文件夹，按 README.md 添加后点击刷新。'),
      h(SkillsList, { skills: filtered, busy, disabled: disabled || state.loading, onToggle: (name, enabled) => action(name, () => api.setExternalSkill(name, enabled)) }),
      state.errors.length > 0 && h('ul', { className: 'external-skill-errors', role: 'alert' }, state.errors.map(error => h('li', { key: error.folder + error.error }, `${error.folder}：${error.error}`))));
  }
  return { SkillsSettings, SkillsList };
}
