/**
 * 1.2.8-titlebar-keyboard: the drawn title bar replaces the native menu bar, so the keys Windows
 * users expect to reach it are routed here from the main process's before-input-event.
 *
 *   Alt (pressed and released on its own)  focus the first menu, or leave the bar again
 *   F10                                     the same
 *   Alt+F / E / V / H / P                   open 文件 / 编辑 / 查看 / 帮助 / 桌宠 directly
 *
 * The decision is a pure function of the key events, so it can be tested without Electron.
 */
export const TITLE_BAR_MNEMONICS = Object.freeze({ 文件: 'F', 编辑: 'E', 查看: 'V', 帮助: 'H', 桌宠: 'P' });

export function titleBarShortcut(label) {
  const letter = TITLE_BAR_MNEMONICS[label];
  return letter ? `Alt+${letter}` : '';
}

/**
 * Returns a decider: decide(input, { labels, fromPage }) -> null | { index, open, toggle }.
 * `fromPage` is false for the embedded browser, whose pages keep their own Alt+letter access keys.
 */
export function createTitleBarKeys() {
  let altArmed = false;
  const decide = (input, { labels = [], fromPage = true } = {}) => {
    if (!input || typeof input !== 'object') return null;
    // 1.3.3: a mouse button or wheel while Alt is down means Alt is a modifier, not a menu tap.
    if (input.type === 'pointer' || input.type === 'mouseDown' || input.type === 'mouseWheel') { altArmed = false; return null; }
    const noOtherModifier = !input.control && !input.meta && !input.shift;
    if (input.type === 'keyDown') {
      if (input.key === 'Alt') {
        if (!input.isAutoRepeat) altArmed = noOtherModifier;
        return null;
      }
      // Any other key in between (Alt+Tab, Alt+F4, Alt+letter) means Alt was used as a modifier.
      altArmed = false;
      if (input.key === 'F10' && noOtherModifier && !input.alt) return input.isAutoRepeat ? null : { index: 0, open: false, toggle: true };
      if (fromPage && input.alt && noOtherModifier && !input.isAutoRepeat) {
        const letter = /^Key([A-Z])$/.exec(String(input.code ?? ''))?.[1];
        if (letter) {
          const index = labels.findIndex(label => TITLE_BAR_MNEMONICS[label] === letter);
          if (index >= 0) return { index, open: true, toggle: false };
        }
      }
      return null;
    }
    if (input.type === 'keyUp' && input.key === 'Alt') {
      const armed = altArmed;
      altArmed = false;
      // 1.3.0: marked as coming from Alt, so the page can ignore it when Alt was held for a click.
      return armed ? { index: 0, open: false, toggle: true, source: 'alt' } : null;
    }
    return null;
  };
  decide.reset = () => { altArmed = false; };
  return decide;
}
