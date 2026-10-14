/** One round of a round-robin: who plays whom with which color, and who sits it out. */
export interface ScheduledRound {
  /** [white, black] pairs of player numbers (0-based). */
  pairs: [number, number][];
  /** The player who sits this round out when the number of players is odd. */
  bye: number | null;
}

/**
 * A single round-robin for `players` players (numbered from 0), from the
 * Berger tables FIDE uses: every pair meets once, and with an odd number of
 * players each round has one player sitting out, a different one each round.
 * Colors alternate from round to round wherever they can: each player gets as
 * many Whites as Blacks (with an even number of players, which gives each an
 * odd number of games, half of them get one White more), and nobody has the
 * same color three times in a row.
 */
export function roundRobin(players: number): ScheduledRound[] {
  if (!Number.isInteger(players) || players < 2) throw new Error("A round-robin needs at least two players.");
  // An odd field gets a phantom last player; whoever is paired with it rests.
  const size = players + (players % 2);
  const last = size - 1;
  const half = size / 2;
  // Round 1 pairs 1–n, 2–(n−1)... with the first named player White.
  let boards: [number, number][] = Array.from({ length: half }, (_, i) => [i, last - i]);
  const rounds: ScheduledRound[] = [];
  for (let r = 0; r < size - 1; r++) {
    const pairs: [number, number][] = [];
    let bye: number | null = null;
    for (const [white, black] of boards) {
      if (last >= players && (white === last || black === last)) bye = white === last ? black : white;
      else pairs.push([white, black]);
    }
    rounds.push({ pairs, bye });
    // Each round every number but the last moves on by half the field, and the
    // last player switches color on the first board.
    const shift = (n: number) => (n === last ? n : (n + half) % last);
    boards = boards.map(([white, black], i) => (i === 0 ? [shift(black), shift(white)] : [shift(white), shift(black)]));
  }
  return rounds;
}
