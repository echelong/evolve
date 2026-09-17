/**
 * Champion Arena — Phase 4 core.
 *
 * A tournament where evolved genomes compete across datasets, seeds, regimes
 * and stress profiles. Everything here is PAPER ONLY: evaluation reuses the
 * historical replay feed and the simulated fill engine, so there is no wallet,
 * no signing, no order, and no on-chain interaction anywhere in this file.
 *
 * Design rules:
 *   - deterministic: same inputs + seed => identical outputs (validated)
 *   - transparent: every score, gate, and classification is inspectable
 *   - honest: synthetic evidence is never counted as real-market evidence,
 *     insufficient evidence is reported as such, and no score claims to
 *     predict future profitability
 */

import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { digestOf, sha256Hex } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import {
  GENOME_KEYS,
  GENE_BOUNDS,
  SPECIES_PRESETS,
} from "../engine/genome.mjs";
import { loadChampionIndex } from "../engine/champions.mjs";

export const ARENA_SCHEMA_VERSION = 1;

export const DEFAULT_ARENA_DIR = path.join(".evolve", "arenas");
export const DEFAULT_DATASETS_DIR = path.join(".evolve", "history");
export const DEFAULT_REGIMES_DIR = path.join(".evolve", "regimes");
export const DEFAULT_SHADOW_DIR = path.join(".evolve", "shadow");
export const DEFAULT_HOF_DIR = path.join(".evolve", "hall-of-fame");
export const DEFAULT_ARENA_CACHE_DIR = path.join(".evolve", "arena-cache");

/** Results a candidate genome can hold at the end of an arena run. */
export const CANDIDATE_STATUS = Object.freeze({
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT EVIDENCE",
  ELIMINATED: "ELIMINATED",
  ARENA_SURVIVOR: "ARENA SURVIVOR",
  DEPLOYMENT_CANDIDATE: "DEPLOYMENT CANDIDATE",
  HALL_OF_FAME: "HALL OF FAME",
  UNQUALIFIED_SHADOW_TEST: "UNQUALIFIED SHADOW TEST",
  SHADOW_TESTING: "SHADOW TESTING",
  SHADOW_PROVISIONAL: "SHADOW PROVISIONAL",
  SHADOW_VALIDATED: "SHADOW VALIDATED",
});

/** Strategy type recorded per genome. */
export const STRATEGY_TYPE = Object.freeze({
  SPECIALIST: "specialist",
  GENERALIST: "generalist",
});

/** Arena stage labels, in tournament order. */
export const ARENA_STAGE = Object.freeze({
  QUALIFICATION: "QUALIFICATION",
  GROUP: "GROUP",
  STRESS: "STRESS",
  OOS: "OUT-OF-SAMPLE",
  CHAMPION_LEAGUE: "CHAMPION LEAGUE",
  DEPLOYMENT: "DEPLOYMENT CANDIDATES",
});

/** Shared directory helper. */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Round a number to 6 decimals; collapse non-finite values to 0. */
export function round6(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

/* ============================================================================
 * 1. Historical dataset registry
 * ==========================================================================*/

/**
 * Build a registry over every dataset under a history root.
 * Synthetic and mixed datasets are classified explicitly and are NEVER
 * aggregated into real-market evidence (see `registrySummary`).
 */
export async function buildDatasetRegistry(root = DEFAULT_DATASETS_DIR) {
  const { listDatasets, readManifest, fingerprintDataset } = await import("../history/dataset.mjs");
  const entries = await listDatasets(root);
  const registry = [];

  for (const entry of entries) {
    const manifest = entry.manifest ?? (await readManifest(entry.dir)) ?? {};
    let fingerprintCombined = manifest?.fingerprint?.combined ?? null;
    if (!fingerprintCombined) {
      const computed = await fingerprintDataset(entry.dir);
      fingerprintCombined = computed.combined ?? null;
    }

    const containsSynthetic = manifest.containsSynthetic === true;
    const usableForRealMarketReplay = manifest.usableForRealMarketReplay === true;

    // Classification mirrors the recorder's own labels; MIXED is treated as
    // contaminated (not real evidence) to stay on the safe side.
    let classification = "REAL";
    if (containsSynthetic) classification = usableForRealMarketReplay ? "MIXED" : "SYNTHETIC";
    else if (!usableForRealMarketReplay && manifest.dataClass) classification = "REAL";

    registry.push({
      datasetId: manifest.datasetId ?? entry.sessionId ?? path.basename(entry.dir),
      dir: entry.dir,
      fingerprint: fingerprintCombined,
      sourceType: classification,
      containsSynthetic,
      usableForRealMarketReplay,
      firstObservedAt: manifest.firstObservedAt ?? null,
      lastObservedAt: manifest.lastObservedAt ?? null,
      durationMs: manifest.durationMs ?? null,
      durationMinutes: Number.isFinite(manifest.durationMs) ? manifest.durationMs / 60_000 : null,
      snapshotCount: manifest.snapshotCount ?? null,
      uniqueMints: manifest.uniqueMintCount ?? null,
      observations: manifest.snapshotCount ?? null,
      status: manifest.status ?? "unknown",
      dataClass: manifest.dataClass ?? null,
      liveOnly: classification === "REAL",
      marketCharacteristics: manifest.marketCharacteristics ?? null,
    });
  }

  registry.sort((a, b) => String(a.datasetId).localeCompare(String(b.datasetId)));
  return registry;
}

/** Separate real and synthetic evidence. Synthetic never counts as real. */
export function registrySummary(registry) {
  const rows = Array.isArray(registry) ? registry : [];
  const real = rows.filter((entry) => entry.sourceType === "REAL");
  const synthetic = rows.filter((entry) => entry.sourceType === "SYNTHETIC");
  const mixed = rows.filter((entry) => entry.sourceType === "MIXED");

  const sumObs = (list) => list.reduce((sum, entry) => sum + (entry.observations ?? 0), 0);
  const sumMs = (list) => list.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);

  return {
    total: rows.length,
    real: {
      count: real.length,
      observations: sumObs(real),
      durationMs: sumMs(real),
      realDataHours: round6(sumMs(real) / 3_600_000),
      datasetIds: real.map((entry) => entry.datasetId),
    },
    synthetic: {
      count: synthetic.length,
      observations: sumObs(synthetic),
      durationMs: sumMs(synthetic),
      syntheticDataHours: round6(sumMs(synthetic) / 3_600_000),
      datasetIds: synthetic.map((entry) => entry.datasetId),
    },
    mixed: {
      count: mixed.length,
      observations: sumObs(mixed),
      durationMs: sumMs(mixed),
      datasetIds: mixed.map((entry) => entry.datasetId),
    },
    note:
      "Synthetic and mixed datasets are development/stress evidence only. They are never aggregated into real Solana evidence counts.",
  };
}

/**
 * Datasets eligible for a real-market arena claim. Only datasets the recorder
 * itself classified `live-only` and `usableForRealMarketReplay: true` count.
 */
export function realEvidenceDatasets(registry) {
  return (Array.isArray(registry) ? registry : []).filter(
    (entry) => entry.sourceType === "REAL" && entry.usableForRealMarketReplay === true,
  );
}

/* ============================================================================
 * 2. Market regime classifier
 * ==========================================================================*/

export const REGIMES = [
  "strong-risk-on",
  "weak-risk-on",
  "sideways-chop",
  "high-volatility",
  "liquidity-expansion",
  "liquidity-contraction",
  "broad-selloff",
  "launch-heavy",
  "low-activity",
];

