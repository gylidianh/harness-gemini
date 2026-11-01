// Desktop-only activity projection. The server owns runs and approvals; this module
// reads their live references without polling session files or changing a run.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITY = { waiting: 0, failed: 1, review: 2, running: 3 };
const MAX_COMPLETIONS = 64;
const MAX_SEEN = 512;
const TOOL_LABELS = {
  read_file: '正在读取文件', write_file: '正在写入文件', list_files: '正在查看文件',
  run_command: '正在执行命令', web_search: '正在搜索', fetch_url: '正在读取网页',
  download_file: '正在下载文件', generate_image: '正在生成图片',
  spawn_subagent: '子代理正在工作', update_tasks: '正在更新任务',
};

function text(value, fallback, max = 80) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return clean ? Array.from(clean).slice(0, max).join('') : fallback;
}

function sessionId(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }

function validMemory(memory) {
  return memory?.completions instanceof Map && memory?.observed instanceof Map
    && memory?.seen instanceof Set && Number.isSafeInteger(memory.sequence);
}

/** Empty at app launch: old session files never turn into new desktop alerts. */
export function createPetActivityMemory() {
  return { completions: new Map(), observed: new Map(), seen: new Set(), sequence: 0 };
}

function remember(memory, key) {
  if (memory.seen.has(key)) return false;
  memory.seen.add(key);
  while (memory.seen.size > MAX_SEEN) memory.seen.delete(memory.seen.values().next().value);
  return true;
}

/** Call from the server's onRunFinished callback, alongside system notifications. */
export function acceptPetCompletion(memory, completion) {
  if (!validMemory(memory) || !completion || !['done', 'error'].includes(completion.status)) return false;
  const id = sessionId(completion.sessionId);
  const message = sessionId(completion.messageId);
  if (!id || !message || !remember(memory, `${id}:${message}`)) return false;
  const state = completion.status === 'error' ? 'failed' : 'review';
  memory.completions.delete(id);
  memory.completions.set(id, {
    sessionId: id,
    title: text(completion.title, '新对话'),
    state,
    statusText: state === 'failed' ? '任务遇到问题，点击查看' : '已完成，点击查看结果',
    sequence: ++memory.sequence,
  });
  while (memory.completions.size > MAX_COMPLETIONS) memory.completions.delete(memory.completions.keys().next().value);
  return true;
}

// An explicit alias keeps integration with an existing onRunFinished naming style simple.
export const acceptCompletion = acceptPetCompletion;

/** Acknowledge only completed activity; opening a running chat keeps its later result unread. */
export function clearPetActivity(memory, value) {
  if (!validMemory(memory)) return false;
  if (value === undefined || value === null) {
    const changed = memory.completions.size > 0;
    memory.completions.clear();
    return changed;
  }
  const id = sessionId(value);
  return id ? memory.completions.delete(id) : false;
}

function runningStatus(run, waiting) {
  if (waiting) return '需要你的批准';
  const tools = Array.isArray(run.assistant?.tools) ? run.assistant.tools : [];
  const tool = tools.findLast(item => item?.status === 'running');
  if (tool) return TOOL_LABELS[tool.name] ?? '正在处理工具任务';
  return run.mode === 'image' ? '正在生成图片' : run.mode === 'agent' ? '正在处理任务' : '正在思考';
}

function idleActivity() {
  return { state: 'idle', title: 'Harness Gemini', statusText: '准备就绪', sessionId: null, activeCount: 0, items: [] };
}

/**
 * Synchronous, safe to call every 750 ms. No disk/network/model calls are made.
 * Uses harness.runs (Map<sessionId, run>) and harness.approvals.pending.
 */
export function collectPetActivity(harness, suppliedMemory) {
  const memory = validMemory(suppliedMemory) ? suppliedMemory : createPetActivityMemory();
  const runs = harness?.runs instanceof Map ? harness.runs : new Map();
  const pending = harness?.approvals?.pending instanceof Map ? harness.approvals.pending : new Map();
  const waitingIds = new Set();
  for (const request of pending.values()) {
    const id = sessionId(request?.runId);
    if (id) waitingIds.add(id);
  }

  const current = new Map();
  for (const [key, run] of runs) {
    if (!run || run.finished === true) continue;
    const id = sessionId(run.id) ?? sessionId(key);
    const message = sessionId(run.messageId);
    if (!id) continue;
    const previous = memory.observed.get(id);
    const sequence = previous?.messageId === message ? previous.sequence : ++memory.sequence;
    // A new request supersedes the same chat's previous result badge.
    if (previous?.messageId !== message) memory.completions.delete(id);
    const waiting = waitingIds.has(id);
    const item = {
      sessionId: id,
      title: text(run.session?.title, text(run.text, '新对话')),
      state: waiting ? 'waiting' : 'running',
      statusText: runningStatus(run, waiting),
      sequence,
    };
    current.set(id, { run, messageId: message, sequence, item });
  }

  // Retain the last run object until it disappears. This small fallback covers a
  // completion between polling ticks while the callback remains the source of truth.
  for (const [id, previous] of memory.observed) {
    if (current.has(id) || !previous.messageId || ['stop', 'shutdown'].includes(previous.run.cancelSource)) continue;
    const status = previous.run.assistant?.status;
    if (status === 'done' || status === 'error') {
      acceptPetCompletion(memory, {
        sessionId: id, messageId: previous.messageId,
        title: previous.run.session?.title ?? previous.item.title,
        status: status === 'done' ? 'done' : 'error',
      });
    }
  }
  memory.observed = current;

  const entries = [
    ...[...memory.completions.values()].filter(item => !current.has(item.sessionId)),
    ...[...current.values()].map(entry => entry.item),
  ];
  if (!entries.length) return idleActivity();
  entries.sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || b.sequence - a.sequence);
  const items = entries.slice(0, 3).map(({ sequence, ...item }) => item);
  return { ...items[0], activeCount: current.size, items };
}
