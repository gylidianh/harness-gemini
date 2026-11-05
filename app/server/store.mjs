import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, isValidContextWindow } from './context.mjs';
import { atomicWrite, boundedString, HttpError, isObject, readJson, requireObject, safeError } from './util.mjs';
import { identityCodec, isSealedSecret } from './secret.mjs';
import { isReasoningLevel, storedReasoningLevel } from '../shared/reasoning-effort.mjs';
// 1.4.8: a connection's advanced options are validated here, where they are saved.
import { MAX_CONCURRENCY, MAX_RPM, PROXY_MODES, normalizeExtraBodyText, normalizeHeaders, normalizeLimit, normalizeProxyMode, normalizeProxyUrl } from './provider-extra.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRUPT_SESSION_TEXT = '这个会话文件已损坏，无法打开；可以在侧边栏直接将它删除。';
const ARTIFACT_FILE_RE = /^[a-f0-9]{36}\.(?:png|jpg|webp|gif)$/i;
const ARTIFACT_URL_GLOBAL_RE = /\/api\/artifacts\/([a-f0-9]{36}\.(?:png|jpg|webp|gif))/gi;

function extractArtifactNamesFromSession(session) {
  const out = new Set();
  if (!isObject(session) || !Array.isArray(session.messages)) return out;
  const addUrl = url => {
    if (typeof url !== 'string') return;
    const m = /^\/api\/artifacts\/([a-f0-9]{36}\.(?:png|jpg|webp|gif))(?:\?|$)/i.exec(url.trim());
    if (m && ARTIFACT_FILE_RE.test(m[1])) out.add(m[1].toLowerCase());
  };
  for (const msg of session.messages) {
    if (!isObject(msg)) continue;
    for (const art of msg.artifacts ?? []) {
      if (isObject(art)) addUrl(art.url);
    }
    for (const tool of msg.tools ?? []) {
      if (!isObject(tool)) continue;
      for (const art of tool.artifacts ?? []) {
        if (isObject(art)) addUrl(art.url);
      }
    }
    if (typeof msg.text === 'string' && msg.text.includes('/api/artifacts/')) {
      for (const m of msg.text.matchAll(ARTIFACT_URL_GLOBAL_RE)) {
        if (m[1] && ARTIFACT_FILE_RE.test(m[1])) out.add(m[1].toLowerCase());
      }
    }
  }
  return out;
}

function isSafeSessionWorkspaceDir(candidate, sessionIdKey) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  const base = path.basename(resolved).toLowerCase();
  const parent = path.basename(path.dirname(resolved)).toLowerCase();
  return base === sessionIdKey.toLowerCase() && parent === 'sessions';
}
const APPROVAL_MODES = new Set(['ask', 'smart', 'full']);
const MODEL_FIELDS = ['chatModel', 'agentModel', 'imageModel'];
/** The wire format one connection speaks. Chat Completions stays the default for old profiles. */
export const API_PROTOCOLS = ['chat', 'anthropic', 'responses'];
const PROTOCOLS = new Set(API_PROTOCOLS);
const CONNECTION_FIELDS = ['protocol', 'baseUrl', ...MODEL_FIELDS, 'contextWindow', 'reasoningEffort', 'apiKey', 'clearApiKey', 'clearKey', 'headers', 'extraBody', 'proxyMode', 'proxyUrl', 'maxConcurrency', 'maxRpm'];
const COMPLETION_FIELDS = ['completionSound', 'completionNotification'];
const COMPACTION_FIELDS = ['autoCompact', 'fileChangesEnabled'];
/**
 * Interface skins: the shipped white Gemini look, the Gemini dark look, the Claude orange look,
 * and the gilded pair 鎏金黑 (dark) and 象牙金 (light). Must match the ids in `src/skins.js`.
 */
export const UI_SKINS = ['classic', 'gemini-dark', 'claude', 'luxe-noir', 'luxe-ivory'];
const SKINS = new Set(UI_SKINS);

/**
 * 1.3.4: the settings API never hands out a saved key. It shows a mask instead (`sk-…abcd`); the
 * mark cannot occur in a real key, so a mask sent back unchanged means "keep the saved key".
 * The full key is only given to the app's own window (see Store.revealApiKey).
 */
export const API_KEY_MASK_MARK = '…';

export function maskApiKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.length <= 8) return `••••${API_KEY_MASK_MARK}`;
  return `${key.length >= 16 ? key.slice(0, 3) : ''}${API_KEY_MASK_MARK}${key.slice(-4)}`;
}

export function isMaskedApiKey(value) {
  return typeof value === 'string' && value.includes(API_KEY_MASK_MARK);
}

function profileId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, '连接 ID 必须是有效的 UUID。');
  return value.toLowerCase();
}

function connectionFields(profile) {
  const protocol = PROTOCOLS.has(profile.protocol) ? profile.protocol : 'chat';
  return {
    protocol,
    baseUrl: profile.baseUrl, chatModel: profile.chatModel, agentModel: profile.agentModel,
    imageModel: profile.imageModel, contextWindow: profile.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    // The user's choice, kept independently of the chat model. Each request checks it against
    // its own model, so a model without reasoning control still never receives the field.
    reasoningEffort: storedReasoningLevel(profile.reasoningEffort),
    // 1.4.8: the advanced options, kept per connection and applied to every request it makes.
    headers: normalizeHeaders(profile.headers),
    extraBody: normalizeExtraBodyText(profile.extraBody),
    proxyMode: normalizeProxyMode(profile.proxyMode),
    proxyUrl: normalizeProxyUrl(profile.proxyUrl),
    maxConcurrency: normalizeLimit(profile.maxConcurrency, MAX_CONCURRENCY),
    maxRpm: normalizeLimit(profile.maxRpm, MAX_RPM),
    apiKey: profile.apiKey,
  };
}

function activateProfile(settings) {
  const active = settings.profiles.find(profile => profile.id === settings.activeProfileId);
  if (!active) throw new HttpError(400, '活动连接不存在；请先选择保留的连接。');
  return { ...settings, ...connectionFields(active) };
}

function persistedSettings(settings) {
  return {
    schemaVersion: 3,
    profiles: settings.profiles.map(profile => ({ id: profile.id, name: profile.name, ...connectionFields(profile) })),
    activeProfileId: settings.activeProfileId,
    workspace: settings.workspace, maxToolRounds: settings.maxToolRounds, approvalMode: settings.approvalMode,
    completionSound: settings.completionSound, completionNotification: settings.completionNotification,
    autoCompact: settings.autoCompact,
    fileChangesEnabled: settings.fileChangesEnabled ?? true,
    globalProxyUrl: settings.globalProxyUrl ?? '',
    skin: settings.skin ?? 'classic',
  };
}

