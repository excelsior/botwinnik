import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { ConfigError, configFromIni, parseIni, parsePlayerSpec } from "./config.js";
import { formatMoveList, hasOnlyKing, resolveMove } from "./game/moves.js";
import {
  formatClock,
  illegalMoveBonusMs,
  parseTimeControl,
  pgnClock,
  pgnTimeControl,
  timeCategory,
  timeControlLabel,
} from "./timeControl.js";

describe("time controls", () => {
  it("parses minutes+increment", () => {
    assert.deepEqual(parseTimeControl("5+3"), { baseMs: 300_000, incrementMs: 3000 });
    assert.deepEqual(parseTimeControl(" 10 + 0 "), { baseMs: 600_000, incrementMs: 0 });
    assert.deepEqual(parseTimeControl("15"), { baseMs: 900_000, incrementMs: 0 });
    assert.deepEqual(parseTimeControl("0.5+1"), { baseMs: 30_000, incrementMs: 1000 });
    assert.throws(() => parseTimeControl("5:3"));
    assert.throws(() => parseTimeControl("0+5"));
    assert.throws(() => parseTimeControl("abc"));
  });

  it("labels and exports them", () => {
    assert.equal(timeControlLabel(parseTimeControl("5+3")), "5+3");
    assert.equal(timeControlLabel(parseTimeControl("0.5+0")), "0.5+0");
    assert.equal(pgnTimeControl(parseTimeControl("5+3")), "300+3");
  });

  it("categorizes by base + 60 × increment", () => {
    const cat = (s: string) => timeCategory(parseTimeControl(s));
    assert.equal(cat("1+0"), "bullet");
    assert.equal(cat("2+1"), "blitz"); // 2 + 1 = 3 minutes
    assert.equal(cat("3+2"), "blitz");
    assert.equal(cat("5+3"), "blitz"); // 5 + 3 = 8 minutes
    assert.equal(cat("9+0"), "blitz");
    assert.equal(cat("10+0"), "rapid");
    assert.equal(cat("10+5"), "rapid");
    assert.equal(cat("15+10"), "rapid");
    assert.equal(cat("45+0"), "rapid");
    assert.equal(cat("30+30"), "classical"); // 30 + 30 = 60 minutes
    assert.equal(cat("60+0"), "classical");
    assert.equal(cat("90+30"), "classical");
  });

  it("gives two minutes for illegal moves only in classical", () => {
    assert.equal(illegalMoveBonusMs(parseTimeControl("1+0")), 60_000);
    assert.equal(illegalMoveBonusMs(parseTimeControl("5+3")), 60_000);
    assert.equal(illegalMoveBonusMs(parseTimeControl("15+10")), 60_000);
    assert.equal(illegalMoveBonusMs(parseTimeControl("90+30")), 120_000);
  });

  it("formats clocks", () => {
    assert.equal(formatClock(300_000), "5:00");
    assert.equal(formatClock(61_999), "1:01");
    assert.equal(formatClock(3_900_000), "1:05:00");
    assert.equal(formatClock(7_350), "0:07.3");
    assert.equal(formatClock(-5), "0:00.0");
    assert.equal(pgnClock(301_400), "0:05:01");
  });
});

describe("moves", () => {
  const start = new Chess().fen();

  it("accepts SAN and coordinate notation", () => {
    for (const text of ["e4", "e2e4", "e2-e4", "1. e4", "e4!", " e4 "]) {
      assert.equal(resolveMove(start, text)?.san, "e4", text);
    }
    assert.equal(resolveMove(start, "Nf3+")?.san, "Nf3", "a spurious check mark is tolerated");
  });

  it("handles castling and promotion spellings", () => {
    const castle = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    assert.equal(resolveMove(castle, "O-O")?.san, "O-O");
    assert.equal(resolveMove(castle, "0-0")?.san, "O-O");
    assert.equal(resolveMove(castle, "0-0-0")?.san, "O-O-O");
    assert.equal(resolveMove(castle, "e1g1")?.san, "O-O");
    const promo = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    for (const text of ["a8=Q", "a8Q", "a7a8q", "a7-a8=Q"]) {
      assert.equal(resolveMove(promo, text)?.lan, "a7a8q", text);
    }
  });

  it("rejects illegal and unreadable moves", () => {
    for (const text of ["Ke2", "e5", "Nd2", "e2e5", "castle", "", "Qxf7"]) {
      assert.equal(resolveMove(start, text), null, text);
    }
  });

  it("formats move lists", () => {
    assert.equal(formatMoveList(["e4", "e5", "Nf3"], start), "1. e4 e5 2. Nf3");
    const blackFirst = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    assert.equal(formatMoveList(["e5", "Nf3"], blackFirst), "1... e5 2. Nf3");
  });

  it("detects a lone king", () => {
    const chess = new Chess("4k3/8/8/8/8/8/r7/4K3 w - - 0 1");
    assert.equal(hasOnlyKing(chess, "w"), true);
    assert.equal(hasOnlyKing(chess, "b"), false);
  });
});

