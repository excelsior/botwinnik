// The models each API key can use, from the providers' list-models endpoints.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider } from "../config.js";
import { classifyAnthropicError } from "./anthropic.js";
import { classifyOpenAIError } from "./openai.js";

export interface ModelOption {
  id: string;
  /** Human-readable name, when the provider gives one. */
  name?: string;
}

export interface ListModelsOptions {
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
  timeoutMs?: number;
}

/** Every model the key can use, newest first. */
export async function listModels(provider: Provider, apiKey: string, options: ListModelsOptions = {}): Promise<ModelOption[]> {
  // Short and without retries: the setup form waits for this.
  const clientOptions = {
    apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 5_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  };
  if (provider === "anthropic") {
    try {
      const models: ModelOption[] = [];
      // Listed newest first. Retired models can't be called; ones without
      // structured outputs can't return a decision.
      for await (const m of new Anthropic(clientOptions).models.list({ lifecycle: ["active", "deprecated"] })) {
        if (m.capabilities?.structured_outputs?.supported === false) continue;
        models.push({ id: m.id, name: m.display_name });
      }
      return models;
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }
  try {
    const models: OpenAI.Models.Model[] = [];
    for await (const m of new OpenAI(clientOptions).models.list()) models.push(m);
    return models.sort((a, b) => b.created - a.created).map((m) => ({ id: m.id }));
  } catch (err) {
    throw classifyOpenAIError(err);
  }
}

/**
 * Whether a model from the list can play: OpenAI lists embedding, image,
 * audio and other models next to the chat ones, and older chat models lack
 * structured outputs. A guess from the name, so any ID can still be typed in.
 */
export function canPlay(provider: Provider, id: string): boolean {
  if (provider === "anthropic") return true;
  if (!/^(gpt-|o\d)/.test(id)) return false;
  if (/^gpt-(3\.5|4(-|$))|^o1-(mini|preview)/.test(id)) return false;
  return !/audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct|deep-research/.test(id);
}

/**
 * Suggestions for the setup form: the models from config.ini that the key can
 * use, in their order, then every other model that can play. Without a
 * fetched list, just the configured ones.
 */
export function suggestModels(provider: Provider, configured: string[], available?: ModelOption[]): ModelOption[] {
  if (!available) return configured.map((id) => ({ id }));
  const byId = new Map(available.map((m) => [m.id, m]));
  const first = configured.flatMap((id) => byId.get(id) ?? []);
  const rest = available.filter((m) => !configured.includes(m.id) && canPlay(provider, m.id));
  return [...first, ...rest];
}
