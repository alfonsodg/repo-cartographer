import { indexRepo } from "./indexer.mjs";

const SYSTEM_BRIEF = `You are Repo Cartographer. You receive a structural index of a
software repository — file tree, language mix, entry points, most-imported modules,
external dependencies and README — and you explain the codebase to an engineer who
just cloned it.

Rules:
- Be concrete. Name real files and directories from the index. Never invent paths.
- Answer the questions a new maintainer actually asks: what is this, how is it
  organised, where do I start reading, where does the main flow live, what are the
  riskiest areas.
- If the index does not contain something, say so plainly instead of guessing.
- Prefer short labelled sections over long prose.`;

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function buildPrompt(index, question = null) {
  const L = [];

  L.push(`# Repository: ${index.root}`);
  L.push("");
  L.push("## Scan summary");
  L.push(`- Files scanned: ${fmt(index.stats.totalFiles)} (${fmt(index.stats.sourceFiles)} source files)`);
  L.push(`- Total size of source files: ${fmt(index.stats.totalKb)} KB`);
  L.push(`- Languages: ${index.languages.map(([lang, n]) => `${lang} (${n})`).join(", ") || "none detected"}`);
  L.push(`- Manifests present: ${index.manifestsPresent.join(", ") || "none"}`);
  L.push(`- Scan took: ${index.elapsedMs} ms`);

  if (index.manifest) {
    L.push("");
    L.push("## Project manifest");
    const m = index.manifest;
    if (m.name) L.push(`- name: ${m.name}`);
    if (m.version) L.push(`- version: ${m.version}`);
    if (m.scripts?.length) L.push(`- npm scripts: ${m.scripts.join(", ")}`);
    if (m.dependencies?.length) L.push(`- runtime deps (${m.dependencies.length}): ${m.dependencies.slice(0, 30).join(", ")}`);
    if (m.devDependencies?.length) L.push(`- dev deps (${m.devDependencies.length}): ${m.devDependencies.slice(0, 20).join(", ")}`);
    if (m.bins?.length) L.push(`- binaries: ${m.bins.join(", ")}`);
    if (m.workspaces) L.push(`- workspaces: ${JSON.stringify(m.workspaces)}`);
  }

  L.push("");
  L.push("## Directory tree (truncated)");
  L.push("```");
  L.push(...index.structure);
  L.push("```");

  if (index.entryPoints.length) {
    L.push("");
    L.push("## Likely entry points");
    L.push(...index.entryPoints.map((p) => `- ${p}`));
  }

  if (index.coreModules.length) {
    L.push("");
    L.push("## Most-imported modules (core of the system)");
    L.push(...index.coreModules.map((m) => `- ${m.file} — imported by ${m.importedBy} files`));
  }

  if (index.largestFiles.length) {
    L.push("");
    L.push("## Largest source files");
    L.push(...index.largestFiles.map((f) => `- ${f.file} (${f.kb} KB, ${f.lang})`));
  }

  if (index.externalDependencies.length) {
    L.push("");
    L.push("## External dependencies actually used in imports");
    L.push(...index.externalDependencies.slice(0, 25).map((d) => `- ${d.name} (${d.uses} imports)`));
  }

  if (index.readmeExcerpt) {
    L.push("");
    L.push("## README excerpt");
    L.push(index.readmeExcerpt);
  }

  if (index.agentsDocExcerpt) {
    L.push("");
    L.push("## AGENTS.md excerpt (project conventions)");
    L.push(index.agentsDocExcerpt);
  }

  L.push("");
  L.push("---");
  L.push("");

  if (question) {
    L.push("## Question");
    L.push(question);
    L.push("");
    L.push("Answer using only the index above. Cite file paths.");
  } else {
    L.push("## Task");
    L.push("Produce a codebase briefing with exactly these sections:");
    L.push("");
    L.push("### What this is");
    L.push("Two or three sentences on purpose and stack.");
    L.push("");
    L.push("### Architecture");
    L.push("The major parts and how they relate. Name the directories and key files.");
    L.push("");
    L.push("### Where to start reading");
    L.push("An ordered list of 4-6 files, each with one line on why it matters.");
    L.push("");
    L.push("### Main flow");
    L.push("How a typical request/command travels through the system, from entry point to output.");
    L.push("");
    L.push("### Risky or complex areas");
    L.push("Where a newcomer is most likely to break something.");
    L.push("");
    L.push("### First tasks");
    L.push("Three concrete things a new contributor could do this week.");
  }

  return L.join("\n");
}

export { SYSTEM_BRIEF };
