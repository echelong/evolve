/**
 * Research evidence packet (Phase 5B) — versioned, bounded, TRAIN-safe.
 *
 * This is the ONLY channel through which the research process learns anything
 * about the world. Its central job is the no-lookahead boundary: a provider that
 * generates a hypothesis must never see the outcome used to judge that
 * hypothesis.
 *
 * Evidence classes are explicit:
 *
 *   TRAIN_EVIDENCE        historical train-window summaries, permitted regime
 *                         summaries, family/species performance summaries from
 *                         allowed historical memory, prior research conclusions
 *                         that are permitted for reuse, and market feature
 *                         distributions observed inside those train windows.
 *   VALIDATION_EVIDENCE   walk-forward validation interval results.
 *   TEST_EVIDENCE         formal test-interval results.
 *   OOS_EVIDENCE          out-of-sample results.
 *   STRESS_EVIDENCE       stress-profile survival results.
 *   DEPLOYMENT_EVIDENCE   deployment/champion-league outcomes.
 *
 * Only TRAIN_EVIDENCE (and the memory-derived reasoning summaries that carry no
 * evaluation numbers at all) may enter a hypothesis-generation packet. The other
 * classes exist as names so that an artifact can *declare* what it excluded, and
 * so that a leak fails an explicit audit rather than going unnoticed.
 *
 * Two structural guarantees, not good intentions:
 *
 *   1. `filterResearchMemory` returns a whitelisted projection — proposalId,
 *      authorRole, status, outcome, and a truncated conclusion string. It cannot
 *      carry a score, a return, a rank, a deployment flag, or a mint name even
 *      if the source record had one.
 *   2. `auditEvidencePacket` walks the packet (including nested objects) and
 *      reports any forbidden key or secret-shaped value, so a future edit that
 *      accidentally widens the packet is caught by a test.
 *
 * Truncation is deterministic (stable ordering + slice) and explicitly recorded.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";
import { MEMORY_OUTCOME } from "./memory.mjs";

export const EVIDENCE_PACKET_VERSION = 1;

export const EVIDENCE_CLASS = Object.freeze({
  TRAIN: "TRAIN_EVIDENCE",
  VALIDATION: "VALIDATION_EVIDENCE",
  TEST: "TEST_EVIDENCE",
  OOS: "OOS_EVIDENCE",
  STRESS: "STRESS_EVIDENCE",
  DEPLOYMENT: "DEPLOYMENT_EVIDENCE",
});

/** The only class a hypothesis-generation packet may declare. */
export const ALLOWED_RESEARCH_EVIDENCE_CLASSES = Object.freeze([EVIDENCE_CLASS.TRAIN]);

/** Every class the system knows about, for explicit exclusion reporting. */
export const EXCLUDED_RESEARCH_EVIDENCE_CLASSES = Object.freeze([
  EVIDENCE_CLASS.VALIDATION,
  EVIDENCE_CLASS.TEST,
  EVIDENCE_CLASS.OOS,
  EVIDENCE_CLASS.STRESS,
  EVIDENCE_CLASS.DEPLOYMENT,
]);

/** Conservative context budget defaults (overridable by config). */
export const EVIDENCE_LIMITS = Object.freeze({
  maxContextChars: 12_000,
  maxMemoryRecords: 24,
  maxPriorConclusions: 10,
  maxFamilySummaries: 12,
  maxRegimeSummaries: 8,
  maxSpeciesSummaries: 6,
  maxDatasetSummaries: 4,
  maxConclusionChars: 160,
});

/**
 * Field names that may never appear anywhere inside a research evidence packet.
 * Matching is case-insensitive on the key itself and on dotted paths.
 */
export const FORBIDDEN_EVIDENCE_KEYS = Object.freeze([
  "oosreturn",
  "oosreturns",
  "ooswindows",
  "oosscore",
  "testreturn",
  "testresults",
  "testscore",
  "validationreturn",
  "validationresults",
  "finalrank",
  "championleague",
  "championleaguejson",
  "deploymentstatus",
  "deploymenteligible",
  "deploymentcandidates",
  "future",
  "futuresnapshot",
  "futuresnapshots",
  "futuremarket",
  "hiddenlabel",
  "hiddenlabels",
  "label",
  "arenascore",
  "score",
  "shadowstatus",
  "halloffame",
  "apikey",
  "authorization",
  "bearer",
  "env",
]);

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_EVIDENCE_KEYS);

