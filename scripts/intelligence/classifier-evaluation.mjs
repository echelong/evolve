/**
 * Phase 5G.1 — OFFLINE classifier TAXONOMY evaluation (PAPER ONLY, DESCRIPTIVE).
 *
 *   frozen capture → Phase 5G.0 classifier experiment → explicit immutable cohort
 *     → OFFLINE descriptive taxonomy evaluation → evaluation artifact → STOP
 *
 * This module is strictly OFFLINE. It reads frozen classifier experiments and
 * their corresponding frozen captures from disk; it NEVER calls classifier.dev,
 * Agent-Reach, Jev, DeepSeek or the Arena. It performs ZERO network calls.
 *
 * It answers DESCRIPTIVE questions only:
 *
 *   is one label swallowing most observations, how do labels differ across
 *   channels, are confidences decisive or ambiguous, which labels have small
 *   top-1/top-2 margins, are the score distributions coherent, does the
 *   taxonomy look descriptive across public-information sources, how much
 *   `unrelated_or_noise` and `promotion_or_marketing` is present.
 *
 * It does NOT establish truth, predictive value or profitability. There is NO
 * ground truth here, so there is NO accuracy/precision/recall/F1/ROC/calibration
 * metric, and NO correlation against returns, P&L, Arena score, survival or gate
 * outcomes. There is NO automated pass/fail verdict of any kind.
 *
 * Both the COHORT and the EVALUATION explicitly declare
 * `evidenceClass: "DEVELOPMENT_CLASSIFIER_EVIDENCE"` — never CLEAN_REPLICATION,
 * VALIDATION, TEST, OOS or PRODUCTION.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { loadCaptureRecords, readCaptureManifest, verifyCapture } from "./capture.mjs";
import {
  CLASSIFIER_EXPERIMENT_FILE,
  CLASSIFIER_RESULTS_FILE,
  classifierExperimentDir,
  experimentDigestOf,
  isValidClassifierExperimentId,
  replayClassifierExperiment,
  resultDigestOf,
} from "./classifier-experiment.mjs";
import {
  CLASSIFIER_ID,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
  normalizeClassifierWhitespace,
  redactClassifierText,
  replaceEmbeddedUrls,
} from "./classifier-definition.mjs";

export const CLASSIFIER_EVALUATION_PHASE = "5G.1";
export const CLASSIFIER_EVALUATION_SCHEMA_VERSION = 1;

export const CLASSIFIER_COHORTS_SUBDIR = "cohorts";
export const CLASSIFIER_EVALUATIONS_SUBDIR = "evaluations";
export const COHORT_FILE_SUFFIX = ".json";
export const EVALUATION_FILE = "evaluation.json";

/** Every development cohort is DEVELOPMENT evidence and NOTHING ELSE. */
export const COHORT_PURPOSE_DEVELOPMENT = "DEVELOPMENT";
export const COHORT_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_EVIDENCE";

/**
 * The canonical Phase 5G.0 ONE-RECORD infrastructure experiment. It proves the
 * plumbing and carries NO taxonomy signal, so it is excluded from the meaningful
 * development cohort by default.
 */
export const CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID = "clexp-20260919T143623Z-69170f53";
export const CANONICAL_INFRASTRUCTURE_RESULT_DIGEST = "69170f5375168f9cadc2243fc50b74e282b6ab055ae738e5b7478b379d33655d";

/** The two descriptive categories reported separately (never as scam/bot/etc.). */
export const NOISE_LABEL = "unrelated_or_noise";
export const PROMOTION_LABEL = "promotion_or_marketing";

/**
 * Fixed DESCRIPTIVE confidence bands. These thresholds are NOT acceptance gates
 * and there is no verdict attached to them.
 */
export const CONFIDENCE_BANDS = Object.freeze([
  Object.freeze({ id: "below_0_50", comparator: "lt", threshold: 0.5 }),
  Object.freeze({ id: "below_0_70", comparator: "lt", threshold: 0.7 }),
  Object.freeze({ id: "at_least_0_90", comparator: "gte", threshold: 0.9 }),
]);

/** Fixed DESCRIPTIVE ambiguity bands for `scoreMargin`. NOT a gate. */
export const AMBIGUITY_BANDS = Object.freeze([
  Object.freeze({ id: "below_0_05", comparator: "lt", threshold: 0.05 }),
  Object.freeze({ id: "below_0_10", comparator: "lt", threshold: 0.1 }),
  Object.freeze({ id: "below_0_20", comparator: "lt", threshold: 0.2 }),
]);

/** Keys that may appear in the cohort manifest — nothing else. */
export const COHORT_FIELDS = Object.freeze([
  "cohortId",
  "purpose",
  "evidenceClass",
  "classifierId",
  "classifierVersion",
  "inputProjectionVersion",
  "experimentIds",
  "sourceCaptureIds",
  "experimentDigests",
  "resultDigests",
  "recordCounts",
  "createdAt",
  "immutable",
  "note",
  "cohortDigest",
]);

/** Keys that may appear in the evaluation artifact — nothing else. */
export const EVALUATION_FIELDS = Object.freeze([
  "schemaVersion",
  "phase",
  "evaluationId",
  "cohortId",
  "evidenceClass",
  "classifierId",
  "classifierVersion",
  "inputProjectionVersion",
  "experimentCount",
  "captureCount",
  "recordCount",
  "channelCounts",
  "metrics",
  "cohortDigest",
  "evaluationDigest",
  "createdAt",
  "immutable",
  "descriptiveOnly",
  "noGroundTruth",
  "noProfitabilityInference",
  "note",
]);

/** Keys that must NEVER appear anywhere in a cohort or evaluation artifact. */
export const FORBIDDEN_ARTIFACT_KEYS = Object.freeze([
  "title",
  "textExcerpt",
  "text",
  "excerpt",
  "url",
  "canonicalUrl",
  "canonicalId",
  "author",
  "authorId",
  "query",
  "queryId",
  "input",
  "inputs",
  "raw",
  "rawDigest",
  "response",
  "headers",
  "authorization",
  "apiKey",
]);

/** Strings that would betray raw text / a URL / a credential in an artifact. */
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;

export const COHORT_NOTE =
  "DEVELOPMENT-only classifier evaluation cohort. Frozen from EXPLICIT classifier experiment ids; descriptive " +
  "evidence for Phase 5G.1 only. `evidenceClass` is authoritative and pins this cohort to DEVELOPMENT classifier " +
  "evidence; no future clean artifact may depend on it.";

