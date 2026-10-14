import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { addSpend, emptySpend, type Spend } from "../pricing.js";
import type { GameRecord } from "./types.js";

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
}

/** Both players' spend added up. */
export function gameSpend(game: GameRecord): Spend {
  return addSpend(game.spend?.white ?? emptySpend(), game.spend?.black ?? emptySpend());
}

/** Saves each game as games/<id>.json, rewriting it after every change. */
export class GameStore {
  constructor(readonly dir: string) {
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
    return JSON.parse(readFileSync(file, "utf8")) as GameRecord;
  }

  list(): GameRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as GameRecord];
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
  };
}
