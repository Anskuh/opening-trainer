// Where the data lives. On the laptop: the local Python server (app/server.py).
// On the phone there is no server: courses and training data are in the device's own storage.
import { kvGet, kvSet } from './idb.js';

async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

let serverMode = true;

/** Call once at startup, before anything else from this module. */
export async function detectMode() {
  if (location.hostname.endsWith('github.io')) {
    serverMode = false;
    return;
  }
  try {
    await fetch('/api/ping').then(json);
  } catch (e) {
    serverMode = false;
  }
}

export const isServer = () => serverMode;

const onlyOnLaptop = () => Promise.reject(new Error('This only works in the laptop app.'));

const device = {
  library: async () => (await kvGet('library')) || { sources: [], scannedAt: 0 },
  pgn: async id => {
    const text = await kvGet(`pgn:${id}`);
    if (text === undefined) throw new Error(`Could not load ${id}`);
    return text;
  },
  loadUserData: async () => {
    const text = await kvGet('userdata');
    return text ? JSON.parse(text) : {};
  },
  saveUserData: async text => {
    await kvSet('userdata', text);
    return { rev: 0 };
  },
  saveUserDataBeacon: text => { kvSet('userdata', text); },
  importPgn: onlyOnLaptop,
  organize: onlyOnLaptop,
  saveGame: onlyOnLaptop,
  openFolder: onlyOnLaptop,
  ping: async () => ({ ok: true }),
};

const server = {
  library: () => fetch('/api/library').then(json),
  pgn: async id => {
    const res = await fetch(`/api/pgn?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Could not load ${id}`);
    return res.text();
  },
  loadUserData: () => fetch('/api/userdata').then(json),
  /** Resolves { rev } on success or { conflict: true } if the data was changed elsewhere. */
  saveUserData: async text => {
    const res = await fetch('/api/userdata', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
    });
    if (res.status === 409) return { conflict: true };
    return json(res);
  },
  saveUserDataBeacon: text => navigator.sendBeacon('/api/userdata', new Blob([text], { type: 'application/json' })),
  importPgn: (name, pgn) => fetch('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pgn }),
  }).then(json),
  organize: async body => {
    const res = await fetch('/api/organize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || res.statusText);
    return out;
  },
  /** Replace one game of a chapter file (pgn = null deletes it). */
  saveGame: async (id, index, pgn) => {
    const res = await fetch('/api/save-game', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, index, pgn }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || res.statusText);
    return out;
  },
  openFolder: path => fetch('/api/open-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  }).then(json),
  ping: () => fetch('/api/ping').then(json),
};

export const api = new Proxy({}, { get: (_, name) => (serverMode ? server : device)[name] });
