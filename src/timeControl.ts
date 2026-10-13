export type TimeCategory = "bullet" | "blitz" | "rapid" | "classical";

export interface TimeControl {
  baseMs: number;
  incrementMs: number;
}

const MINUTE = 60_000;
const SECOND = 1_000;

/**
 * Parses "minutes+seconds" as used in chess, e.g. "5+3" (5 minutes, 3 seconds
 * added per move) or "10+0". A bare "10" means no increment.
 */
export function parseTimeControl(text: string): TimeControl {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\+\s*(\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (!match) {
    throw new Error(`Invalid time control "${text}". Use minutes+increment, e.g. 5+3 or 10+0.`);
  }
  const baseMs = Math.round(Number(match[1]) * MINUTE);
  const incrementMs = Math.round(Number(match[2] ?? 0) * SECOND);
  if (baseMs <= 0) throw new Error(`Invalid time control "${text}": the base time must be above zero.`);
  return { baseMs, incrementMs };
}

/** "5+3" style label. */
export function timeControlLabel(tc: TimeControl): string {
  return `${trimNumber(tc.baseMs / MINUTE)}+${trimNumber(tc.incrementMs / SECOND)}`;
}

/** PGN TimeControl tag value: seconds+increment, e.g. "300+3". */
export function pgnTimeControl(tc: TimeControl): string {
  return `${trimNumber(tc.baseMs / SECOND)}+${trimNumber(tc.incrementMs / SECOND)}`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * FIDE's definition, based on the time each player gets for a 60-move game
 * (base + 60 × increment): 10 minutes or less is blitz, under 60 minutes is
 * rapid, 60 minutes or more is classical (FIDE "standard"). FIDE has no bullet
 * category; the usual under-3-minutes split is used for it.
 */
export function timeCategory(tc: TimeControl): TimeCategory {
  const estimatedMs = tc.baseMs + 60 * tc.incrementMs;
  if (estimatedMs < 3 * MINUTE) return "bullet";
  if (estimatedMs <= 10 * MINUTE) return "blitz";
  if (estimatedMs < 60 * MINUTE) return "rapid";
  return "classical";
}

/** Extra time the opponent receives after a player's first illegal move. */
export function illegalMoveBonusMs(tc: TimeControl): number {
  return timeCategory(tc) === "classical" ? 2 * MINUTE : 1 * MINUTE;
}

/** Human-readable clock: "1:05:00", "4:59", or "0:07.3" under ten seconds. */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 10 * SECOND) {
    const tenths = Math.floor(clamped / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const totalSeconds = Math.floor(clamped / SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** PGN [%clk h:mm:ss] value. */
export function pgnClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** "1 minute", "2 minutes", "30 seconds". */
export function describeDuration(ms: number): string {
  if (ms % MINUTE === 0) {
    const m = ms / MINUTE;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const s = Math.round(ms / SECOND);
  return `${s} second${s === 1 ? "" : "s"}`;
}
