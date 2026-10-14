import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GameService } from "../game/service.js";
import { GameStore } from "../game/store.js";
import { OutOfFundsError, type Player, type PlayerSpec } from "../game/types.js";
import { createGameRecord } from "../game/game.js";
import { FoolsMatePlayer } from "../testing.js";
import { parseTimeControl } from "../timeControl.js";
import { roundRobin } from "./schedule.js";
import { TournamentService } from "./service.js";
import type { TournamentRecord } from "./tournament.js";

const spec = (model: string): PlayerSpec => ({ provider: model.startsWith("gpt") ? "openai" : "anthropic", model });
const A = spec("claude-a");
const B = spec("claude-b");
const C = spec("gpt-c");
const D = spec("gpt-d");
const E = spec("claude-e");

/** Lets the test hold every move until it opens the gate. */
class Gate {
  private wait: Promise<void> = Promise.resolve();
  private release = () => {};
  close() {
    this.wait = new Promise((resolve) => (this.release = resolve));
  }
  open() {
    this.release();
    this.wait = Promise.resolve();
  }
  pass = () => this.wait;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("tournaments", () => {
  let dir: string;
  let gate: Gate;
  /** Models whose next move fails as if their account had run out of funds. */
  let broke: Set<string>;
  let games: GameService;
  let tournaments: TournamentService;
  const makePlayer = (p: PlayerSpec): Player => {
    if (p.model === "broken") throw new Error("config.ini has no API key for openai.");
    return new FoolsMatePlayer(p, async () => {
      await gate.pass();
      if (broke.has(p.model)) throw new OutOfFundsError("Your credit balance is too low");
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "botwinnik-"));
    gate = new Gate();
    broke = new Set();
    games = new GameService(new GameStore(dir), makePlayer);
    // Pairing numbers in the order given.
    tournaments = new TournamentService(games, { random: () => 0.999 });
  });

  afterEach(() => {
    gate.open();
    rmSync(dir, { recursive: true, force: true });
  });

  it("plays a round-robin where one player rests each round, and the games count for the ratings", async () => {
    const created = tournaments.create({ timeControl: "5+3", players: [A, B, C] });
    assert.equal(created.name, "Blitz round robin");
    assert.deepEqual(created.players, [A, B, C]);
    assert.deepEqual(
      created.rounds.map((r) => [r.games.map((g) => [g.white, g.black]), r.bye]),
      [
        [[[1, 2]], 0],
        [[[0, 1]], 2],
        [[[2, 0]], 1],
      ],
    );
    const final = await tournaments.wait(created.id);
    assert.equal(final?.status, "finished");
    assert.ok(final?.finishedAt);

    const played = final!.rounds.map((r) => games.get(r.games[0].gameId!)!);
    assert.deepEqual(
      played.map((g) => [g.white.model, g.black.model, g.result, g.tournament]),
      [
        ["claude-b", "gpt-c", "0-1", { id: created.id, name: "Blitz round robin", round: 1 }],
        ["claude-a", "claude-b", "0-1", { id: created.id, name: "Blitz round robin", round: 2 }],
        ["gpt-c", "claude-a", "0-1", { id: created.id, name: "Blitz round robin", round: 3 }],
      ],
    );
    // The rounds were played one after the other.
    assert.ok(played[0].finishedAt! <= played[1].createdAt && played[1].finishedAt! <= played[2].createdAt);

    const blitz = games.ratings().table("blitz");
    assert.deepEqual(blitz.map((m) => [m.model, m.games]).sort(), [["claude-a", 2], ["claude-b", 2], ["gpt-c", 2]]);

    const view = tournaments.view(created.id)!;
    assert.equal(view.round, null);
    assert.deepEqual(Object.keys(view.games).sort(), played.map((g) => g.id).sort());
    assert.deepEqual(view.standings.map((s) => [s.points, s.played]), [[1, 2], [1, 2], [1, 2]]);
    for (const s of view.standings) {
      assert.equal(s.rating?.now, blitz.find((m) => m.model === s.model)?.rating);
      assert.equal(s.rating!.now - 1500, s.rating!.change, "every rated game was in the tournament");
    }

    const [summary] = tournaments.list();
    assert.equal(summary.id, created.id);
    assert.equal(summary.gamesPlayed, 3);
    assert.equal(summary.gamesTotal, 3);
    assert.equal(summary.round, null);
    assert.equal(summary.leaders.length, 3);
    assert.ok(Math.abs(summary.costUsd! - 0.12) < 1e-9, "four moves at $0.01 a game");
  });

  it("plays a round's games at the same time and starts the next round when they're all over", async () => {
    gate.close();
    const created = tournaments.create({ name: "  Cup  ", timeControl: "10+0", players: [A, B, C, D] });
    assert.equal(created.name, "Cup");
    await tick();
    let view = tournaments.view(created.id)!;
    assert.equal(view.round, 1);
    const first = view.tournament.rounds[0].games.map((p) => view.games[p.gameId!]);
    assert.deepEqual(first.map((g) => g.status), ["running", "running"]);
    assert.ok(view.tournament.rounds[1].games.every((p) => !p.gameId), "round 2 waits");
    assert.equal(tournaments.list()[0].round, 1);

    // One game of round 1 ends; round 2 still waits for the other.
    games.abort(first[0].id);
    await tick();
    view = tournaments.view(created.id)!;
    assert.equal(view.round, 1);
    assert.ok(view.tournament.rounds[1].games.every((p) => !p.gameId));

    gate.open();
    const final = await tournaments.wait(created.id);
    assert.equal(final?.status, "finished");
    view = tournaments.view(created.id)!;
    // The aborted game scores for nobody; Black won the other five.
    assert.equal(view.standings.reduce((sum, s) => sum + s.played, 0), 10);
    assert.equal(view.standings.reduce((sum, s) => sum + s.points, 0), 5);
    assert.equal(tournaments.list()[0].gamesPlayed, 5);
  });

  it("waits for a paused game to be resumed", async () => {
    broke.add("gpt-c");
    const created = tournaments.create({ timeControl: "5+3", players: [A, B, C] });
    const firstGame = created.rounds[0].games[0].gameId!; // claude-b vs gpt-c
    assert.equal((await games.wait(firstGame))?.status, "paused");
    await tick();
    assert.equal(tournaments.view(created.id)!.round, 1);
    assert.ok(!created.rounds[1].games[0].gameId);

    broke.clear();
    games.resume(firstGame);
    assert.equal((await tournaments.wait(created.id))?.status, "finished");
    assert.equal(games.get(firstGame)?.result, "0-1");
  });

  it("aborts a tournament and its games in progress", async () => {
    gate.close();
    const created = tournaments.create({ timeControl: "5+3", players: [A, B, C, D, E] });
    await tick();
    const live = created.rounds[0].games.map((p) => p.gameId!);
    assert.equal(live.length, 2);
    assert.ok(tournaments.abort(created.id));
    assert.ok(!tournaments.abort(created.id));
    const final = await tournaments.wait(created.id);
    assert.equal(final?.status, "aborted");
    assert.equal(final?.message, "Aborted by the admin.");
    assert.deepEqual(live.map((id) => games.get(id)?.status), ["aborted", "aborted"]);
    gate.open();
    await tick();
    assert.ok(tournaments.get(created.id)!.rounds[1].games.every((p) => !p.gameId), "no more rounds start");
    assert.equal(tournaments.store.load(created.id)?.status, "aborted");
  });

  it("stops when a game can't start", async () => {
    const created = tournaments.create({ timeControl: "5+3", players: [A, B, { provider: "openai", model: "broken" }] });
    assert.equal(created.status, "aborted");
    assert.match(created.message ?? "", /couldn't start\. config\.ini has no API key/);
  });

  it("carries on after a restart, with a paused game holding its round", async () => {
    // What a run that stopped during round 1 left on disk: one game over, the other paused.
    const created: TournamentRecord = {
      version: 1,
      id: "cup",
      name: "Cup",
      status: "running",
      createdAt: new Date().toISOString(),
      timeControl: { baseMs: 300_000, incrementMs: 3000, label: "5+3", category: "blitz" },
      players: [A, B, C, D],
      rounds: roundRobin(4).map(({ pairs, bye }) => ({ games: pairs.map(([white, black]) => ({ white, black })), bye })),
    };
    const [over, paused] = created.rounds[0].games.map((pairing, i) => {
      const game = createGameRecord({
        id: games.store.newId(),
        timeControl: parseTimeControl("5+3"),
        white: created.players[pairing.white],
        black: created.players[pairing.black],
        colorsAssigned: "manual",
        tournament: { id: "cup", name: "Cup", round: 1 },
      });
      if (i === 0) Object.assign(game, { status: "finished", result: "1/2-1/2", finishedAt: new Date().toISOString() });
      else game.status = "paused";
      games.store.save(game);
      return (pairing.gameId = game.id);
    });
    tournaments.store.save(created);

    assert.equal(tournaments.resumeRunning(), 1);
    await tick();
    assert.equal(tournaments.view("cup")!.round, 1);
    assert.ok(tournaments.get("cup")!.rounds[1].games.every((p) => !p.gameId), "round 2 waits for the paused game");

    games.resume(paused);
    const final = await tournaments.wait("cup");
    assert.equal(final?.status, "finished");
    assert.deepEqual(final!.rounds[0].games.map((p) => p.gameId), [over, paused]);
    const view = tournaments.view("cup")!;
    assert.equal(Object.keys(view.games).length, 6);
    assert.equal(view.standings.reduce((sum, s) => sum + s.points, 0), 6);
    assert.equal(tournaments.resumeRunning(), 0);
  });

  it("checks the players", () => {
    assert.throws(() => tournaments.create({ timeControl: "5+3", players: [A, B] }), /at least 3 players/);
    assert.throws(
      () => tournaments.create({ timeControl: "5+3", players: [A, B, { ...A, model: "Claude-A" }] }),
      /Claude-A is listed twice/,
    );
    const many = Array.from({ length: 21 }, (_, i) => spec(`claude-${i}`));
    assert.throws(() => tournaments.create({ timeControl: "5+3", players: many }), /at most 20 players/);
    assert.throws(() => tournaments.create({ timeControl: "5:3", players: [A, B, C] }), /Invalid time control/);
    assert.deepEqual(tournaments.list(), []);
  });

  it("draws the pairing numbers at random", async () => {
    const shuffled = new TournamentService(games, { random: () => 0 });
    const created = shuffled.create({ timeControl: "5+3", players: [A, B, C] });
    assert.deepEqual(created.players, [B, C, A]);
    shuffled.abort(created.id);
    await games.wait(created.rounds[0].games[0].gameId!);
  });
});
