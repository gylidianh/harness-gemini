// Run with an unpackaged Windows Electron runtime: electron tests/windows-zoom-electron.cjs
// Hidden real BrowserWindow/WebContentsView. No production profile or desktop-wide key injection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, WebContentsView } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-zoom-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  const { handleWindowsZoomIn } = await import('../app/desktop/windows-zoom.mjs');
  const menu = Menu.buildFromTemplate([{ label: 'View', submenu: ['zoomIn', 'zoomOut', 'resetZoom'].map(role => ({ role, id: role })) }]);
  Menu.setApplicationMenu(menu);
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const view = new WebContentsView({ webPreferences: { partition: 'zoom-guest', backgroundThrottling: false } });
  win.contentView.addChildView(view);
  for (const wc of [win.webContents, view.webContents]) {
    await wc.loadURL('data:text/html,<input autofocus>');
    const decisions = [];
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') decisions.push(handleWindowsZoomIn(event, input, wc));
    });
    for (const [keyCode, modifiers] of [['=', ['control']], ['=', ['control', 'shift']], ['numadd', ['control']]]) {
      const before = wc.zoomLevel;
      for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers });
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(wc.zoomLevel, before + 0.5, `${keyCode} (${modifiers})`);
      assert.deepEqual(decisions.splice(0), [true], 'one consumed keyDown per press');
      // sendInputEvent is addressed to Chromium, not the OS menu. Exercise the real menu roles directly.
      menu.getMenuItemById('zoomOut').click({}, win, wc);
      assert.equal(wc.zoomLevel, before, 'one native shrink exactly reverses the increase');
    }
    menu.getMenuItemById('zoomIn').click({}, win, wc);
    menu.getMenuItemById('resetZoom').click({}, win, wc);
    assert.equal(wc.zoomLevel, 0, 'original menu actions still work');
    wc.sendInputEvent({ type: 'keyDown', keyCode: '=' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: '=' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(decisions.splice(0), [false], 'plain = is not consumed');
    assert.equal(wc.zoomLevel, 0);
  }
  view.webContents.close();
  win.destroy();
  console.log(`PASS: Windows Electron ${process.versions.electron}, three zoom aliases in both shell and guest; native shrink/reset and plain input.`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
