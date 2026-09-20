/**
 * Phase 5I.1 — REPLICATION MANIFEST STORAGE.
 *
 *   .evolve/jev-direction/replication/<replication-id>/
 *     replication.json   the frozen replication manifest (contract + pins)
 *     sessions.json      one record per ADDED session (CLEAN or excluded)
 *     summary.json       the frozen cross-session aggregation of CLEAN sessions
 *
 * The tree REFERENCES existing immutable `jdir-*` experiments by id. It never
 * copies, re-scores, edits or repairs their raw artifacts — a session's
 * observation-level detail stays exactly where it was frozen, and the manifest
 * stores its digest plus the session-level derivation computed from it.
 *
 * IMMUTABILITY: a session id may be ADDED once. Re-adding the same id is refused
 * (the manifest is a wave record, not an append-and-forget log). The manifest
 * itself is created ONCE per replication id: `--replication-create` is the only
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
import { compactStamp } from "../storage.mjs";
import { REPLICATION_EVIDENCE_CLASS, DIRECTION_REPLICATION_FLAGS } from "../evidence.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_MANIFEST_FILE,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_PROTOCOL_VERSION,
  REPLICATION_SESSIONS_FILE,
  REPLICATION_SUMMARY_FILE,
} from "./protocol.mjs";

export const REPLICATION_MANIFEST_VERSION = 1;

/** `jrep-` — a distinct prefix, so a replication id can never be a jdir id. */
const REPLICATION_ID_PATTERN = /^jrep-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/;

export function isValidReplicationId(replicationId) {
  return typeof replicationId === "string" && REPLICATION_ID_PATTERN.test(replicationId);
}

/** Deterministic, filesystem-safe replication id. */
export function replicationIdFor({ developmentExperimentId, protocolDigest = REPLICATION_PROTOCOL_DIGEST, createdAt = Date.now() } = {}) {
  const stamp = compactStamp(createdAt);
  const suffix = digestOf({ kind: "jev-direction-replication", developmentExperimentId, protocolDigest }).slice(0, 6);
  return `jrep-${stamp}-${suffix}`;
}

/**
 * Resolve a replication's isolated root. Never resolves outside
 * `.evolve/jev-direction/replication/`, and never outside a caller-supplied
 * replication tree.
 */
export function replicationRootFor(baseRoot, replicationId) {
  if (!isValidReplicationId(replicationId)) {
    throw new Error(`invalid Phase 5I.1 replication id '${replicationId}'`);
  }
  return path.join(baseRoot ?? DIRECTION_REPLICATION_ROOT_DIR, replicationId);
}

/* ============================================================================
 * Low-level atomic JSON helpers (same shape as the 5I storage helpers)
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
 * Build the frozen replication manifest (§9). Every pin is explicit and every
 * pin is compared by digest at read time; the manifest references the canonical
 * development experiment by ID rather than duplicating it.
 */
export function createReplicationManifest({
  replicationId,
  development,
  protocol = null,
  createdAt = Date.now(),
  developmentArtifactsPresent = false,
}) {
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    manifestVersion: REPLICATION_MANIFEST_VERSION,
    phase: development?.phase ?? "5I.0b",
    artifactKind: "DIRECTION_REPLICATION_MANIFEST",
    replicationId,
    evidenceClass: REPLICATION_EVIDENCE_CLASS,
    ...DIRECTION_REPLICATION_FLAGS,
    ...DIRECTION_ROUTING_FLAGS,
    // ---- §1/§19 the pinned development identity (referenced, not copied) ----
    developmentExperimentId: development.experimentId,
    developmentMetricsDigest: development.metricsDigest,
    developmentEvidenceClass: development.evidenceClass,
    developmentPhase: development.phase,
    developmentBarrierDigest: development.barrierDigest ?? null,
    developmentInterpretation: development.interpretation ?? null,
    developmentSession: development.session ?? null,
    developmentArtifactsPresent: developmentArtifactsPresent === true,
    // ---- §10 the protocol contract ------------------------------------------
    replicationProtocolVersion: REPLICATION_PROTOCOL_VERSION,
    replicationProtocolDigest: REPLICATION_PROTOCOL_DIGEST,
    // ---- §9 the pinned expected pins ----------------------------------------
    expected: {
      provider: protocol.forecaster.provider,
      upstreamProvider: protocol.forecaster.upstreamProvider,
      model: protocol.forecaster.model,
      gatewayUsed: protocol.forecaster.gatewayUsed,
      mode: protocol.forecaster.mode,
      marketId: protocol.market.marketId,
      baseMint: protocol.market.baseMint,
      quoteMint: protocol.market.quoteMint,
      horizonSeconds: protocol.horizon.horizonSeconds,
      resolutionToleranceMs: protocol.timing.resolutionToleranceMs,
      cadenceSeconds: protocol.cadence.samplingCadenceMs / 1_000,
      sessionSize: protocol.observationsPerSession,
      requiredCleanSessions: development?.requiredCleanSessions ?? 3,
      questionSetId: protocol.questions.questionSetId,
      questionSetVersion: protocol.questions.questionSetVersion,
      questionDigest: protocol.questions.questionDigest,
      packetKind: protocol.questions.packetKind,
      packetVersion: protocol.questions.packetVersion,
      featureDefinitionVersion: protocol.features.definitionVersion,
      featureDefinitionDigest: protocol.features.definitionDigest,
      baselineDefinitionVersion: protocol.baselines.definitionVersion,
      baselineDefinitionDigest: protocol.baselines.definitionDigest,
      metricDefinitionVersion: protocol.metrics.definitionVersion,
      metricDefinitionDigest: protocol.metrics.definitionDigest,
      referencePriceDefinitionVersion: protocol.referencePrice.definitionVersion,
      referencePriceDefinitionDigest: protocol.referencePrice.definitionDigest,
      outcomeResolutionPolicyVersion: protocol.outcomeResolution.policyVersion,
      outcomeResolutionPolicyDigest: protocol.outcomeResolution.policyDigest,
      stalenessPolicyVersion: protocol.staleness.policyVersion,
      stalenessPolicyDigest: protocol.staleness.policyDigest,
    },
    // ---- §15/§16 the no-tuning rules ----------------------------------------
    noTuningFromDevelopment: true,
    noTuningBetweenSessions: true,
    interruptedWaveIsIncomparable: true,
    protocolFrozenBeforeReplication: true,
    primaryInferenceUnit: "dataset/session",
    noObservationLevelPseudoReplication: true,
    createdAt: new Date(createdAt).toISOString(),
    status: "OPEN",
    note:
      "Phase 5I.1 replication manifest. It references immutable jdir-* experiment ids and stores their digests; it never " +
      "copies, edits or re-scores their artifacts. Replication only: no development claim, no profitability claim, no " +
      "trading and no deployment decision of any kind.",
  };
}

