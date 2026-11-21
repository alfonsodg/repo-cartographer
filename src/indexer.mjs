import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, relative, basename, dirname } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".cache",
  "coverage", ".turbo", ".gradle", "vendor", "Pods", ".terraform",
  ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "worktrees", ".angular", ".svelte-kit", "bin", "obj",
]);

const LANG_BY_EXT = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".rs": "Rust",
  ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP",
  ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++ Header",
  ".swift": "Swift", ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir",
  ".sol": "Solidity", ".sql": "SQL", ".sh": "Shell", ".lua": "Lua",
  ".vue": "Vue", ".svelte": "Svelte", ".dart": "Dart", ".zig": "Zig",
};

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s+(?:[\s\S]*?\s+)?from\s+["']([^"']+)["']/g,
  /require\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|\n)\s*from\s+(\.{1,2}[\w./]+)\s+import/g,
  /(?:^|\n)\s*import\s+([\w.]+)/g,
];

// Rust module declarations and use paths need their own handling: they are not
// file paths, they are crate-relative module paths that must be resolved
// against the source root.
const RUST_MOD = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z_][a-z0-9_]*)\s*;/g;
const RUST_USE = /(?:^|\n)\s*(?:pub\s+)?use\s+(?:crate|super|self)(?:::([a-z_][a-z0-9_]*))+/g;
const GO_IMPORT = /(?:^|\n)\s*import\s+(?:\(\s*)?(?:[\w.]+\s+)?"([\w./-]+)"/g;

const SRC_ROOTS = ["src", "lib", "app", "internal", "pkg", "crates"];

const ENTRY_HINTS = [
  "main", "index", "app", "server", "cli", "entry", "bootstrap",
  "mod", "lib", "root", "handler", "worker",
];

const MAX_FILES = 25000;
const MAX_READ_BYTES = 200_000;

// Test paths pollute the core ranking: tests import half the codebase by
// construction, so counting them puts api.test.ts next to api.ts. They are
// still indexed, just not treated as architecture.
const TEST_FILE =
  /(^|\/)(tests?|__tests__|__mocks__|spec|e2e|fixtures?)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.(go|py|rs)$|Tests?\.(java|kt)$/i;

function isTestFile(path) {
  return TEST_FILE.test(path);
}

async function safeRead(path, maxBytes = MAX_READ_BYTES) {
  try {
    const buf = await readFile(path);
    if (buf.length > maxBytes) return buf.subarray(0, maxBytes).toString("utf8");
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

async function walk(root, limits) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  const skipped = { ignoredDirs: 0, tooDeep: 0 };

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= limits.maxFiles) return { files, skipped };
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".git")) {
          skipped.ignoredDirs++;
          continue;
        }
        if (depth >= limits.maxDepth) {
          skipped.tooDeep++;
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return { files, skipped };
}

function detectLanguage(file) {
  const ext = extname(file).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

function extractImports(content, lang) {
  if (!["TypeScript", "JavaScript", "Python", "Rust", "Go"].includes(lang)) return [];
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1];
      if (!spec || spec.length > 200) continue;
      found.add(spec);
    }
  }
  return [...found];
}

function normalizeSpec(spec, fromFile, root) {
  if (!spec.startsWith(".")) return null;
  const dir = dirname(fromFile);
  let target = join(dir, spec).replace(/\\/g, "/");
  const rel = relative(root, target).replace(/\\/g, "/");
  return rel.startsWith("..") ? null : rel;
}

/**
 * Rust `mod foo;` resolves to a sibling `foo.rs` or `foo/mod.rs`. `use
 * crate::a::b` resolves to a module under the crate source root. Without this,
 * a Rust repository produces an empty import graph.
 */
function resolveRustModule(name, fromFile, root, allFiles) {
  const dir = dirname(fromFile);

  // sibling module: foo.rs or foo/mod.rs next to the declaring file
  for (const cand of [`${name}.rs`, `${name}/mod.rs`]) {
    const abs = join(dir, cand);
    if (allFiles.has(abs)) {
      return relative(root, abs).replace(/\\/g, "/");
    }
  }

  // nested module reached from a directory module file (foo/mod.rs -> foo/bar.rs)
  if (fromFile.endsWith("mod.rs")) {
    for (const cand of [`${name}.rs`, `${name}/mod.rs`]) {
      const abs = join(dir, cand);
      if (allFiles.has(abs)) return relative(root, abs).replace(/\\/g, "/");
    }
  }

  return null;
}

