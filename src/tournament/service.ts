import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GameService } from "../game/service.js";
import { summarize, type GameSummary } from "../game/store.js";
import type { PlayerSpec } from "../game/types.js";
import { parseTimeControl, timeCategory, timeControlLabel } from "../timeControl.js";
import { roundRobin } from "./schedule.js";
import { currentRound, isOver, standings, type Standing, type TournamentRecord } from "./tournament.js";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 20;

export interface CreateTournamentRequest {
  /** Defaults to the time category, e.g. "Blitz round robin". */
  name?: string;
  /** "5+3", "10+0"... */
  timeControl: string;
  players: PlayerSpec[];
}

/** A request the admin needs to fix: too few players, the same model twice... */
export class TournamentError extends Error {}

export interface TournamentSummary {
  id: string;
  name: string;
  status: TournamentRecord["status"];
  createdAt: string;
  finishedAt?: string;
  timeControl: string;
  category: TournamentRecord["timeControl"]["category"];
  players: PlayerSpec[];
  rounds: number;
  /** The round being played (1-based); null once the tournament is over. */
  round: number | null;
  gamesPlayed: number;
  gamesTotal: number;
  /** Paused games: out of funds, or cut off by a restart. They wait to be resumed. */
  gamesPaused: number;
  /** The players at the top of the table, once a game has finished. */
  leaders: { model: string; points: number }[];
  /** USD for every game of the tournament; null when a model's price is unknown. */
  costUsd: number | null;
}

export interface TournamentView {
  tournament: TournamentRecord;
  /** The round being played (1-based); null once the tournament is over. */
  round: number | null;
  standings: Standing[];
  /** Every game the tournament started, by ID. */
  games: Record<string, GameSummary>;
}

/** Saves each tournament as <games dir>/tournaments/<id>.json. */
export class TournamentStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(tournament: TournamentRecord): void {
    const file = this.file(tournament.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tournament, null, 2));
    renameSync(tmp, file);
  }

  load(id: string): TournamentRecord | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as TournamentRecord;
  }

  list(): TournamentRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as TournamentRecord];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}

/**
 * Runs round-robin tournaments on top of the game service. All the games of
 * a round are played at the same time, and the next round starts once every
 * one of them is over. The games are ordinary games, so they count for the
 * ratings like any other.
 */
export class TournamentService {
  readonly store: TournamentStore;
  /** Tournaments in play, kept in memory while their games run. */
  private readonly running = new Map<string, TournamentRecord>();
  /** Games this service listens to, so it can move their tournament on when they end. */
  private readonly watched = new Set<string>();
  private readonly waiters = new Map<string, ((t: TournamentRecord) => void)[]>();
  private readonly random: () => number;

  constructor(
    private readonly games: GameService,
    options: { store?: TournamentStore; random?: () => number } = {},
  ) {
    this.store = options.store ?? new TournamentStore(path.join(games.store.dir, "tournaments"));
    this.random = options.random ?? Math.random;
  }

  /**
   * At startup, after GameService.recoverInterrupted: carries on with the
   * tournaments a previous run left running. Games of theirs it cut off count
   * as whatever that recovery made of them; a paused one holds its round until
   * it is resumed. Returns how many tournaments carry on.
   */
  resumeRunning(): number {
    const tournaments = this.store.list().filter((t) => t.status === "running" && !this.running.has(t.id));
    for (const t of tournaments) {
      this.running.set(t.id, t);
      this.advance(t);
    }
    return tournaments.length;
  }

  /** Draws the pairing numbers, saves the schedule and starts the first round. */
  create(request: CreateTournamentRequest): TournamentRecord {
    const tc = parseTimeControl(request.timeControl);
    const { players } = request;
    if (players.length < MIN_PLAYERS) throw new TournamentError(`Add at least ${MIN_PLAYERS} players.`);
    if (players.length > MAX_PLAYERS) throw new TournamentError(`A tournament can have at most ${MAX_PLAYERS} players.`);
    const seen = new Set<string>();
    for (const p of players) {
      const key = `${p.provider}:${p.model.toLowerCase()}`;
      if (seen.has(key)) throw new TournamentError(`${p.model} is listed twice. Each model can play only once.`);
      seen.add(key);
    }
    const category = timeCategory(tc);
    const seeded = shuffle(players, this.random);
    const tournament: TournamentRecord = {
      version: 1,
      id: this.games.store.newId(),
      name: request.name?.trim() || `${category[0].toUpperCase()}${category.slice(1)} round robin`,
      status: "running",
      createdAt: new Date().toISOString(),
      timeControl: { baseMs: tc.baseMs, incrementMs: tc.incrementMs, label: timeControlLabel(tc), category },
      players: seeded.map((p) => ({ provider: p.provider, model: p.model })),
      rounds: roundRobin(seeded.length).map(({ pairs, bye }) => ({
        games: pairs.map(([white, black]) => ({ white, black })),
        bye,
      })),
    };
    this.store.save(tournament);
    this.running.set(tournament.id, tournament);
    this.advance(tournament);
    return tournament;
  }

  get(id: string): TournamentRecord | undefined {
    return this.running.get(id) ?? this.store.load(id);
  }

