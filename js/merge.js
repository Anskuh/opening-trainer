// Merges the training data of two devices. Pure functions, no DOM or network.

/** The part of the user data that is shared between devices (not the local save revision). */
export function syncable(data) {
  const { rev, ...rest } = data;
  return rest;
}

/** JSON with sorted object keys, so equal data always gives equal text. */
export function stableStringify(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const unionBy = (a = [], b = [], key) => {
  const seen = new Map();
  for (const item of [...a, ...b]) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
};

function mergeCards(a = {}, b = {}, resetAt) {
  const out = {};
  for (const [key, card] of [...Object.entries(a), ...Object.entries(b)]) {
    if (Math.max(card.last || 0, card.created || 0) <= resetAt) continue;
    const cur = out[key];
    // the most recently reviewed version wins; on a tie the one with more reviews
    if (!cur || (card.last || 0) > (cur.last || 0)
      || ((card.last || 0) === (cur.last || 0) && (card.reps || 0) > (cur.reps || 0))) {
      out[key] = card;
    }
  }
  return out;
}

function mergeNotes(a, b) {
  const deleted = { ...(a.notesDeleted || {}) };
  for (const [fen, t] of Object.entries(b.notesDeleted || {})) deleted[fen] = Math.max(deleted[fen] || 0, t);
  const notes = {};
  for (const [fen, note] of [...Object.entries(a.notes || {}), ...Object.entries(b.notes || {})]) {
    if ((deleted[fen] || 0) >= (note.updated || 0)) continue;
    if (!notes[fen] || (note.updated || 0) > (notes[fen].updated || 0)) notes[fen] = note;
  }
  for (const fen of Object.keys(notes)) delete deleted[fen];
  return { notes, notesDeleted: deleted };
}

function maxPerKey(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
}

// What you chose to train, and how you named it: the whole group follows the last change.
const SELECTION_FIELDS = ['selection', 'moveChoices', 'sources', 'chapters'];

/** Merge local data with the remote copy (remote may be null). Neither input is changed. */
export function mergeUserData(local, remoteData) {
  // nothing uploaded yet: still normalise, so the second sync does not see a difference
  const remote = remoteData || local;
  const out = { ...remote, ...local };
  const ls = local.stamps || {};
  const rs = remote.stamps || {};
  out.stamps = { selection: Math.max(ls.selection || 0, rs.selection || 0), settings: Math.max(ls.settings || 0, rs.settings || 0) };

  // a device only keeps its own version if it changed it more recently than the other one
  for (const f of SELECTION_FIELDS) {
    out[f] = ((ls.selection || 0) > (rs.selection || 0) ? local[f] : remote[f]) ?? local[f] ?? remote[f] ?? {};
  }
  out.settings = (ls.settings || 0) > (rs.settings || 0) ? local.settings : (remote.settings ?? local.settings);

  const resetAt = Math.max(local.resetAt || 0, remote.resetAt || 0);
  out.resetAt = resetAt;
  out.cards = mergeCards(local.cards, remote.cards, resetAt);
  out.log = unionBy(local.log, remote.log, e => `${e[0]}|${e[1]}|${e[4]}`)
    .filter(e => e[0] > resetAt)
    .sort((x, y) => x[0] - y[0]);
  out.sessions = unionBy(local.sessions, remote.sessions, s => `${s.start}|${s.mode}`)
    .filter(s => s.start > resetAt)
    .sort((x, y) => x.start - y.start);
  Object.assign(out, mergeNotes(local, remote));
  out.newLines = maxPerKey(local.newLines, remote.newLines);
  out.settingsVersion = Math.max(local.settingsVersion || 0, remote.settingsVersion || 0);
  return out;
}
