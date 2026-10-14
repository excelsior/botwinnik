import OpenAI from "openai";
import type { CompletionUsage } from "openai/resources/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import { FatalPlayerError, OutOfFundsError, TransientPlayerError } from "../game/types.js";
import type { Usage } from "../pricing.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./llmPlayer.js";
import { DECISION_SCHEMA } from "./prompt.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";

export interface XaiModelOptions {
  model: string;
  apiKey: string;
  /** reasoning_effort for the models that take it (low | high); omitted means the model's default. */
  effort?: string;
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/** Grok via xAI's OpenAI-compatible Chat Completions API, with a strict JSON schema for the reply. */
export class XaiModel implements ModelClient {
  private readonly client: OpenAI;

  constructor(private readonly options: XaiModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? XAI_BASE_URL,
      maxRetries: 2,
      // Reasoning models can think for a long time; the game clock is the real limit.
      timeout: 60 * 60 * 1000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete({ system, user }: ModelRequest): Promise<ModelResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "chess_decision", schema: DECISION_SCHEMA, strict: true },
        },
        ...(this.options.effort ? { reasoning_effort: this.options.effort as ReasoningEffort } : {}),
      });
      const usage = usageOf(completion.usage);
      const choice = completion.choices[0];
      if (!choice) return { problem: "the reply was empty", usage };
      if (choice.message.refusal) return { problem: `the model declined to answer: ${choice.message.refusal}`, usage };
      if (choice.finish_reason === "length") return { problem: "the reply was cut off by the token limit", usage };
      if (choice.finish_reason === "content_filter") return { problem: "the reply was blocked by a content filter", usage };
      const text = choice.message.content;
      return text?.trim() ? { text, usage } : { problem: "the reply was empty", usage };
    } catch (err) {
      throw classifyXaiError(err);
    }
  }
}

/**
 * xAI reports reasoning tokens separately from completion_tokens and bills
 * them as output, so they are added here.
 */
function usageOf(usage: CompletionUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: usage.completion_tokens + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

export function classifyXaiError(err: unknown): unknown {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.APIConnectionError) return new TransientPlayerError(`connection problem: ${err.message}`);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const body = err.error as { message?: string; error?: string | { message?: string } } | string | undefined;
    const message =
      typeof body === "string"
        ? body
        : (body?.message ?? (typeof body?.error === "string" ? body.error : body?.error?.message) ?? err.message);
    const detail = `xAI API error ${status}: ${message}`;
    // A team without credits, or one that hit its spending limit.
    if (status === 402 || /credits|spending limit|billing/i.test(message)) return new OutOfFundsError(detail);
    if (status === 408 || status === 409 || status === 429 || status >= 500) return new TransientPlayerError(detail);
    return new FatalPlayerError(detail);
  }
  return err;
}
