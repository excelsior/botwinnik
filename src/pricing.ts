/** Token counts for one API call, as reported by the provider. */
export interface Usage {
  /** All prompt tokens, including any read from or written to a prompt cache. */
  inputTokens: number;
  /** Prompt tokens served from the provider's cache (billed at the cached rate). */
  cachedInputTokens: number;
  /** Prompt tokens written to Anthropic's prompt cache (billed at 1.25 × input). */
  cacheWriteTokens: number;
  /** Output tokens, including hidden reasoning/thinking tokens. */
  outputTokens: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cached prompt tokens; when unknown they are charged at the full input price. */
  cachedInput?: number;
}

/** What a set of API calls used and cost. */
export interface Spend {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** USD; null when a call's model has no known price. */
  costUsd: number | null;
}

/**
 * Standard (non-batch, short-context) API prices, as of October 2026. A
 * player's prompt stays far below the 200k-token mark where Gemini and Grok
 * charge more.
 *
 * Claude prices are Anthropic's list prices. The GPT-5.6 prices come from
 * third-party listings of OpenAI's pricing after its July 30, 2026 price cut,
 * not from OpenAI's own page. Gemini and Grok prices are from Google's and
 * xAI's pricing pages, except the Gemini ones marked as coming from LiteLLM's
 * price list. Override any of them in config.ini under [prices].
 */
export const BUILT_IN_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cachedInput: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "gpt-5.6-sol": { input: 5, output: 30, cachedInput: 0.5 },
  "gpt-5.6": { input: 5, output: 30, cachedInput: 0.5 },
  "gpt-5.6-terra": { input: 2, output: 12, cachedInput: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cachedInput: 0.075 }, // introductory, until 2027 (see PRICE_CHANGES)
  "gemini-3.1-pro-preview": { input: 2, output: 12, cachedInput: 0.2 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cachedInput: 0.05 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.01 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 }, // LiteLLM
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 }, // LiteLLM
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 }, // LiteLLM
  "gemini-2.5-flash": { input: 0.3, output: 2.5 }, // LiteLLM
  "grok-4.7": { input: 2, output: 6, cachedInput: 0.5 },
  "grok-4.6": { input: 2, output: 6, cachedInput: 0.5 },
  "grok-4.5": { input: 2, output: 6, cachedInput: 0.3 },
  "grok-4.3": { input: 1.25, output: 2.5, cachedInput: 0.2 },
  "grok-build-0.1": { input: 1, output: 2, cachedInput: 0.2 },
};

/** Built-in prices that change on a known date (UTC), and what they change to. */
export const PRICE_CHANGES: Record<string, { from: string; price: ModelPrice }> = {
  "gemini-3.8-flash": { from: "2027-01-01T00:00:00Z", price: { input: 1.5, output: 7.5, cachedInput: 0.15 } },
};

function builtInPrice(id: string, now: Date): ModelPrice | undefined {
  const change = PRICE_CHANGES[id];
  return change && now.getTime() >= Date.parse(change.from) ? change.price : BUILT_IN_PRICES[id];
}

/**
 * The price for a model at `now`: config.ini first, then the built-in table.
 * Dated snapshot IDs ("claude-x-20260101", "gpt-x-2026-01-01") fall back to
 * their base model's price, and "models/gemini-x" means "gemini-x".
 */
export function findPrice(model: string, overrides: Record<string, ModelPrice> = {}, now = new Date()): ModelPrice | undefined {
  const id = model.trim().toLowerCase().replace(/^models\//, "");
  const base = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return overrides[id] ?? builtInPrice(id, now) ?? overrides[base] ?? builtInPrice(base, now);
}

export function costOf(usage: Usage, price: ModelPrice): number {
  const cached = usage.cachedInputTokens;
  const written = usage.cacheWriteTokens;
  const plain = Math.max(0, usage.inputTokens - cached - written);
  const usd =
    plain * price.input +
    cached * (price.cachedInput ?? price.input) +
    written * price.input * 1.25 +
    usage.outputTokens * price.output;
  return usd / 1_000_000;
}

export function emptySpend(): Spend {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** The spend for one call; the cost is null when there is no usage report or no price. */
export function spendOf(usage: Usage | undefined, price: ModelPrice | undefined): Spend {
  return {
    calls: 1,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: usage && price ? costOf(usage, price) : null,
  };
}

/**
 * A spend saved with an unknown cost, priced from its token counts once its
 * model has a price. One without tokens (no usage report) stays unknown.
 * Prompt-cache writes aren't kept in a Spend, so they count as plain input.
 */
export function priceSpend(spend: Spend, price: ModelPrice | undefined): Spend {
  if (spend.costUsd !== null || !price || spend.inputTokens + spend.outputTokens === 0) return spend;
  const usage = { ...spend, cacheWriteTokens: 0 };
  return { ...spend, costUsd: costOf(usage, price) };
}

export function addSpend(a: Spend, b: Spend): Spend {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

/** "$0.0042", "$0.13", "$12.40"; "unknown" without a price. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "unknown";
  if (usd === 0) return "$0";
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
