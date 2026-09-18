/**
 * EVOLVE Phase 2 market + paper configuration.
 *
 * Everything is resolved from environment variables. Two rules matter:
 *
 *   1. `JUPITER_API_KEY` is stored as a NON-ENUMERABLE property so that an
 *      accidental `{ ...config }` spread can never leak it into state, a log
 *      line, or an API response. Its only consumer is the HTTP client that
 *      builds the `x-api-key` request header.
 *   2. Nothing in this module can enable real trading. There is no signing,
 *      no submission, and no execution flag to flip: paper trading is the only
 *      execution model that exists in the codebase.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvFiles } from "../lib/env.mjs";

export const MARKET_MODES = ["auto", "live", "synthetic", "replay"];

export const PROVIDER_JUPITER = "Jupiter Developer Platform";
export const PROVIDER_SYNTHETIC = "Internal synthetic simulator";
export const PROVIDER_REPLAY = "Historical dataset replay";

/** Tokens V2 observation endpoints. Observation only, never execution. */
export const DEFAULT_ENDPOINTS = [
  { id: "recent", path: "recent", label: "/tokens/v2/recent", category: "recent" },
  {
    id: "toporganicscore",
    path: "toporganicscore/5m",
    label: "/tokens/v2/toporganicscore/5m",
    category: "organic",
  },
  {
    id: "toptrending",
    path: "toptrending/5m",
    label: "/tokens/v2/toptrending/5m",
    category: "trending",
  },
];

/** Opt-in bonus category. The three defaults already cover the universe. */
export const OPTIONAL_ENDPOINTS = [
  {
    id: "toptraded",
    path: "toptraded/5m",
    label: "/tokens/v2/toptraded/5m",
    category: "traded",
  },
];

/**
 * Keyless Jupiter access is rate limited (observed: 5 requests per rolling
 * 10s window, surfaced via `x-ratelimit-remaining`). We stay well under that
 * by touching one endpoint at a time and spacing requests out.
 */
export const KEYLESS_POLL_MS = 3500;
export const KEYED_POLL_MS = 3000;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readFirst(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return { name, value: String(value).trim() };
    }
  }
  return { name: null, value: null };
}

