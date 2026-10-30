import { h, clear, debounce, fmtDate } from '../util.js';
import { data, lib, save, gameTitle, deleteNote } from '../store.js';
import { Chessground } from '../../vendor/chessground.min.js';

const PAGE = 30;

export async function render(root) {
  let q = '';
  let limit = PAGE;
  const boards = [];
  const list = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search your notes…', style: { width: '320px' }, oninput: e => { q = e.target.value.toLowerCase(); limit = PAGE; draw(); } });
  root.append(h('div.row', { style: { marginBottom: '16px' } }, h('h1', { style: { margin: 0 } }, 'My notes'), h('div.spacer'), search), list);

  function draw() {
    boards.splice(0).forEach(b => b.destroy());
    const entries = Object.entries(data.notes)
      .filter(([, n]) => !q || n.text.toLowerCase().includes(q) || (n.p || '').toLowerCase().includes(q))
      .sort((a, b) => b[1].updated - a[1].updated);
    if (!entries.length) {
      clear(list, h('div.panel', h('p.muted', Object.keys(data.notes).length
        ? 'No notes match your search.'
        : 'No notes yet. In Study, write your thoughts about any position in the “My notes” box – they show up here and during training whenever that position appears (in any game or course).')));
      return;
    }
    clear(list, entries.slice(0, limit).map(([fen, note]) => {
      const meta = note.g && lib.games.get(note.g);
      const boardEl = h('div.mini-board');
      const text = h('textarea', { value: note.text, style: { minHeight: '110px' } });
      text.value = note.text;
      text.addEventListener('input', debounce(() => {
        if (text.value.trim()) {
          data.notes[fen] = { ...note, text: text.value, updated: Date.now() };
          save('notes');
        }
      }, 600));
      const card = h('div.panel.note-card',
        boardEl,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div.row',
            h('b', note.p ? pathLabel(note.p) : 'Start position'),
            h('div.spacer'),
            h('span.small.faint', fmtDate(note.updated))),
          meta ? h('div.small.muted', gameTitle(meta.headers)) : null,
          text,
          h('div.row',
            meta ? h('a.btn.small', { href: `#/study/${encodeURIComponent(note.g)}?path=${encodeURIComponent(note.p || '')}` }, 'Open in Study') : null,
            h('button.btn.small.ghost.danger', {
              onclick: () => {
                deleteNote(fen);
                save('notes');
                draw();
              },
            }, 'Delete'))));
      requestAnimationFrame(() => {
        const color = (note.g && data.selection[note.g]) === 'b' ? 'black' : 'white';
        boards.push(Chessground(boardEl, { fen: fen.split(' ')[0], viewOnly: true, coordinates: false, orientation: color }));
      });
      return card;
    }), entries.length > limit ? h('div', { style: { textAlign: 'center', marginTop: '12px' } },
      h('button.btn', { onclick: () => { limit += PAGE; draw(); } }, `Show more (${entries.length - limit})`)) : null);
  }

  function pathLabel(p) {
    const sans = p.split(' ');
    const i = sans.length - 1;
    const num = Math.floor(i / 2) + 1;
    return `after ${num}${i % 2 === 0 ? '.' : '...'}${sans[i]}`;
  }

  draw();
  return () => boards.forEach(b => b.destroy());
}
