/**
 * EVOLVE Phase 5I.1a — THE FROZEN TEMPORAL-EXTENSION CONTRACT.
 *
 * Phase 5I.1 completed successfully, but all three CLEAN replication sessions
 * happened on the SAME UTC calendar date and close together in time. Phase 5I.1a
 * exists to ask ONE further question, frozen here BEFORE any temporal session
 * exists:
 *
 *   "Does the SAME frozen Phase 5I.0b predictive protocol reproduce its
 *    predictive behavior on fresh SOL/USDC sessions that are TEMPORALLY
 *    INDEPENDENT of one another and of the canonical Phase 5I.1 wave?"
 *
 * The predictive protocol is NOT modified. This module imports the canonical
 * `REPLICATION_PROTOCOL_DIGEST` and re-exports it verbatim: the temporal
 * extension uses the EXACT SAME protocol digest, the same question set, the same
 * feature definition, the same baselines, the same metric definition, the same
 * reference-price definition, the same staleness rules, the same outcome policy
 * and the same no-threshold rule. Only TWO things are new:
 *
 *   1. a separate EVIDENCE CLASS and a separate MANIFEST tree, so the temporal
 *      extension is reported SEPARATELY and the canonical Phase 5I.1 wave is
 *      never appended to, re-scored, or otherwise touched; and
 *   2. STRICTER TEMPORAL-INDEPENDENCE RULES (below).
 *
 * §5 THE STRICTER TEMPORAL INDEPENDENCE RULES (frozen, source-pinned):
 *
 *   - each new session must occur on a DIFFERENT UTC calendar date;
 *   - each session must start at least 6 hours after the previous eligible
 *     session completed;
 *   - none may overlap any Phase 5I.0b development observation;
 *   - none may overlap any canonical Phase 5I.1 observation;
 *   - none may overlap another Phase 5I.1a session;
 *   - session timing must NOT be selected because the operator observed favorable
 *     Jev performance;
 *   - session timing must NOT be selected because SOL appears especially bullish,
 *     bearish, or volatile.
 *
 * A violation is PRESERVED as CONTAMINATED or INELIGIBLE — never silently
 * excluded.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, no
 * confidence threshold, and no JevCache in the canonical predictive path.
 */

import path from "node:path";

import { digestOf } from "../../../lib/hash.mjs";
import { DIRECTION_ROOT_DIR } from "../definition.mjs";
import { REPLICATION_EVIDENCE_CLASS, TEMPORAL_REPLICATION_EVIDENCE_CLASS } from "../evidence.mjs";
import { CANONICAL_DEVELOPMENT_BARRIER } from "../replication/development-barrier.mjs";
import {
  REPLICATION_COMPARISON_IDS,
  REPLICATION_DELTA_SIGN_CONVENTION,
  REPLICATION_PROTOCOL_CONTRACT,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_PROTOCOL_VERSION,
  REPLICATION_SESSION_CADENCE_SECONDS,
  REPLICATION_SESSION_OBSERVATIONS,
} from "../replication/protocol.mjs";

export const TEMPORAL_PROTOCOL_VERSION = 1;

/** The temporal tree, a sibling of the canonical replication tree. */
export const DIRECTION_TEMPORAL_ROOT_DIR = path.join(DIRECTION_ROOT_DIR, "temporal");
export const TEMPORAL_MANIFEST_FILE = "temporal.json";
export const TEMPORAL_SESSIONS_FILE = "sessions.json";
export const TEMPORAL_SUMMARY_FILE = "summary.json";

/** A distinct prefix, so a temporal id can never be a jrep or jdir id. */
export const TEMPORAL_ID_PREFIX = "jtrp-";

export const TEMPORAL_PHASE = "5I.1a";

/* ============================================================================
 * §5 the frozen temporal settings (EXACT same predictive protocol values)
 * ==========================================================================*/

/** Observations per temporal session — identical to a canonical replication session. */
export const TEMPORAL_SESSION_OBSERVATIONS = REPLICATION_SESSION_OBSERVATIONS;
/** Sampling cadence, in seconds — identical. */
export const TEMPORAL_SESSION_CADENCE_SECONDS = REPLICATION_SESSION_CADENCE_SECONDS;
/** Exactly how many CLEAN temporal-extension sessions the phase requires. */
export const REQUIRED_CLEAN_TEMPORAL_SESSIONS = 3;
/** The PRIMARY inference unit is the dataset/session, never the observation. */
export const TEMPORAL_INFERENCE_UNIT = "dataset/session";

/** The frozen minimum gap from the previous eligible session, in milliseconds. */
export const TEMPORAL_MINIMUM_GAP_MS = 6 * 60 * 60 * 1000;
/** One session per UTC calendar date, enforced. */
export const TEMPORAL_REQUIRES_DISTINCT_UTC_DATE = true;

