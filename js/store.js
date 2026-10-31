// User data (progress, notes, settings) + the opening library and parsed games.
import { api } from './api.js';
import { DEFAULT_SRS, dayStart, DAY } from './srs.js';
import { splitGames, parseGame } from './pgn.js';
import { cacheGet, cacheSet } from './idb.js';
import { debounce } from './util.js';

export const DEFAULT_SETTINGS = {
  maxMoves: 25, // training depth per line, in full moves
  newLinesPerDay: 5,
  boardTheme: 'brown',
  sound: true,
  slowSeconds: 20, // a correct move slower than this counts as "Hard"
  autoplayDelay: 150, // ms before the opponent replies
  mistakesBeforeAnswer: 2,
  showCommentsInDrill: true,
  showNotesInDrill: true,
  autoplayKnown: true, // in reviews, auto-play later moves you know that are not due
  alwaysPlayUntil: 10, // ...but up to this move number you always play your moves yourself
  combineMinMoves: 4, // reviews: lines sharing at least this many moves (and 60 % of the shorter line) are played as one tree (0 = off)
  forgiveLateSlips: true, // a single mistake deep in a line costs less than an early one
  engineDepth: 22, // Stockfish search depth in Study
  afkMinutes: 2, // stop a training session after this long without any activity (0 = never)
  stagedLearning: true, // foundation first: learn all lines up to learnStages[0], then deeper
  learnStages: [10], // full moves; the last stage is always maxMoves (so: two stages)
  srs: { ...DEFAULT_SRS },
};

// ------------------------------------------------------------------ user data

/**
 * data.sources[sourceId]   = { color, title }       default side + optional rename
 * data.chapters[chapterId] = { color, title }
 * data.selection[gameId]   = 'w' | 'b'             games in training and the side you play
 * data.cards[key]          = SRS card + { g: gameId, p: 'e4 c6 d4', c: colour }
 * data.notes[normFen]      = { text, updated, g, p }
 * data.log                 = [[time, cardKey, grade, ms, mode, ply]]
 * data.sessions            = [{ start, end, mode, lines, moves, mistakes }]
 * data.newLines[dayKey]    = number of new lines learned that day
 */
export const data = {};

function defaults() {
  return {
    version: 1, settings: structuredClone(DEFAULT_SETTINGS), sources: {}, chapters: {}, selection: {},
    cards: {}, notes: {}, log: [], sessions: [], newLines: {},
  };
}

export const bus = new EventTarget();
export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Fill in settings that are missing (e.g. data written by an older version). */
export function normalizeSettings() {
  const s = data.settings || {};
  data.settings = { ...DEFAULT_SETTINGS, ...s, srs: { ...DEFAULT_SRS, ...(s.srs || {}) } };
}

export async function loadUserData() {
  const raw = await api.loadUserData();
  Object.assign(data, defaults(), raw);
  normalizeSettings();
  // v2: the old default learning steps (10 min, 4 h) made you come back the same day
  if ((data.settingsVersion || 1) < 2) {
    if (JSON.stringify(data.settings.srs.learningSteps) === '[10,240]') {
      data.settings.srs.learningSteps = [10];
      // moves waiting for the old 4-hour step were answered correctly: review them tomorrow instead
      // (moves that are already due stay due and graduate when you answer them)
      const now = Date.now();
      const tomorrow = dayStart(now, data.settings.srs) + DAY;
      for (const c of Object.values(data.cards)) {
        if (c.state === 'learning' && c.step >= 1 && c.due > now) Object.assign(c, { state: 'review', step: 0, ivl: 1, due: tomorrow });
      }
    }
    data.settingsVersion = 2;
  }
  // v3: reviews only ask the moves that are due (the rest is played for you)
  if (data.settingsVersion < 3) {
    data.settings.autoplayKnown = true;
    data.settingsVersion = 3;
  }
  // v4: two learning stages instead of four
  if (data.settingsVersion < 4) {
    if (JSON.stringify(data.settings.learnStages) === '[6,10,15]') data.settings.learnStages = [10];
    data.settingsVersion = 4;
  }
  // v5: the opponent replies faster (stamped, or a sync would bring the old value back)
  if (data.settingsVersion < 5) {
    if (data.settings.autoplayDelay === 450) {
      data.settings.autoplayDelay = DEFAULT_SETTINGS.autoplayDelay;
      stamp('settings');
    }
    data.settingsVersion = 5;
  }
}

