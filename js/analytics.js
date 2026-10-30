// Statistics derived from the review log.
import { data } from './store.js';
import { dayKey, dayStart, DAY } from './srs.js';

// log entry layout: [time, cardKey, grade, ms, mode, ply, prevInterval, prevState]
export const L = { T: 0, KEY: 1, GRADE: 2, MS: 3, MODE: 4, PLY: 5, IVL: 6, STATE: 7 };

export function logReview(entry) {
  data.log.push([
    entry.t, entry.key, entry.grade, Math.round(entry.ms), entry.mode, entry.ply,
    entry.prevIvl ?? 0, entry.prevState ?? 'new',
  ]);
}

const cfg = () => data.settings.srs;

export function byDay(filter = () => true) {
  const days = new Map();
  for (const e of data.log) {
    if (!filter(e)) continue;
    const k = dayKey(e[L.T], cfg());
    let d = days.get(k);
    if (!d) days.set(k, (d = { n: 0, correct: 0, learn: 0, review: 0, practice: 0, ms: 0 }));
    d.n++;
    if (e[L.GRADE] > 0) d.correct++;
    d[e[L.MODE]] = (d[e[L.MODE]] || 0) + 1;
    d.ms += e[L.MS];
  }
  return days;
}

/** Consecutive study days ending today (or yesterday if nothing done yet today). */
export function streak(now = Date.now()) {
  const days = byDay();
  let t = dayStart(now, cfg());
  if (!days.has(dayKey(t, cfg()))) t -= DAY;
  let n = 0;
  while (days.has(dayKey(t, cfg()))) {
    n++;
    t -= DAY;
  }
  return n;
}

export function longestStreak() {
  const keys = [...byDay().keys()].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    const t = new Date(`${k}T12:00:00`).getTime();
    run = prev !== null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** Share of correct answers on review cards (not learning) in the last `days` days. */
export function retention(days = 30, now = Date.now(), filter = () => true) {
  const since = now - days * DAY;
  let n = 0;
  let ok = 0;
  for (const e of data.log) {
    if (e[L.T] < since || e[L.MODE] !== 'review' || e[L.STATE] !== 'review' || !filter(e)) continue;
    n++;
    if (e[L.GRADE] > 0) ok++;
  }
  return { n, ok, rate: n ? ok / n : null };
}

export function studyTime(sinceTs = 0) {
  let ms = 0;
  for (const s of data.sessions) if (s.start >= sinceTs) ms += Math.max(0, (s.end || s.start) - s.start);
  return ms;
}

export function todayCounts(now = Date.now()) {
  const start = dayStart(now, cfg());
  let n = 0;
  let ok = 0;
  for (let i = data.log.length - 1; i >= 0 && data.log[i][L.T] >= start; i--) {
    n++;
    if (data.log[i][L.GRADE] > 0) ok++;
  }
  return { n, ok };
}
