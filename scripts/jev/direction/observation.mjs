/**
 * Phase 5I.0b — SOL/USDC observation source.
 *
 * This REUSES EVOLVE's existing market observation infrastructure rather than
 * building a parallel market layer:
 *
 *   JupiterTokensClient -> MarketUniverse -> normalize/deriveMarket
 *
 * ...through the same `createMarketFeed` orchestrator the engine uses. What it
 * adds is narrow, honest, and testable:
 *
 *   1. ONE observation cycle = a polite walk over the configured Tokens V2
 *      endpoints, waiting on the CLIENT'S OWN rate/poll rules between requests
 *      (`client.canRequest` / `nextAttemptInMs`). Nothing here hammers Jupiter,
 *      and no endpoint is bypassed.
 *
 *      A Jupiter quote is NOT an order book, and this module never pretends
 *      otherwise: it makes read-only observation GETs and never builds, quotes
 *      or simulates a swap route. There is therefore no bid/ask, no depth, no
 *      queue position and no spread anywhere in Phase 5I's inputs.
 *
 *      (The existing `feed.probeAll()` cannot be used as-is: its results are
 *      deliberately skipped by the client's poll-interval spacing, so only the
 *      first endpoint's payload is ever returned. The benchmark needs a genuine
 *      SOL observation every cycle, so it drives the same client one request at
 *      a time instead.)
 *
 *   2. A GENUINENESS GATE around the benchmark reference price. An observation
 *      counts only when:
 *        - the cycle's Tokens V2 GET succeeded;
 *        - the benchmark base mint (wrapped SOL) was present in THIS cycle's
 *          payloads — a price carried over from an earlier cycle is refused,
 *          never paraphrased as "now";
 *        - the record is genuinely live (`synthetic === false`, source
 *          "Jupiter Tokens V2") with a finite positive USD price;
 *        - the configured mode is `live` — `auto` may fall back to the synthetic
 *          simulator, and synthetic data is NEVER scored as market evidence.
 *
 *   3. A per-observation STAMP. `stateObservedAt` / `outcomeObservedAt` are the
 *      timestamps of the poll that actually carried the base mint — the same
 *      instant EVOLVE's normalization assigns to the token (`observedAt`). That
 *      is why the benchmark's horizon clock is honest even though a cycle polls
 *      several endpoints.
 *
 * Everything else becomes an explicit invalid observation with a machine-readable
 * reason. Nothing is retried into a nicer-looking observation, and no synthetic
 * or substitute price is ever returned.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { createMarketFeed } from "../../market/feed.mjs";
import { MARKET_SOURCE_JUPITER, deriveMarket } from "../../market/normalize.mjs";
import { BENCHMARK_MARKET, DIRECTION_PHASE } from "./definition.mjs";

export const DIRECTION_OBSERVATION_VERSION = 1;

/** Bounded safety guard for the politeness wait (never an unbounded loop). */
export const POLITE_WAIT_MAX_STEPS = 2_000;

/**
 * The ONE implementation of the frozen outcome-selection ORDER rule: return the
 * FIRST observation that is the benchmark base mint AND was RECEIVED at or
 * after `targetAt`. Observations received before `targetAt` are skipped, never
 * used as a substitute. Purely temporal: it never looks at a prediction, a
 * probability or an outcome label.
 *
 * @param {{ observations?: Array<{mint?: string, receivedAtMs?: number, receivedAt?: string}>, targetAtMs?: number, baseMint?: string }} options
 * @returns {{ observation: object, receivedAtMs: number } | null}
 */
export function selectFirstPostTargetObservation({
  observations = [],
  targetAtMs,
  baseMint = BENCHMARK_MARKET.baseMint,
} = {}) {
  if (!Number.isFinite(targetAtMs)) return null;
  for (const observation of observations ?? []) {
    if (!observation || typeof observation !== "object") continue;
    if (baseMint !== null && observation.mint !== undefined && observation.mint !== baseMint) continue;
    const receivedAtMs = Number.isFinite(observation.receivedAtMs)
      ? observation.receivedAtMs
      : Date.parse(observation.receivedAt ?? "");
    if (!Number.isFinite(receivedAtMs)) continue;
    if (receivedAtMs >= targetAtMs) return { observation, receivedAtMs };
  }
  return null;
}

function boundedHealth(health) {
  if (!health || typeof health !== "object") return null;
  return {
    requestedMode: health.requestedMode ?? null,
    effectiveMode: health.effectiveMode ?? null,
    provider: health.provider ?? null,
    source: health.source ?? null,
    live: health.live === true,
    healthy: health.healthy === true,
    degraded: health.degraded === true,
    entriesPaused: health.entriesPaused === true,
    statusLabel: health.statusLabel ?? null,
    lastSuccessAt: health.lastSuccessAt ?? null,
    lastEndpoint: health.lastEndpoint ?? null,
    tokensTracked: Number.isFinite(health.tokensTracked) ? health.tokensTracked : null,
    errorCount: Number.isFinite(health.errorCount) ? health.errorCount : null,
    consecutiveFailures: Number.isFinite(health.consecutiveFailures) ? health.consecutiveFailures : null,
    lastErrorKind: health.lastErrorKind ?? null,
  };
}

function boundedUniverseSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    tracked: Number.isFinite(summary.tracked) ? summary.tracked : null,
    usable: Number.isFinite(summary.usable) ? summary.usable : null,
    fresh: Number.isFinite(summary.fresh) ? summary.fresh : null,
    max: Number.isFinite(summary.max) ? summary.max : null,
  };
}

/**
 * Create the SOL/USDC observation source.
 *
 * @param {{
 *   config: object,              // createMarketConfig() output (requestedMode MUST be "live")
 *   fetchImpl?: Function|null,   // injected for deterministic offline fixtures
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   market?: object,             // benchmark market (defaults to SOL/USDC)
 * }} options
 */
export function createSolDirectionObservationSource({
  config,
  fetchImpl = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  market = BENCHMARK_MARKET,
} = {}) {
  const feed = createMarketFeed({
    config,
    ...(typeof fetchImpl === "function" ? { fetchImpl } : {}),
    now,
  });

  /** Wait until the client itself allows another request. Never bypasses its limits. */
  async function awaitPoliteRequest() {
    let steps = 0;
    while (!feed.client.canRequest(now()) && steps < POLITE_WAIT_MAX_STEPS) {
      const nextIn = feed.client.status(now())?.nextAttemptInMs ?? 0;
      await sleep(Math.max(1, Math.min(250, nextIn)));
      steps += 1;
    }
    return steps < POLITE_WAIT_MAX_STEPS;
  }

  /** Exactly one read-only Tokens V2 GET, ingested into the existing universe. */
  async function pollOnce() {
    const polite = await awaitPoliteRequest();
    const at = now();
    const result = await feed.client.pollOnce(at);
    if (result?.ok === true) {
      feed.universe.ingest(result.tokens, { category: result.endpoint, at: result.at });
    }
    return { result, polite, requestedAt: at };
  }

  /**
   * One observation cycle: walk the configured endpoints in the client's own
   * rotation order, optionally stopping early as soon as the base mint appears
   * (used for the future reference, where measurement lag matters).
   */
  async function walkEndpoints({ stopWhenBaseFound = false, minBaseReceivedAtMs = null } = {}) {
    const cycleStartedAt = now();
    const polls = [];
    let base = null;
    let quote = null;

    for (let index = 0; index < config.endpoints.length; index += 1) {
      const { result, polite } = await pollOnce();
      polls.push({
        endpoint: result?.endpoint ?? null,
        ok: result?.ok === true,
        polite,
        kind: result?.kind ?? null,
        tokensReceived: Number.isFinite(result?.received) ? result.received : null,
        at: Number.isFinite(result?.at) ? result.at : null,
      });
      for (const token of result?.tokens ?? []) {
        // The FIRST base-mint observation received at or after the target instant
        // wins (see `selectFirstPostTargetObservation`); an earlier one is never
        // substituted, exactly as the frozen selection rule states.
        const receivedAt = Number.isFinite(result?.at) ? result.at : null;
        const postTarget = minBaseReceivedAtMs === null || (receivedAt !== null && receivedAt >= minBaseReceivedAtMs);
        if (token?.mint === market.baseMint && base === null && postTarget) {
          base = { at: result.at, endpoint: result.endpoint, token };
        }
        if (token?.mint === market.quoteMint && quote === null) {
          quote = { at: result.at, endpoint: result.endpoint, token };
        }
      }
      if (stopWhenBaseFound && base !== null) break;
    }

    return { cycleStartedAt, completedAt: now(), polls, base, quote };
  }

  /**
   * The VENUE's own timestamp for the reference token, when the payload supplied
   * one (`updatedAt`). It is never inferred, never replaced with our receipt time,
   * and persisted as `null` when absent (§25).
   */
  function sourceEventAtMsOf(token) {
    const value = token?.tokenUpdatedAt;
    return Number.isFinite(value) ? value : null;
  }

  function buildProbe(walk) {
    const completedAt = walk.completedAt;
    const markets = feed.markets(completedAt);
    const universeToken = feed.universe.get(market.baseMint);
    const baseMarket = universeToken
      ? deriveMarket(universeToken, {
          prev: universeToken.prevObservation ?? null,
          at: completedAt,
          staleMs: config.staleMs,
          momentumReference: config.momentumReference?.live,
        })
      : null;
    const quoteMarket = markets.find((entry) => entry.mint === market.quoteMint) ?? null;

    return {
      ok: walk.polls.some((poll) => poll.ok === true),
      cycleStartedAt: walk.cycleStartedAt,
      completedAt,
      baseObservedAt: walk.base?.at ?? null,
      baseSourceEventAt: sourceEventAtMsOf(walk.base?.token ?? universeToken),
      baseEndpoint: walk.base?.endpoint ?? null,
      quoteObservedAt: walk.quote?.at ?? null,
      observedBaseThisCycle: walk.base !== null,
      observedQuoteThisCycle: walk.quote !== null,
      baseMarket,
      quoteMarket,
      universeToken: universeToken ?? null,
      universeMarkets: markets,
      universeSummary: boundedUniverseSummary(feed.universe.summary(completedAt)),
      health: {
        ...boundedHealth(feed.health(completedAt)),
        endpoints: config.endpoints.map((endpoint) => endpoint.label),
      },
      polls: walk.polls,
    };
  }

  function refusal(reason, probeResult) {
    return { ok: false, reason, probe: { ...probeResult, universeMarkets: undefined } };
  }

  function assertGenuineState(probeResult) {
    if (config.requestedMode !== "live") return "market_mode_not_live";
    if (!probeResult.ok) return "observation_cycle_failed";
    if (!probeResult.observedBaseThisCycle) return "reference_market_absent_from_observation";
    if (!probeResult.baseMarket) return "reference_market_unavailable";
    if (probeResult.baseMarket.synthetic === true || probeResult.baseMarket.source !== MARKET_SOURCE_JUPITER) {
      return "non_genuine_market_source";
    }
    if (!Number.isFinite(probeResult.baseMarket.price) || probeResult.baseMarket.price <= 0) {
      return "reference_price_unusable";
    }
    return null;
  }

  /** Validate one full cycle as benchmark STATE (pre-t0). Never invents a price. */
  async function observeState() {
    const probeResult = buildProbe(await walkEndpoints());
    const reason = assertGenuineState(probeResult);
    if (reason !== null) return refusal(reason, probeResult);

    return {
      ok: true,
      reason: null,
      // receivedAt is the instant EVOLVE received the reference observation. It is
      // NOT the venue's source time, which is carried separately (or null).
      stateObservedAt: new Date(probeResult.baseObservedAt).toISOString(),
      stateObservedAtMs: probeResult.baseObservedAt,
      receivedAt: new Date(probeResult.baseObservedAt).toISOString(),
      sourceEventAt: probeResult.baseSourceEventAt === null ? null : new Date(probeResult.baseSourceEventAt).toISOString(),
      sourceEventAtMs: probeResult.baseSourceEventAt,
      probeCompletedAtMs: probeResult.completedAt,
      probeStartedAtMs: probeResult.cycleStartedAt,
      probeWindowMs: probeResult.completedAt - probeResult.cycleStartedAt,
      baseEndpoint: probeResult.baseEndpoint,
      polls: probeResult.polls,
      market: probeResult.baseMarket,
      token: probeResult.universeToken,
      quoteMarket: probeResult.quoteMarket,
      quoteObservationAvailable: probeResult.observedQuoteThisCycle && probeResult.quoteMarket !== null,
      universeMarkets: probeResult.universeMarkets,
      universeSummary: probeResult.universeSummary,
      health: probeResult.health,
    };
  }

  /**
   * Validate one cycle as the FUTURE reference (at/after targetAt). Stops as soon
   * as the base mint is observed, so the resolution lag stays as small as the
   * venue's own data allows. Never rebuilds or touches the Jev input.
   */
  async function observeFuture({ targetAtMs = null } = {}) {
    const probeResult = buildProbe(
      await walkEndpoints({
        stopWhenBaseFound: true,
        minBaseReceivedAtMs: Number.isFinite(targetAtMs) ? targetAtMs : null,
      }),
    );
    const reason = assertGenuineState(probeResult);
    if (reason !== null) {
      return refusal(reason === "reference_market_absent_from_observation" ? "future_reference_absent_from_observation" : reason, probeResult);
    }

    return {
      ok: true,
      reason: null,
      // The SELECTED outcome observation: when EVOLVE received it, plus the
      // venue's own source time when the payload supplied one.
      outcomeObservedAt: new Date(probeResult.baseObservedAt).toISOString(),
      outcomeObservedAtMs: probeResult.baseObservedAt,
      outcomeReceivedAt: new Date(probeResult.baseObservedAt).toISOString(),
      outcomeReceivedAtMs: probeResult.baseObservedAt,
      outcomeSourceEventAt: probeResult.baseSourceEventAt === null ? null : new Date(probeResult.baseSourceEventAt).toISOString(),
      outcomeSourceEventAtMs: probeResult.baseSourceEventAt,
      probeCompletedAtMs: probeResult.completedAt,
      probeWindowMs: probeResult.completedAt - probeResult.cycleStartedAt,
      baseEndpoint: probeResult.baseEndpoint,
      polls: probeResult.polls,
      price: probeResult.baseMarket.price,
      market: probeResult.baseMarket,
      health: probeResult.health,
    };
  }

  return {
    phase: DIRECTION_PHASE,
    version: DIRECTION_OBSERVATION_VERSION,
    market,
    config,
    feed,
    walkEndpoints,
    observeState,
    observeFuture,
    close: () => feed.stop(),
  };
}
