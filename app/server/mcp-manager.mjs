import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { HSCI_READ_TOOLS, MAX_MCP_ARGS_CHARS } from './mcp-client.mjs';
import {
  MAX_SKILL_IMAGES, MAX_SKILL_IMAGE_BYTES, MAX_SKILL_IMAGE_TOTAL, normalizeParameterSchema,
} from './external-skills.mjs';
import { isHeaderName, normalizeHeaders } from './provider-extra.mjs';
import { identityCodec, isSealedSecret } from './secret.mjs';
import { isMaskedApiKey, maskApiKey } from './store.mjs';
import {
  atomicWrite, boundedString, checkAbort, HttpError, isObject, readJson, safeError, waitForChildExit, workspacePath,
} from './util.mjs';

export const MCP_TOOL_PREFIX = 'mcp__';
export const MAX_MCP_SERVERS = 32;
export const MCP_PROTOCOL_VERSION = '2025-03-26';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 16_000;
const MAX_PAGES = 100;
const MAX_TOOLS_PER_SERVER = 256;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const STDIO_IDLE_MS = 10 * 60_000;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SENSITIVE_NAME_RE = /(?:api[-_]?key|token|secret|password|passwd|auth|credential|cookie|bearer|private|pat|dsn)/i;
const SAFE_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MCP_PRESETS = Object.freeze([
  Object.freeze({
    id: 'hsciq',
    name: 'HSCIQ 海关编码与归类',
    description: '汇思海关商品编码查询、税率、申报要素、归类实例、海关总署公告、船司公告及智能归类单（Streamable HTTP）。',
    transport: 'http',
    endpoint: 'https://www.hsciq.com/mcp/rpc',
    authType: 'x-api-key',
    authHeader: 'X-API-Key',
    stateless: true,
    readOnly: false,
    preset: 'hsciq',
  }),
]);

export function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX);
}

export function sanitizeMcpSlug(value, fallback = 'server') {
  const ascii = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii) return ascii.slice(0, 22).replace(/_+$/g, '') || fallback;
  const hash = createHash('sha1').update(String(value ?? fallback)).digest('hex').slice(0, 8);
  return `${fallback}_${hash}`;
}

function buildExposedToolName(serverSlug, remoteToolName, taken) {
  const cleanTool = String(remoteToolName ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
  const base = `${MCP_TOOL_PREFIX}${serverSlug}__${cleanTool}`;
  if (base.length <= 64 && SAFE_TOOL_NAME_RE.test(base) && !taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const seed = attempt === 0 ? `${serverSlug}::${remoteToolName}` : `${serverSlug}::${remoteToolName}::${attempt}`;
    const suffix = createHash('sha1').update(seed).digest('hex').slice(0, attempt === 0 ? 6 : 8);
    const headMax = Math.max(8, 64 - 1 - suffix.length);
    const head = base.slice(0, headMax).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+$/g, '') || `${MCP_TOOL_PREFIX}mcp`;
    const candidate = `${head}_${suffix}`.slice(0, 64);
    if (SAFE_TOOL_NAME_RE.test(candidate) && !taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${MCP_TOOL_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  taken.add(fallback);
  return fallback;
}

function supportedRasterImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function validateHsciImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 3) {
    throw new HttpError(400, 'images 必须包含 1–3 张图片。');
  }
  for (const image of images) {
    if (!isObject(image) || typeof image.fileName !== 'string' || !image.fileName || image.fileName.length > 255
      || /[\\/\0]/.test(image.fileName) || typeof image.data !== 'string' || !image.data
      || image.data.length > 1398104 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new HttpError(400, 'images 每项须含有效 fileName 和纯 base64 data。');
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString('base64') !== image.data || !supportedRasterImage(bytes)) {
      throw new HttpError(400, '每张图片须为不超过 1 MiB 的 JPG、PNG、GIF 或 WebP。');
    }
  }
}

async function encodeWorkspaceImages(workspace, imagePaths, signal) {
  if (!Array.isArray(imagePaths) || imagePaths.length < 1 || imagePaths.length > 3) {
    throw new HttpError(400, 'imagePaths 必须包含 1–3 个工作目录图片路径。');
  }
  const encoded = [];
  for (const item of imagePaths) {
    checkAbort(signal);
    if (typeof item !== 'string' || !item.trim()) throw new HttpError(400, '图片路径必须是非空字符串。');
    const target = await workspacePath(workspace, item, { allowExternal: false });
    const handle = await fs.open(target.absolute, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) {
        throw new HttpError(400, '每张图片必须为非空普通文件且不超过 1 MiB。');
      }
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new HttpError(400, '图片超过 1 MiB。');
      const slice = buffer.subarray(0, bytesRead);
      if (!supportedRasterImage(slice)) throw new HttpError(400, '仅支持 JPG、PNG、GIF 或 WebP 图片。');
      encoded.push({ fileName: path.basename(target.absolute), data: slice.toString('base64') });
    } finally {
      await handle.close();
    }
  }
  return encoded;
}

function redactSecrets(value, secrets) {
  const active = (secrets ?? []).filter(item => typeof item === 'string' && item.length >= 4);
  if (!active.length) return value;
  const scrub = text => {
    let out = text;
    for (const secret of active) out = out.split(secret).join('[REDACTED]');
    return out;
  };
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, active));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, scrub(k), {
        value: redactSecrets(v, active),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
}

function sanitizeLooseSchema(node, depth = 0) {
  if (depth > 16 || !isObject(node)) return { type: 'string' };
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
  let type = node.type;
  if (Array.isArray(type)) type = type.find(item => allowedTypes.has(item)) ?? 'string';
  if (!allowedTypes.has(type)) {
    if (isObject(node.properties)) type = 'object';
    else if (node.items !== undefined) type = 'array';
    else type = 'string';
  }
  const clean = { type };
  if (typeof node.description === 'string' && node.description.trim()) clean.description = node.description.slice(0, 1000);
  if (Array.isArray(node.enum) && node.enum.length) {
    const filtered = node.enum.filter(v => v !== null && ['string', 'number', 'boolean'].includes(typeof v));
    if (filtered.length) clean.enum = filtered.slice(0, 100);
  }
  if (type === 'object') {
    clean.properties = {};
    if (isObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties).slice(0, 120)) {
        clean.properties[key] = sanitizeLooseSchema(child, depth + 1);
      }
    }
    if (Array.isArray(node.required)) {
      const req = node.required.filter(k => typeof k === 'string' && k in clean.properties);
      if (req.length) clean.required = req;
    }
  } else if (type === 'array') {
    clean.items = isObject(node.items) ? sanitizeLooseSchema(node.items, depth + 1) : { type: 'string' };
  }
  return clean;
}

export function normalizeMcpToolSchema(rawSchema, { addHsciImagePaths = false } = {}) {
  const base = isObject(rawSchema) ? structuredClone(rawSchema) : { type: 'object', properties: {} };
  delete base.$schema;
  if (base.type === undefined) base.type = 'object';
  if (base.type === 'object' && !isObject(base.properties)) base.properties = {};
  if (addHsciImagePaths && isObject(base.properties) && 'images' in base.properties && !('imagePaths' in base.properties)) {
    base.properties.imagePaths = {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
      description: '工作目录内 1–3 张图片相对路径（自动读取并编码为 images，无需手动传 base64）。',
    };
  }
  try {
    const normalized = normalizeParameterSchema(base);
    if (isObject(normalized) && normalized.type === 'object') return normalized;
  } catch { /* Fall back to permissive sanitizer for non-strict vendor schemas. */ }
  return sanitizeLooseSchema(base, 0);
}

function normalizeEndpoint(rawEndpoint, { allowInsecureHttp = false } = {}) {
  const text = boundedString(rawEndpoint, 'MCP 地址', { max: 2048 }).trim();
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'MCP 地址必须是完整的 HTTP(S) URL。'); }
  if (url.username || url.password) throw new HttpError(400, 'MCP 地址不能在 URL 中内嵌用户名或密码，请使用认证设置或请求头。');
  if (url.hash) throw new HttpError(400, 'MCP 地址不能包含 # 片段。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp === true))) {
    throw new HttpError(400, '远程 MCP 默认仅允许 HTTPS（本机 127.0.0.1/localhost 可用 HTTP；内网自建服务可勾选允许明文 HTTP）。');
  }
  return url.href;
}

