/**
 * At-rest protection for the one secret this app stores: the API key of each connection.
 *
 * `settings.json` lives in the user's data directory, so a plain key in it is readable by any
 * process running as that user and by anything that copies the folder. A codec turns a key into
 * an opaque token before it is written and back into the key when a request needs it.
 *
 * The desktop app injects Electron's `safeStorage`, which wraps the key with the operating
 * system keychain (DPAPI on Windows). The headless server has no keychain available, so it runs
 * with the identity codec: keys stay usable but are not disguised, and that limitation is
 * reported rather than hidden.
 *
 * A token is always prefixed, so a stored value is self-describing: a bare string is legacy
 * plaintext from an older version, and the migration in Store rewrites it as a token.
 */
export const SECRET_PREFIX = 'vault:v1:';

const SENSITIVE_NAME_RE = /(?:api[-_]?key|token|secret|password|passwd|auth|credential|cookie|bearer|private|pat|dsn|session[-_]?key|access[-_]?key)/i;
const SENSITIVE_VALUE_RE = /^\s*(?:bearer|basic|digest|negotiate|token)\s+\S+/i;
const DIRECT_SECRET_FIELDS = ['apiKey', 'token', 'accessToken', 'refreshToken', 'bearerToken', 'secret', 'password', 'clientSecret'];

/** No encryption: used by the CLI server and by tests that only care about key round-tripping. */
export const identityCodec = {
  kind: 'identity',
  encrypt: async value => value,
  decrypt: async value => value,
};

/**
 * Wraps Electron's safeStorage. `safeStorage` is passed in rather than imported so this module
 * stays runnable outside Electron, and every failure mode is explicit:
 * - the OS keychain is unavailable, so nothing can be encrypted (`available` false);
 * - a token exists but this machine cannot unwrap it, which must surface as a real error rather
 *   than an empty key that silently turns into "unauthenticated" requests.
 */
export function safeStorageCodec(safeStorage) {
  const available = () => {
    try { return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable(); }
    catch { return false; }
  };
  return {
    kind: 'safeStorage',
    get available() { return available(); },
    async encrypt(value) {
      if (!value) return '';
      if (!available()) throw new Error('系统密钥保护不可用，无法安全保存 API 密钥。');
      return `${SECRET_PREFIX}${safeStorage.encryptString(value).toString('base64')}`;
    },
    async decrypt(value) {
      if (typeof value !== 'string' || !value) return '';
      if (!value.startsWith(SECRET_PREFIX)) return value;
      if (!available()) throw new Error('系统密钥保护不可用，无法读取已保存的 API 密钥。');
      const encoded = value.slice(SECRET_PREFIX.length);
      try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
      catch {
        throw new Error('已保存的 API 密钥无法在本机解密；请在设置中重新填写该连接的密钥。');
      }
    },
  };
}

export function isSealedSecret(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isSensitiveEntry(name, value, explicitSecret = false) {
  if (explicitSecret === true) return true;
  if (SENSITIVE_NAME_RE.test(String(name ?? ''))) return true;
  if (typeof value === 'string' && (isSealedSecret(value) || SENSITIVE_VALUE_RE.test(value))) return true;
  return false;
}

function stripProxyCredentials(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const text = rawUrl.trim();
  if (!text || isSealedSecret(text)) return '';
  if (!text.includes('@')) return rawUrl;
  try {
    const hadExplicitPathSlash = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\//i.test(text);
    const url = new URL(text);
    url.username = '';
    url.password = '';
    if (!hadExplicitPathSlash && url.pathname === '/' && !url.search && !url.hash) {
      return `${url.protocol}//${url.host}`;
    }
    return url.href;
  } catch {
    const stripped = text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
    return stripped.includes('@') ? '' : stripped;
  }
}

function stripEndpointCredentials(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const cleanedUser = stripProxyCredentials(rawUrl);
  if (!cleanedUser || !cleanedUser.includes('?')) return cleanedUser;
  try {
    const url = new URL(cleanedUser);
    let mutated = false;
    for (const [k, v] of [...url.searchParams.entries()]) {
      if (isSensitiveEntry(k, v)) {
        url.searchParams.set(k, '');
        mutated = true;
      }
    }
    return mutated ? url.href : cleanedUser;
  } catch {
    return cleanedUser;
  }
}

function stripHeaders(headers) {
  if (Array.isArray(headers)) {
    return headers.map(item => {
      if (typeof item === 'string') {
        const at = item.indexOf(':');
        if (at < 0) return item;
        const name = item.slice(0, at).trim();
        const val = item.slice(at + 1);
        return isSensitiveEntry(name, val) ? `${name}: ` : item;
      }
      if (item && typeof item === 'object') {
        const name = item.name ?? item.key ?? item.header ?? '';
        const val = item.value ?? item.val ?? '';
        if (!isSensitiveEntry(name, val, item.secret)) return { ...item };
        const copy = { ...item };
        if ('value' in copy || !('val' in copy)) copy.value = '';
        if ('val' in copy) copy.val = '';
        return copy;
      }
      return item;
    });
  }
  if (headers && typeof headers === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      defineOwn(out, k, isSensitiveEntry(k, v) ? '' : v);
    }
    return out;
  }
  return headers;
}

