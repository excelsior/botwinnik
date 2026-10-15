import type { Provider } from "../config.js";
import { TIME_CATEGORIES, type TimeCategory } from "../timeControl.js";

/** The effort for each time category; undefined leaves it to the model's default. */
export type EffortByCategory = Record<TimeCategory, string | undefined>;

/** Built in: the faster the game, the less the models think. */
export const DEFAULT_EFFORT: EffortByCategory = { bullet: "low", blitz: "medium", rapid: "high", classical: "max" };

/**
 * Each API's effort levels, lowest first. "max" means the highest level the
 * API has, so it works everywhere; which levels a given model takes still
 * varies (see effortCandidates).
 */
export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"], // reasoning.effort
  anthropic: ["low", "medium", "high", "xhigh", "max"], // output_config.effort
  google: ["minimal", "low", "medium", "high"], // thinkingLevel, Gemini 3 and later
  xai: ["low", "medium", "high"], // reasoning_effort
};

/**
 * Reads a provider's `effort` setting: empty for the built-in levels, one
 * level for every game, or four (bullet, blitz, rapid, classical), where
 * "default" leaves a category to the model's default. Throws a message for
 * the admin when it can't.
 */
export function parseEffort(provider: Provider, value: string | undefined): EffortByCategory {
  const words = (value ?? "").split(",").map((w) => w.trim().toLowerCase());
  if (words.length === 1 && words[0] === "") return { ...DEFAULT_EFFORT };
  if (words.length !== 1 && words.length !== TIME_CATEGORIES.length) {
    throw new Error(`expected one level, or four (for ${TIME_CATEGORIES.join(", ")}), got "${value}"`);
  }
  const allowed = [...EFFORT_LEVELS[provider], "max", "default"].filter((w, i, all) => all.indexOf(w) === i);
  for (const word of words) {
    if (!allowed.includes(word)) throw new Error(`"${word}" isn't a level; use ${allowed.join(", ")}`);
  }
  const level = (i: number) => {
    const word = words.length === 1 ? words[0] : words[i];
    return word === "default" ? undefined : word;
  };
  return Object.fromEntries(TIME_CATEGORIES.map((c, i) => [c, level(i)])) as EffortByCategory;
}

/**
 * The levels to ask `provider` for, in order, when `effort` is wanted: the
 * level itself ("max" as the API's highest), then each lower one down to
 * low, as models of one provider don't all take the same levels. Levels a
 * model already turned down (`rejected`) are left out. A model that takes
 * none of them plays at its default.
 */
export function effortCandidates(provider: Provider, effort: string | undefined, rejected: ReadonlySet<string> = new Set()): string[] {
  if (effort === undefined) return [];
  const levels = EFFORT_LEVELS[provider];
  const wanted = effort === "max" && !levels.includes("max") ? levels[levels.length - 1] : effort;
  const index = levels.indexOf(wanted);
  const lower = index < 0 ? [] : levels.slice(Math.min(index, Math.max(levels.indexOf("low"), 0)), index).reverse();
  return [wanted, ...lower].filter((level) => !rejected.has(level));
}
