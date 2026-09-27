import { digest, epoch, mintIdentity, text } from '../definition.mjs';
import { observation } from '../normalize.mjs';

// Transport is intentionally disabled until program layouts and a read-only endpoint
// have been verified together. This interface accepts decoded observation events only.
export const READ_ONLY_SUBSCRIPTIONS = Object.freeze(['logsSubscribe', 'logsUnsubscribe']);
export function normalizeLaunchEvent(input, { receivedAt, observedAt = receivedAt, staleMs = 300000 } = {}) {
  if (!input || !['pump_fun', 'lets_bonk'].includes(input.platform) || !mintIdentity(input.mint) ||
      !['logs', 'blocks', 'geyser', 'other'].includes(input.sourceKind) || input.chain !== 'solana') return null;
  const providerObservedAt = epoch(input.observedAt) ?? receivedAt;
  const normalized = { schemaVersion: 1, observedAt: providerObservedAt, chain: 'solana', platform: input.platform, mint: input.mint,
    transactionSignature: text(input.transactionSignature), slot: Number.isSafeInteger(input.slot) && input.slot >= 0 ? input.slot : null,
    sourceKind: input.sourceKind, programId: mintIdentity(input.programId), creator: mintIdentity(input.creator),
    metadata: input.metadata ? { name: text(input.metadata.name), symbol: text(input.metadata.symbol), uri: text(input.metadata.uri) } : null,
    rawDigest: digest(input) };
  return observation({ provider: 'launch-observer', endpoint: input.sourceKind, mint: input.mint, payload: input, normalized,
    providerObservedAt, receivedAt, observedAt, staleMs, timestampBasis: input.observedAt ? 'decoded_source_time' : 'received_at',
    limitations: ['Decoded-event interface only; live transport disabled', 'No completeness guarantee or historical backfill', 'Metadata and creator only when supplied by verified decoder'] });
}
export function createLaunchObserver({ config = { staleMs: 300000 }, maxSeen = 10000, maxPending = 128 } = {}) {
  const seen = new Set(), pending = [];
  let duplicates = 0, events = 0, errors = 0;
  return Object.freeze({
    start: async () => ({ unavailable: 'DISABLED_UNVERIFIED_TRANSPORT' }),
    stop: () => {}, poll: async () => pending.splice(0),
    ingest(input, timing) {
      let record;
      try { record = normalizeLaunchEvent(input, { staleMs: config.staleMs, ...timing }); } catch { errors++; return null; }
      if (!record) { errors++; return null; }
      const key = digest([input.platform, input.mint, input.transactionSignature ?? null, input.slot ?? null]);
      if (seen.has(key)) { duplicates++; return null; }
      // Fail closed rather than evicting old duplicate identities and inventing new events.
      if (seen.size >= maxSeen || pending.length >= maxPending) { errors++; return null; }
      seen.add(key); events++; pending.push({ record, payload: structuredClone(input) }); return record;
    },
    health: () => ({ state: 'DISABLED_UNVERIFIED_TRANSPORT', events, duplicates, errors, completeness: 'unavailable', pending: pending.length, maxSeen, maxPending }),
  });
}