/**
 * Compute transparent per-window metrics from the snapshots of one period.
 *
 * Every input is an observation that already happened inside the evaluated
 * period. Returns are formed only against a *previous* observation of the same
 * mint, so there is no future leak by construction. Deterministic: medians are
 * order-independent; the token-order inside a snapshot does not matter.
 */
export function computeRegimeMetrics(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return emptyRegimeMetrics("no snapshots");
  }

  const returns = [];
  const liquidityBySnapshot = [];
  const volumeBySnapshot = [];
  const buySell = [];
  const organic = [];
  const poolAges = [];
  const mints = new Set();
  let activityTotal = 0;
  let snapshotCount = 0;

  // Per-mint last price; updated strictly in stream order.
  const prevPriceByMint = new Map();
  let liquiditySumAll = 0;
  let liquiditySamples = 0;

  for (const snapshot of snapshots) {
    const markets = Array.isArray(snapshot?.markets) ? snapshot.markets : [];
    if (markets.length === 0) continue;

    let snapLiquidity = 0;
    let snapVolume = 0;
    let seen = 0;

    for (const market of markets) {
      if (!market?.mint) continue;
      mints.add(market.mint);
      seen += 1;

      const price = Number(market.price);
      if (Number.isFinite(price) && price > 0) {
        const prev = prevPriceByMint.get(market.mint);
        if (Number.isFinite(prev) && prev > 0) {
          returns.push((price - prev) / prev);
        }
        prevPriceByMint.set(market.mint, price);
      }

      const liquidity = Number(market.liquidity);
      if (Number.isFinite(liquidity) && liquidity > 0) {
        snapLiquidity += liquidity;
        liquiditySumAll += liquidity;
        liquiditySamples += 1;
      }

      const volume = Number(market.volume5m ?? market.volume);
      if (Number.isFinite(volume) && volume > 0) snapVolume += volume;

      const bs = Number(market.buySellRatio ?? market.buyPressure);
      if (Number.isFinite(bs)) buySell.push(bs);

      const organicBs = Number(market.organicBuySellRatio ?? market.organicScore);
      if (Number.isFinite(organicBs)) organic.push(organicBs);

      const age = Number(market.poolAgeMs);
      if (Number.isFinite(age) && age >= 0) poolAges.push(age);
    }

    if (seen > 0) {
      snapshotCount += 1;
      activityTotal += seen;
      liquidityBySnapshot.push(snapLiquidity / seen);
      volumeBySnapshot.push(snapVolume / seen);
    }
  }

  if (returns.length === 0) {
    return emptyRegimeMetrics("no return observations");
  }

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const medianReturn = sortedReturns[Math.floor(sortedReturns.length / 2)];
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const dispersion = Math.sqrt(
    returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length,
  );

  const positiveRatio = returns.filter((r) => r > 0).length / returns.length;

  const firstLiquidity = liquidityBySnapshot[0] ?? 0;
  const lastLiquidity = liquidityBySnapshot[liquidityBySnapshot.length - 1] ?? 0;
  const liquidityChange =
    liquidityBySnapshot.length >= 2 && Math.abs(firstLiquidity) > 1e-9
      ? (lastLiquidity - firstLiquidity) / Math.abs(firstLiquidity)
      : 0;

  const firstVolume = volumeBySnapshot[0] ?? 0;
  const lastVolume = volumeBySnapshot[volumeBySnapshot.length - 1] ?? 0;
  const volumeChange =
    volumeBySnapshot.length >= 2 && Math.abs(firstVolume) > 1e-9
      ? (lastVolume - firstVolume) / Math.abs(firstVolume)
      : 0;

  const meanOf = (values) =>
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  const metrics = {
    medianReturn: round6(medianReturn),
    meanReturn: round6(meanReturn),
    dispersion: round6(dispersion),
    liquidityChange: round6(liquidityChange),
    volumeChange: round6(volumeChange),
    positiveRatio: round6(positiveRatio),
    buySellRatio: round6(meanOf(buySell)),
    organicRatio: round6(meanOf(organic)),
    activeTokens: mints.size,
    launchHeavyRatio:
      poolAges.length > 0
        ? round6(poolAges.filter((age) => age < 3_600_000).length / poolAges.length)
        : 0,
    activityPerSnapshot: snapshotCount > 0 ? round6(activityTotal / snapshotCount) : 0,
    meanLiquidityUsd: liquiditySamples > 0 ? round6(liquiditySumAll / liquiditySamples) : 0,
    returnCount: returns.length,
    snapshots: snapshotCount,
  };

  return { ok: true, reason: null, metrics };
}

function emptyRegimeMetrics(reason) {
  return {
    ok: false,
    reason,
    metrics: {
      medianReturn: 0,
      meanReturn: 0,
      dispersion: 0,
      liquidityChange: 0,
      volumeChange: 0,
      positiveRatio: 0.5,
      buySellRatio: 1,
      organicRatio: 1,
      activeTokens: 0,
      launchHeavyRatio: 0,
      activityPerSnapshot: 0,
      meanLiquidityUsd: 0,
      returnCount: 0,
      snapshots: 0,
    },
  };
}

/**
 * Deterministic rule-based classification from metrics.
 * Rules are ordered; the first match wins, so the result is stable and
 * inspectable (the matched rule is reported as the reason).
 */
export function classifyRegimeFromMetrics(m) {
  if (!m || !Number.isFinite(m.returnCount) || m.returnCount === 0) {
    return {
      regime: "unknown",
      confidence: 0,
      metrics: m ?? {},
      reason: "no return observations",
    };
  }

  // Order matters: most specific/most consequential first.
  const rules = [
    { regime: "broad-selloff", when: () => m.medianReturn < -0.01 && m.positiveRatio < 0.45 },
    {
      regime: "strong-risk-on",
      when: () => m.medianReturn > 0.015 && m.positiveRatio > 0.58,
    },
    {
      regime: "weak-risk-on",
      when: () => m.medianReturn > 0.004 && m.medianReturn <= 0.015 && m.positiveRatio > 0.5,
    },
    { regime: "high-volatility", when: () => m.dispersion > 0.08 },
    {
      regime: "liquidity-expansion",
      when: () => m.liquidityChange > 0.12,
    },
    {
      regime: "liquidity-contraction",
      when: () => m.liquidityChange < -0.08,
    },
    { regime: "launch-heavy", when: () => m.launchHeavyRatio > 0.12 },
    { regime: "low-activity", when: () => m.activityPerSnapshot < 3 },
    {
      regime: "sideways-chop",
      when: () => Math.abs(m.medianReturn) <= 0.004,
    },
  ];

  for (const rule of rules) {
    if (rule.when()) {
      return {
        regime: rule.regime,
        confidence: 0.9,
        metrics: m,
        reason: `matched rule: ${rule.regime}`,
      };
    }
  }

  return {
    regime: "sideways-chop",
    confidence: 0.5,
    metrics: m,
    reason: "no rule matched; defaulted to sideways-chop",
  };
}

/** Classify the regime of one set of snapshots (e.g. one replay window). */
export function classifyWindowRegime(snapshots) {
  const { metrics } = computeRegimeMetrics(snapshots);
  return classifyRegimeFromMetrics(metrics);
}

