import { redact } from './definition.mjs';
import { normalizeGmgn, normalizeDex, normalizeJupiterMarkets } from './normalize.mjs';
import { aggregate } from './aggregate.mjs';
import { createStorage } from './storage.mjs';
import { createGmgnProvider } from './providers/gmgn.mjs';
import { createDexProvider } from './providers/dexscreener.mjs';
import { createLaunchObserver } from './providers/launch-observer.mjs';

export function createIntelligenceRecorder({ config, feed = null, storage = createStorage({ ...config, secrets: config.secrets }), gmgn = createGmgnProvider({ config: config.gmgn }), dex = createDexProvider({ config: config.dex }), launch = createLaunchObserver({ config: config.launch }), now = Date.now } = {}) {
  const latest = new Map(), persisted = new Set(), normalizationErrors = {}, latestFailure = {};
  let cursor = 0, cycle = 0, stopped = false, lastStats = {}, independentErrors = 0;
  const key = r => [r.provider, r.mint, r.sourceEndpoint, r.normalized.pairAddress ?? ''].join(':');
  function error(provider, code) { latestFailure[provider] = true; independentErrors++; normalizationErrors[provider] = (normalizationErrors[provider] ?? 0) + 1; storage.error(provider, code, now()); }
  function record(record, payload, identity) {
    // Receipt stays unchanged across cache hits. Persist each observation only once.
    const identityKey = `${key(record)}:${record.receivedAt}:${record.normalizedPayloadDigest}`;
    if (!persisted.has(identityKey)) {
      storage.writeObservation(record, payload, identity); persisted.add(identityKey);
      // The ledger itself is bounded; session capacity stops capture before unlimited growth.
    }
    latest.set(key(record), record);
  }
  async function collect(provider, result, normalizer) {
    if (result.unavailable) { if (!/DISABLED|CYCLE_BUDGET|BACKOFF|BUSY/.test(result.unavailable)) error(provider, result.unavailable); return; }
    const safe = { ...result, payload: redact(result.payload, config.secrets) };
    const records = normalizer(safe, { mint: result.requestIdentity, observedAt: now(), staleMs: provider === 'gmgn' ? config.gmgn.staleMs : config.dex.staleMs });
    if (!records.length && (provider === 'gmgn' && result.kind !== 'trenches' || provider === 'dexscreener' && !Array.isArray(result.payload))) error(provider, 'MALFORMED_PAYLOAD');
    if (records.length || provider === 'dexscreener' && Array.isArray(result.payload) || result.kind === 'trenches') latestFailure[provider] = false;
    if (!records.length) storage.writeRawResponse(safe, provider);
    for (const r of records) record(r, safe.payload, result.requestIdentity);
  }
  return Object.freeze({
    async capture({ markets = feed?.markets(now()) ?? [], mints = null } = {}) {
      if (stopped) throw new Error('Recorder stopped');
      const safeMarkets = redact(markets, config.secrets);
      for (const r of normalizeJupiterMarkets(safeMarkets, { observedAt: now(), staleMs: config.jupiterStaleMs })) record(r, safeMarkets.find(m => m.mint === r.mint));
      const identities = [...new Set(mints ?? safeMarkets.filter(m => !m.synthetic && m.source === 'Jupiter Tokens V2').map(m => m.mint))].sort();
      const selected = [];
      for (let i = 0; i < Math.min(identities.length, config.dex.maxRequests); i++) selected.push(identities[(cursor + i) % identities.length]);
      cursor += selected.length;
      for (const mint of selected) {
        try { await collect('dexscreener', await dex.observe(mint), normalizeDex); } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('dexscreener', 'NORMALIZATION_FAILED'); }
      }
      // Rotate per-mint routes to avoid spending the entire GMGN budget on one route.
      const kinds = ['info', 'security', 'pool', 'holders', 'traders'];
      let budget = Math.max(0, config.gmgn.maxRequests - 1);
      for (const mint of selected) {
        if (budget-- <= 0) break;
        try { await collect('gmgn', await gmgn.observe(kinds[cycle % kinds.length], mint), normalizeGmgn); } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('gmgn', 'NORMALIZATION_FAILED'); }
      }
      if (config.gmgn.maxRequests >= 1) {
        try { await collect('gmgn', await gmgn.observe('trenches'), normalizeGmgn); } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('gmgn', 'NORMALIZATION_FAILED'); }
      }
      try {
        for (const event of await launch.poll()) {
          if (!event?.record || event.payload === undefined) { error('launch-observer', 'MALFORMED_PAYLOAD'); continue; }
          record(event.record, event.payload);
        }
      } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('launch-observer', 'OBSERVATION_FAILED'); }
      const at = now();
      // Limit retained identities independently of disk limits. Stale evidence remains on disk.
      for (const [k, r] of latest) if (at - r.providerObservedAt > Math.max(r.staleness.budgetMs * 4, 300000)) latest.delete(k);
      if (latest.size > 10000) throw new Error('SESSION_STORAGE_IDENTITY_BOUND');
      const snapshots = aggregate([...latest.values()], { observedAt: at, alignmentMs: config.alignmentMs });
      for (const snapshot of snapshots) storage.writeSnapshot(snapshot);
      const health = { jupiter: feed?.health() ?? { state: 'EXTERNAL_RECORD_COPY' }, gmgn: gmgn.health(), dexscreener: dex.health(), launch: launch.health() };
      for (const provider of ['gmgn', 'dexscreener']) if (normalizationErrors[provider]) health[provider] = { ...health[provider], state: latestFailure[provider] ? 'DEGRADED' : health[provider].state, recordedErrors: normalizationErrors[provider] };
      lastStats = { mints: snapshots.length,
        providers: Object.fromEntries(['jupiter', 'gmgn', 'dexscreener'].map(p => [p, new Set([...latest.values()].filter(r => r.provider === p).map(r => r.mint)).size])),
        freshJoined: snapshots.filter(s => s.disagreement.metrics.alignedSourceCount >= 2).length, launchEvents: launch.health().events,
        errors: independentErrors + (health.jupiter.errorCount ?? 0), health,
        priceRangeBps: snapshots.map(s => s.features.crossSourcePriceRangeBps).filter(v => v !== null) };
      cycle++; return { snapshots, ...lastStats };
    },
    finalize(reason = 'complete') { stopped = true; launch.stop(); return storage.finalize({ endedAt: now(), reason, health: lastStats.health ?? {}, metrics: { mintsJoined: lastStats.mints ?? 0, freshJoined: lastStats.freshJoined ?? 0, launchEvents: lastStats.launchEvents ?? 0, providerErrors: lastStats.errors ?? 0, priceRangeBps: { count: lastStats.priceRangeBps?.length ?? 0, max: lastStats.priceRangeBps?.length ? Math.max(...lastStats.priceRangeBps) : null } } }); },
    health: () => ({ gmgn: gmgn.health(), dexscreener: dex.health(), launch: launch.health() }), dir: storage.dir,
  });
}