/**
 * THE PROTOCOL DIGEST. It is NOT re-derived and NOT re-frozen: the temporal
 * extension uses the canonical Phase 5I.1 digest verbatim. `protocolDigest`
 * must equal this for every temporal session, fail closed.
 */
export const TEMPORAL_PROTOCOL_DIGEST = REPLICATION_PROTOCOL_DIGEST;
export const TEMPORAL_PROTOCOL_VERSION_REFERENCE = REPLICATION_PROTOCOL_VERSION;
export const TEMPORAL_PROTOCOL_CONTRACT = REPLICATION_PROTOCOL_CONTRACT;

/** The five frozen comparisons and the three reported metrics — unchanged. */
export const TEMPORAL_COMPARISON_IDS = REPLICATION_COMPARISON_IDS;
export const TEMPORAL_DELTA_SIGN_CONVENTION = REPLICATION_DELTA_SIGN_CONVENTION;

/* ============================================================================
 * §5 the frozen independence + selection rules
 * ==========================================================================*/

/**
 * The complete, machine-readable statement of the temporal-extension
 * independence rules. Source-pinned BEFORE any temporal session is run.
 */
export const TEMPORAL_INDEPENDENCE_RULES = Object.freeze({
  distinctUtcCalendarDatePerSession: TEMPORAL_REQUIRES_DISTINCT_UTC_DATE,
  minimumGapFromPreviousEligibleSessionMs: TEMPORAL_MINIMUM_GAP_MS,
  requiresNoDevelopmentOverlap: true,
  requiresNoCanonicalReplicationOverlap: true,
  requiresNoTemporalExtensionOverlap: true,
  violationPreservedNeverSilentlyExcluded: true,
  primaryInferenceUnit: TEMPORAL_INFERENCE_UNIT,
  equalWeightPerCleanSession: true,
  observationsNeverPooled: true,
});

/**
 * The two selection rules that cannot be proven from an artifact alone (they
 * describe WHY the operator chose a session's time), declared here as frozen
 * invariants and audited for any field that would contradict them.
 */
export const TEMPORAL_SELECTION_RULES = Object.freeze({
  selectionBasis: "calendar-schedule",
  timingNotSelectedFromObservedPerformance: true,
  timingNotSelectedFromMarketView: true,
  noFavorablePerformanceConditioning: true,
  noBullishBearishVolatilityConditioning: true,
  noAutomatedWinner: true,
  noProfitabilityInference: true,
  noPromotionToPhase5I2: true,
});

/** Fields that would mean session timing was conditioned on an observation. */
export const TEMPORAL_FORBIDDEN_SELECTION_FIELDS = Object.freeze([
  "selectedBecause",
  "selectionReason",
  "timingSelectedFromPerformance",
  "timingSelectedFromMarketView",
  "favorablePerformance",
  "bullish",
  "bearish",
  "volatilityPick",
  "priceAtSelection",
  "observedEdge",
  "performancePick",
  "marketViewPick",
]);

/**
 * Audit a manifest, a summary or a session record for the frozen selection
 * rules. Returns `{ ok, problems }` — never throws.
 *
 * @param {object|null} subject
 */
export function auditTemporalTimingSelection(subject) {
  if (!subject || typeof subject !== "object") {
    return { ok: false, problems: ["no timing-selection declaration is available"] };
  }
  const problems = [];
  const seen = new Set();
  const walk = (value, prefix) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${prefix}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (TEMPORAL_FORBIDDEN_SELECTION_FIELDS.includes(key)) {
        problems.push(`${prefix === "" ? key : `${prefix}.${key}`} is a performance/market-view timing-selection field`);
      }
      walk(child, prefix === "" ? key : `${prefix}.${key}`);
    }
  };
  walk(subject, "");
  if (subject.selectionBasis !== TEMPORAL_SELECTION_RULES.selectionBasis) {
    problems.push(
      `selectionBasis is ${JSON.stringify(subject.selectionBasis ?? null)}; the frozen basis is ` +
        `${JSON.stringify(TEMPORAL_SELECTION_RULES.selectionBasis)}`,
    );
  }
  if (subject.timingNotSelectedFromObservedPerformance !== true) {
    problems.push("the artifact does not declare that session timing was not selected from observed Jev performance");
  }
  if (subject.timingNotSelectedFromMarketView !== true) {
    problems.push("the artifact does not declare that session timing was not selected from a view on SOL direction or volatility");
  }
  return { ok: problems.length === 0, problems };
}