function normalizeEnvEntries(rawEnv, previousEnv = []) {
  if (rawEnv === undefined || rawEnv === null || rawEnv === '') return [];
  const prevByName = new Map((previousEnv ?? []).map(item => [item.name, item]));
  const rows = [];
  if (Array.isArray(rawEnv)) {
    for (const entry of rawEnv) {
      if (!entry) continue;
      if (typeof entry === 'string') {
        const eq = entry.indexOf('=');
        if (eq <= 0) continue;
        rows.push({ name: entry.slice(0, eq).trim(), value: entry.slice(eq + 1), secret: undefined });
      } else if (isObject(entry)) {
        const name = String(entry.name ?? entry.key ?? '').trim();
        if (!name && !String(entry.value ?? '').trim()) continue;
        rows.push({ name, value: String(entry.value ?? ''), secret: entry.secret });
      }
    }
  } else if (isObject(rawEnv)) {
    for (const [name, value] of Object.entries(rawEnv)) {
      rows.push({ name: name.trim(), value: value === undefined || value === null ? '' : String(value), secret: undefined });
    }
  } else {
    throw new HttpError(400, '环境变量必须是键值对列表或对象。');
  }

  const dedup = new Map();
  for (const row of rows) {
    if (!ENV_NAME_RE.test(row.name)) throw new HttpError(400, `环境变量名 "${row.name.slice(0, 40)}" 不合法（仅限字母、数字与下划线，且不以数字开头）。`);
    if (row.value.includes('\0') || row.value.length > 8192) throw new HttpError(400, `环境变量 ${row.name} 的值无效或超过 8192 字符。`);
    const prev = prevByName.get(row.name);
    const secret = typeof row.secret === 'boolean' ? row.secret : (prev?.secret ?? SENSITIVE_NAME_RE.test(row.name));
    let value = row.value;
    if (isMaskedApiKey(value)) {
      if (!prev?.value || value !== maskApiKey(prev.value)) {
        throw new HttpError(400, `环境变量 ${row.name} 当前为掩码，请填写完整新值或保持不改。`);
      }
      value = prev.value;
    }
    dedup.set(row.name, { name: row.name, value, secret });
  }
  if (dedup.size > 48) throw new HttpError(400, '单个 MCP 服务最多配置 48 个环境变量。');
  return [...dedup.values()];
}

function normalizeHeaderEntries(rawHeaders, previousHeaders = []) {
  if (rawHeaders === undefined || rawHeaders === null || rawHeaders === '') return [];
  const prevByLower = new Map((previousHeaders ?? []).map(item => [item.name.toLowerCase(), item]));
  const normalized = normalizeHeaders(rawHeaders, { strict: true });
  return normalized.map(row => {
    const prev = prevByLower.get(row.name.toLowerCase());
    const secret = SENSITIVE_NAME_RE.test(row.name) || prev?.secret === true;
    let value = row.value;
    if (isMaskedApiKey(value)) {
      if (!prev?.value || value !== maskApiKey(prev.value)) {
        throw new HttpError(400, `请求头 ${row.name} 当前为掩码，请填写完整新值或保持不改。`);
      }
      value = prev.value;
    }
    return { name: row.name, value, secret };
  });
}

function normalizeArgsList(rawArgs) {
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') return [];
  let list;
  if (Array.isArray(rawArgs)) {
    list = rawArgs.map(item => String(item ?? ''));
  } else if (typeof rawArgs === 'string') {
    // Support newline-separated or shell-like quoted tokens when typed in a textarea.
    const trimmed = rawArgs.trim();
    if (!trimmed) return [];
    if (trimmed.includes('\n')) {
      list = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } else {
      list = [];
      const tokenRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
      let match;
      while ((match = tokenRe.exec(trimmed)) !== null) {
        list.push(match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : (match[2] ?? match[3]));
      }
    }
  } else {
    throw new HttpError(400, '启动参数必须是字符串数组或文本。');
  }
  if (list.length > 64) throw new HttpError(400, '启动参数最多 64 项。');
  for (const item of list) {
    if (item.length > 4096 || item.includes('\0')) throw new HttpError(400, '启动参数包含非法字符或过长。');
  }
  return list;
}

function normalizeServerRecord(input, previous = null) {
  if (!isObject(input)) throw new HttpError(400, 'MCP 服务配置必须是对象。');
  const id = previous?.id ?? (typeof input.id === 'string' && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id.toLowerCase() : randomUUID());
  const name = boundedString(input.name ?? previous?.name ?? '', '服务名称', { max: 80 }).trim();
  const description = boundedString(input.description ?? previous?.description ?? '', '服务说明', { max: 500, empty: true }).trim();
  const transport = input.transport ?? previous?.transport ?? 'http';
  if (!['http', 'stdio'].includes(transport)) throw new HttpError(400, 'MCP 传输类型必须是 http 或 stdio。');
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (previous?.enabled ?? true);
  const readOnly = input.readOnly !== undefined ? Boolean(input.readOnly) : (previous?.readOnly ?? false);
  const trustReadOnlyHints = input.trustReadOnlyHints !== undefined ? Boolean(input.trustReadOnlyHints) : (previous?.trustReadOnlyHints ?? false);
  const timeoutMsRaw = input.timeoutMs !== undefined && input.timeoutMs !== '' ? Number(input.timeoutMs) : (previous?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMsRaw) || timeoutMsRaw < MIN_TIMEOUT_MS || timeoutMsRaw > MAX_TIMEOUT_MS) {
    throw new HttpError(400, `超时时间必须是 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 毫秒的整数。`);
  }
  const preset = typeof (input.preset ?? previous?.preset) === 'string' ? String(input.preset ?? previous?.preset).trim().slice(0, 40) : '';
  const disabledTools = Array.isArray(input.disabledTools)
    ? [...new Set(input.disabledTools.filter(t => typeof t === 'string' && t.length <= 256))].slice(0, 256)
    : (previous?.disabledTools ?? []);
  const readOnlyTools = Array.isArray(input.readOnlyTools)
    ? [...new Set(input.readOnlyTools.filter(t => typeof t === 'string' && t.length <= 256))].slice(0, 256)
    : (previous?.readOnlyTools ?? []);

  if (transport === 'http') {
    const allowInsecureHttp = input.allowInsecureHttp !== undefined ? Boolean(input.allowInsecureHttp) : (previous?.allowInsecureHttp ?? false);
    const endpoint = normalizeEndpoint(input.endpoint ?? input.url ?? previous?.endpoint ?? '', { allowInsecureHttp });
    const inferredHsciq = preset === 'hsciq' || /^https:\/\/(?:www\.)?hsciq\.com\/mcp\/rpc\/?$/i.test(endpoint);
    const authType = input.authType ?? previous?.authType ?? (inferredHsciq ? 'x-api-key' : 'none');
    if (!['none', 'bearer', 'x-api-key', 'custom-header'].includes(authType)) {
      throw new HttpError(400, '认证方式必须是 none、bearer、x-api-key 或 custom-header。');
    }
    const authHeader = authType === 'custom-header'
      ? boundedString(input.authHeader ?? previous?.authHeader ?? '', '自定义认证头名称', { max: 120 }).trim()
      : (authType === 'x-api-key' ? 'X-API-Key' : authType === 'bearer' ? 'Authorization' : '');
    if (authType === 'custom-header' && !isHeaderName(authHeader)) {
      throw new HttpError(400, '自定义认证头名称不是合法的 HTTP 请求头。');
    }
    let apiKeyEnv = boundedString('apiKeyEnv' in input ? (input.apiKeyEnv ?? '') : (previous?.apiKeyEnv ?? ''), '密钥环境变量名', { max: 128, empty: true }).trim();
    if (authType === 'none') apiKeyEnv = '';
    if (apiKeyEnv && !ENV_NAME_RE.test(apiKeyEnv)) {
      throw new HttpError(400, '密钥环境变量名仅允许字母、数字与下划线，且不能以数字开头。');
    }
    let apiKey = previous?.apiKey ?? '';
    if ('apiKey' in input) {
      const rawKey = boundedString(input.apiKey ?? '', 'API 密钥', { max: 8192, empty: true }).trim();
      if (/[\r\n]/.test(rawKey)) throw new HttpError(400, 'API 密钥不能包含换行。');
      if (isMaskedApiKey(rawKey)) {
        if (!previous?.apiKey || rawKey !== maskApiKey(previous.apiKey)) {
          throw new HttpError(400, '密钥框中是掩码，不是完整密钥；请粘贴完整密钥或留空保持不变。');
        }
      } else if (rawKey) {
        apiKey = rawKey;
      }
    }
    if (input.clearApiKey === true || authType === 'none') apiKey = '';
    const stateless = input.stateless !== undefined ? Boolean(input.stateless) : (previous?.stateless ?? inferredHsciq);
    const headers = normalizeHeaderEntries('headers' in input ? input.headers : previous?.headers, previous?.headers);
    return {
      id,
      name,
      description,
      transport: 'http',
      enabled,
      readOnly,
      trustReadOnlyHints,
      timeoutMs: timeoutMsRaw,
      preset: inferredHsciq ? 'hsciq' : preset,
      endpoint,
      allowInsecureHttp,
      authType,
      authHeader,
      apiKey,
      apiKeyEnv,
      stateless,
      headers,
      command: '',
      args: [],
      cwd: '',
      env: [],
      disabledTools,
      readOnlyTools,
      cachedTools: previous?.cachedTools ?? [],
      serverInfo: previous?.serverInfo ?? null,
      protocolVersion: previous?.protocolVersion ?? '',
      lastSyncAt: previous?.lastSyncAt ?? null,
      lastSyncError: previous?.lastSyncError ?? '',
    };
  }

  // transport === 'stdio'
  const command = boundedString(input.command ?? previous?.command ?? '', '启动命令', { max: 512 }).trim();
  if (/[\r\n]/.test(command)) throw new HttpError(400, '启动命令不能包含换行。');
  const args = normalizeArgsList('args' in input ? input.args : previous?.args);
  const cwd = boundedString(input.cwd ?? previous?.cwd ?? '', '工作目录', { max: 4096, empty: true }).trim();
  if (cwd && /[\r\n]/.test(cwd)) throw new HttpError(400, '工作目录不能包含换行。');
  const env = normalizeEnvEntries('env' in input ? input.env : previous?.env, previous?.env);
  return {
    id,
    name,
    description,
    transport: 'stdio',
    enabled,
    readOnly,
    trustReadOnlyHints,
    timeoutMs: timeoutMsRaw,
    preset,
    endpoint: '',
    allowInsecureHttp: false,
    authType: 'none',
    authHeader: '',
    apiKey: '',
    apiKeyEnv: '',
    stateless: false,
    headers: [],
    command,
    args,
    cwd,
    env,
    disabledTools,
    readOnlyTools,
    cachedTools: previous?.cachedTools ?? [],
    serverInfo: previous?.serverInfo ?? null,
    protocolVersion: previous?.protocolVersion ?? '',
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastSyncError: previous?.lastSyncError ?? '',
  };
}

