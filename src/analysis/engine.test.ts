import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_POSITION } from "chess.js";
import { parseInfo, UciEngine } from "./engine.js";

describe("UCI engine", () => {
  it("reads scores from info lines, skipping bounds and secondary lines", () => {
    assert.deepEqual(parseInfo("info depth 18 seldepth 27 multipv 1 score cp -35 nodes 655665 pv e2e4"), { depth: 18, score: { cp: -35 } });
    assert.deepEqual(parseInfo("info depth 9 score mate -3 pv h7h6"), { depth: 9, score: { mate: -3 } });
    assert.equal(parseInfo("info depth 12 score cp 40 lowerbound nodes 1000"), null);
    assert.equal(parseInfo("info depth 12 multipv 2 score cp 10"), null);
    assert.equal(parseInfo("info string NNUE evaluation using nn-big.nnue"), null);
    assert.equal(parseInfo("bestmove e2e4 ponder e7e5"), null);
  });

  it("says when the engine can't be started", async () => {
    await assert.rejects(UciEngine.start("/nonexistent/stockfish"), /Couldn't start the engine at \/nonexistent\/stockfish/);
  });

  describe("the bundled Stockfish", () => {
    let engine: UciEngine;
    before(async () => {
      engine = await UciEngine.start();
      await engine.newGame();
    });
    after(() => engine.quit());

    it("evaluates positions from the side to move's point of view", async () => {
      assert.match(engine.name, /^Stockfish/);
      const start = await engine.search(DEFAULT_POSITION, [], 8);
      assert.equal(start.depth, 8);
      assert.ok("cp" in start.score && Math.abs(start.score.cp) < 100, `the start position is about level: ${JSON.stringify(start.score)}`);
      assert.match(start.best ?? "", /^[a-h][1-8][a-h][1-8]$/);
    });

    it("finds mates, and knows a mated or stalemated side has no move", async () => {
      const foolsMate = ["f2f3", "e7e5", "g2g4"];
      assert.deepEqual(await engine.search(DEFAULT_POSITION, foolsMate, 8), { depth: 8, score: { mate: 1 }, best: "d8h4" });
      const mated = await engine.search(DEFAULT_POSITION, [...foolsMate, "d8h4"], 8);
      assert.deepEqual([mated.score, mated.best], [{ mate: 0 }, null]);
      const stalemate = await engine.search("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", [], 8);
      assert.deepEqual([stalemate.score, stalemate.best], [{ cp: 0 }, null]);
    });
  });
});
