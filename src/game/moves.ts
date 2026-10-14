import { Chess, type Move } from "chess.js";

/**
 * Resolves a move written by a player to a legal move in the given position,
 * or null if it isn't one. Accepts SAN ("Nf3", "exd5", "e8=Q", "O-O") and
 * coordinate notation ("g1f3", "e7e8q", "e2-e4"), and tolerates missing or
 * extra check marks, annotation symbols, and castling written with zeros.
 */
export function resolveMove(fen: string, text: string): Move | null {
  const candidates = normalize(text);
  for (const candidate of candidates) {
    const chess = new Chess(fen);
    try {
      return chess.move(candidate, { strict: false });
    } catch {
      // try the next spelling
    }
  }
  return null;
}

function normalize(text: string): string[] {
  let t = text.trim();
  // Strip a leading move number such as "12." or "12...".
  t = t.replace(/^\d+\s*\.+\s*/, "");
  // Strip trailing annotations like "!", "?", "!?".
  t = t.replace(/[!?]+$/, "");
  t = t.replace(/^0-0-0/, "O-O-O").replace(/^0-0/, "O-O");
  t = t.replace(/^o-o-o/i, "O-O-O").replace(/^o-o/i, "O-O");
  const out = [t];
  const coord = /^([a-h][1-8])\s*[-x:]?\s*([a-h][1-8])\s*=?\s*([qrbnQRBN])?[+#]?$/.exec(t);
  if (coord) out.push(`${coord[1]}${coord[2]}${(coord[3] ?? "").toLowerCase()}`);
  return out;
}

/** Board diagram from White's side, with rank and file labels. */
export function boardDiagram(chess: Chess): string {
  return chess.ascii().trimEnd();
}

/** "1. e4 e5 2. Nf3" from a SAN list, honoring a start position where Black moves first. */
export function formatMoveList(history: string[], startFen: string): string {
  const startChess = new Chess(startFen);
  let moveNumber = startChess.moveNumber();
  let whiteToMove = startChess.turn() === "w";
  const parts: string[] = [];
  history.forEach((san, i) => {
    if (whiteToMove) parts.push(`${moveNumber}. ${san}`);
    else parts.push(i === 0 ? `${moveNumber}... ${san}` : san);
    if (!whiteToMove) moveNumber++;
    whiteToMove = !whiteToMove;
  });
  return parts.join(" ");
}

/** True when the side has nothing but its king. */
export function hasOnlyKing(chess: Chess, color: "w" | "b"): boolean {
  return chess
    .board()
    .flat()
    .every((sq) => !sq || sq.color !== color || sq.type === "k");
}
