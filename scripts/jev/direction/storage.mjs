/**
 * Phase 5I.0b — storage for the directional benchmark.
 *
 * A SEPARATE research tree from the Phase 5D risk-supervisor experiments,
 * because the scientific target is different (short-horizon market direction vs
 * candidate gate risk):
 *
 *   .evolve/jev-direction/experiments/<experiment-id>/
 *     experiment.json              frozen pins + counters (no secrets)
 *     predictions/<observationId>.json   IMMUTABLE prediction artifact
 *     outcomes/<observationId>.json      IMMUTABLE outcome artifact
 *     summary.json                 finalized metric report + its digest
 *     progress.json                runner bookkeeping only (resumable)
 *
 * IMMUTABILITY SEMANTICS
 * ----------------------
 *   - a prediction is written ONCE, before its outcome can exist;
 *   - writing the same observationId again is only allowed when the content is
 *     byte-identical (idempotent re-write); a different digest throws
 *     `ImmutableArtifactError` and the caller must not continue;
 *   - the prediction artifact carries `predictionDigest`, computed over the
 *     artifact with the digest field itself removed, so a later recomputation
 *     detects ANY edit;
 *   - an outcome artifact records the `verifiedPredictionDigest` it verified
 *     immediately before computing the outcome, plus whether it matched.
 *
 * Nothing here ever mutates Phase 5D/5F Jev evidence, the Phase 5H canonical
 * feature artifact, or any replication freeze.
 *
 * EVIDENCE PROFILE (Phase 5I.1): every artifact carries the evidence class and
 * flag set of the profile its experiment was created under. The DEFAULT is the
 * frozen development profile, so a run that does not ask for anything else
 * produces byte-identical development artifacts exactly as before; a CLEAN
 * replication session passes the replication profile and nothing else about the
 * artifact changes.
 *
 * PAPER ONLY / DEVELOPMENT OR REPLICATION EVIDENCE ONLY.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import { sanitizeForPublic } from "../../lib/sanitize.mjs";
import { boundedProviderAttempts } from "../transport.mjs";
import { DEVELOPMENT_EVIDENCE_PROFILE, evidenceProfileById, evidenceProfileForClass } from "./evidence.mjs";
import { packetDigestOf } from "./packet.mjs";
import {
  DIRECTION_ROUTING_FLAGS,
  EXECUTED_ACTION_IN_5I_0B,
  MODEL_INTENT_DEFINITION,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
  OVERRIDE_REASON_IN_5I_0B,
  TARGET_AT_BASIS,
  DIRECTION_EXPERIMENT_FILE,
  DIRECTION_EXPERIMENTS_DIR,
  DIRECTION_OUTCOMES_DIR,
  DIRECTION_PHASE,
  DIRECTION_PREDICTIONS_DIR,
  DIRECTION_PROGRESS_FILE,
  DIRECTION_ROOT_DIR,
  DIRECTION_SCHEMA_VERSION,
  DIRECTION_SUMMARY_FILE,
} from "./definition.mjs";

export const DIRECTION_STORAGE_VERSION = 1;

/**
 * Resolve an evidence profile argument. `null`/`undefined` means the frozen
 * development profile (the historical default, so nothing changes for a run
 * that never mentions replication). Any unrecognised value THROWS: an artifact
 * must never be written under a guessed evidence class.
 */
export function resolveEvidenceProfile(evidenceProfile) {
  if (evidenceProfile === null || evidenceProfile === undefined) return DEVELOPMENT_EVIDENCE_PROFILE;
  if (typeof evidenceProfile === "string") {
    const byId = evidenceProfileById(evidenceProfile);
    if (byId !== null) return byId;
    throw new Error(`unknown Phase 5I evidence profile '${evidenceProfile}'`);
  }
  if (typeof evidenceProfile === "object" && typeof evidenceProfile.evidenceClass === "string") {
    const resolved = evidenceProfileForClass(evidenceProfile.evidenceClass);
    if (resolved !== null) return resolved;
    throw new Error(`unknown Phase 5I evidence class '${evidenceProfile.evidenceClass}'`);
  }
  throw new Error("unresolvable Phase 5I evidence profile");
}

/** Thrown when something tries to rewrite an already-frozen artifact. */
export class ImmutableArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImmutableArtifactError";
    this.code = "IMMUTABLE_ARTIFACT";
  }
}

