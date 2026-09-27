import { EVIDENCE, digest } from './definition.mjs';

const median = values => {
  const a = [...values].sort((x, y) => x - y), middle = Math.floor(a.length / 2);
  return a.length % 2 ? a[middle] : (a[middle - 1] + a[middle]) / 2;
};
function comparable(records, field, scope = null, window = null) {
  const candidates = records.filter(r => Number.isFinite(r.normalized[field])).sort(selectionOrder);
  const available = [...new Set(candidates.map(r => r.provider))].sort().map(p => candidates.find(r => r.provider === p));
  const compatible = available.length >= 2 && (!scope || new Set(available.map(r => r.normalized[scope])).size === 1 && available.every(r => typeof r.normalized[scope] === 'string' && r.normalized[scope].length > 0)) &&
    (!window || new Set(available.map(r => r.normalized[window])).size === 1 && available.every(r => Number.isFinite(r.normalized[window])));
  return { records: compatible ? available : [], comparable: compatible, reason: available.length < 2 ? 'INSUFFICIENT_EVIDENCE' : compatible ? null : 'INCOMPATIBLE_SCOPE_OR_WINDOW' };
}
const selectionOrder = (a, b) => b.providerObservedAt - a.providerObservedAt || (b.normalized.liquidityUsd ?? -1) - (a.normalized.liquidityUsd ?? -1) || a.normalizedPayloadDigest.localeCompare(b.normalizedPayloadDigest) || digest(a).localeCompare(digest(b));
export function disagreement(records, { observedAt, alignmentMs = 15000 } = {}) {
  if (records.some(r => r.observedAt > observedAt || r.receivedAt > observedAt || r.providerObservedAt > observedAt || r.capturedAt > observedAt)) throw new Error('NO_LOOKAHEAD_TIMESTAMP');
  const providers = new Set(records.map(r => r.provider));
  const fresh = records.filter(r => observedAt - r.providerObservedAt <= r.staleness.budgetMs);
  const newest = fresh.length ? Math.max(...fresh.map(r => r.providerObservedAt)) : null;
  const aligned = fresh.filter(r => newest - r.providerObservedAt <= alignmentMs);
  // Eligibility and deterministic per-provider selection are independent for each
  // measurement. An unavailable price cannot remove valid flow/holder evidence.
  const price = comparable(aligned.filter(r => r.normalized.priceUsd > 0), 'priceUsd');
  const prices = price.records.map(r => r.normalized.priceUsd).filter(v => v > 0);
  const pm = prices.length >= 2 ? median(prices) : null;
  const liquidity = comparable(aligned, 'liquidityUsd', 'liquidityScope');
  const ls = liquidity.records.map(r => r.normalized.liquidityUsd);
  const volume = comparable(aligned, 'volume5mUsd', 'volumeScope', 'volumeWindowMs');
  const vs = volume.records.map(r => r.normalized.volume5mUsd);
  const holders = comparable(aligned.filter(r => r.normalized.holderCount !== null && r.normalized.holderCount !== undefined), 'holderCount');
  const hs = holders.records.map(r => r.normalized.holderCount);
  const ageSources = [...new Set(aligned.map(r => r.provider))].sort().map(provider => aligned.filter(r => r.provider === provider).sort(selectionOrder)[0]);
  const ratio = a => a.length >= 2 && Math.min(...a) > 0 ? Math.max(...a) / Math.min(...a) : null;
  const sources = a => a.map(r => ({ provider: r.provider, rawResponseDigest: r.rawResponseDigest, normalizedPayloadDigest: r.normalizedPayloadDigest, providerObservedAt: r.providerObservedAt, sourceEndpoint: r.sourceEndpoint }));
  const metrics = {
    sourceCount: providers.size, freshSourceCount: new Set(fresh.map(r => r.provider)).size, alignedSourceCount: new Set(aligned.map(r => r.provider)).size,
    priceMedianUsd: pm, priceRangeBps: pm === null ? null : (Math.max(...prices) - Math.min(...prices)) / pm * 10000,
    priceMaxDeviationBps: pm === null ? null : Math.max(...prices.map(v => Math.abs(v - pm))) / pm * 10000,
    liquidityComparable: liquidity.comparable, liquidityMedianUsd: ls.length >= 2 ? median(ls) : null, liquidityMaxRatio: ratio(ls), liquidityReason: liquidity.reason,
    volumeComparable: volume.comparable, volumeDisagreementRatio: ratio(vs), volumeReason: volume.reason,
    holderCountRange: hs.length >= 2 ? Math.max(...hs) - Math.min(...hs) : null,
    poolAgeComparable: false, poolAgeReason: 'FIRST_POOL_AND_SELECTED_PAIR_DEFINITIONS_DIFFER',
    sourceAgeSpreadMs: ageSources.length >= 2 ? Math.max(...ageSources.map(r => r.providerObservedAt)) - Math.min(...ageSources.map(r => r.providerObservedAt)) : null,
    contributors: { price: sources(price.records), liquidity: sources(liquidity.records), volume: sources(volume.records), holders: sources(holders.records), age: ageSources.length >= 2 ? sources(ageSources) : [] },
  };
  return { schemaVersion: 1, recordType: 'disagreement', ...EVIDENCE, observedAt, capturedAt: observedAt, provider: 'multi-source', providerVersion: null, sourceEndpoint: 'disagreement', rawResponseDigest: digest(records.map(r => r.rawResponseDigest).sort()),
    staleness: { alignmentMs, sourceObservedAt: records.map(r => r.providerObservedAt).sort((a, b) => a - b) }, dataAvailability: { price: pm !== null, liquidity: liquidity.comparable, volume: volume.comparable }, limitations: ['Descriptive only', 'Only aligned fresh observations contribute to value comparisons'], chain: 'solana', mint: records[0]?.mint ?? null, alignmentMs, metrics, normalizedPayloadDigest: digest(metrics) };
}
