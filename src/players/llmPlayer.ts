import type { AppConfig } from "../config.js";
import { EffortRejectedError, type Player, type PlayerReply, type PlayerSpec, type TurnInfo } from "../game/types.js";
import { findPrice, spendOf, type ModelPrice, type Usage } from "../pricing.js";
import type { TimeCategory } from "../timeControl.js";
import { AnthropicModel } from "./anthropic.js";
import { DEFAULT_EFFORT, effortCandidates, type EffortByCategory } from "./effort.js";
import { GeminiModel } from "./gemini.js";
import { OpenAIModel } from "./openai.js";
import { XaiModel } from "./xai.js";
import { parseDecision, systemPrompt, turnPrompt } from "./prompt.js";

export interface ModelRequest {
  system: string;
  user: string;
  /** Reasoning effort in the API's own terms; undefined leaves it to the model's default. */
  effort?: string;
}

/** Either the model's text, or why there is no usable text (refusal, cut off...), plus the tokens used. */
export type ModelResponse = ({ text: string } | { problem: string }) & { usage?: Usage };

/**
 * One request to a chat model. Implementations throw FatalPlayerError for
 * failures retrying won't fix (EffortRejectedError when it is the effort the
 * model doesn't take) and TransientPlayerError for ones it might.
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Levels each model turned down, by provider:model, so later turns and games skip them. */
export type RejectedEfforts = Map<string, Set<string>>;

/**
 * A chess player backed by a language model. Each turn is a single,
 * self-contained request, with the reasoning effort set for the game's time
 * category.
 */
export class LlmPlayer implements Player {
  constructor(
    readonly spec: PlayerSpec,
    private readonly model: ModelClient,
    /** USD per million tokens; without it costs are recorded as unknown. */
    private readonly price?: ModelPrice,
    private readonly effort: EffortByCategory = DEFAULT_EFFORT,
    private readonly rejected: RejectedEfforts = new Map(),
  ) {}

  async decide(turn: TurnInfo): Promise<PlayerReply> {
    const response = await this.complete(
      { system: systemPrompt(turn.color, turn.timeControl), user: turnPrompt(turn) },
      turn.timeControl.category,
    );
    const spend = spendOf(response.usage, this.price);
    if ("problem" in response) return { ok: false, error: response.problem, spend };
    return { ...parseDecision(response.text), spend };
  }

  /** Asks at the category's effort, stepping down a level each time the model turns one down. */
  private async complete(request: ModelRequest, category: TimeCategory): Promise<ModelResponse> {
    const key = `${this.spec.provider}:${this.spec.model}`;
    const rejected = this.rejected.get(key) ?? new Set<string>();
    for (const effort of effortCandidates(this.spec.provider, this.effort[category], rejected)) {
      try {
        return await this.model.complete({ ...request, effort });
      } catch (err) {
        if (!(err instanceof EffortRejectedError)) throw err;
        // Turned down before any thinking: asking again costs little time and nothing is billed.
        this.rejected.set(key, rejected.add(effort));
      }
    }
    return this.model.complete(request);
  }
}

export type PlayerFactory = (spec: PlayerSpec) => Player;

export function playerFactory(config: AppConfig): PlayerFactory {
  const rejected: RejectedEfforts = new Map();
  return (spec) => {
    const provider = config.providers[spec.provider];
    if (!provider) throw new Error(`config.ini has no API key for ${spec.provider}.`);
    const options = { model: spec.model, apiKey: provider.apiKey };
    const clients: Record<PlayerSpec["provider"], () => ModelClient> = {
      openai: () => new OpenAIModel(options),
      anthropic: () => new AnthropicModel(options),
      google: () => new GeminiModel(options),
      xai: () => new XaiModel(options),
    };
    return new LlmPlayer(spec, clients[spec.provider](), findPrice(spec.model, config.prices), provider.effort, rejected);
  };
}
