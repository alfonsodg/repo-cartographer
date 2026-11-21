export const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";

// Kimi is the model this was built for, but its preview queue fills up under
// load and answers 429 queue_exceeded. The fallback keeps the tool working
// instead of failing on the first run: same provider, same API shape, only the
// reasoning quality differs.
export const DEFAULT_MODEL = "moonshotai-kimi-k3.1-pro-trial";
export const FALLBACK_MODEL = "gpt-oss-120b";

export const FALLBACK_STATUS = new Set([429, 503]);

export function resolveApiKey() {
  const fromEnv = process.env.CEREBRAS_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "CEREBRAS_API_KEY" };

  const fileKey = process.env.CEREBRAS_KEY_FILE;
  if (fileKey) {
    try {
      const raw = require("node:fs").readFileSync(fileKey, "utf8").trim();
      if (raw) return { key: raw, source: fileKey };
    } catch {
      /* fall through */
    }
  }
  return { key: null, source: null };
}

export async function chat({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  messages,
  maxTokens = 2000,
  temperature = 0.2,
  reasoningEffort = "low",
  signal,
  fallbackModel = FALLBACK_MODEL,
}) {
  try {
    return await requestOnce({
      apiKey, baseUrl, model, messages, maxTokens, temperature, reasoningEffort, signal,
    });
  } catch (err) {
    // A full preview queue is transient and says nothing about the request.
    // Retrying on the stable model beats handing the caller a 429.
    const transient = FALLBACK_STATUS.has(err.status) && fallbackModel && fallbackModel !== model;
    if (!transient) throw err;

    const retried = await requestOnce({
      apiKey, baseUrl, model: fallbackModel, messages, maxTokens, temperature,
      reasoningEffort, signal,
    });
    retried.fellBackFrom = model;
    return retried;
  }
}

async function requestOnce({
  apiKey, baseUrl, model, messages, maxTokens, temperature, reasoningEffort, signal,
}) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const started = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const elapsedMs = performance.now() - started;
  const text = await res.text();

  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message ?? parsed.error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    const err = new Error(`Cerebras ${res.status}: ${detail}`);
    err.status = res.status;
    err.raw = text;
    throw err;
  }

  const json = JSON.parse(text);
  const usage = json.usage ?? {};
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? 0;

  // Cerebras reports server-side breakdown. queue_time is time spent waiting
  // for capacity and must not be folded into throughput: during a shared
  // hackathon it swamps the real decode rate.
  const ti = json.time_info ?? {};
  const queueMs = Math.round((ti.queue_time ?? 0) * 1000);
  const promptMs = Math.round((ti.prompt_time ?? 0) * 1000);
  const completionMs = Math.round((ti.completion_time ?? 0) * 1000);

  const decodeSeconds = completionMs / 1000;
  const tps = decodeSeconds > 0
    ? completionTokens / decodeSeconds
    : completionTokens / (elapsedMs / 1000);

  return {
    content: json.choices?.[0]?.message?.content ?? "",
    reasoning: json.choices?.[0]?.message?.reasoning ?? null,
    finishReason: json.choices?.[0]?.finish_reason ?? null,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens,
      totalTokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    timing: {
      elapsedMs: Math.round(elapsedMs),
      queueMs,
      promptMs,
      completionMs,
      tokensPerSecond: Number(tps.toFixed(1)),
    },
    model: json.model ?? model,
  };
}
