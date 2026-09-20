/**
 * EVOLVE Phase 5I.1a — TEMPORAL-EXTENSION MANIFEST STORAGE.
 *
 *   .evolve/jev-direction/temporal/<temporal-id>/
 *     temporal.json   the frozen temporal-extension manifest (contract + pins)
 *     sessions.json   one record per ADDED session (CLEAN, CONTAMINATED or INELIGIBLE)
 *     summary.json    the frozen cross-session aggregation of CLEAN temporal sessions
 *
 * The tree is DELIBERATELY SEPARATE from the canonical Phase 5I.1 replication
 * tree. It REFERENCES immutable `jdir-*` experiments by id and pins the canonical
 * Phase 5I.1 wave by id/digest; it never copies, re-scores, edits or repairs any
 * artifact, and it never appends to the canonical replication manifest.
 *
 * IMMUTABILITY: a session id may be ADDED once. Re-adding the same id is refused.
 * The manifest is created ONCE per temporal id: `--temporal-create` is the only
 * creation path and there is deliberately no "latest".
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../../../lib/hash.mjs";
import { sanitizeForPublic } from "../../../lib/sanitize.mjs";
import { DIRECTION_ROUTING_FLAGS, DIRECTION_SCHEMA_VERSION } from "../definition.mjs";
import { DIRECTION_TEMPORAL_REPLICATION_FLAGS, TEMPORAL_REPLICATION_EVIDENCE_CLASS } from "../evidence.mjs";
import { createReplicationManifest } from "../replication/manifest.mjs";
import { compactStamp } from "../storage.mjs";
import {
  CANONICAL_REPLICATION_BARRIER,
  DIRECTION_TEMPORAL_ROOT_DIR,
  REQUIRED_CLEAN_TEMPORAL_SESSIONS,
  TEMPORAL_INDEPENDENCE_RULES,
  TEMPORAL_MANIFEST_FILE,
  TEMPORAL_PHASE,
  TEMPORAL_PROTOCOL_CONTRACT,
  TEMPORAL_PROTOCOL_DIGEST,
  TEMPORAL_PROTOCOL_VERSION,
  TEMPORAL_SELECTION_RULES,
  TEMPORAL_SESSIONS_FILE,
  TEMPORAL_SUMMARY_FILE,
} from "./protocol.mjs";

export const TEMPORAL_MANIFEST_VERSION = 1;

/** `jtrp-` — a distinct prefix, so a temporal id can never be a jrep or jdir id. */
const TEMPORAL_ID_PATTERN = /^jtrp-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/;

export function isValidTemporalId(temporalId) {
  return typeof temporalId === "string" && TEMPORAL_ID_PATTERN.test(temporalId);
}

/** Deterministic, filesystem-safe temporal-extension id. */
export function temporalIdFor({
  canonicalReplicationId = CANONICAL_REPLICATION_BARRIER.replicationId,
  protocolDigest = TEMPORAL_PROTOCOL_DIGEST,
  createdAt = Date.now(),
} = {}) {
  const stamp = compactStamp(createdAt);
  const suffix = digestOf({ kind: "jev-direction-temporal-extension", canonicalReplicationId, protocolDigest }).slice(0, 6);
  return `jtrp-${stamp}-${suffix}`;
}

/** Resolve a temporal extension's isolated root. Never resolves outside the tree. */
export function temporalRootFor(baseRoot, temporalId) {
  if (!isValidTemporalId(temporalId)) {
    throw new Error(`invalid Phase 5I.1a temporal-extension id '${temporalId}'`);
  }
  return path.join(baseRoot ?? DIRECTION_TEMPORAL_ROOT_DIR, temporalId);
}

/* ============================================================================
 * Low-level atomic JSON helpers
 * ==========================================================================*/

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

/* ============================================================================
 * The manifest
 * ==========================================================================*/

/**
 * Build the frozen temporal-extension manifest. Every pin is explicit, and the
 * manifest references BOTH the canonical development experiment and the canonical
 * Phase 5I.1 wave by id/digest rather than duplicating them.
 */
