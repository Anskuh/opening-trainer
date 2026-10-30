import { h, clear, toast, modal, choose, colorName } from '../util.js';
import {
  data, lib, save, loadLibrary, getGame, gameTitle, gameSubtitle, isModelGame, chapterTitle, sourceTitle,
  defaultColor, isModelSource, MODEL_FOLDER,
} from '../store.js';
import { guessColor } from '../pgn.js';
import { repertoire } from '../training.js';
import { categoryCounts, stackBar, colorSeg, legend } from '../components.js';
import { api, isServer } from '../api.js';

const openSources = new Set();

const groupsOf = src => {
  const groups = new Map();
  for (const ch of src.chapters) {
    if (!groups.has(ch.group)) groups.set(ch.group, []);
    groups.get(ch.group).push(ch);
  }
  return groups;
};
const theoryIds = chapters => chapters.flatMap(c => c.gameIds).filter(g => !isModelGame(lib.games.get(g).headers));
const allIds = chapters => chapters.flatMap(c => c.gameIds);

export async function render(root, { parts }) {
  let [sourceId, chapterId] = parts;
  let search = '';
  if (!sourceId && lib.sources.length) sourceId = lib.sources[0].id;
  if (sourceId) openSources.add(sourceId);

  const tree = h('div.panel.lib-tree');
  const main = h('div.lib-main');
  root.append(
    h('div.row', { style: { marginBottom: '16px' } },
      h('h1', { style: { margin: 0 } }, 'Library'),
      h('div.spacer'),
      isServer() ? h('button.btn', { onclick: rescan }, '⟳ Rescan') : null,
      isServer() ? h('button.btn', { onclick: () => api.openFolder('openings') }, 'Open openings folder') : null,
      isServer() ? h('button.btn.primary', { onclick: () => addOpeningsDialog(rescan) }, '+ Add openings') : null),
    h('div.lib-layout', tree, main));

  // per-game progress from the current repertoire (only selected games have cards)
  let progress = new Map();
  const loadProgress = async () => {
    const set = await repertoire();
    progress = new Map();
    for (const [key, pos] of set.positions) {
      if (!progress.has(pos.gid)) progress.set(pos.gid, []);
      progress.get(pos.gid).push(key);
    }
  };

  async function rescan() {
    await loadLibrary();
    toast(`Library rescanned: ${lib.sources.length} folders`, 'good');
    drawTree();
    drawMain();
  }

  const selectedIn = gids => gids.filter(g => data.selection[g]).length;
  const chapterHref = ch => `#/library/${encodeURIComponent(ch.source.id)}/${encodeURIComponent(ch.id)}`;

  const searchInput = h('input.search', {
    type: 'search', placeholder: 'Search games, openings, players…',
    oninput: e => { search = e.target.value; drawTree(); drawMain(); },
  });
  const treeList = h('div');
  tree.append(searchInput, treeList);

  // ---------------------------------------------------------------- tree
  function drawTree() {
    const q = search.toLowerCase();
    const matches = ch => !q || chapterTitle(ch).toLowerCase().includes(q) || ch.group.toLowerCase().includes(q)
      || sourceTitle(ch.source).toLowerCase().includes(q) || ch.games.some(g => gameTitle(g).toLowerCase().includes(q));
    const blocks = lib.sources.map(src => {
      const chapters = src.chapters.filter(matches);
      if (q && !chapters.length) return null;
      const sel = selectedIn(allIds(src.chapters));
      const open = openSources.has(src.id) || !!q;
      const groups = groupsOf({ chapters });
      return h(`div.src-block${open ? '.open' : ''}${isModelSource(src) ? '.models' : ''}`,
        h('div.src-head', {
          onclick: () => {
            if (openSources.has(src.id) && sourceId === src.id && !chapterId) openSources.delete(src.id);
            else openSources.add(src.id);
            location.hash = `#/library/${encodeURIComponent(src.id)}`;
          },
        }, h('span.caret', '▸'), h('span', sourceTitle(src)),
        sel ? h('span.count.training', { title: `${sel} entries in training` }, `● ${sel}`) : h('span.count', src.chapters.length)),
        h('div.ch-list', [...groups.entries()].map(([group, chs]) => [
          group ? h('div.grp-label', group) : null,
          chs.map(ch => {
            const s = selectedIn(ch.gameIds);
            return h(`div.ch-item${ch.id === chapterId ? '.active' : ''}`, { onclick: () => { location.hash = chapterHref(ch); } },
              h(s ? 'span.dot-train' : 'span.dot-none', { title: s ? `${s} entries in training` : '' }),
              h('span', chapterTitle(ch)), h('span.count', ch.games.length));
          }),
        ])));
    });
    clear(treeList, blocks.filter(Boolean).length ? blocks : h('p.muted', 'No PGN files found. Use “Add openings”.'));
  }

  // ---------------------------------------------------------------- main pane
  function drawMain() {
    if (search.trim().length >= 2) return drawSearch();
    const src = lib.sources.find(s => s.id === sourceId);
    const ch = src && src.chapters.find(c => c.id === chapterId);
    if (ch) return drawChapter(ch);
    if (src) return drawSource(src);
    clear(main, h('div.panel', h('p.muted', 'Nothing here yet. Add some openings!')));
  }

  function drawSearch() {
    const q = search.toLowerCase();
    const hits = [];
    for (const meta of lib.games.values()) {
      const t = `${gameTitle(meta.headers)} ${gameSubtitle(meta.headers)} ${chapterTitle(meta.chapter)} ${meta.chapter.group} ${sourceTitle(meta.chapter.source)}`;
      if (t.toLowerCase().includes(q)) hits.push(meta.gid);
      if (hits.length >= 200) break;
    }
    clear(main, h('div.panel', h('h2', `Search results (${hits.length}${hits.length >= 200 ? '+' : ''})`),
      gameTable(hits, { showChapter: true })));
  }

  /** "Train Caro-Kann as Black: [Train all] [Stop]" block for an opening, a group or a chapter. */
  function trainingBar(label, chapters, { big = false } = {}) {
    const theory = theoryIds(chapters);
    const ids = theory.length ? theory : allIds(chapters);
    const sel = selectedIn(allIds(chapters));
    const all = ids.length && ids.every(g => data.selection[g]);
    return h(`div.train-bar${big ? '.big' : ''}`,
      h('div.grow',
        h('b', label),
        h('div.small.muted', sel
          ? `${sel} of ${ids.length} ${theory.length ? 'theory entries' : 'entries'} in training`
          : `${ids.length} ${theory.length ? 'theory entries' : 'entries'} · not in training`)),
      !all ? h(`button.btn${big ? '.primary' : '.small'}`, { onclick: () => setTraining(ids) }, sel ? 'Train all' : 'Train') : null,
      sel ? h(`button.btn.ghost${big ? '' : '.small'}`, { onclick: () => setTraining(allIds(chapters), false) }, 'Stop training') : null,
      big && sel ? h('a.btn', { href: `#/train/review?source=${encodeURIComponent(chapters[0].source.id)}` }, 'Review') : null,
      big && sel ? h('a.btn', { href: `#/train/learn?source=${encodeURIComponent(chapters[0].source.id)}` }, 'Learn') : null);
  }

  function drawSource(src) {
    const models = isModelSource(src);
    const color = data.sources[src.id]?.color || null;
    const groups = groupsOf(src);
    const chapterRow = ch => h('tr',
      h('td', h('a', { href: chapterHref(ch) }, chapterTitle(ch))),
      h('td.num', ch.games.length),
      h('td.num', selectedIn(ch.gameIds) || '–'),
      h('td', { style: { textAlign: 'right' } },
        selectedIn(ch.gameIds) < ch.gameIds.length
          ? h('button.btn.small', { onclick: () => setTraining(theoryIds([ch]).length ? theoryIds([ch]) : ch.gameIds) }, 'Train') : null, ' ',
        selectedIn(ch.gameIds) ? h('button.btn.small.ghost', { onclick: () => setTraining(ch.gameIds, false) }, 'Stop') : null, ' ',
        h('a.btn.small', { href: `#/study/${encodeURIComponent(ch.gameIds[0])}` }, 'Study')));
    clear(main,
      h('div.panel',
        h('div.ch-head',
          h('div.titles',
            editableTitle(sourceTitle(src), t => { data.sources[src.id] = { ...data.sources[src.id], title: t }; save(); drawTree(); }),
            h('div.muted', [src.author, `${src.chapters.length} chapters`, `${allIds(src.chapters).length} entries`].filter(Boolean).join(' · '))),
          h('div', h('div.small.muted', models ? 'Side (if you train these)' : 'I play this opening as'),
            colorSeg(color, v => setSourceColor(src, v), { allowNone: true }))),
        models
          ? h('p.muted', 'Complete games, kept apart from the theory so they don’t end up in your drills by accident. Study them to see the typical plans in action.')
          : trainingBar(`Train ${sourceTitle(src)}`, src.chapters, { big: true }),
        [...groups.entries()].map(([group, chs]) => h('div.grp',
          group || groups.size > 1 ? h('div.grp-head', h('h3', group || 'Other'), h('div.spacer'),
            !models ? trainingBar('', chs) : null) : null,
          h('table.game-table',
            h('thead', h('tr', h('th', 'Chapter'), h('th', 'Entries'), h('th', 'Training'), h('th', ''))),
            h('tbody', chs.map(chapterRow)))))));
  }

  function drawChapter(ch) {
    const src = ch.source;
    const chColor = data.chapters[ch.id]?.color || null;
    const theory = theoryIds([ch]);
    const nModels = ch.gameIds.length - theory.length;
    clear(main,
      h('div.panel',
        h('div.ch-head',
          h('div.titles',
            editableTitle(chapterTitle(ch), t => { data.chapters[ch.id] = { ...data.chapters[ch.id], title: t }; save(); drawTree(); }),
            h('div.muted', h('a', { href: `#/library/${encodeURIComponent(src.id)}` }, sourceTitle(src)),
              ch.group ? ` › ${ch.group}` : '', ` · ${ch.games.length} entries`)),
          h('div', h('div.small.muted', 'I play this chapter as'),
            colorSeg(chColor || data.sources[src.id]?.color || null, v => {
              data.chapters[ch.id] = { ...data.chapters[ch.id], color: v };
              for (const g of ch.gameIds) if (data.selection[g] && v) data.selection[g] = v;
              save('selection');
              drawMain();
            }, { allowNone: true }))),
        !isModelSource(src) ? trainingBar(`Train “${chapterTitle(ch)}”`, [ch], { big: true }) : null,
        nModels && theory.length && !isModelSource(src) && isServer()
          ? h('div.hint-box', `This chapter mixes ${theory.length} theory entries with ${nModels} model games. `,
            h('a', { href: '#', onclick: e => { e.preventDefault(); organizeDialog(ch); } }, 'Move the model games to “Model games”'), '.')
          : null,
        h('div.row', { style: { margin: '12px 0' } },
          h('a.btn', { href: `#/study/${encodeURIComponent(ch.gameIds[0])}` }, 'Study'),
          h('a.btn', { href: `#/train/practice?chapter=${encodeURIComponent(ch.id)}` }, 'Practice chapter'),
          h('div.spacer'),
          isServer() ? h('button.btn.ghost', { onclick: () => organizeDialog(ch), title: 'Move this chapter to another opening folder' }, '📁 Organize…') : null),
        gameTable(ch.gameIds),
        h('div', { style: { marginTop: '12px' } }, legend())));
  }

  function gameTable(gids, { showChapter = false } = {}) {
    return h('table.game-table',
      h('thead', h('tr', h('th', 'Train'), h('th', 'Game / line'), h('th', 'Side'), h('th', 'Progress'), h('th', ''))),
      h('tbody', gids.map(gid => {
        const meta = lib.games.get(gid);
        const sel = data.selection[gid];
        const keys = progress.get(gid);
        const counts = keys ? categoryCounts(keys) : null;
        return h(`tr${sel ? '.selected' : ''}`,
          h('td', h('input', {
            type: 'checkbox', checked: !!sel, title: 'Include in training',
            onchange: e => setTraining([gid], e.target.checked),
          })),
          h('td',
            h('div.title', h('a', { href: `#/study/${encodeURIComponent(gid)}` }, gameTitle(meta.headers)),
              isModelGame(meta.headers) ? h('span.tag.model', { style: { marginLeft: '8px' } }, 'model game') : null),
            h('div.sub', [showChapter ? `${sourceTitle(meta.chapter.source)} › ${meta.chapter.group ? `${meta.chapter.group} › ` : ''}${chapterTitle(meta.chapter)}` : null,
              gameSubtitle(meta.headers)].filter(Boolean).join(' · '))),
          h('td', sel ? colorSeg(sel, v => { data.selection[gid] = v; save('selection'); }) : h('span.faint.small', '–')),
          h('td', { style: { minWidth: '140px' } }, counts
            ? h('div', stackBar(counts), h('div.small.faint', `${counts.total - counts.new}/${counts.total} moves seen`))
            : h('span.faint.small', sel ? '…' : '')),
          h('td.nowrap', { style: { textAlign: 'right' } },
            h('a.btn.small', { href: `#/study/${encodeURIComponent(gid)}` }, 'Study'), ' ',
            h('a.btn.small', { href: `#/train/practice?game=${encodeURIComponent(gid)}` }, 'Practice')));
      })));
  }

  // ---------------------------------------------------------------- actions
  async function askColor(src, sampleGid) {
    let guess = null;
    try {
      guess = guessColor((await getGame(sampleGid)).root);
    } catch (e) { /* ignore */ }
    return choose('Which side do you play?',
      `You are adding lines from “${sourceTitle(src)}”. Which side do you want to train? `
      + `${guess ? `(Looks like a repertoire for ${colorName(guess)}.) ` : ''}You can change this per chapter or game later.`,
      [{ label: '♔ White', value: 'w', primary: guess === 'w' }, { label: '♚ Black', value: 'b', primary: guess === 'b' }]);
  }

  async function setTraining(gids, on = true) {
    if (!gids.length) return;
    if (on) {
      const meta = lib.games.get(gids[0]);
      let color = defaultColor(meta);
      if (!color) {
        color = await askColor(meta.chapter.source, gids[0]);
        if (!color) return;
        data.sources[meta.chapter.source.id] = { ...data.sources[meta.chapter.source.id], color };
      }
      for (const g of gids) if (!data.selection[g]) data.selection[g] = defaultColor(lib.games.get(g)) || color;
      toast(`${gids.length} entr${gids.length === 1 ? 'y' : 'ies'} added to training`, 'good');
    } else {
      for (const g of gids) delete data.selection[g];
    }
    save('selection');
    drawTree();
    drawMain();
    await loadProgress();
    drawMain();
  }

  function setSourceColor(src, v) {
    data.sources[src.id] = { ...data.sources[src.id], color: v };
    if (v) {
      for (const ch of src.chapters) {
        if (data.chapters[ch.id]?.color) continue;
        for (const g of ch.gameIds) if (data.selection[g]) data.selection[g] = v;
      }
    }
    save('selection');
  }

  function organizeDialog(ch) {
    const openingFolders = lib.sources.filter(s => s.id.startsWith('openings/') && !isModelSource(s) && s.id.split('/').length === 2)
      .map(s => s.id.split('/')[1]);
    const currentFolder = ch.source.id.split('/')[1] || '';
    const list = h('datalist#opening-folders', openingFolders.map(f => h('option', { value: f })));
    const folder = h('input', { type: 'text', list: 'opening-folders', value: isModelSource(ch.source) ? '' : currentFolder, placeholder: 'e.g. Caro-Kann', style: { width: '100%' } });
    const group = h('input', { type: 'text', value: ch.group, placeholder: 'e.g. author or course (optional)', style: { width: '100%' } });
    const name = h('input', { type: 'text', value: chapterTitle(ch), style: { width: '100%' } });
    const nModels = ch.gameIds.length - theoryIds([ch]).length;
    const split = h('input', { type: 'checkbox', checked: nModels > 0 });
    const m = modal('Organize chapter', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('p.muted', 'Moves the file into ', h('code', 'openings/<opening>/<subfolder>/'), '. Your training selection moves along.'),
      h('label', 'Opening folder', folder, list),
      h('label', 'Subfolder (course / author)', group),
      h('label', 'Chapter name', name),
      nModels ? h('label.check', split, `Put the ${nModels} model game${nModels > 1 ? 's' : ''} into “${MODEL_FOLDER}/<opening>”`) : null,
      ch.id.startsWith('openings/') ? null : h('p.small.faint', 'The original file stays where it is; a copy is made.')),
    [{
      label: 'Move', primary: true,
      onClick: async close => {
        if (!folder.value.trim() || !name.value.trim()) return toast('Opening folder and name are required', 'error');
        let res;
        try {
          res = await api.organize({ id: ch.id, folder: folder.value.trim(), group: group.value.trim(), name: name.value.trim(), splitModels: split.checked });
        } catch (e) {
          return toast(`Could not move: ${e.message}`, 'error');
        }
        // carry selections (and a custom colour) over to the new location
        ch.gameIds.forEach((gid, i) => {
          const to = res.mapping[i];
          if (to && data.selection[gid]) data.selection[to] = data.selection[gid];
          if (to !== gid) delete data.selection[gid];
        });
        if (data.chapters[ch.id]?.color && res.id) data.chapters[res.id.split('#')[0]] = { color: data.chapters[ch.id].color };
        delete data.chapters[ch.id];
        save('selection');
        close();
        await loadLibrary();
        const newCh = lib.chapters.size ? [...lib.sources.flatMap(s => s.chapters)].find(c => c.id === res.id) : null;
        toast('Chapter moved', 'good');
        location.hash = newCh ? chapterHref(newCh) : '#/library';
      },
    }]);
    folder.focus();
    return m;
  }

  drawTree();
  drawMain();
  await loadProgress();
  drawMain();
}

