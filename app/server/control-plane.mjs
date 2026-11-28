// The remote control plane: the only surface a phone can reach.
//
// Two rules keep this small enough to audit:
//   1. Reads are in-process projections. Nothing new is invented, and nothing leaves the
//      machine except a bounded, clipped summary.
//   2. Writes go through the same loopback HTTP routes the desktop interface uses, so every
//      existing validation (UUID checks, pending-set re-checks, bounded text, the session lock)
//      applies unchanged. This module never writes a file, never spawns a command and never
//      calls a model on its own.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError, requireObject } from './util.mjs';
import { clip, MAX_PLAINTEXT_BYTES } from '../shared/relay-protocol.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIONS = new Set([
  'pending.list',
  'approval.decide',
  'question.answer',
  'team.configuration.get',
  'team.configuration.submit',
  'run.stop',
  'task.dispatch',
  'sessions.list',
  'session.messages',
  'session.message.read',
]);

/** Reserve ~300 bytes inside MAX_PLAINTEXT_BYTES (8 KiB) for `{ replyTo, ok, data }` and margin. */
export const RESPONSE_WRAPPER_RESERVE = 300;
export const MAX_RESPONSE_DATA_BYTES = MAX_PLAINTEXT_BYTES - RESPONSE_WRAPPER_RESERVE;

/** Deliberately short: whatever a phone shows must fit in one sealed envelope. */
const LIMITS = Object.freeze({
  sessions: 12,
  messagesPage: 8,
  messagesMaxLimit: 12,
  messageTools: 6,
  approvals: 8,
  questions: 8,
  title: 40,
  reason: 120,
  preview: 200,
  error: 200,
  notice: 160,
  question: 400,
  option: 120,
  answer: 4000,
  dispatchText: 8_000,
});

/** A request from the phone must be short; the run's own limits are enforced upstream. */
const DISPATCH_PER_MINUTE = 3;

function id(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label}不正确。`);
  return value.toLowerCase();
}

function optionalId(value, label) {
  return value === undefined || value === null ? null : id(value, label);
}

function bounded(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label}必须是文本。`);
  if (!empty && !value.trim()) throw new HttpError(400, `${label}不能为空。`);
  if (value.length > max) throw new HttpError(400, `${label}最多 ${max} 个字符。`);
  return value;
}

/**
 * Drain an accepted SSE/HTTP response stream in the background without calling `body.cancel()`.
 * `POST /api/sessions/:id/messages` attaches `res.once('close', onDisconnect)` in `app.mjs`, so
 * cancelling the response stream early would abort the running turn as a client disconnect, while
 * leaving `response.body` unread would eventually stall `sse.send()` on loopback TCP backpressure.
 */
async function drainResponseBody(response) {
  const body = response?.body;
  if (!body) return;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* Stream ended or upstream closed. */ }
    finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const _chunk of body) { /* discard */ }
    } catch { /* ignore */ }
  }
}

/** What a tool call looks like on a phone: one line, no file contents, no arguments dump. */
function toolPreview(tool) {
  const args = tool?.args && typeof tool.args === 'object' ? tool.args : {};
  switch (tool?.name) {
    case 'run_command': return clip(args.command, LIMITS.preview);
    case 'write_file':
    case 'read_file': return clip(args.path, LIMITS.preview);
    case 'list_directory': return clip(args.path ?? '.', LIMITS.preview);
    case 'fetch_url':
    case 'download_file':
    case 'browser_navigate':
    case 'browser_open': return clip(args.url, LIMITS.preview);
    case 'web_search': return clip(args.query, LIMITS.preview);
    case 'ask_user': return clip(args.question, LIMITS.preview);
    default: return '';
  }
}

function sessionTitle(run) {
  const title = run?.session?.title ?? run?.text ?? '';
  return clip(title, LIMITS.title) || '会话';
}

function runState(run, waiting) {
  if (waiting) return 'waiting';
  const status = run?.assistant?.status;
  if (status === 'error') return 'error';
  if (status === 'done' || run?.finished === true) return 'done';
  return 'running';
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Never cuts through a UTF-16 surrogate pair (e.g. emoji or supplementary CJK). */
function alignSurrogateBoundary(text, index, min = 0) {
  if (index > min && index < text.length
    && isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))) {
    return index - 1;
  }
  return index;
}

/** Preserves newlines, tabs and Markdown while replacing disallowed control chars 1:1. */
function normalizeBodyText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
}

