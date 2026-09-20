/**
 * Phase 5I.0b — OFFLINE integrity audits (§23, §24, §32).
 *
 * Two DISTINCT concepts, never conflated:
 *
 *   LOOKAHEAD FAILURE (hard)
 *     Future information changes a historically frozen value:
 *       feature(history <= t0, t0) !== feature(history <= tFuture, t0)
 *
 *   RECURSIVE / STARTUP INSTABILITY (diagnostic)
 *     Different VALID pre-t0 startup histories change the value. That is a
 *     warmup/stability property, not leakage, and it is REPORTED, never
 *     punished as lookahead.
 *
 * The lookahead audit is behavioural: it appends future observations to a stored
 * pre-outcome input projection and RECOMPUTES the feature/baseline for the same
 * earlier target. It is not a source-code scan for suspicious constructs.
 *
 * Nothing in this module writes anything, calls a provider, or touches the
 * network. `--audit` and `--replay` are read-only and produce no canonical
 * evidence.
 */

import { digestOf } from "../../lib/hash.mjs";
import { computeBaselines } from "./baselines.mjs";
import {
  DIRECTION_FEATURE_NAMES,
  MINIMUM_WARMUP,
  extractDirectionFeaturesFromInputs,
} from "./features.mjs";
import { DIRECTION_PHASE } from "./definition.mjs";

export const DIRECTION_AUDIT_VERSION = 1;

/** Startup lengths exercised by the recursive-stability audit, when data permits. */
export const FEATURE_STABILITY_STARTUP_LENGTHS = Object.freeze([30, 60, 120, 240]);

/** Numeric tolerance for "the same value". Deliberately extremely tight. */
export const FEATURE_STABILITY_TOLERANCE = 1e-9;

/** How many target observations the stability audit examines. */
export const FEATURE_STABILITY_MAX_TARGETS = 8;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function maxAbsoluteDifference(a, b) {
  if (a === null && b === null) return 0;
  if (a === null || b === null) return Infinity;
  return Math.abs(a - b);
}

/** Field-by-field difference report between two recomputed values. */
export function diffFeatureValues(a, b) {
  const differences = [];
  for (const name of DIRECTION_FEATURE_NAMES) {
    const left = a?.[name] ?? null;
    const right = b?.[name] ?? null;
    if (left !== right) differences.push({ name, frozen: left, recomputed: right });
  }
  return differences;
}

/**
 * Build the ordered audit observation list from persisted prediction artifacts.
 * Only observations with a persisted pre-outcome input projection take part: an
 * observation whose market state was never observable has nothing to recompute.
 */
export function buildAuditObservations(predictions = []) {
  return (predictions ?? [])
    .filter((prediction) => prediction?.preOutcomeInputs && prediction?.featureValues)
    .slice()
    .sort((a, b) => (a.observationIndex ?? 0) - (b.observationIndex ?? 0))
    .map((prediction) => ({
      observationId: prediction.observationId,
      observationIndex: prediction.observationIndex ?? 0,
      receivedAt: prediction.receivedAt ?? prediction.stateObservedAt ?? null,
      stateDigest: prediction.stateDigest ?? null,
      inputs: prediction.preOutcomeInputs,
      features: prediction.featureValues,
      baselines: prediction.baselines ?? null,
    }));
}

/**
 * THE LOOKAHEAD AUDIT (§23).
 *
 * For every observation:
 *   1. take the stored pre-t0 history (history <= t0);
 *   2. recompute the value -> `frozen`;
 *   3. append observations strictly AFTER t0 to the history;
 *   4. recompute the SAME t0 again;
 *   5. require an exact match.
 *
 * `computeFor` receives `{ inputs }` and returns the value under test, so the
 * same engine audits features AND baselines (and, in the validator, a
 * deliberately poisoned variant that proves the audit detects leakage).
 */
