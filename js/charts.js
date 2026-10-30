// Minimal SVG charts: stacked columns, line with crosshair, calendar heatmap, horizontal bars.
// Marks follow fixed specs: columns <= 24px with 4px rounded tops, 2px lines, r4 dots with a
// surface ring, hairline gridlines, 2px surface gaps between stacked segments, hover tooltips.

const NS = 'http://www.w3.org/2000/svg';
const SURFACE = '#1d2027';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// ---------------------------------------------------------------- tooltip
let tip = null;
function showTip(evt, html) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.append(tip);
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + 14;
  let y = evt.clientY - r.height - 10;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
  if (y < 8) y = evt.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  if (tip) tip.hidden = true;
}
export function hideChartTip() {
  hideTip();
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

const fmt = n => (Math.round(n * 10) / 10).toLocaleString();

function roundedTop(x, yTop, w, yBottom, r) {
  const h = yBottom - yTop;
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${yBottom}V${yTop + rr}Q${x},${yTop} ${x + rr},${yTop}H${x + w - rr}Q${x + w},${yTop} ${x + w},${yTop + rr}V${yBottom}Z`;
}

function yAxis(g, { left, right, top, plotH, max, ticks = 4, format = fmt }) {
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = top + plotH - (v / max) * plotH;
    g.append(s('line', { x1: left, x2: right, y1: y, y2: y, class: 'gridline' }));
    g.append(s('text', { x: left - 6, y: y + 4, 'text-anchor': 'end' }, format(v)));
  }
}

/**
 * Stacked column chart.
 * data: [{ label, values: { key: number }, tip?: string }], series: [{ key, label, color }]
 */
export function columnChart(container, { data, series, height = 210, width = container.clientWidth || 640, labelEvery = 1, yFormat, tipFormat }) {
  const m = { l: 40, r: 8, t: 10, b: 26 };
  const plotW = width - m.l - m.r;
  const plotH = height - m.t - m.b;
  const totals = data.map(d => series.reduce((a, se) => a + (d.values[se.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.72);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const g = s('g');
  svg.append(g);
  yAxis(g, { left: m.l, right: width - m.r, top: m.t, plotH, max, format: yFormat });
  const baseline = m.t + plotH;
  data.forEach((d, i) => {
    const x = m.l + band * i + (band - barW) / 2;
    let y = baseline;
    const segs = series.filter(se => d.values[se.key] > 0);
    segs.forEach((se, si) => {
      const hgt = (d.values[se.key] / max) * plotH;
      const top = y - hgt;
      const isTop = si === segs.length - 1;
      const gapTop = isTop ? top : top + 2; // 2px surface gap between segments
      if (isTop) g.append(s('path', { d: roundedTop(x, top, barW, y, 4), style: `fill:${se.color}`, class: 'bar' }));
      else if (y - gapTop > 0) g.append(s('rect', { x, y: gapTop, width: barW, height: y - gapTop, style: `fill:${se.color}`, class: 'bar' }));
      y = top;
    });
    const last = i === data.length - 1;
    if ((i % labelEvery === 0 && i < data.length - 1 - labelEvery / 2) || last) {
      g.append(s('text', { x: last ? Math.min(width - 2, m.l + band * i + band / 2 + 10) : m.l + band * i + band / 2, y: height - 8, 'text-anchor': last ? 'end' : 'middle' }, d.label));
    }
    // hit target: the whole band
    const hit = s('rect', { x: m.l + band * i, y: m.t, width: band, height: plotH, fill: 'transparent' });
    hit.addEventListener('mousemove', e => {
      const rows = series.filter(se => d.values[se.key]).map(se =>
        `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${se.color};margin-right:6px"></span>${se.label}: <b>${fmt(d.values[se.key])}</b>`);
      showTip(e, `<b>${d.tip || d.label}</b><br>${rows.join('<br>') || 'none'}${tipFormat ? `<br>${tipFormat(d, totals[i])}` : ''}`);
    });
    hit.addEventListener('mouseleave', hideTip);
    g.append(hit);
  });
  container.replaceChildren(svg);
}

