// Turns selected games into training lines and cards, and picks what to study.
import { buildLines, normFen, uciOf, turnOf, sanPath } from './pgn.js';
import { data, getGames, gameColor, selectedGameIds, lib } from './store.js';
import { isDue, dayKey, dayStart, DAY } from './srs.js';
import { shuffle } from './util.js';

export function cardKey(node) {
  return `${normFen(node.parent.fen)}|${uciOf(node)}`;
}

/**
 * Training set for the given games.
 * lines: [{ id, gid, color, nodes, user: [{ idx, key }] }]
 * positions: Map(key -> { key, gid, color, node })
 */
export async function buildTrainingSet(gids, { onProgress, color: forcedColor } = {}) {
  const maxPlies = data.settings.maxMoves * 2;
  const games = await getGames(gids, onProgress);
  const lines = [];
  const positions = new Map();
  for (const game of games) {
    if (!game.root) continue;
    const color = forcedColor || gameColor(game.gid);
    for (const nodes of buildLines(game.root, color, maxPlies, node => data.moveChoices?.[normFen(node.fen)]?.uci)) {
      const user = [];
      nodes.forEach((node, idx) => {
        if (turnOf(node.parent.fen) !== color) return;
        const key = cardKey(node);
        user.push({ idx, key });
        if (!positions.has(key)) positions.set(key, { key, gid: game.gid, color, node });
      });
      if (user.length) lines.push({ id: `${game.gid}@${nodes[nodes.length - 1].id}`, gid: game.gid, color, nodes, user });
    }
  }
  return { lines, positions, gids };
}

let repertoireCache = null;

function repertoireSignature() {
  const sel = selectedGameIds().sort().map(g => `${g}=${data.selection[g]}`).join('|');
  return `${sel}#${data.settings.maxMoves}#${lib.scannedAt}#${JSON.stringify(data.moveChoices || {})}`;
}

/** Training set of everything selected for training (memoised until the selection changes). */
export async function repertoire(onProgress) {
  const sig = repertoireSignature();
  if (!repertoireCache || repertoireCache.sig !== sig) {
    repertoireCache = { sig, promise: buildTrainingSet(selectedGameIds(), { onProgress }) };
  }
  return repertoireCache.promise;
}

// ------------------------------------------------------------------ move conflicts

/**
 * Positions where the training set asks for two or more different moves (e.g. the author shows
 * alternatives in separate chapters). Returns [{ fen, options: [{ uci, san, node, gids }] }].
 */
export function findConflicts(set) {
  const byFen = new Map();
  for (const [key, pos] of set.positions) {
    const [fen, uci] = key.split('|');
    if (!byFen.has(fen)) byFen.set(fen, new Map());
    const m = byFen.get(fen);
    if (!m.has(uci)) m.set(uci, { uci, san: pos.node.san, node: pos.node, gids: new Set() });
  }
  // which games lead to each option
  for (const line of set.lines) {
    for (const u of line.user) {
      const [fen, uci] = u.key.split('|');
      byFen.get(fen)?.get(uci)?.gids.add(line.gid);
    }
  }
  return [...byFen.entries()].filter(([, m]) => m.size > 1)
    .map(([fen, m]) => ({ fen, options: [...m.values()].map(o => ({ ...o, gids: [...o.gids] })) }));
}

/** Your decision for a conflict: play this move here (lines with the other move end at this position). */
export function chooseMove(fen, option) {
  const path = sanPath(option.node.parent).join(' ');
  data.moveChoices = { ...(data.moveChoices || {}), [fen]: { uci: option.uci, san: option.san, path, gid: option.gids[0] } };
}

export function undoChoice(fen) {
  const { [fen]: _, ...rest } = data.moveChoices || {};
  data.moveChoices = rest;
}

/** Restrict a training set to one opening folder (Library source). */
export function filterSet(set, sourceId) {
  if (!sourceId) return set;
  const keep = gid => lib.games.get(gid)?.chapter.source.id === sourceId;
  const lines = set.lines.filter(l => keep(l.gid));
  const positions = new Map();
  for (const line of lines) for (const u of line.user) positions.set(u.key, set.positions.get(u.key));
  return { ...set, lines, positions, gids: set.gids.filter(keep) };
}

/** Opening folders that contain games selected for training. */
export function trainedSources() {
  const out = new Map();
  for (const gid of selectedGameIds()) {
    const src = lib.games.get(gid).chapter.source;
    out.set(src.id, src);
  }
  return [...out.values()];
}

export function invalidateRepertoire() {
  repertoireCache = null;
}

// ------------------------------------------------------------------ queues

