import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Color } from "../game/types.js";
import { accuracyReport, averageAccuracy, judge, moveAccuracy, winPercent, type PositionEval } from "./accuracy.js";

/** Moves alternating from White, as many as there are evaluations after the start. */
function alternating(evals: readonly unknown[]): { color: Color; uci: string }[] {
  return evals.slice(1).map((_, i) => ({ color: i % 2 === 0 ? "white" : "black", uci: `m${i}` }));
}

const near = (actual: number | null, expected: number, digits = 6) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 10 ** -digits, `expected ${expected}, got ${actual}`);

describe("accuracy", () => {
  it("turns evaluations into White's winning chances", () => {
    assert.equal(winPercent({ cp: 0 }), 50);
    near(winPercent({ cp: -250 }), 28.485195256375974);
    near(winPercent({ cp: 1000 }), 97.54474363414323);
    assert.equal(winPercent({ cp: 5000 }), winPercent({ cp: 1000 }), "evaluations past 10 pawns count as 10");
    assert.equal(winPercent({ mate: 3 }), winPercent({ cp: 1000 }));
    assert.equal(winPercent({ mate: -1 }), winPercent({ cp: -1000 }));
    assert.equal(winPercent({ mate: 0, winner: "black" }), winPercent({ cp: -1000 }));
    assert.equal(winPercent({ mate: 0, winner: "white" }), winPercent({ cp: 1000 }));
  });

  it("scores a move by the winning chance it gave away", () => {
    assert.equal(moveAccuracy(50, 50), 100);
    assert.equal(moveAccuracy(40, 70), 100, "gaining is as good as it gets");
    near(moveAccuracy(60, 50), 64.57982845372067);
    assert.equal(moveAccuracy(100, 0), 0);
    assert.equal(judge(4.9), null);
    assert.equal(judge(5), "inaccuracy");
    assert.equal(judge(10), "mistake");
    assert.equal(judge(15), "blunder");
  });

  // Expected values from a line-by-line Python port of Lichess's AccuracyPercent.gameAccuracy.
  it("works out a game's accuracy as Lichess does", () => {
    const blunder = [20, 30, 25, 40, -150, -140, -130, 300, 280, 290, 1000, 1000, 1000].map((cp) => ({ cp }));
    const short = accuracyReport(blunder, alternating(blunder));
    near(short.white.accuracy, 100);
    near(short.black.accuracy, 71.5216390417537);

    const swings = [
      20, 80, 70, -230, -225, -225, -225, -165, -160, -200, -195, -195, 105, -195, -195, -235, -235, -535, -530, -530, -490, -495, -195, -200,
      -160, -165, -175, -295, 5, 15, 15,
    ].map((cp) => ({ cp }));
    const long = accuracyReport(swings, alternating(swings));
    near(long.white.accuracy, 68.00785223784558);
    near(long.black.accuracy, 71.8244127183568);
  });

  it("judges each move and remembers what the engine preferred", () => {
    const evals: PositionEval[] = [
      { cp: 30, best: "e2e4" },
      { cp: 25, best: "e7e5" },
      { cp: 20, best: "g1f3" },
      // White hangs its queen.
      { cp: -900, best: "d8h4" },
      { mate: 1, best: "h5f7" },
      { mate: 0, winner: "white" },
    ];
    const moves = [
      { color: "white" as const, uci: "e2e4" },
      { color: "black" as const, uci: "a7a6" },
      { color: "white" as const, uci: "d1h5" },
      // Black misses the queen and walks into mate.
      { color: "black" as const, uci: "g7g6" },
      { color: "white" as const, uci: "h5f7" },
    ];
    const report = accuracyReport(evals, moves);
    assert.deepEqual(
      report.moves.map((m) => [m.ply, m.color, m.judgement, m.best ?? null, m.cpLoss]),
      [
        [1, "white", null, null, 5],
        [2, "black", null, "e7e5", 0],
        [3, "white", "blunder", "g1f3", 920],
        [4, "black", "blunder", "d8h4", 1900],
        [5, "white", null, null, 0],
      ],
    );
    assert.deepEqual(report.moves[2].eval, { cp: -900 }, "the evaluation after the move, without the next best move");
    assert.equal(report.moves[4].accuracy, 100);
    assert.equal(report.white.blunders, 1);
    assert.equal(report.black.blunders, 1);
    assert.equal(report.white.moves, 3);
    assert.equal(report.black.moves, 2);
    near(report.white.acpl, (5 + 920 + 0) / 3);
    assert.ok(report.white.accuracy! < 100 && report.black.accuracy! < report.white.accuracy!);
  });

  it("has no accuracy for a side that didn't move, and starts with Black when Black moves first", () => {
    const evals: PositionEval[] = [{ cp: -40 }, { cp: -40 }];
    const report = accuracyReport(evals, [{ color: "black", uci: "e7e5" }]);
    assert.equal(report.white.accuracy, null);
    assert.equal(report.white.acpl, null);
    near(report.black.accuracy, 100);
    assert.throws(() => accuracyReport(evals, []), /Expected 1 evaluations/);
    assert.equal(accuracyReport([{ cp: 0 }], []).white.moves, 0);
  });

  it("averages game accuracies", () => {
    assert.equal(averageAccuracy([]), undefined);
    assert.deepEqual(averageAccuracy([80, 90, 70]), { accuracy: 80, games: 3 });
  });
});
