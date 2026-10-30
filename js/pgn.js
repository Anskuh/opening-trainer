// PGN parsing into a move tree with variations, comments, NAGs and drawn shapes.
import { Chess, DEFAULT_POSITION } from '../vendor/chess.js';

export const NAG_SYMBOLS = {
  1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!', 7: '□', 10: '=', 13: '∞',
  14: '⩲', 15: '⩱', 16: '±', 17: '∓', 18: '+−', 19: '−+', 22: '⨀', 23: '⨀',
  32: '⟳', 33: '⟳', 36: '↑', 37: '↑', 40: '→', 41: '→', 44: '=/∞', 45: '=/∞',
  132: '⇆', 133: '⇆', 138: '⊕', 139: '⊕', 140: '∆', 142: '⌓', 145: 'RR', 146: 'N',
};

export const NAG_NAMES = {
  1: 'good move', 2: 'mistake', 3: 'brilliant move', 4: 'blunder', 5: 'interesting move',
  6: 'dubious move', 7: 'only move', 10: 'equal', 13: 'unclear', 14: 'White is slightly better',
  15: 'Black is slightly better', 16: 'White is better', 17: 'Black is better',
  18: 'White is winning', 19: 'Black is winning', 22: 'zugzwang', 32: 'development advantage',
  36: 'initiative', 40: 'attack', 44: 'compensation', 132: 'counterplay', 140: 'with the idea',
  142: 'better is', 146: 'novelty',
};

export const MOVE_NAGS = new Set([1, 2, 3, 4, 5, 6, 7]);
const BAD_NAGS = new Set([2, 4, 6]);
const SUFFIX_NAGS = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6, '□': 7 };
const BRUSHES = { G: 'green', R: 'red', Y: 'yellow', B: 'blue' };

const HEADER_RE = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/;

/** Split a PGN file into games: [{ headers, movetext }]. Cheap; no move parsing. */
export function splitGames(text) {
  const games = [];
  let cur = null;
  let inMoves = false;
  for (const line of text.split(/\r?\n/)) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (!cur || inMoves) {
        cur = { headers: {}, lines: [] };
        games.push(cur);
        inMoves = false;
      }
      cur.headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
    } else if (line.trim() && !line.startsWith('%')) {
      if (!cur) {
        cur = { headers: {}, lines: [] };
        games.push(cur);
      }
      cur.lines.push(line);
      inMoves = true;
    }
  }
  return games.map(g => ({ headers: g.headers, movetext: g.lines.join('\n') }));
}

/** Extract [%cal ...] / [%csl ...] shapes and strip all [%...] commands from a comment. */
function parseComment(raw) {
  const shapes = [];
  const text = raw.replace(/\[%(\w+)\s*([^\]]*)\]/g, (_, cmd, arg) => {
    if (cmd === 'cal' || cmd === 'csl') {
      for (const part of arg.split(',')) {
        const p = part.trim();
        const brush = BRUSHES[p[0]];
        if (!brush) continue;
        if (cmd === 'cal' && /^[a-h][1-8][a-h][1-8]$/.test(p.slice(1, 5))) {
          shapes.push({ orig: p.slice(1, 3), dest: p.slice(3, 5), brush });
        } else if (cmd === 'csl' && /^[a-h][1-8]$/.test(p.slice(1, 3))) {
          shapes.push({ orig: p.slice(1, 3), brush });
        }
      }
    }
    return ' ';
  });
  return { text: text.replace(/\s+/g, ' ').trim(), shapes };
}