/**
 * Slices `text` starting at UTF-16 code-unit `rawOffset` so that `JSON.stringify(slice)` fits
 * within `maxJsonBytes` UTF-8 bytes without splitting any Unicode code point (surrogate pair).
 */
export function sliceTextByJsonBytes(text, rawOffset = 0, maxJsonBytes = 7_500) {
  const source = typeof text === 'string' ? text : '';
  const clamped = Math.max(0, Math.min(source.length, Number.isSafeInteger(rawOffset) ? rawOffset : 0));
  const start = alignSurrogateBoundary(source, clamped, 0);
  if (start >= source.length || maxJsonBytes < 2) {
    return { start, end: start, text: '', nextOffset: start < source.length ? start : null };
  }
  let hi = alignSurrogateBoundary(source, Math.min(source.length, start + maxJsonBytes - 2), start);
  const fits = end => Buffer.byteLength(JSON.stringify(source.slice(start, end)), 'utf8') <= maxJsonBytes;
  if (fits(hi)) {
    return {
      start,
      end: hi,
      text: source.slice(start, hi),
      nextOffset: hi < source.length ? hi : null,
    };
  }
  let lo = start;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const splitsPair = mid > start && mid < source.length
      && isHighSurrogate(source.charCodeAt(mid - 1))
      && isLowSurrogate(source.charCodeAt(mid));
    if (splitsPair) {
      const afterPair = mid + 1;
      if (afterPair <= hi && fits(afterPair)) lo = afterPair;
      else hi = mid - 1;
    } else if (fits(mid)) {
      lo = mid;
    } else {
      hi = alignSurrogateBoundary(source, mid - 1, lo);
    }
  }
  const end = lo;
  return {
    start,
    end,
    text: source.slice(start, end),
    nextOffset: end < source.length ? end : null,
  };
}

function rawMessageText(message) {
  if (typeof message?.text === 'string') return normalizeBodyText(message.text);
  if (typeof message?.content === 'string') return normalizeBodyText(message.content);
  return '';
}

function rawMessageReasoning(message) {
  if (message?.role !== 'assistant' || typeof message?.reasoning !== 'string') return '';
  return normalizeBodyText(message.reasoning);
}

function compactMessageTools(message) {
  const list = Array.isArray(message?.tools) ? message.tools : [];
  return list
    .slice(-LIMITS.messageTools)
    .map(tool => ({ name: clip(tool?.name ?? '', 40), status: clip(tool?.status ?? '', 16) }))
    .filter(item => item.name);
}

function visibleSessionMessages(session) {
  const raw = Array.isArray(session?.messages) ? session.messages : [];
  const out = [];
  for (const message of raw) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const index = out.length;
    const id = typeof message.id === 'string' && message.id.trim()
      ? message.id.trim().slice(0, 120)
      : `msg-${index}`;
    out.push({ id, index, message });
  }
  return out;
}

function messageMetaFields(message) {
  const errorText = typeof message?.error === 'string' && message.error.trim() ? clip(message.error, LIMITS.error) : '';
  const noticeText = typeof message?.notice === 'string' && message.notice.trim() ? clip(message.notice, LIMITS.notice) : '';
  return {
    status: clip(message?.status ?? 'done', 20) || 'done',
    createdAt: typeof message?.createdAt === 'string' ? clip(message.createdAt, 32) : '',
    tools: compactMessageTools(message),
    artifactCount: Array.isArray(message?.artifacts) ? message.artifacts.length : 0,
    attachmentCount: Array.isArray(message?.attachments) ? message.attachments.length : 0,
    ...(errorText ? { error: errorText } : {}),
    ...(noticeText ? { notice: noticeText } : {}),
  };
}

/**
 * Live state for the phone. Built from the same objects the desktop pet and the activity panel
 * read, so the two never disagree about what is running.
 */