export const EVALUATION_NOTE =
  "DESCRIPTIVE, OFFLINE taxonomy evaluation of already-frozen classifier experiments. No ground truth, so no " +
  "accuracy/precision/recall/F1/ROC/calibration; no profitability or predictive inference; no automated verdict. " +
  "The labels are DESCRIPTIVE and UNVERIFIED and have no authority over the Arena, evolution, gates, replication " +
  "or deployment.";

/* ============================================================================
 * Errors
 * ==========================================================================*/

export class CohortError extends Error {
  constructor(message) {
    super(message);
    this.name = "CohortError";
  }
}

export class CohortNoExperimentsError extends CohortError {
  constructor() {
    super("a cohort requires at least one EXPLICIT classifier experiment id — Phase 5G.1 never searches for the 'latest' experiment");
    this.name = "CohortNoExperimentsError";
  }
}

export class CohortDuplicateExperimentError extends CohortError {
  constructor(experimentId) {
    super(`duplicate classifier experiment '${experimentId}' in the cohort — a cohort must not list an experiment twice`);
    this.name = "CohortDuplicateExperimentError";
    this.experimentId = experimentId;
  }
}

export class CohortInvalidExperimentIdError extends CohortError {
  constructor(experimentId) {
    super(`'${experimentId}' is not a valid classifier experiment id (expected clexp-*)`);
    this.name = "CohortInvalidExperimentIdError";
    this.experimentId = experimentId;
  }
}

export class CohortExperimentMissingError extends CohortError {
  constructor(experimentId, cause) {
    super(`classifier experiment '${experimentId}' does not exist — a cohort can only reference FROZEN experiments`);
    this.name = "CohortExperimentMissingError";
    this.experimentId = experimentId;
    this.cause = cause;
  }
}

export class CohortClassifierMismatchError extends CohortError {
  constructor(experimentId, classifierId) {
    super(`classifier experiment '${experimentId}' uses classifier '${classifierId}', not the frozen '${CLASSIFIER_ID}'`);
    this.name = "CohortClassifierMismatchError";
    this.experimentId = experimentId;
  }
}

export class CohortClassifierVersionMismatchError extends CohortError {
  constructor(experimentId, classifierVersion) {
    super(`classifier experiment '${experimentId}' uses version ${classifierVersion}, not the frozen version ${CLASSIFIER_VERSION}`);
    this.name = "CohortClassifierVersionMismatchError";
    this.experimentId = experimentId;
  }
}

export class CohortProjectionMismatchError extends CohortError {
  constructor(experimentId, projectionVersion) {
    super(`classifier experiment '${experimentId}' uses input projection '${projectionVersion}', not the frozen '${INPUT_PROJECTION_VERSION}'`);
    this.name = "CohortProjectionMismatchError";
    this.experimentId = experimentId;
  }
}

export class CohortExperimentNotFinalError extends CohortError {
  constructor(experimentId) {
    super(`classifier experiment '${experimentId}' is not FINALIZED and IMMUTABLE — a cohort only accepts frozen experiments`);
    this.name = "CohortExperimentNotFinalError";
    this.experimentId = experimentId;
  }
}

export class CohortExperimentIntegrityError extends CohortError {
  constructor(experimentId, reason) {
    super(`classifier experiment '${experimentId}' failed integrity verification: ${reason}`);
    this.name = "CohortExperimentIntegrityError";
    this.experimentId = experimentId;
    this.reason = reason;
  }
}

export class CohortCaptureMissingError extends CohortError {
  constructor(captureId) {
    super(`source capture '${captureId}' is missing — a cohort requires every referenced source capture to be present`);
    this.name = "CohortCaptureMissingError";
    this.captureId = captureId;
  }
}

export class CohortCaptureIntegrityError extends CohortError {
  constructor(captureId, reason = "the bytes do not match the frozen manifest") {
    super(`source capture '${captureId}' failed integrity verification: ${reason}`);
    this.name = "CohortCaptureIntegrityError";
    this.captureId = captureId;
  }
}

export class CohortInfrastructureExperimentError extends CohortError {
  constructor(experimentId) {
    super(
      `'${experimentId}' is the canonical Phase 5G.0 ONE-RECORD infrastructure experiment and carries NO taxonomy signal. ` +
        "It is excluded from the meaningful development cohort by default; pass --allow-infrastructure for a separate infrastructure report only.",
    );
    this.name = "CohortInfrastructureExperimentError";
    this.experimentId = experimentId;
  }
}

export class CohortExistsError extends CohortError {
  constructor(cohortId) {
    super(`cohort '${cohortId}' already exists — cohorts are IMMUTABLE and are never overwritten`);
    this.name = "CohortExistsError";
    this.cohortId = cohortId;
  }
}

export class CohortNotFoundError extends CohortError {
  constructor(cohortId) {
    super(`cohort '${cohortId}' was not found`);
    this.name = "CohortNotFoundError";
    this.cohortId = cohortId;
  }
}

export class CohortDigestMismatchError extends CohortError {
  constructor(cohortId) {
    super(`cohort '${cohortId}' does not match its own digest — the manifest was modified after it was frozen`);
    this.name = "CohortDigestMismatchError";
    this.cohortId = cohortId;
  }
}

export class ClassifierEvaluationJoinError extends CohortError {
  constructor(experimentId, recordDigest) {
    super(
      `classification record ${recordDigest} from experiment '${experimentId}' has no matching frozen source record ` +
        "(join is by recordDigest === normalizedDigest) — failing closed",
    );
    this.name = "ClassifierEvaluationJoinError";
    this.experimentId = experimentId;
    this.recordDigest = recordDigest;
  }
}

export class EvaluationExistsError extends CohortError {
  constructor(evaluationId) {
    super(`evaluation '${evaluationId}' already exists — evaluations are IMMUTABLE and are never overwritten`);
    this.name = "EvaluationExistsError";
    this.evaluationId = evaluationId;
  }
}

export class EvaluationNotFoundError extends CohortError {
  constructor(evaluationId) {
    super(`evaluation '${evaluationId}' was not found`);
    this.name = "EvaluationNotFoundError";
    this.evaluationId = evaluationId;
  }
}

/* ============================================================================
 * Identity + digests
 * ==========================================================================*/

