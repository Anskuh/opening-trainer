// Chessground board wired to chess.js for legal move generation.
import { Chessground } from '../vendor/chessground.min.js';
import { Chess } from '../vendor/chess.js';

export const BOARD_THEMES = {
  brown: ['#f0d9b5', '#b58863'],
  green: ['#eeeed2', '#769656'],
  blue: ['#dee3e6', '#8ca2ad'],
  purple: ['#e8e2f0', '#9f90b0'],
  grey: ['#dcdcdc', '#9e9e9e'],
};

function themeCss() {
  let css = '';
  for (const [name, [light, dark]] of Object.entries(BOARD_THEMES)) {
    let path = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) path += `M${x} ${y}h1v1h-1z`;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' shape-rendering='crispEdges'>`
      + `<rect width='8' height='8' fill='${light}'/><path fill='${dark}' d='${path}'/></svg>`;
    css += `.board-theme-${name} cg-board{background-color:${light};background-image:url("data:image/svg+xml,${encodeURIComponent(svg)}")}\n`;
    css += `.board-theme-${name} .cg-wrap coords.ranks coord:nth-child(odd),.board-theme-${name} .cg-wrap coords.files coord:nth-child(even){color:${light}}\n`;
    css += `.board-theme-${name} .cg-wrap coords.ranks coord:nth-child(even),.board-theme-${name} .cg-wrap coords.files coord:nth-child(odd){color:${dark}}\n`;
  }
  return css;
}

let themeStyleAdded = false;
export function setBoardTheme(name) {
  if (!themeStyleAdded) {
    const style = document.createElement('style');
    style.textContent = themeCss();
    document.head.append(style);
    themeStyleAdded = true;
  }
  for (const n of Object.keys(BOARD_THEMES)) document.body.classList.toggle(`board-theme-${n}`, n === name);
}

const colorName = c => (c === 'w' ? 'white' : 'black');

/**
 * createBoard(el, { orientation: 'w'|'b', onMove(move) })
 * onMove receives { from, to, promotion, san, fen } for legal user moves.
 */
export function createBoard(el, { orientation = 'w', onMove } = {}) {
  const chess = new Chess();
  let movableColor = null; // 'w' | 'b' | 'both' | null
  let promotionHint = null;

  const cg = Chessground(el, {
    orientation: colorName(orientation),
    coordinates: true,
    animation: { enabled: true, duration: 180 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: handleMove } },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    blockTouchScroll: true, // dragging a piece must not scroll the page on a phone
    drawable: { enabled: true, visible: true, defaultSnapToValidMove: true },
  });

  function dests() {
    const map = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!map.has(m.from)) map.set(m.from, []);
      map.get(m.from).push(m.to);
    }
    return map;
  }

  function sync(lastMove) {
    const turn = chess.turn();
    const canMove = movableColor === 'both' || movableColor === turn;
    cg.set({
      fen: chess.fen(),
      turnColor: colorName(turn),
      check: chess.inCheck(),
      lastMove,
      movable: { color: canMove ? colorName(turn) : undefined, dests: canMove ? dests() : new Map() },
    });
  }

  function handleMove(orig, dest) {
    const piece = chess.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) promotion = promotionHint || 'q';
    let move;
    try {
      move = chess.move({ from: orig, to: dest, promotion });
    } catch (e) {
      sync();
      return;
    }
    const result = { from: move.from, to: move.to, promotion: move.promotion, san: move.san, fen: move.after };
    chess.undo(); // the caller decides whether the move is accepted
    onMove?.(result);
  }

  const api = {
    cg,
    chess,
    /** Play a move as if the user dragged it (used by automated tests). */
    simulateMove: handleMove,
    /** Show a position. opts: { lastMove: [from, to], movable: 'w'|'b'|'both'|null, shapes, promotionHint } */
    set(fen, opts = {}) {
      chess.load(fen);
      movableColor = opts.movable ?? null;
      promotionHint = opts.promotionHint || null;
      sync(opts.lastMove);
      cg.setAutoShapes(opts.shapes || []);
      if (opts.clearShapes !== false) cg.setShapes([]);
    },
    setShapes(shapes) {
      cg.setAutoShapes(shapes || []);
    },
    setOrientation(color) {
      cg.set({ orientation: colorName(color) });
    },
    orientation() {
      return cg.state.orientation === 'white' ? 'w' : 'b';
    },
    flip() {
      cg.toggleOrientation();
    },
    /** Re-sync after a rejected move (chessground has already moved the piece). */
    reset() {
      sync(cg.state.lastMove);
    },
    flash(kind) {
      el.classList.remove('flash-good', 'flash-bad');
      void el.offsetWidth;
      el.classList.add(`flash-${kind}`);
    },
    redraw() {
      cg.redrawAll();
    },
    destroy() {
      cg.destroy();
    },
  };
  el.__board = api;
  return api;
}

/** Chessground shapes for a node's [%cal]/[%csl] annotations. */
export function nodeShapes(node) {
  return (node?.shapes || []).map(s => ({ ...s }));
}

export function moveArrow(node, brush = 'green') {
  return node?.from ? [{ orig: node.from, dest: node.to, brush }] : [];
}
