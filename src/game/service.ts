import { parseTimeControl } from "../timeControl.js";
import type { PlayerFactory } from "../players/llmPlayer.js";
import { createGameRecord, GameRunner, type GameOptions } from "./game.js";
import { importPgn } from "./pgnImport.js";
import { rateGames, type Ratings } from "./ratings.js";
import { GameStore, summarize, type GameSummary } from "./store.js";
import { colorName, type Color, type GameRecord, type PlayerSpec } from "./types.js";

export interface StartGameRequest {
  /** "5+3", "10+0"... */
  timeControl: string;
  /** The two players, in the order the admin listed them. */
  players: [PlayerSpec, PlayerSpec];
  /** The first player's color; "random" draws it. */
  firstPlayerColor: Color | "random";
  /** Optional starting position. */
  startFen?: string;
  /** Set when a tournament starts the game. */
  tournament?: GameRecord["tournament"];
}

export function assignColors(
  players: [PlayerSpec, PlayerSpec],
  firstPlayerColor: Color | "random",
  random: () => number = Math.random,
): { white: PlayerSpec; black: PlayerSpec; colorsAssigned: "manual" | "random" } {
  const color = firstPlayerColor === "random" ? (random() < 0.5 ? "white" : "black") : firstPlayerColor;
  const [first, second] = players;
  return {
    white: color === "white" ? first : second,
    black: color === "white" ? second : first,
    colorsAssigned: firstPlayerColor === "random" ? "random" : "manual",
  };
}

type Listener = (game: GameRecord) => void;

/** Starts games, keeps track of the running ones, saves every change, and notifies watchers. */
export class GameService {
  private readonly running = new Map<string, { runner: GameRunner; done: Promise<GameRecord> }>();
  /** Games that are over but whose last call is still running in the background. */
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly store: GameStore,
    private readonly makePlayer: PlayerFactory,
    private readonly options: { random?: () => number; game?: Omit<GameOptions, "onUpdate"> } = {},
  ) {}

  /**
   * Games left "running" on disk by a previous process (stopped, crashed or
   * restarted by `npm run dev`) are paused, so they can be resumed. Calls that
   * process was still waiting for are lost, and the turn it stopped in starts
   * over with the time the player had at its start.
   */
  recoverInterrupted(): number {
    let count = 0;
    for (const game of this.store.list()) {
      if (this.running.has(game.id) || this.finishing.has(game.id)) continue;
      if (game.unfinishedCall) {
        delete game.unfinishedCall;
        this.store.save(game);
      }
      if (game.status !== "running") continue;
      markInterrupted(game);
      this.store.save(game);
      count++;
    }
    return count;
  }

  start(request: StartGameRequest): GameRecord {
    const timeControl = parseTimeControl(request.timeControl);
    const { white, black, colorsAssigned } = assignColors(request.players, request.firstPlayerColor, this.options.random);
    const players = { white: this.makePlayer(white), black: this.makePlayer(black) };
    const record = createGameRecord({
      id: this.store.newId(),
      timeControl,
      white,
      black,
      colorsAssigned,
      startFen: request.startFen,
      tournament: request.tournament,
    });
    this.store.save(record);
    this.launch(new GameRunner(record, players, this.runnerOptions()));
    return record;
  }

  /** Continues a paused game where it stopped. */
  resume(id: string): GameRecord {
    const record = this.running.get(id)?.runner.record ?? this.store.load(id);
    if (!record) throw new Error(`No game ${id}`);
    if (record.status !== "paused") throw new Error("The game is not paused.");
    const players = { white: this.makePlayer(record.white), black: this.makePlayer(record.black) };
    const runner = new GameRunner(record, players, this.runnerOptions());
    runner.resume();
    this.launch(runner);
    return record;
  }

  /**
   * Saves a game read from a PGN. It keeps the PGN's GameId unless a saved
   * game already has it. A game without a result comes back paused.
   */
  importPgn(pgn: string): GameRecord {
    const record = importPgn(pgn, (gameId) =>
      gameId && /^[\w-]+$/.test(gameId) && !this.running.has(gameId) && !this.store.load(gameId) ? gameId : this.store.newId(),
    );
    this.store.save(record);
    return record;
  }

  private runnerOptions(): GameOptions {
    return { ...this.options.game, onUpdate: (game) => this.changed(game) };
  }

  private launch(runner: GameRunner): void {
    const { id } = runner.record;
    // A resumed game gets a new runner under the same id; only clear our own entries.
    const done = runner.run().finally(() => {
      if (this.running.get(id)?.runner === runner) this.running.delete(id);
      this.changed(runner.record);
    });
    this.running.set(id, { runner, done });
    const finished = done.then(() => runner.callsFinished());
    this.finishing.set(id, finished);
    void finished.finally(() => {
      if (this.finishing.get(id) === finished) this.finishing.delete(id);
    });
  }

  get(id: string): GameRecord | undefined {
    return this.running.get(id)?.runner.record ?? this.store.load(id);
  }

  list(): GameSummary[] {
    return this.games().map(summarize);
  }

  /** Every model's Elo rating, worked out from the saved games (including ones other processes saved). */
  ratings(): Ratings {
    return rateGames(this.games());
  }

  private games(): GameRecord[] {
    return this.store.list().map((g) => this.running.get(g.id)?.runner.record ?? g);
  }

  /** Stops a running or paused game without a result. */
  abort(id: string): boolean {
    const entry = this.running.get(id);
    if (entry) {
      entry.runner.abort();
      return true;
    }
    const game = this.store.load(id);
    if (game?.status !== "paused") return false;
    markAborted(game, "Aborted by the admin.");
    this.changed(game);
    return true;
  }

  /** Resolves when the game ends (immediately for finished games). */
  async wait(id: string): Promise<GameRecord | undefined> {
    const entry = this.running.get(id);
    return entry ? entry.done : this.store.load(id);
  }

  /** Resolves when the game has ended and the call it stopped waiting for, if any, has finished. */
  async callsFinished(id: string): Promise<void> {
    await this.finishing.get(id);
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private changed(game: GameRecord): void {
    try {
      this.store.save(game);
    } catch (err) {
      console.error(`Could not save game ${game.id}:`, err);
    }
    for (const listener of this.listeners.get(game.id) ?? []) listener(game);
  }
}

function markAborted(game: GameRecord, message: string): void {
  game.status = "aborted";
  game.result = "*";
  game.termination = { reason: "aborted", winner: null, message };
  game.finishedAt = new Date().toISOString();
  delete game.turnStartedAt;
}

function markInterrupted(game: GameRecord): void {
  const fen = game.moves.at(-1)?.fenAfter ?? game.startFen;
  const color: Color = fen.split(" ")[1] === "b" ? "black" : "white";
  game.status = "paused";
  delete game.turnStartedAt;
  game.events.push({
    type: "paused",
    color,
    ply: game.moves.length,
    message: `Paused: the app stopped during ${colorName(color)}'s turn. Resume the game to play on; that turn starts over with the time ${colorName(color)} had at its start.`,
    at: new Date().toISOString(),
  });
}
