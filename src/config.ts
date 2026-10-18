import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseEffort, type EffortByCategory } from "./players/effort.js";
import type { ModelPrice } from "./pricing.js";

export const PROVIDERS = ["openai", "anthropic", "google", "xai", "yandex"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "ChatGPT (OpenAI)",
  anthropic: "Claude (Anthropic)",
  google: "Gemini (Google)",
  xai: "Grok (xAI)",
  yandex: "Alice AI (Yandex)",
};

export interface Credentials {
  apiKey: string;
  /** Yandex only: the Yandex Cloud folder the models are called in. */
  folderId?: string;
}

export interface ProviderConfig extends Credentials {
  /** Models suggested in the setup form. Any other model ID can still be used. */
  models: string[];
  /** Reasoning effort for each time category; undefined leaves it to the model's default. */
  effort: EffortByCategory;
}

/** How finished games are analyzed for the players' accuracy. */
export interface AnalysisSettings {
  /** A UCI engine's executable, such as a native Stockfish; undefined for the bundled Stockfish. */
  engine?: string;
  /** How many plies deep the engine searches each position. */
  depth: number;
}

export const DEFAULT_ANALYSIS_DEPTH = 18;

export interface AppConfig {
  /** Only providers that have an API key are present. */
  providers: Partial<Record<Provider, ProviderConfig>>;
  host: string;
  port: number;
  gamesDir: string;
  /** [app] read_only: the app shows the games, but doesn't start, resume, import or abort any. */
  readOnly: boolean;
  /** Prices from the [prices] section, keyed by lowercase model ID. */
  prices: Record<string, ModelPrice>;
  /** From the [analysis] section; null when it turns analysis off. */
  analysis: AnalysisSettings | null;
}

export const DEFAULT_MODELS: Record<Provider, string[]> = {
  openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  google: ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  xai: ["grok-4.7", "grok-4.6", "grok-4.3"],
  yandex: ["aliceai-llm", "aliceai-llm-flash", "yandexgpt-5.1"],
};

export type IniData = Record<string, Record<string, string>>;

export class ConfigError extends Error {}

/**
 * Parses a small INI dialect: `[section]` headers, `key = value` pairs, and
 * comments starting with `;` or `#` (on their own line, or after a value
 * following whitespace). Keys before any section go in "".
 */
export function parseIni(text: string): IniData {
  const data: IniData = { "": {} };
  let section = "";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) return;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      data[section] ??= {};
      return;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new ConfigError(`Line ${i + 1}: expected "key = value", got "${line}"`);
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/(^|\s+)[;#].*$/, "").trim(); // inline comment
    data[section][key] = value;
  });
  return data;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function configFromIni(ini: IniData, baseDir = process.cwd()): AppConfig {
  const providers: AppConfig["providers"] = {};
  for (const provider of PROVIDERS) {
    const section = ini[provider] ?? {};
    const apiKey = section.api_key?.trim();
    if (!apiKey) continue;
    const folderId = section.folder_id?.trim();
    if (provider === "yandex" && !folderId) {
      throw new ConfigError("[yandex] needs folder_id next to api_key: the ID of the Yandex Cloud folder the key's service account is in (b1g...).");
    }
    const models = list(section.models);
    providers[provider] = {
      apiKey,
      ...(folderId ? { folderId } : {}),
      models: models.length ? models : DEFAULT_MODELS[provider],
      effort: effortSetting(provider, section.effort),
    };
  }
  if (Object.keys(providers).length === 0) {
    throw new ConfigError(
      `config.ini must contain at least one API key: set api_key under ${PROVIDERS.map((p) => `[${p}]`).join(", ").replace(/, ([^,]*)$/, " or $1")}.`,
    );
  }
  const app = ini.app ?? {};
  const port = Number(app.port ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`[app] port must be a number between 0 and 65535, got "${app.port}"`);
  }
  return {
    providers,
    host: app.host?.trim() || "127.0.0.1",
    port,
    gamesDir: path.resolve(baseDir, app.games_dir?.trim() || "games"),
    readOnly: readOnlySetting(app.read_only),
    prices: parsePrices(ini.prices ?? {}),
    analysis: analysisSettings(ini.analysis ?? {}, baseDir),
  };
}

/** `read_only`: true or false (yes/no, on/off and 1/0 do too); empty is false. */
function readOnlySetting(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase() ?? "";
  if (["", "false", "no", "off", "0"].includes(text)) return false;
  if (["true", "yes", "on", "1"].includes(text)) return true;
  throw new ConfigError(`[app] read_only must be true or false, got "${value}"`);
}

