import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AnalysisService } from "../analysis/service.js";
import type { Engine, SearchResult } from "../analysis/engine.js";
import { assignColors, GameService } from "../game/service.js";
import { GameStore } from "../game/store.js";
import { createGameRecord } from "../game/game.js";
import { OutOfFundsError, type PlayerSpec } from "../game/types.js";
import { callSpend, CLAUDE, FoolsMatePlayer, GPT, ScriptedPlayer } from "../testing.js";
import { DEFAULT_EFFORT } from "../players/effort.js";
import { parseTimeControl } from "../timeControl.js";
import { createServer, newestSourceChange } from "./server.js";

const providers = {
  anthropic: { apiKey: "k", models: ["claude-test"], effort: DEFAULT_EFFORT },
  openai: { apiKey: "k", models: ["gpt-test"], effort: DEFAULT_EFFORT },
};

/** While set, OpenAI players fail as if their account had run out of funds. */
let openaiOutOfFunds = false;

/** Fool's mate for whichever model ends up with each color. */
function foolsMatePlayers(spec: PlayerSpec) {
  if (openaiOutOfFunds && spec.provider === "openai") {
    return new ScriptedPlayer(spec, [{ error: new OutOfFundsError("OpenAI API error 429: You exceeded your current quota") }]);
  }
  const steps = spec.model.startsWith("claude") ? ["f3", "g4"] : ["e5", "Qh4#"];
  return new ScriptedPlayer(spec, [...steps], undefined, callSpend(0.01));
}

