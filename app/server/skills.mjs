import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicWrite, boundedString, HttpError, isObject, readJson, requireObject } from './util.mjs';

/**
 * Reusable prompts.
 *
 * The library lives in the data directory next to settings.json, never in browser storage:
 * the desktop app picks a random local port on every launch, which resets local storage.
 */
export const MAX_SKILL_NAME = 40;
export const MAX_SKILL_TEXT = 200_000;
export const MAX_SKILLS = 200;
/** One turn may carry the user's own text plus one skill prompt. */
export const MAX_MESSAGE_CHARS = 400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_FIELDS = ['name', 'text'];

function skillId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(404, '技能不存在。');
  return value.toLowerCase();
}

function skillName(value) {
  const name = boundedString(value, '技能名称', { max: MAX_SKILL_NAME }).trim();
  if (/[\r\n]/.test(name)) throw new HttpError(400, '技能名称不能包含换行。');
  return name;
}

/** The prompt body is stored exactly as it was written; only its size is bounded. */
function skillText(value) {
  return boundedString(value, '技能说明', { max: MAX_SKILL_TEXT });
}

function requireFields(update, allowed, message) {
  requireObject(update);
  if (Object.keys(update).some(field => !allowed.includes(field))) throw new HttpError(400, message);
  return update;
}

function stamp(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * The snapshot of one skill that a sent message carries. History keeps the prompt it was sent
 * with, so editing or deleting a skill never rewrites what the model already answered.
 */
export function normalizeMessageSkill(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new HttpError(400, '提示词技能必须是 JSON 对象。');
  if (Object.keys(value).some(field => !['id', 'name', 'text'].includes(field))) throw new HttpError(400, '提示词技能仅接受 id、name 和 text。');
  return {
    id: typeof value.id === 'string' && UUID.test(value.id.trim()) ? value.id.trim().toLowerCase() : '',
    name: skillName(value.name),
    text: skillText(value.text),
  };
}

export class SkillStore {
  constructor({ dataDir }) {
    this.file = path.join(path.resolve(dataDir), 'skills.json');
    this.queue = Promise.resolve();
    this.skills = [];
  }

  async init() {
    const saved = await readJson(this.file, null);
    if (saved !== null && !isObject(saved)) throw new Error('skills.json 格式不正确；已保留原文件。');
    const list = Array.isArray(saved?.skills) ? saved.skills : [];
    // A damaged entry is dropped instead of failing the whole library.
    this.skills = list.flatMap(entry => {
      if (!isObject(entry) || typeof entry.id !== 'string' || !UUID.test(entry.id)) return [];
      if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > MAX_SKILL_NAME) return [];
      if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > MAX_SKILL_TEXT) return [];
      return [{ id: entry.id.toLowerCase(), name: entry.name, text: entry.text, createdAt: stamp(entry.createdAt), updatedAt: stamp(entry.updatedAt) }];
    }).slice(0, MAX_SKILLS);
    return this;
  }

  /** Newest first: the menu reads like a record of what was written most recently. */
  list() {
    return [...this.skills]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(skill => ({ ...skill }));
  }

  async create(update) {
    requireFields(update, SKILL_FIELDS, '新增技能仅接受 name 和 text。');
    const name = skillName(update.name);
    const text = skillText(update.text);
    if (this.skills.length >= MAX_SKILLS) throw new HttpError(400, `最多保存 ${MAX_SKILLS} 条技能，请先删除不再需要的技能。`);
    return this.write(skills => {
      if (skills.length >= MAX_SKILLS) throw new HttpError(400, `最多保存 ${MAX_SKILLS} 条技能，请先删除不再需要的技能。`);
      const now = new Date().toISOString();
      const skill = { id: randomUUID(), name, text, createdAt: now, updatedAt: now };
      return { skills: [...skills, skill], result: { ...skill } };
    });
  }

  async update(id, update) {
    const key = skillId(id);
    requireFields(update, SKILL_FIELDS, '修改技能仅接受 name 和 text。');
    const current = this.skills.find(skill => skill.id === key);
    if (!current) throw new HttpError(404, '技能不存在。');
    const name = 'name' in update ? skillName(update.name) : undefined;
    const text = 'text' in update ? skillText(update.text) : undefined;
    return this.write(skills => {
      const latest = skills.find(skill => skill.id === key);
      if (!latest) throw new HttpError(404, '技能不存在。');
      const next = { ...latest, name: name ?? latest.name, text: text ?? latest.text, updatedAt: new Date().toISOString() };
      return { skills: skills.map(skill => skill.id === key ? next : skill), result: { ...next } };
    });
  }

  async remove(id) {
    const key = skillId(id);
    if (!this.skills.some(skill => skill.id === key)) throw new HttpError(404, '技能不存在。');
    return this.write(skills => {
      if (!skills.some(skill => skill.id === key)) throw new HttpError(404, '技能不存在。');
      return { skills: skills.filter(skill => skill.id !== key), result: { deleted: true } };
    });
  }

  /**
   * Every write is serialized and atomic, so two editors can never interleave.
   * 1.3.4: the new list is computed inside the queue from the list the previous write left behind.
   * It used to be computed before queuing, from whatever list was current then, so of two saves
   * made at the same time the second silently undid the first.
   */
  write(change) {
    const operation = this.queue.then(async () => {
      const { skills: next, result } = change(this.skills);
      await atomicWrite(this.file, JSON.stringify({ schemaVersion: 1, skills: next }, null, 2));
      this.skills = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
