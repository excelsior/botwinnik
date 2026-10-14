import type { AppConfig } from "../config.js";
import type { Player, PlayerReply, PlayerSpec, TurnInfo } from "../game/types.js";
import { findPrice, spendOf, type ModelPrice, type Usage } from "../pricing.js";
import { AnthropicModel } from "./anthropic.js";
import { GeminiModel } from "./gemini.js";
import { OpenAIModel } from "./openai.js";
import { XaiModel } from "./xai.js";
import { parseDecision, systemPrompt, turnPrompt } from "./prompt.js";

export interface ModelRequest {
  system: string;
  user: string;
}

/** Either the model's text, or why there is no usable text (refusal, cut off...), plus the tokens used. */
export type ModelResponse = ({ text: string } | { problem: string }) & { usage?: Usage };

/**
 * One request to a chat model. Implementations throw FatalPlayerError for
 * failures retrying won't fix and TransientPlayerError for ones it might.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** A chess player backed by a language model. Each turn is a single, self-contained request. */
export class LlmPlayer implements Player {
  constructor(
    readonly spec: PlayerSpec,
    private readonly model: ModelClient,
    /** USD per million tokens; without it costs are recorded as unknown. */
    private readonly price?: ModelPrice,
  ) {}

  async decide(turn: TurnInfo): Promise<PlayerReply> {
    const response = await this.model.complete({
      system: systemPrompt(turn.color, turn.timeControl),
      user: turnPrompt(turn),
    });
    const spend = spendOf(response.usage, this.price);
    if ("problem" in response) return { ok: false, error: response.problem, spend };
    return { ...parseDecision(response.text), spend };
  }
}

export type PlayerFactory = (spec: PlayerSpec) => Player;

export function playerFactory(config: AppConfig): PlayerFactory {
  return (spec) => {
    const provider = config.providers[spec.provider];
    if (!provider) throw new Error(`config.ini has no API key for ${spec.provider}.`);
    const options = { model: spec.model, apiKey: provider.apiKey, effort: provider.effort };
    const clients: Record<PlayerSpec["provider"], () => ModelClient> = {
      openai: () => new OpenAIModel(options),
      anthropic: () => new AnthropicModel(options),
      google: () => new GeminiModel(options),
      xai: () => new XaiModel(options),
    };
    return new LlmPlayer(spec, clients[spec.provider](), findPrice(spec.model, config.prices));
  };
}
