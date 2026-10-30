import { h, pct, fmtDuration } from '../util.js';
import { data, lib, sourceTitle, selectedGameIds } from '../store.js';
import { repertoire, dueKeys, newLines, newLinesLeftToday, reviewPlan, stageProgress, recapLines, findConflicts } from '../training.js';
import { conflictBanner } from '../conflicts.js';
import { categoryCounts, stackBar, legend, loadingBox, planBox, reviewAdvice, stageBox } from '../components.js';
import { streak, retention, todayCounts, studyTime } from '../analytics.js';
import { dayStart } from '../srs.js';

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Late-night study';
  if (hr < 12) return 'Good morning';
  if (hr < 18) return 'Good afternoon';
  return 'Good evening';
}

export async function render(root) {
  const selected = selectedGameIds();
  root.append(h('div.hero',
    h('div', h('h1', greeting()), h('div.muted', new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })))));

  if (!selected.length) {
    root.append(h('div.panel.onboard',
      h('h2', 'Welcome! Let’s build your repertoire'),
      h('ol',
        h('li', 'Open the ', h('a', { href: '#/library' }, 'Library'), ' – your courses are sorted by opening (Caro-Kann, Benoni, …).'),
        h('li', 'Open an opening, choose the side you play and press “Train” – for the whole opening or single chapters.'),
        h('li', 'Come back here and press ', h('b', 'Learn new lines'), '. Reviews then appear automatically, Anki-style.'),
        h('li', 'Everything else stays in the library for reference – you can study it any time.')),
      h('p.muted', { style: { marginTop: '12px' } },
        'New openings: put .pgn files (or whole course folders) into the "openings" folder and press Rescan in the Library.'),
      h('a.btn.primary.big', { href: '#/library' }, 'Go to the Library')));
    return;
  }

  const loading = loadingBox('Preparing your repertoire…');
  root.append(loading.el);
  const set = await repertoire((i, n) => loading.set(`Reading games ${i}/${n} (first time only)…`));
  loading.el.remove();

  const now = Date.now();
  const due = dueKeys(set, now);
  const dueSet = new Set(due);
  const plan = reviewPlan(set, now);
  const stages = stageProgress(set);
  const recap = recapLines(set, now).length;
  const left = newLinesLeftToday(now);
  const availableNew = newLines(set, left || 1).length;
  const quickHref = `#/train/${due.length ? 'review' : availableNew ? 'learn' : 'practice'}?minutes=5`;
  const st = streak(now);
  const ret = retention(30, now);
  const today = todayCounts(now);

  root.querySelector('.hero').append(h('a.btn.primary.big.quick', { href: quickHref, title: 'A short session: reviews first, otherwise new lines' }, '⚡ 5 minutes'));
  root.append(conflictBanner(findConflicts(set), () => window.dispatchEvent(new HashChangeEvent('hashchange'))) || '');
  root.append(h('div.grid.cards-3',
    h(`div.panel.action-card.due${due.length ? '' : '.zero'}`,
      h('div.label', 'Step 1 · Review'),
      h('div.big-num', due.length),
      h('div.muted', reviewAdvice(plan)),
      planBox(plan),
      h('a.btn.primary.big', { href: '#/train/review', class: due.length ? '' : 'disabled' },
        due.length ? 'Start review' : 'No reviews due')),
    h('div.panel.action-card.learn',
      h('div.label', 'Step 2 · Learn new lines'),
      h('div.big-num', Math.min(left, availableNew)),
      h('div.muted', stages.current >= 0 && stages.stages.length > 1
        ? `new lines left today · now in stage ${stages.current + 1} (${stages.stages[stages.current].label})`
        : `new lines left today · daily limit ${data.settings.newLinesPerDay}`),
      stageBox(stages),
      h('div.row', { style: { marginTop: 'auto' } },
        h('a.btn.primary.big', { href: '#/train/learn', class: availableNew ? '' : 'disabled' },
          left ? 'Learn new lines' : 'Learn more anyway'),
        recap ? h('a.btn', { href: '#/train/practice?recap=1', title: 'Play today’s new lines once more' }, `Recap today (${recap})`) : null)),
    h('div.panel.action-card.streak',
      h('div.label', 'Streak'),
      h('div.big-num', `${st} day${st === 1 ? '' : 's'}`),
      h('div.muted', `Today: ${today.n} moves${today.n ? ` (${pct(today.ok, today.n)}% correct)` : ''}`),
      h('div.muted', `30-day retention: ${ret.rate === null ? '–' : `${Math.round(ret.rate * 100)}%`}`),
      h('div.muted', `Study time this week: ${fmtDuration(studyTime(dayStart(now) - 6 * 864e5))}`),
      h('a.btn', { href: '#/stats' }, 'All statistics'))));

  // repertoire overview per course
  const bySource = new Map();
  for (const [key, pos] of set.positions) {
    const src = lib.games.get(pos.gid)?.chapter.source;
    if (!src) continue;
    if (!bySource.has(src)) bySource.set(src, { keys: [], games: new Set(), colors: new Set() });
    const e = bySource.get(src);
    e.keys.push(key);
    e.games.add(pos.gid);
    e.colors.add(pos.color);
  }
  const rows = [...bySource.entries()].map(([src, e]) => {
    const counts = categoryCounts(e.keys);
    const dueHere = e.keys.filter(k => dueSet.has(k)).length;
    return h('tr',
      h('td', h('a', { href: `#/library/${encodeURIComponent(src.id)}` }, sourceTitle(src)),
        h('div.small.faint', [...e.colors].map(c => (c === 'w' ? 'as White' : 'as Black')).join(' & '))),
      h('td.num', e.games.size),
      h('td.num', counts.total),
      h('td', { style: { width: '32%' } }, stackBar(counts)),
      h('td.num', `${pct(counts.total - counts.new, counts.total)}%`),
      h('td.num', dueHere ? h('span', { style: { color: 'var(--bad)' } }, dueHere) : '–'),
      h('td.nowrap', { style: { textAlign: 'right' } },
        h('a.btn.small.primary', { href: `#/train/review?source=${encodeURIComponent(src.id)}`, class: dueHere ? '' : 'disabled' }, 'Review'), ' ',
        h('a.btn.small', { href: `#/train/learn?source=${encodeURIComponent(src.id)}`, class: counts.new ? '' : 'disabled' }, 'Learn'), ' ',
        h('a.btn.small', { href: `#/train/practice?source=${encodeURIComponent(src.id)}` }, 'Practice')));
  });
  root.append(h('div.panel', { style: { marginTop: '16px' } },
    h('div.row', h('h2', 'Your repertoire'), h('div.spacer'), legend()),
    h('table.rep-table',
      h('thead', h('tr', h('th', 'Opening'), h('th', 'Entries'), h('th', 'Moves'), h('th', 'Progress'), h('th', 'Seen'), h('th', 'Due'), h('th', ''))),
      h('tbody', rows))));
}
