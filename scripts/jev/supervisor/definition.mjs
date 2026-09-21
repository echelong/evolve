/**
 * Phase 5I-PS.2 — JEV SUPERVISOR OBSERVER (frozen definition).
 *
 * The purpose is to test Jev in the role originally intended for EVOLVE: an
 * OUTSIDE DECISION SUPERVISOR observing deterministic EVOLVE paper decisions.
 *
 *   NORMAL EVOLVE DECISION
 *           │
 *           ▼
 *   proposal frozen
 *           │
 *           ├──────────────► normal PAPER execution happens immediately
 *           │
 *           ▼
 *   passive observer queue
 *           │
 *           ▼
 *   direct TypeSafe Jev
 *           │
 *           ▼
 *   agreement/disagreement record ONLY
 *
 * JEV HAS ZERO AUTHORITY IN THIS PHASE. It cannot allow, block, alter, resize
 * or delay a trade, and it cannot touch a genome, fitness, evolution, the
 * Arena, research candidates, selection, Temporal 5I.1a, or canonical Phase 5I
 * evidence. No real money, no wallet, no signing, no swap/order execution, no
 * RPC write — PAPER ONLY.
 *
 * Everything that decides what this subsystem DOES and what it may READ is a
 * frozen constant in this file, chosen before any live observer session ran:
 * the one market, the direct-TypeSafe provider pins, the proposal
 * classification rule, the agreement semantics, the bounded queue capacity,
 * and the isolated storage tree.
 */

import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import {
  BENCHMARK_MARKET,
  REQUIRED_GATEWAY_USED,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
} from "../direction/definition.mjs";
import {
  DIRECTION_QUESTION_SET_ID,
  DIRECTION_QUESTION_SET_VERSION,
  directionQuestionDigest,
} from "../direction/questions.mjs";
import {
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
} from "../direction/features.mjs";

export const SUPERVISOR_PHASE = "5I-PS.2";
export const SUPERVISOR_SCHEMA_VERSION = 1;
export const SUPERVISOR_KIND = "JEV_SUPERVISOR_OBSERVER";

/** A completely separate tree. Never a canonical 5I / Paper Shadow / Arena tree. */
export const SUPERVISOR_ROOT_DIR = path.join(".evolve", "jev-supervisor-observer");
export const SUPERVISOR_SESSION_FILE = "session.json";
export const SUPERVISOR_PROPOSALS_FILE = "proposals.ndjson";
export const SUPERVISOR_JUDGMENTS_FILE = "judgments.ndjson";
export const SUPERVISOR_STATE_FILE = "state.json";
export const SUPERVISOR_SUMMARY_FILE = "summary.json";

/** The one purpose string every session persists. There is no other purpose. */
export const SUPERVISOR_PURPOSE = "JEV_SUPERVISOR_OBSERVER";

/**
 * The explicit classification. EVERY session, proposal record, judgment
 * record, state and summary persists exactly these flags, and nothing in this
 * subsystem may ever flip one to true.
 */
export const SUPERVISOR_CLASSIFICATION = Object.freeze({
  purpose: SUPERVISOR_PURPOSE,
  developmentOnly: true,
  observerOnly: true,
  paperOnly: true,
  jevHasTradingAuthority: false,
  jevHasEvolutionAuthority: false,
  jevHasSelectionAuthority: false,
  jevHasArenaAuthority: false,
  jevHasDeploymentAuthority: false,
  canonicalEvidence: false,
  replicationEvidence: false,
  temporalReplicationEvidence: false,
  profitabilityInferencePermitted: false,
  parameterSelectionPermitted: false,
});

export const SUPERVISOR_LABEL = "JEV SUPERVISOR OBSERVER";
export const SUPERVISOR_NO_AUTHORITY_TAG = "NO AUTHORITY • PAPER ONLY";
export const SUPERVISOR_STATEMENT =
  "Jev observes completed EVOLVE paper decisions. It cannot approve, reject, resize, delay, or alter trades. " +
  "Development evidence only.";
export const SUPERVISOR_ISOLATION_STATEMENT =
  "Passive observer only: no wallet, no signing, no swap, no order execution, no RPC write, and no return value " +
  "consumed by any engine, evolution, selection, Arena or research code path.";