function editableTitle(text, onSave) {
  const el = h('h1.editable', { title: 'Click to rename' }, text);
  el.addEventListener('click', () => {
    const input = h('input', { type: 'text', value: text, style: { fontSize: '1.3rem', width: '100%' } });
    const done = ok => {
      if (ok && input.value.trim() && input.value.trim() !== text) onSave(input.value.trim());
      else input.replaceWith(el);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    el.replaceWith(input);
    input.focus();
    input.select();
  });
  return el;
}

function addOpeningsDialog(rescan) {
  const nameInput = h('input', { type: 'text', placeholder: 'Name, e.g. "London System"', style: { width: '100%' } });
  const pgnInput = h('textarea', { placeholder: 'Paste PGN here (e.g. exported from Lichess, ChessBase, a book)…', style: { minHeight: '140px', fontFamily: 'Consolas, monospace', fontSize: '12px' } });
  const fileInput = h('input', { type: 'file', accept: '.pgn', multiple: true, hidden: true });
  const drop = h('div.drop-zone', 'Drop .pgn files here or ', h('a', { href: '#', onclick: e => { e.preventDefault(); fileInput.click(); } }, 'choose files'));

  const uploadFiles = async files => {
    let n = 0;
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith('.pgn')) continue;
      await api.importPgn(f.name.replace(/\.pgn$/i, ''), await f.text());
      n++;
    }
    if (n) {
      toast(`Imported ${n} file${n > 1 ? 's' : ''}`, 'good');
      m.close();
      rescan();
    }
  };
  fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

  const m = modal('Add openings', h('div',
    h('h3', 'Easiest: use the folder'),
    h('p.muted', 'The ', h('b', 'openings'), ' folder has one subfolder per opening (Caro-Kann, Benoni, …). '
      + 'Put your .pgn files into the right opening folder – optionally in a subfolder per course or author – and press Rescan. '
      + 'Model games belong into “Model games/<opening>”. '
      + 'A whole ChessBase course folder can also be dropped in as it is; afterwards use “📁 Organize…” on its chapters to sort them and split off the model games.'),
    h('div.row', { style: { marginBottom: '18px' } },
      h('button.btn', { onclick: () => api.openFolder('openings') }, 'Open openings folder'),
      h('button.btn', { onclick: () => { m.close(); rescan(); } }, '⟳ Rescan now')),
    h('h3', 'Or import files'), drop, fileInput,
    h('h3', { style: { marginTop: '18px' } }, 'Or paste PGN'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, nameInput, pgnInput),
    h('p.small.faint', { style: { marginTop: '8px' } }, 'Imports are saved to openings/My Imports – use “📁 Organize…” to move them to an opening.')),
  [{
    label: 'Import pasted PGN', primary: true,
    onClick: async close => {
      if (!pgnInput.value.trim()) return toast('Paste some PGN first', 'error');
      await api.importPgn(nameInput.value.trim() || 'Pasted lines', pgnInput.value);
      toast('Imported', 'good');
      close();
      rescan();
    },
  }]);
}
