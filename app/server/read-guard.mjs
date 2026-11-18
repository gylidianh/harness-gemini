/**
 * Repeated-read guard (1.2.3 r4).
 *
 * Some models re-read the same scanned page again and again inside one turn, each time producing
 * and uploading a fresh image. Asking them not to is not enough, so the host enforces it: within
 * one turn (one user message, or one subagent), a read-only external skill called again on the same
 * file and the same pages is NOT executed. The model gets back the result of the first read (text
 * only, no image) with a note saying it already read this.
 *
 * Presentation-only arguments (vision, dpi, tiles, maxImages, maxChars) are ignored when comparing,
 * because changing them is exactly how a model "looks again". Exceptions:
 *  - Remote MCP tools (`mcp__*`) and MCP-backed external skills (`skill.transport === 'mcp'`) query
 *    live remote state rather than local static files and are never guarded here.
 *  - If the first read delivered no image (e.g. vision="off") and the new call asks for an image,
 *    it is allowed once.
 *  - If a subsequent read requests a higher `dpi` than any cached read of the same target (e.g.
 *    default 200 DPI followed by `dpi: 300` for small print), it is allowed and updates `maxDpi`.
 * A file that changed on disk (size or modification time) counts as a new file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const PRESENTATION = new Set(['vision', 'dpi', 'tiles', 'maxImages', 'maxChars']);
const MAX_REPLAY_CHARS = 30_000;
const DEFAULT_PDF_DPI = 200;

async function fileIdentity(workspace, value) {
  if (typeof value !== 'string' || !value) return value;
  const absolute = path.resolve(workspace, value);
  try {
    const real = await fs.realpath(absolute);
    const stat = await fs.stat(real);
    return `${real.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch { return absolute.toLowerCase(); }
}

function wantsImage(args) { return args?.vision !== 'off'; }

function isMcpBacked(skill) {
  if (!skill || typeof skill !== 'object') return false;
  if (skill.transport === 'mcp' || skill.mcp) return true;
  return typeof skill.name === 'string' && skill.name.startsWith('mcp__');
}

function effectiveDpi(skill, args) {
  if (!wantsImage(args)) return 0;
  if (args?.dpi !== undefined && args?.dpi !== null && args?.dpi !== '') {
    const parsed = Number(args.dpi);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const skillName = typeof skill?.name === 'string' ? skill.name : '';
  const targetPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (/pdf/i.test(skillName) || /\.pdf$/i.test(targetPath)) return DEFAULT_PDF_DPI;
  return 0;
}

export class ReadGuard {
  constructor() {
    this.entries = new Map();
    this.pendingDpi = new Map();
    this.blocked = 0;
  }

  async key(skill, args, workspace) {
    if (!skill?.readOnly || isMcpBacked(skill) || !args || typeof args !== 'object') return null;
    const parts = { skill: skill.name };
    for (const [name, value] of Object.entries(args).sort(([a], [b]) => a.localeCompare(b))) {
      if (PRESENTATION.has(name)) continue;
      parts[name] = (skill.pathParameters ?? []).includes(name) ? await fileIdentity(workspace, value) : value;
    }
    if (parts.pages === undefined || parts.pages === '') parts.pages = '*';
    return JSON.stringify(parts);
  }

  /** Returns a replacement output when the call must not run, otherwise { key } to record later. */
  async check(skill, args, workspace) {
    const key = await this.key(skill, args, workspace);
    if (!key) return { key: null };
    const requestedDpi = effectiveDpi(skill, args);
    const entry = this.entries.get(key);
    if (!entry) {
      this.pendingDpi.set(key, requestedDpi);
      return { key, dpi: requestedDpi };
    }
    if (!entry.hadImages && wantsImage(args) && !entry.upgraded) {
      entry.upgraded = true;
      entry.maxDpi = Math.max(entry.maxDpi ?? 0, requestedDpi);
      this.pendingDpi.set(key, requestedDpi);
      return { key, dpi: requestedDpi };
    }
    if (requestedDpi > 0 && requestedDpi > (entry.maxDpi ?? 0)) {
      entry.maxDpi = requestedDpi;
      this.pendingDpi.set(key, requestedDpi);
      return { key, dpi: requestedDpi };
    }
    entry.count += 1;
    this.blocked += 1;
    const replay = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
    return {
      key,
      output: {
        skill: skill.name,
        duplicate: true,
        readCount: entry.count,
        note: entry.count === 2
          ? '这份文件的这些页在本轮已经读过，程序没有重新读取，也不会再生成图片。下面是第一次读取的结果；请以第一次读取时你在回复中记下的内容为准，直接继续核对，不要再次读取同一文件同一页。'
          : `你已经第 ${entry.count} 次请求读取同一文件同一页，程序已拒绝重新读取。请直接使用前面已经得到的内容完成任务；若确实看不清，在回复中如实说明看不清的位置。`,
        previousResult: replay.length > MAX_REPLAY_CHARS ? replay.slice(0, MAX_REPLAY_CHARS) + '…（已截断）' : replay,
      },
    };
  }

  record(key, result, hadImages, dpi) {
    if (!key) return;
    const previous = this.entries.get(key);
    const pending = this.pendingDpi.get(key) ?? 0;
    this.pendingDpi.delete(key);
    const numericDpi = Number.isFinite(Number(dpi)) && Number(dpi) > 0 ? Number(dpi) : pending;
    const maxDpi = Math.max(previous?.maxDpi ?? 0, numericDpi);
    this.entries.set(key, {
      result,
      hadImages: Boolean(hadImages) || Boolean(previous?.hadImages),
      count: 1,
      upgraded: previous?.upgraded ?? false,
      maxDpi,
    });
  }
}
