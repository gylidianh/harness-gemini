export function useDialogFocus(React, ref) {
  React.useEffect(() => {
    const previous = document.activeElement, node = ref.current;
    if (!node) return;
    const focusable = () => [...node.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(item => !item.disabled && item.getClientRects().length);
    (node.querySelector('[autofocus]') || focusable()[0])?.focus();
    const trap = event => {
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    node.addEventListener('keydown', trap);
    return () => { node.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, []);
}