/* ============================================================================
 * Provider / model / transport pins (direct TypeSafe only, fail closed)
 * ==========================================================================*/

export const SUPERVISOR_REQUIRED_PROVIDER = REQUIRED_PROVIDER; // typesafe-jev
export const SUPERVISOR_REQUIRED_MODEL = REQUIRED_MODEL; // jev-1.13.0
export const SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER = REQUIRED_UPSTREAM_PROVIDER; // typesafe-ai
export const SUPERVISOR_REQUIRED_GATEWAY_USED = REQUIRED_GATEWAY_USED;
export const SUPERVISOR_MODE = "shadow";
export const SUPERVISOR_CACHE_ENABLED = false;

/**
 * Routes that may NEVER answer a supervisor observation. There is NO fallback:
 * a mismatch fails closed into an observer FAILURE RECORD, never into a
 * trading decision and never into another route/model/cache.
 */
export const SUPERVISOR_FORBIDDEN_PROVIDERS = Object.freeze(["mock-jev", "vercel-jev"]);

/* ============================================================================
 * Market scope — SOL-USDC only, using the EXISTING wrapped SOL / USDC identity
 * ==========================================================================*/

export const SUPERVISOR_MARKET = BENCHMARK_MARKET;
export const SUPERVISOR_MARKET_ID = BENCHMARK_MARKET.marketId;
export const SUPERVISOR_SUPPORTED_MARKET_IDS = Object.freeze([BENCHMARK_MARKET.marketId]);

/**
 * The ONE traded identity this subsystem supports. EVOLVE's simulation may
 * encounter proposals for many tokens; for anything else EVOLVE behaves
 * normally, NO Jev call occurs, `unsupportedProposalCount` is incremented, and
 * another asset is NEVER reinterpreted using the canonical SOL question set.
 *
 * USDC is the QUOTE identity of the benchmark pair (provenance only) — it is
 * not a second supported trading market, and the canonical SOL direction
 * packet is never generalized to it in this phase.
 */
export const SUPERVISOR_SUPPORTED_MINTS = Object.freeze([BENCHMARK_MARKET.baseMint]);
export const SUPERVISOR_QUOTE_MINT = BENCHMARK_MARKET.quoteMint;
export const SUPERVISOR_UNSUPPORTED_MARKET_REASON = "UNSUPPORTED_MARKET";

/* ============================================================================
 * Frozen proposal classification (decided BEFORE any result)
 * ==========================================================================*/

export const SUPERVISOR_ACTIONS = Object.freeze({
  ENTER_LONG: "ENTER_LONG",
  EXIT_LONG: "EXIT_LONG",
});

export const SUPERVISOR_REASONS = Object.freeze({
  ENTRY_SIGNAL: "ENTRY_SIGNAL",
  SIGNAL: "SIGNAL",
  STOP: "STOP",
  TAKE: "TAKE",
  TIME: "TIME",
  // The engine's own end-of-generation / end-of-stage settlements flow through
  // the same exit path. They are lifecycle exits, captured with their existing
  // deterministic reason and classified exactly like STOP/TAKE/TIME.
  GEN_END: "GEN-END",
  STAGE_END: "STAGE-END",
});

export const SUPERVISOR_DIRECTIONAL_INTENTS = Object.freeze({
  HIGHER: "HIGHER",
  LOWER: "LOWER",
});

/** Lifecycle/risk exits: NOT directional claims, so never agree/disagree. */
export const SUPERVISOR_LIFECYCLE_EXIT_REASONS = Object.freeze(["STOP", "TAKE", "TIME", "GEN-END", "STAGE-END"]);

export const SUPERVISOR_AGREEMENT = Object.freeze({
  AGREE: "AGREE",
  DISAGREE: "DISAGREE",
  NOT_DIRECTIONALLY_COMPARABLE: "NOT_DIRECTIONALLY_COMPARABLE",
});

/**
 * Why a comparable proposal has no agreement verdict (Jev produced no valid
 * probability). This is NOT agreement and NOT disagreement.
 */
export const SUPERVISOR_AGREEMENT_NO_INTENT_REASON = "NO_JEV_INTENT";

