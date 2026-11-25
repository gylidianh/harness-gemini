import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createTaskbarAttention } from '../app/desktop/taskbar-attention.mjs';
import { createPendingUserActionQueues } from '../app/server/pending-user-actions.mjs';
import { QuestionManager } from '../app/server/questions.mjs';
import { ApprovalManager } from '../app/server/tools.mjs';
import { TeamConfigurationManager } from '../app/server/team-configurations.mjs';

const icon = Symbol('static blue dot');
const finished = (status = 'done') => ({ sessionId: randomUUID(), messageId: randomUUID(), mode: 'agent', status, title: 'PRIVATE' });
class Window extends EventEmitter {
  visible = true; focused = false; minimized = false; destroyed = false;
  calls = []; blue = false; red = false; flashing = false;
  isDestroyed() { return this.destroyed; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible; }
  setOverlayIcon(image, label) { this.calls.push('badge'); this.blue = image === icon; assert.equal(image, this.blue ? icon : null); assert.equal(label, this.blue ? '等待你的操作' : ''); }
  setProgressBar(value, options) { this.calls.push('progress'); this.red = value === 1; assert.equal(value, this.red ? 1 : -1); assert.equal(options?.mode, this.red ? 'error' : undefined); }
  flashFrame(on) { this.calls.push('flash'); this.flashing = on; }
  expect(blue, red) { assert.deepEqual([this.blue, this.red, this.flashing], [blue, red, red]); }
}
function fixture(platform = 'win32') {
  const ctx = { window: new Window(), suppressed: false };
  ctx.attn = createTaskbarAttention({ platform, waitingIcon: icon, getWindow: () => ctx.window, isSuppressed: () => ctx.suppressed });
  return ctx;
}

test('blue takes priority over unread done/error, and last resolution reveals deferred red', () => {
  const { window: w, attn } = fixture();
  for (const status of ['done', 'error']) {
    const event = finished(status);
    attn.notify(event); w.expect(false, true);
    attn.setWaiting(true); w.expect(true, false);
    const painted = w.calls.length;
    attn.notify(finished(status)); attn.setWaiting(true); attn.refresh();
    assert.equal(w.calls.length, painted);
    attn.setWaiting(false); w.expect(false, true);
    w.focused = true; w.emit('focus'); w.expect(false, false);
    w.focused = false; w.emit('blur'); attn.notify(event); w.expect(false, false);
  }
  attn.dispose();
});
test('foreground acknowledges red, but outstanding actions return on blur/hide/minimize', async () => {
  const { window: w, attn } = fixture();
  w.focused = true; attn.setWaiting(true); attn.notify(finished()); w.expect(false, false);
  w.minimized = true; w.emit('minimize'); w.expect(true, false);
  w.minimized = false; w.emit('restore'); w.expect(false, false);
  // Native event can precede the visibility change.
  w.emit('hide'); w.visible = false; await Promise.resolve(); w.expect(true, false);
  w.visible = true; w.emit('show'); w.expect(false, false);
  w.focused = false; w.emit('blur'); w.expect(true, false);
  attn.setWaiting(false); w.expect(false, false); attn.dispose();
});
test('no window, suppressed modal, replacement, disposal and non-Windows', () => {
  const ctx = fixture(), { attn, window: old } = ctx;
  ctx.window = null; attn.setWaiting(true); attn.notify(finished());
  ctx.window = old; ctx.suppressed = true; attn.attach(); old.expect(false, false);
  ctx.suppressed = false; attn.refresh(); old.expect(true, false);
  ctx.window = new Window(); attn.attach(); old.expect(false, false); ctx.window.expect(true, false);
  assert.equal(old.listenerCount('blur'), 0);
  ctx.suppressed = true; attn.setWaiting(false); ctx.window.expect(false, false);
  ctx.suppressed = false; attn.refresh(); ctx.window.expect(false, true);
  attn.dispose(); ctx.window.expect(false, false);
  attn.notify(finished()); attn.setWaiting(true); ctx.window.expect(false, false);
  assert.equal(ctx.window.listenerCount('closed'), 0);
  const other = fixture('darwin'); other.attn.attach(); other.attn.setWaiting(true); other.attn.notify(finished());
  assert.deepEqual(other.window.calls, []); assert.equal(other.window.listenerCount('blur'), 0);
});
test('multiple real manager queues coalesce to one bit and unwind on answer, denial, abort, timeout, publish error and shutdown', async () => {
  const edges = [], queues = createPendingUserActionQueues((...args) => edges.push(args));
  const team = new TeamConfigurationManager({ pending: queues.teamConfigurations, timeoutMs: 30 });
  const question = new QuestionManager({ pending: queues.questions }), approval = new ApprovalManager({ pending: queues.approvals });
  const config = { specification: { name: 'PRIVATE', members: [{ id:'m1', task:'PRIVATE' }] }, sessionId: 'session' };
  const ask = { question:'PRIVATE', sessionId:'session', assistant:{ id:'assistant' }, emit:()=>{}, save:()=>{} };
  const q = question.ask(ask), a = approval.ask({ args:{private: true}, emit:()=>{} }), t = team.request(config);
  assert.deepEqual(edges, [[true]]);
  approval.decide(approval.pending.keys().next().value, false); assert.equal(await a, false);
  const id = team.list()[0].id;
  assert.throws(() => team.submit(id, {sessionId:'session', members:[]})); // invalid submit does not clear badge
  team.submit(id, {sessionId:'session', cancel:true}); await assert.rejects(t);
  assert.deepEqual(edges, [[true]]);
  await question.answer({sessionId:'session', questionId:ask.assistant.questions[0].id, answer:'PRIVATE'}); await q;
  assert.deepEqual(edges, [[true],[false]]);
  const ac = new AbortController(), stopped = question.ask({...ask, signal:ac.signal}); ac.abort(); await assert.rejects(stopped);
  const failed = question.ask({...ask, save:async()=>{ throw Error('save'); }}); await assert.rejects(failed);
  const closing = team.request(config); team.cancelAll(); await assert.rejects(closing);
  // Production timeout is unref'd; keep the test process alive while checking it.
  const keepAlive = setTimeout(()=>{}, 1000);
  try { await assert.rejects(team.request(config), /超时/); } finally { clearTimeout(keepAlive); }
  assert.deepEqual(edges, Array.from({ length:5 }, ()=>[[true],[false]]).flat());
});
