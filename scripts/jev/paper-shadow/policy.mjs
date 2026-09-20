/**
 * Jev paper-shadow deterministic PAPER POLICY.
 *
 * This is the ONLY place a paper action is chosen, and it is a pure function of
 * the frozen state plus the frozen constants. It has:
 *
 *   - NO confidence threshold beyond the frozen binary boundary;
 *   - NO hysteresis (the boundary is 0.50 exactly, in both directions);
 *   - NO adaptation, no tuning, and no memory of prior results.
 *
 * The policy is deliberately tiny and inspectable:
 *
 *   FLAT + HIGHER => ENTER LONG SOL
 *   LONG + HIGHER => HOLD
 *   LONG + LOWER  => EXIT TO CASH
 *   FLAT + LOWER  => STAY CASH
 *
 * No short selling, no leverage, no stop loss, no take profit, no averaging
 * down, no pyramiding, and at most one open SOL position.
 *
 * A Jev failure or a degraded feed is NEVER converted into a trading action:
 * both resolve to NO_ACTION.
 *
 * PAPER ONLY.
 */

import {
  PAPER_SHADOW_ACTIONS,
  PAPER_SHADOW_INTENT_THRESHOLD,
} from "./definition.mjs";

export const PAPER_SHADOW_POLICY_VERSION = 1;

/**
 * The frozen binary action boundary, applied to the RAW Jev probability. There
 * is no calibration, no result-based threshold tuning, and no confidence gate.
 *
 * @param {number|null} pHigher
 * @returns {"HIGHER"|"LOWER"|null}
 */
export function modelIntentFromProbability(pHigher) {
  if (!Number.isFinite(pHigher)) return null;
  return pHigher >= PAPER_SHADOW_INTENT_THRESHOLD ? "HIGHER" : "LOWER";
}

/**
 * Choose the deterministic paper action.
 *
 * @param {{
 *   hasPosition: boolean,
 *   modelIntent: "HIGHER"|"LOWER"|null,
 *   feedOk: boolean,
 *   price: number|null,
 * }} input
 * @returns {{ action: string, reason: string }}
 */
export function decidePaperAction({ hasPosition, modelIntent, feedOk, price }) {
  if (feedOk !== true) {
    return { action: PAPER_SHADOW_ACTIONS.NO_ACTION, reason: "feed_degraded" };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { action: PAPER_SHADOW_ACTIONS.NO_ACTION, reason: "missing_price" };
  }
  if (modelIntent === null || modelIntent === undefined) {
    // Jev did not produce a usable probability. Recorded, never traded on.
    return { action: PAPER_SHADOW_ACTIONS.NO_ACTION, reason: "jev_unavailable" };
  }

  if (hasPosition) {
    return modelIntent === "HIGHER"
      ? { action: PAPER_SHADOW_ACTIONS.HOLD, reason: "long_and_higher" }
      : { action: PAPER_SHADOW_ACTIONS.EXIT, reason: "long_and_lower" };
  }

  return modelIntent === "HIGHER"
    ? { action: PAPER_SHADOW_ACTIONS.ENTER, reason: "flat_and_higher" }
    : { action: PAPER_SHADOW_ACTIONS.CASH, reason: "flat_and_lower" };
}

/**
 * The frozen, human-readable policy contract. Persisted with every session so a
 * reader can see exactly what was executed without reading code.
 */
export const PAPER_SHADOW_POLICY_DEFINITION = Object.freeze({
  version: PAPER_SHADOW_POLICY_VERSION,
  intentBoundary: "pHigher >= 0.50 => HIGHER; pHigher < 0.50 => LOWER",
  intentThreshold: PAPER_SHADOW_INTENT_THRESHOLD,
  hysteresis: false,
  confidenceThreshold: false,
  calibration: false,
  resultBasedTuning: false,
  rules: Object.freeze([
    "FLAT + HIGHER => ENTER LONG SOL",
    "LONG + HIGHER => HOLD",
    "LONG + LOWER => EXIT TO CASH",
    "FLAT + LOWER => STAY CASH",
  ]),
  shortSelling: false,
  leverage: false,
  stopLoss: false,
  takeProfit: false,
  averagingDown: false,
  pyramiding: false,
  maximumOpenPositions: 1,
  onJevFailure: "NO_ACTION",
  onDegradedFeed: "NO_ACTION",
  onMissingPrice: "NO_ACTION",
});
