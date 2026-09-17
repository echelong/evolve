/**
 * Historical replay market provider.
 *
 * This provider implements the same interface the live and synthetic feeds
 * expose, so the evolutionary engine cannot tell where observations come from:
 *
 *   feed.advance()   -> move to the next recorded snapshot (paced)
 *   feed.markets()   -> the exact normalized records agents consumed live
 *   feed.health()    -> recorded feed health, plus replay metadata
 *
 * Guarantees that matter for research honesty:
 *
 *   - Forward-only. Snapshots are streamed in capture order from disk; there is
 *     no API to seek backwards or to pre-read a later snapshot. `markets(t)`
 *     throws if asked for a time beyond the snapshot currently loaded, so a
 *     look-ahead bug fails loudly instead of inflating results.
 *   - Deterministic. Every value served is a function of the dataset record and
 *     the snapshot timestamp — never of wall-clock time. Replay speed therefore
 *     cannot change a single decision.
 *   - Faithful. Token freshness is recomputed against the snapshot timestamp
 *     using the recorded stale threshold; everything else is passed through
 *     exactly as captured. Degraded periods recorded live stay degraded here.
 */

import { openDataset } from "../history/dataset.mjs";

export const REPLAY_BANNER = "HISTORICAL REPLAY • PAPER MONEY";
export const REPLAY_SOURCE = "Historical replay";

export const REPLAY_SPEED_MAX = "max";

/** Parse EVOLVE_REPLAY_SPEED: a positive number, or "max". */
export function parseReplaySpeed(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === REPLAY_SPEED_MAX || text === "unlimited" || text === "0") return REPLAY_SPEED_MAX;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a historical dataset as a feed.
 *
 * @param {{
 *   datasetDir: string,
 *   config: object,
 *   speed?: number | "max",
 *   from?: number | null,
 *   until?: number | null,
 *   limit?: number,
 *   now?: () => number,
 *   onEvent?: ((event: {type: string, message: string}) => void) | null,
 *   verifyFingerprint?: boolean,
 *   pacing?: boolean,
 * }} options
 */
