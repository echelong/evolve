/**
 * Jev-assisted PAPER SHADOW dashboard experiment — frozen definition.
 *
 * This is a DEVELOPMENT / OBSERVABILITY experiment ONLY. It runs a separate,
 * Jev-controlled paper account beside the normal EVOLVE live dashboard and
 * paper evolutionary engine and records what it did. It is NOT canonical
 * predictive evidence and must never be treated as replication evidence.
 *
 * Everything this subsystem pins is a constant here, chosen before any result
 * was observed:
 *
 *   - the one market (SOL/USDC, the SAME wrapped-SOL / USDC identity Phase 5I
 *     already defines);
 *   - the one provider/model/transport (direct TypeSafe Jev, `typesafe-jev`,
 *     `jev-1.13.0`, `gatewayUsed=false`, cache disabled);
 *   - the deterministic paper policy boundary (pHigher >= 0.50 => HIGHER) with
 *     NO hysteresis and NO confidence threshold;
 *   - the frozen position fraction (0.25) and starting cash ($100);
 *   - the explicit classification every session persists.
 *
 * ISOLATION. Storage lives in a completely separate tree and NOTHING here may
 * write into any Phase 5I canonical evidence tree, the Shadow League, the Arena,
 * research, evolution, or the deployment gates. There is no wallet, no signing,
 * no swap, no order, no RPC write, and no real-money execution anywhere in this
 * subsystem — it is PAPER ONLY.
 */

import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import { JEV_PROVIDER_UPSTREAM } from "../config.mjs";
import {
  BENCHMARK_MARKET,
  MAX_RECEIPT_STATE_AGE_MS,
  RECOMMENDED_ENDPOINT_ORDER,
  REQUIRED_GATEWAY_USED,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
} from "../direction/definition.mjs";

export const PAPER_SHADOW_PHASE = "5I-PS";
export const PAPER_SHADOW_SCHEMA_VERSION = 1;
export const PAPER_SHADOW_KIND = "JEV_PAPER_SHADOW_DASHBOARD_EXPERIMENT";

/** A completely separate tree. Never Phase 5I's `jev-direction`. */
export const PAPER_SHADOW_ROOT_DIR = path.join(".evolve", "jev-paper-shadow");
export const PAPER_SHADOW_SESSION_FILE = "session.json";
export const PAPER_SHADOW_EVENTS_FILE = "events.ndjson";
export const PAPER_SHADOW_STATE_FILE = "state.json";
export const PAPER_SHADOW_SUMMARY_FILE = "summary.json";

/**
 * The ONE purpose string every session persists. There is no other purpose: a
 * session that does not declare this is not this experiment.
 */
export const PAPER_SHADOW_PURPOSE = "DEVELOPMENT_DASHBOARD_PAPER_DEMO";

/**
 * The explicit classification. EVERY session persists exactly these flags, and
 * the dashboard renders the same statement verbatim. Nothing here may ever be
 * flipped to true by any code path.
 */
export const PAPER_SHADOW_CLASSIFICATION = Object.freeze({
  purpose: PAPER_SHADOW_PURPOSE,
  paperOnly: true,
  shadowOnly: true,
  canonicalEvidence: false,
  replicationEvidence: false,
  temporalReplicationEvidence: false,
  arenaEligible: false,
  deploymentEligible: false,
  profitabilityInferencePermitted: false,
  tradingInferencePermitted: false,
});

export const PAPER_SHADOW_LABEL = "JEV PAPER SHADOW • DEVELOPMENT ONLY";
export const PAPER_SHADOW_ACCOUNTING_NOTE =
  "Simulated paper accounting. Not replication evidence. Not profitability evidence.";
export const PAPER_SHADOW_PAPER_ONLY_TAG = "PAPER ONLY";
export const PAPER_SHADOW_EXCLUSION_NOTE =
  "Development dashboard experiment — excluded from replication/Arena/deployment evidence.";

