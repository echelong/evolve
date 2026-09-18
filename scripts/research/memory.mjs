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
export const WATCHDOG_MEMORY_VERSION = 1;

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

/**
 * Phase 5A.2: the explicit candidate lifecycle, one step more precise than
 * `status`. Status stays the coarse, long-standing vocabulary (PROPOSED /
 * TESTING / REJECTED / PROMISING / …) so every existing reader keeps working;
 * `outcome` records exactly WHICH step a proposal stopped at:
 *
 *   PROPOSED -> (schema) -> REJECTED_SCHEMA
 *            -> (compiler) -> REJECTED_COMPILER
 *            -> (uniqueness) -> REJECTED_DUPLICATE
 *            -> COMPILED -> injected -> TESTING
 *            -> (watchdog) -> WATCH | QUARANTINED
 *            -> (Arena) -> ARENA_EVALUATED -> PROMISING / ARENA_SURVIVOR / SHADOW_ELIGIBLE
 *
 * A QUARANTINED outcome can never become deployment/shadow eligible: promotion
 * refuses it outright (see promote.mjs).
 */
export const MEMORY_OUTCOME = Object.freeze({
  PROPOSED: "PROPOSED",
  REJECTED_SCHEMA: "REJECTED_SCHEMA",
  REJECTED_COMPILER: "REJECTED_COMPILER",
  REJECTED_DUPLICATE: "REJECTED_DUPLICATE",
  COMPILED: "COMPILED",
  TESTING: "TESTING",
  WATCH: "WATCH",
  QUARANTINED: "QUARANTINED",
  ARENA_EVALUATED: "ARENA_EVALUATED",
  PROMISING: "PROMISING",
  ARENA_SURVIVOR: "ARENA_SURVIVOR",
  SHADOW_ELIGIBLE: "SHADOW_ELIGIBLE",
});

/**
 * The lifecycle as an ordered list, for documentation, dashboards, and tests.
 * Each entry says where a candidate can go next; nothing here is executable.
 */
export const RESEARCH_LIFECYCLE = Object.freeze([
  { step: "PROPOSED", detail: "provider output received" },
  { step: "REJECTED_SCHEMA", detail: "failed strict proposal-schema validation" },
  { step: "REJECTED_COMPILER", detail: "failed deterministic compilation (unknown gene/family)" },
  { step: "REJECTED_DUPLICATE", detail: "compiled genome digest already present in the research cohort" },
  { step: "COMPILED", detail: "deterministic compiler produced a candidate genome" },
  { step: "TESTING", detail: "injected into a live/replay population" },
  { step: "WATCH", detail: "watchdog flagged the candidate (continues, labelled)" },
  { step: "QUARANTINED", detail: "watchdog quarantined the candidate (can never deploy)" },
  { step: "ARENA_EVALUATED", detail: "the candidate appeared in a real Arena leaderboard" },
  { step: "PROMISING", detail: "Arena-qualified with adequate evidence — NOT profitability" },
  { step: "ARENA_SURVIVOR", detail: "survived the full Arena funnel" },
  { step: "SHADOW_ELIGIBLE", detail: "reached Deployment Candidate status (still paper-only)" },
]);

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
 * Normalize a watchdog verdict into structured, queryable evidence.
 *
 * Watchdog results used to exist only as a human-readable sentence inside
 * `conclusion` ("watchdog quarantined after 5 trades"), which meant answering
 * "which candidates are quarantined, and why?" required parsing prose. This
 * produces the machine-readable form every memory record and conclusion now
 * carries: machine status + flag labels + reasons + the trade count the verdict
 * was based on + when it was evaluated.
 *
 * @param {object|null} watchdog  raw watchdog output ({ verdict/status, flags })
 * @returns {null | { version: number, status: string, flags: string[], reasons: string[], tradeCount: number, evaluatedAt: string }}
 */
