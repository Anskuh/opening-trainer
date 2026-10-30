// Stockfish 19 (lite, single-threaded WASM) running in a Web Worker – works offline.
import { Chess } from '../vendor/chess.js';

const ENGINE_URL = 'vendor/stockfish/stockfish-19-lite-single.js';

/**
 * const engine = createEngine({ multiPv: 3, depth: 24, onUpdate(result) })
 * engine.analyze(fen)  – (re)starts analysis; onUpdate gets
 *   { fen, depth, lines: [{ multipv, cp, mate, pvUci, pvSan, whiteCp, whiteMate }], done }
 * engine.stop(), engine.destroy()
 */
export function createEngine({ multiPv = 3, depth = 24, onUpdate } = {}) {
  let worker;
  try {
    worker = new Worker(ENGINE_URL);
  } catch (e) {
    return null;
  }
  let ready = false;
  let searching = false;
  let wanted = null; // fen we want analysed
  let current = null; // fen being analysed
  let lines = [];
  let lastDepth = 0;
  let throttle = 0;

  const send = cmd => worker.postMessage(cmd);

  function start() {
    if (!ready || searching || !wanted) return;
    current = wanted;
    wanted = null;
    lines = [];
    lastDepth = 0;
    searching = true;
    send(`position fen ${current}`);
    send(`go depth ${depth}`);
  }

  function toSan(fen, uciMoves) {
    const chess = new Chess(fen);
    const out = [];
    for (const u of uciMoves) {
      try {
        const m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        out.push({ san: m.san, ply: out.length, color: m.color });
      } catch (e) {
        break;
      }
    }
    return out;
  }

  function emit(done = false) {
    const turn = current.split(' ')[1];
    const sorted = lines.filter(Boolean).sort((a, b) => a.multipv - b.multipv);
    onUpdate?.({
      fen: current,
      depth: lastDepth,
      done,
      lines: sorted.map(l => ({
        ...l,
        whiteCp: l.cp === undefined ? undefined : (turn === 'w' ? l.cp : -l.cp),
        whiteMate: l.mate === undefined ? undefined : (turn === 'w' ? l.mate : -l.mate),
        pvSan: toSan(current, l.pvUci.slice(0, 12)),
      })),
    });
  }

  worker.onmessage = e => {
    const msg = String(e.data);
    if (msg === 'uciok') {
      send(`setoption name MultiPV value ${multiPv}`);
      send('setoption name Hash value 32');
      send('isready');
    } else if (msg === 'readyok') {
      ready = true;
      start();
    } else if (msg.startsWith('bestmove')) {
      searching = false;
      if (!wanted && current) emit(true);
      start();
    } else if (msg.startsWith('info') && searching && !wanted && msg.includes(' pv ')) {
      const d = /\bdepth (\d+)/.exec(msg);
      const mpv = /\bmultipv (\d+)/.exec(msg);
      const cp = /\bscore cp (-?\d+)/.exec(msg);
      const mate = /\bscore mate (-?\d+)/.exec(msg);
      const pv = / pv (.+)$/.exec(msg);
      if (!d || !pv || / (lowerbound|upperbound) /.test(msg)) return;
      const k = mpv ? +mpv[1] : 1;
      lastDepth = Math.max(lastDepth, +d[1]);
      lines[k - 1] = {
        multipv: k, depth: +d[1],
        cp: cp ? +cp[1] : undefined, mate: mate ? +mate[1] : undefined,
        pvUci: pv[1].trim().split(/\s+/),
      };
      const now = performance.now();
      if (now - throttle > 200) {
        throttle = now;
        emit(false);
      }
    }
  };
  worker.onerror = () => onUpdate?.({ error: 'The engine could not be started.' });
  send('uci');

  return {
    analyze(fen) {
      wanted = fen;
      if (searching) send('stop'); // bestmove arrives, then the new search starts
      else start();
    },
    stop() {
      wanted = null;
      if (searching) send('stop');
    },
    destroy() {
      worker.terminate();
    },
  };
}

/** "+0.35", "-1.20", "#3", "#-2" from White's point of view. */
export function formatEval(line) {
  if (!line) return '…';
  if (line.whiteMate !== undefined) return line.whiteMate === 0 ? '#' : `#${line.whiteMate}`;
  if (line.whiteCp === undefined) return '…';
  const v = line.whiteCp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** 0..1 share of the eval bar for White. */
export function whiteShare(line) {
  if (!line) return 0.5;
  if (line.whiteMate !== undefined) return line.whiteMate > 0 ? 1 : 0;
  const cp = Math.max(-1000, Math.min(1000, line.whiteCp ?? 0));
  return 1 / (1 + Math.exp(-0.004 * cp));
}
