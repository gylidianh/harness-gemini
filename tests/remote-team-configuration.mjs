// End-to-end: paired phone UI -> sealed direct RPC -> desktop confirmation gate -> actual member requests.
// All connections and credentials are generated test fixtures confined to loopback and a temp dir.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../app/server/index.mjs';
import { createDirectHost } from '../app/server/remote-direct.mjs';
import { createControlPlane } from '../app/server/control-plane.mjs';
import { randomSecret } from '../app/shared/relay-protocol.mjs';

const chromePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
assert.ok(chromePath, 'Set CHROME_PATH to a Chromium executable');
async function until(predicate, what) {
  for (let i = 0; i < 150; i++) { const result = await predicate(); if (result) return result; await sleep(100); }
  throw Error('Timed out: ' + what);
}
const dir = await mkdtemp(path.join(tmpdir(), 'hg-phone-team-'));
const userData = path.join(dir, 'browser');
const pairSecret = randomSecret(), keyA = randomSecret(), keyB = randomSecret();
let leaderTurns = 0, writes = 0, host, app, browser, ws;
const children = [];
const upstream = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), tools = body.tools ?? [];
  let delta = { content: 'done' }, finish_reason = 'stop';
  if (tools.some(t => t.function.name === 'team_run')) {
    if (++leaderTurns === 1) {
      delta = { tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'team_run', arguments: JSON.stringify({ background: false, name: '测试 Team', goal: '验证选模', members: [{ name: 'A', task: 'first' }, { name: 'B', task: 'second' }, { name: 'C', task: 'third' }] }) } }] };
      finish_reason = 'tool_calls';
    }
  } else if (tools.some(t => t.function.name === 'team_note')) {
    children.push({ model: body.model, backup: req.headers.authorization === 'Bearer ' + keyB, url: req.url });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }] })}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  app = await startServer({ dataDir: dir, defaultWorkspace: path.join(dir,'workspace'), port: 0, seedExternalSkills: false });
  const origin = 'http://127.0.0.1:' + app.address().port, harness = app.app.locals.harness;
  async function api(method, route, body) {
    const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, route + ': ' + response.status); return response;
  }
  const leaderId = harness.store.settings.activeProfileId, backupId = randomUUID();
  const provider = `http://127.0.0.1:${upstream.address().port}`;
  const profile = (id, name, model, backup) => ({ id, name, chatModel: model, agentModel: model, protocol: 'chat', baseUrl: provider + (backup ? '/backup/v1' : '/leader/v1'), apiKey: backup ? keyB : keyA });
  const other = Array.from({ length: 35 }, (_, i) => profile(randomUUID(), '测试连接' + i, '测'.repeat(110) + i, false));
  await api('PUT','/api/settings',{ profiles: [profile(leaderId,'Leader','leader-model',false), ...other, { ...profile(backupId,'Backup','backup-default',true), agentModel: '' }], activeProfileId: leaderId, approvalMode: 'full' });
  const session = await (await api('POST','/api/sessions',{})).json(), sessionId = session.id ?? session.session.id;
  const turn = api('POST',`/api/sessions/${sessionId}/messages`,{ mode: 'agent', text: '组队测试' }).then(r => r.text());
  const plane = createControlPlane({ harness, origin, dataDir: dir });
  const [entry] = await until(() => plane.snapshot().teamConfigurations.length && plane.snapshot().teamConfigurations, 'pending gate');
  const params = { sessionId, configurationId: entry.id };
  const act = (action, data) => plane.execute({ action, params: data });
  const first = await act('team.configuration.get', params);
  assert.ok(first.nextOffset > 0); assert.equal(first.members.length, 3);
  assert.deepEqual(Object.keys(first.profiles[0]).sort(), ['defaultModel','id','name']);
  assert.ok(!JSON.stringify(first).includes(keyA) && !JSON.stringify(first).includes(provider));
  await assert.rejects(act('team.configuration.get', { ...params, sessionId: randomUUID() }), e => e.status === 403);
  await assert.rejects(act('team.configuration.submit', { ...params, members: [] }), e => e.status === 400);
  assert.equal(children.length, 0);
  host = createDirectHost({ origin, harness, dataDir: dir, config: { enabled: true, pairSecret, devices: [] }, host: '127.0.0.1', fetchImpl: (...args) => { writes++; return fetch(...args); } });
  await host.start({ listenPort: 0 });
  browser = spawn(chromePath, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir=' + userData,'about:blank'],{ windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => (await readFile(path.join(userData,'DevToolsActivePort'),'utf8').catch(() => '')).split('\n')[0], 'browser');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener('open',resolve,{ once:true }));
  let seq = 0; const pending = new Map();
  ws.onmessage = ({data}) => { const msg = JSON.parse(data); pending.get(msg.id)?.(msg); pending.delete(msg.id); };
  const cdp = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({id,method,params})); });
  const evaluate = async expression => { const out = await cdp('Runtime.evaluate',{expression,returnByValue:true}); assert.ok(!out.result?.exceptionDetails, 'page evaluation'); return out.result.result.value; };
  await cdp('Emulation.setDeviceMetricsOverride',{ width:390, height:844, deviceScaleFactor:1, mobile:true });
  await cdp('Page.navigate',{ url: `http://127.0.0.1:${host.describe().port}/#c=${pairSecret}` });
  await until(() => evaluate(`document.querySelectorAll('[data-member]').length === 3`),'phone configuration form');
  assert.equal(await evaluate(`document.querySelector('[data-profile]').options.length`), 38);
  assert.equal(await evaluate(`document.querySelectorAll('datalist option[value="backup-default"]').length`), 1);
  await evaluate(`const row = document.querySelector('[data-member]'), profile = row.querySelector('select'); profile.value=${JSON.stringify(backupId)}; profile.dispatchEvent(new Event('change')); window.testModel=row.querySelector('input'); testModel.focus(); testModel.value='phone-choice'; testModel.dispatchEvent(new Event('input'))`);
  await sleep(3400); // Cross a real direct HTTP snapshot poll while editing.
  assert.equal(await evaluate(`document.activeElement === testModel && testModel.value === 'phone-choice' && testModel.placeholder.includes('backup-default')`), true);
  assert.equal(await evaluate(`document.querySelector('#badgePending').textContent`),'1');
  await evaluate(`document.querySelectorAll('[data-profile]')[2].value=${JSON.stringify(backupId)}`);
  await evaluate(`document.querySelector('[data-confirm]').click(); document.querySelector('[data-confirm]')?.click()`);
  assert.match(await turn,/event: done/); await until(() => evaluate(`!document.querySelector('[data-member]')`),'gate closed');
  assert.equal(writes,1);
  assert.ok(children.some(c => c.backup && c.url.includes('/backup/') && c.model === 'phone-choice'));
  assert.ok(children.some(c => !c.backup && c.url.includes('/leader/') && c.model === 'leader-model'));
  assert.ok(children.some(c => c.backup && c.url.includes('/backup/') && c.model === 'backup-default'));
  assert.equal(plane.snapshot().teamConfigurations.length,0);
  await assert.rejects(act('team.configuration.submit', { ...params, cancel:true }), e => e.status === 404);
  console.log('PASS: 390px phone, paged public profiles, draft/focus across poll, single submission, real member requests use selected connection/model and leader inheritance; stale/invalid requests rejected.');
} finally {
  ws?.close(); if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit',resolve)); browser.kill(); await exited; }
  await host?.stop(); await app?.stop(); await new Promise(resolve => upstream.close(resolve));
  await rm(dir,{ recursive: true, force: true, maxRetries:15, retryDelay:150 });
}
