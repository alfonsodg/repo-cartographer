export const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
export const DEFAULT_MODEL = "moonshotai-kimi-k3.1-pro-trial";

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
  const tps = completionTokens > 0 ? completionTokens / (elapsedMs / 1000) : 0;

  return {
    content: json.choices?.[0]?.message?.content ?? "",
    reasoning: json.choices?.[0]?.message?.reasoning ?? null,
    finishReason: json.choices?.[0]?.finish_reason ?? null,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens,
      totalTokens,
    },
    timing: {
      elapsedMs: Math.round(elapsedMs),
      tokensPerSecond: Number(tps.toFixed(1)),
    },
    model: json.model ?? model,
  };
}
