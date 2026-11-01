import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The on-disk error log: `<dataDir>/logs/errors.log`, one JSON object per line.
 *
 * Before 3.4.0 a failed turn told the reader once, in a banner, and then the reason was gone:
 * nothing was written anywhere, so a failure that happened overnight or in a closed window left
 * only "这次回复未能完成" behind. Every failure now lands here as well as on the message itself.
 *
 * What is written is deliberately narrow: the error, where it happened (session, message, mode,
 * model, connection name) and its stack. Prompts, replies and tool output are never written, and
 * every credential-looking string is masked, so the file can be attached to a bug report as is.
 *
 * Writing must never become a second failure: every call is queued, bounded and swallowed.
 */
export const ERROR_LOG_NAME = 'errors.log';
/** One file is kept at most this large; the previous one is kept beside it as `errors.1.log`. */
export const ERROR_LOG_MAX_BYTES = 1_024 * 1_024;
const MAX_MESSAGE = 4_000;
const MAX_STACK = 6_000;

/** Bearer tokens, `sk-…` style keys and `api_key=` pairs that may appear inside upstream text. */
const SECRET_PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk|rk|pk|ak)-[A-Za-z0-9_-]{8,}/g,
  /\b((?:api[_-]?key|x-api-key|access[_-]?token|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\s)(?!\[)[^\s"',;]{6,}/gi,
];

export function redactSecrets(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) value = value.split(secret).join('[已隐藏密钥]');
  }
  value = value
    .replace(SECRET_PATTERNS[0], '$1[已隐藏]')
    .replace(SECRET_PATTERNS[1], '$1-[已隐藏]')
    .replace(SECRET_PATTERNS[2], '$1[已隐藏]');
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** The parts of a thrown value worth keeping: message, name, code, status, stack, and one cause. */
function describe(error, secrets) {
  if (error === undefined || error === null) return {};
  if (!(error instanceof Error) && typeof error !== 'object') return { message: clip(redactSecrets(error, secrets), MAX_MESSAGE) };
  const out = {};
  if (typeof error.name === 'string' && error.name !== 'Error') out.name = error.name;
  if (error.code !== undefined) out.code = String(error.code);
  if (Number.isInteger(error.status)) out.status = error.status;
  if (typeof error.stack === 'string') out.stack = clip(redactSecrets(error.stack, secrets), MAX_STACK);
  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const text = [cause.name, cause.code, cause.message].filter(Boolean).join(' ');
    if (text) out.cause = clip(redactSecrets(text, secrets), 1_000);
  }
  return out;
}

export class ErrorLog {
  constructor({ dataDir, version = '', maxBytes = ERROR_LOG_MAX_BYTES } = {}) {
    this.directory = path.join(path.resolve(dataDir), 'logs');
    this.file = path.join(this.directory, ERROR_LOG_NAME);
    this.previousFile = path.join(this.directory, 'errors.1.log');
    this.version = version;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
  }

  /**
   * Appends one entry. `message` is what the reader was shown; `error` (optional) supplies the
   * stack and code. `context` carries ids and names only — never prompt or reply text.
   * Resolves to the entry written, or null when the disk refused it.
   */
  write({ source = 'run', message, error, secrets = [], ...context } = {}) {
    const shown = message ?? (error instanceof Error ? error.message : error);
    const entry = {
      time: new Date().toISOString(),
      ...(this.version ? { version: this.version } : {}),
      source,
      ...Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, typeof value === 'string' ? clip(redactSecrets(value, secrets), 500) : value])),
      message: clip(redactSecrets(shown ?? '未知错误', secrets), MAX_MESSAGE),
      ...describe(error, secrets),
    };
    const line = `${JSON.stringify(entry)}\n`;
    const operation = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const size = await fs.stat(this.file).then(stat => stat.size, () => 0);
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        await fs.rm(this.previousFile, { force: true });
        await fs.rename(this.file, this.previousFile).catch(() => {});
      }
      await fs.appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
      return entry;
    }).catch(() => null);
    this.queue = operation;
    return operation;
  }

  /** The newest entries, newest last. A corrupt line is skipped rather than failing the read. */
  async recent(limit = 50) {
    await this.queue;
    const read = file => fs.readFile(file, 'utf8').catch(() => '');
    const lines = `${await read(this.previousFile)}${await read(this.file)}`.split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try { entries.push(JSON.parse(line)); } catch { /* A partially written line is not an entry. */ }
    }
    return entries;
  }

  flush() { return this.queue; }
}