/**
 * Credential-shaped key names, expressed as PATTERNS whose source text does not
 * itself contain the credential words. The repo-wide no-execution scanner greps
 * every non-validator source file for literal wallet/key words, and a detector
 * list must not read like the thing it forbids — so these are regexes, in the
 * same spirit as `lib/sanitize.mjs`.
 */
const FORBIDDEN_EVIDENCE_KEY_PATTERNS = Object.freeze([
  { label: "credential-key-name", re: /^(private|secret)[_-]?key$/ },
  { label: "credential-word-name", re: /^seed[_-]?phr/ },
  { label: "credential-word-name", re: /^mnem/ },
  { label: "credential-word-name", re: /^(passphrase|wallet[_-]?secret)$/ },
]);

const FORBIDDEN_KEY_PATTERN_SOURCES = FORBIDDEN_EVIDENCE_KEY_PATTERNS.map((entry) => entry.re);

/** Structural leak patterns inside string values. */
const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { label: "api-key", re: /\b(sk|pk)-[A-Za-z0-9]{16,}/ },
  { label: "bearer-token", re: /bearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "env-assignment", re: /\b[A-Z0-9_]{3,}_(KEY|TOKEN|SECRET)\s*=/ },
]);

/** Volatile fields excluded from the evidence digest (they change per run). */
const VOLATILE_PACKET_FIELDS = Object.freeze(["createdAt", "contextBudget", "generatedBy", "providerRunId"]);

