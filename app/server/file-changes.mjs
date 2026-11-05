// 1.4.5: the files the agent changed, per conversation and per turn, with revert and re-apply.
//
// The record model follows ZCode's per-turn file changes (`ZCodePersistedFileChange`: one entry per
// turn, each file keeping the content before its first write and after its last write, plus an
// applied/reverted state), and `computeLineChangeStat` below is adapted from ZCode's
// packages/shared/src/lineChangeStat.ts. ZCode is Copyright 2026 Z.AI Co., Ltd, Apache License 2.0;
// see THIRD-PARTY-NOTICES.md. Storage, revert and conflict handling are Harness Gemini's own.
//
// Contents live under <dataDir>/file-changes/<sessionId>/, outside the session workspace, so the
// agent's own file tools can never rewrite the history it is judged by.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { atomicWrite, HttpError, samePath } from './util.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A file above this size is still tracked (hash and size), but its content is not kept. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Line statistics and diffs are only computed for text up to this size. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 200;
const MAX_LCS_CELLS = 400_000;
const MAX_DIFF_CELLS = 4_000_000;
const MAX_DIFF_LINES = 4_000;
const INDEX_VERSION = 1;

// ---------------------------------------------------------------- line statistics (from ZCode)

function splitIntoLogicalLines(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Real added/removed line counts; a huge middle section falls back to a conservative estimate. */
export function computeLineChangeStat(beforeContent, afterContent) {
  const beforeLines = splitIntoLogicalLines(beforeContent);
  const afterLines = splitIntoLogicalLines(afterContent);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let beforeTail = beforeLines.length - 1;
  let afterTail = afterLines.length - 1;
  while (beforeTail >= prefix && afterTail >= prefix && beforeLines[beforeTail] === afterLines[afterTail]) { beforeTail -= 1; afterTail -= 1; }
  const before = beforeLines.slice(prefix, beforeTail + 1);
  const after = afterLines.slice(prefix, afterTail + 1);
  if (before.length === 0) return { added: after.length, removed: 0 };
  if (after.length === 0) return { added: 0, removed: before.length };
  if (before.length * after.length > MAX_LCS_CELLS) return { added: after.length, removed: before.length };
  const lcs = new Array(after.length + 1).fill(0);
  for (let b = 1; b <= before.length; b += 1) {
    let diagonal = 0;
    for (let a = 1; a <= after.length; a += 1) {
      const previousRow = lcs[a];
      lcs[a] = before[b - 1] === after[a - 1] ? diagonal + 1 : Math.max(lcs[a], lcs[a - 1]);
      diagonal = previousRow;
    }
  }
  const unchanged = lcs[after.length] ?? 0;
  return { added: after.length - unchanged, removed: before.length - unchanged };
}

/** A unified diff as hunks of { t: ' ' | '+' | '-', s } lines, with three lines of context. */
export function unifiedDiff(beforeText, afterText, context = 3) {
  const a = splitIntoLogicalLines(beforeText);
  const b = splitIntoLogicalLines(afterText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let aEnd = a.length; let bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) { aEnd -= 1; bEnd -= 1; }
  const ops = [];
  for (let i = 0; i < prefix; i++) ops.push({ t: ' ', s: a[i], ai: i, bi: i });
  const midA = a.slice(prefix, aEnd); const midB = b.slice(prefix, bEnd);
  let approximate = false;
  if (midA.length && midB.length && (midA.length + 1) * (midB.length + 1) <= MAX_DIFF_CELLS) {
    const n = midA.length; const m = midB.length; const w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] = midA[i] === midB[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ t: ' ', s: midA[i], ai: prefix + i, bi: prefix + j }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) { ops.push({ t: '-', s: midA[i], ai: prefix + i }); i++; }
      else { ops.push({ t: '+', s: midB[j], bi: prefix + j }); j++; }
    }
    for (; i < n; i++) ops.push({ t: '-', s: midA[i], ai: prefix + i });
    for (; j < m; j++) ops.push({ t: '+', s: midB[j], bi: prefix + j });
  } else {
    approximate = midA.length > 0 && midB.length > 0;
    midA.forEach((s, i) => ops.push({ t: '-', s, ai: prefix + i }));
    midB.forEach((s, j) => ops.push({ t: '+', s, bi: prefix + j }));
  }
  for (let i = aEnd, j = bEnd; i < a.length; i++, j++) ops.push({ t: ' ', s: a[i], ai: i, bi: j });

  // Group the changes into hunks with `context` unchanged lines around each change.
  const changed = [];
  ops.forEach((op, k) => { if (op.t !== ' ') changed.push(k); });
  const hunks = [];
  let truncated = false; let emitted = 0;
  let g = 0;
  while (g < changed.length) {
    let last = changed[g];
    let h = g + 1;
    while (h < changed.length && changed[h] - last <= context * 2 + 1) { last = changed[h]; h++; }
    const from = Math.max(0, changed[g] - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldLine = 1; let newLine = 1;
    for (let k = 0; k < from; k++) { if (ops[k].t !== '+') oldLine++; if (ops[k].t !== '-') newLine++; }
    const lines = [];
    for (let k = from; k <= to; k++) {
      const op = ops[k];
      lines.push({ t: op.t, s: op.s, o: op.t === '+' ? null : oldLine, n: op.t === '-' ? null : newLine });
      if (op.t !== '+') oldLine++;
      if (op.t !== '-') newLine++;
    }
    hunks.push({ lines });
    emitted += lines.length;
    if (emitted > MAX_DIFF_LINES) { truncated = h < changed.length; break; }
    g = h;
  }
  for (const hunk of hunks) for (const line of hunk.lines) if (line.s.length > 2_000) line.s = line.s.slice(0, 2_000) + '…';
  return { hunks, truncated, approximate };
}

