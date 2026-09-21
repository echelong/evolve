/**
 * EVOLVE Phase 5I-PS.1 — FROZEN counterfactual policy replay (§12, §13, §14).
 *
 * The replay consumes the SAME captured events, the SAME captured reference
 * prices and the SAME fill machinery the recorded session used:
 *
 *   - `scripts/engine/paper.mjs`          (the fill engine, reached through …)
 *   - `scripts/jev/paper-shadow/account.mjs` (the paper account and fills)
 *   - `scripts/jev/paper-shadow/policy.mjs`  (the recorded binary policy)
 *
 * Exactly five policies exist and they are declared in `definition.mjs` BEFORE
 * any result is observed. There is NO threshold sweep, NO grid search, NO
 * Bayesian/adaptive search, NO result-driven parameter search, NO automatic
 * strategy generation, NO ranking, and NO "bestPolicy" field.
 *
 * NO LOOKAHEAD. The fold is strictly chronological: at decision `index` the
 * policy function receives one observation and its own prior memory, and it can
 * neither read nor be influenced by any later record. Forward prices are used
 * only by `horizons.mjs`, in a separate pass, for forensic scoring.
 *
 * PAPER ONLY / DEVELOPMENT ONLY / POST-HOC ONLY.
 */

import { applyPaperEntry, applyPaperExit, compactPaperFill, createPaperAccount, markAccount } from "../paper-shadow/account.mjs";
import { decidePaperAction, modelIntentFromProbability } from "../paper-shadow/policy.mjs";
import {
  PAPER_FORENSICS_COUNTERFACTUAL_BANNER,
  PAPER_FORENSICS_NO_WINNER_STATEMENT,
  PAPER_FORENSICS_POLICIES,
  PAPER_FORENSICS_POLICY_IDS,
  finiteOrNull,
  roundTo,
} from "./definition.mjs";

export const PAPER_FORENSICS_COUNTERFACTUALS_VERSION = 1;

export const PAPER_FORENSICS_NO_TRADE = "NO_TRADE";
export const PAPER_FORENSICS_RECORDED_BINARY = "RECORDED_BINARY";
export const PAPER_FORENSICS_TWO_SIGNAL_CONFIRMATION = "TWO_SIGNAL_CONFIRMATION";
export const PAPER_FORENSICS_MIN_HOLD_60S = "MIN_HOLD_60S";
export const PAPER_FORENSICS_TWO_SIGNAL_PLUS_60S = "TWO_SIGNAL_PLUS_60S";

/** The frozen policy records, or throw for an id outside the frozen set. */
export function paperForensicsPolicyFor(policyId) {
  const policy = PAPER_FORENSICS_POLICIES.find((entry) => entry.id === policyId);
  if (!policy) throw new Error(`unknown counterfactual policy '${policyId}' (the policy set is frozen)`);
  return policy;
}

/**
 * The observation a policy may see at decision `index`. Nothing else is handed
 * to the policy: there is no array, no index, no cursor, and no future record.
 */
export function policyObservationOf(event) {
  const price = finiteOrNull(event?.referencePrice);
  const feedOk = event?.marketFeedHealth === "LIVE";
  return {
    observedAtMs: Date.parse(String(event?.observedAt ?? "")),
    price: price !== null && price > 0 ? price : null,
    liquidityUsd: finiteOrNull(event?.liquidityUsd),
    // The intent is RECOMPUTED from the captured probability through the frozen
    // boundary; the recorded intent is carried only for the integrity comparison.
    intent: modelIntentFromProbability(finiteOrNull(event?.pHigher)),
    recordedIntent: event?.modelIntent === "HIGHER" || event?.modelIntent === "LOWER" ? event.modelIntent : null,
    recordedPHigher: finiteOrNull(event?.pHigher),
    feedOk,
    // `feedOk` is the captured feed health; a missing price is handled by the
    // policy itself (`missing_price`), exactly as the recorded runner did.
    priceOk: price !== null && price > 0,
  };
}

/**
 * The single policy decision function. It is a pure function of the CURRENT
 * observation plus the policy's own chronological memory.
 *
 * @param {{
 *   policyId: string,
 *   hasPosition: boolean,
 *   observation: object,
 *   memory: { higherStreak: number, lowerStreak: number, heldMs: number|null },
 * }} input
 * @returns {{ action: string, reason: string, gate: string|null }}
 */
