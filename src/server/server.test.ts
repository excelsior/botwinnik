import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { assignColors, GameService } from "../game/service.js";
import { GameStore } from "../game/store.js";
import { createGameRecord } from "../game/game.js";
import { OutOfFundsError, type PlayerSpec } from "../game/types.js";
import { callSpend, CLAUDE, GPT, ScriptedPlayer } from "../testing.js";
import { parseTimeControl } from "../timeControl.js";
import { createServer } from "./server.js";

const providers = {
  anthropic: { apiKey: "k", models: ["claude-test"] },
  openai: { apiKey: "k", models: ["gpt-test"] },
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

  it("saves games and marks ones interrupted by a restart as aborted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    try {
      const store = new GameStore(dir);
      const stale = createGameRecord({ id: store.newId(), timeControl: parseTimeControl("5+3"), white: CLAUDE, black: GPT, colorsAssigned: "manual" });
      store.save(stale);
      const service = new GameService(store, foolsMatePlayers);
      assert.equal(service.recoverInterrupted(), 1);
      assert.equal(store.load(stale.id)?.status, "aborted");

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

    let final;
    for (let i = 0; i < 50; i++) {
      final = (await (await fetch(`${base}/api/games/${game.id}`)).json()).game;
      if (final.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(final.result, "0-1");

    const events = await fetch(`${base}/api/games/${game.id}/events`);
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(first, /^data: \{"game":\{/);

    const pgn = await fetch(`${base}/api/games/${game.id}/pgn`);
    assert.equal(pgn.status, 200);
    assert.match(pgn.headers.get("content-disposition") ?? "", /attachment; filename="botwinnik-.*\.pgn"/);
    assert.match(await pgn.text(), /\[Result "0-1"\]/);

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
