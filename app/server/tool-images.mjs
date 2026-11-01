/**
 * Bounded tool images. PDF pages stay queued until the model records their contents (1.2.4).
 * Internal page identities never become provider message fields or tool-output base64.
 */
import { createHash } from 'node:crypto';

export const MAX_RETAINED_SEEN_IMAGES = 20;
export const MAX_RETAINED_SEEN_CHARS = 8 * 1024 * 1024;
export const MAX_REQUEST_IMAGES = 24;
export const MAX_REQUEST_IMAGE_CHARS = 14 * 1024 * 1024;

export const IMAGE_TURN_NOTICE = '看图后请先记录各页关键信息；PDF 页请调用 record_pdf_pages 保存每页 text/fields，需要复核的页标 needsReview=true。成功发送不等于已提取，未记录的页会继续保留；记录完成后图片才会从后续请求移除。一次记录时可设置 continue=true 自动取得下一批，不必另调一次读取工具。';

const RETIRED = label => '[这张图片已从后续请求中移除（为控制请求大小）：' + label + '。你看图时记下的内容在前面的回复里，请以那份记录为准；只有记录里确实缺少需要的信息时，才重新调用工具查看。]';
const DROPPED = label => '[本次请求的图片太多，这张图片没有发送：' + label + '。请单独重新调用相应工具查看。]';
const PDF_RECORDED = label => '[此 PDF 图片的页面内容已通过 record_pdf_pages 保存：' + label + '。请使用已保存的页码、文字及关键字段；需要复核时只重新查看指定页。]';
const PDF_PENDING = label => '[此 PDF 图片仍在待发送队列，本次请求未包含：' + label + '。请先调用 record_pdf_pages 记录当前已看到的页面，程序腾出空间后会继续发送；不要宣称已经看过这张图。]';
export const DUPLICATE = label => '[这张图片与本轮已排队或已发送的图片完全相同：' + label + '。请使用队列或上文中的同一张图；未发送的图片仍会按批交付，不必再次读取。]';

const digest = url => createHash('sha256').update(String(url)).digest('hex');

function labelFor(content, index) {
  const previous = content[index - 1];
  if (previous?.type === 'text' && typeof previous.text === 'string' && previous.text.length <= 400 && !previous.text.startsWith('以下是')) return previous.text;
  return '图片';
}

export class ToolImageLedger {
  constructor({
    maxSeenImages = MAX_RETAINED_SEEN_IMAGES, maxSeenChars = MAX_RETAINED_SEEN_CHARS,
    maxRequestImages = MAX_REQUEST_IMAGES, maxRequestChars = MAX_REQUEST_IMAGE_CHARS,
  } = {}) {
    Object.assign(this, { maxSeenImages, maxSeenChars, maxRequestImages, maxRequestChars });
    this.turns = [];
    this.pdfImages = new Map();
    this.retired = 0;
    this.duplicates = 0;
    this.requestPdfKeys = [];
    this.successfulPdfKeys = [];
    this.selectedSlots = new Set();
  }

  /**
   * 1.3.0: the per-request image cap also follows the room the context window leaves. Each image
   * is reserved at 2,048 tokens, so a fixed count alone let a small window be overrun by images.
   * At least one image always stays allowed; the request check still guards the total.
   */
  limitRequestImages(room) {
    if (this.configuredMaxRequestImages === undefined) this.configuredMaxRequestImages = this.maxRequestImages;
    const cap = this.configuredMaxRequestImages;
    this.maxRequestImages = Math.max(1, Math.min(cap, Number.isFinite(room) ? Math.floor(room) : cap));
  }

  /** Messages whose image parts this ledger decides about. */
  managedMessages() { return new Set(this.turns.map(turn => turn.message)); }

  /** Call before track()/has(); byte-identical pages can share the same picture. */
  registerPdf(url, imageKey) {
    if (typeof url !== 'string' || !url || typeof imageKey !== 'string' || !imageKey || imageKey.length > 512) return;
    const key = digest(url);
    let image = this.pdfImages.get(key);
    // A fresh explicit view after retirement starts another confirmation cycle.
    if (!image || (!image.slots.some(slot => !slot.retired) && image.keys.size && [...image.keys].every(value => image.confirmed.has(value)))) {
      image = { keys: new Set(), confirmed: new Set(), sent: new Set(), slots: [] };
      this.pdfImages.set(key, image);
    }
    image.keys.add(imageKey);
    for (const turn of this.turns) {
      for (const slot of turn.slots) {
        if (!slot.retired && slot.digest === key && !image.slots.includes(slot)) {
          slot.pdf = image;
          image.slots.push(slot);
        }
      }
    }
  }

  /** True for an attached image or one already in the PDF delivery queue. */
  has(url) {
    const key = digest(url);
    const pdf = this.pdfImages.get(key);
    if (pdf?.slots.some(slot => !slot.retired)) return true;
    return this.turns.some(turn => turn.slots.some(slot => !slot.retired && slot.message.content[slot.index]?.type === 'image_url' && slot.digest === key));
  }

