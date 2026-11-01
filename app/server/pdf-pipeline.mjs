/** PDF batching stays inside the existing tool loop; transport/retry policy is unchanged. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runExternalSkill, validateExternalArgs } from './external-skills.mjs';
import { planToolExecution, terminateTree } from './tools.mjs';
import { PdfProgress } from './pdf-progress.mjs';
import { checkAbort } from './util.mjs';

export const RECORD_PDF_TOOL = {
  type: 'function',
  function: {
    name: 'record_pdf_pages',
    description: '记录刚刚看过的 PDF 页，保留准确文字、金额、编号等及其页码；看不清时如实写入 text 并设 needsReview=true。程序验证并保存后才移除已完成页图片。continue=true 在同一次调用内交出下一批，无需另调 read_pdf。整个用户任务已完成时可同时提交 finalAnswer 最终答复，记录成功后直接展示；普通进度叙述不代表完成。不要记录尚未看过的页。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'string', description: 'read_pdf 返回的 documentId' },
        targetId: { type: 'string', description: '可选：read_pdf 返回的 pdfProgress.targetId；同文档多范围或复核有歧义时必须提供' },
        finalAnswer: { type: 'string', maxLength: 100000, description: '仅整个用户任务已完成时填写完整最终答复；普通进度说明不要填此字段' },
        pages: { type: 'array', minItems: 1, maxItems: 24, items: {
          type: 'object', additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            text: { type: 'string', minLength: 1, description: '本页已读取内容和关键数据；不猜测不清晰的信息' },
            fields: { type: 'object', description: '可选：编号、金额、数量、日期等准确字段' },
            needsReview: { type: 'boolean', description: '需要继续看图核对时设 true，图片会继续保留' },
          }, required: ['page', 'text'],
        } },
        continue: { type: 'boolean', description: '记录后直接读取原范围内下一批；默认 false' },
      }, required: ['documentId', 'pages'],
    },
  },
};

export const PDF_GUIDANCE = 'PDF 看图后调用 record_pdf_pages 提交每页文字和关键字段及 pdfProgress.targetId；continue=true 在同一调用内自动交出下一批，避免额外选页轮次。整个用户任务已完成时，可在最后一次记录的 finalAnswer 字段提交完整最终答复，无需额外总结请求；进度叙述不代表最终答复。确认记录前图片不会被当作已读完成。已完成页用记录核验，需要看原图时调用 ext_read_pdf 指定 pages 并设 review=true，宿主会强制交付原图并使用独立复核目标。断线后调用 ext_read_pdf 带原 path、resume=true 和原 pdfProgress.targetId 从未确认批次继续；多个目标匹配时必须指定 targetId。已有记录只是之前读取的内容，不能假定覆盖当前新问题；扫描页未能交付图片时只能记录 needsReview=true。';

const prefetches = new Map();
const keyFor = (workspace, args) => createHash('sha256').update(JSON.stringify([
  path.resolve(workspace, String(args.path ?? '')), Number(/^\s*(\d+)/.exec(args.pages ?? '')?.[1] ?? 1),
  args.vision ?? 'auto', args.dpi ?? 200, args.maxImages ?? 4, args.search ?? '',
])).digest('hex');

export class PdfPipeline {
  constructor({ workspace, externalSkills, signal, toolImages, approvalMode = 'ask' }) {
    Object.assign(this, { workspace, externalSkills, signal, toolImages, approvalMode });
    this.progress = new PdfProgress({ workspace });
    this.tasks = new Set();
    this.textKeys = new Set();
    this.pendingTextKeys = new Set();
    this.authorizedDocuments = new Set();
  }

  async init() {
    // An unusable PDF cache must not prevent an unrelated conversation from starting.
    try { await this.progress.init(); } catch (error) { this.progressError = error; }
    return this;
  }

  async prompt() {
    if (this.progressError) return `${PDF_GUIDANCE}\nPDF 进度缓存暂不可用；普通任务可继续，读取 PDF 时会报告具体原因。`;
    const summary = await this.progress.prompt();
    return summary ? `${PDF_GUIDANCE}\n${summary}` : PDF_GUIDANCE;
  }

  async read(args, invoke) {
    checkAbort(this.signal);
    let actual = { ...args };
    const review = args?.review === true;
    let restored;
    if (args?.resume === true && args?.review !== true) {
      restored = await this.progress.resume(args);
      if (restored?.complete || restored?.completed) return { skill: 'read_pdf', exitCode: 0, result: {
        ...restored, resumed: true, note: '这些页已保存读取记录；请使用记录继续。新问题缺少信息时可指定页并设 review=true 复核。',
      } };
      if (restored?.nextArgs || restored?.args) actual = { ...actual, ...(restored.nextArgs ?? restored.args) };
    }
    if (review) actual.vision = 'force';
    delete actual.resume;
    delete actual.review;
    delete actual.targetId;
    const key = keyFor(this.workspace, actual);
    const ready = prefetches.get(key);
    if (ready) await ready.promise.catch(() => {});
    checkAbort(this.signal);
    const output = await invoke(actual);
    if (output?.exitCode === 0 && output?.result?.documentId && actual.info !== true && !actual.search && output.result.pagesReadList?.length) {
      await this.progress.register(output, actual, { freshTarget: review });
      this.authorizedDocuments.add(output.result.documentId);
      const imageKeys = new Set((output.result.images ?? []).map(image => image.pdfImageKey ?? image.imageKey));
      for (const key of output.result.pdfProgress?.preparedKeys ?? []) if (!imageKeys.has(key)) {
        this.textKeys.add(key); this.pendingTextKeys.add(key);
      }
      if (restored?.records?.length) output.result.previousRecords = restored.records;
      output.result.recordTool = 'record_pdf_pages';
      output.result.note = `${output.result.note ?? ''} ${PDF_GUIDANCE}`.trim();
      await this.prefetch(output, actual);
    }
    return output;
  }

  async record(args, invoke) {
    checkAbort(this.signal);
    if (args?.finalAnswer !== undefined && (typeof args.finalAnswer !== 'string' || args.finalAnswer.length > 100000)) throw new Error('最终答复必须是至多 100000 字符的文本。');
    const saved = await this.progress.record(args);
    this.toolImages.confirmPdf(saved.imageKeys ?? []);
    for (const page of saved.records ?? []) if (page.status === 'extracted') this.pendingTextKeys.delete(page.pageId);
    if (args.continue === true && saved.nextArgs && this.authorizedDocuments.has(args.documentId) && !args.pages.some(page => page.needsReview)) {
      const batch = await this.read(saved.nextArgs, invoke);
      // Keep records even when the next read fails; a retry must never redo confirmed pages.
      return { ...batch, recorded: saved.recorded, records: saved.records, progress: saved };
    }
    return saved.complete && args.finalAnswer?.trim() ? { ...saved, finalAnswer: args.finalAnswer.trim() } : saved;
  }

  async prefetch(output, args) {
    if (this.tasks.size || !output.result.images?.length || args.vision === 'off') return;
    if (!output.result.prefetchSupported && output.result.renderCacheVersion !== 1) return;
    if (!Number.isSafeInteger(output.result.nextPage)) return;
    const skill = this.externalSkills?.get?.('ext_read_pdf');
    if (!skill) return;
    // resume points to the current unconfirmed batch. The next batch starts at nextPage instead.
    const next = { ...args, pages: nextPages(args.pages, output.result.nextPage, output.result.pageCount) };
    if (!next.pages) return;
    delete next.resume; delete next.review;
    const key = keyFor(this.workspace, next);
    if (prefetches.has(key)) return;
    // 1.3.4: the next batch is rendered ahead of time only when the same call would run by itself
    // now: its arguments must pass the skill's own schema, and its plan must need no approval.
    // In 请求批准 mode the user approved one batch, not the ones after it.
    try {
      validateExternalArgs(skill, next);
      const plan = await planToolExecution('ext_read_pdf', next, { workspace: this.workspace, approvalMode: this.approvalMode, externalSkills: this.externalSkills });
      if (plan?.requiresApproval !== false) return;
    } catch { return; }
    if (this.signal?.aborted || prefetches.has(key) || this.tasks.size) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal?.addEventListener('abort', abort, { once: true });
    if (this.signal?.aborted) controller.abort();
    const task = { controller, promise: null };
    task.promise = runExternalSkill(skill, { ...next, _prefetchOnly: true }, { workspace: this.workspace, signal: controller.signal, terminate: terminateTree })
      .catch(() => null).finally(() => {
        this.signal?.removeEventListener('abort', abort);
        if (prefetches.get(key) === task) prefetches.delete(key);
        this.tasks.delete(task);
      });
    prefetches.set(key, task); this.tasks.add(task);
  }

  async markSent() {
    const keys = [...this.toolImages.sentPdfKeys(), ...this.textKeys];
    if (!keys.length) return;
    await this.progress.markSent(keys);
    this.textKeys.clear();
  }

  hasPendingPages() { return this.pendingTextKeys.size > 0 || this.toolImages.hasPendingPdf(); }

  async close() {
    const tasks = [...this.tasks];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map(task => task.promise));
  }
}

/** Preserve an explicit upper bound and non-contiguous selections when continuing. */
export function nextPages(spec, next, count) {
  if (!Number.isSafeInteger(next) || next < 1) return null;
  const pages = new Set();
  for (const raw of String(spec || `1-${count}`).replaceAll('，', ',').split(',')) {
    const match = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(raw.trim());
    if (!match) return null;
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : raw.includes('-') ? count : first;
    for (let page = Math.max(first, 1); page <= Math.min(last, count); page++) pages.add(page);
  }
  const selected = [...pages];
  const index = selected.indexOf(next);
  return index < 0 ? null : selected.slice(index).join(',') || null;
}