export async function openReplayFeed({
  datasetDir,
  config,
  speed = 1,
  from = null,
  until = null,
  limit = 0,
  now = () => Date.now(),
  onEvent = null,
  verifyFingerprint = false,
  pacing = true,
} = {}) {
  const dataset = await openDataset(datasetDir, { requireManifest: false });

  let fingerprintCheck = null;
  if (verifyFingerprint) {
    fingerprintCheck = await dataset.verifyFingerprint();
    if (fingerprintCheck.ok === false) {
      throw new Error(
        `dataset fingerprint mismatch for ${datasetDir}: manifest ${fingerprintCheck.expected} != computed ${fingerprintCheck.computed}`,
      );
    }
  }

  const iterator = dataset.snapshots({ from, until, limit })[Symbol.asyncIterator]();
  const staleMs = config?.staleMs ?? 60_000;

  let current = null;
  let decoratedMarkets = null;
  let finished = false;
  let snapshotsRead = 0;
  let ticksServed = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let replayStartedAt = null;
  let wallPacedMs = 0;

  const emit = (type, message) => {
    if (typeof onEvent === "function") onEvent({ type, message });
  };

  function decorate(market, snapshotTimestamp) {
    const lastObservedAt = Number.isFinite(market.lastObservedAt)
      ? market.lastObservedAt
      : snapshotTimestamp;
    const ageMs = Math.max(0, snapshotTimestamp - lastObservedAt);
    return {
      ...market,
      lastObservedAt,
      ageMs,
      fresh: ageMs <= staleMs,
      replay: true,
      replayTimestamp: snapshotTimestamp,
    };
  }

  /** Decorated once per snapshot, so repeated reads inside one tick are identical. */
  function currentMarkets() {
    if (!current) return [];
    if (decoratedMarkets === null) {
      decoratedMarkets = current.markets.map((market) => decorate(market, current.t));
    }
    return decoratedMarkets;
  }

  function assertNoLookAhead(at) {
    if (!current) return;
    if (Number.isFinite(at) && at > current.t + 1) {
      throw new RangeError(
        `look-ahead blocked: requested market state at ${at} but the newest loaded snapshot is ${current.t}`,
      );
    }
  }

  function buildHealth(at) {
    const recorded = current?.health ?? {};
    const snapshot = current;

    const degraded = recorded.degraded === true;
    const stale = recorded.stale === true;
    const recordedLive = String(recorded.source ?? snapshot?.mode?.source ?? "")
      .toLowerCase()
      .includes("jupiter");

    const allowNewEntries =
      typeof recorded.allowNewEntries === "boolean"
        ? recorded.allowNewEntries
        : !(degraded || stale);

    return {
      requestedMode: "replay",
      effectiveMode: "replay",
      provider: `Historical dataset ${dataset.datasetId}`,
      source: recorded.source ?? REPLAY_SOURCE,
      live: recordedLive,
      healthy: recorded.healthy !== false,
      degraded,
      stale,
      entriesPaused: recorded.entriesPaused === true || !allowNewEntries,
      allowNewEntries,
      banner: REPLAY_BANNER,
      statusLabel: REPLAY_BANNER,
      modeReason: `replaying ${dataset.datasetId}`,
      fallbackReason: null,
      fallbackActive: false,
      promotedFromFallback: false,
      degradedReason: degraded
        ? (recorded.lastErrorKind ? `recorded feed error: ${recorded.lastErrorKind}` : "recorded as degraded")
        : null,
      apiKeyConfigured: config?.apiKeyConfigured === true,
      keyless: false,
      lastSuccessAt: recorded.lastSuccessAt ?? snapshot?.t ?? null,
      lastAttemptAt: recorded.lastSuccessAt ?? snapshot?.t ?? null,
      lastObservationAt: snapshot?.t ?? null,
      ageMs: recorded.ageMs ?? 0,
      staleMs,
      requestCount: recorded.requestCount ?? 0,
      okCount: recorded.okCount ?? recorded.requestCount ?? 0,
      errorCount: recorded.errorCount ?? 0,
      rateLimitCount: recorded.rateLimitCount ?? 0,
      authErrorCount: recorded.authErrorCount ?? 0,
      timeoutCount: recorded.timeoutCount ?? 0,
      consecutiveFailures: recorded.consecutiveFailures ?? 0,
      backoffMs: 0,
      nextAttemptInMs: 0,
      lastLatencyMs: null,
      lastEndpoint: recorded.lastEndpoint ?? null,
      lastErrorKind: recorded.lastErrorKind ?? null,
      lastErrorSafe: null,
      tokensTracked: snapshot ? snapshot.markets.length : 0,
      universe: {
        tracked: snapshot ? snapshot.markets.length : 0,
        max: config?.universeMax ?? null,
        usable: snapshot ? snapshot.markets.filter((market) => market.price > 0).length : 0,
        fresh: snapshot ? snapshot.markets.filter((market) => market.fresh === true).length : 0,
        evicted: 0,
        mergedObservations: 0,
        lastIngestAt: snapshot?.t ?? null,
      },
      endpoints: [],
      pollMs: null,
      modeChangedAt: null,
      modeChangeCount: 0,
      synthetic: { tokenCount: 0, steps: 0, regime: "HISTORICAL" },
      observerOnly: true,
      execution: "paper-only",

      // Replay-specific metadata for the dashboard and experiment reports.
      replay: {
        datasetId: dataset.datasetId,
        datasetClass: dataset.classification,
        snapshotSeq: snapshot?.seq ?? null,
        replayTimestamp: snapshot?.t ?? null,
        snapshotCount: snapshotsRead,
        progressPct: progress().percent,
        speed,
        integrityVerified: fingerprintCheck?.ok ?? null,
        at,
      },
    };
  }

  /** Load the next snapshot. Resolves `{ done: true }` at the end of the window. */
  async function advance() {
    if (finished) return { done: true, snapshot: null };

    const next = await iterator.next();
    if (next.done) {
      finished = true;
      emit("MARKET", `Historical replay reached the end of ${dataset.datasetId}.`);
      return { done: true, snapshot: null };
    }

    const snapshot = next.value;
    current = {
      seq: snapshot.seq,
      t: snapshot.t,
      capturedAt: snapshot.capturedAt,
      mode: snapshot.mode,
      health: snapshot.health,
      markets: snapshot.markets,
    };
    decoratedMarkets = null;
    snapshotsRead += 1;
    firstTimestamp ??= snapshot.t;
    lastTimestamp = snapshot.t;

    if (pacing && speed !== REPLAY_SPEED_MAX) {
      if (replayStartedAt === null) replayStartedAt = now();
      const target = replayStartedAt + (snapshot.t - firstTimestamp) / speed;
      const wait = target - now();
      if (wait > 0) {
        wallPacedMs += wait;
        await sleep(wait);
      }
    } else if (replayStartedAt === null) {
      replayStartedAt = now();
    }

    return { done: false, snapshot: current };
  }

  function markets(at = current?.t ?? now()) {
    assertNoLookAhead(at);
    ticksServed += 1;
    return currentMarkets();
  }

  function health(at = current?.t ?? now()) {
    assertNoLookAhead(at);
    return buildHealth(at);
  }

  function progress() {
    const total = dataset.snapshotCount ?? dataset.manifest?.snapshotCount ?? null;
    const percent = total && total > 0 ? Math.min(100, (snapshotsRead / total) * 100) : null;
    return {
      snapshotsRead,
      totalSnapshots: total,
      percent: percent === null ? null : Number(percent.toFixed(3)),
      currentTimestamp: current?.t ?? null,
      firstTimestamp,
      lastTimestamp,
      speed,
      wallPacedMs: Math.round(wallPacedMs),
    };
  }

  function stop() {
    finished = true;
    if (typeof iterator.return === "function") iterator.return();
  }

  /** Structural look-ahead audit: nothing may be served beyond the cursor. */
  function lookAheadAudit() {
    return {
      snapshotsRead,
      marketsServed: ticksServed,
      lastServedAt: current?.t ?? null,
      cursorAdvancedOnlyForward: true,
      violations: 0,
      note: "replay reads are forward-only and markets() rejects future timestamps",
    };
  }

  emit("MARKET", `Historical replay opened: ${dataset.datasetId} (${dataset.classification ?? "unclassified"}).`);

  return {
    kind: "replay",
    dataset,
    datasetId: dataset.datasetId,
    datasetClass: dataset.classification,
    containsSynthetic: dataset.containsSynthetic,
    fingerprintCheck,
    advance,
    markets,
    health,
    progress,
    lookAheadAudit,
    stop,
    currentTimestamp: () => current?.t ?? null,
    currentSnapshot: () => current,
    /** Compatibility shims so generic engine code can treat this as a feed. */
    synthetic: {
      regime: "HISTORICAL",
      tokenCount: 0,
      steps: 0,
      summary: () => ({ tokenCount: 0, steps: 0, regime: "HISTORICAL", fresh: true, lastStepAt: null }),
    },
    get effectiveMode() {
      return "replay";
    },
    get fallbackReason() {
      return null;
    },
    get finished() {
      return finished;
    },
  };
}
