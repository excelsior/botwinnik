// Helpers for tests: scripted players and a controllable clock.
import type { Decision, Player, PlayerReply, PlayerSpec, TurnInfo } from "./game/types.js";
import type { Spend } from "./pricing.js";

/** A spend for one call of `costUsd` dollars (null = unknown price) and some tokens. */
export function callSpend(costUsd: number | null, inputTokens = 1000, outputTokens = 100): Spend {
  return { calls: 1, inputTokens, cachedInputTokens: 0, outputTokens, costUsd };
}

export class FakeClock {
  t = 0;
  now = () => this.t;
  advance = (ms: number) => {
    this.t += ms;
  };
  sleep = async (ms: number) => {
    this.t += ms;
  };
}

export type Step =
  | string
  | {
      move?: string;
      action?: Decision["action"];
      offerDraw?: boolean;
      reasoning?: string;
      /** Simulated thinking time (advances the fake clock). */
      think?: number;
      /** Return an unusable reply with this error. */
      invalid?: string;
      /** Throw this error instead of replying. */
      error?: Error;
      /** Don't reply until release() is called. */
      hang?: boolean;
      /** What this call used and cost (overrides the player's default). */
      spend?: Spend;
    };

/** A player that replays a fixed list of steps, one per request. */
export class ScriptedPlayer implements Player {
  readonly turns: TurnInfo[] = [];
  private releaseHang?: () => void;

  constructor(
    readonly spec: PlayerSpec,
    private readonly steps: Step[],
    private readonly clock?: FakeClock,
    /** Reported with every reply that has no spend of its own. */
    private readonly spendPerCall?: Spend,
  ) {}

  /** Lets a `hang` step reply. */
  release(): void {
    this.releaseHang?.();
  }

  async decide(turn: TurnInfo): Promise<PlayerReply> {
    this.turns.push(turn);
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`${this.spec.model} has no scripted step left`);
    const spend = (typeof step === "object" && step.spend) || this.spendPerCall;
    if (typeof step === "string") {
      return { ok: true, decision: { action: "move", move: step, offerDraw: false, reasoning: `Playing ${step}.` }, spend };
    }
    if (step.think) this.clock?.advance(step.think);
    if (step.hang) await new Promise<void>((resolve) => (this.releaseHang = resolve));
    if (step.error) throw step.error;
    if (step.invalid) return { ok: false, error: step.invalid, spend };
    return {
      ok: true,
      spend,
      decision: {
        action: step.action ?? "move",
        move: step.move ?? null,
        offerDraw: step.offerDraw ?? false,
        reasoning: step.reasoning ?? (step.move ? `Playing ${step.move}.` : ""),
      },
    };
  }
}

/** Plays fool's mate from whichever side it gets, so Black wins every game in four half-moves. */
export class FoolsMatePlayer implements Player {
  constructor(
    readonly spec: PlayerSpec,
    /** Awaited before each move; a test can hold the game there, or throw. */
    private readonly beforeMove: () => Promise<void> = async () => {},
  ) {}

  async decide(turn: TurnInfo): Promise<PlayerReply> {
    await this.beforeMove();
    const moves = turn.color === "white" ? ["f3", "g4"] : ["e5", "Qh4#"];
    const move = moves[Math.floor(turn.history.length / 2)];
    return { ok: true, decision: { action: "move", move, offerDraw: false, reasoning: `Playing ${move}.` }, spend: callSpend(0.01) };
  }
}

export const CLAUDE: PlayerSpec = { provider: "anthropic", model: "claude-test" };
export const GPT: PlayerSpec = { provider: "openai", model: "gpt-test" };
