/**
 * Agent Teams: one leader splits a goal across named members that share a single board.
 *
 * Why this exists next to `spawn_subagent`: a delegation is a fan-out with no memory. Several
 * children can run at once, but each one is blind to what its siblings found, nobody owns a
 * work item, and the only thing that comes back is a pile of conclusions. A team keeps the
 * shape of the work while it happens: who owns which item, what is blocked on what, what each
 * member reported, and what they said to each other. That shape is also what the desktop panel
 * draws — one lane per member, one card per work item, one line per hand-off.
 *
 * The design follows the product idea of cc-haha's Agent Teams workspace (a leader, parallel
 * members, a shared task board, member-to-member messages, dependency lanes). This file is an
 * independent implementation: no cc-haha source is copied. cc-haha ships under the cc-haha
 * Community Source License 1.0, which is not an OSI licence, so only the interaction design is
 * borrowed here, never the code.
 *
 * Three properties are enforced here rather than left to the model:
 *
 *  - Members never talk to the user. They have one task, they may leave notes and messages on
 *    the board, and they must end with a conclusion.
 *  - A member is offered exactly the tools it needs: the leader's tool set minus anything
 *    interactive, plus the three board tools. Every real action it takes still goes through the
 *    same plan/approve/execute path as the leader's own calls.
 *  - The board is bounded. Polling it from the interface is cheap by design: long text is
 *    trimmed on the server, not in the renderer.
 */
import { randomUUID } from 'node:crypto';
import { boundedString, HttpError } from './util.mjs';

/** A team is a small group on purpose: one leader cannot supervise more than this well. */
export const MAX_TEAM_MEMBERS = 4;
export const MAX_TEAM_TASKS = 24;
/** How many hand-offs one board keeps. The panel only ever shows the tail. */
export const MAX_TEAM_MESSAGES = 240;
export const MAX_TEAM_GOAL_CHARS = 2_000;
export const MAX_MEMBER_TASK_CHARS = 4_000;
export const MAX_TEAM_NAME_CHARS = 40;
/** How many tool names one member may be narrowed to. */
export const MAX_MEMBER_TOOLS = 12;
export const MAX_MEMBER_MODEL_CHARS = 120;
/** How many approvals one board keeps visible at a time. */
export const MAX_TEAM_APPROVALS = 12;
/**
 * How many times one member may be woken again after it returned.
 *
 * A wake is a whole new run: it spends real tokens, so a leader that keeps mailing a finished
 * member must not be able to loop forever. Three is enough for a real hand-off ("here is the
 * missing key", "re-check the number", "now write it up").
 */
export const MAX_MEMBER_WAKES = 3;
export const MAX_MEMBER_PROFILE_CHARS = 80;

/** The three tools that only exist inside a team run. */
export const TEAM_MEMBER_TOOL_NAMES = new Set(['team_note', 'team_message', 'team_task']);

const MEMBER_NAME_CHARS = 24;
const TASK_TITLE_CHARS = 120;
const TASK_DETAIL_CHARS = 2_000;
const NOTE_CHARS = 1_200;
const MESSAGE_CHARS = 1_200;
/** How much of a member's streamed text the board snapshot keeps for the UI panel. */
const MEMBER_TEXT_TAIL = 600;
/** Full member conclusion cap retained on the board for summary() (6000) and wake continuations. */
const MAX_MEMBER_TEXT_CHARS = 24_000;
const MEMBER_ACTIVITY_CHARS = 160;
/** How many hand-offs travel back to the leader model: enough to see the flow, not the whole log. */
const RESULT_MESSAGES = 12;
const RESULT_ANSWER_CHARS = 6_000;

const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'blocked'];
const MEMBER_STATUSES = ['pending', 'running', 'done', 'error', 'cancelled'];

function text(value, max) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw.trim().slice(0, max);
}

function stamp() {
  return new Date().toISOString();
}

function uniqueName(candidate, taken) {
  const base = candidate.slice(0, MEMBER_NAME_CHARS) || '成员';
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const next = `${base.slice(0, MEMBER_NAME_CHARS - String(index).length)}${index}`;
    if (!taken.has(next)) return next;
  }
  return `${base.slice(0, MEMBER_NAME_CHARS - 6)}${taken.size}`;
}

/**
 * Normalize one `team_run` call before anything is started.
 *
 * Names are the address of a member's inbox, so they are made unique here: two members called
 * "前端" would otherwise share one mailbox and one lane.
 */