export function describeHarness(harness, { now = new Date() } = {}) {
  const runs = harness?.runs instanceof Map ? harness.runs : new Map();
  const approvals = harness?.approvals?.pending instanceof Map ? harness.approvals.pending : new Map();
  const questions = harness?.questions?.pending instanceof Map ? harness.questions.pending : new Map();

  // A pending approval carries no summary of its own; the tool call it belongs to does.
  const byApproval = new Map();
  for (const run of runs.values()) {
    for (const tool of Array.isArray(run?.assistant?.tools) ? run.assistant.tools : []) {
      if (tool?.approvalId) byApproval.set(tool.approvalId, { run, tool });
    }
  }

  const pendingApprovals = [];
  for (const [approvalId, request] of approvals) {
    const hit = byApproval.get(approvalId);
    pendingApprovals.push({
      approvalId,
      sessionId: request?.runId ?? hit?.run?.id ?? '',
      title: sessionTitle(hit?.run),
      tool: clip(hit?.tool?.name ?? '', 40),
      reason: clip(hit?.tool?.approvalReason ?? '', LIMITS.reason),
      preview: toolPreview(hit?.tool),
    });
    if (pendingApprovals.length >= LIMITS.approvals) break;
  }

  const pendingQuestions = [];
  for (const [questionId, entry] of questions) {
    const item = entry?.item;
    if (!item) continue;
    pendingQuestions.push({
      questionId,
      sessionId: item.sessionId ?? '',
      title: sessionTitle(runs.get(item.sessionId)),
      question: clip(item.question, LIMITS.question),
      options: Array.isArray(item.options)
        ? item.options.slice(0, 8).map(option => clip(option, LIMITS.option))
        : [],
    });
    if (pendingQuestions.length >= LIMITS.questions) break;
  }

  // Team proposals are immutable pending records. Advertise only their handles; fetch
  // member settings once per card, not with every snapshot/poll.
  const teamConfigurations = [];
  for (const { record } of harness.teamConfigurations?.pending?.values() ?? []) {
    teamConfigurations.push({ id: record.id, sessionId: record.sessionId, name: clip(record.name, LIMITS.title) });
    if (teamConfigurations.length >= 8) break;
  }
  const waiting = new Set([
    ...teamConfigurations.map(item => item.sessionId),
    ...pendingApprovals.map(item => item.sessionId),
    ...pendingQuestions.map(item => item.sessionId),
  ]);

  const live = [];
  for (const [key, run] of runs) {
    if (!run || run.finished === true) continue;
    const sessionId = run.id ?? key;
    const runningTool = (Array.isArray(run.assistant?.tools) ? run.assistant.tools : [])
      .findLast(tool => tool?.status === 'running');
    live.push({
      sessionId,
      title: sessionTitle(run),
      state: runState(run, waiting.has(sessionId)),
      activity: clip(runningTool?.name ?? '', 40),
      mode: clip(run.mode ?? 'chat', 20),
    });
    if (live.length >= LIMITS.sessions) break;
  }

  return {
    generatedAt: now.toISOString(),
    live,
    approvals: pendingApprovals,
    questions: pendingQuestions,
    teamConfigurations,
  };
}

/**
 * The desktop side of the control plane. `origin` is the loopback address of this very app;
 * every write is an ordinary HTTP call to a route that was already there before today.
 */
