/**
 * Jev decision packet (Phase 5D) — versioned, bounded, TRAIN-safe, WHITELIST-ONLY.
 *
 * This is the ONLY channel through which Jev learns anything about EVOLVE
 * state. Two structural guarantees, not good intentions (mirrors the Phase 5B
 * evidence-packet boundary in `scripts/research/evidence-packet.mjs`, kept as
 * a SEPARATE implementation because Jev is a separate subsystem):
 *
 *   1. `buildCandidateDecisionPacket` / `buildMarketDecisionPacket` build a
 *      WHITELISTED projection — only named, bounded fields can ever appear,
 *      never "the rest of the candidate/dataset/repo".
 *   2. `auditJevDecisionPacket` walks the packet (including nested objects)
 *      and reports any forbidden key or secret-shaped value, so a future edit
 *      that accidentally widens the packet is caught by a test rather than
 *      going unnoticed.
 *
 * Explicitly EXCLUDED from every decision packet: VALIDATE outcomes, TEST
 * outcomes, OOS results, Arena ranking, Arena Score, gate result, Champion
 * League result, deployment status, future observations, Shadow League
 * outcomes, and future replication results. Jev only ever sees evidence that
 * was available BEFORE the outcome it is being asked to predict.
 *
 * PAPER ONLY.
 */

import { digestOf } from "../lib/hash.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";
import { REGIMES } from "../arena/orchestrator.mjs";

export const JEV_DECISION_PACKET_VERSION = 1;

export const JEV_PACKET_KIND = Object.freeze({
  CANDIDATE: "JEV_CANDIDATE_DECISION_PACKET",
  MARKET: "JEV_MARKET_DECISION_PACKET",
});

/** The only evidence class a Jev decision packet may declare. */
export const JEV_ALLOWED_EVIDENCE_CLASS = "TRAIN_EVIDENCE";

/** Every outcome class explicitly excluded, named so an artifact can declare what it excluded. */
export const JEV_EXCLUDED_EVIDENCE_CLASSES = Object.freeze([
  "VALIDATION_EVIDENCE",
  "TEST_EVIDENCE",
  "OOS_EVIDENCE",
  "STRESS_EVIDENCE",
  "DEPLOYMENT_EVIDENCE",
  "ARENA_RANKING",
  "ARENA_SCORE",
  "GATE_RESULT",
  "CHAMPION_LEAGUE_RESULT",
  "DEPLOYMENT_STATUS",
  "FUTURE_OBSERVATION",
  "SHADOW_LEAGUE_OUTCOME",
  "FUTURE_REPLICATION_RESULT",
]);

/** Numeric genome parameters that may be projected into a decision packet. Anything else is dropped. */
export const ALLOWED_GENOME_PARAM_KEYS = Object.freeze([
  "momentumWeight",
  "flowWeight",
  "entryScoreThreshold",
  "minLiquidityQuality",
  "maxHold",
  "riskFraction",
  "stopLoss",
  "takeProfit",
  "maxTopHolderPct",
]);

/** Whitelisted watchdog verdicts (mirrors `research/watchdog.mjs` WATCHDOG_VERDICT). */
const ALLOWED_WATCHDOG_VERDICTS = new Set(["NORMAL", "WATCH", "QUARANTINED"]);

/** Field names that may never appear anywhere inside a Jev decision packet. */
export const FORBIDDEN_JEV_KEYS = Object.freeze([
  "oosreturn",
  "oosreturns",
  "ooswindows",
  "oosscore",
  "testreturn",
  "testresults",
  "testscore",
  "validationreturn",
  "validationresults",
  "finalrank",
  "arenarank",
  "arenascore",
  "score",
  "gateresult",
  "gatestatus",
  "deploymentgatestatus",
  "deploymenteligible",
  "deploymentstatus",
  "deploymentcandidates",
  "championleague",
  "championleaguejson",
  "halloffame",
  "shadowstatus",
  "shadowleague",
  "shadowleagueoutcome",
  "future",
  "futuresnapshot",
  "futuresnapshots",
  "futuremarket",
  "futureobservation",
  "replicationresult",
  "replicationstatus",
  "hiddenlabel",
  "hiddenlabels",
  "label",
  "apikey",
  "authorization",
  "bearer",
  "env",
]);

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_JEV_KEYS);

