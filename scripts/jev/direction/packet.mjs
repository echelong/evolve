/**
 * Phase 5I.0b — the frozen Jev input packet.
 *
 *   JEV_MICROSTRUCTURE_DIRECTION_PACKET  version 1
 *
 * This is the ONLY channel through which Jev learns anything about the
 * benchmark. Two structural guarantees (same posture as the Phase 5D decision
 * packet, kept as a SEPARATE implementation because the scientific subject is a
 * market state, not a candidate):
 *
 *   1. `buildDirectionPacket` is a WHITELIST-ONLY projection. Only named,
 *      bounded fields can appear — never "the rest of the observation".
 *   2. `auditDirectionPacket` walks the packet (including nested objects) and
 *      reports any forbidden key or secret-shaped value, so a future edit that
 *      widens the packet is caught by the validator rather than going unnoticed.
 *
 * EXPLICITLY ABSENT, always: the outcome, the target label, `pHigher`/`pLower`,
 * future prices, Arena score/ranking, deployment or champion status,
 * validation/test results, profitability or PnL, classifier evaluation results,
 * and any 5H classifier-derived feature.
 *
 * DIGEST RULES
 * ------------
 * `packetDigest` is a canonical SHA-256 over the packet content with the
 * VOLATILE fields removed (`createdAt`, `generatedBy`). Rebuilding the same
 * logical state at a different wall-clock second therefore reproduces the same
 * digest, while changing any observed field changes it. `stateDigest` on a
 * prediction artifact is that same value (the existing Phase 5D naming for
 * "what state did Jev see").
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { jevStateDigestOf } from "../decision-packet.mjs";
import {
  BENCHMARK_MARKET,
  DIRECTION_PHASE,
  TARGET_AT_BASIS,
  DIRECTION_SCHEMA_VERSION,
  HORIZON_SECONDS,
  OBSERVATION_HISTORY_LIMIT,
  UNAVAILABLE_FEATURE_FAMILIES,
} from "./definition.mjs";
import { DIRECTION_FEATURE_NAMES } from "./features.mjs";

export const DIRECTION_PACKET_KIND = "JEV_MICROSTRUCTURE_DIRECTION_PACKET";
export const DIRECTION_PACKET_VERSION = 1;

/** The only evidence class a 5I packet may declare. */
export const DIRECTION_ALLOWED_EVIDENCE_CLASS = "PRE_OUTCOME_MARKET_STATE";

/** Everything explicitly excluded from the packet, named so an artifact can declare it. */
export const DIRECTION_EXCLUDED_EVIDENCE_CLASSES = Object.freeze([
  "POST_OUTCOME_PRICE",
  "OUTCOME_LABEL",
  "FUTURE_OBSERVATION",
  "ARENA_SCORE",
  "ARENA_RANKING",
  "GATE_RESULT",
  "DEPLOYMENT_STATUS",
  "CHAMPION_STATUS",
  "VALIDATION_RESULT",
  "TEST_RESULT",
  "PROFITABILITY",
  "PNL",
  "TRADE_RESULT",
  "CLASSIFIER_EVALUATION_RESULT",
  "CLASSIFIER_DERIVED_FEATURE",
]);

/**
 * Field names that may NEVER appear anywhere inside a 5I packet. Lowercased and
 * matched exactly (the same convention as the Phase 5D packet audit).
 */
export const DIRECTION_FORBIDDEN_KEYS = Object.freeze([
  "outcome",
  "actualoutcome",
  "futureprice",
  "future",
  "futureobservation",
  "target",
  "targetat",
  "targetlabel",
  "label",
  "hiddenlabel",
  "phigher",
  "plower",
  "probability",
  "answer",
  "answers",
  "live",
  "lower",
  "higher",
  "tie",
  "arenascore",
  "arenaranking",
  "gateresult",
  "deploymentstatus",
  "deploymenteligible",
  "champion",
  "championstatus",
  "validationresult",
  "testresult",
  "profitability",
  "pnl",
  "sharpe",
  "trades",
  "tradelist",
  "classifierevaluation",
  "classifierfeatures",
  "classifierderivedfeatures",
  "clfeat",
  "apikey",
  "authorization",
  "bearer",
  "env",
]);

const FORBIDDEN_KEY_SET = new Set(DIRECTION_FORBIDDEN_KEYS);

/** Credential-shaped key name patterns (patterns, not literal words). */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  { label: "credential-key-name", re: /^(private|secret)[_-]?key$/ },
  { label: "credential-word-name", re: /^seed[_-]?phr/ },
  { label: "credential-word-name", re: /^mnem/ },
  { label: "credential-word-name", re: /^(passphrase|wallet[_-]?secret)$/ },
]);

/** Structural leak patterns inside string values. */
const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { label: "api-key", re: /\b(sk|pk)-[A-Za-z0-9]{16,}/ },
  { label: "bearer-token", re: /bearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "env-assignment", re: /\b[A-Z0-9_]{3,}_(KEY|TOKEN|SECRET)\s*=/ },
]);

