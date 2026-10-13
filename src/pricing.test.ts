import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configFromIni, parseIni } from "./config.js";
import { addSpend, costOf, emptySpend, findPrice, formatUsd, spendOf } from "./pricing.js";

describe("pricing", () => {
  it("finds built-in prices, config overrides, and dated snapshots", () => {
    assert.deepEqual(findPrice("claude-opus-5-5"), { input: 4, output: 20, cachedInput: 0.2 });
    assert.deepEqual(findPrice("Claude-Sonnet-5-5"), { input: 2, output: 10, cachedInput: 0.2 });
    assert.equal(findPrice("gpt-5.6-luna")?.output, 1.2);
    assert.deepEqual(findPrice("claude-opus-5-5", { "claude-opus-5-5": { input: 1, output: 2 } }), { input: 1, output: 2 });
    assert.equal(findPrice("claude-haiku-4-5-20251001")?.input, 1);
    assert.equal(findPrice("gpt-5.6-terra-2026-07-09")?.input, 2);
    assert.equal(findPrice("my-model"), undefined);
    assert.deepEqual(findPrice("my-model", { "my-model": { input: 3, output: 4 } }), { input: 3, output: 4 });
  });

  it("prices plain, cached and cache-write input tokens and output tokens", () => {
    const price = { input: 4, output: 20, cachedInput: 0.2 };
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 500_000 };
    assert.equal(costOf(usage, price), 4 + 10);
    assert.equal(costOf({ ...usage, cachedInputTokens: 400_000 }, price), 600_000 * 4e-6 + 400_000 * 0.2e-6 + 10);
    assert.equal(costOf({ ...usage, cacheWriteTokens: 200_000 }, price), 800_000 * 4e-6 + 200_000 * 5e-6 + 10);
    // Without a cached price, cached tokens cost the full input price.
    assert.equal(costOf({ ...usage, cachedInputTokens: 400_000 }, { input: 4, output: 20 }), 14);
  });

  it("adds up spend, with unknown costs staying unknown", () => {
    const known = spendOf({ inputTokens: 1200, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 300 }, { input: 2, output: 10 });
    assert.deepEqual(known, { calls: 1, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, costUsd: 0.0054 });
    const unpriced = spendOf({ inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, undefined);
    assert.equal(unpriced.costUsd, null);
    assert.equal(spendOf(undefined, { input: 1, output: 1 }).costUsd, null, "no usage report means unknown cost");
    const total = addSpend(addSpend(emptySpend(), known), known);
    assert.equal(total.calls, 2);
    assert.equal(total.inputTokens, 2400);
    assert.ok(Math.abs(total.costUsd! - 0.0108) < 1e-12);
    assert.equal(addSpend(total, unpriced).costUsd, null);
  });

  it("formats dollars", () => {
    assert.equal(formatUsd(0.004213), "$0.0042");
    assert.equal(formatUsd(0.127), "$0.13");
    assert.equal(formatUsd(12.4), "$12.40");
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(null), "unknown");
  });

  it("reads prices from config.ini", () => {
    const config = configFromIni(
      parseIni("[anthropic]\napi_key = k\n[prices]\nGPT-5.6-Sol = 4, 20, 0.4\nmy-model = $1.25, $10\n"),
    );
    assert.deepEqual(config.prices, {
      "gpt-5.6-sol": { input: 4, output: 20, cachedInput: 0.4 },
      "my-model": { input: 1.25, output: 10 },
    });
    assert.deepEqual(configFromIni(parseIni("[openai]\napi_key = k\n")).prices, {});
    for (const bad of ["1", "1, 2, 3, 4", "a, b", "-1, 2"]) {
      assert.throws(() => configFromIni(parseIni(`[openai]\napi_key = k\n[prices]\nm = ${bad}\n`)), /\[prices\] m/, bad);
    }
  });
});