/** Credential-shaped key name PATTERNS (kept as patterns, not literal words — see evidence-packet.mjs precedent). */
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

/** Volatile fields excluded from the state digest (they change per run, not per content). */
const VOLATILE_PACKET_FIELDS = Object.freeze(["createdAt", "generatedBy"]);

function stableProjection(value) {
  if (Array.isArray(value)) return value.map((entry) => stableProjection(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_PACKET_FIELDS.includes(key)) continue;
      out[key] = stableProjection(value[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic digest of the CONTENT of a decision packet ("stateDigest"). */
export function jevStateDigestOf(packet) {
  return digestOf(stableProjection(packet ?? {}));
}

/* ============================================================================
 * Audit: nothing forbidden may be inside the packet
 * ==========================================================================*/

/**
 * Walk the packet and report every forbidden key and forbidden string value.
 * @returns {{ ok: boolean, violations: Array<{ path: string, kind: string, detail: string }> }}
 */
export function auditJevDecisionPacket(packet) {
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
      const forbiddenKey = FORBIDDEN_KEY_SET.has(normalized);
      const forbiddenPattern = FORBIDDEN_KEY_PATTERNS.find((entryPattern) => entryPattern.re.test(normalized));
      if (forbiddenKey || forbiddenPattern) {
        violations.push({
          path: `${path}.${key}`,
          kind: "key",
          detail: forbiddenPattern ? forbiddenPattern.label : "forbidden decision-packet field",
        });
      }
      walk(entry, `${path}.${key}`);
    }
  };

  walk(packet, "packet");
  return { ok: violations.length === 0, violations };
}

/* ============================================================================
 * Candidate decision packet
 * ==========================================================================*/

function boundedGenomeParams(params) {
  const out = {};
  for (const key of ALLOWED_GENOME_PARAM_KEYS) {
    const value = params?.[key];
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function boundedRegimeComposition(distribution) {
  const out = {};
  for (const regime of REGIMES) {
    const value = distribution?.[regime];
    if (Number.isFinite(value)) out[regime] = value;
  }
  return out;
}

function boundedWatchdogEvidence(watchdog) {
  if (!watchdog || typeof watchdog !== "object") return { verdict: null, findings: [] };
  const verdict = ALLOWED_WATCHDOG_VERDICTS.has(watchdog.verdict) ? watchdog.verdict : null;
  const findings = (Array.isArray(watchdog.findings) ? watchdog.findings : []).slice(0, 8).map((finding) => ({
    kind: typeof finding?.kind === "string" ? finding.kind.slice(0, 64) : null,
    detail: typeof finding?.detail === "string" ? redactSecrets(finding.detail).slice(0, 200) : null,
    severity: typeof finding?.severity === "string" ? finding.severity.slice(0, 32) : null,
  }));
  return { verdict, findings };
}

/**
 * Build the versioned, whitelisted candidate decision packet handed to Jev's
 * candidate question set (jev-question-set-v1).
 *
 * @param {{
 *   experimentId?: string|null,
 *   candidateDigest: string,
 *   species?: string|null,
 *   family?: string|null,
 *   authorRole?: string|null,
 *   parentFamilies?: string[],
 *   genomeParams?: object,
 *   train: {
 *     paperReturn?: number|null,
 *     observationCount?: number|null,
 *     tradeCount?: number|null,
 *     mintDiversity?: number|null,
 *     concentration?: number|null,
 *     costDrag?: number|null,
 *     drawdown?: number|null,
 *     regimeDistribution?: Record<string, number>,
 *   },
 *   watchdog?: { verdict: string, findings: object[] } | null,
 *   researchLifecycleState?: string|null,
 *   createdAt?: string|null,
 *   generatedBy?: object|null,
 * }} input
 */
export function buildCandidateDecisionPacket(input = {}) {
  const train = input.train ?? {};
  const packet = {
    packetVersion: JEV_DECISION_PACKET_VERSION,
    packetKind: JEV_PACKET_KIND.CANDIDATE,
    experimentId: input.experimentId ?? null,
    evidenceClasses: [JEV_ALLOWED_EVIDENCE_CLASS],
    excludedEvidenceClasses: [...JEV_EXCLUDED_EVIDENCE_CLASSES],
    candidate: {
      candidateDigest: typeof input.candidateDigest === "string" ? input.candidateDigest.slice(0, 128) : null,
      species: typeof input.species === "string" ? input.species.slice(0, 64) : null,
      family: typeof input.family === "string" ? input.family.slice(0, 64) : null,
      authorRole: typeof input.authorRole === "string" ? input.authorRole.slice(0, 64) : null,
      parentFamilies: (Array.isArray(input.parentFamilies) ? input.parentFamilies : [])
        .filter((entry) => typeof entry === "string")
        .slice(0, 8)
        .map((entry) => entry.slice(0, 64)),
      genomeParams: boundedGenomeParams(input.genomeParams ?? {}),
    },
    train: {
      paperReturn: Number.isFinite(train.paperReturn) ? train.paperReturn : null,
      observationCount: Number.isFinite(train.observationCount) ? train.observationCount : null,
      tradeCount: Number.isFinite(train.tradeCount) ? train.tradeCount : null,
      mintDiversity: Number.isFinite(train.mintDiversity) ? train.mintDiversity : null,
      concentration: Number.isFinite(train.concentration) ? train.concentration : null,
      costDrag: Number.isFinite(train.costDrag) ? train.costDrag : null,
      drawdown: Number.isFinite(train.drawdown) ? train.drawdown : null,
      regimeComposition: boundedRegimeComposition(train.regimeDistribution ?? {}),
    },
    watchdogEvidence: boundedWatchdogEvidence(input.watchdog),
    researchLifecycleState:
      typeof input.researchLifecycleState === "string" ? input.researchLifecycleState.slice(0, 64) : null,
    limitations: [
      "TRAIN-window evidence only. No validation, test, out-of-sample, stress, Arena, gate, champion-league, " +
        "deployment, shadow-league, or replication outcome is present.",
      "Shadow prediction only: this packet's answers have no authority over trading, evolution, Arena, or deployment.",
    ],
    createdAt: input.createdAt ?? null,
    generatedBy: input.generatedBy ?? null,
  };
  return packet;
}

/* ============================================================================
 * Market (regime shadow) decision packet
 * ==========================================================================*/

/** Whitelisted aggregate market feature keys (mirrors evidence-packet.mjs FEATURE_KEYS). */
export const MARKET_FEATURE_KEYS = Object.freeze([
  "medianReturn",
  "meanReturn",
  "dispersion",
  "liquidityChange",
  "volumeChange",
  "positiveRatio",
  "buySellRatio",
  "organicRatio",
  "activeTokens",
  "launchHeavyRatio",
  "activityPerSnapshot",
  "meanLiquidityUsd",
  "returnCount",
  "snapshots",
]);

function boundedMarketFeatures(features) {
  const out = {};
  for (const key of MARKET_FEATURE_KEYS) {
    const value = features?.[key];
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Build the market-window decision packet handed to Jev's `jev-market-v1`
 * question set. INTENTIONALLY omits the deterministic regime label: Jev must
 * classify blind from aggregate TRAIN statistics alone, and the deterministic
 * label is compared afterward by EVOLVE — never given to Jev as a hint.
 *
 * @param {{
 *   experimentId?: string|null,
 *   windowLabel: string,
 *   marketFeatures: object,
 *   createdAt?: string|null,
 *   generatedBy?: object|null,
 * }} input
 */
export function buildMarketDecisionPacket(input = {}) {
  return {
    packetVersion: JEV_DECISION_PACKET_VERSION,
    packetKind: JEV_PACKET_KIND.MARKET,
    experimentId: input.experimentId ?? null,
    evidenceClasses: [JEV_ALLOWED_EVIDENCE_CLASS],
    excludedEvidenceClasses: [...JEV_EXCLUDED_EVIDENCE_CLASSES],
    windowLabel: typeof input.windowLabel === "string" ? input.windowLabel.slice(0, 64) : null,
    marketFeatures: boundedMarketFeatures(input.marketFeatures ?? {}),
    limitations: [
      "TRAIN-window aggregate statistics only; the deterministic regime label is intentionally withheld.",
      "Shadow classification only: never modifies or bypasses the deterministic regime classifier.",
    ],
    createdAt: input.createdAt ?? null,
    generatedBy: input.generatedBy ?? null,
  };
}
