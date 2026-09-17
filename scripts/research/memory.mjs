/**
 * Research memory (Phase 5A).
 *
 * Durable record of what the research swarm proposed, what happened to each
 * proposal, and what the swarm concluded — so researchers do not endlessly
 * rediscover the same failures.
 *
 * Layout (all JSON, no secrets, no code, sanitized before writing):
 *
 *   .evolve/research/
 *     proposals/<proposalId>.json     one validated proposal per file
 *     memory/index.json               bounded research-memory records
 *     conclusions.json                one aggregated line per proposal outcome
 *
 * Statuses are research vocabulary. PROMISING does NOT mean profitable; it
 * means "survived watchdog + first Arena qualification with adequate
 * evidence". Arena status alone grants nothing: Deployment Candidate remains
 * an Arena decision, not a research one.
 *
 * PAPER ONLY research machinery.
 */

import path from "node:path";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";

import { digestOf } from "../lib/hash.mjs";
import { sanitizeForPublic } from "../lib/sanitize.mjs";

export const RESEARCH_MEMORY_VERSION = 1;

export const RESEARCH_ROOT = path.join(".evolve", "research");
export const PROPOSALS_DIR = "proposals";
export const MEMORY_DIR = "memory";
export const COMPILED_DIR = "compiled";
export const CONCLUSIONS_FILE = "conclusions.json";
export const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, "index.json");

export const MEMORY_STATUS = Object.freeze({
  PROPOSED: "PROPOSED",
  TESTING: "TESTING",
  REJECTED: "REJECTED",
  PROMISING: "PROMISING",
  ARENA_SURVIVOR: "ARENA_SURVIVOR",
  SHADOW_ELIGIBLE: "SHADOW_ELIGIBLE",
});

/** PROMISING is documented as a research milestone, never profitability. */
export const STATUS_NOTES = Object.freeze({
  PROPOSED: "accepted by the schema, awaiting evaluation",
  TESTING: "compiled and injected into a live/replay population",
  REJECTED: "failed validation, compilation, or Arena qualification",
  PROMISING: "passed qualification with adequate evidence — NOT a profitability claim",
  ARENA_SURVIVOR: "survived the full Arena funnel as an ARENA SURVIVOR",
  SHADOW_ELIGIBLE: "reached Deployment Candidate status in the Arena (still paper-only)",
});

