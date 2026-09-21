/**
 * Phase 5I-PS.2 — proposal tap: freeze immutable proposal facts, classify them,
 * and compute the frozen agreement semantics.
 *
 * This module is called SYNCHRONOUSLY from the simulation's passive tap. It
 * must therefore be cheap, bounded, allocation-only, and completely incapable
 * of touching engine state: it reads the references it is handed, copies the
 * fields it needs into a NEW plain object, and returns.
 *
 * CLASSIFICATION IS FROZEN BEFORE RESULTS (see `definition.mjs`):
 *
 *   ENTER_LONG + ENTRY_SIGNAL  -> directionalComparable = true,  intent HIGHER
 *   EXIT_LONG  + SIGNAL        -> directionalComparable = true,  intent LOWER
 *   EXIT_LONG  + STOP/TAKE/TIME (+ the engine's own GEN-END/STAGE-END
 *              settlements)    -> directionalComparable = false, intent null
 *
 * A lifecycle/risk exit is NOT a directional claim, so Jev is never classified
 * as agreeing or disagreeing with one.
 *
 * The Jev question is asked about MARKET STATE ONLY. Nothing in this module (or
 * anywhere in the observer path) passes EVOLVE's desired action to Jev: the
 * action is compared AFTER the independent directional answer is in hand.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { toFiniteNumber } from "../../market/normalize.mjs";
import { buildPreOutcomeInputs } from "../direction/features.mjs";
import {
  SUPERVISOR_ACTIONS,
  SUPERVISOR_AGREEMENT,
  SUPERVISOR_AGREEMENT_NO_INTENT_REASON,
  SUPERVISOR_DIRECTIONAL_INTENTS,
  SUPERVISOR_EXACT_HALF,
  SUPERVISOR_LIFECYCLE_EXIT_REASONS,
  SUPERVISOR_MARKET_ID,
  SUPERVISOR_QUOTE_MINT,
  SUPERVISOR_REASONS,
  SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
  SUPERVISOR_SUPPORTED_MINTS,
} from "./definition.mjs";

export const SUPERVISOR_TAP_VERSION = 1;

/* ============================================================================
 * Market scope
 * ==========================================================================*/

/** True only for the ONE supported traded identity (wrapped SOL). */
export function isSupportedMint(mint) {
  return typeof mint === "string" && SUPERVISOR_SUPPORTED_MINTS.includes(mint);
}

/**
 * The truthful market identity for a proposal's market. `SOL-USDC` is permitted
 * ONLY when the proposal market mint is the wrapped-SOL mint; for any other
 * asset the identity is `null` (no market id is ever invented). This fixes the
 * run-1 instrumentation bug where an arbitrary token was serialized as
 * `marketId: "SOL-USDC"`.
 */
export function marketIdForMint(mint) {
  return isSupportedMint(mint) ? SUPERVISOR_MARKET_ID : null;
}

/* ============================================================================
 * Frozen proposal classification
 * ==========================================================================*/

/**
 * The ONE classification rule. Depends only on the proposal's action and its
 * EXISTING deterministic reason — never on a price, a probability or a result.
 *
 * @returns {{ action: string, reason: string|null, directionalComparable: boolean, evolveDirectionalIntent: string|null }}
 */
export function classifyProposal({ action, reason } = {}) {
  const normalizedAction = action === SUPERVISOR_ACTIONS.EXIT_LONG ? SUPERVISOR_ACTIONS.EXIT_LONG : action === SUPERVISOR_ACTIONS.ENTER_LONG ? SUPERVISOR_ACTIONS.ENTER_LONG : null;
  const normalizedReason = typeof reason === "string" && reason.length > 0 ? reason : null;

  if (normalizedAction === SUPERVISOR_ACTIONS.ENTER_LONG) {
    return {
      action: SUPERVISOR_ACTIONS.ENTER_LONG,
      reason: normalizedReason ?? SUPERVISOR_REASONS.ENTRY_SIGNAL,
      // An entry reaching the tap is an ENTRY_SIGNAL by construction (the
      // engine only calls openPosition after gates + entry threshold passed).
      directionalComparable: true,
      evolveDirectionalIntent: SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER,
    };
  }

  if (normalizedAction === SUPERVISOR_ACTIONS.EXIT_LONG) {
    const directional = normalizedReason === SUPERVISOR_REASONS.SIGNAL;
    return {
      action: SUPERVISOR_ACTIONS.EXIT_LONG,
      reason: normalizedReason,
      directionalComparable: directional,
      evolveDirectionalIntent: directional ? SUPERVISOR_DIRECTIONAL_INTENTS.LOWER : null,
    };
  }

  // Unreachable for the current engine, but never guessed: an unknown proposal
  // is recorded as NOT directionally comparable rather than being classified.
  return {
    action: normalizedAction,
    reason: normalizedReason,
    directionalComparable: false,
    evolveDirectionalIntent: null,
  };
}