// ---------------------------------------------------------------- content helpers

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8_000);
  return sample.includes(0);
}

function decodeText(buffer) {
  if (!buffer || looksBinary(buffer)) return null;
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function fileKey(absolute) {
  const resolved = path.resolve(absolute);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

/** Hash a file by streaming it; the content is optionally copied into the blob store as it goes. */
async function hashFile(target, { copyTo = null } = {}) {
  const stat = await lstatOrNull(target);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new HttpError(409, '目标已变成符号链接，为安全起见不处理它。');
  if (!stat.isFile()) throw new HttpError(409, '目标已不是普通文件。');
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk); size += chunk.length;
      if (head.length < 8_000) head = Buffer.concat([head, chunk.subarray(0, 8_000 - head.length)]);
      done(null, chunk);
    },
  });
  const source = createReadStream(target);
  if (copyTo) await pipeline(source, meter, createWriteStream(copyTo, { flags: 'wx', mode: 0o600 }));
  else { await pipeline(source, meter, async function* (stream) { for await (const _ of stream) { /* drain */ } }); }
  return { sha: hash.digest('hex'), size, binary: looksBinary(head), mode: stat.mode & 0o777 };
}

// ---------------------------------------------------------------- the store

export class FileChangeStore {
  constructor({ dataDir }) {
    this.root = path.join(path.resolve(dataDir), 'file-changes');
    this.queues = new Map();
  }

