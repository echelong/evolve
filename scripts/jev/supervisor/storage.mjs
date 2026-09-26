/**
 * Phase 5I-PS.2 — isolated storage for the Jev supervisor observer.
 *
 * Layout (never anywhere else):
 *
 *   .evolve/jev-supervisor-observer/<session-id>/
 *     session.json           session header + pins + isolation
 *     proposals.ndjson       append-only, one immutable executed proposal per line
 *     judgments.ndjson       append-only, one judgment per evaluated proposal
 *     sol-opportunities.ndjson  append-only, one PS.2a SOL opportunity per line
 *     sol-judgments.ndjson      append-only, one judgment per distinct complete frozen SOL Jev input
 *     cross-asset-observations.ndjson  PS.2d only: one line per ADMITTED cross-asset
 *                            observation (bounded by the frozen profile maximum)
 *     local-tev-observations.ndjson    PS.2e only: one line per ADMITTED Local Tev
 *                            observation (bounded by the frozen profile maximum)
 *     state.json             compact live state for the dashboard
 *     summary.json           finalized descriptive summary
 *
 * A PS.2a SOL opportunity is NOT an executed trade: it is written to its own
 * append-only file and never merged into proposals.ndjson.
 *
 * Every write passes the FAIL-CLOSED write-target guard first: the canonical
 * Phase 5I tree, its replication/temporal subtrees, Paper Shadow, the forensic
 * analyzer tree, the Shadow League and the Arena are all refused outright, and
 * a symlinked ancestor can never redirect a write out of the session tree.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { appendFile, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import {
  SUPERVISOR_JUDGMENTS_FILE,
  SUPERVISOR_PROPOSALS_FILE,
  SUPERVISOR_ROOT_DIR,
  SUPERVISOR_SESSION_FILE,
  SUPERVISOR_SOL_JUDGMENTS_FILE,
  SUPERVISOR_SOL_OPPORTUNITIES_FILE,
  SUPERVISOR_STATE_FILE,
  SUPERVISOR_SUMMARY_FILE,
  assertSupervisorWriteTarget,
  isValidSupervisorSessionId,
} from "./definition.mjs";
import { PS2D_OBSERVATIONS_FILE } from "./cross-asset-protocol.mjs";
import { PS2E_OBSERVATIONS_FILE } from "./local-tev-protocol.mjs";

export const SUPERVISOR_STORAGE_VERSION = 1;

/**
 * Reject a write whose ancestor chain contains a symbolic link, so a session
 * tree can never be redirected onto another tree (e.g. the canonical one).
 */