/** Parse Claude Desktop / Cursor / VS Code / Windsurf `mcpServers` or `servers` JSON snippets. */
export function parseMcpImportJson(rawInput) {
  let parsed = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) throw new HttpError(400, '请粘贴 MCP JSON 配置内容。');
    if (trimmed.length > 256_000) throw new HttpError(400, '导入的 JSON 内容过大。');
    try { parsed = JSON.parse(trimmed); } catch { throw new HttpError(400, '导入内容不是合法的 JSON，请检查括号与引号。'); }
  }
  if (!isObject(parsed)) throw new HttpError(400, 'MCP 配置必须是 JSON 对象。');

  let entriesMap = null;
  if (isObject(parsed.mcpServers)) entriesMap = parsed.mcpServers;
  else if (isObject(parsed.servers)) entriesMap = parsed.servers;
  else if (typeof parsed.command === 'string' || typeof parsed.url === 'string' || typeof parsed.endpoint === 'string' || typeof parsed.serverUrl === 'string') {
    entriesMap = { [parsed.name || '导入的 MCP 服务']: parsed };
  } else {
    entriesMap = parsed;
  }

  const out = [];
  for (const [rawName, spec] of Object.entries(entriesMap)) {
    if (!isObject(spec)) continue;
    const name = String(spec.name ?? rawName).trim().slice(0, 80) || '未命名 MCP';
    const enabled = spec.disabled === true ? false : (spec.enabled !== undefined ? Boolean(spec.enabled) : true);
    const url = spec.url ?? spec.endpoint ?? spec.serverUrl ?? spec.httpUrl;
    if (typeof spec.command === 'string' && spec.command.trim()) {
      out.push({
        name,
        description: typeof spec.description === 'string' ? spec.description : '',
        transport: 'stdio',
        enabled,
        readOnly: spec.readOnly === true,
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args : [],
        cwd: typeof spec.cwd === 'string' ? spec.cwd : '',
        env: isObject(spec.env) ? spec.env : (Array.isArray(spec.env) ? spec.env : {}),
        ...(Number.isInteger(spec.timeout) ? { timeoutMs: spec.timeout } : Number.isInteger(spec.timeoutMs) ? { timeoutMs: spec.timeoutMs } : {}),
      });
    } else if (typeof url === 'string' && url.trim()) {
      const rawHeaders = isObject(spec.headers) ? { ...spec.headers } : {};
      let authType = spec.authType ?? 'none';
      let apiKey = typeof spec.apiKey === 'string' ? spec.apiKey : '';
      const apiKeyEnv = typeof spec.apiKeyEnv === 'string' ? spec.apiKeyEnv : '';
      for (const [hKey, hVal] of Object.entries(rawHeaders)) {
        if (typeof hVal !== 'string') continue;
        if (hKey.toLowerCase() === 'authorization' && /^bearer\s+\S+/i.test(hVal.trim()) && !apiKey) {
          authType = 'bearer';
          apiKey = hVal.trim().replace(/^bearer\s+/i, '').trim();
          delete rawHeaders[hKey];
        } else if (hKey.toLowerCase() === 'x-api-key' && hVal.trim() && !apiKey) {
          authType = 'x-api-key';
          apiKey = hVal.trim();
          delete rawHeaders[hKey];
        }
      }
      out.push({
        name,
        description: typeof spec.description === 'string' ? spec.description : '',
        transport: 'http',
        enabled,
        readOnly: spec.readOnly === true,
        endpoint: url,
        allowInsecureHttp: spec.allowInsecureHttp === true,
        authType,
        authHeader: typeof spec.authHeader === 'string' ? spec.authHeader : '',
        apiKey,
        apiKeyEnv,
        headers: rawHeaders,
        stateless: spec.stateless === true,
        ...(Number.isInteger(spec.timeout) ? { timeoutMs: spec.timeout } : Number.isInteger(spec.timeoutMs) ? { timeoutMs: spec.timeoutMs } : {}),
      });
    }
  }
  if (!out.length) throw new HttpError(400, '未识别到有效的 MCP 服务项（需包含 command 或 url/endpoint）。');
  if (out.length > MAX_MCP_SERVERS) throw new HttpError(400, `单次最多导入 ${MAX_MCP_SERVERS} 个 MCP 服务。`);
  return out;
}

/* ------------------------------------------- Windows stdio command resolver */

function isExistingFile(filePath) {
  try { return existsSync(filePath) && statSync(filePath).isFile(); }
  catch { return false; }
}

function findInPath(command, envPath, cwd) {
  const hasSep = command.includes('/') || command.includes('\\');
  const extList = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const lowerCmd = path.basename(command).toLowerCase();
  const hasKnownExt = process.platform === 'win32' && extList.some(ext => lowerCmd.endsWith(ext.toLowerCase()));
  const candidates = file => hasKnownExt
    ? [file]
    : [file, ...extList.map(ext => file + ext.toLowerCase()), ...extList.map(ext => file + ext.toUpperCase())];

  if (hasSep || path.isAbsolute(command)) {
    const abs = path.isAbsolute(command) ? path.resolve(command) : path.resolve(cwd || process.cwd(), command);
    for (const item of candidates(abs)) if (isExistingFile(item)) return item;
    return command;
  }
  const dirs = String(envPath ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const item of candidates(path.join(dir, command))) {
      if (isExistingFile(item)) return item;
    }
  }
  return command;
}

function quoteCmdArg(arg) {
  const s = String(arg ?? '');
  // Escape internal quotes and neutralize % env expansion when going through cmd.exe /d /s /c.
  const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '%%');
  return `"${escaped}"`;
}

function buildStdioSpawnSpec(command, args, env, cwd) {
  if (process.platform !== 'win32') {
    return { file: command, args, options: { shell: false, windowsHide: true } };
  }
  const resolved = findInPath(command, env.PATH ?? env.Path, cwd);
  const lower = resolved.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const dir = path.dirname(resolved);
    const base = path.basename(lower, path.extname(lower));
    const nodeExe = isExistingFile(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : null;
    if (nodeExe && base === 'npx' && isExistingFile(path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'))) {
      return { file: nodeExe, args: [path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...args], options: { shell: false, windowsHide: true } };
    }
    if (nodeExe && base === 'npm' && isExistingFile(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
      return { file: nodeExe, args: [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args], options: { shell: false, windowsHide: true } };
    }
    const comspec = process.env.ComSpec || 'cmd.exe';
    const commandLine = `"${[quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(' ')}"`;
    return { file: comspec, args: ['/d', '/s', '/c', commandLine], options: { shell: false, windowsHide: true, windowsVerbatimArguments: true } };
  }
  return { file: resolved, args, options: { shell: false, windowsHide: true } };
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('close', () => resolve());
        killer.once('error', () => { try { child.kill(); } catch {} resolve(); });
      } catch {
        try { child.kill(); } catch {}
        resolve();
      }
    });
  }
  try { child.kill('SIGTERM'); } catch {}
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 800);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/* --------------------------------------------------- Stdio Session Runtime */

const MAX_STDIO_SESSIONS_PER_SERVER = 8;

function resolveStdioCwd(server, workspace, defaultWorkspace) {
  const base = workspace || defaultWorkspace;
  if (!server?.cwd) return path.resolve(base);
  return path.isAbsolute(server.cwd) ? path.resolve(server.cwd) : path.resolve(base, server.cwd);
}

