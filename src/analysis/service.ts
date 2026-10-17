import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import type { AnalysisSettings } from "../config.js";
import type { GameService } from "../game/service.js";
import { opponent, playerKey, type Color, type GameRecord } from "../game/types.js";
import { TIME_CATEGORIES, type TimeCategory } from "../timeControl.js";
import { accuracyReport, averageAccuracy, type AccuracyAverage, type MoveReport, type PositionEval, type SideReport } from "./accuracy.js";
import { UciEngine, type Engine, type SearchResult } from "./engine.js";

/** A finished game's evaluations, saved as <games dir>/analysis/<game id>.json. */
export interface GameAnalysis {
  version: 1;
  gameId: string;
  /** The position and moves (UCI) analyzed, so a game whose moves aren't these any more is analyzed again. */
  startFen: string;
  moves: string[];
  /** The engine's name and how deep it searched each position. */
  engine: string;
  depth: number;
  analyzedAt: string;
  /** The start position's evaluation, then the evaluation after each move. */
  evals: PositionEval[];
}

/** A move's report, with the engine's choice written in SAN. */
export interface MoveView extends MoveReport {
  bestSan?: string;
}

/** Where a finished game's analysis stands, and once it's done, what it found. */
export type GameAnalysisView =
  | { status: "queued" }
  | { status: "analyzing"; progress: { done: number; total: number } }
  | { status: "failed"; error: string }
  | {
      status: "done";
      engine: string;
      depth: number;
      analyzedAt: string;
      white: SideReport;
      black: SideReport;
      moves: MoveView[];
    };

/** Each player's accuracy over several games, by "provider:model". */
export type PlayerAccuracies = Map<string, AccuracyAverage>;

/** Saves each game's analysis as <games dir>/analysis/<game id>.json. */
export class AnalysisStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(analysis: GameAnalysis): void {
    const file = this.file(analysis.gameId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(analysis));
    renameSync(tmp, file);
  }

  load(gameId: string): GameAnalysis | undefined {
    if (!/^[\w-]+$/.test(gameId)) return undefined;
    const file = this.file(gameId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as GameAnalysis;
    } catch {
      return undefined; // unreadable: analyzed again
    }
  }

  private file(gameId: string): string {
    return path.join(this.dir, `${gameId}.json`);
  }
}

type Listener = () => void;

/**
 * Has Stockfish (or another UCI engine) analyze finished games, one at a time
 * in the background, and works out the players' accuracy from the analyses.
 * Games are analyzed only once they're over, so nothing the engine says can
 * reach the players.
 */