/** Line chart with dots and crosshair. points: [{ label, value (null = gap), tip? }] */
export function lineChart(container, { points, height = 210, width = container.clientWidth || 640, max, color = '#3987e5', yFormat = v => `${Math.round(v)}%`, labelEvery = 1, tipText }) {
  const m = { l: 44, r: 12, t: 12, b: 26 };
  const plotW = width - m.l - m.r;
  const plotH = height - m.t - m.b;
  const vals = points.map(p => p.value).filter(v => v !== null);
  const top = max ?? niceMax(Math.max(1, ...vals));
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const g = s('g');
  svg.append(g);
  yAxis(g, { left: m.l, right: width - m.r, top: m.t, plotH, max: top, format: yFormat });
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const px = i => m.l + step * i;
  const py = v => m.t + plotH - (v / top) * plotH;
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${px(i)},${py(p.value)}`;
    pen = true;
    const last = i === points.length - 1;
    if ((i % labelEvery === 0 && i < points.length - 1 - labelEvery / 2) || last) {
      g.append(s('text', { x: px(i), y: height - 8, 'text-anchor': last ? 'end' : 'middle' }, p.label));
    }
  });
  g.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  points.forEach((p, i) => {
    if (p.value !== null) g.append(s('circle', { cx: px(i), cy: py(p.value), r: 4, fill: color, stroke: SURFACE, 'stroke-width': 2 }));
  });
  const cross = s('line', { y1: m.t, y2: m.t + plotH, stroke: '#9aa2b1', 'stroke-width': 1, visibility: 'hidden' });
  g.append(cross);
  const hit = s('rect', { x: m.l - step / 2, y: m.t, width: plotW + step, height: plotH, fill: 'transparent' });
  hit.addEventListener('mousemove', e => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(points.length - 1, Math.round((x - m.l) / (step || 1))));
    cross.setAttribute('x1', px(i));
    cross.setAttribute('x2', px(i));
    cross.setAttribute('visibility', 'visible');
    const p = points[i];
    showTip(e, `<b>${p.tip || p.label}</b><br>${p.value === null ? 'no data' : (tipText ? tipText(p) : yFormat(p.value))}`);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  g.append(hit);
  container.replaceChildren(svg);
}

/** GitHub-style calendar. counts: Map(dayKey 'YYYY-MM-DD' -> number). */
export function calendarHeatmap(container, { counts, weeks = 26, tipFormat }) {
  const cell = 13;
  const gap = 3;
  const left = 30;
  const topPad = 18;
  const width = left + weeks * (cell + gap);
  const height = topPad + 7 * (cell + gap);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', style: `max-width:${Math.round(width * 1.25)}px` });
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today);
  start.setDate(today.getDate() - dow - (weeks - 1) * 7);
  const vals = [...counts.values()].filter(v => v > 0).sort((a, b) => a - b);
  const q = f => vals[Math.floor((vals.length - 1) * f)] || 1;
  const thresholds = [q(0.25), q(0.5), q(0.75), q(0.9)];
  const shades = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
  const color = v => {
    if (!v) return '#262a33';
    let i = 0;
    while (i < thresholds.length && v > thresholds[i]) i++;
    return shades[i];
  };
  ['Mon', 'Wed', 'Fri'].forEach((d, i) => svg.append(s('text', { x: 0, y: topPad + (i * 2) * (cell + gap) + cell - 2 }, d)));
  let lastMonth = -1;
  let lastMonthWeek = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) continue;
      if (d === 0 && date.getMonth() !== lastMonth && w <= weeks - 2 && (lastMonthWeek < 0 || w - lastMonthWeek >= 3)) {
        lastMonth = date.getMonth();
        lastMonthWeek = w;
        svg.append(s('text', { x: left + w * (cell + gap), y: 11 }, date.toLocaleDateString(undefined, { month: 'short' })));
      }
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const v = counts.get(key) || 0;
      const r = s('rect', { x: left + w * (cell + gap), y: topPad + d * (cell + gap), width: cell, height: cell, rx: 3, style: `fill:${color(v)}`, class: 'cell' });
      r.addEventListener('mousemove', e => showTip(e, `<b>${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${tipFormat ? tipFormat(key, v) : `${v} moves`}`));
      r.addEventListener('mouseleave', hideTip);
      svg.append(r);
    }
  }
  container.replaceChildren(svg);
}