/**
 * `engine` empty for the bundled Stockfish, "off" for no analysis, or an
 * engine's executable: a path (relative to config.ini) or a command on the PATH.
 */
function analysisSettings(section: Record<string, string>, baseDir: string): AnalysisSettings | null {
  const engine = section.engine?.trim() ?? "";
  if (/^(off|none|no|false)$/i.test(engine)) return null;
  const depthText = section.depth?.trim();
  const depth = depthText ? Number(depthText) : DEFAULT_ANALYSIS_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > 99) {
    throw new ConfigError(`[analysis] depth must be a whole number from 1 to 99, got "${section.depth}"`);
  }
  if (!engine) return { depth };
  return { engine: /[\\/]/.test(engine) ? path.resolve(baseDir, engine) : engine, depth };
}

function effortSetting(provider: Provider, value: string | undefined): EffortByCategory {
  try {
    return parseEffort(provider, value);
  } catch (err) {
    throw new ConfigError(`[${provider}] effort: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `model = input, output[, cached input]`, in USD per million tokens. */
function parsePrices(section: Record<string, string>): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(section)) {
    const numbers = list(value).map((v) => Number(v.replace(/^\$/, "")));
    if (numbers.length < 2 || numbers.length > 3 || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new ConfigError(
        `[prices] ${model}: expected "input, output" or "input, output, cached input" in USD per million tokens, got "${value}"`,
      );
    }
    const [input, output, cachedInput] = numbers;
    prices[model] = cachedInput === undefined ? { input, output } : { input, output, cachedInput };
  }
  return prices;
}

export function defaultConfigPath(): string {
  return path.resolve(process.env.BOTWINNIK_CONFIG ?? "config.ini");
}

export function loadConfig(file = defaultConfigPath(), env = process.env): AppConfig {
  if (!existsSync(file)) {
    throw new ConfigError(
      `No config file at ${file}. Copy config.example.ini to config.ini and add at least one API key.`,
    );
  }
  return configFromIni(withAppEnv(parseIni(readFileSync(file, "utf8")), env), path.dirname(file));
}

const APP_ENV: Record<string, string> = { host: "BOTWINNIK_HOST", port: "BOTWINNIK_PORT", games_dir: "BOTWINNIK_GAMES_DIR" };

/**
 * BOTWINNIK_HOST, BOTWINNIK_PORT and BOTWINNIK_GAMES_DIR, when set, take the
 * place of [app]'s host, port and games_dir. The Docker image sets them: in a
 * container, the image decides where the app listens and keeps its games,
 * whatever the config.ini mounted into it says.
 */
export function withAppEnv(ini: IniData, env: NodeJS.ProcessEnv): IniData {
  const app = { ...ini.app };
  for (const [key, name] of Object.entries(APP_ENV)) {
    const value = env[name]?.trim();
    if (value) app[key] = value;
  }
  return { ...ini, app };
}

/**
 * Guesses the provider from a model ID: claude-... is Anthropic's, gpt-...
 * OpenAI's, gemini-... Google's, grok-... xAI's, aliceai-... and yandexgpt...
 * Yandex's.
 */
export function inferProvider(model: string): Provider | undefined {
  const m = model.toLowerCase().replace(/^models\//, "");
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("chatgpt") || /^o\d/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("aliceai") || m.startsWith("yandexgpt")) return "yandex";
  return undefined;
}

const PROVIDER_ALIASES: Record<string, Provider> = {
  openai: "openai",
  chatgpt: "openai",
  gpt: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  google: "google",
  gemini: "google",
  xai: "xai",
  grok: "xai",
  yandex: "yandex",
  alice: "yandex",
  yandexgpt: "yandex",
};

/** Parses "provider:model" (provider optional when it can be inferred from the model ID). */
export function parsePlayerSpec(text: string): { provider: Provider; model: string } {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const provider = PROVIDER_ALIASES[trimmed.slice(0, colon).toLowerCase()];
    const model = trimmed.slice(colon + 1).trim();
    if (!provider) throw new ConfigError(`Unknown provider in "${text}". Use ${PROVIDERS.join(", ")}.`);
    if (!model) throw new ConfigError(`Missing model in "${text}".`);
    return { provider, model };
  }
  const provider = inferProvider(trimmed);
  if (!provider) {
    throw new ConfigError(`Can't tell which provider "${text}" belongs to. Write it as provider:<model>, with provider one of ${PROVIDERS.join(", ")}.`);
  }
  return { provider, model: trimmed };
}
