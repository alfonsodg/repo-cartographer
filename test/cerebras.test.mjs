import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, FALLBACK_STATUS, DEFAULT_MODEL, FALLBACK_MODEL } from "../src/cerebras.mjs";

// The client is exercised against a stub fetch so the tests never touch the
// network. What matters is the decision: retry only on a transient status, and
// never retry when the caller already chose the fallback model.

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra call");
    return {
      ok: next.status === 200,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const okBody = (model) => ({
  model,
  choices: [{ message: { content: "briefing" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  time_info: { queue_time: 0.01, prompt_time: 0.02, completion_time: 0.1 },
});

test("falls back when the primary model queue is full", async () => {
  const stub = stubFetch([
    { status: 429, body: { message: "queue full", code: "queue_exceeded" } },
    { status: 200, body: okBody(FALLBACK_MODEL) },
  ]);
  try {
    const res = await chat({
      apiKey: "k",
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(stub.calls.length, 2, "retries exactly once");
    assert.equal(stub.calls[0], DEFAULT_MODEL);
    assert.equal(stub.calls[1], FALLBACK_MODEL);
    assert.equal(res.model, FALLBACK_MODEL);
    assert.equal(res.fellBackFrom, DEFAULT_MODEL, "reports what it fell back from");
    assert.equal(res.content, "briefing");
  } finally {
    stub.restore();
  }
});

test("does not retry on a non-transient error", async () => {
  const stub = stubFetch([
    { status: 400, body: { message: "bad request" } },
  ]);
  try {
    await assert.rejects(
      () => chat({ apiKey: "k", model: DEFAULT_MODEL, messages: [] }),
      /Cerebras 400/
    );
    assert.equal(stub.calls.length, 1, "no retry for a client error");
  } finally {
    stub.restore();
  }
});

test("does not retry when already on the fallback model", async () => {
  const stub = stubFetch([
    { status: 429, body: { message: "queue full" } },
  ]);
  try {
    await assert.rejects(
      () => chat({ apiKey: "k", model: FALLBACK_MODEL, messages: [] }),
      /Cerebras 429/
    );
    assert.equal(stub.calls.length, 1, "never loops on the same model");
  } finally {
    stub.restore();
  }
});

test("429 and 503 are the transient statuses", () => {
  assert.ok(FALLBACK_STATUS.has(429));
  assert.ok(FALLBACK_STATUS.has(503));
  assert.ok(!FALLBACK_STATUS.has(400));
  assert.ok(!FALLBACK_STATUS.has(401));
});