const TOKEN_RE = /\{([^}]*)\}|;([^\n]*)|(\()|(\))|\$(\d+)|(\d+\.(?:\.\.)?|\d+…)|(1-0|0-1|1\/2-1\/2|\*)(?=\s|$|\))|([!?□]{1,2})(?=\s|$|[({)])|([^\s{}();$]+)/g;

function appendText(a, b) {
  if (!b) return a;
  return a ? `${a} ${b}` : b;
}

/**
 * Parse a game (from splitGames) into a tree.
 * Node: { id, ply, san, from, to, promotion, fen, parent, children, comment, pre, nags, shapes }
 * Returns { headers, root, nodes, errors }.
 */
export function parseGame(game) {
  const headers = game.headers;
  const startFen = headers.FEN || DEFAULT_POSITION;
  const pos = new Chess();
  const errors = [];
  try {
    pos.load(startFen);
  } catch (e) {
    return { headers, root: null, nodes: [], errors: [`Invalid FEN: ${startFen}`] };
  }
  const fenParts = pos.fen().split(' ');
  const startPly = (parseInt(fenParts[5], 10) - 1) * 2 + (fenParts[1] === 'b' ? 1 : 0);
  const root = {
    id: 0, ply: startPly, san: null, fen: pos.fen(), parent: null, children: [],
    comment: '', pre: '', nags: [], shapes: [],
  };
  const nodes = [root];
  let cur = root;
  let pendingPre = '';
  let pendingShapes = [];
  let variationStart = true; // true right after "(" or at the start of the game
  const stack = [];
  let skipDepth = 0; // >0 while skipping a broken variation

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(game.movetext))) {
    const [, comment, lineComment, open, close, nag, , result, suffix, san] = m;
    if (skipDepth > 0) {
      if (open) skipDepth++;
      else if (close && --skipDepth === 0) {
        const s = stack.pop();
        cur = s.node;
        pos.load(s.fen);
        variationStart = false;
      }
      continue;
    }
    if (comment !== undefined || lineComment !== undefined) {
      const { text, shapes } = parseComment(comment ?? lineComment);
      if (variationStart && cur !== root) {
        pendingPre = appendText(pendingPre, text);
        pendingShapes.push(...shapes);
      } else {
        cur.comment = appendText(cur.comment, text);
        cur.shapes.push(...shapes);
      }
    } else if (open) {
      if (cur === root) { skipDepth = 1; stack.push({ node: cur, fen: pos.fen() }); continue; }
      stack.push({ node: cur, fen: pos.fen() });
      cur = cur.parent;
      pos.load(cur.fen);
      variationStart = true;
    } else if (close) {
      const s = stack.pop();
      if (!s) continue;
      cur = s.node;
      pos.load(s.fen);
      variationStart = false;
    } else if (nag) {
      if (cur !== root) cur.nags.push(parseInt(nag, 10));
    } else if (suffix) {
      if (cur !== root && SUFFIX_NAGS[suffix]) cur.nags.push(SUFFIX_NAGS[suffix]);
    } else if (result) {
      // end of game marker
    } else if (san) {
      let token = san.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
      const suffixMatch = /([!?□]{1,2})$/.exec(token);
      let suffixNag = null;
      if (suffixMatch) {
        suffixNag = SUFFIX_NAGS[suffixMatch[1]];
        token = token.slice(0, -suffixMatch[1].length);
      }
      if (/^\d*\.+$/.test(token) || token === '') continue;
      const isNull = token === 'Z0' || token === '--';
      let move = null;
      try {
        move = isNull ? pos.move(null) : pos.move(token, { strict: true });
      } catch (e) {
        try {
          if (!isNull) move = pos.move(token, { strict: false });
        } catch (e2) { /* illegal */ }
      }
      if (!move) {
        errors.push(`Illegal move "${token}" after ${cur.san || 'start'} (ply ${cur.ply})`);
        if (stack.length === 0) break; // main line broken: stop
        skipDepth = 1; // skip rest of this variation
        continue;
      }
      let node = cur.children.find(c => c.san === move.san);
      if (!node) {
        node = {
          id: nodes.length, ply: cur.ply + 1, san: isNull ? '--' : move.san,
          from: isNull ? undefined : move.from, to: isNull ? undefined : move.to,
          promotion: move.promotion, fen: move.after, parent: cur, children: [],
          comment: '', pre: '', nags: [], shapes: [],
        };
        nodes.push(node);
        cur.children.push(node);
      }
      if (pendingPre || pendingShapes.length) {
        node.pre = appendText(node.pre, pendingPre);
        node.shapes.push(...pendingShapes);
        pendingPre = '';
        pendingShapes = [];
      }
      if (suffixNag) node.nags.push(suffixNag);
      cur = node;
      variationStart = false;
    }
  }
  return { headers, root, nodes, errors };
}

// ------------------------------------------------------------------ writing PGN

const BRUSH_LETTERS = { green: 'G', red: 'R', yellow: 'Y', blue: 'B' };