export function normalizeTeamArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('team_run 需要一个对象参数。');
  const goal = text(args.goal, MAX_TEAM_GOAL_CHARS);
  if (!goal) throw new Error('team_run 需要 goal：请写清这个团队要一起达成的整体目标。');
  const raw = Array.isArray(args.members) ? args.members : [];
  if (!raw.length) throw new Error('team_run 需要至少一名成员，每名成员写清 name 与 task。');
  if (raw.length > MAX_TEAM_MEMBERS) throw new Error(`一次最多 ${MAX_TEAM_MEMBERS} 名成员；更多工作请拆成多轮团队。`);
  const taken = new Set();
  const members = raw.map((item, index) => {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const task = text(source.task ?? source.prompt, MAX_MEMBER_TASK_CHARS);
    if (!task) throw new Error(`第 ${index + 1} 名成员缺少 task：请写清交给它的具体任务与期望产出。`);
    const name = uniqueName(text(source.name, MEMBER_NAME_CHARS) || `成员${index + 1}`, taken);
    taken.add(name);
    return {
      id: `m${index + 1}`,
      name,
      role: text(source.role, 60) || '成员',
      task,
      // An empty model means "whatever this connection uses", the same as the leader.
      model: text(source.model, MAX_MEMBER_MODEL_CHARS),
      // 1.8.3: a member may run on another configured connection — its own endpoint, key and
      // model. Only the connection changes: approval mode, workspace and every permission stay
      // the turn's, so choosing a provider can never widen what a member is allowed to do.
      profile: text(source.profile ?? source.connection, MAX_MEMBER_PROFILE_CHARS),
      // A member's tool set is a *narrowing* of the leader's, never an addition. It is resolved
      // against what this turn really offers when the team starts; the resolved list is put on
      // the board so the panel can show what each member actually got.
      tools: Array.isArray(source.tools)
        ? [...new Set(source.tools.map(entry => text(entry, 60)).filter(Boolean))].slice(0, MAX_MEMBER_TOOLS)
        : [],
    };
  });
  return {
    name: text(args.name, MAX_TEAM_NAME_CHARS) || `团队 · ${members.length} 人`,
    goal,
    // 1.8.2: members keep working after the tool call returns, so the leader can do its own part
    // meanwhile and collect the conclusions with team_wait. `background: false` is the old
    // behaviour: the call does not return until everybody is done.
    background: args.background !== false,
    members,
  };
}

function emptyStats() {
  return { total: 0, done: 0, failed: 0, running: 0, pending: 0, blocked: 0, percent: 0 };
}

/**
 * The shared board: the only thing the members, the leader and the panel all read.
 *
 * It is a plain object graph on purpose — no timers, no model calls, no filesystem — so the
 * whole collaboration model can be tested offline and rendered without the server.
 */
export class TeamBoard {
  constructor({ name, goal, members, sessionId = null, workspace = null, model = '', background = true, createdAt = stamp() }) {
    this.id = randomUUID();
    this.sessionId = sessionId;
    this.name = name;
    this.goal = goal;
    this.workspace = workspace;
    this.model = model;
    this.status = 'running';
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
    this.finishedAt = null;
    this.seq = 0;
    // 'background': the leader is free while the members work. 'blocking': it waits inside the
    // tool call. The distinction is shown in the panel, because it changes what "running" means.
    this.mode = background ? 'background' : 'blocking';
    this.tasks = [];
    this.messages = [];
    /**
     * Permissions a member is waiting for. A background member may outlive the turn that started
     * it, so the SSE stream it would have used can be gone; the panel reads this list instead and
     * answers through the same POST /api/approvals/:id the transcript uses. `approvalId` is the
     * approval manager's id and is null until the request has actually been emitted.
     */
    this.approvals = [];
    /**
     * 1.8.3: work in flight, not "members that have not returned".
     *
     * A member can be started a second time by a wake, so the board cannot decide it is finished
     * from a single promise. Everything that runs — first wave or wake — brackets itself with
     * beginWork/endWork, and team_wait waits for idle instead of for one promise.
     */
    this.inflight = 0;
    this.idleWaiters = [];
    this.finalStatus = null;
    this.members = (members ?? []).map((member, index) => ({
      id: member.id ?? `m${index + 1}`,
      name: member.name,
      role: member.role ?? '成员',
      task: member.task ?? '',
      status: 'pending',
      model: member.model ?? '',
      // 1.8.3: what the spec asked for, and what was resolved against the configured connections.
      profile: member.profile ?? '',
      profileId: '',
      profileName: '',
      // How many times it was woken after returning, and whether a wake is already queued.
      wakes: 0,
      wakePending: false,
      tools: Array.isArray(member.tools) ? member.tools : [],
      toolsGranted: null,
      toolsDropped: [],
      rounds: 0,
      steps: 0,
      tokens: 0,
      activity: '',
      text: '',
      error: null,
      startedAt: null,
      finishedAt: null,
      inbox: [],
      taskId: null,
    }));
    // Every member starts as one work item on the board. Ownership is visible from the first
    // frame instead of appearing only after a member happens to add a card.
    for (const member of this.members) {
      const card = this.addTask({
        title: text(member.task.split(/\r?\n/)[0], TASK_TITLE_CHARS) || member.task.slice(0, TASK_TITLE_CHARS),
        detail: member.task,
        owner: member.name,
        memberId: member.id,
        status: 'in_progress',
      });
      member.taskId = card.id;
    }
    this.note({ from: '队长', kind: 'system', text: `团队已组建：${goal}` });
  }

  touch() {
    this.updatedAt = stamp();
    this.seq += 1;
  }

  memberByName(value) {
    const needle = text(value, MEMBER_NAME_CHARS + 20);
    if (!needle) return null;
    return this.members.find(member => member.name === needle)
      ?? this.members.find(member => member.id === needle)
      ?? this.members.find(member => member.name.startsWith(needle) || needle.startsWith(member.name))
      ?? null;
  }