/** The one market. The SAME identity Phase 5I already defines. */
export const PAPER_SHADOW_MARKET = BENCHMARK_MARKET;
export const PAPER_SHADOW_MARKET_ID = BENCHMARK_MARKET.marketId;
export const PAPER_SHADOW_SUPPORTED_MARKET_IDS = Object.freeze([BENCHMARK_MARKET.marketId]);
export const PAPER_SHADOW_RECOMMENDED_ENDPOINT_ORDER = RECOMMENDED_ENDPOINT_ORDER;

/* ============================================================================
 * Provider / model / transport pins (direct TypeSafe only)
 * ==========================================================================*/

export const PAPER_SHADOW_REQUIRED_PROVIDER = REQUIRED_PROVIDER;
export const PAPER_SHADOW_REQUIRED_MODEL = REQUIRED_MODEL;
export const PAPER_SHADOW_REQUIRED_UPSTREAM_PROVIDER = REQUIRED_UPSTREAM_PROVIDER;
export const PAPER_SHADOW_REQUIRED_GATEWAY_USED = REQUIRED_GATEWAY_USED;
/** The offline mock is never acceptable for a canonical paper-shadow session. */
export const PAPER_SHADOW_FORBIDDEN_PROVIDERS = Object.freeze(["mock-jev", "vercel-jev"]);
export const PAPER_SHADOW_CACHE_ENABLED = false;
export const PAPER_SHADOW_MODE = "shadow";

/* ============================================================================
 * Bounded run defaults
 * ==========================================================================*/

export const PAPER_SHADOW_DEFAULT_DURATION_MINUTES = 60;
export const PAPER_SHADOW_DURATION_BOUNDS = Object.freeze({ min: 1, max: 1_440 });
export const PAPER_SHADOW_DEFAULT_CADENCE_MS = 30_000;
export const PAPER_SHADOW_CADENCE_BOUNDS = Object.freeze({ min: 5_000, max: 3_600_000 });
/** Absolute safety ceiling on decisions per session (bounded duration already bounds this). */
export const PAPER_SHADOW_MAX_DECISIONS = 10_000;

/* ============================================================================
 * Frozen paper policy constants
 * ==========================================================================*/

export const PAPER_SHADOW_STARTING_CASH = 100;
/** Frozen engineering/demo constant chosen BEFORE observing results. Never adapted. */
export const PAPER_SHADOW_POSITION_FRACTION = 0.25;
/**
 * The frozen binary action boundary. NO confidence threshold, NO hysteresis:
 *   pHigher >= 0.50  => HIGHER
 *   pHigher <  0.50  => LOWER
 */
export const PAPER_SHADOW_INTENT_THRESHOLD = 0.5;

/** Paper account states. No short, no leverage: FLAT or LONG only. */
export const PAPER_SHADOW_ACCOUNT_STATES = Object.freeze({ FLAT: "FLAT", LONG: "LONG" });

/** Deterministic paper actions. `NO_ACTION` is never a trade. */
export const PAPER_SHADOW_ACTIONS = Object.freeze({
  ENTER: "ENTER",
  HOLD: "HOLD",
  EXIT: "EXIT",
  CASH: "CASH",
  NO_ACTION: "NO_ACTION",
});

/** Market-feed health labels recorded on every decision. */
export const PAPER_SHADOW_FEED_HEALTH = Object.freeze({ LIVE: "LIVE", DEGRADED: "FEED_DEGRADED" });

/** A frozen observation older than this is a degraded feed: no new entries. */
export const PAPER_SHADOW_MAX_FEED_STALE_MS = MAX_RECEIPT_STATE_AGE_MS;

/* ============================================================================
 * Bounded publication limits (dashboard reads only the compact latest state)
 * ==========================================================================*/

export const PAPER_SHADOW_RECENT_DECISION_LIMIT = 20;
export const PAPER_SHADOW_EQUITY_SERIES_LIMIT = 480;

