import { h, clear, debounce, toast, fmtDate, modal } from '../util.js';
import {
  data, lib, save, saveNow, getGame, gameTitle, gameSubtitle, chapterTitle, sourceTitle, gameColor, defaultColor, loadLibrary, deleteNote,
} from '../store.js';
import { api, isServer } from '../api.js';
import { createBoard, nodeShapes } from '../board.js';
import { normFen, moveNumber, nagText, MOVE_NAGS, NAG_SYMBOLS, NAG_NAMES, turnOf, repertoireChild, findBySanPath, sanPath, toPgn } from '../pgn.js';
import { sound } from '../sound.js';
import { colorSeg } from '../components.js';
import { createEngine, formatEval, whiteShare } from '../engine.js';

const ENGINE_KEY = 'studyEngineOn';
const undoStacks = new Map(); // gid -> previous PGN texts of that entry (this session)

/** After deleting entry `index` of a chapter, later entries move up by one: fix all references. */
function shiftGameIds(chapterId, index) {
  const remap = gid => {
    const [c, i] = gid.split('#');
    if (c !== chapterId) return gid;
    const n = +i;
    return n === index ? null : n > index ? `${c}#${n - 1}` : gid;
  };
  const selection = {};
  for (const [g, color] of Object.entries(data.selection)) {
    const to = remap(g);
    if (to) selection[to] = color;
  }
  data.selection = selection;
  for (const coll of [data.cards, data.notes, data.moveChoices || {}]) {
    for (const v of Object.values(coll)) if (v.g || v.gid) {
      if (v.g) v.g = remap(v.g) || v.g;
      if (v.gid) v.gid = remap(v.gid) || v.gid;
    }
  }
}
const engineWanted = () => {
  try {
    return localStorage.getItem(ENGINE_KEY) === '1';
  } catch (e) {
    return false;
  }
};

