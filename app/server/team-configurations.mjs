// 1.9.8: a team specification is a proposal until the user chooses each connection/model.
// Only public connection metadata crosses this boundary. Workspace and permissions never do.
import { randomUUID } from 'node:crypto';
import { checkAbort, HttpError } from './util.mjs';

export class TeamConfigurationManager {
  constructor({ timeoutMs = 10 * 60_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  list(sessionId = '') {
    return [...this.pending.values()].filter(entry => !sessionId || entry.record.sessionId === sessionId)
      .map(entry => structuredClone(entry.record));
  }

  request({ specification, sessionId, leaderProfileName = '', leaderModel = '', profiles = [], signal }) {
    checkAbort(signal);
    if (this.pending.size >= 64) throw new HttpError(429, '待配置的团队过多，请先确认或取消已有请求。');
    const createdAt = new Date().toISOString();
    const record = {
      id: randomUUID(), sessionId, name: specification.name, goal: specification.goal,
      createdAt, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      leaderProfileName, leaderModel,
      profiles: profiles.map(profile => ({ id: profile.id, name: profile.name, defaultModel: profile.agentModel || profile.chatModel || '' })),
      members: specification.members.map(member => {
        const selected = profiles.find(profile => profile.id === member.profile || profile.name === member.profile);
        return { id: member.id, name: member.name, role: member.role, task: member.task,
          profile: selected?.id ?? member.profile ?? '', model: member.model ?? '' };
      }),
    };
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        if (!this.pending.delete(record.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new HttpError(409, '本轮已停止，团队配置已取消。'));
      this.pending.set(record.id, { record, specification, finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new HttpError(408, '团队配置等待超时，未启动任何成员。请重新组队。')), this.timeoutMs);
      timer.unref?.();
      // Covers an abort between the initial check and listener registration.
      if (signal?.aborted) abort();
    });
  }

  submit(id, input, profiles = []) {
    const entry = this.pending.get(id);
    if (!entry) throw new HttpError(404, '这项团队配置已处理、已取消或已过期。');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '团队配置需要对象参数。');
    if (typeof input.sessionId !== 'string' || input.sessionId !== entry.record.sessionId) {
      throw new HttpError(403, '团队配置不属于这个会话。');
    }
    if (input.cancel === true) {
      entry.finish(new HttpError(409, '用户取消了组队，未启动任何成员。'));
      return { ok: true, cancelled: true };
    }
    if (!Array.isArray(input.members) || input.members.length !== entry.specification.members.length) {
      throw new HttpError(400, '请为每位成员确认连接与模型。');
    }
    const selections = new Map();
    for (const item of input.members) {
      if (!item || typeof item.id !== 'string' || selections.has(item.id)
          || !entry.specification.members.some(member => member.id === item.id)) {
        throw new HttpError(400, '成员编号无效或重复。');
      }
      if (typeof item.profile !== 'string' || typeof item.model !== 'string'
          || item.profile.length > 120 || item.model.length > 120) {
        throw new HttpError(400, '连接与模型必须是最多 120 字符的文本。');
      }
      const profile = item.profile.trim();
      const model = item.model.trim();
      if (profile && !profiles.some(candidate => candidate.id === profile)) {
        throw new HttpError(400, '所选连接已不存在，请刷新连接配置后重试。');
      }
      selections.set(item.id, { profile, model });
    }
    // Preserve leader-authored tasks, tool narrowing, background mode and all other fields.
    const specification = { ...entry.specification, members: entry.specification.members.map(member => ({ ...member, ...selections.get(member.id) })) };
    entry.finish(null, specification);
    return { ok: true, cancelled: false };
  }

  cancelAll() {
    for (const entry of [...this.pending.values()]) entry.finish(new HttpError(409, '服务已关闭，团队配置已取消。'));
  }
}