function readNumber(env, names, fallback) {
  const { value } = readFirst(env, names);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readInt(env, names, fallback) {
  return Math.round(readNumber(env, names, fallback));
}

function readBool(env, names, fallback) {
  const { value } = readFirst(env, names);
  if (value === null) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** "11,22,33" -> [11, 22, 33]; empty/unusable input -> empty list. */
function parseSeedList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
}

/**
 * "Genesis Hunter:6,Momentum:5" -> { "Genesis Hunter": 6, Momentum: 5 }.
 * Unknown island names are dropped (validated against ISLAND_NAMES upstream);
 * counts below 2 collapse to 2 so an island can always select + breed.
 */
function parseIslandCounts(value) {
  const out = {};
  if (!value) return out;
  for (const part of String(value).split(",")) {
    const [name, rawCount] = part.split(":").map((piece) => piece.trim());
    if (!name) continue;
    const count = Math.max(2, Math.round(Number(rawCount)));
    if (Number.isFinite(count)) out[name] = count;
  }
  return out;
}

function normalizeDashboardSource(value) {
  const allowed = ["auto", "live", "replay"];
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : "auto";
}

function resolveEndpoints(env, limit) {
  const { value } = readFirst(env, ["EVOLVE_JUPITER_ENDPOINTS"]);
  const known = [...DEFAULT_ENDPOINTS, ...OPTIONAL_ENDPOINTS];
  const selected = [];

  if (value) {
    for (const token of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      const match = known.find(
        (endpoint) =>
          endpoint.id === token || endpoint.path === token || endpoint.label === token,
      );
      if (match && !selected.some((entry) => entry.id === match.id)) selected.push(match);
    }
  }

  if (readBool(env, ["EVOLVE_JUPITER_INCLUDE_TOPTRADED"], false)) {
    for (const endpoint of OPTIONAL_ENDPOINTS) {
      if (!selected.some((entry) => entry.id === endpoint.id)) selected.push(endpoint);
    }
  }

  if (selected.length === 0) selected.push(...DEFAULT_ENDPOINTS);

  return selected.map((endpoint) => ({
    ...endpoint,
    url: `tokens/v2/${endpoint.path}?limit=${limit}`,
  }));
}

/**
 * Build the immutable market + paper configuration.
 * @param {Record<string, string | undefined>} [env]
 */
export function createMarketConfig(env = process.env, { loadEnv = true } = {}) {
  const loadedEnvFiles = loadEnv
    ? [
        ...new Set([
          ...loadEnvFiles({ dir: PROJECT_ROOT }),
          ...(path.resolve(process.cwd()) === PROJECT_ROOT
            ? []
            : loadEnvFiles({ dir: process.cwd() })),
        ]),
      ]
    : [];

  const modeEntry = readFirst(env, ["EVOLVE_MARKET_MODE", "MARKET_MODE"]);
  const requestedMode = MARKET_MODES.includes((modeEntry.value ?? "").toLowerCase())
    ? modeEntry.value.toLowerCase()
    : "auto";

  const apiKeyEntry = readFirst(env, ["JUPITER_API_KEY"]);
  const apiKey = apiKeyEntry.value;
  const apiKeyConfigured = Boolean(apiKey);

  const universeMax = clampNumber(readInt(env, ["EVOLVE_MARKET_UNIVERSE_MAX"], 150), 10, 400);
  const jupiterLimit = clampNumber(readInt(env, ["EVOLVE_JUPITER_LIMIT"], 100), 1, 100);
  const keylessAllowed = readBool(env, ["EVOLVE_ALLOW_KEYLESS"], true);

  const baseUrl = (
    readFirst(env, ["EVOLVE_JUPITER_BASE_URL"]).value ?? "https://api.jup.ag"
  ).replace(/\/+$/, "");

  const config = {
    requestedMode,
    modeSource: modeEntry.name,
    apiKeyConfigured,
    apiKeySource: apiKeyConfigured ? apiKeyEntry.name : null,
    keylessAllowed,
    loadedEnvFiles,
    provider: PROVIDER_JUPITER,

    baseUrl,
    endpoints: resolveEndpoints(env, jupiterLimit),
    pollMs: clampNumber(
      readInt(env, ["EVOLVE_JUPITER_POLL_MS"], apiKeyConfigured ? KEYED_POLL_MS : KEYLESS_POLL_MS),
      1000,
      120_000,
    ),
    requestSpacingMs: clampNumber(
      readInt(env, ["EVOLVE_JUPITER_SPACING_MS"], apiKeyConfigured ? 800 : 2000),
      0,
      60_000,
    ),
    timeoutMs: clampNumber(readInt(env, ["EVOLVE_JUPITER_TIMEOUT_MS"], 9000), 1000, 60_000),
    minBackoffMs: clampNumber(readInt(env, ["EVOLVE_JUPITER_MIN_BACKOFF_MS"], 3000), 500, 600_000),
    maxBackoffMs: clampNumber(
      readInt(env, ["EVOLVE_JUPITER_MAX_BACKOFF_MS"], 120_000),
      1000,
      3_600_000,
    ),
    retryJitter: clampNumber(readNumber(env, ["EVOLVE_JUPITER_RETRY_JITTER"], 0.15), 0, 1),

    staleMs: clampNumber(
      readInt(env, ["EVOLVE_LIVE_STALE_MS", "EVOLVE_MARKET_STALE_MS"], 60_000),
      1000,
      3_600_000,
    ),
    tokenTtlMs: clampNumber(
      readInt(env, ["EVOLVE_MARKET_TOKEN_TTL_MS"], 300_000),
      1000,
      86_400_000,
    ),
    universeMax,
    allowSyntheticFallback: readBool(env, ["EVOLVE_ALLOW_SYNTHETIC_FALLBACK"], true),
    autoFallbackFailures: clampNumber(readInt(env, ["EVOLVE_AUTO_FALLBACK_FAILURES"], 4), 1, 100),
    syntheticRetryMs: clampNumber(
      readInt(env, ["EVOLVE_SYNTHETIC_RETRY_MS"], 90_000),
      1000,
      86_400_000,
    ),
    syntheticUniverseSize: clampNumber(readInt(env, ["EVOLVE_SYNTHETIC_UNIVERSE"], 24), 4, 400),
    minLiquidityUsd: clampNumber(readNumber(env, ["EVOLVE_MIN_LIQUIDITY_USD"], 2500), 0, 1e12),

    // --- Phase 3: historical capture, deterministic replay, walk-forward ----
    seed: readFirst(env, ["EVOLVE_SEED"]).value ?? "evolve",
    evalSeeds: parseSeedList(readFirst(env, ["EVOLVE_EVAL_SEEDS"]).value),

    historyRoot: readFirst(env, ["EVOLVE_HISTORY_ROOT"]).value ?? path.join(".evolve", "history"),
    recordCaptureMs: clampNumber(
      readInt(env, ["EVOLVE_RECORD_INTERVAL_MS"], 5000),
      250,
      3_600_000,
    ),
    recordManifestEvery: clampNumber(readInt(env, ["EVOLVE_RECORD_MANIFEST_EVERY"], 12), 1, 10_000),
    championsDir: readFirst(env, ["EVOLVE_CHAMPIONS_DIR"]).value ?? path.join(".evolve", "champions"),
    experimentsDir:
      readFirst(env, ["EVOLVE_EXPERIMENTS_DIR"]).value ?? path.join(".evolve", "experiments"),

    replay: Object.freeze({
      dataset:
        readFirst(env, ["EVOLVE_REPLAY_DATASET", "EVOLVE_HISTORY_DATASET"]).value ?? null,
      speed: readFirst(env, ["EVOLVE_REPLAY_SPEED"]).value ?? "1",
      limit: clampNumber(readInt(env, ["EVOLVE_REPLAY_LIMIT"], 0), 0, 10_000_000),
      pacing: readBool(env, ["EVOLVE_REPLAY_PACING"], true),
      verifyFingerprint: readBool(env, ["EVOLVE_REPLAY_VERIFY_FINGERPRINT"], true),
      marketScanLimit: clampNumber(readInt(env, ["EVOLVE_REPLAY_SCAN_LIMIT"], 60), 0, 5000),
      writeStateEveryTicks: clampNumber(readInt(env, ["EVOLVE_REPLAY_STATE_EVERY"], 20), 1, 100_000),
      stateFile: readFirst(env, ["EVOLVE_REPLAY_STATE_FILE"]).value ?? "replay-state.json",
    }),

    dashboard: Object.freeze({
      source: normalizeDashboardSource(readFirst(env, ["EVOLVE_DASHBOARD_SOURCE"]).value),
      liveWindowMs: clampNumber(
        readInt(env, ["EVOLVE_DASHBOARD_LIVE_WINDOW_MS"], 45_000),
        1000,
      3_600_000,
      ),
    }),

    walkForward: Object.freeze({
      trainMinutes: clampNumber(readNumber(env, ["EVOLVE_WF_TRAIN_MINUTES"], 360), 0.001, 1_000_000),
      validateMinutes: clampNumber(
        readNumber(env, ["EVOLVE_WF_VALIDATE_MINUTES"], 120),
        0.001,
        1_000_000,
      ),
      testMinutes: clampNumber(readNumber(env, ["EVOLVE_WF_TEST_MINUTES"], 120), 0.001, 1_000_000),
      stepMinutes: clampNumber(readNumber(env, ["EVOLVE_WF_STEP_MINUTES"], 120), 0.001, 1_000_000),
      minWindows: clampNumber(readInt(env, ["EVOLVE_WF_MIN_WINDOWS"], 1), 1, 10_000),
      maxCandidates: clampNumber(readInt(env, ["EVOLVE_WF_MAX_CANDIDATES"], 8), 1, 512),
      minValidationRobustness: readNumber(env, ["EVOLVE_WF_MIN_VALIDATION_ROBUSTNESS"], 0),
      overfitMargin: clampNumber(readNumber(env, ["EVOLVE_WF_OVERFIT_MARGIN"], 0.25), 0, 10),
      allowShortDataset: readBool(env, ["EVOLVE_WF_ALLOW_SHORT_DATASET"], false),
    }),

    evidence: Object.freeze({
      minTrades: clampNumber(readInt(env, ["EVOLVE_MIN_TRADES"], 20), 1, 1_000_000),
      minDistinctMints: clampNumber(readInt(env, ["EVOLVE_MIN_DISTINCT_MINTS"], 4), 1, 10_000),
      minObservations: clampNumber(readInt(env, ["EVOLVE_MIN_OBSERVATIONS"], 200), 1, 10_000_000),
      minExposureTicks: clampNumber(readInt(env, ["EVOLVE_MIN_EXPOSURE_TICKS"], 40), 0, 10_000_000),
    }),

    // --- Phase 5A: strategy islands ------------------------------------------
    // The live population is split into semi-isolated islands that evolve
    // predominantly from their own successful genomes, with bounded migration.
    // The point is to stop one short-lived market regime from immediately
    // destroying all strategic diversity.
    islands: Object.freeze({
      enabled: readBool(env, ["EVOLVE_ISLANDS_ENABLED"], true),
      // Explicit per-island targets ("Name:count,Name:count"). Unset = split
      // the population approximately evenly across the enabled islands. These
      // are the *initialization / base weight*, not a per-generation quota.
      targetCounts: parseIslandCounts(readFirst(env, ["EVOLVE_ISLAND_TARGETS"]).value),
      // Phase 5A.1 soft diversity protection. Islands are no longer held at an
      // identical 1/N quota: births follow each island's evidence-adjusted
      // reproductive weight, bounded per generation and clamped into these
      // explicit bounds. Set EVOLVE_ISLAND_MIN_SHARE=0 to let a persistently
      // failing island actually reach zero (and be revived by the existing
      // extinction rule) instead of being floored.
      minShare: clampNumber(readNumber(env, ["EVOLVE_ISLAND_MIN_SHARE"], 0.08), 0, 0.5),
      maxShare: clampNumber(readNumber(env, ["EVOLVE_ISLAND_MAX_SHARE"], 0.3), 0.02, 1),
      // Maximum share (of the whole population) one island's target may move in
      // one generation — the anti-takeover bound.
      maxShareDelta: clampNumber(readNumber(env, ["EVOLVE_ISLAND_MAX_SHARE_DELTA"], 0.06), 0, 1),
      // How strongly an evidence-backed fitness advantage can shift an island's
      // reproductive weight, and the fitness scale the advantage saturates at.
      advantageStrength: clampNumber(readNumber(env, ["EVOLVE_ISLAND_ADVANTAGE_STRENGTH"], 0.75), 0, 4),
      fitnessScale: clampNumber(readNumber(env, ["EVOLVE_ISLAND_FITNESS_SCALE"], 8), 0.01, 10_000),
      // Fraction of each island that emigrates to other islands per generation
      // (bounded: migration informs, it must not homogenize).
      migrationRate: clampNumber(readNumber(env, ["EVOLVE_ISLAND_MIGRATION_RATE"], 0.04), 0, 0.25),
      maxMigrationsPerGeneration: clampNumber(
        readInt(env, ["EVOLVE_ISLAND_MAX_MIGRATIONS"], 12),
        0,
        10_000,
      ),
      // Probability a bred child is a CROSS-SPECIES crossover (parents drawn
      // from two different islands). Deliberately conservative: cross-pollination
      // without homogenization.
      crossSpeciesCrossoverRate: clampNumber(
        readNumber(env, ["EVOLVE_CROSS_SPECIES_CROSSOVER_RATE"], 0.05),
        0,
        1,
      ),
      // Extra random immigrants per generation as a fraction of the population,
      // on top of the long-standing EVOLVE_IMMIGRANT_RATE (kept for
      // compatibility; both contribute to the bounded exploration floor).
      randomImmigrantRate: clampNumber(readNumber(env, ["EVOLVE_RANDOM_IMMIGRANT_RATE"], 0.03), 0, 0.25),
      // An island whose members all died may be re-seeded with fresh random
      // genomes (bounded revival); an island that persists but keeps failing is
      // NOT protected — selection still culls it normally.
      reviveExtinct: readBool(env, ["EVOLVE_ISLAND_REVIVE_EXTINCT"], true),
    }),

    // --- Phase 5A: offline research swarm -------------------------------------
    // Researchers PROPOSE strategy hypotheses; a deterministic compiler turns
    // valid proposals into candidate genome families; only the existing Arena
    // decides anything. The swarm can never execute code, touch the Arena
    // gates, or promote itself. `mock` is a deterministic no-LLM provider, so
    // the whole validation suite works offline and Phase 5A is usable without
    // any LLM API key.
    research: Object.freeze({
      enabled: readBool(env, ["EVOLVE_RESEARCH_ENABLED"], true),
      provider: (readFirst(env, ["EVOLVE_RESEARCH_PROVIDER"]).value ?? "mock").toLowerCase(),
      root: readFirst(env, ["EVOLVE_RESEARCH_ROOT"]).value ?? path.join(".evolve", "research"),
      // Bounded cadence: a research cycle every N generations (0 = every tick
      // batch the engine decides; the engine treats 0 as "every generation").
      cycleEveryGenerations: clampNumber(readInt(env, ["EVOLVE_RESEARCH_CYCLE_EVERY_GENERATIONS"], 2), 0, 10_000),
      proposalsPerCycle: clampNumber(readInt(env, ["EVOLVE_RESEARCH_PROPOSALS_PER_CYCLE"], 6), 1, 64),
      maxCompilationsPerCycle: clampNumber(readInt(env, ["EVOLVE_RESEARCH_MAX_COMPILATIONS_PER_CYCLE"], 3), 0, 64),
      // Phase 5A.2 cohort guards. `minUniqueRatio` is the fraction of a
      // research cohort that must be genuinely unique genomes; `maxSpeciesShare`
      // is the diversity guard against one species consuming the whole cohort
      // (a research-diversity rule, never a performance rule).
      minUniqueRatio: clampNumber(readNumber(env, ["EVOLVE_RESEARCH_MIN_UNIQUE_RATIO"], 0.9), 0, 1),
      maxSpeciesShare: clampNumber(readNumber(env, ["EVOLVE_RESEARCH_MAX_SPECIES_SHARE"], 0.6), 0, 1),
      strictUniqueness: readBool(env, ["EVOLVE_RESEARCH_STRICT_UNIQUENESS"], false),
      maxProposalsKept: clampNumber(readInt(env, ["EVOLVE_RESEARCH_MAX_PROPOSALS_KEPT"], 200), 10, 10_000),
      maxMemoryKept: clampNumber(readInt(env, ["EVOLVE_RESEARCH_MAX_MEMORY_KEPT"], 500), 10, 100_000),
      proposalSchemaVersion: clampNumber(readInt(env, ["EVOLVE_RESEARCH_PROPOSAL_SCHEMA_VERSION"], 1), 1, 99),
    }),

    researchWatch: Object.freeze({
      // Reward-hacking watchdog thresholds (deterministic, inspection-only).
      topMintNotionalShare: clampNumber(readNumber(env, ["EVOLVE_WATCH_TOP_MINT_SHARE"], 0.5), 0.01, 1),
      topWindowReturnShare: clampNumber(readNumber(env, ["EVOLVE_WATCH_TOP_WINDOW_SHARE"], 0.6), 0.01, 1),
      topRegimeReturnShare: clampNumber(readNumber(env, ["EVOLVE_WATCH_TOP_REGIME_SHARE"], 0.75), 0.01, 1),
      minTrades: clampNumber(readInt(env, ["EVOLVE_WATCH_MIN_TRADES"], 8), 1, 1_000_000),
      maxSingleTradeReturnShare: clampNumber(readNumber(env, ["EVOLVE_WATCH_MAX_SINGLE_TRADE_SHARE"], 0.8), 0.01, 1),
      maxCostDrag: clampNumber(readNumber(env, ["EVOLVE_WATCH_MAX_COST_DRAG"], 0.15), 0, 10),
      maxTrainOosCollapse: clampNumber(readNumber(env, ["EVOLVE_WATCH_MAX_TRAIN_OOS_COLLAPSE"], 0.7), 0, 1),
      quarantineFlags: clampNumber(readInt(env, ["EVOLVE_WATCH_QUARANTINE_FLAGS"], 4), 1, 64),
      watchFlags: clampNumber(readInt(env, ["EVOLVE_WATCH_WATCH_FLAGS"], 2), 1, 64),
      minOosWindows: clampNumber(readInt(env, ["EVOLVE_WATCH_MIN_OOS_WINDOWS"], 3), 1, 10_000),
    }),

    evolution: Object.freeze({
      enabled: readBool(env, ["EVOLVE_EVOLUTION_ENABLED"], true),
      mutationScale: clampNumber(readNumber(env, ["EVOLVE_MUTATION_SCALE"], 0.07), 0.001, 2),
      crossoverRate: clampNumber(readNumber(env, ["EVOLVE_CROSSOVER_RATE"], 0.48), 0, 1),
      immigrantRate: clampNumber(readNumber(env, ["EVOLVE_IMMIGRANT_RATE"], 0.1), 0, 0.5),
      eliteFraction: clampNumber(readNumber(env, ["EVOLVE_LIVE_ELITE_FRACTION", "EVOLVE_ELITE_FRACTION"], 0.1), 0.01, 0.5),
      breederFraction: clampNumber(readNumber(env, ["EVOLVE_BREEDER_FRACTION"], 0.28), 0.05, 1),
      // Total fraction of the population that survives a generation unculled
      // (elites plus a wider, evidence-checked survivor tier). Keeps live
      // replacement well below the ~90% churn a pure elites-only-survive
      // policy produces at the default 10% elite fraction.
      survivorFraction: clampNumber(readNumber(env, ["EVOLVE_LIVE_SURVIVOR_FRACTION"], 0.35), 0.05, 0.9),
      // Evidence gate for *selection privilege* (ranking into the elite/
      // breeder tiers), not for staying alive — an agent short on trades or
      // observations can still occupy a survivor slot, it just cannot out-
      // rank evidenced agents on one lucky result.
      minTradesForSelection: clampNumber(
        readInt(env, ["EVOLVE_LIVE_MIN_TRADES_FOR_SELECTION"], 3),
        0,
        10_000,
      ),
      minObservationsForSelection: clampNumber(
        readInt(env, ["EVOLVE_LIVE_MIN_OBSERVATIONS_FOR_SELECTION"], 30),
        0,
        10_000_000,
      ),
      // Floor under config.engine.generationTicks: a generation cannot end
      // (and cull/breed) before agents have had at least this many ticks to
      // accumulate evidence. Defaults to a no-op (10, below any
      // generationTicks value used anywhere in this codebase) — raise it
      // explicitly if a very short generationTicks is otherwise configured.
      minGenerationTicks: clampNumber(
        readInt(env, ["EVOLVE_LIVE_MIN_GENERATION_TICKS"], 10),
        10,
        100_000,
      ),
    }),

    baselines: Object.freeze({
      enabled: readBool(env, ["EVOLVE_BASELINES_ENABLED"], true),
      randomEntryProbability: clampNumber(
        readNumber(env, ["EVOLVE_BASELINE_RANDOM_ENTRY_PROBABILITY"], 0.02),
        0.0001,
        1,
      ),
    }),
    momentumReference: Object.freeze({
      live: clampNumber(readNumber(env, ["EVOLVE_LIVE_MOMENTUM_REFERENCE"], 0.1), 0.0001, 5),
      synthetic: clampNumber(
        readNumber(env, ["EVOLVE_SYNTHETIC_MOMENTUM_REFERENCE"], 0.02),
        0.0001,
        5,
      ),
    }),

    engine: Object.freeze({
      // Phase 5A: EVOLVE_POPULATION_SIZE is the documented primary knob
      // (default 96, matching the long-standing EVOLVE_POPULATION). Both names
      // resolve to the same value; the first set one wins. The population is
      // constant within one run — births restore exactly this target after
      // every selection, and nothing may grow it.
      population: clampNumber(
        readInt(env, ["EVOLVE_POPULATION_SIZE", "EVOLVE_POPULATION"], 96),
        12,
        512,
      ),
      generationTicks: clampNumber(readInt(env, ["EVOLVE_GENERATION_TICKS"], 180), 10, 100_000),
      tickMs: clampNumber(readInt(env, ["EVOLVE_TICK_MS"], 900), 50, 60_000),
    }),

    paper: Object.freeze({
      startingCash: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_STARTING_CASH", "EVOLVE_STARTING_BALANCE"], 100),
        1,
        10_000_000,
      ),
      baseFeeBps: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_BASE_FEE_BPS", "EVOLVE_FEE_BPS"], 10),
        0,
        2000,
      ),
      minSlippageBps: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_MIN_SLIPPAGE_BPS", "EVOLVE_SLIPPAGE_FLOOR_BPS"], 20),
        0,
        5000,
      ),
      slippageImpact: clampNumber(readNumber(env, ["EVOLVE_PAPER_SLIPPAGE_IMPACT"], 0.6), 0, 100),
      slippageCapBps: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_SLIPPAGE_CAP_BPS"], 400),
        0,
        10_000,
      ),
      adverseBufferBps: clampNumber(readNumber(env, ["EVOLVE_PAPER_ADVERSE_BPS"], 8), 0, 1000),
      maxLiquidityFraction: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_MAX_LIQUIDITY_FRACTION"], 0.02),
        0.00001,
        1,
      ),
      maxPositionFraction: clampNumber(
        readNumber(env, ["EVOLVE_PAPER_MAX_POSITION_FRACTION"], 0.28),
        0.01,
        1,
      ),
    }),
  };

  const researchApiKeyEntry = readFirst(env, ["EVOLVE_RESEARCH_API_KEY", "EVOLVE_LLM_API_KEY"]);
  const researchApiKey = researchApiKeyEntry.value;

  const secretValues = [apiKey, researchApiKey].filter(Boolean);

  // Phase 5A: an external researcher provider's credential is environment-only,
  // never enumerable, and can never reach state, logs, or the dashboard.
  Object.defineProperty(config, "researchApiKey", {
    value: researchApiKey ?? null,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(config, "researchApiKeyConfigured", {
    value: Boolean(researchApiKey),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(config, "apiKey", {
    value: apiKey ?? null,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  // Available for redaction only; never enumerable, never serialized.
  Object.defineProperty(config, "secretValues", {
    value: Object.freeze(secretValues),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(config);
}

/** A safe-to-serialize description of the active configuration. */
export function publicConfig(config) {
  return {
    requestedMode: config.requestedMode,
    provider: config.provider,
    seed: config.seed,
    evalSeeds: [...config.evalSeeds],
    researchApiKeyConfigured: config.researchApiKeyConfigured,
    historyRoot: config.historyRoot,
    recordCaptureMs: config.recordCaptureMs,
    replay: { ...config.replay },
    walkForward: { ...config.walkForward },
    evidence: { ...config.evidence },
    evolution: { ...config.evolution },
    islands: { ...config.islands },
    research: { ...config.research },
    baselines: { ...config.baselines },
    apiKeyConfigured: config.apiKeyConfigured,
    keylessAllowed: config.keylessAllowed,
    endpoints: config.endpoints.map((endpoint) => endpoint.label),
    pollMs: config.pollMs,
    staleMs: config.staleMs,
    universeMax: config.universeMax,
    tokenTtlMs: config.tokenTtlMs,
    loadedEnvFiles: config.loadedEnvFiles,
    paper: { ...config.paper },
    engine: { ...config.engine },
    execution: "paper-only",
  };
}
