function resolveComposerMenuBounds(element, viewportWidth, margin = 12) {
  const mainRect = element?.closest?.('.main-panel')?.getBoundingClientRect?.();
  const topInset = typeof document !== 'undefined' ? (document.getElementById('hg-titlebar')?.getBoundingClientRect()?.bottom || 0) : 0;
  const hasMain = Boolean(mainRect && Number.isFinite(mainRect.left) && Number.isFinite(mainRect.right) && (mainRect.right - mainRect.left) >= 260);
  const minX = hasMain ? Math.max(margin, Math.round(mainRect.left + margin)) : margin;
  const maxX = hasMain ? Math.min(viewportWidth - margin, Math.round(mainRect.right - margin)) : Math.max(margin, viewportWidth - margin);
  return { minX, maxX: Math.max(minX, maxX), topInset };
}

export function reasoningMenuPosition(trigger, container, viewportWidth, viewportHeight, bounds) {
  const margin = 12, gap = 8;
  const minX = bounds && Number.isFinite(bounds.minX) ? bounds.minX : margin;
  const maxX = bounds && Number.isFinite(bounds.maxX) ? bounds.maxX : Math.max(margin, viewportWidth - margin);
  const topInset = bounds && Number.isFinite(bounds.topInset) ? bounds.topInset : 0;
  const width = Math.min(248, Math.max(0, maxX - minX));
  const left = Math.max(minX, Math.min(trigger.right - width, maxX - width));
  const above = trigger.top - topInset - margin - gap;
  const below = viewportHeight - trigger.bottom - margin - gap;
  const upward = above >= below;
  return {
    width: `${width}px`, left: `${left - container.left}px`, right: 'auto',
    top: upward ? 'auto' : `${trigger.bottom + gap - container.top}px`,
    bottom: upward ? `${container.bottom - trigger.top + gap}px` : 'auto',
    maxHeight: `${Math.max(0, Math.min(420, upward ? above : below))}px`,
  };
}

export function permissionMenuPosition(trigger, container, viewportWidth, viewportHeight, bounds) {
  const margin = 12, gap = 8;
  const minX = bounds && Number.isFinite(bounds.minX) ? bounds.minX : margin;
  const maxX = bounds && Number.isFinite(bounds.maxX) ? bounds.maxX : Math.max(margin, viewportWidth - margin);
  const topInset = bounds && Number.isFinite(bounds.topInset) ? bounds.topInset : 0;
  const width = Math.min(360, Math.max(0, maxX - minX));
  const left = Math.max(minX, Math.min(trigger.left, maxX - width));
  const above = trigger.top - topInset - margin - gap;
  const below = viewportHeight - trigger.bottom - margin - gap;
  const upward = above >= below;
  return {
    width: `${width}px`, left: `${left - container.left}px`, right: 'auto',
    top: upward ? 'auto' : `${trigger.bottom + gap - container.top}px`,
    bottom: upward ? `${container.bottom - trigger.top + gap}px` : 'auto',
    maxHeight: `${Math.max(0, Math.min(420, upward ? above : below))}px`,
  };
}

export function useReasoningMenuPosition(React, open, trigger, container, menu) {
  React.useLayoutEffect(() => {
    if (!open) return;
    const mainPanel = container.current?.closest?.('.main-panel');
    const update = () => {
      if (!trigger.current || !container.current || !menu.current) return;
      const bounds = resolveComposerMenuBounds(container.current, window.innerWidth, 12);
      Object.assign(menu.current.style, reasoningMenuPosition(
        trigger.current.getBoundingClientRect(), container.current.getBoundingClientRect(),
        window.innerWidth, window.innerHeight, bounds,
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container.current);
    if (mainPanel) observer.observe(mainPanel);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, trigger, container, menu]);
}

export function usePermissionMenuPosition(React, open, trigger, container, menu) {
  React.useLayoutEffect(() => {
    if (!open) return;
    const mainPanel = container.current?.closest?.('.main-panel');
    const update = () => {
      if (!trigger.current || !container.current || !menu.current) return;
      const bounds = resolveComposerMenuBounds(container.current, window.innerWidth, 12);
      Object.assign(menu.current.style, permissionMenuPosition(
        trigger.current.getBoundingClientRect(), container.current.getBoundingClientRect(),
        window.innerWidth, window.innerHeight, bounds,
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container.current);
    if (mainPanel) observer.observe(mainPanel);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, trigger, container, menu]);
}

export function createComposerModePicker(React, createPortal) {
  const h = React.createElement;
  return function ComposerModePicker({ modes, value, onChange, onSettings, disabled }) {
    const [open, setOpen] = React.useState(false);
    const [position, setPosition] = React.useState({});
    const root = React.useRef(null), trigger = React.useRef(null), menu = React.useRef(null);
    const id = React.useId();
    const current = modes.find(mode => mode.id === value) || modes[0];
    const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
    React.useLayoutEffect(() => {
      if (!open) return;
      const place = () => {
        const rect = trigger.current.getBoundingClientRect();
        const { minX, maxX, topInset } = resolveComposerMenuBounds(trigger.current, innerWidth, 12);
        const width = Math.min(232, Math.max(0, maxX - minX));
        const above = rect.top - topInset - 20, below = innerHeight - rect.bottom - 20;
        setPosition({ width, left: Math.max(minX, Math.min(rect.left, maxX - width)),
          ...(above >= below ? { bottom: innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
          maxHeight: Math.max(0, Math.min(340, Math.max(above, below))) });
      };
      const outside = event => { if (!root.current.contains(event.target) && !menu.current?.contains(event.target)) close(); };
      place();
      menu.current?.querySelector('[aria-checked="true"]')?.focus();
      const observer = new ResizeObserver(place); observer.observe(trigger.current);
      document.addEventListener('pointerdown', outside);
      document.addEventListener('focusin', outside);
      window.addEventListener('resize', place);
      return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', place); };
    }, [open]);
    function navigate(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = [...menu.current.querySelectorAll('[role="menuitemradio"]')];
      const index = options.indexOf(document.activeElement);
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
    }
    return h('div', { className: 'mode-switcher composer-mode-picker', ref: root },
      h('button', { type: 'button', ref: trigger, className: current ? 'active' : '', disabled,
        'aria-label': current ? `切换工作模式：${current.label}` : '配置模型', 'aria-haspopup': current ? 'menu' : undefined,
        'aria-expanded': current ? open : undefined, 'aria-controls': open ? id : undefined,
        title: current ? '切换工作模式' : '配置模型', onClick: () => current ? setOpen(!open) : onSettings() },
        current && h(current.Icon, { size: 14 }), h('span', null, current?.label || '配置模型'),
        current && h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'm4 6 4 4 4-4' }))),
      open && createPortal(h('div', { id, ref: menu, className: 'composer-mode-menu', role: 'menu', 'aria-label': '工作模式', style: position, onKeyDown: navigate },
        modes.map(mode => h('button', { key: mode.id, type: 'button', role: 'menuitemradio', 'aria-checked': value === mode.id,
          title: mode.description, onClick: () => { close(true); onChange(mode.id); } },
          h(mode.Icon, { size: 16 }), h('span', null, mode.label), value === mode.id && h('span', { className: 'composer-mode-check', 'aria-hidden': true }, '✓')))), root.current.closest('.app-shell')));
  };
}