describe("config", () => {
  it("parses INI sections, comments and quotes", () => {
    const ini = parseIni("; comment\n# another\n[OpenAI]\napi_key = \"sk-1\"\nmodels = a, b\n\n[app]\nport=4000\n");
    assert.deepEqual(ini.openai, { api_key: "sk-1", models: "a, b" });
    assert.equal(ini.app.port, "4000");
    assert.throws(() => parseIni("[a]\nnot a pair"), ConfigError);
    const inline = parseIni("[openai]\nmodels = a, b ; suggestions\neffort = # none\napi_key = \"x ; y\"\n");
    assert.deepEqual(inline.openai, { models: "a, b", effort: "", api_key: "x ; y" });
  });

  it("requires at least one API key", () => {
    assert.throws(
      () => configFromIni(parseIni("[openai]\napi_key =\n[anthropic]\n")),
      /at least one API key: set api_key under \[openai\], \[anthropic\], \[google\] or \[xai\]/,
    );
    const gemini = configFromIni(parseIni("[google]\napi_key = AIza-test\n[xai]\napi_key = xai-test\neffort = low\n"));
    assert.deepEqual(Object.keys(gemini.providers), ["google", "xai"]);
    assert.equal(gemini.providers.xai!.effort, "low");
    const config = configFromIni(parseIni("[anthropic]\napi_key = sk-ant\n"), "/srv");
    assert.deepEqual(Object.keys(config.providers), ["anthropic"]);
    assert.ok(config.providers.anthropic!.models.length > 0, "default models are filled in");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.gamesDir, "/srv/games");
  });

  it("reads models, effort and app settings", () => {
    const config = configFromIni(
      parseIni("[openai]\napi_key=k\nmodels=gpt-x, gpt-y\neffort=low\n[app]\nhost=0.0.0.0\nport=8080\ngames_dir=/data/games\n"),
    );
    assert.deepEqual(config.providers.openai, { apiKey: "k", models: ["gpt-x", "gpt-y"], effort: "low" });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 8080);
    assert.equal(config.gamesDir, "/data/games");
    assert.throws(() => configFromIni(parseIni("[openai]\napi_key=k\n[app]\nport=abc\n")), /port/);
  });

  it("parses player specs", () => {
    assert.deepEqual(parsePlayerSpec("claude-opus-5-5"), { provider: "anthropic", model: "claude-opus-5-5" });
    assert.deepEqual(parsePlayerSpec("gpt-5.6-sol"), { provider: "openai", model: "gpt-5.6-sol" });
    assert.deepEqual(parsePlayerSpec("openai:my-model"), { provider: "openai", model: "my-model" });
    assert.deepEqual(parsePlayerSpec("claude:claude-x"), { provider: "anthropic", model: "claude-x" });
    assert.deepEqual(parsePlayerSpec("gemini-3-pro"), { provider: "google", model: "gemini-3-pro" });
    assert.deepEqual(parsePlayerSpec("grok-4"), { provider: "xai", model: "grok-4" });
    assert.deepEqual(parsePlayerSpec("gemini:my-tuned-model"), { provider: "google", model: "my-tuned-model" });
    assert.deepEqual(parsePlayerSpec("xai:grok-x"), { provider: "xai", model: "grok-x" });
    assert.throws(() => parsePlayerSpec("mystery-model"), /provider/);
    assert.throws(() => parsePlayerSpec("bard:x"), /Unknown provider/);
  });
});
