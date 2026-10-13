import Anthropic from "@anthropic-ai/sdk";
import { FatalPlayerError, TransientPlayerError } from "../game/types.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./llmPlayer.js";
import { DECISION_SCHEMA } from "./prompt.js";

type Effort = NonNullable<NonNullable<Anthropic.MessageCreateParams["output_config"]>["effort"]>;

export interface AnthropicModelOptions {
  model: string;
  apiKey: string;
  /** low | medium | high | xhigh | max; omitted means the model's default. */
  effort?: string;
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/**
 * Claude via the Messages API, with structured outputs so the reply is always
 * a decision object. Streams so long thinking doesn't hit HTTP timeouts; the
 * game's clock bounds the request through the abort signal.
 *
 * Refusal fallbacks are deliberately not enabled: they would let a different
 * model play the move, which defeats the point of a match between models.
 */
export class AnthropicModel implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicModelOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 2,
      timeout: 60 * 60 * 1000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete({ system, user, signal }: ModelRequest): Promise<ModelResponse> {
    try {
      const stream = this.client.messages.stream(
        {
          model: this.options.model,
          max_tokens: 64000,
          system,
          messages: [{ role: "user", content: user }],
          output_config: {
            format: { type: "json_schema", schema: DECISION_SCHEMA },
            ...(this.options.effort ? { effort: this.options.effort as Effort } : {}),
          },
        },
        { signal },
      );
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") return { problem: "the model declined to answer" };
      if (message.stop_reason === "max_tokens") return { problem: "the reply was cut off by the token limit" };
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return text.trim() ? { text } : { problem: "the reply was empty" };
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }
}

export function classifyAnthropicError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIConnectionError) return new TransientPlayerError(`connection problem: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const body = err.error as { error?: { message?: string } } | undefined;
    const detail = `Anthropic API error ${status}: ${body?.error?.message ?? err.message}`;
    if (status === 408 || status === 409 || status === 429 || status >= 500) return new TransientPlayerError(detail);
    return new FatalPlayerError(detail);
  }
  return err;
}
