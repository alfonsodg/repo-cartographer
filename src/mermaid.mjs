/**
 * Mermaid export — turn the structural index into a diagram that renders
 * natively on GitHub, GitLab and most markdown viewers.
 *
 * Per-file graphs are unreadable past a few dozen nodes, so edges are
 * aggregated to module level (a directory prefix) and only the modules that
 * take part in cross-module imports are kept. Weight is the number of import
 * statements, which is what makes the diagram say something.
 */

const FILE_EXT = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|cs|cpp|cc|c|h|swift|scala|ex|exs|sol|sql|sh|lua|vue|svelte|dart|zig)$/i;

function dirKey(path, depth) {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";

  // A file sitting directly in a top-level directory (src/layout.rs) is a
  // module in its own right; collapsing it to "src" would merge unrelated
  // siblings into one meaningless bucket.
  const lastIsFile = FILE_EXT.test(parts[parts.length - 1]);
  const dirParts = lastIsFile ? parts.slice(0, -1) : parts;

  if (lastIsFile) {
    const stem = parts[parts.length - 1].replace(FILE_EXT, "");
    if (stem === "mod" || stem === "index") {
      return dirParts.slice(0, depth).join("/") || "(root)";
    }
    const parts2 = [...dirParts, stem];
    return parts2.slice(0, Math.max(depth, parts2.length)).join("/");
  }

  return dirParts.slice(0, depth).join("/") || "(root)";
}

function shortLabel(key) {
  const parts = key.split("/");
  const tail = parts.slice(-1)[0];
  if (tail === "(root)") return "root";
  return tail.replace(FILE_EXT, "");
}

function escapeLabel(text) {
  return text.replace(/["<>]/g, "");
}

/**
 * @param {object} index  result of indexRepo()
 * @param {object} [opts]
 * @param {number} [opts.depth]     directory depth to aggregate at (default 2)
 * @param {number} [opts.maxModules] modules kept in the diagram (default 18)
 * @param {number} [opts.maxEdges]   edges kept, strongest first (default 60)
 * @param {"LR"|"TD"} [opts.direction] graph direction (default "LR")
 * @returns {{ mermaid: string, modules: number, edges: number, depth: number }}
 */
export function toMermaid(index, opts = {}) {
  const depth = opts.depth ?? 2;
  const maxModules = opts.maxModules ?? 18;
  const maxEdges = opts.maxEdges ?? 60;
  const direction = opts.direction ?? "LR";

  const weights = new Map();
  const crossEdges = new Map();

  for (const edge of index.importEdges ?? []) {
    const targets = edge.to ?? [];
    if (targets.length === 0) continue;

    const from = dirKey(edge.from, depth);
    weights.set(from, (weights.get(from) ?? 0) + targets.length);

    for (const target of targets) {
      const to = dirKey(target, depth);
      weights.set(to, (weights.get(to) ?? 0) + 1);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
    }
  }

  const ranked = [...weights.entries()]
    .filter(([key]) => key !== "(root)")
    .sort((a, b) => b[1] - a[1]);

  const keep = new Set(ranked.slice(0, maxModules).map(([key]) => key));

  const edges = [...crossEdges.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, weight };
    })
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxEdges);

  const lines = [];
  lines.push(`flowchart ${direction}`);

  const maxWeight = Math.max(...edges.map((e) => e.weight), 1);
  const strong = Math.max(3, Math.round(maxWeight * 0.35));
  const medium = Math.max(2, Math.round(maxWeight * 0.12));

  const ids = new Map();
  let counter = 0;
  const idFor = (key) => {
    if (!ids.has(key)) ids.set(key, `M${counter++}`);
    return ids.get(key);
  };

  for (const [key, weight] of ranked) {
    if (!keep.has(key)) continue;
    const label = escapeLabel(shortLabel(key));
    const detail = key === shortLabel(key) ? "" : `<br/><small>${escapeLabel(key)}</small>`;
    lines.push(`  ${idFor(key)}["${label}${detail}<br/><b>${weight}</b>"]`);
  }

  for (const e of edges) {
    const label = e.weight >= medium ? `|${e.weight}|` : "";
    lines.push(`  ${idFor(e.from)} -->${label} ${idFor(e.to)}`);
  }

  if (edges.some((e) => e.weight >= strong)) {
    lines.push("");
    lines.push("  linkStyle default stroke-width:1px;");
  }

  return {
    mermaid: lines.join("\n") + "\n",
    modules: keep.size,
    edges: edges.length,
    depth,
  };
}
