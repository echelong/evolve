#!/usr/bin/env node
/**
 * Read-only Jupiter observation probe.
 *
 * Fetches the configured Tokens V2 categories once, normalizes them, and prints
 * a summary plus a few example rows. It never prints the API key, never writes
 * state, and never places anything: it is a connectivity check for the
 * *observation* layer.
 *
 * Run with: npm run probe:market
 */

import { redactSecrets } from "./lib/sanitize.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { JupiterTokensClient } from "./market/jupiter.mjs";
import { deriveMarket } from "./market/normalize.mjs";
import { MarketUniverse } from "./market/universe.mjs";

function money(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function price(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

async function main() {
  const config = createMarketConfig();
  const client = new JupiterTokensClient({ config });

  console.log("EVOLVE market probe (read-only observation)");
  console.log(`  provider        ${config.provider}`);
  console.log(`  base url        ${config.baseUrl}`);
  console.log(`  requested mode  ${config.requestedMode}`);
  console.log(`  api key         ${config.apiKeyConfigured ? "configured (value never printed)" : "not configured — keyless rate limits apply"}`);
  console.log(`  endpoints       ${config.endpoints.map((endpoint) => endpoint.label).join(", ")}`);
  if (config.loadedEnvFiles.length > 0) {
    console.log(`  env files       ${config.loadedEnvFiles.join(", ")}`);
  }

  const universe = new MarketUniverse({
    max: config.universeMax,
    ttlMs: config.tokenTtlMs,
    staleMs: config.staleMs,
    minLiquidityUsd: config.minLiquidityUsd,
  });

  const started = Date.now();
  const outcome = await client.pollAll(Date.now());
  const elapsed = Date.now() - started;

  for (const result of outcome.results) {
    const status = result.ok
      ? `ok · ${result.tokens.length} tokens`
      : result.deferred
        ? "deferred · waiting for rate-limit spacing"
        : `failed · ${redactSecrets(result.error ?? "unknown", config.secretValues)}`;
    console.log(`  ${result.endpoint.padEnd(34)} ${status}`);
    if (result.ok) universe.ingest(result.tokens, { category: result.endpoint });
  }

  const health = client.status();
  console.log("\n  feed health");
  console.log(`    requests        ${health.requestCount}`);
  console.log(`    succeeded       ${health.okCount}`);
  console.log(`    errors          ${health.errorCount}`);
  console.log(`    rate limits     ${health.rateLimitCount}`);
  console.log(`    last latency    ${health.lastLatencyMs === null ? "—" : `${health.lastLatencyMs}ms`}`);
  console.log(`    last error      ${health.lastErrorSafe ?? "none"}`);
  console.log(`    elapsed         ${elapsed}ms`);
  console.log(`    universe        ${universe.size} unique mints tracked`);

  const markets = universe
    .values()
    .slice(0, 6)
    .map((token) => deriveMarket(token, {
      prev: token.prevObservation ?? null,
      staleMs: config.staleMs,
      momentumReference: config.momentumReference.live,
    }));

  if (markets.length > 0) {
    console.log("\n  sample normalized observations");
    console.log("    symbol            price         5m%      liquidity     organic  holders  top%   poolAge");
    for (const market of markets) {
      const poolAgeHours =
        market.poolAgeMs === null ? "—" : `${(market.poolAgeMs / 3_600_000).toFixed(1)}h`;
      console.log(
        `    ${String(market.symbol).slice(0, 14).padEnd(15)} ${price(market.price).padEnd(12)} ${String(market.changePct === null ? "—" : market.changePct.toFixed(2)).padStart(7)}  ${money(market.liquidity).padEnd(11)} ${String(market.organicScore === null ? "—" : market.organicScore.toFixed(0)).padStart(6)}  ${String(market.holderCount ?? "—").padStart(7)}  ${String(market.topHoldersPercentage === null ? "—" : market.topHoldersPercentage.toFixed(1)).padStart(5)}  ${poolAgeHours}`,
      );
    }
  }

  const live = outcome.ok;
  console.log(
    `\n  result: ${live ? "LIVE OBSERVATION OK — real Solana market data available" : "LIVE OBSERVATION UNAVAILABLE — auto mode would fall back to synthetic"}`,
  );

  if (!live) process.exitCode = 2;
}

main().catch((error) => {
  console.error("probe crashed:", error?.message ?? error);
  process.exitCode = 1;
});