/** True when a reason is one of the frozen lifecycle/risk exits. */
export function isLifecycleExitReason(reason) {
  return SUPERVISOR_LIFECYCLE_EXIT_REASONS.includes(reason);
}

/* ============================================================================
 * Frozen agreement semantics
 * ==========================================================================*/

/**
 * Frozen agreement rule. The raw Jev intent is preserved; this only compares it
 * with EVOLVE's frozen directional intent.
 *
 * @returns {{ agreement: string|null, agreementReason: string|null }}
 *   `agreement === null` (with `agreementReason = NO_JEV_INTENT`) means the
 *   proposal WAS directionally comparable but Jev produced no valid
 *   probability. That is a failure record, never agreement or disagreement.
 */
export function agreementFor({ directionalComparable, evolveDirectionalIntent, modelIntent } = {}) {
  if (directionalComparable !== true) {
    return { agreement: SUPERVISOR_AGREEMENT.NOT_DIRECTIONALLY_COMPARABLE, agreementReason: null };
  }
  const evolveIntent =
    evolveDirectionalIntent === SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER || evolveDirectionalIntent === SUPERVISOR_DIRECTIONAL_INTENTS.LOWER
      ? evolveDirectionalIntent
      : null;
  const jevIntent =
    modelIntent === SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER || modelIntent === SUPERVISOR_DIRECTIONAL_INTENTS.LOWER ? modelIntent : null;
  if (evolveIntent === null || jevIntent === null) {
    return { agreement: null, agreementReason: SUPERVISOR_AGREEMENT_NO_INTENT_REASON };
  }
  return {
    agreement: evolveIntent === jevIntent ? SUPERVISOR_AGREEMENT.AGREE : SUPERVISOR_AGREEMENT.DISAGREE,
    agreementReason: null,
  };
}

/**
 * The existing frozen Phase 5I model-intent rule, reused verbatim:
 *   modelIntent = 'HIGHER' when pHigher >= 0.5, else 'LOWER'; null when no
 *   valid probability exists.
 * It is a probability-implied directional lean recorded for provenance only —
 * NOT an order side, NOT a trade decision, and never a supervisor verdict.
 */
export function modelIntentFromProbability(pHigher) {
  if (!Number.isFinite(pHigher)) return null;
  return pHigher >= SUPERVISOR_EXACT_HALF ? SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER : SUPERVISOR_DIRECTIONAL_INTENTS.LOWER;
}

/** `distanceFromHalf = abs(pHigher - 0.5)`. Descriptive only; never a cutoff. */
export function distanceFromHalfOf(pHigher) {
  return Number.isFinite(pHigher) ? Math.abs(pHigher - SUPERVISOR_EXACT_HALF) : null;
}

/** Exact comparison, no tolerance: `exactlyHalf = pHigher === 0.5`. */
export function exactlyHalfOf(pHigher) {
  return pHigher === SUPERVISOR_EXACT_HALF;
}

/* ============================================================================
 * Immutable fact freezing
 * ==========================================================================*/

/** Recursively freeze a plain JSON-shaped value (defensive copy semantics). */
export function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function finiteOrNull(value) {
  return toFiniteNumber(value);
}

/**
 * The EXACT pre-outcome input projection this subsystem carries forward. It
 * reuses the existing frozen Phase 5I builder (`buildPreOutcomeInputs`) instead
 * of re-deriving a parallel projection, so features/digests stay comparable in
 * meaning. The observer adds its bounded pre-decision history and regime
 * inputs synchronously at capture; this current-state projection alone is
 * never a complete Jev-input identity.
 */
export function freezeMarketState({ market, token = null, quoteMarket = null, observedAt = null } = {}) {
  if (!market || typeof market !== "object") return null;
  return deepFreeze(
    buildPreOutcomeInputs({
      market,
      token,
      history: [],
      observedAt: finiteOrNull(observedAt ?? market.lastObservedAt),
      quoteMarket,
    }),
  );
}

/**
 * Bounded regime snapshot in the existing compact shape the deterministic
 * regime classifier consumes. Bounded to `marketLimit` markets with an explicit
 * truncation flag — the whole universe is never carried into the queue.
 */
