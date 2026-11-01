/**
 * The native right-click menu for editable text.
 *
 * Adapted from ZCode's desktop input context-menu behaviour (Apache-2.0; see
 * THIRD-PARTY-NOTICES.md): Electron's own `context-menu` event builds the popup, every item
 * keeps its Electron `role` so the native editing behaviour is untouched, and each item's
 * enabled state comes from the reported `editFlags` rather than from a guess. Only the labels
 * are supplied, because Electron's default labels follow the operating system's language rather
 * than this application's.
 *
 * A menu is only shown when it has something to offer: an editable field, or a selection that
 * can be copied. Right-clicking inert page background does nothing, exactly as before.
 */

/** Message table, mirroring the desktop menu ids ZCode resolves per locale. */
const MESSAGES = {
  'zh-CN': {
    undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', delete: '删除', selectAll: '全选',
  },
  'en-US': {
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', delete: 'Delete', selectAll: 'Select all',
  },
};

export const CONTEXT_MENU_LOCALES = Object.keys(MESSAGES);

export function contextMenuMessages(locale) {
  return MESSAGES[locale] ?? MESSAGES['zh-CN'];
}

const flag = (params, name) => params?.editFlags?.[name] === true;

/**
 * The template for one `context-menu` event, or null when no menu should appear. Kept free of
 * Electron imports so the exact item list and enabled states can be asserted in tests.
 */
export function contextMenuTemplate(params, { locale = 'zh-CN' } = {}) {
  const labels = contextMenuMessages(locale);
  const editable = params?.isEditable === true;
  const hasSelection = typeof params?.selectionText === 'string' && params.selectionText.trim().length > 0;
  if (!editable && !hasSelection) return null;
  if (editable) {
    return [
      { role: 'undo', label: labels.undo, enabled: flag(params, 'canUndo') },
      { role: 'redo', label: labels.redo, enabled: flag(params, 'canRedo') },
      { type: 'separator' },
      { role: 'cut', label: labels.cut, enabled: flag(params, 'canCut') },
      { role: 'copy', label: labels.copy, enabled: flag(params, 'canCopy') },
      { role: 'paste', label: labels.paste, enabled: flag(params, 'canPaste') },
      { role: 'delete', label: labels.delete, enabled: flag(params, 'canDelete') },
      { type: 'separator' },
      { role: 'selectAll', label: labels.selectAll, enabled: flag(params, 'canSelectAll') },
    ];
  }
  return [
    { role: 'copy', label: labels.copy, enabled: flag(params, 'canCopy') || hasSelection },
    { role: 'selectAll', label: labels.selectAll, enabled: flag(params, 'canSelectAll') },
  ];
}

/**
 * Show the native menu for one WebContents. The locale is read while the menu is built, so a
 * language change takes effect on the next right-click. Returns a detach function.
 */
export function installContextMenu(contents, { Menu, BrowserWindow, getLocale = () => 'zh-CN', offset = null } = {}) {
  const listener = (event, params) => {
    const template = contextMenuTemplate(params, { locale: getLocale() });
    if (!template) return;
    const owner = BrowserWindow?.fromWebContents?.(contents);
    if (!owner || owner.isDestroyed()) return;
    // 1.3.0: a child view (the embedded browser) adds its offset inside the window.
    let shift = { x: 0, y: 0 };
    try {
      const value = typeof offset === 'function' ? offset() : null;
      if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) shift = value;
    } catch { /* Fall back to the reported position. */ }
    Menu.buildFromTemplate(template).popup({ window: owner, x: Math.round(params.x + shift.x), y: Math.round(params.y + shift.y) });
    event.preventDefault?.();
  };
  contents.on('context-menu', listener);
  return () => contents.off?.('context-menu', listener);
}
