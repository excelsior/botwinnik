import { Chess, DEFAULT_POSITION } from "chess.js";
import { inferProvider, PROVIDERS, type Provider } from "../config.js";
import { addSpend, emptySpend, type Spend } from "../pricing.js";
import { illegalMoveBonusMs, timeCategory, timeControlLabel, type TimeControl } from "../timeControl.js";
import { positionalResult } from "./game.js";
import { resolveMove } from "./moves.js";
import {
  COLORS,
  colorName,
  type Color,
  type GameEvent,
  type GameEventType,
  type GameRecord,
  type GameResult,
  type MoveRecord,
  type Termination,
  type TerminationReason,
} from "./types.js";

/** A PGN that can't be turned into a game; the message says what to fix. */
export class PgnImportError extends Error {}

interface RawMove {
  token: string;
  comments: string[];
}

interface RawGame {
  tags: Record<string, string>;
  /** Comments before the first move. */
  leadingComments: string[];
  moves: RawMove[];
  result?: string;
}

/**
 * Splits PGN text into games: tag pairs, moves and the comments after each
 * move. Variations, NAGs and move numbers are skipped.
 */
export function readPgn(text: string): RawGame[] {
  const games: RawGame[] = [];
  let game: RawGame | undefined;
  let inMovetext = false;
  const startGame = () => {
    game = { tags: {}, leadingComments: [], moves: [] };
    games.push(game);
    inMovetext = false;
    return game;
  };
  const current = () => game ?? startGame();
  const addComment = (body: string) => {
    const g = current();
    (g.moves.at(-1)?.comments ?? g.leadingComments).push(body);
  };
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  const tagPattern = /\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/y;

  let depth = 0; // inside a variation
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "%" && (i === 0 || text[i - 1] === "\n")) {
      i = lineEnd(i); // escape line
    } else if (/\s/.test(ch) || ch === "\uFEFF") {
      i++;
    } else if (ch === "{") {
      const end = text.indexOf("}", i + 1);
      const close = end === -1 ? text.length : end;
      if (depth === 0) addComment(text.slice(i + 1, close));
      i = close + 1;
    } else if (ch === ";") {
      const end = lineEnd(i);
      if (depth === 0) addComment(text.slice(i + 1, end));
      i = end;
    } else if (ch === "(") {
      depth++;
      i++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (ch === "[" && depth === 0) {
      tagPattern.lastIndex = i;
      const match = tagPattern.exec(text);
      if (!match) throw new PgnImportError(`Can't read the tag at "${text.slice(i, i + 40).split("\n")[0]}".`);
      if (inMovetext) startGame(); // tags after moves begin the next game
      current().tags[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
      i = tagPattern.lastIndex;
    } else {
      let end = i;
      while (end < text.length && !/[\s{}();[\]]/.test(text[end])) end++;
      if (end === i) end++; // a stray "]"
      const token = text.slice(i, end);
      i = end;
      if (depth > 0) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) {
        current().result = token;
        game = undefined;
        continue;
      }
      inMovetext = true;
      const san = token.replace(/^\d+\.*/, "").replace(/^\.+/, "").replace(/[!?]+$/, "");
      if (!san || /^\$\d+$/.test(san) || san === "]") continue;
      current().moves.push({ token: san, comments: [] });
    }
  }
  return games.filter((g) => g.moves.length || Object.keys(g.tags).length);
}

const EVENT_TYPES: readonly GameEventType[] = [
  "illegal_move",
  "invalid_response",
  "draw_offer",
  "draw_offer_not_allowed",
  "draw_declined",
  "draw_accepted",
  "resignation",
  "api_error",
  "paused",
  "resumed",
];

const TERMINATION_REASONS: readonly TerminationReason[] = [
  "checkmate",
  "resignation",
  "timeout",
  "illegal_moves",
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_moves",
  "agreement",
  "timeout_vs_insufficient_material",
  "aborted",
  "error",
];

/** What one move's comment says, read from the [%...] commands that toPgn writes. */
interface CommentData {
  clockMs?: number;
  thinkingMs?: number;
  spend?: Spend;
  reasoning: string;
  drawOffered: boolean;
  events: Omit<GameEvent, "ply" | "at">[];
  termination?: Termination;
}