export function freezeRegimeSnapshot(byMint, { marketLimit = 0 } = {}) {
  const markets = [];
  if (byMint && typeof byMint.values === "function") {
    for (const market of byMint.values()) {
      if (markets.length >= marketLimit) break;
      if (!market || typeof market !== "object") continue;
      markets.push({
        mint: typeof market.mint === "string" ? market.mint : null,
        price: finiteOrNull(market.price),
        liquidity: finiteOrNull(market.liquidity),
        volume5m: finiteOrNull(market.volume5m),
        buySellRatio: finiteOrNull(market.buySellRatio),
        organicBuySellRatio: finiteOrNull(market.organicBuySellRatio),
        poolAgeMs: finiteOrNull(market.poolAgeMs),
      });
    }
  }
  const totalMarkets = byMint && typeof byMint.size === "number" ? byMint.size : markets.length;
  return deepFreeze({ markets, marketCount: markets.length, totalMarkets, truncated: totalMarkets > markets.length });
}

function freezePosition(position) {
  if (!position || typeof position !== "object") return null;
  return deepFreeze({
    mint: typeof position.mint === "string" ? position.mint : null,
    symbol: typeof position.symbol === "string" ? position.symbol : null,
    qty: finiteOrNull(position.qty),
    cost: finiteOrNull(position.cost),
    entryRefPrice: finiteOrNull(position.entryRefPrice),
    entryPrice: finiteOrNull(position.entryPrice),
    entryLiquidity: finiteOrNull(position.entryLiquidity),
    heldTicks: finiteOrNull(position.heldTicks),
    entryAt: Number.isFinite(position.entryAt) ? position.entryAt : null,
    entryScore: finiteOrNull(position.entryScore),
  });
}

/**
 * Build the immutable proposal record from the tap facts. This runs BEFORE the
 * paper execution attempt; the execution result is attached afterwards by
 * `freezeExecution` and is never merged into these facts.
 */
export function buildProposalFacts(
  {
    action,
    reason,
    at,
    generation,
    generationTick,
    agentId,
    species,
    lineageId = null,
    researchFamilyId = null,
    market = null,
    universeToken = null,
    byMint = null,
    agentScore = null,
    entryScoreThreshold = null,
    paperCashBefore = null,
    intendedPaperNotional = null,
    referencePrice = null,
    liquidityUsd = null,
    riskMultiplier = null,
    position = null,
  } = {},
  { proposalId, sessionId, regimeMarketLimit = 0 } = {},
) {
  const classification = classifyProposal({ action, reason });
  const mint = typeof market?.mint === "string" ? market.mint : position?.mint ?? null;
  const quoteMintPrice =
    byMint && typeof byMint.get === "function" ? finiteOrNull(byMint.get(SUPERVISOR_QUOTE_MINT)?.price) : null;
  const quoteMarket = quoteMintPrice === null ? null : { price: quoteMintPrice };
  const referencePriceValue = finiteOrNull(referencePrice ?? market?.price ?? position?.entryRefPrice ?? null);
  const observedAt = market && Number.isFinite(market.lastObservedAt) ? market.lastObservedAt : null;
  // The venue's own timestamp for the SOL observation, when it supplied one.
  // Never inferred and never replaced with our receipt time.
  const sourceEventAtMs = Number.isFinite(universeToken?.tokenUpdatedAt) ? universeToken.tokenUpdatedAt : null;

  const facts = {
    proposalId,
    sessionId,
    action: classification.action,
    reason: classification.reason,
    directionalComparable: classification.directionalComparable,
    evolveDirectionalIntent: classification.evolveDirectionalIntent,
    timestamp: Number.isFinite(at) ? new Date(at).toISOString() : null,
    timestampMs: Number.isFinite(at) ? at : null,
    proposalFrozenAt: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
    generation: Number.isFinite(generation) ? generation : null,
    generationTick: Number.isFinite(generationTick) ? generationTick : null,
    agentId: typeof agentId === "string" ? agentId : null,
    species: typeof species === "string" ? species : null,
    lineageId: typeof lineageId === "string" ? lineageId : null,
    researchFamilyId: typeof researchFamilyId === "string" ? researchFamilyId : null,
    sourceEventAtMs,
    market: {
      // NEVER a fabricated identity: the canonical id appears only when the
      // mint really is the wrapped-SOL mint (see `marketIdForMint`).
      marketId: marketIdForMint(mint),
      mint,
      symbol: typeof market?.symbol === "string" ? market.symbol : position?.symbol ?? null,
      referencePrice: referencePriceValue,
      liquidity: finiteOrNull(liquidityUsd ?? market?.liquidity ?? null),
      priceChangePct: finiteOrNull(market?.changePct ?? null),
      poolAgeMs: finiteOrNull(market?.poolAgeMs ?? null),
      observed: market !== null,
    },
    agentScore: finiteOrNull(agentScore),
    entryScoreThreshold: finiteOrNull(entryScoreThreshold),
    paperCashBefore: finiteOrNull(paperCashBefore),
    intendedPaperNotional: finiteOrNull(intendedPaperNotional),
    riskMultiplier: finiteOrNull(riskMultiplier),
    position: freezePosition(position),
    // The frozen SOL/USDC market-state projection carried into the Jev packet.
    // It is NOT EVOLVE's desired action: the action fields above live outside
    // this block and are compared only AFTER Jev answers the market question.
    marketState: freezeMarketState({ market, token: universeToken, quoteMarket, observedAt }),
    regimeSnapshot: freezeRegimeSnapshot(byMint, { marketLimit: regimeMarketLimit }),
  };

  return deepFreeze(facts);
}

