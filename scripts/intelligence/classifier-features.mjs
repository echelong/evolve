/**
 * Phase 5H.0 — DETERMINISTIC classifier-derived feature extraction (PAPER ONLY, DESCRIPTIVE).
 *
 *   frozen 5G.1 cohort → verify cohort → verify classifier experiments
 *     → verify source captures → classifier-feature-definition-v1
 *     → record-level deterministic extraction → classifier-feature artifact
 *     → offline replay / audit / stats → STOP
 *
 * This module is strictly OFFLINE and DETERMINISTIC. It reads ONE frozen
 * `clcohort-*` (and the frozen classifier experiments + source captures that
 * cohort references) from disk, reconstructs the aggregation RECORD BY RECORD
 * and derives the 19 frozen numeric features. It NEVER calls classifier.dev,
 * Agent-Reach, Jev, DeepSeek or the Arena, performs ZERO network calls, never
 * reclassifies, and never averages experiment summaries: pooling is
 * record-weighted by construction.
 *
 * The derived features are DESCRIPTIVE ONLY. They are NOT alpha, signal
 * strength, sentiment, trading direction, project quality, legitimacy, fraud
 * probability, profitability, expected return, market health or buy/sell
 * probability, and they have no authority over the Arena, evolution, gates,
 * replication or deployment.
 *
 * There is NO routing from 5H.0:
 *
 *   jevRoutingActive: false · deepseekRoutingActive: false
 *   arenaRoutingActive: false · tradingRoutingActive: false
 *
 * `0` NEVER stands for unknown: unavailable derived quantities are `null`.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import {
  CLASSIFIER_DEFINITION_DIGEST,
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
} from "./classifier-definition.mjs";
import {
  auditArtifactTextFree,
  CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID,
  collectCohortEvidence,
  FORBIDDEN_METRIC_KEYS,
  meanOf,
  quantile,
  readCohort,
  round6,
  verifyCohort,
} from "./classifier-evaluation.mjs";
import {
  assertOutsideCaptureRoot,
  CLASSIFIER_EXPERIMENT_FILE,
  classifierExperimentDir,
  experimentDigestOf,
} from "./classifier-experiment.mjs";
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  DERIVED_EVIDENCE_CLASS,
  FEATURE_ALIASES,
  FEATURE_DEFINITION_DIGEST,
  FEATURE_DEFINITION_VERSION,
  FEATURE_NAMES,
  FEATURE_PHASE,
  FEATURE_SCHEMA_VERSION,
  FORBIDDEN_GROUP_FEATURE_KEYS,
  MARGIN_AMBIGUOUS,
  SOURCE_EVIDENCE_CLASS,
  assertFeatureDefinitionIntegrity,
  FeatureEvidenceClassError,
  isForbiddenFeatureName,
  labelFeatureName,
  mapEvidenceClass,
} from "./classifier-feature-definition.mjs";
import { readCaptureManifest } from "./capture.mjs";

export const CLASSIFIER_FEATURES_PHASE = FEATURE_PHASE;
export const CLASSIFIER_FEATURE_SCHEMA_VERSION = FEATURE_SCHEMA_VERSION;

/** Default classifier root (gitignored like every `.evolve/` artifact). */
export const CLASSIFIER_DIR = path.join(".evolve", "classifier");
export const CLASSIFIER_FEATURES_SUBDIR = "features";
export const FEATURE_FILE = "feature.json";

export const AGGREGATION_MODE = "record-weighted";
export const AGGREGATION_UNIT = "cohort";

/** The EXACT top-level keys of a feature artifact, in the frozen order. Nothing else is ever written. */
export const FEATURE_ARTIFACT_FIELDS = Object.freeze([
  "schemaVersion",
  "phase",
  "featureId",
  "featureDefinitionVersion",
  "featureDefinitionDigest",
  "evidenceClass",
  "sourceEvidenceClass",
  "classifierId",
  "classifierVersion",
  "classifierDefinitionDigest",
  "instructionsDigest",
  "inputProjectionVersion",
  "cohortId",
  "cohortDigest",
  "experimentCount",
  "captureCount",
  "experimentIds",
  "sourceCaptureIds",
  "experimentDigests",
  "resultDigests",
  "captureManifestDigests",
  "recordsDigests",
  "experimentRecordCounts",
  "infrastructureExperimentPresent",
  "recordCount",
  "classifiedCount",
  "skippedEmptyCount",
  "distinctRecordDigestCount",
  "duplicateRecordDigestCount",
  "scoreVectorCompleteCount",
  "scoreVectorIncompleteCount",
  "nullFeatureCount",
  "counts",
  "features",
  "aggregation",
  "timeline",
  "routing",
  "immutable",
  "finalized",
  "descriptiveOnly",
  "developmentOnly",
  "noGroundTruth",
  "noProfitabilityInference",
  "createdAt",
  "featureDigest",
  "note",
]);

/** Folders that would signal an (unsupported) grouped-semantic artifact shape. */
const GROUP_CONTAINER_KEYS = Object.freeze(["groups", "featureGroups", "groupFeatures", "aggregates", "featureAggregates"]);

export const FEATURE_NOTE =
  "Frozen, DETERMINISTIC, DESCRIPTIVE features derived record-by-record from ONE already-frozen DEVELOPMENT classifier cohort. " +
  "No ground truth, no profitability or predictive inference, no automated verdict, no ranking and no raw source text. " +
  "DEVELOPMENT-only: a future clean validation requires entirely new evidence.";

export const FEATURE_ROUTING_NOTE =
  "Phase 5H.0 activates NOTHING. No Jev packet, no DeepSeek request, no Arena input and no trading signal: " +
  "all four routing flags are permanently false in this phase.";

export const FEATURE_TIMELINE_NOTE =
  "evidenceAsOf is the LATER of the latest source-capture time and the latest classifier-experiment creation time. " +
  "featureCreatedAt is never earlier (no backdating, no retrospective injection).";

/* ============================================================================
 * Errors
 * ==========================================================================*/

export class FeatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeatureError";
  }
}

export class FeatureNoEvidenceError extends FeatureError {
  constructor(context = null) {
    super(
      "classifiedCount is 0 — there is NO classifier evidence to derive features from. " +
        "Phase 5H.0 never invents evidence and never writes an empty artifact." +
        (context === null ? "" : ` (${context})`),
    );
    this.name = "FeatureNoEvidenceError";
  }
}

export class FeatureExistsError extends FeatureError {
  constructor(featureId) {
    super(`feature artifact '${featureId}' already exists — feature artifacts are IMMUTABLE and are never overwritten`);
    this.name = "FeatureExistsError";
    this.featureId = featureId;
  }
}

export class FeatureNotFoundError extends FeatureError {
  constructor(featureId) {
    super(`feature artifact '${featureId}' was not found`);
    this.name = "FeatureNotFoundError";
    this.featureId = featureId;
  }
}

