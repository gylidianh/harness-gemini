'use strict';
// node tests/remote-question-draft.cjs — isolated, real Chromium DOM in a phone-sized window.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'remote-question-draft-'));
  env.QUESTION_DRAFT_TEST_PROFILE = tmp;
  try {
    const child = require('node:child_process').spawnSync(require('electron'), [__filename], { env, windowsHide: true, timeout: 45000, stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); }
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.QUESTION_DRAFT_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let win, code = 1;
    try {
      const page = fs.readFileSync(path.join(root, 'app/remote/phone.html'), 'utf8');
      const module = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
      const logic = module.slice(0, module.lastIndexOf('transport = await detectTransport();')).replace(/^import .*;$/gm, '');
      win = new BrowserWindow({ show: false, width: 390, height: 844 });
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page.replace(/<script type="module">[\s\S]*?<\/script>/, '')));
      const protocol = fs.readFileSync(path.join(root, 'app/shared/relay-protocol.mjs')).toString('base64');
      const count = await win.webContents.executeJavaScript(`(async () => {const {sealPlain, openPlain, isPlainEnvelope} = await import('data:text/javascript;base64,${protocol}');\n${logic}\nreturn await (${verify.toString()})();})()`);
      console.log(`PASS: ${count} remote question checks`);
      code = 0;
    } catch (error) { console.error(error); }
    finally { win?.destroy(); app.exit(code); }
  });
}

async function verify() {
  let count = 0, resolveAnswer, rejectAnswer;
  const check = (condition, name) => { if (!condition) throw new Error(name); count++; };
  const writes = [];
  const q1 = { sessionId: 's1', questionId: 'q1', question: '第一个问题', options: ['确认', '取消'] };
  const q2 = { ...q1, questionId: 'q2', question: '第二个问题' };
  let data = { questions: [q1] };
  // Drive the production refresh paths; stub the RPC boundary only.
  invoke = async (action, params) => {
    if (action === 'pending.list') return structuredClone(data);
    if (action === 'sessions.list') return { sessions: [] };
    if (action !== 'question.answer') throw new Error('unexpected action ' + action);
    writes.push(params);
    return new Promise((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  };
  device = { deviceId: 'device-1' }; transport = 'plain'; directHttp = true;
  $('app').classList.remove('hide');
  await refreshDirect();
  const cards = () => [...$('questions').children];
  const first = cards()[0], input = first.querySelector('input');
  const send = first.querySelector('[data-send]');
  input.focus(); input.value = '  自定义答复  '; input.setSelectionRange(3, 5);
  let blurred = false; input.onblur = () => { blurred = true; };
  input.dispatchEvent(new CompositionEvent('compositionstart'));
  data = { questions: [q2, { ...q1, title: '更新标题', options: ['继续'] }], live: [{ sessionId: 's2', title: '另一个会话', state: 'running' }] };
  await refreshDirect(); await refreshAll();
  check(input.isConnected && input === first.querySelector('input') && input.value === '  自定义答复  ', 'polls keep the same editor and draft');
  check(!blurred && document.activeElement === input && input.selectionStart === 3 && input.selectionEnd === 5, 'no blur or selection loss during composition');
  check(first.querySelector('.card-title').textContent === '更新标题' && first.querySelector('[data-option]').textContent === '继续', 'server metadata still updates');
  check($('questionsCount').textContent === '2' && $('liveCount').textContent === '1', 'polling still updates other pending items');
  await handle(sealPlain('pending.snapshot', data));
  check(!blurred && document.activeElement === input && input.selectionEnd === 5, 'SSE snapshot also preserves the active editor');
  input.dispatchEvent(new CompositionEvent('compositionend'));
  const second = cards().find(node => node !== first);
  second.querySelector('input').value = '独立草稿';
  const attempt = send.onclick(); send.onclick(); await refreshDirect();
  check(send.disabled && first.querySelector('[data-option]').disabled && writes.length === 1, 'in-flight submit locks controls even across a poll');
  check(JSON.stringify(writes[0]) === JSON.stringify({ sessionId: 's1', questionId: 'q1', answer: '自定义答复' }), 'custom answer routed to the correct question');
  rejectAnswer(new Error('test rejection')); await attempt;
  check(!send.disabled && !input.readOnly && input.value === '  自定义答复  ', 'error keeps the draft and allows retry');
  const retry = send.onclick(); resolveAnswer({}); await retry;
  await refreshDirect(); // deliberately stale pending.list still contains the acknowledged question
  check(!first.isConnected && cards().length === 1 && $('questionsCount').textContent === '1', 'accepted question does not return on a stale poll');
  check(second.isConnected && second.querySelector('input').value === '独立草稿', 'only the submitted draft was cleared');
  data = { questions: [{ ...q2, sessionId: 's2' }] }; await refreshDirect();
  const switched = cards()[0];
  check(!second.isConnected && switched.querySelector('input').value === '', 'same question ID in a new session starts fresh');
  switched.querySelector('[data-send]').click();
  check(writes.length === 2, 'blank submission sends no request');
  switched.querySelector('[data-option]').click();
  check(writes.length === 3 && writes[2].answer === '确认' && writes[2].sessionId === 's2', 'preset choice submits to the correct new session');
  // The old completion must not remove the next request.
  data = { questions: [q1] }; await refreshDirect(); resolveAnswer({}); await new Promise(resolve => setTimeout(resolve, 0));
  check(cards().length === 1 && cards()[0].querySelector('input').value === '', 'superseded write cannot clear the next request');
  data = {}; await refreshDirect();
  check(cards().length === 0 && !$('emptyCard').classList.contains('hide') && $('badgePending').textContent === '0', 'empty state and badge recover');
  stopConnection();
  return count;
}
