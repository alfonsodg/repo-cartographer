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
| `-m, --model <id>` | Cerebras model id (default Kimi K3.1 Pro trial) |
| `-o, --out <file>` | Write output to a file |
| `-j, --json` | Print the raw index, no model call |
| `--max-files <n>` | Scan limit (default 25000) |
| `--timeout <s>` | Request timeout (default 180) |
| `--reasoning <lvl>` | `reasoning_effort`: low, medium, high |

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

## Measured on real repos

Benchmark with `moonshotai-kimi-k3.1-pro-trial` (reasoning on, `low`):

| repo | files | source | scan | compression | inference | speed |
| --- | --- | --- | --- | --- | --- | --- |
| camoufox | 805 | 441 | 184 ms | 322x | 5.6 s | 215 tok/s |
| herdr | 1737 | 516 | 201 ms | 823x | 10.6 s | 113 tok/s |

The structural scan is the part that stays constant: under a quarter of a second
whether the repo has 800 files or 1,700. Inference time scales with how much the
model has to write, not with how big the repo is — that is the whole point of
compressing first.

A full briefing for an 805-file repository (`camoufox`) is 1,740 output tokens
from 4,827 input tokens, and reads like this:

> **`browser/patches/`** — The core Firefox changes: navigator, screen, WebGL,
> fonts, locale, timezone, WebRTC, media, input, and automation-behavior patches.
> `patch-dependencies.md` documents patch ordering and relationships.
>
> **Fingerprint consistency:** Python and TypeScript contain parallel
> utility/fingerprint implementations. Drift between them — or between
> configuration and native injection — can create a detectable, impossible
> device.

Those are real paths and real risks from the index, not generic advice.

## Tests

```bash
node --test
```

## License

MIT
