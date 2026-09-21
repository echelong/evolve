/**
 * EVOLVE Phase 5I-PS.1 — JEV PAPER SHADOW POST-HOC FORENSIC ANALYZER (definition).
 *
 * This is an OFFLINE, POST-HOC DEVELOPMENT instrument that reads ONE captured
 * Jev paper-shadow session and produces a forensic analysis of it.
 *
 * It is NOT evidence of anything:
 *
 *   - it never modifies, scores, tunes, influences or contaminates Phase 5I.0b,
 *     the Phase 5I.1 canonical replication, the Phase 5I.1a temporal replication,
 *     tomorrow's temporal session, the Arena, the Shadow League, the deployment
 *     gates, evolution, or the research swarm;
 *   - it never calls Jev, Jupiter, or any network endpoint;
 *   - it never constructs a provider, reads an API key, or requires Jev
 *     configuration;
 *   - it has no wallet, no signing, no swap, no order, no RPC write and no
 *     execution capability of any kind.
 *
 * Everything it writes lands in a COMPLETELY SEPARATE tree
 * (`.evolve/jev-paper-forensics/<analysis-id>/`) and it never rewrites a source
 * artifact: the three source files are read once, digested, and proven
 * byte-identical afterwards.
 *
 * The forensic counterfactual policies are PRE-DEFINED mechanistic diagnostics
 * frozen in this file BEFORE any result was observed. There is no threshold
 * sweep, no grid search, no adaptive holding period, no result-driven parameter
 * search, no automatic strategy generation, no ranking, and no "bestPolicy".
 *
 * PAPER ONLY / DEVELOPMENT ONLY / POST-HOC ONLY.
 */

import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import { REQUIRED_UPSTREAM_PROVIDER } from "../direction/definition.mjs";
import {
  PAPER_SHADOW_EVENTS_FILE,
  PAPER_SHADOW_ROOT_DIR,
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_SUMMARY_FILE,
} from "../paper-shadow/definition.mjs";

export const PAPER_FORENSICS_PHASE = "5I-PS.1";
export const PAPER_FORENSICS_SCHEMA_VERSION = 1;
export const PAPER_FORENSICS_KIND = "JEV_PAPER_SHADOW_POSTHOC_FORENSICS";

/** The ONE purpose string every analysis persists. */
export const PAPER_FORENSICS_PURPOSE = "JEV_PAPER_SHADOW_POSTHOC_FORENSICS";

/** A completely separate tree. Never the paper-shadow source tree. */
export const PAPER_FORENSICS_ROOT_DIR = path.join(".evolve", "jev-paper-forensics");

/** Where a captured paper-shadow session lives. Read-only for this analyzer. */
export const PAPER_FORENSICS_SOURCE_ROOT_DIR = PAPER_SHADOW_ROOT_DIR;

/** The full canonical Phase 5I tree this analyzer must never write into. */
export const PAPER_FORENSICS_CANONICAL_ROOT_DIR = path.join(".evolve", "jev-direction");

export const PAPER_FORENSICS_ID_PREFIX = "jforensic-";

/** The three REQUIRED source artifacts, in digest order. */
export const PAPER_FORENSICS_SOURCE_FILES = Object.freeze([
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_SUMMARY_FILE,
  PAPER_SHADOW_EVENTS_FILE,
]);

/** The analysis artifact layout. Stable file names, one directory per analysis. */
export const PAPER_FORENSICS_FILES = Object.freeze({
  manifest: "manifest.json",
  integrity: "integrity.json",
  signal: "signal.json",
  horizons: "horizons.json",
  episodes: "episodes.json",
  friction: "friction.json",
  counterfactuals: "counterfactuals.json",
  summary: "summary.json",
  report: "report.csv",
});

export const PAPER_FORENSICS_ARTIFACT_ORDER = Object.freeze([
  PAPER_FORENSICS_FILES.manifest,
  PAPER_FORENSICS_FILES.integrity,
  PAPER_FORENSICS_FILES.signal,
  PAPER_FORENSICS_FILES.horizons,
  PAPER_FORENSICS_FILES.episodes,
  PAPER_FORENSICS_FILES.friction,
  PAPER_FORENSICS_FILES.counterfactuals,
  PAPER_FORENSICS_FILES.summary,
  PAPER_FORENSICS_FILES.report,
]);

/**
 * The explicit classification. EVERY analysis persists exactly these flags, and
 * nothing in this subsystem may ever flip one of them to true.
 */
export const PAPER_FORENSICS_CLASSIFICATION = Object.freeze({
  purpose: PAPER_FORENSICS_PURPOSE,
  developmentOnly: true,
  postHoc: true,
  paperOnly: true,
  canonicalEvidence: false,
  replicationEvidence: false,
  temporalReplicationEvidence: false,
  arenaEligible: false,
  deploymentEligible: false,
  profitabilityInferencePermitted: false,
  parameterSelectionPermitted: false,
});

