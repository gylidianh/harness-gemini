import { performance } from 'node:perf_hooks';

function textWithoutImages(value) {
  return String(value ?? '')
    .replace(/!\[[^\]]*\]\([^)]*(?:\)|$)/g, '')
    .replace(/<img\b[^>]*(?:>|$)/gi, '')
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*/gi, '')
    .replace(/\/api\/artifacts\/[a-f0-9]{36}\.(?:png|jpe?g|gif|webp)(?:\?download=1)?/gi, '')
    .replace(/https?:\/\/googleusercontent\.com\/image_generation_content\/[^\s)]+/gi, '');
}

/** A labelled fallback, never a claim to use the provider's actual tokenizer. */
export function estimateOutputTokens(value) {
  const text = textWithoutImages(value);
  if (!text.trim()) return 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  const other = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '');
  return Math.ceil(cjk.length + Buffer.byteLength(other, 'utf8') / 4);
}

function outputUsage(usage) {
  const value = usage?.completion_tokens ?? usage?.output_tokens;
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

/**
 * Tracks only model-request intervals, excluding tool work and approval waits.
 *
 * Several requests can be in flight at once: a delegation starts a child model request while the
 * parent's own tools keep running, and two children can overlap. Each request is therefore its own
 * entry, and the total elapsed time counts a second as long as *any* request is open. Without this
 * a child's output tokens landed in the totals while the parent's request window had already
 * closed, so the reported rate collapsed the moment a delegation started.
 */
export class GenerationMetrics {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.entries = [];
    /** Requests that are still open, keyed by their own handle. */
    this.open = new Set();
    this.status = 'running';
  }

  get isRequestActive() { return this.open.size > 0; }

  /**
   * Starts one measured request. The returned handle is the only way to feed that request, so a
   * child request and the parent request never mix their texts or their usage.
   */
  beginRequest({ image = false } = {}) {
    const entry = {
      started: this.now(), ended: null, image, containsImage: false,
      text: '', reasoning: '', toolText: '', apiTokens: null, estimatedTokens: 0, dirty: false,
    };
    this.entries.push(entry);
    this.open.add(entry);
    return entry;
  }

  /** Ends the request the handle belongs to; a stale handle is ignored rather than counted twice. */
  endRequest(entry) {
    if (!entry || entry.ended !== null || !this.open.has(entry)) return null;
    this.open.delete(entry);
    entry.ended = this.now();
    return entry;
  }

  addText(text, entry = null) {
    const target = entry ?? this.lastOpen();
    if (!target || target.image || !text) return;
    target.text += text;
    target.dirty = true;
  }

  /** Thinking text is generated output too, so it counts toward the reported rate. */
  addReasoning(text, entry = null) {
    const target = entry ?? this.lastOpen();
    if (!target || target.image || !text) return;
    target.reasoning += text;
    target.dirty = true;
  }

  markImageOutput(entry = null) {
    const target = entry ?? this.lastOpen();
    if (target) target.containsImage = true;
  }

  recordUsage(usage, entry = null) {
    const target = entry ?? this.lastOpen();
    if (!target) return;
    const value = outputUsage(usage);
    if (value !== null) target.apiTokens = value;
  }

  finishRequest(options = {}, entry = null) {
    // `finishRequest(result)` and `finishRequest()` were the old shapes; both still work, and both
    // close the most recent open request when no handle is given.
    const target = entry ?? this.lastOpen();
    if (!target) return;
    const { usage, toolCalls = [] } = options ?? {};
    this.recordUsage(usage, target);
    target.toolText = toolCalls.map(call => `${call?.function?.name ?? ''}\n${call?.function?.arguments ?? ''}`).join('\n');
    target.dirty = true;
    this.endRequest(target);
  }

  lastOpen() {
    let found = null;
    for (const entry of this.open) found = entry;
    return found;
  }

  /** Closes anything still open, so a cancelled turn cannot keep the timer running. */
  closeAll() {
    for (const entry of [...this.open]) this.endRequest(entry);
  }

  finish(status = 'done') {
    if (!['done', 'cancelled', 'error'].includes(status)) throw new Error('Invalid metric status.');
    this.finishRequest();
    this.closeAll();
    this.status = status;
    return this.snapshot();
  }

  snapshot() {
    const currentTime = this.now();
    const textEntries = this.entries.filter(entry => !entry.image);
    // Image-only turns show their elapsed time, never base64 throughput. Image tools in an agent
    // turn do not inflate or slow down its text-token rate.
    const measured = textEntries.length ? textEntries : this.entries;
    // Overlapping requests are one wall-clock interval, not the sum of their lengths: a parent and
    // two children generating at the same time took that much of the user's time, once.
    const elapsedMs = Math.max(0, Math.round(unionLength(measured, currentTime)));
    let outputTokens = 0;
    const sources = [];
    for (const entry of textEntries) {
      if (entry.apiTokens !== null && !entry.containsImage) {
        outputTokens += entry.apiTokens;
        sources.push('usage');
      } else {
        if (entry.dirty) {
          entry.estimatedTokens = estimateOutputTokens(`${entry.reasoning}\n${entry.text}\n${entry.toolText}`);
          entry.dirty = false;
        }
        outputTokens += entry.estimatedTokens;
        sources.push(entry.estimatedTokens > 0 ? 'estimated' : 'none');
      }
    }
    const source = sources.length && sources.every(value => value === 'usage')
      ? 'usage'
      : sources.some(value => value !== 'none') ? 'estimated' : 'none';
    const rate = source !== 'none' && elapsedMs > 0 ? outputTokens / (elapsedMs / 1000) : null;
    return {
      outputTokens,
      tokensPerSecond: rate === null ? null : Math.round(rate * 10) / 10,
      elapsedMs,
      source,
      status: this.status,
      requests: this.entries.length,
    };
  }
}

/** Length of the union of the request intervals, so overlapping requests are not double-counted. */
function unionLength(entries, currentTime) {
  const spans = entries
    .map(entry => [entry.started, entry.ended ?? currentTime])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let spanStart = null;
  let spanEnd = null;
  for (const [start, end] of spans) {
    if (spanStart === null) { spanStart = start; spanEnd = end; continue; }
    if (start <= spanEnd) { spanEnd = Math.max(spanEnd, end); continue; }
    total += spanEnd - spanStart;
    spanStart = start; spanEnd = end;
  }
  if (spanStart !== null) total += spanEnd - spanStart;
  return total;
}