describe("game service", () => {
  it("assigns colors as asked, or at random", () => {
    assert.deepEqual(assignColors([CLAUDE, GPT], "white"), { white: CLAUDE, black: GPT, colorsAssigned: "manual" });
    assert.deepEqual(assignColors([CLAUDE, GPT], "black"), { white: GPT, black: CLAUDE, colorsAssigned: "manual" });
    assert.equal(assignColors([CLAUDE, GPT], "random", () => 0.1).white, CLAUDE);
    assert.equal(assignColors([CLAUDE, GPT], "random", () => 0.9).white, GPT);
    assert.equal(assignColors([CLAUDE, GPT], "random").colorsAssigned, "random");
  });

  it("saves games, and pauses ones interrupted by a restart so they can be resumed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      // White was thinking with 200 s left when the app stopped.
      const stale = createGameRecord({ id: store.newId(), timeControl: parseTimeControl("5+3"), white: CLAUDE, black: GPT, colorsAssigned: "manual" });
      stale.clocks.white = 200_000;
      stale.turnStartedAt = new Date().toISOString();
      store.save(stale);
      const service = new GameService(store, foolsMatePlayers);
      assert.equal(service.recoverInterrupted(), 1);
      const paused = store.load(stale.id)!;
      assert.equal(paused.status, "paused");
      assert.equal(paused.turnStartedAt, undefined);
      assert.equal(paused.clocks.white, 200_000, "the interrupted turn starts over with the time it started with");
      assert.deepEqual(
        paused.events.map((e) => [e.type, e.color, e.ply]),
        [["paused", "white", 0]],
      );
      assert.match(paused.events[0].message, /^Paused: the app stopped during White's turn\. Resume the game/);
      assert.equal(service.recoverInterrupted(), 0, "a paused game stays paused");
      service.resume(stale.id);
      assert.equal((await service.wait(stale.id))?.result, "0-1");

      const game = service.start({ timeControl: "5+3", players: [CLAUDE, GPT], firstPlayerColor: "white" });
      const final = await service.wait(game.id);
      assert.equal(final?.result, "0-1");
      const saved = store.load(game.id);
      assert.equal(saved?.status, "finished");
      assert.equal(saved?.moves.length, 4);
      assert.deepEqual(
        service.list().map((g) => g.id).sort(),
        [game.id, stale.id].sort(),
      );
      assert.equal(store.load("../etc/passwd"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves the cost of a call cut off by the clock once it finishes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      let white: ScriptedPlayer | undefined;
      const service = new GameService(store, (spec) =>
        spec.model.startsWith("claude")
          ? (white = new ScriptedPlayer(spec, [{ hang: true, spend: callSpend(0.25) }]))
          : new ScriptedPlayer(spec, []),
      );
      const game = service.start({ timeControl: "0.001+0", players: [CLAUDE, GPT], firstPlayerColor: "white" });
      assert.equal((await service.wait(game.id))?.termination?.reason, "timeout");
      assert.equal(store.load(game.id)?.unfinishedCall, "white");

      white!.release();
      await service.callsFinished(game.id);
      const saved = store.load(game.id);
      assert.equal(saved?.unfinishedCall, undefined);
      assert.equal(saved?.spend.white.costUsd, 0.25);
      assert.equal(service.list()[0].costUsd, 0.25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauses a game whose player runs out of funds, keeps it paused across restarts, and resumes it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      openaiOutOfFunds = true;
      const first = new GameService(store, foolsMatePlayers);
      const game = first.start({ timeControl: "5+3", players: [CLAUDE, GPT], firstPlayerColor: "white" });
      assert.equal((await first.wait(game.id))?.status, "paused");
      assert.equal(store.load(game.id)?.status, "paused");

      // After a restart (a new service on the same folder) it is still paused, and can be resumed.
      const service = new GameService(store, foolsMatePlayers);
      assert.equal(service.recoverInterrupted(), 0);
      assert.equal(store.load(game.id)?.status, "paused");
      openaiOutOfFunds = false;
      service.resume(game.id);
      const final = await service.wait(game.id);
      assert.equal(final?.result, "0-1");
      assert.equal(final?.moves.length, 4);
      assert.throws(() => service.resume(game.id), /not paused/);
    } finally {
      openaiOutOfFunds = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts a paused game", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      openaiOutOfFunds = true;
      const service = new GameService(store, foolsMatePlayers);
      const game = service.start({ timeControl: "5+3", players: [CLAUDE, GPT], firstPlayerColor: "white" });
      assert.equal((await service.wait(game.id))?.status, "paused");
      assert.ok(service.abort(game.id));
      assert.equal(store.load(game.id)?.status, "aborted");
      assert.equal(store.load(game.id)?.termination?.message, "Aborted by the admin.");
      assert.ok(!service.abort(game.id));
    } finally {
      openaiOutOfFunds = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets calls a previous run was still waiting for", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      const game = createGameRecord({ id: store.newId(), timeControl: parseTimeControl("5+3"), white: CLAUDE, black: GPT, colorsAssigned: "manual" });
      game.status = "finished";
      game.unfinishedCall = "black";
      store.save(game);
      assert.equal(new GameService(store, foolsMatePlayers).recoverInterrupted(), 0);
      const saved = store.load(game.id);
      assert.equal(saved?.status, "finished");
      assert.equal(saved?.unfinishedCall, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rates a 10+0 game saved as blitz as rapid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      const game = createGameRecord({ id: store.newId(), timeControl: parseTimeControl("10+0"), white: CLAUDE, black: GPT, colorsAssigned: "manual" });
      Object.assign(game, { status: "finished", result: "1-0", finishedAt: new Date().toISOString() });
      game.timeControl.category = "blitz"; // as saved before 10+0 counted as rapid
      store.save(game);
      assert.equal(store.load(game.id)?.timeControl.category, "rapid");
      const ratings = new GameService(store, foolsMatePlayers).ratings();
      assert.deepEqual(ratings.table("blitz"), []);
      assert.deepEqual(ratings.table("rapid").map((m) => m.model).sort(), ["claude-test", "gpt-test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("admin server", () => {
  let dir: string;
  let base: string;
  let close: () => void;
  let openaiListCalls: () => number;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    const service = new GameService(new GameStore(dir), foolsMatePlayers);
    let openaiCalls = 0;
    const server = createServer(service, {
      providers,
      loopbackOnly: true,
      listModels: async (provider) => {
        if (provider === "anthropic") return [{ id: "claude-new", name: "Claude New" }, { id: "claude-test", name: "Claude Test" }];
        openaiCalls++;
        throw new Error("OpenAI API error 401: Incorrect API key provided");
      },
    });
    openaiListCalls = () => openaiCalls;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });

  after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("serves the page and the setup options", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Botwinnik<\/title>/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    const icon = await fetch(`${base}/favicon.svg`);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.match(await icon.text(), /<svg/);
    const engine = await fetch(`${base}/vendor/stockfish/stockfish-18-lite-single.wasm`);
    assert.equal(engine.status, 200);
    assert.equal(engine.headers.get("content-type"), "application/wasm");
    assert.match(engine.headers.get("cache-control") ?? "", /immutable/);
    await engine.arrayBuffer();
    assert.equal((await fetch(`${base}/../config.ini`)).status, 404);
    const setup = await (await fetch(`${base}/api/setup`)).json();
    assert.deepEqual(
      setup.providers.map((p: { id: string }) => p.id),
      ["openai", "anthropic"],
    );
    assert.ok(setup.timeControls.includes("5+3"));
    assert.equal(setup.outdated, false);
    const [openai, anthropic] = setup.providers;
    assert.deepEqual(anthropic.models, [
      { id: "claude-test", name: "Claude Test" },
      { id: "claude-new", name: "Claude New" },
    ]);
    assert.equal(anthropic.modelsError, undefined);
    assert.deepEqual(openai.models, [{ id: "gpt-test" }], "falls back to config.ini's list");
    assert.match(openai.modelsError, /401/);
    await fetch(`${base}/api/setup`);
    assert.equal(openaiListCalls(), 1, "a failed fetch isn't retried right away");
  });

  it("tells the page when the code changed after the server started", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-src-"));
    try {
      writeFileSync(path.join(dir, "a.ts"), "");
      mkdirSync(path.join(dir, "game"));
      writeFileSync(path.join(dir, "game", "b.ts"), "");
      writeFileSync(path.join(dir, "notes.md"), "");
      writeFileSync(path.join(dir, "game", "b.test.ts"), "");
      writeFileSync(path.join(dir, "testing.ts"), "");
      const started = newestSourceChange(dir);
      const later = new Date(Math.ceil(started) + 60_000);
      for (const file of ["notes.md", "game/b.test.ts", "testing.ts"]) utimesSync(path.join(dir, file), later, later);
      assert.equal(newestSourceChange(dir), started, "only the app's source files count, not tests");
      utimesSync(path.join(dir, "game", "b.ts"), later, later);
      // Within a millisecond: file times can come back with float rounding.
      assert.ok(Math.abs(newestSourceChange(dir) - later.getTime()) < 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const server = createServer(new GameService(new GameStore(dir), foolsMatePlayers), { providers, loopbackOnly: true, codeChanged: () => true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const setup = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`)).json();
      assert.equal(setup.outdated, true);
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates new games", async () => {
    const cases: [unknown, RegExp][] = [
      [{ players: [CLAUDE, GPT] }, /timeControl/],
      [{ timeControl: "5+3", players: [CLAUDE] }, /two players/],
      [{ timeControl: "5:3", players: [CLAUDE, GPT] }, /Invalid time control/],
      [{ timeControl: "5+3", players: [CLAUDE, { provider: "openai", model: " " }] }, /Player 2: pick a model/],
      [{ timeControl: "5+3", players: [CLAUDE, { provider: "bard", model: "x" }] }, /Player 2: unknown provider/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT], firstPlayerColor: "green" }, /firstPlayerColor/],
    ];
    for (const [body, error] of cases) {
      const res = await post("/api/games", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, error);
    }
  });

  it("starts a game, streams it, and exports PGN", async () => {
    const res = await post("/api/games", { timeControl: "3+2", players: [GPT, CLAUDE], firstPlayerColor: "black" });
    assert.equal(res.status, 201);
    const { game } = await res.json();
    assert.equal(game.white.model, "claude-test");
    assert.equal(game.colorsAssigned, "manual");

    let final, ratings;
    for (let i = 0; i < 50; i++) {
      ({ game: final, ratings } = await (await fetch(`${base}/api/games/${game.id}`)).json());
      if (final.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(final.result, "0-1");
    assert.deepEqual(ratings, { white: { before: 1500, after: 1484 }, black: { before: 1500, after: 1516 } });
    const table = await (await fetch(`${base}/api/ratings`)).json();
    assert.equal(table.start, 1500);
    assert.deepEqual(Object.keys(table.categories), ["bullet", "blitz", "rapid", "classical"]);
    assert.deepEqual(
      table.categories.blitz.map((m: { model: string; rating: number; wins: number }) => [m.model, m.rating, m.wins]),
      [
        ["gpt-test", 1516, 1],
        ["claude-test", 1484, 0],
      ],
    );
    assert.deepEqual(table.categories.rapid, []);

    const events = await fetch(`${base}/api/games/${game.id}/events`);
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(first, /^data: \{"game":\{/);
    assert.match(first, /"ratings":\{"white":\{"before":1500,"after":1484\}/);

    const pgn = await fetch(`${base}/api/games/${game.id}/pgn`);
    assert.equal(pgn.status, 200);
    assert.match(pgn.headers.get("content-disposition") ?? "", /attachment; filename="botwinnik-.*\.pgn"/);
    const pgnText = await pgn.text();
    assert.match(pgnText, /\[Result "0-1"\]/);
    assert.match(pgnText, /\[WhiteElo "1500"\]\n\[BlackElo "1500"\]/);

    const list = await (await fetch(`${base}/api/games`)).json();
    const summary = list.find((g: { id: string }) => g.id === game.id);
    assert.ok(Math.abs(summary.costUsd - 0.04) < 1e-9, "four moves at $0.01");
    assert.ok(Math.abs(final.spend.white.costUsd - 0.02) < 1e-9);

    const abort = await post(`/api/games/${game.id}/abort`, {});
    assert.equal(abort.status, 409);
    assert.equal((await fetch(`${base}/api/games/nope`)).status, 404);
  });

  it("pauses a game when an account runs out of funds and resumes it", async () => {
    const poll = async (id: string, done: (g: { status: string }) => boolean) => {
      let game;
      for (let i = 0; i < 100; i++) {
        game = (await (await fetch(`${base}/api/games/${id}`)).json()).game;
        if (done(game)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      return game;
    };
    openaiOutOfFunds = true;
    try {
      const { game } = await (await post("/api/games", { timeControl: "5+3", players: [CLAUDE, GPT], firstPlayerColor: "white" })).json();
      const paused = await poll(game.id, (g) => g.status === "paused");
      assert.equal(paused.status, "paused");
      assert.match(paused.events.at(-1).message, /Black's API account is out of funds/);
    } finally {
      openaiOutOfFunds = false;
    }
    const list = await (await fetch(`${base}/api/games`)).json();
    const id = list.find((g: { status: string }) => g.status === "paused").id;
    const resumed = await post(`/api/games/${id}/resume`, {});
    assert.equal(resumed.status, 200);
    const final = await poll(id, (g) => g.status !== "running");
    assert.equal(final.result, "0-1");
    assert.equal((await post(`/api/games/${id}/resume`, {})).status, 409);
  });

  it("imports a PGN and resumes it when it has no result", async () => {
    const pgn = `[White "claude-test"]\n[Black "gpt-test"]\n[TimeControl "300+3"]\n[Result "*"]\n\n*\n`;
    const imported = await post("/api/games/import", { pgn });
    assert.equal(imported.status, 201);
    const { game } = await imported.json();
    assert.equal(game.status, "paused");
    assert.equal((await post(`/api/games/${game.id}/resume`, {})).status, 200);
    let final = game;
    for (let i = 0; i < 100 && final.status !== "finished"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      final = (await (await fetch(`${base}/api/games/${game.id}`)).json()).game;
    }
    assert.equal(final.result, "0-1");

    const bad = await post("/api/games/import", { pgn: "1. e4 e5 2. Ke3 *" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /doesn't name White's model/);
    assert.equal((await post("/api/games/import", {})).status, 400);
  });

  it("rejects cross-site requests and foreign Host headers", async () => {
    const crossSite = await post("/api/games", { timeControl: "5+3", players: [CLAUDE, GPT] }, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    const form = await fetch(`${base}/api/games`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415);
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/setup`, { headers: { host: "evil.example:3000" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe("tournament API", () => {
  let dir: string;
  let base: string;
  let close: () => void;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    const server = createServer(new GameService(new GameStore(dir), (spec) => new FoolsMatePlayer(spec)), { providers, loopbackOnly: true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });

  after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const OPUS = { provider: "anthropic", model: "claude-opus" };

  it("validates new tournaments", async () => {
    const cases: [unknown, RegExp][] = [
      [{ players: [CLAUDE, GPT, OPUS] }, /timeControl/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT] }, /at least 3 players/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT, { ...GPT }] }, /gpt-test is listed twice/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT, { provider: "bard", model: "x" }] }, /Player 3: unknown provider/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT, { provider: "openai", model: "" }] }, /Player 3: pick a model/],
      [{ timeControl: "5+3", players: [CLAUDE, GPT, OPUS], name: "x".repeat(81) }, /80 characters/],
      [{ timeControl: "5+3", players: "all" }, /players must list/],
    ];
    for (const [body, error] of cases) {
      const res = await post("/api/tournaments", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, error);
    }
  });

  it("runs a tournament, lists it and shows its table and games", async () => {
    const res = await post("/api/tournaments", { name: "Autumn\n cup", timeControl: "3+2", players: [CLAUDE, GPT, OPUS] });
    assert.equal(res.status, 201);
    const { tournament } = await res.json();
    assert.equal(tournament.name, "Autumn cup");
    assert.equal(tournament.rounds.length, 3);

    let view;
    for (let i = 0; i < 100; i++) {
      view = await (await fetch(`${base}/api/tournaments/${tournament.id}`)).json();
      if (view.tournament.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(view.tournament.status, "finished");
    assert.equal(view.round, null);
    assert.equal(view.standings.length, 3);
    assert.deepEqual(view.standings.map((s: { points: number }) => s.points), [1, 1, 1]);
    const ids = view.tournament.rounds.map((r: { games: { gameId: string }[] }) => r.games[0].gameId);
    assert.deepEqual(Object.keys(view.games).sort(), [...ids].sort());
    assert.deepEqual(view.games[ids[1]].tournament, { id: tournament.id, name: "Autumn cup", round: 2 });

    const pgn = await (await fetch(`${base}/api/games/${ids[1]}/pgn`)).text();
    assert.match(pgn, /\[Event "Autumn cup"\]/);
    assert.match(pgn, /\[Round "2"\]/);
    const { game } = await (await fetch(`${base}/api/games/${ids[1]}`)).json();
    assert.equal(game.tournament.round, 2);

    const blitz = (await (await fetch(`${base}/api/ratings`)).json()).categories.blitz;
    assert.equal(blitz.length, 3, "the tournament's games are rated");

    const list = await (await fetch(`${base}/api/tournaments`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].gamesPlayed, 3);
    assert.equal(list[0].category, "blitz");
    assert.equal((await post(`/api/tournaments/${tournament.id}/abort`, {})).status, 409);
    assert.equal((await fetch(`${base}/api/tournaments/nope`)).status, 404);
  });
});

describe("accuracy and illegal moves API", () => {
  let dir: string;
  let base: string;
  let close: () => void;
  let games: GameService;
  let analysis: AnalysisService;
  /** A model that tries one illegal move. */
  const SLOPPY: PlayerSpec = { provider: "anthropic", model: "claude-sloppy" };
  /** Holds the engine's searches while set. */
  let hold: Promise<void> | null = null;
  let release = () => {};
  /** Holds the players' moves while set. */
  let moves: Promise<void> | null = null;
  let play = () => {};
  const engine: Engine = {
    name: "Fake Stockfish",
    async newGame() {},
    async search(_fen, moves): Promise<SearchResult> {
      await hold;
      // Level, until Black can mate after 1. f3 e5 2. g4.
      if (moves.length === 3) return { score: { mate: 1 }, best: "d8h4", depth: 12 };
      return { score: { cp: 0 }, best: moves.length % 2 ? "a7a6" : "a2a3", depth: 12 };
    },
    quit() {},
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    games = new GameService(new GameStore(dir), (spec) =>
      // Tries 2. Qh5 before 2. g4.
      spec.model === SLOPPY.model ? new ScriptedPlayer(spec, ["f3", "Qh5", "g4"]) : new FoolsMatePlayer(spec, async () => void (await moves)),
    );
    analysis = new AnalysisService(games, { depth: 12 }, { startEngine: async () => engine });
    analysis.start();
    const server = createServer(games, { providers, loopbackOnly: true, analysis });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });

  after(() => {
    release();
    play();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** The events a stream sends, parsed, as they arrive. */
  async function* events(url: string) {
    const reader = (await fetch(`${base}${url}`)).body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (chunk.startsWith("data: ")) yield JSON.parse(chunk.slice(6));
        }
      }
    } finally {
      await reader.cancel();
    }
  }

  it("streams a game, then its analysis, then shows each model's accuracy by time control", async () => {
    hold = new Promise((resolve) => (release = resolve));
    moves = new Promise((resolve) => (play = resolve));
    const { game } = await (await post("/api/games", { timeControl: "3+2", players: [CLAUDE, GPT], firstPlayerColor: "white" })).json();

    const seen: string[] = [];
    let final;
    for await (const event of events(`/api/games/${game.id}/events`)) {
      if (event.game.status === "running") {
        assert.equal(event.analysis, null, "nothing is analyzed while the game is played");
        play();
        continue;
      }
      const { status, progress } = event.analysis;
      if (!seen.length) {
        // The game's last update already says Stockfish is on it, so the page knows to keep listening.
        assert.equal(event.game.result, "0-1");
        const data = await (await fetch(`${base}/api/games/${game.id}`)).json();
        assert.deepEqual(data.analysis, { status: "analyzing", progress: { done: 0, total: 5 } });
        assert.equal((await (await fetch(`${base}/api/ratings`)).json()).analysis.pending, 1);
        release();
      }
      seen.push(progress ? `${status} ${progress.done}/${progress.total}` : status);
      if (status === "done") {
        final = event.analysis;
        break;
      }
    }
    assert.deepEqual(
      seen.filter((e, i) => e !== seen[i - 1]),
      ["queued", "analyzing 0/5", "analyzing 1/5", "analyzing 2/5", "analyzing 3/5", "analyzing 4/5", "analyzing 5/5", "done"],
    );
    assert.equal(final.engine, "Fake Stockfish");
    assert.equal(final.depth, 12);
    assert.deepEqual(
      final.moves.map((m: { san?: string; judgement: string | null; bestSan?: string }) => [m.judgement, m.bestSan ?? null]),
      [
        [null, "a3"],
        [null, "a6"],
        ["blunder", "a3"],
        [null, null],
      ],
    );
    assert.ok(final.white.accuracy < final.black.accuracy);

    const ratings = await (await fetch(`${base}/api/ratings`)).json();
    assert.deepEqual(ratings.analysis, { depth: 12, pending: 0 });
    const blitz = Object.fromEntries(
      ratings.categories.blitz.map((m: { model: string; accuracy: unknown; illegalMoves: unknown }) => [m.model, [m.accuracy, m.illegalMoves]]),
    );
    assert.deepEqual(blitz, {
      "claude-test": [{ accuracy: final.white.accuracy, games: 1 }, { games: 1, illegal: 0, tried: 2, percent: 0 }],
      "gpt-test": [{ accuracy: final.black.accuracy, games: 1 }, { games: 1, illegal: 0, tried: 2, percent: 0 }],
    });
  });

  it("gives the tournament standings each model's accuracy in its games", async () => {
    const OPUS = { provider: "anthropic", model: "claude-opus" };
    const { tournament } = await (await post("/api/tournaments", { timeControl: "1+0", players: [CLAUDE, GPT, OPUS] })).json();
    let view;
    for (let i = 0; i < 100; i++) {
      view = await (await fetch(`${base}/api/tournaments/${tournament.id}`)).json();
      if (view.tournament.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(view.tournament.status, "finished");
    await analysis.whenIdle();
    view = await (await fetch(`${base}/api/tournaments/${tournament.id}`)).json();
    assert.deepEqual(view.analysis, { depth: 12, pending: 0 });
    for (const row of view.standings) {
      assert.equal(row.accuracy.games, 2, `${row.model} played two games`);
      assert.deepEqual(row.illegalMoves, { games: 2, illegal: 0, tried: 4, percent: 0 });
    }
    // Each model won its game as Black with every move as good as the engine's, and lost the other.
    const bullet = (await (await fetch(`${base}/api/ratings`)).json()).categories.bullet;
    for (const row of view.standings) {
      assert.equal(row.accuracy.accuracy, bullet.find((m: { model: string }) => m.model === row.model).accuracy.accuracy);
    }
  });

  it("counts each model's illegal moves by time control and over every time control", async () => {
    const started = games.start({ timeControl: "10+0", players: [SLOPPY, GPT], firstPlayerColor: "white" });
    const game = (await games.wait(started.id))!;
    assert.deepEqual([game.result, game.illegalMoves], ["0-1", { white: 1, black: 0 }]);
    await analysis.whenIdle();

    const ratings = await (await fetch(`${base}/api/ratings`)).json();
    const rapid = Object.fromEntries(ratings.categories.rapid.map((m: { model: string; illegalMoves: unknown }) => [m.model, m.illegalMoves]));
    assert.deepEqual(rapid, {
      "claude-sloppy": { games: 1, illegal: 1, tried: 3, percent: 100 / 3 },
      "gpt-test": { games: 1, illegal: 0, tried: 2, percent: 0 },
    });
    // The blitz game, the tournament's bullet games and this one, most games first.
    const overall = ratings.overall as { model: string; games: number; illegalMoves: { illegal: number; tried: number }; accuracy?: { games: number } }[];
    assert.deepEqual(
      overall.map((m) => [m.model, m.games, m.illegalMoves.illegal, m.illegalMoves.tried, m.accuracy?.games]),
      [
        ["gpt-test", 4, 0, 8, 4],
        ["claude-test", 3, 0, 6, 3],
        ["claude-opus", 2, 0, 4, 2],
        ["claude-sloppy", 1, 1, 3, 1],
      ],
    );
  });
});