function normalizeCwdKey(dirPath) {
  const resolved = path.resolve(dirPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeRootsList(rootsOrWorkspace) {
  if (Array.isArray(rootsOrWorkspace)) {
    const seen = new Set();
    const out = [];
    for (const entry of rootsOrWorkspace) {
      let uri = '';
      let name = 'workspace';
      if (typeof entry === 'string' && entry.trim()) {
        const raw = entry.trim();
        uri = /^file:\/\//i.test(raw) ? raw : pathToFileURL(path.resolve(raw)).href;
        name = path.basename(path.resolve(raw.replace(/^file:\/\//i, ''))) || 'workspace';
      } else if (isObject(entry) && typeof entry.uri === 'string' && entry.uri.trim()) {
        uri = entry.uri.trim();
        name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 120) : 'workspace';
      }
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        out.push({ uri, name });
      }
    }
    return out;
  }
  if (typeof rootsOrWorkspace === 'string' && rootsOrWorkspace.trim()) {
    return [{ uri: pathToFileURL(path.resolve(rootsOrWorkspace)).href, name: 'workspace' }];
  }
  return [];
}

class StdioMcpSession {
  constructor(server, { defaultWorkspace, workspace, resolvedCwd, roots, version, onClose } = {}) {
    this.server = server;
    this.serverId = server.id;
    this.defaultWorkspace = defaultWorkspace;
    this.version = version;
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.child = null;
    this.pending = new Map();
    this.stderrTail = '';
    this.lineBuffer = '';
    this.bufferedBytes = 0;
    this.initialized = false;
    this.starting = null;
    this.serverInfo = null;
    this.protocolVersion = '';
    this.idleTimer = null;
    this.closed = false;
    this.currentWorkspace = workspace || defaultWorkspace;
    this.resolvedCwd = resolvedCwd || resolveStdioCwd(server, this.currentWorkspace, defaultWorkspace);
    this.roots = normalizeRootsList(roots ?? this.currentWorkspace);
    this.lastUsedAt = Date.now();
  }

  secrets() {
    return this.server.env.filter(e => e.secret && e.value).map(e => e.value);
  }

  touchIdle() {
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, STDIO_IDLE_MS);
    this.idleTimer.unref?.();
  }

  setRoots(rootsOrWorkspace) {
    if (rootsOrWorkspace === undefined || rootsOrWorkspace === null || rootsOrWorkspace === '') return false;
    if (typeof rootsOrWorkspace === 'string') this.currentWorkspace = rootsOrWorkspace;
    const nextRoots = normalizeRootsList(rootsOrWorkspace);
    if (JSON.stringify(nextRoots) === JSON.stringify(this.roots)) return false;
    this.roots = nextRoots;
    if (this.initialized && this.child && this.child.exitCode === null && this.child.stdin?.writable) {
      try {
        this._sendLine({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
      } catch { /* ignore write race */ }
    }
    return true;
  }

  async ensureStarted({ workspace, roots, timeoutMs, signal } = {}) {
    const targetCwd = resolveStdioCwd(this.server, workspace, this.defaultWorkspace);
    const cwdChanged = normalizeCwdKey(targetCwd) !== normalizeCwdKey(this.resolvedCwd);
    if (cwdChanged) {
      await this.close({ notifyManager: false });
      this.resolvedCwd = targetCwd;
    }
    if (roots !== undefined) this.setRoots(roots);
    else if (workspace) this.setRoots(workspace);

    if (!cwdChanged && this.child && this.child.exitCode === null && this.initialized) {
      this.touchIdle();
      return;
    }
    if (this.starting) {
      await this.starting;
      if (roots !== undefined) this.setRoots(roots);
      else if (workspace) this.setRoots(workspace);
      return;
    }
    this.starting = this._start({ workspace: workspace || this.currentWorkspace || this.defaultWorkspace, timeoutMs: timeoutMs ?? this.server.timeoutMs, signal })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start({ workspace, timeoutMs, signal }) {
    await this.close({ notifyManager: false });
    this.closed = false;
    checkAbort(signal);
    const cwd = this.resolvedCwd || resolveStdioCwd(this.server, workspace, this.defaultWorkspace);
    this.resolvedCwd = cwd;
    const cwdStat = await fs.stat(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new HttpError(400, `MCP 本地进程工作目录不存在或不是文件夹：${this.server.cwd || cwd}`);
    }
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (/^HARNESS_.*(?:KEY|SECRET|TOKEN)/i.test(k)) continue;
      baseEnv[k] = v;
    }
    baseEnv.PYTHONIOENCODING = 'utf-8';
    baseEnv.PYTHONUTF8 = '1';
    for (const item of this.server.env) baseEnv[item.name] = item.value;

    const spec = buildStdioSpawnSpec(this.server.command, this.server.args, baseEnv, cwd);
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        ...spec.options,
        cwd,
        env: baseEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new HttpError(502, `无法启动本地 MCP 进程（${this.server.command}）：${safeError(error)}`);
    }
    this.child = child;
    this.stderrTail = '';
    this.lineBuffer = '';
    this.bufferedBytes = 0;

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    child.stdout.on('data', chunk => {
      this.bufferedBytes += chunk.length;
      if (this.bufferedBytes > MAX_RESPONSE_BYTES) {
        this._failAll(new HttpError(502, '本地 MCP 标准输出超过 8 MiB 上限，已终止进程。'));
        void this.close();
        return;
      }
      this.lineBuffer += outDecoder.write(chunk);
      let nl;
      while ((nl = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, nl).replace(/\r$/, '').trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        this.bufferedBytes = Buffer.byteLength(this.lineBuffer, 'utf8');
        if (!line) continue;
        this._onLine(line);
      }
    });

    child.stderr.on('data', chunk => {
      const piece = errDecoder.write(chunk);
      this.stderrTail = (this.stderrTail + piece).slice(-MAX_STDERR_CHARS);
    });

    const initialRootsJson = JSON.stringify(this.roots);
    const onExit = (code, sig) => {
      if (this.child === child) {
        this.child = null;
        this.initialized = false;
      }
      const tail = redactSecrets(this.stderrTail.trim(), this.secrets()).slice(-400);
      const detail = tail ? `；stderr：${tail}` : '';
      this._failAll(new HttpError(502, `本地 MCP 进程已退出（code=${code ?? 'null'}${sig ? `, signal=${sig}` : ''}）${detail}`));
      this.onClose?.(this);
    };
    child.once('error', error => {
      if (this.child === child) { this.child = null; this.initialized = false; }
      this._failAll(new HttpError(502, `本地 MCP 进程启动失败（${this.server.command}）：${safeError(error)}`));
      this.onClose?.(this);
    });
    child.once('exit', onExit);

    try {
      const initResult = await this._rawRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'Harness Gemini', version: this.version },
      }, { timeoutMs, signal });

      this.protocolVersion = typeof initResult?.protocolVersion === 'string' ? initResult.protocolVersion : MCP_PROTOCOL_VERSION;
      this.serverInfo = isObject(initResult?.serverInfo) ? {
        name: String(initResult.serverInfo.name ?? '').slice(0, 120),
        version: String(initResult.serverInfo.version ?? '').slice(0, 60),
      } : null;
      this._sendLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.initialized = true;
      if (JSON.stringify(this.roots) !== initialRootsJson) {
        try { this._sendLine({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }); } catch {}
      }
      this.touchIdle();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  _sendLine(packet) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      throw new HttpError(502, '本地 MCP 进程未就绪或已关闭。');
    }
    this.child.stdin.write(`${JSON.stringify(packet)}\n`, 'utf8');
  }

  _onLine(line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      // Non-JSON banner lines printed by wrapper scripts before or between frames are ignored unless pending fails on timeout.
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const packet of items) this._handlePacket(packet);
  }

  _handlePacket(packet) {
    if (!isObject(packet) || packet.jsonrpc !== '2.0') return;
    // Handle server-initiated requests (e.g. ping, roots/list) so compliant MCP servers never deadlock.
    if (typeof packet.method === 'string' && Object.hasOwn(packet, 'id')) {
      try {
        if (packet.method === 'ping') {
          this._sendLine({ jsonrpc: '2.0', id: packet.id, result: {} });
        } else if (packet.method === 'roots/list') {
          const roots = this.roots.length
            ? this.roots
            : (this.currentWorkspace ? [{ uri: pathToFileURL(path.resolve(this.currentWorkspace)).href, name: 'workspace' }] : []);
          this._sendLine({ jsonrpc: '2.0', id: packet.id, result: { roots } });
        } else {
          this._sendLine({ jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'Method not supported by client' } });
        }
      } catch { /* ignore write race */ }
      return;
    }
    if (!Object.hasOwn(packet, 'id')) return; // notification
    const waiter = this.pending.get(packet.id);
    if (!waiter) return;
    this.pending.delete(packet.id);
    waiter.resolve(packet);
  }

  _failAll(error) {
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  _rawRequest(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    checkAbort(signal);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        // Cancel in-flight request notification per MCP spec; kill if stuck.
        try { this._sendLine({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } }); } catch {}
        reject(signal?.reason ?? new Error('操作已停止。'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        void this.close();
        reject(new HttpError(504, `本地 MCP 请求超时（${method}，未自动重试）。`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: packet => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (packet.error) {
            const code = Number.isInteger(packet.error.code) ? ` (${packet.error.code})` : '';
            const msg = typeof packet.error.message === 'string'
              ? `：${redactSecrets(packet.error.message, this.secrets()).slice(0, 240)}`
              : '';
            reject(new HttpError(502, `MCP JSON-RPC 错误${code}${msg}`));
            return;
          }
          if (!isObject(packet.result)) {
            reject(new HttpError(502, 'MCP 响应缺少 result 对象。'));
            return;
          }
          resolve(redactSecrets(packet.result, this.secrets()));
        },
        reject: err => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
      try {
        this._sendLine({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  async request(method, params = {}, { workspace, roots, timeoutMs, signal } = {}) {
    await this.ensureStarted({ workspace, roots, timeoutMs, signal });
    this.touchIdle();
    return this._rawRequest(method, params, { timeoutMs: timeoutMs ?? this.server.timeoutMs, signal });
  }

  async close({ notifyManager = true } = {}) {
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this._failAll(new HttpError(409, 'MCP 本地连接已关闭。'));
    if (notifyManager) this.onClose?.(this);
    if (!child) return;
    const exited = child.exitCode !== null
      ? Promise.resolve()
      : waitForChildExit(child, { drainMs: 150 }).catch(() => {});
    try { child.stdin?.end(); } catch {}
    await killProcessTree(child);
    await exited;
  }
}

/* ------------------------------------------- Streamable HTTP Session Client */

async function readHttpRpcResponse(response, id, signal, { allowEmpty = false } = {}) {
  if (allowEmpty && (response.status === 202 || response.status === 204)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type && allowEmpty) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!['application/json', 'text/event-stream'].includes(type)) {
    if (!allowEmpty) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, `MCP HTTP 响应类型无效（${type || '未知'}），期望 application/json 或 text/event-stream。`);
    }
    if (!response.body) return null;
    const probeReader = response.body.getReader();
    const probeDecoder = new TextDecoder();
    let probeText = '';
    try {
      for (;;) {
        const { value, done } = await probeReader.read();
        if (done) { probeText += probeDecoder.decode(); break; }
        probeText += probeDecoder.decode(value, { stream: true });
        if (probeText.trim()) break;
      }
    } finally {
      await probeReader.cancel().catch(() => {});
      probeReader.releaseLock();
    }
    if (!probeText.trim()) return null;
    throw new HttpError(502, `MCP HTTP 响应类型无效（${type || '未知'}），期望 application/json 或 text/event-stream。`);
  }
  if (!response.body) {
    if (allowEmpty) return null;
    throw new HttpError(502, 'MCP HTTP 响应体为空。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  const parse = raw => { try { return JSON.parse(raw); } catch { throw new HttpError(502, 'MCP 响应 JSON 解析失败。'); } };
  const unwrapSingle = packet => {
    if (!isObject(packet) || packet.jsonrpc !== '2.0' || packet.id !== id) {
      throw new HttpError(502, 'MCP 响应 JSON-RPC 版本或请求 ID 不匹配。');
    }
    if (packet.error) {
      const err = new HttpError(502, `MCP JSON-RPC 错误${Number.isInteger(packet.error.code) ? ` (${packet.error.code})` : ''}。`);
      err.rpcCode = packet.error.code;
      throw err;
    }
    if (!isObject(packet.result)) throw new HttpError(502, 'MCP 响应缺少 result 对象。');
    return packet.result;
  };
  const unwrap = (payload, { fromSse = false } = {}) => {
    if (Array.isArray(payload)) {
      if (!payload.length) {
        if (fromSse) return undefined;
        throw new HttpError(502, 'MCP 响应 JSON-RPC 批量数组为空。');
      }
      const matched = payload.find(item => isObject(item) && Object.hasOwn(item, 'id') && item.id === id);
      if (!matched) {
        if (fromSse) return undefined;
        throw new HttpError(502, 'MCP 响应 JSON-RPC 版本或请求 ID 不匹配。');
      }
      return unwrapSingle(matched);
    }
    if (fromSse) {
      if (isObject(payload) && !Object.hasOwn(payload, 'id') && typeof payload.method === 'string') return undefined;
      if (isObject(payload) && Object.hasOwn(packetOrPayload(payload), 'id') && payload.id !== id) return undefined;
    }
    return unwrapSingle(payload);
  };
  function packetOrPayload(v) { return v; }
  const frame = block => {
    let eventType = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    // Ignore non-message SSE frames such as hybrid gateway `event: endpoint` announcements.
    if (eventType !== 'message') return undefined;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return undefined;
    return unwrap(parse(data), { fromSse: true });
  };
  try {
    for (;;) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      if (done) { text += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new HttpError(502, 'MCP 响应超过 8 MiB 上限。');
      text += decoder.decode(value, { stream: true });
      if (type === 'text/event-stream') {
        text = text.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
        let end;
        while ((end = text.indexOf('\n\n')) !== -1) {
          const result = frame(text.slice(0, end));
          text = text.slice(end + 2);
          if (result !== undefined) return result;
        }
      }
    }
    if (type === 'application/json') {
      if (allowEmpty && !text.trim()) return null;
      return unwrap(parse(text));
    }
    const result = frame(text.replace(/\r/g, '\n'));
    if (result !== undefined) return result;
    if (allowEmpty) return null;
    throw new HttpError(502, 'MCP SSE 流在返回最终结果前提前结束。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class HttpMcpSession {
  constructor(server, { fetchImpl, version }) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.version = version;
    this.sessionId = '';
    this.protocolVersion = '';
    this.serverInfo = null;
    this.initialized = false;
    this.statelessDetected = server.stateless === true;
    this.initializing = null;
  }

  resolveAuthAndSecrets() {
    const secrets = [];
    let key = '';
    if (this.server.authType !== 'none') {
      if (this.server.apiKey) {
        key = this.server.apiKey;
      } else if (this.server.apiKeyEnv) {
        const envVal = process.env[this.server.apiKeyEnv];
        if (!envVal || envVal.length > 8192 || /[\r\n]/.test(envVal)) {
          throw new HttpError(400, `MCP 服务「${this.server.name}」需要有效的环境变量 ${this.server.apiKeyEnv}，或在设置中直接填写密钥。`);
        }
        key = envVal;
      } else {
        throw new HttpError(400, `MCP 服务「${this.server.name}」尚未配置认证密钥。`);
      }
      secrets.push(key);
    }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    for (const row of this.server.headers) {
      headers[row.name] = row.value;
      if (row.secret && row.value) secrets.push(row.value);
    }
    const setHeaderCaseInsensitive = (targetName, targetVal) => {
      const lower = targetName.toLowerCase();
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lower) delete headers[existing];
      }
      headers[targetName] = targetVal;
    };
    if (this.server.authType === 'bearer') setHeaderCaseInsensitive('Authorization', `Bearer ${key}`);
    else if (this.server.authType === 'x-api-key') setHeaderCaseInsensitive('X-API-Key', key);
    else if (this.server.authType === 'custom-header' && this.server.authHeader) setHeaderCaseInsensitive(this.server.authHeader, key);

    try {
      const parsed = new URL(this.server.endpoint);
      for (const [, v] of parsed.searchParams) if (v.length >= 6) secrets.push(v);
    } catch { /* validated earlier */ }
    return { headers, secrets };
  }

  async _post(body, { extraHeaders = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, allowEmpty = false } = {}) {
    checkAbort(signal);
    const { headers, secrets } = this.resolveAuthAndSecrets();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.server.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          ...headers,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      const returnedSession = response.headers.get('mcp-session-id');
      if (returnedSession && returnedSession.length <= 512 && !/[\r\n]/.test(returnedSession)) {
        this.sessionId = returnedSession;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const err = new HttpError(502, `MCP HTTP ${response.status}；请求未自动重试。`);
        err.httpStatus = response.status;
        throw err;
      }
      const result = await readHttpRpcResponse(response, body.id, controller.signal, { allowEmpty });
      return redactSecrets(result, secrets);
    } catch (error) {
      checkAbort(signal);
      if (controller.signal.aborted) throw new HttpError(504, 'MCP HTTP 请求超时，未自动重试。');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `MCP 网络连接失败：${redactSecrets(safeError(error), secrets)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async ensureInitialized({ timeoutMs, signal } = {}) {
    if (this.statelessDetected || this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const id = randomUUID();
      try {
        const result = await this._post({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'Harness Gemini', version: this.version },
          },
        }, { timeoutMs, signal });
        this.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
        this.serverInfo = isObject(result?.serverInfo) ? {
          name: String(result.serverInfo.name ?? '').slice(0, 120),
          version: String(result.serverInfo.version ?? '').slice(0, 60),
        } : null;
        this.initialized = true;
        // Best-effort initialized notification; stateless/hybrid servers may answer 202, 200, or ignore it.
        await this._post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { timeoutMs: Math.min(10_000, timeoutMs ?? DEFAULT_TIMEOUT_MS), signal, allowEmpty: true },
        ).catch(() => {});
      } catch (error) {
        // Stateless JSON-RPC MCP gateways that do not implement `initialize` return -32601/-32600 or 404/405/501.
        if (error?.rpcCode === -32601 || error?.rpcCode === -32600 || [404, 405, 501].includes(error?.httpStatus)) {
          this.statelessDetected = true;
          this.initialized = true;
          return;
        }
        throw error;
      }
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async request(method, params = {}, { timeoutMs, signal } = {}) {
    const budget = timeoutMs ?? this.server.timeoutMs;
    await this.ensureInitialized({ timeoutMs: budget, signal });
    const id = randomUUID();
    try {
      return await this._post({ jsonrpc: '2.0', id, method, params }, { timeoutMs: budget, signal });
    } catch (error) {
      // Clear expired Mcp-Session-Id on HTTP 404 so subsequent calls can re-initialize cleanly;
      // only read-only `tools/list` auto-retries immediately (`tools/call` never auto-retries).
      if (this.sessionId && error?.httpStatus === 404) {
        this.sessionId = '';
        this.protocolVersion = '';
        this.initialized = false;
        if (method === 'tools/list') {
          await this.ensureInitialized({ timeoutMs: budget, signal });
          return this._post({ jsonrpc: '2.0', id: randomUUID(), method, params }, { timeoutMs: budget, signal });
        }
      }
      throw error;
    }
  }

  async close() {
    const sessionId = this.sessionId;
    this.sessionId = '';
    this.initialized = false;
    if (sessionId) {
      // Best-effort DELETE per MCP Streamable HTTP session termination spec.
      try {
        const { headers } = this.resolveAuthAndSecrets();
        const res = await this.fetchImpl(this.server.endpoint, {
          method: 'DELETE',
          redirect: 'error',
          headers: { ...headers, 'Mcp-Session-Id': sessionId },
          signal: AbortSignal.timeout(1_500),
        });
        await res?.body?.cancel?.().catch(() => {});
      } catch { /* optional on server */ }
    }
  }
}

/* -------------------------------------------------------------- McpManager */

function serverTargetChanged(previous, next) {
  if (!previous) return false;
  if (
    previous.transport !== next.transport
    || previous.endpoint !== next.endpoint
    || previous.command !== next.command
    || (previous.cwd ?? '') !== (next.cwd ?? '')
  ) {
    return true;
  }
  const prevArgs = previous.args ?? [];
  const nextArgs = next.args ?? [];
  if (prevArgs.length !== nextArgs.length || prevArgs.some((val, idx) => val !== nextArgs[idx])) {
    return true;
  }
  const prevEnv = previous.env ?? [];
  const nextEnv = next.env ?? [];
  if (prevEnv.length !== nextEnv.length || prevEnv.some((item, idx) => item.name !== nextEnv[idx]?.name || item.value !== nextEnv[idx]?.value)) {
    return true;
  }
  return false;
}

export class McpManager {
  constructor({ dataDir, defaultWorkspace, secrets = identityCodec, fetchImpl = globalThis.fetch, version = '2.0.2' }) {
    this.dataDir = dataDir;
    this.defaultWorkspace = defaultWorkspace;
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
    this.version = version;
    this.file = path.join(dataDir, 'mcp-servers.json');
    this.servers = [];
    this.sessions = new Map();
    this.toolIndex = new Map();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    const raw = await readJson(this.file, { schemaVersion: 1, servers: [] });
    const list = Array.isArray(raw?.servers) ? raw.servers : [];
    const loaded = [];
    let needsResave = false;
    for (const entry of list.slice(0, MAX_MCP_SERVERS)) {
      if (!isObject(entry)) continue;
      try {
        const copy = structuredClone(entry);
        if (copy.apiKey) {
          if (!isSealedSecret(copy.apiKey) && this.secrets.kind !== 'identity') needsResave = true;
          copy.apiKey = await this.secrets.decrypt(copy.apiKey);
        }
        if (Array.isArray(copy.headers)) {
          for (const h of copy.headers) {
            if (isObject(h) && h.secret && h.value) {
              if (!isSealedSecret(h.value) && this.secrets.kind !== 'identity') needsResave = true;
              h.value = await this.secrets.decrypt(h.value);
            }
          }
        }
        if (Array.isArray(copy.env)) {
          for (const e of copy.env) {
            if (isObject(e) && e.secret && e.value) {
              if (!isSealedSecret(e.value) && this.secrets.kind !== 'identity') needsResave = true;
              e.value = await this.secrets.decrypt(e.value);
            }
          }
        }
        loaded.push(normalizeServerRecord(copy, copy));
      } catch { /* skip corrupt record without blocking startup */ }
    }
    this.servers = loaded;
    this.rebuildToolIndex();
    if (needsResave) await this.persist().catch(() => {});
    return this;
  }

  async persist() {
    const job = async () => {
      const serialized = [];
      for (const server of this.servers) {
        const item = structuredClone(server);
        if (item.apiKey) item.apiKey = await this.secrets.encrypt(item.apiKey);
        item.headers = await Promise.all((item.headers ?? []).map(async h => ({
          ...h,
          value: h.secret && h.value ? await this.secrets.encrypt(h.value) : h.value,
        })));
        item.env = await Promise.all((item.env ?? []).map(async e => ({
          ...e,
          value: e.secret && e.value ? await this.secrets.encrypt(e.value) : e.value,
        })));
        serialized.push(item);
      }
      await atomicWrite(this.file, JSON.stringify({ schemaVersion: 1, servers: serialized }, null, 2));
    };
    this.writeQueue = this.writeQueue.then(job, job);
    return this.writeQueue;
  }

  isToolReadOnly(server, rawTool) {
    if (server.preset === 'hsciq' && server.readOnly && !HSCI_READ_TOOLS.has(rawTool.name)) return false;
    if (server.readOnly === true) return true;
    if (server.preset === 'hsciq' && HSCI_READ_TOOLS.has(rawTool.name)) return true;
    if (server.readOnlyTools?.includes(rawTool.name)) return true;
    if (server.transport === 'http' && server.trustReadOnlyHints === true && isObject(rawTool.annotations)
      && rawTool.annotations.readOnlyHint === true && rawTool.annotations.destructiveHint !== true) {
      return true;
    }
    return false;
  }

  rebuildToolIndex() {
    this.toolIndex.clear();
    const takenNames = new Set();
    const takenSlugs = new Set();
    for (const server of this.servers) {
      let baseSlug = sanitizeMcpSlug(server.name, 'mcp');
      if (takenSlugs.has(baseSlug)) {
        let i = 2;
        while (takenSlugs.has(`${baseSlug}_${i}`)) i++;
        baseSlug = `${baseSlug}_${i}`;
      }
      takenSlugs.add(baseSlug);
      server._slug = baseSlug;
      const disabled = new Set(server.disabledTools ?? []);
      const seenServerToolNames = new Set();
      const uniqueCached = (server.cachedTools ?? []).filter(rawTool => {
        if (!isObject(rawTool) || typeof rawTool.name !== 'string') return false;
        const trimmedName = rawTool.name.trim();
        if (!trimmedName || seenServerToolNames.has(trimmedName)) return false;
        if (server.preset === 'hsciq' && server.readOnly && !HSCI_READ_TOOLS.has(trimmedName)) return false;
        seenServerToolNames.add(trimmedName);
        return true;
      });
      server._resolvedTools = uniqueCached.map(rawTool => {
        const exposedName = buildExposedToolName(baseSlug, rawTool.name, takenNames);
        const readOnly = this.isToolReadOnly(server, rawTool);
        const toolEnabled = server.enabled && !disabled.has(rawTool.name);
        const addHsciImagePaths = server.preset === 'hsciq' && rawTool.name === 'create_guilei_form';
        const schema = normalizeMcpToolSchema(rawTool.inputSchema, { addHsciImagePaths });
        const resolved = {
          name: rawTool.name,
          exposedName,
          description: typeof rawTool.description === 'string' && rawTool.description.trim()
            ? rawTool.description.trim().slice(0, 1800)
            : `调用 MCP 服务「${server.name}」的工具 ${rawTool.name}`,
          readOnly,
          enabled: !disabled.has(rawTool.name),
          active: toolEnabled,
          schema,
        };
        if (toolEnabled) {
          this.toolIndex.set(exposedName, { exposedName, server, tool: resolved });
        }
        return resolved;
      });
    }
  }

  publicServer(server) {
    const tools = (server._resolvedTools ?? []).map(t => ({
      name: t.name,
      exposedName: t.exposedName,
      description: t.description,
      readOnly: t.readOnly,
      enabled: t.enabled,
    }));
    const status = !server.enabled
      ? 'disabled'
      : server.lastSyncError
        ? 'error'
        : server.lastSyncAt
          ? 'ready'
          : 'needs_sync';
    return {
      id: server.id,
      name: server.name,
      description: server.description,
      transport: server.transport,
      enabled: server.enabled,
      readOnly: server.readOnly,
      trustReadOnlyHints: server.trustReadOnlyHints,
      timeoutMs: server.timeoutMs,
      preset: server.preset,
      endpoint: server.endpoint,
      allowInsecureHttp: server.allowInsecureHttp,
      authType: server.authType,
      authHeader: server.authHeader,
      apiKey: maskApiKey(server.apiKey),
      hasApiKey: Boolean(server.apiKey),
      apiKeyEnv: server.apiKeyEnv,
      stateless: server.stateless,
      headers: (server.headers ?? []).map(h => ({
        name: h.name,
        value: h.secret ? maskApiKey(h.value) : h.value,
        secret: Boolean(h.secret),
        hasValue: Boolean(h.value),
      })),
      command: server.command,
      args: [...(server.args ?? [])],
      cwd: server.cwd,
      env: (server.env ?? []).map(e => ({
        name: e.name,
        value: e.secret ? maskApiKey(e.value) : e.value,
        secret: Boolean(e.secret),
        hasValue: Boolean(e.value),
      })),
      disabledTools: [...(server.disabledTools ?? [])],
      readOnlyTools: [...(server.readOnlyTools ?? [])],
      status,
      serverInfo: server.serverInfo,
      protocolVersion: server.protocolVersion,
      lastSyncAt: server.lastSyncAt,
      lastSyncError: server.lastSyncError,
      toolCount: tools.length,
      enabledToolCount: tools.filter(t => t.enabled).length,
      readOnlyToolCount: tools.filter(t => t.readOnly && t.enabled).length,
      tools,
    };
  }

  listPublic() {
    return {
      servers: this.servers.map(s => this.publicServer(s)),
      presets: MCP_PRESETS,
    };
  }

  tools({ readOnlyOnly = false } = {}) {
    const out = [];
    for (const { exposedName, server, tool } of this.toolIndex.values()) {
      if (readOnlyOnly && !tool.readOnly) continue;
      const transportTag = server.transport === 'stdio' ? '本地 stdio' : 'HTTP';
      out.push({
        type: 'function',
        function: {
          name: exposedName,
          description: `[MCP · ${server.name} (${transportTag}) · ${tool.name}] ${tool.description}`,
          parameters: tool.schema,
        },
      });
    }
    return out;
  }

  getTool(exposedName) {
    return this.toolIndex.get(exposedName) ?? null;
  }

  _sessionKey(server, workspace) {
    if (server.transport !== 'stdio') return `http::${server.id}`;
    const resolvedCwd = resolveStdioCwd(server, workspace, this.defaultWorkspace);
    return `stdio::${server.id}::${normalizeCwdKey(resolvedCwd)}`;
  }

  _evictOverflowStdioSessions(serverId) {
    const entries = [];
    for (const [key, session] of this.sessions.entries()) {
      if (session?.serverId === serverId && session instanceof StdioMcpSession) {
        entries.push([key, session]);
      }
    }
    if (entries.length < MAX_STDIO_SESSIONS_PER_SERVER) return;
    entries.sort((a, b) => (a[1].lastUsedAt ?? 0) - (b[1].lastUsedAt ?? 0));
    let remaining = entries.length;
    for (const [key, session] of entries) {
      if (remaining < MAX_STDIO_SESSIONS_PER_SERVER) break;
      if (session.pending.size === 0 && !session.starting) {
        this.sessions.delete(key);
        void session.close({ notifyManager: false }).catch(() => {});
        remaining--;
      }
    }
  }

  _sessionFor(server, { workspace, roots } = {}) {
    const effectiveWorkspace = workspace || this.defaultWorkspace;
    const key = this._sessionKey(server, effectiveWorkspace);
    let session = this.sessions.get(key);
    if (session && !session.closed) {
      if (session instanceof StdioMcpSession) {
        session.lastUsedAt = Date.now();
        if (roots !== undefined) session.setRoots(roots);
        else if (workspace) session.setRoots(workspace);
      }
      return session;
    }
    if (server.transport === 'stdio') {
      this._evictOverflowStdioSessions(server.id);
      const resolvedCwd = resolveStdioCwd(server, effectiveWorkspace, this.defaultWorkspace);
      session = new StdioMcpSession(server, {
        defaultWorkspace: this.defaultWorkspace,
        workspace: effectiveWorkspace,
        resolvedCwd,
        roots: roots ?? this.customRoots ?? effectiveWorkspace,
        version: this.version,
        onClose: closedSession => {
          if (this.sessions.get(key) === closedSession) this.sessions.delete(key);
        },
      });
    } else {
      session = new HttpMcpSession(server, { fetchImpl: this.fetchImpl, version: this.version });
      session.serverId = server.id;
    }
    this.sessions.set(key, session);
    return session;
  }

  setRoots(rootsOrWorkspace) {
    this.customRoots = Array.isArray(rootsOrWorkspace) ? normalizeRootsList(rootsOrWorkspace) : null;
    let notified = 0;
    for (const session of this.sessions.values()) {
      if (!(session instanceof StdioMcpSession) || session.closed) continue;
      if (Array.isArray(rootsOrWorkspace)) {
        if (session.setRoots(rootsOrWorkspace)) notified++;
      } else if (typeof rootsOrWorkspace === 'string' && rootsOrWorkspace.trim()) {
        const fixedAbsCwd = Boolean(session.server?.cwd && path.isAbsolute(session.server.cwd));
        const sameCwd = normalizeCwdKey(resolveStdioCwd(session.server, rootsOrWorkspace, this.defaultWorkspace)) === normalizeCwdKey(session.resolvedCwd);
        if ((fixedAbsCwd || sameCwd) && session.setRoots(rootsOrWorkspace)) notified++;
      }
    }
    return notified;
  }

  async _dropSession(serverId) {
    const matched = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key === serverId || session?.serverId === serverId || key.startsWith(`http::${serverId}`) || key.startsWith(`stdio::${serverId}::`)) {
        this.sessions.delete(key);
        matched.push(session);
      }
    }
    if (!matched.length) return;
    await Promise.all(matched.map(session => session.close({ notifyManager: false }).catch(() => {})));
  }

  async stopServer(serverId) {
    await this._dropSession(serverId);
  }

  async ensureReady({ workspace, roots, timeoutMs = 10_000 } = {}) {
    if (roots !== undefined) this.setRoots(roots);
    else if (workspace) this.setRoots(workspace);
    const unsynced = this.servers.filter(s => s.enabled && !s.lastSyncAt && !(s.cachedTools?.length));
    if (!unsynced.length) return;
    await Promise.all(unsynced.map(s => this.syncServer(s.id, { workspace, timeoutMs }).catch(() => {})));
  }

  async syncServer(id, { workspace, timeoutMs, signal } = {}) {
    const server = this.servers.find(s => s.id === id);
    if (!server) throw new HttpError(404, '未找到该 MCP 服务配置。');
    await this._dropSession(server.id);
    const effectiveWorkspace = workspace || this.defaultWorkspace;
    const session = this._sessionFor(server, { workspace: effectiveWorkspace });
    const budget = timeoutMs ?? Math.min(server.timeoutMs, 45_000);
    const started = Date.now();
    try {
      const discovered = [];
      const seenToolNames = new Set();
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const remaining = budget - (Date.now() - started);
        if (remaining < 200) throw new HttpError(504, 'MCP 工具列表读取超时。');
        const result = await session.request(
          'tools/list',
          cursor === undefined ? {} : { cursor },
          { workspace: effectiveWorkspace, timeoutMs: remaining, signal },
        );
        if (!Array.isArray(result?.tools)) throw new HttpError(502, 'MCP tools/list 响应缺少 tools 数组。');
        for (const item of result.tools) {
          if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim()) continue;
          const cleanName = item.name.trim().slice(0, 200);
          if (!cleanName || seenToolNames.has(cleanName)) continue;
          if (server.preset === 'hsciq' && server.readOnly && !HSCI_READ_TOOLS.has(cleanName)) continue;
          seenToolNames.add(cleanName);
          discovered.push({
            name: cleanName,
            description: typeof item.description === 'string' ? item.description.slice(0, 1800) : '',
            inputSchema: isObject(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} },
            ...(isObject(item.annotations) ? { annotations: {
              readOnlyHint: item.annotations.readOnlyHint === true,
              destructiveHint: item.annotations.destructiveHint === true,
            } } : {}),
          });
          if (discovered.length >= MAX_TOOLS_PER_SERVER) break;
        }
        if (discovered.length >= MAX_TOOLS_PER_SERVER) break;
        const next = result.nextCursor;
        if (next === undefined || next === null || next === '') break;
        if (typeof next !== 'string' || cursors.has(next)) throw new HttpError(502, 'MCP 工具分页游标无效或重复。');
        cursors.add(next);
        cursor = next;
      }
      server.cachedTools = discovered;
      server.serverInfo = session.serverInfo ?? null;
      server.protocolVersion = session.protocolVersion || '';
      server.lastSyncAt = new Date().toISOString();
      server.lastSyncError = '';
      this.rebuildToolIndex();
      await this.persist();
      if (!server.enabled) await this._dropSession(server.id);
      return { ok: true, server: this.publicServer(server), ...this.listPublic() };
    } catch (error) {
      await this._dropSession(server.id);
      const message = safeError(error);
      server.lastSyncError = message;
      this.rebuildToolIndex();
      await this.persist();
      return { ok: false, error: message, server: this.publicServer(server), ...this.listPublic() };
    }
  }

  async upsertServer(input, { id = null, sync = false } = {}) {
    const existingIndex = id ? this.servers.findIndex(s => s.id === id) : -1;
    if (id && existingIndex === -1) throw new HttpError(404, '未找到要修改的 MCP 服务。');
    if (existingIndex === -1 && this.servers.length >= MAX_MCP_SERVERS) {
      throw new HttpError(400, `最多可添加 ${MAX_MCP_SERVERS} 个 MCP 服务。`);
    }
    const previous = existingIndex >= 0 ? this.servers[existingIndex] : null;
    const next = normalizeServerRecord(input, previous);
    // Reset cached tools if transport/endpoint or stdio command/args/cwd/env changed so stale tools never linger.
    if (serverTargetChanged(previous, next)) {
      next.cachedTools = [];
      next.lastSyncAt = null;
      next.lastSyncError = '';
      next.serverInfo = null;
      next.protocolVersion = '';
    }
    await this._dropSession(next.id);
    if (existingIndex >= 0) this.servers[existingIndex] = next;
    else this.servers.push(next);
    this.rebuildToolIndex();
    await this.persist();
    if (sync) {
      const synced = await this.syncServer(next.id);
      return { ...synced, syncAttempted: true };
    }
    return { ok: true, server: this.publicServer(next), ...this.listPublic() };
  }

  async setEnabled(id, enabled, { sync = true } = {}) {
    const server = this.servers.find(s => s.id === id);
    if (!server) throw new HttpError(404, '未找到该 MCP 服务。');
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值。');
    server.enabled = enabled;
    if (!enabled) await this._dropSession(server.id);
    this.rebuildToolIndex();
    await this.persist();
    if (enabled && sync && !server.cachedTools?.length) {
      return this.syncServer(server.id);
    }
    return { ok: true, server: this.publicServer(server), ...this.listPublic() };
  }

  async removeServer(id) {
    const idx = this.servers.findIndex(s => s.id === id);
    if (idx === -1) throw new HttpError(404, '未找到该 MCP 服务。');
    const [removed] = this.servers.splice(idx, 1);
    await this._dropSession(removed.id);
    this.rebuildToolIndex();
    await this.persist();
    return { deleted: true, ...this.listPublic() };
  }

  async importConfig(rawInput, { sync = false } = {}) {
    const specs = parseMcpImportJson(rawInput);
    const prepared = [];
    const seenNames = new Set();
    let projectedCount = this.servers.length;
    for (const spec of specs) {
      const lowerName = spec.name.toLowerCase();
      const byName = this.servers.find(s => s.name.toLowerCase() === lowerName);
      if (!byName && !seenNames.has(lowerName)) {
        if (projectedCount >= MAX_MCP_SERVERS) {
          throw new HttpError(400, `MCP 服务总数不能超过 ${MAX_MCP_SERVERS} 个。`);
        }
        projectedCount++;
      }
      seenNames.add(lowerName);
      const next = normalizeServerRecord(spec, byName ?? null);
      if (serverTargetChanged(byName, next)) {
        next.cachedTools = [];
        next.lastSyncAt = null;
        next.lastSyncError = '';
        next.serverInfo = null;
        next.protocolVersion = '';
      }
      prepared.push({ lowerName, next });
    }
    const touchedIds = [];
    for (const { lowerName, next } of prepared) {
      await this._dropSession(next.id);
      const at = this.servers.findIndex(s => s.name.toLowerCase() === lowerName);
      if (at >= 0) {
        next.id = this.servers[at].id;
        this.servers[at] = next;
      } else {
        this.servers.push(next);
      }
      if (!touchedIds.includes(next.id)) touchedIds.push(next.id);
    }
    this.rebuildToolIndex();
    await this.persist();
    if (sync) {
      for (const id of touchedIds) await this.syncServer(id).catch(() => {});
    }
    return { imported: touchedIds.length, ...this.listPublic() };
  }

  async planExecution(exposedName, args, { workspace, approvalMode = 'ask' } = {}) {
    const entry = this.getTool(exposedName);
    if (!entry) throw new HttpError(404, `MCP 工具 ${String(exposedName).slice(0, 80)} 不存在或所属服务已停用。`);
    if (args !== undefined && !isObject(args)) throw new HttpError(400, 'MCP 工具参数必须是 JSON 对象。');
    const serialized = JSON.stringify(args ?? {});
    if (serialized.length > MAX_MCP_ARGS_CHARS) throw new HttpError(400, 'MCP 工具参数超过 5 MiB 上限。');

    const root = await fs.realpath(workspace);
    const { server, tool } = entry;
    if (server.preset === 'hsciq' && tool.name === 'create_guilei_form' && args?.imagePaths !== undefined) {
      if (args.images !== undefined) throw new HttpError(400, 'imagePaths 与 images 不能同时传入。');
      if (!Array.isArray(args.imagePaths) || args.imagePaths.length < 1 || args.imagePaths.length > 3) {
        throw new HttpError(400, 'imagePaths 必须包含 1–3 个工作目录图片路径。');
      }
      for (const rel of args.imagePaths) {
        if (typeof rel !== 'string') throw new HttpError(400, '图片路径必须是字符串。');
        await workspacePath(root, rel, { allowExternal: false });
      }
    }

    const access = { allowExternal: false, expectedPath: root };
    const mcpSummary = this.approvalSummary(exposedName, args);
    if (approvalMode === 'full') {
      return { requiresApproval: false, reason: '完全访问权限允许调用已启用的 MCP 工具。', access, mcpSummary };
    }
    if (approvalMode === 'smart' && tool.readOnly) {
      return { requiresApproval: false, reason: `MCP 工具「${server.name} / ${tool.name}」声明为只读，可自动运行。`, access, mcpSummary };
    }
    const reason = server.transport === 'stdio'
      ? `将通过本地进程运行 MCP 服务「${server.name}」的工具 ${tool.name}，需要批准。`
      : tool.readOnly
        ? `请求批准模式下调用 MCP 工具「${server.name} / ${tool.name}」需要确认。`
        : `MCP 工具「${server.name} / ${tool.name}」可能执行外部写入或状态变更，需要批准。`;
    return { requiresApproval: true, reason, access, mcpSummary };
  }

  approvalSummary(exposedName, args = {}) {
    const entry = this.getTool(exposedName);
    const shown = JSON.stringify(args ?? {});
    const preview = shown.length > 400 ? `${shown.slice(0, 400)}…` : shown;
    if (!entry) return `将调用 MCP 工具 ${exposedName}，参数：${preview}`;
    const transportLabel = entry.server.transport === 'stdio'
      ? `本地进程（${entry.server.command}）`
      : `远程 HTTP（${entry.server.endpoint}）`;
    return `将调用 MCP 服务「${entry.server.name}」[${transportLabel}] 的工具 ${entry.tool.name}，参数：${preview}`;
  }

  async executeTool(exposedName, args = {}, { workspace, signal } = {}) {
    checkAbort(signal);
    const entry = this.getTool(exposedName);
    if (!entry) throw new HttpError(404, `MCP 工具 ${String(exposedName).slice(0, 80)} 不存在或已停用。`);
    if (!isObject(args)) throw new HttpError(400, 'MCP 工具参数必须是对象。');
    if (JSON.stringify(args).length > MAX_MCP_ARGS_CHARS) throw new HttpError(400, 'MCP 工具参数超过 5 MiB 上限。');

    const { server, tool } = entry;
    if (server.preset === 'hsciq' && server.readOnly && !HSCI_READ_TOOLS.has(tool.name)) {
      throw new HttpError(403, '此 HSCIQ 连接处于只读模式，仅允许官方只读查询工具。');
    }

    const callArgs = { ...args };
    if (server.preset === 'hsciq' && tool.name === 'create_guilei_form') {
      if (callArgs.imagePaths !== undefined) {
        if (callArgs.images !== undefined) throw new HttpError(400, 'imagePaths 不能与 images 同时传入。');
        const imagePaths = callArgs.imagePaths;
        delete callArgs.imagePaths;
        callArgs.images = await encodeWorkspaceImages(workspace, imagePaths, signal);
      } else if (callArgs.images !== undefined) {
        validateHsciImages(callArgs.images);
      }
    }

    const started = Date.now();
    const session = this._sessionFor(server, { workspace });
    const result = await session.request(
      'tools/call',
      { name: tool.name, arguments: callArgs },
      { workspace, timeoutMs: server.timeoutMs, signal },
    );
    if (!isObject(result) || (result.content !== undefined && !Array.isArray(result.content))) {
      throw new HttpError(502, 'MCP tools/call 返回结构无效。');
    }

    // Extract MCP image blocks (`{ type: 'image', data, mimeType }`) into real visionImages for the LLM!
    const visionImages = [];
    let totalImageBytes = 0;
    const sanitizedResult = structuredClone(result);
    if (Array.isArray(sanitizedResult.content)) {
      sanitizedResult.content = sanitizedResult.content.map((block, index) => {
        if (!isObject(block) || block.type !== 'image' || typeof block.data !== 'string') return block;
        if (visionImages.length >= MAX_SKILL_IMAGES) {
          return { type: 'text', text: `[图片 #${index + 1} 已省略：单次最多传递 ${MAX_SKILL_IMAGES} 张图片]` };
        }
        try {
          const cleanB64 = block.data.replace(/\s+/g, '');
          const bytes = Buffer.from(cleanB64, 'base64');
          const mime = supportedRasterImage(bytes);
          if (mime && bytes.length > 0 && bytes.length <= MAX_SKILL_IMAGE_BYTES && totalImageBytes + bytes.length <= MAX_SKILL_IMAGE_TOTAL) {
            totalImageBytes += bytes.length;
            visionImages.push({
              dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
              label: `${server.name} / ${tool.name} #${index + 1}`,
            });
            return { type: 'text', text: `[图片 #${index + 1}（${mime}，${bytes.length} 字节）已作为真实视觉图像随本轮提供]` };
          }
        } catch { /* keep non-decodable block scrubbed */ }
        return { type: 'text', text: `[图片 #${index + 1} 无法解码或超出体积限制]` };
      });
    }

    const failed = sanitizedResult.isError === true;
    return {
      mcp: server.name,
      tool: tool.name,
      ok: !failed,
      exitCode: failed ? 1 : 0,
      elapsedMs: Date.now() - started,
      result: sanitizedResult,
      ...(visionImages.length ? { visionImages } : {}),
    };
  }

  async close() {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(active.map(session => session.close({ notifyManager: false }).catch(() => {})));
  }

  async dispose() {
    return this.close();
  }
}