export function normalizeWatchdogEvidence(watchdog, { evaluatedAt = null } = {}) {
  if (!watchdog || typeof watchdog !== "object") return null;
  const status = typeof watchdog.status === "string" ? watchdog.status : watchdog.verdict;
  if (typeof status !== "string" || status === "") return null;

  const rawFlags = Array.isArray(watchdog.flags) ? watchdog.flags : [];
  const flags = rawFlags
    .map((entry) => (typeof entry === "string" ? entry : entry?.flag))
    .filter((entry) => typeof entry === "string" && entry.length > 0);
  const reasons = rawFlags
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : [entry?.flag, entry?.detail].filter((part) => typeof part === "string" && part.length > 0).join(": "),
    )
    .filter((entry) => entry.length > 0);

  return {
    version: finiteInt(watchdog.version, WATCHDOG_MEMORY_VERSION),
    status,
    flags: [...new Set(flags)].slice(0, 24),
    reasons: reasons.slice(0, 24),
    tradeCount: finiteInt(watchdog.tradeCount ?? watchdog.trades, 0),
    evaluatedAt:
      typeof watchdog.evaluatedAt === "string"
        ? watchdog.evaluatedAt
        : typeof evaluatedAt === "string"
          ? evaluatedAt
          : new Date().toISOString(),
  };
}

/**
 * A research-memory record: the structured result of testing one hypothesis.
 * Every number passes through `finite`; nothing non-finite can be stored.
 *
 * Memory stays append-only: a record's `status` only ever moves through
 * PROPOSED -> TESTING -> REJECTED here, and promotion (PROMISING /
 * ARENA_SURVIVOR / SHADOW_ELIGIBLE) is written by promote.mjs from a real
 * Arena result as a *new* record. Watchdog evidence is attached in place (a
 * watchdog verdict genuinely describes the same evaluation), never by mutating
 * a promoted status.
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
  outcome = null,
  watchdog = null,
  evaluatedAt = null,
}) {
  const watchdogEvidence = normalizeWatchdogEvidence(watchdog, { evaluatedAt });
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
    // Explicit lifecycle outcome. Defaults to the status when the caller does
    // not name one, so pre-5A.2 call sites keep writing a sensible value.
    outcome: typeof outcome === "string" && outcome.length > 0 ? outcome : status,
    // Structured watchdog evidence (null until the candidate has been screened).
    // `watchdogVerdict` / `watchdogStatus` are flat aliases so an existing
    // reader (promote.mjs' quarantine check, older memory rows) keeps working.
    watchdog: watchdogEvidence,
    watchdogStatus: watchdogEvidence?.status ?? null,
    watchdogVerdict: watchdogEvidence?.status ?? null,
    watchdogFlags: watchdogEvidence?.flags ?? [],
    watchdogEvaluatedAt: watchdogEvidence?.evaluatedAt ?? null,
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
 * Researchers read these back as prior knowledge for the next cycle, and the
 * structured `watchdog` field rides along so watchdog evidence is queryable
 * here too, without parsing `conclusion`.
 */