function stripEnv(env) {
  if (Array.isArray(env)) {
    return env.map(item => {
      if (typeof item === 'string') {
        const eq = item.indexOf('=');
        if (eq <= 0) return item;
        const name = item.slice(0, eq).trim();
        const val = item.slice(eq + 1);
        return isSensitiveEntry(name, val) ? `${name}=` : item;
      }
      if (item && typeof item === 'object') {
        const name = item.name ?? item.key ?? '';
        const val = item.value ?? '';
        return isSensitiveEntry(name, val, item.secret)
          ? { ...item, value: '' }
          : { ...item };
      }
      return item;
    });
  }
  if (env && typeof env === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      defineOwn(out, k, isSensitiveEntry(k, v) ? '' : v);
    }
    return out;
  }
  return env;
}

function stripMcpServer(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return server;
  const out = { ...server };
  for (const field of DIRECT_SECRET_FIELDS) {
    if (field in out && typeof out[field] === 'string') out[field] = '';
  }
  for (const urlField of ['endpoint', 'url', 'serverUrl', 'httpUrl']) {
    if (urlField in out && typeof out[urlField] === 'string') {
      out[urlField] = stripEndpointCredentials(out[urlField]);
    }
  }
  if ('headers' in out && out.headers !== undefined) out.headers = stripHeaders(out.headers);
  if ('env' in out && out.env !== undefined) out.env = stripEnv(out.env);
  return out;
}

function stripMcpServers(mcpServers) {
  if (Array.isArray(mcpServers)) return mcpServers.map(stripMcpServer);
  if (mcpServers && typeof mcpServers === 'object') {
    const out = {};
    for (const [name, server] of Object.entries(mcpServers)) {
      defineOwn(out, name, stripMcpServer(server));
    }
    return out;
  }
  return mcpServers;
}

function stripProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const out = { ...profile, apiKey: '' };
  if ('headers' in profile && profile.headers !== undefined) out.headers = stripHeaders(profile.headers);
  if ('proxyUrl' in profile && typeof profile.proxyUrl === 'string') out.proxyUrl = stripProxyCredentials(profile.proxyUrl);
  return out;
}

/**
 * A public projection of a settings object with every credential removed. Used for the places
 * that only need to know whether a key is configured.
 */
export function withoutSecrets(settings) {
  if (!settings || typeof settings !== 'object') return { apiKey: '', profiles: [] };
  const out = {
    ...settings,
    apiKey: '',
    profiles: Array.isArray(settings.profiles) ? settings.profiles.map(stripProfile) : [],
  };
  if ('headers' in settings && settings.headers !== undefined) out.headers = stripHeaders(settings.headers);
  if ('proxyUrl' in settings && typeof settings.proxyUrl === 'string') out.proxyUrl = stripProxyCredentials(settings.proxyUrl);
  if ('globalProxyUrl' in settings && typeof settings.globalProxyUrl === 'string') out.globalProxyUrl = stripProxyCredentials(settings.globalProxyUrl);
  if ('mcpServers' in settings && settings.mcpServers !== undefined) out.mcpServers = stripMcpServers(settings.mcpServers);
  if ('servers' in settings && settings.servers !== undefined) out.servers = stripMcpServers(settings.servers);
  return out;
}