/**
 * The mandatory counterfactual banner. It is persisted with the counterfactual
 * artifact and printed by the CLI. No policy result may ever be reported
 * without it.
 */
export const PAPER_FORENSICS_COUNTERFACTUAL_BANNER = Object.freeze([
  "POST-HOC COUNTERFACTUAL DEVELOPMENT ANALYSIS",
  "NOT OUT-OF-SAMPLE",
  "NOT REPLICATION EVIDENCE",
  "NOT PARAMETER VALIDATION",
]);

/**
 * The mandatory metric banner for Brier / log loss / accuracy. These numbers are
 * DEVELOPMENT POST-HOC diagnostics only and may never be mixed with Phase 5I
 * replication metrics.
 */
export const PAPER_FORENSICS_METRIC_BANNER =
  "DEVELOPMENT POST-HOC DIAGNOSTIC ONLY — not Phase 5I evidence, not replication evidence, and never mixed with replication metrics.";

/** The mandatory closing banner printed by the CLI. */
export const PAPER_FORENSICS_CLOSING_BANNER = Object.freeze([
  "POST-HOC DEVELOPMENT ANALYSIS ONLY",
  "NO WINNER / NO PARAMETER SELECTION / NO PROFITABILITY CLAIM",
]);

/** The mandatory statement persisted with every counterfactual policy block. */
export const PAPER_FORENSICS_NO_WINNER_STATEMENT =
  "No policy is ranked, preferred, recommended, or declared a winner. The five policies are frozen mechanistic diagnostics; the analyzer contains no selection mechanism.";

/* ============================================================================
 * Frozen analysis parameters (chosen BEFORE any result was observed)
 * ==========================================================================*/

/** The five fixed forward-return horizons, in seconds. Never extended per run. */
export const PAPER_FORENSICS_HORIZONS_SECONDS = Object.freeze([30, 60, 90, 120, 300]);

/**
 * The FIXED probability histogram. Boundaries are frozen: no bin may be added,
 * removed, or optimized, and no "confidence" reading of the buckets is valid
 * beyond the explicit distance from 0.50.
 */
export const PAPER_FORENSICS_PROBABILITY_BINS = Object.freeze([
  { id: "lt_040", label: "<0.40", upperExclusive: 0.4 },
  { id: "040_043", label: "0.40–0.4299", lowerInclusive: 0.4, upperExclusive: 0.43 },
  { id: "043_045", label: "0.43–0.4499", lowerInclusive: 0.43, upperExclusive: 0.45 },
  { id: "045_047", label: "0.45–0.4699", lowerInclusive: 0.45, upperExclusive: 0.47 },
  { id: "047_049", label: "0.47–0.4899", lowerInclusive: 0.47, upperExclusive: 0.49 },
  { id: "049_050", label: "0.49–0.4999", lowerInclusive: 0.49, upperExclusive: 0.5 },
  { id: "exactly_050", label: "0.50", exactly: 0.5 },
  { id: "050_052", label: "0.5001–0.5199", lowerExclusive: 0.5, upperExclusive: 0.52 },
  { id: "052_055", label: "0.52–0.5499", lowerInclusive: 0.52, upperExclusive: 0.55 },
  { id: "gte_055", label: ">=0.55", lowerInclusive: 0.55 },
]);

/**
 * The five PRE-DEFINED counterfactual policies. Ids and semantics are frozen;
 * there is deliberately no policy generator, no parameter bag, and no ranking.
 */