/**
 * Precompute regimes for every dataset window from its snapshots.
 *
 * Each window is classified independently from the snapshots inside its own
 * TEST interval (the same interval an OOS run is scored on) — never data from
 * outside that window, and never data past the window's end, so
 * classifications carry no future information. Windows are queried directly
 * by timestamp range rather than accumulated from a single forward-only
 * stream cursor: walk-forward windows overlap by design (train periods
 * re-cover earlier test periods), and a cursor that only ever advances would
 * silently drop the overlapping portion of a later window's own range.
 */
export async function buildRegimeMap(datasetDir, windows) {
  const { openDataset } = await import("../history/dataset.mjs");
  const dataset = await openDataset(datasetDir, { requireManifest: false });
  const out = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const buffer = [];
    for await (const snapshot of dataset.snapshots({ from: window.test.start, until: window.test.end })) {
      buffer.push({ ...snapshot, markets: snapshot.markets ?? [] });
    }
    const result = classifyWindowRegime(buffer);
    out.push({
      window: window?.label ?? `W${index + 1}`,
      windowIndex: index,
      start: window?.test?.start ?? null,
      end: window?.test?.end ?? null,
      ...result,
      snapshotCount: buffer.length,
    });
  }

  return out;
}

/* ============================================================================
 * 3. Stress engine
 * ==========================================================================*/

/**
 * Deterministic stress profiles.
 *
 * Stress modifies EXECUTION CONDITIONS only (fees, slippage, position caps,
 * observation delay, snapshot dropout, liquidity haircuts). Historical prices
 * are never modified: a stressed replay sees exactly the same observations as
 * the unstressed one.
 */
export const STRESS_PROFILES = Object.freeze({
  none: Object.freeze({
    id: "none",
    feeMultiplier: 1,
    slippageMultiplier: 1,
    adverseBufferBps: 0,
    observationDelaySec: 0,
    missingSnapshotPct: 0,
    stalePeriodSec: 0,
    liquidityHaircutPct: 0,
    positionCapMultiplier: 1,
    extreme: false,
  }),
  mild: Object.freeze({
    id: "mild",
    feeMultiplier: 1.5,
    slippageMultiplier: 2,
    adverseBufferBps: 5,
    observationDelaySec: 2,
    missingSnapshotPct: 0.01,
    stalePeriodSec: 5,
    liquidityHaircutPct: 25,
    positionCapMultiplier: 0.8,
    extreme: false,
  }),
  moderate: Object.freeze({
    id: "moderate",
    feeMultiplier: 2,
    slippageMultiplier: 3,
    adverseBufferBps: 10,
    observationDelaySec: 5,
    missingSnapshotPct: 0.05,
    stalePeriodSec: 15,
    liquidityHaircutPct: 50,
    positionCapMultiplier: 0.6,
    extreme: false,
  }),
  severe: Object.freeze({
    id: "severe",
    feeMultiplier: 3,
    slippageMultiplier: 4,
    adverseBufferBps: 20,
    observationDelaySec: 15,
    missingSnapshotPct: 0.1,
    stalePeriodSec: 30,
    liquidityHaircutPct: 75,
    positionCapMultiplier: 0.4,
    extreme: false,
  }),
  extreme: Object.freeze({
    id: "extreme",
    feeMultiplier: 5,
    slippageMultiplier: 5,
    adverseBufferBps: 30,
    observationDelaySec: 30,
    missingSnapshotPct: 0.2,
    stalePeriodSec: 60,
    liquidityHaircutPct: 90,
    positionCapMultiplier: 0.2,
    extreme: true,
  }),
});

export function getStressProfile(name) {
  return STRESS_PROFILES[String(name)] ?? STRESS_PROFILES.none;
}

export const STRESS_PROFILE_IDS = Object.freeze(Object.keys(STRESS_PROFILES));

/** Apply a stress profile on top of the base paper friction config. */
export function applyStressToPaper(basePaper, profile) {
  if (!profile || profile.id === "none") return { ...basePaper };
  return {
    ...basePaper,
    baseFeeBps: Math.round((basePaper.baseFeeBps ?? 10) * profile.feeMultiplier),
    minSlippageBps: Math.round((basePaper.minSlippageBps ?? 20) * profile.slippageMultiplier),
    slippageCapBps: Math.round((basePaper.slippageCapBps ?? 400) * profile.slippageMultiplier),
    adverseBufferBps: Math.round((basePaper.adverseBufferBps ?? 8) + profile.adverseBufferBps),
    maxPositionFraction: Math.max(
      0.001,
      (basePaper.maxPositionFraction ?? 0.28) * profile.positionCapMultiplier,
    ),
    maxLiquidityFraction: Math.max(
      0.00001,
      (basePaper.maxLiquidityFraction ?? 0.02) * (1 - profile.liquidityHaircutPct / 100),
    ),
  };
}

/** Compact fingerprint of a stress profile for cache keys. */
export function stressProfileKey(profile) {
  const p = profile ?? STRESS_PROFILES.none;
  return [
    p.id,
    p.feeMultiplier,
    p.slippageMultiplier,
    p.adverseBufferBps,
    p.observationDelaySec,
    p.missingSnapshotPct,
    p.stalePeriodSec,
    p.liquidityHaircutPct,
    p.positionCapMultiplier,
  ].join(":");
}

/** Deterministic fractional dropout of snapshots for missing-snapshot stress. */
export function shouldDropSnapshot(snapshotIndex, missingPct, seed) {
  if (!Number.isFinite(missingPct) || missingPct <= 0) return false;
  const random = createSeededRandom(`${seed}:drop:${snapshotIndex}`);
  return random() < missingPct;
}

/** Deterministic delay applied to observation availability (never future info). */
export function observationDelaySec(profile) {
  return Number.isFinite(profile?.observationDelaySec) ? profile.observationDelaySec : 0;
}

/**
 * Token disappearance handling.
 *
 * Deterministically selects a fraction of mints per window that "disappear"
 * partway through replay. A disappeared token:
 *   - receives no NEW entries after its disappearance point
 *   - existing positions retain their last defensible observed mark
 *   - the engine's existing no-fabrication policy applies (never a future price)
 */
export function buildTokenFailurePlan(windowMints, { seed, failureRate = 0.05 } = {}) {
  const random = createSeededRandom(`${seed}:token-failure`);
  const plan = [];

  const entries = Array.isArray(windowMints) ? windowMints : [];
  for (const entry of entries) {
    const mints = Array.isArray(entry?.mints) ? [...entry.mints] : [];
    // Deterministic shuffle (Fisher-Yates with the seeded generator).
    for (let i = mints.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [mints[i], mints[j]] = [mints[j], mints[i]];
    }
    const count = Math.max(0, Math.floor(mints.length * failureRate));
    for (const mint of mints.slice(0, count)) {
      plan.push({
        mint,
        windowLabel: entry?.label ?? null,
        policy: "LAST_OBSERVATION_THEN_FORCED_CLOSE",
        noNewEntriesAfterDisappearance: true,
        noFabricatedPrice: true,
      });
    }
  }

  return plan;
}

/* ============================================================================
 * 4. Arena Score
 * ==========================================================================*/

export const ARENA_SCORE_VERSION = 1;

export const ARENA_SCORE_DEFAULTS = Object.freeze({
  medianOOSWeight: 0.2,
  worstPeriodWeight: 0.15,
  drawdownWeight: 0.15,
  stressSurvivalWeight: 0.15,
  regimeBreadthWeight: 0.1,
  seedConsistencyWeight: 0.1,
  tokenBreadthWeight: 0.05,
  concentrationPenaltyWeight: 0.05,
  costSensitivityWeight: 0.03,
  catastrophicPenaltyWeight: 0.02,
  // Implicit weight: total is normalized, so evidence contributes too.
  evidenceStrengthWeight: 0.05,
  returnScale: 0.3,
  drawdownScale: 0.4,
  tokenBreadthTarget: 50,
});

