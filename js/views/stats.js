import { h, clear, pct, fmtDuration, fmtDate } from '../util.js';
import { data, lib, sourceTitle, gameTitle } from '../store.js';
import { repertoire } from '../training.js';
import { L, byDay, streak, longestStreak, retention, studyTime } from '../analytics.js';
import { dayKey, dayStart, DAY, cardCategory, describeInterval } from '../srs.js';
import { categoryCounts, stackBar, legend, loadingBox } from '../components.js';
import { columnChart, lineChart, calendarHeatmap, hideChartTip } from '../charts.js';

const MODE_SERIES = [
  { key: 'review', label: 'Review', color: 'var(--s-review)' },
  { key: 'learn', label: 'Learn', color: 'var(--s-learn)' },
  { key: 'practice', label: 'Practice', color: 'var(--s-practice)' },
];

function kpi(label, value, detail) {
  return h('div.kpi', h('div.l', label), h('div.v', value), detail ? h('div.d', detail) : null);
}

function seriesLegend(series) {
  return h('div.legend', series.map(se => h('span', h('i', { style: { background: se.color } }), se.label)));
}

/** Chart panel with a "Table" toggle so every chart also has a plain data view. */
function chartPanel(title, sub, draw, table, extra) {
  const box = h('div.chart');
  const tableBox = h('div', { hidden: true });
  let showingTable = false;
  const toggle = h('button.btn.small.ghost', {
    onclick: () => {
      showingTable = !showingTable;
      box.hidden = showingTable;
      tableBox.hidden = !showingTable;
      toggle.textContent = showingTable ? 'Chart' : 'Table';
      if (showingTable && !tableBox.firstChild) {
        const [head, rows] = table();
        tableBox.append(h('div', { style: { maxHeight: '260px', overflow: 'auto' } }, h('table.stat-table',
          h('thead', h('tr', head.map((c, i) => h(`th${i ? '.r' : ''}`, c)))),
          h('tbody', rows.map(r => h('tr', r.map((c, i) => h(`td${i ? '.r.num' : ''}`, c))))))));
      }
    },
  }, 'Table');
  const panel = h('div.panel.chart-panel',
    h('div.row', h('h3', title), h('div.spacer'), extra || null, toggle),
    h('div.sub', sub), box, tableBox);
  requestAnimationFrame(() => draw(box));
  return panel;
}