/** Compact UTC stamp, matching the Arena/research experiment id convention. */
export function compactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Deterministic, filesystem-safe experiment id. Distinct `jdir-` prefix. */
export function directionExperimentIdFor({ marketId = "SOL-USDC", startedAt = Date.now(), salt = "" } = {}) {
  const stamp = compactStamp(startedAt);
  const suffix = digestOf({ phase: DIRECTION_PHASE, marketId, salt }).slice(0, 6);
  return `jdir-${stamp}-${suffix}`;
}

export function isValidDirectionExperimentId(experimentId) {
  return typeof experimentId === "string" && /^jdir-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(experimentId);
}

/** Resolve an experiment's isolated root. Never resolves outside `.evolve/jev-direction/experiments/`. */
export function directionExperimentRootFor(baseRoot, experimentId) {
  if (!isValidDirectionExperimentId(experimentId)) {
    throw new Error(`invalid Phase 5I experiment id '${experimentId}'`);
  }
  return path.join(baseRoot ?? DIRECTION_EXPERIMENTS_DIR, experimentId);
}

/** Deterministic observation id: index-sortable and stable across replays. */
export function directionObservationIdFor({ experimentId, index }) {
  const suffix = digestOf({ experimentId, index }).slice(0, 8);
  return `jdir-obs-${String(Math.max(0, Math.round(index))).padStart(4, "0")}-${suffix}`;
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

async function listJson(dir) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of files) {
    const record = await readJson(path.join(dir, name), null);
    if (record) out.push(record);
  }
  return out;
}

/* ============================================================================
 * Experiment metadata
 * ==========================================================================*/

export function createDirectionExperiment({
  experimentId,
  market,
  provider,
  model,
  upstreamProvider = null,
  gatewayUsed = false,
  horizonSeconds,
  resolutionToleranceMs,
  samplingCadenceMs,
  maxObservations,
  maxRuntimeMinutes,
  questionSetId,
  questionSetVersion,
  questionDigest,
  packetKind = null,
  packetVersion,
  featureDefinitionVersion,
  featureDefinitionDigest,
  baselineDefinitionVersion,
  baselineDefinitionDigest,
  metricDefinitionVersion = null,
  metricDefinitionDigest = null,
  referencePriceDefinitionVersion = null,
  referencePriceDefinitionDigest = null,
  stalenessPolicy = null,
  stalenessPolicyDigest = null,
  outcomeResolutionPolicy = null,
  outcomeResolutionPolicyDigest = null,
  outcomeResolutionPolicyVersion = null,
  unavailableFeatureFamiliesDigest,
  routingFlags = DIRECTION_ROUTING_FLAGS,
  startedAt = Date.now(),
  providerConfigNote = null,
  offlineFixture = false,
  providerImplementation = null,
  observationEndpoints = null,
  evidenceProfile = null,
}) {
  // FAIL CLOSED: an unknown profile is never silently replaced by the default.
  const profile = resolveEvidenceProfile(evidenceProfile);
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    phase: DIRECTION_PHASE,
    experimentId,
    market,
    // ---- reference-price contract (§4) -------------------------------------
    referencePriceDefinitionVersion,
    referencePriceDefinitionDigest,
    provider,
    model,
    upstreamProvider,
    offlineFixture: offlineFixture === true,
    providerImplementation,
    observationEndpoints: Array.isArray(observationEndpoints) ? [...observationEndpoints] : null,
    gatewayUsed: gatewayUsed === true,
    mode: "shadow",
    horizonSeconds,
    resolutionToleranceMs,
    samplingCadenceMs,
    maxObservations,
    maxRuntimeMinutes,
    questionSetId,
    questionSetVersion,
    questionDigest,
    packetKind,
    packetVersion,
    featureDefinitionVersion,
    featureDefinitionDigest,
    baselineDefinitionVersion,
    baselineDefinitionDigest,
    metricDefinitionVersion,
    metricDefinitionDigest,
    // ---- frozen policies, pinned by digest so a change is a NEW experiment --
    stalenessPolicy,
    stalenessPolicyDigest,
    outcomeResolutionPolicy,
    outcomeResolutionPolicyDigest,
    outcomeResolutionPolicyVersion,
    unavailableFeatureFamiliesDigest,
    evidenceClass: profile.evidenceClass,
    evidenceScope: profile.evidenceScope,
    ...profile.flags,
    ...(routingFlags ?? DIRECTION_ROUTING_FLAGS),
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: null,
    status: "RUNNING",
    finalized: false,
    counters: {
      observationsScheduled: 0,
      predictionsFrozen: 0,
      invalidPredictions: 0,
      outcomesResolved: 0,
      ties: 0,
      failedJevObservations: 0,
      latePredictions: 0,
      tamperDetected: 0,
      providerAttempts: 0,
      byStatus: {},
    },
    providerConfigNote,
    note:
      "DIRECTIONAL PREDICTION benchmark. It produces no orders, no P&L, no profitability claim, and gives Jev no " +
      "trading authority. " +
      (profile.id === "replication"
        ? "This is ONE CLEAN Phase 5I.1 replication SESSION of the frozen 5I.0b protocol — replication, not development, " +
          "and still not a wave-level replication result until it is aggregated with the other CLEAN sessions."
        : "This is DEVELOPMENT evidence only; a positive result here is NOT replication."),
  };
}

