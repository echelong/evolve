#!/usr/bin/env node
/**
 * Syntax sweep for the plain-Node engine.
 *
 * TypeScript sources are covered by `npm run build`; this script guarantees the
 * .mjs engine files at least parse before a run starts.
 */

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["scripts"];

async function collect(dir, files = []) {
  const entries = await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await collect(relative, files);
    } else if (entry.name.endsWith(".mjs")) {
      files.push(relative);
    }
  }
  return files;
}

async function run() {
  const files = [];
  for (const root of ROOTS) await collect(root, files);

  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", path.join(PROJECT_ROOT, file)], {
      encoding: "utf8",
    });
    if (result.status !== 0) failures.push({ file, output: result.stderr || result.stdout });
  }

  console.log(`Checked ${files.length} engine modules with node --check`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure.file}\n${failure.output}`);
    process.exitCode = 1;
    return;
  }
  console.log("All engine modules parse cleanly.");
}

run().catch((error) => {
  console.error("syntax sweep crashed:", error);
  process.exitCode = 1;
});
