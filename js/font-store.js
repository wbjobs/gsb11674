/**
 * FontStore — IndexedDB 持久化：加载记录 / 回退记录 / 使用统计
 */
export class FontStore {
  constructor(dbName = 'font-manager-db') {
    this.dbName = dbName;
    this.db = null;
    this._ready = null;
  }

  open() {
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['loads', 'fallbacks', 'usage']) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          }
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
    return this._ready;
  }

  async add(storeName, data) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).add(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAll(storeName, limit = 100) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve((req.result || []).slice(-limit).reverse());
      req.onerror = () => reject(req.error);
    });
  }

  async clear(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAll() {
    for (const name of ['loads', 'fallbacks', 'usage']) {
      await this.clear(name).catch(() => {});
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._ready = null;
    }
  }
}
