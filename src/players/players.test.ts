import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { FatalPlayerError, OutOfFundsError, TransientPlayerError, type TurnInfo } from "../game/types.js";
import { illegalMoveBonusMs, parseTimeControl, timeCategory } from "../timeControl.js";
import { AnthropicModel } from "./anthropic.js";
import { GeminiModel } from "./gemini.js";
import { LlmPlayer } from "./llmPlayer.js";
import { OpenAIModel } from "./openai.js";
import { XaiModel } from "./xai.js";

const DECISION = { reasoning: "Fighting for the center.", action: "move", move: "e5", offer_draw: false };

function turn(): TurnInfo {
  const chess = new Chess();
  chess.move("e4");
  const tc = parseTimeControl("3+2");
  return {
    color: "black",
    fen: chess.fen(),
    board: chess.ascii(),
    history: ["e4"],
    startFen: new Chess().fen(),
    moveNumber: 1,
    timeControl: { ...tc, label: "3+2", category: timeCategory(tc), illegalMoveBonusMs: illegalMoveBonusMs(tc) },
    myClockMs: 180_000,
    opponentClockMs: 181_000,
    drawOffered: false,
    canOfferDraw: true,
    illegalMovesSoFar: 0,
    recentNotes: [],
  };
}

/** A fetch stand-in that records requests and answers from a queue. */
function fakeFetch(responses: (() => Response)[]) {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error("no fake response left");
    return next();
  }) as typeof fetch;
  return { fn, requests };
}

function claudeStream(text: string, stopReason = "end_turn"): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openaiResponse(text: string, extra: Record<string, unknown> = {}): Response {
  const body = {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-5.6-sol",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    incomplete_details: null,
    usage: {
      input_tokens: 1500,
      input_tokens_details: { cached_tokens: 1024 },
      output_tokens: 400,
      output_tokens_details: { reasoning_tokens: 300 },
      total_tokens: 1900,
    },
    ...extra,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Claude player", () => {
  it("asks for a structured decision and parses it", async () => {
    const fake = fakeFetch([() => claudeStream(JSON.stringify(DECISION))]);
    const model = new AnthropicModel({ model: "claude-opus-5-5", apiKey: "sk-ant-test", effort: "low", fetch: fake.fn });
    const player = new LlmPlayer({ provider: "anthropic", model: "claude-opus-5-5" }, model, { input: 4, output: 20 });
    const reply = await player.decide(turn());
    assert.deepEqual(reply, {
      ok: true,
      decision: { action: "move", move: "e5", offerDraw: false, reasoning: "Fighting for the center." },
      // 10 input tokens at $4/M and 20 output tokens at $20/M.
      spend: { calls: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, costUsd: (10 * 4 + 20 * 20) / 1e6 },
    });
    const { url, body } = fake.requests[0];
    assert.match(url, /\/v1\/messages$/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.output_config.format.type, "json_schema");
    assert.deepEqual(body.output_config.format.schema.required, ["reasoning", "action", "move", "offer_draw"]);
    assert.equal(body.output_config.effort, "low");
    assert.match(body.system, /playing a game of chess as Black/);
    assert.match(body.messages[0].content, /Your clock: 3:00 left/);
  });

  it("reports refusals and truncation as unusable replies", async () => {
    const fake = fakeFetch([() => claudeStream("", "refusal"), () => claudeStream('{"reasoning":"', "max_tokens")]);
    const model = new AnthropicModel({ model: "claude-opus-5-5", apiKey: "k", fetch: fake.fn });
    const refused = await model.complete({ system: "s", user: "u" });
    assert.equal("problem" in refused && refused.problem, "the model declined to answer");
    assert.deepEqual(refused.usage, { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 }, "still billed");
    const truncated = await model.complete({ system: "s", user: "u" });
    assert.equal("problem" in truncated && truncated.problem, "the reply was cut off by the token limit");
    assert.equal(truncated.usage?.outputTokens, 20);
    assert.equal(fake.requests[0].body.output_config.effort, undefined);
  });

  it("classifies API errors", async () => {
    const fake = fakeFetch([
      () => errorResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
      () => errorResponse(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }),
    ]);
    const model = new AnthropicModel({ model: "claude-opus-5-5", apiKey: "k", fetch: fake.fn });
    await assert.rejects(model.complete({ system: "s", user: "u" }), (err: Error) => {
      assert.ok(err instanceof FatalPlayerError);
      assert.equal(err.message, "Anthropic API error 401: invalid x-api-key");
      return true;
    });
    await assert.rejects(model.complete({ system: "s", user: "u" }), FatalPlayerError);
  });

  it("recognizes an account that is out of credit", async () => {
    const fake = fakeFetch([
      () => errorResponse(402, { type: "error", error: { type: "billing_error", message: "Your account has no credit left." } }),
      () =>
        errorResponse(400, {
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
        }),
      () => errorResponse(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }),
    ]);
    const model = new AnthropicModel({ model: "claude-opus-5-5", apiKey: "k", fetch: fake.fn });
    await assert.rejects(model.complete({ system: "s", user: "u" }), (err: Error) => {
      assert.ok(err instanceof OutOfFundsError);
      assert.equal(err.message, "Anthropic API error 402: Your account has no credit left.");
      return true;
    });
    await assert.rejects(model.complete({ system: "s", user: "u" }), OutOfFundsError);
    await assert.rejects(model.complete({ system: "s", user: "u" }), (err) => !(err instanceof OutOfFundsError));
  });

  it("treats overload as transient (after the SDK's own retries)", async () => {
    const overloaded = () => errorResponse(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const fake = fakeFetch([overloaded, overloaded, overloaded]);
    const model = new AnthropicModel({ model: "claude-opus-5-5", apiKey: "k", fetch: fake.fn });
    await assert.rejects(
      model.complete({ system: "s", user: "u" }),
      TransientPlayerError,
    );
  });
});

