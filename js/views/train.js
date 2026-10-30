import { h, clear, sleep, shuffle, pct, fmtDuration } from '../util.js';
import { data, lib, save, saveNow, gameTitle, chapterTitle, sourceTitle, selectedGameIds, isModelGame, gameColor } from '../store.js';
import {
  repertoire, buildTrainingSet, reviewLines, newLines, dueKeys, countNew, newLinesLeftToday, recordNewLine, cardRef,
  filterSet, trainedSources, reviewPlan, recapLines, stageProgress, learnStages, stageLabel, mistakeSeverity, findConflicts, groupReviewLines,
} from '../training.js';
import { conflictBanner } from '../conflicts.js';
import { createBoard, nodeShapes } from '../board.js';
import { normFen, moveNumber, nagText, turnOf, isBadMove, NAG_NAMES, MOVE_NAGS } from '../pgn.js';
import { grade as srsGrade, reviewEarly, isDue, AGAIN, HARD, GOOD, GRADE_NAMES, MILD } from '../srs.js';
import { logReview } from '../analytics.js';
import { sound } from '../sound.js';
import { loadingBox, planBox, reviewAdvice, stageBox } from '../components.js';
import { pauseSync } from '../sync.js';

const MODE_TITLES = { review: 'Review', learn: 'Learn new lines', practice: 'Practice' };

export async function render(root, { parts, query }) {
  const mode = parts[0];
  if (!MODE_TITLES[mode]) return renderHub(root);
  return runSession(root, mode, query);
}

// ================================================================== hub

const SCOPE_KEY = 'trainScope';

function rememberedScope() {
  try {
    return localStorage.getItem(SCOPE_KEY) || '';
  } catch (e) {
    return '';
  }
}

async function renderHub(root) {
  const loading = loadingBox('Preparing your repertoire…');
  root.append(h('h1', 'Train'), loading.el);
  const fullSet = await repertoire((i, n) => loading.set(`Reading games ${i}/${n}…`));
  loading.el.remove();

  const sources = trainedSources();
  let scope = rememberedScope();
  if (scope && !sources.some(s => s.id === scope)) scope = '';

  const chips = h('div.scope-chips');
  const cards = h('div');
  root.append(conflictBanner(findConflicts(fullSet), () => window.dispatchEvent(new HashChangeEvent('hashchange'))) || '');
  root.append(h('div.row', { style: { marginBottom: '14px' } }, h('span.muted', 'Opening:'), chips), cards);

  const draw = () => {
    const set = filterSet(fullSet, scope);
    const q = scope ? `?source=${encodeURIComponent(scope)}` : '';
    const due = dueKeys(set).length;
    const unlearned = countNew(set);
    const left = newLinesLeftToday();
    const weak = [...set.positions.keys()].filter(k => data.cards[k] && (data.cards[k].lapses > 0 || data.cards[k].ease < 2.3)).length;
    const plan = reviewPlan(set);
    const stages = stageProgress(set);
    const recap = recapLines(set).length;
    const chip = (id, label, n) => h(`button${scope === id ? '.on' : ''}`, {
      onclick: () => {
        scope = id;
        try { localStorage.setItem(SCOPE_KEY, id); } catch (e) { /* private mode */ }
        draw();
      },
    }, label, n ? h('span.chip-count', n) : null);
    clear(chips, chip('', 'All openings', dueKeys(fullSet).length),
      sources.map(s => chip(s.id, sourceTitle(s), dueKeys(filterSet(fullSet, s.id)).length)));
    const scopeName = scope ? sourceTitle(sources.find(s => s.id === scope)) : 'your repertoire';
    clear(cards, h('div.grid.cards-3.train-hub',
      h('div.panel.action-card',
        h('h2', '1 · Review'),
        planBox(plan),
        h('p', reviewAdvice(plan)),
        h('a.btn.primary', { href: `#/train/review${q}`, class: due ? '' : 'disabled' }, due ? `Review ${due} moves` : 'Nothing due')),
      h('div.panel.action-card',
        h('h2', '2 · Learn'),
        stages.current >= 0 && stages.stages.length > 1
          ? h('p', h('b', `Stage ${stages.current + 1}: ${stages.stages[stages.current].label}. `),
            'Foundation first – deeper moves come once this stage is learned in all lines.')
          : null,
        stageBox(stages),
        h('p', `${left} of ${data.settings.newLinesPerDay} new lines left today. Each line is shown with arrows and comments, then you play it from memory.`),
        h('div.row',
          h('a.btn.primary', { href: `#/train/learn${q}`, class: unlearned ? '' : 'disabled' }, left ? 'Learn new lines' : 'Learn more anyway'),
          recap ? h('a.btn', { href: `#/train/practice?recap=1${scope ? `&source=${encodeURIComponent(scope)}` : ''}`, title: 'Play today’s new lines once more' }, `Recap today (${recap})`) : null)),
      h('div.panel.action-card',
        h('h2', 'Practice'),
        h('p', `Drill random lines of ${scopeName} without affecting your schedule – great before a tournament.`),
        h('div.row',
          h('a.btn.primary', { href: `#/train/practice${q}`, class: set.lines.length ? '' : 'disabled' }, 'Practice random lines'),
          h('a.btn', { href: `#/train/practice?weak=1${scope ? `&source=${encodeURIComponent(scope)}` : ''}`, title: 'Moves you got wrong before', class: weak ? '' : 'disabled' }, `Weak moves (${weak})`)))),
    h('p.small.faint', { style: { marginTop: '14px' } },
      'Daily routine: 1 · review what is due, 2 · learn a few new lines, then recap them. Everything learned today comes back tomorrow, then after a few days, a week, and so on. '
      + 'Which openings are trained is set in the Library.'));
  };
  draw();
}

