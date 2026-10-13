import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTimeControl, type TimeControl } from "../timeControl.js";
import { callSpend, CLAUDE, FakeClock, GPT, ScriptedPlayer, type Step } from "../testing.js";
import type { Spend } from "../pricing.js";
import { createGameRecord, GameRunner, moveNumberOf, type GameOptions } from "./game.js";
import { FatalPlayerError, TransientPlayerError } from "./types.js";

function setup(
  whiteSteps: Step[],
  blackSteps: Step[],
  opts: {
    tc?: string | TimeControl;
    fen?: string;
    realTime?: boolean;
    options?: GameOptions;
    spend?: { white?: Spend; black?: Spend };
  } = {},
) {
  const clock = new FakeClock();
  const tc = typeof opts.tc === "object" ? opts.tc : parseTimeControl(opts.tc ?? "5+3");
  const record = createGameRecord({
    id: "test",
    timeControl: tc,
    white: CLAUDE,
    black: GPT,
    colorsAssigned: "manual",
    startFen: opts.fen,
  });
  const white = new ScriptedPlayer(CLAUDE, whiteSteps, clock, opts.spend?.white);
  const black = new ScriptedPlayer(GPT, blackSteps, clock, opts.spend?.black);
  const runner = new GameRunner(
    record,
    { white, black },
    opts.realTime ? { ...opts.options } : { now: clock.now, sleep: clock.sleep, ...opts.options },
  );
  return { runner, record, white, black, clock };
}

describe("game end conditions", () => {
  it("ends on checkmate and records moves, reasoning and clocks", async () => {
    const { runner, record } = setup(
      [{ move: "f3", think: 2000, reasoning: "Opening the diagonal, bravely." }, { move: "g4", think: 1000 }],
      [{ move: "e5", think: 4000 }, { move: "Qh4#", think: 500, reasoning: "Mate on the e1-h4 diagonal." }],
    );
    await runner.run();
    assert.equal(record.status, "finished");
    assert.equal(record.result, "0-1");
    assert.equal(record.termination?.reason, "checkmate");
    assert.deepEqual(
      record.moves.map((m) => m.san),
      ["f3", "e5", "g4", "Qh4#"],
    );
    assert.equal(record.moves[0].reasoning, "Opening the diagonal, bravely.");
    assert.equal(record.moves[3].reasoning, "Mate on the e1-h4 diagonal.");
    // 5:00 - 2s + 3s increment
    assert.equal(record.moves[0].clockMs, 301_000);
    assert.equal(record.moves[0].thinkingMs, 2000);
    assert.equal(record.clocks.white, 300_000 - 2000 + 3000 - 1000 + 3000);
    assert.equal(record.clocks.black, 300_000 - 4000 + 3000 - 500 + 3000);
    assert.equal(record.turnStartedAt, undefined);
  });

  it("ends immediately on threefold repetition", async () => {
    const { runner, record } = setup(["Nf3", "Ng1", "Nf3", "Ng1"], ["Nf6", "Ng8", "Nf6", "Ng8"]);
    await runner.run();
    assert.equal(record.result, "1/2-1/2");
    assert.equal(record.termination?.reason, "threefold_repetition");
    assert.equal(record.moves.length, 8);
  });

  it("ends on stalemate", async () => {
    // Sam Loyd's ten-move stalemate.
    const { runner, record } = setup(
      ["e3", "Qh5", "Qxa5", "h4", "Qxc7", "Qxd7+", "Qxb7", "Qxb8", "Qxc8", "Qe6"],
      ["a5", "Ra6", "h5", "Rah6", "f6", "Kf7", "Qd3", "Qh7", "Kg6"],
    );
    await runner.run();
    assert.equal(record.result, "1/2-1/2");
    assert.equal(record.termination?.reason, "stalemate");
  });

  it("ends on insufficient material", async () => {
    const { runner, record } = setup(["Kxd2"], [], { fen: "4k3/8/8/8/8/8/3n4/4K3 w - - 0 1" });
    await runner.run();
    assert.equal(record.termination?.reason, "insufficient_material");
    assert.equal(record.result, "1/2-1/2");
  });

  it("ends after fifty moves without a capture or pawn move", async () => {
    const { runner, record } = setup(["Ra2"], [], { fen: "4k3/8/8/8/8/8/8/R3K3 w - - 99 60" });
    await runner.run();
    assert.equal(record.termination?.reason, "fifty_moves");
    assert.equal(record.result, "1/2-1/2");
  });

  it("lets a player resign", async () => {
    const { runner, record } = setup(["e4"], [{ action: "resign", reasoning: "Hopeless." }]);
    await runner.run();
    assert.equal(record.result, "1-0");
    assert.equal(record.termination?.reason, "resignation");
    assert.equal(record.events.at(-1)?.type, "resignation");
    assert.equal(record.events.at(-1)?.reasoning, "Hopeless.");
  });
});

