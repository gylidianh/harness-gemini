import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { Script, createContext } from 'node:vm';
import { atomicWrite, checkAbort, HttpError, inside, isObject, readJson, requireObject, waitForChildExit, workspacePath } from './util.mjs';

/**
 * External skills: user-installed scripts the model can discover and call by itself.
 *
 * A skill is one folder in the external-skills directory holding a `skill.json` manifest and the
 * script it names. Every enabled skill is offered to the model as its own function tool called
 * `ext_<name>`, with the manifest's description and parameter schema, so the model knows when it
 * is useful and what to pass. The directory is re-read before every model round: a skill the user
 * (or the model) just wrote is callable on the very next round, without a restart.
 *
 * A call runs the script once. Its arguments arrive as JSON on standard input; whatever it prints
 * on standard output is the result (JSON is parsed, anything else is returned as text). The
 * working directory is the session's own workspace, so relative paths the model passes resolve
 * exactly as they do for read_file.
 *
 * Running a script is running code, so it is governed like run_command: full access runs it
 * directly; smart approval runs it without asking only when its manifest declares `readOnly` and
 * no path argument leaves the workspace; ask mode always asks. Chat mode, which is read-only,
 * is offered only the skills that declare `readOnly`.
 */

export const EXTERNAL_TOOL_PREFIX = 'ext_';
export const MANIFEST_NAME = 'skill.json';
export const MAX_EXTERNAL_SKILLS = 64;
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_DESCRIPTION = 2_000;
const MAX_SCHEMA_CHARS = 16_000;
const MAX_SCHEMA_DEPTH = 64;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_SINGLE_KEYS = new Set([
  'additionalProperties', 'additionalItems', 'contains', 'propertyNames', 'not',
  'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema',
]);
const MAX_ARGS_CHARS = 200_000;
const MAX_STDOUT_BYTES = 400_000;
const MAX_STDERR_BYTES = 32_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
// 1.2.3-skill-images: images a skill hands to the model. The bytes never travel through stdout (which is
// capped at 400 KB); the skill writes files into the workspace and lists them in `images`.
export const MAX_SKILL_IMAGES = 6;
export const MAX_SKILL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_IMAGE_TOTAL = 15 * 1024 * 1024;
const SAMPLES_DIR = fileURLToPath(new URL('./external-skill-samples/', import.meta.url));

export function isExternalTool(name) {
  return typeof name === 'string' && name.startsWith(EXTERNAL_TOOL_PREFIX);
}

function manifestError(folder, message) {
  return { folder, error: message };
}

/**
 * Adapt JSON Schema type unions for relays that require a scalar type. Only schema-bearing
 * keywords are visited: enum/default/examples and other annotation data must remain verbatim.
 * The original schema is not modified; callers keep it for runtime argument validation.
 */