export const ARENA_SCORE_FORMULA =
  "ArenaScore = 100 * weighted mean of: medianOOS tanh(netReturn/scale), worstPeriod tanh(worst/scale), drawdown (1-DD/scale), stressSurvival (survived/total), regimeBreadth (positive regimes/known), seedConsistency (1-std/scale), tokenBreadth log-scaled distinct mints, concentration (1-topMintShare), costSensitivity (1-loss-under-2x-friction), catastrophic (0 if any blow-up), evidence (trades+mints+windows coverage)";

export const ARENA_SCORE_NOTE =
  "Arena Score is a robustness heuristic over PAPER results. It does NOT predict future profitability.";

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/**
 * Transparent multi-component score. Never just total return:
 * penalises one-lucky-trade, one-token, one-period, one-seed dependence,
 * catastrophic drawdown, and collapse under mild friction.
 */
export function computeArenaScore(components, options = {}) {
  const o = { ...ARENA_SCORE_DEFAULTS, ...options };

  const tanh01 = (v) => (Math.tanh((Number.isFinite(v) ? v : 0) / o.returnScale) + 1) / 2;

  const c = {
    medianOOSReturn: Number.isFinite(components?.medianOOSReturn) ? components.medianOOSReturn : 0,
    worstOOSReturn: Number.isFinite(components?.worstOOSReturn) ? components.worstOOSReturn : 0,
    maxDrawdown: clamp01(components?.maxDrawdown ?? 1),
    stressSurvived: Math.max(0, components?.stressSurvived ?? 0),
    stressTotal: Math.max(1, components?.stressTotal ?? 1),
    regimePositive: Math.max(0, components?.regimePositive ?? 0),
    regimeRuns: Math.max(0, components?.regimeRuns ?? 0),
    seedReturns: Array.isArray(components?.seedReturns) ? components.seedReturns : [],
    distinctMints: Math.max(0, components?.distinctMints ?? 0),
    topMintShare: clamp01(components?.topMintShare ?? 0),
    baseNetReturn: Number.isFinite(components?.baseNetReturn) ? components.baseNetReturn : 0,
    stressedNetReturn: Number.isFinite(components?.stressedNetReturn)
      ? components.stressedNetReturn
      : components?.baseNetReturn ?? 0,
    catastrophicEvents: Math.max(0, Math.round(components?.catastrophicEvents ?? 0)),
    trades: Math.max(0, components?.trades ?? 0),
    oosWindows: Math.max(0, components?.oosWindows ?? 0),
  };

  const s = {
    medianOOS: tanh01(c.medianOOSReturn),
    worstPeriod: tanh01(c.worstOOSReturn),
    drawdown: clamp01(1 - c.maxDrawdown / o.drawdownScale),
    stressSurvival: c.stressSurvived / c.stressTotal,
    regimeBreadth: c.regimeRuns > 0 ? c.regimePositive / c.regimeRuns : 0.5,
    tokenBreadth: clamp01(
      Math.log(1 + c.distinctMints) / Math.log(1 + o.tokenBreadthTarget),
    ),
    concentration: clamp01(1 - c.topMintShare),
    costSensitivity: clamp01(
      1 - Math.max(0, c.baseNetReturn - c.stressedNetReturn) / o.returnScale,
    ),
    catastrophic: c.catastrophicEvents > 0 ? 0 : 1,
  };

  let consistency = 0.5;
  if (c.seedReturns.length >= 2) {
    const mean = c.seedReturns.reduce((a, b) => a + b, 0) / c.seedReturns.length;
    const variance =
      c.seedReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / c.seedReturns.length;
    const std = Math.sqrt(Math.max(0, variance));
    consistency = clamp01(1 - std / o.returnScale);
  }
  s.seedConsistency = consistency;

  // Evidence strength: three equally-weighted coverage terms.
  s.evidence = clamp01(
    (clamp01(c.trades / 40) + clamp01(c.distinctMints / 12) + clamp01(c.oosWindows / 4)) / 3,
  );

  const weighted =
    o.medianOOSWeight * s.medianOOS +
    o.worstPeriodWeight * s.worstPeriod +
    o.drawdownWeight * s.drawdown +
    o.stressSurvivalWeight * s.stressSurvival +
    o.regimeBreadthWeight * s.regimeBreadth +
    o.seedConsistencyWeight * s.seedConsistency +
    o.tokenBreadthWeight * s.tokenBreadth +
    o.concentrationPenaltyWeight * s.concentration +
    o.costSensitivityWeight * s.costSensitivity +
    o.catastrophicPenaltyWeight * s.catastrophic +
    o.evidenceStrengthWeight * s.evidence;

  const totalWeight =
    o.medianOOSWeight +
    o.worstPeriodWeight +
    o.drawdownWeight +
    o.stressSurvivalWeight +
    o.regimeBreadthWeight +
    o.seedConsistencyWeight +
    o.tokenBreadthWeight +
    o.concentrationPenaltyWeight +
    o.costSensitivityWeight +
    o.catastrophicPenaltyWeight +
    o.evidenceStrengthWeight;

  const score = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0;

  return {
    version: ARENA_SCORE_VERSION,
    score: round6(Math.min(100, Math.max(0, score))),
    components: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round6(v)])),
    raw: c,
    weights: { ...o },
    formula: ARENA_SCORE_FORMULA,
    note: ARENA_SCORE_NOTE,
  };
}

/* ============================================================================
 * 5. Survival gates / deployment candidates
 * ==========================================================================*/

export const DEFAULT_DEPLOYMENT_GATES = Object.freeze({
  minTrades: 20,
  minDistinctMints: 4,
  minRealDatasets: 1,
  minOosWindows: 2,
  minSeeds: 2,
  minStressSurvived: 1,
  maxDrawdown: 0.5,
  maxTopMintShare: 0.5,
  minArenaScore: 50,
  requireMildStressSurvival: true,
  requireNoCatastrophic: true,
});

/**
 * Evaluate every deployment gate for one candidate.
 *
 * Status precedence:
 *   INSUFFICIENT EVIDENCE  -> ELIMINATED -> ARENA SURVIVOR -> DEPLOYMENT CANDIDATE
 *
 * A passing result means "survived the arena's paper gauntlet"; it is never a
 * claim of profitability or safety.
 */
