/**
 * EVOLVE Development Governance v1 — protected-artifact preservation (§10, §22).
 *
 * Before and after any governance run, the protected evidence/artifact trees are
 * hashed and the digests compared. A protected tree that is not byte-identical
 * afterwards is a hard preservation failure — evidence is immutable.
 *
 * A plan may explicitly declare an INTENDED write to a protected path. That is
 * the only exemption, it requires both the plan declaration and an explicit
 * operator confirmation (`--allow-declared-write`), and it is recorded as a loud
 * warning rather than a silent pass.
 *
 * Default protected trees (canonical):
 *   .evolve/jev-direction/          .evolve/jev-paper-shadow/
 *   .evolve/jev-paper-forensics/    .evolve/jev-supervisor-observer/
 *   .evolve/shadow/                 .evolve/arenas/
 *
 * A plan may extend the list; it may never shrink the canonical list.
 *
 * DEVELOPMENT GOVERNANCE ONLY. This module READS evidence trees and writes only
 * its own record beneath `.evolve/governance/`. It never writes, repairs,
 * re-scores or re-freezes evidence.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import { DEFAULT_PROTECTED_PATHS, GOVERNANCE_CLASSIFICATION } from "./definition.mjs";
import { PROJECT_ROOT, newGovernanceId, readGovernanceFile, writeGovernanceFile } from "./storage.mjs";
import { matchesDeclaredPath, normalizeRelativePath } from "./scope-check.mjs";
import { checkPlanFile } from "./plan-check.mjs";

/** Safety bound so a runaway tree can never hang a governance run. */
export const DEFAULT_MAX_EVIDENCE_FILES = 200000;

function summaryOf(evidence) {
  if (!evidence) return null;
  return {
    path: evidence.path,
    exists: evidence.exists,
    kind: evidence.kind,
    fileCount: evidence.fileCount,
    totalBytes: evidence.totalBytes,
    treeDigest: evidence.treeDigest,
    truncated: Boolean(evidence.truncated),
  };
}

/**
 * Hash one protected path (file or directory tree) into comparable evidence.
 * Read-only. Symlinks are recorded but never followed.
 */
export async function collectPathEvidence({
  target,
  projectRoot = PROJECT_ROOT,
  maxFiles = DEFAULT_MAX_EVIDENCE_FILES,
} = {}) {
  const relative = normalizeRelativePath(target, projectRoot);
  const absolute = path.resolve(projectRoot, relative);
  const problems = [];

  let stats;
  try {
    stats = await stat(absolute);
  } catch {
    return {
      path: relative,
      exists: false,
      kind: "missing",
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      truncated: false,
      treeDigest: sha256Hex(`MISSING ${relative}`),
      problems: [`protected path does not exist: ${relative}`],
    };
  }

  if (stats.isFile()) {
    const buffer = await readFile(absolute);
    const digest = sha256Hex(buffer);
    return {
      path: relative,
      exists: true,
      kind: "file",
      fileCount: 1,
      totalBytes: buffer.byteLength,
      entries: [{ path: relative, kind: "file", bytes: buffer.byteLength, digest }],
      truncated: false,
      treeDigest: digest,
      problems,
    };
  }

  if (!stats.isDirectory()) {
    return {
      path: relative,
      exists: true,
      kind: "other",
      fileCount: 0,
      totalBytes: 0,
      entries: [],
      truncated: false,
      treeDigest: sha256Hex(`OTHER ${relative}`),
      problems: [`protected path is neither a regular file nor a directory: ${relative}`],
    };
  }

  const entries = [];
  let totalBytes = 0;
  let truncated = false;

  const walk = async (dir) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = normalizeRelativePath(path.relative(projectRoot, full), projectRoot);
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      if (item.isSymbolicLink()) {
        entries.push({ path: rel, kind: "symlink", bytes: 0, digest: sha256Hex(`SYMLINK ${rel}`) });
        continue;
      }
      if (!item.isFile()) {
        entries.push({ path: rel, kind: "other", bytes: 0, digest: sha256Hex(`OTHER ${rel}`) });
        continue;
      }
      if (entries.length >= maxFiles) {
        truncated = true;
        continue;
      }
      const buffer = await readFile(full);
      totalBytes += buffer.byteLength;
      entries.push({ path: rel, kind: "file", bytes: buffer.byteLength, digest: sha256Hex(buffer) });
    }
  };

  await walk(absolute);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (truncated) problems.push(`protected path evidence truncated at ${maxFiles} files: ${relative}`);

  return {
    path: relative,
    exists: true,
    kind: "directory",
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    totalBytes,
    entries,
    truncated,
    treeDigest: sha256Hex(entries.map((entry) => `${entry.path}:${entry.bytes}:${entry.digest}`).join("\n")),
    problems,
  };
}

