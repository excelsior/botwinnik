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
    const { response, effort } = await this.complete(
      { system: systemPrompt(turn.color, turn.timeControl), user: turnPrompt(turn) },
      turn.timeControl.category,
    );
    const spend = spendOf(response.usage, this.price);
    if ("problem" in response) return { ok: false, error: response.problem, spend, effort };
    return { ...parseDecision(response.text), spend, effort };
  }

  effortFor(category: TimeCategory): string | null {
    return this.candidates(category)[0] ?? null;
  }

  /** Asks at the category's effort, stepping down a level each time the model turns one down. */
  private async complete(request: ModelRequest, category: TimeCategory): Promise<{ response: ModelResponse; effort: string | null }> {
    for (const effort of this.candidates(category)) {
      try {
        return { response: await this.model.complete({ ...request, effort }), effort };
      } catch (err) {
        if (!(err instanceof EffortRejectedError)) throw err;
        // Turned down before any thinking: asking again costs little time and nothing is billed.
        const key = this.key();
        this.rejected.set(key, (this.rejected.get(key) ?? new Set()).add(effort));
      }
    }
    return { response: await this.model.complete(request), effort: null };
  }

  /** The levels to try for the category, leaving out the ones this model turned down. */
  private candidates(category: TimeCategory): string[] {
    return effortCandidates(this.spec.provider, this.effort[category], this.rejected.get(this.key()));
  }

  private key(): string {
    return `${this.spec.provider}:${this.spec.model}`;
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