export class FeatureTimelineError extends FeatureError {
  constructor(featureCreatedAt, evidenceAsOf) {
    super(
      `featureCreatedAt (${featureCreatedAt}) is EARLIER than evidenceAsOf (${evidenceAsOf}) — refusing to backdate a feature artifact`,
    );
    this.name = "FeatureTimelineError";
    this.featureCreatedAt = featureCreatedAt;
    this.evidenceAsOf = evidenceAsOf;
  }
}

export class FeatureIntegrityError extends FeatureError {
  constructor(message) {
    super(message);
    this.name = "FeatureIntegrityError";
  }
}

export class FeatureRecordIntegrityError extends FeatureIntegrityError {
  constructor(message) {
    super(message);
    this.name = "FeatureRecordIntegrityError";
  }
}

export class FeatureClassifierIdentityError extends FeatureIntegrityError {
  constructor(message) {
    super(message);
    this.name = "FeatureClassifierIdentityError";
  }
}

export class FeatureMixedEvidenceError extends FeatureIntegrityError {
  constructor(message) {
    super(message);
    this.name = "FeatureMixedEvidenceError";
  }
}

export class FeatureOutputRootError extends FeatureError {
  constructor(message) {
    super(message);
    this.name = "FeatureOutputRootError";
  }
}

export class FeatureArtifactAuditError extends FeatureError {
  constructor(problems) {
    super(`the feature artifact failed its own audit: ${problems.join(" | ")}`);
    this.name = "FeatureArtifactAuditError";
    this.problems = problems;
  }
}

export { FeatureEvidenceClassError };

/* ============================================================================
 * Identity + digests
 * ==========================================================================*/

export function isValidFeatureId(featureId) {
  return typeof featureId === "string" && /^clfeat-[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(featureId);
}

/** `clfeat-<UTC stamp>-<8 hex of identityDigest>` — deterministic given the clock and the digest. */
export function buildFeatureId({ now, identityDigest }) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `clfeat-${stamp}-${String(identityDigest).slice(0, 8)}`;
}

export function featureDirFor(classifierRoot, featureId) {
  if (!isValidFeatureId(featureId)) throw new FeatureError(`invalid feature id '${featureId}'`);
  return path.join(classifierRoot, CLASSIFIER_FEATURES_SUBDIR, featureId);
}

export function featurePathFor(classifierRoot, featureId) {
  return path.join(featureDirFor(classifierRoot, featureId), FEATURE_FILE);
}

/** Identity subject: everything EXCEPT the derived `featureId` and the `featureDigest`. */
export function featureIdentitySubject(feature) {
  const subject = { ...(feature ?? {}) };
  delete subject.featureId;
  delete subject.featureDigest;
  return subject;
}

export function featureIdentityDigest(feature) {
  return digestOf(featureIdentitySubject(feature));
}

/** Digest subject: everything EXCEPT `featureDigest` (so `featureId` IS covered). */
export function featureDigestSubject(feature) {
  const subject = { ...(feature ?? {}) };
  delete subject.featureDigest;
  return subject;
}

export function featureDigestOf(feature) {
  return digestOf(featureDigestSubject(feature));
}

/** Rebuild the artifact in the frozen field order (the whitelist AND the file layout). */
function orderFeatureArtifact(source) {
  const ordered = {};
  for (const field of FEATURE_ARTIFACT_FIELDS) ordered[field] = source[field];
  return ordered;
}

/* ============================================================================
 * Deterministic numeric helpers
 * ==========================================================================*/

function sortedAscending(values) {
  return [...values].sort((a, b) => a - b);
}

/**
 * The top-1/top-2 margin of a COMPLETE score vector, or `null` when the vector
 * is incomplete. A missing label or a `null` score means "unavailable" (excluded
 * from the margin denominator only); a present value outside [0, 1] is an
 * integrity error and is NEVER silently skipped or coerced to zero.
 */
function completeScoreMargin(scores, index) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return null;
  const values = [];
  for (const label of CLASSIFIER_LABELS) {
    if (!Object.hasOwn(scores, label)) return null;
    const value = scores[label];
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new FeatureRecordIntegrityError(`record ${index} score '${label}' is not a finite number in [0, 1]`);
    }
    values.push(value);
  }
  // Ranked top-2 with ties resolved by frozen taxonomy order (deterministic).
  const ranked = values
    .map((value, position) => ({ value, position }))
    .sort((a, b) => b.value - a.value || a.position - b.position);
  return ranked[0].value - ranked[1].value;
}

/** Normalized Shannon entropy over the ENTIRE frozen taxonomy (K = 9, natural log). */
export function labelEntropyNormalized(labelCounts, total) {
  let entropy = 0;
  for (const label of CLASSIFIER_LABELS) {
    const count = labelCounts[label] ?? 0;
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log(p);
    }
  }
  return entropy / Math.log(CLASSIFIER_LABELS.length);
}

/* ============================================================================
 * Deterministic feature extraction (record-level, pure)
 * ==========================================================================*/

/**
 * Derive the EXACTLY 19 canonical features from pooled classified records.
 *
 * @param {{ records?: Array<{ label: string, confidence: number, scores: object }>, context?: string|null }} options
 * @returns {{
 *   features: object, labelCounts: object, largestLabel: string, largestLabelCount: number,
 *   classifiedCount: number, scoreVectorCompleteCount: number, scoreVectorIncompleteCount: number,
 *   nullFeatureCount: number,
 * }}
 */
