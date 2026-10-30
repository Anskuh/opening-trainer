// Anki-style spaced repetition (SM-2 with learning steps).
// A card is one move you have to find: { state, due, ivl, ease, step, reps, lapses, created, last }.
// state: 'learning' | 'review' | 'relearning'. Unseen positions have no card ("new").

export const AGAIN = 0;
export const HARD = 1;
export const GOOD = 2;
export const EASY = 3;
export const GRADE_NAMES = ['Again', 'Hard', 'Good', 'Easy'];

const MIN = 60 * 1000;
export const DAY = 24 * 60 * MIN;

export const DEFAULT_SRS = {
  // Learning happens inside the session (show → play from memory → recap); only a mistake brings
  // a new move back after 10 minutes. Everything learned today is reviewed tomorrow.
  learningSteps: [10], // minutes
  relearningSteps: [10], // minutes
  graduatingInterval: 1, // days
  easyInterval: 4, // days
  startingEase: 2.5,
  minEase: 1.3,
  easyBonus: 1.3,
  hardFactor: 1.2,
  lapseFactor: 0.3, // new interval after a lapse = old interval * lapseFactor
  maxInterval: 365,
  dayStartsAtHour: 4,
};

function fuzz(days) {
  if (days < 3) return days;
  const f = Math.max(1, Math.round(days * 0.05));
  return days + Math.round((Math.random() * 2 - 1) * f);
}

/** Timestamp of the start of the "study day" containing t (days roll over at dayStartsAtHour). */
export function dayStart(t, cfg = DEFAULT_SRS) {
  const d = new Date(t - cfg.dayStartsAtHour * 3600 * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + cfg.dayStartsAtHour * 3600 * 1000;
}

export function dayKey(t, cfg = DEFAULT_SRS) {
  const d = new Date(dayStart(t, cfg));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Review cards are due for the whole study day; learning cards are due at their exact time. */
export function isDue(card, now, cfg = DEFAULT_SRS) {
  if (!card) return false;
  if (card.state === 'review') return card.due < dayStart(now, cfg) + DAY;
  return card.due <= now + 20 * MIN; // allow learning ahead a little
}

export function newCard(now, cfg = DEFAULT_SRS) {
  return { state: 'learning', due: now, ivl: 0, ease: cfg.startingEase, step: 0, reps: 0, lapses: 0, created: now, last: 0 };
}

function scheduleReview(card, days, now, cfg) {
  card.state = 'review';
  card.step = 0;
  card.ivl = Math.min(cfg.maxInterval, Math.max(1, fuzz(Math.round(days))));
  card.due = dayStart(now, cfg) + card.ivl * DAY;
}

/** A mistake with severity below this is "mild": no same-day repeat, smaller interval cut. */
export const MILD = 0.75;

/**
 * Apply a grade to a card (mutates and returns it).
 * severity (0..1) only matters for AGAIN: 1 = full Anki lapse; lower values (late moves in a line,
 * a single slip) cut the interval less and skip the same-day repeat.
 */
export function grade(card, g, now, cfg = DEFAULT_SRS, { severity = 1 } = {}) {
  const c = card || newCard(now, cfg);
  c.reps += 1;
  c.last = now;
  if (c.state === 'learning' || c.state === 'relearning') {
    const steps = c.state === 'learning' ? cfg.learningSteps : cfg.relearningSteps;
    if (g === AGAIN && severity < MILD) {
      // a late slip on a move you are still learning: see it again tomorrow instead of in 10 minutes
      scheduleReview(c, Math.max(1, Math.round((c.ivl || 1) * 0.7)), now, cfg);
    } else if (g === AGAIN) {
      c.step = 0;
      c.due = now + steps[0] * MIN;
    } else if (g === HARD) {
      const cur = steps[c.step] ?? steps[steps.length - 1];
      const next = steps[c.step + 1] ?? cur * 1.5;
      c.due = now + ((cur + next) / 2) * MIN;
    } else if (g === EASY) {
      scheduleReview(c, c.state === 'learning' ? cfg.easyInterval : Math.max(c.ivl, 1) * 1.5, now, cfg);
    } else {
      c.step += 1;
      if (c.step >= steps.length) {
        scheduleReview(c, c.state === 'learning' ? cfg.graduatingInterval : Math.max(c.ivl, 1), now, cfg);
      } else {
        c.due = now + steps[c.step] * MIN;
      }
    }
    return c;
  }
  // review card
  const overdue = Math.max(0, (dayStart(now, cfg) - c.due) / DAY);
  if (g === AGAIN) {
    c.lapses += 1;
    c.ease = Math.max(cfg.minEase, c.ease - 0.2 * severity);
    // keep more of the interval the milder the mistake (severity 1 -> lapseFactor, 0 -> everything)
    const keep = cfg.lapseFactor + (1 - cfg.lapseFactor) * (1 - severity);
    const ivl = Math.max(1, Math.round(c.ivl * keep));
    if (severity < MILD) {
      scheduleReview(c, ivl, now, cfg);
    } else {
      c.ivl = ivl;
      c.state = 'relearning';
      c.step = 0;
      c.due = now + cfg.relearningSteps[0] * MIN;
    }
  } else if (g === HARD) {
    c.ease = Math.max(cfg.minEase, c.ease - 0.15);
    scheduleReview(c, Math.max(c.ivl + 1, c.ivl * cfg.hardFactor), now, cfg);
  } else if (g === GOOD) {
    scheduleReview(c, Math.max(c.ivl + 1, (c.ivl + overdue / 2) * c.ease), now, cfg);
  } else {
    c.ease += 0.15;
    scheduleReview(c, Math.max(c.ivl + 2, (c.ivl + overdue) * c.ease * cfg.easyBonus), now, cfg);
  }
  return c;
}

/**
 * A move that is not due yet, answered correctly while playing through a line. If at least half of
 * its interval has passed, it counts as an early review: the next interval is based on the time
 * that actually passed (like Anki's "review ahead"), so it never shrinks. Returns true if credited.
 */
export function reviewEarly(card, g, now, cfg = DEFAULT_SRS) {
  if (!card || card.state !== 'review' || g === AGAIN || !card.last) return false;
  const elapsed = (now - card.last) / DAY;
  if (elapsed < card.ivl * 0.5) return false;
  const factor = g === HARD ? cfg.hardFactor : card.ease;
  const days = Math.max(card.ivl, elapsed * factor);
  card.reps += 1;
  card.last = now;
  scheduleReview(card, days, now, cfg);
  return true;
}

/** new | learning | young | mature (Anki's categories; mature = interval >= 21 days). */
export function cardCategory(card) {
  if (!card) return 'new';
  if (card.state !== 'review') return 'learning';
  return card.ivl >= 21 ? 'mature' : 'young';
}

export function describeInterval(card, now) {
  if (!card) return 'new';
  const ms = card.due - now;
  if (ms <= 0) return 'due';
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}h`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d}d`;
  if (d < 365) return `${(d / 30).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