function normalizeConnection(update, previous, { migrateAgentModel = false, tolerant = false } = {}) {
  const next = { ...previous };
  if ('protocol' in update) {
    if (!PROTOCOLS.has(update.protocol)) throw new HttpError(400, 'API 协议必须是 chat、anthropic 或 responses。');
    next.protocol = update.protocol;
  }
  if ('baseUrl' in update) next.baseUrl = normalizeBaseUrl(update.baseUrl);
  for (const field of MODEL_FIELDS) {
    if (field in update) next[field] = boundedString(update[field], '模型名称', { max: 256, empty: true }).trim();
  }
  if (migrateAgentModel && !('agentModel' in update)) next.agentModel = next.chatModel;
  // Context capacity is model capability metadata, so it belongs to the connection rather than
  // to one run: the same value is reused by every turn until the user edits it.
  if ('contextWindow' in update) {
    if (!isValidContextWindow(update.contextWindow)) {
      throw new HttpError(400, `上下文窗口必须是 ${MIN_CONTEXT_WINDOW} 到 ${MAX_CONTEXT_WINDOW} 之间的整数。`);
    }
    next.contextWindow = update.contextWindow;
  }
  for (const field of ['clearApiKey', 'clearKey']) {
    if (field in update && typeof update[field] !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值。`);
  }
  if ('apiKey' in update) {
    boundedString(update.apiKey, 'API 密钥', { max: 8_192, empty: true });
    if (/[\r\n]/.test(update.apiKey)) throw new HttpError(400, 'API 密钥不能包含换行。');
    // Blank editor fields preserve only this profile's existing credential.
    const typed = update.apiKey.trim();
    if (isMaskedApiKey(typed)) {
      // 1.3.4: the editor shows the saved key masked; the same mask sent back keeps that key.
      if (!previous.apiKey || typed !== maskApiKey(previous.apiKey)) throw new HttpError(400, 'API 密钥框中是已保存密钥的掩码，不是完整密钥；请粘贴完整的 API 密钥，或点“显示”后再修改。');
    } else if (typed) next.apiKey = typed;
  }
  // 1.4.8: the advanced options are checked where they are typed, so a bad header name, a
  // broken JSON body or an out-of-range limit is refused by the dialog that sent it instead of
  // failing the next request with the vendor.
  if ('headers' in update) next.headers = normalizeHeaders(update.headers, { strict: !tolerant });
  if ('extraBody' in update) next.extraBody = normalizeExtraBodyText(update.extraBody, { strict: !tolerant });
  if ('proxyMode' in update) {
    if (PROXY_MODES.includes(update.proxyMode)) next.proxyMode = update.proxyMode;
    else if (!tolerant) throw new HttpError(400, '代理必须是 global、direct 或 custom。');
  }
  if ('proxyUrl' in update) next.proxyUrl = normalizeProxyUrl(update.proxyUrl, { strict: !tolerant, label: '代理地址' });
  if ('maxConcurrency' in update) next.maxConcurrency = normalizeLimit(update.maxConcurrency, MAX_CONCURRENCY, '并发上限', { strict: !tolerant });
  if ('maxRpm' in update) next.maxRpm = normalizeLimit(update.maxRpm, MAX_RPM, '每分钟请求数', { strict: !tolerant });
  if (!tolerant && next.proxyMode === 'custom' && !next.proxyUrl) throw new HttpError(400, '选择“自定义”代理时，请填写代理地址。');
  if ('reasoningEffort' in update) {
    const requested = update.reasoningEffort;
    if (requested === undefined || requested === null || requested === '') next.reasoningEffort = '';
    else {
      if (!isReasoningLevel(requested)) throw new HttpError(400, '推理等级必须是 low、medium 或 high。');
      next.reasoningEffort = requested;
    }
  }
  if (update.clearApiKey === true || update.clearKey === true) next.apiKey = '';
  next.reasoningEffort = storedReasoningLevel(next.reasoningEffort);
  return next;
}

export function normalizeBaseUrl(value) {
  boundedString(value, 'API 地址', { max: 2_048, empty: true });
  if (!value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'API 地址必须是有效的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, 'API 地址仅支持 HTTP/HTTPS，不能包含账号、密码、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

export function publicSettings(settings) {
  return {
    protocol: settings.protocol ?? 'chat',
    baseUrl: settings.baseUrl, chatModel: settings.chatModel, agentModel: settings.agentModel, imageModel: settings.imageModel,
    contextWindow: settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    apiKeySet: Boolean(settings.apiKey), workspace: settings.workspace, maxToolRounds: settings.maxToolRounds,
    profiles: (settings.profiles ?? []).map(profile => ({
      id: profile.id, name: profile.name, protocol: profile.protocol ?? 'chat',
      baseUrl: profile.baseUrl, chatModel: profile.chatModel,
      agentModel: profile.agentModel, imageModel: profile.imageModel,
      contextWindow: profile.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      reasoningEffort: profile.reasoningEffort ?? '', apiKeySet: Boolean(profile.apiKey),
      // 1.4.8: the advanced options travel with the connection, so the dialog can show them.
      headers: profile.headers ?? [], extraBody: profile.extraBody ?? '',
      proxyMode: profile.proxyMode ?? 'global', proxyUrl: profile.proxyUrl ?? '',
      maxConcurrency: profile.maxConcurrency ?? 0, maxRpm: profile.maxRpm ?? 0,
      // 1.3.4: only a mask. The editor asks the desktop bridge for the full key when the user
      // presses "显示", so no other local process can read keys through this API.
      apiKey: maskApiKey(profile.apiKey),
    })),
    activeProfileId: settings.activeProfileId, approvalMode: settings.approvalMode ?? 'ask',
    completionSound: settings.completionSound ?? true, completionNotification: settings.completionNotification ?? true,
    autoCompact: settings.autoCompact ?? true,
    fileChangesEnabled: settings.fileChangesEnabled ?? true,
    globalProxyUrl: settings.globalProxyUrl ?? '',
    skin: SKINS.has(settings.skin) ? settings.skin : 'classic',
  };
}

/** A run owns a flat snapshot, never references the mutable settings or other credentials. */
export function resolveConnectionSettings(settings, requestedProfileId) {
  const id = requestedProfileId === undefined ? settings.activeProfileId : profileId(requestedProfileId);
  const selected = settings.profiles?.find(profile => profile.id === id);
  if (!selected) throw new HttpError(404, '连接配置不存在。');
  return {
    ...connectionFields(selected), workspace: settings.workspace, maxToolRounds: settings.maxToolRounds,
    approvalMode: settings.approvalMode ?? 'ask', autoCompact: settings.autoCompact ?? true,
    fileChangesEnabled: settings.fileChangesEnabled ?? true,
    // 1.4.8: the app-wide proxy a connection follows when it has none of its own.
    globalProxyUrl: settings.globalProxyUrl ?? '',
    profileId: selected.id, profileName: selected.name, activeProfileId: selected.id,
  };
}

export class Store {
  /** 
   * secrets is the codec that protects API keys at rest. The desktop app injects Electron's
   * safeStorage so keys are sealed by the OS keychain; the headless server falls back to the
   * identity codec, where keys are stored as typed because no keychain is reachable there.
   */
  constructor({ dataDir, defaultWorkspace, secrets = identityCodec }) {
    this.dataDir = path.resolve(dataDir);
    this.secrets = secrets;
    this.defaultWorkspace = path.resolve(defaultWorkspace);
    this.sessionDir = path.join(this.dataDir, 'sessions');
    this.deletedDir = path.join(this.dataDir, 'deleted-sessions');
    this.artifactDir = path.join(this.dataDir, 'artifacts');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.settingsBackupFile = path.join(this.dataDir, 'settings.json.bak');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.sessionMetaFile = path.join(this.dataDir, 'session-meta.json');
    this.settingsQueue = Promise.resolve();
    this.stateQueue = Promise.resolve();
    this.metaQueue = Promise.resolve();
    this.sessionMeta = {};
    this.sessionQueues = new Map();
    this.deletionQueues = new Map();
    this.deletingSessions = new Set();
    this.deletedSessions = new Set();
  }

  async init() {
    /** Problems start-up worked around instead of failing on; the app writes them to the error log. */
    this.startupProblems = [];
    this.unreadableKeys = new Map();
    await Promise.all([this.dataDir, this.sessionDir, this.deletedDir, this.artifactDir, this.defaultWorkspace].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    const defaultProfile = { id: randomUUID(), name: '默认连接', protocol: 'chat', baseUrl: '', chatModel: '', agentModel: '', imageModel: '', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningEffort: '', headers: [], extraBody: '', proxyMode: 'global', proxyUrl: '', maxConcurrency: 0, maxRpm: 0, apiKey: '' };
    const initial = activateProfile({ profiles: [defaultProfile], activeProfileId: defaultProfile.id, workspace: this.defaultWorkspace, maxToolRounds: 0, approvalMode: 'ask', completionSound: true, completionNotification: true, autoCompact: true, fileChangesEnabled: true, globalProxyUrl: '' });
    const { saved, recovered } = await this.loadSavedSettings();
    // 1.3.3: the stored (sealed) form is never validated as if it were the key itself. A sealed key
    // is longer than the key, so a key saved near the length limit used to stop the next start-up.
    // A key may be stored sealed (current) or bare (written by a version before sealing).
    // Unsealing first means validation and every run only ever see the real key.
    const unsealed = await this.unsealSettings(saved ?? {});
    this.settings = await this.validateSettings(unsealed, initial, { loading: true });
    const persisted = await this.sealedSettings();
    const content = JSON.stringify(persisted, null, 2);
    if (recovered || JSON.stringify(saved) !== JSON.stringify(persisted)) await this.writeSettingsFile(content);
    else if (!(await fs.access(this.settingsBackupFile).then(() => true, () => false))) await atomicWrite(this.settingsBackupFile, content);
    // The last conversation the user had open, so a restart reopens the same one
    // even when the desktop app's random local port has reset browser storage.
    const remembered = await readJson(this.stateFile, {}).catch(async error => {
      // Only a pointer to the last open conversation lives here. A file left full of NUL bytes by a
      // crash or power loss used to abort startup; it is set aside and the app starts without it.
      if (!(error instanceof SyntaxError)) throw error;
      await fs.rename(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`).catch(() => {});
      return {};
    });
    this.state = isObject(remembered) && UUID.test(String(remembered.lastSessionId ?? '')) ? { lastSessionId: String(remembered.lastSessionId).toLowerCase() } : {};
    if (this.lastSessionId && !(await fs.access(this.sessionFile(this.lastSessionId)).then(() => true, () => false))) await this.forgetSession();
    const rawMeta = await readJson(this.sessionMetaFile, {}).catch(async error => {
      if (!(error instanceof SyntaxError)) throw error;
      await fs.rename(this.sessionMetaFile, `${this.sessionMetaFile}.corrupt-${Date.now()}`).catch(() => {});
      return {};
    });
    this.sessionMeta = {};
    if (isObject(rawMeta)) {
      for (const [k, v] of Object.entries(rawMeta)) {
        if (!UUID.test(k) || !isObject(v)) continue;
        const pinned = Boolean(v.pinned);
        const locked = Boolean(v.locked);
        // 1.5.6: explicit false entries override stale flags in legacy session JSON.
        this.sessionMeta[k.toLowerCase()] = {
          pinned,
          pinnedAt: pinned && typeof v.pinnedAt === 'string' ? v.pinnedAt : null,
          locked,
          lockedAt: locked && typeof v.lockedAt === 'string' ? v.lockedAt : null,
        };
      }
    }
    await this.recoverInterruptedSessions();
    return this;
  }


  /**
   * 1.3.4: a settings.json that is no longer JSON (a crash or power loss) used to stop the app from
   * starting. It is set aside and the copy kept beside it from the last successful save is used;
   * without one, the app starts with default settings. Either way the problem is logged.
   */
  async loadSavedSettings() {
    const parse = async file => {
      const value = await readJson(file, null);
      if (value !== null && !isObject(value)) throw new SyntaxError(`${path.basename(file)} 不是 JSON 对象。`);
      return value;
    };
    try { return { saved: await parse(this.settingsFile), recovered: false }; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const kept = `${this.settingsFile}.corrupt-${Date.now()}`;
      await fs.rename(this.settingsFile, kept).catch(() => {});
      let restored = null;
      try { restored = await parse(this.settingsBackupFile); }
      catch (backupError) { if (!(backupError instanceof SyntaxError)) throw backupError; }
      this.startupProblems.push({
        source: 'settings',
        message: restored
          ? `settings.json 已损坏，已用上次保存的备份恢复设置；损坏的文件已改名为 ${path.basename(kept)}。`
          : `settings.json 已损坏且没有可用的备份，已按默认设置启动；损坏的文件已改名为 ${path.basename(kept)}。`,
        error,
      });
      return { saved: restored, recovered: true };
    }
  }

  /** The backup is written first, so whichever copy a power loss interrupts, the other is whole. */
  async writeSettingsFile(content) {
    await atomicWrite(this.settingsBackupFile, content);
    await atomicWrite(this.settingsFile, content);
  }

  /** 1.3.4: the full key of one connection, for the app's own window only. */
  revealApiKey(id) {
    const key = profileId(id);
    const profile = this.settings.profiles.find(item => item.id === key);
    if (!profile) throw new HttpError(404, '连接不存在。');
    return profile.apiKey ?? '';
  }

  /**
   * Replaces a stored credential with the real key. A bare value is plaintext from an older
   * version and is returned unchanged so the caller can keep using it while the next write seals it.
   */
  async unsealSettings(saved) {
    // 1.3.3-unreadable-key: one key this computer cannot decrypt (another computer, a copied data
    // directory, a reset Windows password) used to stop the whole app from starting, so the user
    // could never reach the settings page the error pointed to. That connection now loads without
    // a key; its sealed value is kept on disk until the user enters a new key or clears it.
    this.unreadableKeys = new Map();
    const open = async (token, id) => {
      try { return await this.secrets.decrypt(token); }
      catch (error) {
        if (typeof id === 'string' && UUID.test(id)) this.unreadableKeys.set(id.toLowerCase(), token);
        this.startupProblems.push({ source: 'settings', message: '连接的 API 密钥无法在本机解密，已按未填写密钥处理；请在设置中重新填写该连接的密钥。', profileId: id, error });
        return '';
      }
    };
    const profiles = Array.isArray(saved.profiles) ? saved.profiles : [];
    const unsealed = await Promise.all(profiles.map(async profile => {
      if (!isObject(profile) || typeof profile.apiKey !== "string" || !profile.apiKey) return profile;
      return { ...profile, apiKey: await open(profile.apiKey, profile.id) };
    }));
    const flat = typeof saved.apiKey === "string" && saved.apiKey ? { ...saved, apiKey: await open(saved.apiKey, null) } : saved;
    return { ...flat, ...(Array.isArray(saved.profiles) ? { profiles: unsealed } : {}) };
  }

  /** True when this connection's saved key could not be decrypted and no new key was entered since. */
  keyUnreadable(profileId) {
    return typeof profileId === 'string' && Boolean(this.unreadableKeys?.has(profileId.toLowerCase()));
  }

  /** The on-disk form of the current settings, with every API key sealed by the codec. */
  async sealedSettings(settings = this.settings) {
    const persisted = persistedSettings(settings);
    const profiles = await Promise.all(persisted.profiles.map(async profile => ({
      ...profile,
      // An undecryptable key is written back exactly as it was, so a later computer that can
      // read it (or the user's own restore) still has it.
      apiKey: profile.apiKey ? await this.secrets.encrypt(profile.apiKey) : (this.unreadableKeys?.get(profile.id) ?? ""),
    })));
    return { ...persisted, profiles };
  }

  get lastSessionId() { return this.state.lastSessionId; }

  /** Point the app at one conversation. The caller has already checked it exists. */
  rememberSession(id) {
    if (!UUID.test(id)) throw new HttpError(404, '会话不存在。');
    return this.writeState({ lastSessionId: id.toLowerCase() });
  }

  /** A deleted conversation must not be reopened on the next launch. */
  forgetSession() {
    return this.writeState({});
  }

  writeState(next) {
    const operation = this.stateQueue.then(async () => {
      await atomicWrite(this.stateFile, JSON.stringify(next, null, 2));
      this.state = next;
    });
    this.stateQueue = operation.catch(() => {});
    return operation;
  }

  /**
   * A cheap pre-check: could this file possibly need recovery at all?
   *
   * Recovery only rewrites an unfinished run, an unfinished tool call, a session missing its own
   * workspace, or a compaction record. Parsing every conversation on every launch costs real
   * start-up time once a user accumulates hundreds of them, so a raw-text scan skips the files
   * that cannot change. The markers are deliberately broad: a false positive costs one parse,
   * while a false negative would leave a stuck "running" turn on screen forever.
   */
  needsRecovery(bytes) {
    const text = bytes.toString('utf8');
    return text.includes('"running"') || text.includes('"pending"') || text.includes('"streaming"')
      || text.includes('"compaction"') || text.includes('"pinned"') || text.includes('"locked"') || !text.includes('"workspace"');
  }

  async recoverInterruptedSessions() {
    const names = await fs.readdir(this.sessionDir);
    for (const name of names) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      const file = path.join(this.sessionDir, name);
      // 1.3.3-corrupt-session: a single damaged conversation (all NUL bytes after a power loss, an
      // empty or cut-off file) used to stop the whole app from starting, with no file name in the
      // message. It is now set aside under a .corrupt name and start-up continues.
      let raw;
      try { raw = await fs.readFile(file); }
      catch (error) {
        if (error.code !== 'ENOENT') this.startupProblems.push({ source: 'session', message: `无法读取会话文件 ${name}，已跳过。`, error });
        continue;
      }
      // Nothing to repair means no JSON parse and no full-object scan.
      if (!this.needsRecovery(raw)) continue;
      let session;
      try { session = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
      catch (error) {
        const aside = `${file}.corrupt-${Date.now()}`;
        const moved = await fs.rename(file, aside).then(() => true, () => false);
        this.startupProblems.push({ source: 'session', message: moved ? `会话文件 ${name} 已损坏，已改名为 ${path.basename(aside)} 并跳过。` : `会话文件 ${name} 已损坏，已跳过。`, error });
        continue;
      }
      if (!isObject(session) || !Array.isArray(session.messages)) continue;
      try {
      let changed = false;
      // 1.5.6: migrate legacy flags once, then metadata is the only authority.
      const metaKey = String(session.id).toLowerCase();
      if (UUID.test(metaKey) && !(metaKey in this.sessionMeta) && (session.pinned || session.locked)) {
        const entry = {
          pinned: Boolean(session.pinned), pinnedAt: session.pinned ? (session.pinnedAt ?? null) : null,
          locked: Boolean(session.locked), lockedAt: session.locked ? (session.lockedAt ?? null) : null,
        };
        await this.writeSessionMeta(meta => ({ next: { ...meta, [metaKey]: entry } }));
      }
      for (const field of ['pinned', 'pinnedAt', 'locked', 'lockedAt']) {
        if (field in session) { delete session[field]; changed = true; }
      }
      // Sessions saved before per-session workspaces adopt their own directory here, while no run is active.
      if (typeof session.workspace !== 'string' || !path.isAbsolute(session.workspace)) {
        session.workspace = this.sessionWorkspacePath(session.id);
        changed = true;
      }
      // A compaction record must reference a message that still exists; otherwise the
      // conversation would silently lose the history it was told to keep.
      if (session.compaction && this.compactionBoundary(session) < 0) {
        delete session.compaction;
        changed = true;
      }
      for (const message of session.messages) {
        if (message.role === 'assistant' && ['running', 'pending', 'streaming'].includes(message.status)) {
          message.status = 'cancelled';
          if (isObject(message.metrics)) message.metrics = { ...message.metrics, status: 'cancelled' };
          changed = true;
        }
        for (const tool of message.tools ?? []) {
          if (['running', 'pending'].includes(tool.status)) {
            tool.status = 'error'; tool.output = '上次服务已中断；此待处理请求已结束，请重新发送消息。'; changed = true;
          }
        }
      }
      if (changed) { session.updatedAt = new Date().toISOString(); await this.saveSession(session); }
      } catch (error) {
        this.startupProblems.push({ source: 'session', message: `修复会话文件 ${name} 时出错，已跳过。`, error });
      }
    }
  }

  /** The message index a stored compaction record summarizes up to, or -1 when it is unusable. */
  compactionBoundary(session) {
    const id = session?.compaction?.throughMessageId;
    if (typeof id !== 'string' || !id) return -1;
    return session.messages.findIndex(message => message.id === id);
  }

  async validateSettings(update, previous, { loading = false } = {}) {
    requireObject(update);
    // Upgrade old shared chat/agent models only while reading an older saved schema.
    const migrateAgentModel = loading && (!('schemaVersion' in update) || (typeof update.schemaVersion === 'number' && update.schemaVersion < 3));
    const next = {
      profiles: previous.profiles.map(profile => ({ ...profile })), activeProfileId: previous.activeProfileId,
      workspace: previous.workspace, maxToolRounds: previous.maxToolRounds, approvalMode: previous.approvalMode ?? 'ask',
      completionSound: previous.completionSound ?? true, completionNotification: previous.completionNotification ?? true,
      autoCompact: previous.autoCompact ?? true,
      fileChangesEnabled: previous.fileChangesEnabled ?? true,
      globalProxyUrl: previous.globalProxyUrl ?? '',
      skin: SKINS.has(previous.skin) ? previous.skin : 'classic',
    };
    if ('profiles' in update) {
      if (!Array.isArray(update.profiles) || update.profiles.length < 1 || update.profiles.length > 50) throw new HttpError(400, '连接配置必须有 1 到 50 项。');
      const previousProfiles = new Map(previous.profiles.map(profile => [profile.id, profile]));
      const ids = new Set();
      next.profiles = update.profiles.map(item => {
        requireObject(item);
        const id = profileId(item.id);
        if (ids.has(id)) throw new HttpError(400, '连接 ID 不能重复。');
        ids.add(id);
        const existing = previousProfiles.get(id);
        const name = boundedString('name' in item ? item.name : existing?.name, '连接名称', { max: 80 }).trim();
        const defaults = existing ?? { protocol: 'chat', baseUrl: '', chatModel: '', agentModel: '', imageModel: '', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningEffort: '', apiKey: '' };
        return { id, name, ...connectionFields(normalizeConnection(item, defaults, { migrateAgentModel, tolerant: loading })) };
      });
    }
    if ('activeProfileId' in update) next.activeProfileId = profileId(update.activeProfileId);
    const activeIndex = next.profiles.findIndex(profile => profile.id === next.activeProfileId);
    if (activeIndex < 0) throw new HttpError(400, '活动连接不存在；删除它时请同时选择另一个连接。');
    // Full profile lists are authoritative; old flat clients update only their active profile.
    if (!('profiles' in update) && CONNECTION_FIELDS.some(field => field in update)) {
      next.profiles[activeIndex] = normalizeConnection(update, next.profiles[activeIndex], { migrateAgentModel, tolerant: loading });
    }
    if (!loading && ('profiles' in update || MODEL_FIELDS.some(field => field in update))) {
      const incomplete = next.profiles.find(profile => !MODEL_FIELDS.some(field => Boolean(profile[field])));
      if (incomplete) throw new HttpError(400, `连接“${incomplete.name}”至少填写一个聊天、编程或生图模型；未填写的模式将不可用。`);
    }
    if ('maxToolRounds' in update) {
      if (!Number.isSafeInteger(update.maxToolRounds) || update.maxToolRounds < 0) throw new HttpError(400, '工具轮数必须是非负安全整数；0 表示不限制。');
      next.maxToolRounds = update.maxToolRounds;
    }
    if ('workspace' in update) {
      boundedString(update.workspace, '工作目录', { max: 4_096 });
      if (!path.isAbsolute(update.workspace)) throw new HttpError(400, '工作目录必须是绝对路径。');
      next.workspace = path.resolve(update.workspace);
    }
    if ('approvalMode' in update) {
      if (!APPROVAL_MODES.has(update.approvalMode)) throw new HttpError(400, '权限模式必须是 ask、smart 或 full。');
      next.approvalMode = update.approvalMode;
    }
    for (const field of COMPLETION_FIELDS) {
      if (!(field in update)) continue;
      if (typeof update[field] !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值。`);
      next[field] = update[field];
    }
    for (const field of COMPACTION_FIELDS) {
      if (!(field in update)) continue;
      if (typeof update[field] !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值。`);
      next[field] = update[field];
    }
    if ('fileChanges' in update && !('fileChangesEnabled' in update)) {
      if (typeof update.fileChanges !== 'boolean') throw new HttpError(400, 'fileChanges 必须是布尔值。');
      next.fileChangesEnabled = update.fileChanges;
    }
    if ('globalProxyUrl' in update) {
      next.globalProxyUrl = normalizeProxyUrl(update.globalProxyUrl, { strict: true, label: '全局代理地址' });
    }
    if ('skin' in update) {
      // A value written by another build must never stop the app from starting: while loading
      // it falls back to the shipped skin, while saving it is a clear error.
      if (SKINS.has(update.skin)) next.skin = update.skin;
      else if (!loading) throw new HttpError(400, `皮肤必须是 ${UI_SKINS.join('、')} 之一。`);
    }
    if (loading || 'workspace' in update) {
      await fs.mkdir(next.workspace, { recursive: true });
      next.workspace = await fs.realpath(next.workspace);
    }
    return activateProfile(next);
  }

  async updateSettings(update) {
    const operation = this.settingsQueue.then(async () => {
      const next = await this.validateSettings(update, this.settings);
      const replaced = new Set();
      const touches = (item, id) => {
        if (!isObject(item) || typeof id !== 'string') return;
        const typed = typeof item.apiKey === 'string' && item.apiKey.trim() && !isMaskedApiKey(item.apiKey.trim());
        if (typed || item.clearApiKey === true || item.clearKey === true) replaced.add(id.toLowerCase());
      };
      if (Array.isArray(update.profiles)) for (const item of update.profiles) touches(item, item?.id);
      else touches(update, this.settings.activeProfileId);
      // Profiles that were removed take their unreadable key with them.
      const keep = new Map([...this.unreadableKeys].filter(([id]) => !replaced.has(id) && next.profiles.some(profile => profile.id === id)));
      const previousUnreadable = this.unreadableKeys;
      this.unreadableKeys = keep;
      try { await this.writeSettingsFile(JSON.stringify(await this.sealedSettings(next), null, 2)); }
      catch (error) { this.unreadableKeys = previousUnreadable; throw error; }
      this.settings = next;
      return publicSettings(next);
    });
    this.settingsQueue = operation.catch(() => {});
    return operation;
  }

  sessionFile(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, '会话不存在。');
    // 1.3.3: Windows file names ignore case, so an upper-case id opened the same file while every
    // in-memory lock keyed on the original spelling missed it.
    return path.join(this.sessionDir, `${id.toLowerCase()}.json`);
  }

  /**
   * Every session works in its own directory, so files one session creates can
   * never appear in another session's listing or command output. The configured
   * workspace is the root these directories live under.
   */
  sessionWorkspacePath(id, root = this.settings.workspace) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, '会话不存在。');
    return path.join(root, 'sessions', id.toLowerCase());
  }

  /** The directory a session record works in, tolerating records written before this layout. */
  sessionWorkspace(session) {
    return typeof session.workspace === 'string' && path.isAbsolute(session.workspace)
      ? session.workspace
      : this.sessionWorkspacePath(session.id);
  }

  /** Create a session's directory on demand. A read never rewrites the session record. */
  async ensureSessionWorkspace(session) {
    const target = this.sessionWorkspace(session);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    return target;
  }

  /** The workspace a request works in: one session's own directory, or the configured root. */
  async workspaceFor(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return this.settings.workspace;
    if (typeof sessionId !== 'string') throw new HttpError(400, '会话 ID 必须是文本。');
    return this.ensureSessionWorkspace(await this.getSession(sessionId));
  }

  getSessionMeta(id) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      return { pinned: false, pinnedAt: null, locked: false, lockedAt: null };
    }
    const entry = this.sessionMeta?.[id.toLowerCase()];
    const pinned = Boolean(entry?.pinned);
    const locked = Boolean(entry?.locked);
    return {
      pinned,
      pinnedAt: pinned ? (entry?.pinnedAt ?? null) : null,
      locked,
      lockedAt: locked ? (entry?.lockedAt ?? null) : null,
    };
  }

  isSessionLocked(id) {
    return this.getSessionMeta(id).locked;
  }

  withSessionMeta(session) {
    if (!isObject(session)) return session;
    return { ...session, ...this.getSessionMeta(session.id) };
  }

  // 1.5.6: compute each change inside the queue, from the preceding successful write.
  writeSessionMeta(change = meta => ({ next: meta })) {
    const operation = this.metaQueue.then(async () => {
      const { next, result } = change(this.sessionMeta);
      await atomicWrite(this.sessionMetaFile, JSON.stringify(next, null, 2));
      this.sessionMeta = next;
      return result;
    });
    this.metaQueue = operation.catch(() => {});
    return operation;
  }

  async updateSessionFlags(id, patch = {}) {
    requireObject(patch);
    const file = this.sessionFile(id);
    const key = id.toLowerCase();
    if ('pinned' in patch && typeof patch.pinned !== 'boolean') throw new HttpError(400, 'pinned 必须是布尔值。');
    if ('locked' in patch && typeof patch.locked !== 'boolean') throw new HttpError(400, 'locked 必须是布尔值。');
    const flags = { ...patch };
    // Check existence and calculate the patch in the same serialized metadata operation.
    const operation = this.metaQueue.then(async () => {
      if (this.deletingSessions.has(key) || this.deletedSessions.has(key)) throw new HttpError(409, '此会话正在删除或已经删除。');
      const exists = await fs.access(file).then(() => true, () => false);
      if (!exists) throw new HttpError(404, '会话不存在。');
      const prev = this.getSessionMeta(key);
      const now = new Date().toISOString();
      const pinned = 'pinned' in flags ? flags.pinned : prev.pinned;
      const locked = 'locked' in flags ? flags.locked : prev.locked;
      const entry = {
        pinned, pinnedAt: pinned ? (prev.pinned && prev.pinnedAt ? prev.pinnedAt : now) : null,
        locked, lockedAt: locked ? (prev.locked && prev.lockedAt ? prev.lockedAt : now) : null,
      };
      const next = { ...this.sessionMeta, [key]: entry };
      await atomicWrite(this.sessionMetaFile, JSON.stringify(next, null, 2));
      this.sessionMeta = next;
      return { id: key, ...entry };
    });
    this.metaQueue = operation.catch(() => {});
    return operation;
  }

  sortSessionSummaries(sessions) {
    return sessions.filter(Boolean).sort((a, b) => {
      const ap = Boolean(a.pinned);
      const bp = Boolean(b.pinned);
      if (ap !== bp) return bp ? 1 : -1;
      if (ap && bp) {
        const at = String(a.pinnedAt || a.updatedAt || a.createdAt || '');
        const bt = String(b.pinnedAt || b.updatedAt || b.createdAt || '');
        if (bt !== at) return bt.localeCompare(at);
      }
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }

  async getSession(id) {
    let session;
    try { session = await readJson(this.sessionFile(id), null); }
    catch (error) {
      // 1.3.3: a damaged file is reported as damaged (and can still be deleted), not as a 500.
      if (error instanceof SyntaxError) throw new HttpError(422, CORRUPT_SESSION_TEXT);
      throw error;
    }
    if (!session) throw new HttpError(404, '会话不存在。');
    if (!isObject(session) || !Array.isArray(session.messages)) throw new HttpError(422, CORRUPT_SESSION_TEXT);
    return this.withSessionMeta(session);
  }

  async createSession(title = '新对话') {
    const now = new Date().toISOString();
    const id = randomUUID();
    const workspace = await fs.realpath(await this.ensureSessionWorkspace({ id }));
    const session = { id, title, workspace, createdAt: now, updatedAt: now, messages: [] };
    await this.saveSession(session);
    return this.withSessionMeta(session);
  }

  saveSession(session) {
    const filename = this.sessionFile(session.id);
    const key = String(session.id).toLowerCase();
    // Pin/lock state belongs to session-meta.json, not a live run's stale snapshot.
    const { pinned, pinnedAt, locked, lockedAt, ...record } = session;
    const snapshot = JSON.stringify(record, null, 2);
    const previous = this.sessionQueues.get(key) ?? Promise.resolve();
    if (this.deletingSessions.has(key) || this.deletedSessions.has(key)) return Promise.reject(new HttpError(409, '此会话正在删除或已经删除，未重新保存。'));
    const operation = previous.catch(() => {}).then(() => atomicWrite(filename, snapshot));
    this.sessionQueues.set(key, operation);
    operation.finally(() => { if (this.sessionQueues.get(key) === operation) this.sessionQueues.delete(key); }).catch(() => {});
    return operation;
  }

  async listSessions() {
    const names = await fs.readdir(this.sessionDir);
    // 1.3.3: one damaged or incomplete file used to fail the whole list, so the sidebar showed no
    // conversation at all. Each file now stands alone; a damaged one is listed as damaged so the
    // user can still see and delete it.
    const sessions = await Promise.all(names.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).map(async name => {
      const file = path.join(this.sessionDir, name);
      const id = name.slice(0, -5).toLowerCase();
      const meta = this.getSessionMeta(id);
      const fallbackTime = async () => (await fs.stat(file).catch(() => null))?.mtime?.toISOString?.() ?? new Date(0).toISOString();
      let session;
      try { session = await readJson(file, null); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        const time = await fallbackTime();
        return { id, title: '（已损坏的会话，可删除）', createdAt: time, updatedAt: time, messageCount: 0, corrupt: true, ...meta };
      }
      if (!session) return null;
      if (!isObject(session)) {
        const time = await fallbackTime();
        return { id, title: '（已损坏的会话，可删除）', createdAt: time, updatedAt: time, messageCount: 0, corrupt: true, ...meta };
      }
      const text = value => (typeof value === 'string' && value ? value : null);
      const updatedAt = text(session.updatedAt) ?? text(session.createdAt) ?? await fallbackTime();
      const pinned = meta.pinned;
      const locked = meta.locked;
      return {
        id, title: typeof session.title === 'string' ? session.title : '新对话',
        createdAt: text(session.createdAt) ?? updatedAt, updatedAt,
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
        pinned,
        pinnedAt: meta.pinnedAt,
        locked,
        lockedAt: meta.lockedAt,
      };
    }));
    return this.sortSessionSummaries(sessions);
  }

  /** Durable cleanup receipts contain paths/identifiers only, never conversation text. */
  cleanupFile(id) {
    this.sessionFile(id); // validate before joining paths
    return path.join(this.dataDir, 'session-cleanup', `${id.toLowerCase()}.json`);
  }

  async readCleanup(id) {
    const record = await readJson(this.cleanupFile(id), null);
    if (record === null) return null;
    if (!isObject(record) || record.version !== 1 || record.id !== id.toLowerCase()
      || !Array.isArray(record.workspaces) || record.workspaces.some(dir => !isSafeSessionWorkspaceDir(dir, id))
      || !Array.isArray(record.artifacts) || record.artifacts.some(name => typeof name !== 'string' || !ARTIFACT_FILE_RE.test(name))) {
      throw new HttpError(422, '删除清理记录损坏；为保护其他文件，未继续删除。');
    }
    return record;
  }

  async pendingCleanupIds() {
    let names;
    try { names = await fs.readdir(path.join(this.dataDir, 'session-cleanup')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const ids = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5).toLowerCase();
      try { if (!(await this.readCleanup(id))?.complete) ids.push(id); }
      catch { ids.push(id); } // retry reports the damaged receipt instead of hiding it
    }
    return ids;
  }

  /**
   * A primary unlink is the deletion commit. Everything after it is reported as
   * cleanup, never thrown as if the conversation were still present. Save the
   * cleanup recipe BEFORE that commit, so missing JSON/restarts remain retryable.
   */
  deleteSession(id, { force = false, removeFileChanges = null } = {}) {
    this.sessionFile(id);
    const key = id.toLowerCase();
    if (this.deletionQueues.has(key)) return this.deletionQueues.get(key);
    this.deletingSessions.add(key);
    const operation = this.performSessionDeletion(key, { force, removeFileChanges });
    this.deletionQueues.set(key, operation);
    operation.finally(() => {
      this.deletingSessions.delete(key);
      if (this.deletionQueues.get(key) === operation) this.deletionQueues.delete(key);
    }).catch(() => {});
    return operation;
  }

  async performSessionDeletion(key, { force, removeFileChanges }) {
    await this.metaQueue;
    if (!force && this.isSessionLocked(key)) throw new HttpError(423, '此会话已锁定，请先解锁后再删除。');
    await (this.sessionQueues.get(key) ?? Promise.resolve()).catch(() => {});
    const file = this.sessionFile(key);
    let session = null;
    let missing = false;
    let unreadableArtifacts = false;
    try { session = await readJson(file, null); missing = session === null && !(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; unreadableArtifacts = true; }
    let receipt = await this.readCleanup(key);
    const retriedCleanup = Boolean(receipt);
    if (!receipt && missing) throw new HttpError(404, '会话不存在，也没有可重试的删除清理记录。');
    // If the first unlink failed, the live session may have changed since then.
    // Merge a fresh recipe before committing; never trust stale artifact/workspace lists.
    if (!missing) {
      const workspaces = new Set([...(receipt?.workspaces ?? []),
        this.sessionWorkspacePath(key), this.sessionWorkspacePath(key, this.defaultWorkspace),
      ]);
      if (typeof session?.workspace === 'string' && path.isAbsolute(session.workspace)) workspaces.add(path.resolve(session.workspace));
      let artifacts;
      try { artifacts = [...extractArtifactNamesFromSession(session)]; }
      catch { artifacts = []; unreadableArtifacts = true; }
      receipt = {
        version: 1, id: key, createdAt: receipt?.createdAt ?? new Date().toISOString(), complete: false,
        workspaces: [...workspaces].filter(dir => isSafeSessionWorkspaceDir(dir, key)),
        artifacts: [...new Set([...(receipt?.artifacts ?? []), ...artifacts])],
        unreadableArtifacts: Boolean(receipt?.unreadableArtifacts) || unreadableArtifacts || !isObject(session) || !Array.isArray(session.messages),
      };
      // Failure here is a pre-commit failure: leave the primary record intact.
      await atomicWrite(this.cleanupFile(key), JSON.stringify(receipt, null, 2));
    }
    const failures = [];
    const attempt = async (stage, target, action) => {
      try { await action(); return true; }
      catch (error) {
        failures.push({ stage, path: target, code: error?.code ?? error?.status ?? null, message: safeError(error) });
        return false;
      }
    };
    if (!missing) {
      const unlinked = await attempt('session-record', file, async () => {
        try { await fs.unlink(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      });
      if (!unlinked) return { deleted: false, recordDeleted: false, id: key, dataRemoved: false, cleanupComplete: false, partial: false, retriedCleanup, failures, cleanupFailures: [], retryable: true };
    }
    this.deletedSessions.add(key);
    // No unhandled post-commit filesystem/metadata error may turn this into HTTP 500.
    for (const directory of [this.sessionDir, this.deletedDir]) {
      await attempt('archive', directory, async () => {
        let names;
        try { names = await fs.readdir(directory); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const name of names) {
          const lower = name.toLowerCase();
          if (lower === `${key}.json` || lower.startsWith(`${key}.json.corrupt-`) || lower.startsWith(`${key}.corrupt-`)) {
            await attempt('archive', path.join(directory, name), () => fs.rm(path.join(directory, name), { force: true }));
          }
        }
      });
    }
    for (const directory of receipt.workspaces) {
      await attempt('workspace', directory, async () => {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        try { await fs.lstat(directory); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('删除后工作目录仍然存在。');
      });
    }
    if (receipt.unreadableArtifacts) failures.push({ stage: 'artifact-discovery', path: file, code: 'UNREADABLE_RECORD', message: '原会话内容损坏，无法确认其关联图片；未盲目删除其他会话的图片。' });
    if (receipt.artifacts.length) {
      await attempt('artifact-references', this.sessionDir, async () => {
        // An unreadable remaining record is NOT evidence that a picture is unshared.
        const shared = new Set();
        const names = await fs.readdir(this.sessionDir);
        for (const name of names) {
          if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5)) || name.slice(0, -5).toLowerCase() === key) continue;
          let raw;
          try { raw = (await fs.readFile(path.join(this.sessionDir, name), 'utf8')).toLowerCase(); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          for (const artifact of receipt.artifacts) if (raw.includes(artifact.toLowerCase())) shared.add(artifact);
        }
        for (const artifact of receipt.artifacts) if (!shared.has(artifact)) {
          await attempt('artifact', path.join(this.artifactDir, artifact), () => fs.rm(path.join(this.artifactDir, artifact), { force: true }));
        }
      });
    }
    await attempt('file-changes', path.join(this.dataDir, 'file-changes', key), async () => {
      if (removeFileChanges) await removeFileChanges(key);
      else await fs.rm(path.join(this.dataDir, 'file-changes', key), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    await attempt('state', this.stateFile, () => this.forgetDeletedSession(key));
    await attempt('metadata', this.sessionMetaFile, () => this.writeSessionMeta(meta => {
      const next = { ...meta }; delete next[key]; return { next };
    }));
    const dataRemoved = failures.every(item => !['archive', 'workspace', 'artifact-discovery', 'artifact-references', 'artifact', 'file-changes'].includes(item.stage));
    const updated = { ...receipt, recordDeleted: true, complete: failures.length === 0, updatedAt: new Date().toISOString(), failures };
    await attempt('cleanup-journal', this.cleanupFile(key), () => atomicWrite(this.cleanupFile(key), JSON.stringify(updated, null, 2)));
    return {
      deleted: true, recordDeleted: true, id: key, alreadyDeleted: missing, retriedCleanup,
      dataRemoved, cleanupComplete: failures.length === 0, partial: failures.length > 0,
      failures, cleanupFailures: failures, retryable: failures.length > 0,
    };
  }

  /** Check the current pointer INSIDE its queue; do not clear a newly activated session. */
  forgetDeletedSession(key) {
    const operation = this.stateQueue.then(async () => {
      if (this.lastSessionId !== key) return;
      await atomicWrite(this.stateFile, '{}'); this.state = {};
    });
    this.stateQueue = operation.catch(() => {});
    return operation;
  }

  async deleteAllSessions({ includePinned = true, excludeIds = [], removeFileChanges = null } = {}) {
    const exclude = new Set((excludeIds ?? []).map(x => String(x).toLowerCase()));
    const all = await this.listSessions();
    const candidates = new Map(all.map(item => [item.id, item]));
    // A second bulk delete also retries records already removed from the sidebar.
    for (const id of await this.pendingCleanupIds()) if (!candidates.has(id)) candidates.set(id, { id, ...this.getSessionMeta(id) });
    const deletedIds = [], retriedIds = [], cleanedIds = [], cleanupPendingIds = [];
    const skippedLockedIds = [], skippedPinnedIds = [], failures = [], cleanupFailures = [], outcomes = [];
    for (const item of candidates.values()) {
      if (exclude.has(item.id)) continue;
      if (item.locked) { skippedLockedIds.push(item.id); continue; }
      if (!includePinned && item.pinned) { skippedPinnedIds.push(item.id); continue; }
      try {
        const result = await this.deleteSession(item.id, { removeFileChanges });
        outcomes.push(result);
        if (result.recordDeleted) {
          deletedIds.push(item.id);
          if (result.retriedCleanup) retriedIds.push(item.id);
          if (result.cleanupComplete) cleanedIds.push(item.id);
          else { cleanupPendingIds.push(item.id); cleanupFailures.push(...result.cleanupFailures.map(failure => ({ id: item.id, ...failure }))); }
        } else failures.push({ id: item.id, message: result.failures[0]?.message ?? '会话记录删除失败。', failures: result.failures });
      } catch (error) {
        if (error?.status === 423) skippedLockedIds.push(item.id);
        else failures.push({ id: item.id, message: safeError(error) });
      }
    }
    // No blind purge of archives: locked/excluded sessions and cleanup receipts survive.
    return {
      deleted: true, deletedIds, retriedIds, cleanedIds, cleanupPendingIds, outcomes,
      skippedLockedIds, skippedPinnedIds, failures, cleanupFailures,
      failedIds: failures.map(item => item.id), failedCount: failures.length,
      deletedCount: outcomes.filter(item => item.recordDeleted && !item.alreadyDeleted).length, cleanedCount: cleanedIds.length,
      cleanupFailedCount: cleanupPendingIds.length, retriedCount: retriedIds.length,
      dataRemoved: failures.length === 0 && cleanupPendingIds.length === 0,
      cleanupComplete: failures.length === 0 && cleanupPendingIds.length === 0,
      partial: cleanupPendingIds.length > 0 || (deletedIds.length > 0 && failures.length > 0),
      skippedLockedCount: skippedLockedIds.length,
    };
  }

  async searchSessions(query, { caseSensitive = false, liveSessions = new Map(), limit = 100 } = {}) {
    const rawQuery = typeof query === 'string' ? query.trim() : '';
    if (!rawQuery) return { query: '', results: [] };
    const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
    const summaries = await this.listSessions();
    const results = [];

    const makeSnippet = (text, idx, len) => {
      const start = Math.max(0, idx - 32);
      const end = Math.min(text.length, idx + len + 48);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      return (prefix + text.slice(start, end).replace(/\s+/g, ' ') + suffix).trim();
    };

    for (const summary of summaries) {
      if (summary.corrupt) continue;
      let session = liveSessions.get(summary.id) ?? null;
      if (!session) {
        try { session = await this.getSession(summary.id); }
        catch { continue; }
      }
      const matches = [];
      let matchCount = 0;

      const titleText = typeof session.title === 'string' ? session.title : '';
      if (titleText) {
        const hay = caseSensitive ? titleText : titleText.toLowerCase();
        const idx = hay.indexOf(needle);
        if (idx !== -1) {
          matchCount += 1;
          matches.push({
            messageId: null,
            role: 'title',
            occurrenceInMessage: 0,
            snippet: titleText,
          });
        }
      }

      for (const msg of session.messages ?? []) {
        if (!isObject(msg)) continue;
        const combined = [
          typeof msg.text === 'string' ? msg.text : '',
          typeof msg.reasoning === 'string' ? msg.reasoning : '',
        ].filter(Boolean).join('\n');
        if (!combined) continue;
        const hay = caseSensitive ? combined : combined.toLowerCase();
        let from = 0;
        let occ = 0;
        while (from <= hay.length - needle.length) {
          const idx = hay.indexOf(needle, from);
          if (idx === -1) break;
          matchCount += 1;
          if (matches.length < 20) {
            matches.push({
              messageId: msg.id ?? null,
              role: msg.role ?? 'assistant',
              occurrenceInMessage: occ,
              snippet: makeSnippet(combined, idx, rawQuery.length),
            });
          }
          occ += 1;
          from = idx + Math.max(1, needle.length);
        }
      }

      if (matchCount > 0) {
        results.push({
          sessionId: summary.id,
          title: summary.title,
          pinned: Boolean(summary.pinned),
          locked: Boolean(summary.locked),
          updatedAt: summary.updatedAt,
          matchCount,
          matches,
        });
        if (results.length >= limit) break;
      }
    }

    return { query: rawQuery, results };
  }

  async flush() {
    await this.settingsQueue;
    await this.stateQueue;
    await this.metaQueue;
    await Promise.allSettled([...this.sessionQueues.values()]);
  }
}