function cleanId(id) {
  return String(id ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Atomic-ish JSON write: temp file + rename so a reader never sees a torn file. */
async function writeJsonAtomic(file, payload) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/* ============================================================================
 * Proposals
 * ==========================================================================*/

/**
 * Persist one validated proposal. Sanitization is applied on the way out, so a
 * hand-tampered in-memory proposal still cannot carry a credential-shaped key
 * or a non-finite number to disk.
 */
export async function saveProposal(root, proposal, { status = MEMORY_STATUS.PROPOSED } = {}) {
  if (!proposal?.proposalId) return null;
  const dir = path.join(root, PROPOSALS_DIR);
  await ensureDir(dir);
  const record = {
    schemaVersion: RESEARCH_MEMORY_VERSION,
    savedAt: new Date().toISOString(),
    status,
    proposal,
  };
  await writeJsonAtomic(path.join(dir, `${cleanId(proposal.proposalId)}.json`), sanitizeForPublic(record));
  return record;
}

/** List all persisted proposals (bounded by `limit`, oldest dropped by sort). */
export async function listProposals(root, { limit = 200 } = {}) {
  const dir = path.join(root, PROPOSALS_DIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of files.slice(0, limit)) {
    const record = await readJson(path.join(dir, name), null);
    if (record?.proposal) out.push(record);
  }
  out.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  return out;
}

/**
 * Load a bounded set of prior conclusions for the evidence packet: statuses
 * plus a short conclusion string. This is how researchers "remember".
 */
export async function loadPriorConclusions(root, { limit = 40 } = {}) {
  const conclusions = await readJson(path.join(root, CONCLUSIONS_FILE), { entries: [] });
  const entries = Array.isArray(conclusions?.entries) ? conclusions.entries : [];
  return entries.slice(-limit).map((entry) => ({
    proposalId: entry?.proposalId ?? null,
    authorRole: entry?.authorRole ?? null,
    status: entry?.status ?? null,
    conclusion: typeof entry?.conclusion === "string" ? entry.conclusion.slice(0, 160) : "",
  }));
}

/* ============================================================================
 * Compiled candidates
 * ==========================================================================*/

/**
 * Persist one compiler output (the object `compileProposals` returns per
 * entry) so a later, separate process — the Arena CLI, or `promote.mjs` —
 * can find the exact genome a research cycle produced without needing to
 * recompile it. The genome itself is the only thing that matters for
 * matching against an Arena leaderboard digest; everything else is context.
 */
export async function saveCompiledCandidate(root, entry) {
  if (!entry?.familyId) return null;
  const dir = path.join(root, COMPILED_DIR);
  await ensureDir(dir);
  const record = { schemaVersion: RESEARCH_MEMORY_VERSION, savedAt: new Date().toISOString(), ...entry };
  await writeJsonAtomic(path.join(dir, `${cleanId(entry.familyId)}.json`), sanitizeForPublic(record));
  return record;
}

/** List all persisted compiled candidates (bounded by `limit`). */
export async function listCompiledCandidates(root, { limit = 200 } = {}) {
  const dir = path.join(root, COMPILED_DIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of files.slice(0, limit)) {
    const record = await readJson(path.join(dir, name), null);
    if (record?.familyId) out.push(record);
  }
  out.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  return out;
}

/* ============================================================================
 * Memory records
 * ==========================================================================*/

/**
 * A research-memory record: the structured result of testing one hypothesis.
 * Every number passes through `finite`; nothing non-finite can be stored.
 */
export function createMemoryRecord({
  proposalId,
  authorRole,
  hypothesis,
  candidateFamily = null,
  datasetsTested = [],
  regimesTested = [],
  tradeCount = 0,
  distinctMints = 0,
  medianOosReturn = null,
  worstOosReturn = null,
  drawdown = null,
  costDrag = null,
  stressResult = null,
  arenaResult = null,
  failedGates = [],
  conclusion = "",
  status = MEMORY_STATUS.PROPOSED,
}) {
  return {
    schemaVersion: RESEARCH_MEMORY_VERSION,
    recordedAt: new Date().toISOString(),
    proposalId,
    authorRole,
    hypothesis: String(hypothesis ?? "").slice(0, 600),
    candidateFamily,
    datasetsTested: [...datasetsTested],
    regimesTested: [...regimesTested],
    tradeCount: finiteInt(tradeCount),
    distinctMints: finiteInt(distinctMints),
    medianOosReturn: finiteOrNull(medianOosReturn),
    worstOosReturn: finiteOrNull(worstOosReturn),
    drawdown: finiteOrNull(drawdown),
    costDrag: finiteOrNull(costDrag),
    stressResult,
    arenaResult,
    failedGates: [...failedGates],
    conclusion: String(conclusion ?? "").slice(0, 400),
    status,
  };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function finiteInt(value, fallback = 0) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Append a memory record to the bounded index. Oldest records are dropped
 * when the cap is exceeded. The whole index is sanitized before writing.
 */
export async function appendMemoryRecord(root, record, { maxKept = 500 } = {}) {
  const file = path.join(root, MEMORY_INDEX_FILE);
  const current = await readJson(file, { schemaVersion: RESEARCH_MEMORY_VERSION, updatedAt: null, records: [] });
  const records = Array.isArray(current.records) ? current.records : [];
  records.push(record);
  const trimmed = records.slice(-Math.max(1, maxKept));
  await writeJsonAtomic(file, {
    schemaVersion: RESEARCH_MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    count: trimmed.length,
    records: sanitizeForPublic(trimmed),
  });
  return trimmed.length;
}

/** Read the memory index (bounded). */
export async function readMemoryIndex(root, { limit = 100 } = {}) {
  const current = await readJson(path.join(root, MEMORY_INDEX_FILE), { records: [] });
  const records = Array.isArray(current.records) ? current.records : [];
  return records.slice(-limit);
}

/**
 * Write one aggregated conclusion per proposal outcome (append, bounded).
 * Researchers read these back as prior knowledge for the next cycle.
 */
export async function appendConclusion(root, { proposalId, authorRole, status, conclusion, at = null }) {
  const file = path.join(root, CONCLUSIONS_FILE);
  const current = await readJson(file, { schemaVersion: RESEARCH_MEMORY_VERSION, entries: [] });
  const entries = Array.isArray(current.entries) ? current.entries : [];
  entries.push({
    proposalId,
    authorRole,
    status,
    conclusion: String(conclusion ?? "").slice(0, 400),
    at: at ?? new Date().toISOString(),
  });
  await writeJsonAtomic(file, {
    schemaVersion: RESEARCH_MEMORY_VERSION,
    count: entries.length,
    entries: sanitizeForPublic(entries.slice(-2000)),
  });
  return entries.length;
}

/** Aggregate memory stats for the dashboard + cycle metrics. */
export function memoryStats({ proposals, memoryRecords, conclusions }) {
  const byStatus = {};
  for (const status of Object.values(MEMORY_STATUS)) byStatus[status] = 0;
  for (const record of memoryRecords ?? []) {
    if (record?.status && byStatus[record.status] !== undefined) byStatus[record.status] += 1;
  }
  const byRole = {};
  for (const record of memoryRecords ?? []) {
    const role = record?.authorRole ?? "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return {
    version: RESEARCH_MEMORY_VERSION,
    proposalsStored: (proposals ?? []).length,
    memoryRecords: (memoryRecords ?? []).length,
    conclusions: (conclusions ?? []).length,
    byStatus,
    byRole,
    note: "Research statuses describe the evaluation journey. PROMISING is not profitability.",
  };
}

/** Deterministic digest of a proposal for cross-referencing in memory. */
export function proposalDigest(proposal) {
  return digestOf(proposal ?? {}).slice(0, 12);
}
