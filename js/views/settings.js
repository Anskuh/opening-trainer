import { h, toast, modal } from '../util.js';
import { data, save, DEFAULT_SETTINGS, loadLibrary } from '../store.js';
import { BOARD_THEMES } from '../board.js';
import { DEFAULT_SRS } from '../srs.js';
import { cacheClear } from '../idb.js';
import { invalidateRepertoire } from '../training.js';
import { syncPanel } from './sync-panel.js';
import { choicesList } from '../conflicts.js';

export async function render(root) {
  const s = data.settings;

  const num = (obj, key, { min = 0, max = 9999, step = 1, what = 'settings' } = {}) =>
    h('input', {
      type: 'number', min, max, step, value: obj[key],
      onchange: e => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) {
          obj[key] = v;
          save(what);
        } else {
          e.target.value = obj[key];
        }
      },
    });
  const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: !!s[key], onchange: e => { s[key] = e.target.checked; save('settings'); } }), label);
  const steps = (key) => h('input', {
    type: 'text', value: s.srs[key].join(' '), style: { width: '160px' },
    onchange: e => {
      const arr = e.target.value.split(/[\s,]+/).map(Number).filter(v => v > 0);
      if (arr.length) { s.srs[key] = arr; save('settings'); } else e.target.value = s.srs[key].join(' ');
    },
  });
  const row = (label, control, help) => [h('label', label), h('div', control), help ? h('div.help', help) : null];

  root.append(h('h1', 'Settings'));
  const sync = syncPanel();
  root.append(sync.el);
  root.append(h('div.panel', h('h2', 'Training'), h('div.settings-grid',
    row('New lines per day', num(s, 'newLinesPerDay', { min: 0, max: 200 }), 'How many new lines “Learn” introduces per day.'),
    row('Line depth (moves)', num(s, 'maxMoves', { min: 2, max: 80 }), 'Lines are cut off after this many full moves. Lower = shorter, more focused lines.'),
    row('Foundation first', check('stagedLearning', 'Learn every line up to a certain move before going deeper'),
      'New lines are learned in stages: first all variations up to the first depth, then up to the next one, and so on until the full line depth.'),
    row('Stage depths (moves)', h('input', {
      type: 'text', value: (s.learnStages || []).join(' '), style: { width: '160px' },
      onchange: e => {
        const arr = [...new Set(e.target.value.split(/[\s,]+/).map(Number).filter(v => v > 0))].sort((a, b) => a - b);
        if (arr.length) { s.learnStages = arr; save('settings'); } else e.target.value = s.learnStages.join(' ');
      },
    }), `E.g. “10” = stage 1 up to move 10, stage 2 the rest up to move ${s.maxMoves}. Several numbers (e.g. “6 12”) give more stages.`),
    row('Slow answer (seconds)', num(s, 'slowSeconds', { min: 3, max: 300 }), 'A correct move slower than this is graded “Hard” instead of “Good”.'),
    row('Mistakes before the answer is shown', num(s, 'mistakesBeforeAnswer', { min: 1, max: 10 })),
    row('Away detection (minutes)', num(s, 'afkMinutes', { min: 0, max: 60 }), 'A training session stops after this long without any mouse, keyboard or move activity. The time away is not counted as study time. 0 = off.'),
    row('Always play myself up to move', num(s, 'alwaysPlayUntil', { min: 0, max: 80 }), 'In reviews you play all your moves up to this move number yourself, due or not. Later moves are only asked when they are due (if auto-play is on).'),
    row('Combine similar lines (min. shared moves)', num(s, 'combineMinMoves', { min: 0, max: 40 }), 'In reviews, lines that share at least this many moves – and at least 60 % of the shorter line – are played as one tree: after a branch the board goes back to where the next branch starts. 0 = off.'),
    row('Opponent reply delay (ms)', num(s, 'autoplayDelay', { min: 0, max: 3000, step: 50 })),
    row('During training', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      check('showCommentsInDrill', 'Show the author’s comments'),
      check('showNotesInDrill', 'Show my notes'),
      check('autoplayKnown', 'In reviews, auto-play later moves I know that are not due yet'),
      check('forgiveLateSlips', 'Forgive single slips late in a line (they come back in a few days, not today)'),
      check('sound', 'Sounds'))))));

  root.append(h('div.panel', h('h2', 'Board'), h('div.settings-grid',
    row('Engine depth', num(s, 'engineDepth', { min: 8, max: 40 }), 'How deep Stockfish searches in Study (higher = stronger but slower). 22 takes a few seconds per position.'),
    row('Board colours', h('div.row', Object.entries(BOARD_THEMES).map(([name, [light, dark]]) =>
      h(`button.btn${s.boardTheme === name ? '.primary' : ''}`, {
        onclick: e => {
          s.boardTheme = name;
          save('settings');
          e.currentTarget.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('primary'));
          e.currentTarget.classList.add('primary');
        },
      }, h('span', { style: { display: 'inline-block', width: '14px', height: '14px', background: `linear-gradient(135deg, ${light} 50%, ${dark} 50%)`, borderRadius: '3px' } }), name)))))));

  root.append(h('div.panel', h('h2', 'Spaced repetition'),
    h('p.muted.small', 'Anki-style scheduling. The defaults work well; change only if you know what you are doing.'),
    h('div.settings-grid',
      row('Learning steps (minutes)', steps('learningSteps'), 'Default “10”: a new move you get wrong comes back after 10 minutes; a correct one graduates and is reviewed tomorrow.'),
      row('Relearning steps (minutes)', steps('relearningSteps')),
      row('Graduating interval (days)', num(s.srs, 'graduatingInterval', { min: 1, max: 30 })),
      row('Starting ease', num(s.srs, 'startingEase', { min: 1.3, max: 5, step: 0.05 }), 'Multiplier for the next interval after a correct answer.'),
      row('Interval after forgetting', num(s.srs, 'lapseFactor', { min: 0, max: 1, step: 0.05 }), 'Share of the old interval kept when you forget a move.'),
      row('Maximum interval (days)', num(s.srs, 'maxInterval', { min: 7, max: 3650 })),
      row('New day starts at (hour)', num(s.srs, 'dayStartsAtHour', { min: 0, max: 12 }))),
    h('div', { style: { marginTop: '12px' } }, h('button.btn.small', {
      onclick: () => { data.settings.srs = { ...DEFAULT_SRS }; save('settings'); location.reload(); },
    }, 'Reset to defaults'))));

  const choicesBox = h('div');
  const drawChoices = () => choicesBox.replaceChildren(choicesList(drawChoices));
  drawChoices();
  root.append(h('div.panel', h('h2', 'My move decisions'),
    h('p.muted.small', 'Positions where your repertoire had two moves and you chose one. Undo a decision to be asked again.'),
    choicesBox));

  const cardCount = Object.keys(data.cards).length;
  root.append(h('div.panel', h('h2', 'Data'),
    h('p.muted', `Your progress (${cardCount} moves, ${data.log.length} answers, ${Object.keys(data.notes).length} notes) is saved in `,
      h('code', 'data/userdata.json'), ' in the app folder. A backup is made automatically every day in ', h('code', 'data/backups'), ' (last 30 days kept).'),
    h('div.row',
      h('button.btn', {
        onclick: () => {
          const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `opening-trainer-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a);
          a.click();
          a.remove();
        },
      }, 'Export backup'),
      h('button.btn', {
        onclick: async () => {
          await cacheClear();
          invalidateRepertoire();
          await loadLibrary();
          toast('Game cache cleared – games will be re-read from the PGN files', 'good');
        },
      }, 'Re-read all PGN files'),
      h('button.btn.danger', {
        onclick: () => {
          const input = h('input', { type: 'text', placeholder: 'type RESET', style: { width: '100%' } });
          modal('Reset training progress?', h('div',
            h('p', 'This deletes all learned moves, the review history and statistics. Your notes, selections and settings are kept. A backup of today stays in data/backups.'),
            input), [{
            label: 'Delete progress', primary: true,
            onClick: close => {
              if (input.value.trim() !== 'RESET') return toast('Type RESET to confirm', 'error');
              data.resetAt = Date.now(); // keeps the old progress from coming back through sync
              data.cards = {};
              data.log = [];
              data.sessions = [];
              data.newLines = {};
              save('cards');
              close();
              toast('Progress reset');
            },
          }]);
        },
      }, 'Reset progress'))));

  root.append(h('div.panel', h('h2', 'Keyboard shortcuts'), h('div.settings-grid',
    row('Study', h('span', h('kbd', '←'), ' ', h('kbd', '→'), ' move · ', h('kbd', '↑'), ' ', h('kbd', '↓'), ' switch variation · ', h('kbd', 'Home'), ' ', h('kbd', 'End'), ' · ', h('kbd', 'F'), ' flip · ', h('kbd', 'N'), ' next-move arrows')),
    row('Training', h('span', h('kbd', 'H'), ' hint · ', h('kbd', 'S'), ' show move · ', h('kbd', 'U'), ' misclick · ', h('kbd', 'Space'), ' next line')),
    row('Arrows', h('span', 'Right-click-drag on any board to draw your own arrows and circles.')))));

  root.append(h('p.small.faint', { style: { marginTop: '12px' } },
    `Defaults: ${DEFAULT_SETTINGS.newLinesPerDay} new lines/day, depth ${DEFAULT_SETTINGS.maxMoves} moves. `
    + 'Library folders and the port can be changed in config.json.'));

  return () => sync.dispose();
}
