// Run: node --test tests/windows-zoom.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleWindowsZoomIn } from '../app/desktop/windows-zoom.mjs';

const input = { type: 'keyDown', key: '=', code: 'Equal', control: true };
function check(overrides, handled, delta = 0) {
  const contents = { zoomLevel: -0.5 };
  let prevented = 0;
  const result = handleWindowsZoomIn({ preventDefault() { prevented++; } }, { ...input, ...overrides }, contents);
  assert.equal(result, handled);
  assert.equal(prevented, Number(handled));
  assert.equal(contents.zoomLevel, -0.5 + delta);
}

test('Windows zoom-in aliases consume exactly one keydown per press', { skip: process.platform !== 'win32' }, () => {
  for (const alias of [{}, { key: '+', shift: true }, { key: '+', code: 'NumpadAdd' },
    { key: 'Unidentified' }, { key: 'Add', code: 'NumpadAdd' }, { key: '+', code: 'BracketRight' }]) {
    check(alias, true, 0.5);
    check({ ...alias, isAutoRepeat: true }, true);
    check({ ...alias, type: 'keyUp' }, false);
  }
});

test('leave native decrease/reset, text, AltGr, layout-specific keys and IME alone', () => {
  for (const other of [{ key: '-', code: 'Minus' }, { key: '0', code: 'Digit0' }, { control: false },
    { alt: true }, { meta: true }, { type: 'char' }, { isComposing: true }, { key: 'Dead' },
    { key: 'ä' }, { key: 'Backspace', code: 'Backspace' }]) check(other, false);
  if (process.platform !== 'win32') check({}, false);
});