export function auditHistoryRecomputation({ observations = [], computeFor, label = "value" }) {
  const violations = [];
  let checked = 0;
  let recomputationPairs = 0;
  let claimed = 0;

  for (let index = 0; index < observations.length; index += 1) {
    const target = observations[index];
    const claimedValue = target.claimed ?? null;
    if (claimedValue !== null) {
      claimed += 1;
      if (claimedValue !== undefined && digestOf(claimedValue) !== digestOf(computeFor({ inputs: target.inputs, observation: target }))) {
        violations.push({
          kind: "stored-value-mismatch",
          label,
          observationId: target.observationId,
          detail: "the stored value does not reproduce from the stored pre-outcome inputs",
        });
      }
    }

    const frozen = computeFor({ inputs: target.inputs, observation: target });
    checked += 1;

    for (let future = index + 1; future < observations.length; future += 1) {
      const appended = observations.slice(index + 1, future + 1).map((entry) => ({
        observedAt: entry.receivedAt ?? null,
        observedAtMs: finiteOrNull(Date.parse(entry.receivedAt ?? "")),
        priceUsd: finiteOrNull(entry.inputs?.market?.price),
      }));
      const poisonedInputs = {
        ...target.inputs,
        history: [...(target.inputs.history ?? []), ...appended],
      };
      const recomputed = computeFor({ inputs: poisonedInputs, observation: target });
      recomputationPairs += 1;
      if (digestOf(frozen) !== digestOf(recomputed)) {
        violations.push({
          kind: "lookahead",
          label,
          observationId: target.observationId,
          futureAppendedThrough: observations[future].observationId,
          differences: diffFeatureValues(frozen, recomputed).slice(0, 12),
        });
      }
    }
  }

  return {
    auditVersion: DIRECTION_AUDIT_VERSION,
    phase: DIRECTION_PHASE,
    label,
    ok: violations.length === 0,
    checkedObservations: checked,
    recomputationPairs,
    claimedValueChecks: claimed,
    violations: violations.slice(0, 25),
    note:
      "BEHAVIOURAL lookahead audit: future observations are appended and the historical value is recomputed. " +
      "No new canonical evidence is produced by this audit.",
  };
}

/** Feature-level lookahead audit over persisted pre-outcome inputs. */
export function auditFeatureLookahead(observations) {
  return auditHistoryRecomputation({
    observations,
    label: "features",
    computeFor: ({ inputs }) => extractDirectionFeaturesFromInputs(inputs).features,
  });
}

/** Baseline-level lookahead audit: baselines are recomputed from the SAME audited features. */
export function auditBaselineLookahead(observations) {
  const withClaimed = observations.map((entry) => ({ ...entry, claimed: entry.baselines ?? null }));
  return auditHistoryRecomputation({
    observations: withClaimed,
    label: "baselines",
    // Recomputed with the SAME frozen-state provenance the artifact pinned, so a
    // `stateDigest` difference is never mistaken for a lookahead failure.
    computeFor: ({ inputs, observation }) =>
      computeBaselines(extractDirectionFeaturesFromInputs(inputs).features, {
        stateDigest: observation?.stateDigest ?? null,
      }),
  });
}

/** Same-state fairness + reproducibility check between the stored artifact and a clean recomputation. */
export function auditStoredStateConsistency(observations) {
  const problems = [];
  for (const entry of observations) {
    const recomputed = extractDirectionFeaturesFromInputs(entry.inputs).features;
    if (digestOf(recomputed) !== digestOf(entry.features)) {
      problems.push({ observationId: entry.observationId, detail: "stored feature values do not reproduce from the stored inputs" });
      continue;
    }
    // Same-state fairness is checked FIRST and per baseline: a baseline pinned to
    // a foreign state is reported as exactly that, not as a vague "does not
    // reproduce". A shared, consistent state digest must still recompute.
    let digestMismatch = false;
    for (const [baselineId, baseline] of Object.entries(entry.baselines ?? {})) {
      if (baseline?.stateDigest !== null && baseline?.stateDigest !== entry.stateDigest) {
        digestMismatch = true;
        problems.push({
          observationId: entry.observationId,
          detail: `baseline '${baselineId}' did not consume the same frozen state (${baseline?.stateDigest} != ${entry.stateDigest})`,
        });
      }
    }
    if (digestMismatch) continue;
    const recomputedBaselines = computeBaselines(recomputed, { stateDigest: entry.stateDigest ?? null });
    if (digestOf(recomputedBaselines) !== digestOf(entry.baselines)) {
      problems.push({ observationId: entry.observationId, detail: "stored baselines do not reproduce from the frozen state" });
      continue;
    }
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 25), checkedObservations: observations.length };
}

/**
 * The EXACT optional inputs `evaluateDirectionExperiment` needs so that a
 * metrics digest computed at finalize time, at replay time and at stats time is
 * byte-identical. Using one helper for all three is what makes "the summary
 * digest reproduces" a real property rather than an accident of call ordering.
 */