export function evaluateSurvivalGates({
  arenaScore,
  components,
  config = {},
  realDatasetsUsed = 0,
  stressSurvivalByProfile = null,
  strategyType = STRATEGY_TYPE.GENERALIST,
}) {
  const o = { ...DEFAULT_DEPLOYMENT_GATES, ...config };
  const gates = [];
  const push = (label, pass, detail) =>
    gates.push({ label, pass: Boolean(pass), detail: String(detail) });

  const trades = Math.max(0, components?.trades ?? 0);
  const distinctMints = Math.max(0, components?.distinctMints ?? 0);
  const oosWindows = Math.max(0, components?.oosWindows ?? 0);
  const seeds = Math.max(0, components?.seeds ?? 0);
  const maxDrawdown = clamp01(components?.maxDrawdown ?? 1);
  const topMintShare = clamp01(components?.topMintShare ?? 0);
  const catastrophicEvents = Math.max(0, Math.round(components?.catastrophicEvents ?? 0));
  const stressSurvived = Math.max(0, components?.stressSurvived ?? 0);
  const stressTotal = Math.max(0, components?.stressTotal ?? 0);

  push("score at or above minimum", (arenaScore ?? 0) >= o.minArenaScore, `score ${round6(arenaScore ?? 0)} vs min ${o.minArenaScore}`);
  push("minimum total trades", trades >= o.minTrades, `trades ${trades} vs min ${o.minTrades}`);
  push("minimum distinct mints", distinctMints >= o.minDistinctMints, `mints ${distinctMints} vs min ${o.minDistinctMints}`);
  push("genuine live-market datasets", realDatasetsUsed >= o.minRealDatasets, `real datasets ${realDatasetsUsed} vs min ${o.minRealDatasets}`);
  push("out-of-sample windows", oosWindows >= o.minOosWindows, `OOS windows ${oosWindows} vs min ${o.minOosWindows}`);
  push("independent seeds", seeds >= o.minSeeds, `seeds ${seeds} vs min ${o.minSeeds}`);
  push("stress profiles survived", stressSurvived >= o.minStressSurvived, `stress ${stressSurvived}/${stressTotal}`);
  push("acceptable maximum drawdown", maxDrawdown <= o.maxDrawdown, `DD ${(maxDrawdown * 100).toFixed(1)}% vs max ${(o.maxDrawdown * 100).toFixed(1)}%`);
  push("reasonable concentration", topMintShare <= o.maxTopMintShare, `top mint share ${(topMintShare * 100).toFixed(1)}% vs max ${(o.maxTopMintShare * 100).toFixed(1)}%`);

  if (o.requireNoCatastrophic) {
    push("no catastrophic failures", catastrophicEvents === 0, `catastrophic events ${catastrophicEvents}`);
  }
  if (o.requireMildStressSurvival && stressSurvivalByProfile) {
    push("survives mild stress", stressSurvivalByProfile.mild?.survived === true, `mild stress ${stressSurvivalByProfile.mild?.survived === true ? "survived" : "failed"}`);
  }

  // Deployment consideration requires the generalist track: a specialist may
  // still be an Arena Survivor, but must additionally prove regime breadth.
  const failed = gates.filter((gate) => !gate.pass);
  const sufficientEvidence = (components?.evidenceInsufficient ?? false) !== true;

  let status;
  let reason;
  if (!sufficientEvidence) {
    status = CANDIDATE_STATUS.INSUFFICIENT_EVIDENCE;
    reason = "did not meet minimum evidence gates (trades/mints/observations)";
  } else if (failed.length > 0) {
    status = CANDIDATE_STATUS.ELIMINATED;
    reason = failed.map((gate) => gate.label).join(", ");
  } else if (strategyType === STRATEGY_TYPE.SPECIALIST) {
    status = CANDIDATE_STATUS.ARENA_SURVIVOR;
    reason = "specialist: additional regime-breadth validation required before deployment consideration";
  } else {
    status = CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE;
    reason = "passed all configured deployment gates (PAPER ONLY — not a profitability or safety claim)";
  }

  return {
    status,
    reason,
    gates,
    passed: gates.length - failed.length,
    failed: failed.length,
    total: gates.length,
  };
}

/* ============================================================================
 * 5b. Arena result composition
 * ==========================================================================*/

/**
 * Aggregate one candidate's evaluation runs into Arena Score components.
 *
 * Aggregates median/worst OOS return across all (dataset, seed, window) runs,
 * per-regime performance, stress survival, concentration, and evidence counts.
 * Pure: no I/O, no clock, no RNG.
 */
export function aggregateCandidateEvaluation({
  digest,
  species,
  evaluations,
  regimesByDataset = {},
  stressProfiles = ["mild", "moderate"],
  components: overrides = {},
}) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const oosRuns = rows.flatMap((evaluation) => evaluation?.oosRuns ?? []);
  const stressRuns = rows.flatMap((evaluation) => evaluation?.stressRuns ?? []);

  const usableOos = oosRuns.filter(
    (run) => run?.metrics && Number.isFinite(run.metrics.netReturn),
  );
  const netReturns = usableOos.map((run) => run.metrics.netReturn).sort((a, b) => a - b);
  const medianOOSReturn =
    netReturns.length > 0 ? netReturns[Math.floor(netReturns.length / 2)] : 0;
  const worstOOSReturn = netReturns.length > 0 ? netReturns[0] : 0;

  let trades = 0;
  let costs = 0;
  let observations = 0;
  let maxDrawdown = 0;
  let catastrophicEvents = 0;
  let distinctMintsCount = 0;

  for (const run of usableOos) {
    const metrics = run.metrics;
    trades += metrics.trades ?? 0;
    costs += metrics.costs ?? 0;
    observations += metrics.observations ?? 0;
    maxDrawdown = Math.max(maxDrawdown, metrics.maxDrawdown ?? 0);
    distinctMintsCount = Math.max(distinctMintsCount, metrics.distinctMints ?? 0);
    if (metrics.robustnessDetail?.catastrophic === true) catastrophicEvents += 1;
  }

  // Stress survival: a profile is "survived" when no run under it is
  // catastrophic and its median return holds within 50% of the base median.
  const stressSurvival = {};
  const baseMedian = medianOOSReturn;
  for (const profile of stressProfiles) {
    if (profile === "none") continue;
    const runs = stressRuns.filter((run) => run.profile === profile && run?.metrics);
    if (runs.length === 0) {
      stressSurvival[profile] = {
        survived: false,
        reason: "not evaluated",
        medianNetReturn: null,
        catastrophic: false,
      };
      continue;
    }
    const stressedReturns = runs
      .map((run) => run.metrics.netReturn)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const median =
      stressedReturns.length > 0
        ? stressedReturns[Math.floor(stressedReturns.length / 2)]
        : 0;
    const catastrophic = runs.some(
      (run) => run.metrics.robustnessDetail?.catastrophic === true,
    );
    const survived = !catastrophic && median > Math.min(0, baseMedian * 0.5) - 0.05;
    stressSurvival[profile] = {
      survived,
      medianNetReturn: round6(median),
      catastrophic,
    };
  }

  const stressProfilesEvaluated = Object.keys(stressSurvival);
  const stressSurvived = stressProfilesEvaluated.filter(
    (profile) => stressSurvival[profile].survived,
  ).length;
  const stressTotal = stressProfilesEvaluated.length;

  // Regime mapping: OOS run -> window -> regime label for that dataset window.
  // Looked up per RUN (not per wrapping evaluation object): the tournament
  // runner flattens every dataset's runs into one array per candidate before
  // this function ever sees them, so `evaluation.datasetDir` alone is not
  // reliable — each run carries its own `datasetDir` (set in evaluator.mjs)
  // precisely so this lookup still works after flattening.
  const regimeMap = {};
  for (const evaluation of rows) {
    for (const run of evaluation?.oosRuns ?? []) {
      const regimes = regimesByDataset[run.datasetDir ?? evaluation?.datasetDir] ?? {};
      const regime = regimes[run.window]?.regime ?? "unknown";
      if (!regimeMap[regime]) regimeMap[regime] = { regime, runs: 0, netReturns: [] };
      regimeMap[regime].runs += 1;
      if (Number.isFinite(run.metrics?.netReturn)) {
        regimeMap[regime].netReturns.push(run.metrics.netReturn);
      }
    }
  }

  const regimePerformance = {};
  for (const [regime, entry] of Object.entries(regimeMap)) {
    const returns = [...entry.netReturns].sort((a, b) => a - b);
    regimePerformance[regime] = {
      regime,
      runs: entry.runs,
      medianNetReturn:
        returns.length > 0 ? round6(returns[Math.floor(returns.length / 2)]) : null,
      worstNetReturn: returns.length > 0 ? round6(returns[0]) : null,
    };
  }
  const regimePositive = Object.values(regimePerformance).filter(
    (row) => (row.medianNetReturn ?? 0) > 0,
  ).length;
  const regimeRuns = Object.keys(regimePerformance).length;

  // Seed consistency: per-seed mean returns feed the score's std term.
  const bySeed = new Map();
  for (const run of usableOos) {
    if (!bySeed.has(run.seed)) bySeed.set(run.seed, []);
    bySeed.get(run.seed).push(run.metrics.netReturn);
  }
  const seedReturns = [...bySeed.values()].map(
    (runs) => runs.reduce((a, b) => a + b, 0) / runs.length,
  );

  // Concentration: aggregate share of total executed paper notional
  // attributable to the single most-traded mint, pooled by mint across every
  // OOS and stress run in this candidate's full evaluated evidence set (not
  // the max of independent per-run shares, which saturates to 1.0 the moment
  // any single run happens to trade only one mint). Bounded 0..1; 0 when
  // there is no notional evidence at all; 1 only when every dollar of
  // evidence traded through one mint.
  const evidenceRuns = [...usableOos, ...stressRuns.filter((run) => run?.metrics)];
  const pooledMintNotional = new Map();
  let pooledTotalNotional = 0;
  for (const run of evidenceRuns) {
    const byMint = run.metrics?.mintNotional;
    if (!byMint || typeof byMint !== "object") continue;
    for (const [mint, notional] of Object.entries(byMint)) {
      const value = Number.isFinite(notional) ? Math.max(0, notional) : 0;
      pooledMintNotional.set(mint, (pooledMintNotional.get(mint) ?? 0) + value);
      pooledTotalNotional += value;
    }
  }
  const maxPooledMintNotional =
    pooledMintNotional.size > 0 ? Math.max(...pooledMintNotional.values()) : 0;
  const topMintShare =
    pooledTotalNotional > 0 ? clamp01(maxPooledMintNotional / pooledTotalNotional) : 0;

  const components = {
    medianOOSReturn: round6(medianOOSReturn),
    worstOOSReturn: round6(worstOOSReturn),
    maxDrawdown: round6(maxDrawdown),
    stressSurvived,
    stressTotal,
    regimePositive,
    regimeRuns,
    seedReturns,
    distinctMints: distinctMintsCount,
    topMintShare: round6(topMintShare),
    baseNetReturn: round6(medianOOSReturn),
    stressedNetReturn: round6(
      stressRuns.find((run) => run.profile === "mild")?.metrics?.netReturn ?? medianOOSReturn,
    ),
    catastrophicEvents,
    trades,
    oosWindows: new Set(usableOos.map((run) => `${run.seed}:${run.window}`)).size,
    observations,
    costs: round6(costs),
    seeds: bySeed.size,
    ...overrides,
  };

  return { digest, species: species ?? null, components, regimePerformance, stressSurvival };
}

