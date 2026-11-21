# Repo Cartographer

Explain any codebase in one command.

Point it at a repository and get a briefing an engineer can actually use: what
the project is, how it is organised, where to start reading, how a request
flows through the system, which areas are fragile, and what to do in the first
week.

Built for the **Cerebras × Kimi K3.1 Pro Hackathon**. The speed of Cerebras
inference is the point: a structural scan plus a full briefing in seconds, not
minutes.

## Why it is fast

Two stages, deliberately separated:

1. **Structural index (no LLM).** Walks the repo, detects languages, finds
   manifests, parses imports, builds an internal import graph, ranks the
   most-imported modules, and identifies entry points. Runs in milliseconds —
   an 800-file repo indexes in about 180 ms.
2. **Reasoning (Kimi on Cerebras).** The index is compressed into a dense
   prompt and sent to the model. Because the index already did the expensive
   work, the model receives a small, high-signal payload instead of raw source.

That split is why it is fast: the model never reads your source, it reads a map
of it.

## Install

```bash
git clone <repo> && cd repo-cartographer
export CEREBRAS_API_KEY=csk-...        # https://cloud.cerebras.ai
```

No dependencies. Node 20+ only.

## Usage

```bash
# Full briefing
node cartographer.mjs /path/to/repo

# Ask a specific question
node cartographer.mjs . -q "where is authentication handled?"

# Structural index only, no LLM call
node cartographer.mjs . --json > index.json

# Save the briefing
node cartographer.mjs . -o BRIEFING.md
```

Or install the binary:

```bash
npm link
cartographer /path/to/repo
```

## Options

| Flag | Meaning |
| --- | --- |
| `-q, --question <text>` | Ask one question instead of a briefing |
| `-m, --model <id>` | Cerebras model id |
| `-o, --out <file>` | Write output to a file |
| `-j, --json` | Print the raw index, no model call |
| `--max-files <n>` | Scan limit (default 25000) |
| `--timeout <s>` | Request timeout (default 180) |
| `--reasoning <lvl>` | `reasoning_effort`: off, low, medium, high |

Environment: `CEREBRAS_API_KEY`; set `REPO_CARTOGRAPHER_DEBUG=1` to dump the
prompt.

## What the briefing contains

- **What this is** — purpose and stack in plain language
- **Architecture** — the major parts and how they relate
- **Where to start reading** — an ordered list of files, each with a reason
- **Main flow** — how a request travels from entry point to output
- **Risky or complex areas** — where a newcomer breaks things
- **First tasks** — three concrete things to do this week

## How the index works

`src/indexer.mjs` does the structural work:

- Skips `node_modules`, `.git`, build output, virtualenvs, caches
- Detects language per file across about 30 extensions
- Parses `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`
- Extracts imports for TS/JS/Python/Rust/Go and resolves relative paths into an
  internal graph
- Ranks files by how many others import them — that is the de facto core
- Scores entry points by filename, `bin`/`main` manifest fields, and convention
- Samples README, `AGENTS.md` and `CLAUDE.md` for project conventions

Everything is bounded (file count, depth, bytes per file) so a monorepo cannot
hang it.

## Project layout

```text
cartographer.mjs     CLI, argument parsing, output formatting
src/indexer.mjs      structural scan and import graph
src/prompt.mjs       index to prompt compression
src/cerebras.mjs     Cerebras Inference API client with TPS measurement
bench.mjs            benchmark across repositories
```

## Measured on a real repo

`camoufox` (805 files, 441 source, 5.5 MB of source):

```text
scan       180 ms
inference  1491 ms
output     1511 tokens
speed      1013 tok/s
```

The whole briefing — structure, architecture, reading order, main flow, risks
and first tasks — lands in under two seconds.

Benchmark across repositories:

| repo | files | scan ms | compression |
| --- | --- | --- | --- |
| camoufox | 805 | 180 | 322x |
| herdr | 1737 | 327 | 823x |

## Tests

```bash
node --test
```

## License

MIT
