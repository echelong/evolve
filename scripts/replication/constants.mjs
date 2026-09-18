/**
 * Phase 5C — multi-dataset replication constants (PAPER ONLY).
 *
 * Phase 5B answered "did the DeepSeek research cohort beat mock on ONE replay?".
 * Phase 5C asks a different, narrower question:
 *
 *   "Do the observed Research-vs-Conventional deltas REPLICATE across multiple
 *    independent real-market datasets?"
 *
 * The unit of replication is the DATASET, never an individual genome, and never
 * a walk-forward window sliced out of one capture. Everything here is a frozen
 * constant or an explicitly declared status vocabulary; nothing here trades,
 * signs, or executes anything, and nothing here requires a research provider at
 * evaluation time (the frozen cohorts already exist as compiled genomes).
 *
 * Sampling rule of thumb used throughout: pick datasets BEFORE looking at any
 * result. Eligibility is performance-blind by construction — no function in this
 * phase can even see a strategy metric while deciding what to evaluate.
 */

import path from "node:path";

export const REPLICATION_SCHEMA_VERSION = 1;
export const PHASE = "5C";

/** Default freeze label (`npm run replicate:research -- --freeze phase5c`). */
export const DEFAULT_FREEZE_VERSION = "phase5c";

export const REPLICATION_DIR = path.join(".evolve", "replication");
export const FREEZE_FILE = "phase5c-freeze.json";
export const COHORTS_DIR = "cohorts";
export const COHORT_MANIFEST_FILE = "cohort-manifest.json";
export const RUN_MANIFEST_FILE = "manifest.json";
export const RUN_SUMMARY_FILE = "summary.json";
export const RUN_STATUS_FILE = "status.json";
export const RUN_UNITS_DIR = "units";
export const RUN_ARENAS_DIR = "arenas";

/**
 * Per (provider × dataset) experiment status. Persisted after every unit so a
 * multi-hour, multi-dataset run can be resumed without redoing finished work.
 */
export const UNIT_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  INVALID_DATASET: "INVALID_DATASET",
  CONTAMINATED: "CONTAMINATED",
  SKIPPED: "SKIPPED",
});

/** Statuses a resumed run will NOT re-execute without an explicit `--rerun`. */
export const TERMINAL_UNIT_STATUSES = Object.freeze([
  UNIT_STATUS.COMPLETED,
  UNIT_STATUS.INVALID_DATASET,
  UNIT_STATUS.CONTAMINATED,
  UNIT_STATUS.SKIPPED,
]);

/** Dataset classification (mirrors the Phase 3 recorder labels conservatively). */
export const DATASET_CLASS = Object.freeze({
  REAL: "REAL",
  SYNTHETIC: "SYNTHETIC",
  MIXED: "MIXED",
  INVALID: "INVALID",
});

/** Why a dataset is (or is not) part of the primary replication sample. */
export const DATASET_ROLE = Object.freeze({
  DEVELOPMENT: "DEVELOPMENT",
  REPLICATION: "REPLICATION",
  CONTAMINATED: "CONTAMINATED",
  UNKNOWN: "UNKNOWN",
  INELIGIBLE: "INELIGIBLE",
  NON_REAL: "NON_REAL",
  INVALID: "INVALID",
});

/** Per (research cohort × dataset) leakage classification. */
export const LEAKAGE_CLASS = Object.freeze({
  DEVELOPMENT: "DEVELOPMENT",
  CONTAMINATED: "CONTAMINATED",
  CLEAN_REPLICATION: "CLEAN_REPLICATION",
  UNKNOWN: "UNKNOWN",
});

/** Descriptive replication status. Never a winner rating. */
export const REPLICATION_STATUS = Object.freeze({
  NO_REPLICATION_EVIDENCE: "NO_REPLICATION_EVIDENCE",
  SINGLE_REPLICATION: "SINGLE_REPLICATION",
  LIMITED_REPLICATION: "LIMITED_REPLICATION",
  MULTI_DATASET_REPLICATION: "MULTI_DATASET_REPLICATION",
  INSUFFICIENT_INDEPENDENT_REAL_DATASETS: "INSUFFICIENT_INDEPENDENT_REAL_DATASETS",
});

/** Minimum CLEAN datasets required before a multi-dataset claim is even described. */
export const MIN_CLEAN_FOR_MULTI = 3;
/** Below this many CLEAN datasets the primary replication run refuses to execute. */
export const MIN_CLEAN_TO_RUN = 2;

/**
 * The dataset used to DEVELOP the research cohorts and the Phase 5B comparison.
 * It is a legitimate historical benchmark and is NEVER presented as an
 * independent replication sample.
 */
