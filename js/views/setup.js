// First start on the phone: connect the app to your private data repository.
import { h, clear, toast } from '../util.js';
import { setConfig } from '../github.js';

export function encodeSetup(cfg) {
  return btoa(JSON.stringify(cfg));
}

function decodeSetup(code) {
  const cfg = JSON.parse(atob(code.trim()));
  if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('incomplete');
  return cfg;
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isInstalled = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** The screen shown as long as this device is not connected. `code` comes from the QR code. */
export function renderSetup(root, code, onConnected) {
  const input = h('textarea', { placeholder: 'Paste the setup code here', rows: 3, style: { fontSize: '16px' } });
  if (code) input.value = code;

  const connect = () => {
    let cfg;
    try {
      cfg = decodeSetup(input.value);
    } catch (e) {
      toast('That is not a valid setup code', 'error');
      return;
    }
    setConfig(cfg);
    onConnected();
  };

  const connectBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, input,
    h('div.row',
      navigator.clipboard?.readText ? h('button.btn', {
        onclick: async () => {
          try {
            input.value = await navigator.clipboard.readText();
          } catch (e) {
            toast('Could not read the clipboard – long-press the box and choose Paste', 'error');
          }
        },
      }, 'Paste') : null,
      h('button.btn.primary', { onclick: connect }, 'Connect')));

  // On iPhone the installed app and Safari keep separate data, so the code has to be carried over.
  const installSteps = isIos() && !isInstalled();
  clear(root, h('div.panel.setup', { style: { maxWidth: '520px', margin: '0 auto' } },
    h('h1', 'Opening Trainer'),
    installSteps
      ? h('div',
        h('p', 'Three steps to get the app on your iPhone:'),
        h('ol.setup-steps',
          code ? h('li', h('button.btn.primary', {
            onclick: async () => {
              await navigator.clipboard.writeText(code);
              toast('Setup code copied', 'good');
            },
          }, 'Copy setup code')) : h('li', 'Scan the QR code from your laptop (Settings → Sync) and come back to this page.'),
          h('li', 'Tap the Share button in Safari, then ', h('b', 'Add to Home Screen'), '.'),
          h('li', 'Open ', h('b', 'Opening Trainer'), ' from your home screen, tap ', h('b', 'Paste'), ' and ', h('b', 'Connect'), '.')))
      : h('div',
        h('p', 'Connect this device to your training data. On the laptop, open Settings → Sync to get the setup code.'),
        connectBox)));
}