export function extractClassifierFeatures({ records, context = null } = {}) {
  const rows = Array.isArray(records) ? records : [];
  if (rows.length === 0) throw new FeatureNoEvidenceError(context);
  const total = rows.length;

  const labelCounts = Object.fromEntries(CLASSIFIER_LABELS.map((label) => [label, 0]));
  const confidences = [];
  const margins = [];
  let scoreVectorCompleteCount = 0;

  rows.forEach((row, index) => {
    const label = row?.label;
    if (typeof label !== "string" || !Object.hasOwn(labelCounts, label)) {
      throw new FeatureRecordIntegrityError(`record ${index} carries label '${String(label)}', which is outside the frozen taxonomy`);
    }
    labelCounts[label] += 1;

    const confidence = row?.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new FeatureRecordIntegrityError(`record ${index} confidence is not a finite number in [0, 1] — refusing rather than skipping it`);
    }
    confidences.push(confidence);

    const margin = completeScoreMargin(row?.scores, index);
    if (margin !== null) {
      scoreVectorCompleteCount += 1;
      margins.push(round6(margin));
    }
  });

  const scoreVectorIncompleteCount = total - scoreVectorCompleteCount;
  const sortedConfidences = sortedAscending(confidences);
  const sortedMargins = sortedAscending(margins);

  let observedLabelCount = 0;
  let largestLabel = CLASSIFIER_LABELS[0];
  let largestLabelCount = -1;
  for (const label of CLASSIFIER_LABELS) {
    if (labelCounts[label] > 0) observedLabelCount += 1;
    // Ties are resolved using the frozen taxonomy order.
    if (labelCounts[label] > largestLabelCount) {
      largestLabelCount = labelCounts[label];
      largestLabel = label;
    }
  }

  const features = {};
  // 1-9. Label fractions: a label with zero observations is a TRUE ZERO, never missingness.
  for (const label of CLASSIFIER_LABELS) features[labelFeatureName(label)] = round6(labelCounts[label] / total);
  // 10. A count, not a fraction (observed_label_fraction would be redundant).
  features.observed_label_count = observedLabelCount;
  // 11. Normalized label entropy (K = 9). A single observed label is exactly 0.
  features.label_entropy_normalized = round6(labelEntropyNormalized(labelCounts, total));
  // 12. Largest-label concentration.
  features.largest_label_fraction = round6(largestLabelCount / total);
  // 13-16. Confidence features. `0.50` is NOT low; `0.90` IS high.
  features.confidence_mean = round6(meanOf(confidences));
  features.confidence_median = round6(quantile(sortedConfidences, 0.5));
  features.confidence_low_fraction = round6(confidences.filter((value) => value < CONFIDENCE_LOW.threshold).length / total);
  features.confidence_high_fraction = round6(confidences.filter((value) => value >= CONFIDENCE_HIGH.threshold).length / total);
  // 17-19. Score-margin features over COMPLETE score vectors only. No complete
  // vector ⇒ `null` (never 0): the quantity is unavailable, not zero.
  features.score_margin_mean = margins.length === 0 ? null : round6(meanOf(margins));
  features.score_margin_median = margins.length === 0 ? null : round6(quantile(sortedMargins, 0.5));
  features.score_margin_ambiguous_fraction =
    margins.length === 0 ? null : round6(margins.filter((value) => value < MARGIN_AMBIGUOUS.threshold).length / margins.length);

  const ordered = {};
  for (const name of FEATURE_NAMES) ordered[name] = features[name];
  const nullFeatureCount = FEATURE_NAMES.filter((name) => ordered[name] === null).length;

  return {
    features: ordered,
    labelCounts: { ...labelCounts },
    largestLabel,
    largestLabelCount,
    classifiedCount: total,
    scoreVectorCompleteCount,
    scoreVectorIncompleteCount,
    nullFeatureCount,
  };
}

/* ============================================================================
 * Evidence loading (offline, zero network)
 * ==========================================================================*/

async function readExperimentHeader(classifierRoot, experimentId) {
  try {
    return JSON.parse(await readFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  } catch (error) {
    throw new FeatureIntegrityError(`classifier experiment '${experimentId}' is unreadable (${error?.message ?? error})`);
  }
}

/** The capture time of a frozen capture: `finalizedAt`, else `endedAt`, else `startedAt`. */
function captureTimeOf(captureId, manifest) {
  const raw = manifest?.finalizedAt ?? manifest?.endedAt ?? manifest?.startedAt ?? null;
  const ms = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) throw new FeatureIntegrityError(`source capture '${captureId}' carries no readable capture timestamp`);
  return new Date(ms).toISOString();
}

function rawTimestampOf(value, what) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new FeatureIntegrityError(`${what} is not a readable timestamp`);
  return new Date(ms).toISOString();
}

async function readSourceCaptureManifests({ captureRoot, cohort }) {
  const manifests = new Map();
  for (const captureId of cohort.sourceCaptureIds) {
    const manifest = await readCaptureManifest(captureRoot, captureId);
    if (!manifest) throw new FeatureIntegrityError(`source capture '${captureId}' is missing — Phase 5H.0 never invents capture evidence`);
    if (manifest.immutable !== true || manifest.finalized !== true) {
      throw new FeatureIntegrityError(`source capture '${captureId}' is not immutable/finalized`);
    }
    manifests.set(captureId, manifest);
  }
  return manifests;
}

/**
 * Verify the classifier identity of every referenced experiment BEFORE any
 * extraction. Mixed classifier versions, mixed input projections and mixed
 * definition/instruction digests are refused, never averaged, never resolved to
 * a "latest" version.
 */
function assertExperimentIdentities(headers) {
  const distinct = (select) => [...new Set(headers.map((header) => select(header.experiment)))];
  const mixed = [
    ["classifierId", "classifier id"],
    ["classifierVersion", "classifier version"],
    ["inputProjectionVersion", "input projection version"],
    ["classifierDefinitionDigest", "classifier definition digest"],
    ["instructionsDigest", "instructions digest"],
  ];
  for (const [key, label] of mixed) {
    const values = distinct((experiment) => experiment?.[key]);
    if (values.length > 1) {
      throw new FeatureMixedEvidenceError(
        `the cohort references MULTIPLE ${label}s (${values.map((value) => JSON.stringify(value)).join(", ")}) — refusing to mix evidence`,
      );
    }
  }

  for (const { experimentId, experiment } of headers) {
    if (experiment?.experimentId !== experimentId) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' declares experimentId '${String(experiment?.experimentId)}'`);
    }
    if (experiment?.classifierId !== CLASSIFIER_ID) {
      throw new FeatureClassifierIdentityError(`classifier experiment '${experimentId}' uses classifier '${String(experiment?.classifierId)}', not the frozen '${CLASSIFIER_ID}'`);
    }
    if (experiment?.classifierVersion !== CLASSIFIER_VERSION) {
      throw new FeatureClassifierIdentityError(
        `classifier experiment '${experimentId}' uses version ${String(experiment?.classifierVersion)}, not the frozen version ${CLASSIFIER_VERSION}`,
      );
    }
    if (experiment?.inputProjectionVersion !== INPUT_PROJECTION_VERSION) {
      throw new FeatureClassifierIdentityError(
        `classifier experiment '${experimentId}' uses input projection '${String(experiment?.inputProjectionVersion)}', not the frozen '${INPUT_PROJECTION_VERSION}'`,
      );
    }
    if (experiment?.classifierDefinitionDigest !== CLASSIFIER_DEFINITION_DIGEST) {
      throw new FeatureClassifierIdentityError(`classifier experiment '${experimentId}' does not carry the frozen classifier definition digest`);
    }
    if (experiment?.instructionsDigest !== CLASSIFIER_INSTRUCTIONS_DIGEST) {
      throw new FeatureClassifierIdentityError(`classifier experiment '${experimentId}' does not carry the frozen classifier instructions digest`);
    }
    if (experiment?.immutable !== true || experiment?.finalized !== true) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' is not FINALIZED and IMMUTABLE`);
    }
    if (experimentDigestOf(experiment) !== experiment.experimentDigest) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' does not match its own experiment digest`);
    }
    if (!Number.isInteger(experiment?.classifiedCount) || experiment.classifiedCount < 0) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' carries a non-integer classifiedCount`);
    }
    if (!Number.isInteger(experiment?.recordCount) || experiment.recordCount < 0) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' carries a non-integer recordCount`);
    }
    if (!Number.isInteger(experiment?.skippedEmptyCount) || experiment.skippedEmptyCount < 0) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' carries a non-integer skippedEmptyCount`);
    }
    if (experiment.recordCount !== experiment.classifiedCount + experiment.skippedEmptyCount) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' record/classified/skipped counts are inconsistent`);
    }
    rawTimestampOf(experiment.createdAt, `classifier experiment '${experimentId}' createdAt`);
  }
}

