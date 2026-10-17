import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE, GPT } from "../testing.js";
import type { TimeCategory } from "../timeControl.js";
import { illegalMoveRates, illegalMoveRatesByCategory, illegalMovesOf, modelTotals, type CountedGame } from "./illegalMoves.js";
import { playerKey, type Color, type GameStatus, type MoveRecord, type PlayerSpec } from "./types.js";

const GEMINI: PlayerSpec = { provider: "google", model: "gemini-test" };

/** A game in which White played `whiteMoves` legal moves and Black `blackMoves`. */
function game(
  white: PlayerSpec,
  black: PlayerSpec,
  { whiteMoves = 10, blackMoves = 10, illegal = { white: 0, black: 0 }, status = "finished" as GameStatus, category = "blitz" as TimeCategory } = {},
): CountedGame {
  const moves = (color: Color, n: number) => Array.from({ length: n }, () => ({ color }) as MoveRecord);
  return { status, white, black, moves: [...moves("white", whiteMoves), ...moves("black", blackMoves)], illegalMoves: illegal, timeControl: { category } };
}

describe("illegal moves", () => {
  it("counts each side's illegal moves among the moves it tried", () => {
    assert.deepEqual(illegalMovesOf(game(CLAUDE, GPT, { whiteMoves: 19, blackMoves: 18, illegal: { white: 1, black: 2 } })), {
      white: { illegal: 1, tried: 20, percent: 5 },
      black: { illegal: 2, tried: 20, percent: 10 },
    });
    assert.deepEqual(illegalMovesOf(game(CLAUDE, GPT, { whiteMoves: 0, blackMoves: 0 })).black, { illegal: 0, tried: 0, percent: null });
  });

  it("adds up a model's moves over its finished games, a model playing itself counting twice", () => {
    const games = [
      game(CLAUDE, GPT, { whiteMoves: 9, illegal: { white: 1, black: 0 } }),
      game(GPT, CLAUDE, { whiteMoves: 30, blackMoves: 29, illegal: { white: 0, black: 1 } }),
      game(CLAUDE, CLAUDE, { illegal: { white: 0, black: 1 }, category: "bullet" }),
      // Not over, or never finished: these don't count.
      game(CLAUDE, GPT, { illegal: { white: 1, black: 1 }, status: "running" }),
      game(CLAUDE, GPT, { illegal: { white: 1, black: 1 }, status: "aborted" }),
    ];
    const rates = illegalMoveRates(games);
    // 1 of 10, 1 of 30, 0 of 10 and 1 of 11: 3 of 61, not the average of the games' percentages.
    assert.deepEqual(rates.get(playerKey(CLAUDE)), { games: 4, illegal: 3, tried: 61, percent: 300 / 61 });
    assert.deepEqual(rates.get(playerKey(GPT)), { games: 2, illegal: 0, tried: 40, percent: 0 });

    const byCategory = illegalMoveRatesByCategory(games);
    assert.deepEqual(byCategory.bullet.get(playerKey(CLAUDE)), { games: 2, illegal: 1, tried: 21, percent: 100 / 21 });
    assert.equal(byCategory.bullet.get(playerKey(GPT)), undefined);
    assert.equal(byCategory.blitz.get(playerKey(CLAUDE))?.games, 2);
    assert.equal(byCategory.rapid.size, 0);
  });

  it("lists every model's totals over every time control, most games first", () => {
    const games = [
      game(CLAUDE, GPT, { category: "bullet" }),
      game(GEMINI, CLAUDE, { illegal: { white: 2, black: 0 }, whiteMoves: 8, category: "classical" }),
      game(GEMINI, GPT, { status: "aborted" }),
    ];
    const accuracy = new Map([[playerKey(CLAUDE), { accuracy: 81.5, games: 2 }]]);
    assert.deepEqual(modelTotals(games, accuracy), [
      { ...CLAUDE, games: 2, illegalMoves: { games: 2, illegal: 0, tried: 20, percent: 0 }, accuracy: { accuracy: 81.5, games: 2 } },
      { ...GEMINI, games: 1, illegalMoves: { games: 1, illegal: 2, tried: 10, percent: 20 } },
      { ...GPT, games: 1, illegalMoves: { games: 1, illegal: 0, tried: 10, percent: 0 } },
    ]);
    assert.deepEqual(modelTotals([]), []);
  });
});