/** Volatile fields excluded from the packet digest (they vary per run, not per content). */
export const DIRECTION_VOLATILE_PACKET_FIELDS = Object.freeze(["createdAt", "generatedBy"]);

/** Stable, key-sorted projection used for the digest. */
function stableProjection(value) {
  if (Array.isArray(value)) return value.map((entry) => stableProjection(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (DIRECTION_VOLATILE_PACKET_FIELDS.includes(key)) continue;
      out[key] = stableProjection(value[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic digest of the CONTENT of a 5I packet (this IS the packet digest). */
export function packetDigestOf(packet) {
  return digestOf(stableProjection(packet ?? {}));
}

/**
 * The packet digest as the Phase 5D runtime computes it. 5I packets never carry
 * `createdAt`/`generatedBy` inside their content-bearing sections, so the two
 * digests are equal by construction — asserted by the validator.
 */
export function packetStateDigestOf(packet) {
  return jevStateDigestOf(packet ?? {});
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function whitelistedFeatures(features) {
  const out = {};
  for (const name of DIRECTION_FEATURE_NAMES) {
    if (!Object.hasOwn(features ?? {}, name)) continue;
    const value = features[name];
    out[name] = value === null || Number.isFinite(value) ? value : null;
  }
  return out;
}

function boundedHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-OBSERVATION_HISTORY_LIMIT)
    .map((entry) => ({
      observedAt: typeof entry?.observedAt === "string" ? entry.observedAt.slice(0, 40) : null,
      priceUsd: finiteOrNull(Number(entry?.priceUsd)),
    }));
}

function boundedRegime(regime) {
  if (!regime || typeof regime !== "object") return null;
  const metrics = {};
  for (const [key, value] of Object.entries(regime.metrics ?? {})) {
    metrics[key] = finiteOrNull(value);
  }
  return {
    regimeName: typeof regime.regimeName === "string" ? regime.regimeName.slice(0, 64) : null,
    confidence: finiteOrNull(regime.confidence),
    reason: typeof regime.reason === "string" ? regime.reason.slice(0, 200) : null,
    metrics,
    derivedFrom: typeof regime.derivedFrom === "string" ? regime.derivedFrom.slice(0, 80) : null,
  };
}

/**
 * Staleness accounting (§26): source age and receipt age are kept SEPARATE and
 * are never mixed. `sourceAgeMs` is null unless the venue supplied its own
 * timestamp — a missing source timestamp is never replaced with receipt time.
 */
function boundedStateAge(stateAge) {
  if (!stateAge || typeof stateAge !== "object") return null;
  return {
    sourceTimestampAvailable: stateAge.sourceTimestampAvailable === true,
    latestSourceEventAt: typeof stateAge.latestSourceEventAt === "string" ? stateAge.latestSourceEventAt.slice(0, 40) : null,
    sourceAgeAtFreezeMs: finiteOrNull(stateAge.sourceAgeAtFreezeMs),
    receiptAgeAtFreezeMs: finiteOrNull(stateAge.receiptAgeAtFreezeMs),
    sourceAgeAtPredictionCompleteMs: finiteOrNull(stateAge.sourceAgeAtPredictionCompleteMs),
    receiptAgeAtPredictionCompleteMs: finiteOrNull(stateAge.receiptAgeAtPredictionCompleteMs),
    maxReceiptStateAgeMs: finiteOrNull(stateAge.maxReceiptStateAgeMs),
    maxSourceStateAgeMs: finiteOrNull(stateAge.maxSourceStateAgeMs),
  };
}

function boundedWarmup(warmup) {
  if (!warmup || typeof warmup !== "object") return null;
  return {
    priorObservationCount: finiteOrNull(warmup.priorObservationCount),
    requiredWarmupObservations: finiteOrNull(warmup.requiredWarmupObservations),
    warmupComplete: warmup.warmupComplete === true,
    warmupIncompleteFeatures: (Array.isArray(warmup.warmupIncompleteFeatures) ? warmup.warmupIncompleteFeatures : [])
      .filter((entry) => typeof entry === "string")
      .slice(0, 32)
      .map((entry) => entry.slice(0, 64)),
  };
}

function boundedUniverse(universe) {
  return {
    observedMarkets: finiteOrNull(universe?.observedMarkets),
    usableMarkets: finiteOrNull(universe?.usableMarkets),
    source: typeof universe?.source === "string" ? universe.source.slice(0, 64) : null,
    endpoints: (Array.isArray(universe?.endpoints) ? universe.endpoints : [])
      .filter((entry) => typeof entry === "string")
      .slice(0, 8)
      .map((entry) => entry.slice(0, 48)),
    synthetic: universe?.synthetic === true,
  };
}

/**
 * Build the versioned, whitelisted 5I packet.
 *
 * @param {{
 *   experimentId?: string|null,
 *   observationId: string,
 *   observationIndex: number,
 *   market?: object,
 *   horizonSeconds?: number,
 *   stateObservedAt: string,
 *   stateAgeMs?: number|null,
 *   features: Record<string, number|null>,
 *   recentObservationHistory?: Array<object>,
 *   regime?: object|null,
 *   universe?: object|null,
 *   quoteObservationAvailable?: boolean,
 *   createdAt?: string|null,
 *   generatedBy?: object|null,
 * }} input
 */
export function buildDirectionPacket(input = {}) {
  const market = input.market ?? BENCHMARK_MARKET;
  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    packetVersion: DIRECTION_PACKET_VERSION,
    packetKind: DIRECTION_PACKET_KIND,
    phase: DIRECTION_PHASE,
    evidenceClass: DIRECTION_ALLOWED_EVIDENCE_CLASS,
    experimentId: typeof input.experimentId === "string" ? input.experimentId.slice(0, 160) : null,
    observationId: typeof input.observationId === "string" ? input.observationId.slice(0, 160) : null,
    observationIndex: Number.isFinite(input.observationIndex) ? Math.max(0, Math.round(input.observationIndex)) : null,
    market: {
      marketId: market.marketId ?? BENCHMARK_MARKET.marketId,
      displayName: market.displayName ?? BENCHMARK_MARKET.displayName,
      baseSymbol: market.baseSymbol ?? BENCHMARK_MARKET.baseSymbol,
      quoteSymbol: market.quoteSymbol ?? BENCHMARK_MARKET.quoteSymbol,
      baseMint: market.baseMint ?? BENCHMARK_MARKET.baseMint,
      quoteMint: market.quoteMint ?? BENCHMARK_MARKET.quoteMint,
      quoteConvention: market.quoteConvention ?? BENCHMARK_MARKET.quoteConvention,
      referencePriceSource: market.referencePriceSource ?? BENCHMARK_MARKET.referencePriceSource,
    },
    horizonSeconds: finiteOrNull(input.horizonSeconds) ?? HORIZON_SECONDS,
    targetAtBasis: TARGET_AT_BASIS,
    sourceEventAt: typeof input.sourceEventAt === "string" ? input.sourceEventAt.slice(0, 40) : null,
    receivedAt: typeof input.receivedAt === "string" ? input.receivedAt.slice(0, 40) : null,
    stateObservedAt: typeof input.stateObservedAt === "string" ? input.stateObservedAt.slice(0, 40) : null,
    stateAge: boundedStateAge(input.stateAge),
    preOutcomeInputDigest: typeof input.preOutcomeInputDigest === "string" ? input.preOutcomeInputDigest.slice(0, 64) : null,
    warmup: boundedWarmup(input.warmup),
    quoteObservationAvailable: input.quoteObservationAvailable === true,
    features: whitelistedFeatures(input.features),
    recentObservationHistory: boundedHistory(input.recentObservationHistory),
    regime: boundedRegime(input.regime),
    universe: boundedUniverse(input.universe),
    unavailableFeatureFamilies: UNAVAILABLE_FEATURE_FAMILIES.map((entry) => ({
      family: entry.family,
      reason: entry.reason.slice(0, 240),
    })),
    excludedEvidenceClasses: [...DIRECTION_EXCLUDED_EVIDENCE_CLASSES],
    limitations: [
      "Pre-outcome market state only: no outcome, no target label, no future price, no Arena/gate/deployment/champion state.",
      "Directional prediction benchmark only: it implies nothing about profitability, execution, or trading authority.",
      "No order-book / CVD / queue-depth / maker-flow / quote-spread features exist in EVOLVE's observed schema; they are declared unavailable, not approximated.",
    ],
    createdAt: input.createdAt ?? null,
    generatedBy: input.generatedBy ?? null,
  };
}

/**
 * Walk the packet and report every forbidden key and forbidden string value.
 * @returns {{ ok: boolean, violations: Array<{ path: string, kind: string, detail: string }> }}
 */
export function auditDirectionPacket(packet) {
  const violations = [];
  const seen = new WeakSet();

  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    const kind = typeof value;
    if (kind === "string") {
      for (const { label, re } of FORBIDDEN_VALUE_PATTERNS) {
        if (re.test(value)) violations.push({ path, kind: "value", detail: label });
      }
      return;
    }
    if (kind !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      // `unavailableFeatureFamilies` names the families EVOLVE CANNOT observe;
      // it never carries a value for them, so the family vocabulary itself is
      // not a leak. The walk still descends into it.
      const forbiddenKey = FORBIDDEN_KEY_SET.has(normalized);
      const forbiddenPattern = FORBIDDEN_KEY_PATTERNS.find((entryPattern) => entryPattern.re.test(normalized));
      if (forbiddenKey || forbiddenPattern) {
        violations.push({
          path: `${path}.${key}`,
          kind: "key",
          detail: forbiddenPattern ? forbiddenPattern.label : "forbidden packet field",
        });
      }
      walk(entry, `${path}.${key}`);
    }
  };

  walk(packet, "packet");
  return { ok: violations.length === 0, violations };
}
