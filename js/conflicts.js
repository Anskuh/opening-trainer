// UI for positions where the repertoire contains two different moves for you.
import { Chessground } from '../vendor/chessground.min.js';
import { h, clear, modal, toast } from './util.js';
import { lib, save, gameTitle, chapterTitle, data } from './store.js';
import { chooseMove } from './training.js';
import { sanPath, nagText, NAG_NAMES } from './pgn.js';

function pathText(sans) {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(' ');
}

/** Warning box listing the conflicts with a button to resolve them. */
export function conflictBanner(conflicts, onResolved) {
  if (!conflicts.length) return null;
  return h('div.panel.conflict-banner',
    h('div.grow',
      h('b', `⚠ ${conflicts.length} position${conflicts.length > 1 ? 's' : ''} with two different moves in your repertoire`),
      h('div.small.muted', 'The author shows alternatives in different chapters. Choose the move you want to play – lines with the other move then end at that position.')),
    h('button.btn.primary', { onclick: () => openConflictDialog(conflicts, onResolved) }, 'Choose my moves'));
}

/** Modal that walks through the conflicts one by one. */
export function openConflictDialog(conflicts, onResolved) {
  const queue = conflicts.slice();
  const body = h('div');
  let board = null;
  const m = modal('Choose your move', body);
  m.el.style.width = 'min(760px, 100%)';
  const close = () => {
    board?.destroy();
    m.close();
  };

  const draw = () => {
    board?.destroy();
    board = null;
    const c = queue[0];
    if (!c) {
      close();
      toast('All choices saved – your lines now follow them', 'good');
      onResolved?.();
      return;
    }
    const sample = c.options[0].node.parent;
    const boardEl = h('div.mini-board.conflict-board');
    clear(body,
      h('p.muted', queue.length > 1 ? `${conflicts.length - queue.length + 1} of ${conflicts.length}` : ''),
      h('div.conflict',
        boardEl,
        h('div.grow',
          h('div.small.muted', 'After'),
          h('div.conflict-path', pathText(sanPath(sample)) || 'the start position'),
          h('p', 'Your repertoire contains these moves here. Which one do you want to play?'),
          c.options.map(o => {
            const titles = o.gids.map(g => lib.games.get(g)).filter(Boolean)
              .map(meta => `${chapterTitle(meta.chapter)} · ${gameTitle(meta.headers)}`);
            const why = o.node.nags.filter(n => NAG_NAMES[n]).map(n => NAG_NAMES[n]).join(', ');
            return h('button.conflict-option', {
              onclick: () => {
                chooseMove(c.fen, o);
                save('selection');
                queue.shift();
                draw();
              },
            },
            h('div.conflict-move', `${o.san}${nagText(o.node, true)}`, why ? h('span.small.muted', ` (${why})`) : null),
            h('div.small.muted', `${o.gids.length} game${o.gids.length > 1 ? 's' : ''}: ${titles.slice(0, 2).join(' | ')}${titles.length > 2 ? ' …' : ''}`),
            o.node.comment ? h('div.small.conflict-comment', o.node.comment.length > 220 ? `${o.node.comment.slice(0, 220)}…` : o.node.comment) : null);
          }),
          h('div.row', { style: { marginTop: '10px' } },
            h('button.btn.ghost', { onclick: () => { queue.push(queue.shift()); draw(); } }, 'Decide later'),
            h('a.btn.ghost', { href: `#/study/${encodeURIComponent(c.options[0].gids[0])}?path=${encodeURIComponent(sanPath(sample).join(' '))}`, onclick: close }, 'Look at it in Study')))));
    requestAnimationFrame(() => {
      const turn = c.fen.split(' ')[1] === 'w' ? 'white' : 'black';
      board = Chessground(boardEl, {
        fen: c.fen.split(' ')[0], orientation: turn, viewOnly: true, coordinates: false,
        drawable: { autoShapes: c.options.map((o, i) => ({ orig: o.uci.slice(0, 2), dest: o.uci.slice(2, 4), brush: ['green', 'blue', 'yellow', 'red'][i % 4] })) },
      });
    });
  };
  draw();
}

/** For Settings: your decisions, each with an undo. */
export function choicesList(onChange) {
  const entries = Object.entries(data.moveChoices || {});
  if (!entries.length) return h('p.muted', 'No decisions yet.');
  return h('table.stat-table', h('tbody', entries.map(([fen, c]) => h('tr',
    h('td', pathText((c.path || '').split(' ').filter(Boolean)) || 'start'),
    h('td', h('b', c.san)),
    h('td', { style: { textAlign: 'right' } }, h('button.btn.small.ghost', {
      onclick: () => {
        const { [fen]: _, ...rest } = data.moveChoices;
        data.moveChoices = rest;
        save('selection');
        onChange?.();
      },
    }, 'Undo'))))));
}
