import { TIME_CATEGORIES, type TimeCategory } from "../timeControl.js";
import type { Color, GameRecord, GameResult, PlayerSpec } from "./types.js";

/** Every model's rating before its first game. */
export const START_RATING = 1500;
/** The most one game can move a rating by, in points. */
export const K_FACTOR = 32;

/** A model's rating in one time category (bullet, blitz, rapid or classical). */
export interface ModelRating extends PlayerSpec {
  category: TimeCategory;
  rating: number;
  /** Rated games played. */
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/** A player's rating going into a game and, once a rated game is over, coming out of it. */
export interface RatingChange {
  before: number;
  after?: number;
}

export type GameRatings = Record<Color, RatingChange>;

/** The parts of a game that rating needs. */
export type RatedGame = Pick<GameRecord, "id" | "status" | "createdAt" | "finishedAt" | "white" | "black" | "result"> & {
  timeControl: Pick<GameRecord["timeControl"], "category">;
};

/** White's score for each result that counts. */
const WHITE_SCORE: Partial<Record<GameResult, number>> = { "1-0": 1, "1/2-1/2": 0.5, "0-1": 0 };

/** The share of the points a player rated `rating` is expected to score against `opponent`. */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** Points White gains from a game (Black loses the same): K × (score − expected score), rounded. */
export function ratingDelta(white: number, black: number, whiteScore: number): number {
  return Math.round(K_FACTOR * (whiteScore - expectedScore(white, black)));
}

/**
 * Every model's Elo rating in each time category, and what each rated game did
 * to its players' ratings.
 */
export class Ratings {
  constructor(
    private readonly models: ReadonlyMap<string, ModelRating>,
    private readonly games: ReadonlyMap<string, GameRatings>,
  ) {}

  /** The models that have played a rated game in `category`, highest rating first. */
  table(category: TimeCategory): ModelRating[] {
    return [...this.models.values()]
      .filter((m) => m.category === category)
      .sort((a, b) => b.rating - a.rating || b.games - a.games || a.model.localeCompare(b.model));
  }

  /** Each category's table, in order from bullet to classical. */
  tables(): Record<TimeCategory, ModelRating[]> {
    return Object.fromEntries(TIME_CATEGORIES.map((c) => [c, this.table(c)])) as Record<TimeCategory, ModelRating[]>;
  }

  rating(spec: PlayerSpec, category: TimeCategory): number {
    return this.models.get(key(spec, category))?.rating ?? START_RATING;
  }

  /**
   * The players' ratings in the game's time category before and after a
   * rated game, or their current ones for a game still in play. Null for a
   * game that doesn't count: one aborted, or a model playing itself.
   */
  forGame(game: RatedGame): GameRatings | null {
    if (samePlayer(game)) return null;
    if (game.status === "running" || game.status === "paused") {
      const { category } = game.timeControl;
      return { white: { before: this.rating(game.white, category) }, black: { before: this.rating(game.black, category) } };
    }
    return this.games.get(game.id) ?? null;
  }
}

/**
 * Works out the ratings by replaying the finished games in the order they
 * ended. Each time category (bullet, blitz, rapid, classical) has its own
 * ratings, and each model starts at START_RATING in each. Aborted games and
 * games between a model and itself don't count.
 */
export function rateGames(games: readonly RatedGame[]): Ratings {
  const models = new Map<string, ModelRating>();
  const changes = new Map<string, GameRatings>();
  const entry = (spec: PlayerSpec, category: TimeCategory) => {
    let model = models.get(key(spec, category));
    if (!model) {
      model = { provider: spec.provider, model: spec.model, category, rating: START_RATING, games: 0, wins: 0, draws: 0, losses: 0 };
      models.set(key(spec, category), model);
    }
    return model;
  };
  const rated = games
    .filter((g) => g.status === "finished" && WHITE_SCORE[g.result] !== undefined && !samePlayer(g))
    .sort((a, b) => endOf(a).localeCompare(endOf(b)) || a.id.localeCompare(b.id));
  for (const game of rated) {
    const white = entry(game.white, game.timeControl.category);
    const black = entry(game.black, game.timeControl.category);
    const score = WHITE_SCORE[game.result]!;
    const delta = ratingDelta(white.rating, black.rating, score);
    changes.set(game.id, {
      white: { before: white.rating, after: white.rating + delta },
      black: { before: black.rating, after: black.rating - delta },
    });
    white.rating += delta;
    black.rating -= delta;
    tally(white, score);
    tally(black, 1 - score);
  }
  return new Ratings(models, changes);
}

function key(spec: PlayerSpec, category: TimeCategory): string {
  return `${category}:${spec.provider}:${spec.model}`;
}

function samePlayer(game: RatedGame): boolean {
  return game.white.provider === game.black.provider && game.white.model === game.black.model;
}

function endOf(game: RatedGame): string {
  return game.finishedAt ?? game.createdAt;
}

function tally(model: ModelRating, score: number) {
  model.games++;
  if (score === 1) model.wins++;
  else if (score === 0) model.losses++;
  else model.draws++;
}
