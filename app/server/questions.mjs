import { randomUUID } from 'node:crypto';
import { abortError, checkAbort, HttpError, requireObject } from './util.mjs';

/** Questions are conversation input, deliberately separate from ApprovalManager. */
export function normalizeQuestionArgs(input) {
  const args = requireObject(input);
  if (Object.keys(args).some(key => !['question', 'options'].includes(key))) throw new HttpError(400, 'ask_user 只允许 question 和 options 字段。');
  if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000) throw new HttpError(400, 'ask_user.question 必须是非空文本，最多 2000 字符。');
  if (args.options !== undefined && (!Array.isArray(args.options) || args.options.length > 8 || args.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 200))) throw new HttpError(400, 'ask_user.options 必须是最多 8 项的数组，每项为非空文本且不超过 200 字符。');
  return { question: args.question, options: args.options ? [...args.options] : [] };
}

export function normalizeQuestionAnswer(answer) {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000) throw new HttpError(400, 'answer 必须是非空文本，最多 4000 字符。');
  return answer;
}

export class QuestionManager {
  constructor({ pending = new Map() } = {}) { this.pending = pending; }

  async ask({ question, options, sessionId, assistant, signal, emit, save }) {
    const input = normalizeQuestionArgs({ question, ...(options === undefined ? {} : { options }) });
    checkAbort(signal);
    const item = { id: randomUUID(), sessionId, assistantId: assistant.id, ...input, status: 'pending' };
    assistant.questions ??= [];
    assistant.questions.push(item);
    let resolve, reject;
    const waiting = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Publication can be asynchronous; an abort during publication is not an unhandled rejection.
    void waiting.catch(() => {});
    const publish = async () => { await emit({ ...item, options: [...item.options] }); await save(); };
    const entry = { item, signal, publish, resolve, reject, ready: null };
    let cancellation;
    const cancel = () => {
      if (item.status === 'pending') {
        item.status = 'cancelled';
        item.reason = 'interrupted';
        item.error = '提问已中断，请重新发送消息。';
        this.pending.delete(item.id);
        cancellation = publish().catch(() => {});
      }
      reject(abortError());
    };
    entry.cancel = cancel;
    this.pending.set(item.id, entry);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    entry.ready = publish();
    try {
      await entry.ready;
      checkAbort(signal);
      return await waiting;
    } catch (error) {
      if (item.status === 'pending') {
        item.status = 'cancelled';
        item.reason = 'interrupted';
        item.error = '提问已中断，请重新发送消息。';
        await publish().catch(() => {});
      }
      await cancellation;
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.pending.delete(item.id);
    }
  }

  async answer({ sessionId, questionId, answer }) {
    answer = normalizeQuestionAnswer(answer);
    const entry = this.pending.get(questionId);
    if (entry && entry.item.sessionId !== sessionId) throw new HttpError(404, '此会话中没有该提问。');
    if (!entry || entry.item.status !== 'pending' || entry.signal?.aborted) throw new HttpError(409, '此提问已回答或已中断，不能继续回答。');
    await entry.ready;
    // Recheck after saving pending: an answer can race a stop or another answer.
    if (this.pending.get(questionId) !== entry || entry.item.status !== 'pending' || entry.signal?.aborted) throw new HttpError(409, '此提问已回答或已中断，不能继续回答。');
    this.pending.delete(questionId);
    entry.item.status = 'done';
    entry.item.answer = answer;
    try {
      await entry.publish();
      entry.resolve({ questionId, question: entry.item.question, answer });
      return { ...entry.item, options: [...entry.item.options] };
    } catch (error) {
      entry.reject(error);
      throw error;
    }
  }
}
