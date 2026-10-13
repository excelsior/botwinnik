import { Chess, DEFAULT_POSITION } from "chess.js";
import {
  describeDuration,
  illegalMoveBonusMs,
  timeCategory,
  timeControlLabel,
  type TimeControl,
} from "../timeControl.js";
import { boardDiagram, hasOnlyKing, resolveMove } from "./moves.js";
import {
  colorName,
  FatalPlayerError,
  opponent,
  type Color,
  type GameEvent,
  type GameRecord,
  type MoveRecord,
  type Player,
  type PlayerReply,
  type PlayerSpec,
  type Termination,
  type TurnInfo,
} from "./types.js";

export interface NewGame {
  id: string;
  timeControl: TimeControl;
  white: PlayerSpec;
  black: PlayerSpec;
  colorsAssigned: "manual" | "random";
  startFen?: string;
}

export interface GameOptions {
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
  /** Waits between retries after an API error; resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called after every change to the record. */
  onUpdate?: (record: GameRecord) => void;
  /** Unreadable replies in one turn before they count as an illegal move. */
  maxInvalidReplies?: number;
  /** How many of its own previous explanations a player is shown. */
  notesInPrompt?: number;
}

export function createGameRecord(setup: NewGame): GameRecord {
  const startFen = setup.startFen ?? DEFAULT_POSITION;
  new Chess(startFen); // throws on an invalid FEN
  const tc = setup.timeControl;
  return {
    version: 1,
    id: setup.id,
    status: "running",
    createdAt: new Date().toISOString(),
    timeControl: {
      baseMs: tc.baseMs,
      incrementMs: tc.incrementMs,
      label: timeControlLabel(tc),
      category: timeCategory(tc),
      illegalMoveBonusMs: illegalMoveBonusMs(tc),
    },
    white: setup.white,
    black: setup.black,
    colorsAssigned: setup.colorsAssigned,
    startFen,
    moves: [],
    events: [],
    clocks: { white: tc.baseMs, black: tc.baseMs },
    illegalMoves: { white: 0, black: 0 },
    pendingDrawOffer: null,
    lastDrawOfferBy: null,
    result: "*",
    termination: null,
  };
}

class DeadlineError extends Error {}
class GameAbortedError extends Error {}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Runs one game between two players: asks the side to move for a decision,
 * enforces the clocks and the rules, and records everything in `record`.
 */
export class GameRunner {
  readonly record: GameRecord;
  private readonly chess: Chess;
  private readonly players: Record<Color, Player>;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly onUpdate: (record: GameRecord) => void;
  private readonly maxInvalidReplies: number;
  private readonly notesInPrompt: number;
  private readonly abortController = new AbortController();
  /** The turn in progress, so the clock can be stopped from outside (abort). */
  private turn: { color: Color; startedAt: number; clockAtStart: number } | null = null;

  constructor(record: GameRecord, players: Record<Color, Player>, options: GameOptions = {}) {
    this.record = record;
    this.players = players;
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.onUpdate = options.onUpdate ?? (() => {});
    this.maxInvalidReplies = options.maxInvalidReplies ?? 3;
    this.notesInPrompt = options.notesInPrompt ?? 3;
    this.chess = new Chess(record.startFen);
    for (const move of record.moves) this.chess.move(move.uci);
  }

  get sideToMove(): Color {
    return this.chess.turn() === "w" ? "white" : "black";
  }

  async run(): Promise<GameRecord> {
    try {
      while (this.record.status === "running") {
        await this.playTurn(this.sideToMove);
      }
    } catch (err) {
      if (this.record.status === "running") {
        this.end("aborted", {
          reason: "error",
          winner: null,
          message: `The game stopped because of an unexpected error: ${errorMessage(err)}`,
        });
      }
    }
    return this.record;
  }

  /** Stops a running game without a result. */
  abort(message = "Aborted by the admin."): void {
    if (this.record.status !== "running") return;
    this.end("aborted", { reason: "aborted", winner: null, message });
    this.abortController.abort();
  }

