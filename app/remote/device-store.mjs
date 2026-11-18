// The one record the page and the service worker both need.
//
// A service worker has no localStorage, so the device secret has to live in IndexedDB: the
// worker must derive the same key while the page is closed, which is the entire point of a
// notification. Nothing here leaves the phone, and the record carries no relay address.

const DB_NAME = 'harness-relay';
const DB_VERSION = 1;
const STORE = 'device';
const RECORD = 'current';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;

/** A record that cannot be used is not a record: a half-written value must not be trusted. */
export function validDevice(value) {
  if (!value || typeof value !== 'object') return null;
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.toLowerCase() : '';
  const token = typeof value.token === 'string' ? value.token : '';
  const secret = typeof value.secret === 'string' ? value.secret : '';
  if (!UUID.test(deviceId) || !SECRET.test(token) || !SECRET.test(secret)) return null;
  return { deviceId, token, secret };
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('这个浏览器不支持本地数据库。')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库。'));
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      // Request success is provisional; only transaction completion confirms persistence.
      let result;
      transaction.oncomplete = () => resolve(result);
      const request = run(transaction.objectStore(STORE));
      transaction.onerror = () => reject(transaction.error ?? new Error('本地数据库写入失败。'));
      transaction.onabort = () => reject(transaction.error ?? new Error('本地数据库写入被中断。'));
      if (request) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败。'));
      }
    });
  } finally {
    db.close();
  }
}

export async function readDevice() {
  try { return validDevice(await withStore('readonly', store => store.get(RECORD))); }
  catch { return null; }
}

export async function writeDevice(value) {
  const record = validDevice(value);
  if (!record) throw new Error('设备信息不完整，无法保存。');
  await withStore('readwrite', store => store.put(record, RECORD));
  return record;
}

export async function clearDevice() {
  await withStore('readwrite', store => store.delete(RECORD));
}