/** Digest of the frozen proposal facts — proof they were never mutated. */
export function proposalDigestOf(facts) {
  return digestOf(facts ?? null);
}

/* ============================================================================
 * PS.2a — SOL opportunity facts (NOT an executed trade)
 * ==========================================================================*/

/**
 * The ONE deduplication key for agent/generation-scoped SOL opportunity
 * sampling. Deliberately contains nothing but the identity and the generation,
 * so the rule can never depend on a score, a price, a Jev answer or an outcome.
 */
export function solOpportunityDedupKey({ agentId = null, generation = null } = {}) {
  return `${typeof agentId === "string" ? agentId : "?"}::${Number.isFinite(generation) ? generation : "?"}`;
}

/**
 * Freeze the passive SOL opportunity observation. Built at the EXACT tap point
 * inside the engine's market-scoring loop, where all of the following were true
 * for one flat agent at one deterministic observation:
 *
 *   - new entries were allowed;
 *   - wrapped SOL was present in the normal market universe;
 *   - SOL passed that genome's existing `passesGates(...)`;
 *   - `scoreMarket(genome, SOL) >= genome.entryScoreThreshold`.
 *
 * No new trading threshold is introduced here: `agentEntryThreshold` is the
 * genome's EXISTING entry threshold, carried through verbatim.
 */
export function buildSolOpportunityFacts(
  {
    at = null,
    generation = null,
    generationTick = null,
    agentId = null,
    species = null,
    lineageId = null,
    researchFamilyId = null,
    market = null,
    universeToken = null,
    byMint = null,
    solScore = null,
    agentEntryThreshold = null,
  } = {},
  { opportunityId, sessionId, regimeMarketLimit = 0 } = {},
) {
  const mint = typeof market?.mint === "string" ? market.mint : null;
  const quoteMintPrice =
    byMint && typeof byMint.get === "function" ? finiteOrNull(byMint.get(SUPERVISOR_QUOTE_MINT)?.price) : null;
  const quoteMarket = quoteMintPrice === null ? null : { price: quoteMintPrice };
  const observedAt = market && Number.isFinite(market.lastObservedAt) ? market.lastObservedAt : null;
  const scoreValue = finiteOrNull(solScore);
  const thresholdValue = finiteOrNull(agentEntryThreshold);
  const scoreMargin = scoreValue !== null && thresholdValue !== null ? scoreValue - thresholdValue : null;
  const sourceEventAtMs = Number.isFinite(universeToken?.tokenUpdatedAt) ? universeToken.tokenUpdatedAt : null;

  const facts = {
    opportunityId,
    sessionId,
    evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
    isExecutedTrade: false,
    timestamp: Number.isFinite(at) ? new Date(at).toISOString() : null,
    timestampMs: Number.isFinite(at) ? at : null,
    opportunityFrozenAt: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
    generation: Number.isFinite(generation) ? generation : null,
    generationTick: Number.isFinite(generationTick) ? generationTick : null,
    agentId: typeof agentId === "string" ? agentId : null,
    species: typeof species === "string" ? species : null,
    lineageId: typeof lineageId === "string" ? lineageId : null,
    researchFamilyId: typeof researchFamilyId === "string" ? researchFamilyId : null,
    sourceEventAtMs,
    // ---- the SOL observation itself (never EVOLVE's selected token) --------
    solMint: mint,
    symbol: typeof market?.symbol === "string" ? market.symbol : null,
    referencePrice: finiteOrNull(market?.price),
    liquidity: finiteOrNull(market?.liquidity),
    solScore: scoreValue,
    agentEntryThreshold: thresholdValue,
    scoreMargin,
    passesGates: true,
    actionable: true,
    // A SOL opportunity is ALWAYS a HIGHER directional claim, frozen before any
    // Jev answer: it means the agent considered SOL worth entering.
    evolveDirectionalIntent: SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER,
    directionalComparable: true,
    // The frozen SOL/USDC market-state projection carried into the Jev packet.
    marketState: freezeMarketState({ market, token: universeToken, quoteMarket, observedAt }),
    regimeSnapshot: freezeRegimeSnapshot(byMint, { marketLimit: regimeMarketLimit }),
  };

  return deepFreeze(facts);
}