function resolveRustUse(segments, fromFile, root, allFiles) {
  if (segments.length === 0) return null;

  // find the crate root by walking up to the nearest directory holding src/
  let base = dirname(fromFile);
  let guard = 0;
  while (guard++ < 12) {
    if (allFiles.has(join(base, "src", "lib.rs")) || allFiles.has(join(base, "src", "main.rs"))) {
      base = join(base, "src");
      break;
    }
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }

  const candidates = [];
  const joined = segments.join("/");
  for (const start of [base, join(base, "src")]) {
    candidates.push(join(start, `${joined}.rs`));
    candidates.push(join(start, joined, "mod.rs"));
    candidates.push(join(start, `${segments[0]}.rs`));
    candidates.push(join(start, segments[0], "mod.rs"));
  }

  for (const cand of candidates) {
    if (allFiles.has(cand)) return relative(root, cand).replace(/\\/g, "/");
  }
  return null;
}

async function readManifests(root) {
  const manifests = {};
  const candidates = [
    "package.json", "Cargo.toml", "pyproject.toml", "go.mod",
    "requirements.txt", "composer.json", "Gemfile", "pom.xml",
    "build.gradle", "deno.json", "bun.lockb",
  ];
  for (const name of candidates) {
    const content = await safeRead(join(root, name), 40_000);
    if (content) manifests[name] = content;
  }
  return manifests;
}

function parsePackageJson(raw) {
  try {
    const pkg = JSON.parse(raw);
    return {
      name: pkg.name,
      version: pkg.version,
      scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
      dependencies: Object.keys(pkg.dependencies ?? {}),
      devDependencies: Object.keys(pkg.devDependencies ?? {}),
      workspaces: pkg.workspaces,
      bin: pkg.bin,
      main: pkg.main,
      module: pkg.module,
    };
  } catch {
    return null;
  }
}

