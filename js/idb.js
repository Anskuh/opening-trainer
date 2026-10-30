// Tiny IndexedDB key/value cache for parsed games (parsing big PGNs is slow).
const DB_NAME = 'chess-openings-cache';
const STORE = 'games';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export async function cacheGet(key) {
  const db = await open();
  if (!db) return undefined;
  return new Promise(resolve => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

export async function cacheSet(key, value) {
  const db = await open();
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function cacheClear() {
  const db = await open();
  if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ------------------------------------------------------------------ device storage (phone)
// Courses and training data live here when there is no local server. Kept apart from the
// game cache above, which may be thrown away at any time.
const KV_DB = 'chess-openings-device';
const KV_STORE = 'kv';
let kvPromise = null;

function kvOpen() {
  if (!kvPromise) {
    kvPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(KV_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(KV_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return kvPromise;
}

export async function kvGet(key) {
  const db = await kvOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(KV_STORE).objectStore(KV_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key, value) {
  const db = await kvOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvDelete(key) {
  const db = await kvOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