/**
 * Compose the full arena result for one candidate: aggregate evaluation runs,
 * compute the Arena Score, classify specialist/generalist, and evaluate all
 * survival gates. This is the single entry point used by the tournament.
 */
export function aggregateArenaResult({
  digest,
  species,
  origin = "evolved",
  evaluations,
  regimesByDataset = {},
  stressProfiles = ["mild", "moderate"],
  realDatasetsUsed = 0,
  gatesConfig = {},
  scoreOptions = {},
}) {
  const aggregate = aggregateCandidateEvaluation({
    digest,
    species,
    evaluations,
    regimesByDataset,
    stressProfiles,
  });

  const arenaScore = computeArenaScore(aggregate.components, scoreOptions);
  const strategyType = classifyStrategyType(aggregate.regimePerformance);
  const gates = evaluateSurvivalGates({
    arenaScore: arenaScore.score,
    components: aggregate.components,
    config: gatesConfig,
    realDatasetsUsed,
    stressSurvivalByProfile: aggregate.stressSurvival,
    strategyType,
  });

  return {
    digest,
    species: species ?? null,
    origin,
    strategyType,
    components: aggregate.components,
    regimePerformance: aggregate.regimePerformance,
    stressSurvival: aggregate.stressSurvival,
    arenaScore,
    status: gates.status,
    reason: gates.reason,
    gates: gates.gates,
    gateCounts: { passed: gates.passed, failed: gates.failed, total: gates.total },
  };
}

/* ============================================================================
 * 6. Specialists vs generalists
 * ==========================================================================*/

/**
 * Classify strategy type from regime coverage.
 * A specialist targets one or a few regimes; a generalist survives across
 * broader conditions. Neither is declared superior — regime performance is
 * reported per regime and the caller decides.
 */
export function classifyStrategyType(regimePerformance, { minPositiveRegimes = 3 } = {}) {
  const rows = Object.values(regimePerformance ?? {}).filter((row) => row && row.runs > 0);
  if (rows.length === 0) return STRATEGY_TYPE.GENERALIST;
  const positive = rows.filter((row) => (row.medianNetReturn ?? 0) > 0).length;
  return positive >= minPositiveRegimes ? STRATEGY_TYPE.GENERALIST : STRATEGY_TYPE.SPECIALIST;
}

/* ============================================================================
 * 7. Hall of Fame
 * ==========================================================================*/

/**
 * Load prior champions for re-entry. Champions are NOT protected: they re-enter
 * future arenas, defend status, and can be eliminated like anyone else.
 */
export async function loadChampionCandidates(championsDir = path.join(".evolve", "champions")) {
  let index;
  try {
    index = await loadChampionIndex({ dir: championsDir });
  } catch {
    return [];
  }
  const champs = Array.isArray(index?.champions) ? index.champions : [];

  const byDigest = new Map();
  for (const champ of champs) {
    if (!champ?.genomeDigest || !champ?.genome) continue;
    const existing = byDigest.get(champ.genomeDigest);
    if (!existing || String(champ.createdAt ?? "") > String(existing.createdAt ?? "")) {
      byDigest.set(champ.genomeDigest, champ);
    }
  }

  return [...byDigest.values()].map((entry) => ({
    digest: entry.genomeDigest,
    genome: entry.genome,
    species: entry.species ?? "Champion",
    origin: "champion",
    arenaAppearances: entry.arenaAppearances ?? 0,
    titleDefenses: entry.titleDefenses ?? 0,
    eliminations: entry.eliminations ?? 0,
    bestArenaScore: entry.bestArenaScore ?? null,
    latestArenaScore: entry.latestArenaScore ?? null,
  }));
}

