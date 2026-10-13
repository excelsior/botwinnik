import { DEFAULT_POSITION } from "chess.js";
import type { Spend } from "../pricing.js";
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
 * move ([%clk]), the time spent on it ([%emt]), what it cost ([%spend]) and
 * the player's reasoning; illegal moves, draw offers and other events appear
 * as comments where they happened. The extra tags and [%...] commands carry
 * everything importPgn needs to restore the game, so a paused game can be
 * exported, imported elsewhere and resumed.
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
    ["GameStatus", game.status],
    ["ColorsAssigned", game.colorsAssigned],
    ["WhiteProvider", game.white.provider],
    ["BlackProvider", game.black.provider],
    ["WhiteClock", preciseClock(game.clocks.white)],
    ["BlackClock", preciseClock(game.clocks.black)],
    ["WhiteSpend", formatSpend(game.spend.white)],
    ["BlackSpend", formatSpend(game.spend.black)],
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
    for (const event of game.events) if (event.ply === ply) addComment(eventComment(event));
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
  if (game.termination) {
    const { reason, winner, message } = game.termination;
    addComment(`[%end ${reason} ${winner ?? "none"}] ${freeText(message)}`);
  }
  flushComment();
  tokens.push(game.result);

  const header = tags.map(([k, v]) => `[${k} "${escapeTag(v)}"]`).join("\n");
  // Keep each [%...] command on one line.
  const glued = tokens.join(" ").replace(/\[%[^\]]*\]/g, (command) => command.replace(/ /g, "\u0000"));
  return `${header}\n\n${wrap(glued, 80).replace(/\u0000/g, " ")}\n`;
}

function moveComment(move: MoveRecord): string {
  const parts = [`[%clk ${moveClock(move.clockMs)}]`, `[%emt ${pgnDuration(move.thinkingMs)}]`];
  if (move.spend?.calls) parts.push(`[%spend ${formatSpend(move.spend)}]`);
  if (move.reasoning) parts.push(freeText(move.reasoning));
  if (move.drawOffered) parts.push(`[%draw offer] ${colorName(move.color)} offers a draw.`);
  return parts.join(" ");
}

function eventComment(event: GameEvent): string {
  const args: string[] = [event.type, event.color];
  if (event.bonusMs) args.push(`bonus=${event.bonusMs}`);
  if (event.attempted !== undefined) args.push(`sent=${commandString(event.attempted)}`);
  const text = `[%event ${args.join(" ")}] ${freeText(event.message)}`;
  return event.reasoning ? `${text} [%reasoning] ${freeText(event.reasoning)}` : text;
}

/** Text outside the [%...] commands can't start a command of its own. */
function freeText(text: string): string {
  return text.replace(/\[%/g, "[ %");
}

/** A string argument of a [%...] command: JSON, with the characters that end a comment or command escaped. */
export function commandString(text: string): string {
  return JSON.stringify(text).replace(/[{}[\]]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** "usd=0.0123 calls=2 in=1500 cached=0 out=420"; usd=? when the price is unknown. */
export function formatSpend(spend: Spend): string {
  const usd = spend.costUsd === null ? "?" : String(Number(spend.costUsd.toFixed(8)));
  return `usd=${usd} calls=${spend.calls} in=${spend.inputTokens} cached=${spend.cachedInputTokens} out=${spend.outputTokens}`;
}

/** Clock with milliseconds, "0:04:12.345". */
export function preciseClock(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  return `${pgnClock(clamped)}.${String(clamped % 1000).padStart(3, "0")}`;
}

/** Clock for [%clk]: whole seconds, with tenths when there are any ("0:04:59", "0:00:07.3"). */
function moveClock(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const seconds = pgnClock(Math.floor(tenths / 10) * 1000);
  return tenths % 10 ? `${seconds}.${tenths % 10}` : seconds;
}

/** Elapsed time to a tenth of a second, "0:00:05.2". */
export function pgnDuration(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  return `${pgnClock(Math.floor(tenths / 10) * 1000)}.${tenths % 10}`;
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
    // A line starting with "%" is an escape line that PGN readers skip.
    if (line && line.length + 1 + word.length > width && !word.startsWith("%")) {
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