export class AnalysisService {
  readonly store: AnalysisStore;
  /** Games waiting for the engine, by ID, next first. */
  private readonly queue: string[] = [];
  private current: { id: string; done: number; total: number } | null = null;
  /** Why analyzing a game failed; it isn't tried again until the app restarts or it's asked for again. */
  private readonly failed = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly waiters = new Map<string, { resolve: (a: GameAnalysis) => void; reject: (err: Error) => void }[]>();
  private readonly startEngine: (settings: AnalysisSettings) => Promise<Engine>;
  private engine: Promise<Engine> | null = null;
  private working = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly games: GameService,
    /** Null when analysis is turned off: analyses already saved still count. */
    readonly settings: AnalysisSettings | null,
    options: { store?: AnalysisStore; startEngine?: (settings: AnalysisSettings) => Promise<Engine> } = {},
  ) {
    this.store = options.store ?? new AnalysisStore(path.join(games.store.dir, "analysis"));
    this.startEngine = options.startEngine ?? ((s) => UciEngine.start(s.engine, { hashMb: 64 }));
  }

  /**
   * Analyzes each game as it finishes, and queues the finished games that
   * haven't been analyzed yet, newest first. Returns how many it queued.
   */
  start(): number {
    if (!this.settings) return 0;
    this.games.subscribeAll((game) => {
      if (game.status !== "finished") return;
      try {
        this.ensure(game, { urgent: true });
      } catch (err) {
        console.error(`Couldn't queue game ${game.id} for analysis:`, err);
      }
    });
    return this.games.records().filter((g) => this.ensure(g)).length;
  }

  /**
   * Queues a finished game that has no analysis of its current moves (or, with
   * `force`, any finished game). `urgent` puts it at the front of the queue.
   * Returns whether the game is waiting for the engine now.
   */
  ensure(game: GameRecord, { urgent = false, force = false } = {}): boolean {
    if (!this.settings || game.status !== "finished") return false;
    if (this.current?.id === game.id) return false;
    const queued = this.queue.indexOf(game.id);
    if (queued >= 0) {
      if (urgent && queued > 0) this.queue.unshift(...this.queue.splice(queued, 1));
      return true;
    }
    if (!force && (this.failed.has(game.id) || this.analysisOf(game))) return false;
    this.failed.delete(game.id);
    if (urgent) this.queue.unshift(game.id);
    else this.queue.push(game.id);
    this.emit(game.id);
    this.pump();
    return true;
  }

  /** Analyzes a finished game now (again, if it has been), ahead of the queue. */
  analyze(game: GameRecord, onProgress?: (done: number, total: number) => void): Promise<GameAnalysis> {
    if (!this.settings) return Promise.reject(new Error("Analysis is turned off in config.ini ([analysis] engine = off)."));
    if (game.status !== "finished") return Promise.reject(new Error("Only finished games are analyzed."));
    const result = new Promise<GameAnalysis>((resolve, reject) => {
      this.waiters.set(game.id, [...(this.waiters.get(game.id) ?? []), { resolve, reject }]);
    });
    const unsubscribe = onProgress
      ? this.subscribe(game.id, () => {
          if (this.current?.id === game.id) onProgress(this.current.done, this.current.total);
        })
      : () => {};
    if (this.current?.id !== game.id) this.ensure(game, { urgent: true, force: true });
    return result.finally(unsubscribe);
  }

  /** Games waiting for the engine, including the one it's on. */
  pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** Resolves once the queue is empty and the engine is done. */
  async whenIdle(): Promise<void> {
    while (this.working) await this.idle;
  }

  /** The saved analysis of a game's current moves, if there is one. */
  analysisOf(game: Pick<GameRecord, "id" | "startFen" | "moves">): GameAnalysis | undefined {
    const analysis = this.store.load(game.id);
    if (
      !analysis ||
      analysis.version !== 1 ||
      analysis.startFen !== game.startFen ||
      analysis.moves.length !== game.moves.length ||
      analysis.moves.some((uci, i) => uci !== game.moves[i].uci) ||
      analysis.evals.length !== game.moves.length + 1
    ) {
      return undefined;
    }
    return analysis;
  }

  /** Where a game's analysis stands; null for a game that isn't finished or won't be analyzed. */
  view(game: GameRecord): GameAnalysisView | null {
    if (game.status !== "finished") return null;
    if (this.current?.id === game.id) return { status: "analyzing", progress: { done: this.current.done, total: this.current.total } };
    if (this.queue.includes(game.id)) return { status: "queued" };
    const analysis = this.analysisOf(game);
    if (analysis) {
      const report = accuracyReport(analysis.evals, game.moves);
      return {
        status: "done",
        engine: analysis.engine,
        depth: analysis.depth,
        analyzedAt: analysis.analyzedAt,
        white: report.white,
        black: report.black,
        moves: report.moves.map((m) => (m.best ? { ...m, bestSan: sanOf(game, m.ply, m.best) } : m)),
      };
    }
    const error = this.failed.get(game.id);
    return error ? { status: "failed", error } : null;
  }

  /** Each side's accuracy in a finished game that has been analyzed. */
  accuracyOf(game: GameRecord): Record<Color, number | null> | null {
    if (game.status !== "finished") return null;
    const analysis = this.analysisOf(game);
    if (!analysis) return null;
    const report = accuracyReport(analysis.evals, game.moves);
    return { white: report.white.accuracy, black: report.black.accuracy };
  }

  /**
   * Each player's average accuracy over the analyzed finished games among
   * `games`. A model playing itself counts for both sides.
   */
  averages(games: readonly GameRecord[]): PlayerAccuracies {
    const accuracies = new Map<string, number[]>();
    for (const game of games) {
      const sides = this.accuracyOf(game);
      if (!sides) continue;
      for (const color of ["white", "black"] as const) {
        const accuracy = sides[color];
        if (accuracy === null) continue;
        const key = playerKey(game[color]);
        accuracies.set(key, [...(accuracies.get(key) ?? []), accuracy]);
      }
    }
    return new Map([...accuracies].map(([key, list]) => [key, averageAccuracy(list)!]));
  }

  /** Each player's average accuracy in each time category. */
  byCategory(games: readonly GameRecord[]): Record<TimeCategory, PlayerAccuracies> {
    return Object.fromEntries(
      TIME_CATEGORIES.map((c) => [c, this.averages(games.filter((g) => g.timeControl.category === c))]),
    ) as Record<TimeCategory, PlayerAccuracies>;
  }

  /** Calls `listener` whenever the game's analysis moves on: queued, a position done, finished or failed. */
  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private emit(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener();
      } catch (err) {
        console.error(`An analysis listener for game ${id} failed:`, err);
      }
    }
  }

  private pump(): void {
    if (this.working) return;
    this.working = true;
    let settle!: () => void;
    this.idle = new Promise((resolve) => (settle = resolve));
    void (async () => {
      try {
        await this.work();
      } catch (err) {
        console.error("Stockfish analysis stopped:", err);
      } finally {
        this.stopEngine();
        this.working = false;
        settle();
        if (this.queue.length) this.pump();
      }
    })();
  }

  private async work(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      const game = this.games.get(id);
      if (game?.status !== "finished") {
        this.finish(id, new Error(game ? "Only finished games are analyzed." : `No game ${id}.`));
        continue;
      }
      this.current = { id, done: 0, total: game.moves.length + 1 };
      this.emit(id);
      try {
        const analysis = await this.run(game);
        this.finish(id, analysis);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (err instanceof EngineStartError) {
          // No engine, no point trying the rest: they're tried again when the app restarts.
          console.error(`Stockfish analysis is off until the app restarts. ${error.message}`);
          for (const queued of [id, ...this.queue.splice(0)]) this.finish(queued, error);
        } else {
          console.error(`Couldn't analyze game ${id}: ${error.message}`);
          this.finish(id, error);
          this.stopEngine(); // start afresh for the next game
        }
      }
    }
  }

  private async run(game: GameRecord): Promise<GameAnalysis> {
    const settings = this.settings!;
    this.engine ??= this.startEngine(settings).catch((err) => {
      throw new EngineStartError(err instanceof Error ? err.message : String(err));
    });
    const engine = await this.engine;
    await engine.newGame();
    const moves = game.moves.map((m) => m.uci);
    const end = finalEval(game);
    const evals: PositionEval[] = [];
    for (let ply = 0; ply <= moves.length; ply++) {
      if (ply === moves.length && end) evals.push(end);
      else evals.push(fromWhite(await engine.search(game.startFen, moves.slice(0, ply), settings.depth), sideToMove(game, ply)));
      this.current!.done = ply + 1;
      this.emit(game.id);
    }
    const analysis: GameAnalysis = {
      version: 1,
      gameId: game.id,
      startFen: game.startFen,
      moves,
      engine: engine.name,
      depth: settings.depth,
      analyzedAt: new Date().toISOString(),
      evals,
    };
    this.store.save(analysis);
    return analysis;
  }

  /** Records how a game's analysis ended and tells whoever is waiting for it. */
  private finish(id: string, outcome: GameAnalysis | Error): void {
    if (outcome instanceof Error) this.failed.set(id, outcome.message);
    if (this.current?.id === id) this.current = null;
    for (const waiter of this.waiters.get(id) ?? []) {
      if (outcome instanceof Error) waiter.reject(outcome);
      else waiter.resolve(outcome);
    }
    this.waiters.delete(id);
    this.emit(id);
  }

  private stopEngine(): void {
    const engine = this.engine;
    this.engine = null;
    engine?.then((e) => e.quit(), () => {});
  }
}

