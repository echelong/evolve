/**
 * EVOLVE Phase 5I-PS.1 — forensic CSV report (§2, §13).
 *
 * One flat, fully explicit CSV with three row types:
 *
 *   decision   one row per captured decision, with the fixed forward horizons
 *   episode    one row per reconstructed paper round trip
 *   policy     one row per FROZEN counterfactual policy
 *
 * The report is a rendering of the JSON artifacts, never a second computation:
 * it cannot disagree with them. No column names or values rank, optimize, or
 * recommend anything.
 *
 * PAPER ONLY / POST-HOC.
 */

import { PAPER_FORENSICS_COUNTERFACTUAL_BANNER, roundTo } from "./definition.mjs";

export const PAPER_FORENSICS_REPORT_VERSION = 1;

/** The frozen column list. Every row type writes every column (empty when N/A). */
export const PAPER_FORENSICS_REPORT_COLUMNS = Object.freeze([
  "rowType",
  "classification",
  "analysisId",
  "sessionId",
  "decisionSequence",
  "observedAt",
  "pHigher",
  "modelIntent",
  "marketFeedHealth",
  "action",
  "actionReason",
  "referencePrice",
  "forwardReturn30s",
  "forwardReturn60s",
  "forwardReturn90s",
  "forwardReturn120s",
  "forwardReturn300s",
  "outcome30s",
  "correctDirection30s",
  "entrySequence",
  "exitSequence",
  "holdingMs",
  "entryPHigher",
  "exitPHigher",
  "referencePriceMovePct",
  "grossPnl",
  "fees",
  "executionCost",
  "totalCosts",
  "netPnl",
  "observedBreakEvenMovementPct",
  "policyId",
  "policyEntries",
  "policyExits",
  "policyRoundTrips",
  "policyTimeInMarketMs",
  "policyEndingCash",
  "policyEndingPositionValue",
  "policyEndingEquity",
  "policyGrossPnl",
  "policyNetPnl",
  "policyCosts",
  "policyMaxDrawdown",
  "policyTurnoverNotional",
  "policyMeanHoldingMs",
]);

const NUMERIC_DIGITS = 12;

function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(Number(value.toFixed(NUMERIC_DIGITS)));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowFrom(cells) {
  return PAPER_FORENSICS_REPORT_COLUMNS.map((column) => cell(column === "classification" ? PAPER_FORENSICS_COUNTERFACTUAL_BANNER.join(" | ") : cells[column])).join(",");
}

/** Build the full CSV text. `horizons` carries the fixed forward observations. */
export function buildForensicsReport({ analysisId, sessionId, events = [], episodes = [], horizons = null, counterfactuals = null, decomposition = null }) {
  const lines = [PAPER_FORENSICS_REPORT_COLUMNS.join(",")];
  const breakEvenByEntry = new Map(
    (decomposition?.observedBreakEvenMovement?.episodes ?? []).map((entry) => [entry.entrySequence, entry.observedBreakEvenMovementPct]),
  );
  const horizonBySequence = new Map(
    (horizons?.decisions ?? []).map((decision) => [decision.sequence, decision]),
  );

  // ---- decisions ----------------------------------------------------------
  for (const [index, event] of events.entries()) {
    const forward = horizonBySequence.get(event?.sequence ?? index + 1) ?? null;
    const horizonOf = (seconds) => forward?.horizons?.[String(seconds)] ?? null;
    lines.push(
      rowFrom({
        rowType: "decision",
        analysisId,
        sessionId,
        decisionSequence: event?.sequence ?? index + 1,
        observedAt: event?.observedAt ?? null,
        pHigher: event?.pHigher ?? null,
        modelIntent: event?.modelIntent ?? null,
        marketFeedHealth: event?.marketFeedHealth ?? null,
        action: event?.action ?? null,
        actionReason: event?.actionReason ?? null,
        referencePrice: event?.referencePrice ?? null,
        forwardReturn30s: horizonOf(30)?.forwardReturn ?? null,
        forwardReturn60s: horizonOf(60)?.forwardReturn ?? null,
        forwardReturn90s: horizonOf(90)?.forwardReturn ?? null,
        forwardReturn120s: horizonOf(120)?.forwardReturn ?? null,
        forwardReturn300s: horizonOf(300)?.forwardReturn ?? null,
        outcome30s: horizonOf(30)?.actualOutcome ?? null,
        correctDirection30s:
          horizonOf(30)?.available === true ? horizonOf(30)?.correctDirection ?? null : null,
        grossPnl: event?.grossPnl ?? null,
        netPnl: event?.realizedPnl ?? null,
        totalCosts: event?.costs ?? null,
      }),
    );
  }

  // ---- episodes -----------------------------------------------------------
  for (const episode of episodes) {
    lines.push(
      rowFrom({
        rowType: "episode",
        analysisId,
        sessionId,
        entrySequence: episode?.entrySequence ?? null,
        exitSequence: episode?.exitSequence ?? null,
        observedAt: episode?.entryObservedAt ?? null,
        action: episode?.status ?? null,
        referencePrice: episode?.entryReferencePrice ?? null,
        pHigher: episode?.entryPHigher ?? null,
        modelIntent: episode?.entryIntent ?? null,
        holdingMs: episode?.holdingMs ?? null,
        entryPHigher: episode?.entryPHigher ?? null,
        exitPHigher: episode?.exitPHigher ?? null,
        referencePriceMovePct: episode?.referencePriceMovePct ?? null,
        grossPnl: episode?.grossPnl ?? null,
        fees: episode?.fees ?? null,
        executionCost: episode?.executionCost ?? null,
        totalCosts: episode?.totalCosts ?? null,
        netPnl: episode?.netPnl ?? null,
        observedBreakEvenMovementPct: breakEvenByEntry.get(episode?.entrySequence) ?? null,
      }),
    );
  }

  // ---- counterfactual policies -------------------------------------------
  for (const policy of counterfactuals?.policies ?? []) {
    lines.push(
      rowFrom({
        rowType: "policy",
        analysisId,
        sessionId,
        policyId: policy?.policyId ?? null,
        policyEntries: policy?.entries ?? null,
        policyExits: policy?.exits ?? null,
        policyRoundTrips: policy?.roundTrips ?? null,
        policyTimeInMarketMs: policy?.timeInMarketMs ?? null,
        policyEndingCash: policy?.endingCash ?? null,
        policyEndingPositionValue: policy?.endingPositionValue ?? null,
        policyEndingEquity: policy?.endingEquity ?? null,
        policyGrossPnl: policy?.grossPnl ?? null,
        policyNetPnl: policy?.netPnl ?? null,
        policyCosts: policy?.costs ?? null,
        policyMaxDrawdown: policy?.maxDrawdown ?? null,
        policyTurnoverNotional: policy?.turnoverNotional ?? null,
        policyMeanHoldingMs: policy?.meanHoldingMs ?? null,
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** A bounded rendering of one number, for the CLI's compact lines. */
export function reportNumber(value, digits = 6) {
  return Number.isFinite(value) ? String(roundTo(value, digits)) : "n/a";
}
