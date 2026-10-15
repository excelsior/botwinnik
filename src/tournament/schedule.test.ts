import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roundRobin } from "./schedule.js";

describe("round-robin schedule", () => {
  it("follows the Berger table for four players", () => {
    // FIDE's table, numbered from 0: 1-4 2-3 / 4-3 1-2 / 2-4 3-1.
    assert.deepEqual(roundRobin(4), [
      { pairs: [[0, 3], [1, 2]], bye: null },
      { pairs: [[3, 2], [0, 1]], bye: null },
      { pairs: [[1, 3], [2, 0]], bye: null },
    ]);
  });

  for (let n = 3; n <= 12; n++) {
    it(`pairs everyone once, with balanced colors, for ${n} players`, () => {
      const rounds = roundRobin(n);
      assert.equal(rounds.length, n % 2 ? n : n - 1);
      const met = new Set<string>();
      const colors: string[] = Array(n).fill("");
      const rests = Array(n).fill(0);
      for (const { pairs, bye } of rounds) {
        assert.equal(pairs.length, Math.floor(n / 2));
        const playing = pairs.flat();
        if (bye !== null) {
          rests[bye]++;
          playing.push(bye);
        }
        assert.equal(new Set(playing).size, n, "everyone plays or rests once a round");
        for (const [white, black] of pairs) {
          const key = [white, black].sort((a, b) => a - b).join("-");
          assert.ok(!met.has(key), `${key} meet twice`);
          met.add(key);
          colors[white] += "W";
          colors[black] += "B";
        }
      }
      assert.equal(met.size, (n * (n - 1)) / 2);
      assert.deepEqual(rests, Array(n).fill(n % 2), "with an odd number of players each rests once");
      for (const sequence of colors) {
        const whites = sequence.split("W").length - 1;
        const blacks = sequence.length - whites;
        assert.ok(Math.abs(whites - blacks) <= 1, `${sequence} is unbalanced`);
        assert.doesNotMatch(sequence, /WWW|BBB/);
      }
    });
  }

  it("needs two players", () => {
    assert.throws(() => roundRobin(1), /at least two/);
    assert.equal(roundRobin(2).length, 1);
  });
});
