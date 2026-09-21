/**
 * Jev paper-shadow RUNNER.
 *
 * One bounded, interruptible loop. At every scheduled decision it:
 *
 *   1. observes genuine state (Jupiter Tokens V2, live mode only);
 *   2. freezes the packet/state for Jev;
 *   3. asks direct TypeSafe Jev (`jevDecide`, no cache);
 *   4. persists the Jev result on the event;
 *   5. applies the deterministic paper policy;
 *   6. simulates a fill via the existing engine paper machinery;
 *   7. marks the account;
 *   8. appends the event to `events.ndjson` (append-only);
 *   9. publishes the compact `state.json` for the dashboard.
 *
 * It never waits for Phase 5I outcome resolution: this is a paper-account
 * stream, not a directional scoring experiment. There is no retrospective
 * rewriting — events are appended, never edited.
 *
 * Feed failure and Jev failure both resolve to NO_ACTION and never become a
 * trading action. A degraded feed retains the last legitimate mark.
 *
 * PAPER ONLY / DEVELOPMENT DASHBOARD EXPERIMENT — no wallet, no signing, no
 * swap, no order, no RPC write, no real-money execution.
 */

import { digestOf } from "../../lib/hash.mjs";
import { NO_JEV_DECISION } from "../config.mjs";
import { jevDecide } from "../decide.mjs";
import { DIRECTION_QUESTION_NAME, DIRECTION_QUESTION_SET_ID, DIRECTION_QUESTION_SET_VERSION } from "../direction/questions.mjs";
import {
  DIRECTION_PACKET_VERSION,
  auditDirectionPacket,
  buildDirectionPacket,
  packetDigestOf,
  packetStateDigestOf,
} from "../direction/packet.mjs";
import {
  auditDirectionFeatures,
  classifyDirectionRegime,
  extractDirectionFeatures,
  warmupStatus,
} from "../direction/features.mjs";
import { BENCHMARK_MARKET, HORIZON_SECONDS } from "../direction/definition.mjs";
import {
  PAPER_SHADOW_ACCOUNTING_NOTE,
  PAPER_SHADOW_ACCOUNT_STATES,
  PAPER_SHADOW_ACTIONS,
  PAPER_SHADOW_CLASSIFICATION,
  PAPER_SHADOW_EQUITY_SERIES_LIMIT,
  PAPER_SHADOW_EXCLUSION_NOTE,
  PAPER_SHADOW_FEED_HEALTH,
  PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS,
  PAPER_SHADOW_KIND,
  PAPER_SHADOW_LABEL,
  PAPER_SHADOW_MAX_DECISIONS,
  PAPER_SHADOW_MAX_FEED_STALE_MS,
  PAPER_SHADOW_MODE,
  PAPER_SHADOW_PAPER_ONLY_TAG,
  PAPER_SHADOW_PHASE,
  PAPER_SHADOW_RECENT_DECISION_LIMIT,
  PAPER_SHADOW_SCHEMA_VERSION,
  PAPER_SHADOW_STARTING_CASH,
  PAPER_SHADOW_ROOT_DIR,
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_SUPPORTED_MARKET_IDS,
  paperShadowCompactStamp,
  paperShadowSessionIdFor,
  paperShadowSessionRootFor,
  paperShadowUpstreamFor,
} from "./definition.mjs";
import {
  PAPER_SHADOW_POLICY_DEFINITION,
  decidePaperAction,
  modelIntentFromProbability,
} from "./policy.mjs";
import {
  applyPaperEntry,
  applyPaperExit,
  compactPaperFill,
  createPaperAccount,
  hasOpenPosition,
  markAccount,
} from "./account.mjs";
import {
  appendPaperShadowEvent,
  ensurePaperShadowDir,
  paperShadowSummaryDigestOf,
  writePaperShadowSession,
  writePaperShadowState,
  writePaperShadowSummary,
} from "./storage.mjs";

export const PAPER_SHADOW_RUNNER_VERSION = 1;

/** How many pre-decision universe snapshots the regime feature is computed over. */
export const PAPER_SHADOW_REGIME_SNAPSHOT_LIMIT = 12;
/** Bounded rolling pre-decision history carried for the feature vector. */
export const PAPER_SHADOW_HISTORY_LIMIT = 64;