const COMMAND = /\[%(\w+)((?:[^\]"]|"(?:[^"\\]|\\.)*")*)\]/g;

/**
 * Reads a comment: [%clk], [%emt] and [%spend] describe the move, the text
 * after them is the reasoning, and [%draw], [%event], [%reasoning] and [%end]
 * start sections of their own. Other commands ([%eval], [%csl]...) are dropped.
 */
export function readComment(text: string): CommentData {
  const data: CommentData = { reasoning: "", drawOffered: false, events: [] };
  type Target = { kind: "move" } | { kind: "ignore" } | { kind: "event"; event: CommentData["events"][number]; field: "message" | "reasoning" } | { kind: "end"; termination: Termination };
  let target: Target = { kind: "move" };
  const append = (chunk: string) => {
    if (target.kind === "move") data.reasoning += chunk;
    else if (target.kind === "event") target.event[target.field] = (target.event[target.field] ?? "") + chunk;
    else if (target.kind === "end") target.termination.message += chunk;
  };

  const clean = text.replace(/\s+/g, " ");
  let pos = 0;
  for (const match of clean.matchAll(COMMAND)) {
    append(clean.slice(pos, match.index));
    pos = match.index + match[0].length;
    const name = match[1].toLowerCase();
    const args = commandArgs(match[2]);
    if (name === "clk") data.clockMs = parseClock(args.positional[0]) ?? data.clockMs;
    else if (name === "emt") data.thinkingMs = parseClock(args.positional[0]) ?? data.thinkingMs;
    else if (name === "spend") data.spend = parseSpend(match[2]) ?? data.spend;
    else if (name === "draw") {
      data.drawOffered = true;
      target = { kind: "ignore" }; // followed by "White offers a draw."
    } else if (name === "event") {
      const [type, color] = args.positional as [GameEventType, Color];
      if (!EVENT_TYPES.includes(type) || !COLORS.includes(color)) {
        target = { kind: "ignore" };
        continue;
      }
      const event: CommentData["events"][number] = { type, color, message: "" };
      const bonus = Number(args.named.bonus);
      if (args.named.bonus && Number.isFinite(bonus)) event.bonusMs = bonus;
      if (args.named.sent !== undefined) event.attempted = args.named.sent;
      data.events.push(event);
      target = { kind: "event", event, field: "message" };
    } else if (name === "reasoning") {
      const current = target as Target;
      if (current.kind === "event") target = { kind: "event", event: current.event, field: "reasoning" };
    } else if (name === "end") {
      const [reason, winner] = args.positional;
      if (!TERMINATION_REASONS.includes(reason as TerminationReason)) {
        target = { kind: "ignore" };
        continue;
      }
      data.termination = {
        reason: reason as TerminationReason,
        winner: COLORS.includes(winner as Color) ? (winner as Color) : null,
        message: "",
      };
      target = { kind: "end", termination: data.termination };
    }
  }
  append(clean.slice(pos));

  data.reasoning = data.reasoning.trim();
  for (const event of data.events) {
    event.message = event.message.trim();
    if (event.reasoning !== undefined) event.reasoning = event.reasoning.trim() || undefined;
  }
  if (data.termination) data.termination.message = data.termination.message.trim();
  return data;
}

function commandArgs(text: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  const unquote = (v: string) => {
    if (!v.startsWith('"')) return v;
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  };
  for (const m of text.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)|("(?:[^"\\]|\\.)*"|\S+)/g)) {
    if (m[1]) named[m[1]] = unquote(m[2]);
    else positional.push(unquote(m[3]));
  }
  return { positional, named };
}

/** "H:MM:SS", "H:MM:SS.s" or "M:SS" to milliseconds. */
export function parseClock(text: string | undefined): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text?.trim() ?? "");
  if (!m) return undefined;
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
}