export const PAPER_FORENSICS_POLICIES = Object.freeze([
  {
    id: "NO_TRADE",
    label: "NO_TRADE",
    summary: "Always cash.",
    definition: "Never trade: the account stays in cash for every captured decision.",
    parameters: Object.freeze({ confirmationSignals: null, minHoldMs: null }),
  },
  {
    id: "RECORDED_BINARY",
    label: "RECORDED_BINARY",
    summary: "The exact original recorded policy (replay integrity check).",
    definition:
      "pHigher >= 0.50 => HIGHER, pHigher < 0.50 => LOWER; FLAT + HIGHER => ENTER; LONG + HIGHER => HOLD; " +
      "LONG + LOWER => EXIT; FLAT + LOWER => CASH.",
    parameters: Object.freeze({ confirmationSignals: null, minHoldMs: null }),
  },
  {
    id: "TWO_SIGNAL_CONFIRMATION",
    label: "TWO_SIGNAL_CONFIRMATION",
    summary:
      "ENTER only after two consecutive HIGHER intents; EXIT only after two consecutive LOWER intents.",
    definition:
      "As RECORDED_BINARY, except ENTER requires two consecutive HIGHER intents and EXIT requires two " +
      "consecutive LOWER intents. A null intent resets both streaks; a streak resets after it triggers its action.",
    parameters: Object.freeze({ confirmationSignals: 2, minHoldMs: null }),
  },
  {
    id: "MIN_HOLD_60S",
    label: "MIN_HOLD_60S",
    summary:
      "RECORDED_BINARY, but an intent-driven EXIT is forbidden for the first 60 seconds of a hold.",
    definition:
      "As RECORDED_BINARY, except that while fewer than 60 000 ms have elapsed since entry a LOWER intent " +
      "cannot exit (it holds with reason 'min_hold_active'). After 60 000 ms the original LOWER exit rule applies.",
    parameters: Object.freeze({ confirmationSignals: null, minHoldMs: 60_000 }),
  },
  {
    id: "TWO_SIGNAL_PLUS_60S",
    label: "TWO_SIGNAL_PLUS_60S",
    summary: "TWO_SIGNAL_CONFIRMATION combined with MIN_HOLD_60S.",
    definition:
      "Both the two-signal confirmations of TWO_SIGNAL_CONFIRMATION and the 60 000 ms minimum hold of " +
      "MIN_HOLD_60S apply.",
    parameters: Object.freeze({ confirmationSignals: 2, minHoldMs: 60_000 }),
  },
]);

/** Policy ids in their frozen, presentation order (never a ranking). */
export const PAPER_FORENSICS_POLICY_IDS = Object.freeze(
  PAPER_FORENSICS_POLICIES.map((policy) => policy.id),
);

/** The frozen confirmation count / minimum hold of the predefined policies. */
export const PAPER_FORENSICS_CONFIRMATION_SIGNALS = 2;
export const PAPER_FORENSICS_MIN_HOLD_MS = 60_000;

/** The frozen 0.50 intent boundary used by the recorded policy. Never swept. */
export const PAPER_FORENSICS_INTENT_THRESHOLD = 0.5;

/**
 * Fields that must NEVER appear on a forensic artifact: an automatically chosen
 * explanation, a winner, a ranking, an optimum, a recommendation, or a selected
 * parameter. The validator asserts the absence of every one of them.
 */
export const PAPER_FORENSICS_FORBIDDEN_RESULT_KEYS = Object.freeze([
  "bestpolicy",
  "winner",
  "ranking",
  "rank",
  "optimal",
  "optimum",
  "best",
  "recommendation",
  "recommendedthreshold",
  "selectedthreshold",
  "optimized",
  "verdict",
  "profitable",
  "winning",
  "score",
]);

/** The expected upstream identity for the frozen direct TypeSafe provider. */
export const PAPER_FORENSICS_EXPECTED_UPSTREAM = REQUIRED_UPSTREAM_PROVIDER;

/** Documented numeric tolerances: absolute USD, relative fill, friction, log clip. */
export const PAPER_FORENSICS_TOLERANCE = Object.freeze({
  /** Absolute USD tolerance when a summary rounds a source value to 10 decimals. */
  accountUsd: 1e-9,
  /** Relative tolerance when reproducing a recorded fill through the engine. */
  fillRelative: 1e-12,
  /** Probability-log clipping bound (log loss never evaluates ln(0)). */
  probabilityClip: 1e-12,
});

export const PAPER_FORENSICS_LABEL = "JEV PAPER SHADOW • POST-HOC FORENSICS • DEVELOPMENT ONLY";
export const PAPER_FORENSICS_ACCOUNTING_NOTE =
  "Simulated paper accounting. Not replication evidence. Not profitability evidence.";
export const PAPER_FORENSICS_EXCLUSION_NOTE =
  "Offline post-hoc development analysis — excluded from Phase 5I / 5I.1 / 5I.1a replication, Arena, Shadow League and deployment evidence.";
export const PAPER_FORENSICS_BOUNDARY_NOTE =
  "Reads one captured paper-shadow session; never writes to it, never scores it, never tunes anything from it.";

/* ============================================================================
 * Isolation guards
 * ==========================================================================*/

/**
 * Trees this analyzer may NEVER write into. The list is the single source of
 * truth shared by the writer and the validator.
 */
export const PAPER_FORENSICS_FORBIDDEN_WRITE_ROOTS = Object.freeze([
  PAPER_SHADOW_ROOT_DIR,
  PAPER_FORENSICS_CANONICAL_ROOT_DIR,
  path.join(PAPER_FORENSICS_CANONICAL_ROOT_DIR, "replication"),
  path.join(PAPER_FORENSICS_CANONICAL_ROOT_DIR, "temporal"),
  path.join(".evolve", "jev"),
  path.join(".evolve", "shadow"),
  path.join(".evolve", "arenas"),
  path.join(".evolve", "arena"),
  path.join(".evolve", "arena-cache"),
  path.join(".evolve", "history"),
  path.join(".evolve", "research"),
  path.join(".evolve", "replication"),
  path.join(".evolve", "experiments"),
  path.join(".evolve", "champions"),
  path.join(".evolve", "classifier"),
  path.join(".evolve", "datasets"),
  path.join(".evolve", "regimes"),
  path.join(".evolve", "stress"),
  path.join(".evolve", "hall-of-fame"),
]);