/* ============================================================================
 * §1/§9 THE CANONICAL PHASE 5I.1 BARRIER (source-pinned, READ ONLY)
 *
 * The completed canonical Phase 5I.1 replication wave is FROZEN historical
 * identity. Its id, digests, session ids, session windows and per-session metric
 * digests are pinned HERE, in source control, BEFORE the temporal framework can
 * read anything. NOTHING in Phase 5I.1a may rewrite the canonical manifest, its
 * sessions, or its aggregation.
 * ==========================================================================*/

export const CANONICAL_REPLICATION_BARRIER = Object.freeze({
  replicationId: "jrep-20260920T090716Z-97c862",
  phase: "5I.1",
  evidenceClass: REPLICATION_EVIDENCE_CLASS,
  status: "CLEAN_REPLICATION_SESSIONS_COMPLETE",
  cleanSessionCount: 3,
  requiredCleanSessions: 3,
  developmentExperimentId: CANONICAL_DEVELOPMENT_BARRIER.experimentId,
  developmentMetricsDigest: CANONICAL_DEVELOPMENT_BARRIER.metricsDigest,
  protocolDigest: REPLICATION_PROTOCOL_DIGEST,
  // The aggregate content digest of the frozen canonical summary.
  aggregateMetricsDigest: "7857b7875f88bb9acefc83f66290114085ab784d4219e7308f75753b1214dba1",
  // The digest of the frozen canonical session-record array.
  sessionRecordsDigest: "369152fd53bf53ace2fc31ca55ea508e3b327f2a3b67a033258658b95d63defd",
  // The digest of the frozen canonical manifest body.
  manifestContentDigest: "6b329879b54af896445aa1c766e488b57bedf7966a13d5d60083f0019c4f0909",
  /** The canonical session ids, in recorded order. */
  cleanSessionIds: Object.freeze([
    "jdir-20260920T090716Z-3a9163",
    "jdir-20260920T104154Z-3a9163",
    "jdir-20260920T121446Z-3a9163",
  ]),
  /**
   * The canonical session windows, pinned so the "no overlap with canonical
   * Phase 5I.1 observations" rule is enforceable OFFLINE without reading the
   * canonical artifacts.
   */
  sessionWindows: Object.freeze({
    "jdir-20260920T090716Z-3a9163": Object.freeze({
      sessionStartedAt: "2026-09-20T09:07:16.485Z",
      earliestObservationAt: "2026-09-20T09:07:19.490Z",
      latestObservationAt: "2026-09-20T10:37:25.003Z",
      sessionCompletedAt: "2026-09-20T10:37:26.028Z",
      metricsDigest: "da893ba67cbb75dade144fc77a628a2a38c8418acfdfbb2e187c49efc6eb9cc6",
      recordDigest: "07936fa990af0e6d612ea4939c9868b20debc445f288656c3ba0d3a879d093fe",
    }),
    "jdir-20260920T104154Z-3a9163": Object.freeze({
      sessionStartedAt: "2026-09-20T10:41:54.203Z",
      earliestObservationAt: "2026-09-20T10:41:57.208Z",
      latestObservationAt: "2026-09-20T12:12:02.971Z",
      sessionCompletedAt: "2026-09-20T12:12:04.056Z",
      metricsDigest: "f9ba506bd15ab0dbad7f730c9f99d23f1c0c58b934f175f8b87b03b87466b28c",
      recordDigest: "36b08da3b473db2f3a7a759eba52659e3d5ec3d554cbd74421b0fea14e1b1cad",
    }),
    "jdir-20260920T121446Z-3a9163": Object.freeze({
      sessionStartedAt: "2026-09-20T12:14:46.874Z",
      earliestObservationAt: "2026-09-20T12:14:49.879Z",
      latestObservationAt: "2026-09-20T13:44:55.608Z",
      sessionCompletedAt: "2026-09-20T13:44:56.672Z",
      metricsDigest: "ca4b4b7c903397de8ed1e525f9731cdd5be85b825dff7d96b6165ce18e5c3c6b",
      recordDigest: "3424bfb25dfb3b5b0498534fb5477d7e9c91ab0ab2ad12dd74fa900941eaac39",
    }),
  }),
  /** The development observation window the temporal extension must not overlap. */
  developmentWindow: Object.freeze({
    earliestObservationAt: CANONICAL_DEVELOPMENT_BARRIER.session.earliestObservationAt,
    latestObservationAt: CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt,
    completedAt: CANONICAL_DEVELOPMENT_BARRIER.session.completedAt,
  }),
});

export const CANONICAL_REPLICATION_BARRIER_DIGEST = digestOf(CANONICAL_REPLICATION_BARRIER);

/** The instant the canonical Phase 5I.1 wave ended; no temporal session precedes it. */
export const CANONICAL_REPLICATION_COMPLETED_AT_MS = Math.max(
  ...Object.values(CANONICAL_REPLICATION_BARRIER.sessionWindows).map((entry) => Date.parse(entry.sessionCompletedAt)),
);

