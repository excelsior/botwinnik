import type { Provider } from "../config.js";
import type { Spend } from "../pricing.js";
import type { TimeCategory } from "../timeControl.js";

export type Color = "white" | "black";
export const COLORS: readonly Color[] = ["white", "black"];

export function opponent(color: Color): Color {
  return color === "white" ? "black" : "white";
}

export function colorName(color: Color): string {
  return color === "white" ? "White" : "Black";
}

export interface PlayerSpec {
  provider: Provider;
  model: string;
}

export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";

export type TerminationReason =
  | "checkmate"
  | "resignation"
  | "timeout"
  | "illegal_moves"
  | "stalemate"
  | "insufficient_material"
  | "threefold_repetition"
  | "fifty_moves"
  | "agreement"
  | "timeout_vs_insufficient_material"
  | "aborted"
  | "error";

export interface Termination {
  reason: TerminationReason;
  winner: Color | null;
  message: string;
}

export interface MoveRecord {
  /** 1-based half-move number. */
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenAfter: string;
  /** The player's own explanation of the move. */
  reasoning: string;
  /** Time spent on this turn, including any rejected attempts. */
  thinkingMs: number;
  /** Clock after the move, increment included. */
  clockMs: number;
  drawOffered: boolean;
  /** Tokens and money spent on this turn, including rejected attempts. */
  spend: Spend;
  at: string;
}

export type GameEventType =
  | "illegal_move"
  | "invalid_response"
  | "draw_offer"
  | "draw_offer_not_allowed"
  | "draw_declined"
  | "draw_accepted"
  | "resignation"
  | "api_error"
  | "paused"
  | "resumed";

export interface GameEvent {
  type: GameEventType;
  color: Color;
  /** Number of moves already played when this happened. */
  ply: number;
  message: string;
  /** The move text the player sent, for illegal moves. */
  attempted?: string;
  /** The player's explanation, when one came with the event. */
  reasoning?: string;
  /** Extra time given to the opponent. */
  bonusMs?: number;
  at: string;
}

/** "paused": stopped with the clocks frozen (an API account ran out of funds, or the app stopped) until resumed. */
export type GameStatus = "running" | "paused" | "finished" | "aborted";

export interface GameRecord {
  version: 1;
  id: string;
  status: GameStatus;
  createdAt: string;
  finishedAt?: string;
  timeControl: {
    baseMs: number;
    incrementMs: number;
    label: string;
    category: TimeCategory;
    illegalMoveBonusMs: number;
  };
  white: PlayerSpec;
  black: PlayerSpec;
  /** Whether the admin picked the colors or they were drawn at random. */
  colorsAssigned: "manual" | "random";
  startFen: string;
  moves: MoveRecord[];
  events: GameEvent[];
  /** Remaining time at the start of the current turn (or at the end of the game). */
  clocks: Record<Color, number>;
  /** When the current turn started; absent once the game is over. */
  turnStartedAt?: string;
  illegalMoves: Record<Color, number>;
  /** Everything each player's API calls used and cost, including turns that ended without a move. */
  spend: Record<Color, Spend>;
  /**
   * Set while the call the game stopped waiting for (the player ran out of
   * time, or the game was aborted) is still running; its cost is added to
   * `spend` when it finishes.
   */
  unfinishedCall?: Color;
  /** A draw offer the side to move can accept. */
  pendingDrawOffer: Color | null;
  /** Who made the most recent draw offer; that side can't offer again until the other side does. */
  lastDrawOfferBy: Color | null;
  result: GameResult;
  termination: Termination | null;
  /** Set for a game played in a tournament. */
  tournament?: TournamentGame;
  /**
   * The reasoning effort each player's requests go out with (null: the
   * model's own default), the one it asks for first until it has replied.
   * Absent for players without one, and for games from before it was kept.
   */
  effort?: Partial<Record<Color, string | null>>;
}

/** The tournament a game belongs to. */
export interface TournamentGame {
  id: string;
  name: string;
  /** 1-based. */
  round: number;
}

/** What a player decided to do on its turn. */
export interface Decision {
  action: "move" | "resign" | "accept_draw";
  move: string | null;
  offerDraw: boolean;
  reasoning: string;
}

/** What the engine tells a player at the start of (each attempt at) its turn. */
export interface TurnInfo {
  color: Color;
  fen: string;
  board: string;
  /** SAN moves played so far, from the start position. */
  history: string[];
  startFen: string;
  moveNumber: number;
  timeControl: GameRecord["timeControl"];
  myClockMs: number;
  opponentClockMs: number;
  /** How long this player took over its previous move, if it has made one. */
  myLastMoveMs?: number;
  /** The opponent has offered a draw that can be accepted now. */
  drawOffered: boolean;
  /** This player may attach a draw offer to its move. */
  canOfferDraw: boolean;
  illegalMovesSoFar: number;
  /** The player's own explanations for its last few moves, oldest first. */
  recentNotes: { moveNumber: number; san: string; reasoning: string }[];
  /** Why the previous attempt this turn was rejected, if it was. */
  feedback?: string;
}

export type PlayerReply = (
  | { ok: true; decision: Decision }
  /** The response could not be read as a decision (bad JSON, refusal, truncated...). */
  | { ok: false; error: string }
) & {
  /** What the request used and cost, when known. */
  spend?: Spend;
  /** The reasoning effort the request went out with; null for the model's default. */
  effort?: string | null;
};

export interface Player {
  readonly spec: PlayerSpec;
  decide(turn: TurnInfo): Promise<PlayerReply>;
  /** The reasoning effort it will ask for first in games of this category; null for the model's default. */
  effortFor?(category: TimeCategory): string | null;
}

/** An API failure that retrying won't fix (bad key, unknown model...). The game is aborted. */
export class FatalPlayerError extends Error {}

/** The API account has no funds left. The game is paused so it can be resumed after topping up. */
export class OutOfFundsError extends FatalPlayerError {}

/** The model doesn't take the reasoning effort asked for. The player asks again with a lower one, or none. */
export class EffortRejectedError extends FatalPlayerError {}

/** A failure that may go away on retry (rate limit, overload, network). Retried on the player's clock. */
export class TransientPlayerError extends Error {}