/** The feature output root must be a SEPARATE tree from the capture root. */
function assertFeatureOutputRoot(captureRoot, classifierRoot) {
  try {
    assertOutsideCaptureRoot(captureRoot, classifierRoot);
  } catch (error) {
    throw new FeatureOutputRootError(String(error?.message ?? error));
  }
}

/* ============================================================================
 * Artifact assembly
 * ==========================================================================*/

function computeTimeline({ captureManifests, experiments, createdAt }) {
  const captureTimes = [...captureManifests.keys()].map((captureId) => captureTimeOf(captureId, captureManifests.get(captureId)));
  const experimentTimes = experiments.map(({ experimentId, experiment }) => rawTimestampOf(experiment.createdAt, `classifier experiment '${experimentId}' createdAt`));
  if (captureTimes.length === 0) throw new FeatureIntegrityError("the cohort references no source capture — there is no capture timeline");
  if (experimentTimes.length === 0) throw new FeatureIntegrityError("the cohort references no classifier experiment — there is no experiment timeline");

  const sortedCaptures = sortedAscending(captureTimes.map((value) => Date.parse(value)));
  const sortedExperiments = sortedAscending(experimentTimes.map((value) => Date.parse(value)));
  const earliestCaptureAt = new Date(sortedCaptures[0]).toISOString();
  const latestCaptureAt = new Date(sortedCaptures[sortedCaptures.length - 1]).toISOString();
  const latestExperimentAt = new Date(sortedExperiments[sortedExperiments.length - 1]).toISOString();
  const evidenceAsOf = new Date(Math.max(sortedCaptures[sortedCaptures.length - 1], sortedExperiments[sortedExperiments.length - 1])).toISOString();
  const featureCreatedAt = rawTimestampOf(createdAt, "featureCreatedAt");
  if (Date.parse(featureCreatedAt) < Date.parse(evidenceAsOf)) throw new FeatureTimelineError(featureCreatedAt, evidenceAsOf);

  return { earliestCaptureAt, latestCaptureAt, latestExperimentAt, evidenceAsOf, featureCreatedAt };
}

/**
 * Build the ordered feature artifact body (identity included) from VERIFIED
 * evidence. Pure: no I/O, no clock beyond the supplied `createdAt`.
 */
export function assembleFeatureArtifact({ cohort, evidence, captureManifests, createdAt }) {
  const experiments = Array.isArray(evidence?.experiments) ? evidence.experiments : [];
  const observations = Array.isArray(evidence?.observations) ? evidence.observations : [];

  if (experiments.length !== cohort.experimentIds.length) {
    throw new FeatureIntegrityError("the loaded experiment count differs from the cohort manifest");
  }
  const loadedIds = experiments.map((entry) => entry.experimentId).sort();
  if (loadedIds.join(",") !== [...cohort.experimentIds].sort().join(",")) {
    throw new FeatureIntegrityError("the loaded experiment ids differ from the cohort manifest");
  }

  let recordCount = 0;
  let classifiedCount = 0;
  let skippedEmptyCount = 0;
  const experimentDigests = {};
  const resultDigests = {};
  const experimentRecordCounts = {};
  for (const { experimentId, experiment, records } of experiments) {
    if (!Array.isArray(records) || records.length !== experiment.classifiedCount) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' classified record count is inconsistent`);
    }
    if (cohort.experimentDigests?.[experimentId] !== experiment.experimentDigest) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' no longer matches the cohort manifest experiment digest`);
    }
    if (cohort.resultDigests?.[experimentId] !== experiment.resultDigest) {
      throw new FeatureIntegrityError(`classifier experiment '${experimentId}' no longer matches the cohort manifest result digest`);
    }
    experimentDigests[experimentId] = experiment.experimentDigest;
    resultDigests[experimentId] = experiment.resultDigest;
    experimentRecordCounts[experimentId] = experiment.recordCount;
    recordCount += experiment.recordCount;
    classifiedCount += records.length;
    skippedEmptyCount += experiment.skippedEmptyCount;
  }
  if (recordCount !== classifiedCount + skippedEmptyCount) {
    throw new FeatureIntegrityError("the pooled record/classified/skipped counts are inconsistent");
  }

  const captureManifestDigests = {};
  const recordsDigests = {};
  for (const captureId of cohort.sourceCaptureIds) {
    const manifest = captureManifests.get(captureId);
    if (!manifest) throw new FeatureIntegrityError(`source capture '${captureId}' has no manifest`);
    captureManifestDigests[captureId] = manifest.manifestDigest;
    recordsDigests[captureId] = manifest.digests?.recordsDigest ?? null;
  }

  const extracted = extractClassifierFeatures({ records: observations, context: `cohort '${cohort.cohortId}'` });
  if (extracted.classifiedCount !== classifiedCount) {
    throw new FeatureIntegrityError("the joined observation count differs from the pooled classifiedCount");
  }

  const recordDigests = observations.map((row) => row.recordDigest);
  const distinctRecordDigestCount = new Set(recordDigests).size;
  const duplicateRecordDigestCount = recordDigests.length - distinctRecordDigestCount;

  const timeline = computeTimeline({ captureManifests, experiments, createdAt });

  const body = {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    phase: FEATURE_PHASE,
    featureDefinitionVersion: FEATURE_DEFINITION_VERSION,
    featureDefinitionDigest: FEATURE_DEFINITION_DIGEST,
    evidenceClass: DERIVED_EVIDENCE_CLASS,
    sourceEvidenceClass: SOURCE_EVIDENCE_CLASS,
    classifierId: CLASSIFIER_ID,
    classifierVersion: CLASSIFIER_VERSION,
    classifierDefinitionDigest: CLASSIFIER_DEFINITION_DIGEST,
    instructionsDigest: CLASSIFIER_INSTRUCTIONS_DIGEST,
    inputProjectionVersion: INPUT_PROJECTION_VERSION,
    cohortId: cohort.cohortId,
    cohortDigest: cohort.cohortDigest,
    experimentCount: experiments.length,
    captureCount: cohort.sourceCaptureIds.length,
    experimentIds: [...cohort.experimentIds],
    sourceCaptureIds: [...cohort.sourceCaptureIds],
    experimentDigests,
    resultDigests,
    captureManifestDigests,
    recordsDigests,
    experimentRecordCounts,
    infrastructureExperimentPresent: cohort.experimentIds.includes(CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID),
    recordCount,
    classifiedCount,
    skippedEmptyCount,
    distinctRecordDigestCount,
    duplicateRecordDigestCount,
    scoreVectorCompleteCount: extracted.scoreVectorCompleteCount,
    scoreVectorIncompleteCount: extracted.scoreVectorIncompleteCount,
    nullFeatureCount: extracted.nullFeatureCount,
    counts: {
      labelCounts: extracted.labelCounts,
      largestLabel: extracted.largestLabel,
      largestLabelCount: extracted.largestLabelCount,
    },
    features: extracted.features,
    aggregation: { mode: AGGREGATION_MODE, unit: AGGREGATION_UNIT, experimentsAveraged: false },
    timeline,
    routing: {
      jevRoutingActive: false,
      deepseekRoutingActive: false,
      arenaRoutingActive: false,
      tradingRoutingActive: false,
      note: FEATURE_ROUTING_NOTE,
    },
    immutable: true,
    finalized: true,
    descriptiveOnly: true,
    developmentOnly: true,
    noGroundTruth: true,
    noProfitabilityInference: true,
    createdAt: new Date(Date.parse(timeline.featureCreatedAt)).toISOString(),
    note: FEATURE_NOTE,
  };

  const featureId = buildFeatureId({ now: Date.parse(body.createdAt), identityDigest: featureIdentityDigest(body) });
  const featureDigest = featureDigestOf({ ...body, featureId });
  return orderFeatureArtifact({ ...body, featureId, featureDigest });
}

