# Repo Cartographer

Explain an unfamiliar repository in one command: a module graph plus a written
briefing, both derived from the same structural scan.

Designed to run **inside OpenClaw** as a skill, with Cerebras inference for the
written part. The scan is deterministic and model-free; only the briefing calls
a model.

## Why it is fast

Two stages, deliberately separated:

1. **Structural index, no model.** Walks the tree, detects languages, parses
   manifests, resolves imports into a graph, ranks modules by how many others
   import them, and scores entry points. Milliseconds — an 800-file repo in
   about 180 ms.
2. **Reasoning.** The index is compressed into a dense prompt. The model reads
   a map of the codebase, never the source, so cost does not grow with repo size.

## Use it from OpenClaw

The tool is meant to be driven by an agent, not by hand. A skill lives at
`~/.claude/skills/repo-cartographer/SKILL.md` and instructs the agent to:

```bash
# 1. structural facts
node cartographer.mjs "$REPO" --json

# 2. the diagram, terminal-safe
node cartographer.mjs "$REPO" --mermaid --plain --flat --max-modules 8 -o ARCH.md
mermaid-ascii --file ARCH.md --ascii

# 3. the written briefing
node cartographer.mjs "$REPO" -o BRIEFING.md
```

Run the agent with a reduced context so the prompt stays under the rate limit:

```bash
openclaw agent exec --cwd "$REPO" --model cerebras/gpt-oss-120b --thinking off \
  --config-override '{"agents":{"entries":{"main":{"skills":[]}}}}' \
  "Scan this repository with the cartographer tool, draw its graph, and paste \
   the diagram. Then report what the scan could not see."
```

Without `--config-override` the agent loads every installed skill and the
request exceeds the token quota before it reaches the tool.

## Install

```bash
git clone <repo> && cd repo-cartographer
export CEREBRAS_API_KEY=csk-...
```

No dependencies. Node 20+. Optional: `mermaid-ascii` for terminal rendering.

## Usage

```bash
# Full briefing
node cartographer.mjs /path/to/repo

# Module diagram, renders natively on GitHub
node cartographer.mjs . --mermaid

# Diagram for a terminal
node cartographer.mjs . --mermaid --plain --flat

# Ask one question
node cartographer.mjs . -q "where is authentication handled?"

# Structural index only
node cartographer.mjs . --json > index.json
```

## The diagram

Modules are grouped into architectural layers inferred from the import graph:

| Layer | Detected by |
| --- | --- |
| **Entry points** | Known entries (`main`, `cli`), or barely imported code |
| **Core** | Imported by a large share of the repo — the load-bearing code |
| **Boundaries** | Wide fan-in *and* fan-out; interfaces others route through |
| **Leaves** | Mostly consumed, import little |

Each box carries its degree as `in / out`. Arrow weight encodes how many import
statements connect two modules.

Two flags exist because terminals are not browsers:

- `--plain` strips HTML from labels. ASCII renderers print `<small>` verbatim.
- `--flat` drops layer subgraphs, which `mermaid-ascii` lays out badly.

Omit both for a README or a browser and the diagram gains colour and bands.

```bash
node cartographer.mjs . --mermaid --depth 1        # coarser grouping
node cartographer.mjs . --mermaid --max-modules 30 # more boxes
node cartographer.mjs . --mermaid -o ARCH.md       # save it
```

## Options

| Flag | Meaning |
| --- | --- |
| `-q, --question <text>` | One question instead of a briefing |
| `-m, --model <id>` | Cerebras model id |
| `-o, --out <file>` | Write output to a file |
| `-j, --json` | Raw index, no model call |
| `--mermaid` | Mermaid diagram, no model call |
| `--depth <n>` | Module depth for `--mermaid` (default 2) |
| `--max-modules <n>` | Modules drawn (default 22) |
| `--flat` | No layer bands |
| `--plain` | Plain labels for ASCII renderers |
| `--max-files <n>` | Scan limit (default 25000) |
| `--timeout <s>` | Request timeout (default 180) |
| `--reasoning <lvl>` | `reasoning_effort`: low, medium, high |

## Project layout

```text
cartographer.mjs     CLI, argument parsing, output formatting
src/indexer.mjs      structural scan and import graph
src/mermaid.mjs      module-level diagram export
src/prompt.mjs       index to prompt compression
src/cerebras.mjs     inference client with timing breakdown
bench.mjs            benchmark across repositories
```

## Measured on real repositories

Scan time is model-free and roughly flat as repositories grow:

| repo | stack | files | source | scan |
| --- | --- | --- | --- | --- |
| ohmycaptcha | Python | 76 | 18 | 13 ms |
| gorm | Go | 174 | 163 | 18 ms |
| OpenSign | JS | 678 | 532 | 206 ms |
| open-design | TypeScript | 2,494 | 965 | 969 ms |
| herdr | Rust | 1,737 | 516 | 201 ms |
| lightdash | TypeScript | 12,626 | 10,911 | 13.4 s |

On `herdr`: 3.1M tokens of source compress to 3,929 tokens of map — 799× — which
is what keeps the model call cheap.

## Models

Kimi K3.1 Pro is the model this was built for. Its preview queue fills up under
load, so a request can come back `429 queue_exceeded` while the model still
answers the next minute. Rather than fail on the first run, the client retries
once on `gpt-oss-120b` — same provider, same API shape, less reasoning — and
says so on stderr:

```text
moonshotai-kimi-k3.1-pro-trial was unavailable — answered with gpt-oss-120b
```

Point `--model` at anything else to skip the fallback.

## On throughput numbers

Cerebras returns a server-side timing breakdown and the split matters:

```text
queue       20 ms   waiting for capacity
prefill     61 ms
decode     940 ms
speed    1762.8 tok/s   (decode only)
```

During a contested period `queue_time` dominates. Folding it into a tok/s figure
reports platform congestion, not model speed, so the tool reports decode
throughput and shows queue time separately.

## Tests

```bash
node --test
```

## License

MIT