export function normalizeParameterSchema(schema) {
  const ancestors = new WeakSet();
  const normalizedNodes = new WeakMap();
  const normalizedDepths = new WeakMap();
  const referenceTargets = new Map();
  let visitsLeft = 20_000;
  const visit = (node, location, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) throw new TypeError(`Schema depth exceeds ${MAX_SCHEMA_DEPTH} at ${location}.`);
    if (--visitsLeft < 0) throw new TypeError('Parameter schema is too complex.');
    if (typeof node === 'boolean') return node;
    if (!isObject(node)) throw new TypeError(`Expected an object or boolean schema at ${location}.`);
    if (ancestors.has(node)) throw new TypeError(`Circular parameter schema at ${location}.`);
    // Reusing a JS DAG at a deeper location must not bypass the structural depth bound.
    if (normalizedNodes.has(node) && depth <= normalizedDepths.get(node)) return normalizedNodes.get(node);
    ancestors.add(node);
    try {
      // Reject malformed supported keywords at load time; never reinterpret them as no constraint.
      if (node.type !== undefined && !Array.isArray(node.type) && !SCHEMA_TYPES.has(node.type)) throw new TypeError(`Invalid type at ${location}.type.`);
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => typeof key !== 'string'))) throw new TypeError(`Expected a string array at ${location}.required.`);
      if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new TypeError(`Expected a non-empty array at ${location}.enum.`);
      for (const key of SCHEMA_MAP_KEYS) {
        if (node[key] !== undefined && !isObject(node[key])) throw new TypeError(`Expected a schema map at ${location}.${key}.`);
      }
      for (const key of SCHEMA_ARRAY_KEYS) {
        if (node[key] !== undefined && (!Array.isArray(node[key]) || (key !== 'prefixItems' && !node[key].length))) throw new TypeError(`Expected a non-empty schema array at ${location}.${key}.`);
      }
      for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
        if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) throw new TypeError(`Expected a finite number at ${location}.${key}.`);
      }
      for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (node[key] !== undefined && (!Number.isInteger(node[key]) || node[key] < 0)) throw new TypeError(`Expected a non-negative integer at ${location}.${key}.`);
      }
      if (node.pattern !== undefined && (typeof node.pattern !== 'string' || !schemaRegExp(node.pattern))) throw new TypeError(`Invalid pattern at ${location}.pattern.`);
      if (isObject(node.patternProperties)) {
        for (const source of Object.keys(node.patternProperties)) {
          if (!schemaRegExp(source)) throw new TypeError(`Invalid patternProperties key at ${location}.patternProperties: ${source.slice(0, 80)}`);
        }
      }
      if (node.$ref !== undefined) {
        const target = typeof node.$ref === 'string' ? resolveSchemaRef(node.$ref, schema) : UNRESOLVED;
        if (target === UNRESOLVED || (!isObject(target) && typeof target !== 'boolean')) {
          throw new TypeError(`Unresolvable or non-schema $ref at ${location}.$ref: ${String(node.$ref).slice(0, 80)} (only local references such as #/$defs/name are supported)`);
        }
        referenceTargets.set(target, `${location}.$ref(${node.$ref})`);
      }
      const normalized = { ...node };
      if (Array.isArray(node.type)) {
        const types = node.type;
        if (!types.length || new Set(types).size !== types.length
          || Array.from(types).some(type => typeof type !== 'string' || !SCHEMA_TYPES.has(type))) {
          throw new TypeError(`Invalid type union: expected a non-empty array of unique JSON Schema types (object, array, string, number, integer, boolean, null) at ${location}.type.`);
        }
        const selected = types.find(type => type !== 'null');
        if (!selected) throw new TypeError(`Invalid type union: must contain a supported non-null type at ${location}.type.`);
        normalized.type = selected;
        // The model-facing schema must not offer a null its own type no longer allows.
        if (Array.isArray(node.enum) && node.enum.includes(null) && node.enum.some(value => value !== null)) normalized.enum = node.enum.filter(value => value !== null);
        const note = `Tool schema recommends ${selected}; scripts still accept original types: ${types.join(', ')}.`;
        normalized.description = typeof node.description === 'string' && node.description
          ? `${node.description}\n${note}` : note;
      }
      for (const [key, value] of Object.entries(node)) {
        if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) {
          normalized[key] = Object.fromEntries(Object.entries(value).map(([name, child]) =>
            [name, visit(child, `${location}.${key}[${JSON.stringify(name)}]`, depth + 1)]));
        } else if ((SCHEMA_ARRAY_KEYS.has(key) || key === 'items') && Array.isArray(value)) {
          normalized[key] = value.map((child, index) => visit(child, `${location}.${key}[${index}]`, depth + 1));
        } else if (SCHEMA_SINGLE_KEYS.has(key) || key === 'items') {
          normalized[key] = visit(value, `${location}.${key}`, depth + 1);
        } else if (key === 'dependencies') {
          if (!isObject(value)) throw new TypeError(`Expected a dependency map at ${location}.dependencies.`);
          // Draft-07 dependencies can be schemas (including booleans) or property-name arrays.
          normalized[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => {
            if (Array.isArray(child)) {
              if (child.some(item => typeof item !== 'string')) throw new TypeError(`Invalid dependency at ${location}.dependencies[${JSON.stringify(name)}].`);
              return [name, child];
            }
            return [name, visit(child, `${location}.dependencies[${JSON.stringify(name)}]`, depth + 1)];
          }));
        }
      }
      normalizedNodes.set(node, normalized);
      normalizedDepths.set(node, depth);
      return normalized;
    } finally {
      ancestors.delete(node);
    }
  };
  const normalized = visit(schema, 'parameters', 0);
  // A JSON Pointer may reach a schema outside properties/$defs (e.g. a custom container).
  // Validate those targets too, without expanding a recursive $ref graph or visiting annotations
  // that are not used as schemas. Newly discovered reference targets are included by Map's iterator.
  for (const [target, location] of referenceTargets) {
    if (isObject(target) && !normalizedNodes.has(target)) visit(target, location, 0);
  }
  return normalized;
}

/** Validate one manifest. Every problem is reported in words, never thrown at the run. */
export function normalizeManifest(raw, folder) {
  if (!isObject(raw)) return manifestError(folder, 'skill.json 必须是 JSON 对象。');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME.test(name)) return manifestError(folder, 'name 必须是 2–40 个小写字母、数字或下划线，并以字母开头。');
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) return manifestError(folder, 'description 不能为空：模型靠它判断什么时候调用。');
  if (description.length > MAX_DESCRIPTION) return manifestError(folder, `description 不能超过 ${MAX_DESCRIPTION} 个字符。`);
  let command = raw.command;
  if (typeof command === 'string') command = [command];
  if (!Array.isArray(command) || !command.length || command.length > 32
    || command.some(token => typeof token !== 'string' || !token || token.length > 1_024 || token.includes('\0'))) {
    return manifestError(folder, 'command 必须是非空字符串数组，例如 ["read_pdf.py"] 或 ["node", "index.mjs"]。');
  }
  let parameters = raw.parameters ?? { type: 'object', properties: {} };
  if (!isObject(parameters) || (parameters.type ?? 'object') !== 'object') return manifestError(folder, 'parameters 必须是 type 为 object 的 JSON Schema。');
  if (parameters.properties !== undefined && !isObject(parameters.properties)) return manifestError(folder, 'parameters.properties 必须是 Schema 对象映射。');
  parameters = { ...parameters, type: 'object', properties: parameters.properties ?? {} };
  const originalParameters = parameters;
  try {
    if (JSON.stringify(parameters).length > MAX_SCHEMA_CHARS) return manifestError(folder, `parameters 不能超过 ${MAX_SCHEMA_CHARS} 个字符。`);
    if (parameters.required !== undefined && (!Array.isArray(parameters.required) || parameters.required.some(key => typeof key !== 'string'))) {
      return manifestError(folder, 'parameters.required 必须是字符串数组。');
    }
    parameters = normalizeParameterSchema(originalParameters);
  } catch (error) {
    return manifestError(folder, `parameters 无效：${error.message.slice(0, 400)}`);
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) return manifestError(folder, `timeoutMs 必须是 1000 到 ${MAX_TIMEOUT_MS} 的整数。`);
  const pathParameters = raw.pathParameters ?? [];
  if (!Array.isArray(pathParameters) || pathParameters.some(key => typeof key !== 'string')) return manifestError(folder, 'pathParameters 必须是参数名数组。');
  if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') return manifestError(folder, 'readOnly 必须是布尔值。');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return manifestError(folder, 'enabled 必须是布尔值。');
  return {
    skill: {
      name, description, command, parameters, originalParameters, timeoutMs, pathParameters,
      readOnly: raw.readOnly === true,
      manifestEnabled: raw.enabled !== false,
      folder,
    },
  };
}

