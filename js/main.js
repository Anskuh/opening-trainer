import { loadUserData, loadLibrary, data, bus, lib } from './store.js';
import { setBoardTheme } from './board.js';
import { repertoire, dueKeys } from './training.js';
import { api, detectMode, isServer } from './api.js';
import { h, modal } from './util.js';
import { getConfig } from './github.js';
import { syncNow, startAutoSync, syncState } from './sync.js';
import * as home from './views/home.js';
import * as library from './views/library.js';
import * as study from './views/study.js';
import * as train from './views/train.js';
import * as stats from './views/stats.js';
import * as notes from './views/notes.js';
import * as settings from './views/settings.js';
import { renderSetup } from './views/setup.js';

const routes = { home, library, study, train, stats, notes, settings };
let cleanup = null;
let routeToken = 0;
let routeName = 'home';

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = routes[parts[0]] ? parts[0] : 'home';
  routeName = name;
  const token = ++routeToken;
  try {
    cleanup?.();
  } catch (e) {
    console.error(e);
  }
  cleanup = null;
  // every page gets its own container: a slower, outdated render can then no longer touch the new page
  const view = document.getElementById('view');
  const root = document.createElement('div');
  view.replaceChildren(root);
  view.className = `view-${name}`;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.route === name);
  try {
    const c = await routes[name].render(root, { parts: parts.slice(1), query: new URLSearchParams(query) });
    if (token === routeToken) cleanup = c || null;
    else c?.();
  } catch (e) {
    console.error(e);
    root.replaceChildren(h('div.panel.error', h('h2', 'Something went wrong'), h('pre', String(e.stack || e))));
  }
}

let badgeTimer;
async function updateDueBadge() {
  clearTimeout(badgeTimer);
  const set = await repertoire();
  const n = dueKeys(set).length;
  const badge = document.getElementById('due-badge');
  badge.hidden = n === 0;
  badge.textContent = n;
  badgeTimer = setTimeout(updateDueBadge, 5 * 60 * 1000);
}

function watchSaveState() {
  const el = document.getElementById('save-state');
  bus.addEventListener('change', () => { el.textContent = 'Saving…'; el.className = 'save-state'; });
  bus.addEventListener('saved', () => { el.textContent = 'Saved'; el.className = 'save-state ok'; });
  bus.addEventListener('save-error', () => {
    el.textContent = isServer() ? 'Not saved – is the server running?' : 'Not saved';
    el.className = 'save-state err';
  });
  bus.addEventListener('conflict', () => {
    el.textContent = 'Not saved – reload needed';
    el.className = 'save-state err';
    modal('Please reload', h('p',
      'Your training data was changed outside this window (for example in another app window). '
      + 'To avoid overwriting it, this window stopped saving. Reload to continue with the current data.'),
    [{ label: 'Reload now', primary: true, onClick: () => location.reload() }]);
  });
}

/** The phone's app files stay available offline through the service worker. */
function registerOffline() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline mode unavailable', e));
  navigator.storage?.persist?.();
}

/** A code from the QR link: take it out of the address right away, it contains the token. */
function takeSetupCode() {
  const m = /^#setup=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

/** Phone: first start needs the setup code and the first download. Returns false if not ready. */
async function prepareDevice() {
  const view = document.getElementById('view');
  const code = takeSetupCode();
  if (!getConfig()) {
    renderSetup(view, code, () => location.reload());
    return false;
  }
  if (!lib.sources.length) {
    const status = h('div.loading', 'Downloading your courses…');
    view.replaceChildren(status);
    await syncNow({ onProgress: (i, n) => { status.textContent = `Downloading your courses… ${i}/${n}`; } });
    if (!lib.sources.length) {
      view.replaceChildren(h('div.panel.error',
        h('h2', 'Could not download your courses'),
        h('p', syncState.error ? String(syncState.error.message) : 'Open the laptop app once with sync turned on, so that it can upload them.'),
        h('button.btn.primary', { onclick: () => location.reload() }, 'Try again')));
      return false;
    }
  }
  return true;
}

async function init() {
  await detectMode();
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname) && !location.search.includes('phone');
  if (!isServer() && local) {
    document.getElementById('view').replaceChildren(h('div.panel.error',
      h('h2', 'Cannot reach the local server'),
      h('p', 'Start the app with the desktop shortcut (or run "python app/server.py") and reload this page.')));
    return;
  }
  document.body.classList.toggle('on-device', !isServer());
  if (!isServer()) registerOffline();
  try {
    await Promise.all([loadUserData(), loadLibrary()]);
  } catch (e) {
    document.getElementById('view').replaceChildren(h('div.panel.error', h('h2', 'Could not load your data'), h('pre', String(e.message || e))));
    return;
  }
  setBoardTheme(data.settings.boardTheme);
  if (!isServer() && !(await prepareDevice())) return;
  watchSaveState();
  bus.addEventListener('change', e => {
    if (e.detail === 'settings') setBoardTheme(data.settings.boardTheme);
    if (['selection', 'cards', 'settings'].includes(e.detail)) updateDueBadge();
  });
  bus.addEventListener('library', updateDueBadge);
  // new progress from the other device: refresh overview pages, but never a running session
  bus.addEventListener('synced', () => {
    updateDueBadge();
    if (routeName === 'home' || routeName === 'stats' || (routeName === 'train' && !location.hash.includes('/train/'))) route();
  });
  window.addEventListener('hashchange', route);
  route();
  updateDueBadge();
  startAutoSync(bus);
  syncNow();
  // keeps the server alive while the app is open (it shuts down when idle)
  if (isServer()) setInterval(() => api.ping().catch(() => {}), 60 * 1000);
}

init();
