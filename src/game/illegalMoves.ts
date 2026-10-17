import type { AccuracyAverage } from "../analysis/accuracy.js";
import { TIME_CATEGORIES, type TimeCategory } from "../timeControl.js";
import { COLORS, playerKey, type Color, type GameRecord, type PlayerSpec } from "./types.js";

/** How many of the moves a player tried were illegal. */
export interface IllegalMoves {
  /**
   * Illegal moves, each taken back. Three unusable replies in a row count as
   * one, as the rules say.
   */
  illegal: number;
  /** Moves tried: the legal moves played plus the illegal ones. */
  tried: number;
  /** The illegal moves as a percentage of the moves tried; null when it tried none. */
  percent: number | null;
}

/** A player's illegal moves over several games. */
export interface IllegalMoveRate extends IllegalMoves {
  /** Finished games counted; a model playing itself counts twice. */
  games: number;
}

/** A model's figures over all its finished games, whatever the time control. */
export interface ModelTotals extends PlayerSpec {
  /** Finished games played; a model playing itself counts twice. */
  games: number;
  illegalMoves: IllegalMoveRate;
  /** Its average accuracy over those Stockfish has analyzed, when any. */
  accuracy?: AccuracyAverage;
}

/** The parts of a game that counting illegal moves needs. */
export type CountedGame = Pick<GameRecord, "status" | "white" | "black" | "moves" | "illegalMoves"> & {
  timeControl: Pick<GameRecord["timeControl"], "category">;
};

/** Each side's illegal moves in a game, so far for a game still in play. */
export function illegalMovesOf(game: Pick<GameRecord, "moves" | "illegalMoves">): Record<Color, IllegalMoves> {
  const side = (color: Color) => {
    const illegal = game.illegalMoves[color];
    return counted(illegal, game.moves.filter((m) => m.color === color).length + illegal);
  };
  return { white: side("white"), black: side("black") };
}

/**
 * Each player's illegal moves over the finished games among `games`, by
 * playerKey: all its illegal moves as a percentage of all the moves it tried,
 * so a long game weighs more than a short one. A model playing itself counts
 * for both sides.
 */
export function illegalMoveRates(games: readonly CountedGame[]): Map<string, IllegalMoveRate> {
  const rates = new Map<string, IllegalMoveRate>();
  for (const game of games) {
    if (game.status !== "finished") continue;
    const sides = illegalMovesOf(game);
    for (const color of COLORS) {
      const key = playerKey(game[color]);
      const sum = rates.get(key) ?? { games: 0, illegal: 0, tried: 0, percent: null };
      rates.set(key, { games: sum.games + 1, ...counted(sum.illegal + sides[color].illegal, sum.tried + sides[color].tried) });
    }
  }
  return rates;
}

/** Each player's illegal moves in each time category. */
export function illegalMoveRatesByCategory(games: readonly CountedGame[]): Record<TimeCategory, Map<string, IllegalMoveRate>> {
  return Object.fromEntries(
    TIME_CATEGORIES.map((c) => [c, illegalMoveRates(games.filter((g) => g.timeControl.category === c))]),
  ) as Record<TimeCategory, Map<string, IllegalMoveRate>>;
}

/**
 * Every model that has finished a game, with its illegal moves and, from
 * `accuracy`, its average accuracy over all of them: most games first.
 */
export function modelTotals(games: readonly CountedGame[], accuracy?: ReadonlyMap<string, AccuracyAverage>): ModelTotals[] {
  const players = new Map<string, PlayerSpec>();
  for (const game of games) {
    if (game.status === "finished") for (const color of COLORS) players.set(playerKey(game[color]), game[color]);
  }
  const rates = illegalMoveRates(games);
  return [...players]
    .map(([key, player]) => {
      const illegalMoves = rates.get(key)!;
      const average = accuracy?.get(key);
      return { provider: player.provider, model: player.model, games: illegalMoves.games, illegalMoves, ...(average && { accuracy: average }) };
    })
    .sort((a, b) => b.games - a.games || a.model.localeCompare(b.model));
}

function counted(illegal: number, tried: number): IllegalMoves {
  return { illegal, tried, percent: tried ? (100 * illegal) / tried : null };
}