  hasPendingPdf() {
    return [...this.pdfImages.values()].some(image => image.slots.some(slot => !slot.retired) && [...image.keys].some(key => !image.confirmed.has(key)));
  }

  noteDuplicate() { this.duplicates += 1; }

  track(message) {
    if (!message || !Array.isArray(message.content) || this.turns.some(turn => turn.message === message)) return;
    if (!message.content.some(part => part?.type === 'image_url')) return;
    if (!message.content.some(part => part?.type === 'text' && part.text === IMAGE_TURN_NOTICE)) message.content.push({ type: 'text', text: IMAGE_TURN_NOTICE });
    const turn = { message, seen: false, slots: [] };
    for (let index = 0; index < message.content.length; index++) {
      const original = message.content[index];
      if (original?.type !== 'image_url') continue;
      const key = digest(original.image_url?.url);
      const slot = { message, index, original, digest: key, label: labelFor(message.content, index), seen: false, retired: false, pdf: this.pdfImages.get(key) ?? null };
      turn.slots.push(slot);
      slot.pdf?.slots.push(slot);
    }
    this.turns.push(turn);
  }

  beforeRequest() {
    this.enforce();
    this.requestPdfKeys = [...new Set([...this.selectedSlots].flatMap(slot => slot.pdf ? [...slot.pdf.keys] : []))];
  }

  /** Deferred pages never become seen/sent simply because another image succeeded. */
  afterRequest() {
    for (const slot of this.selectedSlots) {
      slot.seen = true;
      if (slot.pdf) for (const key of slot.pdf.keys) slot.pdf.sent.add(key);
    }
    for (const turn of this.turns) turn.seen = turn.slots.every(slot => slot.retired || slot.seen);
    this.successfulPdfKeys = [...this.requestPdfKeys];
    this.enforce();
  }

  /** Keys in the last successful request; safe to call after afterRequest(). */
  sentPdfKeys() { return [...this.successfulPdfKeys]; }

  /** Shared pictures retire only once every page represented by them is recorded. */
  confirmPdf(imageKeys) {
    const confirmed = new Set(Array.isArray(imageKeys) ? imageKeys : []);
    for (const image of this.pdfImages.values()) {
      for (const key of confirmed) if (image.keys.has(key) && image.sent.has(key)) image.confirmed.add(key);
      if (!image.keys.size || ![...image.keys].every(key => image.confirmed.has(key))) continue;
      for (const slot of image.slots) this.retire(slot, PDF_RECORDED(slot.label));
    }
    this.enforce();
  }

  stats() {
    let images = 0; let chars = 0;
    for (const { message } of this.turns) for (const part of message.content) if (part?.type === 'image_url') { images += 1; chars += String(part.image_url?.url ?? '').length; }
    return { images, chars, retired: this.retired, duplicates: this.duplicates };
  }

  retire(slot, text) {
    if (slot.retired) return;
    slot.message.content[slot.index] = { type: 'text', text };
    slot.original = null;
    slot.retired = true;
    this.retired += 1;
  }

  enforce() {
    let requestImages = 0; let requestChars = 0;
    let seenImages = 0; let seenChars = 0;
    this.selectedSlots = new Set();
    const fits = size => requestImages + 1 <= this.maxRequestImages && requestChars + size <= this.maxRequestChars;
    const keep = slot => {
      slot.message.content[slot.index] = slot.original;
      requestImages += 1;
      requestChars += String(slot.original.image_url?.url ?? '').length;
      this.selectedSlots.add(slot);
    };

    // Oldest unrecorded PDF first. Over-budget originals remain private and are restored when
    // records release space; neither request success nor a seen-image cap permanently drops them.
    const handled = new Set();
    for (const turn of this.turns) {
      for (const slot of turn.slots) {
        if (slot.retired || !slot.pdf) continue;
        if ([...slot.pdf.keys].every(key => slot.pdf.confirmed.has(key))) { this.retire(slot, PDF_RECORDED(slot.label)); continue; }
        const size = String(slot.original.image_url?.url ?? '').length;
        if (!handled.has(slot.pdf) && fits(size)) { keep(slot); handled.add(slot.pdf); }
        else slot.message.content[slot.index] = { type: 'text', text: handled.has(slot.pdf) ? DUPLICATE(slot.label) : PDF_PENDING(slot.label) };
      }
    }

    // Other tools retain the existing newest-first seen/request budgets.
    for (let t = this.turns.length - 1; t >= 0; t--) {
      for (let i = this.turns[t].slots.length - 1; i >= 0; i--) {
        const slot = this.turns[t].slots[i];
        if (slot.retired || slot.pdf) continue;
        const size = String(slot.original.image_url?.url ?? '').length;
        let accepted = fits(size);
        if (accepted && slot.seen) accepted = seenImages + 1 <= this.maxSeenImages && seenChars + size <= this.maxSeenChars;
        if (accepted) {
          keep(slot);
          if (slot.seen) { seenImages += 1; seenChars += size; }
        } else this.retire(slot, slot.seen ? RETIRED(slot.label) : DROPPED(slot.label));
      }
    }
  }
}
