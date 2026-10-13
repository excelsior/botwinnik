import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { FatalPlayerError, TransientPlayerError, type TurnInfo } from "../game/types.js";
import { illegalMoveBonusMs, parseTimeControl, timeCategory } from "../timeControl.js";
import { AnthropicModel } from "./anthropic.js";
import { LlmPlayer } from "./llmPlayer.js";
import { OpenAIModel } from "./openai.js";

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
  const requests: { url: string; body: any }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
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

  it("classifies API errors, including an exhausted quota", async () => {
    const quota = () => errorResponse(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } });
    const notFound = () => errorResponse(404, { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } });
    // The SDK retries 429s twice on its own before giving up.
    const fake = fakeFetch([quota, quota, quota, notFound]);
    const model = new OpenAIModel({ model: "gpt-nope", apiKey: "k", fetch: fake.fn });
    await assert.rejects(model.complete({ system: "s", user: "u" }), FatalPlayerError);
    await assert.rejects(model.complete({ system: "s", user: "u" }), /^Error: OpenAI API error 404: The model does not exist$/);
  });
});