function commentText(text, shapes = []) {
  const cal = shapes.filter(s => s.dest && BRUSH_LETTERS[s.brush]).map(s => `${BRUSH_LETTERS[s.brush]}${s.orig}${s.dest}`);
  const csl = shapes.filter(s => !s.dest && BRUSH_LETTERS[s.brush]).map(s => `${BRUSH_LETTERS[s.brush]}${s.orig}`);
  const parts = [];
  if (csl.length) parts.push(`[%csl ${csl.join(',')}]`);
  if (cal.length) parts.push(`[%cal ${cal.join(',')}]`);
  if (text) parts.push(text.replace(/[{}]/g, m => (m === '{' ? '(' : ')')));
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/** Serialise a game tree back to PGN (temporary "explore" moves are left out). */
export function toPgn(headers, root) {
  const tokens = [];
  const moveTokens = (node, forceNumber) => {
    if (node.pre) tokens.push(commentText(node.pre));
    const p = node.ply - 1;
    if (p % 2 === 0) tokens.push(`${Math.floor(p / 2) + 1}.`);
    else if (forceNumber || node.pre) tokens.push(`${Math.floor(p / 2) + 1}...`);
    tokens.push(node.san === '--' ? 'Z0' : node.san);
    for (const n of node.nags) tokens.push(`$${n}`);
    const c = commentText(node.comment, node.shapes);
    if (c) tokens.push(c);
  };
  const line = (node, forceFirst) => {
    let n = node;
    let force = forceFirst;
    for (;;) {
      const kids = n.children.filter(k => !k.temp);
      if (!kids.length) return;
      const main = kids[0];
      moveTokens(main, force);
      force = !!main.comment || !!main.shapes.length;
      for (const alt of kids.slice(1)) {
        tokens.push('(');
        moveTokens(alt, true);
        line(alt, !!alt.comment);
        tokens.push(')');
        force = true;
      }
      n = main;
    }
  };
  const rootComment = commentText(root.comment, root.shapes);
  if (rootComment) tokens.push(rootComment);
  line(root, true);
  tokens.push(headers.Result || '*');

  // wrap at ~80 characters; no space after "(" or before ")"
  let text = '';
  let lineLen = 0;
  let prev = '';
  for (const t of tokens) {
    const glue = !text || prev === '(' || t === ')' ? '' : ' ';
    if (lineLen + glue.length + t.length > 80 && glue) {
      text += '\n';
      lineLen = 0;
    } else {
      text += glue;
      lineLen += glue.length;
    }
    text += t;
    lineLen += t.length;
    prev = t;
  }
  const head = Object.entries(headers).map(([k, v]) => `[${k} "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join('\n');
  return `${head}\n\n${text}\n`;
}

// ------------------------------------------------------------------ helpers

export function turnOf(fen) {
  return fen.split(' ')[1];
}

/** Position key without move counters, so transpositions share a key. */
export function normFen(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function uciOf(node) {
  return node.from + node.to + (node.promotion || '');
}

export function isBadMove(node) {
  return node.nags.some(n => BAD_NAGS.has(n));
}

/** Move number label, e.g. "12." or "12..." */
export function moveNumber(node, forceBlack = false) {
  const p = node.ply - 1;
  const n = Math.floor(p / 2) + 1;
  return p % 2 === 0 ? `${n}.` : forceBlack ? `${n}...` : '';
}

export function nagText(node, onlyMoveNags = false) {
  return node.nags
    .filter(n => !onlyMoveNags || MOVE_NAGS.has(n))
    .map(n => NAG_SYMBOLS[n] || '')
    .join('');
}

export function sanPath(node) {
  const path = [];
  for (let n = node; n && n.san; n = n.parent) path.push(n.san);
  return path.reverse();
}

export function findBySanPath(root, sans) {
  let n = root;
  for (const s of sans) {
    n = n.children.find(c => c.san === s);
    if (!n) return null;
  }
  return n;
}

export function lineToString(nodes) {
  return nodes.map((n, i) => (i === 0 || n.ply % 2 === 1 ? moveNumber(n, true) + ' ' : '') + n.san)
    .join(' ').replace(/\. /g, '.');
}

/**
 * The move the user should play at a node where it is their turn:
 * the main line, unless it is marked as bad and a better alternative exists.
 */
export function repertoireChild(node) {
  const kids = node.children.filter(c => !c.temp); // temp = explored in Study, not part of the file
  if (!kids.length) return null;
  if (!isBadMove(kids[0])) return kids[0];
  const rank = c => (c.nags.includes(3) ? 0 : c.nags.includes(1) ? 1 : c.nags.includes(142) ? 2
    : c.nags.includes(5) ? 3 : isBadMove(c) ? 9 : 4);
  let best = kids[0];
  for (const c of kids) if (rank(c) < rank(best)) best = c;
  return best;
}

/**
 * All training lines of a game for the given colour ('w' | 'b').
 * At the user's turn only the repertoire move is followed, at the opponent's turn every branch.
 * Returns arrays of nodes (first move .. last move).
 */
export function buildLines(root, color, maxPlies = 40, choose = null) {
  const lines = [];
  const path = [];
  // choose(node) may return the uci you decided to play in this position (see "move choices");
  // the line then follows that move, or ends here if this game doesn't contain it
  const userChild = node => {
    const chosen = choose?.(node);
    if (!chosen) return [repertoireChild(node)];
    const c = node.children.find(k => !k.temp && k.from && uciOf(k) === chosen);
    return c ? [c] : [];
  };
  const walk = (node, hasUserMove) => {
    const atLimit = node.ply - root.ply >= maxPlies;
    let next = [];
    if (!atLimit && node.children.length) {
      next = turnOf(node.fen) === color ? userChild(node) : node.children;
      // null moves ("what if he passes") are not trainable; temp moves only exist in Study
      next = next.filter(c => c && c.san !== '--' && !c.temp);
    }
    if (!next.length) {
      if (hasUserMove) lines.push(path.slice());
      return;
    }
    for (const child of next) {
      path.push(child);
      walk(child, hasUserMove || turnOf(node.fen) === color);
      path.pop();
    }
  };
  walk(root, false);
  return lines;
}

/** Guess which side a game is written for: branches mostly appear at the opponent's turns. */
export function guessColor(root) {
  let atWhite = 0;
  let atBlack = 0;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.children.length > 1) {
      if (turnOf(n.fen) === 'w') atWhite += n.children.length - 1;
      else atBlack += n.children.length - 1;
    }
    stack.push(...n.children);
  }
  if (atWhite === atBlack) return null;
  return atWhite > atBlack ? 'b' : 'w';
}

export function countNodes(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    count++;
    stack.push(...n.children);
  }
  return count;
}
