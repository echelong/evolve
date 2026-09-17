/**
 * Reward-hacking watchdog (Phase 5A).
 *
 * A deterministic, inspection-only screen over candidate results. It looks for
 * the classic ways a paper-trading candidate "cheats" its own evaluation:
 * one mint, one window, one regime, one seed, one lucky trade, missing data,
 * parameter-bound saturation, train→OOS collapse, stress collapse, churn, and
 * replay-vs-live discrepancy.
 *
 * A flag does NOT kill a candidate. Flags map to a verdict:
 *
 *   NORMAL      — nothing suspicious
 *   WATCH       — some flags; candidate continues but is labelled
 *   QUARANTINED — too many flags; the candidate needs additional deterministic
 *                 evaluation (another cycle with fresh windows/seeds) before it
 *                 may be considered for anything beyond research bookkeeping.
 *                 It can never become a Deployment Candidate while quarantined.
 *
 * The watchdog is advisory to the research layer and invisible to the Arena:
 * Arena gates are never weakened or bypassed by it. Quarantine only constrains
 * what the RESEARCH layer may do next (no injection, no PROMISING status).
 *
 * PAPER ONLY research machinery.
 */

import { GENOME_KEYS, GENE_BOUNDS } from "../engine/genome.mjs";

export const WATCHDOG_VERSION = 1;

export const WATCHDOG_FLAGS = Object.freeze([
  "single-mint-dominance",
  "single-window-dominance",
  "single-regime-dependence",
  "single-seed-dependence",
  "very-low-trade-count",
  "single-trade-return-dominance",
  "high-cost-drag",
  "replay-live-discrepancy",
  "missing-data-dependence",
  "parameter-boundary-saturation",
  "train-oos-collapse",
  "stress-collapse",
]);

export const WATCHDOG_VERDICT = Object.freeze({
  NORMAL: "NORMAL",
  WATCH: "WATCH",
  QUARANTINED: "QUARANTINED",
});

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** Largest-share helper over a map of positive totals. */
function topShare(totals) {
  const values = Object.values(totals ?? {}).filter((v) => Number.isFinite(v) && v > 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || values.length === 0) return { share: 0, key: null, total: 0 };
  let bestKey = null;
  let best = -Infinity;
  for (const [key, value] of Object.entries(totals)) {
    if (Number.isFinite(value) && value > best) {
      best = value;
      bestKey = key;
    }
  }
  return { share: clamp01(best / total), key: bestKey, total };
}

/**
 * Share of genome genes sitting exactly on their bound edges (within epsilon).
 * A candidate whose parameters all sit at hard limits is usually optimizing a
 * simulator artifact rather than a strategy.
 */