  private async playTurn(color: Color): Promise<void> {
    const player = this.players[color];
    const startedAt = this.now();
    const clockAtStart = this.record.clocks[color];
    this.turn = { color, startedAt, clockAtStart };
    this.record.turnStartedAt = new Date().toISOString();
    this.emit();

    const remaining = () => clockAtStart - (this.now() - startedAt);
    let feedback: string | undefined;
    let invalidReplies = 0;
    let apiFailures = 0;

    while (this.record.status === "running") {
      if (remaining() <= 0) return this.flag(color);

      let reply: PlayerReply;
      try {
        reply = await this.ask(player, this.turnInfo(color, remaining(), feedback), remaining());
      } catch (err) {
        if (this.record.status !== "running" || err instanceof GameAbortedError) return;
        if (err instanceof DeadlineError) return this.flag(color);
        if (err instanceof FatalPlayerError) {
          this.end("aborted", {
            reason: "error",
            winner: null,
            message: `${colorName(color)} (${player.spec.model}) failed: ${err.message}`,
          });
          return;
        }
        apiFailures++;
        this.addEvent({
          type: "api_error",
          color,
          message: `API error, retrying on ${colorName(color)}'s clock: ${errorMessage(err)}`,
        });
        const delay = Math.min(1000 * 2 ** (apiFailures - 1), 15_000);
        await this.sleep(Math.max(0, Math.min(delay, remaining())), this.abortController.signal);
        continue;
      }

      if (remaining() <= 0) return this.flag(color);

      const rejectReply = (reason: string): boolean => {
        invalidReplies++;
        this.addEvent({ type: "invalid_response", color, message: `Unusable reply: ${reason}` });
        if (invalidReplies < this.maxInvalidReplies) {
          feedback = `Your previous reply could not be used: ${reason}. Reply again with a JSON object as described.`;
          return false;
        }
        invalidReplies = 0;
        const ended = this.illegalMove(color, null, `${this.maxInvalidReplies} unusable replies in a row`);
        feedback = this.illegalFeedback(color, `You sent ${this.maxInvalidReplies} unusable replies in a row, which counts as an illegal move (last problem: ${reason})`);
        return ended;
      };

      if (!reply.ok) {
        if (rejectReply(reply.error)) return;
        continue;
      }

      const decision = reply.decision;
      if (decision.action === "resign") {
        this.addEvent({
          type: "resignation",
          color,
          message: `${colorName(color)} resigns.`,
          reasoning: decision.reasoning || undefined,
        });
        this.stopClock();
        this.end("finished", {
          reason: "resignation",
          winner: opponent(color),
          message: `${colorName(opponent(color))} wins: ${colorName(color)} resigned.`,
        });
        return;
      }

      if (decision.action === "accept_draw") {
        if (this.record.pendingDrawOffer !== opponent(color)) {
          if (rejectReply("there is no draw offer to accept; make a move instead")) return;
          continue;
        }
        this.addEvent({
          type: "draw_accepted",
          color,
          message: `${colorName(color)} accepts the draw offer.`,
          reasoning: decision.reasoning || undefined,
        });
        this.stopClock();
        this.end("finished", { reason: "agreement", winner: null, message: "Draw by agreement." });
        return;
      }

      const moveText = decision.move?.trim();
      if (!moveText) {
        if (rejectReply('"action" was "move" but "move" was empty')) return;
        continue;
      }

      const move = resolveMove(this.chess.fen(), moveText);
      if (!move) {
        if (this.illegalMove(color, moveText, `"${moveText}" is not a legal move`, decision.reasoning)) return;
        invalidReplies = 0;
        feedback = this.illegalFeedback(color, `"${moveText}" is not a legal move in this position`);
        continue;
      }

      this.playMove(color, move.lan, decision.offerDraw, decision.reasoning);
      return;
    }
  }

  private playMove(color: Color, uci: string, offerDraw: boolean, reasoning: string): void {
    const turn = this.turn!;
    const spent = this.now() - turn.startedAt;
    const move = this.chess.move(uci);

    if (this.record.pendingDrawOffer === opponent(color)) {
      this.addEvent({ type: "draw_declined", color, message: `${colorName(color)} declines the draw offer by playing on.` });
    }
    this.record.pendingDrawOffer = null;
    this.record.clocks[color] = turn.clockAtStart - spent + this.record.timeControl.incrementMs;
    this.turn = null;

    let drawOffered = false;
    if (offerDraw) {
      if (this.record.lastDrawOfferBy === color) {
        this.addEvent({
          type: "draw_offer_not_allowed",
          color,
          message: `${colorName(color)}'s draw offer was ignored: they offered last, and ${colorName(opponent(color))} has not offered since.`,
        });
      } else {
        drawOffered = true;
        this.record.pendingDrawOffer = color;
        this.record.lastDrawOfferBy = color;
      }
    }

    this.record.moves.push({
      ply: this.record.moves.length + 1,
      color,
      san: move.san,
      uci: move.lan,
      fenAfter: this.chess.fen(),
      reasoning: reasoning.trim().slice(0, 4000),
      thinkingMs: Math.round(spent),
      clockMs: Math.round(this.record.clocks[color]),
      drawOffered,
      at: new Date().toISOString(),
    });

    const over = this.positionalResult(color);
    if (over) this.end("finished", over);
    else this.emit();
  }

  /** Game-ending conditions after `mover` has moved. */
  private positionalResult(mover: Color): Termination | null {
    const c = this.chess;
    if (c.isCheckmate()) {
      return { reason: "checkmate", winner: mover, message: `${colorName(mover)} wins by checkmate.` };
    }
    if (c.isStalemate()) return { reason: "stalemate", winner: null, message: "Draw by stalemate." };
    if (c.isInsufficientMaterial()) {
      return { reason: "insufficient_material", winner: null, message: "Draw: neither side has enough material to checkmate." };
    }
    if (c.isThreefoldRepetition()) {
      return { reason: "threefold_repetition", winner: null, message: "Draw by threefold repetition." };
    }
    if (c.isDrawByFiftyMoves()) {
      return { reason: "fifty_moves", winner: null, message: "Draw by the fifty-move rule." };
    }
    return null;
  }