/** The function tool the model sees for one skill. */
export function externalToolDefinition(skill) {
  const note = skill.readOnly ? '' : '（此技能可能修改文件，按当前权限模式审批。）';
  return {
    type: 'function',
    function: {
      name: `${EXTERNAL_TOOL_PREFIX}${skill.name}`,
      description: `[外置技能] ${skill.description}${note}`,
      parameters: skill.parameters,
    },
  };
}

export class ExternalSkillRegistry {
  constructor({ directory, dataDir }) {
    this.directory = path.resolve(directory);
    this.stateFile = path.join(path.resolve(dataDir), 'external-skills-state.json');
    this.bundledStateFile = path.join(path.resolve(dataDir), 'bundled-skill-upgrades.json');
    this.skills = new Map();
    this.errors = [];
    this.disabled = new Set();
    this.queue = Promise.resolve();
  }

  async init({ seed = false } = {}) {
    const state = await readJson(this.stateFile, null);
    if (Array.isArray(state?.disabled)) this.disabled = new Set(state.disabled.filter(name => typeof name === 'string' && NAME.test(name)));
    let exists = true;
    try { await fs.access(this.directory); } catch { exists = false; }
    await fs.mkdir(this.directory, { recursive: true });
    // The samples are written once, when the directory is first created. A user who deletes a
    // sample does not get it back on the next launch.
    if (seed && !exists) await this.installSamples().catch(() => {});
    if (seed && exists) await this.upgradeSamples();
    if (seed) await this.installIntroducedSamples();
    await this.scan();
    return this;
  }