export function createControlPlane({
  harness,
  origin,
  dataDir,
  dispatchEnabled = false,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  if (!harness) throw new Error('控制面缺少本机服务引用。');
  const base = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname)) {
    throw new Error('控制面只能访问本机服务。');
  }
  if (typeof fetchImpl !== 'function') throw new Error('控制面缺少网络实现。');
  const auditFile = path.join(path.resolve(dataDir), 'remote-audit.jsonl');
  const dispatchHits = new Map();
  // The settings page can switch dispatch on and off while the link stays up, so the gate is
  // read per call rather than frozen when the client starts.
  const dispatchAllowed = () => (typeof dispatchEnabled === 'function' ? dispatchEnabled() : dispatchEnabled) === true;

  async function audit(entry) {
    // Local only and append only. A dispatched task keeps a clipped preview because "which
    // command did the phone send" is the whole point of the trail; tool output, file contents
    // and credentials never get here.
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try { await fs.appendFile(auditFile, `${line}\n`); } catch { /* Auditing must not block a stop. */ }
  }

  async function upstream(method, route, body, { wait = true } = {}) {
    const target = new URL(route, base);
    if (target.origin !== base.origin) throw new HttpError(400, '控制面不允许跨源请求。');
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      controller.abort(timeoutError);
    }, 30_000);
    timer.unref?.();

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'TimeoutError' || controller.signal.aborted) throw new HttpError(504, '本机服务响应超时。');
      throw new HttpError(502, '无法连接本机服务。');
    }

    if (!response.ok) {
      try {
        const data = await response.json().catch(() => null);
        const message = typeof data?.error === 'string' ? data.error : '本机服务拒绝了这次操作。';
        throw new HttpError(response.status >= 500 ? 502 : response.status, message);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!wait) {
      // Disarm the header deadline once 2xx headers arrive so a long SSE turn can run to completion,
      // then drain chunks in the background until `res.end()` closes the stream naturally.
      clearTimeout(timer);
      void drainResponseBody(response);
      return { accepted: true };
    }

    try {
      const data = await response.json().catch(() => null);
      return data ?? { accepted: true };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    snapshot: () => describeHarness(harness),

    async execute({ action, params, deviceId }) {
      if (!ACTIONS.has(action)) throw new HttpError(400, '不支持的中继操作。');
      const input = params === undefined || params === null ? {} : requireObject(params);
      const actor = typeof deviceId === 'string' ? clip(deviceId, 64) : 'unknown';

      switch (action) {
        case 'pending.list':
          return this.snapshot();

        case 'approval.decide': {
          const approvalId = id(input.approvalId, '批准编号');
          if (typeof input.approved !== 'boolean') throw new HttpError(400, 'approved 必须是布尔值。');
          // Re-read the live set: a thumb that lands two seconds late must not approve a tool
          // call that already timed out, and it must not approve a different one.
          const pending = harness.approvals?.pending instanceof Map ? harness.approvals.pending.get(approvalId) : null;
          if (!pending) throw new HttpError(404, '该批准请求已结束或不存在。');
          const expected = optionalId(input.sessionId, '会话编号');
          if (expected && pending.runId !== expected) throw new HttpError(409, '该批准请求不属于这个会话。');
          const result = await upstream('POST', `/api/approvals/${approvalId}`, { approved: input.approved });
          await audit({ actor, action, approvalId, sessionId: pending.runId, approved: input.approved });
          return result;
        }

        case 'question.answer': {
          const sessionId = id(input.sessionId, '会话编号');
          const questionId = id(input.questionId, '提问编号');
          const answer = bounded(input.answer, '回答', LIMITS.answer);
          const entry = harness.questions?.pending instanceof Map ? harness.questions.pending.get(questionId) : null;
          if (!entry?.item) throw new HttpError(404, '该提问已回答或已中断。');
          if (entry.item.sessionId !== sessionId) throw new HttpError(409, '该提问不属于这个会话。');
          const result = await upstream('POST', `/api/sessions/${sessionId}/questions/${questionId}/answer`, { answer });
          await audit({ actor, action, sessionId, questionId });
          return result;
        }

        case 'team.configuration.get':
        case 'team.configuration.submit': {
          const sessionId = id(input.sessionId, '会话编号');
          const configurationId = id(input.configurationId, '团队配置编号');
          const record = harness.teamConfigurations?.pending.get(configurationId)?.record;
          if (!record) throw new HttpError(404, '这项团队配置已处理、已取消或已过期。');
          if (record.sessionId !== sessionId) throw new HttpError(403, '团队配置不属于这个会话。');
          if (action === 'team.configuration.get') {
            const offset = input.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.profiles.length) throw new HttpError(400, '连接分页位置无效。');
            const page = { profiles: [], nextOffset: null };
            if (offset === 0) Object.assign(page, {
              goal: clip(record.goal, 96), leaderModel: record.leaderModel, leaderProfileName: clip(record.leaderProfileName, 60),
              members: record.members.map(({ id, name, role, task, profile, model }) => ({ id, name, role: clip(role, 32), task: clip(task, 80), profile, model })),
            });
            // Only explicitly public fields. Page by encoded bytes (not JS characters),
            // leaving room for the result wrapper and the cursor inside the sealed frame.
            let cursor = offset;
            for (; cursor < record.profiles.length; cursor++) {
              const { id, name, defaultModel } = record.profiles[cursor];
              page.profiles.push({ id, name, defaultModel });
              if (Buffer.byteLength(JSON.stringify(page)) <= MAX_PLAINTEXT_BYTES - 160) continue;
              page.profiles.pop();
              if (cursor === offset) throw new HttpError(413, '团队配置过长，请在电脑端确认。');
              break;
            }
            page.nextOffset = cursor < record.profiles.length ? cursor : null;
            return page;
          }
          // The same desktop route atomically consumes the proposal, validates every member
          // and re-checks profile availability. Do not forward arbitrary proposal edits.
          const body = input.cancel === true ? { sessionId, cancel: true } : { sessionId, members: input.members };
          const result = await upstream('POST', `/api/team-configurations/${configurationId}`, body);
          await audit({ actor, action, sessionId, configurationId, cancelled: input.cancel === true });
          return result;
        }

        case 'sessions.list': {
          // Choosing where a task goes needs the app's own conversation list, not a guess at
          // whichever run happens to be first. This is the same summary the sidebar renders,
          // clipped to what one sealed envelope can carry.
          const listSessions = harness.store?.listSessions;
          if (typeof listSessions !== 'function') throw new HttpError(503, '会话列表暂时不可用。');
          const summaries = await listSessions.call(harness.store);
          const busy = new Set([...harness.runs.keys()]);
          const sessions = (Array.isArray(summaries) ? summaries : [])
            .map(item => {
              const sessionId = String(item?.id ?? '').toLowerCase();
              return {
                sessionId,
                title: clip(item?.title ?? '新对话', LIMITS.title),
                updatedAt: typeof item?.updatedAt === 'string' ? clip(item.updatedAt, 32) : '',
                busy: busy.has(sessionId),
              };
            })
            .filter(item => UUID.test(item.sessionId))
            .slice(0, LIMITS.sessions);
          return { sessions, total: Array.isArray(summaries) ? summaries.length : 0 };
        }

        case 'session.messages': {
          // On-demand read of conversation body, byte-budgeted to fit one 8 KiB frame (reserving
          // ~300 bytes for the result wrapper). Prefer the in-memory live run so streaming text
          // is immediately visible before the next disk checkpoint.
          const sessionId = id(input.sessionId, '会话编号');
          const liveRun = harness.runs instanceof Map ? harness.runs.get(sessionId) : null;
          let session = liveRun?.session ?? null;
          if (!session) {
            if (typeof harness.store?.getSession !== 'function') throw new HttpError(503, '会话内容暂时不可用。');
            session = await harness.store.getSession(sessionId);
          }
          const visible = visibleSessionMessages(session);
          const rawBefore = input.beforeIndex === undefined || input.beforeIndex === null ? visible.length : input.beforeIndex;
          if (!Number.isSafeInteger(rawBefore) || rawBefore < 0 || rawBefore > visible.length) {
            throw new HttpError(400, '分页位置无效。');
          }
          const rawLimit = input.limit === undefined || input.limit === null ? LIMITS.messagesPage : input.limit;
          if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > LIMITS.messagesMaxLimit) {
            throw new HttpError(400, `每页消息数必须在 1 到 ${LIMITS.messagesMaxLimit} 之间。`);
          }
          const endIndex = rawBefore;
          const running = Boolean(liveRun && liveRun.finished !== true);
          const page = {
            sessionId,
            title: clip(session?.title ?? '新对话', LIMITS.title) || '新对话',
            running,
            totalMessages: visible.length,
            startIndex: endIndex,
            endIndex,
            hasMoreBefore: endIndex > 0,
            messages: [],
          };
          const selected = [];
          const floor = Math.max(0, endIndex - rawLimit);
          for (let index = endIndex - 1; index >= floor; index -= 1) {
            const { id: messageId, message } = visible[index];
            const fullText = rawMessageText(message);
            const fullReasoning = rawMessageReasoning(message);
            const meta = messageMetaFields(message);
            const entry = {
              id: messageId,
              index,
              role: message.role,
              ...meta,
              text: '',
              textLength: fullText.length,
              // Use the worst-case integer digit width while measuring the byte budget.
              nextOffset: fullText.length,
              hasReasoning: fullReasoning.length > 0,
              reasoningLength: fullReasoning.length,
            };
            const shellBytes = Buffer.byteLength(JSON.stringify({
              ...page,
              startIndex: index,
              hasMoreBefore: index > 0,
              messages: [entry, ...selected],
            }), 'utf8');
            const remaining = MAX_RESPONSE_DATA_BYTES - shellBytes;
            if (selected.length > 0 && remaining < 240) break;
            const slice = sliceTextByJsonBytes(fullText, 0, Math.max(2, remaining + 2));
            if (selected.length > 0 && fullText.length > 0 && slice.text.length === 0) break;
            // If an earlier message cannot fit a substantial chunk in the leftover room, leave it
            // for the previous page so it gets a full ~7.5 KiB budget on its own.
            if (selected.length > 0 && slice.nextOffset !== null && remaining < 1_024) break;
            entry.text = slice.text;
            entry.nextOffset = slice.nextOffset;
            selected.unshift(entry);
          }
          page.messages = selected;
          page.startIndex = selected.length ? selected[0].index : endIndex;
          page.hasMoreBefore = page.startIndex > 0;
          return page;
        }

        case 'session.message.read': {
          // Continues reading a truncated message or tails a streaming assistant reply from the
          // phone's current UTF-16 offset, never splitting a Unicode code point (surrogate pair).
          const sessionId = id(input.sessionId, '会话编号');
          const messageId = bounded(input.messageId, '消息编号', 120).trim();
          const offset = input.offset === undefined || input.offset === null ? 0 : input.offset;
          if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '读取偏移量无效。');
          const field = input.field === undefined || input.field === null ? 'text' : input.field;
          if (field !== 'text' && field !== 'reasoning') throw new HttpError(400, 'field 必须是 text 或 reasoning。');
          const liveRun = harness.runs instanceof Map ? harness.runs.get(sessionId) : null;
          let session = liveRun?.session ?? null;
          if (!session) {
            if (typeof harness.store?.getSession !== 'function') throw new HttpError(503, '会话内容暂时不可用。');
            session = await harness.store.getSession(sessionId);
          }
          const visible = visibleSessionMessages(session);
          const hit = visible.find(item => item.id === messageId);
          if (!hit) throw new HttpError(404, '找不到这条消息。');
          const fullText = field === 'reasoning' ? rawMessageReasoning(hit.message) : rawMessageText(hit.message);
          const fullReasoning = rawMessageReasoning(hit.message);
          const meta = messageMetaFields(hit.message);
          const running = Boolean(liveRun && liveRun.finished !== true);
          const latestMessageId = visible.length ? visible[visible.length - 1].id : null;
          const payload = {
            sessionId,
            messageId,
            field,
            offset: fullText.length,
            chunk: '',
            nextOffset: fullText.length,
            totalLength: fullText.length,
            hasMore: true,
            running,
            totalMessages: visible.length,
            latestMessageId,
            hasReasoning: fullReasoning.length > 0,
            reasoningLength: fullReasoning.length,
            ...meta,
          };
          const shellBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
          const remaining = Math.max(0, MAX_RESPONSE_DATA_BYTES - shellBytes);
          const slice = sliceTextByJsonBytes(fullText, offset, remaining + 2);
          payload.offset = slice.start;
          payload.chunk = slice.text;
          payload.nextOffset = slice.nextOffset;
          payload.hasMore = slice.nextOffset !== null;
          return payload;
        }

        case 'run.stop': {
          const sessionId = id(input.sessionId, '会话编号');
          const result = await upstream('POST', `/api/sessions/${sessionId}/stop`, {});
          await audit({ actor, action, sessionId });
          return result;
        }

        case 'task.dispatch': {
          // Dispatching from a phone is one step away from running commands. Three gates,
          // all of them refuse by default.
          if (!dispatchAllowed()) throw new HttpError(403, '远程派发任务未开启。');
          if (harness.store?.settings?.approvalMode === 'full') {
            throw new HttpError(409, '当前是完整访问模式，远程派任务会被无审批执行。请先切换到询问模式。');
          }
          const sessionId = id(input.sessionId, '会话编号');
          const text = bounded(input.text, '任务内容', LIMITS.dispatchText).trim();
          const mode = input.mode === undefined ? 'chat' : input.mode;
          if (mode !== 'chat' && mode !== 'agent') throw new HttpError(400, '远程派发只支持 chat 或 agent。');
          if (harness.runs instanceof Map && harness.runs.has(sessionId)) {
            throw new HttpError(409, '这个会话正在处理另一条消息，请先停止或等待完成。');
          }
          // The session must already exist: a phone may add work to a conversation the user
          // opened at the desk, never invent one in a directory it picked.
          await harness.store.getSession(sessionId);

          const hits = dispatchHits.get(actor) ?? [];
          const cutoff = now() - 60_000;
          while (hits.length && hits[0] < cutoff) hits.shift();
          if (hits.length >= DISPATCH_PER_MINUTE) throw new HttpError(429, '远程派发过于频繁，请稍后再试。');

          // Wait for response headers so pre-stream 400/409/413 errors surface honestly; once 2xx
          // SSE headers flush, return immediately while draining the stream in the background.
          const result = await upstream('POST', `/api/sessions/${sessionId}/messages`, { text, mode }, { wait: false });
          hits.push(now());
          dispatchHits.set(actor, hits);
          await audit({ actor, action, sessionId, mode, preview: clip(text, 200) });
          return result;
        }

        default:
          throw new HttpError(400, '不支持的中继操作。');
      }
    },
  };
}
