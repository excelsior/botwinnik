import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configFromIni, parseIni } from "./config.js";
import { addSpend, costOf, emptySpend, findPrice, formatUsd, priceSpend, spendOf } from "./pricing.js";

describe("pricing", () => {
  it("finds built-in prices, config overrides, and dated snapshots", () => {
    assert.deepEqual(findPrice("claude-opus-5-5"), { input: 4, output: 20, cachedInput: 0.2 });
    assert.deepEqual(findPrice("Claude-Sonnet-5-5"), { input: 2, output: 10, cachedInput: 0.1 });
    assert.equal(findPrice("gpt-5.6-luna")?.output, 1.2);
    assert.deepEqual(findPrice("claude-opus-5-5", { "claude-opus-5-5": { input: 1, output: 2 } }), { input: 1, output: 2 });
    assert.equal(findPrice("claude-haiku-4-5-20251001")?.input, 1);
    assert.equal(findPrice("gpt-5.6-terra-2026-07-09")?.input, 2);
    assert.equal(findPrice("my-model"), undefined);
    assert.deepEqual(findPrice("my-model", { "my-model": { input: 3, output: 4 } }), { input: 3, output: 4 });
    assert.equal(findPrice("grok-4.7")?.output, 6);
    assert.equal(findPrice("models/gemini-2.5-pro")?.input, 1.25);
  });

  it("switches to a built-in price on the day it changes", () => {
    const flash = (iso: string) => findPrice("gemini-3.8-flash", {}, new Date(iso));
    assert.deepEqual(flash("2026-12-31T23:59:59Z"), { input: 0.75, output: 3.75, cachedInput: 0.075 });
    assert.deepEqual(flash("2027-01-01T00:00:00Z"), { input: 1.5, output: 7.5, cachedInput: 0.15 });
    // config.ini still wins.
    assert.equal(findPrice("gemini-3.8-flash", { "gemini-3.8-flash": { input: 1, output: 1 } }, new Date("2027-06-01"))?.input, 1);
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

  it("prices a spend saved with an unknown cost once its model has a price", () => {
    const price = { input: 2, output: 10, cachedInput: 0.5 };
    const unpriced = { calls: 2, inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 400, costUsd: null };
    assert.deepEqual(priceSpend(unpriced, price), { ...unpriced, costUsd: (2000 * 2 + 1000 * 0.5 + 400 * 10) / 1e6 });
    assert.equal(priceSpend(unpriced, undefined).costUsd, null);
    const known = { ...unpriced, costUsd: 0.5 };
    assert.equal(priceSpend(known, price), known, "a cost worked out during the game stays as it was");
    assert.equal(priceSpend(spendOf(undefined, undefined), price).costUsd, null, "no usage report means unknown cost");
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