export function isValidCohortId(cohortId) {
  return typeof cohortId === "string" && /^clcohort-[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(cohortId);
}

export function isValidEvaluationId(evaluationId) {
  return typeof evaluationId === "string" && /^cleval-[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(evaluationId);
}

function utcStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** `clcohort-<UTC stamp>-<8 hex>` — deterministic given the clock and the digest. */
export function buildCohortId({ now, identityDigest }) {
  return `clcohort-${utcStamp(now)}-${String(identityDigest).slice(0, 8)}`;
}

/** `cleval-<UTC stamp>-<8 hex>` — deterministic given the clock and the digest. */
export function buildEvaluationId({ now, identityDigest }) {
  return `cleval-${utcStamp(now)}-${String(identityDigest).slice(0, 8)}`;
}

/**
 * The identity subject of a cohort: everything except the derived `cohortId` and
 * the `cohortDigest` itself (the id is derived FROM this digest, so including it
 * would be circular).
 */
export function cohortIdentitySubject(cohort) {
  const subject = { ...(cohort ?? {}) };
  delete subject.cohortId;
  delete subject.cohortDigest;
  return subject;
}

export function cohortIdentityDigest(cohort) {
  return digestOf(cohortIdentitySubject(cohort));
}

export function cohortDigestOf(cohort) {
  const subject = { ...(cohort ?? {}) };
  delete subject.cohortDigest;
  return digestOf(subject);
}

export function evaluationIdentityDigest(evaluation) {
  const subject = { ...(evaluation ?? {}) };
  delete subject.evaluationId;
  delete subject.evaluationDigest;
  return digestOf(subject);
}

export function evaluationDigestOf(evaluation) {
  const subject = { ...(evaluation ?? {}) };
  delete subject.evaluationDigest;
  return digestOf(subject);
}

export function cohortPathFor(classifierRoot, cohortId) {
  if (!isValidCohortId(cohortId)) throw new CohortError(`invalid cohort id '${cohortId}'`);
  return path.join(classifierRoot, CLASSIFIER_COHORTS_SUBDIR, `${cohortId}${COHORT_FILE_SUFFIX}`);
}

export function evaluationDirFor(classifierRoot, evaluationId) {
  if (!isValidEvaluationId(evaluationId)) throw new CohortError(`invalid evaluation id '${evaluationId}'`);
  return path.join(classifierRoot, CLASSIFIER_EVALUATIONS_SUBDIR, evaluationId);
}

/* ============================================================================
 * Numeric helpers (deterministic)
 * ==========================================================================*/

export function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function sortedAscending(values) {
  return [...values].sort((a, b) => a - b);
}

/**
 * Linear-interpolation quantile over an ALREADY-SORTED ascending array
 * (the numpy "linear" definition). Deterministic; no randomness.
 */
export function quantile(sortedValues, q) {
  const n = sortedValues.length;
  if (n === 0) return null;
  if (n === 1) return sortedValues[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  const weight = pos - lo;
  return sortedValues[lo] * (1 - weight) + sortedValues[hi] * weight;
}

export function meanOf(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The nine classifier scores, with an absent label treated as 0. */
export function nineScores(scores) {
  const out = {};
  for (const label of CLASSIFIER_LABELS) {
    const value = scores?.[label];
    out[label] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return out;
}

/** Top two values of the nine scores, descending. */
export function topTwoScores(scores) {
  const values = sortedAscending(Object.values(nineScores(scores))).reverse();
  return { top1Score: values[0] ?? 0, top2Score: values[1] ?? 0 };
}

export function scoreMarginOf(scores) {
  const { top1Score, top2Score } = topTwoScores(scores);
  return top1Score - top2Score;
}

/**
 * Normalized Shannon entropy of a NONNEGATIVE vector that sums to > 0.
 * Returns null when normalization is not mathematically valid (empty or
 * zero-sum) — a missing value is never invented.
 */
export function normalizedEntropy(values, labelCount) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  let entropy = 0;
  for (const value of values) {
    if (value > 0) {
      const p = value / total;
      entropy -= p * Math.log(p);
    }
  }
  return entropy / Math.log(labelCount);
}

/** Normalized entropy over the nine labels (0 = one label, 1 = uniform). */
export function labelDiversityOf(labelCounts) {
  return normalizedEntropy(CLASSIFIER_LABELS.map((label) => labelCounts[label] ?? 0), CLASSIFIER_LABELS.length);
}

/** Normalized entropy of one record's nine scores, or null when invalid. */
export function scoreEntropyOf(scores) {
  const values = CLASSIFIER_LABELS.map((label) => {
    const value = scores?.[label];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  });
  return normalizedEntropy(values, CLASSIFIER_LABELS.length);
}

function bandSummary(values, bands, total) {
  const summary = {};
  for (const band of bands) {
    const count = values.filter((value) => (band.comparator === "lt" ? value < band.threshold : value >= band.threshold)).length;
    summary[band.id] = { threshold: band.threshold, comparator: band.comparator, count, fraction: total > 0 ? round6(count / total) : 0 };
  }
  return summary;
}

function distributionSummary(values) {
  if (values.length === 0) {
    return { count: 0, mean: null, median: null, p10: null, p25: null, p75: null, p90: null, min: null, max: null };
  }
  const sorted = sortedAscending(values);
  return {
    count: sorted.length,
    mean: round6(meanOf(sorted)),
    median: round6(quantile(sorted, 0.5)),
    p10: round6(quantile(sorted, 0.1)),
    p25: round6(quantile(sorted, 0.25)),
    p75: round6(quantile(sorted, 0.75)),
    p90: round6(quantile(sorted, 0.9)),
    min: round6(sorted[0]),
    max: round6(sorted[sorted.length - 1]),
  };
}

/* ============================================================================
 * Metrics
 * ==========================================================================*/

/**
 * Compute the deterministic descriptive metrics of an evaluation.
 *
 * @param {Array<{ recordDigest: string, label: string, confidence: number, scores: object, channel: string }>} observations
 */
export function computeEvaluationMetrics(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  const total = rows.length;

  const labelCounts = {};
  for (const label of CLASSIFIER_LABELS) labelCounts[label] = 0;
  for (const row of rows) {
    if (Object.hasOwn(labelCounts, row.label)) labelCounts[row.label] += 1;
  }

  const labelDistribution = {
    labels: CLASSIFIER_LABELS.map((label) => ({
      label,
      count: labelCounts[label],
      fraction: total > 0 ? round6(labelCounts[label] / total) : 0,
    })),
    totalClassified: total,
    labelsObserved: CLASSIFIER_LABELS.filter((label) => labelCounts[label] > 0).length,
    labelDiversity: round6(labelDiversityOf(labelCounts)),
  };

  const confidences = rows.map((row) => row.confidence);
  const confidenceStats = distributionSummary(confidences);
  const confidence = {
    ...confidenceStats,
    bands: bandSummary(confidences, CONFIDENCE_BANDS, total),
  };

  const perLabelConfidence = {};
  for (const label of CLASSIFIER_LABELS) {
    const values = rows.filter((row) => row.label === label).map((row) => row.confidence);
    if (values.length === 0) continue;
    const sorted = sortedAscending(values);
    perLabelConfidence[label] = {
      count: sorted.length,
      mean: round6(meanOf(sorted)),
      median: round6(quantile(sorted, 0.5)),
      p25: round6(quantile(sorted, 0.25)),
      p75: round6(quantile(sorted, 0.75)),
    };
  }

  const margins = rows.map((row) => round6(scoreMarginOf(row.scores)));
  const marginStats = distributionSummary(margins);
  const scoreMargin = {
    ...marginStats,
    bands: bandSummary(margins, AMBIGUITY_BANDS, total),
  };

  const entropies = rows.map((row) => scoreEntropyOf(row.scores));
  const computedEntropies = entropies.filter((value) => value !== null);
  const sortedEntropies = sortedAscending(computedEntropies);
  const scoreEntropy = {
    count: computedEntropies.length,
    nullCount: entropies.length - computedEntropies.length,
    mean: computedEntropies.length > 0 ? round6(meanOf(computedEntropies)) : null,
    median: computedEntropies.length > 0 ? round6(quantile(sortedEntropies, 0.5)) : null,
    p25: computedEntropies.length > 0 ? round6(quantile(sortedEntropies, 0.25)) : null,
    p75: computedEntropies.length > 0 ? round6(quantile(sortedEntropies, 0.75)) : null,
  };

  const channelNames = [...new Set(rows.map((row) => row.channel))].sort();
  const channels = {};
  for (const channel of channelNames) {
    const channelRows = rows.filter((row) => row.channel === channel);
    const channelCounts = {};
    for (const label of CLASSIFIER_LABELS) channelCounts[label] = 0;
    for (const row of channelRows) channelCounts[row.label] += 1;
    const channelTotal = channelRows.length;
    channels[channel] = {
      recordCount: channelTotal,
      labelCounts: channelCounts,
      labelFractions: Object.fromEntries(CLASSIFIER_LABELS.map((label) => [label, round6(channelCounts[label] / channelTotal)])),
      meanConfidence: round6(meanOf(channelRows.map((row) => row.confidence))),
      medianConfidence: round6(quantile(sortedAscending(channelRows.map((row) => row.confidence)), 0.5)),
      meanScoreMargin: round6(meanOf(channelRows.map((row) => scoreMarginOf(row.scores)))),
      medianScoreMargin: round6(quantile(sortedAscending(channelRows.map((row) => scoreMarginOf(row.scores))), 0.5)),
    };
  }

  const channelCoverage = {
    channels: channelNames,
    countPerChannel: Object.fromEntries(channelNames.map((channel) => [channel, channels[channel].recordCount])),
    fractionPerChannel: Object.fromEntries(
      channelNames.map((channel) => [channel, total > 0 ? round6(channels[channel].recordCount / total) : 0]),
    ),
  };

  const noise = { label: NOISE_LABEL, count: labelCounts[NOISE_LABEL], fraction: total > 0 ? round6(labelCounts[NOISE_LABEL] / total) : 0 };
  const promotion = {
    label: PROMOTION_LABEL,
    count: labelCounts[PROMOTION_LABEL],
    fraction: total > 0 ? round6(labelCounts[PROMOTION_LABEL] / total) : 0,
  };

  // Tie-break by taxonomy order so concentration is deterministic.
  let largestLabel = CLASSIFIER_LABELS[0];
  let largestLabelCount = -1;
  for (const label of CLASSIFIER_LABELS) {
    if (labelCounts[label] > largestLabelCount) {
      largestLabelCount = labelCounts[label];
      largestLabel = label;
    }
  }
  const concentration = {
    largestLabel,
    largestLabelCount,
    largestLabelFraction: total > 0 ? round6(largestLabelCount / total) : 0,
  };

  return {
    labelDistribution,
    confidence,
    perLabelConfidence,
    scoreMargin,
    scoreEntropy,
    channels,
    channelCoverage,
    noise,
    promotion,
    concentration,
  };
}

/* ============================================================================
 * Offline evidence loading (ZERO network)
 * ==========================================================================*/

async function readStoredExperiment(classifierRoot, experimentId) {
  const dir = classifierExperimentDir(classifierRoot, experimentId);
  let experiment;
  try {
    experiment = JSON.parse(await readFile(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  } catch (error) {
    throw new CohortExperimentMissingError(experimentId, error);
  }
  const text = await readFile(path.join(dir, CLASSIFIER_RESULTS_FILE), "utf8");
  const records = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { dir, experiment, records };
}

/**
 * Validate ONE classifier experiment against the frozen definition and its
 * source capture, in a fixed order. Throws a typed `CohortError` on any failure.
 */
export async function assertExperimentMembership({ captureRoot, experimentId, experiment, records }) {
  if (experiment?.experimentId !== experimentId) {
    throw new CohortExperimentIntegrityError(experimentId, "the stored experiment id differs from the directory name");
  }
  if (experiment.classifierId !== CLASSIFIER_ID) throw new CohortClassifierMismatchError(experimentId, experiment.classifierId);
  if (experiment.classifierVersion !== CLASSIFIER_VERSION) {
    throw new CohortClassifierVersionMismatchError(experimentId, experiment.classifierVersion);
  }
  if (experiment.inputProjectionVersion !== INPUT_PROJECTION_VERSION) {
    throw new CohortProjectionMismatchError(experimentId, experiment.inputProjectionVersion);
  }
  if (experiment.immutable !== true || experiment.finalized !== true) throw new CohortExperimentNotFinalError(experimentId);

  if (experimentDigestOf(experiment) !== experiment.experimentDigest) {
    throw new CohortExperimentIntegrityError(experimentId, "experiment.json does not match its own digest");
  }
  if (!Array.isArray(records) || records.length !== experiment.classifiedCount) {
    throw new CohortExperimentIntegrityError(experimentId, "the classified record count is inconsistent");
  }
  if (resultDigestOf(records) !== experiment.resultDigest) {
    throw new CohortExperimentIntegrityError(experimentId, "the recomputed resultDigest differs from the stored one");
  }
  for (const record of records) {
    if (
      record?.classifierId !== CLASSIFIER_ID ||
      record?.classifierVersion !== CLASSIFIER_VERSION ||
      record?.inputProjectionVersion !== INPUT_PROJECTION_VERSION
    ) {
      throw new CohortExperimentIntegrityError(experimentId, "a classification record disagrees with the frozen definition");
    }
    if (typeof record.label !== "string" || !CLASSIFIER_LABELS.includes(record.label)) {
      throw new CohortExperimentIntegrityError(experimentId, "a classification record carries a label outside the taxonomy");
    }
  }

  const manifest = await readCaptureManifest(captureRoot, experiment.captureId);
  if (!manifest) throw new CohortCaptureMissingError(experiment.captureId);
  if (manifest.immutable !== true || manifest.finalized !== true) {
    throw new CohortCaptureIntegrityError(experiment.captureId, "the capture manifest is not immutable/finalized");
  }
  if (manifest.manifestDigest !== experiment.captureManifestDigest) {
    throw new CohortCaptureIntegrityError(experiment.captureId, "the capture identity no longer matches the experiment");
  }
  const integrity = await verifyCapture(captureRoot, experiment.captureId);
  if (!integrity.ok) throw new CohortCaptureIntegrityError(experiment.captureId);
}

/**
 * Load every frozen classifier experiment and source capture a cohort references,
 * verify each one OFFLINE, and join classifications to source records by
 * `recordDigest === normalizedDigest`. Fails closed when a source record is
 * missing.
 */
export async function collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity = true }) {
  for (const captureId of cohort.sourceCaptureIds) {
    const manifest = await readCaptureManifest(captureRoot, captureId);
    if (!manifest) throw new CohortCaptureMissingError(captureId);
    if (manifest.immutable !== true || manifest.finalized !== true) {
      throw new CohortCaptureIntegrityError(captureId, "the capture manifest is not immutable/finalized");
    }
    if (verifyIntegrity) {
      const integrity = await verifyCapture(captureRoot, captureId);
      if (!integrity.ok) throw new CohortCaptureIntegrityError(captureId);
    }
  }

  const sourceByDigest = new Map();
  for (const captureId of cohort.sourceCaptureIds) {
    const records = await loadCaptureRecords(captureRoot, captureId);
    for (const record of records) {
      if (!sourceByDigest.has(record.normalizedDigest)) sourceByDigest.set(record.normalizedDigest, record);
    }
  }

  const experiments = [];
  const observations = [];
  for (const experimentId of cohort.experimentIds) {
    const { experiment, records } = await readStoredExperiment(classifierRoot, experimentId);
    await assertExperimentMembership({ captureRoot, experimentId, experiment, records });
    if (verifyIntegrity) {
      const replay = await replayClassifierExperiment({ outRoot: classifierRoot, captureRoot, experimentId });
      if (!replay.ok) throw new CohortExperimentIntegrityError(experimentId, replay.problems.join(" | ") || "offline replay failed");
    }
    experiments.push({ experimentId, experiment, records });
    for (const record of records) {
      const source = sourceByDigest.get(record.recordDigest);
      if (!source) throw new ClassifierEvaluationJoinError(experimentId, record.recordDigest);
      observations.push({
        experimentId,
        recordDigest: record.recordDigest,
        label: record.label,
        confidence: record.confidence,
        scores: record.scores,
        channel: source.channel,
      });
    }
  }
  return { experiments, sourceByDigest, observations };
}

/* ============================================================================
 * Cohort freeze / read
 * ==========================================================================*/

export function normalizeExperimentIds(experimentIds) {
  const list = Array.isArray(experimentIds)
    ? experimentIds
    : typeof experimentIds === "string"
      ? experimentIds.split(",")
      : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? "").trim();
    if (id.length === 0) continue;
    if (!isValidClassifierExperimentId(id)) throw new CohortInvalidExperimentIdError(id);
    if (seen.has(id)) throw new CohortDuplicateExperimentError(id);
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) throw new CohortNoExperimentsError();
  return out.sort();
}

/**
 * Freeze an immutable DEVELOPMENT cohort from EXPLICIT classifier experiment ids.
 * Validates every experiment (and its source capture) BEFORE writing anything.
 */
export async function freezeCohort({ classifierRoot, captureRoot, experimentIds, now = () => Date.now(), allowInfrastructure = false } = {}) {
  const requested = normalizeExperimentIds(experimentIds);
  if (!allowInfrastructure && requested.includes(CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID)) {
    throw new CohortInfrastructureExperimentError(CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  }

  const experimentDigests = {};
  const resultDigests = {};
  const recordCounts = {};
  const sourceCaptureIds = new Set();
  for (const experimentId of requested) {
    const { experiment, records } = await readStoredExperiment(classifierRoot, experimentId);
    await assertExperimentMembership({ captureRoot, experimentId, experiment, records });
    experimentDigests[experimentId] = experiment.experimentDigest;
    resultDigests[experimentId] = experiment.resultDigest;
    recordCounts[experimentId] = records.length;
    sourceCaptureIds.add(experiment.captureId);
  }

  const createdAt = new Date(now()).toISOString();
  const subject = {
    purpose: COHORT_PURPOSE_DEVELOPMENT,
    evidenceClass: COHORT_EVIDENCE_CLASS,
    classifierId: CLASSIFIER_ID,
    classifierVersion: CLASSIFIER_VERSION,
    inputProjectionVersion: INPUT_PROJECTION_VERSION,
    experimentIds: requested,
    sourceCaptureIds: [...sourceCaptureIds].sort(),
    experimentDigests,
    resultDigests,
    recordCounts,
    createdAt,
    immutable: true,
    note: COHORT_NOTE,
  };
  const cohortId = buildCohortId({ now: Date.parse(createdAt), identityDigest: cohortIdentityDigest(subject) });
  const cohort = { ...subject, cohortId, cohortDigest: cohortDigestOf({ ...subject, cohortId }) };

  const file = cohortPathFor(classifierRoot, cohortId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cohort, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error?.code === "EEXIST") throw new CohortExistsError(cohortId);
    throw error;
  });
  return { cohort, file };
}

export async function readCohort(classifierRoot, cohortId) {
  if (!isValidCohortId(cohortId)) throw new CohortError(`invalid cohort id '${cohortId}'`);
  try {
    return JSON.parse(await readFile(cohortPathFor(classifierRoot, cohortId), "utf8"));
  } catch {
    return null;
  }
}

export async function listCohorts(classifierRoot) {
  try {
    return (await readdir(path.join(classifierRoot, CLASSIFIER_COHORTS_SUBDIR), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(COHORT_FILE_SUFFIX) && isValidCohortId(entry.name.slice(0, -COHORT_FILE_SUFFIX.length)))
      .map((entry) => entry.name.slice(0, -COHORT_FILE_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

/** Verify the cohort is self-consistent, DEVELOPMENT-only and matches its id. */
export function verifyCohort(cohort) {
  const problems = [];
  if (cohort?.purpose !== COHORT_PURPOSE_DEVELOPMENT) problems.push(`purpose must be '${COHORT_PURPOSE_DEVELOPMENT}'`);
  if (cohort?.evidenceClass !== COHORT_EVIDENCE_CLASS) problems.push(`evidenceClass must be '${COHORT_EVIDENCE_CLASS}'`);
  if (cohort?.classifierId !== CLASSIFIER_ID) problems.push("classifierId does not match the frozen taxonomy");
  if (cohort?.classifierVersion !== CLASSIFIER_VERSION) problems.push("classifierVersion does not match the frozen taxonomy");
  if (cohort?.inputProjectionVersion !== INPUT_PROJECTION_VERSION) problems.push("inputProjectionVersion does not match the frozen projection");
  if (cohort?.immutable !== true) problems.push("immutable must be true");
  const expectedId = buildCohortId({ now: Date.parse(cohort?.createdAt), identityDigest: cohortIdentityDigest(cohort) });
  if (cohort?.cohortId !== expectedId) problems.push("cohortId does not match the derived identity");
  if (cohortDigestOf(cohort) !== cohort?.cohortDigest) problems.push("cohortDigest does not match the manifest body");
  return { ok: problems.length === 0, problems };
}

async function requireCohort(classifierRoot, cohortId) {
  const cohort = await readCohort(classifierRoot, cohortId);
  if (!cohort) throw new CohortNotFoundError(cohortId);
  const verified = verifyCohort(cohort);
  if (!verified.ok) throw new CohortDigestMismatchError(cohortId);
  return cohort;
}

/* ============================================================================
 * Evaluation build
 * ==========================================================================*/

function channelCountsOf(observations) {
  const channels = [...new Set(observations.map((row) => row.channel))].sort();
  const counts = {};
  for (const channel of channels) counts[channel] = observations.filter((row) => row.channel === channel).length;
  return counts;
}

function evaluationBody({ cohort, observations, createdAt }) {
  return {
    schemaVersion: CLASSIFIER_EVALUATION_SCHEMA_VERSION,
    phase: CLASSIFIER_EVALUATION_PHASE,
    cohortId: cohort.cohortId,
    evidenceClass: COHORT_EVIDENCE_CLASS,
    classifierId: CLASSIFIER_ID,
    classifierVersion: CLASSIFIER_VERSION,
    inputProjectionVersion: INPUT_PROJECTION_VERSION,
    experimentCount: cohort.experimentIds.length,
    captureCount: cohort.sourceCaptureIds.length,
    recordCount: observations.length,
    channelCounts: channelCountsOf(observations),
    metrics: computeEvaluationMetrics(observations),
    cohortDigest: cohort.cohortDigest,
    createdAt,
    immutable: true,
    descriptiveOnly: true,
    noGroundTruth: true,
    noProfitabilityInference: true,
    note: EVALUATION_NOTE,
  };
}

/**
 * Run the OFFLINE taxonomy evaluation for a cohort. Zero network calls. When
 * `save` is true, freezes the evaluation artifact under
 * `.evolve/classifier/evaluations/<evaluation-id>/evaluation.json`.
 */
export async function runEvaluation({ classifierRoot, captureRoot, cohortId, now = () => Date.now(), save = true } = {}) {
  const cohort = await requireCohort(classifierRoot, cohortId);
  const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
  const createdAt = new Date(now()).toISOString();
  const body = evaluationBody({ cohort, observations: evidence.observations, createdAt });
  const evaluationId = buildEvaluationId({ now: Date.parse(createdAt), identityDigest: evaluationIdentityDigest(body) });
  const withId = { ...body, evaluationId };
  const evaluation = { ...withId, evaluationDigest: evaluationDigestOf(withId) };

  let dir = null;
  if (save) {
    dir = evaluationDirFor(classifierRoot, evaluationId);
    await mkdir(path.dirname(dir), { recursive: true });
    await mkdir(dir).catch((error) => {
      if (error?.code === "EEXIST") throw new EvaluationExistsError(evaluationId);
      throw error;
    });
    await writeFile(path.join(dir, EVALUATION_FILE), `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
  }
  return { evaluation, dir, saved: save, evidence };
}

export async function readEvaluation(classifierRoot, evaluationId) {
  if (!isValidEvaluationId(evaluationId)) throw new CohortError(`invalid evaluation id '${evaluationId}'`);
  try {
    return JSON.parse(await readFile(path.join(evaluationDirFor(classifierRoot, evaluationId), EVALUATION_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function listEvaluations(classifierRoot) {
  try {
    return (await readdir(path.join(classifierRoot, CLASSIFIER_EVALUATIONS_SUBDIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidEvaluationId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/* ============================================================================
 * Artifact text-free audit
 * ==========================================================================*/

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const entry of value) collectKeys(entry, out);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, out);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) collectStrings(entry, out);
  return out;
}

/**
 * Prove an artifact carries no raw text, no URL, no author and no secret. Returns
 * the list of problems (empty means clean).
 */
export function auditArtifactTextFree(artifact) {
  const problems = [];
  const keys = collectKeys(artifact);
  for (const key of keys) {
    if (FORBIDDEN_ARTIFACT_KEYS.includes(key)) problems.push(`forbidden key '${key}'`);
  }
  for (const value of collectStrings(artifact)) {
    if (URL_PATTERN.test(value)) problems.push("a URL-like string is present");
  }
  return problems;
}

/** The metric containers that may appear inside `metrics` — nothing else. */
export const METRIC_TOP_LEVEL_KEYS = Object.freeze([
  "labelDistribution",
  "confidence",
  "perLabelConfidence",
  "scoreMargin",
  "scoreEntropy",
  "channels",
  "channelCoverage",
  "noise",
  "promotion",
  "concentration",
]);

/**
 * Prove the evaluation artifact carries only whitelisted keys and NONE of the
 * forbidden truth / profitability / verdict keys. Returns the list of problems.
 */
export function auditEvaluationArtifact(evaluation) {
  const problems = auditArtifactTextFree(evaluation);
  for (const key of Object.keys(evaluation ?? {})) {
    if (!EVALUATION_FIELDS.includes(key)) problems.push(`unexpected top-level key '${key}'`);
  }
  for (const key of Object.keys(evaluation?.metrics ?? {})) {
    if (!METRIC_TOP_LEVEL_KEYS.includes(key)) problems.push(`unexpected metric key '${key}'`);
  }
  for (const key of forbiddenVerdictKeys(evaluation)) problems.push(`forbidden verdict/quantity key '${key}'`);
  return problems;
}

/** Metric keys that must NEVER exist (no truth / no profitability / no verdict). */
export const FORBIDDEN_METRIC_KEYS = Object.freeze([
  "accuracy",
  "precision",
  "recall",
  "f1",
  "f1Score",
  "roc",
  "rocAuc",
  "auc",
  "calibrationError",
  "calibration",
  "groundTruth",
  "truth",
  "correct",
  "incorrect",
  "tp",
  "fp",
  "tn",
  "fn",
  "verdict",
  "passed",
  "failed",
  "return",
  "returns",
  "pnl",
  "profit",
  "profitability",
  "expectedReturn",
  "arenaScore",
  "survival",
  "gateOutcome",
  "sharpe",
  "correlation",
  "signalQuality",
  "qualityScore",
]);

/** Keys that must never appear as an artifact key at all (verdicts/profitability). */
export function forbiddenVerdictKeys(value, out = new Set()) {
  collectKeys(value, out);
  return [...out].filter((key) => FORBIDDEN_METRIC_KEYS.includes(key)).sort();
}

/* ============================================================================
 * Replay (offline, zero network)
 * ==========================================================================*/

/**
 * Re-verify a stored evaluation OFFLINE: cohort identity, every classifier
 * experiment, every source capture, and every metric — then reproduce the
 * evaluationDigest exactly. Zero network calls.
 */
export async function replayEvaluation({ classifierRoot, captureRoot, evaluationId } = {}) {
  const checks = {};
  const problems = [];
  const check = (name, ok, detail = null) => {
    checks[name] = ok === true;
    if (ok !== true) problems.push(detail ? `${name}: ${detail}` : name);
  };

  let evaluation;
  try {
    evaluation = await readEvaluation(classifierRoot, evaluationId);
  } catch (error) {
    return { ok: false, evaluationId, networkCalls: 0, checks: { evaluationReadable: false }, problems: [`evaluationReadable: ${error?.message ?? error}`] };
  }
  if (!evaluation) {
    return { ok: false, evaluationId, networkCalls: 0, checks: { evaluationReadable: false }, problems: [`evaluationReadable: '${evaluationId}' was not found`] };
  }
  check("evaluationReadable", true);
  check("evaluationId", evaluation.evaluationId === evaluationId, "the stored id differs from the directory name");
  check("evaluationDigest", evaluationDigestOf(evaluation) === evaluation.evaluationDigest, "the artifact does not match its own digest");
  check(
    "evaluationIdentity",
    evaluation.evaluationId === buildEvaluationId({ now: Date.parse(evaluation.createdAt), identityDigest: evaluationIdentityDigest(evaluation) }),
    "evaluationId does not match the derived identity",
  );
  check("frozenFlags", evaluation.immutable === true && evaluation.descriptiveOnly === true);
  check("flags", evaluation.noGroundTruth === true && evaluation.noProfitabilityInference === true);
  check("evidenceClass", evaluation.evidenceClass === COHORT_EVIDENCE_CLASS, "the evaluation is not pinned to DEVELOPMENT_CLASSIFIER_EVIDENCE");

  const artifactProblems = auditEvaluationArtifact(evaluation);
  check("noRawText", artifactProblems.length === 0, artifactProblems.slice(0, 3).join("; "));

  let cohort = null;
  try {
    cohort = await readCohort(classifierRoot, evaluation.cohortId);
  } catch (error) {
    check("cohortReadable", false, String(error?.message ?? error));
  }
  check("cohortPresent", Boolean(cohort), "the referenced cohort is missing");
  if (cohort) {
    const cohortCheck = verifyCohort(cohort);
    check("cohortIdentity", cohortCheck.ok, cohortCheck.problems.join("; "));
    check("cohortDigest", cohort.cohortDigest === evaluation.cohortDigest, "the evaluation references a different cohort digest");
    check("cohortEvidenceClass", cohort.evidenceClass === evaluation.evidenceClass);
    check("cohortClassifier", cohort.classifierId === evaluation.classifierId && cohort.classifierVersion === evaluation.classifierVersion);
    check("cohortProjection", cohort.inputProjectionVersion === evaluation.inputProjectionVersion);
  }

  try {
    const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
    check("experimentsIntegrity", true);
    check("capturesIntegrity", true);
    const body = evaluationBody({ cohort, observations: evidence.observations, createdAt: evaluation.createdAt });
    const recomputed = { ...body, evaluationId: evaluation.evaluationId };
    check("experimentCount", recomputed.experimentCount === evaluation.experimentCount, "experimentCount differs");
    check("captureCount", recomputed.captureCount === evaluation.captureCount, "captureCount differs");
    check("recordCount", recomputed.recordCount === evaluation.recordCount, "recordCount differs");
    check("channelCounts", digestOf(recomputed.channelCounts) === digestOf(evaluation.channelCounts), "channelCounts differ");
    check("metrics", digestOf(recomputed.metrics) === digestOf(evaluation.metrics), "a stored metric does not recompute");
    check(
      "evaluationDigestReproduced",
      evaluationDigestOf(recomputed) === evaluation.evaluationDigest,
      "the recomputed evaluationDigest differs from the stored one",
    );
  } catch (error) {
    check("experimentsIntegrity", false, String(error?.message ?? error));
  }

  return {
    ok: problems.length === 0,
    evaluationId,
    cohortId: evaluation.cohortId,
    evaluationDigest: evaluation.evaluationDigest,
    recomputedEvaluationDigest: evaluationDigestOf(evaluation),
    networkCalls: 0,
    checks,
    problems,
  };
}

/* ============================================================================
 * Stats (offline, zero network)
 * ==========================================================================*/

export async function evaluationStats({ classifierRoot, evaluationId } = {}) {
  const evaluation = await readEvaluation(classifierRoot, evaluationId);
  if (!evaluation) throw new EvaluationNotFoundError(evaluationId);
  const cohort = evaluation.cohortId ? await readCohort(classifierRoot, evaluation.cohortId) : null;
  const cohortCheck = cohort ? verifyCohort(cohort) : { ok: false, problems: ["the cohort is missing"] };
  const metrics = evaluation.metrics ?? {};
  const labelCounts = Object.fromEntries(
    (metrics.labelDistribution?.labels ?? []).map((entry) => [entry.label, entry.count]),
  );
  return {
    evaluationId: evaluation.evaluationId,
    cohortId: evaluation.cohortId,
    evidenceClass: evaluation.evidenceClass,
    classifierId: evaluation.classifierId,
    classifierVersion: evaluation.classifierVersion,
    inputProjectionVersion: evaluation.inputProjectionVersion,
    experimentCount: evaluation.experimentCount,
    captureCount: evaluation.captureCount,
    recordCount: evaluation.recordCount,
    channelCounts: evaluation.channelCounts,
    labelCounts,
    labelFractions: Object.fromEntries((metrics.labelDistribution?.labels ?? []).map((entry) => [entry.label, entry.fraction])),
    meanConfidence: metrics.confidence?.mean ?? null,
    medianConfidence: metrics.confidence?.median ?? null,
    ambiguityFractions: Object.fromEntries(Object.entries(metrics.scoreMargin?.bands ?? {}).map(([id, band]) => [id, band.fraction])),
    labelDiversity: metrics.labelDistribution?.labelDiversity ?? null,
    noiseFraction: metrics.noise?.fraction ?? null,
    promotionFraction: metrics.promotion?.fraction ?? null,
    largestLabel: metrics.concentration?.largestLabel ?? null,
    largestLabelFraction: metrics.concentration?.largestLabelFraction ?? null,
    cohortDigest: evaluation.cohortDigest,
    cohortDigestOk: Boolean(cohort) && cohort.cohortDigest === evaluation.cohortDigest,
    cohortOk: cohortCheck.ok,
    resultDigests: cohort?.resultDigests ?? {},
    evaluationDigest: evaluation.evaluationDigest,
    evaluationDigestOk: evaluationDigestOf(evaluation) === evaluation.evaluationDigest,
    createdAt: evaluation.createdAt,
    networkCalls: 0,
  };
}

/* ============================================================================
 * Human audit view (EPHEMERAL, terminal only: NO artifact is ever written)
 * ==========================================================================*/

const AUDIT_EXCERPT_CHARS = 160;

function auditExcerpt(record) {
  const parts = [];
  if (typeof record?.title === "string" && record.title.trim().length > 0) parts.push(record.title);
  if (typeof record?.textExcerpt === "string" && record.textExcerpt.trim().length > 0) parts.push(record.textExcerpt);
  if (parts.length === 0) return null;
  let text = normalizeClassifierWhitespace(parts.join(" "));
  text = redactClassifierText(text);
  text = replaceEmbeddedUrls(text);
  if (text.length > AUDIT_EXCERPT_CHARS) text = `${text.slice(0, AUDIT_EXCERPT_CHARS)}…`;
  return text;
}

function topTwoWithLabels(scores) {
  const entries = CLASSIFIER_LABELS.map((label) => ({
    label,
    score: typeof scores?.[label] === "number" && Number.isFinite(scores[label]) ? scores[label] : 0,
  })).sort((a, b) => (b.score - a.score) || (CLASSIFIER_LABELS.indexOf(a.label) - CLASSIFIER_LABELS.indexOf(b.label)));
  return entries.slice(0, 2);
}

function toAuditRow(observation, sourceByDigest) {
  const source = sourceByDigest.get(observation.recordDigest);
  return {
    recordDigest: String(observation.recordDigest).slice(0, 12),
    channel: observation.channel,
    excerpt: auditExcerpt(source),
    label: observation.label,
    confidence: observation.confidence,
    topScores: topTwoWithLabels(observation.scores),
  };
}

function byDigestAscending(a, b) {
  return a.recordDigest < b.recordDigest ? -1 : a.recordDigest > b.recordDigest ? 1 : 0;
}

/**
 * Deterministic audit sample: up to `perLabel` observations per observed label,
 * selected by LOWEST digest order per label. No randomness. Terminal only.
 */
export async function buildAuditSample({ classifierRoot, captureRoot, cohortId, perLabel = 3 } = {}) {
  const perLabelCount = Math.max(1, Math.min(50, Math.round(Number(perLabel) || 3)));
  const cohort = await requireCohort(classifierRoot, cohortId);
  const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
  const rows = [];
  for (const label of CLASSIFIER_LABELS) {
    const matching = evidence.observations.filter((row) => row.label === label).sort(byDigestAscending);
    for (const observation of matching.slice(0, perLabelCount)) rows.push(toAuditRow(observation, evidence.sourceByDigest));
  }
  return { cohortId, evidenceClass: cohort.evidenceClass, perLabel: perLabelCount, rows, networkCalls: 0 };
}

/**
 * Deterministic LOW-CONFIDENCE audit: the `limit` lowest-confidence records
 * (tie-broken by digest). Default 20, clamped to 1..100. Terminal only.
 */
export async function buildLowConfidenceAudit({ classifierRoot, captureRoot, cohortId, limit = 20 } = {}) {
  const requested = Number(limit === true ? 20 : limit);
  const count = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.round(requested))) : 20;
  const cohort = await requireCohort(classifierRoot, cohortId);
  const evidence = await collectCohortEvidence({ classifierRoot, captureRoot, cohort, verifyIntegrity: true });
  const ordered = [...evidence.observations].sort((a, b) => (a.confidence - b.confidence) || byDigestAscending(a, b));
  const rows = ordered.slice(0, count).map((observation) => toAuditRow(observation, evidence.sourceByDigest));
  return { cohortId, evidenceClass: cohort.evidenceClass, limit: count, rows, networkCalls: 0 };
}
