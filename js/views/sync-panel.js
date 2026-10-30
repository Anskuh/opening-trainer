// The "Sync" panel in Settings.
import { h, clear, toast, modal } from '../util.js';
import { bus } from '../store.js';
import { isServer } from '../api.js';
import { getConfig, setConfig, clearConfig, checkAccess } from '../github.js';
import { syncNow, describeSync } from '../sync.js';
import { encodeSetup } from './setup.js';
import { qrcode } from '../../vendor/qrcode.js';

const DATA_REPO = 'opening-trainer-data';

function showPhoneDialog(cfg) {
  const url = `${cfg.pages.replace(/\/$/, '')}/#setup=${encodeURIComponent(encodeSetup(cfg))}`;
  const qr = qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  modal('Connect your iPhone', h('div',
    h('div.qr-box', { html: qr.createSvgTag({ scalable: true, margin: 2 }) }),
    h('ol.setup-steps',
      h('li', 'Scan this with the iPhone camera and open the link in Safari.'),
      h('li', 'Follow the three steps on the phone.')),
    h('p.small.faint', 'This code contains your access token, so don’t share a photo of it.')));
}

export function syncPanel() {
  const body = h('div');
  const panel = h('div.panel', h('h2', 'Sync'), body);

  const draw = () => {
    const cfg = getConfig();
    const status = h('p.sync-status', describeSync());
    const syncBtn = h('button.btn', { onclick: () => syncNow() }, 'Sync now');
    if (cfg) {
      clear(body, status, h('div.row',
        syncBtn,
        isServer() && cfg.pages ? h('button.btn.primary', { onclick: () => showPhoneDialog(cfg) }, 'Connect iPhone') : null,
        h('button.btn.ghost', {
          onclick: () => {
            clearConfig();
            toast('Sync turned off on this device');
            if (isServer()) draw();
            else location.reload();
          },
        }, 'Disconnect')),
      h('p.small.faint', { style: { marginTop: '8px' } }, `Private repository: ${cfg.owner}/${cfg.repo}`));
      return;
    }
    const repoIn = h('input', { type: 'text', placeholder: `your-name/${DATA_REPO}`, style: { width: '100%' } });
    const tokenIn = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', style: { width: '100%' } });
    const pagesIn = h('input', { type: 'text', placeholder: 'https://your-name.github.io/opening-trainer', style: { width: '100%' } });
    clear(body,
      h('p.muted', 'Keeps your laptop and phone in step through a private GitHub repository.'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '520px' } },
        h('label', 'Private data repository', repoIn),
        h('label', 'Access token', tokenIn),
        h('label', 'Address of the phone app', pagesIn),
        h('div', h('button.btn.primary', {
          onclick: async e => {
            const [owner, repo] = repoIn.value.trim().split('/');
            if (!owner || !repo || !tokenIn.value.trim()) return toast('Please fill in the repository and the token', 'error');
            const next = { owner, repo, token: tokenIn.value.trim(), pages: pagesIn.value.trim() };
            setConfig(next);
            e.target.disabled = true;
            try {
              await checkAccess();
            } catch (err) {
              clearConfig();
              e.target.disabled = false;
              return toast(`Could not connect: ${err.message}`, 'error');
            }
            draw();
            await syncNow();
            toast(describeSync(), 'good');
          },
        }, 'Connect'))));
  };

  const onState = () => {
    const el = body.querySelector('.sync-status');
    if (el) el.textContent = describeSync();
  };
  bus.addEventListener('sync-state', onState);
  draw();
  return { el: panel, dispose: () => bus.removeEventListener('sync-state', onState) };
}
