/**
 * Phase 5I.0b — deterministic baselines.
 *
 * The point of the baselines is falsification: if direct TypeSafe Jev cannot beat
 * a constant, a one-line momentum rule, or a one-line mean-reversion rule, then
 * it contains no short-horizon directional information worth reporting.
 *
 * Every baseline:
 *   - is a FROZEN formula with pre-registered constants (defined in this file,
 *     before any benchmark outcome existed),
 *   - is a pure function of genuinely observed PRE-t0 features only,
 *   - uses NO fitting against benchmark outcomes, NO post-hoc coefficient
 *     optimization, NO LLM, and NO random seed,
 *   - produces `pHigher` and `pLower = 1 - pHigher`,
 *   - falls back to the neutral 0.50 when a required input was not observed
 *     (recorded as `inputsMissing`), never to a guessed value.
 *
 * Where a name could be misread, the name says what the data really is:
 * `volume-flow-imbalance-v1` is built from the VENUE'S 5m aggregated buy/sell
 * volumes. It is NOT order-book imbalance and NOT CVD — EVOLVE observes neither.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { clamp } from "../../market/normalize.mjs";
import { DIRECTION_PHASE } from "./definition.mjs";
import { warmupRequiredForInputs } from "./features.mjs";

export const BASELINE_DEFINITION_VERSION = 1;

/** Pre-registered constants. Changing any of these changes the definition digest. */
export const BASELINE_CONSTANTS = Object.freeze({
  neutralProbability: 0.5,
  probabilityFloor: 0.05,
  probabilityCeiling: 0.95,
  /** A 10 bps short-horizon return saturates the momentum z-score. */
  momentumScale: 0.001,
  /** A (±)0.5 buy/sell volume imbalance saturates the flow z-score. */
  flowImbalanceScale: 0.5,
  /** A 5% 5m liquidity change saturates the liquidity z-score. */
  liquidityChangePctScale: 5,
  /** Maximum deviation from 0.50 any single-signal baseline may produce. */
  maxDeviation: 0.5,
});

/**
 * FROZEN baseline definitions. `formula` is the human-readable, exact rule; the
 * digest of this whole object is what every experiment and prediction pins.
 */
export const BASELINE_DEFINITIONS = Object.freeze({
  "neutral-v1": {
    baselineId: "neutral-v1",
    version: 1,
    requiredInputs: [],
    formula: "pHigher = 0.50",
    description: "Constant neutral forecast. The reference every other number must beat to be interesting.",
  },
  "momentum-v1": {
    baselineId: "momentum-v1",
    version: 1,
    requiredInputs: ["recentReferenceReturn1"],
    formula:
      "z = clamp(recentReferenceReturn1 / 0.001, -1, 1); pHigher = clamp(0.5 + 0.5 * z * 0.5, 0.05, 0.95); neutral " +
      "0.50 (and NON-SCORABLE for this baseline) when recentReferenceReturn1 is null",
    description: "Short-horizon continuation of the market's own last observed reference move.",
  },
  "mean-reversion-v1": {
    baselineId: "mean-reversion-v1",
    version: 1,
    requiredInputs: ["recentReferenceReturn1"],
    formula:
      "z = clamp(recentReferenceReturn1 / 0.001, -1, 1); pHigher = clamp(0.5 - 0.5 * z * 0.5, 0.05, 0.95); neutral " +
      "0.50 (and NON-SCORABLE for this baseline) when recentReferenceReturn1 is null",
    description: "Short-horizon fade of the market's own last observed reference move (the rival of momentum-v1).",
  },
  "volume-flow-imbalance-v1": {
    baselineId: "volume-flow-imbalance-v1",
    version: 1,
    requiredInputs: ["observed5mVolumeFlowImbalance"],
    formula:
      "z = clamp(observed5mVolumeFlowImbalance / 0.5, -1, 1); pHigher = clamp(0.5 + 0.5 * z * 0.5, 0.05, 0.95); " +
      "neutral 0.50 (and NON-SCORABLE) when the input is null",
    description:
      "5m aggregated buy/sell VOLUME FLOW imbalance from the venue's own stats5m. NOT order-book imbalance, NOT CVD, " +
      "NOT queue depth, NOT maker flow.",
  },
  "momentum-liquidity-v1": {
    baselineId: "momentum-liquidity-v1",
    version: 1,
    requiredInputs: ["recentReferenceReturn1", "observedLiquidityChangePct"],
    formula:
      "momentumZ = clamp(recentReferenceReturn1 / 0.001, -1, 1); liquidityZ = clamp(observedLiquidityChangePct / 5, " +
      "-1, 1); combined = clamp((momentumZ + liquidityZ) / 2, -1, 1); pHigher = clamp(0.5 + 0.5 * combined * 0.5, " +
      "0.05, 0.95); neutral 0.50 (and NON-SCORABLE) when either input is null",
    description: "Continuation biased by the observed 5m liquidity trend (a two-field deterministic rule).",
  },
});