/** Reads formatSpend's "usd=0.0123 calls=2 in=1500 cached=0 out=420". */
export function parseSpend(text: string | undefined): Spend | undefined {
  if (!text) return undefined;
  const fields: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S+)/g)) fields[m[1]] = m[2];
  const count = (key: string) => {
    const n = Number(fields[key]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  if (fields.usd === undefined && fields.calls === undefined) return undefined;
  const usd = Number(fields.usd);
  return {
    calls: count("calls"),
    inputTokens: count("in"),
    cachedInputTokens: count("cached"),
    outputTokens: count("out"),
    costUsd: fields.usd === "?" || !Number.isFinite(usd) ? null : usd,
  };
}

/** PGN TimeControl "300+3" or "600" (seconds); other forms aren't supported. */
function parsePgnTimeControl(text: string | undefined): TimeControl | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?\s*$/.exec(text ?? "");
  if (!m || Number(m[1]) <= 0) return undefined;
  return { baseMs: Math.round(Number(m[1]) * 1000), incrementMs: Math.round(Number(m[2] ?? 0) * 1000) };
}

function player(tags: Record<string, string>, color: Color): { provider: Provider; model: string } {
  const side = colorName(color);
  const model = (tags[side] ?? "").trim();
  if (!model || model === "?") throw new PgnImportError(`The PGN doesn't name ${side}'s model (the ${side} tag).`);
  const given = tags[`${side}Provider`]?.trim().toLowerCase();
  const provider = PROVIDERS.find((p) => p === given) ?? inferProvider(model);
  if (!provider) {
    throw new PgnImportError(
      `Can't tell whether ${side} ("${model}") is a Claude or a ChatGPT model. Add [${side}Provider "anthropic"] or [${side}Provider "openai"] to the PGN.`,
    );
  }
  return { provider, model };
}

function createdAt(tags: Record<string, string>, fallback: Date): string {
  const d = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(tags.Date ?? "");
  if (!d) return fallback.toISOString();
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(tags.UTCTime ?? "") ?? [null, "00", "00", "00"];
  const date = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3])));
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function resultOf(termination: Termination): GameResult {
  return termination.winner === "white" ? "1-0" : termination.winner === "black" ? "0-1" : "1/2-1/2";
}

/** A reason for a result the PGN doesn't explain, from the final position or the Termination tag. */
function guessTermination(result: GameResult, chess: Chess, lastMover: Color | undefined, tag: string | undefined): Termination {
  const positional = lastMover ? positionalResult(chess, lastMover) : null;
  const winner: Color | null = result === "1-0" ? "white" : result === "0-1" ? "black" : null;
  if (positional && positional.winner === winner) return positional;
  if (/time forfeit/i.test(tag ?? "")) {
    return winner
      ? { reason: "timeout", winner, message: `${colorName(winner)} wins on time.` }
      : { reason: "timeout_vs_insufficient_material", winner: null, message: "Draw on time." };
  }
  if (winner && /rules infraction/i.test(tag ?? "")) {
    return { reason: "illegal_moves", winner, message: `${colorName(winner)} wins: the opponent broke the rules.` };
  }
  return winner
    ? { reason: "resignation", winner, message: `${colorName(winner)} wins (the PGN doesn't say how).` }
    : { reason: "agreement", winner: null, message: "Draw (the PGN doesn't say how)." };
}

/**
 * Builds a saved game from a PGN. Botwinnik's own exports come back as they
 * were; for other PGNs the players' providers are inferred from the model
 * names. A game without a result is restored as paused so it can be resumed,
 * unless its final position already ends it.
 *
 * `chooseId` gets the PGN's GameId tag (if any) and returns the id to use.
 */
