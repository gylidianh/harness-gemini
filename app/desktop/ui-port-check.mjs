// Runs only inside the existing isolated desktop smoke test.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function checkPortUi({ window, store, origin, outputDir }) {
  const result = { ok: false };
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async (code, label) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const click = selector => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.click();})()`);
  const capture = async name => {
    const visible = window.isVisible();
    if (!visible) window.showInactive();
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.writeFile(path.join(outputDir, name), (await window.webContents.capturePage()).toPNG());
    if (!visible) window.hide();
  };
  const modelServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'preview-model-b' }] }));
  });
  try {
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const profile = store.settings.profiles[0];
    await store.updateSettings({ profiles: [{ ...profile, name: '新连接', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, chatModel: 'gpt-6.1-sol', agentModel: 'gpt-6.1-sol', imageModel: 'preview-image' }], activeProfileId: profile.id, skin: 'claude' });
    await window.loadURL(origin);
    await wait("document.querySelector('.composer-mode-picker button')?.textContent.includes('聊天') && !document.querySelector('.model-selector-trigger')?.disabled", 'configured composer');
    result.layout = await evaluate(`(() => {
      const toolbar=document.querySelector('.composer-toolbar');
      const names=['.composer-attach','.composer-mode-picker','.permission-control','.composer-model-controls','.composer-actions'];
      const rects=names.map(name=>{const r=toolbar.querySelector(name).getBoundingClientRect();return {name,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
      return {rects,headerModels:document.querySelectorAll('.chat-header .header-model').length,panelButton:!!document.querySelector('.chat-header button'),text:document.querySelector('.reasoning-trigger').textContent};
    })()`);
    if (result.layout.headerModels !== 0 || !result.layout.panelButton || result.layout.text.includes('0')) throw new Error('Duplicate header model or stray reasoning zero');
    await click('.composer-mode-picker button');
    await wait("!!document.querySelector('.composer-mode-menu')", 'mode menu');
    await evaluate("[...document.querySelectorAll('.composer-mode-menu button')].find(e=>e.textContent.includes('编程')).click()");
    await wait("document.querySelector('.composer-mode-picker button').textContent.includes('编程')", 'code mode');
    result.modeSwitch = true;
    await click('.reasoning-trigger');
    await wait("!!document.querySelector('.reasoning-menu')", 'reasoning menu');
    await evaluate("[...document.querySelectorAll('.reasoning-option')].find(e=>e.querySelector('em')?.textContent==='high').click()");
    await wait("document.querySelector('.reasoning-trigger').textContent.includes('思考·高')", 'high reasoning');
    result.reasoning = await evaluate("document.querySelector('.reasoning-trigger').textContent");
    if (result.reasoning.includes('0')) throw new Error('Stray reasoning zero after switching');
    await click('.model-selector-trigger');
    await wait("[...document.querySelectorAll('.model-selector-option')].some(e=>e.textContent==='preview-model-b')", 'local model catalog');
    await evaluate("[...document.querySelectorAll('.model-selector-option')].find(e=>e.textContent==='preview-model-b').click()");
    await wait("document.querySelector('.model-selector-trigger').textContent.includes('preview-model-b') && !document.querySelector('.model-selector-popover')", 'saved model selection');
    result.modelSwitch = store.settings.agentModel === 'preview-model-b';
    await capture('ui-composer.png');
    await click('button[aria-label="打开设置"]');
    await wait("!!document.querySelector('.settings-nav')", 'settings navigation');
    result.sections = await evaluate("[...document.querySelectorAll('.settings-nav-item')].map(e=>e.textContent)");
    for (const name of ['工作区', '任务提醒', '供应商', '外观', '技能']) {
      await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find(e=>e.textContent===${JSON.stringify(name)}).click()`);
      await wait(`document.querySelector('#settings-title').textContent===${JSON.stringify(name)}`, `settings ${name}`);
    }
    await wait("document.querySelectorAll('.skill-card').length>0", 'skill cards');
    result.skillCount = await evaluate("document.querySelectorAll('.skill-card').length");
    const initial = await evaluate("document.querySelector('.skill-toggle input').checked");
    await click('.skill-toggle input');
    await wait(`!document.querySelector('.skill-toggle input').disabled && document.querySelector('.skill-toggle input').checked===${!initial}`, 'saved skill toggle');
    await click('.skill-toggle input');
    await wait(`!document.querySelector('.skill-toggle input').disabled && document.querySelector('.skill-toggle input').checked===${initial}`, 'restored skill toggle');
    result.skillToggle = true;
    result.settingsGeometry = await evaluate("(()=>{const r=document.querySelector('.settings-workbench').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()");
    await capture('ui-settings.png');
    await click('button[aria-label="关闭设置"]');
    await wait("!document.querySelector('.settings-workbench')", 'settings closed');
    result.ok = result.modeSwitch && result.modelSwitch && result.skillToggle && result.settingsGeometry.bottom <= result.settingsGeometry.height && result.settingsGeometry.right <= result.settingsGeometry.width;
  } catch (error) { result.error = error.stack; }
  finally { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); }
  return result;
}
