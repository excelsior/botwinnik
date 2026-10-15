import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameRecord } from "../game/types.js";
import { currentRound, standings, type GameOutcome, type TournamentRecord } from "./tournament.js";

const player = (model: string) => ({ provider: "anthropic" as const, model });

/** A tournament between the given players whose games are `${white}-${black}` in `results`. */
function tournament(models: string[], rounds: [string, string][][]): TournamentRecord {
  return {
    version: 1,
    id: "t",
    name: "Test",
    status: "running",
    createdAt: "2026-10-14T00:00:00.000Z",
    timeControl: { baseMs: 300_000, incrementMs: 3000, label: "5+3", category: "blitz" },
    players: models.map(player),
    rounds: rounds.map((games) => ({
      bye: null,
      games: games.map(([white, black]) => ({ white: models.indexOf(white), black: models.indexOf(black), gameId: `${white}-${black}` })),
    })),
  };
}

function outcomes(results: Record<string, GameRecord["result"] | "aborted" | "running">) {
  return (id: string): GameOutcome | undefined => {
    const result = results[id];
    if (result === undefined) return undefined;
    if (result === "aborted") return { status: "aborted", result: "*" };
    if (result === "running") return { status: "running", result: "*" };
    return { status: "finished", result };
  };
}

describe("tournament standings", () => {
  it("ranks by points, then Sonneborn-Berger, then wins", () => {
    const t = tournament(["a", "b", "c", "d"], [
      [["a", "b"], ["c", "d"]],
      [["c", "a"], ["b", "d"]],
      [["a", "d"], ["b", "c"]],
    ]);
    const table = standings(t, outcomes({ "a-b": "1-0", "c-d": "1-0", "c-a": "1/2-1/2", "b-d": "1-0", "a-d": "1-0", "b-c": "1-0" }));
    assert.deepEqual(
      table.map((s) => [s.model, s.rank, s.points, s.tiebreak, s.wins, s.draws, s.losses, s.played]),
      [
        ["a", 1, 2.5, 2.75, 2, 1, 0, 3], // beat b (2) and d (0), drew with c (1½ / 2)
        ["b", 2, 2, 1.5, 2, 0, 1, 3],
        ["c", 3, 1.5, 1.25, 1, 1, 1, 3],
        ["d", 4, 0, 0, 0, 0, 3, 3],
      ],
    );
  });

  it("shares a place between players level on everything", () => {
    const t = tournament(["a", "b", "c"], [[["a", "b"]], [["b", "c"]], [["c", "a"]]]);
    const table = standings(t, outcomes({ "a-b": "1/2-1/2", "b-c": "1/2-1/2", "c-a": "1/2-1/2" }));
    assert.deepEqual(table.map((s) => [s.model, s.rank, s.points]), [["a", 1, 1], ["b", 1, 1], ["c", 1, 1]]);
  });

  it("counts only finished games, and adds up what they did to the ratings", () => {
    const t = tournament(["a", "b", "c"], [[["a", "b"]], [["b", "c"]], [["c", "a"]]]);
    const table = standings(t, outcomes({ "a-b": "0-1", "b-c": "aborted", "c-a": "running" }), {
      now: (p) => ({ a: 1490, b: 1510, c: 1500 })[p.model]!,
      forGame: (id) => (id === "a-b" ? { white: { before: 1506, after: 1490 }, black: { before: 1494, after: 1510 } } : null),
    });
    assert.deepEqual(
      table.map((s) => [s.model, s.points, s.played, s.rating]),
      [
        ["b", 1, 1, { now: 1510, change: 16 }],
        ["a", 0, 1, { now: 1490, change: -16 }],
        ["c", 0, 0, { now: 1500, change: 0 }],
      ],
    );
  });

  it("finds the round being played", () => {
    const t = tournament(["a", "b", "c"], [[["a", "b"]], [["b", "c"]], [["c", "a"]]]);
    assert.equal(currentRound(t, outcomes({ "a-b": "running" })), 0);
    assert.equal(currentRound(t, outcomes({ "a-b": "1-0", "b-c": "aborted", "c-a": "running" })), 2, "a game that isn't over holds its round");
    assert.equal(currentRound(t, outcomes({ "a-b": "1-0", "b-c": "1-0", "c-a": "0-1" })), -1);
    assert.equal(currentRound(t, outcomes({ "a-b": "1-0", "b-c": "1-0" })), -1, "a deleted game counts as over");
    delete t.rounds[2].games[0].gameId;
    assert.equal(currentRound(t, outcomes({ "a-b": "1-0", "b-c": "1-0" })), 2, "a game not started holds its round");
  });
});
