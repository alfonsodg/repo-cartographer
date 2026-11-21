#!/usr/bin/env node
/**
 * Bench — measure scan time, compression ratio and inference speed
 * across several repositories. Output is a markdown table you can paste
 * straight into the submission post.
 *
 *   CEREBRAS_API_KEY=... node bench.mjs ~/repo1 ~/repo2
 *   node bench.mjs --scan-only ~/repo1 ~/repo2
 */
import { indexRepo } from "./src/indexer.mjs";
import { buildPrompt } from "./src/prompt.mjs";
import { chat, resolveApiKey } from "./src/cerebras.mjs";

const args = process.argv.slice(2);
const scanOnly = args.includes("--scan-only");
const repos = args.filter((a) => !a.startsWith("--"));

if (repos.length === 0) {
  console.error("usage: node bench.mjs [--scan-only] <repo> [repo...]");
  process.exit(1);
}

const rows = [];

for (const repo of repos) {
  const idx = await indexRepo(repo);
  const prompt = buildPrompt(idx);
  const sourceTokens = Math.round(idx.stats.totalBytes / 4);
  const promptTokens = Math.round(prompt.length / 4);

  const row = {
    repo: repo.split("/").filter(Boolean).pop(),
    files: idx.stats.totalFiles,
    source: idx.stats.sourceFiles,
    langs: idx.languages.slice(0, 3).map(([l, n]) => `${l} ${n}`).join(", "),
    scanMs: idx.elapsedMs,
    compression: `${(sourceTokens / promptTokens).toFixed(0)}x`,
    promptTokens,
    queueMs: null,
    decodeMs: null,
    tps: null,
    outTokens: null,
  };

  if (!scanOnly) {
    const { key } = resolveApiKey();
    if (!key) {
      console.error("error: CEREBRAS_API_KEY not set (use --scan-only to skip inference)");
      process.exit(2);
    }
    try {
      const res = await chat({
        apiKey: key,
        model: process.env.BENCH_MODEL ?? undefined,
        messages: [
          { role: "system", content: "You are a codebase analyst. Be concise." },
          { role: "user", content: prompt },
        ],
        maxTokens: 1200,
        reasoningEffort: "low",
      });
      row.queueMs = res.timing.queueMs;
      row.decodeMs = res.timing.completionMs;
      row.tps = res.timing.tokensPerSecond;
      row.outTokens = res.usage.completionTokens;
    } catch (err) {
      row.decodeMs = `ERR ${err.status ?? ""}`;
      console.error(`${row.repo}: ${err.message}`);
    }
  }

  rows.push(row);
}

const header = scanOnly
  ? ["repo", "files", "source", "languages", "scan ms", "compression"]
  : [
      "repo", "files", "source", "languages", "scan ms", "compression",
      "queue ms", "decode ms", "tok/s",
    ];

console.log("");
console.log("| " + header.join(" | ") + " |");
console.log("|" + header.map(() => "---").join("|") + "|");
for (const r of rows) {
  const cells = [r.repo, r.files, r.source, r.langs, r.scanMs, r.compression];
  if (!scanOnly) cells.push(r.queueMs, r.decodeMs, r.tps);
  console.log("| " + cells.join(" | ") + " |");
}
console.log("");
if (!scanOnly) {
  console.log("tok/s is decode throughput; queue time is reported separately.");
  console.log("");
}