export async function render(root, { parts, query }) {
  const gid = parts[0];
  const meta = lib.games.get(gid);
  if (!meta) {
    root.append(h('div.panel', h('p', 'This game is not in the library (anymore).'), h('a', { href: '#/library' }, 'Back to Library')));
    return;
  }
  root.append(h('div.loading', 'Loading game…'));
  const game = await getGame(gid);
  root.replaceChildren();
  if (!game.root) {
    root.append(h('div.panel.error', h('p', `Could not read this game: ${game.errors.join('; ')}`)));
    return;
  }

  const ch = meta.chapter;
  const idx = ch.gameIds.indexOf(gid);
  let showNext = false;
  let cur = game.root;
  const moveEls = new Map();

  // ---------------------------------------------------------------- layout
  const boardBox = h('div.board-box');
  const tree = h('div.move-tree');
  const noteArea = h('textarea', { placeholder: 'Your own thoughts on this position: plans, typical ideas, traps… (saved automatically)' });
  const noteInfo = h('span.faint');
  const trainBox = h('div.row.small');
  const nextBtn = h('button.btn', { title: 'Show arrows for the moves in the file from here (N)', onclick: () => { showNext = !showNext; nextBtn.classList.toggle('primary', showNext); show(); } }, 'Arrows: next moves');
  const engineBtn = h('button.btn', { title: 'Stockfish analysis (E)', onclick: () => toggleEngine() }, '⚙ Engine');
  const enginePanel = h('div.panel.engine-panel', { hidden: true });
  let editMode = query.get('edit') === '1' && isServer();
  const editBtn = h('button.btn', { title: 'Edit this entry: delete variations, comments, … (changes the PGN file)', onclick: () => { editMode = !editMode; editBtn.classList.toggle('primary', editMode); drawEditPanel(); } }, '✎ Edit');
  editBtn.classList.toggle('primary', editMode);
  const editPanel = h('div.panel.edit-panel', { hidden: true });

  const nav = (label, title, fn) => h('button.btn', { title, onclick: fn }, label);
  root.append(h('div.board-layout',
    h('div.board-col', boardBox,
      h('div.board-controls',
        nav('⏮', 'Start (Home)', () => go(game.root)),
        nav('◀', 'Back (←)', () => cur.parent && go(cur.parent)),
        nav('▶', 'Forward (→)', () => cur.children[0] && go(cur.children[0])),
        nav('⏭', 'End of line (End)', () => go(lineEnd(cur))),
        nav('⇅', 'Flip board (F)', () => board.flip()),
        nextBtn, engineBtn, isServer() ? editBtn : null)),
    h('div.side-col',
      h('div.study-head',
        h('div.row',
          h('div.grow',
            h('h2', gameTitle(meta.headers)),
            h('div.sub', h('a', { href: `#/library/${encodeURIComponent(ch.source.id)}/${encodeURIComponent(ch.id)}` },
              `${sourceTitle(ch.source)} › ${chapterTitle(ch)}`), ` · ${idx + 1}/${ch.gameIds.length}`,
            gameSubtitle(meta.headers) ? ` · ${gameSubtitle(meta.headers)}` : '')),
          h('a.btn.small', { href: idx > 0 ? `#/study/${encodeURIComponent(ch.gameIds[idx - 1])}` : null, class: idx > 0 ? '' : 'disabled', title: 'Previous game' }, '‹'),
          h('a.btn.small', { href: idx < ch.gameIds.length - 1 ? `#/study/${encodeURIComponent(ch.gameIds[idx + 1])}` : null, title: 'Next game' }, '›')),
        trainBox),
      editPanel,
      tree,
      enginePanel,
      h('div.panel.note-box', { style: { padding: '12px 14px' } },
        h('div.row', h('b', '✎ My notes for this position'), h('div.spacer'), noteInfo),
        noteArea),
      h('div.row',
        h('button.btn', { onclick: () => { location.hash = `#/train/practice?game=${encodeURIComponent(gid)}&from=${cur.id}`; } }, 'Practice from this position'),
        game.errors.length ? h('span.small.faint', { title: game.errors.join('\n') }, `⚠ ${game.errors.length} unreadable variation(s) skipped`) : null))));

  const orientation = data.selection[gid] || defaultColor(meta) || 'w';
  const board = createBoard(boardBox, { orientation, onMove: userMove });

  function drawTrainBox() {
    const sel = data.selection[gid];
    clear(trainBox,
      h('label.check', h('input', {
        type: 'checkbox', checked: !!sel,
        onchange: e => {
          if (e.target.checked) data.selection[gid] = gameColor(gid);
          else delete data.selection[gid];
          save('selection');
          drawTrainBox();
          drawTree();
        },
      }), 'Train this game'),
      sel ? h('span.muted', 'as') : null,
      sel ? colorSeg(sel, v => { data.selection[gid] = v; save('selection'); drawTree(); }) : null,
      sel ? h('span.faint', ' – underlined moves are the ones you will be asked') : null);
  }

  // ---------------------------------------------------------------- move tree
  function trainColor() {
    return data.selection[gid] || null;
  }

  function drawTree() {
    moveEls.clear();
    const color = trainColor();
    const trainMoves = new Set();
    if (color) {
      // mark the moves that are asked in training (repertoire moves for your side)
      const stack = [game.root];
      while (stack.length) {
        const n = stack.pop();
        if (turnOf(n.fen) === color) {
          const c = repertoireChild(n);
          if (c) trainMoves.add(c);
        }
        stack.push(...n.children);
      }
    }

    const moveEl = (node, forceNum) => {
      const frag = [];
      if (node.pre) frag.push(h('span.cmt', node.pre));
      const num = moveNumber(node, forceNum);
      const el = h(`span.mv${trainMoves.has(node) ? '.train-move' : ''}${data.notes[normFen(node.fen)] ? '.has-note' : ''}${node.temp ? '.temp' : ''}`,
        { onclick: () => go(node), title: node.temp ? 'Your own move – not in the file, not saved' : node.nags.filter(n => NAG_NAMES[n]).map(n => NAG_NAMES[n]).join(', ') || null },
        num ? h('span.num', num) : null, node.san, h('span.nag', nagText(node, true)));
      moveEls.set(node.id, el);
      frag.push(el);
      const posNags = node.nags.filter(n => !MOVE_NAGS.has(n) && NAG_SYMBOLS[n]);
      if (posNags.length) frag.push(h('span.pos-nag', { title: posNags.map(n => NAG_NAMES[n] || '').join(', ') }, posNags.map(n => NAG_SYMBOLS[n]).join(' ')));
      if (node.comment) frag.push(h('span.cmt', node.comment));
      frag.push(' '); // break opportunity between moves
      return frag;
    };

    // Renders the continuation after `node`; sidelines appear right after the main move they replace.
    const line = (container, node, forceFirst, isMain) => {
      let n = node;
      let force = forceFirst;
      while (n.children.length) {
        const main = n.children[0];
        const parts = moveEl(main, force);
        if (isMain && main.comment && main.comment.length > 90) {
          parts[parts.length - 2] = h('span.cmt.main-cmt', main.comment);
        }
        container.append(...parts);
        force = !!main.comment;
        if (n.children.length > 1) {
          for (const alt of n.children.slice(1)) {
            const v = h('span.var');
            v.append(...moveEl(alt, true));
            line(v, alt, !!alt.comment, false);
            container.append(v);
          }
          force = true;
        }
        n = main;
      }
    };

    const content = h('div');
    if (game.root.comment) content.append(h('span.cmt.main-cmt', game.root.comment));
    line(content, game.root, true, true);
    if (!game.root.children.length) content.append(h('span.muted', 'This entry has no moves.'));
    clear(tree, content);
    highlight();
  }

  function highlight() {
    for (const el of tree.querySelectorAll('.mv.cur')) el.classList.remove('cur');
    const el = moveEls.get(cur.id);
    if (el) {
      el.classList.add('cur');
      const tr = tree.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.top < tr.top + 20 || er.bottom > tr.bottom - 20) {
        tree.scrollTop += er.top - tr.top - tr.height / 3;
      }
    }
  }

  // ---------------------------------------------------------------- navigation
  function lineEnd(n) {
    while (n.children.length) n = n.children[0];
    return n;
  }

  let baseShapes = [];
  let engineShapes = [];

  function show() {
    baseShapes = nodeShapes(cur);
    if (showNext) {
      cur.children.forEach((c, i) => {
        if (c.from && !c.temp) baseShapes.push({ orig: c.from, dest: c.to, brush: i === 0 ? 'paleBlue' : 'paleGrey' });
      });
    }
    engineShapes = [];
    board.set(cur.fen, {
      lastMove: cur.from ? [cur.from, cur.to] : undefined,
      movable: 'both',
      shapes: baseShapes,
    });
    highlight();
    loadNote();
    drawEditPanel();
    if (engine) {
      drawEngine(null);
      engine.analyze(cur.fen);
    }
  }

  function go(node, withSound = true) {
    if (!node || node === cur) return;
    if (withSound && node.parent === cur) sound.move(node.san);
    cur = node;
    show();
  }

  function userMove(mv) {
    const child = cur.children.find(c => c.from === mv.from && c.to === mv.to && (c.promotion || undefined) === (mv.promotion || undefined));
    if (child) {
      go(child);
      return;
    }
    // a move that is not in the file: add it as a temporary "explore" variation (never saved)
    const node = {
      id: game.nodes.length, ply: cur.ply + 1, san: mv.san, from: mv.from, to: mv.to, promotion: mv.promotion,
      fen: mv.fen, parent: cur, children: [], comment: '', pre: '', nags: [], shapes: [], temp: true,
    };
    game.nodes.push(node);
    cur.children.push(node);
    tempNodes.push(node);
    drawTree();
    go(node);
  }

  const tempNodes = [];
  function removeTempNodes() {
    for (const n of tempNodes) {
      const i = n.parent.children.indexOf(n);
      if (i >= 0) n.parent.children.splice(i, 1);
    }
    const firstTemp = game.nodes.findIndex(n => n.temp);
    if (firstTemp >= 0) game.nodes.length = firstTemp;
  }

  // ---------------------------------------------------------------- engine
  let engine = null;

  function toggleEngine(on = !engine) {
    try { localStorage.setItem(ENGINE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    engineBtn.classList.toggle('primary', on);
    enginePanel.hidden = !on;
    if (on && !engine) {
      engine = createEngine({ multiPv: 3, depth: isServer() ? (data.settings.engineDepth || 22) : Math.min(data.settings.engineDepth || 22, 18), onUpdate: drawEngine });
      if (!engine) {
        toast('The engine could not be started in this browser', 'error');
        return toggleEngine(false);
      }
      drawEngine(null);
      engine.analyze(cur.fen);
    } else if (!on && engine) {
      engine.destroy();
      engine = null;
      engineShapes = [];
      board.setShapes(baseShapes);
    }
  }

  function playEngineMove(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci[4];
    const existing = cur.children.find(c => c.from === from && c.to === to);
    if (existing) return go(existing);
    const chess = board.chess;
    try {
      const m = chess.move({ from, to, promotion });
      const mv = { from: m.from, to: m.to, promotion: m.promotion, san: m.san, fen: m.after };
      chess.undo();
      userMove(mv);
    } catch (e) { /* stale line */ }
  }

  function drawEngine(res) {
    if (!engine) return;
    if (res?.error) {
      clear(enginePanel, h('div.muted', res.error));
      return;
    }
    if (res && res.fen !== cur.fen) return;
    const lines = res?.lines || [];
    const best = lines[0];
    const share = whiteShare(best);
    const head = h('div.engine-head',
      h('span.engine-eval', best ? formatEval(best) : '…'),
      h('div.eval-bar', { title: 'White’s share' }, h('div', { style: { width: `${(share * 100).toFixed(1)}%` } })),
      h('span.small.faint', res ? `depth ${res.depth}${res.done ? '' : '…'}` : 'thinking…'),
      h('button.icon-btn', { title: 'Turn the engine off (E)', onclick: () => toggleEngine(false) }, '✕'));
    const rows = lines.map(l => {
      const first = l.pvUci[0];
      const moves = l.pvSan.map((m, i) => {
        const ply = cur.ply + i; // ply of the position before this move
        const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}.` : i === 0 ? `${Math.floor(ply / 2) + 1}...` : '';
        return `${num}${m.san}`;
      }).join(' ');
      return h('div.engine-line', {
        title: 'Click to play the first move',
        onclick: () => playEngineMove(first),
        onmouseenter: () => board.setShapes([...baseShapes, { orig: first.slice(0, 2), dest: first.slice(2, 4), brush: 'blue' }]),
        onmouseleave: () => board.setShapes([...baseShapes, ...engineShapes]),
      }, h('span.engine-chip', formatEval(l)), h('span.engine-pv', moves));
    });
    if (res?.done && !lines.length) rows.push(h('div.muted.small', 'No legal moves in this position.'));
    clear(enginePanel, head, h('div.engine-lines', rows));
    if (best?.pvUci[0]) {
      const u = best.pvUci[0];
      engineShapes = [{ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'blue' }];
      board.setShapes([...baseShapes, ...engineShapes]);
    }
  }

  // ---------------------------------------------------------------- editing the PGN
  const undoStack = undoStacks.get(gid) || [];
  undoStacks.set(gid, undoStack);
  const moveLabel = n => `${moveNumber(n, true)}${n.ply % 2 === 0 ? ' ' : ''}${n.san}`.replace(/^(\d+\.)(\S)/, '$1$2');
  const countMoves = n => n.children.filter(c => !c.temp).reduce((a, c) => a + 1 + countMoves(c), 0);

  /** Apply a change to the tree, write the entry back to its file and reload at `path`. */
  async function commitEdit(mutate, path) {
    const before = toPgn(game.headers, game.root);
    mutate();
    const after = toPgn(game.headers, game.root);
    if (after === before) return;
    try {
      await api.saveGame(ch.id, idx, after);
    } catch (e) {
      toast(`Could not save: ${e.message}`, 'error');
      return;
    }
    undoStack.push(before);
    await reloadAt(path);
  }

  async function reloadAt(path) {
    await loadLibrary();
    location.hash = `#/study/${encodeURIComponent(gid)}?edit=1&path=${encodeURIComponent(path.join(' '))}&r=${Date.now()}`;
  }

  function confirmBox(title, text, label, onYes) {
    modal(title, h('p', text), [
      { label: 'Cancel', onClick: close => close() },
      { label, primary: true, onClick: close => { close(); onYes(); } },
    ]);
  }

  function drawEditPanel() {
    editPanel.hidden = !editMode;
    if (!editMode) return;
    const node = cur;
    const isRoot = !node.parent;
    const siblings = isRoot ? [] : node.parent.children.filter(c => !c.temp);
    const tempPath = [];
    for (let n = node; n && n.parent; n = n.parent) if (n.temp) tempPath.push(n);
    const btn = (label, title, fn, disabled = false) => h('button.btn.small', { title, onclick: fn, disabled }, label);
    clear(editPanel,
      h('div.row',
        h('b', '✎ Edit mode'),
        h('span.muted.small', isRoot ? 'start position' : `selected: ${moveLabel(node)}${node.temp ? ' (your own move)' : ''}`),
        h('div.spacer'),
        undoStack.length ? btn('↶ Undo', 'Undo the last change to this entry', async () => {
          const prev = undoStack.pop();
          try {
            await api.saveGame(ch.id, idx, prev);
          } catch (e) {
            toast(`Could not undo: ${e.message}`, 'error');
            return;
          }
          await reloadAt(sanPath(cur).filter(Boolean));
        }) : null),
      h('div.row', { style: { marginTop: '8px' } },
        btn('🗑 Delete move & rest', 'Delete the selected move and everything after it', () => {
          const n = countMoves(node);
          confirmBox('Delete moves?', `Delete ${moveLabel(node)}${n ? ` and the ${n} move${n > 1 ? 's' : ''} after it` : ''} from this entry?`, 'Delete',
            () => commitEdit(() => {
              node.parent.children.splice(node.parent.children.indexOf(node), 1);
            }, sanPath(node.parent)));
        }, isRoot || node.temp),
        btn('⬆ Make main line', 'Make this variation the main line', () => commitEdit(() => {
          const kids = node.parent.children;
          kids.splice(kids.indexOf(node), 1);
          kids.unshift(node);
        }, sanPath(node)), isRoot || node.temp || siblings[0] === node),
        btn('💬 Edit comment', 'Edit the text comment after this move', () => {
          const area = h('textarea', { style: { minHeight: '140px' } });
          area.value = node.comment || '';
          modal(`Comment ${isRoot ? 'before the first move' : `after ${moveLabel(node)}`}`, area, [
            { label: 'Cancel', onClick: close => close() },
            { label: 'Save', primary: true, onClick: close => { close(); commitEdit(() => { node.comment = area.value.replace(/\s+/g, ' ').trim(); }, sanPath(node)); } },
          ]);
          setTimeout(() => area.focus(), 50);
        }, node.temp),
        tempPath.length ? h('button.btn.small.primary', {
          title: 'Save the moves you played on the board as a variation in the file',
          onclick: () => commitEdit(() => { tempPath.forEach(n => { n.temp = false; }); }, sanPath(node)),
        }, `✔ Keep my ${tempPath.length} move${tempPath.length > 1 ? 's' : ''}`) : null,
        h('div.spacer'),
        btn('Delete entry', 'Delete this whole entry from the chapter file', () => {
          confirmBox('Delete the whole entry?', `“${gameTitle(meta.headers)}” will be removed from ${chapterTitle(ch)}. A backup of the file is kept in data/backups/pgn.`, 'Delete entry', async () => {
            try {
              await api.saveGame(ch.id, idx, null);
            } catch (e) {
              toast(`Could not delete: ${e.message}`, 'error');
              return;
            }
            shiftGameIds(ch.id, idx);
            saveNow('selection');
            undoStacks.clear();
            await loadLibrary();
            toast('Entry deleted', 'good');
            location.hash = `#/library/${encodeURIComponent(ch.source.id)}/${encodeURIComponent(ch.id)}`;
          });
        }, ch.gameIds.length < 2)),
      h('div.small.faint', { style: { marginTop: '6px' } },
        'Changes are saved to the PGN file right away (a backup of the original is kept in data/backups/pgn). '
        + 'Play moves on the board to add your own variation, then press “Keep”.'));
  }

  // ---------------------------------------------------------------- notes
  let noteKey = null;
  function loadNote() {
    noteKey = normFen(cur.fen);
    const note = data.notes[noteKey];
    noteArea.value = note?.text || '';
    noteInfo.textContent = note ? `edited ${fmtDate(note.updated)}` : '';
  }
  const saveNote = debounce(() => {
    const key = noteKey;
    const text = noteArea.value.trim();
    if (text) {
      const path = [];
      for (let n = cur; n && n.san; n = n.parent) path.unshift(n.san);
      data.notes[key] = { text: noteArea.value, updated: Date.now(), g: gid, p: path.join(' ') };
    } else {
      deleteNote(key);
    }
    save('notes');
    const el = moveEls.get(cur.id);
    el?.classList.toggle('has-note', !!text);
    noteInfo.textContent = text ? 'saved' : '';
  }, 600);
  noteArea.addEventListener('input', saveNote);

  // ---------------------------------------------------------------- keys
  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    const siblings = cur.parent ? cur.parent.children : [];
    const i = siblings.indexOf(cur);
    switch (e.key) {
      case 'ArrowLeft': if (cur.parent) go(cur.parent); break;
      case 'ArrowRight': if (cur.children[0]) go(cur.children[0]); break;
      case 'ArrowUp': if (i > 0) go(siblings[i - 1], false); break;
      case 'ArrowDown': if (i >= 0 && i < siblings.length - 1) go(siblings[i + 1], false); break;
      case 'Home': go(game.root); break;
      case 'End': go(lineEnd(cur)); break;
      case 'f': board.flip(); break;
      case 'n': nextBtn.click(); break;
      case 'e': toggleEngine(); break;
      default: return;
    }
    e.preventDefault();
  }
  document.addEventListener('keydown', onKey);

  drawTrainBox();
  drawTree();
  const start = query.get('node') ? game.nodes[+query.get('node')]
    : query.get('path') ? findBySanPath(game.root, query.get('path').split(' ').filter(Boolean)) : null;
  cur = start || game.root;
  show();
  if (engineWanted()) toggleEngine(true);

  return () => {
    document.removeEventListener('keydown', onKey);
    engine?.destroy();
    removeTempNodes();
    board.destroy();
  };
}