/* ============================================================================
 * Artifact audit (one function: before write, during replay, in validation)
 * ==========================================================================*/

function arithmeticProblems(feature) {
  const problems = [];
  const counts = feature?.counts ?? {};
  const labelCounts = counts.labelCounts ?? {};
  const features = feature?.features ?? {};
  const classifiedCount = feature?.classifiedCount;

  const labelKeys = Object.keys(labelCounts);
  if (labelKeys.length !== CLASSIFIER_LABELS.length || CLASSIFIER_LABELS.some((label) => !Object.hasOwn(labelCounts, label))) {
    problems.push("counts.labelCounts must contain exactly the nine frozen taxonomy labels");
  }
  if (!labelKeys.every((label) => CLASSIFIER_LABELS.includes(label))) problems.push("counts.labelCounts carries a label outside the frozen taxonomy");

  const labelCountsSum = CLASSIFIER_LABELS.reduce((sum, label) => sum + (Number.isFinite(labelCounts[label]) ? labelCounts[label] : 0), 0);
  if (labelCountsSum !== classifiedCount) problems.push(`Σ labelCounts (${labelCountsSum}) must equal classifiedCount (${classifiedCount})`);

  const fractions = CLASSIFIER_LABELS.map((label) => features[labelFeatureName(label)]);
  if (fractions.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    problems.push("every label fraction must be a finite number in [0, 1]");
  } else {
    const sum = fractions.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 0.0000045) problems.push(`the label fractions must sum to 1 (got ${sum})`);
  }

  const observed = CLASSIFIER_LABELS.filter((label) => labelCounts[label] > 0).length;
  if (features.observed_label_count !== observed) problems.push("observed_label_count must equal the number of labels with a nonzero count");

  const maxCount = Math.max(...CLASSIFIER_LABELS.map((label) => (Number.isFinite(labelCounts[label]) ? labelCounts[label] : 0)));
  if (counts.largestLabelCount !== maxCount) problems.push("counts.largestLabelCount must equal the largest label count");
  if (!CLASSIFIER_LABELS.includes(counts.largestLabel)) problems.push("counts.largestLabel must be a frozen taxonomy label");
  if (Number.isFinite(counts.largestLabelCount) && classifiedCount > 0) {
    const modal = CLASSIFIER_LABELS.find((label) => labelCounts[label] === maxCount);
    if (counts.largestLabel !== modal) problems.push("counts.largestLabel must resolve ties in frozen taxonomy order");
  }
  if (features.largest_label_fraction !== round6(maxCount / classifiedCount)) problems.push("largest_label_fraction must equal the largest label count over classifiedCount");

  const entropy = features.label_entropy_normalized;
  if (typeof entropy !== "number" || !Number.isFinite(entropy) || entropy < 0 || entropy > 1) problems.push("label_entropy_normalized must be a finite number in [0, 1]");
  if (observed === 1 && entropy !== 0) problems.push("a single observed label must yield entropy exactly 0");

  const complete = feature?.scoreVectorCompleteCount;
  const incomplete = feature?.scoreVectorIncompleteCount;
  if (!Number.isInteger(complete) || !Number.isInteger(incomplete) || complete + incomplete !== classifiedCount) {
    problems.push("scoreVectorCompleteCount + scoreVectorIncompleteCount must equal classifiedCount");
  }
  if (feature?.recordCount !== classifiedCount + feature?.skippedEmptyCount) {
    problems.push("recordCount must equal classifiedCount + skippedEmptyCount");
  }
  if (feature?.distinctRecordDigestCount + feature?.duplicateRecordDigestCount !== classifiedCount) {
    problems.push("distinctRecordDigestCount + duplicateRecordDigestCount must equal classifiedCount");
  }

  const actualNulls = FEATURE_NAMES.filter((name) => features[name] === null).length;
  if (feature?.nullFeatureCount !== actualNulls) problems.push("nullFeatureCount must equal the number of null feature values");
  if (complete === 0) {
    for (const name of ["score_margin_mean", "score_margin_median", "score_margin_ambiguous_fraction"]) {
      if (features[name] !== null) problems.push(`${name} must be null when no score vector is complete`);
    }
  }
  if (incomplete === 0 && feature?.nullFeatureCount !== 0) problems.push("nullFeatureCount must be 0 when every score vector is complete");

  if (feature?.aggregation?.mode !== AGGREGATION_MODE) problems.push(`aggregation.mode must be '${AGGREGATION_MODE}'`);
  if (feature?.aggregation?.unit !== AGGREGATION_UNIT) problems.push(`aggregation.unit must be '${AGGREGATION_UNIT}'`);
  if (feature?.aggregation?.experimentsAveraged !== false) problems.push("aggregation.experimentsAveraged must be false");

  return problems;
}

/**
 * Prove a feature artifact is well-formed, numeric-only, text-free, group-free
 * and routing-inactive, and that every arithmetic invariant holds. Returns
 * `{ ok, problems, categories }`; the per-category problems let replay expose
 * named checks without a second audit implementation.
 */