export const DEVELOPMENT_DATASET_IDS = Object.freeze(["session-20260917T164922Z-live"]);

/**
 * FROZEN evaluation configuration.
 *
 * Every value here is a *declared* experimental constant, not a knob to be
 * turned after seeing a result. It mirrors the canonical Phase 5B A/B arenas
 * (`arena-20260918T081727Z`, `arena-20260918T120841Z`) so Phase 5C reproduces
 * the same experiment against different market samples instead of inventing a
 * new one.
 */
export const FROZEN_RUN_CONFIG = Object.freeze({
  population: 200,
  researchShare: 0.5,
  generations: 30,
  workers: 8,
  seeds: Object.freeze(["evolve", "evolve-2"]),
  stressProfiles: Object.freeze(["mild", "moderate"]),
  survivorFraction: 0.3,
  breederShare: 0.35,
  mutationScale: 0.07,
  crossoverRate: 0.48,
  immigrantRate: 0.1,
  randomImmigrantShare: 0.15,
  championShare: 0.35,
  immigrantShare: 0.15,
  speciesMatchMode: "species-matched",
  noCloning: true,
  crossCohortCrossover: false,
  equalStartingSlots: true,
  equalEvolutionaryRules: true,
  equalScoring: true,
  equalGates: true,
  scoringBonusForEitherCohort: 0,
  bootstrapIterations: 2000,
  bootstrapSeed: "evolve-ab-bootstrap-v1",
  maxWindows: null,
});

/** Frozen evidence gates (mirrors the Arena's own deployment gate table). */
export const FROZEN_EVIDENCE_THRESHOLDS = Object.freeze({
  minTrades: 20,
  minDistinctMints: 4,
  minObservations: 200,
  minExposureTicks: 40,
});

/** Concentration / catastrophic bounds carried explicitly into the freeze. */
export const FROZEN_CONCENTRATION_BOUNDS = Object.freeze({
  maxDrawdown: 0.5,
  maxTopMintShare: 0.5,
  minArenaScore: 50,
  requireMildStressSurvival: true,
  requireNoCatastrophic: true,
});

/** Frozen research-cohort provider identities. */
export const FROZEN_COHORT_KEYS = Object.freeze(["mock", "deepseek"]);

/** Dataset-level bootstrap defaults (deterministic). */
export const DATASET_BOOTSTRAP_DEFAULTS = Object.freeze({
  iterations: 2000,
  seed: "evolve-phase5c-dataset-bootstrap-v1",
});

/**
 * Explicit Phase 5C dataset eligibility criteria, declared BEFORE any run.
 *
 * `performanceBlind: true` is not decoration: no eligibility function in this
 * module receives a metric, score, return, rank, or gate outcome, so selection
 * cannot be steered by how the research cohort happens to perform.
 */
export const ELIGIBILITY_CRITERIA = Object.freeze({
  performanceBlind: true,
  requireReal: true,
  requireComplete: true,
  requireFingerprint: true,
  maxFeedErrors: 0,
  maxRateLimits: 0,
  minDurationMs: 30 * 60 * 1000,
  minObservations: 200,
  minUniqueMints: 30,
  requireNoOverlapWithSelected: true,
  requireCleanLeakage: true,
  excludeDevelopmentDatasets: true,
  excludeDuplicateFingerprints: true,
});

/** Human-readable criterion text shipped in the artifact. */
export const ELIGIBILITY_CRITERIA_TEXT = Object.freeze({
  real: "REAL market observations only (the recorder's own live-only / usableForRealMarketReplay labels)",
  complete: "dataset status must be `complete` (an interrupted capture is not a replication sample)",
  fingerprint: "a valid SHA-256 dataset fingerprint must be present and computable",
  feedErrors: `feed errors <= ${ELIGIBILITY_CRITERIA.maxFeedErrors} and rate limits <= ${ELIGIBILITY_CRITERIA.maxRateLimits}`,
  duration: `duration >= ${ELIGIBILITY_CRITERIA.minDurationMs / 60000} minutes of real observations`,
  observations: `observations >= ${ELIGIBILITY_CRITERIA.minObservations}`,
  mints: `unique mints >= ${ELIGIBILITY_CRITERIA.minUniqueMints}`,
  overlap: "zero temporal overlap with already-selected primary replication datasets",
  leakage: "leakage class must be CLEAN_REPLICATION for the evaluated cohort",
  development: "development/original-benchmark datasets are never primary replication datasets",
  duplicates: "fingerprint-identical datasets count once",
  windows: "walk-forward windows produced from one capture are NOT independent datasets and never count separately",
  blind: "eligibility is computed WITHOUT any strategy metric — selection is performance-blind",
});
