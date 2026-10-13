import type { AppConfig } from "../config.js";
import type { Player, PlayerReply, PlayerSpec, TurnInfo } from "../game/types.js";
import { AnthropicModel } from "./anthropic.js";
import { OpenAIModel } from "./openai.js";
import { parseDecision, systemPrompt, turnPrompt } from "./prompt.js";

export interface ModelRequest {
  system: string;
  user: string;
  signal: AbortSignal;
}

/** Either the model's text, or why there is no usable text (refusal, cut off...). */
export type ModelResponse = { text: string } | { problem: string };

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
  ) {}

  async decide(turn: TurnInfo, signal: AbortSignal): Promise<PlayerReply> {
    const response = await this.model.complete({
      system: systemPrompt(turn.color, turn.timeControl),
      user: turnPrompt(turn),
      signal,
    });
    if ("problem" in response) return { ok: false, error: response.problem };
    return parseDecision(response.text);
  }
}

export type PlayerFactory = (spec: PlayerSpec) => Player;

export function playerFactory(config: AppConfig): PlayerFactory {
  return (spec) => {
    const provider = config.providers[spec.provider];
    if (!provider) throw new Error(`config.ini has no API key for ${spec.provider}.`);
    const model =
      spec.provider === "anthropic"
        ? new AnthropicModel({ model: spec.model, apiKey: provider.apiKey, effort: provider.effort })
        : new OpenAIModel({ model: spec.model, apiKey: provider.apiKey, effort: provider.effort });
    return new LlmPlayer(spec, model);
  };
}