class EngineStartError extends Error {}

function sideToMove(game: GameRecord, ply: number): Color {
  const fen = ply === 0 ? game.startFen : game.moves[ply - 1].fenAfter;
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/** An engine's result from White's side. */
function fromWhite({ score, best }: SearchResult, toMove: Color): PositionEval {
  const sign = toMove === "white" ? 1 : -1;
  const evaluation: PositionEval =
    "cp" in score ? { cp: sign * score.cp } : score.mate === 0 ? { mate: 0, winner: opponent(toMove) } : { mate: sign * score.mate };
  return best ? { ...evaluation, best } : evaluation;
}

/**
 * The final position's evaluation when the game ended on the board: a
 * checkmate is won, and stalemate, too little material, threefold repetition
 * and the fifty-move rule are draws whatever an engine would make of the
 * position. Null when the engine has to judge it (resignation, time...).
 */
function finalEval(game: GameRecord): PositionEval | null {
  const chess = new Chess(game.moves.at(-1)?.fenAfter ?? game.startFen);
  if (chess.isCheckmate()) return { mate: 0, winner: chess.turn() === "w" ? "black" : "white" };
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return { cp: 0 };
  const reason = game.termination?.reason;
  if (reason === "threefold_repetition" || reason === "fifty_moves") return { cp: 0 };
  return null;
}

/** A UCI move in SAN, in the position before half-move `ply`. */
function sanOf(game: GameRecord, ply: number, uci: string): string | undefined {
  try {
    const chess = new Chess(ply === 1 ? game.startFen : game.moves[ply - 2].fenAfter);
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return undefined;
  }
}
