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

export const MARKET_MODES = ["auto", "live", "synthetic"];

export const PROVIDER_JUPITER = "Jupiter Developer Platform";
export const PROVIDER_SYNTHETIC = "Internal synthetic simulator";

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
    momentumReference: Object.freeze({
      live: clampNumber(readNumber(env, ["EVOLVE_LIVE_MOMENTUM_REFERENCE"], 0.1), 0.0001, 5),
      synthetic: clampNumber(
        readNumber(env, ["EVOLVE_SYNTHETIC_MOMENTUM_REFERENCE"], 0.02),
        0.0001,
        5,
      ),
    }),

    engine: Object.freeze({
      population: clampNumber(readInt(env, ["EVOLVE_POPULATION"], 96), 12, 512),
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

  const secretValues = [apiKey].filter(Boolean);

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
