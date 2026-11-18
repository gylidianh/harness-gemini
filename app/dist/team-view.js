// 1.8.0 / 1.8.2: the view model for the Agent Teams board.
//
// Kept apart from the panel on purpose: everything here is a pure function of one snapshot, so
// the layout the reader sees can be tested offline (tests/teams-view.mjs) without a browser and
// without a model. The panel only turns these values into DOM.

export const TEAM_STATUS = {
  running: { label: '协作中', tone: 'running' },
  done: { label: '已完成', tone: 'done' },
  failed: { label: '有失败', tone: 'failed' },
  cancelled: { label: '已停止', tone: 'failed' },
};

export const MEMBER_STATUS = {
  pending: { label: '待启动', tone: 'pending' },
  running: { label: '进行中', tone: 'running' },
  done: { label: '已返回结论', tone: 'done' },
  error: { label: '失败', tone: 'failed' },
  cancelled: { label: '已停止', tone: 'failed' },
};

export const TASK_STATUS = {
  pending: { label: '待办', tone: 'pending' },
  in_progress: { label: '进行中', tone: 'running' },
  done: { label: '完成', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
  blocked: { label: '受阻', tone: 'failed' },
};

const TONE_FALLBACK = { label: '未知', tone: 'pending' };

function pick(table, key) {
  // A member or card that has not reported a status yet is pending, not "unknown": the board
  // creates every lane before the first frame and those lanes are waiting, not broken.
  return table[key] ?? table.pending ?? TONE_FALLBACK;
}

function text(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function statusOf(snapshot) {
  return pick(TEAM_STATUS, snapshot?.status);
}

export function memberStatusOf(member) {
  return pick(MEMBER_STATUS, member?.status);
}

export function taskStatusOf(task) {
  return pick(TASK_STATUS, task?.status);
}

/** Integer percent of work items that are finished. The board, not the members, is the truth. */
export function progressOf(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const total = tasks.length;
  const done = tasks.filter(task => task?.status === 'done').length;
  const failed = tasks.filter(task => task?.status === 'failed' || task?.status === 'blocked').length;
  const running = tasks.filter(task => task?.status === 'in_progress').length;
  return {
    total,
    done,
    failed,
    running,
    pending: Math.max(0, total - done - failed - running),
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * One lane per member, in the order the leader declared them, plus one for work nobody owns.
 *
 * A lane keeps the member's *main* work item separate from anything else it picked up, because
 * the main item is what the leader asked for and the rest is what the member chose to take on.
 */
export function buildLanes(snapshot) {
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [];
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const now = Date.now();
  const lanes = members.map(member => {
    const own = tasks.filter(task => task.memberId === member.id || (task.owner && task.owner === member.name));
    const main = own.find(task => task.id === member.taskId) ?? own[0] ?? null;
    return {
      id: member.id ?? member.name,
      kind: 'member',
      name: text(member.name),
      role: text(member.role) || '成员',
      status: member.status ?? 'pending',
      tone: memberStatusOf(member).tone,
      statusLabel: memberStatusOf(member).label,
      activity: text(member.activity),
      text: text(member.text),
      rounds: Number(member.rounds) || 0,
      steps: Number(member.steps) || 0,
      inbox: Number(member.inbox) || 0,
      error: text(member.error),
      // 1.8.2: a member can run on its own model with a narrowed tool set, so the lane has to say
      // which of the two it really got — the request may name a tool this turn never offered.
      model: memberModelLabel(member, snapshot),
      // 1.8.3: which connection it ran on, and how many times it was woken after returning.
      profile: text(member.profileName) || text(member.profile),
      wakes: Number(member.wakes) || 0,
      tools: Array.isArray(member.toolsGranted) ? member.toolsGranted : (Array.isArray(member.tools) ? member.tools : []),
      toolsDropped: Array.isArray(member.toolsDropped) ? member.toolsDropped : [],
      mainTaskId: main?.id ?? null,
      tasks: own.map(task => ({ ...task, tone: taskStatusOf(task).tone, statusLabel: taskStatusOf(task).label })),
      startedAt: member.startedAt ?? null,
      finishedAt: member.finishedAt ?? null,
      elapsedMs: elapsedOf({ startedAt: member.startedAt, finishedAt: member.finishedAt }, now),
    };
  });
  const claimed = new Set(lanes.flatMap(lane => lane.tasks.map(task => task.id)));
  const orphans = tasks.filter(task => !claimed.has(task.id));
  if (orphans.length) {
    lanes.push({
      id: 'unassigned',
      kind: 'pool',
      name: '未分配',
      role: '看板上的公共工作',
      status: 'pending',
      tone: 'pending',
      statusLabel: '未分配',
      activity: '',
      text: '',
      rounds: 0,
      steps: 0,
      inbox: 0,
      error: '',
      model: '',
      tools: [],
      toolsDropped: [],
      mainTaskId: null,
      tasks: orphans.map(task => ({ ...task, tone: taskStatusOf(task).tone, statusLabel: taskStatusOf(task).label })),
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
    });
  }
  return lanes;
}

/**
 * 1.8.2: what the lane says about the model, without pretending to know more than it does.
 *
 * An empty member model means "the model this connection uses", which is what the team record
 * carries; when even that is missing the lane says so instead of showing a blank chip.
 */
export function memberModelLabel(member, snapshot) {
  const own = text(member?.model).trim();
  const profile = text(member?.profileName ?? member?.profile).trim();
  const shared = text(snapshot?.model).trim();
  const model = own || (shared ? `${shared}（同队长）` : '默认模型');
  // 1.8.3: a member on its own connection says so. A model id alone would not tell the reader
  // which account and endpoint paid for the run — and that is the whole point of the feature.
  return profile ? `${profile} · ${model}` : model;
}

/** 1.8.3: how many times this member was woken after it returned; empty when never. */
export function memberWakeLabel(lane) {
  const wakes = Number(lane?.wakes) || 0;
  return wakes ? `续跑 ${wakes} 次` : '';
}

/** How the team was started: a background team keeps working after the tool call returns. */
export function modeLabel(snapshot) {
  return snapshot?.mode === 'background' ? '后台运行' : '本轮等待';
}

/**
 * 1.8.2: the permissions a background member is waiting for.
 *
 * Only entries that already have an approval id are listed: before that, there is nothing a
 * person could click, and a button that cannot work is worse than no button.
 */
export function pendingApprovals(snapshot) {
  const entries = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
  return entries
    .filter(entry => entry?.status === 'pending' && entry?.approvalId)
    .map(entry => ({
      id: entry.id,
      approvalId: String(entry.approvalId),
      member: text(entry.member) || '成员',
      tool: text(entry.tool),
      summary: text(entry.summary),
      at: entry.at ?? '',
      time: shortTime(entry.at),
    }));
}

/** The tool names a lane was really given, for a title attribute. */
export function memberToolLine(lane) {
  const tools = Array.isArray(lane?.tools) ? lane.tools : [];
  const dropped = Array.isArray(lane?.toolsDropped) ? lane.toolsDropped : [];
  const granted = tools.length ? `工具 ${tools.length} 个：${tools.join('、')}` : '工具：与队长相同';
  return dropped.length ? `${granted}\n本次未提供、已忽略：${dropped.join('、')}` : granted;
}

/** Where every card sits on the board, so a dependency can be drawn as a line between two cards. */
export function dependencyEdges(lanes) {
  const at = new Map();
  lanes.forEach((lane, laneIndex) => {
    (lane.tasks ?? []).forEach((task, row) => {
      if (task?.id) at.set(task.id, { lane: laneIndex, row, taskId: task.id, owner: lane.name });
    });
  });
  const edges = [];
  const seen = new Set();
  lanes.forEach((lane, laneIndex) => {
    (lane.tasks ?? []).forEach((task, row) => {
      for (const dependency of Array.isArray(task?.dependsOn) ? task.dependsOn : []) {
        const from = at.get(dependency);
        if (!from) continue;
        const key = `${from.taskId}->${task.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // A self-loop is a planning mistake, not something to draw.
        if (from.taskId === task.id) continue;
        edges.push({ from, to: { lane: laneIndex, row, taskId: task.id, owner: lane.name } });
      }
    });
  });
  return edges;
}

export function formatElapsed(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '0 秒';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 时 ${minutes % 60} 分`;
}

/** How long this member (or the whole team) has been working, from its own timestamps. */
export function elapsedOf(entry, now = Date.now()) {
  const start = Date.parse(entry?.startedAt ?? entry?.createdAt ?? '');
  if (!Number.isFinite(start)) return 0;
  const end = Date.parse(entry?.finishedAt ?? '');
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

export function teamElapsedMs(snapshot, now = Date.now()) {
  return elapsedOf(snapshot, now);
}

/** The last few things that happened, newest last, as one line each. */
export function activityFeed(snapshot, limit = 14) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const labels = { note: '进度', finding: '发现', blocker: '受阻', message: '留言', result: '结论', task: '任务', system: '系统' };
  return messages.slice(-Math.max(1, limit)).map(message => ({
    id: message.id ?? `${message.seq}-${message.at}`,
    kind: message.kind ?? 'note',
    label: labels[message.kind] ?? '进度',
    from: text(message.from) || '成员',
    to: text(message.to) || '*',
    text: text(message.text),
    at: message.at ?? '',
    time: shortTime(message.at),
  }));
}

/** HH:MM for today, M月D日 HH:MM otherwise — the same shape the rest of the app uses. */
export function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** One line that says what the team is doing right now. */
export function headlineOf(snapshot) {
  const status = statusOf(snapshot);
  const lanes = buildLanes(snapshot);
  const working = lanes.filter(lane => lane.status === 'running').map(lane => lane.name);
  if (snapshot?.status === 'running') {
    return working.length ? `${working.join('、')} 正在工作` : '正在分配任务';
  }
  const progress = progressOf(snapshot);
  if (snapshot?.status === 'done') return `全员已返回，${progress.done}/${progress.total} 项完成`;
  if (snapshot?.status === 'cancelled') return '已停止，保留已完成的结论';
  return progress.failed ? `${progress.failed} 项失败，其余结论仍可用` : '协作已结束';
}

/** Cheap change detector for the poller: equal strings mean "nothing to re-render". */
export function signatureOf(snapshot) {
  if (!snapshot) return '';
  return [
    snapshot.id ?? '',
    snapshot.status ?? '',
    snapshot.updatedAt ?? '',
    snapshot.seq ?? '',
    snapshot.mode ?? '',
    (snapshot.members ?? []).map(member => `${member.id}:${member.status}:${member.rounds}:${member.steps}:${member.inbox}:${member.model}:${(member.toolsGranted ?? []).length}:${member.wakes ?? 0}:${member.profileName ?? ''}`).join(','),
    (snapshot.approvals ?? []).map(entry => `${entry.id}:${entry.status}:${entry.approvalId ?? ''}`).join(','),
    (snapshot.tasks ?? []).map(task => `${task.id}:${task.status}`).join(','),
    (snapshot.messages ?? []).length,
  ].join('|');
}

/** Initials for the lane avatar: one CJK character, or two latin letters. */
export function initialsOf(name) {
  const clean = text(name).trim();
  if (!clean) return '·';
  if (/^[\u3400-\u9fff]/.test(clean)) return clean.slice(0, 1);
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Member selection is a local view filter, never a change to the running team.
 * A stale/missing member falls back to the full board rather than a blank screen.
 */
export function memberSelection(lanes, selectedId = '') {
  const all = Array.isArray(lanes) ? lanes : [];
  const member = selectedId ? all.find(lane => lane.id === selectedId) : null;
  return { id: member?.id ?? '', member: member ?? null, lanes: member ? [member] : all };
}