  addTask({ title, detail = '', owner = null, memberId = null, status = 'pending', dependsOn = [] } = {}) {
    if (this.tasks.length >= MAX_TEAM_TASKS) throw new HttpError(409, `共享看板最多 ${MAX_TEAM_TASKS} 个任务，请先完成或合并一些任务。`);
    const cleanTitle = text(title, TASK_TITLE_CHARS);
    if (!cleanTitle) throw new HttpError(400, '共享任务需要一个 title。');
    const known = new Set(this.tasks.map(task => task.id));
    // An entry may be an id (from the leader) or a title (from a member), so it is resolved to
    // the card first and only then reduced to an id; mixing the two shapes dropped every id.
    const deps = (Array.isArray(dependsOn) ? dependsOn : [])
      .map(entry => {
        const wanted = text(entry, TASK_TITLE_CHARS + 40);
        if (!wanted) return null;
        return this.tasks.find(task => task.id === wanted)
          ?? this.tasks.find(task => task.title === wanted)
          ?? this.tasks.find(task => task.title.startsWith(wanted))
          ?? null;
      })
      .filter(Boolean)
      .map(task => task.id)
      .filter(id => known.has(id));
    const task = {
      id: `t${this.tasks.length + 1}-${randomUUID().slice(0, 4)}`,
      title: cleanTitle,
      detail: text(detail, TASK_DETAIL_CHARS),
      owner: owner ? text(owner, MEMBER_NAME_CHARS) : null,
      memberId,
      status: TASK_STATUSES.includes(status) ? status : 'pending',
      dependsOn: [...new Set(deps)],
      result: '',
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    this.tasks.push(task);
    this.touch();
    return task;
  }

  updateTask(id, patch = {}) {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new HttpError(404, '共享看板上没有这个任务。');
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.includes(patch.status)) throw new HttpError(400, '任务状态只能是 pending / in_progress / done / failed / blocked。');
      task.status = patch.status;
    }
    if (patch.result !== undefined) task.result = text(patch.result, TASK_DETAIL_CHARS);
    if (patch.owner !== undefined) task.owner = patch.owner ? text(patch.owner, MEMBER_NAME_CHARS) : null;
    if (patch.owner && !task.memberId) task.memberId = this.memberByName(patch.owner)?.id ?? task.memberId;
    task.updatedAt = stamp();
    this.touch();
    return task;
  }

  /** A member takes over one unowned card. Returns null when there is nothing to take. */
  claimTask(id, memberName, memberId) {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new HttpError(404, '共享看板上没有这个任务。');
    if (task.owner && task.owner !== memberName) throw new HttpError(409, `任务「${task.title}」已经由 ${task.owner} 接手。`);
    task.owner = memberName;
    task.memberId = memberId ?? task.memberId;
    if (task.status === 'pending') task.status = 'in_progress';
    task.updatedAt = stamp();
    this.touch();
    return task;
  }

  /** The member's own card follows its run: a finished member's card is done, not left open. */
  completeMemberTasks(memberId, status, result) {
    const wanted = status === 'done' ? 'done' : 'failed';
    for (const task of this.tasks) {
      if (task.memberId !== memberId) continue;
      if (task.status === 'done' || task.status === 'failed') continue;
      task.status = wanted;
      task.result = text(result, TASK_DETAIL_CHARS);
      task.updatedAt = stamp();
    }
    this.touch();
  }

  note({ from, to = '*', kind = 'note', text: body }) {
    const clean = text(body, kind === 'result' ? TASK_DETAIL_CHARS : NOTE_CHARS);
    if (!clean) return null;
    const message = {
      id: `msg${this.messages.length + 1}-${randomUUID().slice(0, 4)}`,
      seq: this.messages.length + 1,
      from: text(from, MEMBER_NAME_CHARS) || '成员',
      to: text(to, MEMBER_NAME_CHARS) || '*',
      kind,
      text: clean,
      at: stamp(),
    };
    this.messages.push(message);
    while (this.messages.length > MAX_TEAM_MESSAGES) this.messages.shift();
    this.touch();
    return message;
  }

  /** A message is both a visible hand-off and a mailbox entry for a running member. */
  sendMessage({ from, to, text: body }) {
    return this.requestWake({ from, to, text: body, wake: false });
  }

  /** What a member's next round is told. Draining, so a message is delivered exactly once. */
  takeInbox(memberId) {
    const member = this.members.find(item => item.id === memberId) ?? this.members.find(item => item.name === memberId);
    if (!member || !member.inbox.length) return [];
    const queued = member.inbox.splice(0, member.inbox.length);
    return queued;
  }

  /**
   * Record what a member was really offered. Called once when its run starts: an empty request
   * means "everything the leader has", which is exactly what the leader's own list was.
   */
  setMemberTools(memberId, { granted = [], dropped = [] } = {}) {
    const member = this.members.find(item => item.id === memberId);
    if (!member) return null;
    member.toolsGranted = [...new Set(granted)];
    member.toolsDropped = [...new Set(dropped)];
    this.touch();
    return member;
  }

  /** A member asked for permission. Returns the board entry the panel draws. */
  addApproval({ member, tool, summary }) {
    const entry = {
      id: `appr${this.approvals.length + 1}-${randomUUID().slice(0, 4)}`,
      approvalId: null,
      member: text(member, MEMBER_NAME_CHARS) || '成员',
      tool: text(tool, 60),
      summary: text(summary, 600),
      status: 'pending',
      at: stamp(),
    };
    this.approvals.push(entry);
    while (this.approvals.length > MAX_TEAM_APPROVALS) this.approvals.shift();
    this.note({ from: entry.member, to: '用户', kind: 'approval', text: entry.summary });
    return entry;
  }

  /** The approval manager gave the request an id; the panel needs that id to answer it. */
  bindApproval(entryId, approvalId) {
    const entry = this.approvals.find(item => item.id === entryId);
    if (!entry || !approvalId) return null;
    entry.approvalId = String(approvalId);
    this.touch();
    return entry;
  }

  resolveApproval(entryId, approved) {
    const entry = this.approvals.find(item => item.id === entryId);
    if (!entry) return null;
    entry.status = approved ? 'approved' : 'denied';
    entry.resolvedAt = stamp();
    this.touch();
    return entry;
  }

  /** Only what still needs a person: the panel is an inbox, not an audit log. */
  pendingApprovals() {
    return this.approvals.filter(entry => entry.status === 'pending' && entry.approvalId);
  }

  updateMember(memberId, patch = {}) {
    const member = this.members.find(item => item.id === memberId) ?? this.members.find(item => item.name === memberId);
    if (!member) return null;
    if (patch.status !== undefined && MEMBER_STATUSES.includes(patch.status)) member.status = patch.status;
    if (patch.rounds !== undefined) member.rounds = patch.rounds;
    if (patch.steps !== undefined) member.steps = patch.steps;
    if (patch.text !== undefined) member.text = String(patch.text ?? '').slice(0, MAX_MEMBER_TEXT_CHARS);
    if (patch.activity !== undefined) member.activity = text(patch.activity, MEMBER_ACTIVITY_CHARS);
    if (patch.error !== undefined) member.error = patch.error ? text(patch.error, 400) : null;
    if (patch.tokens !== undefined) member.tokens = patch.tokens;
    if (patch.startedAt !== undefined) member.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) member.finishedAt = patch.finishedAt;
    this.touch();
    return member;
  }

  /** 1.8.3: work started (a member run, initial or woken). */
  beginWork() {
    this.inflight += 1;
    this.touch();
    return this.inflight;
  }

  isIdle() {
    return this.inflight === 0 && !this.members.some(member => member.status === 'running' || member.wakePending);
  }

  /** 1.8.3: work settled; the board becomes finished only when nothing else is running or wakePending. */
  endWork() {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.isIdle()) {
      if (this.finalStatus) this.applyFinal();
      this.resolveIdle();
    }
    this.touch();
    return this.inflight;
  }

  whenIdle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  resolveIdle() {
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  applyFinal() {
    this.status = this.finalStatus ?? this.status;
    this.finishedAt ??= stamp();
    this.finalStatus = null;
    this.note({ from: '队长', kind: 'system', text: `团队结束：${this.status === 'done' ? '全部成员已返回结论' : this.status === 'cancelled' ? '已停止' : '有成员失败，已保留其余结论'}` });
    this.touch();
  }

  /**
   * 1.8.3: put a finished board back to work.
   *
   * A wake is a new run of an existing member, so the team is running again — the panel must not
   * keep saying "已完成" while somebody is actually working.
   */
  reopen() {
    if (this.status === 'running') return this;
    this.status = 'running';
    this.finishedAt = null;
    this.finalStatus = null;
    this.note({ from: '队长', kind: 'system', text: '有成员被重新唤起，团队继续处理新的留言。' });
    this.touch();
    return this;
  }

  /**
   * 1.8.3: mail for a member, with the wake decision made here.
   *
   * While a member is running, a message simply waits in its inbox for the next round. Once it
   * has settled nothing would ever read that inbox again, so an explicit wake starts it a second
   * time — with its previous conclusion and the new message. The cap is enforced here, not in the
   * caller: a wake costs a whole run, and the model must not be able to loop.
   */
  requestWake({ from, to, text: body, wake = true }) {
    const clean = text(body, MESSAGE_CHARS);
    if (!clean) throw new HttpError(400, '给团队成员的留言不能为空。');
    const sender = text(from, MEMBER_NAME_CHARS) || '队长';
    const senderIsMember = this.members.some(member => member.name === sender || member.name === from);
    const target = text(to, MEMBER_NAME_CHARS + 20);
    if (target === '*' || !target) {
      const live = this.members.filter(member => member.name !== sender && member.name !== from && (member.status === 'running' || member.status === 'pending' || member.wakePending));
      if (!live.length) {
        if (!senderIsMember) throw new HttpError(409, '现在没有还在运行的成员；要唤起某个已返回的成员，请 to 写它的名字。');
        this.note({ from: sender, to: '*', kind: 'message', text: clean });
        return { queued: false, woke: false, deliveredTo: [], live: false, reason: '当前没有其他还在运行的队友，留言已记入共享看板。' };
      }
      for (const member of live) member.inbox.push(`${sender} 留言：${clean}`);
      this.note({ from: sender, to: '*', kind: 'message', text: clean });
      return { queued: true, woke: false, deliveredTo: live.map(member => member.name), live: true };
    }
    const member = this.memberByName(target);
    if (!member) throw new HttpError(404, `团队里没有成员「${target}」，可用成员：${this.members.map(item => item.name).join('、')}。`);
    member.inbox.push(`${sender} 留言：${clean}`);
    this.note({ from: sender, to: member.name, kind: 'message', text: clean });
    const live = member.status === 'running' || member.status === 'pending' || Boolean(member.wakePending);
    if (!wake || live) return { queued: true, woke: false, member: member.name, deliveredTo: [member.name], live };
    if (member.wakes >= MAX_MEMBER_WAKES) {
      return {
        queued: true, woke: false, member: member.name, deliveredTo: [member.name], live: false,
        reason: `「${member.name}」已经续跑 ${member.wakes} 次，达到上限（${MAX_MEMBER_WAKES} 次）；留言留在看板上，需要继续请自己完成，或者新建一个团队。`,
      };
    }
    member.wakes += 1;
    member.wakePending = true;
    this.reopen();
    this.touch();
    return { queued: true, woke: true, member: member.name, memberId: member.id, deliveredTo: [member.name], wakes: member.wakes };
  }

  /** 1.8.3: the connection a member really ran on, resolved from the configured profiles. */
  setMemberConnection(memberId, connection) {
    const member = this.members.find(item => item.id === memberId);
    if (!member) return null;
    member.profileId = connection?.id ?? '';
    member.profileName = connection?.name ?? '';
    this.touch();
    return member;
  }

  finish({ status } = {}) {
    const failed = this.members.some(member => member.status === 'error');
    const stopped = this.members.some(member => member.status === 'cancelled');
    this.finalStatus = status ?? (stopped ? 'cancelled' : failed ? 'failed' : 'done');
    for (const task of this.tasks) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        task.status = this.finalStatus === 'done' ? 'done' : 'failed';
        task.updatedAt = stamp();
      }
    }
    // A wake already in flight keeps the board running: its own endWork applies the status.
    if (this.isIdle()) this.applyFinal();
    else this.touch();
    return this.status;
  }

  stats() {
    const stats = emptyStats();
    stats.total = this.tasks.length;
    for (const task of this.tasks) {
      if (task.status === 'done') stats.done += 1;
      else if (task.status === 'failed') stats.failed += 1;
      else if (task.status === 'in_progress') stats.running += 1;
      else if (task.status === 'blocked') stats.blocked += 1;
      else stats.pending += 1;
    }
    stats.percent = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
    return stats;
  }

  /** The bounded view the panel polls. Long text is trimmed once, here. */
  snapshot() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      name: this.name,
      goal: this.goal,
      model: this.model,
      mode: this.mode,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      finishedAt: this.finishedAt,
      seq: this.seq,
      members: this.members.map(member => ({
        id: member.id,
        name: member.name,
        role: member.role,
        status: member.status,
        taskId: member.taskId,
        task: member.task.slice(0, 400),
        activity: member.activity,
        text: member.text.slice(-MEMBER_TEXT_TAIL),
        model: member.model,
        profile: member.profile,
        profileName: member.profileName,
        wakes: member.wakes,
        wakePending: member.wakePending,
        tools: member.tools,
        toolsGranted: member.toolsGranted,
        toolsDropped: member.toolsDropped,
        rounds: member.rounds,
        steps: member.steps,
        tokens: member.tokens,
        error: member.error,
        startedAt: member.startedAt,
        finishedAt: member.finishedAt,
        inbox: member.inbox.length,
      })),
      tasks: this.tasks.map(task => ({
        id: task.id,
        title: task.title,
        detail: task.detail.slice(0, 400),
        owner: task.owner,
        memberId: task.memberId,
        status: task.status,
        dependsOn: task.dependsOn,
        result: task.result.slice(0, 400),
        updatedAt: task.updatedAt,
      })),
      messages: this.messages.slice(-40).map(message => ({
        id: message.id, seq: message.seq, from: message.from, to: message.to,
        kind: message.kind, text: message.text.slice(0, 300), at: message.at,
      })),
      approvals: this.approvals.slice(-MAX_TEAM_APPROVALS).map(entry => ({
        id: entry.id,
        approvalId: entry.approvalId,
        member: entry.member,
        tool: entry.tool,
        summary: entry.summary,
        status: entry.status,
        at: entry.at,
      })),
      stats: this.stats(),
    };
  }

  /** What the leader model is handed when the team returns: conclusions and the shape of the board. */
  summary() {
    const stats = this.stats();
    return {
      teamId: this.id,
      name: this.name,
      status: this.status,
      goal: this.goal,
      mode: this.mode,
      members: this.members.map(member => ({
        name: member.name,
        role: member.role,
        status: member.status,
        model: member.model || this.model || null,
        ...(member.profileName ? { profile: member.profileName } : {}),
        ...(member.wakes ? { wakes: member.wakes } : {}),
        tools: member.toolsGranted ?? member.tools,
        rounds: member.rounds,
        ...(member.error ? { error: member.error } : {}),
        answer: member.text.slice(0, RESULT_ANSWER_CHARS),
      })),
      tasks: this.tasks.map(task => ({
        title: task.title,
        owner: task.owner ?? '未分配',
        status: task.status,
        ...(task.dependsOn.length ? { dependsOn: task.dependsOn } : {}),
      })),
      messages: this.messages
        .filter(message => message.kind === 'message' || message.kind === 'result' || message.kind === 'blocker')
        .slice(-RESULT_MESSAGES)
        .map(message => `${message.from} → ${message.to}：${message.text.slice(0, 200)}`),
      stats,
      note: this.status === 'done'
        ? '团队成员都已返回结论，tasks 与 messages 是它们协作的过程记录。'
        : '团队没有全部成功：失败的成员已在 members 中标出，其余结论与过程记录仍然可用。',
    };
  }
}

