import { loadEnvFiles } from '../lib/env.mjs';
import { MIB, SESSION_CAPACITY_MIB } from './storage.mjs';

// Only whole decimal MiB values are accepted; anything else (empty, negative,
// fractional, exponent, hex, NaN, Infinity) uses the default. Whole values clamp
// to the bounded range, so capacity is always a finite positive integer.
export function sessionCapacityMiB(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!/^[0-9]+$/.test(text)) return SESSION_CAPACITY_MIB.default;
  return Math.min(SESSION_CAPACITY_MIB.max, Math.max(SESSION_CAPACITY_MIB.min, Number(text)));
}

export function createIntelligenceConfig({ env = process.env, loadEnv = env === process.env } = {}) {
  if (loadEnv) loadEnvFiles();
  const n = (key, fallback, min = 1, max = 3_600_000) => {
    const value = Number(env[key] ?? fallback);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
  };
  const enabled = (key, fallback) => env[key] === undefined ? fallback : /^(1|true|yes)$/i.test(env[key]);
  const gmgn = {
    enabled: enabled('EVOLVE_GMGN_ENABLED', true), baseUrl: env.EVOLVE_GMGN_BASE_URL || 'https://openapi.gmgn.ai',
    timeoutMs: n('EVOLVE_GMGN_TIMEOUT_MS', 8000, 100, 60000), pollMs: n('EVOLVE_GMGN_POLL_MS', 30000, 1000),
    // One request slot is reserved for Trenches and at least one for token-route
    // service, so a GMGN budget below 2 can never cover the declared routes.
    maxRequests: Math.floor(n('EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE', 6, 2, 30)), cacheMs: n('EVOLVE_GMGN_CACHE_MS', 30000, 0),
    staleMs: n('EVOLVE_GMGN_STALE_MS', 90000), spacingMs: 1200,
  };
  const key = env.EVOLVE_GMGN_API_KEY || env.GMGN_API_KEY || null;
  Object.defineProperty(gmgn, 'apiKey', { value: key, enumerable: false });
  const maxSessionMiB = sessionCapacityMiB(env.EVOLVE_INTELLIGENCE_MAX_SESSION_MIB);
  const config = {
    gmgn: Object.freeze(gmgn), dex: Object.freeze({ enabled: enabled('EVOLVE_DEXSCREENER_ENABLED', true),
      baseUrl: 'https://api.dexscreener.com', timeoutMs: n('EVOLVE_DEXSCREENER_TIMEOUT_MS', 8000, 100, 60000),
      pollMs: n('EVOLVE_DEXSCREENER_POLL_MS', 30000, 1000), maxRequests: Math.floor(n('EVOLVE_DEXSCREENER_MAX_REQUESTS_PER_CYCLE', 6, 1, 30)),
      cacheMs: n('EVOLVE_DEXSCREENER_CACHE_MS', 30000, 0), staleMs: n('EVOLVE_DEXSCREENER_STALE_MS', 60000), spacingMs: 1200 }),
    launch: Object.freeze({ staleMs: n('EVOLVE_LAUNCH_STALE_MS', 300000), transportImplemented: false }),
    jupiterStaleMs: n('EVOLVE_INTELLIGENCE_JUPITER_STALE_MS', 60000),
    alignmentMs: n('EVOLVE_INTELLIGENCE_ALIGNMENT_MS', 15000),
    root: '.evolve/market-intelligence', maxRawBytes: 256 * 1024, maxSessionMiB, maxSessionBytes: maxSessionMiB * MIB,
  };
  Object.defineProperty(config, 'secrets', { value: Object.freeze([key, env.JUPITER_API_KEY, env.EVOLVE_JUPITER_API_KEY,
    env.EVOLVE_SOLANA_RPC_URL, env.EVOLVE_SOLANA_WSS_URL].filter(Boolean)), enumerable: false });
  return Object.freeze(config);
}