export async function appendConclusion(
  root,
  { proposalId, authorRole, status, outcome = null, conclusion, at = null, watchdog = null },
) {
  const file = path.join(root, CONCLUSIONS_FILE);
  const current = await readJson(file, { schemaVersion: RESEARCH_MEMORY_VERSION, entries: [] });
  const entries = Array.isArray(current.entries) ? current.entries : [];
  const watchdogEvidence = normalizeWatchdogEvidence(watchdog, { evaluatedAt: at });
  entries.push({
    proposalId,
    authorRole,
    status,
    outcome: typeof outcome === "string" && outcome.length > 0 ? outcome : status,
    conclusion: String(conclusion ?? "").slice(0, 400),
    at: at ?? new Date().toISOString(),
    ...(watchdogEvidence ? { watchdog: watchdogEvidence } : {}),
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

/**
 * Machine-readable watchdog roll-up over research memory. Counts are derived
 * from each record's structured `watchdog.status` (falling back to the flat
 * `watchdogVerdict` alias on rows written before structured evidence existed)
 * — never by parsing a conclusion sentence.
 *
 * The memory index is the canonical store; `conclusions` is only used as a
 * fallback when there are no memory records at all, so a record and its
 * mirrored conclusion line are never double-counted.
 *
 * @param {{ memoryRecords?: object[], conclusions?: object[] }} options
 * @returns {{ evaluated: number, NORMAL: number, WATCH: number, QUARANTINED: number, byStatus: Record<string, number>, lastEvaluatedAt: string|null }}
 */
export function watchdogStats({ memoryRecords = [], conclusions = [] } = {}) {
  const byStatus = { NORMAL: 0, WATCH: 0, QUARANTINED: 0 };
  let evaluated = 0;
  let lastEvaluatedAt = null;

  const consider = (entry) => {
    const status = entry?.watchdog?.status ?? entry?.watchdogStatus ?? entry?.watchdogVerdict;
    if (typeof status !== "string" || status === "") return;
    evaluated += 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const at = entry?.watchdog?.evaluatedAt ?? null;
    if (typeof at === "string" && (lastEvaluatedAt === null || at > lastEvaluatedAt)) lastEvaluatedAt = at;
  };

  const source = (memoryRecords ?? []).length > 0 ? memoryRecords : conclusions ?? [];
  for (const entry of source) consider(entry);

  return { evaluated, ...byStatus, byStatus, lastEvaluatedAt };
}

/**
 * Full research-memory summary for the engine's state summary and the
 * dashboard: how many records exist, by status and by researcher role, how
 * many conclusions/evaluations have been written, and the watchdog roll-up.
 */
export function summarizeResearchMemory({
  proposals = [],
  compiled = [],
  memoryRecords = [],
  conclusions = [],
} = {}) {
  const byStatus = {};
  for (const status of Object.values(MEMORY_STATUS)) byStatus[status] = 0;
  const byOutcome = {};
  for (const outcome of Object.values(MEMORY_OUTCOME)) byOutcome[outcome] = 0;
  const byRole = {};
  for (const record of memoryRecords ?? []) {
    if (record?.status && byStatus[record.status] !== undefined) byStatus[record.status] += 1;
    const outcome = record?.outcome ?? record?.status;
    if (outcome && byOutcome[outcome] !== undefined) byOutcome[outcome] += 1;
    const role = record?.authorRole ?? "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }

  return {
    version: RESEARCH_MEMORY_VERSION,
    proposalsStored: (proposals ?? []).length,
    compiledFamilies: (compiled ?? []).length,
    memoryRecords: (memoryRecords ?? []).length,
    conclusions: (conclusions ?? []).length,
    byStatus,
    byOutcome,
    byRole,
    watchdog: watchdogStats({ memoryRecords, conclusions }),
    note: "Research statuses describe the evaluation journey. PROMISING is not profitability.",
  };
}

/** Read the memory index + conclusions and summarize them (bounded reads). */
export async function readResearchMemorySummary(root, { limit = 1000 } = {}) {
  const memoryRecords = await readMemoryIndex(root, { limit });
  const conclusionsDoc = await readJson(path.join(root, CONCLUSIONS_FILE), { entries: [] });
  const conclusions = Array.isArray(conclusionsDoc?.entries) ? conclusionsDoc.entries.slice(-limit) : [];
  const proposals = await listProposals(root, { limit });
  const compiled = await listCompiledCandidates(root, { limit });
  return summarizeResearchMemory({ proposals, compiled, memoryRecords, conclusions });
}

/**
 * Queryable watchdog evidence: the structured evaluations recorded in research
 * memory (optionally filtered by status), plus the conclusions that carry one.
 */
export async function readWatchdogEvaluations(root, { limit = 500, status = null } = {}) {
  const records = await readMemoryIndex(root, { limit });
  const evaluations = [];
  for (const record of records) {
    const evidence = record?.watchdog ?? null;
    if (!evidence?.status) continue;
    if (status && evidence.status !== status) continue;
    evaluations.push({
      proposalId: record.proposalId ?? null,
      candidateFamily: record.candidateFamily ?? null,
      authorRole: record.authorRole ?? null,
      memoryStatus: record.status ?? null,
      watchdog: evidence,
    });
  }
  return evaluations;
}

/**
 * Phase 5A.2: per-researcher-role metrics, derived from persisted records that
 * already exist on disk — never from a live in-memory guess. Answers "is each
 * researcher role contributing meaningfully distinct search behaviour?".
 *
 * @param {{
 *   proposals?: object[],      // listProposals() records ({ proposal: { authorRole } })
 *   compiled?: object[],       // listCompiledCandidates() entries
 *   memoryRecords?: object[],
 *   conclusions?: object[],
 *   arenaRows?: object[],      // Arena leaderboard rows carrying authorRole
 * }} options
 */
export function roleResearchMetrics({
  proposals = [],
  compiled = [],
  memoryRecords = [],
  conclusions = [],
  arenaRows = [],
} = {}) {
  const roles = {};
  const ensure = (role) => {
    const key = typeof role === "string" && role.length > 0 ? role : "unknown";
    if (!roles[key]) {
      roles[key] = {
        role: key,
        proposalsGenerated: 0,
        schemaAccepted: 0,
        compilationAccepted: 0,
        duplicateRejected: 0,
        uniqueGenomes: 0,
        arenaEntrants: 0,
        medianArenaScore: null,
        bestArenaRank: null,
        gateFailures: 0,
        watchdog: { NORMAL: 0, WATCH: 0, QUARANTINED: 0 },
      };
      roles[key]._proposalIds = new Set();
      roles[key]._digests = new Set();
      roles[key]._scores = [];
    }
    return roles[key];
  };

  for (const record of proposals ?? []) {
    const role = ensure(record?.proposal?.authorRole);
    roles[role.role]._proposalIds.add(record?.proposal?.proposalId ?? `anon-${roles[role.role].proposalsGenerated}`);
    roles[role.role].proposalsGenerated += 1;
  }

  const PASSED_SCHEMA = new Set([
    MEMORY_OUTCOME.REJECTED_COMPILER,
    MEMORY_OUTCOME.REJECTED_DUPLICATE,
    MEMORY_OUTCOME.COMPILED,
    MEMORY_OUTCOME.TESTING,
    MEMORY_OUTCOME.WATCH,
    MEMORY_OUTCOME.QUARANTINED,
    MEMORY_OUTCOME.ARENA_EVALUATED,
    MEMORY_OUTCOME.PROMISING,
    MEMORY_OUTCOME.ARENA_SURVIVOR,
    MEMORY_OUTCOME.SHADOW_ELIGIBLE,
    MEMORY_OUTCOME.PROPOSED,
  ]);

  for (const entry of conclusions ?? []) {
    const role = ensure(entry?.authorRole);
    const outcome = entry?.outcome ?? entry?.status ?? null;
    if (!PASSED_SCHEMA.has(outcome)) continue;
    roles[role.role]._proposalIds.add(entry?.proposalId ?? "unknown");
  }
  for (const row of Object.values(roles)) row.schemaAccepted = row._proposalIds.size;

  for (const entry of compiled ?? []) {
    const role = ensure(entry?.authorRole);
    roles[role.role].compilationAccepted += 1;
    // Pre-5A.2 artifacts predate the persisted `genomeDigest` field; recompute
    // it from the genome so a legacy cohort still reports honest uniqueness.
    const digest = entry?.genomeDigest ?? (entry?.genome ? digestOf(entry.genome) : null);
    if (typeof digest === "string") roles[role.role]._digests.add(digest);
  }

  const outcomeCounts = new Map();
  for (const entry of conclusions ?? []) {
    const outcome = entry?.outcome ?? entry?.status ?? null;
    if (typeof outcome !== "string") continue;
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
    const role = ensure(entry?.authorRole);
    if (outcome === MEMORY_OUTCOME.REJECTED_DUPLICATE) roles[role.role].duplicateRejected += 1;
  }

  for (const record of memoryRecords ?? []) {
    const role = ensure(record?.authorRole);
    const watchdog = record?.watchdog?.status ?? record?.watchdogStatus ?? record?.watchdogVerdict ?? null;
    if (watchdog && roles[role.role].watchdog[watchdog] !== undefined) roles[role.role].watchdog[watchdog] += 1;
  }

  for (const row of arenaRows ?? []) {
    // Arena candidate rows carry the author role inside their research
    // provenance; accept either shape.
    const role = ensure(row?.authorRole ?? row?.research?.authorRole);
    roles[role.role].arenaEntrants += 1;
    if (Number.isFinite(row?.score)) roles[role.role]._scores.push(row.score);
    if (Number.isFinite(row?.finalRank) && (roles[role.role].bestArenaRank === null || row.finalRank < roles[role.role].bestArenaRank)) {
      roles[role.role].bestArenaRank = row.finalRank;
    }
    roles[role.role].gateFailures += Array.isArray(row?.failedGates) ? row.failedGates.length : 0;
  }

  const out = {};
  for (const [key, row] of Object.entries(roles)) {
    const scores = [...row._scores].sort((a, b) => a - b);
    out[key] = {
      role: row.role,
      proposalsGenerated: row.proposalsGenerated,
      schemaAccepted: row.schemaAccepted,
      compilationAccepted: row.compilationAccepted,
      duplicateRejected: row.duplicateRejected,
      uniqueGenomes: row._digests.size,
      arenaEntrants: row.arenaEntrants,
      medianArenaScore: scores.length > 0 ? scores[Math.floor(scores.length / 2)] : null,
      bestArenaRank: row.bestArenaRank,
      gateFailures: row.gateFailures,
      watchdog: { ...row.watchdog },
    };
  }
  return out;
}

/** Deterministic digest of a proposal for cross-referencing in memory. */
export function proposalDigest(proposal) {
  return digestOf(proposal ?? {}).slice(0, 12);
}
