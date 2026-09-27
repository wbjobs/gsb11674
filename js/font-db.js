/* IndexedDB 持久化：回退记录 + 加载统计 */
const DB_NAME = 'font-manager-db';
const DB_VERSION = 1;
const STORE_FALLBACKS = 'fallbackRecords';
const STORE_STATS = 'loadStats';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_FALLBACKS)) {
        const store = db.createObjectStore(STORE_FALLBACKS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byFamily', 'family', { unique: false });
        store.createIndex('byTime', 'time', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STATS)) {
        const store = db.createObjectStore(STORE_STATS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byFamily', 'family', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    fn(store);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function addFallbackRecord(record) {
  const db = await openDB();
  return tx(db, STORE_FALLBACKS, 'readwrite', (s) => s.add(record));
}

export async function getFallbackRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_FALLBACKS, 'readonly');
    const req = t.objectStore(STORE_FALLBACKS).index('byTime').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function clearFallbackRecords() {
  const db = await openDB();
  return tx(db, STORE_FALLBACKS, 'readwrite', (s) => s.clear());
}

export async function addLoadStat(stat) {
  const db = await openDB();
  return tx(db, STORE_STATS, 'readwrite', (s) => s.add(stat));
}

export async function getLoadStats() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_STATS, 'readonly');
    const req = t.objectStore(STORE_STATS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export function closeDB() {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
}
