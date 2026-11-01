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

/**
 * A public projection of a settings object with every credential removed. Used for the places
 * that only need to know whether a key is configured.
 */
export function withoutSecrets(settings) {
  const strip = profile => ({ ...profile, apiKey: '' });
  return { ...settings, apiKey: '', profiles: (settings.profiles ?? []).map(strip) };
}