/** Digest of the frozen SOL opportunity observation facts. */
export function solOpportunityDigestOf(facts) {
  return digestOf(facts ?? null);
}

/**
 * Freeze which market EVOLVE ACTUALLY selected for this agent's paper decision.
 * Recorded only so the SOL opportunity can state, truthfully, whether SOL was
 * the selected token. It is NEVER read by the engine. `solWasActuallySelected`
 * is derived later, once the frozen `solMint` is known.
 */
export function freezeSolSelection(selection = null) {
  if (!selection || typeof selection !== "object") {
    return deepFreeze({ actualSelectedMint: null, actualSelectedSymbol: null, actualSelectedScore: null });
  }
  return deepFreeze({
    actualSelectedMint: typeof selection.actualSelectedMint === "string" ? selection.actualSelectedMint : null,
    actualSelectedSymbol: typeof selection.actualSelectedSymbol === "string" ? selection.actualSelectedSymbol : null,
    actualSelectedScore: finiteOrNull(selection.actualSelectedScore),
  });
}

/** Version marker for the frozen PS.2a SOL opportunity tap semantics. */
export const SUPERVISOR_SOL_TAP_DEFINITION = Object.freeze({
  evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
  isExecutedTrade: false,
  evolveDirectionalIntent: SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER,
  directionalComparable: true,
  scoreMarginFormula: "scoreMargin = solScore - agentEntryThreshold",
  agentEntryThresholdIsTheExistingGenomeThreshold: true,
  newTradingThresholdIntroduced: false,
  dedupScope: "agent-and-generation",
  dedupRuleResetsOnGenerationChange: true,
  dedupDependsOnJevOutputOrFuturePrice: false,
  jevCallDeduplicatedByFrozenMarketState: true,
  recordInfluencesMarketSelection: false,
  agentAnchoringSentToJev: false,
  confidenceThresholdApplied: false,
});

/** Freeze the engine's execution result into a fixed, bounded field list. */
export function freezeExecution(execution = null) {
  if (!execution || typeof execution !== "object") {
    return deepFreeze({
      executed: false,
      blocked: false,
      blockedReason: "execution_result_missing",
      fillSide: null,
      referencePrice: null,
      executedPrice: null,
      notional: null,
      netProceeds: null,
      qty: null,
      feesUsd: null,
      frictionUsd: null,
      costBps: null,
    });
  }
  return deepFreeze({
    executed: execution.executed === true,
    blocked: execution.blocked === true,
    blockedReason: typeof execution.blockedReason === "string" ? execution.blockedReason : null,
    fillSide: typeof execution.fillSide === "string" ? execution.fillSide : null,
    referencePrice: finiteOrNull(execution.referencePrice),
    executedPrice: finiteOrNull(execution.executedPrice),
    notional: finiteOrNull(execution.notional),
    netProceeds: finiteOrNull(execution.netProceeds),
    qty: finiteOrNull(execution.qty),
    feesUsd: finiteOrNull(execution.feesUsd),
    frictionUsd: finiteOrNull(execution.frictionUsd),
    costBps: finiteOrNull(execution.costBps),
  });
}

/** Version marker for the frozen tap/classification semantics. */
export const SUPERVISOR_TAP_DEFINITION = Object.freeze({
  tapVersion: SUPERVISOR_TAP_VERSION,
  classificationRule: "ENTER_LONG+ENTRY_SIGNAL => comparable/HIGHER; EXIT_LONG+SIGNAL => comparable/LOWER; lifecycle exits => not comparable",
  agreementRule: "AGREE iff the frozen EVOLVE directional intent equals the raw Jev modelIntent",
  exactHalfRule: "exactlyHalf = (pHigher === 0.5), exact comparison, no tolerance",
  distanceFromHalfFormula: "distanceFromHalf = abs(pHigher - 0.5)",
  distanceFromHalfIsAThreshold: false,
  confidenceThresholdApplied: false,
  evolvesDesiredActionSentToJev: false,
  classificationFrozenBeforeResults: true,
});
