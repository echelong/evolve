/**
 * Phase 5I.1 — EVIDENCE PROFILES.
 *
 * A Phase 5I artifact declares exactly ONE evidence class, and which class it is
 * decides what the artifact is allowed to mean:
 *
 *   development  DEVELOPMENT_JEV_DIRECTION_EVIDENCE
 *                developmentOnly: true. The artifact is DEVELOPMENT evidence:
 *                it established nothing persistent and supports no profitability
 *                or deployment inference.
 *
 *   replication  CLEAN_JEV_DIRECTION_REPLICATION_EVIDENCE
 *                developmentOnly: false, replicationOnly: true. The artifact is
 *                ONE fresh, unseen replication SESSION executed under the exact
 *                frozen Phase 5I.0b protocol. It is still paper/shadow only, it
 *                still makes no profitability or deployment claim, and on its
 *                own it is NOT a wave-level replication result — that only ever
 *                comes from the cross-session aggregation in the replication
 *                manifest (§13), and only from CLEAN sessions.
 *
 *   temporal     CLEAN_JEV_DIRECTION_TEMPORAL_REPLICATION_EVIDENCE
 *                developmentOnly: false, replicationOnly: true,
 *                temporalExtensionOnly: true. The artifact is ONE fresh, unseen
 *                session of the SAME frozen Phase 5I.0b predictive protocol, but
 *                it belongs to the Phase 5I.1a TEMPORAL EXTENSION: it is held to
 *                STRICTER temporal-independence rules (a different UTC calendar
 *                date per session, a >= 6 h gap from the previous eligible
 *                session, and no overlap with the development experiment, the
 *                canonical Phase 5I.1 wave, or another temporal session) and is
 *                aggregated in its OWN manifest, never appended to the canonical
 *                Phase 5I.1 wave. It changes NO predictive semantic: the frozen
 *                protocol digest is identical for all three classes.
 *
 * WHY A PROFILE INSTEAD OF A SECOND PIPELINE: the predictive protocol must be
 * BYTE-IDENTICAL between development and replication. A second code path would
 * be a second protocol. The evidence class is a *labelling* dimension only — it
 * changes no question wording, no feature formula, no baseline coefficient, no
 * horizon, no outcome tolerance, no staleness cutoff, no calibration bin, no
 * metric formula, and no threshold. The protocol contract digest (§10) covers
 * all of those semantics and must match the frozen development digest exactly,
 * for both classes, fail closed.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold of any kind.
 */

import { DIRECTION_DEVELOPMENT_FLAGS, DIRECTION_EVIDENCE_CLASS } from "./definition.mjs";

/** The ONE evidence class a real Phase 5I.1 replication session may carry. */
export const REPLICATION_EVIDENCE_CLASS = "CLEAN_JEV_DIRECTION_REPLICATION_EVIDENCE";

/**
 * Every replication artifact carries these flags, verbatim. Note the deliberate
 * asymmetry with the development flag set: `developmentOnly` is FALSE and
 * `replicationOnly` is TRUE. Everything else stays exactly as strict.
 */
export const DIRECTION_REPLICATION_FLAGS = Object.freeze({
  developmentOnly: false,
  replicationOnly: true,
  noGroundTruthBeyondObservedFutureOutcome: true,
  noProfitabilityInference: true,
  noTradingInference: true,
  noDeploymentInference: true,
  paperOnly: true,
  shadowOnly: true,
});

export const DEVELOPMENT_EVIDENCE_PROFILE = Object.freeze({
  id: "development",
  evidenceClass: DIRECTION_EVIDENCE_CLASS,
  evidenceScope: "DEVELOPMENT",
  replicationStatus: "NOT_REPLICATED",
  flags: DIRECTION_DEVELOPMENT_FLAGS,
  // §2: the development interpretation is FROZEN. These two sentences are the
  // whole verdict, and they are never replaced by an automated winner.
  interpretation:
    "Phase 5I.0b showed no clear directional advantage for Jev over the neutral baseline. This is DEVELOPMENT " +
    "evidence only. No persistent edge has been established. No profitability inference is permitted.",
  noAutomatedWinner: true,
  protocolUnchangedByResults: true,
});