export function collectOfflineAuditInputs(predictions = []) {
  const observations = buildAuditObservations(predictions);
  const lookahead = auditDirectionLookahead({ predictions });
  const featureStability = auditFeatureStability({ observations });
  return {
    observations,
    lookahead,
    featureStability,
    lookaheadAudit: {
      ok: lookahead.ok,
      featureViolations: lookahead.features.violations.length,
      baselineViolations: lookahead.baselines.violations.length,
    },
  };
}

/** The full offline lookahead audit report (§31 support). */
export function auditDirectionLookahead({ predictions = [] } = {}) {
  const observations = buildAuditObservations(predictions);
  const features = auditFeatureLookahead(observations);
  const baselines = auditBaselineLookahead(observations);
  const consistency = auditStoredStateConsistency(observations);
  return {
    auditVersion: DIRECTION_AUDIT_VERSION,
    phase: DIRECTION_PHASE,
    ok: features.ok && baselines.ok && consistency.ok,
    observationCount: observations.length,
    features,
    baselines,
    storedStateConsistency: consistency,
    canonicalEvidencePersisted: false,
    note:
      "Offline integrity test only: it persists no canonical evidence and changes no frozen artifact.",
  };
}

/**
 * RECURSIVE / STARTUP STABILITY AUDIT (§24, §32).
 *
 * The SAME target observation is recomputed with several valid pre-t0 startup
 * histories. Numerical divergence between startup lengths is REPORTED per
 * feature; it is never described as lookahead. Observations lacking sufficient
 * warmup produce nulls, which are counted separately instead of being invented.
 */
export function auditFeatureStability({
  observations = [],
  startupLengths = FEATURE_STABILITY_STARTUP_LENGTHS,
  tolerance = FEATURE_STABILITY_TOLERANCE,
  maxTargets = FEATURE_STABILITY_MAX_TARGETS,
} = {}) {
  const targets = observations.slice(-Math.max(1, maxTargets));
  const diagnostics = {};
  for (const name of DIRECTION_FEATURE_NAMES) {
    diagnostics[name] = {
      minimumWarmup: MINIMUM_WARMUP[name] ?? 0,
      testedStartupLengths: [],
      maxAbsoluteDifference: 0,
      comparisons: 0,
      nullDivergenceCount: 0,
      stableWithinTolerance: true,
    };
  }

  let tested = 0;
  for (const target of targets) {
    const priorSeries = observations
      .filter((entry) => (entry.observationIndex ?? 0) < (target.observationIndex ?? 0))
      .map((entry) => ({
        observedAt: entry.receivedAt ?? null,
        observedAtMs: finiteOrNull(Date.parse(entry.receivedAt ?? "")),
        priceUsd: finiteOrNull(entry.inputs?.market?.price),
      }));
    if (priorSeries.length === 0) continue;

    const lengths = [...new Set([...startupLengths.filter((length) => length <= priorSeries.length), priorSeries.length])]
      .filter((length) => length > 0)
      .sort((a, b) => a - b);
    if (lengths.length === 0) continue;
    tested += 1;

    const valuesByLength = new Map();
    for (const length of lengths) {
      const inputs = { ...target.inputs, history: priorSeries.slice(-length) };
      valuesByLength.set(length, extractDirectionFeaturesFromInputs(inputs).features);
    }

    for (const name of DIRECTION_FEATURE_NAMES) {
      const entry = diagnostics[name];
      entry.testedStartupLengths = [...new Set([...entry.testedStartupLengths, ...lengths])].sort((a, b) => a - b);
      const values = lengths.map((length) => valuesByLength.get(length)?.[name] ?? null);
      const baseline = values[values.length - 1] ?? null;
      for (const value of values) {
        entry.comparisons += 1;
        if (value === null || baseline === null) {
          if (value !== baseline) entry.nullDivergenceCount += 1;
          continue;
        }
        const delta = maxAbsoluteDifference(value, baseline);
        if (Number.isFinite(delta)) entry.maxAbsoluteDifference = Math.max(entry.maxAbsoluteDifference, delta);
      }
      entry.stableWithinTolerance = entry.maxAbsoluteDifference <= tolerance;
    }
  }

  return {
    auditVersion: DIRECTION_AUDIT_VERSION,
    phase: DIRECTION_PHASE,
    testedObservations: tested,
    requestedStartupLengths: [...startupLengths],
    tolerance,
    diagnostics,
    lookaheadFailuresReported: 0,
    note:
      "DIAGNOSTICS ONLY. Startup-length divergence is NOT lookahead: it is a warmup property. Values are never " +
      "ranked, never used to tune warmup, and never tuned against target outcomes.",
  };
}
