/**
 * EVOLVE Phase 5I-PS.1 — forensic analysis storage.
 *
 * A COMPLETELY SEPARATE tree from every other EVOLVE tree:
 *
 *   .evolve/jev-paper-forensics/<analysis-id>/
 *     manifest.json           analysis identity + source digests + classification
 *     integrity.json          the source integrity contract result
 *     signal.json             the captured pHigher stream diagnostics
 *     horizons.json           forward-return forensic analysis at fixed horizons
 *     episodes.json           reconstructed paper round trips + churn + friction
 *     friction.json           the fixed paper friction model + fill reproduction
 *     counterfactuals.json    the five PRE-DEFINED policy replays
 *     summary.json            compact roll-up + artifact digests
 *     report.csv              one row per decision/episode/policy
 *
 * Every write is guarded by `assertPaperForensicsWriteTarget`, so a future edit
 * can never silently start writing into the paper-shadow source tree, the Phase
 * 5I canonical tree, the replication/temporal manifests, the Arena, or the
 * Shadow League.
 *
 * PAPER ONLY. This module never reads a source artifact and never writes one.
 */

import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf, sha256Hex } from "../../lib/hash.mjs";
import { sanitizeForPublic } from "../../lib/sanitize.mjs";
import {
  PAPER_FORENSICS_ARTIFACT_ORDER,
  PAPER_FORENSICS_CLASSIFICATION,
  PAPER_FORENSICS_ROOT_DIR,
  assertPaperForensicsWriteTarget,
  isValidPaperForensicsAnalysisId,
} from "./definition.mjs";

export const PAPER_FORENSICS_STORAGE_VERSION = 1;

function resolveBaseRoot(baseRoot) {
  return path.resolve(baseRoot ?? PAPER_FORENSICS_ROOT_DIR);
}

/** Ensure a directory exists, refusing any protected target first. */
export async function ensurePaperForensicsDir(dir, baseRoot) {
  assertPaperForensicsWriteTarget(dir, resolveBaseRoot(baseRoot));
  await rejectSymlinkAncestors(dir);
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir); // Never overwrite a prior analysis with the same identity.
  return dir;
}

/** Byte digest of one file, or null when it does not exist. */
export async function fileDigest(target) {
  try {
    const content = await readFile(target);
    return sha256Hex(content);
  } catch {
    return null;
  }
}

async function rejectSymlinkAncestors(target) {
  for (let cursor = path.resolve(target); ; cursor = path.dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("symlink forensic write target rejected"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
}

async function writeTextAtomic(target, text, baseRoot) {
  assertPaperForensicsWriteTarget(target, resolveBaseRoot(baseRoot));
  await rejectSymlinkAncestors(target);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, target);
  return target;
}

/** Write one JSON artifact atomically, sanitized for public consumption. */
export async function writePaperForensicsJson(root, filename, value) {
  const target = path.join(root, filename);
  return writeTextAtomic(target, `${JSON.stringify(sanitizeForPublic({ ...value, ...PAPER_FORENSICS_CLASSIFICATION }), null, 2)}\n`, root);
}

/** Write the CSV report atomically. */
export async function writePaperForensicsText(root, filename, text) {
  return writeTextAtomic(path.join(root, filename), text, root);
}

/** Read one artifact back (used by tests and the `--json` CLI path). */
export async function readPaperForensicsJson(root, filename) {
  try {
    return JSON.parse(await readFile(path.join(root ?? "", filename), "utf8"));
  } catch {
    return null;
  }
}

export async function readPaperForensicsText(root, filename) {
  try {
    return await readFile(path.join(root ?? "", filename), "utf8");
  } catch {
    return null;
  }
}

/** Every file under one analysis root, with byte digests (deterministic order). */
export async function paperForensicsArtifactSnapshot(root) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const absolute = path.join(root, entry.name);
    const content = await readFile(absolute);
    out.push({
      file: entry.name,
      bytes: content.length,
      digest: sha256Hex(content),
    });
  }
  return out;
}

/** List analysis ids under a base root, name-sorted. */
export async function listPaperForensicsAnalyses(baseRoot) {
  let entries = [];
  try {
    entries = await readdir(resolveBaseRoot(baseRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidPaperForensicsAnalysisId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Digest of an analysis artifact SET as one value (file name + content digest),
 * so a summary can prove exactly which bytes it describes.
 */
export function paperForensicsArtifactSetDigest(snapshot) {
  const subject = (Array.isArray(snapshot) ? snapshot : [])
    .map((entry) => ({ file: entry?.file ?? null, digest: entry?.digest ?? null }))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));
  return digestOf(subject);
}

/** The frozen, expected artifact order — exposed for the validator. */
export function paperForensicsExpectedArtifacts() {
  return [...PAPER_FORENSICS_ARTIFACT_ORDER];
}