/**
 * One publish channel for every viewer of the board.
 *
 * Emissions are throttled: the board changes on every streamed token, and both the SSE stream
 * and the session checkpoint are far more expensive than a frame the reader can perceive.
 */
export function createPublisher(emit, { intervalMs = 350, now = () => Date.now() } = {}) {
  let last = 0;
  let pending = false;
  let timer = null;
  const run = async () => {
    timer = null;
    if (!pending) return;
    pending = false;
    last = now();
    await emit();
  };
  return async function publish(force = false) {
    const stampNow = now();
    if (!force && stampNow - last < intervalMs) {
      if (!pending) {
        pending = true;
        timer = setTimeout(() => { void run().catch(() => {}); }, Math.max(16, intervalMs - (stampNow - last)));
        timer.unref?.();
      }
      return;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    pending = false;
    last = stampNow;
    await emit();
  };
}

/** The rules a member is told once, at the top of its prompt. */
export const TEAM_MEMBER_RULES = [
  '你正在一个团队里工作，不是独自完成整个任务：共享看板记录了每个人的任务、结论和留言。',
  '用 team_note 把关键发现写进看板（kind=finding 表示结论性事实，blocker 表示你被卡住的地方）。',
  '用 team_message 给某个成员或 * 留言；留言会在对方下一轮开始时送到，所以请写清需要它做什么。',
  '用 team_task 往看板加一项新工作（claim=true 表示你自己接手）。依赖别人先做完时，用 dependsOn 写上对方任务的标题。',
  '不要重复别人已经做完的工作：先看看板上已有的任务和结论。',
  '你无法向用户提问，也不能等待用户补充信息；信息不足时按最合理的假设继续，并在结论中写明该假设。',
  '你的最终回复会作为结论交给队长，所以要写成可直接使用的结论：完成了什么、关键结果或数据、涉及的文件路径、尚未解决的部分。不要复述过程。',
].join('\n');

export function memberPrompt({ board, member, wake = false, messages = [] }) {
  const others = board.members.filter(item => item.id !== member.id);
  const share = board.tasks
    .filter(task => task.id !== member.taskId)
    .slice(0, 12)
    .map(task => `- ${task.title}（${task.owner ?? '未分配'} · ${task.status}）`);
  return [
    `你是团队「${board.name}」的成员「${member.name}」，角色：${member.role}。`,
    `团队目标：${board.goal}`,
    board.workspace ? `工作目录：${board.workspace}` : '',
    others.length ? `其他成员：${others.map(item => `${item.name}（${item.role}）`).join('、')}。` : '你是这个团队唯一的成员。',
    share.length ? `共享看板上已有这些工作：\n${share.join('\n')}` : '',
    `你的任务：\n${member.task}`,
    // 1.8.3: a woken member is not a new member. It keeps its conclusion and is told exactly what
    // arrived after it — the messages are handed over here *and* drained from the inbox, so the
    // task is stated once instead of being repeated as a teammate message on the first round.
    ...(wake && member.text ? [
      `你之前已经交过结论：\n${member.text}`,
      messages.length ? `在这之后有人给你留言：\n${messages.map(entry => `- ${entry}`).join('\n')}` : '',
      '请在这条结论的基础上继续：需要补查就继续用工具，需要交接就留言，最后给出更新后的结论（保留仍然成立的部分即可，不要整篇重写，也不要重复已经完成的工作）。',
    ].filter(Boolean) : []),
    TEAM_MEMBER_RULES,
  ].filter(Boolean).join('\n\n');
}

/** The OpenAI-style descriptors for the three board tools, offered to members only. */
export function teamMemberTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'team_note',
        description: '把一条发现、进度或阻塞写进团队共享看板，队长和队友都能看到。用于同步事实，不要写成寒暄。',
        parameters: {
          type: 'object', additionalProperties: false, properties: {
            text: { type: 'string', description: '要写进看板的内容，最多 1200 字符' },
            kind: { type: 'string', enum: ['note', 'finding', 'blocker'], description: 'note 普通进度、finding 结论性事实、blocker 被卡住的地方' },
          }, required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'team_message',
        description: '给某个队友或全部队友（to 写 *）留言。留言会在对方下一轮开始时送到，请写清需要对方做什么。',
        parameters: {
          type: 'object', additionalProperties: false, properties: {
            to: { type: 'string', description: '队友的名字，或 * 表示所有还在运行的队友' },
            text: { type: 'string', description: '留言内容，最多 1200 字符' },
          }, required: ['to', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'team_task',
        description: '往共享看板加一项新工作；claim=true 表示你自己接手。依赖别人的工作时，在 dependsOn 里写对方任务的标题。',
        parameters: {
          type: 'object', additionalProperties: false, properties: {
            title: { type: 'string', description: '任务标题，最多 120 字符' },
            detail: { type: 'string', description: '任务细节，最多 2000 字符' },
            claim: { type: 'boolean', description: '是否由你接手（默认 false）' },
            dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 4, description: '前置任务的标题' },
          }, required: ['title'],
        },
      },
    },
  ];
}