/** Capture evidence for every protected path. */
export async function capturePreservation({
  protectedPaths = DEFAULT_PROTECTED_PATHS,
  projectRoot = PROJECT_ROOT,
  maxFiles = DEFAULT_MAX_EVIDENCE_FILES,
} = {}) {
  const entries = [];
  for (const target of protectedPaths ?? []) {
    entries.push(await collectPathEvidence({ target, projectRoot, maxFiles }));
  }
  return {
    capturedAt: new Date().toISOString(),
    protectedPaths: (protectedPaths ?? []).map((entry) => normalizeRelativePath(entry, projectRoot)),
    entries,
    captureDigest: sha256Hex(entries.map((entry) => `${entry.path}:${entry.treeDigest}`).join("\n")),
  };
}

/* ============================================================================
 * Comparison
 * ==========================================================================*/

function diffEntries(beforeEntries, afterEntries) {
  const before = new Map((beforeEntries ?? []).map((entry) => [entry.path, entry]));
  const after = new Map((afterEntries ?? []).map((entry) => [entry.path, entry]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [entryPath, entry] of after) {
    if (!before.has(entryPath)) added.push({ path: entryPath, bytes: entry.bytes, digest: entry.digest });
  }
  for (const [entryPath, entry] of before) {
    const other = after.get(entryPath);
    if (!other) {
      removed.push({ path: entryPath, bytes: entry.bytes, digest: entry.digest });
      continue;
    }
    if (other.digest !== entry.digest || other.bytes !== entry.bytes) {
      modified.push({
        path: entryPath,
        beforeBytes: entry.bytes,
        afterBytes: other.bytes,
        beforeDigest: entry.digest,
        afterDigest: other.digest,
      });
    }
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  added.sort(byPath);
  removed.sort(byPath);
  modified.sort(byPath);
  return { added, removed, modified, count: added.length + removed.length + modified.length };
}

/** Compare two preservation captures. Byte-identity or a hard failure. */
export function comparePreservation(before, after) {
  const beforeByPath = new Map((before?.entries ?? []).map((entry) => [entry.path, entry]));
  const afterByPath = new Map((after?.entries ?? []).map((entry) => [entry.path, entry]));
  const results = [];
  const problems = [];

  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort((a, b) => a.localeCompare(b));
  for (const entryPath of paths) {
    const previous = beforeByPath.get(entryPath);
    const current = afterByPath.get(entryPath);
    if (!previous) {
      results.push({
        path: entryPath,
        preserved: false,
        reason: `protected path appeared during the run: ${entryPath}`,
        before: null,
        after: summaryOf(current),
      });
      problems.push(`protected path appeared during the run: ${entryPath}`);
      continue;
    }
    if (!current) {
      results.push({
        path: entryPath,
        preserved: false,
        reason: `protected path disappeared during the run: ${entryPath}`,
        before: summaryOf(previous),
        after: null,
      });
      problems.push(`protected path disappeared during the run: ${entryPath}`);
      continue;
    }
    const identical =
      previous.treeDigest === current.treeDigest &&
      previous.fileCount === current.fileCount &&
      previous.totalBytes === current.totalBytes;
    if (identical) {
      results.push({ path: entryPath, preserved: true, before: summaryOf(previous), after: summaryOf(current) });
      continue;
    }
    const changedFiles = diffEntries(previous.entries, current.entries);
    results.push({
      path: entryPath,
      preserved: false,
      reason: `tree digest changed from ${previous.treeDigest} to ${current.treeDigest}`,
      before: summaryOf(previous),
      after: summaryOf(current),
      changedFiles,
    });
    problems.push(
      `protected evidence tree changed during the run: ${entryPath} (${changedFiles.count} file differences)`,
    );
  }

  return { preserved: problems.length === 0, results, problems };
}

/* ============================================================================
 * Report
 * ==========================================================================*/

function sameProtectedPath(a, b) {
  const strip = (value) => String(value ?? "").replace(/\/+$/, "");
  return strip(a) === strip(b);
}

/**
 * Canonical protected trees plus any plan/CLI extension. A plan may EXTEND the
 * protected list; it can never shrink the canonical list.
 */
export function mergeProtectedPaths(planPaths = [], extraPaths = [], projectRoot = PROJECT_ROOT) {
  const merged = DEFAULT_PROTECTED_PATHS.map((entry) => normalizeRelativePath(entry, projectRoot));
  for (const entry of [...(planPaths ?? []), ...(extraPaths ?? [])]) {
    const relative = normalizeRelativePath(entry, projectRoot);
    if (relative.length === 0) continue;
    if (merged.some((existing) => sameProtectedPath(existing, relative))) continue;
    merged.push(relative);
  }
  return merged;
}

/**
 * Build the preservation report. A changed protected path fails unless the plan
 * explicitly declares the write AND the operator confirms the exemption.
 */
export function buildPreservationReport({
  before,
  after,
  intendedWrites = [],
  allowDeclaredWrites = false,
  protectedPaths = DEFAULT_PROTECTED_PATHS,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const comparison = comparePreservation(before, after);
  const problems = [];
  const warnings = [];
  const exempted = [];
  const declaredWrites = (intendedWrites ?? []).map((entry) =>
    normalizeRelativePath(typeof entry === "string" ? entry : entry?.path, projectRoot),
  );

  for (const result of comparison.results) {
    if (result.preserved) continue;
    const declared = declaredWrites.some((declaredWrite) => matchesDeclaredPath(result.path, declaredWrite));
    if (declared && allowDeclaredWrites) {
      exempted.push(result.path);
      warnings.push(
        `protected path changed but the plan explicitly declares this write and the operator confirmed the exemption: ${result.path} — ${result.reason}`,
      );
      continue;
    }
    if (declared) {
      problems.push(
        `protected path changed and the plan declares the write, but the exemption was not confirmed with --allow-declared-write: ${result.path} — ${result.reason}`,
      );
      continue;
    }
    problems.push(
      result.changedFiles
        ? `protected evidence tree changed: ${result.path} — ${result.reason}`
        : result.reason,
    );
  }

  for (const entry of [...(before?.entries ?? []), ...(after?.entries ?? [])]) {
    for (const problem of entry.problems ?? []) {
      if (!problems.includes(problem)) problems.push(problem);
    }
  }

  const body = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_PRESERVATION_RECORD",
    status: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    warnings,
    preserved: problems.length === 0,
    protectedPaths: (protectedPaths ?? []).map((entry) => normalizeRelativePath(entry, projectRoot)),
    before: {
      capturedAt: before?.capturedAt ?? null,
      captureDigest: before?.captureDigest ?? null,
      entries: (before?.entries ?? []).map(summaryOf),
    },
    after: {
      capturedAt: after?.capturedAt ?? null,
      captureDigest: after?.captureDigest ?? null,
      entries: (after?.entries ?? []).map(summaryOf),
    },
    comparison: comparison.results,
    intendedWrites: declaredWrites,
    allowDeclaredWrites: Boolean(allowDeclaredWrites),
    exempted,
    classification: GOVERNANCE_CLASSIFICATION,
  };
  return { ...body, preservationDigest: sha256Hex(canonicalJson(body)) };
}

/* ============================================================================
 * CLI (§16: before/after phases of one run)
 * ==========================================================================*/

function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function stringFlag(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function printHumanPreservation(payload) {
  const report = payload.report;
  if (report) {
    console.log(`preservation: ${report.status}`);
    console.log(`protected paths: ${report.protectedPaths.length}`);
    for (const result of report.comparison) {
      console.log(
        `  ${result.preserved ? "PRESERVED " : "CHANGED   "} ${result.path} files=${result.after?.fileCount ?? 0} bytes=${result.after?.totalBytes ?? 0}`,
      );
    }
    console.log(`exempted: ${report.exempted.length}`);
    for (const problem of report.problems) console.log(`PROBLEM: ${problem}`);
    for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
    console.log(`preservationDigest: ${report.preservationDigest}`);
  } else {
    console.log(`preservation-before: captured ${payload.before.entries.length} protected paths`);
    console.log(`captureDigest: ${payload.before.captureDigest}`);
  }
  console.log(`runId: ${payload.runId}`);
  if (payload.record) console.log(`written: ${payload.record.path} (${payload.record.bytes} bytes)`);
}

/**
 * `preservation --phase before|after [--plan <path.md>] [--run-id <id>]
 * [--protected <path> ...] [--allow-declared-write] [--json]`
 */
export async function runPreservationCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, {
    json: true,
    plan: false,
    phase: false,
    "run-id": false,
    protected: false,
    "allow-declared-write": true,
  }, { multi: ["protected"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const phase = (stringFlag(args.flags.phase) ?? "after").toLowerCase();
  if (phase !== "before" && phase !== "after") {
    console.error("usage: preservation --phase before|after [--plan <path.md>] [--run-id <id>] [--json]");
    process.exitCode = 1;
    return null;
  }

  const planPath = stringFlag(args.flags.plan);
  const planReport = planPath ? await checkPlanFile(planPath, { projectRoot }) : null;
  const protectedPaths = mergeProtectedPaths(planReport?.protectedPaths ?? [], asList(args.flags.protected), projectRoot);
  const runId = stringFlag(args.flags["run-id"]) ?? newGovernanceId("run");

  if (phase === "before") {
    const before = await capturePreservation({ protectedPaths, projectRoot });
    const record = await writeGovernanceFile(
      `runs/${runId}/preservation-before.json`,
      `${canonicalJson(before, 2)}\n`,
      { projectRoot },
    );
    const payload = { runId, phase, before, record, report: null };
    if (args.flags.json) console.log(canonicalJson(payload, 2));
    else printHumanPreservation(payload);
    process.exitCode = 0;
    return payload;
  }

  const beforePath = `runs/${runId}/preservation-before.json`;
  let before = null;
  let readError = null;
  try {
    before = JSON.parse(await readGovernanceFile(beforePath, { projectRoot }));
  } catch (error) {
    readError = String(error.message);
  }

  const after = await capturePreservation({ protectedPaths, projectRoot });
  const report = before
    ? buildPreservationReport({
        before,
        after,
        intendedWrites: planReport?.intendedWrites ?? [],
        allowDeclaredWrites: Boolean(args.flags["allow-declared-write"]),
        protectedPaths,
        projectRoot,
      })
    : {
        purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
        kind: "GOVERNANCE_PRESERVATION_RECORD",
        status: "FAIL",
        problems: [`no preservation-before record for run ${runId}: ${beforePath} (${readError ?? "missing"})`],
        warnings: [],
        preserved: false,
        protectedPaths,
        before: null,
        after: {
          capturedAt: after.capturedAt,
          captureDigest: after.captureDigest,
          entries: after.entries.map((entry) => ({
            path: entry.path,
            exists: entry.exists,
            kind: entry.kind,
            fileCount: entry.fileCount,
            totalBytes: entry.totalBytes,
            treeDigest: entry.treeDigest,
          })),
        },
        comparison: [],
        intendedWrites: planReport?.intendedWrites ?? [],
        allowDeclaredWrites: Boolean(args.flags["allow-declared-write"]),
        exempted: [],
        classification: GOVERNANCE_CLASSIFICATION,
        preservationDigest: null,
      };

  const record = await writeGovernanceFile(`runs/${runId}/preservation.json`, `${canonicalJson(report, 2)}\n`, {
    projectRoot,
  });
  const payload = { runId, phase, before, after, report, record };
  if (args.flags.json) console.log(canonicalJson({ runId, phase, report, record }, 2));
  else printHumanPreservation(payload);
  process.exitCode = report.status === "PASS" ? 0 : 1;
  return payload;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runPreservationCli();
}