/** Merge arena outcomes into the Hall of Fame record for a digest. */
export function mergeHallOfFameRecord(existing, outcome) {
  const base = existing ?? {
    digest: outcome.digest,
    genome: outcome.genome ?? null,
    species: outcome.species ?? null,
    strategyType: outcome.strategyType ?? STRATEGY_TYPE.GENERALIST,
    arenaAppearances: 0,
    titleDefenses: 0,
    eliminations: 0,
    bestArenaScore: null,
    latestArenaScore: null,
    bestStatus: null,
    scoreHistory: [],
    regimeCoverage: {},
    stressSurvival: {},
    firstSeenAt: outcome.at ?? null,
    lastSeenAt: outcome.at ?? null,
    note: "Hall of Fame membership is historical interest only. It does NOT imply deployment eligibility, profitability, or safety.",
  };

  const score = Number.isFinite(outcome.arenaScore) ? round6(outcome.arenaScore) : null;
  const appearances = (base.arenaAppearances ?? 0) + 1;
  const wasBest = Number.isFinite(base.bestArenaScore) ? base.bestArenaScore : -Infinity;
  const defended =
    base.bestStatus === CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE &&
    outcome.status === CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE;

  const scoreHistory = [...(base.scoreHistory ?? [])];
  if (score !== null) {
    scoreHistory.push({ at: outcome.at ?? null, arenaId: outcome.arenaId ?? null, score, status: outcome.status });
  }

  return {
    ...base,
    arenaAppearances: appearances,
    titleDefenses: (base.titleDefenses ?? 0) + (defended ? 1 : 0),
    eliminations: (base.eliminations ?? 0) + (outcome.status === CANDIDATE_STATUS.ELIMINATED ? 1 : 0),
    bestArenaScore: Number.isFinite(score) ? round6(Math.max(wasBest, score)) : base.bestArenaScore,
    latestArenaScore: score,
    bestStatus:
      score !== null && score >= wasBest ? outcome.status ?? base.bestStatus : base.bestStatus,
    scoreHistory: scoreHistory.slice(-20),
    regimeCoverage: { ...(base.regimeCoverage ?? {}), ...(outcome.regimeCoverage ?? {}) },
    stressSurvival: { ...(base.stressSurvival ?? {}), ...(outcome.stressSurvival ?? {}) },
    lastSeenAt: outcome.at ?? base.lastSeenAt,
  };
}

/* ============================================================================
 * 8. Diversity protection
 * ==========================================================================*/