/** True when `candidate` resolves to `parent` or a path inside it. */
export function isPathWithin(candidate, parent) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

/**
 * FAIL-CLOSED guard for every forensic write. A target must live inside the
 * forensic tree and must not live inside any protected tree.
 */
export function assertPaperForensicsWriteTarget(target, baseRoot) {
  const resolvedBase = path.resolve(baseRoot ?? PAPER_FORENSICS_ROOT_DIR);
  if (!isPathWithin(resolvedBase, PAPER_FORENSICS_ROOT_DIR) || !isPathWithin(target, PAPER_FORENSICS_ROOT_DIR)) {
    throw new Error("forensic output must stay under .evolve/jev-paper-forensics");
  }
  for (const forbidden of PAPER_FORENSICS_FORBIDDEN_WRITE_ROOTS) {
    if (isPathWithin(target, path.resolve(forbidden))) {
      throw new Error(`refusing to write to ${target}: it is inside the protected tree ${forbidden}`);
    }
  }
  if (!isPathWithin(target, resolvedBase)) {
    throw new Error(`refusing to write to ${target}: it is outside the forensic base tree ${resolvedBase}`);
  }
  return true;
}

/* ============================================================================
 * Analysis identity
 * ==========================================================================*/

/** Compact UTC stamp matching the Phase 5I / Arena convention. */
export function paperForensicsCompactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function isValidPaperForensicsAnalysisId(analysisId) {
  return (
    typeof analysisId === "string" && /^jforensic-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(analysisId)
  );
}

/**
 * `jforensic-<UTC timestamp>-<short deterministic source digest>`.
 *
 * The suffix is a pure function of the source identity digest, so two analyses
 * of the same captured bytes share a suffix and differ only by their creation
 * stamp. Nothing about the analysis RESULT is part of the id.
 */
export function paperForensicsAnalysisIdFor({ sourceDigest, createdAt = Date.now() } = {}) {
  const stamp = paperForensicsCompactStamp(createdAt);
  const suffix = digestOf({ kind: PAPER_FORENSICS_KIND, sourceDigest: sourceDigest ?? null }).slice(0, 6);
  return `${PAPER_FORENSICS_ID_PREFIX}${stamp}-${suffix}`;
}

/** Resolve one analysis root. Refuses any id that is not a forensic analysis id. */
export function paperForensicsRootFor(baseRoot, analysisId) {
  if (!isValidPaperForensicsAnalysisId(analysisId)) {
    throw new Error(`invalid forensic analysis id '${analysisId}'`);
  }
  const root = path.join(baseRoot ?? PAPER_FORENSICS_ROOT_DIR, analysisId);
  if (!isPathWithin(root, baseRoot ?? PAPER_FORENSICS_ROOT_DIR)) {
    throw new Error(`refusing a forensic analysis root outside its base tree: ${root}`);
  }
  return root;
}

/** This analyzer analyzes captured PAPER SHADOW sessions only: `jpaper-` ids. */
export function isValidPaperShadowSourceSessionId(sessionId) {
  return typeof sessionId === "string" && /^jpaper-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(sessionId);
}

/* ============================================================================
 * Small shared numeric helpers (descriptive only)
 * ==========================================================================*/

export function finiteOrNull(value) {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundTo(value, digits = 10) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** Deterministic descriptive statistics. No inference, no interval, no p-value. */
export function describe(values) {
  const sample = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (sample.length === 0) {
    return { count: 0, mean: null, median: null, stddev: null, min: null, max: null, sum: null };
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const sum = sample.reduce((total, value) => total + value, 0);
  const mean = sum / sample.length;
  const variance =
    sample.length > 1
      ? sample.reduce((total, value) => total + (value - mean) ** 2, 0) / (sample.length - 1)
      : 0;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    count: sample.length,
    mean: roundTo(mean, 12),
    median: roundTo(median, 12),
    stddev: roundTo(Math.sqrt(variance), 12),
    min: roundTo(sorted[0], 12),
    max: roundTo(sorted[sorted.length - 1], 12),
    sum: roundTo(sum, 12),
  };
}

/** Run-length encoding of a boolean stream (used for HIGHER/LOWER runs). */
export function runLengths(stream) {
  const runs = [];
  for (const value of stream) {
    const key = value === true;
    const last = runs[runs.length - 1];
    if (last && last.value === key) last.length += 1;
    else runs.push({ value: key, length: 1 });
  }
  return runs;
}
