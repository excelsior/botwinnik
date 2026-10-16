import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createGameRecord } from "../game/game.js";
import { GameService } from "../game/service.js";
import { GameStore } from "../game/store.js";
import type { GameRecord, PlayerSpec } from "../game/types.js";
import { CLAUDE, FoolsMatePlayer, GPT } from "../testing.js";
import { parseTimeControl } from "../timeControl.js";
import type { Engine, SearchResult } from "./engine.js";
import { AnalysisService, playerKey } from "./service.js";

/** An engine that answers from a script: `score(moves)` for the position after `moves`. */
class FakeEngine implements Engine {
  readonly name = "Fake Stockfish";
  readonly searches: string[][] = [];
  quits = 0;
  constructor(private readonly score: (moves: readonly string[]) => SearchResult | Promise<SearchResult>) {}
  async newGame() {}
  async search(_fen: string, moves: readonly string[]) {
    this.searches.push([...moves]);
    return this.score(moves);
  }
  quit() {
    this.quits++;
  }
}

/** Level positions where the engine would play e2e4. */
const level = (): SearchResult => ({ score: { cp: 0 }, best: "e2e4", depth: 18 });

describe("analysis", () => {
  let dir: string;
  let games: GameService;
  let engine: FakeEngine;
  let starts: number;
  const service = (score: (moves: readonly string[]) => SearchResult | Promise<SearchResult> = level, settings = { depth: 18 }) => {
    engine = new FakeEngine(score);
    return new AnalysisService(games, settings, {
      startEngine: async () => {
        starts++;
        return engine;
      },
    });
  };
  let minute = 0;
  /** Plays fool's mate: Black wins in four half-moves. Each game starts a minute after the one before. */
  const play = async (white: PlayerSpec = CLAUDE, black: PlayerSpec = GPT, timeControl = "5+3") => {
    const started = games.start({ timeControl, players: [white, black], firstPlayerColor: "white" });
    const game = (await games.wait(started.id))!;
    game.createdAt = new Date(Date.UTC(2026, 9, 16, 12, minute++)).toISOString();
    games.store.save(game);
    return game;
  };
  /** Runs `fn` with console.error collected instead of printed. */
  const quietly = async (fn: () => Promise<void>) => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return errors;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    games = new GameService(new GameStore(dir), (spec) => new FoolsMatePlayer(spec));
    starts = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("analyzes each game once it's over and saves the analysis next to the games", async () => {
    // White's moves give the game away; Black's are the engine's choice.
    const analysis = service((moves) => {
      if (moves.length === 3) return { score: { mate: 1 }, best: "d8h4", depth: 18 }; // Black to move mates
      if (moves.length === 2) return { score: { cp: -300 }, best: "d2d4", depth: 18 }; // White to move after 1. f3 e5
      return { score: { cp: 20 }, best: moves.length ? "e7e5" : "e2e4", depth: 18 };
    });
    assert.equal(analysis.start(), 0);
    const game = await play();
    assert.equal(analysis.pending(), 1, "queued as soon as the game ended");
    await analysis.whenIdle();

    assert.deepEqual(engine.searches, [[], ["f2f3"], ["f2f3", "e7e5"], ["f2f3", "e7e5", "g2g4"]], "the mate on the board isn't searched");
    assert.equal(engine.quits, 1, "the engine stops once there's nothing left to analyze");
    const saved = JSON.parse(readFileSync(path.join(dir, "analysis", `${game.id}.json`), "utf8"));
    assert.equal(saved.engine, "Fake Stockfish");
    assert.equal(saved.depth, 18);
    assert.deepEqual(saved.moves, ["f2f3", "e7e5", "g2g4", "d8h4"]);
    assert.deepEqual(saved.evals, [
      { cp: 20, best: "e2e4" },
      { cp: -20, best: "e7e5" },
      { cp: -300, best: "d2d4" },
      { mate: -1, best: "d8h4" },
      { mate: 0, winner: "black" },
    ]);

    const view = analysis.view(game);
    assert.equal(view?.status, "done");
    if (view?.status !== "done") return;
    assert.deepEqual(
      view.moves.map((m) => [m.ply, m.judgement, m.bestSan ?? null]),
      [
        [1, null, "e4"],
        [2, null, null],
        [3, "blunder", "d4"],
        [4, null, null],
      ],
    );
    assert.equal(view.black.accuracy !== null && Math.round(view.black.accuracy), 100);
    assert.ok(view.white.accuracy! < 60);
    assert.equal(view.white.blunders, 1);
    assert.deepEqual(analysis.accuracyOf(game), { white: view.white.accuracy, black: view.black.accuracy });
  });

  it("analyzes the finished games that haven't been, newest first, when it starts", async () => {
    const old = await play();
    const recent = await play(GPT, CLAUDE);
    const stored = createGameRecord({ id: "unfinished", timeControl: parseTimeControl("5+3"), white: CLAUDE, black: GPT, colorsAssigned: "manual" });
    games.store.save({ ...stored, status: "aborted" });
    games.store.save({ ...stored, id: "paused", status: "paused" });

    const first = service();
    const done: string[] = [];
    for (const g of [old, recent]) first.subscribe(g.id, () => first.view(g)?.status === "done" && done.push(g.id));
    assert.equal(first.start(), 2);
    assert.equal(first.view(old)?.status, "queued");
    await first.whenIdle();
    assert.equal(starts, 1, "one engine for the whole queue");
    assert.deepEqual(done, [recent.id, old.id]);
    assert.equal(first.view(games.get("unfinished")!), null);

    // A later start has nothing left to do, until a game's moves stop matching its analysis.
    assert.equal(service().start(), 0);
    const file = path.join(dir, "analysis", `${old.id}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, moves: ["e2e4", "e7e5", "g2g4", "d8h4"] }));
    const again = service();
    assert.equal(again.analysisOf(old), undefined);
    assert.equal(again.start(), 1);
    await again.whenIdle();
    assert.equal(again.view(old)?.status, "done");
  });

  it("puts the game someone is looking at first", async () => {
    const [a, b, c] = [await play(), await play(), await play()];
    let release = () => {};
    const held = new Promise<SearchResult>((resolve) => (release = () => resolve(level())));
    const analysis = service((moves) => (moves.length === 0 && engine.searches.length === 1 ? held : level()));
    analysis.start(); // newest first: c, b, a
    assert.equal(analysis.view(c)?.status, "analyzing");
    assert.ok(analysis.ensure(a, { urgent: true }));
    assert.equal(analysis.pending(), 3);
    const done: string[] = [];
    for (const g of [a, b, c]) analysis.subscribe(g.id, () => analysis.view(g)?.status === "done" && done.push(g.id));
    release();
    await analysis.whenIdle();
    assert.deepEqual(done, [c.id, a.id, b.id]);
  });

  it("says why a game couldn't be analyzed, and tries it again only when asked", async () => {
    const game = await play();
    let broken = true;
    const analysis = service((moves) => {
      if (broken && moves.length === 2) throw new Error("The engine stopped (exit code 1)");
      return level();
    });
    const errors = await quietly(async () => {
      analysis.start();
      await analysis.whenIdle();
    });
    assert.deepEqual(errors, [`Couldn't analyze game ${game.id}: The engine stopped (exit code 1)`]);
    assert.deepEqual(analysis.view(game), { status: "failed", error: "The engine stopped (exit code 1)" });
    assert.equal(analysis.ensure(game, { urgent: true }), false, "opening the game doesn't retry it");
    broken = false;
    const progress: string[] = [];
    const result = await analysis.analyze(game, (done, total) => progress.push(`${done}/${total}`));
    assert.deepEqual(progress, ["0/5", "1/5", "2/5", "3/5", "4/5", "5/5"]);
    assert.equal(result.evals.length, 5);
    assert.equal(analysis.view(game)?.status, "done");
  });

  it("gives up on the queue when the engine can't start", async () => {
    const [a, b] = [await play(), await play()];
    const analysis = new AnalysisService(games, { engine: "/no/stockfish", depth: 18 }, {
      startEngine: async () => {
        starts++;
        throw new Error("Couldn't start the engine at /no/stockfish: spawn /no/stockfish ENOENT");
      },
    });
    const errors = await quietly(async () => {
      analysis.start();
      await analysis.whenIdle();
    });
    assert.equal(starts, 1);
    assert.equal(errors.length, 1, "said once");
    for (const g of [a, b]) assert.deepEqual(analysis.view(g), { status: "failed", error: "Couldn't start the engine at /no/stockfish: spawn /no/stockfish ENOENT" });
  });

  it("averages each model's accuracy by time category, a model playing itself counting twice", async () => {
    // White blunders on its second move (2. g4) and Black finds the mate, in every game.
    const blitz = [await play(CLAUDE, GPT), await play(GPT, CLAUDE)];
    const bullet = await play(CLAUDE, CLAUDE, "1+0");
    const unanalyzed = await play(GPT, CLAUDE);
    const analysis = service((moves) =>
      moves.length === 3 ? { score: { mate: 1 }, best: "d8h4", depth: 18 } : { score: { cp: moves.length === 2 ? 30 : 0 }, best: "a2a3", depth: 18 },
    );
    for (const g of [...blitz, bullet]) analysis.ensure(g);
    await analysis.whenIdle();
    const side = (g: GameRecord, color: "white" | "black") => analysis.accuracyOf(g)![color]!;

    const categories = analysis.byCategory(games.records());
    assert.deepEqual(categories.bullet.get(playerKey(CLAUDE)), {
      accuracy: (side(bullet, "white") + side(bullet, "black")) / 2,
      games: 2,
    });
    assert.equal(categories.bullet.get(playerKey(GPT)), undefined);
    assert.deepEqual(categories.blitz.get(playerKey(GPT)), {
      accuracy: (side(blitz[0], "black") + side(blitz[1], "white")) / 2,
      games: 2,
    });
    assert.equal(categories.rapid.size, 0);
    // Until it's analyzed, a game doesn't count.
    assert.equal(analysis.accuracyOf(unanalyzed), null);
    assert.equal(analysis.averages([unanalyzed]).size, 0);
    analysis.ensure(unanalyzed);
    await analysis.whenIdle();
    assert.equal(analysis.averages([unanalyzed]).size, 2);
  });

  it("analyzes nothing when turned off, but still counts the analyses it has", async () => {
    const game = await play();
    const on = service();
    on.ensure(game);
    await on.whenIdle();

    const off = new AnalysisService(games, null);
    assert.equal(off.start(), 0);
    const later = await play();
    assert.equal(off.ensure(later), false);
    assert.equal(off.view(later), null);
    await assert.rejects(off.analyze(later), /turned off/);
    assert.equal(off.view(game)?.status, "done");
    assert.equal(off.averages([game, later]).size, 2);
    assert.ok(existsSync(path.join(dir, "analysis", `${game.id}.json`)));
  });
});
