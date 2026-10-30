// Reusable UI pieces.
import { h } from './util.js';
import { data } from './store.js';
import { cardCategory } from './srs.js';

export const CATEGORIES = ['mature', 'young', 'learning', 'new'];
export const CATEGORY_LABELS = { mature: 'Mature (≥21d)', young: 'Young', learning: 'Learning', new: 'New' };

export function categoryCounts(keys) {
  const c = { new: 0, learning: 0, young: 0, mature: 0, total: 0 };
  for (const k of keys) {
    c[cardCategory(data.cards[k])]++;
    c.total++;
  }
  return c;
}

export function stackBar(counts, title = true) {
  const total = counts.total || 1;
  const el = h('div.stack', ['mature', 'young', 'learning', 'new'].filter(cat => counts[cat] > 0).map(cat =>
    h(`span.s-${cat}`, { style: { flex: `${counts[cat] / total} 1 0` } })));
  if (title) {
    el.title = `${counts.mature} mature · ${counts.young} young · ${counts.learning} learning · ${counts.new} new`;
  }
  return el;
}

export function legend() {
  return h('div.legend',
    h('span', h('i', { style: { background: 'var(--c-mature)' } }), 'Mature'),
    h('span', h('i', { style: { background: 'var(--c-young)' } }), 'Young'),
    h('span', h('i', { style: { background: 'var(--c-learning)' } }), 'Learning'),
    h('span', h('i', { style: { background: 'var(--c-new)' } }), 'New'));
}

/** Segmented White/Black picker. */
export function colorSeg(value, onChange, { allowNone = false } = {}) {
  const opts = [['w', 'White'], ['b', 'Black']];
  if (allowNone) opts.unshift([null, 'Auto']);
  const el = h('div.seg');
  const draw = v => {
    el.replaceChildren(...opts.map(([val, label]) => h(`button${v === val ? '.on' : ''}`, {
      onclick: e => {
        e.stopPropagation();
        draw(val);
        onChange(val);
      },
    }, val ? h(`span.side-dot.${val}`) : null, ' ', label)));
  };
  draw(value);
  return el;
}

export function loadingBox(text = 'Loading…') {
  const el = h('div.loading', text);
  return { el, set: t => { el.textContent = t; } };
}

const clock = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayName = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long' });

/** One sentence telling you when to review, from training.reviewPlan(). */
export function reviewAdvice(plan) {
  if (plan.now) return 'Review these now – reviews first, then new lines.';
  if (plan.laterToday) return `Done for now. ${plan.laterToday} move${plan.laterToday > 1 ? 's' : ''} you missed come back at ${clock(plan.nextToday)}.`;
  if (plan.tomorrow) return `All done for today! Come back tomorrow for ${plan.tomorrow} move${plan.tomorrow > 1 ? 's' : ''}.`;
  if (plan.nextDay) return `All done! Your next review is on ${dayName(plan.nextDay)}.`;
  return 'Nothing to review yet – learn some lines first.';
}

/** Small table: due now / later today / tomorrow / next 7 days. */
export function planBox(plan) {
  const row = (label, n, extra, strong) => h(`div.plan-row${strong && n ? '.strong' : ''}`,
    h('span', label), h('span.num', n || '–'), extra ? h('span.faint.small', extra) : h('span'));
  return h('div.plan',
    row('Due now', plan.now, '', true),
    row('Later today', plan.laterToday, plan.nextToday ? `from ${clock(plan.nextToday)}` : ''),
    row('Tomorrow', plan.tomorrow),
    row('Next 7 days', plan.week));
}

/** Learning stages with progress bars, from training.stageProgress(). */
export function stageBox(progress) {
  if (progress.stages.length < 2) return null;
  return h('div.stages', progress.stages.map((s, i) => h(`div.stage-row${i === progress.current ? '.current' : ''}${s.total && s.learned === s.total ? '.done' : ''}`,
    h('span.stage-name', `Stage ${i + 1}`),
    h('span.stage-label', s.label),
    h('div.stage-bar', h('div', { style: { width: `${s.total ? (s.learned / s.total) * 100 : 0}%` } })),
    h('span.num.small', s.total ? `${s.learned}/${s.total}` : '–'))));
}

export function sideDot(color) {
  return h(`span.side-dot.${color}`, { title: color === 'w' ? 'You play White' : 'You play Black' });
}