export function createTemporalManifest({
  temporalId,
  protocol = TEMPORAL_PROTOCOL_CONTRACT,
  createdAt = Date.now(),
  canonicalArtifactsPresent = false,
}) {
  // The expected pins are derived from the SAME frozen protocol contract the
  // canonical replication manifest derives its own from — so a temporal session
  // is judged against byte-identical predictive semantics.
  const expected = createReplicationManifest({
    replicationId: `jrep-expected-temporal-pins`,
    development: {
      experimentId: CANONICAL_REPLICATION_BARRIER.developmentExperimentId,
      metricsDigest: CANONICAL_REPLICATION_BARRIER.developmentMetricsDigest,
      evidenceClass: "DEVELOPMENT_JEV_DIRECTION_EVIDENCE",
      phase: "5I.0b",
      requiredCleanSessions: REQUIRED_CLEAN_TEMPORAL_SESSIONS,
    },
    protocol,
  }).expected;

  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    manifestVersion: TEMPORAL_MANIFEST_VERSION,
    phase: TEMPORAL_PHASE,
    protocolPhase: "5I.0b",
    artifactKind: "DIRECTION_TEMPORAL_EXTENSION_MANIFEST",
    temporalId,
    evidenceClass: TEMPORAL_REPLICATION_EVIDENCE_CLASS,
    ...DIRECTION_TEMPORAL_REPLICATION_FLAGS,
    ...DIRECTION_ROUTING_FLAGS,
    // ---- §1 the canonical development identity (referenced, not copied) -----
    developmentExperimentId: CANONICAL_REPLICATION_BARRIER.developmentExperimentId,
    developmentMetricsDigest: CANONICAL_REPLICATION_BARRIER.developmentMetricsDigest,
    // ---- §1/§9 the canonical Phase 5I.1 wave (referenced, never modified) ---
    canonicalReplicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
    canonicalReplicationDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
    canonicalReplicationAggregateDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    canonicalReplicationSessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    canonicalReplicationProtocolDigest: CANONICAL_REPLICATION_BARRIER.protocolDigest,
    canonicalReplicationEvidenceClass: CANONICAL_REPLICATION_BARRIER.evidenceClass,
    canonicalReplicationStatus: CANONICAL_REPLICATION_BARRIER.status,
    canonicalReplicationCleanSessionCount: CANONICAL_REPLICATION_BARRIER.cleanSessionCount,
    canonicalReplicationCleanSessionIds: [...CANONICAL_REPLICATION_BARRIER.cleanSessionIds],
    canonicalReplicationInterpretation: {
      verdict:
        "The canonical Phase 5I.1 wave is a 3/3 CLEAN replication wave with a mixed Jev-vs-neutral result and no established " +
        "directional edge.",
      scope: "REPLICATION evidence only.",
      edge: "No persistent edge has been established.",
      inference: "No profitability inference is permitted.",
      automatedWinner: null,
      noAutomatedWinner: true,
      immutable: true,
      independentlyReproducible: true,
    },
    canonicalArtifactsPresent: canonicalArtifactsPresent === true,
    // ---- §10 the protocol contract (SAME digest as Phase 5I.1) --------------
    temporalProtocolVersion: TEMPORAL_PROTOCOL_VERSION,
    temporalProtocolDigest: TEMPORAL_PROTOCOL_DIGEST,
    protocolDigest: TEMPORAL_PROTOCOL_DIGEST,
    protocolUnchangedFromReplication: true,
    // ---- §9 the pinned expected pins ----------------------------------------
    expected,
    // ---- §5 the frozen independence + selection rules -----------------------
    independenceRules: { ...TEMPORAL_INDEPENDENCE_RULES },
    temporalSelectionRules: { ...TEMPORAL_SELECTION_RULES },
    selectionBasis: TEMPORAL_SELECTION_RULES.selectionBasis,
    timingNotSelectedFromObservedPerformance: true,
    timingNotSelectedFromMarketView: true,
    violationPreservedNeverSilentlyExcluded: true,
    requiredCleanSessions: REQUIRED_CLEAN_TEMPORAL_SESSIONS,
    primaryInferenceUnit: "dataset/session",
    equalWeightPerCleanSession: true,
    noObservationLevelPseudoReplication: true,
    noNewWinnerField: true,
    noPromotionToPhase5I2: true,
    noTradingLogic: true,
    noJevCacheInPredictivePath: true,
    singleAssetOnly: true,
    crossAssetTestingDeferredTo: "5I.1b",
    canonicalResultImmutable: true,
    canonicalResultIndependentlyReproducible: true,
    createdAt: new Date(createdAt).toISOString(),
    status: "OPEN",
    note:
      "Phase 5I.1a temporal-extension manifest. It re-uses the frozen Phase 5I.1 predictive protocol digest verbatim and " +
      "references immutable jdir-* experiment ids plus the canonical Phase 5I.1 wave; it never copies, edits or re-scores " +
      "their artifacts and never appends to the canonical replication manifest. No developed claim, no profitability " +
      "claim, no trading and no deployment decision of any kind.",
  };
}