function finite(value, fallback = null) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 10) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** Compact, deterministic regime snapshot (only the fields the classifier reads). */
export function compactRegimeSnapshot(markets) {
  return {
    markets: (Array.isArray(markets) ? markets : []).map((market) => ({
      mint: market?.mint ?? null,
      price: finite(market?.price, null),
      liquidity: finite(market?.liquidity, null),
      volume5m: finite(market?.volume5m, null),
      buySellRatio: finite(market?.buySellRatio, null),
      organicBuySellRatio: finite(market?.organicBuySellRatio, null),
      poolAgeMs: finite(market?.poolAgeMs, null),
    })),
  };
}

/** The session record. Written once at start and refreshed on status change. */
export function createPaperShadowSession({ sessionId, settings, identity, questionDigest, startedAt = Date.now() }) {
  return {
    schemaVersion: PAPER_SHADOW_SCHEMA_VERSION,
    phase: PAPER_SHADOW_PHASE,
    kind: PAPER_SHADOW_KIND,
    sessionId,
    ...PAPER_SHADOW_CLASSIFICATION,
    label: PAPER_SHADOW_LABEL,
    accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
    exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
    paperOnlyTag: PAPER_SHADOW_PAPER_ONLY_TAG,
    market: {
      marketId: BENCHMARK_MARKET.marketId,
      displayName: BENCHMARK_MARKET.displayName,
      baseSymbol: BENCHMARK_MARKET.baseSymbol,
      quoteSymbol: BENCHMARK_MARKET.quoteSymbol,
      baseMint: BENCHMARK_MARKET.baseMint,
      quoteMint: BENCHMARK_MARKET.quoteMint,
    },
    provider: identity?.provider ?? null,
    model: identity?.model ?? null,
    upstream: identity?.upstream ?? null,
    gatewayUsed: false,
    mode: PAPER_SHADOW_MODE,
    cacheEnabled: false,
    questionSetId: DIRECTION_QUESTION_SET_ID,
    questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
    questionDigest: questionDigest ?? null,
    packetVersion: DIRECTION_PACKET_VERSION,
    policy: PAPER_SHADOW_POLICY_DEFINITION,
    startingCash: settings.startingCash,
    positionFraction: settings.positionFraction,
    intentThreshold: settings.intentThreshold,
    cadenceMs: settings.cadenceMs,
    durationMinutes: settings.durationMinutes,
    isolation: {
      root: PAPER_SHADOW_ROOT_DIR,
      forbiddenWriteRoots: [...PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS],
      canonicalEvidence: false,
      replicationEvidence: false,
      temporalReplicationEvidence: false,
      arenaEligible: false,
      deploymentEligible: false,
    },
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    finalizedAt: null,
    status: "RUNNING",
  };
}

/** A bounded summary of one decision, for the dashboard's recent-decision table. */
export function compactDecisionRow(event) {
  return {
    sequence: event.sequence,
    scheduledAt: event.scheduledAt,
    observedAt: event.observedAt,
    referencePrice: event.referencePrice,
    pHigher: event.pHigher,
    modelIntent: event.modelIntent,
    action: event.action,
    actionReason: event.actionReason,
    equity: event.equity,
    netPnl: event.netPnl,
    costs: event.costs,
    marketFeedHealth: event.marketFeedHealth,
  };
}