export function auditClassifierFeatureArtifact(feature) {
  const categories = {
    topLevelKeys: [],
    featureKeys: [],
    featureValues: [],
    forbiddenNames: [],
    groupKeys: [],
    textFree: [],
    arithmetic: [],
    routing: [],
    flags: [],
    definitionPin: [],
  };

  const keys = Object.keys(feature ?? {});
  const missing = FEATURE_ARTIFACT_FIELDS.filter((field) => !keys.includes(field));
  const extra = keys.filter((field) => !FEATURE_ARTIFACT_FIELDS.includes(field));
  for (const field of missing) categories.topLevelKeys.push(`missing top-level key '${field}'`);
  for (const field of extra) categories.topLevelKeys.push(`unexpected top-level key '${field}'`);
  for (const field of extra) {
    if (GROUP_CONTAINER_KEYS.includes(field)) categories.groupKeys.push(`grouped-semantic container '${field}' is not allowed in v1`);
  }

  const featureKeys = Object.keys(feature?.features ?? {});
  if (featureKeys.length !== FEATURE_NAMES.length || featureKeys.some((name, index) => name !== FEATURE_NAMES[index])) {
    categories.featureKeys.push("features must deep-equal the 19 canonical feature names in canonical order");
  }
  for (const name of featureKeys) {
    if (!FEATURE_NAMES.includes(name)) {
      if (FORBIDDEN_GROUP_FEATURE_KEYS.includes(name) || name.endsWith("_fraction")) {
        categories.groupKeys.push(`grouped-semantic feature '${name}' is not allowed in v1`);
      }
      if (isForbiddenFeatureName(name)) categories.forbiddenNames.push(`forbidden feature name '${name}'`);
    }
  }
  for (const name of FEATURE_NAMES) {
    if (isForbiddenFeatureName(name)) categories.forbiddenNames.push(`forbidden feature name '${name}'`);
  }
  for (const name of [...keys, ...featureKeys]) {
    if (FORBIDDEN_METRIC_KEYS.includes(name)) categories.forbiddenNames.push(`forbidden sealed 5G.1 metric key '${name}'`);
  }

  for (const name of featureKeys) {
    const value = feature.features[name];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) categories.featureValues.push(`feature '${name}' must be a finite number or null`);
  }

  categories.textFree.push(...auditArtifactTextFree(feature));

  for (const flag of ["immutable", "finalized", "descriptiveOnly", "developmentOnly", "noGroundTruth", "noProfitabilityInference"]) {
    if (feature?.[flag] !== true) categories.flags.push(`'${flag}' must be true`);
  }
  if (feature?.schemaVersion !== FEATURE_SCHEMA_VERSION) categories.definitionPin.push("schemaVersion must be 1");
  if (feature?.phase !== FEATURE_PHASE) categories.definitionPin.push(`phase must be '${FEATURE_PHASE}'`);
  if (feature?.featureDefinitionVersion !== FEATURE_DEFINITION_VERSION) categories.definitionPin.push("featureDefinitionVersion does not match the frozen definition");
  if (feature?.featureDefinitionDigest !== FEATURE_DEFINITION_DIGEST) categories.definitionPin.push("featureDefinitionDigest does not match the frozen definition");
  if (feature?.evidenceClass !== DERIVED_EVIDENCE_CLASS) categories.definitionPin.push(`evidenceClass must be '${DERIVED_EVIDENCE_CLASS}'`);
  if (feature?.sourceEvidenceClass !== SOURCE_EVIDENCE_CLASS) categories.definitionPin.push(`sourceEvidenceClass must be '${SOURCE_EVIDENCE_CLASS}'`);
  if (feature?.classifierId !== CLASSIFIER_ID) categories.definitionPin.push("classifierId does not match the frozen classifier");
  if (feature?.classifierVersion !== CLASSIFIER_VERSION) categories.definitionPin.push("classifierVersion does not match the frozen classifier");
  if (feature?.classifierDefinitionDigest !== CLASSIFIER_DEFINITION_DIGEST) categories.definitionPin.push("classifierDefinitionDigest does not match the frozen classifier");
  if (feature?.instructionsDigest !== CLASSIFIER_INSTRUCTIONS_DIGEST) categories.definitionPin.push("instructionsDigest does not match the frozen classifier");
  if (feature?.inputProjectionVersion !== INPUT_PROJECTION_VERSION) categories.definitionPin.push("inputProjectionVersion does not match the frozen projection");

  const routing = feature?.routing ?? {};
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    if (routing[flag] !== false) categories.routing.push(`routing.${flag} must be strictly false`);
  }

  categories.arithmetic.push(...arithmeticProblems(feature));

  const problems = Object.values(categories).flat();
  return { ok: problems.length === 0, problems, categories };
}

/* ============================================================================
 * Build (write-once) + read
 * ==========================================================================*/

/**
 * Build and (by default) freeze ONE feature artifact for ONE explicit frozen
 * cohort. Offline only: zero network calls, no classification, no routing.
 */
