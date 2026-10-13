import { parseTimeControl } from "../timeControl.js";
import type { PlayerFactory } from "../players/llmPlayer.js";
import { createGameRecord, GameRunner, type GameOptions } from "./game.js";
import { GameStore, summarize, type GameSummary } from "./store.js";
import type { Color, GameRecord, PlayerSpec } from "./types.js";

export interface StartGameRequest {
  /** "5+3", "10+0"... */
  timeControl: string;
  /** The two players, in the order the admin listed them. */
  players: [PlayerSpec, PlayerSpec];
  /** The first player's color; "random" draws it. */
  firstPlayerColor: Color | "random";
  /** Optional starting position. */
  startFen?: string;
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
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly store: GameStore,
    private readonly makePlayer: PlayerFactory,
    private readonly options: { random?: () => number; game?: Omit<GameOptions, "onUpdate"> } = {},
  ) {}

  /** Games left "running" on disk by a previous process can't continue; mark them aborted. */
  recoverInterrupted(): number {
    let count = 0;
    for (const game of this.store.list()) {
      if (game.status !== "running" || this.running.has(game.id)) continue;
      game.status = "aborted";
      game.result = "*";
      game.termination = { reason: "aborted", winner: null, message: "Interrupted: the app stopped while the game was running." };
      game.finishedAt = new Date().toISOString();
      delete game.turnStartedAt;
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
    });
    const runner = new GameRunner(record, players, {
      ...this.options.game,
      onUpdate: (game) => this.changed(game),
    });
    this.store.save(record);
    const done = runner.run().finally(() => {
      this.running.delete(record.id);
      this.changed(record);
    });
    this.running.set(record.id, { runner, done });
    return record;
  }

  get(id: string): GameRecord | undefined {
    return this.running.get(id)?.runner.record ?? this.store.load(id);
  }

  list(): GameSummary[] {
    return this.store.list().map((g) => summarize(this.running.get(g.id)?.runner.record ?? g));
  }

  abort(id: string): boolean {
    const entry = this.running.get(id);
    if (!entry) return false;
    entry.runner.abort();
    return true;
  }

  /** Resolves when the game ends (immediately for finished games). */
  async wait(id: string): Promise<GameRecord | undefined> {
    const entry = this.running.get(id);
    return entry ? entry.done : this.store.load(id);
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