describe("illegal moves", () => {
  it("gives the opponent a minute after the first illegal move in blitz, and the second one loses", async () => {
    const { runner, record, white } = setup(
      [{ move: "Ke2", think: 1000 }, { move: "e4", think: 1000 }, { move: "Qxf7", think: 1000 }],
      ["e5"],
    );
    await runner.run();
    assert.equal(record.timeControl.category, "blitz");
    assert.equal(record.result, "0-1");
    assert.equal(record.termination?.reason, "illegal_moves");
    assert.equal(record.illegalMoves.white, 2);
    const illegal = record.events.filter((e) => e.type === "illegal_move");
    assert.equal(illegal.length, 2);
    assert.equal(illegal[0].attempted, "Ke2");
    assert.equal(illegal[0].bonusMs, 60_000);
    assert.equal(illegal[0].ply, 0);
    // Black: 5:00 + 1:00 bonus, then e5 played instantly with +3s.
    assert.equal(record.moves[1].clockMs, 300_000 + 60_000 + 3000);
    // The retry was told what happened, on the same turn and clock.
    assert.match(white.turns[1].feedback ?? "", /"Ke2" is not a legal move/);
    assert.equal(white.turns[1].illegalMovesSoFar, 1);
    assert.equal(white.turns[1].myClockMs, 299_000);
    // The time spent on the illegal attempt counts against the clock.
    assert.equal(record.moves[0].thinkingMs, 2000);
  });

  it("gives two minutes in classical games", async () => {
    const { runner, record } = setup(["Ke2", "e4"], [{ action: "resign" }], { tc: "60+0" });
    await runner.run();
    assert.equal(record.timeControl.category, "classical");
    assert.equal(record.events[0].bonusMs, 120_000);
    assert.equal(record.clocks.black, 3_600_000 + 120_000);
  });

  it("re-asks after unusable replies, and counts the third one in a turn as an illegal move", async () => {
    const { runner, record, white } = setup(
      [{ invalid: "not JSON" }, { invalid: "not JSON" }, { invalid: "not JSON" }, "e4"],
      [{ action: "resign" }],
    );
    await runner.run();
    assert.deepEqual(
      record.events.map((e) => e.type),
      ["invalid_response", "invalid_response", "invalid_response", "illegal_move", "resignation"],
    );
    assert.equal(record.illegalMoves.white, 1);
    assert.match(white.turns[1].feedback ?? "", /could not be used: not JSON/);
    assert.match(white.turns[3].feedback ?? "", /counts as an illegal move/);
    assert.equal(record.result, "1-0");
  });

  it("treats a move action without a move as unusable", async () => {
    const { runner, record } = setup([{ action: "move" }, "d4"], [{ action: "resign" }]);
    await runner.run();
    assert.equal(record.events[0].type, "invalid_response");
    assert.equal(record.illegalMoves.white, 0);
    assert.equal(record.moves[0].san, "d4");
  });
});