export const BASELINE_IDS = Object.freeze(Object.keys(BASELINE_DEFINITIONS));

/** The minimum baseline set every 5I experiment must produce. */
export const REQUIRED_BASELINE_IDS = Object.freeze(["neutral-v1", "momentum-v1", "mean-reversion-v1"]);

/** Optional baselines, present because the required observed fields genuinely exist. */
export const OPTIONAL_BASELINE_IDS = Object.freeze(["volume-flow-imbalance-v1", "momentum-liquidity-v1"]);

export const BASELINE_DEFINITION = Object.freeze({
  phase: DIRECTION_PHASE,
  definitionVersion: BASELINE_DEFINITION_VERSION,
  constants: BASELINE_CONSTANTS,
  baselines: BASELINE_DEFINITIONS,
  required: REQUIRED_BASELINE_IDS,
  optional: OPTIONAL_BASELINE_IDS,
  fittedAgainstBenchmarkOutcomes: false,
  llmUsed: false,
  randomSeedUsed: false,
});

export const BASELINE_DEFINITION_DIGEST = digestOf(BASELINE_DEFINITION);

function probabilityOf(pHigher) {
  const bounded = clamp(pHigher, BASELINE_CONSTANTS.probabilityFloor, BASELINE_CONSTANTS.probabilityCeiling);
  return bounded;
}

function clampSignedUnit(value) {
  return clamp(value, -1, 1);
}

/**
 * Compute one baseline. Pure and total: a missing input yields the neutral 0.50
 * with the missing input named, never a guess and never a crash.
 *
 * SAME-STATE FAIRNESS (§30): the baseline is a pure function of the frozen
 * `features` object Jev's packet was built from, and the returned entry pins the
 * `stateDigest` + `baselineDefinitionDigest` so a replay can PROVE the baseline
 * saw exactly the same frozen state. A baseline that had to fall back to neutral
 * is explicitly NON-SCORABLE (`scorableForMetrics: false`) instead of being
 * scored at a made-up 0.50.
 */
