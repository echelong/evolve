/** Offline fixed paper friction and captured-fill reproduction. No fitting. */

import { simulateEntry, simulateExit, slippageBpsFor } from "../../engine/paper.mjs";
import { createMarketConfig } from "../../market/config.mjs";
import { PAPER_FORENSICS_TOLERANCE, finiteOrNull, roundTo } from "./definition.mjs";

export const PAPER_FORENSICS_FRICTION_VERSION = 1;

/** The frozen paper friction defaults, resolved WITHOUT env and WITHOUT network. */
export function frozenPaperFriction() {
  const config = createMarketConfig({}, { loadEnv: false });
  return { ...config.paper };
}

/** One recorded fill as a reconstruction observation. */
export function frictionObservationOf(event) {
  const fill = event?.paperFill;
  if (!fill || fill.ok === false) return null;
  const side = fill.side === "SELL" ? "SELL" : fill.side === "BUY" ? "BUY" : null;
  if (side === null) return null;
  const liquidityUsd = finiteOrNull(event?.liquidityUsd);
  const notional = finiteOrNull(fill.notional);
  const qty = finiteOrNull(fill.qty);
  const executedPrice = finiteOrNull(fill.executedPrice);
  const referencePrice = finiteOrNull(fill.referencePrice);
  if (liquidityUsd === null || liquidityUsd <= 0 || notional === null || notional <= 0) return null;
  if (qty === null || executedPrice === null || referencePrice === null) return null;
  return {
    sequence: event?.sequence ?? null,
    side,
    liquidityUsd,
    notional,
    qty,
    executedPrice,
    referencePrice,
    feeUsd: finiteOrNull(fill.feeUsd),
    slippageBps: finiteOrNull(fill.slippageBps),
    costBps: finiteOrNull(fill.costBps),
    frictionUsd: finiteOrNull(fill.frictionUsd),
    share: notional / liquidityUsd,
    grossProceeds: qty * executedPrice,
  };
}
/** A relative/absolute closeness test with a documented tolerance. */
function closeEnough(actual, expected, { relative = PAPER_FORENSICS_TOLERANCE.fillRelative } = {}) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= relative * scale;
}

/** True when replayed slippage is strictly below the cap (the cap never binds). */
export function capNeverBinds({ model, observation }) {
  if (!model || !observation) return true;
  const notionalCandidates = [observation.notional, observation.grossProceeds].filter((value) => Number.isFinite(value));
  return notionalCandidates.every((notional) => {
    const bps = slippageBpsFor({ notionalUsd: notional, liquidityUsd: observation.liquidityUsd, friction: model });
    return bps < model.slippageCapBps;
  });
}

/**
 * Replay every recorded fill through the SAME engine machinery with the given
 * friction model and report the residuals.
 */
export function verifyFillReproduction({ observations = [], model = null } = {}) {
  if (model === null || observations.length === 0) {
    return {
      ok: false,
      reason: model === null ? "no_friction_model" : "no_recorded_fills",
      replayCount: 0,
      maxAbsoluteDelta: {},
      maxRelativeDelta: {},
      mismatches: [],
      engineModule: "scripts/engine/paper.mjs",
    };
  }

  const maxAbsoluteDelta = { executedPrice: 0, qty: 0, feeUsd: 0, frictionUsd: 0 };
  const maxRelativeDelta = { executedPrice: 0, qty: 0, feeUsd: 0, frictionUsd: 0 };
  const mismatches = [];
  let replayed = 0;

  for (const observation of observations) {
    const simulated =
      observation.side === "BUY"
        ? simulateEntry({
            price: observation.referencePrice,
            notionalUsd: observation.notional,
            liquidityUsd: observation.liquidityUsd,
            friction: model,
          })
        : simulateExit({
            qty: observation.qty,
            price: observation.referencePrice,
            liquidityUsd: observation.liquidityUsd,
            referencePrice: observation.referencePrice,
            friction: model,
          });
    replayed += 1;
    if (simulated.ok !== true) {
      mismatches.push({ sequence: observation.sequence, side: observation.side, detail: `engine returned ${simulated.reason}` });
      continue;
    }
    const pairs = [
      ["executedPrice", simulated.executedPrice, observation.executedPrice],
      ["qty", simulated.qty, observation.qty],
      ["feeUsd", simulated.feeUsd, observation.feeUsd],
      ["frictionUsd", simulated.frictionUsd, observation.frictionUsd],
    ];
    for (const [field, actual, expected] of pairs) {
      const absolute = Math.abs(actual - expected);
      const scale = Math.max(1e-300, Math.abs(expected));
      maxAbsoluteDelta[field] = Math.max(maxAbsoluteDelta[field], absolute);
      maxRelativeDelta[field] = Math.max(maxRelativeDelta[field], absolute / scale);
      if (!closeEnough(actual, expected)) {
        mismatches.push({
          sequence: observation.sequence,
          side: observation.side,
          field,
          recorded: expected,
          replayed: actual,
        });
      }
    }
  }

  return {
    ok: mismatches.length === 0 && replayed > 0,
    reason: mismatches.length === 0 ? null : "recorded_fills_not_reproduced",
    replayCount: replayed,
    maxAbsoluteDelta: Object.fromEntries(
      Object.entries(maxAbsoluteDelta).map(([key, value]) => [key, roundTo(value, 18)]),
    ),
    maxRelativeDelta: Object.fromEntries(
      Object.entries(maxRelativeDelta).map(([key, value]) => [key, roundTo(value, 18)]),
    ),
    mismatches: mismatches.slice(0, 20),
    toleranceRelative: PAPER_FORENSICS_TOLERANCE.fillRelative,
    engineModule: "scripts/engine/paper.mjs",
    directEngineReuse: true,
  };
}

/** Fixed configuration, chosen before replay. Captured fills only verify it.
 * Legacy captures omit cap/liquidity settings, so a mismatch fails closed;
 * we never solve or select parameters from future fills.
 */
export function resolveFrictionModel({ events = [] } = {}) {
  const model = frozenPaperFriction();
  const observations = events.map(frictionObservationOf).filter(Boolean);
  const reproductionWithDefault = verifyFillReproduction({ observations, model });
  if (observations.length === 0) reproductionWithDefault.ok = true;
  return {
    model, used: "frozen_default", reason: "fixed_before_replay_not_inferred_from_fills",
    derivation: null, reproductionWithDerived: null, reproductionWithDefault, observations,
  };
}