/** Validate one member tool call. Errors are the model's to fix, so they say what is wrong. */
export function normalizeMemberToolArgs(name, args) {
  if (!TEAM_MEMBER_TOOL_NAMES.has(name)) throw new HttpError(404, `团队协作工具不存在：${String(name).slice(0, 60)}。`);
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'team_note') {
    const body = boundedString(source.text, '看板内容', { max: NOTE_CHARS });
    const kind = ['note', 'finding', 'blocker'].includes(source.kind) ? source.kind : 'note';
    return { text: body, kind };
  }
  if (name === 'team_message') {
    const to = boundedString(source.to, '收件成员', { max: MEMBER_NAME_CHARS + 20 });
    const body = boundedString(source.text, '留言内容', { max: MESSAGE_CHARS });
    return { to, text: body };
  }
  const title = boundedString(source.title, '任务标题', { max: TASK_TITLE_CHARS });
  return {
    title,
    detail: source.detail === undefined ? '' : boundedString(source.detail, '任务细节', { max: TASK_DETAIL_CHARS, empty: true }),
    claim: source.claim === true,
    dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.slice(0, 4).map(item => text(item, TASK_TITLE_CHARS)) : [],
  };
}

/**
 * Run every member at once and settle the board.
 *
 * `runner(member, ctx)` is injected so the orchestration can be tested without a model: it gets
 * the member, a `publish` that pushes a new frame, an `inbox` that drains what teammates sent,
 * and the board operations a member is allowed to perform.
 */