let dirty = false;
let conflict = false;
let saving = Promise.resolve();
// Saves are chained: each one is based on the revision the previous one returned.
// The server rejects a save based on an outdated revision (data changed elsewhere).
const flush = debounce(() => {
  saving = saving
    .then(async () => {
      if (!dirty || conflict) return;
      dirty = false;
      const res = await api.saveUserData(JSON.stringify(data));
      if (res.conflict) {
        conflict = true;
        emit('conflict');
        return;
      }
      data.rev = res.rev;
      emit('saved');
    })
    .catch(e => {
      dirty = true;
      emit('save-error', e);
    });
}, 700);

// Selections and settings are shared as a whole: the device that changed them last wins.
function stamp(what) {
  const group = what === 'settings' ? 'settings' : (what === 'selection' || what === 'data') ? 'selection' : null;
  if (group) data.stamps = { ...(data.stamps || {}), [group]: Date.now() };
}

/** Mark user data as changed; it is written to data/userdata.json shortly after. */
export function save(what = 'data') {
  stamp(what);
  dirty = true;
  flush();
  emit('change', what);
}

/** Save right away (end of a line / session). */
export function saveNow(what = 'data') {
  if (what !== 'cards') stamp(what);
  dirty = true;
  emit('change', what);
  flush();
  flush.now();
}

// last-chance save when the window closes (the page is gone afterwards, so no revision bookkeeping)
function beacon() {
  if (dirty && !conflict) {
    dirty = false;
    api.saveUserDataBeacon(JSON.stringify(data));
  }
}
/** Delete a note so that it does not come back from another device. */
export function deleteNote(fen) {
  delete data.notes[fen];
  data.notesDeleted = { ...(data.notesDeleted || {}), [fen]: Date.now() };
}

window.addEventListener('beforeunload', beacon);
window.addEventListener('pagehide', beacon);
// switching to another window: normal save, the page lives on
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) flush.now();
});

// ------------------------------------------------------------------ library

export const lib = { sources: [], chapters: new Map(), games: new Map(), scannedAt: 0 };

export async function loadLibrary() {
  const r = await api.library();
  lib.sources = r.sources;
  lib.scannedAt = r.scannedAt;
  lib.chapters.clear();
  lib.games.clear();
  for (const src of lib.sources) {
    for (const ch of src.chapters) {
      ch.source = src;
      ch.gameIds = ch.games.map((headers, index) => {
        const gid = `${ch.id}#${index}`;
        lib.games.set(gid, { gid, chapter: ch, index, headers });
        return gid;
      });
    }
  }
  // parsed games may be stale if a file changed on disk
  for (const [gid, entry] of parsedGames) {
    const meta = lib.games.get(gid);
    if (!meta || entry.stamp !== stampOf(meta.chapter)) parsedGames.delete(gid);
  }
  chapterTexts.clear();
  emit('library');
}

const isPlaceholder = v => !v || ['?', '-', ''].includes(v.trim());
const isPerson = v => !!v && /\w, \w/.test(v);
const surname = v => v.split(',')[0];

export function gameTitle(headers) {
  const { White: w, Black: b, Event: ev, Date: date } = headers;
  if (isPerson(w) && isPerson(b)) {
    const year = date && /^\d{4}/.test(date) ? date.slice(0, 4) : '';
    return `${surname(w)} – ${surname(b)}${year ? `, ${year}` : ''}`;
  }
  return [w, b, ev].filter(v => !isPlaceholder(v)).join(' · ') || 'Untitled';
}

export function gameSubtitle(headers) {
  const { White: w, Black: b, Event: ev, Result: res, ECO: eco } = headers;
  const parts = [];
  if (isPerson(w) && isPerson(b) && !isPlaceholder(ev)) parts.push(ev);
  if (eco) parts.push(eco);
  if (res && res !== '*') parts.push(res);
  return parts.join(' · ');
}

