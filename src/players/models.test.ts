import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FatalPlayerError } from "../game/types.js";
import { canPlay, listModels, suggestModels } from "./models.js";

/** A fetch stand-in that records request URLs and headers and answers from a queue. */
function fakeFetch(responses: unknown[], status = 200) {
  const requests: { url: string; headers: Headers }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const body = responses.shift();
    if (body === undefined) throw new Error("no fake response left");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, requests };
}

const claude = (id: string, name: string, structuredOutputs = true) => ({
  type: "model",
  id,
  display_name: name,
  created_at: "2026-09-01T00:00:00Z",
  lifecycle: "active",
  capabilities: { structured_outputs: { supported: structuredOutputs } },
});

describe("model lists", () => {
  it("lists Claude models across pages, skipping ones without structured outputs", async () => {
    const fake = fakeFetch([
      { data: [claude("claude-fable-5-1", "Claude Fable 5.1"), claude("claude-old", "Claude Old", false)], has_more: true, first_id: "claude-fable-5-1", last_id: "claude-old" },
      { data: [claude("claude-opus-5-5", "Claude Opus 5.5")], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" },
    ]);
    const models = await listModels("anthropic", "sk-ant-test", { fetch: fake.fn });
    assert.deepEqual(models, [
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    ]);
    assert.equal(fake.requests.length, 2);
    assert.match(fake.requests[0].url, /\/v1\/models\?.*lifecycle/);
    assert.match(fake.requests[1].url, /after_id=claude-old/);
    assert.equal(fake.requests[0].headers.get("x-api-key"), "sk-ant-test");
  });

  it("lists OpenAI models newest first", async () => {
    const fake = fakeFetch([
      {
        object: "list",
        data: [
          { id: "gpt-5.6-luna", object: "model", created: 100, owned_by: "openai" },
          { id: "gpt-5.6-sol", object: "model", created: 300, owned_by: "openai" },
          { id: "text-embedding-3-large", object: "model", created: 200, owned_by: "openai" },
        ],
      },
    ]);
    const models = await listModels("openai", "sk-test", { fetch: fake.fn });
    assert.deepEqual(models.map((m) => m.id), ["gpt-5.6-sol", "text-embedding-3-large", "gpt-5.6-luna"]);
    assert.match(fake.requests[0].url, /\/v1\/models$/);
    assert.equal(fake.requests[0].headers.get("authorization"), "Bearer sk-test");
  });

  it("lists Gemini models that can generate content across pages, newest version first", async () => {
    const gemini = (name: string, displayName: string, methods = ["generateContent", "countTokens"]) => ({
      name: `models/${name}`,
      displayName,
      supportedGenerationMethods: methods,
    });
    const fake = fakeFetch([
      { models: [gemini("gemini-2.5-pro", "Gemini 2.5 Pro"), gemini("gemini-embedding-001", "Gemini Embedding", ["embedContent"])], nextPageToken: "next" },
      { models: [gemini("gemini-3-pro", "Gemini 3 Pro")] },
    ]);
    const models = await listModels("google", "AIza-test", { fetch: fake.fn });
    assert.deepEqual(models, [
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ]);
    assert.match(fake.requests[0].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000$/);
    assert.match(fake.requests[1].url, /pageToken=next$/);
    assert.equal(fake.requests[0].headers.get("x-goog-api-key"), "AIza-test");
  });

  it("lists Grok models from xAI's API, newest first", async () => {
    const fake = fakeFetch([
      {
        object: "list",
        data: [
          { id: "grok-3-mini", object: "model", created: 100, owned_by: "xai" },
          { id: "grok-4", object: "model", created: 300, owned_by: "xai" },
        ],
      },
    ]);
    const models = await listModels("xai", "xai-test", { fetch: fake.fn });
    assert.deepEqual(models.map((m) => m.id), ["grok-4", "grok-3-mini"]);
    assert.equal(fake.requests[0].url, "https://api.x.ai/v1/models");
    assert.equal(fake.requests[0].headers.get("authorization"), "Bearer xai-test");
  });

  it("reports a rejected key", async () => {
    const fake = fakeFetch([{ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }], 401);
    await assert.rejects(
      listModels("anthropic", "bad", { fetch: fake.fn }),
      (err) => err instanceof FatalPlayerError && err.message === "Anthropic API error 401: invalid x-api-key",
    );
  });

  it("keeps OpenAI chat models with structured outputs", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-luna-2026-07-30", "gpt-4o", "gpt-4.1-mini", "o3", "o4-mini", "gpt-5-codex"]) {
      assert.ok(canPlay("openai", id), id);
    }
    for (const id of ["text-embedding-3-large", "dall-e-3", "whisper-1", "gpt-image-1", "gpt-4o-audio-preview", "gpt-4o-realtime-preview", "gpt-4o-mini-tts", "gpt-4o-transcribe", "gpt-4o-search-preview", "omni-moderation-latest", "gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "o1-mini", "o3-deep-research"]) {
      assert.ok(!canPlay("openai", id), id);
    }
    assert.ok(canPlay("anthropic", "claude-anything"));
    for (const id of ["gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3-pro-preview", "gemini-3.5-flash", "gemini-flash-latest"]) {
      assert.ok(canPlay("google", id), id);
    }
    for (const id of ["gemini-2.0-flash", "gemini-embedding-001", "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-native-audio-latest", "gemini-live-2.5-flash", "gemma-3-27b-it", "imagen-4.0-generate-001"]) {
      assert.ok(!canPlay("google", id), id);
    }
    for (const id of ["grok-4", "grok-4-1-fast-reasoning", "grok-3-mini", "grok-code-fast-1"]) assert.ok(canPlay("xai", id), id);
    for (const id of ["grok-2-image-1212", "grok-imagine-video", "grok-imagine-image"]) assert.ok(!canPlay("xai", id), id);
  });

  it("suggests configured models first, then the rest that can play", () => {
    const available = [
      { id: "gpt-5.6-terra" },
      { id: "text-embedding-3-large" },
      { id: "gpt-5.6-sol" },
      { id: "ft:gpt-4o:me::abc" },
    ];
    assert.deepEqual(
      suggestModels("openai", ["gpt-5.6-sol", "ft:gpt-4o:me::abc", "gpt-gone"], available).map((m) => m.id),
      ["gpt-5.6-sol", "ft:gpt-4o:me::abc", "gpt-5.6-terra"],
    );
    assert.deepEqual(suggestModels("openai", ["gpt-5.6-sol"]), [{ id: "gpt-5.6-sol" }]);
  });
});
