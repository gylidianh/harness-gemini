// Headless Chromium regression for the shipped GFM renderer. No user profile, model,
// installed Harness instance or OS clipboard required. Node >=22; optionally CHROMIUM_PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../app/dist/', import.meta.url));
const browser = [process.env.CHROMIUM_PATH, path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe')].find(p => p && existsSync(p));
assert.ok(browser, 'Set CHROMIUM_PATH to a Chromium browser');
const profile = await mkdtemp(path.join(os.tmpdir(), 'harness-table-test-'));
const md = '| 名称 | 数值 | 备注 |\n|---|---|---|\n| **甲** | `10` | "双引号" |\n| 乙 | 20 | [链接](https://example.org) |\n| 丙 | 30 | |';
const html = `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="/styles/main.css"><div id="root"></div><textarea id="editor">普通输入</textarea><script type="module">
import { createRoot, jsx } from '/vendor/vendor-deps.js';
import { MarkdownBody } from '/src/markdown-and-tools.js';
const root=createRoot(document.querySelector('#root')); window.draw=(text)=>root.render(jsx(MarkdownBody,{text})); draw('流式回答…');
window.$=s=>document.querySelector(s); window.$$=s=>[...document.querySelectorAll(s)]; window.control=(label)=>$$('button').find(b=>b.textContent===label);
window.pick=(n,shift=false)=>{const b=$('.hg-table-picker[data-number="'+n+'"]');b.focus();b.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:shift}))};
window.record=null; document.addEventListener('copy',e=>{window.record={handled:e.defaultPrevented,text:e.clipboardData.getData('text/plain'),nativeText:getSelection().toString()};e.preventDefault();e.clipboardData.clearData()});
Object.defineProperty(navigator.clipboard,'writeText',{value:async text=>{window.written=text}});window.ready=true;
</script>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' }); res.end(html); return; }
    const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(path.resolve(dist) + path.sep)) throw Error();
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let proc, ws, exited;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, origin], { windowsHide: true, stdio: 'ignore' });
  exited = new Promise(r => proc.once('exit', r));
  async function until(check, message) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await wait(50); }
    throw Error(message);
  }
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => existsSync(portFile), 'Chromium failed to launch');
  const port = (await readFile(portFile, 'utf8')).split('\n')[0].trim();
  let target;
  await until(async () => target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith(origin)), 'No fixture target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r,j) => { ws.onopen=r; ws.onerror=j; });
  const pending = new Map(); let id = 0;
  ws.onmessage = e => { const m=JSON.parse(e.data); const p=pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
  const send = (method, params={}) => new Promise((resolve,reject) => { pending.set(++id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})); });
  const exec = async expression => { const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const check = async (expression, expected) => assert.deepEqual(await exec(expression), expected, expression);
  const key = async (key, code, vk, modifiers=0) => { for(const type of ['rawKeyDown','keyUp']) await send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,modifiers}); };
  const copy = async () => { await exec('record=null'); await key('c','KeyC',67,2); await until(()=>exec('!!record'),'Ctrl+C produced no native copy event'); return exec('record'); };
  await until(()=>exec('!!window.ready'),'Markdown module did not load');
  await exec(`draw(${JSON.stringify(md)})`);
  await until(()=>exec('!!$(".hg-answer-table table")'),'Streamed GFM table not mounted');
  await check('[$("table").rows.length, ...Array.from($("table").rows,r=>r.cells.length)]',[4,3,3,3,3]);
  await check('!!$(".hg-table-tools,.hg-sheet-heading,.hg-answer-table button")',false);
  async function point(r,c,edge='') { return exec(`(()=>{const el=$('table').rows[${r}].cells[${c}]; const b=el.getBoundingClientRect();return {x:b.left+${edge==='row'?3:12},y:b.top+${edge==='col'?3:12}}})()`); }
  async function drag(a,b,modifiers=0) {
    const from=await point(...a), to=await point(...b);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1,modifiers});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1,modifiers});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1,modifiers});
  }
  async function doubleClick(r,c) {
    const pt=await point(r,c);
    for(const clickCount of [1,2]) for(const type of ['mousePressed','mouseReleased'])
      await send('Input.dispatchMouseEvent',{type,...pt,button:'left',buttons:type==='mousePressed'?1:0,clickCount});
  }
  await doubleClick(1,2);
  await check('getSelection().toString()', '');
  await check('document.querySelectorAll("[data-hg-picked]").length',0);
  // Locate two actual glyph boundaries; select with mouse input, not a scripted DOM selection.
  async function glyphPoint(offset) { return exec(`(()=>{const t=$('table').rows[1].cells[2].firstChild; const r=document.createRange();r.setStart(t,${offset});r.collapse(true);const b=r.getBoundingClientRect();return {x:b.left+.1,y:(b.top+b.bottom)/2}})()`); }
  for(const [a,b,expected] of [[2,4,'引号'],[3,1,'双引']]) {
    const from=await glyphPoint(a), to=await glyphPoint(b);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
    assert.deepEqual(await copy(),{handled:false,text:'',nativeText:expected});
    // Collapse the native selection before starting a new drag from within it.
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...from,button:'left',buttons:0,clickCount:1});
  }
  await drag([2,1],[1,0]); await check('$$("[data-hg-picked]").length',4);
  assert.equal((await copy()).text,'甲\t10\r\n乙\t20');
  await drag([1,0,'row'],[2,0,'row']); assert.equal((await copy()).text,'甲\t10\t"""双引号"""\r\n乙\t20\t链接');
  await drag([0,2,'col'],[0,1,'col']); assert.equal((await copy()).text,'数值\t备注\r\n10\t"""双引号"""\r\n20\t链接\r\n30\t');
  await exec(`draw(${JSON.stringify(md+'\n| 丁 | 40 | 追加 |')})`); await until(()=>exec('$("tbody").textContent.includes("追加")'),'stream update');
  assert.match((await copy()).text,/\r\n40\t追加$/);
  await drag([1,0],[1,0]); await key('ArrowDown','ArrowDown',40,8); assert.equal((await copy()).text,'甲\r\n乙');
  await key('a','KeyA',65,2); await check('$$ ("[data-hg-picked]").length',15);
  await key('Escape','Escape',27); await check('$$("[data-hg-picked]").length',0);
  await exec('$("#editor").focus();$("#editor").select()'); assert.equal((await copy()).handled,false);
  console.log('PASS: double-click without select-all, forward/reverse partial text selection and native copy, immediate return to grid dragging; native mouse rectangle (reverse), whole row and column drags, Ctrl+C TSV, stream update, keyboard extension, bare table, select all, Escape and editor copy.');
  await send('Browser.close');
} finally {
  ws?.close(); server.closeAllConnections(); server.close();
  if (proc && proc.exitCode === null) { await Promise.race([exited, wait(1000)]); if(proc.exitCode === null) proc.kill(); await exited; }
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
