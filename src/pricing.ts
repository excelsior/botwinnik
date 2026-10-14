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
 * Standard (non-batch, short-context) API prices, as of October 2026.
 * Claude prices are Anthropic's list prices. The GPT-5.6 prices come from
 * third-party listings of OpenAI's pricing after its July 30, 2026 price cut,
 * not from OpenAI's own page; override them in config.ini under [prices].
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
};

/**
 * The price for a model: config.ini first, then the built-in table. Dated
 * snapshot IDs ("claude-x-20260101", "gpt-x-2026-01-01") fall back to their
 * base model's price.
 */
export function findPrice(model: string, overrides: Record<string, ModelPrice> = {}): ModelPrice | undefined {
  const id = model.trim().toLowerCase();
  const base = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return overrides[id] ?? BUILT_IN_PRICES[id] ?? overrides[base] ?? BUILT_IN_PRICES[base];
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