/**
 * One member, from start to settle.
 *
 * Extracted from runTeam because a member can be started more than once: the first wave, and
 * every wake that follows a message sent to a member that had already returned. Both paths must
 * settle the lane, the card and the inbox the same way, so there is one implementation of it.
 */
export async function runMember({ board, member, runner, signal, publish = async () => {}, wakeMessages = null, viaWake = false }) {
  board.beginWork();
  try {
    if (signal?.aborted) {
      // Marked here, not in the catch below: the member never reached its runner, and a lane
      // left at "pending" would read as "was never started" instead of "the turn was stopped".
      board.updateMember(member.id, { status: 'cancelled', activity: '已停止', finishedAt: stamp() });
      board.completeMemberTasks(member.id, 'cancelled', '');
      throw new HttpError(499, '操作已停止。');
    }
    board.updateMember(member.id, {
      status: 'running',
      startedAt: member.startedAt ?? stamp(),
      finishedAt: null,
      activity: viaWake ? '收到新留言，继续处理…' : '正在读取任务…',
      ...(viaWake ? { error: null } : {}),
    });
    await publish(true);
    try {
      const outcome = await runner(member, {
        publish: () => publish(false),
        takeInbox: () => board.takeInbox(member.id),
        wakeMessages,
        note: (body, kind = 'note') => board.note({ from: member.name, kind, text: body }),
        message: ({ to, text: body }) => {
          const delivered = board.requestWake({ from: member.name, to, text: body });
          if (delivered.woke && typeof board.launchWake !== 'function') {
            const targetMember = board.members.find(item => item.id === delivered.memberId);
            if (targetMember) {
              const queued = board.takeInbox(targetMember.id);
              void runMember({ board, member: targetMember, runner, signal, publish, wakeMessages: queued, viaWake: true }).catch(() => {});
            }
          }
          return delivered;
        },
        addTask: ({ title, detail, claim, dependsOn }) => {
          const task = board.addTask({ title, detail, owner: claim ? member.name : null, memberId: claim ? member.id : null, status: claim ? 'in_progress' : 'pending', dependsOn });
          board.note({ from: member.name, kind: 'task', text: `${claim ? '接手' : '新增'}任务：${task.title}` });
          return task;
        },
        claimTask: taskId => board.claimTask(taskId, member.name, member.id),
      });
      const cancelled = outcome?.status === 'cancelled' || signal?.aborted;
      const done = outcome?.status === 'done' && !cancelled;
      board.updateMember(member.id, {
        status: cancelled ? 'cancelled' : done ? 'done' : 'error',
        rounds: outcome?.rounds ?? member.rounds,
        steps: outcome?.steps ?? member.steps,
        tokens: outcome?.tokens ?? member.tokens,
        text: outcome?.text ?? '',
        error: cancelled ? null : outcome?.error ?? null,
        activity: cancelled ? '已停止' : done ? '已提交结论' : '未给出结论',
        finishedAt: stamp(),
      });
      member.wakePending = false;
      board.completeMemberTasks(member.id, cancelled ? 'cancelled' : done ? 'done' : 'error', outcome?.text ?? '');
      if (done) board.note({ from: member.name, to: '队长', kind: 'result', text: `结论：${text(outcome?.text, 400)}` });
      return outcome;
    } catch (error) {
      member.wakePending = false;
      const cancelled = signal?.aborted;
      const message = text(error?.message ?? error, 400);
      board.updateMember(member.id, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? null : message,
        activity: cancelled ? '已停止' : '出错',
        finishedAt: stamp(),
      });
      board.completeMemberTasks(member.id, 'cancelled', '');
      if (!cancelled) board.note({ from: member.name, kind: 'blocker', text: `成员失败：${message}` });
      throw error;
    }
  } finally {
    member.wakePending = false;
    board.endWork();
  }
}