export function dueKeys(set, now = Date.now()) {
  const cfg = data.settings.srs;
  return [...set.positions.keys()].filter(k => isDue(data.cards[k], now, cfg));
}

/**
 * Lines that cover all due cards. Each line is cut off before the first move you have not
 * learned yet, so a review never asks for a move you have never seen.
 */
export function reviewLines(set, now = Date.now()) {
  const due = new Set(dueKeys(set, now));
  const picked = [];
  for (const line of set.lines) {
    if (!due.size) break;
    const firstNew = line.user.findIndex(u => !data.cards[u.key]);
    const known = firstNew === -1 ? line.user : line.user.slice(0, firstNew);
    if (!known.some(u => due.has(u.key))) continue;
    for (const u of known) due.delete(u.key);
    const lastIdx = known[known.length - 1].idx;
    // keep the opponent's reply after your last known move, it often carries the explanation
    const end = firstNew === -1 ? line.nodes.length : Math.min(line.nodes.length, lastIdx + 2);
    picked.push({ ...line, nodes: line.nodes.slice(0, end), user: known });
  }
  return shuffle(picked);
}

/** Number of leading moves (plies) two lines have in common. */
function commonPlies(a, b) {
  let i = 0;
  while (i < a.nodes.length && i < b.nodes.length && a.nodes[i].fen === b.nodes[i].fen) i++;
  return i;
}

/**
 * Combine review lines that share a long trunk (at least `minMoves` full moves) into groups that
 * are played as a tree: the first branch from the start, every further branch from the position
 * where it leaves the previous one (line.startIdx). Groups are shuffled, branches stay in tree order.
 * Adds { group, part, parts, continuation } to every line.
 */
export function groupReviewLines(lines, minMoves) {
  if (!minMoves || lines.length < 2) {
    return lines.map((l, i) => ({ ...l, group: i, part: 1, parts: 1, continuation: false }));
  }
  const pathKey = l => l.nodes.map(n => n.san).join(' ');
  const sorted = lines.slice().sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : 1));
  // "really the same start": at least minMoves full moves AND at least 60 % of the shorter line
  const related = (a, b) => {
    const common = commonPlies(a, b);
    return common >= minMoves * 2 && common >= 0.6 * Math.min(a.nodes.length, b.nodes.length);
  };
  const groups = [];
  for (const line of sorted) {
    const g = groups[groups.length - 1];
    if (g && related(g[g.length - 1], line)) g.push(line);
    else groups.push([line]);
  }
  return shuffle(groups).flatMap((g, gi) => {
    const parts = g
      .map((line, i) => ({ ...line, startIdx: i === 0 ? 0 : commonPlies(g[i - 1], line) }))
      .filter(l => l.startIdx < l.nodes.length); // nothing left to play after the shared part
    return parts.map((line, i) => ({ ...line, group: gi, part: i + 1, parts: parts.length, continuation: i > 0 }));
  });
}

// ------------------------------------------------------------------ learning stages
// "Foundation first": all lines are learned up to move 6, then up to 10, then 15, then full depth.

const moveNo = node => Math.floor((node.ply - 1) / 2) + 1;

/** Depth limits (in full moves) of the learning stages; the last one is the full line depth. */
export function learnStages() {
  const s = data.settings;
  if (!s.stagedLearning) return [s.maxMoves];
  return [...(s.learnStages || []).filter(d => d < s.maxMoves), s.maxMoves];
}

export function stageLabel(i, stages = learnStages()) {
  if (stages.length === 1) return 'full lines';
  const from = i === 0 ? 1 : stages[i - 1] + 1;
  return i === stages.length - 1 ? `from move ${from} to the end` : `moves ${from}–${stages[i]}`;
}

/** Stage index (0-based) of a card = first stage whose depth reaches the move. */
function stageOf(node, stages) {
  const n = moveNo(node);
  const i = stages.findIndex(d => n <= d);
  return i === -1 ? stages.length - 1 : i;
}

// cost of a single mistake by depth: up to move 6 full, up to 10, up to 15, beyond
const SEVERITY_DEPTHS = [6, 10, 15];
const SEVERITY_BY_STAGE = [1, 0.6, 0.4, 0.25];

/**
 * How much a single mistake on this move should cost (1 = full lapse). Early moves matter most;
 * deep moves are rarely reached in a game. Key moves (!, !!, only move) always count fully.
 */
export function mistakeSeverity(node) {
  if (!data.settings.forgiveLateSlips) return 1;
  if (node.nags.some(n => n === 1 || n === 3 || n === 7)) return 1;
  const i = SEVERITY_DEPTHS.findIndex(d => moveNo(node) <= d);
  return SEVERITY_BY_STAGE[i === -1 ? SEVERITY_BY_STAGE.length - 1 : i];
}