export function computeBaseline(baselineId, features = {}, { stateDigest = null } = {}) {
  const definition = BASELINE_DEFINITIONS[baselineId];
  if (!definition) return null;

  const inputsMissing = definition.requiredInputs.filter((name) => !Number.isFinite(features?.[name]));
  const requiredWarmupObservations = warmupRequiredForInputs(definition.requiredInputs);
  const priorObservationCount = Number.isFinite(features?.priorObservationCount) ? features.priorObservationCount : 0;
  const neutral = BASELINE_CONSTANTS.neutralProbability;

  let pHigher = neutral;
  let inputs = {};

  if (inputsMissing.length === 0) {
    const momentumZ = Number.isFinite(features.recentReferenceReturn1)
      ? clampSignedUnit(features.recentReferenceReturn1 / BASELINE_CONSTANTS.momentumScale)
      : null;
    const flowZ = Number.isFinite(features.observed5mVolumeFlowImbalance)
      ? clampSignedUnit(features.observed5mVolumeFlowImbalance / BASELINE_CONSTANTS.flowImbalanceScale)
      : null;
    const liquidityZ = Number.isFinite(features.observedLiquidityChangePct)
      ? clampSignedUnit(features.observedLiquidityChangePct / BASELINE_CONSTANTS.liquidityChangePctScale)
      : null;

    switch (baselineId) {
      case "neutral-v1":
        pHigher = neutral;
        inputs = {};
        break;
      case "momentum-v1":
        pHigher = 0.5 + BASELINE_CONSTANTS.maxDeviation * momentumZ * 0.5;
        inputs = { recentReferenceReturn1: features.recentReferenceReturn1, momentumZ };
        break;
      case "mean-reversion-v1":
        pHigher = 0.5 - BASELINE_CONSTANTS.maxDeviation * momentumZ * 0.5;
        inputs = { recentReferenceReturn1: features.recentReferenceReturn1, momentumZ };
        break;
      case "volume-flow-imbalance-v1":
        pHigher = 0.5 + BASELINE_CONSTANTS.maxDeviation * flowZ * 0.5;
        inputs = { observed5mVolumeFlowImbalance: features.observed5mVolumeFlowImbalance, flowZ };
        break;
      case "momentum-liquidity-v1": {
        const combined = clampSignedUnit((momentumZ + liquidityZ) / 2);
        pHigher = 0.5 + BASELINE_CONSTANTS.maxDeviation * combined * 0.5;
        inputs = {
          recentReferenceReturn1: features.recentReferenceReturn1,
          observedLiquidityChangePct: features.observedLiquidityChangePct,
          momentumZ,
          liquidityZ,
          combined,
        };
        break;
      }
      default:
        pHigher = neutral;
        inputs = {};
        break;
    }
  }

  const bounded = probabilityOf(pHigher);
  return {
    baselineId,
    baselineVersion: definition.version,
    definitionDigest: BASELINE_DEFINITION_DIGEST,
    // Same-state provenance: what frozen state this baseline consumed.
    stateDigest: typeof stateDigest === "string" ? stateDigest : null,
    formula: definition.formula,
    pHigher: bounded,
    pLower: 1 - bounded,
    inputs,
    inputsMissing,
    fellBackToNeutral: inputsMissing.length > 0,
    // A neutral fallback is NOT a prediction; it is excluded from that baseline's
    // metrics rather than scored as a fake 0.50 call (§24 warmup discipline).
    scorableForMetrics: inputsMissing.length === 0,
    priorObservationCount,
    requiredWarmupObservations,
    warmupComplete: priorObservationCount >= requiredWarmupObservations,
  };
}

/** Compute every frozen baseline for one feature vector. Deterministic and total. */
export function computeBaselines(features = {}, { stateDigest = null } = {}) {
  const out = {};
  for (const baselineId of BASELINE_IDS) out[baselineId] = computeBaseline(baselineId, features, { stateDigest });
  return out;
}

/**
 * Audit a persisted baseline block: ids complete, probabilities finite and in
 * (0,1), `pLower = 1 - pHigher` exactly, and definition digests pinned.
 */
export function auditBaselines(baselines) {
  const problems = [];
  if (!baselines || typeof baselines !== "object") return { ok: false, problems: ["baselines is not an object"] };
  for (const baselineId of BASELINE_IDS) {
    const entry = baselines[baselineId];
    if (!entry) {
      problems.push(`missing baseline '${baselineId}'`);
      continue;
    }
    if (entry.baselineId !== baselineId) problems.push(`baseline '${baselineId}' reports id '${entry.baselineId}'`);
    if (!Number.isFinite(entry.pHigher) || entry.pHigher <= 0 || entry.pHigher >= 1) {
      problems.push(`baseline '${baselineId}' pHigher is not a valid probability`);
    }
    if (!Number.isFinite(entry.pLower) || Math.abs(entry.pLower - (1 - entry.pHigher)) > 1e-12) {
      problems.push(`baseline '${baselineId}' pLower !== 1 - pHigher`);
    }
    if (entry.definitionDigest !== BASELINE_DEFINITION_DIGEST) {
      problems.push(`baseline '${baselineId}' pins a different definition digest`);
    }
    if (entry.scorableForMetrics === true && entry.fellBackToNeutral !== false) {
      problems.push(`baseline '${baselineId}' claims to be scorable while reporting a neutral fallback`);
    }
  }
  return { ok: problems.length === 0, problems };
}