/** A real game between players (the server decides; see is_model_game in server.py). */
export function isModelGame(headers) {
  if (typeof headers._model === 'boolean') return headers._model;
  const decided = ['1-0', '0-1', '1/2-1/2'].includes(headers.Result);
  return (isPerson(headers.White) && isPerson(headers.Black))
    || (decided && (isPerson(headers.White) || isPerson(headers.Black)));
}

export const MODEL_FOLDER = 'Model games';

export function isModelSource(src) {
  return src.id.split('/').pop() === MODEL_FOLDER;
}

export function chapterTitle(ch) {
  return data.chapters[ch.id]?.title || ch.title;
}

export function sourceTitle(src) {
  return data.sources[src.id]?.title || src.title;
}

/** Side the user plays for a game: explicit selection, else chapter default, else source default. */
export function defaultColor(meta) {
  return data.chapters[meta.chapter.id]?.color || data.sources[meta.chapter.source.id]?.color || null;
}

export function gameColor(gid) {
  const meta = lib.games.get(gid);
  return data.selection[gid] || (meta && defaultColor(meta)) || 'w';
}

export function selectedGameIds() {
  return Object.keys(data.selection).filter(gid => lib.games.has(gid));
}

// ------------------------------------------------------------------ parsed games

const PARSER_VERSION = 2;
const parsedGames = new Map(); // gid -> { stamp, promise }
const chapterTexts = new Map(); // chapterId -> Promise<splitGames result>

const stampOf = ch => `${PARSER_VERSION}:${ch.mtime}:${ch.size}`;

function chapterGames(ch) {
  if (!chapterTexts.has(ch.id)) chapterTexts.set(ch.id, api.pgn(ch.id).then(splitGames));
  return chapterTexts.get(ch.id);
}

function serialize(g) {
  return {
    headers: g.headers,
    errors: g.errors,
    nodes: g.nodes.map(n => [n.parent ? n.parent.id : -1, n.san, n.from, n.to, n.promotion, n.fen,
      n.comment, n.pre, n.nags, n.shapes]),
  };
}

function deserialize(s) {
  const nodes = [];
  for (const [p, san, from, to, promotion, fen, comment, pre, nags, shapes] of s.nodes) {
    const parent = p >= 0 ? nodes[p] : null;
    const fp = fen.split(' ');
    const node = {
      id: nodes.length, san, from, to, promotion, fen, comment, pre, nags, shapes, parent, children: [],
      ply: parent ? parent.ply + 1 : (parseInt(fp[5], 10) - 1) * 2 + (fp[1] === 'b' ? 1 : 0),
    };
    if (parent) parent.children.push(node);
    nodes.push(node);
  }
  return { headers: s.headers, errors: s.errors, root: nodes[0], nodes };
}

async function loadGame(meta) {
  const stamp = stampOf(meta.chapter);
  const cached = await cacheGet(meta.gid);
  let g;
  if (cached && cached.stamp === stamp) {
    g = deserialize(cached);
  } else {
    const games = await chapterGames(meta.chapter);
    const src = games[meta.index];
    if (!src) throw new Error(`Game ${meta.gid} not found in file`);
    g = parseGame(src);
    if (g.root) cacheSet(meta.gid, { stamp, ...serialize(g) });
  }
  g.gid = meta.gid;
  g.meta = meta;
  return g;
}

/** Parsed game tree (cached in memory and IndexedDB). */
export function getGame(gid) {
  const meta = lib.games.get(gid);
  if (!meta) return Promise.reject(new Error(`Unknown game ${gid}`));
  let entry = parsedGames.get(gid);
  if (!entry) {
    entry = { stamp: stampOf(meta.chapter), promise: loadGame(meta) };
    entry.promise.catch(() => parsedGames.delete(gid));
    parsedGames.set(gid, entry);
  }
  return entry.promise;
}

/** Load many games, yielding to the UI between games. */
export async function getGames(gids, onProgress) {
  const out = [];
  for (let i = 0; i < gids.length; i++) {
    const cachedInMemory = parsedGames.has(gids[i]);
    try {
      out.push(await getGame(gids[i]));
    } catch (e) {
      console.warn(e);
    }
    if (!cachedInMemory) {
      onProgress?.(i + 1, gids.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return out;
}
