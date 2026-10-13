import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { parseTimeControl } from "../timeControl.js";
import { CLAUDE, FakeClock, GPT, ScriptedPlayer, type Step } from "../testing.js";
import { createGameRecord, GameRunner } from "./game.js";
import { toPgn } from "./pgn.js";

async function play(white: Step[], black: Step[], fen?: string) {
  const clock = new FakeClock();
  const record = createGameRecord({
    id: "20261013-120000-abcdef",
    timeControl: parseTimeControl("5+3"),
    white: CLAUDE,
    black: GPT,
    colorsAssigned: "random",
    startFen: fen,
  });
  await new GameRunner(
    record,
    { white: new ScriptedPlayer(CLAUDE, white, clock), black: new ScriptedPlayer(GPT, black, clock) },
    { now: clock.now, sleep: clock.sleep },
  ).run();
  return record;
}

/** The movetext section with line breaks removed. */
function movetext(pgn: string): string {
  return pgn.split("\n\n")[1].trim().replace(/\n/g, " ");
}

describe("PGN export", () => {
  it("writes headers, clocks and reasoning, and round-trips through a PGN parser", async () => {
    const game = await play(
      [{ move: "f3", think: 2000, reasoning: "A {dubious} start." }, { move: "g4", think: 1000 }],
      ["e5", { move: "Qh4#", reasoning: "Mate." }],
    );
    const pgn = toPgn(game);
    const moves = movetext(pgn);
    assert.match(pgn, /^\[Event "Botwinnik AI match"\]$/m);
    assert.match(pgn, /^\[White "claude-test"\]$/m);
    assert.match(pgn, /^\[Black "gpt-test"\]$/m);
    assert.match(pgn, /^\[Result "0-1"\]$/m);
    assert.match(pgn, /^\[TimeControl "300\+3"\]$/m);
    assert.match(pgn, /^\[Termination "normal"\]$/m);
    assert.match(pgn, /^\[WhiteType "program"\]$/m);
    assert.match(moves, /^1\. f3 \{\[%clk 0:05:01\] A \(dubious\) start\.\} 1\.\.\. e5/);
    assert.match(moves, /2\.\.\. Qh4# \{\[%clk 0:05:06\] Mate\. Black wins by checkmate\.\} 0-1$/);
    assert.match(pgn, /0-1\n$/);
    assert.ok(pgn.split("\n").every((line) => line.length <= 80), "lines are wrapped");

    const chess = new Chess();
    chess.loadPgn(pgn);
    assert.equal(chess.fen(), game.moves.at(-1)!.fenAfter);
    assert.equal(chess.getHeaders().Result, "0-1");
  });

  it("records illegal moves, draw offers and the termination", async () => {
    const game = await play(
      [{ move: "Ke2", reasoning: "King walk!" }, { move: "e4", offerDraw: true }, { move: "Qxf7" }],
      ["e5"],
    );
    const pgn = toPgn(game);
    const moves = movetext(pgn);
    assert.match(moves, /^\{Illegal move by White: "Ke2" is not a legal move\. Black gets 1 minute extra\. Reasoning: King walk!\} 1\. e4/);
    assert.match(moves, /White offers a draw\. Black declines the draw offer by playing on\.\} 1\.\.\. e5/);
    assert.match(pgn, /^\[Termination "rules infraction"\]$/m);
    assert.match(moves, /White made a second illegal move\.\} 0-1$/);
    const chess = new Chess();
    chess.loadPgn(pgn);
    assert.equal(chess.history().length, 2);
  });

  it("includes the start position when it isn't the standard one", async () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const game = await play([{ action: "resign" }], ["c5"], fen);
    const pgn = toPgn(game);
    assert.match(pgn, /^\[SetUp "1"\]$/m);
    assert.match(pgn, new RegExp(`^\\[FEN "${fen.replace(/[/]/g, "\\/")}"\\]$`, "m"));
    assert.match(movetext(pgn), /^1\.\.\. c5 \{\[%clk 0:05:03\] Playing c5\. White resigns\. Black wins: White resigned\.\} 0-1$/);
    const chess = new Chess();
    chess.loadPgn(pgn);
    assert.equal(chess.history()[0], "c5");
  });

  it("marks unfinished games", async () => {
    const game = createGameRecord({
      id: "x",
      timeControl: parseTimeControl("3+2"),
      white: CLAUDE,
      black: GPT,
      colorsAssigned: "manual",
    });
    const pgn = toPgn(game);
    assert.match(pgn, /^\[Result "\*"\]$/m);
    assert.match(pgn, /^\[Termination "unterminated"\]$/m);
    assert.match(pgn, /\n\*\n$/);
  });
});
