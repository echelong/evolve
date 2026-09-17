/**
 * Market feed orchestrator.
 *
 * One object owns the whole observation lifecycle and answers three questions
 * for the rest of the engine:
 *
 *   feed.advance()  -> "look at the market now" (polls Jupiter when due)
 *   feed.markets()  -> normalized market records for agents + dashboard
 *   feed.health()   -> secret-free feed state, banner text, entry permission
 *
 * Mode rules (no silent behaviour anywhere):
 *
 *   synthetic  always the Phase 1 simulator. Never touches the network.
 *   live       requires genuine live observations. Missing key, failed
 *              requests, or stale data => degraded + new entries paused.
 *              It NEVER falls back to synthetic data.
 *   auto       try live; if live cannot be established or stops working,
 *              fall back to synthetic EXPLICITLY (banner + event + reason),
 *              and keep probing live so it can be promoted back.
 */

import { JupiterTokensClient, FAILURE_KIND, FAILURE_LABELS } from "./jupiter.mjs";
import { MARKET_SOURCE_JUPITER, MARKET_SOURCE_SYNTHETIC, MOMENTUM_REFERENCE, deriveMarket, toFiniteNumber } from "./normalize.mjs";
import { SyntheticMarketProvider } from "./synthetic.mjs";
import { MarketUniverse } from "./universe.mjs";

export const MODE = Object.freeze({ AUTO: "auto", LIVE: "live", SYNTHETIC: "synthetic" });

export const SOURCE_LABEL = Object.freeze({
  live: MARKET_SOURCE_JUPITER,
  synthetic: MARKET_SOURCE_SYNTHETIC,
});

/** The three exact banner strings required by the Phase 2 spec. */
export const BANNER = Object.freeze({
  LIVE: "LIVE SOLANA DATA • PAPER MONEY",
  DEGRADED: "LIVE FEED DEGRADED • NEW ENTRIES PAUSED",
  SYNTHETIC: "SYNTHETIC MARKET • PAPER MONEY",
});

export function bannerFor({ effectiveMode, degraded }) {
  if (effectiveMode === MODE.LIVE) return degraded ? BANNER.DEGRADED : BANNER.LIVE;
  return BANNER.SYNTHETIC;
}

