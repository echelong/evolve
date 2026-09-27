import { redact, digest } from './definition.mjs';
import { normalizeGmgn, normalizeDex, normalizeJupiterMarkets, jupiterAdapterPayload } from './normalize.mjs';
import { aggregate } from './aggregate.mjs';
import { createStorage } from './storage.mjs';
import { createGmgnProvider } from './providers/gmgn.mjs';
import { createDexProvider } from './providers/dexscreener.mjs';
import { createLaunchObserver } from './providers/launch-observer.mjs';

export function createIntelligenceRecorder({ config, feed = null, storage = createStorage({ ...config, secrets: config.secrets }), gmgn = createGmgnProvider({ config: config.gmgn }), dex = createDexProvider({ config: config.dex }), launch = createLaunchObserver({ config: config.launch }), now = Date.now } = {}) {
  const latest = new Map(), persisted = new Set(), normalizationErrors = {}, latestFailure = {};
  const jupiterReceipts = new Map(), gmgnRouteCursors = new Map();
  let cursor = 0, gmgnCursor = 0, stopped = false, lastStats = {}, independentErrors = 0;
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
      const copiedAt = now();
      for (const market of safeMarkets.filter(m => m.synthetic === false && m.source === 'Jupiter Tokens V2')) {
        try {
          const copy = jupiterAdapterPayload(market), receiptKey = `${market.mint}:${market.endpoint ?? ''}`;
          const previous = jupiterReceipts.get(receiptKey);
          const sourceStateDigest = digest(Object.fromEntries(Object.entries(copy)
            .filter(([field]) => !['ageMs', 'fresh', 'poolAgeMs', 'features'].includes(field))));
          // Retain the first adapter copy for this feed observation, including its
          // raw digest. Derived age fields changing on later reads are not new data.
          const sameObservation = previous?.sourceStateDigest === sourceStateDigest;
          const payload = sameObservation ? previous.payload : copy;
          const receivedAt = sameObservation ? previous.receivedAt : copiedAt;
          if (!previous && jupiterReceipts.size >= 10000) throw new Error('SESSION_STORAGE_RECEIPT_BOUND');
          const [r] = normalizeJupiterMarkets([payload], { observedAt: copiedAt, receivedAt, capturedAt: copiedAt, staleMs: config.jupiterStaleMs });
          if (r) { record(r, payload); jupiterReceipts.set(receiptKey, { sourceStateDigest, payload, receivedAt }); }
        } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('jupiter', 'NORMALIZATION_FAILED'); }
      }
      const identities = [...new Set(mints ?? safeMarkets.filter(m => !m.synthetic && m.source === 'Jupiter Tokens V2').map(m => m.mint))].sort();
      if (identities.length > 10000) throw new Error('SESSION_STORAGE_IDENTITY_BOUND');
      const selected = [];
      for (let i = 0; i < Math.min(identities.length, config.dex.maxRequests); i++) selected.push(identities[(cursor + i) % identities.length]);
      cursor += selected.length;
      for (const mint of selected) {
        try { await collect('dexscreener', await dex.observe(mint), normalizeDex); } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('dexscreener', 'NORMALIZATION_FAILED'); }
      }
      // Independent mint service and per-mint route rotation avoid common-factor
      // starvation. Only the bounded current eligible universe retains cursors.
      const kinds = ['info', 'security', 'pool', 'holders', 'traders'];
      const eligible = new Set(identities);
      for (const mint of gmgnRouteCursors.keys()) if (!eligible.has(mint)) gmgnRouteCursors.delete(mint);
      const budget = Math.min(identities.length, Math.max(0, config.gmgn.maxRequests - 1));
      // Cursors advance only when a call actually reached the provider: a served
      // observation (including one served from the transport cache of a prior
      // attempt) or a bounded failure after a real attempt. Blocked non-attempts
      // (CYCLE_BUDGET/BACKOFF/BUSY/DISABLED) leave the schedule untouched: the loop
      // stops and the pending mint/route is attempted again next capture instead of
      // being skipped. Progression therefore follows provider availability, never
      // capture cadence, so eventual five-route coverage holds at any frequency.
      let serviced = 0;
      for (let i = 0; i < budget; i++) {
        const mint = identities[(gmgnCursor + i) % identities.length], routeCursor = gmgnRouteCursors.get(mint) ?? 0;
        let requestServiced = false;
        try {
          const result = await gmgn.observe(kinds[routeCursor], mint);
          requestServiced = result.unavailable === undefined || result.requestAttempted === true;
          await collect('gmgn', result, normalizeGmgn);
        } catch (e) { if (/STORAGE|DIGEST|finalized/.test(e.message)) throw e; error('gmgn', 'NORMALIZATION_FAILED'); }
        if (!requestServiced) break;
        gmgnRouteCursors.set(mint, (routeCursor + 1) % kinds.length);
        serviced++;
      }
      gmgnCursor = identities.length ? (gmgnCursor + serviced) % identities.length : 0;
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
      return { snapshots, ...lastStats };
    },
    finalize(reason = 'complete') { stopped = true; launch.stop(); return storage.finalize({ endedAt: now(), reason, health: lastStats.health ?? {}, metrics: { mintsJoined: lastStats.mints ?? 0, freshJoined: lastStats.freshJoined ?? 0, launchEvents: lastStats.launchEvents ?? 0, providerErrors: lastStats.errors ?? 0, priceRangeBps: { count: lastStats.priceRangeBps?.length ?? 0, max: lastStats.priceRangeBps?.length ? Math.max(...lastStats.priceRangeBps) : null } } }); },
    health: () => ({ gmgn: gmgn.health(), dexscreener: dex.health(), launch: launch.health() }), dir: storage.dir,
  });
}