describe("draw offers", () => {
  it("ends the game when the opponent accepts", async () => {
    const { runner, record, black } = setup([{ move: "e4", offerDraw: true }], [{ action: "accept_draw" }]);
    await runner.run();
    assert.equal(black.turns[0].drawOffered, true);
    assert.equal(record.moves[0].drawOffered, true);
    assert.equal(record.result, "1/2-1/2");
    assert.equal(record.termination?.reason, "agreement");
  });

  it("is declined by moving, and the same player can't offer twice in a row", async () => {
    const { runner, record, white, black } = setup(
      [{ move: "e4", offerDraw: true }, { move: "Nf3", offerDraw: true }, { action: "accept_draw" }],
      ["e5", { move: "Nc6", offerDraw: true }],
    );
    await runner.run();
    const types = record.events.map((e) => e.type);
    assert.deepEqual(types, ["draw_declined", "draw_offer_not_allowed", "draw_accepted"]);
    assert.equal(white.turns[1].canOfferDraw, false);
    assert.equal(black.turns[1].drawOffered, false, "the refused offer was not passed on");
    assert.equal(record.moves[2].drawOffered, false);
    assert.equal(record.moves[3].drawOffered, true);
    assert.equal(white.turns[2].drawOffered, true);
    assert.equal(white.turns[2].canOfferDraw, true, "Black offered since, so White may offer again");
    assert.equal(record.result, "1/2-1/2");
  });

  it("rejects accepting a draw nobody offered", async () => {
    const { runner, record } = setup([{ action: "accept_draw" }, "e4"], [{ action: "resign" }]);
    await runner.run();
    assert.equal(record.events[0].type, "invalid_response");
    assert.match(record.events[0].message, /no draw offer/);
    assert.equal(record.result, "1-0");
  });
});

describe("clocks", () => {
  it("cuts off a player whose clock runs out mid-request", async () => {
    const { runner, record, white } = setup([{ hang: true }], [], {
      tc: { baseMs: 60, incrementMs: 0 },
      realTime: true,
    });
    await runner.run();
    assert.equal(white.turns.length, 1);
    assert.equal(record.termination?.reason, "timeout");
    assert.equal(record.result, "0-1");
    assert.equal(record.clocks.white, 0);
  });

  it("flags a reply that arrives after the clock ran out", async () => {
    const { runner, record } = setup([{ move: "e4", think: 301_000 }], [], { tc: "5+3" });
    await runner.run();
    assert.equal(record.moves.length, 0);
    assert.equal(record.termination?.reason, "timeout");
    assert.equal(record.result, "0-1");
  });

  it("is a draw when the side that flagged faces a lone king", async () => {
    const { runner, record } = setup([], [{ move: "Ra3", think: 61_000 }], {
      tc: "1+0",
      fen: "4k3/8/8/8/8/8/r7/4K3 b - - 0 1",
    });
    await runner.run();
    assert.equal(record.termination?.reason, "timeout_vs_insufficient_material");
    assert.equal(record.result, "1/2-1/2");
  });

  it("tells players both clocks", async () => {
    const { runner, black } = setup([{ move: "e4", think: 10_000 }], [{ action: "resign", think: 1000 }]);
    await runner.run();
    assert.equal(black.turns[0].myClockMs, 300_000);
    assert.equal(black.turns[0].opponentClockMs, 293_000);
  });
});

