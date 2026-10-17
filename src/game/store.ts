import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { addSpend, emptySpend, findPrice, priceSpend, type ModelPrice, type Spend } from "../pricing.js";
import { timeCategory } from "../timeControl.js";
import { COLORS, playerKey, type GameRecord } from "./types.js";

export interface GameSummary {
  id: string;
  status: GameRecord["status"];
  createdAt: string;
  white: GameRecord["white"];
  black: GameRecord["black"];
  timeControl: string;
  result: GameRecord["result"];
  termination: string | null;
  moves: number;
  /** USD for both players; null when a model's price is unknown. */
  costUsd: number | null;
  tournament?: GameRecord["tournament"];
}

/** Both players' spend added up. */
export function gameSpend(game: GameRecord): Spend {
  return addSpend(game.spend?.white ?? emptySpend(), game.spend?.black ?? emptySpend());
}

/** Each player's spend over `games` added up, by playerKey. */
export function spendByPlayer(games: readonly GameRecord[]): Map<string, Spend> {
  const totals = new Map<string, Spend>();
  for (const game of games) {
    for (const color of COLORS) {
      const key = playerKey(game[color]);
      totals.set(key, addSpend(totals.get(key) ?? emptySpend(), game.spend?.[color] ?? emptySpend()));
    }
  }
  return totals;
}

/** Saves each game as games/<id>.json, rewriting it after every change. */
export class GameStore {
  constructor(
    readonly dir: string,
    /** Prices from config.ini, for costs the games were saved without. */
    private readonly prices: Record<string, ModelPrice> = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  newId(now = new Date()): string {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  save(game: GameRecord): void {
    const file = this.file(game.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(game, null, 2));
    renameSync(tmp, file);
  }

  load(id: string): GameRecord | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    return read(file, this.prices);
  }

  list(): GameRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [read(path.join(this.dir, f), this.prices)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}

/**
 * A saved game, its category worked out again (10+0 games saved as blitz
 * count as rapid), and the costs of models that had no price when it was
 * played worked out from their tokens if they have one now.
 */
function read(file: string, prices: Record<string, ModelPrice>): GameRecord {
  const game = JSON.parse(readFileSync(file, "utf8")) as GameRecord;
  game.timeControl.category = timeCategory(game.timeControl);
  fillInCosts(game, prices);
  return game;
}

/** Prices unknown costs at the prices of the day the game started, as it would have been then. */
function fillInCosts(game: GameRecord, prices: Record<string, ModelPrice>): void {
  const day = new Date(game.createdAt);
  const price = { white: findPrice(game.white.model, prices, day), black: findPrice(game.black.model, prices, day) };
  for (const move of game.moves) {
    if (move.spend) move.spend = priceSpend(move.spend, price[move.color]);
  }
  for (const color of ["white", "black"] as const) {
    if (game.spend?.[color]) game.spend[color] = priceSpend(game.spend[color], price[color]);
  }
}

export function summarize(game: GameRecord): GameSummary {
  return {
    id: game.id,
    status: game.status,
    createdAt: game.createdAt,
    white: game.white,
    black: game.black,
    timeControl: game.timeControl.label,
    result: game.result,
    termination: game.termination?.message ?? null,
    moves: game.moves.length,
    costUsd: gameSpend(game).costUsd,
    ...(game.tournament ? { tournament: game.tournament } : {}),
  };
}
