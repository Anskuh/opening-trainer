// Small DOM and formatting helpers.

/** h('div.card#id', { onclick, title }, child, ...) */
export function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs !== undefined && attrs !== null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Debounced function; call .now() to run a pending call immediately. */
export function debounce(fn, ms) {
  let t;
  let pendingArgs = null;
  const d = (...args) => {
    pendingArgs = args;
    clearTimeout(t);
    t = setTimeout(() => { pendingArgs = null; fn(...args); }, ms);
  };
  d.now = () => {
    if (!pendingArgs) return;
    clearTimeout(t);
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };
  return d;
}

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return `${hrs} h ${m % 60} min`;
}

export function fmtDate(t) {
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let toastTimer;
export function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div#toast');
    document.body.append(el);
  }
  el.className = `show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

/** Simple modal. Returns { close, el }. */
export function modal(title, body, actions = []) {
  const overlay = h('div.modal-overlay');
  const close = () => overlay.remove();
  const box = h('div.modal',
    h('div.modal-head', h('h2', title), h('button.icon-btn', { onclick: close, title: 'Close' }, '✕')),
    h('div.modal-body', body),
    actions.length ? h('div.modal-actions', actions.map(a =>
      h(`button.btn${a.primary ? '.primary' : ''}`, { onclick: () => a.onClick(close) }, a.label))) : null,
  );
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  overlay.append(box);
  document.body.append(overlay);
  return { close, el: box };
}

/** Ask a question with buttons; resolves with the chosen value (or null). */
export function choose(title, text, options) {
  return new Promise(resolve => {
    const m = modal(title, h('p', text), options.map(o => ({
      label: o.label, primary: o.primary, onClick: close => { close(); resolve(o.value); },
    })));
    m.el.parentElement.addEventListener('mousedown', e => { if (e.target === m.el.parentElement) resolve(null); });
  });
}

export function colorName(c) {
  return c === 'w' ? 'White' : 'Black';
}
