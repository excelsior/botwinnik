import { FatalPlayerError, OutOfFundsError, TransientPlayerError } from "../game/types.js";
import type { Usage } from "../pricing.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./llmPlayer.js";
import { DECISION_SCHEMA } from "./prompt.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModelOptions {
  model: string;
  apiKey: string;
  /** thinkingLevel (minimal | low | medium | high) for Gemini 3 and later; omitted means the model's default. */
  effort?: string;
  /** For tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; reason?: string; violations?: { quotaId?: string }[] }[];
  };
}

/** Gemini via the Gemini API's generateContent, with a JSON schema for the reply. */
export class GeminiModel implements ModelClient {
  constructor(private readonly options: GeminiModelOptions) {}

  async complete({ system, user }: ModelRequest): Promise<ModelResponse> {
    const { model, effort } = this.options;
    // Gemini 2.5 rejects thinkingLevel (it takes a token budget instead), so it keeps its default there.
    const thinking = effort && !/^gemini-2\./.test(geminiModelId(model)) ? { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } : {};
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: DECISION_SCHEMA, ...thinking },
    };
    const data = (await geminiRequest(this.options, `models/${geminiModelId(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as GeminiResponse;

    const meta = data.usageMetadata;
    // promptTokenCount includes cached tokens; thinking is billed as output but counted apart from the reply.
    const usage: Usage | undefined = meta
      ? {
          inputTokens: meta.promptTokenCount ?? 0,
          cachedInputTokens: meta.cachedContentTokenCount ?? 0,
          cacheWriteTokens: 0,
          outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        }
      : undefined;
    if (data.promptFeedback?.blockReason) return { problem: `the request was blocked (${data.promptFeedback.blockReason})`, usage };
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    const reason = candidate?.finishReason;
    if (reason === "MAX_TOKENS") return { problem: "the reply was cut off by the token limit", usage };
    if (reason && reason !== "STOP") return { problem: `the reply stopped early (${reason})`, usage };
    return text.trim() ? { text, usage } : { problem: "the reply was empty", usage };
  }
}

/** "models/gemini-x" and "gemini-x" both name the same model. */
export function geminiModelId(model: string): string {
  return model.replace(/^models\//, "");
}

/** Sends one Gemini API request and returns its JSON, or throws a classified error. */
export async function geminiRequest(
  options: { apiKey: string; fetch?: typeof fetch; baseURL?: string; timeoutMs?: number },
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${options.baseURL ?? GEMINI_BASE_URL}/${path}`, {
      ...init,
      headers: { "x-goog-api-key": options.apiKey, ...(init.headers as Record<string, string>) },
      // Thinking models can take a long time; the game clock is the real limit.
      signal: AbortSignal.timeout(options.timeoutMs ?? 60 * 60 * 1000),
    });
  } catch (err) {
    throw new TransientPlayerError(`connection problem: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = (await res.json().catch(() => undefined)) as GeminiErrorBody | undefined;
  if (!res.ok) throw classifyGeminiError(res.status, data);
  return data;
}

export function classifyGeminiError(status: number, body: GeminiErrorBody | undefined): Error {
  const error = body?.error;
  const detail = `Gemini API error ${status}: ${error?.message ?? error?.status ?? "no details"}`;
  const quotaIds = (error?.details ?? []).flatMap((d) => (d.violations ?? []).map((v) => v.quotaId ?? ""));
  const reasons = (error?.details ?? []).map((d) => d.reason ?? "");
  // Depleted prepaid credits (402), a monthly spending cap, a used-up daily
  // quota or missing billing won't come back by retrying; a per-minute limit will.
  if (
    status === 402 ||
    quotaIds.some((id) => /PerDay/i.test(id)) ||
    reasons.some((r) => /BILLING/i.test(r)) ||
    /billing|prepay|credits|spending cap/i.test(error?.message ?? "")
  ) {
    return new OutOfFundsError(detail);
  }
  if (status === 408 || status === 429 || status >= 500) return new TransientPlayerError(detail);
  return new FatalPlayerError(detail);
}