/** Normalized L1 distance between two genomes across shared bounded genes. */
export function genomeDistance(a = {}, b = {}) {
  let total = 0;
  let count = 0;
  for (const key of GENOME_KEYS) {
    const bounds = GENE_BOUNDS[key];
    if (!bounds) continue;
    const span = bounds[1] - bounds[0];
    if (!(span > 0)) continue;
    const va = Number.isFinite(a[key]) ? a[key] : bounds[0];
    const vb = Number.isFinite(b[key]) ? b[key] : bounds[0];
    total += Math.abs(va - vb) / span;
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

const DIVERSITY_SAMPLE_SIZE = 60;

/**
 * Deterministic, bounded diversity metrics for a population.
 * Pairwise distance is sampled on a fixed-size prefix to stay O(k²).
 */
export function computeGenomeMetrics(population) {
  const list = Array.isArray(population) ? population : [];
  if (list.length === 0) {
    return {
      populationSize: 0,
      uniqueGenomes: 0,
      genomeDiversity: 0,
      speciesDistribution: {},
      lineageConcentration: 0,
      ancestryConcentration: 0,
      pairwiseDistanceSample: 0,
    };
  }

  const digests = new Set();
  const speciesCounts = new Map();
  const lineageCounts = new Map();

  for (const entry of list) {
    const digest = entry?.digest ?? digestOf(entry?.genome ?? {});
    digests.add(digest);
    const species = entry?.species ?? "unknown";
    speciesCounts.set(species, (speciesCounts.get(species) ?? 0) + 1);
    // Fall back to the genome digest (not the literal string "unknown") so
    // distinct genomes without an explicit lineageId don't all collapse into
    // one bucket and falsely max out lineage concentration.
    const lineage = entry?.lineageId ?? digest;
    lineageCounts.set(lineage, (lineageCounts.get(lineage) ?? 0) + 1);
  }

  const herfindahl = (counts) => {
    const values = [...counts.values()];
    const sum = values.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return 0;
    return values.reduce((acc, c) => acc + (c / sum) ** 2, 0);
  };

  const sample = list.slice(0, DIVERSITY_SAMPLE_SIZE);
  let distanceTotal = 0;
  let distancePairs = 0;
  for (let i = 0; i < sample.length; i += 1) {
    for (let j = i + 1; j < sample.length; j += 1) {
      distanceTotal += genomeDistance(sample[i]?.genome ?? {}, sample[j]?.genome ?? {});
      distancePairs += 1;
    }
  }

  return {
    populationSize: list.length,
    uniqueGenomes: digests.size,
    genomeDiversity: round6(digests.size / list.length),
    speciesDistribution: Object.fromEntries(
      [...speciesCounts.entries()].map(([k, v]) => [k, round6(v / list.length)]),
    ),
    lineageConcentration: round6(herfindahl(lineageCounts)),
    ancestryConcentration: round6(herfindahl(lineageCounts)),
    pairwiseDistanceSample: distancePairs > 0 ? round6(distanceTotal / distancePairs) : 0,
  };
}

/** Diversity health verdict: is the population collapsing into one lineage? */
export function diversityVerdict(metrics, { minDiversity = 0.25, maxLineageConcentration = 0.8 } = {}) {
  const diversity = metrics?.genomeDiversity ?? 0;
  const lineage = metrics?.lineageConcentration ?? 0;
  if (diversity < minDiversity || lineage > maxLineageConcentration) {
    return { healthy: false, action: "increase-mutation", reason: `diversity ${round6(diversity)} below ${minDiversity} or lineage concentration ${round6(lineage)} above ${maxLineageConcentration}` };
  }
  return { healthy: true, action: "maintain", reason: "diversity within bounds" };
}

/* ============================================================================
 * 9. Adaptive mutation
 * ==========================================================================*/

export const MUTATION_LIMITS = Object.freeze({
  min: 0.03,
  max: 0.2,
  base: 0.07,
  lowDiversityThreshold: 0.25,
  stepUpFactor: 1.08,
  stepUpBonus: 0.004,
  stepDownRate: 0.2,
});

/**
 * Bounded mutation adaptation: low diversity nudges the scale up, healthy
 * diversity relaxes back toward base. Always inside [min, max].
 */
export function adaptMutationScale(diversity, currentScale, limits = MUTATION_LIMITS) {
  const current = Number.isFinite(currentScale) ? currentScale : limits.base;
  const diverse = Number.isFinite(diversity) ? diversity : 1;

  let next;
  if (diverse < limits.lowDiversityThreshold) {
    next = Math.min(limits.max, current * limits.stepUpFactor + limits.stepUpBonus);
  } else {
    next = current + (limits.base - current) * limits.stepDownRate;
  }

  return round6(Math.min(limits.max, Math.max(limits.min, next)));
}

/* ============================================================================
 * 10. Shadow League (paper-only)
 * ==========================================================================*/

export const SHADOW_DURATION_MILESTONES = Object.freeze({
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "3d": 72,
  "7d": 168,
  "30d": 720,
});

export function shadowCandidateId(digest) {
  return `shadow-${String(digest).slice(0, 10)}`;
}

/**
 * Build the initial shadow state for a candidate genome.
 * The genome embedded here is FROZEN for the life of the shadow run.
 */
export function buildShadowState(candidate, { source, startingCash = 100, label = null, at = null } = {}) {
  const qualified = candidate?.status === CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE;
  const digest = candidate?.digest ?? digestOf(candidate?.genome ?? {});
  const startTimestamp = Number.isFinite(at) ? at : Date.now();

  return {
    candidateId: shadowCandidateId(digest),
    digest,
    genome: candidate?.genome ?? null,
    species: candidate?.species ?? null,
    strategyType: candidate?.strategyType ?? STRATEGY_TYPE.GENERALIST,
    qualified,
    label:
      label ??
      (qualified ? CANDIDATE_STATUS.SHADOW_TESTING : CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST),
    startTimestamp,
    marketSource: source ?? "live",
    startingCash,
    bankroll: startingCash,
    grossPnl: 0,
    netPnl: 0,
    drawdown: 0,
    costs: 0,
    trades: 0,
    distinctMints: 0,
    activePositions: 0,
    runtimeMs: 0,
    feedHealthExposure: { degradedSnapshots: 0, entriesPausedTicks: 0, totalSnapshots: 0 },
    status: qualified ? CANDIDATE_STATUS.SHADOW_TESTING : CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST,
    paperOnly: true,
    immutableGenome: true,
    durationMilestones: Object.fromEntries(Object.keys(SHADOW_DURATION_MILESTONES).map((k) => [k, false])),
    observations: [],
    paperFills: [],
    equityHistory: [],
    feedFailures: [],
  };
}

/** Flip completed duration milestones. Returns the newly completed labels. */
export function advanceShadowMilestones(state, at = Date.now()) {
  const runtimeMs = Math.max(0, at - (state?.startTimestamp ?? at));
  const hours = runtimeMs / 3_600_000;
  const completed = [];
  for (const [label, required] of Object.entries(SHADOW_DURATION_MILESTONES)) {
    if (hours >= required && state?.durationMilestones?.[label] !== true) {
      state.durationMilestones[label] = true;
      completed.push(label);
    }
  }
  return completed;
}

/** Promotion status from shadow duration + evidence. Still always PAPER. */
export function shadowPromotionStatus(state) {
  if (!state?.qualified) {
    return {
      status: CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST,
      note: "development override; not deployment-qualified",
    };
  }
  const milestones = state.durationMilestones ?? {};
  if (milestones["30d"] && (state.trades ?? 0) >= 100 && (state.distinctMints ?? 0) >= 10) {
    return {
      status: CANDIDATE_STATUS.SHADOW_VALIDATED,
      note: "long paper track record; still PAPER ONLY — never auto-activates real trading",
    };
  }
  if (milestones["7d"] && (state.trades ?? 0) >= 40 && (state.distinctMints ?? 0) >= 6) {
    return {
      status: CANDIDATE_STATUS.SHADOW_PROVISIONAL,
      note: "substantial paper history; still PAPER ONLY",
    };
  }
  return {
    status: CANDIDATE_STATUS.SHADOW_TESTING,
    note: "in shadow testing; accumulating paper evidence",
  };
}

/**
 * Feed degradation gate for shadow entries.
 * A degraded live feed blocks NEW shadow entries (existing frozen candidates
 * keep their last defensible observed marks; no fabricated prices).
 */
export function shadowEntryGate(feedHealth, { allowDegraded = false } = {}) {
  const degraded = feedHealth?.degraded === true;
  const live = feedHealth?.live === true || feedHealth?.effectiveMode === "live";
  const entriesPaused = feedHealth?.entriesPaused === true;

  const blocked = !allowDegraded && (degraded || entriesPaused || !feedHealth?.allowNewEntries);

  return {
    blocked,
    reason: blocked
      ? degraded
        ? feedHealth?.degradedReason ?? "live feed degraded"
        : "new entries paused by feed health"
      : null,
    feedLive: live,
    paperOnly: true,
    note: "Degraded live feed blocks new shadow paper entries. Existing positions keep their last observed mark.",
  };
}

/**
 * Serialize a shadow state for persistence. No secrets, compact samples only.
 * The genome is stored verbatim: shadow evaluation must never alter it.
 */
export async function persistShadowState(state, dir = DEFAULT_SHADOW_DIR) {
  await ensureDir(dir);
  const file = path.join(dir, `${state.candidateId}.json`);
  const record = {
    ...state,
    updatedAt: new Date().toISOString(),
    paperOnly: true,
    realMoney: false,
    genomeImmutable: true,
    observations: state.observations.slice(-200),
    paperFills: state.paperFills.slice(-500),
    equityHistory: state.equityHistory.slice(-2000),
    feedFailures: state.feedFailures.slice(-100),
  };
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/* ============================================================================
 * 11. Arena cache
 * ==========================================================================*/

// Bumped for Phase 4.1: cached run payloads now carry `datasetDir` (regime
// wiring fix) and metrics carry `notional`/`mintNotional` (concentration
// fix) — old cache entries lack both and must not be reused.
export const ARENA_CACHE_VERSION = 2;

/**
 * Cache key for an arena evaluation slice. Includes dataset fingerprints,
 * genome digest, seed, stage, friction/stress profile, and scoring/arena
 * versions — change any of these and the cache invalidates.
 */
export function arenaCacheKey({
  genomeDigest,
  datasetFingerprints,
  seed,
  stage,
  stressProfile,
  windowPlan = null,
  arenaVersion = ARENA_CACHE_VERSION,
  scoreVersion = ARENA_SCORE_VERSION,
}) {
  const profiles = (Array.isArray(stressProfile) ? stressProfile : [stressProfile])
    .map((p) => (typeof p === "string" ? p : p?.id ?? String(p)))
    .sort();
  const fingerprints = [...(datasetFingerprints ?? [])].filter(Boolean).sort();
  const raw = JSON.stringify({
    arenaVersion,
    scoreVersion,
    genomeDigest,
    datasetFingerprints: fingerprints,
    seed: String(seed),
    stage,
    stressProfiles: profiles,
    windowPlan,
  });
  return sha256Hex(raw).slice(0, 24);
}

/** Read/write one cache entry. Values are JSON; misses return null. */
export async function readArenaCache(dir, key) {
  try {
    const file = path.join(dir, `${key}.json`);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.key !== key || parsed?.version !== ARENA_CACHE_VERSION) return null;
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

export async function writeArenaCache(dir, key, value) {
  await ensureDir(dir);
  const file = path.join(dir, `${key}.json`);
  await writeFile(
    file,
    `${JSON.stringify({ key, version: ARENA_CACHE_VERSION, value }, null, 0)}\n`,
    "utf8",
  );
  return file;
}

/** Number of cached arena entries (for dashboards/CLI). */
export async function arenaCacheStats(dir = DEFAULT_ARENA_CACHE_DIR) {
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return { entries: 0, dir };
  }
  return { entries: files.filter((name) => name.endsWith(".json")).length, dir };
}

/* ============================================================================
 * 12. Preset genome access (deterministic; used by distance + specialists)
 * ==========================================================================*/

/** Deterministic genome object for a species preset (no RNG involved). */
export function presetGenomeFor(species) {
  const preset = SPECIES_PRESETS[species];
  if (!preset) return null;
  const genome = {};
  for (const key of GENOME_KEYS) genome[key] = 0;
  for (const [k, v] of Object.entries(preset.weights ?? {})) {
    const genomeKey = `${k}Weight`;
    if (GENOME_KEYS.includes(genomeKey)) genome[genomeKey] = v;
  }
  for (const [k, v] of Object.entries(preset.gates ?? {})) {
    if (GENOME_KEYS.includes(k)) genome[k] = v;
  }
  for (const [k, v] of Object.entries(preset.risk ?? {})) {
    if (GENOME_KEYS.includes(k)) genome[k] = v;
  }
  genome.contrarian = preset.contrarian ?? 0;
  return genome;
}

export { sha256Hex, digestOf };