function parseCargoToml(raw) {
  const name = raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  const version = raw.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  const depsBlock = raw.split(/\[dependencies\]/)[1] ?? "";
  const deps = [...depsBlock.matchAll(/^\s*([\w-]+)\s*=/gm)].map((m) => m[1]);
  const bins = [...raw.matchAll(/\[\[bin\]\]\s*\n\s*name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  return { name, version, dependencies: deps, bins };
}

function parsePyproject(raw) {
  const name = raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  const version = raw.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  const deps = [...raw.matchAll(/^\s*"([A-Za-z0-9_.\-]+)\s*[><=~!]/gm)].map((m) => m[1]);
  return { name, version, dependencies: [...new Set(deps)] };
}

function isEntryPoint(file, manifest) {
  const base = basename(file).toLowerCase();
  const stem = base.split(".")[0];

  // `mod.rs` and `index.ts` are directory barrels, not program entry points: a
  // crate root is `main.rs` or `lib.rs`. Treating every barrel as an entry
  // labelled protocol internals as the top of the system.
  if (stem === "mod" || stem === "index") {
    if (manifest?.bin) {
      const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin);
      if (bins.some((p) => file.endsWith(p))) return true;
    }
    if (manifest?.main && file.endsWith(manifest.main)) return true;
    return false;
  }

  if (manifest?.bin) {
    const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin);
    if (bins.some((p) => file.endsWith(p))) return true;
  }
  if (manifest?.main && file.endsWith(manifest.main)) return true;
  if (/^(main|server|cli|lib|lib\.rs)\.(ts|tsx|js|mjs|cjs|py|rs|go|java)$/.test(base)) return true;
  return ENTRY_HINTS.includes(stem) && /\.(ts|tsx|js|mjs|cjs|py|rs|go)$/.test(base);
}

function buildDirTree(files, root, maxDepth = 3) {
  const tree = {};
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const parts = rel.split("/");
    if (parts.length > maxDepth + 1) continue;
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (!node.__files) node.__files = [];
    node.__files.push(leaf);
  }
  return tree;
}

function renderTree(node, indent = "", out = []) {
  const dirs = Object.keys(node).filter((k) => k !== "__files").sort();
  const files = (node.__files ?? []).sort();
  for (const dir of dirs) {
    out.push(`${indent}${dir}/`);
    renderTree(node[dir], indent + "  ", out);
  }
  for (const file of files) out.push(`${indent}${file}`);
  return out;
}

export async function indexRepo(root, options = {}) {
  const limits = {
    maxFiles: options.maxFiles ?? MAX_FILES,
    maxDepth: options.maxDepth ?? 14,
  };

  // Optional progress sink. When present, the scan reports what it is doing so
  // a viewer can build the graph while the work happens instead of waiting for
  // a finished JSON blob.
  const emit = typeof options.onEvent === "function" ? options.onEvent : null;

  const startedAt = Date.now();
  const { files, skipped } = await walk(root, limits);

  emit?.({ type: "walked", files: files.length, skipped });

  const languages = {};
  const byExt = {};
  let totalBytes = 0;
  const sourceFiles = [];

  for (const file of files) {
    const lang = detectLanguage(file);
    const ext = extname(file).toLowerCase() || "(none)";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
    if (!lang) continue;

    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      continue;
    }
    totalBytes += size;
    languages[lang] = (languages[lang] ?? 0) + 1;
    sourceFiles.push({ path: file, lang, size });
  }

  emit?.({
    type: "languages",
    languages: Object.entries(languages).sort((a, b) => b[1] - a[1]),
    sourceFiles: sourceFiles.length,
    totalBytes,
  });

  const manifests = await readManifests(root);
  const pkg = manifests["package.json"] ? parsePackageJson(manifests["package.json"]) : null;
  const cargo = manifests["Cargo.toml"] ? parseCargoToml(manifests["Cargo.toml"]) : null;
  const pyproject = manifests["pyproject.toml"] ? parsePyproject(manifests["pyproject.toml"]) : null;
  const primaryManifest = pkg ?? cargo ?? pyproject ?? null;

  const importGraph = new Map();
  const externalDeps = new Map();
  const fileContents = new Map();
  const allFiles = new Set(files);

  for (const entry of sourceFiles.slice(0, options.maxAnalyzedFiles ?? 4000)) {
    if (!["TypeScript", "JavaScript", "Python", "Rust", "Go"].includes(entry.lang)) continue;
    const content = await safeRead(entry.path);
    if (!content) continue;
    fileContents.set(entry.path, content);

    const rel = relative(root, entry.path).replace(/\\/g, "/");
    const internal = new Set();

    if (entry.lang === "Rust") {
      RUST_MOD.lastIndex = 0;
      let m;
      while ((m = RUST_MOD.exec(content)) !== null) {
        const target = resolveRustModule(m[1], entry.path, root, allFiles);
        if (target) internal.add(target);
      }
      RUST_USE.lastIndex = 0;
      while ((m = RUST_USE.exec(content)) !== null) {
        const pathPart = m[0].replace(/^\s*(pub\s+)?use\s+/, "").replace(/[;{].*$/, "").trim();
        const segments = pathPart.split("::").slice(1).filter(Boolean);
        const target = resolveRustUse(segments, entry.path, root, allFiles);
        if (target && target !== rel) internal.add(target);
      }
      const externals = content.match(/^\s*(?:pub\s+)?(?:use|extern\s+crate)\s+([a-z_][a-z0-9_]*)/gm) ?? [];
      for (const line of externals) {
        const name = line.replace(/^\s*(?:pub\s+)?(?:use|extern\s+crate)\s+/, "").trim();
        if (!["crate", "super", "self", "std", "core", "alloc"].includes(name)) {
          externalDeps.set(name, (externalDeps.get(name) ?? 0) + 1);
        }
      }
      importGraph.set(rel, [...internal]);
      continue;
    }

    if (entry.lang === "Go") {
      GO_IMPORT.lastIndex = 0;
      let m;
      while ((m = GO_IMPORT.exec(content)) !== null) {
        const spec = m[1];
        const target = normalizeSpec(spec, entry.path, root);
        if (target) internal.add(target);
        else if (spec.includes(".") || spec.includes("/")) {
          externalDeps.set(spec, (externalDeps.get(spec) ?? 0) + 1);
        }
      }
      importGraph.set(rel, [...internal]);
      continue;
    }

    const specs = extractImports(content, entry.lang);
    for (const spec of specs) {
      const target = normalizeSpec(spec, entry.path, root);
      if (target) internal.add(target);
      else if (!spec.startsWith(".")) {
        const pkgName = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        externalDeps.set(pkgName, (externalDeps.get(pkgName) ?? 0) + 1);
      }
    }
    importGraph.set(rel, [...internal]);

    // Report each analysed file with the edges it resolved, so a live viewer
    // can grow the graph module by module instead of waiting for the tail.
    if (emit) {
      emit({
        type: "file",
        file: rel,
        edges: [...internal],
        index: importGraph.size,
        total: Math.min(sourceFiles.length, options.maxAnalyzedFiles ?? 4000),
      });
    }
  }

  const inDegree = new Map();
  const prodInDegree = new Map();

  for (const [source, targets] of importGraph) {
    const sourceIsTest = isTestFile(source);
    for (const target of targets) {
      for (const [file] of importGraph) {
        if (file === target || file.startsWith(`${target}.`) || file.startsWith(`${target}/`)) {
          inDegree.set(file, (inDegree.get(file) ?? 0) + 1);
          // Tests import half the codebase by construction. Counting them ranks
          // test utilities next to the actual core, which is both wrong and a
          // waste of prompt tokens: nobody onboards by reading api.test.ts.
          if (!sourceIsTest) prodInDegree.set(file, (prodInDegree.get(file) ?? 0) + 1);
        }
      }
    }
  }

  // Production graph when there is one, so the briefing describes the system
  // rather than its test scaffolding.
  const ranking = prodInDegree.size > 0 ? prodInDegree : inDegree;

  const coreModules = [...ranking.entries()]
    .filter(([file]) => !isTestFile(file))
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.topCore ?? 20)
    .map(([file, count]) => ({ file, importedBy: count }));

  const entryPoints = sourceFiles
    .filter((f) => isEntryPoint(f.path, primaryManifest))
    .map((f) => relative(root, f.path).replace(/\\/g, "/"))
    .slice(0, 20);

  const largest = [...sourceFiles]
    .sort((a, b) => b.size - a.size)
    .slice(0, 15)
    .map((f) => ({
      file: relative(root, f.path).replace(/\\/g, "/"),
      lang: f.lang,
      kb: Math.round(f.size / 1024),
    }));

  const tree = renderTree(buildDirTree(files, root))
    .slice(0, options.maxTreeLines ?? 220);

  const readmeRaw = await safeRead(join(root, "README.md"), 12_000)
    ?? await safeRead(join(root, "README.rst"), 12_000)
    ?? await safeRead(join(root, "readme.md"), 12_000);

  const agentsDoc = await safeRead(join(root, "AGENTS.md"), 8_000);
  const claudeDoc = await safeRead(join(root, "CLAUDE.md"), 8_000);

  return {
    root,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    stats: {
      totalFiles: files.length,
      sourceFiles: sourceFiles.length,
      totalBytes,
      totalKb: Math.round(totalBytes / 1024),
      truncatedAtLimit: files.length >= limits.maxFiles,
      skipped,
    },
    languages: Object.entries(languages).sort((a, b) => b[1] - a[1]),
    topExtensions: Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 15),
    manifest: primaryManifest,
    manifestsPresent: Object.keys(manifests),
    structure: tree,
    entryPoints,
    coreModules,
    largestFiles: largest,
    externalDependencies: [...externalDeps.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name, uses]) => ({ name, uses })),
    importEdges: [...importGraph.entries()].slice(0, 800).map(([from, to]) => ({ from, to })),
    readmeExcerpt: readmeRaw?.slice(0, 6000) ?? null,
    agentsDocExcerpt: agentsDoc?.slice(0, 3000) ?? null,
    claudeDocExcerpt: claudeDoc?.slice(0, 2000) ?? null,
  };
}