describe("ChatGPT player", () => {
  it("uses the Responses API with a strict JSON schema", async () => {
    const fake = fakeFetch([() => openaiResponse(JSON.stringify({ ...DECISION, move: "c5", offer_draw: true }))]);
    const model = new OpenAIModel({ model: "gpt-5.6-sol", apiKey: "sk-test", effort: "high", fetch: fake.fn });
    const player = new LlmPlayer({ provider: "openai", model: "gpt-5.6-sol" }, model, { input: 5, output: 30, cachedInput: 0.5 });
    const reply = await player.decide(turn());
    assert.deepEqual(reply, {
      ok: true,
      decision: { action: "move", move: "c5", offerDraw: true, reasoning: "Fighting for the center." },
      // 476 fresh input tokens at $5/M, 1024 cached at $0.50/M, 400 output (incl. reasoning) at $30/M.
      spend: {
        calls: 1,
        inputTokens: 1500,
        cachedInputTokens: 1024,
        outputTokens: 400,
        costUsd: (476 * 5 + 1024 * 0.5 + 400 * 30) / 1e6,
      },
    });
    const { url, body } = fake.requests[0];
    assert.match(url, /\/responses$/);
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.match(body.instructions, /playing a game of chess as Black/);
    assert.match(body.input, /Moves so far: 1\. e4/);
  });

  it("reports refusals and incomplete replies", async () => {
    const refusal = () =>
      new Response(
        JSON.stringify({
          id: "r",
          object: "response",
          status: "completed",
          output: [{ type: "message", id: "m", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: "No." }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const incomplete = () => openaiResponse('{"reasoning": "', { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const fake = fakeFetch([refusal, incomplete]);
    const model = new OpenAIModel({ model: "gpt-5.6-sol", apiKey: "k", fetch: fake.fn });
    assert.deepEqual(await model.complete({ system: "s", user: "u" }), {
      problem: "the model declined to answer: No.",
      usage: undefined,
    });
    const incompleteReply = await model.complete({ system: "s", user: "u" });
    assert.equal("problem" in incompleteReply && incompleteReply.problem, "the reply was cut off (max_output_tokens)");
    assert.equal(incompleteReply.usage?.outputTokens, 400, "still billed");
    assert.equal(fake.requests[0].body.reasoning, undefined);
  });

  it("classifies API errors, recognizing an exhausted quota as out of funds", async () => {
    const quota = () => errorResponse(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } });
    const notFound = () => errorResponse(404, { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } });
    // The SDK retries 429s twice on its own before giving up.
    const fake = fakeFetch([quota, quota, quota, notFound]);
    const model = new OpenAIModel({ model: "gpt-nope", apiKey: "k", fetch: fake.fn });
    await assert.rejects(model.complete({ system: "s", user: "u" }), OutOfFundsError);
    await assert.rejects(model.complete({ system: "s", user: "u" }), (err: Error) => {
      assert.ok(err instanceof FatalPlayerError && !(err instanceof OutOfFundsError));
      assert.equal(err.message, "OpenAI API error 404: The model does not exist");
      return true;
    });
  });
});

function geminiResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const GEMINI_USAGE = { promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 80, thoughtsTokenCount: 500, totalTokenCount: 1780 };

describe("Gemini player", () => {
  it("asks generateContent for JSON matching the schema and counts thinking as output", async () => {
    const fake = fakeFetch([
      () =>
        geminiResponse({
          // A thought summary part, if one comes back, isn't part of the reply.
          candidates: [{ content: { role: "model", parts: [{ text: "Considering e5...", thought: true }, { text: JSON.stringify(DECISION) }] }, finishReason: "STOP" }],
          usageMetadata: GEMINI_USAGE,
        }),
    ]);
    const model = new GeminiModel({ model: "gemini-3.8-flash", apiKey: "AIza-test", effort: "low", fetch: fake.fn });
    const player = new LlmPlayer({ provider: "google", model: "gemini-3.8-flash" }, model, { input: 0.75, output: 3.75, cachedInput: 0.075 });
    const reply = await player.decide(turn());
    assert.deepEqual(reply, {
      ok: true,
      decision: { action: "move", move: "e5", offerDraw: false, reasoning: "Fighting for the center." },
      // 200 fresh input tokens, 1000 cached, and 80 reply + 500 thinking tokens of output.
      spend: { calls: 1, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 580, costUsd: (200 * 0.75 + 1000 * 0.075 + 580 * 3.75) / 1e6 },
    });
    const { url, body, headers } = fake.requests[0];
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(headers.get("x-goog-api-key"), "AIza-test");
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["reasoning", "action", "move", "offer_draw"]);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
    assert.match(body.systemInstruction.parts[0].text, /playing a game of chess as Black/);
    assert.match(body.contents[0].parts[0].text, /Moves so far: 1\. e4/);
  });

  it("leaves Gemini 2.5's thinking alone, which takes no thinking level", async () => {
    const reply = () => geminiResponse({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
    const fake = fakeFetch([reply, reply]);
    await new GeminiModel({ model: "models/gemini-2.5-pro", apiKey: "k", effort: "high", fetch: fake.fn }).complete({ system: "s", user: "u" });
    await new GeminiModel({ model: "gemini-3.1-pro-preview", apiKey: "k", fetch: fake.fn }).complete({ system: "s", user: "u" });
    assert.match(fake.requests[0].url, /\/models\/gemini-2\.5-pro:generateContent$/);
    assert.equal(fake.requests[0].body.generationConfig.thinkingConfig, undefined);
    assert.equal(fake.requests[1].body.generationConfig.thinkingConfig, undefined);
  });

  it("reports blocked, cut-off and empty replies as unusable, still billed", async () => {
    const fake = fakeFetch([
      () => geminiResponse({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 50 } }),
      () => geminiResponse({ candidates: [{ content: { parts: [{ text: '{"reasoning": "' }] }, finishReason: "MAX_TOKENS" }], usageMetadata: GEMINI_USAGE }),
      () => geminiResponse({ candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }] }),
      () => geminiResponse({ candidates: [{ content: { parts: [{ text: "  " }] }, finishReason: "STOP" }] }),
    ]);
    const model = new GeminiModel({ model: "gemini-3.8-flash", apiKey: "k", fetch: fake.fn });
    const problems = [];
    for (let i = 0; i < 4; i++) {
      const response = await model.complete({ system: "s", user: "u" });
      problems.push("problem" in response ? response.problem : "ok");
      if (i === 1) assert.equal(response.usage?.outputTokens, 580);
    }
    assert.deepEqual(problems, [
      "the request was blocked (SAFETY)",
      "the reply was cut off by the token limit",
      "the reply stopped early (RECITATION)",
      "the reply was empty",
    ]);
  });

  it("classifies API errors, telling used-up credit and daily quota from a short rate limit", async () => {
    const quota = (quotaId: string) =>
      errorResponse(429, {
        error: {
          code: 429,
          message: "You exceeded your current quota.",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] }],
        },
      });
    const fake = fakeFetch([
      () => errorResponse(402, { error: { code: 402, message: "Your prepayment credits are depleted. Please go to AI Studio to add more.", status: "RESOURCE_EXHAUSTED" } }),
      () => quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier"),
      () => errorResponse(429, { error: { code: 429, message: "Your project has exceeded its monthly spending cap.", status: "RESOURCE_EXHAUSTED" } }),
      () => quota("GenerateRequestsPerMinutePerProjectPerModel"),
      () => errorResponse(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }),
      () => errorResponse(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }),
      () => errorResponse(404, { error: { code: 404, message: "models/gemini-nope is not found", status: "NOT_FOUND" } }),
    ]);
    const model = new GeminiModel({ model: "gemini-3.8-flash", apiKey: "k", fetch: fake.fn });
    const call = () => model.complete({ system: "s", user: "u" });
    await assert.rejects(call(), (err: Error) => {
      assert.ok(err instanceof OutOfFundsError);
      assert.equal(err.message, "Gemini API error 402: Your prepayment credits are depleted. Please go to AI Studio to add more.");
      return true;
    });
    await assert.rejects(call(), OutOfFundsError);
    await assert.rejects(call(), OutOfFundsError);
    await assert.rejects(call(), TransientPlayerError);
    await assert.rejects(call(), TransientPlayerError);
    await assert.rejects(call(), (err) => err instanceof FatalPlayerError && !(err instanceof OutOfFundsError));
    await assert.rejects(call(), (err) => err instanceof FatalPlayerError && !(err instanceof OutOfFundsError));
  });

  it("treats a failed connection as transient", async () => {
    const model = new GeminiModel({
      model: "gemini-3.8-flash",
      apiKey: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await assert.rejects(model.complete({ system: "s", user: "u" }), (err: Error) => err instanceof TransientPlayerError && /fetch failed/.test(err.message));
  });
});

