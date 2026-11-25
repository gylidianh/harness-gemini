// Electron's Windows zoomIn menu accelerator (Ctrl+Plus) doesn't cover all
// layouts/keypads. Handle these aliases before the menu and the page see them.
export function handleWindowsZoomIn(event, input, contents) {
  if (process.platform !== 'win32' || input.type !== 'keyDown' || !input.control
    || input.alt || input.meta || input.isComposing) return false;
  const { key, code } = input;
  if (key !== '+' && key !== '=' && code !== 'NumpadAdd'
    && !(code === 'Equal' && (!key || key === 'Unidentified'))) return false;

  event.preventDefault(); // Also suppress the native accelerator, including on repeats.
  // Same target and 0.5-level step as Electron's zoomIn/zoomOut menu roles.
  if (!input.isAutoRepeat) contents.zoomLevel += 0.5;
  return true;
}