  /** Copy the bundled samples (which may live inside app.asar) into real files on disk. */
  async installSamples() {
    const copy = async (from, to) => {
      const entries = await fs.readdir(from, { withFileTypes: true });
      await fs.mkdir(to, { recursive: true });
      for (const entry of entries) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) await copy(source, target);
        else if (entry.isFile()) {
          try { await fs.access(target); continue; } catch { /* Not there yet. */ }
          await fs.writeFile(target, await fs.readFile(source));
        }
      }
    };
    await copy(SAMPLES_DIR, this.directory);
  }

  /** Upgrade only byte-for-byte original bundled files. Keep edits, deletions and opt-outs. */
  async upgradeSamples() {
    const baseline = JSON.parse(await fs.readFile(new URL('./external-skill-baselines.json', import.meta.url), 'utf8'));
    for (const [relative, hashes] of Object.entries(baseline.hashes)) {
      const target = path.join(this.directory, ...relative.split('/'));
      let current;
      try { current = await fs.readFile(target); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const hash = createHash('sha256').update(current).digest('hex');
      if (!hashes.includes(hash)) continue;
      const replacement = await fs.readFile(path.join(SAMPLES_DIR, ...relative.split('/')));
      if (replacement.equals(current)) continue;
      try { await fs.writeFile(`${target}.before-${baseline.release}`, current, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await atomicWrite(target, replacement);
    }
  }

  /** Add a newly bundled skill once, including on existing profiles. Respect later deletions. */
  async installIntroducedSamples() {
    const metadata = JSON.parse(await fs.readFile(new URL('./external-skill-baselines.json', import.meta.url), 'utf8'));
    const state = await readJson(this.bundledStateFile, {});
    const applied = new Set(Array.isArray(state?.applied) ? state.applied.filter(item => typeof item === 'string') : []);
    let changed = false;
    for (const entry of metadata.introducedSkills ?? []) {
      if (!NAME.test(entry.name) || !Array.isArray(entry.files)
        || entry.files.some(file => typeof file !== 'string' || !file || ['.', '..'].includes(file) || path.basename(file) !== file)) {
        throw new Error('Invalid bundled skill introduction metadata');
      }
      const token = `${entry.name}@${entry.revision}`;
      if (applied.has(token)) continue;
      const target = path.join(this.directory, entry.name);
      let exists = true;
      try { await fs.lstat(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
      if (!exists) {
        const temporary = await fs.mkdtemp(path.join(this.directory, `.${entry.name}-`));
        try {
          for (const file of entry.files) {
            const data = await fs.readFile(path.join(SAMPLES_DIR, entry.name, file));
            await fs.writeFile(path.join(temporary, file), data, { flag: 'wx' });
          }
          try { await fs.rename(temporary, target); }
          catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
        } finally {
          if (!inside(this.directory, temporary)) throw new Error('Invalid bundled skill temporary path');
          await fs.rm(temporary, { recursive: true, force: true });
        }
      }
      applied.add(token);
      changed = true;
    }
    if (changed) await atomicWrite(this.bundledStateFile, JSON.stringify({ schemaVersion: 1, applied: [...applied].sort() }, null, 2));
  }

  /** Re-read every manifest. Cheap enough to run before each model round. */
  async scan() {
    const skills = new Map();
    const errors = [];
    let entries = [];
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') errors.push(manifestError('.', '无法读取外置技能目录。')); }
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skills.size >= MAX_EXTERNAL_SKILLS) { errors.push(manifestError(entry.name, `最多加载 ${MAX_EXTERNAL_SKILLS} 个外置技能。`)); break; }
      const folder = path.join(this.directory, entry.name);
      let raw;
      // 1.3.0: PowerShell 5 writes UTF-8 with a BOM; that is still valid JSON for a manifest.
      try { raw = JSON.parse((await fs.readFile(path.join(folder, MANIFEST_NAME), 'utf8')).replace(/^\uFEFF/, '')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        errors.push(manifestError(entry.name, error instanceof SyntaxError ? `skill.json 不是有效的 JSON：${error.message.slice(0, 160)}` : '无法读取 skill.json。'));
        continue;
      }
      const result = normalizeManifest(raw, folder);
      if (result.error) { errors.push({ folder: entry.name, error: result.error }); continue; }
      if (skills.has(result.skill.name)) { errors.push(manifestError(entry.name, `名称 ${result.skill.name} 与另一个技能重复，已忽略。`)); continue; }
      skills.set(result.skill.name, result.skill);
    }
    this.skills = skills;
    this.errors = errors;
    return this.list();
  }

  isEnabled(skill) { return skill.manifestEnabled && !this.disabled.has(skill.name); }

  /** The enabled skill behind one tool name, or null. */
  get(toolName) {
    if (!isExternalTool(toolName)) return null;
    const skill = this.skills.get(toolName.slice(EXTERNAL_TOOL_PREFIX.length));
    return skill && this.isEnabled(skill) ? skill : null;
  }

  /** Function tools for one request; chat mode is offered only read-only skills. */
  tools({ readOnlyOnly = false } = {}) {
    return [...this.skills.values()]
      .filter(skill => this.isEnabled(skill) && (!readOnlyOnly || skill.readOnly))
      .map(externalToolDefinition);
  }

  list() {
    return {
      directory: this.directory,
      skills: [...this.skills.values()].map(skill => ({
        name: skill.name, tool: `${EXTERNAL_TOOL_PREFIX}${skill.name}`, description: skill.description,
        command: skill.command, readOnly: skill.readOnly, timeoutMs: skill.timeoutMs,
        folder: path.basename(skill.folder), enabled: this.isEnabled(skill), manifestEnabled: skill.manifestEnabled,
        parameters: Object.keys(skill.parameters.properties ?? {}),
      })),
      errors: this.errors.map(item => ({ folder: typeof item.folder === 'string' ? path.basename(item.folder) : '.', error: item.error })),
    };
  }

  async setEnabled(name, enabled) {
    if (typeof name !== 'string' || !NAME.test(name)) throw new HttpError(404, '外置技能不存在。');
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值。');
    await this.scan();
    if (!this.skills.has(name)) throw new HttpError(404, '外置技能不存在。');
    // 1.3.0: the new set is computed inside the queue, so two toggles at once both survive.
    const operation = this.queue.then(async () => {
      const next = new Set(this.disabled);
      if (enabled) next.delete(name); else next.add(name);
      await atomicWrite(this.stateFile, JSON.stringify({ schemaVersion: 1, disabled: [...next].sort() }, null, 2));
      this.disabled = next;
    });
    this.queue = operation.catch(() => {});
    await operation;
    return this.list();
  }
}

// A visit budget cannot interrupt a single pathological native RegExp.test(). A fixed VM script
// invokes our own synchronous validator under V8's wall-clock timeout (including native regexp
// backtracking). No schema or argument text is ever evaluated as JavaScript. This is a time guard,
// not an untrusted-code sandbox. A fresh context prevents an interrupted call retaining state.
const SCHEMA_TIMEOUT_MS = 2_000;
const SCHEMA_RUNNER = new Script('validate()', { filename: 'external-skill-schema-check' });

/** The light schema check a model call must pass before anything is spawned. */
export function validateExternalArgs(skill, args) {
  try {
    SCHEMA_RUNNER.runInContext(createContext({ validate: () => validateExternalSchema(skill, args) }), { timeout: SCHEMA_TIMEOUT_MS });
  } catch (error) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new HttpError(400, '外置技能参数说明校验超时，已拒绝调用。');
    throw error;
  }
}

function validateExternalSchema(skill, args) {
  requireObject(args);
  // Count and bound the actual JSON tree before recursion. Also rejects cyclic / non-JSON callers
  // with a controlled 400, rather than letting JSON.stringify throw or a counting loop run forever.
  const { nodes, keyCounts } = jsonNodeCount(args);
  const parameters = skill.originalParameters ?? skill.parameters;
  const context = {
    root: parameters, budget: { left: SCHEMA_VISIT_BUDGET + 32 * nodes },
    active: new Map(), memo: new WeakMap(), cycleSerial: 0, keyCounts, stringLengths: new Map(),
  };
  // One walk of the real root applies root enum/const as well as properties, required and the
  // combinators. Do not synthesize a partial root: it can omit constraints or duplicate work.
  const problem = schemaProblem(parameters, args, '参数整体', context, 0);
  if (problem) {
    // fix3: root problems keep the wording earlier releases used (缺少参数 x / 不接受参数 x / 参数 x ...).
    const rooted = typeof problem === 'string'
      ? problem.replace(/^参数整体\.([^\s.\[]+) 缺失$/, '缺少参数 $1').replace(/^参数整体 不接受 /, '不接受参数 ').replace(/^参数整体(?=[.\[])\.?/, '参数 ')
      : problem;
    const detail = problem === SCHEMA_CYCLE ? '参数说明含有无法确定匹配结果的循环 $ref' : rooted;
    throw new HttpError(400, /^(?:缺少|不接受)参数 /.test(detail) ? `外置技能 ${skill.name} ${detail}。` : `外置技能 ${skill.name} 的${detail}。`);
  }
}

/** Bounded iterative JSON preflight. Count every occurrence (not just distinct JS identities). */
function jsonNodeCount(value) {
  let count = 0;
  let chars = 0;
  const keyCounts = new WeakMap();
  const active = new WeakSet();
  const stack = [{ value, depth: 0 }];
  const tooLarge = () => { throw new HttpError(400, `外置技能参数不能超过 ${MAX_ARGS_CHARS} 个字符。`); };
  while (stack.length) {
    const frame = stack.pop();
    const item = frame.value;
    if (frame.exit) { active.delete(item); continue; }
    if (frame.depth > MAX_VALIDATION_DEPTH) throw new HttpError(400, '外置技能参数嵌套层级过深，无法校验。');
    if (++count > MAX_ARGS_CHARS) tooLarge();
    if (item !== null && typeof item === 'object') {
      if (active.has(item)) throw new HttpError(400, '外置技能参数不能含有循环引用。');
      const array = Array.isArray(item);
      if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new HttpError(400, '外置技能参数必须是普通 JSON 数据。');
      const keys = array ? null : Object.keys(item);
      const length = array ? item.length : keys.length;
      if (keys) keyCounts.set(item, keys.length);
      if (length > MAX_ARGS_CHARS) tooLarge();
      chars += 2 + Math.max(0, length - 1); // brackets/braces and commas
      if (keys) for (const key of keys) {
        if (key.length > MAX_ARGS_CHARS) tooLarge();
        chars += JSON.stringify(key).length + 1; // key and colon
        if (chars > MAX_ARGS_CHARS) tooLarge();
      }
      active.add(item);
      stack.push({ value: item, exit: true });
      for (let i = length - 1; i >= 0; i--) stack.push({ value: item[array ? i : keys[i]], depth: frame.depth + 1 });
    } else {
      const type = typeof item;
      if (item !== null && type !== 'string' && type !== 'boolean' && (type !== 'number' || !Number.isFinite(item))) throw new HttpError(400, '外置技能参数必须是有效 JSON 数据。');
      if (type === 'string' && item.length > MAX_ARGS_CHARS) tooLarge();
      chars += JSON.stringify(item).length;
    }
    if (chars > MAX_ARGS_CHARS) tooLarge();
  }
  return { nodes: count, keyCounts };
}

/**
 * Supported subset: types, enum/const, numeric and length bounds, pattern, items, required,
 * additionalProperties/patternProperties, allOf/anyOf/oneOf and local $ref (with siblings).
 * Unknown keywords remain the script's responsibility; this is not a full JSON Schema engine.
 *
 * Resource exhaustion is an exception, never an ordinary "branch did not match": otherwise a
 * oneOf can accept after a second matching branch hits a limit. Non-consuming reference cycles
 * are UNKNOWN, not false; anyOf may still prove a match, but oneOf cannot count UNKNOWN as false.
 * Completed schema/value results are memoized by depth so shared DAGs do not expand exponentially.
 */
const SCHEMA_VISIT_BUDGET = 20_000;
const MAX_VALIDATION_DEPTH = 512;
const SCHEMA_CYCLE = Symbol('uncheckable cyclic schema');
const typeOfValue = value => Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
function sameJson(left, right, context, location) {
  spendSchemaBudget(context, location);
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((item, index) => sameJson(item, right[index], context, location));
  const keys = Object.keys(left);
  return keys.length === context.keyCounts.get(right) && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key], context, location));
}
const regexCache = new Map();

/** A schema pattern compiled the way JSON Schema means it; a pattern that is not valid either way is null. */
function schemaRegExp(source) {
  if (regexCache.has(source)) return regexCache.get(source);
  let compiled = null;
  // 1.3.3: many real patterns (for example ^[\w-.]+$) are valid ECMAScript but not valid with the
  // 'u' flag; they used to be skipped silently, so the constraint was never applied.
  try { compiled = new RegExp(source, 'u'); } catch { try { compiled = new RegExp(source); } catch { compiled = null; } }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(source, compiled);
  return compiled;
}

function patternSchemas(schema) {
  if (!isObject(schema?.patternProperties)) return [];
  return Object.entries(schema.patternProperties).map(([source, child]) => {
    const pattern = schemaRegExp(source);
    if (!pattern) throw new HttpError(400, '外置技能参数说明含有无效 patternProperties。');
    return { pattern, schema: child };
  });
}

const UNRESOLVED = Symbol('unresolved');
/** Local URI-fragment JSON Pointers only. '#/' names the empty property, not the root. */
function resolveSchemaRef(ref, rootSchema) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return UNRESOLVED;
  let pointer;
  try { pointer = decodeURIComponent(ref.slice(1)); } catch { return UNRESOLVED; }
  if (!pointer) return rootSchema;
  if (!pointer.startsWith('/')) return UNRESOLVED;
  let current = rootSchema;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(raw)) return UNRESOLVED;
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return UNRESOLVED;
    current = current[part];
  }
  return current;
}