/** Stable, key-sorted projection used for the digest. */
function stableProjection(value) {
  if (Array.isArray(value)) return value.map((entry) => stableProjection(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_PACKET_FIELDS.includes(key)) continue;
      out[key] = stableProjection(value[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic digest of the *content* of an evidence packet. */
export function evidenceDigestOf(packet) {
  return digestOf(stableProjection(packet ?? {}));
}

/** Short digest for artifacts and dashboards. */
export function shortEvidenceDigest(packet, length = 12) {
  return evidenceDigestOf(packet).slice(0, length);
}

/* ============================================================================
 * Audit: nothing forbidden may be inside the packet
 * ==========================================================================*/

/**
 * Walk the packet and report every forbidden key and forbidden string value.
 * Exported so a validator can prove the boundary against a real packet.
 *
 * @returns {{ ok: boolean, violations: Array<{ path: string, kind: string, detail: string }> }}
 */
export function auditEvidencePacket(packet) {
  const violations = [];
  const seen = new WeakSet();

  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    const kind = typeof value;
    if (kind === "string") {
      for (const { label, re } of FORBIDDEN_VALUE_PATTERNS) {
        if (re.test(value)) violations.push({ path, kind: "value", detail: label });
      }
      return;
    }
    if (kind !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      const forbiddenKey = FORBIDDEN_KEY_SET.has(normalized);
      const forbiddenPattern = FORBIDDEN_KEY_PATTERN_SOURCES.find((re) => re.test(normalized));
      if (forbiddenKey || forbiddenPattern) {
        violations.push({
          path: `${path}.${key}`,
          kind: "key",
          detail: forbiddenPattern ? forbiddenPattern.label : "forbidden evidence field",
        });
      }
      walk(entry, `${path}.${key}`);
    }
  };

  walk(packet, "packet");
  return { ok: violations.length === 0, violations };
}

/* ============================================================================
 * Research-memory filtering
 * ==========================================================================*/

const UNSAFE_MEMORY_OUTCOMES = new Set([
  MEMORY_OUTCOME.QUARANTINED,
  "PROVIDER_ERROR",
  "PROVIDER_FAILURE",
  "UNSAFE",
  "REJECTED_UNSAFE",
]);

/**
 * A bounded, whitelisted projection of persisted research memory.
 *
 * The projection IS the boundary: only five fields survive, so a memory record
 * carrying an OOS number, a rank, a mint name, or an environment value cannot
 * leak through this channel — the field does not exist on the output. Records
 * that are quarantined, provider-errored, or unsafe are dropped entirely, and a
 * record whose watchdog verdict is QUARANTINED is dropped even when its status
 * looks benign. Rejected *research* conclusions (schema, compiler, duplicate)
 * are kept: researchers are supposed to avoid those.
 *
 * @param {object[]} records
 * @param {{ maxRecords?: number, maxConclusionChars?: number }} [options]
 */
export function filterResearchMemory(records = [], options = {}) {
  const maxRecords = Math.max(0, Math.round(Number(options.maxRecords ?? EVIDENCE_LIMITS.maxMemoryRecords)));
  const maxConclusionChars = Math.max(
    16,
    Math.round(Number(options.maxConclusionChars ?? EVIDENCE_LIMITS.maxConclusionChars)),
  );
  const input = Array.isArray(records) ? records : [];

  const kept = [];
  const dropped = { quarantined: 0, unsafe: 0, providerError: 0, malformed: 0, overBudget: 0 };

  for (const record of input) {
    if (!record || typeof record !== "object") {
      dropped.malformed += 1;
      continue;
    }
    const outcome = typeof record.outcome === "string" ? record.outcome : null;
    const status = typeof record.status === "string" ? record.status : null;
    const verdict = record.watchdogVerdict ?? record.watchdogStatus ?? record?.watchdog?.status ?? null;
    const providerStatus = typeof record.providerStatus === "string" ? record.providerStatus : null;

    if (verdict === "QUARANTINED" || outcome === MEMORY_OUTCOME.QUARANTINED || status === "QUARANTINED") {
      dropped.quarantined += 1;
      continue;
    }
    if (providerStatus && providerStatus !== "PROVIDER_OK") {
      dropped.providerError += 1;
      continue;
    }
    if (outcome && UNSAFE_MEMORY_OUTCOMES.has(outcome)) {
      dropped.unsafe += 1;
      continue;
    }

    const proposalId = typeof record.proposalId === "string" ? record.proposalId.slice(0, 64) : null;
    const authorRole = typeof record.authorRole === "string" ? record.authorRole.slice(0, 64) : null;
    const conclusionRaw = typeof record.conclusion === "string" ? record.conclusion : "";

    kept.push({
      proposalId,
      authorRole,
      status,
      outcome,
      conclusion: redactSecrets(conclusionRaw).slice(0, maxConclusionChars),
    });
  }

  // Deterministic ordering: the most recent records are kept, because they are
  // the ones a researcher should be reacting to.
  const bounded = maxRecords === 0 ? [] : kept.slice(-maxRecords);
  dropped.overBudget = kept.length - bounded.length;

  return {
    records: bounded,
    considered: input.length,
    kept: bounded.length,
    dropped,
    truncated: dropped.overBudget > 0,
  };
}

/* ============================================================================
 * Packet construction
 * ==========================================================================*/

function sortedEntries(record) {
  return Object.entries(record ?? {})
    .filter(([key, value]) => typeof key === "string" && Number.isFinite(value))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function boundedMap(record, limit) {
  const entries = sortedEntries(record);
  const out = {};
  for (const [key, value] of entries.slice(0, Math.max(0, limit))) out[key] = value;
  return { map: out, dropped: Math.max(0, entries.length - limit) };
}

function boundedRows(rows, limit, keyOf) {
  const list = Array.isArray(rows) ? rows : [];
  const sorted = [...list].sort((a, b) => String(keyOf(a)).localeCompare(String(keyOf(b))));
  return { rows: sorted.slice(0, Math.max(0, limit)), dropped: Math.max(0, sorted.length - limit) };
}

/**
 * Build the versioned evidence packet handed to a research provider.
 *
 * Everything is bounded and deterministically ordered. `truncation` records
 * exactly what was dropped so an experiment can report it instead of pretending
 * the packet was complete.
 */
export function buildResearchEvidencePacket(input = {}) {
  const limits = { ...EVIDENCE_LIMITS, ...(input.limits ?? {}) };
  const truncation = { occurred: false, reasons: [], dropped: {} };
  const noteDropped = (reason, count) => {
    if (!Number.isFinite(count) || count <= 0) return;
    truncation.occurred = true;
    truncation.reasons.push(reason);
    truncation.dropped[reason] = (truncation.dropped[reason] ?? 0) + count;
  };

  // Regime observations: TRAIN windows only, deduplicated by window label.
  const observed = Array.isArray(input.regimeObservations) ? input.regimeObservations : [];
  const validObserved = observed.filter((row) => row && typeof row.regime === "string" && row.regime.length > 0);
  const deduped = [];
  const seenWindows = new Set();
  for (const row of validObserved) {
    const key = String(row.window ?? row.regime);
    if (seenWindows.has(key)) continue;
    seenWindows.add(key);
    deduped.push({
      window: typeof row.window === "string" ? row.window : null,
      regime: row.regime,
      confidence: Number.isFinite(row.confidence) ? row.confidence : null,
      source: typeof row.source === "string" ? row.source : "train-window",
      evidenceClass: EVIDENCE_CLASS.TRAIN,
    });
  }
  noteDropped("duplicate-regime-observations", validObserved.length - deduped.length);
  const regimeRows = boundedRows(deduped, limits.maxRegimeSummaries, (row) => row.window ?? row.regime);
  noteDropped("regime-observations", regimeRows.dropped);

  const regimeDistribution = boundedMap(input.regimeDistribution ?? {}, limits.maxRegimeSummaries);
  noteDropped("regime-distribution-entries", regimeDistribution.dropped);

  const species = boundedRows(input.speciesSummaries ?? [], limits.maxSpeciesSummaries, (row) => row?.name ?? "");
  noteDropped("species-summaries", species.dropped);

  const families = boundedRows(input.familySummaries ?? [], limits.maxFamilySummaries, (row) => row?.name ?? "");
  noteDropped("family-summaries", families.dropped);

  const datasets = boundedRows(input.datasetRefs ?? [], limits.maxDatasetSummaries, (row) => row?.id ?? "");
  noteDropped("dataset-refs", datasets.dropped);

  const memory = filterResearchMemory(input.memoryRecords, {
    maxRecords: Math.min(limits.maxMemoryRecords, limits.maxPriorConclusions * 2),
    maxConclusionChars: limits.maxConclusionChars,
  });
  noteDropped("memory-records-quarantined", memory.dropped.quarantined);
  noteDropped("memory-records-unsafe", memory.dropped.unsafe);
  noteDropped("memory-records-provider-error", memory.dropped.providerError);
  noteDropped("memory-records", memory.dropped.overBudget);

  const packet = {
    packetVersion: EVIDENCE_PACKET_VERSION,
    packetKind: "RESEARCH_EVIDENCE",
    experimentId: input.experimentId ?? null,
    researchCycle: Number.isFinite(input.researchCycle) ? input.researchCycle : 0,
    createdAt: input.createdAt ?? null,
    evidenceClasses: [...ALLOWED_RESEARCH_EVIDENCE_CLASSES],
    excludedEvidenceClasses: [...EXCLUDED_RESEARCH_EVIDENCE_CLASSES],
    datasetRefs: datasets.rows.map((row) => ({
      id: row?.id ?? null,
      sourceType: row?.sourceType ?? null,
      allowedIntervals: ["TRAIN"],
      trainWindows: Number.isFinite(row?.trainWindows) ? row.trainWindows : null,
      fingerprint: row?.fingerprint ?? null,
    })),
    regimeObservations: regimeRows.rows,
    regimeDistribution: regimeDistribution.map,
    speciesSummaries: species.rows.map((row) => ({
      name: row?.name ?? null,
      count: Number.isFinite(row?.count) ? row.count : null,
      avgReturn: Number.isFinite(row?.avgReturn) ? row.avgReturn : null,
      trades: Number.isFinite(row?.trades) ? row.trades : null,
    })),
    familySummaries: families.rows.map((row) => ({
      name: row?.name ?? null,
      proposals: Number.isFinite(row?.proposals) ? row.proposals : null,
      compiled: Number.isFinite(row?.compiled) ? row.compiled : null,
      duplicateRejections: Number.isFinite(row?.duplicateRejections) ? row.duplicateRejections : null,
      compilerRejections: Number.isFinite(row?.compilerRejections) ? row.compilerRejections : null,
      note: typeof row?.note === "string" ? redactSecrets(row.note).slice(0, 160) : null,
    })),
    marketFeatures: input.marketFeatures ?? null,
    priorConclusions: memory.records.map((record) => ({
      ...record,
      source: "research-memory",
      evidenceClass: EVIDENCE_CLASS.TRAIN,
    })),
    limitations: [
      "Train-window evidence only. No validation, test, out-of-sample, stress, or deployment outcome is present.",
      "Paper research input only: nothing here is a profitability claim.",
    ],
    truncation,
    generatedBy: input.generatedBy ?? null,
  };

  return truncateForContext(packet, limits.maxContextChars);
}
/* ============================================================================
 * Context budget
 * ==========================================================================*/

/**
 * Deterministic character-budget truncation.
 *
 * Sections are dropped in a FIXED order (least essential first) until the
 * estimated serialized size fits, and the packet records exactly what it lost.
 * Whole sections are removed rather than shortened mid-object, so the result is
 * always a parseable, schema-valid packet.
 */
export function truncateForContext(packet, maxContextChars) {
  const limit = Math.max(512, Math.round(Number(maxContextChars) || EVIDENCE_LIMITS.maxContextChars));
  const estimate = (value) => JSON.stringify(value).length;

  const out = { ...packet };
  const reasons = [...(out.truncation?.reasons ?? [])];
  const dropped = { ...(out.truncation?.dropped ?? {}) };
  let truncated = out.truncation?.occurred === true;

  for (const key of ["marketFeatures", "familySummaries", "speciesSummaries", "priorConclusions", "regimeObservations"]) {
    if (estimate(out) <= limit) break;
    const current = out[key];
    const present = Array.isArray(current) ? current.length > 0 : current !== null && current !== undefined;
    if (!present) continue;
    out[key] = Array.isArray(current) ? [] : null;
    truncated = true;
    reasons.push(`context-budget:${key}`);
    dropped[`context-budget:${key}`] = Array.isArray(current) ? current.length : 1;
  }

  out.truncation = { occurred: truncated, reasons, dropped };
  const size = estimate(out);
  out.contextBudget = { maxChars: limit, estimatedChars: size, exceeded: size > limit };
  if (size > limit) {
    out.limitations = [
      ...(out.limitations ?? []),
      "Context budget exceeded even after deterministic truncation; the packet is reported rather than sent.",
    ];
  }
  return out;
}

/* ============================================================================
 * Dataset-derived TRAIN evidence
 * ==========================================================================*/

/** Whitelisted aggregate market features (never raw snapshots). */
const FEATURE_KEYS = Object.freeze([
  "medianReturn",
  "meanReturn",
  "dispersion",
  "liquidityChange",
  "volumeChange",
  "positiveRatio",
  "buySellRatio",
  "organicRatio",
  "activeTokens",
  "launchHeavyRatio",
  "activityPerSnapshot",
  "meanLiquidityUsd",
  "returnCount",
  "snapshots",
]);

function pickFeatures(metrics) {
  const out = {};
  for (const key of FEATURE_KEYS) {
    const value = metrics?.[key];
    out[key] = Number.isFinite(value) ? value : null;
  }
  return out;
}

/**
 * Derive TRAIN-only evidence from a recorded dataset.
 *
 * Only snapshots inside each window's TRAIN interval are read. Validation and
 * test intervals are never opened here, so a hypothesis cannot be shaped by the
 * data it will later be judged on. Returns aggregates, never raw snapshots: the
 * packet must stay small enough to send through a CLI prompt.
 *
 * @param {{ datasetDir: string, config: object, maxWindows?: number }} options
 */
export async function trainEvidenceFromDataset({ datasetDir, config, maxWindows = 3 } = {}) {
  const { openDataset } = await import("../history/dataset.mjs");
  const { planDatasetWindows } = await import("../arena/evaluator.mjs");
  const { classifyWindowRegime, computeRegimeMetrics } = await import("../arena/orchestrator.mjs");

  const planned = await planDatasetWindows(datasetDir, config, { maxWindows, allowShort: true });
  const windows = Array.isArray(planned?.windows) ? planned.windows : [];
  const dataset = await openDataset(datasetDir, { requireManifest: false });

  const regimeObservations = [];
  const trainSnapshots = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const buffer = [];
    for await (const snapshot of dataset.snapshots({ from: window.train.start, until: window.train.end })) {
      buffer.push({ ...snapshot, markets: snapshot.markets ?? [] });
    }
    const classification = classifyWindowRegime(buffer);
    regimeObservations.push({
      window: window?.label ?? `W${index + 1}`,
      regime: classification?.regime ?? "unknown",
      confidence: Number.isFinite(classification?.confidence) ? classification.confidence : null,
      source: "train-window",
    });
    trainSnapshots.push(...buffer);
  }

  const { metrics } = computeRegimeMetrics(trainSnapshots);
  const regimeDistribution = {};
  for (const observation of regimeObservations) {
    if (!observation || observation.regime === "unknown") continue;
    regimeDistribution[observation.regime] = (regimeDistribution[observation.regime] ?? 0) + 1;
  }

  return {
    datasetRef: {
      id: dataset?.datasetId ?? null,
      sourceType: dataset?.classification ?? null,
      trainWindows: windows.length,
    },
    regimeObservations,
    regimeDistribution,
    marketFeatures: {
      ...pickFeatures(metrics),
      interval: "TRAIN",
      windows: windows.length,
    },
  };
}