/** The exact probability value that is `exactlyHalf`. There is no other. */
export const SUPERVISOR_EXACT_HALF = 0.5;

/**
 * There is deliberately NO confidence threshold, hysteresis, uncertainty band
 * or distance-from-half cutoff anywhere in this subsystem. Names are listed so
 * the validator can assert they are never recreated.
 */
export const SUPERVISOR_FORBIDDEN_THRESHOLD_NAMES = Object.freeze(["minConfidence", "confidenceThreshold", "uncertaintyZone"]);

/* ============================================================================
 * Bounded observer queue + worker bounds (fixed in source, never derived from
 * performance, chosen BEFORE any live run)
 * ==========================================================================*/

/**
 * Conservative fixed cap on proposals awaiting observer work. When the queue is
 * at capacity, observer work is DROPPED explicitly (`queueDropped`, plus an
 * explicit drop record) — the paper engine is never slowed, never blocked, and
 * never told to wait.
 */
export const SUPERVISOR_QUEUE_CAPACITY = 64;
/** Backstop bound on frozen-but-not-yet-finalized proposals (see observer.mjs). */
export const SUPERVISOR_MAX_PENDING_DRAFTS = 1024;
/** How many drop records are retained for evidence (counts stay exact). */
export const SUPERVISOR_MAX_DROP_RECORDS = 32;
/** Bounded recent rows published to the dashboard. */
export const SUPERVISOR_RECENT_ROW_LIMIT = 24;
/** Worker idle poll interval; the worker is the ONLY thing that ever waits. */
export const SUPERVISOR_WORKER_IDLE_MS = 25;
/** Bounded wait for in-flight observer work during Ctrl+C finalization. */
export const SUPERVISOR_FINALIZE_TIMEOUT_MS = 5_000;
/** Absolute safety ceiling on logical Jev calls in one observer session. */
export const SUPERVISOR_MAX_JEV_CALLS = 2_000;
/** Minimum spacing between dashboard `state.json` publications. */
export const SUPERVISOR_STATE_PUBLISH_INTERVAL_MS = 1_000;
/** Bounded pre-decision SOL observation history carried into the packet. */
export const SUPERVISOR_HISTORY_LIMIT = 64;
/** Bounded pre-decision universe snapshots used by the regime classifier. */
export const SUPERVISOR_REGIME_SNAPSHOT_LIMIT = 12;
/** Bounded markets per frozen regime snapshot (never the whole universe). */
export const SUPERVISOR_REGIME_MARKET_LIMIT = 32;

/* ============================================================================
 * Bounded run defaults (the CLI is bounded only; there is no daemon)
 * ==========================================================================*/

export const SUPERVISOR_DEFAULT_DURATION_MINUTES = 60;
export const SUPERVISOR_DURATION_BOUNDS = Object.freeze({ min: 1, max: 1_440 });

/**
 * Options this phase deliberately does NOT have. Supplying one is a hard error
 * rather than a silently ignored flag: an observer that could be nudged toward
 * influencing a decision is not an observer.
 */
export const SUPERVISOR_FORBIDDEN_FLAGS = Object.freeze([
  "threshold",
  "min-confidence",
  "confidence",
  "trade",
  "trades",
  "wallet",
  "sign",
  "signer",
  "swap",
  "order",
  "execute",
  "route",
  "routing",
  "pnl",
  "profit",
  "profitability",
  "position",
  "position-size",
  "signal",
  "alpha",
  "latest",
  "queue-capacity",
  "speed",
]);

export const SUPERVISOR_BOOLEAN_FLAGS = Object.freeze(["help", "json"]);
export const SUPERVISOR_VALUE_FLAGS = Object.freeze(["minutes", "market", "session"]);

/* ============================================================================
 * Question-set / feature-definition identity (reused, never re-derived)
 * ==========================================================================*/

export const SUPERVISOR_QUESTION_SET_ID = DIRECTION_QUESTION_SET_ID;
export const SUPERVISOR_QUESTION_SET_VERSION = DIRECTION_QUESTION_SET_VERSION;
export const SUPERVISOR_FEATURE_DEFINITION_VERSION = DIRECTION_FEATURE_DEFINITION_VERSION;
export const SUPERVISOR_FEATURE_DEFINITION_DIGEST = DIRECTION_FEATURE_DEFINITION_DIGEST;