function spendSchemaBudget(context, location, amount = 1) {
  context.budget.left -= amount;
  if (context.budget.left < 0) throw new HttpError(400, `${location} 的参数说明结构过于复杂，无法校验。`);
}

function schemaProblem(schema, value, location, context, depth) {
  // Untrusted property names must not grow diagnostic strings without bound on a deep path.
  if (location.length > 600) location = `${location.slice(0, 160)}…${location.slice(-400)}`;
  // Fatal limits must escape every combinator; never let oneOf mistake them for non-matches.
  if (depth > MAX_VALIDATION_DEPTH) throw new HttpError(400, `${location} 嵌套层级过深，无法校验。`);
  spendSchemaBudget(context, location);
  if (schema === false) return `${location} 不被接受`;
  if (schema === true) return '';
  if (!isObject(schema)) throw new HttpError(400, `${location} 的参数说明不是有效 Schema。`);
  const cached = context.memo.get(schema)?.get(depth);
  if (cached?.has(value)) return cached.get(value) ? '' : `${location} 不符合参数说明`;
  const active = context.active.get(schema);
  if (active?.has(value)) {
    context.cycleSerial++;
    return SCHEMA_CYCLE;
  }
  const values = active ?? new Set();
  values.add(value);
  if (!active) context.active.set(schema, values);
  const cycleSerial = context.cycleSerial;
  try {
    let problem = schemaNodeProblem(schema, value, location, context, depth);
    if (typeof problem === 'string' && problem.length > 2000) problem = `${problem.slice(0, 1999)}…`;
    // Results that encountered an active ancestor depend on this invocation's path. Caching them
    // would poison later alternatives (or turn an unresolved recursion into a definite non-match).
    if (context.cycleSerial === cycleSerial && problem !== SCHEMA_CYCLE) {
      let byDepth = context.memo.get(schema);
      if (!byDepth) context.memo.set(schema, byDepth = new Map());
      let results = byDepth.get(depth);
      if (!results) byDepth.set(depth, results = new Map());
      results.set(value, !problem);
    }
    return problem;
  } finally {
    values.delete(value);
    if (!values.size) context.active.delete(schema);
  }
}