export function decideCounterfactualAction({ policyId, hasPosition, observation, memory }) {
  const policy = paperForensicsPolicyFor(policyId);
  const { confirmationSignals, minHoldMs } = policy.parameters;

  if (policyId === PAPER_FORENSICS_NO_TRADE) {
    return { action: "CASH", reason: "no_trade_policy", gate: null };
  }

  // The recorded binary rule is the SAME pure function the live runner used.
  const base = decidePaperAction({
    hasPosition,
    modelIntent: observation.intent,
    feedOk: observation.feedOk,
    price: observation.price,
  });

  let action = base.action;
  let reason = base.reason;
  let gate = null;

  if (confirmationSignals !== null) {
    const confirmed = (streak) => Number.isFinite(streak) && streak >= confirmationSignals;
    if (action === "ENTER" && !confirmed(memory.higherStreak)) {
      action = "CASH";
      reason = "confirmation_pending";
      gate = "two_signal_confirmation";
    } else if (action === "EXIT" && !confirmed(memory.lowerStreak)) {
      action = "HOLD";
      reason = "confirmation_pending";
      gate = "two_signal_confirmation";
    }
  }

  if (minHoldMs !== null && action === "EXIT") {
    const heldMs = finiteOrNull(memory.heldMs);
    if (heldMs === null || heldMs < minHoldMs) {
      action = "HOLD";
      reason = "min_hold_active";
      gate = "min_hold";
    }
  }

  return { action, reason, gate };
}

/**
 * The next policy memory, computed ONLY from the current intent and the action
 * that was actually taken. A null intent resets both streaks; a streak resets
 * once it has triggered its action.
 */
export function nextPolicyMemory({ policyId, observation, action, previous }) {
  const policy = paperForensicsPolicyFor(policyId);
  if (policy.parameters.confirmationSignals === null) {
    return { higherStreak: 0, lowerStreak: 0 };
  }
  if (observation.intent === null) return { higherStreak: 0, lowerStreak: 0 };
  let higherStreak = observation.intent === "HIGHER" ? previous.higherStreak + 1 : 0;
  let lowerStreak = observation.intent === "LOWER" ? previous.lowerStreak + 1 : 0;
  if (action === "ENTER") higherStreak = 0;
  if (action === "EXIT") lowerStreak = 0;
  return { higherStreak, lowerStreak };
}

/**
 * Replay ONE frozen policy over the captured events.
 *
 * @param {{
 *   policyId: string,
 *   events?: object[],
 *   friction: object,
 *   positionFraction: number,
 *   startingCash: number,
 * }} input
 */
