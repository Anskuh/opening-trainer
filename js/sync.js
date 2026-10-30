// Keeps the laptop and the phone in step through the private GitHub repository.
// Training data: both devices merge (see merge.js). Courses: the laptop publishes, the phone downloads.
import { api, isServer } from './api.js';
import { kvGet, kvSet, kvDelete } from './idb.js';
import { data, emit, saveNow, normalizeSettings, loadLibrary } from './store.js';
import { mergeUserData, syncable, stableStringify } from './merge.js';
import { getConfig, getFile, putFile, listFiles, getBlob, commitFiles, GitHubError } from './github.js';
import { debounce } from './util.js';

const USERDATA_FILE = 'userdata.json';
const LIBRARY_FILE = 'library.json';
const LAST_SYNC_KEY = 'lastSync';

export const syncState = { running: false, error: null, paused: false };

export function lastSync() {
  try {
    return +localStorage.getItem(LAST_SYNC_KEY) || 0;
  } catch (e) {
    return 0;
  }
}

const chapterSig = ch => `${ch.mtime}:${ch.size}`;
const allChapters = library => library.sources.flatMap(s => s.chapters);

// ------------------------------------------------------------------ courses

/** Laptop: publish new or changed course files to the private repository. */
async function pushLibrary() {
  const local = await api.library();
  const remoteFile = await getFile(LIBRARY_FILE);
  const remote = remoteFile ? JSON.parse(remoteFile.text) : { sources: [] };
  const remoteSigs = new Map(allChapters(remote).map(ch => [ch.id, chapterSig(ch)]));
  const localChapters = allChapters(local);
  const changed = localChapters.filter(ch => remoteSigs.get(ch.id) !== chapterSig(ch));
  const localIds = new Set(localChapters.map(ch => ch.id));
  const removed = [...remoteSigs.keys()].filter(id => !localIds.has(id));
  const sameList = JSON.stringify(local.sources.map(s => [s.id, s.title, s.chapters.map(c => c.id)]))
    === JSON.stringify(remote.sources.map(s => [s.id, s.title, s.chapters.map(c => c.id)]));
  if (!changed.length && !removed.length && sameList) return false;

  const files = { [LIBRARY_FILE]: JSON.stringify(local) };
  for (const ch of changed) files[`library/${ch.id}`] = await api.pgn(ch.id);
  await commitFiles(files, removed.map(id => `library/${id}`), `Courses: ${changed.length} updated, ${removed.length} removed`);
  return true;
}

/** Phone: download new or changed course files. The old courses stay usable until all arrived. */
async function pullLibrary(onProgress) {
  const remoteFile = await getFile(LIBRARY_FILE);
  if (!remoteFile) return false;
  const stored = (await kvGet('librarySig')) || '';
  if (stored === remoteFile.sha) return false;
  const remote = JSON.parse(remoteFile.text);
  const have = (await kvGet('library')) || { sources: [] };
  const haveSigs = new Map(allChapters(have).map(ch => [ch.id, chapterSig(ch)]));
  const chapters = allChapters(remote);
  const todo = chapters.filter(ch => haveSigs.get(ch.id) !== chapterSig(ch));
  const shas = todo.length ? await listFiles() : new Map();
  let done = 0;
  onProgress?.(done, todo.length);
  const queue = todo.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const ch = queue.shift();
      const sha = shas.get(`library/${ch.id}`);
      if (!sha) throw new GitHubError(404, `Course file missing: ${ch.id}`);
      await kvSet(`pgn:${ch.id}`, await getBlob(sha));
      onProgress?.(++done, todo.length);
    }
  }));
  const ids = new Set(chapters.map(ch => ch.id));
  await kvSet('library', remote);
  await kvSet('librarySig', remoteFile.sha);
  for (const ch of allChapters(have)) if (!ids.has(ch.id)) await kvDelete(`pgn:${ch.id}`);
  await loadLibrary();
  return true;
}

// ------------------------------------------------------------------ training data

/** Merge with the remote copy and upload the result. Retries if the other device wrote meanwhile. */
async function syncUserData() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remoteFile = await getFile(USERDATA_FILE);
    const remote = remoteFile ? JSON.parse(remoteFile.text) : null;
    const before = stableStringify(syncable(data));
    Object.assign(data, mergeUserData(syncable(data), remote));
    normalizeSettings();
    const text = stableStringify(syncable(data));
    const changedHere = text !== before;
    if (!remoteFile || text !== stableStringify(remote)) {
      try {
        await putFile(USERDATA_FILE, text, remoteFile?.sha, `Training data from ${isServer() ? 'laptop' : 'phone'}`);
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
        throw e;
      }
    }
    return changedHere;
  }
  return false;
}

// ------------------------------------------------------------------ public

let running = null;
let pending = false;

/** Sync now. Never throws: failures (e.g. no internet) end up in syncState.error, training goes on. */
export function syncNow({ library = true, onProgress } = {}) {
  if (!getConfig()) return Promise.resolve();
  if (syncState.paused) {
    pending = true;
    return Promise.resolve();
  }
  if (running) return running;
  running = (async () => {
    syncState.running = true;
    emit('sync-state');
    let libraryChanged = false;
    let dataChanged = false;
    try {
      if (library) libraryChanged = isServer() ? (await pushLibrary(), false) : await pullLibrary(onProgress);
      dataChanged = await syncUserData();
      if (dataChanged) saveNow('cards');
      syncState.error = null;
      localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    } catch (e) {
      syncState.error = e;
    } finally {
      syncState.running = false;
      running = null;
      emit('sync-state');
      if (dataChanged || libraryChanged) emit('synced');
    }
  })();
  return running;
}

/** While a training session runs nothing is merged in, so the session is not disturbed. */
export function pauseSync(paused) {
  const wasPaused = syncState.paused;
  syncState.paused = paused;
  // the end of a session is the moment to upload: the app may be closed right afterwards
  if (wasPaused && !paused) {
    pending = false;
    syncNow({ library: false });
  }
}

const syncSoon = debounce(() => syncNow({ library: false }), 30 * 1000);

/** Automatic syncing: after changes, and when coming back to the app. */
export function startAutoSync(bus) {
  bus.addEventListener('change', syncSoon);
  bus.addEventListener('library', () => { if (isServer()) syncNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      syncSoon.now();
    } else if (Date.now() - lastSync() > 2 * 60 * 1000) {
      syncNow();
    }
  });
}

/** Text for the status line in Settings. */
export function describeSync() {
  if (!getConfig()) return 'Not set up';
  if (syncState.running) return 'Syncing…';
  if (syncState.error) {
    const s = syncState.error.status;
    if (s === 401) return 'Not synced: the token is no longer valid.';
    if (s === 403 || s === 404) return 'Not synced: no access to the repository – check the token.';
    return `Not synced: ${syncState.error.message || 'no connection'}. It will try again.`;
  }
  const t = lastSync();
  return t ? `Last synced ${new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not synced yet';
}

