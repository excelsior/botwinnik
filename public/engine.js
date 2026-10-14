// Stockfish in a web worker, for the eval bar. It runs only in the viewer's
// browser: nothing it says goes back to the server or to the players.

const ENGINE_URL = "/vendor/stockfish/stockfish-18-lite-single.js";
const DEPTH = 20;
const MAX_MS = 10_000;

/**
 * Evaluates one position at a time. Asking for a new position stops the
 * current search; updates for the old position are dropped.
 */
export class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.next = null; // { fen, onUpdate } waiting to start
    this.current = null; // the search in progress
    this.error = null;
  }

  /**
   * Evaluates `fen`; onUpdate gets { depth, cp } or { depth, mate } from
   * White's side as the search deepens, or { error } if the engine can't run.
   */
  analyse(fen, onUpdate) {
    if (this.error) return onUpdate({ error: this.error });
    if (this.current && this.current.fen === fen && !this.next) {
      this.current.onUpdate = onUpdate;
      if (this.current.last) onUpdate(this.current.last);
      return;
    }
    this.next = { fen, onUpdate };
    if (!this.worker) this.start();
    else if (this.searching) this.send("stop");
    else this.startNext();
  }

  /** Stops searching and forgets the callback (the worker stays loaded for the next game). */
  stop() {
    this.next = null;
    if (this.current) this.current.onUpdate = () => {};
    if (this.searching) this.send("stop");
  }

  start() {
    try {
      this.worker = new Worker(ENGINE_URL);
    } catch (err) {
      return this.fail(err.message);
    }
    this.worker.onmessage = (e) => this.onLine(String(e.data));
    this.worker.onerror = (e) => this.fail(e.message || "the engine failed to load");
    this.send("uci");
  }

  send(command) {
    this.worker?.postMessage(command);
  }

  fail(message) {
    this.error = `Stockfish isn't available: ${message}`;
    this.worker?.terminate();
    const waiting = [this.current, this.next].filter(Boolean);
    this.current = this.next = null;
    for (const job of waiting) job.onUpdate({ error: this.error });
  }

  startNext() {
    if (!this.ready || this.searching || !this.next) return;
    this.current = this.next;
    this.next = null;
    this.searching = true;
    this.send(`position fen ${this.current.fen}`);
    this.send(`go depth ${DEPTH} movetime ${MAX_MS}`);
  }

  onLine(line) {
    if (line === "uciok") {
      this.send("setoption name Hash value 32");
      this.send("isready");
    } else if (line === "readyok") {
      this.ready = true;
      this.startNext();
    } else if (line.startsWith("bestmove")) {
      this.searching = false;
      this.startNext();
    } else if (line.startsWith("info") && this.current && !this.next) {
      const score = parseInfo(line);
      if (!score) return;
      // The engine scores from the side to move; the bar shows White's side.
      const sign = this.current.fen.split(" ")[1] === "b" ? -1 : 1;
      const update =
        score.mate === 0
          ? { depth: score.depth, mate: 0, winner: sign === 1 ? "black" : "white" } // the side to move is mated
          : score.mate !== undefined
            ? { depth: score.depth, mate: sign * score.mate }
            : { depth: score.depth, cp: sign * score.cp };
      this.current.last = update;
      this.current.onUpdate(update);
    }
  }
}

/** "info depth 12 ... score cp -35 ..." to { depth, cp } or { depth, mate }; null for other lines. */
function parseInfo(line) {
  const m = /\bdepth (\d+)\b.*\bscore (cp|mate) (-?\d+)( lowerbound| upperbound)?/.exec(line);
  if (!m || m[4]) return null;
  const multipv = /\bmultipv (\d+)/.exec(line);
  if (multipv && multipv[1] !== "1") return null;
  const depth = Number(m[1]);
  return m[2] === "cp" ? { depth, cp: Number(m[3]) } : { depth, mate: Number(m[3]) };
}

/** White's share of the bar, 0 to 1, from an evaluation (Lichess's winning-chances curve). */
export function whiteShare(evaluation) {
  if (!evaluation || evaluation.error) return 0.5;
  if (evaluation.mate === 0) return evaluation.winner === "white" ? 1 : 0;
  if (evaluation.mate !== undefined) return evaluation.mate > 0 ? 1 : 0;
  const chances = 2 / (1 + Math.exp(-0.00368208 * evaluation.cp)) - 1;
  return Math.min(1, Math.max(0, (1 + chances) / 2));
}

/** "+1.3", "-0.4", "0.0", "M3", "#". */
export function evalLabel(evaluation) {
  if (!evaluation || evaluation.error) return "–";
  if (evaluation.mate === 0) return "#";
  if (evaluation.mate !== undefined) return `M${Math.abs(evaluation.mate)}`;
  const pawns = evaluation.cp / 100;
  if (Math.abs(pawns) < 0.05) return "0.0";
  return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
}

/** Which side the evaluation favors, for placing the label; null when level. */
export function favored(evaluation) {
  if (!evaluation || evaluation.error) return null;
  if (evaluation.mate === 0) return evaluation.winner;
  if (evaluation.mate !== undefined) return evaluation.mate > 0 ? "white" : "black";
  return evaluation.cp > 0 ? "white" : evaluation.cp < 0 ? "black" : null;
}