export function createMarketFeed({
  config,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  onEvent = null,
} = {}) {
  const client = new JupiterTokensClient({ config, fetchImpl, now, random });
  const universe = new MarketUniverse({
    max: config.universeMax,
    ttlMs: config.tokenTtlMs,
    staleMs: config.staleMs,
    minLiquidityUsd: config.minLiquidityUsd,
    now,
  });
  const synthetic = new SyntheticMarketProvider({
    tokenCount: config.syntheticUniverseSize,
    now,
    random,
    staleMs: config.staleMs,
    tickMs: config.engine.tickMs,
  });

  const state = {
    effectiveMode: MODE.SYNTHETIC,
    modeReason: "not started",
    fallbackReason: null,
    modeChangedAt: null,
    modeChangeCount: 0,
    promotedFromFallback: false,
    nextLiveProbeAt: 0,
    lastAdvanceAt: null,
    lastDegradedEmit: null,
    lastEntryPaused: null,
  };

  // auto starts in the live attempt state so that a fallback to synthetic is an
  // explicit, event-logged transition instead of a silent initial condition.
  if (config.requestedMode === MODE.SYNTHETIC) {
    state.effectiveMode = MODE.SYNTHETIC;
    state.modeReason = "requested synthetic";
  } else if (config.requestedMode === MODE.LIVE) {
    state.effectiveMode = MODE.LIVE;
    state.modeReason = config.apiKeyConfigured
      ? "live mode requested"
      : "live mode requires JUPITER_API_KEY";
  } else {
    state.effectiveMode = MODE.LIVE;
    state.modeReason = "acquiring live observation";
  }

  const emit = (type, message) => {
    if (typeof onEvent === "function") onEvent({ type, message });
  };

  const keylessUsable = () => config.keylessAllowed === true && !config.apiKeyConfigured;

  /**
   * Live observation is only attempted when it can actually be trusted:
   *   - forced live mode requires a configured JUPITER_API_KEY
   *   - auto mode may additionally try keyless access, then fall back
   */
  function canAttemptLive() {
    if (config.apiKeyConfigured) return true;
    return config.requestedMode === MODE.AUTO && keylessUsable();
  }

  function setMode(next, reason, at, { event = null } = {}) {
    if (state.effectiveMode === next && !event) return;
    state.effectiveMode = next;
    state.modeReason = reason;
    state.modeChangedAt = at;
    state.modeChangeCount += 1;
    if (event) emit(event.type, event.message);
  }

  function ingest(result) {
    if (!result?.ok) return;
    universe.ingest(result.tokens, { category: result.endpoint, at: result.at });
  }

  function liveSnapshotFresh(at) {
    const lastSuccessAt = client.lastSuccessAt;
    if (lastSuccessAt === null) return false;
    return at - lastSuccessAt <= config.staleMs;
  }

  function shouldFallBackToSynthetic(at) {
    if (config.requestedMode !== MODE.AUTO) return false;
    if (!config.allowSyntheticFallback) return false;
    if (state.effectiveMode !== MODE.LIVE) return false;
    if (!canAttemptLive()) return true;
    if (liveSnapshotFresh(at)) return false;
    // A rejected API key will not fix itself by retrying, so degrade fast.
    if (client.lastErrorKind === FAILURE_KIND.AUTH) return true;
    return client.consecutiveFailures >= config.autoFallbackFailures;
  }

  /**
   * One observation cycle. Safe to call on a timer: it respects both the poll
   * interval and the client's exponential backoff.
   */
  async function advance(at = now()) {
    state.lastAdvanceAt = at;
    let lastPoll = null;

    if (config.requestedMode === MODE.SYNTHETIC) {
      synthetic.step(at);
      if (state.effectiveMode !== MODE.SYNTHETIC) {
        setMode(MODE.SYNTHETIC, "requested synthetic", at);
      }
    } else if (state.effectiveMode === MODE.LIVE) {
      if (!canAttemptLive()) {
        // Forced live without a key: stay degraded, never fabricate data.
        setMode(MODE.LIVE, "live mode requires JUPITER_API_KEY", at, {
          event:
            state.lastEntryPaused === true
              ? null
              : {
                  type: "MARKET",
                  message: "Live mode requested without JUPITER_API_KEY — paper entries paused.",
                },
        });
      } else if (client.canRequest(at)) {
        lastPoll = await client.pollOnce(at);
        ingest(lastPoll);
      }
    } else {
      // Synthetic fallback (auto mode): keep the paper market alive while
      // probing the live provider on a slow cadence.
      synthetic.step(at);

      if (at >= state.nextLiveProbeAt) {
        state.nextLiveProbeAt = at + config.syntheticRetryMs;
        if (canAttemptLive() && client.canRequest(at)) {
          lastPoll = await client.pollOnce(at);
          ingest(lastPoll);
          if (lastPoll.ok && universe.size > 0) {
            setMode(MODE.LIVE, "live observation restored", at, {
              event: {
                type: "MARKET",
                message: `Live Solana market data restored via ${client.lastEndpoint}.`,
              },
            });
            state.fallbackReason = null;
            state.promotedFromFallback = true;
          }
        }
      }
    }

    // Auto mode: explicit, event-logged fallback to the synthetic simulator.
    if (shouldFallBackToSynthetic(at)) {
      const reason =
        !canAttemptLive()
          ? config.apiKeyConfigured
            ? "live keyless access disabled"
            : "no JUPITER_API_KEY configured"
          : (client.lastErrorSafe ?? "live market unavailable");

      state.fallbackReason = reason;
      state.promotedFromFallback = false;
      setMode(MODE.SYNTHETIC, "auto fallback", at, {
        event: {
          type: "MARKET",
          message: `Live market unavailable (${reason}). Falling back to SYNTHETIC paper market.`,
        },
      });
    }

    const health = buildHealth(at);

    if (health.entriesPaused !== state.lastEntryPaused) {
      state.lastEntryPaused = health.entriesPaused;
      if (health.entriesPaused) {
        emit("MARKET", "Live feed degraded — new paper entries paused.");
      } else if (state.effectiveMode === MODE.LIVE) {
        emit("MARKET", "Live feed healthy — new paper entries enabled.");
      }
    }

    return { health, poll: lastPoll };
  }

  /** True when the active mode has the credentials it requires. */
  function apiKeySatisfied() {
    if (config.apiKeyConfigured) return true;
    return config.requestedMode === MODE.AUTO && keylessUsable();
  }

  function tokensTracked() {
    return state.effectiveMode === MODE.LIVE ? universe.size : synthetic.tokens.length;
  }

  function buildHealth(at = now()) {
    const live = state.effectiveMode === MODE.LIVE;
    const lastSuccessAt = client.lastSuccessAt;
    const ageMs = lastSuccessAt === null ? null : Math.max(0, at - lastSuccessAt);
    const stale = live ? ageMs === null || ageMs > config.staleMs : false;
    const tracked = tokensTracked();
    const missingKey = live && !apiKeySatisfied();
    const degraded = live && Boolean(stale || missingKey || tracked === 0);
    const entriesPaused = degraded;
    const clientStatus = client.status(at);

    let degradedReason = null;
    if (degraded) {
      if (missingKey) degradedReason = "JUPITER_API_KEY is not configured";
      else if (tracked === 0) degradedReason = clientStatus.lastErrorSafe ?? "no valid token observations yet";
      else if (stale)
        degradedReason =
          lastSuccessAt === null
            ? "no successful live observation yet"
            : `last successful observation ${Math.round((ageMs ?? 0) / 1000)}s ago`;
    }

    return {
      requestedMode: config.requestedMode,
      effectiveMode: state.effectiveMode,
      provider:
        state.effectiveMode === MODE.LIVE
          ? "Jupiter Developer Platform (Tokens V2)"
          : "Internal synthetic simulator",
      source: SOURCE_LABEL[state.effectiveMode],
      live,
      healthy: !degraded,
      degraded,
      stale,
      entriesPaused,
      allowNewEntries: !entriesPaused,
      banner: bannerFor({ effectiveMode: state.effectiveMode, degraded }),
      statusLabel: degraded
        ? BANNER.DEGRADED
        : state.effectiveMode === MODE.LIVE
          ? BANNER.LIVE
          : BANNER.SYNTHETIC,
      modeReason: state.modeReason,
      fallbackReason: state.fallbackReason,
      fallbackActive: state.effectiveMode === MODE.SYNTHETIC && config.requestedMode === MODE.AUTO,
      promotedFromFallback: state.promotedFromFallback,
      degradedReason,
      apiKeyConfigured: config.apiKeyConfigured,
      keyless: keylessUsable(),
      lastSuccessAt,
      lastAttemptAt: client.lastAttemptAt,
      lastObservationAt: universe.lastIngestAt,
      ageMs,
      staleMs: config.staleMs,
      requestCount: clientStatus.requestCount,
      okCount: clientStatus.okCount,
      errorCount: clientStatus.errorCount,
      rateLimitCount: clientStatus.rateLimitCount,
      authErrorCount: clientStatus.authErrorCount,
      timeoutCount: clientStatus.timeoutCount,
      consecutiveFailures: clientStatus.consecutiveFailures,
      backoffMs: clientStatus.backoffMs,
      nextAttemptInMs: clientStatus.nextAttemptInMs,
      lastLatencyMs: clientStatus.lastLatencyMs,
      lastEndpoint: clientStatus.lastEndpoint,
      lastErrorKind: clientStatus.lastErrorKind,
      lastErrorSafe: clientStatus.lastErrorSafe,
      tokensTracked: tracked,
      universe: universe.summary(at),
      endpoints: config.endpoints.map((endpoint) => endpoint.label),
      pollMs: config.pollMs,
      modeChangedAt: state.modeChangedAt,
      modeChangeCount: state.modeChangeCount,
      synthetic: synthetic.summary(at),
      observerOnly: true,
      execution: "paper-only",
    };
  }

  /**
   * Normalized market records. Live records use only observed prices; no
   * ticks are ever invented between observations.
   */
  function markets(at = now()) {
    if (state.effectiveMode === MODE.LIVE) {
      const out = [];
      for (const token of universe.values(at)) {
        const price = toFiniteNumber(token.usdPrice);
        const liquidity = toFiniteNumber(token.liquidity);
        if (price === null || price <= 0) continue;
        if (liquidity === null || liquidity < 0) continue;

        out.push(
          deriveMarket(token, {
            prev: token.prevObservation ?? null,
            at,
            staleMs: config.staleMs,
            momentumReference: config.momentumReference.live,
          }),
        );
      }

      return out;
    }

    const tokens = synthetic.tokensAt(at);

    return tokens.map((token) =>
      deriveMarket(token, {
        prev: token.prevObservation ?? null,
        at,
        staleMs: config.staleMs,
        momentumReference: config.momentumReference.synthetic,
      }),
    );
  }

  function health(at = now()) {
    return buildHealth(at);
  }

  let timer = null;
  let inFlight = false;

  function start({ intervalMs = 1000 } = {}) {
    if (timer) return;
    const cadence = Math.max(200, Math.min(intervalMs, config.pollMs));
    timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await advance(now());
      } catch (error) {
        emit("MARKET", `Market observation cycle failed: ${error?.message ?? "unknown error"}`);
      } finally {
        inFlight = false;
      }
    }, cadence);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Read-only single probe used by the CLI and validation, never by the loop. */
  async function probe(at = now()) {
    const result = await client.pollOnce(at);
    ingest(result);
    return result;
  }

  async function probeAll(at = now()) {
    const result = await client.pollAll(at, { spacing: 0 });
    for (const entry of result.results) ingest(entry);
    return result;
  }

  function markMode(mode, reason, at = now()) {
    setMode(mode, reason, at);
  }

  return {
    config,
    client,
    universe,
    synthetic,
    advance,
    markets,
    health,
    tokensTracked,
    start,
    stop,
    probe,
    probeAll,
    markMode,
    get effectiveMode() {
      return state.effectiveMode;
    },
    get fallbackReason() {
      return state.fallbackReason;
    },
    failureLabels: FAILURE_LABELS,
    failureKinds: FAILURE_KIND,
    momentumReference: MOMENTUM_REFERENCE,
  };
}