/** Fully deterministic paper-shadow summary. Never a winner, never a verdict. */
export function buildPaperShadowSummary({ session, account, counters, status, equitySeries = [] }) {
  const sum = finite(counters.pHigherSum, 0) ?? 0;
  const count = finite(counters.pHigherCount, 0) ?? 0;
  const latencySum = finite(counters.jevLatencySumMs, 0) ?? 0;
  const latencyCount = finite(counters.jevLatencyCount, 0) ?? 0;
  const jevCalls = finite(counters.jevOk, 0) + finite(counters.jevFailures, 0);

  const summary = {
    schemaVersion: PAPER_SHADOW_SCHEMA_VERSION,
    phase: PAPER_SHADOW_PHASE,
    sessionId: session.sessionId,
    purpose: session.purpose,
    ...PAPER_SHADOW_CLASSIFICATION,
    status,
    provider: session.provider,
    model: session.model,
    upstream: session.upstream,
    gatewayUsed: false,
    market: BENCHMARK_MARKET.marketId,
    startedAt: session.startedAt,
    finalizedAt: new Date().toISOString(),
    decisions: finite(counters.decisions, 0) ?? 0,
    jevOk: finite(counters.jevOk, 0) ?? 0,
    jevFailures: finite(counters.jevFailures, 0) ?? 0,
    higherCount: finite(counters.higherCount, 0) ?? 0,
    lowerCount: finite(counters.lowerCount, 0) ?? 0,
    enterCount: finite(counters.enterCount, 0) ?? 0,
    exitCount: finite(counters.exitCount, 0) ?? 0,
    holdCount: finite(counters.holdCount, 0) ?? 0,
    cashCount: finite(counters.cashCount, 0) ?? 0,
    // `paperTrades` = executed paper fills (entries + exits).
    paperTrades: (finite(counters.enterCount, 0) ?? 0) + (finite(counters.exitCount, 0) ?? 0),
    winningClosedTrades: finite(account.winningClosedTrades, 0) ?? 0,
    losingClosedTrades: finite(account.losingClosedTrades, 0) ?? 0,
    startingCash: finite(session.startingCash, PAPER_SHADOW_STARTING_CASH),
    endingCash: round(finite(account.cash, null)),
    endingPositionValue: round(finite(account.positionValue, null)),
    endingEquity: round(finite(account.equity, null)),
    grossPnl: round(finite(account.grossPnl, null)),
    netPnl: round(finite(account.netPnl, null)),
    totalCosts: round(finite(account.costs, null)),
    maxDrawdown: round(finite(account.maxDrawdown, null)),
    meanJevLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    meanPHigher: count > 0 ? round(sum / count) : null,
    minPHigher: count > 0 ? round(finite(counters.minPHigher, null)) : null,
    maxPHigher: count > 0 ? round(finite(counters.maxPHigher, null)) : null,
    equityPoints: Array.isArray(equitySeries) ? equitySeries.length : 0,
    jevCalls,
    label: PAPER_SHADOW_LABEL,
    accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
    exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
    note:
      "Deterministic simulated paper accounting for an isolated Jev-controlled account. No winner, no profitability " +
      "verdict, and not replication, Arena, or deployment evidence.",
  };
  return { ...summary, summaryDigest: paperShadowSummaryDigestOf(summary) };
}

function emptyCounters() {
  return {
    decisions: 0,
    jevOk: 0,
    jevFailures: 0,
    higherCount: 0,
    lowerCount: 0,
    enterCount: 0,
    exitCount: 0,
    holdCount: 0,
    cashCount: 0,
    noActionCount: 0,
    pHigherSum: 0,
    pHigherCount: 0,
    minPHigher: null,
    maxPHigher: null,
    jevLatencySumMs: 0,
    jevLatencyCount: 0,
  };
}

function observeP(tuple, value) {
  if (!Number.isFinite(value)) return tuple;
  return {
    sum: tuple.sum + value,
    count: tuple.count + 1,
    min: tuple.min === null ? value : Math.min(tuple.min, value),
    max: tuple.max === null ? value : Math.max(tuple.max, value),
  };
}

/**
 * Run one bounded paper-shadow session.
 *
 * @param {{
 *   settings: object,
 *   provider: object,
 *   source: { observeState: () => Promise<object> },
 *   questions: object,
 *   friction: object,
 *   baseRoot?: string|null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   control?: { stopped?: boolean }|null,
 *   budget?: object|null,
 *   onEvent?: ((event: object) => void)|null,
 *   resume?: boolean,
 *   priorState?: object|null,
 * }} options
 */
