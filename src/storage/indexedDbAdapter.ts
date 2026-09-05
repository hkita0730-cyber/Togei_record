import type { StorageAdapter } from './StorageAdapter';

const DB_NAME = 'tougei-kiroku';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export const indexedDbAdapter: StorageAdapter = {
  async get(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  },

  async set(key, value) {
    try {
      const db = await openDb();
      return await new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  async delete(key) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* best-effort delete; nothing to roll back client-side */
    }
  },

  async list(prefix) {
    const db = await openDb();
    return new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const keys: string[] = [];
      const req = store.openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const k = String(cursor.key);
          if (k.startsWith(prefix)) keys.push(k);
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },
};

// Turns a low-level storage failure into a short, specific Japanese message
// so the UI can tell the person *why* a save failed instead of just "failed".
export function describeStorageError(err: unknown): string {
  if (typeof indexedDB === 'undefined') {
    return 'このブラウザはデータの保存に対応していません。別のブラウザ(Chrome、Safariなど)でお試しください。';
  }
  if (err instanceof DOMException) {
    if (err.name === 'QuotaExceededError') {
      return 'この端末の保存容量が上限に達しました。写真の多い作品を減らすか、不要な作品・アイディアを削除してください。';
    }
  }
  return '保存中に問題が発生しました。プライベートブラウジング(シークレット)モードの場合は保存に対応していないことがあります。';
}