export async function buildClassifierFeature({ classifierRoot, captureRoot, cohortId, now = () => Date.now(), save = true } = {}) {
  const definitionCheck = assertFeatureDefinitionIntegrity();
  if (!definitionCheck.ok) throw new FeatureIntegrityError(`the frozen feature definition is not intact: ${definitionCheck.problems.join(" | ")}`);

  if (typeof cohortId !== "string" || cohortId.trim().length === 0) {
    throw new FeatureError("buildClassifierFeature requires an EXPLICIT cohort id — Phase 5H.0 never searches for the 'latest' cohort");
  }
  if (save) assertFeatureOutputRoot(captureRoot, classifierRoot);

  const cohort = await readCohort(classifierRoot, cohortId);
  if (!cohort) throw new FeatureIntegrityError(`cohort '${cohortId}' does not exist`);
  // The one-entry evidence-class transition is checked FIRST, so an unmapped
  // source evidence class always fails closed with a precise error.
  const derivedEvidenceClass = mapEvidenceClass(cohort.evidenceClass);
  if (derivedEvidenceClass !== DERIVED_EVIDENCE_CLASS) throw new FeatureEvidenceClassError(cohort.evidenceClass);

  const cohortCheck = verifyCohort(cohort);
  if (!cohortCheck.ok) throw new FeatureIntegrityError(`cohort '${cohortId}' failed verification: ${cohortCheck.problems.join(" | ")}`);
  if (cohort.classifierId !== CLASSIFIER_ID || cohort.classifierVersion !== CLASSIFIER_VERSION) {
    throw new FeatureClassifierIdentityError(`cohort '${cohortId}' is not pinned to the frozen classifier`);
  }

  // Fail-fast pre-pass: classifier identity BEFORE any extraction.
  const headers = [];
  for (const experimentId of cohort.experimentIds) {
    headers.push({ experimentId, experiment: await readExperimentHeader(classifierRoot, experimentId) });
  }
  assertExperimentIdentities(headers);

  const captureManifests = await readSourceCaptureManifests({ captureRoot, cohort });

  let declaredClassifiedCount = 0;
  for (const { experiment } of headers) declaredClassifiedCount += experiment.classifiedCount;
  if (declaredClassifiedCount === 0) throw new FeatureNoEvidenceError(`cohort '${cohortId}'`);

  const createdAt = new Date(now()).toISOString();
  // Fail-fast timeline (the artifact timeline is recomputed from VERIFIED evidence).
  computeTimeline({ captureManifests, experiments: headers, createdAt });

  const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
  const feature = assembleFeatureArtifact({ cohort, evidence, captureManifests, createdAt });

  const audit = auditClassifierFeatureArtifact(feature);
  if (!audit.ok) throw new FeatureArtifactAuditError(audit.problems);

  if (!save) return { feature, dir: null, saved: false, evidence, audit };

  const dir = featureDirFor(classifierRoot, feature.featureId);
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if (error?.code === "EEXIST") throw new FeatureExistsError(feature.featureId);
    throw error;
  }
  // Write ONCE. `wx` is the last line of defence: an existing artifact is never overwritten.
  await writeFile(path.join(dir, FEATURE_FILE), `${JSON.stringify(feature, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error?.code === "EEXIST") throw new FeatureExistsError(feature.featureId);
    throw error;
  });
  return { feature, dir, saved: true, evidence, audit };
}

export async function readFeatureArtifact(classifierRoot, featureId) {
  if (!isValidFeatureId(featureId)) throw new FeatureError(`invalid feature id '${featureId}'`);
  try {
    return JSON.parse(await readFile(featurePathFor(classifierRoot, featureId), "utf8"));
  } catch {
    return null;
  }
}

export async function listFeatureArtifacts(classifierRoot) {
  try {
    return (await readdir(path.join(classifierRoot, CLASSIFIER_FEATURES_SUBDIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidFeatureId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function requireFeatureArtifact(classifierRoot, featureId) {
  const feature = await readFeatureArtifact(classifierRoot, featureId);
  if (!feature) throw new FeatureNotFoundError(featureId);
  return feature;
}

/* ============================================================================
 * Replay (offline, zero network, no reclassification, no writes)
 * ==========================================================================*/

/**
 * Re-verify a stored feature artifact OFFLINE: identity, digests, flags,
 * evidence class, cohort/experiment/capture integrity and every feature — then
 * reproduce `featureId` and `featureDigest` from the frozen evidence.
 */
export async function replayClassifierFeature({ classifierRoot, captureRoot, featureId } = {}) {
  const checks = {};
  const problems = [];
  const check = (name, ok, detail = null) => {
    checks[name] = ok === true;
    if (ok !== true) problems.push(detail === null ? name : `${name}: ${detail}`);
  };

  let feature;
  try {
    feature = await readFeatureArtifact(classifierRoot, featureId);
  } catch (error) {
    return { ok: false, featureId, networkCalls: 0, checks: { featureReadable: false }, problems: [`featureReadable: ${error?.message ?? error}`] };
  }
  if (!feature) {
    return { ok: false, featureId, networkCalls: 0, checks: { featureReadable: false }, problems: [`featureReadable: '${featureId}' was not found`] };
  }
  check("featureReadable", true);
  check("featureId", feature.featureId === featureId, "the stored id differs from the directory name");
  check("featureDigest", featureDigestOf(feature) === feature.featureDigest, "the artifact does not match its own featureDigest");
  check(
    "featureIdentity",
    feature.featureId === buildFeatureId({ now: Date.parse(feature.createdAt), identityDigest: featureIdentityDigest(feature) }),
    "featureId does not match the derived identity",
  );
  check(
    "definitionPin",
    feature.featureDefinitionVersion === FEATURE_DEFINITION_VERSION && feature.featureDefinitionDigest === FEATURE_DEFINITION_DIGEST,
    "the artifact is not pinned to the frozen feature definition",
  );
  check(
    "frozenFlags",
    feature.immutable === true &&
      feature.finalized === true &&
      feature.descriptiveOnly === true &&
      feature.developmentOnly === true &&
      feature.noGroundTruth === true &&
      feature.noProfitabilityInference === true,
    "the frozen flags are not all true",
  );
  check("evidenceClass", feature.evidenceClass === DERIVED_EVIDENCE_CLASS, `the artifact is not '${DERIVED_EVIDENCE_CLASS}'`);
  check(
    "sourceEvidenceClass",
    feature.sourceEvidenceClass === SOURCE_EVIDENCE_CLASS && mapEvidenceClass(feature.sourceEvidenceClass) === feature.evidenceClass,
    "the source evidence class is not the mapped DEVELOPMENT class",
  );

  const audit = auditClassifierFeatureArtifact(feature);
  check("noRawText", audit.categories.textFree.length === 0, audit.categories.textFree.slice(0, 3).join("; "));
  check(
    "noForbiddenKeys",
    audit.categories.topLevelKeys.length === 0 && audit.categories.featureKeys.length === 0,
    [...audit.categories.topLevelKeys, ...audit.categories.featureKeys].slice(0, 3).join("; "),
  );
  check("noForbiddenNames", audit.categories.forbiddenNames.length === 0, audit.categories.forbiddenNames.slice(0, 3).join("; "));
  check("featuresNumericOnly", audit.categories.featureValues.length === 0, audit.categories.featureValues.slice(0, 3).join("; "));
  check("noGroupKeys", audit.categories.groupKeys.length === 0, audit.categories.groupKeys.slice(0, 3).join("; "));
  check(
    "routingInactive",
    audit.categories.routing.length === 0,
    audit.categories.routing.slice(0, 3).join("; "),
  );

  let cohort = null;
  try {
    cohort = await readCohort(classifierRoot, feature.cohortId);
  } catch (error) {
    check("cohortPresent", false, String(error?.message ?? error));
  }
  check("cohortPresent", Boolean(cohort), "the referenced cohort is missing");
  if (cohort) {
    const cohortCheck = verifyCohort(cohort);
    check("cohortIdentity", cohortCheck.ok, cohortCheck.problems.join("; "));
    check("cohortDigest", cohort.cohortDigest === feature.cohortDigest, "the artifact references a different cohort digest");
    check("cohortEvidenceClass", cohort.evidenceClass === feature.sourceEvidenceClass, "the cohort evidence class differs");
    check("cohortClassifier", cohort.classifierId === feature.classifierId && cohort.classifierVersion === feature.classifierVersion, "the cohort classifier differs");
    check("cohortProjection", cohort.inputProjectionVersion === feature.inputProjectionVersion, "the cohort projection differs");
  }

  let recomputed = null;
  try {
    if (!cohort) throw new FeatureIntegrityError(`cohort '${feature.cohortId}' is missing — the frozen evidence cannot be re-read`);
    const captureManifests = await readSourceCaptureManifests({ captureRoot, cohort });
    const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
    check("experimentsIntegrity", true);
    check("capturesIntegrity", true);
    recomputed = assembleFeatureArtifact({ cohort, evidence, captureManifests, createdAt: feature.createdAt });
    const countsOk =
      recomputed.recordCount === feature.recordCount &&
      recomputed.classifiedCount === feature.classifiedCount &&
      recomputed.skippedEmptyCount === feature.skippedEmptyCount &&
      recomputed.distinctRecordDigestCount === feature.distinctRecordDigestCount &&
      recomputed.duplicateRecordDigestCount === feature.duplicateRecordDigestCount &&
      recomputed.scoreVectorCompleteCount === feature.scoreVectorCompleteCount &&
      recomputed.scoreVectorIncompleteCount === feature.scoreVectorIncompleteCount &&
      recomputed.nullFeatureCount === feature.nullFeatureCount &&
      digestOf(recomputed.experimentDigests) === digestOf(feature.experimentDigests) &&
      digestOf(recomputed.resultDigests) === digestOf(feature.resultDigests) &&
      digestOf(recomputed.experimentRecordCounts) === digestOf(feature.experimentRecordCounts);
    check("counts", countsOk, "a stored count does not recompute from the frozen evidence");
    const distributionOk =
      digestOf(recomputed.counts) === digestOf(feature.counts) &&
      FEATURE_NAMES.filter((name) => name.startsWith("label_fraction_")).every((name) => recomputed.features[name] === feature.features[name]);
    check("labelDistribution", distributionOk, "the stored label distribution does not recompute");
    const confidenceOk = ["confidence_mean", "confidence_median", "confidence_low_fraction", "confidence_high_fraction"].every(
      (name) => recomputed.features[name] === feature.features[name],
    );
    check("confidence", confidenceOk, "a stored confidence feature does not recompute");
    const marginOk = ["score_margin_mean", "score_margin_median", "score_margin_ambiguous_fraction"].every(
      (name) => recomputed.features[name] === feature.features[name],
    );
    check("scoreMargin", marginOk, "a stored score-margin feature does not recompute");
    check(
      "timeline",
      digestOf(recomputed.timeline) === digestOf(feature.timeline) && feature.timeline.featureCreatedAt === feature.createdAt,
      "the stored timeline does not recompute from the frozen evidence",
    );
    check("featureDigestReproduced", recomputed.featureDigest === feature.featureDigest, "the recomputed featureDigest differs from the stored one");
  } catch (error) {
    check("experimentsIntegrity", false, String(error?.message ?? error));
    check("capturesIntegrity", false, String(error?.message ?? error));
  }

  return {
    ok: problems.length === 0,
    featureId,
    cohortId: feature.cohortId,
    featureDefinitionVersion: feature.featureDefinitionVersion,
    evidenceClass: feature.evidenceClass,
    featureDigest: feature.featureDigest,
    recomputedFeatureDigest: recomputed?.featureDigest ?? null,
    evidenceAsOf: feature.timeline?.evidenceAsOf ?? null,
    classifiedCount: feature.classifiedCount,
    networkCalls: 0,
    checks,
    problems,
  };
}

/* ============================================================================
 * Stats (offline, zero network, works WITHOUT a capture root)
 * ==========================================================================*/

/**
 * Read-only DESCRIPTIVE stats for one stored feature artifact. No verdict, no
 * ranking, no gate, no predictive claim. `noiseFraction`/`promotionFraction` are
 * DISPLAY ALIASES for two canonical features, never additional features.
 */
export async function classifierFeatureStats({ classifierRoot, featureId } = {}) {
  const feature = await requireFeatureArtifact(classifierRoot, featureId);
  const cohort = feature.cohortId ? await readCohort(classifierRoot, feature.cohortId) : null;
  const cohortCheck = cohort ? verifyCohort(cohort) : { ok: false, problems: ["the cohort is missing"] };
  const features = feature.features ?? {};
  return {
    featureId: feature.featureId,
    phase: feature.phase,
    featureDefinitionVersion: feature.featureDefinitionVersion,
    featureDefinitionDigest: feature.featureDefinitionDigest,
    featureDefinitionDigestOk: feature.featureDefinitionDigest === FEATURE_DEFINITION_DIGEST,
    evidenceClass: feature.evidenceClass,
    sourceEvidenceClass: feature.sourceEvidenceClass,
    cohortId: feature.cohortId,
    cohortDigest: feature.cohortDigest,
    cohortDigestOk: Boolean(cohort) && cohort.cohortDigest === feature.cohortDigest,
    cohortOk: cohortCheck.ok,
    experimentCount: feature.experimentCount,
    captureCount: feature.captureCount,
    infrastructureExperimentPresent: feature.infrastructureExperimentPresent === true,
    recordCount: feature.recordCount,
    classifiedCount: feature.classifiedCount,
    skippedCount: feature.skippedEmptyCount,
    distinctRecordDigestCount: feature.distinctRecordDigestCount,
    duplicateRecordDigestCount: feature.duplicateRecordDigestCount,
    scoreVectorCompleteCount: feature.scoreVectorCompleteCount,
    scoreVectorIncompleteCount: feature.scoreVectorIncompleteCount,
    nullFeatureCount: feature.nullFeatureCount,
    labelCounts: feature.counts?.labelCounts ?? {},
    labelFractions: Object.fromEntries(CLASSIFIER_LABELS.map((label) => [label, features[labelFeatureName(label)]])),
    observedLabelCount: features.observed_label_count,
    labelEntropyNormalized: features.label_entropy_normalized,
    largestLabel: feature.counts?.largestLabel ?? null,
    largestLabelCount: feature.counts?.largestLabelCount ?? null,
    largestLabelFraction: features.largest_label_fraction,
    confidenceMean: features.confidence_mean,
    confidenceMedian: features.confidence_median,
    confidenceLowFraction: features.confidence_low_fraction,
    confidenceHighFraction: features.confidence_high_fraction,
    scoreMarginMean: features.score_margin_mean,
    scoreMarginMedian: features.score_margin_median,
    scoreMarginAmbiguousFraction: features.score_margin_ambiguous_fraction,
    // DISPLAY ALIASES ONLY — the same canonical features, never additional ones.
    noiseFraction: features[FEATURE_ALIASES.noise_fraction],
    promotionFraction: features[FEATURE_ALIASES.promotion_fraction],
    features: { ...features },
    aggregation: { ...(feature.aggregation ?? {}) },
    evidenceAsOf: feature.timeline?.evidenceAsOf ?? null,
    createdAt: feature.createdAt,
    featureDigest: feature.featureDigest,
    featureDigestOk: featureDigestOf(feature) === feature.featureDigest,
    routing: { ...(feature.routing ?? {}) },
    jevRoutingActive: feature.routing?.jevRoutingActive === true,
    deepseekRoutingActive: feature.routing?.deepseekRoutingActive === true,
    arenaRoutingActive: feature.routing?.arenaRoutingActive === true,
    tradingRoutingActive: feature.routing?.tradingRoutingActive === true,
    auditOk: auditClassifierFeatureArtifact(feature).ok,
    networkCalls: 0,
  };
}
