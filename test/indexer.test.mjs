import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexRepo } from "../src/indexer.mjs";
import { buildPrompt } from "../src/prompt.mjs";

async function makeFixture() {
  const root = join(tmpdir(), `carto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "src", "core"), { recursive: true });
  await mkdir(join(root, "src", "utils"), { recursive: true });
  await mkdir(join(root, "node_modules", "junk"), { recursive: true });

  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture-app",
    version: "2.1.0",
    main: "src/index.mjs",
    dependencies: { express: "^4.0.0" },
    scripts: { start: "node src/index.mjs" },
  }));

  await writeFile(join(root, "src", "index.mjs"), `
import { handler } from "./core/handler.mjs";
import express from "express";
export const app = express();
export default handler;
`);

  await writeFile(join(root, "src", "core", "handler.mjs"), `
import { helper } from "../utils/helper.mjs";
export function handler() { return helper(); }
`);

  await writeFile(join(root, "src", "utils", "helper.mjs"), `
export function helper() { return 42; }
`);

  await writeFile(join(root, "node_modules", "junk", "index.js"), "should be ignored");
  await writeFile(join(root, "README.md"), "# Fixture App\n\nA test repository.\n");

  return root;
}

test("indexes files, skips node_modules", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    assert.equal(idx.stats.totalFiles, 5, "5 real files, node_modules skipped");
    assert.equal(idx.stats.sourceFiles, 3, "3 JS source files");
    assert.ok(idx.languages.length > 0, "detects languages");
    assert.equal(idx.languages[0][0], "JavaScript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads package manifest", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    assert.equal(idx.manifest.name, "fixture-app");
    assert.equal(idx.manifest.version, "2.1.0");
    assert.ok(idx.manifest.dependencies.includes("express"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves internal imports and ranks core modules", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    assert.ok(idx.importEdges.length >= 2, "captures import edges");
    const core = idx.coreModules.map((m) => m.file);
    assert.ok(core.some((f) => f.includes("handler") || f.includes("helper")),
      `core modules should include imported files, got ${JSON.stringify(core)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts external dependencies, ignores relative paths", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const names = idx.externalDependencies.map((d) => d.name);
    assert.ok(names.includes("express"), `expected express in ${names}`);
    assert.ok(!names.some((n) => n.startsWith(".")), "relative imports excluded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects entry points", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    assert.ok(idx.entryPoints.some((p) => p.includes("index")),
      `expected index entry point, got ${JSON.stringify(idx.entryPoints)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt contains required sections and real paths", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const prompt = buildPrompt(idx);
    assert.match(prompt, /## Scan summary/);
    assert.match(prompt, /## Directory tree/);
    assert.match(prompt, /### Architecture/);
    assert.match(prompt, /### Where to start reading/);
    assert.match(prompt, /### Main flow/);
    assert.match(prompt, /fixture-app/, "manifest name in prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("question mode replaces the briefing task", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root);
    const prompt = buildPrompt(idx, "where is helper defined?");
    assert.match(prompt, /## Question/);
    assert.match(prompt, /where is helper defined\?/);
    assert.ok(!prompt.includes("### First tasks"), "briefing sections removed in question mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("respects maxFiles limit", async () => {
  const root = await makeFixture();
  try {
    const idx = await indexRepo(root, { maxFiles: 2 });
    assert.ok(idx.stats.totalFiles <= 2, "respects file cap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRustFixture() {
  const root = join(tmpdir(), `carto-rust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "app"), { recursive: true });

  await writeFile(join(root, "Cargo.toml"), [
    "[package]",
    'name = "fixture-rs"',
    'version = "0.3.0"',
    "",
    "[dependencies]",
    'tokio = { version = "1", features = ["full"] }',
    'serde = "1"',
  ].join("\n"));

  await writeFile(join(root, "src", "main.rs"), [
    "mod api;",
    "mod app;",
    "use crate::api::schema;",
    "use tokio::runtime;",
    "fn main() {}",
  ].join("\n"));

  await writeFile(join(root, "src", "api", "mod.rs"), [
    "pub mod schema;",
    "use crate::app::state;",
  ].join("\n"));

  await writeFile(join(root, "src", "api", "schema.rs"), [
    "use serde::Serialize;",
    "pub struct Op;",
  ].join("\n"));

  await writeFile(join(root, "src", "app", "mod.rs"), [
    "pub mod state;",
  ].join("\n"));

  await writeFile(join(root, "src", "app", "state.rs"), "pub struct State;");

  return root;
}

test("resolves rust mod declarations into the import graph", async () => {
  const root = await makeRustFixture();
  try {
    const idx = await indexRepo(root);
    const withTargets = idx.importEdges.filter((e) => e.to.length > 0);
    assert.ok(
      withTargets.length >= 2,
      `expected resolved rust edges, got ${withTargets.length}: ${JSON.stringify(idx.importEdges)}`
    );
    assert.ok(
      idx.coreModules.length > 0,
      `expected core modules in a rust repo, got ${JSON.stringify(idx.coreModules)}`
    );
    const coreFiles = idx.coreModules.map((m) => m.file);
    assert.ok(
      coreFiles.some((f) => f.endsWith("schema.rs") || f.endsWith("state.rs") || f.endsWith("mod.rs")),
      `expected a rust module in core, got ${JSON.stringify(coreFiles)}`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects rust crate dependencies but not std", async () => {
  const root = await makeRustFixture();
  try {
    const idx = await indexRepo(root);
    const names = idx.externalDependencies.map((d) => d.name);
    assert.ok(names.includes("serde"), `expected serde, got ${names}`);
    assert.ok(names.includes("tokio"), `expected tokio, got ${names}`);
    assert.ok(!names.includes("std"), "std must not count as a dependency");
    assert.ok(!names.includes("crate"), "crate is not a dependency");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
