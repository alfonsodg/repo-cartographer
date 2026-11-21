import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexRepo } from "../src/indexer.mjs";
import { toMermaid } from "../src/mermaid.mjs";

async function makeFixture() {
  const root = join(tmpdir(), `carto-mm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });
  await mkdir(join(root, "src", "util"), { recursive: true });

  await writeFile(join(root, "Cargo.toml"), '[package]\nname = "mm-fixture"\nversion = "0.1.0"\n');

  await writeFile(join(root, "src", "main.rs"), "mod api;\nmod app;\nfn main() {}\n");
  await writeFile(join(root, "src", "api", "mod.rs"), "pub mod schema;\nuse crate::app::state;\n");
  await writeFile(join(root, "src", "api", "schema.rs"), "pub struct Op;\n");
  await writeFile(join(root, "src", "app", "mod.rs"), "pub mod state;\nuse crate::api::schema;\n");
  await writeFile(join(root, "src", "app", "state.rs"), "pub struct S;\n");
  await writeFile(join(root, "src", "util", "helpers.rs"), "pub fn h() {}\n");

  return root;
}

test("emits a valid mermaid flowchart", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const { mermaid } = toMermaid(idx);
    assert.match(mermaid, /^flowchart LR/);
    assert.match(mermaid, /M0\["/, "declares at least one node");
    assert.ok(mermaid.includes("-->"), "has at least one edge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node labels are escaped so mermaid does not break", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const { mermaid } = toMermaid(idx);
    const labelLines = mermaid.split("\n").filter((l) => l.includes('["'));
    for (const line of labelLines) {
      const label = line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]'));
      assert.ok(!/[<>]/.test(label.replace(/<br\/>/g, "").replace(/<\/?small>/g, "").replace(/<\/?b>/g, "")),
        `label must not carry raw angle brackets: ${label}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("respects maxModules", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const small = toMermaid(idx, { maxModules: 2 });
    assert.ok(small.modules <= 2, `expected <= 2 modules, got ${small.modules}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("depth changes the module grouping", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const d1 = toMermaid(idx, { depth: 1 });
    const d3 = toMermaid(idx, { depth: 3 });
    assert.notEqual(d1.mermaid, d3.mermaid, "different depth must change the diagram");
    assert.equal(d1.depth, 1);
    assert.equal(d3.depth, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file next to its siblings stays its own module", async () => {
  const root = await makeFixture();
  try {
    // give helpers.rs an actual edge so it participates in the graph
    await writeFile(
      join(root, "src", "main.rs"),
      "mod api;\nmod app;\nmod util;\nuse crate::util::helpers;\nfn main() {}\n"
    );
    await writeFile(join(root, "src", "util", "mod.rs"), "pub mod helpers;\n");
    await writeFile(join(root, "src", "util", "helpers.rs"), "pub fn h() {}\n");

    const idx = await indexRepo(root);
    const { mermaid } = toMermaid(idx, { depth: 2 });
    assert.match(mermaid, /helpers/, "src/util/helpers.rs should keep its own name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modules with no import edges are left out of the diagram", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const { mermaid } = toMermaid(idx, { depth: 2 });
    // helpers.rs is imported by nobody in this fixture
    assert.ok(!mermaid.includes("helpers"), "unconnected modules are not diagrammed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
