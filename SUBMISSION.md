# Submission copy — Cerebras × Kimi K3.1 Pro Hackathon

Deadline: **Sunday 22 Nov 2026, 10:00 AM PT**.

The post on X is the official submission.

## X post (primary submission)

**Project Name:** Repo Cartographer

**Team Members:** @alfonsodg

**Project Description:**

Repo Cartographer explains any codebase in seconds. It builds a structural index
of a repository — languages, entry points, most-imported modules, import graph —
and compresses 1.4M tokens of source into a 4.8K-token map. Kimi K3.1 Pro on
Cerebras then reasons over that map and writes a briefing an engineer can
actually use: architecture, where to start reading, how a request flows, what is
fragile, what to do first. Up to 823x compression, sub-second structural scan.

**Demo Video:** 60s max, attached.

**GitHub Repository:** <https://github.com/alfonsodg/repo-cartographer>

```text
#KimiOnCerebras @Cerebras @Kimi_Moonshot
```

## Reddit post (r/cerebras) — optional, second $1k

Flair: **Kimi K3.1 Pro Hackathon**

**Title:** I built a tool that explains a 1,700-file repo in 2 seconds
(Kimi K3.1 Pro on Cerebras)

**Body:**

The slow part of understanding a new codebase is that an agent has to read the
files. Reading 5 MB of source is about 1.4M tokens — that is minutes of prefill
no matter how fast your inference is.

So I split the problem. Stage one is deterministic and has no model in it: walk
the repo, detect languages, parse manifests, resolve imports into a graph, rank
modules by how many others import them, score entry points. That runs in
**184-201 ms** for repos of 800-1,700 files — the scan does not care how big the
repo is.

Stage two sends only the *map* to the model: 4.8K tokens instead of 1.4M. That
is **322x compression** (823x on a Rust repo). Kimi never reads the source, it
reads the structure — so inference time scales with the briefing, not the
codebase.

Measured with `moonshotai-kimi-k3.1-pro-trial`:

| repo | files | scan | compression | inference | speed |
| --- | --- | --- | --- | --- | --- |
| camoufox | 805 | 184 ms | 322x | 5.6 s | 215 tok/s |
| herdr | 1737 | 201 ms | 823x | 10.6 s | 113 tok/s |

The output is not a summary. It names real files, explains the import graph,
orders the files you should read, walks a request from entry point to output,
and flags what will break first. Real line from the camoufox briefing:

> Python and TypeScript contain parallel utility/fingerprint implementations.
> Drift between them — or between configuration and native injection — can
> create a detectable, impossible device.

What broke, and what I learned:

- The deployed model name moved between `-test` and `-trial` during the event,
  and `reasoning_effort` rejects `none`/`minimal` for this model. Both cost me
  debugging time that the guide did not warn about.
- Reasoning-heavy models are not the fastest thing on the platform, and that is
  fine: the scan is what makes this fast, not raw decode speed.
- Bounding the scan (file cap, depth cap, bytes per file) is what keeps a
  monorepo from hanging it. A 111k-file checkout is not 111k files of signal.

Repo: <https://github.com/alfonsodg/repo-cartographer>

## 60-second video script

| time | shot | line |
| --- | --- | --- |
| 0-5s | terminal, `ls` of a big repo | "1,700 files. You just joined." |
| 5-15s | `node cartographer.mjs .` | "It maps the repo, no model. 201 ms." |
| 15-25s | scroll the index JSON | "823x compression. 1.4M tokens become 4,800." |
| 25-50s | briefing scrolls in | "Kimi reads the map: architecture, reading order, main flow, what breaks." |
| 50-57s | the scan vs infer readout | "Scan in a fifth of a second. Briefing in ten." |
| 57-60s | repo URL on screen | "Repo Cartographer. Link below." |

Recording notes:

- Clean desktop: no keys, no tabs, no notifications.
- Show the scan-vs-inference contrast clearly — that is the selling point.
- Standard build only (no speed patch) for public posts.

## Facts to have ready

- Scan: 184 ms / 805 files; 201 ms / 1,737 files (constant, model-free)
- Compression: 322x (camoufox), 823x (herdr)
- Inference: 5.6-10.6 s, 1,740 output tokens, 113-215 tok/s
- Prompt: 4,827 tokens from 5.5 MB of source
- Model: `moonshotai-kimi-k3.1-pro-trial`, reasoning `low`
- Tests: 8/8 passing (`node --test`)
- Zero dependencies, Node 20+, MIT