export const REPLICATION_EVIDENCE_PROFILE = Object.freeze({
  id: "replication",
  evidenceClass: REPLICATION_EVIDENCE_CLASS,
  evidenceScope: "REPLICATION",
  // A single session is a replication SESSION, never a replication RESULT: the
  // wave-level status is only ever produced by the frozen cross-session
  // aggregation over CLEAN sessions.
  replicationStatus: "PENDING_WAVE_AGGREGATION",
  flags: DIRECTION_REPLICATION_FLAGS,
  interpretation:
    "One fresh, unseen replication SESSION of the frozen Phase 5I.0b predictive protocol. Replication, not " +
    "development. It is paper/shadow only, it establishes nothing on its own, and no profitability, trading or " +
    "deployment inference is permitted from it.",
  noAutomatedWinner: true,
  protocolUnchangedByResults: true,
});

/**
 * The ONE evidence class a Phase 5I.1a temporal-extension session may carry. It
 * is deliberately DISTINCT from the canonical replication class so a temporal
 * session can never be added to the canonical Phase 5I.1 wave and a canonical
 * 5I.1 session can never be added to the temporal extension.
 */
export const TEMPORAL_REPLICATION_EVIDENCE_CLASS = "CLEAN_JEV_DIRECTION_TEMPORAL_REPLICATION_EVIDENCE";

/**
 * Every temporal-extension artifact carries these flags, verbatim. The flag set
 * is the replication set plus `temporalExtensionOnly`; nothing about the
 * predictive protocol is expressed here — this is a LABELLING dimension only.
 */
export const DIRECTION_TEMPORAL_REPLICATION_FLAGS = Object.freeze({
  developmentOnly: false,
  replicationOnly: true,
  temporalExtensionOnly: true,
  noGroundTruthBeyondObservedFutureOutcome: true,
  noProfitabilityInference: true,
  noTradingInference: true,
  noDeploymentInference: true,
  paperOnly: true,
  shadowOnly: true,
});

export const TEMPORAL_REPLICATION_EVIDENCE_PROFILE = Object.freeze({
  id: "temporal",
  evidenceClass: TEMPORAL_REPLICATION_EVIDENCE_CLASS,
  evidenceScope: "TEMPORAL_REPLICATION",
  // One temporal session is still a SESSION, never a wave-level result: the
  // temporal result only ever comes from the temporal cross-session aggregation.
  replicationStatus: "PENDING_TEMPORAL_AGGREGATION",
  flags: DIRECTION_TEMPORAL_REPLICATION_FLAGS,
  interpretation:
    "One fresh, unseen TEMPORAL-EXTENSION session of the frozen Phase 5I.0b predictive protocol. It uses the same " +
    "protocol digest as development and replication evidence, but it is held to STRICTER temporal-independence rules " +
    "and is aggregated separately. It is paper/shadow only, it establishes nothing on its own, and no profitability, " +
    "trading or deployment inference is permitted from it.",
  noAutomatedWinner: true,
  protocolUnchangedByResults: true,
});

export const DIRECTION_EVIDENCE_PROFILES = Object.freeze({
  development: DEVELOPMENT_EVIDENCE_PROFILE,
  replication: REPLICATION_EVIDENCE_PROFILE,
  temporal: TEMPORAL_REPLICATION_EVIDENCE_PROFILE,
});

/** Resolve a profile by id. An unknown id resolves to `null` (FAIL CLOSED). */
export function evidenceProfileById(id) {
  const resolved = DIRECTION_EVIDENCE_PROFILES[String(id)];
  return resolved ?? null;
}

/**
 * Resolve the profile an artifact declares, from its `evidenceClass` alone.
 * An unrecognised class resolves to `null` and the caller must refuse to
 * continue — never guess, never default to development.
 */
export function evidenceProfileForClass(evidenceClass) {
  for (const profile of Object.values(DIRECTION_EVIDENCE_PROFILES)) {
    if (profile.evidenceClass === evidenceClass) return profile;
  }
  return null;
}

/** Resolve the profile of a stored experiment artifact. FAIL CLOSED on unknown. */
export function evidenceProfileForExperiment(experiment) {
  return evidenceProfileForClass(experiment?.evidenceClass);
}

/** Every evidence class this phase knows about, in a stable order. */
export const DIRECTION_EVIDENCE_CLASSES = Object.freeze(
  Object.values(DIRECTION_EVIDENCE_PROFILES).map((profile) => profile.evidenceClass),
);
