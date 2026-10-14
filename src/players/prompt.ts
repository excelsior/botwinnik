import { formatMoveList } from "../game/moves.js";
import { colorName, opponent, type Color, type Decision, type PlayerReply, type TurnInfo } from "../game/types.js";
import { describeDuration, formatClock } from "../timeControl.js";

/** JSON Schema for a player's reply; usable with both OpenAI strict mode and Claude structured outputs. */
export const DECISION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "One to three sentences on the idea behind your choice, e.g. grabbing the center, putting pressure on f2, building a battery.",
    },
    action: {
      type: "string",
      enum: ["move", "resign", "accept_draw"],
      description: '"move" to play a move, "resign" to resign, "accept_draw" to accept a pending draw offer.',
    },
    move: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: 'Your move in Standard Algebraic Notation, e.g. "Nf3", "exd5", "O-O", "e8=Q". Null unless action is "move".',
    },
    offer_draw: {
      type: "boolean",
      description: "True to offer a draw together with your move.",
    },
  },
  required: ["reasoning", "action", "move", "offer_draw"],
  additionalProperties: false,
};

export function systemPrompt(color: Color, timeControl: TurnInfo["timeControl"]): string {
  const base = describeDuration(timeControl.baseMs);
  const inc = timeControl.incrementMs
    ? ` and ${describeDuration(timeControl.incrementMs)} added to your clock after each move you make`
    : " with no increment";
  const bonus = describeDuration(timeControl.illegalMoveBonusMs);
  return [
    `You are playing a game of chess as ${colorName(color)} against another AI model. Play to win.`,
    "",
    "Rules of this game:",
    `- Time control ${timeControl.label} (${timeControl.category}): ${base} for the whole game${inc}. Your clock runs while you think; if it reaches zero you lose, or draw if your opponent has only a king left.`,
    "- The game ends immediately on checkmate, stalemate, insufficient material, threefold repetition, or fifty moves by each side without a capture or pawn move. No claim is needed.",
    `- An illegal move is taken back and you must move again while your clock keeps running; your opponent gets ${bonus} of extra time. A second illegal move loses the game.`,
    "- You may offer a draw together with a move. Your opponent accepts it or declines it on their next turn. Once you have offered a draw, you can't offer another until your opponent has offered one.",
    "- You may resign instead of moving.",
    "",
    "Each turn you get the position, the moves so far, both clocks and any pending draw offer. Reply with a JSON object:",
    '- "reasoning": one to three sentences explaining the idea behind your choice (for example: grabbing the center, putting pressure on f2, building a battery). Your opponent does not see it.',
    '- "action": "move", "resign", or "accept_draw" (only when your opponent has offered a draw).',
    '- "move": your move in Standard Algebraic Notation, such as "e4", "Nf3", "exd5", "O-O", "e8=Q"; null if you are not moving.',
    '- "offer_draw": true to offer a draw along with your move, otherwise false.',
  ].join("\n");
}

export function turnPrompt(turn: TurnInfo): string {
  const me = colorName(turn.color);
  const them = colorName(opponent(turn.color));
  const lines: string[] = [];
  if (turn.feedback) lines.push(`IMPORTANT: ${turn.feedback}`, "");
  lines.push(`Move ${turn.moveNumber}. You are ${me}, and it is your turn.`, "");
  lines.push(`Position (FEN): ${turn.fen}`, "", "Board (White at the bottom):", turn.board, "");
  const moves = turn.history.length ? formatMoveList(turn.history, turn.startFen) : "none yet";
  lines.push(`Moves so far: ${moves}`);
  if (turn.history.length) lines.push(`${them}'s last move: ${turn.history[turn.history.length - 1]}`);
  lines.push("");
  const inc = turn.timeControl.incrementMs ? ` (+${turn.timeControl.incrementMs / 1000}s after each move)` : "";
  lines.push(`Your clock: ${formatClock(turn.myClockMs)} left${inc}. ${them}'s clock: ${formatClock(turn.opponentClockMs)}.`);
  if (turn.drawOffered) {
    lines.push(`${them} has offered a draw. Reply with action "accept_draw" to accept it, or make a move to decline.`);
  }
  lines.push(
    turn.canOfferDraw
      ? "You may offer a draw with your move."
      : "You can't offer a draw this turn: you made the last offer, and your opponent hasn't offered one since.",
  );
  if (turn.illegalMovesSoFar > 0) {
    lines.push("You have already made one illegal move in this game; another one loses the game.");
  }
  if (turn.recentNotes.length) {
    lines.push("", "Your notes on your recent moves:");
    for (const note of turn.recentNotes) lines.push(`- ${note.moveNumber}. ${note.san}: ${note.reasoning}`);
  }
  return lines.join("\n");
}

/** Turns model output into a decision, or explains why it can't. */
export function parseDecision(text: string): PlayerReply {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: "the reply was not a JSON object" };
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "the reply was not a JSON object" };
  }
  const obj = json as Record<string, unknown>;
  const action = obj.action;
  if (action !== "move" && action !== "resign" && action !== "accept_draw") {
    return { ok: false, error: '"action" must be "move", "resign" or "accept_draw"' };
  }
  const move = typeof obj.move === "string" ? obj.move : null;
  const decision: Decision = {
    action,
    move,
    offerDraw: obj.offer_draw === true,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning.trim() : "",
  };
  return { ok: true, decision };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) attempts.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