export async function writeTemporalManifest(root, manifest) {
  if (!root || !manifest?.temporalId) return null;
  const record = sanitizeForPublic({ ...manifest, updatedAt: new Date().toISOString() });
  record.manifestContentDigest = manifestDigestOf(record);
  await writeJsonAtomic(path.join(root, TEMPORAL_MANIFEST_FILE), record);
  return record;
}

export async function readTemporalManifest(root) {
  return readJson(path.join(root ?? "", TEMPORAL_MANIFEST_FILE), null);
}

/** The manifest's own content digest (bookkeeping stamp and digest excluded). */
export function manifestDigestOf(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "updatedAt" || key === "manifestContentDigest") continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

/* ============================================================================
 * Sessions
 * ==========================================================================*/

export const TEMPORAL_SESSIONS_VERSION = 1;

export function createTemporalSessionsDocument({ temporalId, sessions = [] }) {
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    sessionsVersion: TEMPORAL_SESSIONS_VERSION,
    artifactKind: "DIRECTION_TEMPORAL_EXTENSION_SESSIONS",
    temporalId,
    evidenceClass: TEMPORAL_REPLICATION_EVIDENCE_CLASS,
    ...DIRECTION_TEMPORAL_REPLICATION_FLAGS,
    sessionCount: sessions.length,
    sessions,
  };
}

export async function writeTemporalSessions(root, document) {
  if (!root || !document?.temporalId) return null;
  const record = sanitizeForPublic(document);
  await writeJsonAtomic(path.join(root, TEMPORAL_SESSIONS_FILE), record);
  return record;
}

export async function readTemporalSessions(root) {
  return readJson(path.join(root ?? "", TEMPORAL_SESSIONS_FILE), null);
}

/** The digest of the session records array (order-sensitive, so re-adding is visible). */
export function sessionsDigestOf(sessions = []) {
  return digestOf(sessions ?? []);
}

/* ============================================================================
 * Summary
 * ==========================================================================*/

export const TEMPORAL_SUMMARY_VERSION = 1;

export async function writeTemporalSummary(root, summary) {
  if (!root) return null;
  const record = sanitizeForPublic({ ...summary, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, TEMPORAL_SUMMARY_FILE), record);
  return record;
}

export async function readTemporalSummary(root) {
  return readJson(path.join(root ?? "", TEMPORAL_SUMMARY_FILE), null);
}

/** The digest of the temporal aggregate content itself (volatile bookkeeping excluded). */
export function aggregateDigestOf(summary) {
  if (!summary || typeof summary !== "object") return null;
  return digestOf({
    status: summary.status ?? null,
    cleanSessionCount: summary.cleanSessionCount ?? null,
    cleanSessionIds: summary.cleanSessionIds ?? null,
    totalSessionCount: summary.totalSessionCount ?? null,
    comparisons: summary.comparisons ?? null,
    absolute: summary.absolute ?? null,
    bootstrap: summary.bootstrap ?? null,
    perSession: summary.perSession ?? null,
    excludedSessions: summary.excludedSessions ?? null,
  });
}

/** The digest of the COMBINED descriptive view (canonical + temporal) alone. */
export function combinedDigestOf(combined) {
  if (!combined || typeof combined !== "object") return null;
  return digestOf(combined);
}

export async function listTemporalIds(baseRoot = DIRECTION_TEMPORAL_ROOT_DIR) {
  let entries = [];
  try {
    entries = await readdir(baseRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isValidTemporalId(entry.name)) continue;
    const manifest = await readTemporalManifest(path.join(baseRoot, entry.name));
    if (manifest) out.push(manifest);
  }
  return out;
}

/** Read an entire temporal bundle. READ ONLY. */
export async function readTemporalBundle(root) {
  const [manifest, sessions, summary] = await Promise.all([
    readTemporalManifest(root),
    readTemporalSessions(root),
    readTemporalSummary(root),
  ]);
  return { manifest, sessions, summary };
}

/** Byte-level metadata snapshot, to prove an offline pass wrote nothing. */
export async function temporalMetadataSnapshot(root) {
  const out = [];
  const walk = async (dir, relative) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, rel);
        continue;
      }
      const content = await readFile(absolute, "utf8").catch(() => null);
      if (content === null) continue;
      out.push({ path: rel, bytes: content.length, digest: digestOf(content) });
    }
  };
  await walk(root, "");
  return out;
}

export const TEMPORAL_STORAGE_PATHS = Object.freeze({
  root: DIRECTION_TEMPORAL_ROOT_DIR,
  manifest: TEMPORAL_MANIFEST_FILE,
  sessions: TEMPORAL_SESSIONS_FILE,
  summary: TEMPORAL_SUMMARY_FILE,
});