// ================================================================== session

async function scopeSet(query, onProgress) {
  if (query.get('game')) {
    const gid = query.get('game');
    const set = await buildTrainingSet([gid], { onProgress, color: gameColor(gid) });
    const from = query.get('from');
    if (from && +from > 0) {
      const lines = set.lines.filter(l => l.nodes.some(n => n.id === +from));
      for (const l of lines) l.startIdx = l.nodes.findIndex(n => n.id === +from) + 1;
      set.lines = lines;
    }
    return { set, label: gameTitle(lib.games.get(gid).headers) };
  }
  if (query.get('chapter')) {
    const ch = lib.chapters.get(query.get('chapter')) || [...lib.sources.flatMap(s => s.chapters)].find(c => c.id === query.get('chapter'));
    if (!ch) return { set: { lines: [], positions: new Map() }, label: 'Unknown chapter' };
    const sel = ch.gameIds.filter(g => data.selection[g]);
    const gids = sel.length ? sel : ch.gameIds.filter(g => !isModelGame(lib.games.get(g).headers));
    return { set: await buildTrainingSet(gids, { onProgress }), label: chapterTitle(ch) };
  }
  const src = query.get('source') && lib.sources.find(s => s.id === query.get('source'));
  if (query.get('recap')) {
    const set = filterSet(await repertoire(onProgress), src?.id);
    return { set: { ...set, lines: recapLines(set), once: true }, label: 'Recap of today’s new lines' };
  }
  if (query.get('weak')) {
    const set = filterSet(await repertoire(onProgress), src?.id);
    const weakKeys = new Set([...set.positions.keys()].filter(k => data.cards[k] && (data.cards[k].lapses > 0 || data.cards[k].ease < 2.3)));
    const lines = set.lines.filter(l => l.user.some(u => weakKeys.has(u.key)));
    return { set: { ...set, lines }, label: src ? `Weak moves · ${sourceTitle(src)}` : 'Weak moves' };
  }
  if (query.get('source')) {
    if (!src) return { set: { lines: [], positions: new Map() }, label: 'Unknown opening' };
    const all = src.chapters.flatMap(c => c.gameIds);
    const sel = all.filter(g => data.selection[g]);
    return { set: await buildTrainingSet(sel.length ? sel : all.filter(g => !isModelGame(lib.games.get(g).headers)), { onProgress }), label: sourceTitle(src) };
  }
  return { set: await repertoire(onProgress), label: 'Whole repertoire' };
}

