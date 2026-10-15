import OpenAI from "openai";
import type { CompletionUsage } from "openai/resources/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import { EffortRejectedError, FatalPlayerError, OutOfFundsError, TransientPlayerError } from "../game/types.js";
import type { Usage } from "../pricing.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./llmPlayer.js";
import { DECISION_SCHEMA } from "./prompt.js";

/** Yandex AI Studio's OpenAI-compatible API, at the address Yandex's own SDK uses for it. */
export const YANDEX_BASE_URL = "https://llm.api.cloud.yandex.net/v1";

export interface YandexModelOptions {
  model: string;
  /** An API key of a service account with the ai.languageModels.user role. */
  apiKey: string;
  /** The Yandex Cloud folder the model is called in, and billed to. */
  folderId: string;
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/**
 * Alice AI and YandexGPT models (and the open models Yandex hosts) via Yandex
 * AI Studio's OpenAI-compatible Chat Completions API, with a strict JSON
 * schema for the reply.
 */
export class YandexModel implements ModelClient {
  private readonly client: OpenAI;

  constructor(private readonly options: YandexModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      // Sent as OpenAI-Project, which Yandex reads as the folder.
      project: options.folderId,
      baseURL: options.baseURL ?? YANDEX_BASE_URL,
      maxRetries: 2,
      timeout: 60 * 60 * 1000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** `effort`: reasoning_effort, low | medium | high, for the models that reason; omitted means the model's default. */
  async complete({ system, user, effort }: ModelRequest): Promise<ModelResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: yandexModelUri(this.options.folderId, this.options.model),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "chess_decision", schema: DECISION_SCHEMA, strict: true },
        },
        ...(effort ? { reasoning_effort: effort as ReasoningEffort } : {}),
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
      throw classifyYandexError(err);
    }
  }
}

/**
 * Yandex names models by URI, gpt://<folder ID>/<model>. Botwinnik's model
 * IDs are the part after the folder ("aliceai-llm", "yandexgpt-5.1",
 * "yandexgpt/rc"), so they stay the same whatever the folder; a whole URI
 * is used as it is.
 */
export function yandexModelUri(folderId: string, model: string): string {
  return model.includes("://") ? model : `gpt://${folderId}/${model}`;
}

/** The model ID for a URI from the folder: gpt://<folder>/aliceai-llm/latest is aliceai-llm. Other URIs stay whole. */
export function yandexModelId(folderId: string, uri: string): string {
  const prefix = `gpt://${folderId}/`;
  return uri.startsWith(prefix) ? uri.slice(prefix.length).replace(/\/latest$/, "") : uri;
}

/**
 * Yandex doesn't say whether completion_tokens includes the reasoning tokens,
 * so the output is everything the total holds beyond the prompt, which counts
 * them once either way.
 */
function usageOf(usage: CompletionUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: Math.max(usage.completion_tokens, (usage.total_tokens ?? 0) - usage.prompt_tokens),
  };
}

export function classifyYandexError(err: unknown): unknown {
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.APIConnectionError) return new TransientPlayerError(`connection problem: ${err.message}`);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    // Yandex Cloud's errors are {"error": {"grpcCode", "httpCode", "message", ...}}.
    const body = err.error as { message?: string; error?: string | { message?: string } } | string | undefined;
    const message =
      typeof body === "string"
        ? body
        : (body?.message ?? (typeof body?.error === "string" ? body.error : body?.error?.message) ?? err.message);
    const detail = `Yandex AI Studio API error ${status}: ${message}`;
    // A billing account that is suspended or has run out of money.
    if (status === 402 || /billing|balance|insufficient funds|payment/i.test(message)) return new OutOfFundsError(detail);
    if (status === 408 || status === 409 || status === 429 || status >= 500) return new TransientPlayerError(detail);
    // A model that doesn't reason, or doesn't take this level.
    if ((status === 400 || status === 422) && /reasoning|effort/i.test(message)) return new EffortRejectedError(detail);
    return new FatalPlayerError(detail);
  }
  return err;
}