function grokResponse(content: string | null, extra: Record<string, unknown> = {}): Response {
  const body = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "grok-4.7",
    choices: [{ index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1300,
      completion_tokens: 60,
      total_tokens: 1760,
      prompt_tokens_details: { cached_tokens: 1024 },
      completion_tokens_details: { reasoning_tokens: 400 },
    },
    ...extra,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Grok player", () => {
  it("uses xAI's Chat Completions API with a strict JSON schema and counts reasoning as output", async () => {
    const fake = fakeFetch([() => grokResponse(JSON.stringify({ ...DECISION, action: "resign", move: null }))]);
    const model = new XaiModel({ model: "grok-4.7", apiKey: "xai-test", effort: "high", fetch: fake.fn });
    const player = new LlmPlayer({ provider: "xai", model: "grok-4.7" }, model, { input: 2, output: 6, cachedInput: 0.5 });
    const reply = await player.decide(turn());
    assert.deepEqual(reply, {
      ok: true,
      decision: { action: "resign", move: null, offerDraw: false, reasoning: "Fighting for the center." },
      // 276 fresh input tokens, 1024 cached, and 60 reply + 400 reasoning tokens of output.
      spend: { calls: 1, inputTokens: 1300, cachedInputTokens: 1024, outputTokens: 460, costUsd: (276 * 2 + 1024 * 0.5 + 460 * 6) / 1e6 },
    });
    const { url, body, headers } = fake.requests[0];
    assert.equal(url, "https://api.x.ai/v1/chat/completions");
    assert.equal(headers.get("authorization"), "Bearer xai-test");
    assert.equal(body.model, "grok-4.7");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.required, ["reasoning", "action", "move", "offer_draw"]);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /playing a game of chess as Black/);
    assert.match(body.messages[1].content, /Moves so far: 1\. e4/);
  });

  it("reports cut-off, refused and empty replies", async () => {
    const fake = fakeFetch([
      () => grokResponse('{"reasoning": "', { choices: [{ index: 0, message: { role: "assistant", content: '{"reasoning": "' }, finish_reason: "length" }] }),
      () => grokResponse(null, { choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "No." }, finish_reason: "stop" }] }),
      () => grokResponse(""),
    ]);
    const model = new XaiModel({ model: "grok-4.3", apiKey: "k", fetch: fake.fn });
    const problems = [];
    for (let i = 0; i < 3; i++) {
      const response = await model.complete({ system: "s", user: "u" });
      problems.push("problem" in response ? response.problem : "ok");
    }
    assert.deepEqual(problems, ["the reply was cut off by the token limit", "the model declined to answer: No.", "the reply was empty"]);
    assert.equal(fake.requests[0].body.reasoning_effort, undefined);
  });

  it("classifies API errors, recognizing a team out of credits", async () => {
    const spendingLimit = () => errorResponse(429, { error: "Your team has reached its monthly spending limit." });
    // The SDK retries 429s twice on its own before giving up.
    const fake = fakeFetch([
      () => errorResponse(403, { code: "The caller does not have permission to execute the specified operation", error: "Your team doesn't have any credits yet. Purchase credits on https://console.x.ai." }),
      spendingLimit,
      spendingLimit,
      spendingLimit,
      () => errorResponse(404, { code: "Some requested entity was not found", error: "The model grok-nope does not exist or your team does not have access to it." }),
      () => errorResponse(401, { error: "Incorrect API key provided: xa***st." }),
    ]);
    const model = new XaiModel({ model: "grok-4.7", apiKey: "k", fetch: fake.fn });
    const call = () => model.complete({ system: "s", user: "u" });
    await assert.rejects(call(), (err: Error) => {
      assert.ok(err instanceof OutOfFundsError);
      assert.equal(err.message, "xAI API error 403: Your team doesn't have any credits yet. Purchase credits on https://console.x.ai.");
      return true;
    });
    await assert.rejects(call(), (err: Error) => err instanceof OutOfFundsError && /429: Your team has reached its monthly spending limit/.test(err.message));
    await assert.rejects(call(), (err: Error) => err instanceof FatalPlayerError && !(err instanceof OutOfFundsError) && /does not exist/.test(err.message));
    await assert.rejects(call(), (err: Error) => err instanceof FatalPlayerError && /401: Incorrect API key/.test(err.message));
  });
});
