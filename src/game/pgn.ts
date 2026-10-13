import { DEFAULT_POSITION } from "chess.js";
import { pgnClock, pgnTimeControl } from "../timeControl.js";
import { moveNumberOf } from "./game.js";
import { colorName, type GameEvent, type GameRecord, type MoveRecord } from "./types.js";

const PGN_TERMINATION: Record<string, string> = {
  timeout: "time forfeit",
  timeout_vs_insufficient_material: "time forfeit",
  illegal_moves: "rules infraction",
  aborted: "abandoned",
  error: "abandoned",
};

/**
 * Exports a game as PGN. Each move carries a comment with the clock after the
 * move ([%clk]) and the player's reasoning; illegal moves, draw offers and
 * other events appear as comments where they happened.
 */
export function toPgn(game: GameRecord): string {
  const date = new Date(game.createdAt);
  const tags: [string, string][] = [
    ["Event", "Botwinnik AI match"],
    ["Site", "Botwinnik"],
    ["Date", `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`],
    ["Round", "-"],
    ["White", game.white.model],
    ["Black", game.black.model],
    ["Result", game.result],
    ["WhiteType", "program"],
    ["BlackType", "program"],
    ["TimeControl", pgnTimeControl(game.timeControl)],
    ["Termination", PGN_TERMINATION[game.termination?.reason ?? ""] ?? (game.status === "running" || game.status === "paused" ? "unterminated" : "normal")],
    ["PlyCount", String(game.moves.length)],
    ["UTCTime", `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`],
    ["GameId", game.id],
  ];
  if (game.startFen !== DEFAULT_POSITION) tags.push(["SetUp", "1"], ["FEN", game.startFen]);

  // Movetext tokens; consecutive comments are merged because some parsers reject "{a} {b}".
  const tokens: string[] = [];
  let pendingComment: string[] = [];
  const addComment = (text: string) => {
    if (text) pendingComment.push(text);
  };
  const flushComment = () => {
    if (pendingComment.length) tokens.push(comment(pendingComment.join(" ")));
    pendingComment = [];
  };
  const addEvents = (ply: number) => {
    for (const event of game.events) if (event.ply === ply) addComment(describeEvent(event));
  };

  addEvents(0);
  for (const move of game.moves) {
    flushComment();
    // Every move carries a comment, so Black's moves always need their own "N..." number.
    if (move.color === "white" || tokens.length === 0 || tokens[tokens.length - 1].startsWith("{")) {
      tokens.push(move.color === "white" ? `${moveNumberOf(move)}.` : `${moveNumberOf(move)}...`);
    }
    tokens.push(move.san);
    addComment(moveComment(move));
    addEvents(move.ply);
  }
  if (game.termination) addComment(game.termination.message);
  flushComment();
  tokens.push(game.result);

  const header = tags.map(([k, v]) => `[${k} "${escapeTag(v)}"]`).join("\n");
  return `${header}\n\n${wrap(tokens.join(" "), 80)}\n`;
}

function moveComment(move: MoveRecord): string {
  const parts = [`[%clk ${pgnClock(move.clockMs)}]`];
  if (move.reasoning) parts.push(move.reasoning);
  if (move.drawOffered) parts.push(`${colorName(move.color)} offers a draw.`);
  return parts.join(" ");
}

function describeEvent(event: GameEvent): string {
  if (event.type === "illegal_move" || event.type === "resignation" || event.type === "draw_accepted") {
    return event.reasoning ? `${event.message} Reasoning: ${event.reasoning}` : event.message;
  }
  return event.message;
}

/** PGN comments end at "}", so braces inside the text are swapped for parentheses. */
function comment(text: string): string {
  const clean = text.replace(/[{]/g, "(").replace(/[}]/g, ")").replace(/\s+/g, " ").trim();
  return `{${clean}}`;
}

function escapeTag(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