export async function writeDirectionExperiment(root, experiment) {
  if (!root || !experiment?.experimentId) return null;
  const record = sanitizeForPublic({ ...experiment, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, DIRECTION_EXPERIMENT_FILE), record);
  return record;
}

export async function readDirectionExperiment(root) {
  return readJson(path.join(root ?? "", DIRECTION_EXPERIMENT_FILE), null);
}

export async function listDirectionExperiments(baseRoot = DIRECTION_EXPERIMENTS_DIR) {
  let entries = [];
  try {
    entries = await readdir(baseRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const experiment = await readDirectionExperiment(path.join(baseRoot, entry.name));
    if (experiment) out.push(experiment);
  }
  return out;
}

/** Merge one prediction's status into experiment counters. Pure. */
export function accumulateDirectionCounters(counters, prediction) {
  const next = JSON.parse(JSON.stringify(counters ?? {}));
  next.byStatus = next.byStatus ?? {};
  next.observationsScheduled = (next.observationsScheduled ?? 0) + 1;
  const status = typeof prediction?.status === "string" ? prediction.status : "UNKNOWN";
  next.byStatus[status] = (next.byStatus[status] ?? 0) + 1;
  if (prediction?.invalid === true) next.invalidPredictions = (next.invalidPredictions ?? 0) + 1;
  else next.predictionsFrozen = (next.predictionsFrozen ?? 0) + 1;
  if (status !== "JEV_OK") next.failedJevObservations = (next.failedJevObservations ?? 0) + 1;
  if (prediction?.invalidReason === "late_prediction") next.latePredictions = (next.latePredictions ?? 0) + 1;
  next.providerAttempts = (next.providerAttempts ?? 0) + (prediction?.providerAttemptCount ?? 0);
  return next;
}

/** Merge one resolved outcome into experiment counters. Pure. */
export function accumulateDirectionOutcomeCounters(counters, outcome) {
  const next = JSON.parse(JSON.stringify(counters ?? {}));
  next.outcomesResolved = (next.outcomesResolved ?? 0) + 1;
  if (outcome?.actualOutcome === "TIE") next.ties = (next.ties ?? 0) + 1;
  if (outcome?.tamperDetected === true) next.tamperDetected = (next.tamperDetected ?? 0) + 1;
  return next;
}

/* ============================================================================
 * Prediction artifacts (immutable, frozen BEFORE the outcome exists)
 * ==========================================================================*/

/** Fields excluded from the prediction digest (the digest itself + prose). */
export const PREDICTION_DIGEST_EXCLUDED_FIELDS = Object.freeze(["predictionDigest", "note"]);

export function predictionDigestOf(record) {
  if (!record || typeof record !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(record)) {
    if (PREDICTION_DIGEST_EXCLUDED_FIELDS.includes(key)) continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

/** Attach the self-describing digest to a prediction record. */
export function withPredictionDigest(record) {
  const next = { ...record, predictionDigest: predictionDigestOf(record) };
  return next;
}

/**
 * Build a prediction-stage artifact.
 *
 * NOTE ON FAILED/INVALID OBSERVATIONS: every SCHEDULED observation produces
 * exactly one artifact in this directory — either a real frozen prediction, or an
 * explicitly invalid attempt (market state unavailable, Jev failure, late
 * prediction). Nothing is ever silently dropped, and a failed Jev call is
 * preserved as a failed observation rather than retried into a nicer-looking one.
 */
export function buildDirectionPredictionRecord({
  observationId,
  experimentId,
  observationIndex,
  scheduledAt,
  sourceEventAt = null,
  receivedAt = null,
  stateObservedAt = null,
  stateFrozenAt = null,
  stateAge = null,
  targetAt = null,
  targetAtBasis = null,
  predictionStartedAt = null,
  predictionCompletedAt = null,
  predictionFinalizedAt = null,
  latencyMs = null,
  status,
  reason = null,
  invalid = false,
  invalidReason = null,
  scorable = false,
  provider = null,
  model = null,
  upstreamProvider = null,
  gatewayUsed = false,
  questionSetId,
  questionSetVersion,
  questionDigest,
  packetVersion,
  packetKind,
  packet = null,
  stateDigest = null,
  requestId = null,
  jevCallAttempted = false,
  pHigher = null,
  pLower = null,
  answer = null,
  modelIntent = null,
  baselines = null,
  baselineDefinitionVersion,
  baselineDefinitionDigest,
  featureDefinitionVersion,
  featureDefinitionDigest,
  featureValues = null,
  preOutcomeInputs = null,
  preOutcomeInputDigest = null,
  warmup = null,
  regime = null,
  providerAttempts = null,
  providerAttemptCount = null,
  referencePrice = null,
  quoteObservedPrice = null,
  cacheHit = false,
  evidenceProfile = null,
}) {
  const profile = resolveEvidenceProfile(evidenceProfile);
  const attempts = Array.isArray(providerAttempts) ? boundedProviderAttempts(providerAttempts) : null;
  const record = {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    phase: DIRECTION_PHASE,
    artifactKind: "DIRECTION_PREDICTION",
    evidenceClass: profile.evidenceClass,
    evidenceScope: profile.evidenceScope,
    ...profile.flags,
    ...DIRECTION_ROUTING_FLAGS,
    observationId,
    experimentId,
    observationIndex,
    marketId: "SOL-USDC",
    scheduledAt,
    // ---- multi-timestamp provenance (§25): every instant stays separate ----
    sourceEventAt,
    receivedAt,
    stateObservedAt,
    stateFrozenAt,
    stateAge,
    targetAt,
    targetAtBasis,
    predictionStartedAt,
    predictionCompletedAt,
    predictionFinalizedAt,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    status: status ?? "UNKNOWN",
    reason,
    invalid: invalid === true,
    invalidReason: invalidReason ?? null,
    scorable: scorable === true,
    provider,
    model,
    upstreamProvider,
    gatewayUsed: gatewayUsed === true,
    questionSetId,
    questionSetVersion,
    questionDigest,
    packetVersion,
    packetKind,
    // The FULL frozen packet is persisted, not merely its digest: without the
    // bytes, an offline replay could not re-verify the state digest, the packet
    // whitelist or the baseline fairness claim.
    packet,
    // The ONLY packet digest in 5I is `packetDigestOf` (canonical content digest
    // with the volatile fields stripped). Replay recomputes this exact function,
    // so there is a single hash scheme rather than two competing ones.
    packetDigest: packet ? packetDigestOf(packet) : null,
    stateDigest,
    requestId,
    // Whether a model call was attempted at all. An observation refused BEFORE
    // asking Jev (unobservable or stale state) is honestly recorded as such, so
    // "failed Jev" and "never asked" stay distinguishable.
    jevCallAttempted: jevCallAttempted === true,
    // RAW model output stays primary (§29): probability first, class never a substitute.
    pHigher: Number.isFinite(pHigher) ? pHigher : null,
    pLower: Number.isFinite(pLower) ? pLower : null,
    modelProbabilityHigher: Number.isFinite(pHigher) ? pHigher : null,
    modelProbabilityLower: Number.isFinite(pLower) ? pLower : null,
    // Model intent is a recorded lean, NOT an action, and is never overwritten (§28).
    modelIntent,
    modelIntentDefinition: MODEL_INTENT_DEFINITION,
    executedAction: EXECUTED_ACTION_IN_5I_0B,
    overrideReason: OVERRIDE_REASON_IN_5I_0B,
    answer,
    baselines,
    baselineDefinitionVersion,
    baselineDefinitionDigest,
    featureDefinitionVersion,
    featureDefinitionDigest,
    featureValues,
    // The EXACT frozen input projection every feature and baseline is a pure
    // function of, persisted so the lookahead audit can recompute it offline.
    preOutcomeInputs,
    preOutcomeInputDigest,
    warmup,
    regime,
    referencePrice,
    quoteObservedPrice,
    providerAttemptCount: attempts ? attempts.length : Number.isFinite(providerAttemptCount) ? providerAttemptCount : 0,
    providerAttempts: attempts,
    cacheHit: cacheHit === true,
    routingFlags: { ...DIRECTION_ROUTING_FLAGS },
    immutable: true,
    note:
      "Frozen BEFORE any outcome existed. This artifact must never be rewritten; outcome resolution verifies its " +
      "digest and FAILS CLOSED if it changed.",
  };
  return record;
}

/** Write a prediction exactly once. Idempotent for byte-identical content; otherwise refuses. */
export async function writeDirectionPrediction(root, prediction) {
  if (!root || !prediction?.observationId) return null;
  if (!prediction.predictionDigest) throw new ImmutableArtifactError("refusing to write a prediction without a digest");
  const target = path.join(root, DIRECTION_PREDICTIONS_DIR, `${prediction.observationId}.json`);
  const existing = await readJson(target, null);
  if (existing) {
    if (existing.predictionDigest === prediction.predictionDigest) return existing;
    throw new ImmutableArtifactError(
      `refusing to overwrite the frozen prediction ${prediction.observationId} ` +
        `(existing ${String(existing.predictionDigest).slice(0, 12)} != new ${String(prediction.predictionDigest).slice(0, 12)})`,
    );
  }
  await writeJsonAtomic(target, prediction);
  return prediction;
}

export async function readDirectionPrediction(root, observationId) {
  return readJson(path.join(root ?? "", DIRECTION_PREDICTIONS_DIR, `${observationId}.json`), null);
}

export async function listDirectionPredictions(root) {
  return listJson(path.join(root ?? "", DIRECTION_PREDICTIONS_DIR));
}

/* ============================================================================
 * Outcome artifacts (immutable, written AFTER targetAt only)
 * ==========================================================================*/

export const OUTCOME_DIGEST_EXCLUDED_FIELDS = Object.freeze(["outcomeDigest", "note"]);

export function outcomeDigestOf(record) {
  if (!record || typeof record !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(record)) {
    if (OUTCOME_DIGEST_EXCLUDED_FIELDS.includes(key)) continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

export function withOutcomeDigest(record) {
  return { ...record, outcomeDigest: outcomeDigestOf(record) };
}

export function buildDirectionOutcomeRecord({
  observationId,
  experimentId,
  observationIndex,
  stateObservedAt,
  stateFrozenAt = null,
  targetAt,
  horizonSeconds,
  predictionCompletedAt = null,
  predictionFinalizedAt = null,
  outcomeResolutionStartedAt = null,
  outcomeSourceEventAt = null,
  outcomeReceivedAt = null,
  outcomeObservedAt = null,
  predictionDigestBeforeOutcome = null,
  verifiedPredictionDigest = null,
  achievedHorizonMs = null,
  resolutionLagMs = null,
  outcomeOffsetMs = null,
  currentReferencePrice = null,
  futureReferencePrice = null,
  actualOutcome = null,
  scorable = false,
  invalidReason = null,
  unavailableDetail = null,
  tamperDetected = false,
  resolvedAt = Date.now(),
  outcomeResolutionPolicy = DEFAULT_OUTCOME_RESOLUTION_POLICY,
  evidenceProfile = null,
}) {
  const profile = resolveEvidenceProfile(evidenceProfile);
  const record = {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    phase: DIRECTION_PHASE,
    artifactKind: "DIRECTION_OUTCOME",
    evidenceClass: profile.evidenceClass,
    evidenceScope: profile.evidenceScope,
    ...profile.flags,
    observationId,
    experimentId,
    observationIndex,
    marketId: "SOL-USDC",
    // ---- multi-timestamp provenance (§25) ----------------------------------
    stateObservedAt,
    stateFrozenAt,
    targetAt,
    targetAtBasis: TARGET_AT_BASIS,
    horizonSeconds,
    predictionCompletedAt,
    predictionFinalizedAt,
    outcomeResolutionStartedAt,
    outcomeSourceEventAt,
    outcomeReceivedAt,
    outcomeObservedAt,
    predictionBeforeTarget:
      predictionCompletedAt !== null && targetAt !== null
        ? Date.parse(predictionCompletedAt) < Date.parse(targetAt)
        : null,
    // The resolver may never run before the prediction artifact was finalized (§27).
    predictionFinalizedBeforeResolution:
      predictionFinalizedAt !== null && outcomeResolutionStartedAt !== null
        ? Date.parse(predictionFinalizedAt) <= Date.parse(outcomeResolutionStartedAt)
        : null,
    predictionDigestBeforeOutcome,
    verifiedPredictionDigest,
    predictionDigestMatches:
      predictionDigestBeforeOutcome !== null && verifiedPredictionDigest !== null
        ? predictionDigestBeforeOutcome === verifiedPredictionDigest
        : null,
    achievedHorizonMs: Number.isFinite(achievedHorizonMs) ? achievedHorizonMs : null,
    resolutionLagMs: Number.isFinite(resolutionLagMs) ? resolutionLagMs : null,
    resolutionLagBasis: "outcomeReceivedAt - targetAt",
    currentReferencePrice: Number.isFinite(currentReferencePrice) ? currentReferencePrice : null,
    futureReferencePrice: Number.isFinite(futureReferencePrice) ? futureReferencePrice : null,
    actualOutcome,
    scorable: scorable === true,
    scoringExclusionReason:
      actualOutcome === "TIE" && invalidReason === null ? "tie_not_binary" : null,
    invalidReason: invalidReason ?? null,
    unavailableDetail: unavailableDetail ?? null,
    // §24: the timing distance from target is persisted, never hidden.
    outcomeOffsetMs: Number.isFinite(outcomeOffsetMs) ? outcomeOffsetMs : Number.isFinite(resolutionLagMs) ? resolutionLagMs : null,
    tamperDetected: tamperDetected === true,
    outcomeResolutionPolicy,
    ...DIRECTION_ROUTING_FLAGS,
    resolveNote:
      "Outcome resolution NEVER rebuilds or modifies the Jev input. The prediction artifact was frozen first and its " +
      "digest was verified here; a mismatch fails closed with no scoring.",
    resolvedAt: new Date(resolvedAt).toISOString(),
    immutable: true,
  };
  return record;
}

export async function writeDirectionOutcome(root, outcome) {
  if (!root || !outcome?.observationId) return null;
  if (!outcome.outcomeDigest) throw new ImmutableArtifactError("refusing to write an outcome without a digest");
  const target = path.join(root, DIRECTION_OUTCOMES_DIR, `${outcome.observationId}.json`);
  const existing = await readJson(target, null);
  if (existing) {
    if (existing.outcomeDigest === outcome.outcomeDigest) return existing;
    throw new ImmutableArtifactError(
      `refusing to overwrite the frozen outcome ${outcome.observationId} ` +
        `(existing ${String(existing.outcomeDigest).slice(0, 12)} != new ${String(outcome.outcomeDigest).slice(0, 12)})`,
    );
  }
  await writeJsonAtomic(target, outcome);
  return outcome;
}

export async function readDirectionOutcome(root, observationId) {
  return readJson(path.join(root ?? "", DIRECTION_OUTCOMES_DIR, `${observationId}.json`), null);
}

export async function listDirectionOutcomes(root) {
  return listJson(path.join(root ?? "", DIRECTION_OUTCOMES_DIR));
}

/* ============================================================================
 * Summary + progress
 * ==========================================================================*/

export async function writeDirectionSummary(root, summary) {
  if (!root) return null;
  const record = sanitizeForPublic({ ...summary, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, DIRECTION_SUMMARY_FILE), record);
  return record;
}

export async function readDirectionSummary(root) {
  return readJson(path.join(root ?? "", DIRECTION_SUMMARY_FILE), null);
}

export async function writeDirectionProgress(root, progress) {
  if (!root) return null;
  await writeJsonAtomic(path.join(root, DIRECTION_PROGRESS_FILE), progress);
  return progress;
}

export async function readDirectionProgress(root) {
  return readJson(path.join(root ?? "", DIRECTION_PROGRESS_FILE), null);
}

/** Read an entire experiment bundle. Read-only; never repairs or rewrites anything. */
export async function readDirectionExperimentBundle(root) {
  const [experiment, predictions, outcomes, summary, progress] = await Promise.all([
    readDirectionExperiment(root),
    listDirectionPredictions(root),
    listDirectionOutcomes(root),
    readDirectionSummary(root),
    readDirectionProgress(root),
  ]);
  return { experiment, predictions, outcomes, summary, progress };
}

/**
 * Byte-level metadata snapshot used to prove a replay/validator rewrote nothing.
 * (Same idea as the Phase 5H canonical barrier snapshot.)
 */
export async function directionMetadataSnapshot(root) {
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
      const content = await readFile(absolute, "utf8");
      out.push({ path: rel, bytes: content.length, digest: digestOf(content) });
    }
  };
  await walk(root, "");
  return out;
}

export const DIRECTION_STORAGE_PATHS = Object.freeze({
  root: DIRECTION_ROOT_DIR,
  experiments: DIRECTION_EXPERIMENTS_DIR,
});