/** Per stage: { total, learned } move counts, plus the stage you are currently in. */
export function stageProgress(set) {
  const stages = learnStages();
  const rows = stages.map((depth, i) => ({ depth, label: stageLabel(i, stages), total: 0, learned: 0 }));
  for (const [key, pos] of set.positions) {
    const r = rows[stageOf(pos.node, stages)];
    r.total++;
    if (data.cards[key]) r.learned++;
  }
  const current = rows.findIndex(r => r.learned < r.total);
  return { stages: rows, current };
}

/**
 * New lines to learn, foundation first: every line is cut at the current stage depth, and a
 * deeper stage only starts when all moves of the shallower stages are learned.
 * Returned lines carry { stage, depth } for display.
 */
export function newLines(set, limit = Infinity) {
  const stages = learnStages();
  const covered = new Set();
  const picked = [];
  for (let si = 0; si < stages.length && picked.length < limit; si++) {
    const depth = stages[si];
    for (const line of set.lines) {
      if (picked.length >= limit) break;
      let end = line.nodes.findIndex(n => moveNo(n) > depth);
      if (end === -1) end = line.nodes.length;
      const user = line.user.filter(u => u.idx < end);
      const fresh = user.filter(u => !data.cards[u.key] && !covered.has(u.key));
      if (!fresh.length) continue;
      fresh.forEach(u => covered.add(u.key));
      // end on your last move of this stage (plus the opponent's reply, which often carries the explanation)
      const cut = Math.min(end, user[user.length - 1].idx + 2);
      picked.push({ ...line, id: `${line.id}@${depth}`, nodes: line.nodes.slice(0, cut), user, stage: si + 1, depth });
    }
  }
  return picked;
}

export function countNew(set) {
  let n = 0;
  for (const k of set.positions.keys()) if (!data.cards[k]) n++;
  return n;
}

// ------------------------------------------------------------------ review plan

/** How many moves are due now, later today, tomorrow and within a week. */
export function reviewPlan(set, now = Date.now()) {
  const cfg = data.settings.srs;
  const today = dayStart(now, cfg);
  const plan = { now: 0, laterToday: 0, nextToday: null, tomorrow: 0, week: 0, nextDay: null };
  for (const k of set.positions.keys()) {
    const c = data.cards[k];
    if (!c) continue;
    if (isDue(c, now, cfg)) plan.now++;
    else if (c.due < today + DAY) {
      plan.laterToday++;
      if (!plan.nextToday || c.due < plan.nextToday) plan.nextToday = c.due;
    } else if (c.due < today + 2 * DAY) plan.tomorrow++;
    else if (c.due < today + 7 * DAY) {
      plan.week++;
      if (!plan.nextDay || c.due < plan.nextDay) plan.nextDay = c.due;
    } else if (!plan.nextDay || c.due < plan.nextDay) plan.nextDay = c.due;
  }
  return plan;
}

/** Lines containing moves learned today, cut after the last learned move – for a quick recap. */
export function recapLines(set, now = Date.now()) {
  const today = dayStart(now, data.settings.srs);
  const fresh = new Set([...set.positions.keys()].filter(k => data.cards[k]?.created >= today));
  const picked = [];
  const covered = new Set();
  for (const line of set.lines) {
    const firstNew = line.user.findIndex(u => !data.cards[u.key]);
    const known = firstNew === -1 ? line.user : line.user.slice(0, firstNew);
    const todays = known.filter(u => fresh.has(u.key) && !covered.has(u.key));
    if (!todays.length) continue;
    todays.forEach(u => covered.add(u.key));
    const end = firstNew === -1 ? line.nodes.length : Math.min(line.nodes.length, known[known.length - 1].idx + 2);
    picked.push({ ...line, nodes: line.nodes.slice(0, end), user: known });
  }
  return picked;
}

export function newLinesToday(now = Date.now()) {
  return data.newLines[dayKey(now, data.settings.srs)] || 0;
}

export function newLinesLeftToday(now = Date.now()) {
  return Math.max(0, data.settings.newLinesPerDay - newLinesToday(now));
}

export function recordNewLine(now = Date.now()) {
  const k = dayKey(now, data.settings.srs);
  data.newLines[k] = (data.newLines[k] || 0) + 1;
}

/** Store info needed to find a card's position again (for stats / hardest moves). */
export function cardRef(pos) {
  return { g: pos.gid, p: sanPath(pos.node).join(' '), c: pos.color };
}