async function assertNoSymlinkAncestor(target, baseRoot) {
  const resolvedTarget = path.resolve(target);
  const start = baseRoot ? path.resolve(baseRoot) : path.parse(resolvedTarget).root;
  const relative = path.relative(start, resolvedTarget);
  if (relative.startsWith("..")) {
    throw new Error(`refusing to write to ${resolvedTarget}: it is outside ${start}`);
  }
  let current = start;
  for (const segment of relative.split(path.sep).filter((entry) => entry.length > 0)) {
    current = path.join(current, segment);
    let info = null;
    try {
      info = await lstat(current);
    } catch {
      info = null;
    }
    if (info === null) break; // the remaining path does not exist yet
    if (info.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlinked path: ${current}`);
    }
  }
}

/**
 * Create the session directory (and its ancestors), guarded against every
 * protected tree and against symlink redirection.
 */
export async function ensureSupervisorDir(root, baseRoot = null) {
  const resolvedBase = baseRoot ?? SUPERVISOR_ROOT_DIR;
  assertSupervisorWriteTarget(root, baseRoot === null ? null : resolvedBase);
  await assertNoSymlinkAncestor(root, resolvedBase);
  await mkdir(root, { recursive: true });
  return root;
}

export async function readSupervisorJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic-ish JSON write: temp file then rename, so readers never see a partial. */
export async function writeSupervisorJson(file, value) {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/** Append one NDJSON record. Records are never rewritten in place. */
export async function appendSupervisorLine(file, record) {
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function writeSupervisorSession(root, session) {
  await ensureSupervisorDir(root, path.dirname(root));
  await writeSupervisorJson(path.join(root, SUPERVISOR_SESSION_FILE), session);
}

export async function appendSupervisorProposal(root, record) {
  await appendSupervisorLine(path.join(root, SUPERVISOR_PROPOSALS_FILE), record);
}

export async function appendSupervisorJudgment(root, record) {
  await appendSupervisorLine(path.join(root, SUPERVISOR_JUDGMENTS_FILE), record);
}

/** PS.2a: one EVOLVE_SOL_OPPORTUNITY record (NOT a trade). */
export async function appendSupervisorSolOpportunity(root, record) {
  await appendSupervisorLine(path.join(root, SUPERVISOR_SOL_OPPORTUNITIES_FILE), record);
}

/** PS.2a: one judgment for a distinct frozen SOL market state. */
export async function appendSupervisorSolJudgment(root, record) {
  await appendSupervisorLine(path.join(root, SUPERVISOR_SOL_JUDGMENTS_FILE), record);
}

/** PS.2d: one admitted cross-asset observation (development shadow, zero authority). */
export async function appendSupervisorCrossAssetObservation(root, record) {
  await appendSupervisorLine(path.join(root, PS2D_OBSERVATIONS_FILE), record);
}

export async function readSupervisorCrossAssetObservations(root) {
  return readSupervisorLines(path.join(root, PS2D_OBSERVATIONS_FILE));
}

/** PS.2e: one admitted Local Tev observation (development shadow, zero authority). */
export async function appendSupervisorLocalTevObservation(root, record) {
  await appendSupervisorLine(path.join(root, PS2E_OBSERVATIONS_FILE), record);
}

export async function readSupervisorLocalTevObservations(root) {
  return readSupervisorLines(path.join(root, PS2E_OBSERVATIONS_FILE));
}

export async function writeSupervisorState(root, state) {
  await writeSupervisorJson(path.join(root, SUPERVISOR_STATE_FILE), state);
}

export async function writeSupervisorSummary(root, summary) {
  await writeSupervisorJson(path.join(root, SUPERVISOR_SUMMARY_FILE), summary);
}

export async function readSupervisorSession(root) {
  return readSupervisorJson(path.join(root, SUPERVISOR_SESSION_FILE));
}

export async function readSupervisorState(root) {
  return readSupervisorJson(path.join(root, SUPERVISOR_STATE_FILE));
}

export async function readSupervisorSummary(root) {
  return readSupervisorJson(path.join(root, SUPERVISOR_SUMMARY_FILE));
}

/** Read an NDJSON file defensively; malformed lines are reported, not thrown. */
export async function readSupervisorSolOpportunities(root) {
  return readSupervisorLines(path.join(root, SUPERVISOR_SOL_OPPORTUNITIES_FILE));
}

export async function readSupervisorSolJudgments(root) {
  return readSupervisorLines(path.join(root, SUPERVISOR_SOL_JUDGMENTS_FILE));
}

/** Read an NDJSON file defensively; malformed lines are reported, not thrown. */
export async function readSupervisorLines(file) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { records: [], malformed: 0, missing: true };
  }
  const records = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed, missing: false };
}

/** Newest-first valid supervisor session ids in a base tree. */
export async function listSupervisorSessions(baseRoot = SUPERVISOR_ROOT_DIR) {
  let entries = [];
  try {
    entries = (await readdir(baseRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidSupervisorSessionId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort();
}

/** Digest of a finalized summary (excludes the digest field itself). */
export function supervisorSummaryDigestOf(summary) {
  if (!summary || typeof summary !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(summary)) {
    if (key === "summaryDigest") continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

/**
 * Paths this subsystem may write, in one place, so the validator can assert
 * that every write stays inside the session tree.
 */
export const SUPERVISOR_WRITE_FILES = Object.freeze([
  SUPERVISOR_SESSION_FILE,
  SUPERVISOR_PROPOSALS_FILE,
  SUPERVISOR_JUDGMENTS_FILE,
  SUPERVISOR_SOL_OPPORTUNITIES_FILE,
  SUPERVISOR_SOL_JUDGMENTS_FILE,
  PS2D_OBSERVATIONS_FILE,
  PS2E_OBSERVATIONS_FILE,
  SUPERVISOR_STATE_FILE,
  SUPERVISOR_SUMMARY_FILE,
]);