/* ============================================================================
 * Isolation guards
 * ==========================================================================*/

/**
 * Trees this subsystem may NEVER write into. Kept as a single source of truth so
 * both the runner and the validator can assert against the same list.
 */
export const PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS = Object.freeze([
  path.join(".evolve", "jev-direction"),
  path.join(".evolve", "jev-direction", "replication"),
  path.join(".evolve", "jev-direction", "temporal"),
  path.join(".evolve", "shadow"),
  path.join(".evolve", "arenas"),
]);

/* ============================================================================
 * Session identity
 * ==========================================================================*/

/** Compact UTC stamp matching the Phase 5I / Arena convention. */
export function paperShadowCompactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `jpaper-<UTC timestamp>-<short digest>`. */
export function paperShadowSessionIdFor({ startedAt = Date.now(), salt = "" } = {}) {
  const stamp = paperShadowCompactStamp(startedAt);
  const suffix = digestOf({ kind: PAPER_SHADOW_KIND, startedAt, salt }).slice(0, 6);
  return `jpaper-${stamp}-${suffix}`;
}

export function isValidPaperShadowSessionId(sessionId) {
  return typeof sessionId === "string" && /^jpaper-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(sessionId);
}

/**
 * Resolve a session's isolated root. Refuses any id that is not a paper-shadow
 * session id, and refuses any root that would land inside a forbidden tree.
 */
export function paperShadowSessionRootFor(baseRoot, sessionId) {
  if (!isValidPaperShadowSessionId(sessionId)) {
    throw new Error(`invalid Jev paper-shadow session id '${sessionId}'`);
  }
  const root = path.join(baseRoot ?? PAPER_SHADOW_ROOT_DIR, sessionId);
  if (!isPathWithin(root, baseRoot ?? PAPER_SHADOW_ROOT_DIR)) {
    throw new Error(`refusing a paper-shadow session root outside its base tree: ${root}`);
  }
  return root;
}

/** True when `candidate` resolves to `parent` or a path inside it. */
export function isPathWithin(candidate, parent) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

/**
 * FAIL-CLOSED guard: throw if a paper-shadow write target lands inside any
 * forbidden root. Called before every storage write path is created.
 */
export function assertPaperShadowWriteTarget(target, baseRoot) {
  for (const forbidden of PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS) {
    if (isPathWithin(target, path.resolve(forbidden))) {
      throw new Error(
        `refusing to write to ${target}: it is inside the forbidden Phase 5I / Arena / Shadow tree ${forbidden}`,
      );
    }
  }
  if (baseRoot && !isPathWithin(target, baseRoot)) {
    throw new Error(`refusing to write to ${target}: it is outside the paper-shadow base tree ${baseRoot}`);
  }
  return true;
}

/**
 * The upstream identity implied by a resolved provider NAME (§15 fix).
 *
 * The provider objects expose `name`, `model` and `transport` — but no upstream
 * field — so a session that read `provider?.upstream` always persisted
 * `upstream: null` even when its route was the direct TypeSafe one. This resolves
 * the upstream from the documented provider registry instead, so NEW sessions
 * persist the real upstream identity. Prior captures are never rewritten.
 */
export function paperShadowUpstreamFor(providerName) {
  if (providerName === null || providerName === undefined || providerName === "") return null;
  return JEV_PROVIDER_UPSTREAM[String(providerName)] ?? null;
}

/** The route/model identity recorded on every session, never a secret. */
export function paperShadowProviderIdentity(envConfig, provider) {
  return {
    provider,
    model: PAPER_SHADOW_REQUIRED_MODEL,
    upstream: PAPER_SHADOW_REQUIRED_UPSTREAM_PROVIDER,
    gatewayUsed: false,
    mode: PAPER_SHADOW_MODE,
    cacheEnabled: PAPER_SHADOW_CACHE_ENABLED,
    baseURLConfigured: typeof envConfig?.baseURL === "string" && envConfig.baseURL.length > 0,
  };
}
