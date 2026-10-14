import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE, GPT } from "../testing.js";
import { expectedScore, K_FACTOR, rateGames, ratingDelta, START_RATING, type RatedGame } from "./ratings.js";
import type { PlayerSpec } from "./types.js";

const OTHER: PlayerSpec = { provider: "openai", model: "gpt-other" };

let minute = 0;
/** A game that ended `minute` minutes after the first one. */
function game(white: PlayerSpec, black: PlayerSpec, result: RatedGame["result"], extra: Partial<RatedGame> = {}): RatedGame {
  const at = new Date(Date.UTC(2026, 9, 14, 12, minute++)).toISOString();
  return { id: `g${minute}`, status: result === "*" ? "running" : "finished", createdAt: at, finishedAt: at, white, black, result, ...extra };
}

describe("Elo ratings", () => {
  it("expects equal players to split the points and a 400-point favorite to score about 91%", () => {
    assert.equal(expectedScore(1500, 1500), 0.5);
    assert.ok(Math.abs(expectedScore(1900, 1500) - 0.909) < 0.001);
    assert.ok(Math.abs(expectedScore(1500, 1900) + expectedScore(1900, 1500) - 1) < 1e-12);
    assert.equal(ratingDelta(1500, 1500, 1), K_FACTOR / 2);
    assert.equal(ratingDelta(1500, 1500, 0.5), 0);
    assert.equal(ratingDelta(1600, 1400, 0.5), -8);
    assert.equal(ratingDelta(1400, 1600, 1), 24);
  });

  it("starts every model at the default and moves both ratings by the same amount after each game", () => {
    const games = [game(CLAUDE, GPT, "1-0"), game(GPT, CLAUDE, "1/2-1/2"), game(GPT, OTHER, "0-1")];
    const ratings = rateGames(games);
    assert.deepEqual(ratings.forGame(games[0]), { white: { before: 1500, after: 1516 }, black: { before: 1500, after: 1484 } });
    // The lower-rated side gains from a draw.
    assert.deepEqual(ratings.forGame(games[1]), { white: { before: 1484, after: 1485 }, black: { before: 1516, after: 1515 } });
    assert.deepEqual(ratings.forGame(games[2]), { white: { before: 1485, after: 1470 }, black: { before: 1500, after: 1515 } });
    assert.deepEqual(
      ratings.table().map(({ model, rating, games, wins, draws, losses }) => [model, rating, games, wins, draws, losses]),
      [
        // Tied on rating: more games first.
        ["claude-test", 1515, 2, 1, 1, 0],
        ["gpt-other", 1515, 1, 1, 0, 0],
        ["gpt-test", 1470, 3, 0, 1, 2],
      ],
    );
    assert.equal(ratings.rating({ provider: "anthropic", model: "claude-new" }), START_RATING);
  });

  it("rates games in the order they ended", () => {
    const early = game(CLAUDE, GPT, "1-0");
    const late = game(GPT, CLAUDE, "1-0");
    // Started first, ended last.
    late.createdAt = new Date(Date.parse(early.createdAt) - 60_000).toISOString();
    const ratings = rateGames([late, early]);
    assert.equal(ratings.forGame(early)?.white.before, 1500);
    assert.equal(ratings.forGame(late)?.white.before, 1484);
  });

  it("leaves out aborted games, games in play and a model playing itself", () => {
    const aborted = game(CLAUDE, GPT, "*", { status: "aborted" });
    const running = game(CLAUDE, GPT, "*");
    const paused = game(GPT, CLAUDE, "*", { status: "paused" });
    const self = game(CLAUDE, CLAUDE, "1-0");
    const win = game(CLAUDE, GPT, "1-0");
    const ratings = rateGames([aborted, running, paused, self, win]);
    assert.equal(ratings.forGame(aborted), null);
    assert.equal(ratings.forGame(self), null);
    // Games in play show the current ratings, with no change yet.
    assert.deepEqual(ratings.forGame(running), { white: { before: 1516 }, black: { before: 1484 } });
    assert.deepEqual(ratings.forGame(paused), { white: { before: 1484 }, black: { before: 1516 } });
    assert.deepEqual(
      ratings.table().map((m) => [m.model, m.games]),
      [
        ["claude-test", 1],
        ["gpt-test", 1],
      ],
    );
  });
});
