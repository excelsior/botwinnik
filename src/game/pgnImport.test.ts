import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseTimeControl } from "../timeControl.js";
import { callSpend, CLAUDE, FakeClock, GPT, ScriptedPlayer, type Step } from "../testing.js";
import { createGameRecord, GameRunner } from "./game.js";
import { toPgn } from "./pgn.js";
import { importPgn, readComment } from "./pgnImport.js";
import { GameService } from "./service.js";
import { GameStore } from "./store.js";
import { OutOfFundsError, type GameRecord } from "./types.js";

async function play(white: Step[], black: Step[]) {
  const clock = new FakeClock();
  const record = createGameRecord({
    id: "20261013-120000-abcdef",
    timeControl: parseTimeControl("5+3"),
    white: CLAUDE,
    black: GPT,
    colorsAssigned: "random",
  });
  await new GameRunner(
    record,
    {
      white: new ScriptedPlayer(CLAUDE, white, clock, callSpend(0.25)),
      black: new ScriptedPlayer(GPT, black, clock, callSpend(0.5, 2000, 300)),
    },
    { now: clock.now, sleep: clock.sleep },
  ).run();
  return record;
}

/** The parts of a game a PGN can't hold to the millisecond: creation and move timestamps. */
function withoutTimestamps(game: GameRecord) {
  const copy = structuredClone(game) as Partial<GameRecord>;
  delete copy.createdAt;
  delete copy.finishedAt;
  for (const m of copy.moves!) delete (m as Partial<typeof m>).at;
  for (const e of copy.events!) delete (e as Partial<typeof e>).at;
  return copy;
}

const sameId = (id: string | undefined) => id ?? "new-id";