/** The canonical replication windows as closed `[start, end]` millisecond intervals. */
export const CANONICAL_REPLICATION_WINDOWS = Object.freeze(
  Object.entries(CANONICAL_REPLICATION_BARRIER.sessionWindows).map(([sessionId, entry]) => Object.freeze({
    sessionId,
    windowMs: Object.freeze([Date.parse(entry.earliestObservationAt), Date.parse(entry.latestObservationAt)]),
  })),
);

/** The development window as a closed `[start, end]` millisecond interval. */
export const DEVELOPMENT_WINDOW_MS = Object.freeze([
  Date.parse(CANONICAL_REPLICATION_BARRIER.developmentWindow.earliestObservationAt),
  Date.parse(CANONICAL_REPLICATION_BARRIER.developmentWindow.latestObservationAt),
]);

/* ============================================================================
 * Small pure helpers
 * ==========================================================================*/

/** The UTC calendar date (`YYYY-MM-DD`) of a timestamp, or `null`. */
export function utcDateOf(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The gap (ms) between a session's start and the previous eligible session's
 * completion. `null` when either instant is unknown.
 */
export function gapFromPreviousEligibleSessionMs({ startedAtMs, previousCompletedAtMs = null }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(previousCompletedAtMs)) return null;
  return startedAtMs - previousCompletedAtMs;
}

/**
 * Verify a stored temporal manifest against the frozen declarations. Fail
 * closed: a manifest that drifted from the pinned contract, the pinned canonical
 * Phase 5I.1 wave, or the frozen independence/selection rules is refused.
 *
 * @param {object|null} manifest
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyTemporalManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return { ok: false, problems: ["no temporal manifest is available"] };
  const problems = [];
  const expect = (label, actual, expected) => {
    if (digestOf(actual ?? null) !== digestOf(expected ?? null)) {
      problems.push(`${label} changed: ${JSON.stringify(actual ?? null)} != ${JSON.stringify(expected ?? null)}`);
    }
  };
  expect("temporal evidence class", manifest.evidenceClass, TEMPORAL_REPLICATION_EVIDENCE_CLASS);
  expect("protocol digest", manifest.protocolDigest, TEMPORAL_PROTOCOL_DIGEST);
  expect("temporal protocol digest", manifest.temporalProtocolDigest, TEMPORAL_PROTOCOL_DIGEST);
  expect("canonical replication id", manifest.canonicalReplicationId, CANONICAL_REPLICATION_BARRIER.replicationId);
  expect("canonical replication digest", manifest.canonicalReplicationDigest, CANONICAL_REPLICATION_BARRIER.manifestContentDigest);
  expect("canonical aggregate digest", manifest.canonicalReplicationAggregateDigest, CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest);
  expect(
    "canonical session-records digest",
    manifest.canonicalReplicationSessionRecordsDigest,
    CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
  );
  expect("canonical replication protocol digest", manifest.canonicalReplicationProtocolDigest, CANONICAL_REPLICATION_BARRIER.protocolDigest);
  expect("independence rules", manifest.independenceRules, TEMPORAL_INDEPENDENCE_RULES);
  expect("temporal selection rules", manifest.temporalSelectionRules, TEMPORAL_SELECTION_RULES);
  expect("primary inference unit", manifest.primaryInferenceUnit, TEMPORAL_INFERENCE_UNIT);
  expect("required clean sessions", manifest.requiredCleanSessions, REQUIRED_CLEAN_TEMPORAL_SESSIONS);
  if (manifest.temporalExtensionOnly !== true) problems.push("the manifest does not declare temporalExtensionOnly");
  if (manifest.noProfitabilityInference !== true) problems.push("the manifest does not declare no-profitability-inference");
  if (manifest.noTradingInference !== true) problems.push("the manifest does not declare no-trading-inference");
  if (manifest.noDeploymentInference !== true) problems.push("the manifest does not declare no-deployment-inference");
  if (manifest.noNewWinnerField !== true) problems.push("the manifest does not declare no-new-winner-field");
  if (manifest.noPromotionToPhase5I2 !== true) problems.push("the manifest does not declare no-promotion-to-5I.2");
  if (manifest.canonicalResultImmutable !== true) problems.push("the manifest does not declare the canonical result immutable");
  if (manifest.canonicalResultIndependentlyReproducible !== true) {
    problems.push("the manifest does not declare the canonical result independently reproducible");
  }
  if (manifest.protocolUnchangedFromReplication !== true) {
    problems.push("the manifest does not declare the protocol unchanged from Phase 5I.1");
  }
  problems.push(...auditTemporalTimingSelection(manifest).problems);
  return { ok: problems.length === 0, problems };
}
