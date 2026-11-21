/**
 * Mermaid export — turn the structural index into a diagram that says how the
 * system is layered, not just which files talk to which.
 *
 * A flat node list is useless past a dozen boxes. What makes a diagram
 * readable is grouping: modules that play the same architectural role sit in
 * the same band, so a reader sees "entry layer, then core, then leaves" without
 * knowing anything about the codebase.
 *
 * Roles are inferred from the import graph itself:
 *   entry   — reaches no one above it, imported by few (main, cli, server start)
 *   core    — imported by many; this is the load-bearing code
 *   api     — wide fan-in and fan-out; the boundary other layers go through
 *   leaf    — mostly consumed, imports little
 */

const FILE_EXT =
  /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|cs|cpp|cc|c|h|swift|scala|ex|exs|sol|sql|sh|lua|vue|svelte|dart|zig)$/i;

function dirKey(path, depth) {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";

  const lastIsFile = FILE_EXT.test(parts[parts.length - 1]);
  const dirParts = lastIsFile ? parts.slice(0, -1) : parts;

  if (lastIsFile) {
    const stem = parts[parts.length - 1].replace(FILE_EXT, "");
    if (stem === "mod" || stem === "index") {
      return dirParts.slice(0, depth).join("/") || "(root)";
    }
    const combined = [...dirParts, stem];
    return combined.slice(0, Math.max(depth, combined.length)).join("/");
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
  return String(text).replace(/["<>]/g, "").replace(/\|/g, "/");
}

function buildGraph(index, depth) {
  const inWeight = new Map();
  const outWeight = new Map();
  const crossEdges = new Map();

  for (const edge of index.importEdges ?? []) {
    const targets = edge.to ?? [];
    if (targets.length === 0) continue;

    const from = dirKey(edge.from, depth);
    outWeight.set(from, (outWeight.get(from) ?? 0) + targets.length);

    for (const target of targets) {
      const to = dirKey(target, depth);
      inWeight.set(to, (inWeight.get(to) ?? 0) + 1);
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
    }
  }

  const keys = new Set([...inWeight.keys(), ...outWeight.keys()]);
  keys.delete("(root)");

  return { inWeight, outWeight, crossEdges, keys };
}

function classify(key, inW, outW, maxIn, maxOut, knownEntries) {
  const fanIn = inW / maxIn;
  const fanOut = outW / maxOut;

  if (knownEntries.has(key)) return "entry";
  if (fanIn >= 0.30) return "core";
  if (fanIn >= 0.10 && fanOut >= 0.10) return "api";
  if (fanOut > fanIn * 1.8 && fanIn < 0.10) return "entry";
  return "leaf";
}

const ROLE_ORDER = ["entry", "core", "api", "leaf"];
const ROLE_TITLE = {
  entry: "Entry points",
  core: "Core — imported by everything",
  api: "Boundaries — wide fan-in and fan-out",
  leaf: "Leaves — mostly consumed",
};
const ROLE_STYLE = {
  entry: "fill:#ffbe5c,stroke:#d99b2f,color:#1a1206,stroke-width:2px",
  core: "fill:#00e0d0,stroke:#00b3a6,color:#04121a,stroke-width:2px",
  api: "fill:#c678dd,stroke:#a35fc0,color:#160a1c,stroke-width:1.5px",
  leaf: "fill:#5aa9ff,stroke:#3d7fc4,color:#06121e,stroke-width:1px",
};

/**
 * @param {object} index  result of indexRepo()
 * @param {object} [opts]
 * @param {number} [opts.depth]        directory depth defining a module (default 2)
 * @param {number} [opts.maxModules]   modules drawn (default 22)
 * @param {number} [opts.maxEdges]     edges drawn, strongest first (default 50)
 * @param {boolean} [opts.layers]      group by architectural role (default true)
 * @param {"LR"|"TD"} [opts.direction] graph direction (default "TD")
 * @returns {{mermaid:string, modules:number, edges:number, depth:number, layers:object}}
 */
export function toMermaid(index, opts = {}) {
  const depth = opts.depth ?? 2;
  const maxModules = opts.maxModules ?? 22;
  const maxEdges = opts.maxEdges ?? 50;
  const useLayers = opts.layers ?? true;
  const direction = opts.direction ?? "TD";

  const { inWeight, outWeight, crossEdges, keys } = buildGraph(index, depth);

  const knownEntries = new Set();
  for (const entry of index.entryPoints ?? []) {
    knownEntries.add(dirKey(entry, depth));
  }

  const scored = [...keys]
    .map((key) => ({
      key,
      in: inWeight.get(key) ?? 0,
      out: outWeight.get(key) ?? 0,
      total: (inWeight.get(key) ?? 0) * 2 + (outWeight.get(key) ?? 0),
    }))
    .sort((a, b) => b.total - a.total);

  const kept = scored.slice(0, maxModules);
  const keep = new Set(kept.map((s) => s.key));

  const maxIn = Math.max(...kept.map((s) => s.in), 1);
  const maxOut = Math.max(...kept.map((s) => s.out), 1);

  for (const node of kept) {
    node.role = classify(node.key, node.in, node.out, maxIn, maxOut, knownEntries);
  }

  const edges = [...crossEdges.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, weight };
    })
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxEdges);

  const maxEdge = Math.max(...edges.map((e) => e.weight), 1);

  const ids = new Map();
  let counter = 0;
  const idFor = (key) => {
    if (!ids.has(key)) ids.set(key, `M${counter++}`);
    return ids.get(key);
  };

  const nodeLine = (node) => {
    const label = escapeLabel(shortLabel(node.key));
    const path = node.key === shortLabel(node.key) ? "" : `<br/><small>${escapeLabel(node.key)}</small>`;
    const fan = `<br/><b>${node.in}</b> in / ${node.out} out`;
    // Without the class suffix the classDef blocks are inert and every box
    // renders the same colour, which defeats the point of the layers.
    return `    ${idFor(node.key)}["${label}${path}${fan}"]:::${node.role}`;
  };

  const lines = [];
  lines.push(`flowchart ${direction}`);
  lines.push("");

  const byRole = new Map(ROLE_ORDER.map((r) => [r, []]));
  for (const node of kept) byRole.get(node.role).push(node);

  if (useLayers) {
    for (const role of ROLE_ORDER) {
      const group = byRole.get(role);
      if (!group || group.length === 0) continue;
      lines.push(`  subgraph ${role.toUpperCase()}["${ROLE_TITLE[role]}"]`);
      lines.push("    direction LR");
      for (const node of group.sort((a, b) => b.in - a.in)) lines.push(nodeLine(node));
      lines.push("  end");
      lines.push("");
    }
  } else {
    for (const node of kept) lines.push(nodeLine(node));
    lines.push("");
  }

  for (const e of edges) {
    const heavy = e.weight >= maxEdge * 0.45;
    const medium = e.weight >= maxEdge * 0.15;
    const arrow = heavy ? "==>" : "-->";
    // Weight is encoded in the arrow itself. Numeric edge labels render as
    // unreadable chips on a dark theme and add nothing the thickness does not
    // already say.
    const label = medium && opts.edgeLabels ? `|${e.weight}|` : "";
    lines.push(`  ${idFor(e.from)} ${arrow}${label} ${idFor(e.to)}`);
  }

  lines.push("");
  for (const role of ROLE_ORDER) {
    const group = byRole.get(role);
    if (!group || group.length === 0) continue;
    lines.push(`  classDef ${role} ${ROLE_STYLE[role]};`);
  }
  lines.push("  classDef default fill:#131a26,stroke:#2a3344,color:#e2e7f0;");

  // Only style the layer bands when the subgraphs actually exist. Referencing
  // ENTRY/CORE/API/LEAF in flat mode makes mermaid invent four empty nodes.
  if (useLayers) {
    for (const role of ROLE_ORDER) {
      const group = byRole.get(role);
      if (!group || group.length === 0) continue;
      lines.push(
        `  style ${role.toUpperCase()} fill:#0e131d,stroke:#243049,color:#7b869c;`
      );
    }
  }

  const layerSummary = {};
  for (const role of ROLE_ORDER) layerSummary[role] = byRole.get(role).length;

  // A single-package repository (all files under one namespace, common in Go
  // and small Python libs) has no internal imports to draw. An empty diagram
  // looks broken; say why instead.
  if (keep.size === 0) {
    const lang = (index.languages ?? []).map(([name]) => name).join("/");
    const msg = [
      "No internal import graph.",
      `This looks like a single-package ${lang || "codebase"}:`,
      "all files share one namespace, so there are no",
      "cross-module edges to draw.",
      "The written briefing is the useful output here.",
    ].join("<br/>");
    return {
      mermaid:
        "flowchart TD\n" +
        `  EMPTY["${msg}"]\n` +
        "  classDef default fill:#131a26,stroke:#2a3344,color:#e2e7f0;\n",
      modules: 0,
      edges: 0,
      depth,
      layers: layerSummary,
      empty: true,
      reason: "single-package repository — no internal import edges",
    };
  }

  return {
    mermaid: lines.join("\n") + "\n",
    modules: keep.size,
    edges: edges.length,
    depth,
    layers: layerSummary,
    empty: false,
  };
}