export async function writeReplicationManifest(root, manifest) {
  if (!root || !manifest?.replicationId) return null;
  const record = sanitizeForPublic({ ...manifest, updatedAt: new Date().toISOString() });
  record.manifestContentDigest = manifestDigestOf(record);
  await writeJsonAtomic(path.join(root, REPLICATION_MANIFEST_FILE), record);
  return record;
}

export async function readReplicationManifest(root) {
  return readJson(path.join(root ?? "", REPLICATION_MANIFEST_FILE), null);
}

/**
 * The manifest's own content digest. The bookkeeping stamp and the digest field
 * itself are excluded, so the digest describes the CONTRACT the manifest pins.
 */
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

export const REPLICATION_SESSIONS_VERSION = 1;

export function createSessionsDocument({ replicationId, sessions = [] }) {
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    sessionsVersion: REPLICATION_SESSIONS_VERSION,
    artifactKind: "DIRECTION_REPLICATION_SESSIONS",
    replicationId,
    evidenceClass: REPLICATION_EVIDENCE_CLASS,
    ...DIRECTION_REPLICATION_FLAGS,
    sessionCount: sessions.length,
    sessions,
  };
}

export async function writeReplicationSessions(root, document) {
  if (!root || !document?.replicationId) return null;
  const record = sanitizeForPublic(document);
  await writeJsonAtomic(path.join(root, REPLICATION_SESSIONS_FILE), record);
  return record;
}

export async function readReplicationSessions(root) {
  return readJson(path.join(root ?? "", REPLICATION_SESSIONS_FILE), null);
}

/** The digest of the session records array (order-sensitive, so re-adding is visible). */
export function sessionsDigestOf(sessions = []) {
  return digestOf(sessions ?? []);
}

/* ============================================================================
 * Summary
 * ==========================================================================*/

export const REPLICATION_SUMMARY_VERSION = 1;

export async function writeReplicationSummary(root, summary) {
  if (!root) return null;
  const record = sanitizeForPublic({ ...summary, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, REPLICATION_SUMMARY_FILE), record);
  return record;
}

export async function readReplicationSummary(root) {
  return readJson(path.join(root ?? "", REPLICATION_SUMMARY_FILE), null);
}

/** The digest of the aggregate content itself (volatile bookkeeping excluded). */
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

export async function listReplicationIds(baseRoot = DIRECTION_REPLICATION_ROOT_DIR) {
  let entries = [];
  try {
    entries = await readdir(baseRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isValidReplicationId(entry.name)) continue;
    const manifest = await readReplicationManifest(path.join(baseRoot, entry.name));
    if (manifest) out.push(manifest);
  }
  return out;
}

/** Read an entire replication bundle. READ ONLY. */
export async function readReplicationBundle(root) {
  const [manifest, sessions, summary] = await Promise.all([
    readReplicationManifest(root),
    readReplicationSessions(root),
    readReplicationSummary(root),
  ]);
  return { manifest, sessions, summary };
}

/**
 * Byte-level metadata snapshot used to prove a replay/validator wrote nothing
 * under the replication tree (same idea as the Phase 5I experiment snapshot and
 * the Phase 5H canonical barrier snapshot).
 */
export async function replicationMetadataSnapshot(root) {
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

export const REPLICATION_STORAGE_PATHS = Object.freeze({
  root: DIRECTION_REPLICATION_ROOT_DIR,
  manifest: REPLICATION_MANIFEST_FILE,
  sessions: REPLICATION_SESSIONS_FILE,
  summary: REPLICATION_SUMMARY_FILE,
});
