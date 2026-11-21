#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexRepo } from "./src/indexer.mjs";
import { buildPrompt, SYSTEM_BRIEF } from "./src/prompt.mjs";
import { chat, resolveApiKey, DEFAULT_MODEL } from "./src/cerebras.mjs";
import { toMermaid } from "./src/mermaid.mjs";

const HELP = `repo-cartographer — explain any codebase in one command

Usage:
  cartographer <path> [options]

Options:
  -q, --question <text>   Ask a specific question instead of a full briefing
  -m, --model <id>        Cerebras model (default: ${DEFAULT_MODEL})
  -o, --out <file>        Write the briefing to a file
  -j, --json              Print the raw index as JSON (no LLM call)
      --mermaid           Print a Mermaid diagram (no LLM call)
      --depth <n>         Module depth for --mermaid (default 2)
      --max-modules <n>   Modules in the diagram (default 22)
      --flat              No architectural layer bands
      --plain             Plain-text labels (for ASCII renderers)
      --edge-labels       Show import counts on edges
      --max-files <n>     File scan limit (default: 25000)
      --timeout <s>       Request timeout in seconds (default: 180)
      --reasoning <lvl>   reasoning_effort: low|medium|high (default: low)
  -h, --help              Show this help

Environment:
  CEREBRAS_API_KEY        API key (required unless --json)
  REPO_CARTOGRAPHER_DEBUG Set to 1 to print the prompt

Examples:
  cartographer .
  cartographer ~/code/my-app -q "where is authentication handled?"
  cartographer . --json > index.json
`;

function parseArgs(argv) {
  const opts = {
    path: null,
    question: null,
    model: DEFAULT_MODEL,
    out: null,
    json: false,
    mermaid: false,
    flat: false,
    plain: false,
    edgeLabels: false,
    depth: 2,
    maxModules: 22,
    maxFiles: 25000,
    timeout: 180,
    reasoning: "low",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h": case "--help": opts.help = true; break;
      case "-q": case "--question": opts.question = argv[++i]; break;
      case "-m": case "--model": opts.model = argv[++i]; break;
      case "-o": case "--out": opts.out = argv[++i]; break;
      case "-j": case "--json": opts.json = true; break;
      case "--mermaid": opts.mermaid = true; break;
      case "--flat": opts.flat = true; break;
      case "--plain": opts.plain = true; break;
      case "--edge-labels": opts.edgeLabels = true; break;
      case "--depth": opts.depth = Number(argv[++i]); break;
      case "--max-modules": opts.maxModules = Number(argv[++i]); break;
      case "--max-files": opts.maxFiles = Number(argv[++i]); break;
      case "--timeout": opts.timeout = Number(argv[++i]); break;
      case "--reasoning": opts.reasoning = argv[++i]; break;
      default:
        if (!arg.startsWith("-") && !opts.path) opts.path = arg;
        break;
    }
  }
  return opts;
}

function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.path) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const root = resolve(opts.path.replace(/^~/, process.env.HOME ?? "~"));

  process.stderr.write(dim(`scanning ${root} ...`) + "\n");
  const index = await indexRepo(root, { maxFiles: opts.maxFiles });

  if (opts.json) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }

  if (opts.mermaid) {
    const diagram = toMermaid(index, {
      depth: opts.depth,
      maxModules: opts.maxModules,
      layers: !opts.flat,
      plain: opts.plain,
      edgeLabels: opts.edgeLabels,
    });
    const out = diagram.mermaid;
    if (opts.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.out, out);
      process.stderr.write(green(`wrote ${opts.out}`) + "\n");
    } else {
      process.stdout.write(out);
    }
    const layerText = Object.entries(diagram.layers)
      .filter(([, n]) => n > 0)
      .map(([role, n]) => `${role}:${n}`)
      .join(" ");
    process.stderr.write(
      dim(`${diagram.modules} modules · ${diagram.edges} edges · depth ${diagram.depth}`) +
        (layerText ? dim(` · ${layerText}`) : "") + "\n"
    );
    return;
  }

  const { key, source } = resolveApiKey();
  if (!key) {
    console.error("error: CEREBRAS_API_KEY is not set");
    console.error("hint: export CEREBRAS_API_KEY=... (see https://cloud.cerebras.ai)");
    process.exit(2);
  }

  const prompt = buildPrompt(index, opts.question);
  if (process.env.REPO_CARTOGRAPHER_DEBUG === "1") {
    process.stderr.write(dim("--- prompt ---\n") + prompt + "\n" + dim("--- end ---\n"));
  }

  process.stderr.write(
    dim(`${index.stats.totalFiles} files · ${index.stats.sourceFiles} source · `) +
    dim(`${index.languages.map(([l, n]) => `${l}:${n}`).join(" ")}`) + "\n"
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout * 1000);

  let result;
  try {
    result = await chat({
      apiKey: key,
      model: opts.model,
      messages: [
        { role: "system", content: SYSTEM_BRIEF },
        { role: "user", content: prompt },
      ],
      maxTokens: 3000,
      reasoningEffort: opts.reasoning,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      console.error(`error: request timed out after ${opts.timeout}s`);
      process.exit(3);
    }
    console.error(`error: ${err.message}`);
    if (err.status === 404) {
      console.error("");
      console.error("The model is not enabled for your account. Check:");
      console.error("  curl -s https://api.cerebras.ai/v1/models -H \"Authorization: Bearer $CEREBRAS_API_KEY\"");
    }
    process.exit(4);
  }
  clearTimeout(timer);

  const output = result.content.trim();
  if (opts.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(opts.out, output + "\n");
    process.stderr.write(green(`wrote ${opts.out}`) + "\n");
  } else {
    console.log(output);
  }

  const t = result.timing;
  const u = result.usage;
  const pad = (s) => s.padEnd(8);
  process.stderr.write(
    "\n" +
    dim("─".repeat(60)) + "\n" +
    `${cyan(pad("model"))} ${result.model}\n` +
    `${cyan(pad("tokens"))} ${u.completionTokens} out / ${u.promptTokens} in` +
      (u.reasoningTokens ? dim(` (${u.reasoningTokens} reasoning)`) : "") + "\n" +
    `${cyan(pad("queue"))} ${t.queueMs} ms` + dim("  waiting for capacity") + "\n" +
    `${cyan(pad("prefill"))} ${t.promptMs} ms\n` +
    `${cyan(pad("decode"))} ${t.completionMs} ms\n` +
    `${cyan(pad("total"))} ${t.elapsedMs} ms\n` +
    `${cyan(pad("speed"))} ${bold(t.tokensPerSecond + " tok/s")}` +
      dim("  (decode only)") + "\n"
  );
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