async function runSession(root, mode, query) {
  const loading = loadingBox('Preparing lines…');
  root.append(loading.el);
  const progress = (i, n) => loading.set(`Reading games ${i}/${n}…`);
  const scopeSrc = query.get('source') && lib.sources.find(s => s.id === query.get('source'));
  const { set, label } = mode === 'practice'
    ? await scopeSet(query, progress)
    : { set: filterSet(await repertoire(progress), scopeSrc?.id), label: scopeSrc ? sourceTitle(scopeSrc) : 'Your repertoire' };
  loading.el.remove();

  const settings = data.settings;
  let cancelled = false;
  let queue = [];
  let lineNo = 0;
  let learnBudget = mode === 'learn' ? (newLinesLeftToday() || settings.newLinesPerDay) : 0;
  const stats = { start: Date.now(), lines: 0, moves: 0, correct: 0, mistakes: 0, graded: {} };
  const timeLimit = (+query.get('minutes') || 0) * 60 * 1000; // quick sessions end after the current line

  let filledOnce = false;
  const fillQueue = () => {
    if (mode === 'review') queue = groupReviewLines(reviewLines(set), settings.combineMinMoves);
    else if (mode === 'learn') queue = learnBudget > 0 ? newLines(set, learnBudget) : [];
    else queue = set.once && filledOnce ? [] : shuffle(set.lines.slice()); // a recap is played once
    filledOnce = true;
    lineNo = 0;
  };
  fillQueue();
  if (!queue.length) {
    root.append(h('div.panel', h('h2', MODE_TITLES[mode]),
      h('p', mode === 'review' ? 'Nothing is due right now. 🎉' : mode === 'learn' ? 'No new lines to learn – select more games in the Library.' : 'No lines found for this selection.'),
      h('a.btn', { href: '#/train' }, 'Back')));
    return;
  }

  // ---------------------------------------------------------------- layout
  const boardBox = h('div.board-box');
  const progressBar = h('div');
  const statusText = h('span.muted.small.num');
  const feedback = h('div.feedback');
  const lineMoves = h('div.line-moves');
  const coach = h('div.coach');
  const hintBtn = h('button.btn', { title: 'Highlight the piece to move (H)' }, 'Hint');
  const answerBtn = h('button.btn', { title: 'Show the move (S)' }, 'Show move');
  const misclickBtn = h('button.btn.ghost', { hidden: true, title: 'That was a misclick – undo the mistake (U)' }, '↶ Misclick');
  const nextBtn = h('button.btn.primary', { hidden: true, title: 'Space / Enter' }, 'Next line ▶');
  const skipBtn = h('button.btn.ghost', { title: 'Skip this line' }, 'Skip line');
  const studyLink = h('a.btn.ghost', { title: 'Open this line in Study' }, 'Open in Study');

  root.append(h('div.board-layout',
    h('div.board-col', boardBox),
    h('div.side-col',
      h('div.drill-status', h('span.mode', MODE_TITLES[mode]), h('span.muted', label), h('div.spacer'), statusText),
      h('div.progress', progressBar),
      feedback,
      h('div.row', hintBtn, answerBtn, misclickBtn, nextBtn, h('div.spacer'), studyLink, skipBtn,
        h('button.btn.ghost', { onclick: () => finish() }, 'Stop')),
      lineMoves,
      coach)));

  let onUserMove = null;
  let abortAsk = null; // resolves a pending askMove with null (skip / stop)
  const board = createBoard(boardBox, { onMove: mv => onUserMove?.(mv) });

  const setFeedback = (kind, title, text) => {
    clear(feedback, h('div.title', title), text ? h('div', text) : null);
    feedback.className = `feedback ${kind || ''}`;
  };

  const coachItem = (node, who, extra = []) => {
    const parts = [];
    if (node.pre) parts.push(node.pre);
    if (node.comment) parts.push(node.comment);
    const posNags = node.nags.filter(n => !MOVE_NAGS.has(n) && NAG_NAMES[n]).map(n => NAG_NAMES[n]);
    if (!parts.length && !posNags.length && !extra.length) return;
    const el = h('div.coach-item',
      h('div.who', who, ' ', h('span.mvtxt', `${moveNumber(node, true)} ${node.san}${nagText(node, true)}`),
        posNags.length ? h('span.faint', ` (${posNags.join(', ')})`) : null),
      parts.length ? h('div', parts.join(' ')) : null, extra);
    coach.append(el);
    coach.scrollTop = coach.scrollHeight;
  };

  const noteItem = fen => {
    if (!settings.showNotesInDrill) return;
    const note = data.notes[normFen(fen)];
    if (!note) return;
    coach.append(h('div.coach-item.note', h('div.who', '✎ Your note'), h('div', { style: { whiteSpace: 'pre-wrap' } }, note.text)));
    coach.scrollTop = coach.scrollHeight;
  };

  const drawLineMoves = (line, idx, missed) => {
    const start = line.startIdx || 0;
    const items = [];
    line.nodes.forEach((n, i) => {
      if (i > idx) return;
      const num = i === 0 || n.ply % 2 === 1 || i === start ? `${moveNumber(n, true)} ` : '';
      const cls = i === idx ? '.cur' : missed.has(i) ? '.miss' : '.done';
      items.push(h(`span${cls}`, `${num}${i === idx ? '?' : n.san}`), ' ');
    });
    if (idx < line.nodes.length - 1) items.push(h('span.faint', '…'));
    clear(lineMoves, items);
  };

  const updateStatus = () => {
    progressBar.style.width = `${pct(lineNo, queue.length)}%`;
    const line = queue[Math.min(lineNo, queue.length - 1)];
    const stage = mode === 'learn' && line?.stage && learnStages().length > 1
      ? `Stage ${line.stage} · ${stageLabel(line.stage - 1)} · ` : '';
    statusText.textContent = mode === 'practice'
      ? `line ${lineNo + 1}${set.once ? `/${queue.length}` : ''} · ${stats.correct}/${stats.moves} correct`
      : `${stage}line ${Math.min(lineNo + 1, queue.length)}/${queue.length}${line?.parts > 1 ? ` · branch ${line.part}/${line.parts}` : ''}`;
  };

  // ---------------------------------------------------------------- grading
  /** Grades a move; returns a function that re-grades it as a full mistake (used when a line has 2+ misses). */
  function applyGrade(key, node, line, g, ms, severity = 1) {
    const now = Date.now();
    const before = data.cards[key];
    const snapshot = before ? { ...before } : null;
    const prevState = before ? before.state : 'new';
    const prevIvl = before ? before.ivl : 0;
    const ref = () => cardRef(set.positions.get(key) || { gid: line.gid, node, color: line.color });
    let changed = false;
    if (mode === 'learn' && !before) {
      const card = srsGrade(null, g, now, settings.srs, { severity });
      data.cards[key] = { ...card, ...ref() };
      changed = true;
    } else if (mode !== 'practice' && before && (isDue(before, now, settings.srs) || g === AGAIN)) {
      srsGrade(before, g, now, settings.srs, { severity });
      changed = true;
    } else if (mode === 'review' && before && reviewEarly(before, g, now, settings.srs)) {
      changed = true; // played correctly although not due yet: counts as an early review
    }
    const escalate = () => {
      if (!changed) return;
      const card = srsGrade(snapshot ? { ...snapshot } : null, AGAIN, now, settings.srs, { severity: 1 });
      data.cards[key] = snapshot ? card : { ...card, ...ref() };
    };
    if (changed || mode === 'practice' || g === AGAIN) {
      logReview({ t: now, key, grade: g, ms, mode, ply: node.ply, prevIvl, prevState });
      stats.graded[g] = (stats.graded[g] || 0) + 1;
    }
    save('cards');
    return escalate;
  }

  // ---------------------------------------------------------------- asking one move
  function askMove(line, idx, { arrow, graded }) {
    const node = line.nodes[idx];
    const prev = node.parent;
    return new Promise(resolve => {
      abortAsk = () => {
        onUserMove = null;
        resolve(null);
      };
      let mistakes = 0;
      let hint = 0; // hints you asked for (1 = piece, 2 = move)
      let autoShown = false; // answer shown automatically after too many mistakes
      const t0 = performance.now();
      const baseShapes = arrow ? [{ orig: node.from, dest: node.to, brush: 'green' }] : [];
      const hintShapes = level => (level >= 2 ? [{ orig: node.from, dest: node.to, brush: 'green' }]
        : level === 1 ? [{ orig: node.from, brush: 'green' }] : baseShapes);
      misclickBtn.hidden = true;
      misclickBtn.onclick = () => {
        if (!mistakes) return;
        mistakes--;
        stats.mistakes--;
        if (autoShown && mistakes < settings.mistakesBeforeAnswer) {
          autoShown = false;
          board.setShapes(hintShapes(hint));
        }
        misclickBtn.hidden = mistakes === 0;
        setFeedback('', 'Misclick – no problem', 'That mistake doesn’t count. Play your move.');
      };
      board.set(prev.fen, {
        movable: line.color, lastMove: prev.from ? [prev.from, prev.to] : undefined, shapes: baseShapes,
        promotionHint: node.promotion,
      });
      const showHint = level => {
        hint = Math.max(hint, level);
        board.setShapes(hintShapes(hint));
      };
      hintBtn.onclick = () => showHint(1);
      answerBtn.onclick = () => showHint(2);
      hintBtn.disabled = answerBtn.disabled = false;

      onUserMove = mv => {
        lastActivity = Date.now();
        if (mv.from === node.from && mv.to === node.to) {
          onUserMove = null;
          hintBtn.disabled = answerBtn.disabled = true;
          misclickBtn.hidden = true;
          board.set(node.fen, { lastMove: [node.from, node.to], shapes: nodeShapes(node) });
          sound.move(node.san);
          const ms = performance.now() - t0;
          let g = GOOD;
          if (mistakes > 0 || hint >= 2) g = AGAIN;
          else if (hint === 1 || ms > settings.slowSeconds * 1000) g = HARD;
          resolve({ g, ms, mistakes, hint });
          return;
        }
        board.reset();
        // another move of your repertoire for this position (the books disagree): no penalty
        if (set.positions.has(`${normFen(prev.fen)}|${mv.from}${mv.to}${mv.promotion || ''}`)) {
          setFeedback('info', `${mv.san} is also in your repertoire here`,
            'Your repertoire has two moves in this position. Play this line’s move now – and pick one for good via “Choose my moves” on Home or Train.');
          return;
        }
        // is it another move from the book at this position?
        const sibling = prev.children.find(c => c.from === mv.from && c.to === mv.to);
        if (sibling && !isBadMove(sibling)) {
          setFeedback('info', `${mv.san} is a playable alternative in the book`, 'But your repertoire move here is different – try again.');
          if (sibling.comment) coachItem(sibling, 'Book on the alternative:');
          return;
        }
        mistakes++;
        stats.mistakes++;
        sound.bad();
        board.flash('bad');
        misclickBtn.hidden = graded === false;
        if (sibling) {
          const why = sibling.nags.filter(n => NAG_NAMES[n]).map(n => NAG_NAMES[n]).join(', ');
          setFeedback('bad', `${mv.san}${nagText(sibling, true)} – ${why || 'not your repertoire move'}`, sibling.comment || 'Try again.');
        } else {
          setFeedback('bad', `${mv.san} is not the move`, 'Try again.');
        }
        if (graded === false) return;
        if (mistakes >= settings.mistakesBeforeAnswer) {
          autoShown = true;
          board.setShapes(hintShapes(2));
          setFeedback('bad', 'The correct move is shown with the arrow', 'Play it to continue.');
        }
      };
    });
  }

  // ---------------------------------------------------------------- playing a line
  async function playLine(line, phase) {
    const start = line.startIdx || 0;
    const missed = new Set();
    const first = line.nodes[start];
    if (line.continuation) {
      const at = first.parent;
      coach.append(h('div.coach-item.branch', h('div.who', '↩ Back to an earlier position'),
        h('div', `After ${moveNumber(at, true)} ${at.san} the opponent now plays something else.`)));
      coach.scrollTop = coach.scrollHeight;
    } else {
      coach.replaceChildren();
    }
    board.setOrientation(line.color);
    const startFen = first.parent.fen;
    board.set(startFen, { lastMove: first.parent.from ? [first.parent.from, first.parent.to] : undefined });
    const userIdx = new Map(line.user.map(u => [u.idx, u.key]));
    let asked = 0;
    let correct = 0;
    const pendingComments = [];
    const showCommentsNow = phase === 'show';
    const mildMisses = []; // escalate() functions of late single slips in this line
    const meta = lib.games.get(line.gid);
    studyLink.href = `#/study/${encodeURIComponent(line.gid)}?node=${line.nodes[line.nodes.length - 1].id}`;
    studyLink.title = `Open in Study: ${gameTitle(meta.headers)}`;

    if (phase === 'show') setFeedback('info', 'New line – follow the arrows', `${gameTitle(meta.headers)} · ${chapterTitle(meta.chapter)}`);
    else if (phase === 'recall' && mode === 'learn') setFeedback('info', 'Now from memory', 'Play the same line again without arrows.');
    else if (line.continuation) setFeedback('info', `↩ Back to move ${moveNumber(first.parent, true)} ${first.parent.san}`, `Branch ${line.part} of ${line.parts} – watch the opponent’s new move.`);
    else setFeedback('', 'Your move', `${gameTitle(meta.headers)} · ${chapterTitle(meta.chapter)}`);

    for (let i = start; i < line.nodes.length; i++) {
      if (cancelled) return null;
      const node = line.nodes[i];
      drawLineMoves(line, i, missed);
      if (!userIdx.has(i)) {
        // opponent (or passed-through) move
        await sleep(i === start ? 350 : settings.autoplayDelay);
        if (cancelled) return null;
        board.set(node.fen, { lastMove: node.from ? [node.from, node.to] : undefined, shapes: showCommentsNow ? nodeShapes(node) : [] });
        sound.move(node.san);
        if (settings.showCommentsInDrill) {
          if (showCommentsNow) coachItem(node, 'Opponent:');
          else pendingComments.push([node, 'Opponent:']);
        }
        if (showCommentsNow) noteItem(node.fen);
        continue;
      }
      const key = userIdx.get(i);
      const card = data.cards[key];
      const isNewCard = !card;
      const due = card && isDue(card, Date.now(), settings.srs);
      const arrow = phase === 'show' && isNewCard;
      const moveNumber = Math.floor((node.ply - 1) / 2) + 1;
      if (mode === 'review' && settings.autoplayKnown && !due && card && moveNumber > settings.alwaysPlayUntil) {
        // a later move you know that is not due: played for you
        await sleep(Math.min(settings.autoplayDelay, 350));
        if (cancelled) return null;
        board.set(node.fen, { lastMove: [node.from, node.to] });
        sound.move(node.san);
        if (settings.showCommentsInDrill) {
          for (const [n, who] of pendingComments.splice(0)) coachItem(n, who);
        }
        continue;
      }
      if (phase === 'show' && !isNewCard) setFeedback('', 'You know this one', 'Play your move.');
      else if (arrow) setFeedback('info', 'Play the arrow move', node.comment ? 'The author’s explanation appears after you play it.' : '');
      else setFeedback('', 'Your move', due ? 'This move is due for review.' : '');
      const res = await askMove(line, i, { arrow, graded: phase !== 'show' });
      if (!res || cancelled) return null;
      asked++;
      if (res.g === AGAIN) missed.add(i);
      else correct++;

      const severity = res.g === AGAIN ? mistakeSeverity(node) : 1;
      if (phase !== 'show') {
        stats.moves++;
        if (res.g !== AGAIN) stats.correct++;
        const escalate = applyGrade(key, node, line, res.g, res.ms, severity);
        if (res.g === AGAIN && severity < MILD) mildMisses.push(escalate);
      }
      if (res.g !== AGAIN) {
        board.flash('good');
        if (phase !== 'show') sound.good();
      }
      setFeedback(res.g === AGAIN ? 'bad' : 'good',
        res.g === AGAIN
          ? (severity < MILD && phase !== 'show'
            ? `${node.san} – late in the line, so it comes back in a few days, not today`
            : `${node.san} – you’ll see this again soon`)
          : `${node.san} ✓${res.g === HARD ? ' (a bit slow – marked Hard)' : ''}`,
        '');
      if (settings.showCommentsInDrill) {
        for (const [n, who] of pendingComments.splice(0)) coachItem(n, who);
        coachItem(node, 'Book:');
      }
      noteItem(node.fen);
    }
    drawLineMoves(line, line.nodes.length, missed);
    // two or more misses in one line: the line itself is shaky, so late slips count fully after all
    if (phase !== 'show' && missed.size >= 2 && mildMisses.length) {
      mildMisses.forEach(escalate => escalate());
      save('cards');
      coach.append(h('div.coach-item.note', h('div.who', '⚠ Shaky line'),
        h('div', `You missed ${missed.size} moves in this line, so all of them come back today.`)));
    }
    // comments held back until your next move would be lost when the line ends on the opponent's move
    for (const [n, who] of pendingComments.splice(0)) coachItem(n, who);
    const last = line.nodes[line.nodes.length - 1];
    if (!showCommentsNow && !userIdx.has(line.nodes.length - 1)) noteItem(last.fen);
    return { asked, correct, missed: missed.size };
  }

  // ---------------------------------------------------------------- main loop
  const waitNext = (label = 'Next line ▶') => new Promise(resolve => {
    nextBtn.textContent = label;
    nextBtn.hidden = false;
    nextBtn.focus();
    const go = () => {
      nextBtn.hidden = true;
      document.removeEventListener('keydown', key);
      resolve();
    };
    const key = e => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    };
    nextBtn.onclick = go;
    document.addEventListener('keydown', key);
  });

  let skip = false;
  skipBtn.onclick = () => {
    skip = true;
    cancelled = true;
    abortAsk?.();
    if (!nextBtn.hidden) nextBtn.click(); // also skips while waiting between the two learn passes
  };

  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'h') hintBtn.click();
    if (e.key === 's') answerBtn.click();
    if (e.key === 'u' && !misclickBtn.hidden) misclickBtn.click();
  }
  document.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- away (AFK) detection
  // Any mouse/keyboard input or move counts as activity. After afkMinutes without activity the
  // session stops; the time studied ends at the last activity and the pending move is not graded.
  let lastActivity = Date.now();
  let awayWarned = false;
  const activity = () => {
    lastActivity = Date.now();
    if (awayWarned) {
      awayWarned = false;
      awayBanner.hidden = true;
    }
  };
  pauseSync(true);
  const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, activity, { passive: true }));
  const awayBanner = h('div.away-banner', { hidden: true });
  document.body.append(awayBanner);
  const afkTimer = setInterval(() => {
    const limit = (settings.afkMinutes || 0) * 60 * 1000;
    if (!limit || finished) return;
    const idle = Date.now() - lastActivity;
    const warnBefore = Math.min(30 * 1000, limit / 2);
    if (idle >= limit) {
      finish({ away: true });
    } else if (idle >= limit - warnBefore) {
      awayWarned = true;
      awayBanner.textContent = `Still there? Move the mouse or press a key – the session stops in ${Math.ceil((limit - idle) / 1000)} seconds.`;
      awayBanner.hidden = false;
    }
  }, 1000);
  const stopAfk = () => {
    pauseSync(false);
    clearInterval(afkTimer);
    ACTIVITY_EVENTS.forEach(ev => document.removeEventListener(ev, activity));
    awayBanner.remove();
  };

  let finished = false;
  function finish({ away = false } = {}) {
    if (finished) return;
    finished = true;
    cancelled = true;
    abortAsk?.();
    stopAfk();
    stats.away = away;
    stats.end = away ? lastActivity : Date.now();
    if (stats.moves > 0 || stats.lines > 0) {
      data.sessions.push({ start: stats.start, end: stats.end, mode, lines: stats.lines, moves: stats.moves, correct: stats.correct, mistakes: stats.mistakes });
      saveNow('cards');
    }
    showSummary();
  }

  function resumeHref() {
    const q = new URLSearchParams(query);
    q.set('resume', Date.now()); // a new hash so the session restarts
    return `#/train/${mode}?${q}`;
  }

  function showSummary() {
    document.removeEventListener('keydown', onKey);
    board.destroy();
    const acc = pct(stats.correct, stats.moves);
    const dueLeft = mode !== 'practice' ? dueKeys(set).length : 0;
    clear(root, h('div.panel.session-summary', { style: { maxWidth: '720px', margin: '0 auto' } },
      h('h1', stats.away ? `${MODE_TITLES[mode]} – stopped` : `${MODE_TITLES[mode]} – done!`),
      stats.away ? h('div.feedback.info', h('div.title', '⏸ You were away'),
        h('div', `No activity for ${settings.afkMinutes} minute${settings.afkMinutes === 1 ? '' : 's'}, so the session was stopped. `
          + 'The time you were away is not counted as study time, and the move you were on was not graded.')) : null,
      h('div.summary-grid',
        h('div', h('div.label', 'Lines'), h('div.big-num', stats.lines)),
        h('div', h('div.label', 'Moves'), h('div.big-num', stats.moves)),
        h('div', h('div.label', 'Accuracy'), h('div.big-num', stats.moves ? `${acc}%` : '–')),
        h('div', h('div.label', 'Time'), h('div.big-num', { style: { fontSize: '22px' } }, fmtDuration((stats.end || Date.now()) - stats.start)))),
      Object.keys(stats.graded).length ? h('p.muted', [AGAIN, HARD, GOOD].filter(g => stats.graded[g]).map(g => `${GRADE_NAMES[g]}: ${stats.graded[g]}`).join(' · ')) : null,
      mode !== 'practice' ? h('p', h('b', 'When next? '), reviewAdvice(reviewPlan(set))) : null,
      h('div.row', { style: { marginTop: '12px' } },
        stats.away ? h('a.btn.primary', { href: resumeHref() }, 'Continue training') : null,
        mode !== 'review' && dueLeft ? h('a.btn.primary', { href: '#/train/review' }, 'Review due moves') : null,
        mode === 'learn' && stats.lines ? h('a.btn.primary', { href: `#/train/practice?recap=1${query.get('source') ? `&source=${encodeURIComponent(query.get('source'))}` : ''}` }, 'Recap today’s lines (recommended)') : null,
        mode === 'learn' ? h('button.btn', { onclick: () => { location.hash = `#/train/learn?again=${Date.now()}`; } }, 'Learn more lines') : null,
        h('a.btn', { href: '#/' }, 'Home'),
        h('a.btn', { href: '#/stats' }, 'Statistics'))));
  }

  (async () => {
    while (!cancelled || skip) {
      if (timeLimit && Date.now() - stats.start >= timeLimit) break;
      if (lineNo >= queue.length) {
        if (mode === 'review') fillQueue();
        else if (mode === 'practice') fillQueue();
        else queue = [];
        if (!queue.length) break;
        if (mode === 'review') setFeedback('info', 'Repeating the moves you missed', '');
      }
      skip = false;
      cancelled = false;
      const line = queue[lineNo];
      updateStatus();
      let res;
      if (mode === 'learn') {
        res = await playLine(line, 'show');
        if (res && !cancelled) {
          // let the comments of the last moves be read before the board resets
          setFeedback('good', 'Line shown ✓', 'Read the comments below, then play the line again from memory.');
          hintBtn.disabled = answerBtn.disabled = true;
          await waitNext('Play it from memory ▶');
          if (!cancelled) res = await playLine(line, 'recall');
        }
        if (res && !skip && !cancelled) {
          recordNewLine();
          learnBudget--;
        }
      } else {
        res = await playLine(line, 'recall');
      }
      if (skip) {
        lineNo++;
        continue;
      }
      if (!res || cancelled) break;
      stats.lines++;
      saveNow('cards');
      lineNo++;
      updateStatus();
      sound.done();
      const perfect = res.missed === 0;
      hintBtn.disabled = answerBtn.disabled = true;
      const nextLine = queue[lineNo];
      if (nextLine?.continuation && nextLine.group === line.group) {
        setFeedback(perfect ? 'good' : 'bad', perfect ? `Branch ${line.part}/${line.parts} ✓` : `Branch ${line.part}/${line.parts} – ${res.missed} mistake${res.missed > 1 ? 's' : ''}`,
          'Going back to where the next branch starts…');
        await sleep(1800);
        continue;
      }
      setFeedback(perfect ? 'good' : 'bad', perfect ? 'Line complete ✓' : `Line complete – ${res.missed} mistake${res.missed > 1 ? 's' : ''}`,
        `${res.correct}/${res.asked} moves correct. Read the comments below, then continue.`);
      await waitNext();
      if (cancelled && !skip) break;
    }
    if (!finished) finish();
  })();

  return () => {
    stopAfk();
    if (!finished) {
      cancelled = true;
      finished = true;
      abortAsk?.();
      document.removeEventListener('keydown', onKey);
      if (stats.moves > 0) {
        data.sessions.push({ start: stats.start, end: Math.min(Date.now(), lastActivity + 60 * 1000), mode, lines: stats.lines, moves: stats.moves, correct: stats.correct, mistakes: stats.mistakes });
        saveNow('cards');
      }
      board.destroy();
    }
  };
}