  list(): TournamentSummary[] {
    const games = new Map(this.games.list().map((g) => [g.id, g]));
    return this.store.list().map((stored) => {
      const t = this.running.get(stored.id) ?? stored;
      const table = standings(t, (id) => games.get(id));
      const round = currentRound(t, (id) => games.get(id));
      const pairings = t.rounds.flatMap((r) => r.games);
      const top = table.filter((s) => s.rank === 1 && s.played > 0);
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        createdAt: t.createdAt,
        ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
        timeControl: t.timeControl.label,
        category: t.timeControl.category,
        players: t.players,
        rounds: t.rounds.length,
        round: t.status === "running" && round >= 0 ? round + 1 : null,
        gamesPlayed: pairings.filter((p) => p.gameId && games.get(p.gameId)?.status === "finished").length,
        gamesTotal: pairings.length,
        gamesPaused: pairings.filter((p) => p.gameId && games.get(p.gameId)?.status === "paused").length,
        leaders: top.map((s) => ({ model: s.model, points: s.points })),
        costUsd: totalCost(gameIds(t).map((id) => games.get(id))),
      };
    });
  }

  /** A tournament with its table and the summaries of its games. */
  view(id: string): TournamentView | undefined {
    const tournament = this.get(id);
    if (!tournament) return undefined;
    const records = new Map(gameIds(tournament).flatMap((g) => {
      const game = this.games.get(g);
      return game ? [[g, game] as const] : [];
    }));
    const ratings = this.games.ratings();
    const { category } = tournament.timeControl;
    const table = standings(tournament, (g) => records.get(g), {
      now: (player) => ratings.rating(player, category),
      forGame: (g) => {
        const game = records.get(g);
        return game ? ratings.forGame(game) : null;
      },
    });
    const round = currentRound(tournament, (g) => records.get(g));
    return {
      tournament,
      round: tournament.status === "running" && round >= 0 ? round + 1 : null,
      standings: table,
      games: Object.fromEntries([...records].map(([g, game]) => [g, summarize(game)])),
    };
  }

  /** Stops a running tournament: aborts its games in progress and plays no more rounds. */
  abort(id: string, message = "Aborted by the admin."): boolean {
    const tournament = this.get(id);
    if (tournament?.status !== "running") return false;
    this.end(tournament, "aborted", message);
    for (const pairing of tournament.rounds.flatMap((r) => r.games)) {
      if (pairing.gameId) this.games.abort(pairing.gameId);
    }
    return true;
  }

  /** Resolves when the tournament is over (immediately for one that is). */
  wait(id: string): Promise<TournamentRecord | undefined> {
    const tournament = this.get(id);
    if (tournament?.status !== "running") return Promise.resolve(tournament);
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  /**
   * Starts the games of the round being played that haven't started, and
   * listens for the end of the ones in progress. Once a round is over it
   * moves on to the next, and after the last it ends the tournament.
   */
  private advance(tournament: TournamentRecord): void {
    if (tournament.status !== "running") return;
    const game = (id: string) => this.games.get(id);
    let started = false;
    for (;;) {
      const index = currentRound(tournament, game);
      if (index < 0) {
        this.end(tournament, "finished");
        return;
      }
      for (const pairing of tournament.rounds[index].games) {
        if (pairing.gameId) continue;
        const [white, black] = [tournament.players[pairing.white], tournament.players[pairing.black]];
        try {
          pairing.gameId = this.games.start({
            timeControl: tournament.timeControl.label,
            players: [white, black],
            firstPlayerColor: "white",
            tournament: { id: tournament.id, name: tournament.name, round: index + 1 },
          }).id;
        } catch (err) {
          // Say, config.ini lost a provider's key since the tournament started.
          const reason = err instanceof Error ? err.message : String(err);
          this.abort(tournament.id, `Stopped: ${white.model} vs ${black.model} couldn't start. ${reason}`);
          return;
        }
        started = true;
      }
      if (started) this.store.save(tournament);
      const playing = tournament.rounds[index].games.filter((p) => !isOver(game(p.gameId!)));
      if (playing.length === 0) continue; // every game of the round ended right away
      for (const pairing of playing) this.watch(tournament.id, pairing.gameId!);
      return;
    }
  }

  private watch(tournamentId: string, gameId: string): void {
    if (this.watched.has(gameId)) return;
    this.watched.add(gameId);
    const unsubscribe = this.games.subscribe(gameId, (game) => {
      if (!isOver(game)) return;
      unsubscribe();
      this.watched.delete(gameId);
      // Not from inside the game's own update.
      setImmediate(() => {
        const tournament = this.running.get(tournamentId);
        try {
          if (tournament) this.advance(tournament);
        } catch (err) {
          console.error(`Could not move tournament ${tournamentId} on:`, err);
        }
      });
    });
  }

  private end(tournament: TournamentRecord, status: "finished" | "aborted", message?: string): void {
    tournament.status = status;
    tournament.finishedAt = new Date().toISOString();
    if (message) tournament.message = message;
    this.store.save(tournament);
    this.running.delete(tournament.id);
    for (const resolve of this.waiters.get(tournament.id) ?? []) resolve(tournament);
    this.waiters.delete(tournament.id);
  }
}

/** Every game a tournament started, in schedule order. */
function gameIds(tournament: TournamentRecord): string[] {
  return tournament.rounds.flatMap((r) => r.games.flatMap((p) => (p.gameId ? [p.gameId] : [])));
}

function totalCost(games: (GameSummary | undefined)[]): number | null {
  let total = 0;
  for (const game of games) {
    if (!game) continue;
    if (game.costUsd === null) return null;
    total += game.costUsd;
  }
  return total;
}

/** A copy in random order (Fisher-Yates). */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
