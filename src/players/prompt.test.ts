import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { parseTimeControl, illegalMoveBonusMs, timeCategory } from "../timeControl.js";
import type { TurnInfo } from "../game/types.js";
import { DECISION_SCHEMA, parseDecision, systemPrompt, turnPrompt } from "./prompt.js";

function turn(overrides: Partial<TurnInfo> = {}): TurnInfo {
  const chess = new Chess();
  chess.move("e4");
  const tc = parseTimeControl("5+3");
  return {
    color: "black",
    fen: chess.fen(),
    board: chess.ascii(),
    history: ["e4"],
    startFen: new Chess().fen(),
    moveNumber: 1,
    timeControl: { ...tc, label: "5+3", category: timeCategory(tc), illegalMoveBonusMs: illegalMoveBonusMs(tc) },
    myClockMs: 287_400,
    opponentClockMs: 301_000,
    drawOffered: false,
    canOfferDraw: true,
    illegalMovesSoFar: 0,
    recentNotes: [],
    ...overrides,
  };
}

describe("prompts", () => {
  it("explains the rules of this game", () => {
    const text = systemPrompt("white", turn().timeControl);
    assert.match(text, /as White/);
    assert.match(text, /5 minutes for the whole game and 3 seconds added/);
    assert.match(text, /gets 1 minute of extra time\. A second illegal move loses/);
    assert.match(text, /can't offer another until your opponent has offered one/);
    assert.match(text, /threefold repetition/);
    assert.match(text, /Managing your clock is part of the game/);
  });

  it("gives the position, history and both clocks", () => {
    const text = turnPrompt(turn());
    assert.match(text, /You are Black/);
    assert.match(text, /Position \(FEN\): rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq - 0 1/);
    assert.match(text, /Moves so far: 1\. e4/);
    assert.match(text, /Your clock: 4:47 left \(\+3s after each move\)\. White's clock: 5:01\./);
    assert.match(text, /Suggested time for this move: about 11 seconds\./); // 4:47 over 34.5 moves, plus 3s
    assert.doesNotMatch(text, /previous move took|low on time/);
    assert.match(text, /You may offer a draw/);
    assert.doesNotMatch(text, /IMPORTANT/);
  });

  it("says how long the previous move took, and warns when time runs low", () => {
    const text = turnPrompt(turn({ moveNumber: 30, myClockMs: 50_000, myLastMoveMs: 102_000 }));
    assert.match(text, /Your previous move took 1:42\./);
    assert.match(text, /Suggested time for this move: about 6 seconds\./); // 50s over 20 moves, plus 3s
    assert.match(text, /You are low on time: play fast/);
  });

  it("mentions pending offers, draw-offer limits, illegal moves, notes and feedback", () => {
    const text = turnPrompt(
      turn({
        drawOffered: true,
        canOfferDraw: false,
        illegalMovesSoFar: 1,
        recentNotes: [{ moveNumber: 3, san: "Nf6", reasoning: "Hitting e4." }],
        feedback: '"Ke7" is not a legal move in this position',
      }),
    );
    assert.match(text, /^IMPORTANT: "Ke7" is not a legal move/);
    assert.match(text, /White has offered a draw/);
    assert.match(text, /can't offer a draw this turn/);
    assert.match(text, /another one loses the game/);
    assert.match(text, /- 3\. Nf6: Hitting e4\./);
  });

  it("has a schema that strict structured outputs accept", () => {
    const schema = DECISION_SCHEMA as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.equal(schema.additionalProperties, false);
  });
});

describe("parseDecision", () => {
  it("reads a decision", () => {
    const reply = parseDecision('{"reasoning":"Center.","action":"move","move":"e5","offer_draw":false}');
    assert.deepEqual(reply, { ok: true, decision: { action: "move", move: "e5", offerDraw: false, reasoning: "Center." } });
  });

  it("tolerates code fences and surrounding text", () => {
    const fenced = parseDecision('Here you go:\n```json\n{"reasoning":"x","action":"resign","move":null,"offer_draw":false}\n```');
    assert.equal(fenced.ok && fenced.decision.action, "resign");
    const embedded = parseDecision('I play {"reasoning":"x","action":"move","move":"d5","offer_draw":true} ok');
    assert.equal(embedded.ok && embedded.decision.offerDraw, true);
  });

  it("rejects unusable replies", () => {
    assert.equal(parseDecision("e4").ok, false);
    assert.equal(parseDecision("[1,2]").ok, false);
    const bad = parseDecision('{"action":"castle","move":"O-O"}');
    assert.deepEqual(bad, { ok: false, error: '"action" must be "move", "resign" or "accept_draw"' });
  });
});