export async function runPaperShadow({
  settings,
  provider,
  source,
  questions,
  friction,
  baseRoot = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  control = null,
  budget = null,
  onEvent = null,
  resume = false,
  priorState = null,
}) {
  const emit = (event) => {
    if (typeof onEvent === "function") onEvent(event);
  };

  const sessionId = settings.sessionId ?? priorState?.sessionId ?? paperShadowSessionIdFor({ startedAt: now(), salt: "" });
  const root = paperShadowSessionRootFor(baseRoot, sessionId);
  await ensurePaperShadowDir(root, baseRoot);

  const startedAtMs = resume && Number.isFinite(priorState?.startedAtMs) ? priorState.startedAtMs : now();
  const endMs = startedAtMs + settings.durationMs;

  const questionDigest = digestOf(questions);

  const session = {
    ...createPaperShadowSession({
      sessionId,
      settings,
      // §15 fix: the provider object exposes no `upstream` field, so the upstream
      // identity is resolved from the provider registry (an explicit field is
      // honoured first if a future provider supplies one). NEW sessions therefore
      // persist the real upstream identity; already-captured sessions are untouched.
      identity: {
        provider: provider?.name ?? null,
        model: provider?.model ?? null,
        upstream: provider?.upstream ?? provider?.upstreamProvider ?? paperShadowUpstreamFor(provider?.name ?? null),
      },
      questionDigest,
      startedAt: startedAtMs,
    }),
    startedAt: new Date(startedAtMs).toISOString(),
  };
  await writePaperShadowSession(root, session);

  // ---- resume: restore the account, counters, and bounded bookkeeping --------
  const runner = resume && priorState?.runner ? priorState.runner : null;
  let account = runner?.account ?? createPaperAccount({ startingCash: settings.startingCash });
  let counters = { ...emptyCounters(), ...(runner?.counters ?? {}) };
  let history = Array.isArray(runner?.history) ? [...runner.history] : [];
  let regimeSnapshots = Array.isArray(runner?.regimeSnapshots) ? [...runner.regimeSnapshots] : [];
  let equitySeries = Array.isArray(runner?.equitySeries) ? [...runner.equitySeries] : [];
  let recentDecisions = Array.isArray(runner?.recentDecisions) ? [...runner.recentDecisions] : [];
  let nextIndex = Number.isFinite(runner?.nextIndex) ? runner.nextIndex : 0;
  let sequence = Number.isFinite(runner?.sequence) ? runner.sequence : 0;

  const budgetGuard =
    budget ?? { exhausted: () => false, consume: () => true, max: null, used: 0, remaining: null };

  const stopRequested = () => control?.stopped === true;

  async function waitUntil(targetMs) {
    while (now() < targetMs) {
      if (stopRequested()) return false;
      await sleep(Math.min(250, Math.max(1, targetMs - now())));
    }
    return true;
  }

  function publishState(status = "RUNNING") {
    return {
      schemaVersion: PAPER_SHADOW_SCHEMA_VERSION,
      phase: PAPER_SHADOW_PHASE,
      kind: PAPER_SHADOW_KIND,
      sessionId,
      purpose: session.purpose,
      ...PAPER_SHADOW_CLASSIFICATION,
      label: PAPER_SHADOW_LABEL,
      accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
      exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
      paperOnlyTag: PAPER_SHADOW_PAPER_ONLY_TAG,
      status,
      provider: session.provider,
      model: session.model,
      upstream: session.upstream,
      gatewayUsed: false,
      mode: PAPER_SHADOW_MODE,
      cacheEnabled: false,
      market: session.market,
      startedAt: session.startedAt,
      updatedAt: new Date(now()).toISOString(),
      lastUpdate: recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].observedAt : session.startedAt,
      marketFeedHealth:
        recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].marketFeedHealth : PAPER_SHADOW_FEED_HEALTH.LIVE,
      pHigher: recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].pHigher : null,
      pLower:
        recentDecisions.length > 0 && Number.isFinite(recentDecisions[recentDecisions.length - 1].pHigher)
          ? 1 - recentDecisions[recentDecisions.length - 1].pHigher
          : null,
      modelIntent: recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].modelIntent : null,
      accountState: hasOpenPosition(account) ? PAPER_SHADOW_ACCOUNT_STATES.LONG : PAPER_SHADOW_ACCOUNT_STATES.FLAT,
      paperAction: recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].action : null,
      actionReason: recentDecisions.length > 0 ? recentDecisions[recentDecisions.length - 1].actionReason : null,
      account: {
        startingCash: account.startingCash,
        cash: account.cash,
        positionQty: account.positionQty,
        positionEntryPrice: account.positionEntryPrice,
        positionMarkPrice: account.positionMarkPrice,
        positionValue: account.positionValue,
        equity: account.equity,
        grossPnl: account.grossPnl,
        netPnl: account.netPnl,
        unrealizedPnl: account.unrealizedPnl,
        realizedPnl: account.realizedPnl,
        costs: account.costs,
        returnPct: account.returnPct,
        maxDrawdown: account.maxDrawdown,
        enterCount: account.enterCount,
        exitCount: account.exitCount,
        winningClosedTrades: account.winningClosedTrades,
        losingClosedTrades: account.losingClosedTrades,
      },
      counters: { ...counters },
      recentDecisions,
      equitySeries,
      runner: { nextIndex, sequence, history, regimeSnapshots, equitySeries, recentDecisions, counters, account },
      isolation: session.isolation,
    };
  }

  let interrupted = false;
  let finalStatus = "COMPLETE";

  while (nextIndex < PAPER_SHADOW_MAX_DECISIONS) {
    if (stopRequested()) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }

    const scheduledAtMs = startedAtMs + nextIndex * settings.cadenceMs;
    if (scheduledAtMs >= endMs) break;

    const waited = await waitUntil(scheduledAtMs);
    if (!waited) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }

    sequence += 1;
    const scheduledAt = new Date(scheduledAtMs).toISOString();
    const observedAtMs = now();

    // ---- 1. observe genuine state -----------------------------------------
    let state = null;
    try {
      state = await source.observeState();
    } catch (error) {
      state = { ok: false, reason: `observation_threw:${error?.message ?? error}` };
    }

    const baseMarket = state?.market ?? null;
    const price = finite(baseMarket?.price, null);
    const liquidityUsd = finite(baseMarket?.liquidity, null);
    const stateObservedAtMs = finite(state?.stateObservedAtMs, null);
    const receiptAgeMs = stateObservedAtMs === null ? null : Math.max(0, observedAtMs - stateObservedAtMs);
    const feedStale = receiptAgeMs !== null && receiptAgeMs > PAPER_SHADOW_MAX_FEED_STALE_MS;
    const priceOk = price !== null && price > 0;
    // `feedOk` is about the OBSERVATION being genuine and fresh; a missing price
    // is handled by the policy (`missing_price`) rather than folded into the feed
    // health, so the recorded reason stays honest.
    const feedOk = state?.ok === true && state?.health?.degraded !== true && !feedStale;
    const feedHealth =
      feedOk && priceOk ? PAPER_SHADOW_FEED_HEALTH.LIVE : PAPER_SHADOW_FEED_HEALTH.DEGRADED;

    // ---- 2-4. freeze + ask Jev (only from a genuine state) -----------------
    let packet = null;
    let stateDigest = null;
    let packetDigest = null;
    let run = null;
    let decision = NO_JEV_DECISION;
    let pHigher = null;
    let modelIntent = null;
    let jevCallAttempted = false;
    let errorReason = feedOk ? null : state?.reason ?? (feedStale ? "state_receipt_stale" : "market_state_unavailable");

    if (feedOk) {
      try {
        const featureVector = extractDirectionFeatures({
          market: baseMarket,
          token: state.token,
          history,
          observedAt: stateObservedAtMs,
          quoteMarket: state.quoteMarket ?? null,
        });
        const featureAudit = auditDirectionFeatures(featureVector.features);
        if (!featureAudit.ok) {
          throw new Error(`malformed feature vector: ${featureAudit.problems.join("; ")}`);
        }
        const warmup = warmupStatus(featureVector.features);
        const regimeSnapshot = compactRegimeSnapshot(state.universeMarkets);
        const regime = classifyDirectionRegime([...regimeSnapshots, regimeSnapshot].slice(-PAPER_SHADOW_REGIME_SNAPSHOT_LIMIT));

        packet = buildDirectionPacket({
          experimentId: sessionId,
          observationId: `${sessionId}-d${String(sequence).padStart(6, "0")}`,
          observationIndex: nextIndex,
          market: BENCHMARK_MARKET,
          horizonSeconds: HORIZON_SECONDS,
          sourceEventAt: state.sourceEventAt ?? null,
          receivedAt: state.receivedAt ?? null,
          stateObservedAt: state.stateObservedAt ?? null,
          stateAge: null,
          features: featureVector.features,
          recentObservationHistory: featureVector.historyUsed,
          regime,
          universe: {
            observedMarkets: state.universeSummary?.tracked ?? null,
            usableMarkets: state.universeSummary?.usable ?? null,
            source: state.health?.source ?? null,
            endpoints: state.health?.endpoints ?? [],
            synthetic: false,
          },
          quoteObservationAvailable: state.quoteObservationAvailable === true,
          createdAt: new Date(observedAtMs).toISOString(),
          generatedBy: { phase: PAPER_SHADOW_PHASE, runner: PAPER_SHADOW_RUNNER_VERSION, warmup },
        });
        const packetAudit = auditDirectionPacket(packet);
        if (!packetAudit.ok) {
          throw new Error(`packet failed the leakage audit: ${JSON.stringify(packetAudit.violations)}`);
        }
        stateDigest = packetStateDigestOf(packet);
        packetDigest = packetDigestOf(packet);

        jevCallAttempted = true;
        const decided = await jevDecide({
          provider,
          packet,
          questions,
          questionSetId: DIRECTION_QUESTION_SET_ID,
          questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
          decisionPacketVersion: DIRECTION_PACKET_VERSION,
          experimentId: sessionId,
          root: null,
          cacheEnabled: false,
          budget: budgetGuard,
          now,
          salt: `${sessionId}-d${sequence}`,
        });
        run = decided.run;
        decision = decided.decision;
        const answer = decision === NO_JEV_DECISION ? null : decision?.[DIRECTION_QUESTION_NAME] ?? null;
        pHigher = answer && answer.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
      } catch (error) {
        errorReason = `decision_error:${error?.message ?? error}`;
        run = null;
        pHigher = null;
      }
    }

    modelIntent = modelIntentFromProbability(pHigher);

    // ---- counters ----------------------------------------------------------
    counters.decisions += 1;
    if (jevCallAttempted) {
      if (run?.status === "JEV_OK") counters.jevOk += 1;
      else counters.jevFailures += 1;
      const latency = finite(run?.latencyMs, null);
      if (latency !== null) {
        counters.jevLatencySumMs += latency;
        counters.jevLatencyCount += 1;
      }
    }
    if (modelIntent === "HIGHER") counters.higherCount += 1;
    if (modelIntent === "LOWER") counters.lowerCount += 1;
    if (Number.isFinite(pHigher)) {
      const observed = observeP(
        { sum: counters.pHigherSum, count: counters.pHigherCount, min: counters.minPHigher, max: counters.maxPHigher },
        pHigher,
      );
      counters.pHigherSum = observed.sum;
      counters.pHigherCount = observed.count;
      counters.minPHigher = observed.min;
      counters.maxPHigher = observed.max;
    }

    // ---- 5-6. policy + fill -------------------------------------------------
    const previousAccountState = hasOpenPosition(account) ? PAPER_SHADOW_ACCOUNT_STATES.LONG : PAPER_SHADOW_ACCOUNT_STATES.FLAT;
    const { action, reason: actionReason } = decidePaperAction({
      hasPosition: previousAccountState === PAPER_SHADOW_ACCOUNT_STATES.LONG,
      modelIntent,
      feedOk,
      price,
    });

    let paperFill = null;
    let appliedAction = action;
    let appliedReason = actionReason;

    if (action === PAPER_SHADOW_ACTIONS.ENTER) {
      const result = applyPaperEntry({ account, price, liquidityUsd, friction, positionFraction: settings.positionFraction });
      if (result.ok) {
        account = result.account;
        paperFill = compactPaperFill(result.fill, "BUY");
        counters.enterCount += 1;
      } else {
        appliedAction = PAPER_SHADOW_ACTIONS.NO_ACTION;
        appliedReason = `entry_${result.reason}`;
      }
    } else if (action === PAPER_SHADOW_ACTIONS.EXIT) {
      const result = applyPaperExit({ account, price, liquidityUsd, friction });
      if (result.ok) {
        account = result.account;
        paperFill = compactPaperFill(result.fill, "SELL");
        counters.exitCount += 1;
      } else {
        appliedAction = PAPER_SHADOW_ACTIONS.NO_ACTION;
        appliedReason = `exit_${result.reason}`;
      }
    } else if (action === PAPER_SHADOW_ACTIONS.HOLD) {
      counters.holdCount += 1;
      account = markAccount(account, { markPrice: price });
    } else if (action === PAPER_SHADOW_ACTIONS.CASH) {
      counters.cashCount += 1;
      account = markAccount(account, { markPrice: price });
    } else {
      counters.noActionCount += 1;
      // Retain the last legitimate mark: no invented price.
      account = markAccount(account, { markPrice: null });
    }

    // ---- 7. mark the account ----------------------------------------------
    if (appliedAction !== PAPER_SHADOW_ACTIONS.ENTER && appliedAction !== PAPER_SHADOW_ACTIONS.EXIT) {
      account = markAccount(account, { markPrice: feedOk ? price : null });
    }

    // ---- 8. append the event ----------------------------------------------
    const event = {
      sequence,
      sessionId,
      scheduledAt,
      observedAt: new Date(observedAtMs).toISOString(),
      stateFrozenAt: new Date(now()).toISOString(),
      market: BENCHMARK_MARKET.marketId,
      symbol: BENCHMARK_MARKET.baseSymbol,
      mint: BENCHMARK_MARKET.baseMint,
      referencePrice: price,
      liquidityUsd,
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      status: run?.status ?? null,
      requestId: run?.requestId ?? null,
      latencyMs: finite(run?.latencyMs, null),
      pHigher,
      pLower: Number.isFinite(pHigher) ? 1 - pHigher : null,
      modelIntent,
      stateDigest,
      packetDigest,
      previousAccountState,
      action: appliedAction,
      actionReason: appliedReason,
      paperFill,
      cash: account.cash,
      positionQty: account.positionQty,
      positionEntryPrice: account.positionEntryPrice,
      positionMarkPrice: account.positionMarkPrice,
      grossPnl: account.grossPnl,
      netPnl: account.netPnl,
      unrealizedPnl: account.unrealizedPnl,
      realizedPnl: account.realizedPnl,
      costs: account.costs,
      equity: account.equity,
      returnPct: account.returnPct,
      maxDrawdown: account.maxDrawdown,
      marketFeedHealth: feedHealth,
      jevCallAttempted,
      stateReason: feedOk ? null : state?.reason ?? null,
      errorReason,
    };

    await appendPaperShadowEvent(root, event);

    // ---- bounded bookkeeping for the dashboard + resume -------------------
    const row = compactDecisionRow(event);
    recentDecisions = [...recentDecisions, row].slice(-PAPER_SHADOW_RECENT_DECISION_LIMIT);
    equitySeries = [...equitySeries, { at: event.observedAt, equity: account.equity, price }].slice(
      -PAPER_SHADOW_EQUITY_SERIES_LIMIT,
    );

    // ---- 9. publish --------------------------------------------------------
    await writePaperShadowState(root, publishState("RUNNING"));

    // appending to the pre-decision history happens AFTER the packet is frozen
    if (feedOk && Number.isFinite(price)) {
      history = [...history, { observedAt: state.stateObservedAt, observedAtMs: stateObservedAtMs, priceUsd: price }].slice(
        -PAPER_SHADOW_HISTORY_LIMIT,
      );
      if (state.universeMarkets) {
        regimeSnapshots = [...regimeSnapshots, compactRegimeSnapshot(state.universeMarkets)].slice(
          -PAPER_SHADOW_REGIME_SNAPSHOT_LIMIT,
        );
      }
    }

    nextIndex += 1;

    emit({
      type: "DECISION",
      sessionId,
      sequence,
      action: appliedAction,
      actionReason: appliedReason,
      modelIntent,
      pHigher,
      referencePrice: price,
      equity: account.equity,
      netPnl: account.netPnl,
      marketFeedHealth: feedHealth,
    });
  }

  // ---- finalize ------------------------------------------------------------
  const finalSession = {
    ...session,
    updatedAt: new Date(now()).toISOString(),
    finalizedAt: new Date(now()).toISOString(),
    status: finalStatus,
    decisions: counters.decisions,
  };
  await writePaperShadowSession(root, finalSession);
  await writePaperShadowState(root, publishState(finalStatus));

  const summary = buildPaperShadowSummary({ session: finalSession, account, counters, status: finalStatus, equitySeries });
  await writePaperShadowSummary(root, summary);

  return {
    ok: true,
    sessionId,
    root,
    session: finalSession,
    summary,
    state: publishState(finalStatus),
    events: counters.decisions,
    interrupted,
  };
}

export const PAPER_SHADOW_RUNNER_EXPORTS = Object.freeze({
  sessionFile: PAPER_SHADOW_SESSION_FILE,
  supportedMarketIds: PAPER_SHADOW_SUPPORTED_MARKET_IDS,
  compactStamp: paperShadowCompactStamp,
});