  /** Records an illegal move. Returns true if it ended the game. */
  private illegalMove(color: Color, attempted: string | null, what: string, reasoning?: string): boolean {
    const opp = opponent(color);
    const count = ++this.record.illegalMoves[color];
    if (count >= 2) {
      this.addEvent({
        type: "illegal_move",
        color,
        message: `${colorName(color)}'s second illegal move: ${what}.`,
        attempted: attempted ?? undefined,
        reasoning: reasoning || undefined,
      });
      this.stopClock();
      this.end("finished", {
        reason: "illegal_moves",
        winner: opp,
        message: `${colorName(opp)} wins: ${colorName(color)} made a second illegal move.`,
      });
      return true;
    }
    const bonus = this.record.timeControl.illegalMoveBonusMs;
    this.record.clocks[opp] += bonus;
    this.addEvent({
      type: "illegal_move",
      color,
      message: `Illegal move by ${colorName(color)}: ${what}. ${colorName(opp)} gets ${describeDuration(bonus)} extra.`,
      attempted: attempted ?? undefined,
      reasoning: reasoning || undefined,
      bonusMs: bonus,
    });
    return false;
  }

  private illegalFeedback(color: Color, what: string): string {
    const bonus = describeDuration(this.record.timeControl.illegalMoveBonusMs);
    return `${what}. Your opponent received ${bonus} of extra time, and another illegal move by you loses the game. Your clock is still running; choose a legal move.`;
  }

  private flag(color: Color): void {
    const opp = opponent(color);
    this.turn = null;
    this.record.clocks[color] = 0;
    const oppSide = opp === "white" ? "w" : "b";
    if (hasOnlyKing(this.chess, oppSide)) {
      this.end("finished", {
        reason: "timeout_vs_insufficient_material",
        winner: null,
        message: `Draw: ${colorName(color)} ran out of time, but ${colorName(opp)} has only a king left.`,
      });
    } else {
      this.end("finished", {
        reason: "timeout",
        winner: opp,
        message: `${colorName(opp)} wins on time.`,
      });
    }
  }

  /** Freezes the running clock at its current value. */
  private stopClock(): void {
    if (!this.turn) return;
    const { color, startedAt, clockAtStart } = this.turn;
    this.record.clocks[color] = Math.max(0, Math.round(clockAtStart - (this.now() - startedAt)));
    this.turn = null;
  }

  private end(status: "finished" | "aborted", termination: Termination): void {
    this.stopClock();
    this.record.status = status;
    this.record.termination = termination;
    this.record.result =
      status === "aborted" ? "*" : termination.winner === "white" ? "1-0" : termination.winner === "black" ? "0-1" : "1/2-1/2";
    this.record.finishedAt = new Date().toISOString();
    delete this.record.turnStartedAt;
    this.emit();
  }

  private addEvent(event: Omit<GameEvent, "ply" | "at">): void {
    this.record.events.push({ ...event, ply: this.record.moves.length, at: new Date().toISOString() });
    this.emit();
  }

  private emit(): void {
    try {
      this.onUpdate(this.record);
    } catch (err) {
      console.error("Game update listener failed:", err);
    }
  }

  private turnInfo(color: Color, remainingMs: number, feedback: string | undefined): TurnInfo {
    const own = this.record.moves.filter((m) => m.color === color && m.reasoning);
    return {
      color,
      fen: this.chess.fen(),
      board: boardDiagram(this.chess),
      history: this.record.moves.map((m) => m.san),
      startFen: this.record.startFen,
      moveNumber: this.chess.moveNumber(),
      timeControl: this.record.timeControl,
      myClockMs: Math.max(0, remainingMs),
      opponentClockMs: this.record.clocks[opponent(color)],
      drawOffered: this.record.pendingDrawOffer === opponent(color),
      canOfferDraw: this.record.lastDrawOfferBy !== color,
      illegalMovesSoFar: this.record.illegalMoves[color],
      recentNotes: own.slice(-this.notesInPrompt).map((m) => ({
        moveNumber: moveNumberOf(m),
        san: m.san,
        reasoning: m.reasoning,
      })),
      feedback,
    };
  }

  /** Asks the player, giving up when its clock runs out or the game is aborted. */
  private async ask(player: Player, turn: TurnInfo, remainingMs: number): Promise<PlayerReply> {
    const controller = new AbortController();
    const gameSignal = this.abortController.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onGameAbort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeadlineError("Out of time"));
        controller.abort();
      }, Math.max(0, remainingMs));
      onGameAbort = () => {
        reject(new GameAbortedError("Game aborted"));
        controller.abort();
      };
      if (gameSignal.aborted) onGameAbort();
      else gameSignal.addEventListener("abort", onGameAbort, { once: true });
    });
    try {
      return await Promise.race([player.decide(turn, controller.signal), stop]);
    } finally {
      clearTimeout(timer);
      if (onGameAbort) gameSignal.removeEventListener("abort", onGameAbort);
    }
  }
}

/** The full-move number a move was played on, read from the FEN after it. */
export function moveNumberOf(move: MoveRecord): number {
  const fullmove = Number(move.fenAfter.split(" ")[5]);
  return move.color === "white" ? fullmove : fullmove - 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