const lastDays = n => {
  const out = [];
  const today = dayStart(Date.now(), data.settings.srs);
  for (let i = n - 1; i >= 0; i--) out.push(today - i * DAY);
  return out;
};
const shortDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export async function render(root) {
  const loading = loadingBox('Crunching numbers…');
  root.append(h('h1', 'Statistics'), loading.el);
  const set = await repertoire((i, n) => loading.set(`Reading games ${i}/${n}…`));
  loading.el.remove();
  const now = Date.now();
  const cfg = data.settings.srs;
  const keys = [...set.positions.keys()];
  const counts = categoryCounts(keys);
  const days = byDay();
  const ret30 = retention(30, now);
  const retYoung = retention(30, now, e => e[L.IVL] < 21);
  const retMature = retention(30, now, e => e[L.IVL] >= 21);
  const reviewEntries = data.log.filter(e => e[L.MODE] !== 'practice');
  const avgMs = reviewEntries.length ? reviewEntries.reduce((a, e) => a + e[L.MS], 0) / reviewEntries.length : 0;
  const dueNow = keys.filter(k => data.cards[k] && data.cards[k].due < dayStart(now, cfg) + DAY).length;
  const cur = streak(now);
  const best = longestStreak();

  root.append(h('div.kpis',
    kpi('Repertoire moves', counts.total.toLocaleString(), `${set.lines.length.toLocaleString()} lines in ${set.gids.length} games`),
    kpi('Seen', `${pct(counts.total - counts.new, counts.total)}%`, `${(counts.total - counts.new).toLocaleString()} moves learned`),
    kpi('Mature', `${pct(counts.mature, counts.total)}%`, `${counts.mature.toLocaleString()} moves with interval ≥ 21 days`),
    kpi('Retention (30 days)', ret30.rate === null ? '–' : `${Math.round(ret30.rate * 100)}%`,
      `young ${retYoung.rate === null ? '–' : `${Math.round(retYoung.rate * 100)}%`} · mature ${retMature.rate === null ? '–' : `${Math.round(retMature.rate * 100)}%`}`),
    kpi('Due today', dueNow.toLocaleString(), dueNow ? h('a', { href: '#/train/review' }, 'Start review') : 'all caught up'),
    kpi('Streak', `${cur} day${cur === 1 ? '' : 's'}`, `longest: ${best} day${best === 1 ? '' : 's'}`),
    kpi('Study time', fmtDuration(studyTime(0)), `this week ${fmtDuration(studyTime(dayStart(now, cfg) - 6 * DAY))}`),
    kpi('Moves answered', data.log.length.toLocaleString(), `avg. think time ${(avgMs / 1000).toFixed(1)} s`)));

  if (!data.log.length) {
    root.append(h('div.panel', h('p.muted', 'Charts appear here as soon as you have trained a few lines. Go to ', h('a', { href: '#/train' }, 'Train'), ' to start.')));
  }

  // ---------------------------------------------------------------- activity calendar
  const calCounts = new Map([...days].map(([k, v]) => [k, v.n]));
  root.append(chartPanel('Activity', 'Moves answered per day, last 26 weeks (darker = fewer, lighter = more)',
    box => calendarHeatmap(box, {
      counts: calCounts, weeks: 26,
      tipFormat: (k, v) => {
        const d = days.get(k);
        return d ? `${d.n} moves · ${pct(d.correct, d.n)}% correct` : 'no training';
      },
    }),
    () => [['Day', 'Moves', 'Correct'], [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, d]) => [k, d.n, `${pct(d.correct, d.n)}%`])]));

  const charts = h('div.charts', { style: { marginTop: '16px' } });
  root.append(charts);

  // ---------------------------------------------------------------- per day by mode
  const last30 = lastDays(30).map(t => {
    const d = days.get(dayKey(t, cfg)) || {};
    return { label: shortDate(t), values: { review: d.review || 0, learn: d.learn || 0, practice: d.practice || 0 }, correct: d.correct || 0, n: d.n || 0 };
  });
  charts.append(chartPanel('Moves per day', 'Last 30 days, by kind of training',
    box => columnChart(box, {
      data: last30, series: MODE_SERIES, labelEvery: 5,
      tipFormat: d => (d.n ? `accuracy ${pct(d.correct, d.n)}%` : ''),
    }),
    () => [['Day', 'Review', 'Learn', 'Practice', 'Accuracy'], last30.map(d => [d.label, d.values.review, d.values.learn, d.values.practice, d.n ? `${pct(d.correct, d.n)}%` : '–'])],
    seriesLegend(MODE_SERIES)));

  // ---------------------------------------------------------------- forecast
  const start = dayStart(now, cfg);
  const forecast = Array.from({ length: 30 }, (_, i) => ({ label: i === 0 ? 'today' : shortDate(start + i * DAY), values: { due: 0 } }));
  for (const k of keys) {
    const c = data.cards[k];
    if (!c) continue;
    const i = Math.max(0, Math.floor((c.due - start) / DAY));
    if (i < 30) forecast[i].values.due++;
  }
  charts.append(chartPanel('Review forecast', 'Moves that will be due in the next 30 days (today includes overdue)',
    box => columnChart(box, { data: forecast, series: [{ key: 'due', label: 'Due', color: 'var(--s-review)' }], labelEvery: 5 }),
    () => [['Day', 'Due'], forecast.map(d => [d.label, d.values.due])]));

  // ---------------------------------------------------------------- retention per week
  const weeks = [];
  for (let w = 11; w >= 0; w--) {
    const from = start - (w * 7 + 6) * DAY;
    const to = from + 7 * DAY;
    let n = 0;
    let ok = 0;
    for (const e of data.log) {
      if (e[L.T] < from || e[L.T] >= to || e[L.MODE] !== 'review' || e[L.STATE] !== 'review') continue;
      n++;
      if (e[L.GRADE] > 0) ok++;
    }
    weeks.push({ label: shortDate(from), value: n ? (ok / n) * 100 : null, n, ok, tip: `Week of ${shortDate(from)}` });
  }
  charts.append(chartPanel('Retention', 'Share of review moves you remembered, per week (learning steps excluded)',
    box => lineChart(box, { points: weeks, max: 100, labelEvery: 2, tipText: p => `${Math.round(p.value)}% (${p.ok}/${p.n} moves)` }),
    () => [['Week', 'Retention', 'Moves'], weeks.map(w => [w.label, w.value === null ? '–' : `${Math.round(w.value)}%`, w.n])]));

  // ---------------------------------------------------------------- mistakes by move number
  const byMove = new Map();
  for (const e of data.log) {
    const mv = Math.floor((e[L.PLY] - 1) / 2) + 1;
    if (!byMove.has(mv)) byMove.set(mv, { n: 0, bad: 0 });
    const b = byMove.get(mv);
    b.n++;
    if (e[L.GRADE] === 0) b.bad++;
  }
  const maxMove = Math.min(40, Math.max(10, ...byMove.keys()));
  const moveData = Array.from({ length: maxMove }, (_, i) => {
    const b = byMove.get(i + 1) || { n: 0, bad: 0 };
    return { label: String(i + 1), tip: `Move ${i + 1}`, values: { err: b.n ? (b.bad / b.n) * 100 : 0 }, n: b.n, bad: b.bad };
  });
  charts.append(chartPanel('Where you go wrong', 'Error rate by move number – shows how deep into your lines you start forgetting',
    box => columnChart(box, {
      data: moveData, series: [{ key: 'err', label: 'Error rate %', color: 'var(--s-learn)' }], labelEvery: 5,
      yFormat: v => `${Math.round(v)}%`, tipFormat: d => `${d.bad} mistakes in ${d.n} moves`,
    }),
    () => [['Move', 'Answered', 'Mistakes', 'Error rate'], moveData.map(d => [d.label, d.n, d.bad, d.n ? `${Math.round(d.values.err)}%` : '–'])]));

  // ---------------------------------------------------------------- interval distribution
  const buckets = [[1, 1, '1d'], [2, 3, '2–3d'], [4, 7, '4–7d'], [8, 14, '1–2w'], [15, 30, '2–4w'], [31, 60, '1–2mo'], [61, 120, '2–4mo'], [121, 99999, '4mo+']];
  const ivData = buckets.map(([, , label]) => ({ label, values: { n: 0 } }));
  let learningNow = 0;
  for (const k of keys) {
    const c = data.cards[k];
    if (!c) continue;
    if (c.state !== 'review') { learningNow++; continue; }
    const i = buckets.findIndex(([lo, hi]) => c.ivl >= lo && c.ivl <= hi);
    if (i >= 0) ivData[i].values.n++;
  }
  charts.append(chartPanel('Memory strength', `Current review intervals of your moves (+ ${learningNow} in learning)`,
    box => columnChart(box, { data: ivData, series: [{ key: 'n', label: 'Moves', color: 'var(--c-mature)' }] }),
    () => [['Interval', 'Moves'], ivData.map(d => [d.label, d.values.n])]));

  // ---------------------------------------------------------------- per course table
  const perSource = new Map();
  for (const [key, pos] of set.positions) {
    const src = lib.games.get(pos.gid)?.chapter.source;
    if (!src) continue;
    if (!perSource.has(src)) perSource.set(src, []);
    perSource.get(src).push(key);
  }
  const since30 = now - 30 * DAY;
  const courseRows = [...perSource.entries()].map(([src, ks]) => {
    const kset = new Set(ks);
    const c = categoryCounts(ks);
    let n = 0;
    let ok = 0;
    for (const e of data.log) {
      if (e[L.T] < since30 || e[L.MODE] !== 'review' || e[L.STATE] !== 'review' || !kset.has(e[L.KEY])) continue;
      n++;
      if (e[L.GRADE] > 0) ok++;
    }
    const cards = ks.map(k => data.cards[k]).filter(Boolean);
    const lapses = cards.reduce((a, cc) => a + cc.lapses, 0);
    const ease = cards.length ? cards.reduce((a, cc) => a + cc.ease, 0) / cards.length : null;
    const due = cards.filter(cc => cc.due < dayStart(now, cfg) + DAY).length;
    return { src, c, ret: n ? `${pct(ok, n)}%` : '–', lapses, ease, due };
  });
  root.append(h('div.panel', { style: { marginTop: '16px' } },
    h('div.row', h('h3', 'Mastery by opening'), h('div.spacer'), legend()),
    h('table.stat-table',
      h('thead', h('tr', h('th', 'Opening'), h('th.r', 'Moves'), h('th', 'Progress'), h('th.r', 'Seen'), h('th.r', 'Mature'), h('th.r', 'Retention 30d'), h('th.r', 'Lapses'), h('th.r', 'Avg. ease'), h('th.r', 'Due'))),
      h('tbody', courseRows.map(r => h('tr',
        h('td', sourceTitle(r.src)),
        h('td.r.num', r.c.total),
        h('td', { style: { width: '26%' } }, stackBar(r.c)),
        h('td.r.num', `${pct(r.c.total - r.c.new, r.c.total)}%`),
        h('td.r.num', `${pct(r.c.mature, r.c.total)}%`),
        h('td.r.num', r.ret),
        h('td.r.num', r.lapses),
        h('td.r.num', r.ease ? r.ease.toFixed(2) : '–'),
        h('td.r.num', r.due || '–')))))));

  // ---------------------------------------------------------------- hardest moves
  const hardest = Object.entries(data.cards)
    .filter(([, c]) => c.lapses > 0 || c.ease < 2.5)
    .sort((a, b) => b[1].lapses - a[1].lapses || a[1].ease - b[1].ease)
    .slice(0, 20);
  const pathText = p => {
    const sans = p.split(' ');
    const startIdx = Math.max(0, sans.length - 4);
    return (startIdx > 0 ? '… ' : '') + sans.slice(startIdx).map((s2, j) => {
      const i = startIdx + j;
      const num = Math.floor(i / 2) + 1;
      return i % 2 === 0 ? `${num}.${s2}` : (j === 0 ? `${num}...${s2}` : s2);
    }).join(' ');
  };
  root.append(h('div.panel', { style: { marginTop: '16px' } },
    h('h3', 'Your hardest moves'),
    h('div.sub.muted.small', { style: { marginBottom: '8px' } }, 'Most forgotten moves. Click one to study the position – adding a note about the idea often helps.'),
    hardest.length ? h('table.stat-table',
      h('thead', h('tr', h('th', 'Move'), h('th', 'Game'), h('th.r', 'Lapses'), h('th.r', 'Ease'), h('th.r', 'Next review'), h('th.r', 'Last seen'))),
      h('tbody', hardest.map(([, c]) => {
        const meta = lib.games.get(c.g);
        return h('tr.click', { onclick: () => { location.hash = `#/study/${encodeURIComponent(c.g)}?path=${encodeURIComponent(c.p)}`; } },
          h('td', h('b', pathText(c.p || ''))),
          h('td', meta ? gameTitle(meta.headers) : h('span.faint', 'removed')),
          h('td.r.num', c.lapses),
          h('td.r.num', c.ease.toFixed(2)),
          h('td.r.num', describeInterval(c, now)),
          h('td.r.num', c.last ? fmtDate(c.last) : '–'));
      }))) : h('p.muted', 'No problem moves yet – keep training!')));

  return () => hideChartTip();
}
