import type { AccuracyAverage } from "../analysis/accuracy.js";
import type { GameRatings } from "../game/ratings.js";
import type { GameRecord, PlayerSpec } from "../game/types.js";
import type { TimeCategory } from "../timeControl.js";

/** "running" until every round has been played, or the admin aborts it. */
export type TournamentStatus = "running" | "finished" | "aborted";

/** A game of the schedule; players are numbers into the tournament's player list. */
export interface Pairing {
  white: number;
  black: number;
  /** The game played for this pairing, once its round has started. */
  gameId?: string;
}

export interface TournamentRound {
  games: Pairing[];
  /** The player sitting this round out, with an odd number of players. */
  bye: number | null;
}

export interface TournamentRecord {
  version: 1;
  id: string;
  name: string;
  status: TournamentStatus;
  createdAt: string;
  finishedAt?: string;
  timeControl: { baseMs: number; incrementMs: number; label: string; category: TimeCategory };
  /** In the order of their pairing numbers, which are drawn at random. */
  players: PlayerSpec[];
  rounds: TournamentRound[];
  /** Why an aborted tournament stopped. */
  message?: string;
}

/** The parts of a game the standings need. */
export type GameOutcome = Pick<GameRecord, "status" | "result">;

export interface Standing extends PlayerSpec {
  /** Shared by players level on points, tiebreak and wins. */
  rank: number;
  /** 1 for a win, ½ for a draw. */
  points: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  /** Sonneborn-Berger: the points of the players it beat, plus half the points of those it drew with. */
  tiebreak: number;
  /** Its rating in the tournament's time category now, and how much the tournament's games moved it. */
  rating?: { now: number; change: number };
  /** Its average accuracy over the tournament's games that Stockfish has analyzed. */
  accuracy?: AccuracyAverage;
}

/** Whether a pairing's game is over (or gone), so the round can move on. */
export function isOver(game: GameOutcome | undefined): boolean {
  return !game || game.status === "finished" || game.status === "aborted";
}

/** The round being played (0-based): the first with a game not over yet, or -1 once all are. */
export function currentRound(tournament: TournamentRecord, game: (id: string) => GameOutcome | undefined): number {
  return tournament.rounds.findIndex((round) => round.games.some((p) => !p.gameId || !isOver(game(p.gameId))));
}

const SCORES: Partial<Record<GameRecord["result"], [number, number]>> = { "1-0": [1, 0], "0-1": [0, 1], "1/2-1/2": [0.5, 0.5] };

/**
 * The tournament table: points from finished games (aborted ones count for
 * nobody), ranked by points, then Sonneborn-Berger, then wins. With
 * `ratings`, each player's current rating and what the tournament's games
 * did to it.
 */
export function standings(
  tournament: TournamentRecord,
  game: (id: string) => GameOutcome | undefined,
  ratings?: { now: (player: PlayerSpec) => number; forGame: (id: string) => GameRatings | null },
): Standing[] {
  const rows: Standing[] = tournament.players.map((p) => ({
    provider: p.provider,
    model: p.model,
    rank: 0,
    points: 0,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    tiebreak: 0,
    ...(ratings ? { rating: { now: ratings.now(p), change: 0 } } : {}),
  }));
  const results: { white: number; black: number; scores: [number, number] }[] = [];
  for (const round of tournament.rounds) {
    for (const pairing of round.games) {
      const outcome = pairing.gameId ? game(pairing.gameId) : undefined;
      const scores = outcome?.status === "finished" ? SCORES[outcome.result] : undefined;
      if (!scores) continue;
      results.push({ white: pairing.white, black: pairing.black, scores });
      [pairing.white, pairing.black].forEach((player, side) => {
        const row = rows[player];
        row.points += scores[side];
        row.played++;
        if (scores[side] === 1) row.wins++;
        else if (scores[side] === 0) row.losses++;
        else row.draws++;
        const change = ratings?.forGame(pairing.gameId!);
        if (change && row.rating) {
          const { before, after = before } = change[side === 0 ? "white" : "black"];
          row.rating.change += after - before;
        }
      });
    }
  }
  for (const { white, black, scores } of results) {
    rows[white].tiebreak += scores[0] * rows[black].points;
    rows[black].tiebreak += scores[1] * rows[white].points;
  }
  const order = (a: Standing, b: Standing) => b.points - a.points || b.tiebreak - a.tiebreak || b.wins - a.wins;
  const sorted = [...rows].sort((a, b) => order(a, b) || a.model.localeCompare(b.model));
  for (const row of sorted) row.rank = 1 + sorted.filter((other) => order(other, row) < 0).length;
  return sorted;
}