function schemaNodeProblem(schema, value, location, context, depth) {
  if (schema.$ref !== undefined) {
    const target = resolveSchemaRef(schema.$ref, context.root);
    if (target === UNRESOLVED || (!isObject(target) && typeof target !== 'boolean')) throw new HttpError(400, `${location} 的参数说明引用了无法解析的 $ref。`);
    // Include direct self-references too. The wrapper detects re-entry into the same schema/value;
    // consuming recursion (a different child object) remains valid and is checked all the way down.
    const problem = schemaProblem(target, value, location, context, depth + 1);
    if (problem) return problem;
  }
  const actual = typeOfValue(value);
  const declared = Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : null;
  if (declared && !declared.some(type => type === actual || (type === 'number' && actual === 'integer'))) return `${location} 应为 ${declared.join(' 或 ')}`;
  if (Array.isArray(schema.enum) && !schema.enum.some(option => sameJson(option, value, context, location))) {
    return `${location} 只能是 ${schema.enum.slice(0, 12).map(option => JSON.stringify(option)).join('、')} 之一`;
  }
  if (Object.hasOwn(schema, 'const') && !sameJson(schema.const, value, context, location)) return `${location} 只能是 ${JSON.stringify(schema.const)}`;
  if (actual === 'integer' || actual === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${location} 不能小于 ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${location} 不能大于 ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return `${location} 必须大于 ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return `${location} 必须小于 ${schema.exclusiveMaximum}`;
  }
  if (actual === 'string') {
    if (Number.isInteger(schema.minLength) || Number.isInteger(schema.maxLength)) {
      let length = context.stringLengths.get(value);
      if (length === undefined) { length = [...value].length; context.stringLengths.set(value, length); }
      if (Number.isInteger(schema.minLength) && length < schema.minLength) return `${location} 至少需要 ${schema.minLength} 个字符`;
      if (Number.isInteger(schema.maxLength) && length > schema.maxLength) return `${location} 不能超过 ${schema.maxLength} 个字符`;
    }
    if (typeof schema.pattern === 'string') {
      const pattern = schemaRegExp(schema.pattern);
      if (!pattern) throw new HttpError(400, `${location} 的参数说明含有无效 pattern。`);
      if (!pattern.test(value)) return `${location} 的格式不符合要求`;
    }
  }
  if (actual === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${location} 至少需要 ${schema.minItems} 项`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${location} 不能超过 ${schema.maxItems} 项`;
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
    const tailSchema = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
    // No items constraint means no work per element. The same holds for an unconstrained tuple
    // tail: scanning it once per allOf branch can otherwise multiply a large array needlessly.
    const limit = tuple && tailSchema === undefined ? Math.min(tuple.length, value.length) : tailSchema === undefined ? 0 : value.length;
    for (let index = 0; index < limit; index++) {
      const itemSchema = tuple && index < tuple.length ? tuple[index] : tailSchema;
      const problem = schemaProblem(itemSchema, value[index], `${location}[${index}]`, context, depth + 1);
      if (problem) return problem;
    }
  }
  if (actual === 'object') {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const patterns = patternSchemas(schema);
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      spendSchemaBudget(context, location);
      if (!Object.hasOwn(value, key)) return `${location}.${key} 缺失`;
    }
    const inspectChildren = Object.keys(properties).length || patterns.length || schema.additionalProperties === false || isObject(schema.additionalProperties);
    for (const [key, child] of inspectChildren ? Object.entries(value) : []) {
      // Visits alone do not bound patternProperties work: account for each key/pattern test.
      spendSchemaBudget(context, location, Math.max(1, patterns.length));
      const known = Object.hasOwn(properties, key);
      const matching = patterns.filter(item => item.pattern.test(key));
      if (known) {
        const problem = schemaProblem(properties[key], child, `${location}.${key}`, context, depth + 1);
        if (problem) return problem;
      }
      for (const item of matching) {
        const problem = schemaProblem(item.schema, child, `${location}.${key}`, context, depth + 1);
        if (problem) return problem;
      }
      if (known || matching.length) continue;
      if (schema.additionalProperties === false) return `${location} 不接受 ${key.slice(0, 60)}`;
      if (isObject(schema.additionalProperties)) {
        const problem = schemaProblem(schema.additionalProperties, child, `${location}.${key}`, context, depth + 1);
        if (problem) return problem;
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const problem = schemaProblem(part, value, location, context, depth + 1);
      if (problem) return problem;
    }
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key])) continue;
    let first = '';
    let matches = 0;
    let uncertain = false;
    for (const part of schema[key]) {
      const problem = schemaProblem(part, value, location, context, depth + 1);
      if (problem === SCHEMA_CYCLE) { uncertain = true; continue; }
      if (!problem) {
        matches++;
        if (key === 'anyOf') break;
        if (matches > 1) return `${location} 的 oneOf 必须恰好匹配一个分支（匹配了多个）`;
      } else first ||= problem;
    }
    if (uncertain && (key === 'oneOf' || !matches)) return SCHEMA_CYCLE;
    if (!matches) return key === 'oneOf' ? `${location} 的 oneOf 必须恰好匹配一个分支（没有匹配）${first ? `：${first}` : ''}` : (first || `${location} 的 anyOf 没有匹配分支`);
  }
  return '';
}

/**
 * The paths a call names: the parameters the manifest declares as paths, plus any top-level
 * string that is an absolute path. Each is resolved against the session's workspace so a script
 * cannot be used to read outside it without the same approval read_file would need.
 */
export async function externalPathTargets(skill, args, workspace) {
  const values = new Set();
  for (const key of skill.pathParameters) if (typeof args[key] === 'string' && args[key]) values.add(args[key]);
  for (const value of Object.values(args)) if (typeof value === 'string' && value.length < 4_096 && path.isAbsolute(value)) values.add(value);
  const targets = [];
  for (const value of values) {
    if (value.includes('\0')) throw new HttpError(400, '路径不能包含空字符。');
    targets.push(await workspacePath(workspace, value, { allowExternal: true, allowMissing: true }));
  }
  return targets;
}

const NODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Turn a manifest command into an executable and arguments. A first token that names a script
 * picks its interpreter by extension; `node` always means the runtime this app ships with, so a
 * JavaScript skill works in the packaged EXE even where Node.js is not installed.
 */
export async function resolveCommand(skill, workspace) {
  const substitute = token => token.replaceAll('{skillDir}', skill.folder).replaceAll('{workspace}', workspace);
  const tokens = [];
  for (const raw of skill.command) {
    const token = substitute(raw);
    if (!path.isAbsolute(token) && !token.startsWith('-') && /[\w.-]/.test(token)) {
      const candidate = path.resolve(skill.folder, token);
      if (inside(skill.folder, candidate)) {
        try { if ((await fs.stat(candidate)).isFile()) { tokens.push(candidate); continue; } } catch { /* Not a file in the skill folder. */ }
      }
    }
    tokens.push(token);
  }
  const env = {};
  const nodeRuntime = () => {
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return process.execPath;
  };
  let [first, ...rest] = tokens;
  const extension = path.extname(first).toLowerCase();
  if (first === 'node' || first === 'node.exe') first = nodeRuntime();
  else if (NODE_EXTENSIONS.has(extension)) { rest = [first, ...rest]; first = nodeRuntime(); }
  else if (extension === '.py') { rest = [first, ...rest]; first = process.platform === 'win32' ? 'python' : 'python3'; }
  else if (extension === '.ps1') { rest = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', first, ...rest]; first = 'powershell.exe'; }
  else if (extension === '.cmd' || extension === '.bat') { rest = ['/d', '/c', first, ...rest]; first = 'cmd.exe'; }
  return { executable: first, args: rest, env };
}

/** Run one call to completion and describe what it printed. */
export async function runExternalSkill(skill, args, { workspace, signal, terminate }) {
  checkAbort(signal);
  const root = await fs.realpath(workspace);
  const { executable, args: argv, env } = await resolveCommand(skill, root);
  // 1.3.4: a stop that arrived during the two awaits above fired its abort event before any
  // listener existed, so the skill started anyway and ran until its own timeout.
  checkAbort(signal);
  let child;
  try {
    child = spawn(executable, argv, {
      cwd: root, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, ...env,
        HARNESS_WORKSPACE: root, HARNESS_SKILL_DIR: skill.folder, HARNESS_SKILL_NAME: skill.name,
        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      },
    });
  } catch (error) {
    throw new HttpError(502, `无法启动外置技能 ${skill.name}：${error.message}`);
  }
  const started = Date.now();
  const outDecoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
  let stdout = ''; let stderr = ''; let outBytes = 0; let errBytes = 0; let truncated = false; let timedOut = false; let stopping;
  const stop = () => { stopping ??= Promise.resolve(terminate ? terminate(child) : child.kill()); return stopping; };
  child.stdout.on('data', chunk => {
    const room = MAX_STDOUT_BYTES - outBytes;
    if (room > 0) stdout += outDecoder.write(chunk.subarray(0, room));
    outBytes += chunk.length;
    if (outBytes > MAX_STDOUT_BYTES) { truncated = true; void stop(); }
  });
  child.stderr.on('data', chunk => {
    const room = MAX_STDERR_BYTES - errBytes;
    if (room > 0) stderr += errDecoder.write(chunk.subarray(0, room));
    errBytes += chunk.length;
  });
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(args));
  const onAbort = () => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; void stop(); }, skill.timeoutMs); timer.unref?.();
  let exit;
  try {
    exit = await waitForChildExit(child);
    if (stopping) await stopping;
  } catch (error) {
    spawnError ??= error;
    exit = { exitCode: null, signal: null };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
  checkAbort(signal);
  stdout += outDecoder.end(); stderr += errDecoder.end();
  if (spawnError) {
    const hint = spawnError.code === 'ENOENT' ? `找不到可执行程序「${executable}」，请确认它已安装并在 PATH 中。` : spawnError.message;
    throw new HttpError(502, `无法启动外置技能 ${skill.name}：${hint}`);
  }
  const report = { skill: skill.name, exitCode: exit.exitCode, elapsedMs: Date.now() - started };
  if (timedOut) report.timedOut = true;
  if (truncated) report.truncated = true;
  const text = stdout.trim();
  let parsed;
  if (text && /^[[{]/.test(text) && !truncated) { try { parsed = JSON.parse(text); } catch { /* Plain text. */ } }
  if (parsed !== undefined) report.result = parsed; else report.output = stdout;
  if (stderr.trim() && (exit.exitCode !== 0 || timedOut || !text)) report.stderr = stderr.trim().slice(-8_000);
  if (timedOut) report.note = `外置技能运行超过 ${skill.timeoutMs} 毫秒，已停止。`;
  if (!timedOut && isObject(report.result) && report.result.images !== undefined) await attachSkillImages(report, root);
  return report;
}

/** Recognise an image by its bytes, never by its file name. */
export function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * A skill result may name image files in `images` (a path string or { path, label, page, ... }).
 * Each file must resolve, after following links, inside the session workspace, be a PNG, JPEG or
 * WebP by content, and fit the count and size limits. Accepted files are read here and attached
 * as `report.visionImages` (data URLs); the run moves them out of the tool record into an image
 * turn for the model. `result.images` is rewritten to say what was and was not delivered, so a
 * refused image is reported instead of silently missing.
 */
export async function attachSkillImages(report, root) {
  const requested = report.result.images;
  const list = Array.isArray(requested) ? requested : [requested];
  const delivered = [];
  const described = [];
  let total = 0;
  for (const [index, item] of list.entries()) {
    const entry = typeof item === 'string' ? { path: item } : isObject(item) ? item : {};
    const record = { path: typeof entry.path === 'string' ? entry.path.slice(0, 4_096) : null };
    if (typeof entry.label === 'string' && entry.label.trim()) record.label = entry.label.trim().slice(0, 300);
    for (const key of ['page', 'tile', 'tiles', 'width', 'height', 'dpi', 'encodedBytes']) if (Number.isFinite(entry[key])) record[key] = entry[key];
    for (const key of ['documentId', 'imageKey']) if (typeof entry[key] === 'string') record[key] = entry[key];
    if (typeof entry.cacheHit === 'boolean') record.cacheHit = entry.cacheHit;
    try {
      if (!record.path) throw new Error('缺少图片 path。');
      if (index >= MAX_SKILL_IMAGES) throw new Error(`单次最多交给模型 ${MAX_SKILL_IMAGES} 张图片。`);
      let real;
      try { real = await fs.realpath(path.resolve(root, record.path)); }
      catch { throw new Error('图片文件不存在。'); }
      if (!inside(root, real)) throw new Error('图片必须位于当前工作目录内。');
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new Error('图片路径不是普通文件。');
      if (stat.size > MAX_SKILL_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_SKILL_IMAGE_BYTES} 字节上限。`);
      if (total + stat.size > MAX_SKILL_IMAGE_TOTAL) throw new Error(`本次图片合计超过 ${MAX_SKILL_IMAGE_TOTAL} 字节上限。`);
      const bytes = await fs.readFile(real);
      const mime = sniffImageMime(bytes);
      if (!mime) throw new Error('只支持 PNG、JPEG、WebP 图片。');
      total += bytes.length;
      record.path = real;
      delivered.push({ ...record, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, label: record.label ?? path.basename(real), path: real });
      described.push({ ...record, mime, bytes: bytes.length, delivered: true });
    } catch (error) {
      described.push({ ...record, delivered: false, reason: String(error?.message ?? error).slice(0, 300) });
    }
  }
  report.result.images = described;
  if (delivered.length) {
    report.visionImages = delivered;
    report.imageNote = `已把 ${delivered.length} 张图片作为图片输入随本轮请求交给模型，请直接观察图像内容；result.images 列出了每张图对应的文件。`;
  }
  const refused = described.filter(image => !image.delivered).length;
  if (refused) report.imageWarning = `有 ${refused} 张图片未能交给模型，原因见 result.images[].reason。`;
  return report;
}