describe("API failures and aborting", () => {
  it("retries transient errors on the player's clock", async () => {
    const { runner, record, clock } = setup(
      [{ error: new TransientPlayerError("rate limited") }, { error: new TransientPlayerError("overloaded") }, "e4"],
      [{ action: "resign" }],
    );
    await runner.run();
    assert.deepEqual(
      record.events.map((e) => e.type),
      ["api_error", "api_error", "resignation"],
    );
    // Back-off waits of 1s and 2s were charged to White.
    assert.equal(record.moves[0].thinkingMs, 3000);
    assert.equal(clock.t, 3000);
    assert.equal(record.result, "1-0");
  });

  it("aborts the game without a result on a fatal error", async () => {
    const { runner, record } = setup(["e4"], [{ error: new FatalPlayerError("401 invalid x-api-key") }]);
    await runner.run();
    assert.equal(record.status, "aborted");
    assert.equal(record.result, "*");
    assert.equal(record.termination?.reason, "error");
    assert.match(record.termination?.message ?? "", /gpt-test.*invalid x-api-key/);
  });

  it("can be aborted by the admin while a player is thinking", async () => {
    const { runner, record } = setup([{ hang: true }], [], { realTime: true });
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 20));
    runner.abort();
    await done;
    assert.equal(record.status, "aborted");
    assert.equal(record.result, "*");
    assert.equal(record.termination?.reason, "aborted");
    assert.ok(record.clocks.white < 300_000 && record.clocks.white > 299_000);
  });

  it("reports progress through onUpdate", async () => {
    const updates: number[] = [];
    const { runner } = setup(["e4"], [{ action: "resign" }], {
      options: { onUpdate: (g) => updates.push(g.moves.length) },
    });
    await runner.run();
    assert.ok(updates.length >= 3);
    assert.equal(updates.at(-1), 1);
  });
});

describe("custom start positions", () => {
  it("lets Black move first and numbers moves from the FEN", async () => {
    const { runner, record } = setup([{ action: "resign" }], ["e5"], {
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    });
    await runner.run();
    assert.equal(record.moves[0].color, "black");
    assert.equal(moveNumberOf(record.moves[0]), 1);
    assert.equal(record.result, "0-1");
  });
});

describe("costs", () => {
  it("charges every call in a turn to its move, and every call to the player", async () => {
    const { runner, record } = setup(
      [{ move: "Ke2", spend: callSpend(0.02, 2000, 300) }, { invalid: "garbled", spend: callSpend(0.01) }, "e4", "d4"],
      ["e5", { action: "resign", spend: callSpend(0.004) }],
      { spend: { white: callSpend(0.01), black: callSpend(0.005) } },
    );
    await runner.run();
    const [e4, e5, d4] = record.moves;
    assert.equal(e4.spend.calls, 3);
    assert.equal(e4.spend.inputTokens, 4000);
    assert.equal(e4.spend.outputTokens, 500);
    assert.ok(Math.abs(e4.spend.costUsd! - 0.04) < 1e-9);
    assert.deepEqual(e5.spend, callSpend(0.005));
    assert.deepEqual(d4.spend, callSpend(0.01));
    // White: 0.04 for e4 + 0.01 for d4. Black: 0.005 for e5 + 0.004 for resigning.
    assert.ok(Math.abs(record.spend.white.costUsd! - 0.05) < 1e-9);
    assert.equal(record.spend.white.calls, 4);
    assert.ok(Math.abs(record.spend.black.costUsd! - 0.009) < 1e-9);
    assert.equal(record.spend.black.calls, 2);
  });

  it("keeps counting tokens when a model's price is unknown", async () => {
    const { runner, record } = setup(["e4"], [{ action: "resign" }], {
      spend: { white: callSpend(null, 500, 50), black: callSpend(0.001) },
    });
    await runner.run();
    assert.equal(record.moves[0].spend.costUsd, null);
    assert.equal(record.moves[0].spend.inputTokens, 500);
    assert.equal(record.spend.white.costUsd, null);
    assert.equal(record.spend.black.costUsd, 0.001);
  });

  it("counts a reply that arrived too late", async () => {
    const { runner, record } = setup([{ move: "e4", think: 400_000, spend: callSpend(0.3) }], []);
    await runner.run();
    assert.equal(record.termination?.reason, "timeout");
    assert.equal(record.spend.white.costUsd, 0.3);
  });
});
