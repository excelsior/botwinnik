import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import { FatalPlayerError, TransientPlayerError } from "../game/types.js";
import type { Usage } from "../pricing.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./llmPlayer.js";
import { DECISION_SCHEMA } from "./prompt.js";

export interface OpenAIModelOptions {
  model: string;
  apiKey: string;
  /** Reasoning effort, e.g. low | medium | high; omitted means the model's default. */
  effort?: string;
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/** ChatGPT models via the Responses API, with a strict JSON schema for the reply. */
export class OpenAIModel implements ModelClient {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 2,
      timeout: 60 * 60 * 1000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete({ system, user, signal }: ModelRequest): Promise<ModelResponse> {
    try {
      const response = await this.client.responses.create(
        {
          model: this.options.model,
          instructions: system,
          input: user,
          store: false,
          text: {
            format: { type: "json_schema", name: "chess_decision", schema: DECISION_SCHEMA, strict: true },
          },
          ...(this.options.effort ? { reasoning: { effort: this.options.effort as ReasoningEffort } } : {}),
        },
        { signal },
      );
      const usage: Usage | undefined = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
            outputTokens: response.usage.output_tokens,
          }
        : undefined;
      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "refusal") return { problem: `the model declined to answer: ${part.refusal}`, usage };
        }
      }
      if (response.status === "incomplete") {
        return { problem: `the reply was cut off (${response.incomplete_details?.reason ?? "incomplete"})`, usage };
      }
      const text = response.output_text;
      return text?.trim() ? { text, usage } : { problem: "the reply was empty", usage };
    } catch (err) {
      throw classifyOpenAIError(err);
    }
  }
}

export function classifyOpenAIError(err: unknown): unknown {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.APIConnectionError) return new TransientPlayerError(`connection problem: ${err.message}`);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const body = err.error as { message?: string } | undefined;
    const detail = `OpenAI API error ${status}: ${body?.message ?? err.message}`;
    if (err.code === "insufficient_quota") return new FatalPlayerError(detail);
    if (status === 408 || status === 409 || status === 429 || status >= 500) return new TransientPlayerError(detail);
    return new FatalPlayerError(detail);
  }
  return err;
}