  sessionDir(sessionId) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new HttpError(404, '会话不存在。');
    return path.join(this.root, sessionId.toLowerCase());
  }

  /** All index changes of one session run one after another. */
  enqueue(sessionId, task) {
    const key = String(sessionId).toLowerCase();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    this.queues.set(key, tail);
    tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return next;
  }

  async load(sessionId) {
    const file = path.join(this.sessionDir(sessionId), 'index.json');
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed && Array.isArray(parsed.turns)) return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return { version: INDEX_VERSION, sequence: 0, turns: [] };
  }

  async save(sessionId, index) {
    await atomicWrite(path.join(this.sessionDir(sessionId), 'index.json'), JSON.stringify(index));
  }

  blobPath(sessionId, sha) {
    if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new HttpError(400, '快照编号无效。');
    return path.join(this.sessionDir(sessionId), 'blobs', sha);
  }

  /** Snapshot the file as it is now: null when it does not exist. */
  async capture(sessionId, absolute) {
    const stat = await lstatOrNull(absolute);
    if (!stat) return null;
    if (!stat.isFile()) return { unavailable: true, reason: '原内容不是普通文件，无法保存快照。' };
    const blobs = path.join(this.sessionDir(sessionId), 'blobs');
    await fs.mkdir(blobs, { recursive: true, mode: 0o700 });
    if (stat.size > MAX_SNAPSHOT_BYTES) {
      const info = await hashFile(absolute);
      return { ...info, stored: false };
    }
    const temporary = path.join(blobs, `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const info = await hashFile(absolute, { copyTo: temporary });
      const target = this.blobPath(sessionId, info.sha);
      if (await lstatOrNull(target)) await fs.unlink(temporary);
      else await fs.rename(temporary, target);
      return { ...info, stored: true };
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async readBlob(sessionId, snapshot) {
    if (!snapshot?.stored) return null;
    return fs.readFile(this.blobPath(sessionId, snapshot.sha));
  }

  async lineStat(sessionId, entry) {
    if (!entry.after || entry.after.binary || entry.before?.binary || entry.before?.unavailable) return { added: 0, removed: 0, text: false };
    if (entry.after.size > MAX_TEXT_BYTES || (entry.before && entry.before.size > MAX_TEXT_BYTES)) return { added: 0, removed: 0, text: false };
    if (!entry.after.stored || (entry.before && !entry.before.stored)) return { added: 0, removed: 0, text: false };
    const before = entry.before ? decodeText(await this.readBlob(sessionId, entry.before)) : '';
    const after = decodeText(await this.readBlob(sessionId, entry.after));
    if (before === null || after === null) return { added: 0, removed: 0, text: false };
    return { ...computeLineChangeStat(before, after), text: true };
  }

  /**
   * One recorder per conversation turn. The tool calls `before` just ahead of a write and `after`
   * once the write succeeded; a write that failed simply never reports back and leaves no entry.
   */
  recorder(sessionId, { turnId, userText = '', createdAt = new Date().toISOString(), onChange = null } = {}) {
    const store = this;
    return {
      async before(absolute, { tool, relative } = {}) {
        try {
          const index = await store.load(sessionId);
          const turn = index.turns.find(item => item.turnId === turnId);
          const key = fileKey(absolute);
          if (turn?.files.some(file => file.key === key)) return { absolute, key, tool, relative, known: true };
          return { absolute, key, tool, relative, known: false, before: await store.capture(sessionId, absolute) };
        } catch (error) {
          return { absolute, key: fileKey(absolute), tool, relative, known: false, before: { unavailable: true, reason: `保存原内容失败：${String(error?.message ?? error).slice(0, 160)}` } };
        }
      },
      async after(token) {
        if (!token) return;
        try {
          const after = await store.capture(sessionId, token.absolute);
          if (!after || after.unavailable) return;
          await store.enqueue(sessionId, async () => {
            const index = await store.load(sessionId);
            let turn = index.turns.find(item => item.turnId === turnId);
            if (!turn) {
              index.sequence = (index.sequence ?? 0) + 1;
              turn = { turnId, turnIndex: index.sequence, createdAt, userText: String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), files: [] };
              index.turns.push(turn);
            }
            const now = new Date().toISOString();
            let entry = turn.files.find(file => file.key === token.key);
            if (!entry) {
              entry = {
                key: token.key, path: token.absolute, relative: token.relative ?? path.basename(token.absolute), tool: token.tool,
                before: token.known ? null : token.before ?? null, writeCount: 0, firstAt: now, state: 'applied',
              };
              turn.files.push(entry);
            }
            entry.after = after; entry.writeCount += 1; entry.lastAt = now; entry.tool = token.tool ?? entry.tool;
            entry.state = 'applied'; delete entry.revertedAt;
            Object.assign(entry, await store.lineStat(sessionId, entry).catch(() => ({ added: 0, removed: 0, text: false })));
            await store.prune(sessionId, index);
            await store.save(sessionId, index);
          });
          await onChange?.();
        } catch { /* A failed record must never fail the write that already happened. */ }
      },
    };
  }

  /** Keep the most recent turns and drop content nobody refers to any more. */
  async prune(sessionId, index) {
    if (index.turns.length <= MAX_TURNS) return;
    index.turns = index.turns.slice(-MAX_TURNS);
    const used = new Set();
    for (const turn of index.turns) for (const file of turn.files) { if (file.before?.sha) used.add(file.before.sha); if (file.after?.sha) used.add(file.after.sha); }
    const blobs = path.join(this.sessionDir(sessionId), 'blobs');
    for (const name of await fs.readdir(blobs).catch(() => [])) {
      if (/^[0-9a-f]{64}$/.test(name) && !used.has(name)) await fs.unlink(path.join(blobs, name)).catch(() => {});
    }
  }

  describeFile(file) {
    const kind = file.before === null ? (file.tool === 'download_file' ? 'downloaded' : 'created') : 'modified';
    let canRevert = true; let reason = '';
    if (file.before?.unavailable) { canRevert = false; reason = file.before.reason || '没有保存到原内容，无法撤回。'; }
    else if (file.before && !file.before.stored) { canRevert = false; reason = '原文件超过 32 MB，没有保存快照，无法撤回。'; }
    const canReapply = Boolean(file.after?.stored);
    return {
      path: file.path, relative: file.relative, name: path.basename(file.path), tool: file.tool, kind,
      state: file.state, added: file.added ?? 0, removed: file.removed ?? 0, text: Boolean(file.text),
      binary: Boolean(file.after?.binary || file.before?.binary),
      beforeSize: file.before && !file.before.unavailable ? file.before.size : null, afterSize: file.after?.size ?? 0,
      writeCount: file.writeCount, firstAt: file.firstAt, lastAt: file.lastAt, revertedAt: file.revertedAt ?? null,
      canRevert, canReapply, reason,
    };
  }

  describeTurn(turn) {
    const files = turn.files.filter(file => file.after).map(file => this.describeFile(file)).sort((l, r) => l.relative.localeCompare(r.relative));
    const reverted = files.filter(file => file.state === 'reverted').length;
    return {
      turnId: turn.turnId, turnIndex: turn.turnIndex, createdAt: turn.createdAt, userText: turn.userText,
      fileState: reverted === 0 ? 'applied' : reverted === files.length ? 'reverted' : 'partial',
      fileCount: files.length,
      added: files.filter(file => file.state !== 'reverted').reduce((sum, file) => sum + file.added, 0),
      removed: files.filter(file => file.state !== 'reverted').reduce((sum, file) => sum + file.removed, 0),
      files,
    };
  }

  async list(sessionId) {
    const index = await this.load(sessionId);
    const turns = index.turns.map(turn => this.describeTurn(turn)).filter(turn => turn.fileCount > 0).reverse();
    const live = new Set();
    for (const turn of turns) for (const file of turn.files) if (file.state !== 'reverted') live.add(fileKey(file.path));
    return { sessionId: sessionId.toLowerCase(), turns, fileCount: live.size, turnCount: turns.length };
  }

  findTurn(index, turnId) {
    const turn = index.turns.find(item => item.turnId === turnId);
    if (!turn) throw new HttpError(404, '这一轮没有文件改动记录。');
    return turn;
  }

  async diff(sessionId, turnId, filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new HttpError(400, '缺少文件路径。');
    const index = await this.load(sessionId);
    const turn = this.findTurn(index, turnId);
    const entry = turn.files.find(file => file.key === fileKey(filePath));
    if (!entry?.after) throw new HttpError(404, '这一轮没有改动这个文件。');
    const info = this.describeFile(entry);
    const base = { ...info, turnId, turnIndex: turn.turnIndex };
    if (info.binary) return { ...base, diffable: false, message: '二进制文件，不显示文本差异。' };
    if (entry.before?.unavailable) return { ...base, diffable: false, message: entry.before.reason };
    if (!entry.after.stored || (entry.before && !entry.before.stored) || entry.after.size > MAX_TEXT_BYTES || (entry.before?.size ?? 0) > MAX_TEXT_BYTES) {
      return { ...base, diffable: false, message: '文件过大，不显示文本差异。' };
    }
    const before = entry.before ? decodeText(await this.readBlob(sessionId, entry.before)) : '';
    const after = decodeText(await this.readBlob(sessionId, entry.after));
    if (before === null || after === null) return { ...base, diffable: false, message: '不是文本文件，不显示文本差异。' };
    return { ...base, diffable: true, ...unifiedDiff(before, after) };
  }

  /** Check that a recorded path is still a plain path we may write to. */
  async safeTarget(entry) {
    const parent = path.dirname(entry.path);
    const real = await fs.realpath(parent).catch(() => null);
    if (real && !samePath(real, parent)) throw new HttpError(409, '文件所在文件夹已被替换为链接，为安全起见不处理。');
    const stat = await lstatOrNull(entry.path);
    if (stat?.isSymbolicLink()) throw new HttpError(409, '目标已变成符号链接，为安全起见不处理。');
    if (stat && !stat.isFile()) throw new HttpError(409, '目标已不是普通文件。');
  }

  /**
   * Put one file back to its state before the turn (`revert`) or after it (`reapply`). Unless
   * `force` is set, a file that changed since — by the user, a command or a later turn — is left
   * alone and reported as a conflict, so a revert never silently destroys newer work.
   */
  async applyFile(sessionId, entry, action, force) {
    const toBefore = action === 'revert';
    if (toBefore ? entry.state === 'reverted' : entry.state !== 'reverted') return { status: 'skipped' };
    const info = this.describeFile(entry);
    if (toBefore && !info.canRevert) return { status: 'unavailable', reason: info.reason };
    if (!toBefore && !info.canReapply) return { status: 'unavailable', reason: '改动后的文件超过 32 MB，没有保存快照，无法恢复。' };
    await this.safeTarget(entry);
    const current = await hashFile(entry.path);
    const expected = toBefore ? entry.after : entry.before;
    const expectedSha = expected?.sha ?? null;
    if (!force && (current?.sha ?? null) !== expectedSha) {
      const reason = current === null
        ? '文件已被删除或移走。'
        : expectedSha === null ? '这个位置现在有另一个文件。' : '文件在这之后又被修改过（可能是你、命令或之后的对话）。';
      return { status: 'conflict', reason };
    }
    const target = toBefore ? entry.before : entry.after;
    if (target === null) {
      if (current) await fs.unlink(entry.path);
    } else {
      const content = await this.readBlob(sessionId, target);
      await atomicWrite(entry.path, content, { mode: target.mode || current?.mode || 0o600 });
      await this.safeTarget(entry);
    }
    entry.state = toBefore ? 'reverted' : 'applied';
    if (toBefore) entry.revertedAt = new Date().toISOString(); else delete entry.revertedAt;
    return { status: 'done' };
  }

  async apply(sessionId, turnId, { action = 'revert', paths = null, force = false } = {}) {
    if (!['revert', 'reapply'].includes(action)) throw new HttpError(400, '未知的操作。');
    if (paths !== null && (!Array.isArray(paths) || paths.length > 500 || paths.some(item => typeof item !== 'string'))) throw new HttpError(400, 'paths 必须是文件路径列表。');
    return this.enqueue(sessionId, async () => {
      const index = await this.load(sessionId);
      const turn = this.findTurn(index, turnId);
      const wanted = paths ? new Set(paths.map(fileKey)) : null;
      const entries = turn.files.filter(file => file.after && (!wanted || wanted.has(file.key)));
      if (wanted && !entries.length) throw new HttpError(404, '这一轮没有改动这个文件。');
      const done = []; const conflicts = []; const failed = []; const unavailable = [];
      for (const entry of entries) {
        try {
          const result = await this.applyFile(sessionId, entry, action, force === true);
          if (result.status === 'done') done.push(entry.relative);
          else if (result.status === 'conflict') conflicts.push({ path: entry.path, relative: entry.relative, reason: result.reason });
          else if (result.status === 'unavailable') unavailable.push({ path: entry.path, relative: entry.relative, reason: result.reason });
        } catch (error) {
          failed.push({ path: entry.path, relative: entry.relative, reason: String(error?.message ?? error).slice(0, 200) });
        }
      }
      await this.save(sessionId, index);
      return { action, done, conflicts, unavailable, failed, turn: this.describeTurn(turn) };
    });
  }

  async removeSession(sessionId) {
    const dir = this.sessionDir(sessionId);
    await this.enqueue(sessionId, async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (await lstatOrNull(dir)) throw new Error('删除后文件改动快照目录仍然存在。');
    });
  }
}
