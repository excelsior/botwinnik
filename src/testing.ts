// Helpers for tests: scripted players and a controllable clock.
import type { Decision, Player, PlayerReply, PlayerSpec, TurnInfo } from "./game/types.js";

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
      /** Never reply; resolves only when aborted. */
      hang?: boolean;
    };

/** A player that replays a fixed list of steps, one per request. */
export class ScriptedPlayer implements Player {
  readonly turns: TurnInfo[] = [];

  constructor(
    readonly spec: PlayerSpec,
    private readonly steps: Step[],
    private readonly clock?: FakeClock,
  ) {}

  async decide(turn: TurnInfo, signal: AbortSignal): Promise<PlayerReply> {
    this.turns.push(turn);
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`${this.spec.model} has no scripted step left`);
    if (typeof step === "string") {
      return { ok: true, decision: { action: "move", move: step, offerDraw: false, reasoning: `Playing ${step}.` } };
    }
    if (step.think) this.clock?.advance(step.think);
    if (step.hang) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    }
    if (step.error) throw step.error;
    if (step.invalid) return { ok: false, error: step.invalid };
    return {
      ok: true,
      decision: {
        action: step.action ?? "move",
        move: step.move ?? null,
        offerDraw: step.offerDraw ?? false,
        reasoning: step.reasoning ?? (step.move ? `Playing ${step.move}.` : ""),
      },
    };
  }
}

export const CLAUDE: PlayerSpec = { provider: "anthropic", model: "claude-test" };
export const GPT: PlayerSpec = { provider: "openai", model: "gpt-test" };