/** Digest of the frozen question set — persisted with every judgment. */
export function supervisorQuestionDigest() {
  return directionQuestionDigest();
}

/* ============================================================================
 * Isolation guards
 * ==========================================================================*/

/**
 * Trees this subsystem may NEVER write into. Kept as a single source of truth
 * so the observer and the validator assert against the same list.
 */
export const SUPERVISOR_FORBIDDEN_WRITE_ROOTS = Object.freeze([
  path.join(".evolve", "jev-direction"),
  path.join(".evolve", "jev-direction", "replication"),
  path.join(".evolve", "jev-direction", "temporal"),
  path.join(".evolve", "jev-paper-shadow"),
  path.join(".evolve", "jev-paper-forensics"),
  path.join(".evolve", "shadow"),
  path.join(".evolve", "arenas"),
]);

/** True when `candidate` resolves to `parent` or a path inside it. */
export function isPathWithin(candidate, parent) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

/**
 * FAIL-CLOSED guard: throw if a supervisor write target lands inside any
 * forbidden root (or outside its own base tree). Called before every write.
 */
export function assertSupervisorWriteTarget(target, baseRoot = null) {
  for (const forbidden of SUPERVISOR_FORBIDDEN_WRITE_ROOTS) {
    if (isPathWithin(target, path.resolve(forbidden))) {
      throw new Error(
        `refusing to write to ${target}: it is inside the protected tree ${forbidden} ` +
          "(canonical Phase 5I / Paper Shadow / forensics / Arena evidence)",
      );
    }
  }
  if (baseRoot !== null && !isPathWithin(target, baseRoot)) {
    throw new Error(`refusing to write to ${target}: it is outside the supervisor base tree ${baseRoot}`);
  }
  return true;
}

/* ============================================================================
 * Session identity
 * ==========================================================================*/

/** Compact UTC stamp matching the Phase 5I / paper-shadow convention. */
export function supervisorCompactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `jsup-<UTC timestamp>-<short digest>`. */
export function supervisorSessionIdFor({ startedAt = Date.now(), salt = "" } = {}) {
  const stamp = supervisorCompactStamp(startedAt);
  const suffix = digestOf({ kind: SUPERVISOR_KIND, startedAt, salt }).slice(0, 6);
  return `jsup-${stamp}-${suffix}`;
}

export function isValidSupervisorSessionId(sessionId) {
  return typeof sessionId === "string" && /^jsup-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(sessionId);
}

/** Resolve a session's isolated root; refuses an invalid id or an escaped path. */
export function supervisorSessionRootFor(baseRoot, sessionId) {
  if (!isValidSupervisorSessionId(sessionId)) {
    throw new Error(`invalid Jev supervisor session id '${sessionId}'`);
  }
  const root = path.join(baseRoot ?? SUPERVISOR_ROOT_DIR, sessionId);
  if (!isPathWithin(root, baseRoot ?? SUPERVISOR_ROOT_DIR)) {
    throw new Error(`refusing a supervisor session root outside its base tree: ${root}`);
  }
  return root;
}

/**
 * Fields a supervisor summary must NEVER contain: this is an observation
 * capture, not a competition, not a profitability claim, and not a policy
 * recommendation. The validator asserts their absence, so "no winner / no
 * supervisor score / no profitability claim / no automatic policy
 * recommendation" is structural rather than a matter of convention.
 */
export const SUPERVISOR_FORBIDDEN_RESULT_KEYS = Object.freeze([
  "winners",
  "supervisorscore",
  "rank",
  "ranking",
  "pnl",
  "profit",
  "profitability",
  "return",
  "returns",
  "sharpe",
  "sortino",
  "expectedreturn",
  "trades",
  "tradecount",
  "position",
  "positionsize",
  "recommendation",
  "policyrecommendation",
  "deploymentverdict",
  "deploymenteligible",
  "futureoutcome",
  "futurereturn",
  "forwardreturn",
  "horizon",
  "outcome",
]);