export function parameterBoundarySaturation(genome, { epsilon = 1e-9 } = {}) {
  if (!genome || typeof genome !== "object") return { share: 0, saturated: [] };
  const saturated = [];
  let considered = 0;
  for (const key of GENOME_KEYS) {
    const value = genome[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const bounds = GENE_BOUNDS[key];
    if (!bounds) continue;
    considered += 1;
    const [lo, hi] = bounds;
    if (Math.abs(value - lo) <= epsilon || Math.abs(value - hi) <= epsilon) saturated.push(key);
  }
  return { share: considered > 0 ? saturated.length / considered : 0, saturated };
}

/**
 * Evaluate one candidate's aggregated evidence.
 *
 * @param {{
 *   trades?: number,
 *   distinctMints?: number,
 *   mintNotional?: Record<string, number>,
 *   windowReturns?: Record<string, number>,
 *   regimeReturns?: Record<string, number>,
 *   seedReturns?: Record<string, number>,
 *   maxSingleTradeReturn?: number,
 *   totalPositiveReturn?: number,
 *   costDrag?: number,
 *   missingDataShare?: number,
 *   trainReturn?: number|null,
 *   oosReturn?: number|null,
 *   oosWindows?: number,
 *   stressSurvived?: number,
 *   stressTotal?: number,
 *   replayReturn?: number|null,
 *   liveReturn?: number|null,
 *   genome?: object,
 * }} evidence
 * @param {object} thresholds researchWatch config
 * @returns {{
 *   verdict: string,
 *   flags: Array<{flag: string, detail: string}>,
 *   shares: object,
 * }}
 */
export function evaluateCandidate(evidence, thresholds) {
  const t = thresholds ?? {};
  const minTrades = Number.isFinite(t.minTrades) ? t.minTrades : 8;
  const flags = [];

  const mint = topShare(evidence.mintNotional);
  if (mint.share >= (t.topMintNotionalShare ?? 0.5)) {
    flags.push({ flag: "single-mint-dominance", detail: `top mint ${(mint.share * 100).toFixed(1)}% of executed notional` });
  }

  const window = topShare(evidence.windowReturns);
  if (window.share >= (t.topWindowReturnShare ?? 0.6)) {
    flags.push({ flag: "single-window-dominance", detail: `top window carries ${(window.share * 100).toFixed(1)}% of net return` });
  }

  const regime = topShare(evidence.regimeReturns);
  if (regime.share >= (t.topRegimeReturnShare ?? 0.75)) {
    flags.push({ flag: "single-regime-dependence", detail: `top regime carries ${(regime.share * 100).toFixed(1)}% of net return` });
  }

  const seed = topShare(evidence.seedReturns);
  if (seed.share >= 0.8) {
    flags.push({ flag: "single-seed-dependence", detail: `top seed carries ${(seed.share * 100).toFixed(1)}% of net return` });
  }

  const trades = Math.max(0, Math.round(Number(evidence.trades ?? 0)));
  if (trades < minTrades) {
    flags.push({ flag: "very-low-trade-count", detail: `${trades} trades < ${minTrades} minimum` });
  }

  const positive = Math.max(0, Number(evidence.totalPositiveReturn ?? 0));
  const maxSingle = Number.isFinite(evidence.maxSingleTradeReturn) ? Math.max(0, evidence.maxSingleTradeReturn) : 0;
  const singleTradeShare = positive > 0 ? clamp01(maxSingle / positive) : 0;
  if (positive > 0 && singleTradeShare >= (t.maxSingleTradeReturnShare ?? 0.8)) {
    flags.push({ flag: "single-trade-return-dominance", detail: `one trade is ${(singleTradeShare * 100).toFixed(1)}% of positive return` });
  }

  const costDrag = Number.isFinite(evidence.costDrag) ? evidence.costDrag : 0;
  if (costDrag >= (t.maxCostDrag ?? 0.15)) {
    flags.push({ flag: "high-cost-drag", detail: `cost drag ${(costDrag * 100).toFixed(2)}% of starting cash` });
  }

  // Replay/live discrepancy: relative gap between replay and live observed
  // paper returns when both exist. A large gap means the candidate's behaviour
  // depends on something that differs between the two feeds.
  const replayReturn = Number.isFinite(evidence.replayReturn) ? evidence.replayReturn : null;
  const liveReturn = Number.isFinite(evidence.liveReturn) ? evidence.liveReturn : null;
  if (replayReturn !== null && liveReturn !== null) {
    const scale = Math.max(Math.abs(replayReturn), Math.abs(liveReturn), 0.01);
    const discrepancy = Math.abs(replayReturn - liveReturn) / scale;
    if (discrepancy >= 0.5) {
      flags.push({ flag: "replay-live-discrepancy", detail: `replay vs live paper return differs by ${(discrepancy * 100).toFixed(0)}%` });
    }
  }

  const missingDataShare = clamp01(evidence.missingDataShare ?? 0);
  if (missingDataShare >= 0.2) {
    flags.push({ flag: "missing-data-dependence", detail: `${(missingDataShare * 100).toFixed(0)}% of observations had missing data` });
  }

  const saturation = parameterBoundarySaturation(evidence.genome);
  if (saturation.share >= 0.4) {
    flags.push({ flag: "parameter-boundary-saturation", detail: `${saturatedList(saturation)} genes pinned at bounds (${(saturation.share * 100).toFixed(0)}%)` });
  }

  const trainReturn = Number.isFinite(evidence.trainReturn) ? evidence.trainReturn : null;
  const oosReturn = Number.isFinite(evidence.oosReturn) ? evidence.oosReturn : null;
  if (trainReturn !== null && oosReturn !== null && trainReturn > 0) {
    const collapse = (trainReturn - oosReturn) / Math.abs(trainReturn);
    if (collapse >= (t.maxTrainOosCollapse ?? 0.7)) {
      flags.push({ flag: "train-oos-collapse", detail: `train ${(trainReturn * 100).toFixed(1)}% collapsed to ${(oosReturn * 100).toFixed(1)}% out-of-sample` });
    }
  }

  const oosWindows = Math.max(0, Math.round(Number(evidence.oosWindows ?? 0)));
  const stressSurvived = Math.max(0, Math.round(Number(evidence.stressSurvived ?? 0)));
  const stressTotal = Math.max(0, Math.round(Number(evidence.stressTotal ?? 0)));
  if (stressTotal > 0 && stressSurvived === 0) {
    flags.push({ flag: "stress-collapse", detail: `survived 0 of ${stressTotal} stress profiles` });
  } else if (oosWindows > 0 && oosWindows < (t.minOosWindows ?? 3)) {
    // Thin OOS coverage alone is not a cheat, but with any other flag it
    // strengthens the case for quarantine; report it as a soft flag only when
    // something else already fired.
    if (flags.length > 0) {
      flags.push({ flag: "single-window-dominance", detail: `only ${oosWindows} OOS window(s) evaluated` });
    }
  }

  const quarantineAt = Math.max(1, Math.round(t.quarantineFlags ?? 4));
  const watchAt = Math.max(1, Math.round(t.watchFlags ?? 2));
  const verdict =
    flags.length >= quarantineAt
      ? WATCHDOG_VERDICT.QUARANTINED
      : flags.length >= watchAt
        ? WATCHDOG_VERDICT.WATCH
        : WATCHDOG_VERDICT.NORMAL;

  return {
    verdict,
    flags,
    shares: {
      topMintShare: mint.share,
      topWindowShare: window.share,
      topRegimeShare: regime.share,
      topSeedShare: seed.share,
      singleTradeShare,
      missingDataShare,
      parameterSaturation: saturation.share,
    },
  };
}

function saturatedList(saturation) {
  return saturation.saturated.slice(0, 3).join(", ") || "none";
}

/** Compact persistence record for one candidate evaluation. */
export function watchdogRecord({ candidateId, family, evidence, result, at = null }) {
  return {
    schemaVersion: WATCHDOG_VERSION,
    evaluatedAt: at ?? new Date().toISOString(),
    candidateId,
    family: family ?? null,
    verdict: result.verdict,
    flags: result.flags,
    shares: result.shares,
    evidence: {
      trades: Math.max(0, Math.round(Number(evidence.trades ?? 0))),
      distinctMints: Math.max(0, Math.round(Number(evidence.distinctMints ?? 0))),
      costDrag: Number.isFinite(evidence.costDrag) ? evidence.costDrag : null,
      oosWindows: Math.max(0, Math.round(Number(evidence.oosWindows ?? 0))),
    },
    note: "Watchdog verdicts are research-layer labels. They never modify Arena gates.",
  };
}

/**
 * Quarantine policy:
 *   - QUARANTINED candidates may not be injected into a live population by the
 *     research layer, may not hold PROMISING/ARENA_SURVIVOR/SHADOW_ELIGIBLE
 *     memory status, and cannot become Deployment Candidates (that status is
 *     Arena-owned anyway — quarantine can only *add* restriction).
 *   - Clearance requires a later evaluation with fresh windows/seeds whose
 *     verdict is WATCH or NORMAL (see `clearQuarantine`).
 */
export function clearQuarantine(previous, latest) {
  if (!previous || previous.verdict !== WATCHDOG_VERDICT.QUARANTINED) return true;
  return latest?.verdict === WATCHDOG_VERDICT.NORMAL || latest?.verdict === WATCHDOG_VERDICT.WATCH;
}