export function importPgn(text: string, chooseId: (gameId: string | undefined) => string, now = new Date()): GameRecord {
  const games = readPgn(text);
  if (games.length === 0) throw new PgnImportError("No game found in the PGN.");
  if (games.length > 1) throw new PgnImportError(`The PGN holds ${games.length} games. Import them one at a time.`);
  const [raw] = games;
  const tags = raw.tags;

  const white = player(tags, "white");
  const black = player(tags, "black");
  const tc = parsePgnTimeControl(tags.TimeControl);
  if (!tc) {
    throw new PgnImportError(
      `The PGN has no time control Botwinnik can use (TimeControl tag: "${tags.TimeControl ?? ""}"). Add one in seconds, like [TimeControl "300+3"].`,
    );
  }

  const startFen = tags.FEN?.trim() || DEFAULT_POSITION;
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch (err) {
    throw new PgnImportError(`The FEN tag isn't a valid position: ${err instanceof Error ? err.message : String(err)}`);
  }

  const created = createdAt(tags, now);
  const lead = readComment(raw.leadingComments.join(" "));
  const events: GameEvent[] = lead.events.map((e) => ({ ...e, ply: 0, at: created }));
  let termination = lead.termination;
  const moves: MoveRecord[] = [];
  const lastClock: Record<Color, number> = { white: tc.baseMs, black: tc.baseMs };
  const movedSpend: Record<Color, Spend> = { white: emptySpend(), black: emptySpend() };
  let elapsed = 0;

  for (const rawMove of raw.moves) {
    const color: Color = chess.turn() === "w" ? "white" : "black";
    const label = `${chess.moveNumber()}${color === "white" ? "." : "..."} ${rawMove.token}`;
    if (termination) throw new PgnImportError(`The game had already ended before ${label}.`);
    const move = resolveMove(chess.fen(), rawMove.token);
    if (!move) throw new PgnImportError(`${label} isn't a legal move in that position.`);
    chess.move(move.lan);
    const note = readComment(rawMove.comments.join(" "));
    const ply = moves.length + 1;
    const thinkingMs = note.thinkingMs ?? 0;
    elapsed += thinkingMs;
    const at = new Date(Date.parse(created) + elapsed).toISOString();
    const spend = note.spend ?? emptySpend();
    movedSpend[color] = addSpend(movedSpend[color], spend);
    lastClock[color] = note.clockMs ?? lastClock[color];
    moves.push({
      ply,
      color,
      san: move.san,
      uci: move.lan,
      fenAfter: chess.fen(),
      reasoning: note.reasoning.slice(0, 4000),
      thinkingMs,
      clockMs: lastClock[color],
      drawOffered: note.drawOffered,
      spend,
      at,
    });
    for (const e of note.events) events.push({ ...e, ply, at });
    termination = note.termination;
  }

  const lastMove = moves.at(-1);
  const result: GameResult = (["1-0", "0-1", "1/2-1/2"] as const).find((r) => r === raw.result || r === tags.Result) ?? "*";
  let status: GameRecord["status"];
  if (result !== "*") {
    status = "finished";
    termination ??= guessTermination(result, chess, lastMove?.color, tags.Termination);
  } else if (termination?.reason === "aborted" || termination?.reason === "error" || /abandoned/i.test(tags.Termination ?? "")) {
    status = "aborted";
    termination ??= { reason: "aborted", winner: null, message: "Aborted." };
  } else {
    // Unfinished: resumable, unless the final position already decides the game.
    const over = lastMove ? positionalResult(chess, lastMove.color) : null;
    status = over ? "finished" : "paused";
    termination = over ?? undefined;
  }

  const clocks: Record<Color, number> = {
    white: parseClock(tags.WhiteClock) ?? lastClock.white,
    black: parseClock(tags.BlackClock) ?? lastClock.black,
  };
  const spend: Record<Color, Spend> = {
    white: parseSpend(tags.WhiteSpend) ?? movedSpend.white,
    black: parseSpend(tags.BlackSpend) ?? movedSpend.black,
  };
  const illegalMoves: Record<Color, number> = {
    white: events.filter((e) => e.type === "illegal_move" && e.color === "white").length,
    black: events.filter((e) => e.type === "illegal_move" && e.color === "black").length,
  };
  const lastOffer = moves.filter((m) => m.drawOffered).at(-1);

  const record: GameRecord = {
    version: 1,
    id: chooseId(tags.GameId?.trim() || undefined),
    status,
    createdAt: created,
    timeControl: {
      baseMs: tc.baseMs,
      incrementMs: tc.incrementMs,
      label: timeControlLabel(tc),
      category: timeCategory(tc),
      illegalMoveBonusMs: illegalMoveBonusMs(tc),
    },
    white,
    black,
    colorsAssigned: tags.ColorsAssigned === "random" ? "random" : "manual",
    startFen,
    moves,
    events,
    clocks,
    illegalMoves,
    spend,
    pendingDrawOffer: status === "paused" && lastMove?.drawOffered ? lastMove.color : null,
    lastDrawOfferBy: lastOffer?.color ?? null,
    result: status !== "finished" ? "*" : result !== "*" ? result : resultOf(termination!),
    termination: termination ?? null,
  };
  if (status === "finished" || status === "aborted") record.finishedAt = now.toISOString();
  return record;
}
