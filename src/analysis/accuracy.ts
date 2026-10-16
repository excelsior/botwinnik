// Accuracy the way Lichess works it out (https://lichess.org/page/accuracy):
// each position's evaluation becomes a winning chance, each move is scored by
// how much of its player's winning chance it gave away, and a game's accuracy
// is the average of a weighted and a harmonic mean of those scores.
import type { Color } from "../game/types.js";

/** An engine's verdict on a position, from White's side. */
export interface PositionEval {
  /** Centipawns, positive when White is better. Absent when `mate` is set. */
  cp?: number;
  /** Moves to mate: positive when White mates, negative when Black does; 0 once checkmate is on the board. */
  mate?: number;
  /** Who gave checkmate, with `mate: 0`. */
  winner?: Color;
  /** The engine's choice in this position (UCI); absent where the game is over. */
  best?: string;
}

/** Inaccuracies, mistakes and blunders give away this much of their player's winning chance, in percentage points. */
export const JUDGEMENT_THRESHOLDS = { inaccuracy: 5, mistake: 10, blunder: 15 } as const;
export type Judgement = keyof typeof JUDGEMENT_THRESHOLDS;

/** Evaluations beyond this many centipawns, and mates, count as this many. */
const CP_CEILING = 1000;

/** White's chance of winning in a position, 0 to 100 (Lichess's curve, fitted to its players' games). */
export function winPercent(evaluation: PositionEval): number {
  const cp = clamp(centipawns(evaluation), -CP_CEILING, CP_CEILING);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** An evaluation in centipawns from White's side, mates counting as the ceiling. */
function centipawns(evaluation: PositionEval): number {
  if (evaluation.mate === undefined) return evaluation.cp ?? 0;
  const sign = evaluation.mate === 0 ? (evaluation.winner === "black" ? -1 : 1) : Math.sign(evaluation.mate);
  return sign * CP_CEILING;
}

/**
 * How good a move was, 0 to 100, from its player's winning chance before and
 * after it: 100 when it kept it, less the more it gave away.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (winBefore - winAfter)) - 3.166924740191411;
  // Lichess adds a point for the engine's own uncertainty.
  return clamp(raw + 1, 0, 100);
}

export interface MoveReport {
  /** 1-based half-move number. */
  ply: number;
  color: Color;
  /** The position after the move. */
  eval: PositionEval;
  /** The mover's winning chances before and after the move, 0 to 100. */
  winBefore: number;
  winAfter: number;
  accuracy: number;
  /** Centipawns the move gave away (mates counting as 1000). */
  cpLoss: number;
  judgement: Judgement | null;
  /** The engine's choice in the position before the move (UCI), when the move was something else. */
  best?: string;
}

export interface SideReport {
  /** Null for a side that made no moves. */
  accuracy: number | null;
  moves: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  /** Average centipawn loss; null for a side that made no moves. */
  acpl: number | null;
}

export interface AccuracyReport {
  white: SideReport;
  black: SideReport;
  moves: MoveReport[];
}

/**
 * Scores a game's moves and each side's accuracy from the evaluations of the
 * start position and of the position after each move (`evals` has one more
 * entry than `moves`).
 *
 * A game's accuracy follows Lichess: the mean of the side's move accuracies
 * weighted by how much the position was swinging around each move (the
 * standard deviation of the winning chances over a window of positions),
 * averaged with their harmonic mean, which a few bad moves pull down hard.
 */
export function accuracyReport(evals: readonly PositionEval[], moves: readonly { color: Color; uci: string }[]): AccuracyReport {
  if (evals.length !== moves.length + 1) throw new Error(`Expected ${moves.length + 1} evaluations, got ${evals.length}.`);
  const wins = evals.map(winPercent);
  const window = clamp(Math.floor(moves.length / 10), 2, 8);
  const windows = [
    ...Array.from({ length: Math.max(0, Math.min(window, wins.length) - 2) }, () => wins.slice(0, window)),
    ...slidingWindows(wins, window),
  ];
  const weights = windows.map((w) => clamp(standardDeviation(w), 0.5, 12));

  const reports: MoveReport[] = moves.map((move, i) => {
    const pov = (w: number) => (move.color === "white" ? w : 100 - w);
    const [winBefore, winAfter] = [pov(wins[i]), pov(wins[i + 1])];
    const sign = move.color === "white" ? 1 : -1;
    const ceiled = (e: PositionEval) => sign * clamp(centipawns(e), -CP_CEILING, CP_CEILING);
    const best = evals[i].best;
    return {
      ply: i + 1,
      color: move.color,
      eval: withoutBest(evals[i + 1]),
      winBefore,
      winAfter,
      accuracy: moveAccuracy(winBefore, winAfter),
      cpLoss: Math.max(0, ceiled(evals[i]) - ceiled(evals[i + 1])),
      judgement: judge(winBefore - winAfter),
      ...(best && best !== move.uci ? { best } : {}),
    };
  });

  const side = (color: Color): SideReport => {
    const own = reports.map((r, i) => ({ r, weight: weights[i] })).filter(({ r }) => r.color === color);
    const count = (j: Judgement) => own.filter(({ r }) => r.judgement === j).length;
    if (!own.length) return { accuracy: null, moves: 0, inaccuracies: 0, mistakes: 0, blunders: 0, acpl: null };
    const weightedMean = own.reduce((sum, { r, weight }) => sum + r.accuracy * weight, 0) / own.reduce((sum, { weight }) => sum + weight, 0);
    const harmonicMean = own.length / own.reduce((sum, { r }) => sum + 1 / Math.max(1, r.accuracy), 0);
    return {
      accuracy: (weightedMean + harmonicMean) / 2,
      moves: own.length,
      inaccuracies: count("inaccuracy"),
      mistakes: count("mistake"),
      blunders: count("blunder"),
      acpl: own.reduce((sum, { r }) => sum + r.cpLoss, 0) / own.length,
    };
  };
  return { white: side("white"), black: side("black"), moves: reports };
}

/** Lichess's judgement of a move that cost its player `drop` percentage points of winning chance. */
export function judge(drop: number): Judgement | null {
  if (drop >= JUDGEMENT_THRESHOLDS.blunder) return "blunder";
  if (drop >= JUDGEMENT_THRESHOLDS.mistake) return "mistake";
  if (drop >= JUDGEMENT_THRESHOLDS.inaccuracy) return "inaccuracy";
  return null;
}

/** A player's accuracy over several games: the plain mean of its game accuracies. */
export interface AccuracyAverage {
  accuracy: number;
  games: number;
}

export function averageAccuracy(accuracies: readonly number[]): AccuracyAverage | undefined {
  if (!accuracies.length) return undefined;
  return { accuracy: accuracies.reduce((a, b) => a + b, 0) / accuracies.length, games: accuracies.length };
}

function withoutBest({ best: _best, ...evaluation }: PositionEval): PositionEval {
  return evaluation;
}

/** Every run of `size` consecutive values; the whole list when it is shorter. */
function slidingWindows(values: readonly number[], size: number): number[][] {
  if (values.length <= size) return [values.slice()];
  return Array.from({ length: values.length - size + 1 }, (_, i) => values.slice(i, i + size));
}

function standardDeviation(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