export function replayPolicy({ policyId, events = [], friction, positionFraction, startingCash }) {
  const policy = paperForensicsPolicyFor(policyId);
  const start = finiteOrNull(startingCash) ?? 0;
  let account = createPaperAccount({ startingCash: start });
  let streaks = { higherStreak: 0, lowerStreak: 0 };
  let totalTurnoverNotional = 0;
  const actions = [];
  const roundTrips = [];
  let openEntry = null;

  for (let index = 0; index < events.length; index += 1) {
    // ---- the ONLY observation the policy is allowed to see -----------------
    // NOTE the fold reads exactly one record per step — the CURRENT one. It never
    // looks ahead to a later record: the policy input is this observation plus the
    // policy's own memory, which was built from earlier records only.
    const observation = policyObservationOf(events[index]);
    const hasPosition = account.positionQty > 0;
    const memory = {
      higherStreak: observation.intent === "HIGHER" ? streaks.higherStreak + 1 : 0,
      lowerStreak: observation.intent === "LOWER" ? streaks.lowerStreak + 1 : 0,
      heldMs: openEntry === null ? null : observation.observedAtMs - openEntry.observedAtMs,
    };

    const decision = decideCounterfactualAction({ policyId, hasPosition, observation, memory });

    let appliedAction = decision.action;
    let appliedReason = decision.reason;
    let fill = null;

    if (decision.action === "ENTER") {
      const result = applyPaperEntry({
        account,
        price: observation.price,
        liquidityUsd: observation.liquidityUsd,
        friction,
        positionFraction,
      });
      if (result.ok) {
        account = result.account;
        fill = result.fill;
        totalTurnoverNotional += finiteOrNull(result.fill.cashSpent) ?? 0;
        openEntry = {
          sequence: events[index]?.sequence ?? index + 1,
          observedAt: events[index]?.observedAt ?? null,
          observedAtMs: observation.observedAtMs,
          referencePrice: result.fill.referencePrice,
          executedPrice: result.fill.executedPrice,
          notional: result.fill.cashSpent,
          pHigher: observation.recordedPHigher,
          intent: observation.recordedIntent,
        };
      } else {
        appliedAction = "NO_ACTION";
        appliedReason = `entry_${result.reason}`;
      }
    } else if (decision.action === "EXIT") {
      const result = applyPaperExit({
        account,
        price: observation.price,
        liquidityUsd: observation.liquidityUsd,
        friction,
      });
      if (result.ok) {
        account = result.account;
        fill = result.fill;
        totalTurnoverNotional += (finiteOrNull(result.fill.qty) ?? 0) * (finiteOrNull(result.fill.referencePrice) ?? 0);
        if (openEntry !== null) {
          roundTrips.push({
            entrySequence: openEntry.sequence,
            exitSequence: events[index]?.sequence ?? index + 1,
            holdingMs: observation.observedAtMs - openEntry.observedAtMs,
            decisionsHeld: (events[index]?.sequence ?? index + 1) - openEntry.sequence,
            entryReferencePrice: openEntry.referencePrice,
            exitReferencePrice: result.fill.referencePrice,
            entryPHigher: openEntry.pHigher,
            exitPHigher: observation.recordedPHigher,
            netPnl: roundTo(result.tradeNetPnl, 12),
          });
          openEntry = null;
        }
      } else {
        appliedAction = "NO_ACTION";
        appliedReason = `exit_${result.reason}`;
      }
    }

    // ---- marking: EXACTLY the recorded runner's order ----------------------
    if (appliedAction !== "ENTER" && appliedAction !== "EXIT") {
      account = markAccount(account, {
        markPrice: observation.feedOk ? observation.price : null,
      });
    }

    streaks = nextPolicyMemory({ policyId, observation, action: appliedAction, previous: streaks });

    actions.push({
      sequence: events[index]?.sequence ?? index + 1,
      observedAt: events[index]?.observedAt ?? null,
      recordedAction: typeof events[index]?.action === "string" ? events[index].action : null,
      recordedIntent: observation.recordedIntent,
      replayedIntent: observation.intent,
      action: appliedAction,
      reason: appliedReason,
      gate: decision.gate,
      pHigher: observation.recordedPHigher,
      referencePrice: observation.price,
      feedOk: observation.feedOk,
      fillSide: fill === null ? null : decision.action === "ENTER" ? "BUY" : "SELL",
      cash: roundTo(account.cash, 12),
      positionQty: roundTo(account.positionQty, 12),
      equity: roundTo(account.equity, 12),
      netPnl: roundTo(account.netPnl, 12),
      costs: roundTo(account.costs, 12),
      grossPnl: roundTo(account.grossPnl, 12),
      realizedPnl: roundTo(account.realizedPnl, 12),
      maxDrawdown: roundTo(account.maxDrawdown, 12),
      paperFill: compactPaperFill(fill, appliedAction === "ENTER" ? "BUY" : "SELL"),
    });
  }

  const holdSamples = roundTrips.map((trip) => trip.holdingMs).filter((value) => Number.isFinite(value));
  const entries = actions.filter((action) => action.action === "ENTER").length;
  const exits = actions.filter((action) => action.action === "EXIT").length;
  // Time in market is measured AFTER the fold, from the already-decided action
  // states. It is a duration metric only and cannot influence any action.
  const timeInMarketMs = timeInMarketFromActions(actions);

  return {
    policyId: policy.id,
    banner: [...PAPER_FORENSICS_COUNTERFACTUAL_BANNER],
    label: policy.label,
    definition: policy.definition,
    parametersFrozen: policy.parameters,
    entries,
    exits,
    roundTrips: roundTrips.length,
    openAtSessionEnd: account.positionQty > 0 ? 1 : 0,
    timeInMarketMs,
    timeInMarketShare:
      events.length > 1
        ? roundTo(
            timeInMarketMs /
              Math.max(
                1,
                Date.parse(String(events[events.length - 1]?.observedAt ?? "")) -
                  Date.parse(String(events[0]?.observedAt ?? "")),
              ),
            12,
          )
        : null,
    startingCash: roundTo(start, 12),
    endingCash: roundTo(account.cash, 12),
    endingPositionValue: roundTo(account.positionValue, 12),
    endingEquity: roundTo(account.equity, 12),
    grossPnl: roundTo(account.grossPnl, 12),
    netPnl: roundTo(account.netPnl, 12),
    realizedGrossPnl: roundTo(account.realizedGrossPnl, 12),
    realizedPnl: roundTo(account.realizedPnl, 12),
    costs: roundTo(account.costs, 12),
    maxDrawdown: roundTo(account.maxDrawdown, 12),
    turnoverNotional: roundTo(totalTurnoverNotional, 12),
    meanHoldingMs:
      holdSamples.length > 0 ? roundTo(holdSamples.reduce((total, value) => total + value, 0) / holdSamples.length, 12) : null,
    roundTripsDetail: roundTrips,
    actions,
    actionCounts: actions.reduce((counts, action) => {
      counts[action.action] = (counts[action.action] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

/**
 * Post-hoc time-in-market measurement over the decided action states: the span
 * between consecutive decisions is counted for the position held at the START of
 * that span. Never used by the policy fold itself.
 */
export function timeInMarketFromActions(actions) {
  let total = 0;
  for (let index = 0; index < actions.length - 1; index += 1) {
    const from = Date.parse(String(actions[index]?.observedAt ?? ""));
    const to = Date.parse(String(actions[index + 1]?.observedAt ?? ""));
    const span = to - from;
    if (!Number.isFinite(span) || span <= 0) continue;
    if ((finiteOrNull(actions[index]?.positionQty) ?? 0) > 0) total += span;
  }
  return total;
}

/**
 * Replay every frozen policy. Presentation order is the frozen declaration order
 * and carries NO ranking: the returned list is not sorted by any result, and no
 * policy is marked as preferred.
 */
export function replayAllPolicies({ events = [], friction, positionFraction, startingCash } = {}) {
  return PAPER_FORENSICS_POLICY_IDS.map((policyId) =>
    replayPolicy({ policyId, events, friction, positionFraction, startingCash }),
  );
}

/**
 * The replay integrity check for RECORDED_BINARY: the recorded policy must
 * reproduce the recorded actions and the recorded final account.
 */
export function compareRecordedReplay({ replay, events = [], summary = null }) {
  const mismatches = [];
  for (const action of replay.actions) {
    const captured = events.find((event) => event.sequence === action.sequence);
    const accountMatches = ["cash", "equity", "positionQty", "netPnl", "costs", "grossPnl", "realizedPnl", "maxDrawdown"].every((key) =>
      Number.isFinite(captured?.[key]) && Math.abs(captured[key] - action[key]) <= 1e-9);
    const fillMatches = action.paperFill === null ? captured?.paperFill === null :
      captured?.paperFill?.side === action.paperFill.side &&
      Object.keys(action.paperFill).filter(key => key !== "side").every(key =>
        Number.isFinite(captured.paperFill[key]) && Math.abs(captured.paperFill[key] - action.paperFill[key]) <= 1e-9);
    if (action.recordedAction !== action.action || !accountMatches || !fillMatches || action.recordedIntent !== action.replayedIntent) {
      mismatches.push({
        sequence: action.sequence,
        recorded: action.recordedAction,
        replayed: action.action,
        reason: action.reason,
      });
    }
  }
  const lastEvent = events[events.length - 1] ?? null;
  const deltas = {
    cash: Math.abs((finiteOrNull(lastEvent?.cash) ?? 0) - (replay.endingCash ?? 0)),
    equity: Math.abs((finiteOrNull(lastEvent?.equity) ?? 0) - (replay.endingEquity ?? 0)),
    netPnl: Math.abs((finiteOrNull(lastEvent?.netPnl) ?? 0) - (replay.netPnl ?? 0)),
    realizedPnl: Math.abs((finiteOrNull(lastEvent?.realizedPnl) ?? 0) - (replay.realizedPnl ?? 0)),
    grossPnl: Math.abs(lastEvent.grossPnl - replay.grossPnl),
    maxDrawdown: Math.abs(lastEvent.maxDrawdown - replay.maxDrawdown),
    positionQty: Math.abs(lastEvent.positionQty - replay.actions.at(-1).positionQty),
    costs: Math.abs((finiteOrNull(lastEvent?.costs) ?? 0) - (replay.costs ?? 0)),
  };
  const maxDelta = Math.max(...Object.values(deltas));
  const roundTripsMatch = replay.roundTrips === (finiteOrNull(summary?.exitCount) ?? replay.roundTrips);
  return {
    actionsMatch: mismatches.length === 0,
    actionMismatches: mismatches.slice(0, 20),
    actionMismatchCount: mismatches.length,
    roundTripsMatch,
    finalAccount: {
      recorded: {
        cash: finiteOrNull(lastEvent?.cash),
        equity: finiteOrNull(lastEvent?.equity),
        netPnl: finiteOrNull(lastEvent?.netPnl),
        realizedPnl: finiteOrNull(lastEvent?.realizedPnl),
        realizedGrossPnl: finiteOrNull(lastEvent?.realizedGrossPnl),
        costs: finiteOrNull(lastEvent?.costs),
      },
      replayed: {
        cash: replay.endingCash,
        equity: replay.endingEquity,
        netPnl: replay.netPnl,
        realizedPnl: replay.realizedPnl,
        realizedGrossPnl: replay.realizedGrossPnl,
        costs: replay.costs,
      },
      absoluteDeltas: Object.fromEntries(Object.entries(deltas).map(([key, value]) => [key, roundTo(value, 18)])),
      maxAbsoluteDelta: roundTo(maxDelta, 18),
    },
    ok: mismatches.length === 0 && roundTripsMatch && maxDelta <= 1e-9,
    toleranceUsd: 1e-9,
    note:
      "RECORDED_BINARY is a replay integrity check: it must reproduce the captured policy's actions and final account. It is not a performance claim.",
  };
}

/** The full counterfactual artifact (§12, §13). */
export function buildCounterfactuals({ events = [], friction, positionFraction, startingCash, summary = null } = {}) {
  const policies = replayAllPolicies({ events, friction, positionFraction, startingCash });
  const recorded = policies.find((policy) => policy.policyId === PAPER_FORENSICS_RECORDED_BINARY) ?? null;
  const replayIntegrity =
    recorded === null ? null : compareRecordedReplay({ replay: recorded, events, summary });

  return {
    version: PAPER_FORENSICS_COUNTERFACTUALS_VERSION,
    banner: [...PAPER_FORENSICS_COUNTERFACTUAL_BANNER],
    paperOnly: true,
    postHoc: true,
    developmentOnly: true,
    outOfSample: false,
    replicationEvidence: false,
    parameterValidation: false,
    noWinnerStatement: PAPER_FORENSICS_NO_WINNER_STATEMENT,
    rankingPerformed: false,
    policySelected: false,
    policyCount: policies.length,
    policyIds: [...PAPER_FORENSICS_POLICY_IDS],
    policyOrderIsDefinitionOrderNotARanking: true,
    engineModule: "scripts/engine/paper.mjs",
    engineReusePath: "scripts/engine/paper.mjs -> scripts/jev/paper-shadow/account.mjs -> counterfactuals.mjs",
    fillMachinery: "scripts/jev/paper-shadow/account.mjs (applyPaperEntry / applyPaperExit)",
    recordedPolicyModule: "scripts/jev/paper-shadow/policy.mjs (decidePaperAction)",
    chronological: true,
    futureDataUsedForActions: false,
    fringeParametersFrozenBeforeResults: true,
    replayIntegrity,
    policies,
    notes: [
      "Every policy replays the SAME captured events and the SAME captured prices through the SAME paper fill machinery.",
      "No threshold sweep, grid search, adaptive holding period, or result-driven parameter search exists in this module.",
      "The policy list is in frozen declaration order. No policy is ranked, recommended, or selected.",
    ],
  };
}