/**
 * The first wave: every member at once, plus any wake continuations triggered before the team settles.
 */
export async function runTeam({ board, runner, signal, publish = async () => {} }) {
  const started = Date.now();
  const results = await Promise.allSettled(board.members.map(member => runMember({ board, member, runner, signal, publish })));
  while (!board.isIdle()) {
    if (board.inflight === 0 && !board.members.some(member => member.status === 'running')) {
      await new Promise(resolve => setImmediate(resolve));
      if (board.inflight === 0 && !board.members.some(member => member.status === 'running')) {
        const pendingMembers = board.members.filter(member => member.wakePending);
        if (!pendingMembers.length) break;
        if (signal?.aborted || typeof board.launchWake === 'function') {
          for (const member of pendingMembers) member.wakePending = false;
          board.resolveIdle();
          break;
        }
        await Promise.allSettled(pendingMembers.map(member => runMember({
          board, member, runner, signal, publish, wakeMessages: board.takeInbox(member.id), viaWake: true,
        })));
        continue;
      }
    }
    await board.whenIdle();
  }
  board.finish({ status: signal?.aborted ? 'cancelled' : undefined });
  await publish(true);
  return {
    status: board.status,
    ms: Date.now() - started,
    members: board.members.map(member => member.name),
    rejected: results.filter(result => result.status === 'rejected').length,
  };
}