describe("PGN import", () => {
  it("restores a finished game exported by Botwinnik", async () => {
    const game = await play(
      [{ move: "Ke2", reasoning: "King walk!" }, { move: "f3", think: 2000, offerDraw: true, reasoning: "A {dubious} start." }, { move: "g4", think: 1500 }],
      [{ invalid: "no JSON" }, { move: "e5", think: 700 }, { move: "Qh4#", reasoning: "Mate." }],
    );
    assert.equal(game.result, "0-1");
    const pgn = toPgn(game, { white: { before: 1532, after: 1515 }, black: { before: 1490, after: 1507 } });
    assert.match(pgn, /^\[WhiteElo "1532"\]\n\[BlackElo "1490"\]$/m);
    // Ratings come from the games themselves, so the import leaves the Elo tags aside.
    const imported = importPgn(pgn, sameId);
    // Braces can't appear in PGN comments; everything else comes back as it was.
    game.moves[0].reasoning = "A (dubious) start.";
    assert.deepEqual(withoutTimestamps(imported), withoutTimestamps(game));
    assert.equal(imported.createdAt, game.createdAt.replace(/\.\d+Z$/, ".000Z"));
  });

  it("restores a paused game, which can then be resumed", async () => {
    const outOfFunds = new OutOfFundsError("OpenAI API error 429: You exceeded your current quota");
    const game = await play([{ move: "e4", think: 4000, offerDraw: true }], [{ move: "Ke5", think: 1234 }, { error: outOfFunds }]);
    assert.equal(game.status, "paused");
    assert.equal(game.pendingDrawOffer, "white");
    assert.equal(game.illegalMoves.black, 1);

    const pgn = toPgn(game);
    assert.match(pgn, /^\[Result "\*"\]$/m);
    assert.match(pgn, /^\[WhiteClock "0:05:59\.000"\]$/m);
    assert.match(pgn, /^\[BlackClock "0:04:58\.766"\]$/m);
    const imported = importPgn(pgn, sameId);
    assert.deepEqual(withoutTimestamps(imported), withoutTimestamps(game));

    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const service = new GameService(new GameStore(dir), (spec) =>
        new ScriptedPlayer(spec, spec.provider === "openai" ? [{ action: "accept_draw", reasoning: "Fine." }] : []),
      );
      const saved = service.importPgn(pgn);
      assert.equal(saved.id, game.id);
      service.resume(saved.id);
      const final = await service.wait(saved.id);
      assert.equal(final?.result, "1/2-1/2");
      assert.equal(final?.termination?.reason, "agreement");
      assert.deepEqual(
        final?.events.map((e) => e.type),
        ["illegal_move", "paused", "resumed", "draw_accepted"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores an aborted game as aborted", async () => {
    const record = createGameRecord({ id: "g", timeControl: parseTimeControl("3+2"), white: GPT, black: CLAUDE, colorsAssigned: "manual" });
    record.status = "aborted";
    record.termination = { reason: "aborted", winner: null, message: "Aborted by the admin." };
    const imported = importPgn(toPgn(record), sameId);
    assert.equal(imported.status, "aborted");
    assert.equal(imported.result, "*");
    assert.deepEqual(imported.termination, record.termination);
    assert.deepEqual(imported.white, GPT);
  });

  it("imports PGNs from elsewhere, guessing the providers from the model names", () => {
    const pgn = `[Event "Casual game"]
[Site "https://lichess.org/abcdefgh"]
[Date "2026.09.01"]
[White "claude-opus-5-5"]
[Black "gpt-5.6-sol"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 { [%clk 0:10:00] [%eval 0.3] Best by test. } 1... e5 $2 { [%clk 0:10:03] }
2. Bc4 (2. Nf3 Nc6 { a side line } 3. Bb5) 2... Nc6 ; a rest-of-line comment
3. Qh5 Nf6?? 4. Qxf7# 1-0
`;
    const game = importPgn(pgn, sameId);
    assert.equal(game.id, "new-id");
    assert.equal(game.status, "finished");
    assert.equal(game.result, "1-0");
    assert.equal(game.termination?.reason, "checkmate");
    assert.deepEqual(game.white, { provider: "anthropic", model: "claude-opus-5-5" });
    assert.deepEqual(game.black, { provider: "openai", model: "gpt-5.6-sol" });
    assert.equal(game.timeControl.label, "10+5");
    assert.deepEqual(
      game.moves.map((m) => m.san),
      ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"],
    );
    assert.equal(game.moves[0].reasoning, "Best by test.");
    assert.equal(game.moves[1].clockMs, 603_000);
    assert.equal(game.moves[3].reasoning, "a rest-of-line comment");
    assert.equal(game.createdAt, "2026-09-01T00:00:00.000Z");
    assert.equal(game.spend.white.calls, 0);
  });

  it("brings an unfinished game back paused, with the clocks from its last moves", () => {
    const pgn = `[White "my-model"]
[WhiteProvider "openai"]
[Black "claude-x"]
[TimeControl "300+2"]
[Result "*"]

1. d4 {[%clk 0:04:58]} d5 {[%clk 0:04:55]} 2. c4 *`;
    const game = importPgn(pgn, sameId);
    assert.equal(game.status, "paused");
    assert.equal(game.result, "*");
    assert.deepEqual(game.white, { provider: "openai", model: "my-model" });
    assert.deepEqual(game.clocks, { white: 298_000, black: 295_000 });
    assert.equal(game.termination, null);
  });

  it("finishes an unfinished game whose last move already ends it", () => {
    const game = importPgn(`[White "claude-a"] [Black "gpt-b"] [TimeControl "60"] 1. f3 e5 2. g4 Qh4# *`, sameId);
    assert.equal(game.status, "finished");
    assert.equal(game.result, "0-1");
    assert.equal(game.termination?.reason, "checkmate");
    assert.equal(game.timeControl.label, "1+0");
  });

  it("explains what's wrong with a PGN it can't import", () => {
    const tags = `[White "claude-a"] [Black "gpt-b"] [TimeControl "300+3"]`;
    assert.throws(() => importPgn("", sameId), /No game found/);
    assert.throws(() => importPgn(`${tags} 1. e4 * ${tags} 1. d4 *`, sameId), /holds 2 games/);
    assert.throws(() => importPgn(`[White "claude-a"] [Black "Magnus"] [TimeControl "300"] *`, sameId), /Can't tell which provider Black \("Magnus"\) comes from/);
    assert.throws(() => importPgn(`[White "claude-a"] [Black "gpt-b"] 1. e4 *`, sameId), /no time control/);
    assert.throws(() => importPgn(`${tags} 1. e4 e5 2. Ke3 *`, sameId), /2\. Ke3 isn't a legal move/);
    assert.throws(() => importPgn(`${tags} [FEN "not a position"] *`, sameId), /FEN tag/);
    assert.throws(() => importPgn(`[White claude] *`, sameId), /Can't read the tag/);
  });

  it("reads the commands in a comment", () => {
    const data = readComment(
      '[%clk 0:01:02] [%emt 0:00:03.4] [%spend usd=? calls=2 in=10 cached=5 out=7] I think. [%draw offer] White offers a draw. ' +
        '[%event illegal_move black bonus=60000 sent="Q\\u007dx"] Illegal! [%reasoning] Oops. [%event bogus white] Ignored. [%end timeout white] White wins on time.',
    );
    assert.equal(data.clockMs, 62_000);
    assert.equal(data.thinkingMs, 3400);
    assert.deepEqual(data.spend, { calls: 2, inputTokens: 10, cachedInputTokens: 5, outputTokens: 7, costUsd: null });
    assert.equal(data.reasoning, "I think.");
    assert.equal(data.drawOffered, true);
    assert.deepEqual(data.events, [
      { type: "illegal_move", color: "black", message: "Illegal!", bonusMs: 60000, attempted: "Q}x", reasoning: "Oops." },
    ]);
    assert.deepEqual(data.termination, { reason: "timeout", winner: "white", message: "White wins on time." });
  });

  it("keeps the PGN's game id unless it is taken", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const service = new GameService(new GameStore(dir), (spec) => new ScriptedPlayer(spec, []));
      const pgn = `[White "claude-a"] [Black "gpt-b"] [TimeControl "300"] [GameId "20260101-000000-aaaaaa"] [Result "*"] 1. e4 *`;
      assert.equal(service.importPgn(pgn).id, "20260101-000000-aaaaaa");
      const second = service.importPgn(pgn);
      assert.notEqual(second.id, "20260101-000000-aaaaaa");
      assert.equal(service.get(second.id)?.status, "paused");
      assert.notEqual(service.importPgn(pgn.replace("20260101-000000-aaaaaa", "../escape")).id, "../escape");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