/**
 * The leader's view while the team is still working.
 *
 * `team_status` and a timed-out `team_wait` both answer with this: who is still running, what
 * each one is doing right now, and what the board already knows. It is deliberately smaller than
 * `teamToolResult`, because the leader may poll it several times in one turn.
 */
export function teamProgressResult(board) {
  const stats = board.stats();
  return {
    teamId: board.id,
    name: board.name,
    status: board.status,
    mode: board.mode,
    running: board.members.filter(member => member.status === 'running').map(member => member.name),
    members: board.members.map(member => ({
      name: member.name,
      status: member.status,
      model: member.model || board.model || null,
      ...(member.profileName ? { profile: member.profileName } : {}),
      ...(member.wakes ? { wakes: member.wakes } : {}),
      rounds: member.rounds,
      activity: member.activity,
      ...(member.error ? { error: member.error } : {}),
      ...(member.status === 'done' ? { answer: member.text.slice(0, RESULT_ANSWER_CHARS) } : {}),
    })),
    tasks: board.tasks.map(task => ({ title: task.title, owner: task.owner ?? '未分配', status: task.status })),
    messages: board.messages.slice(-8).map(message => `${message.from} → ${message.to}：${message.text.slice(0, 160)}`),
    stats,
    pendingApprovals: board.pendingApprovals().map(entry => ({ member: entry.member, tool: entry.tool, summary: entry.summary })),
    note: board.status === 'running'
      ? '团队还在运行：成员在后台继续，你可以先做自己的部分，稍后再收结论；成员的批准请求会出现在协作面板里。'
      : '团队已经结束，结论见 members。',
  };
}

/**
 * Apply a member's requested tool names to what the turn actually offers.
 *
 * The result is a subset by construction, so a member can never end up with a tool the leader
 * did not have. Names the turn does not offer are reported back instead of being dropped
 * silently: the leader can then tell the member, or fix the request.
 */
export function filterMemberTools(available, requested) {
  const pool = (available ?? []).filter(tool => tool?.function?.name);
  if (!Array.isArray(requested) || !requested.length) {
    return { tools: [...pool], granted: pool.map(tool => tool.function.name), dropped: [] };
  }
  const wanted = new Set(requested);
  const tools = pool.filter(tool => wanted.has(tool.function.name));
  const granted = tools.map(tool => tool.function.name);
  return { tools, granted, dropped: [...wanted].filter(name => !granted.includes(name)) };
}

/** The leader's view of a finished team: conclusions first, process second. */
export function teamToolResult(board) {
  const summary = board.summary();
  return {
    teamId: summary.teamId,
    name: summary.name,
    status: summary.status,
    goal: summary.goal,
    stats: summary.stats,
    members: summary.members,
    tasks: summary.tasks,
    messages: summary.messages,
    note: summary.note,
  };
}

export { TASK_STATUSES, MEMBER_STATUSES };
