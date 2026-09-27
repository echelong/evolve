import { EVIDENCE, digest } from './definition.mjs';
import { disagreement } from './disagreement.mjs';

export const FEATURE_NAMES = Object.freeze([
  'launchAgeSeconds', 'launchPlatform', 'launchPhase', 'gmgnSmartMoneyCount', 'gmgnKolCount', 'gmgnSniperCount', 'gmgnBundlerCount',
  'gmgnRatTraderCount', 'gmgnWhaleCount', 'gmgnCreatorHoldingPct', 'gmgnRugRatio', 'gmgnSecurityWarningCount',
  'dexLiquidityUsd', 'dexVolume5mUsd', 'dexVolume1hUsd', 'dexBuys5m', 'dexSells5m', 'dexBuyPressure5m',
  'dexPriceChange5m', 'dexPriceChange1h', 'dexPairAgeSeconds', 'crossSourcePriceRangeBps', 'crossSourceLiquidityRatio',
  'crossSourceAgeSpreadMs', 'crossSourceCount', 'crossSourceFreshCount',
]);
export function aggregate(records, { observedAt, alignmentMs = 15000 } = {}) {
  if (records.some(r => r.observedAt > observedAt || r.providerObservedAt > observedAt || r.receivedAt > observedAt)) throw new Error('NO_LOOKAHEAD_TIMESTAMP');
  const groups = new Map();
  for (const r of records) {
    if (r.chain !== 'solana' || !r.mint) continue;
    if (!groups.has(r.mint)) groups.set(r.mint, []);
    groups.get(r.mint).push(r);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([mint, rs]) => {
    const cross = disagreement(rs, { observedAt, alignmentMs });
    const features = Object.fromEntries(FEATURE_NAMES.map(k => [k, null]));
    const contributors = {};
    const fresh = rs.filter(r => observedAt - r.providerObservedAt <= r.staleness.budgetMs)
      .sort((a, b) => b.providerObservedAt - a.providerObservedAt || (b.normalized.liquidityUsd ?? -1) - (a.normalized.liquidityUsd ?? -1) || a.normalizedPayloadDigest.localeCompare(b.normalizedPayloadDigest));
    const put = (name, value, record) => {
      if (features[name] !== null || value === undefined || value === null || typeof value === 'number' && !Number.isFinite(value)) return;
      features[name] = value;
      contributors[name] = { provider: record.provider, sourceEndpoint: record.sourceEndpoint, providerObservedAt: record.providerObservedAt, normalizedPayloadDigest: record.normalizedPayloadDigest, rawResponseDigest: record.rawResponseDigest };
    };
    let dexSelected = false;
    for (const r of fresh) {
      const p = r.normalized;
      if (r.provider === 'gmgn') {
        const tag = label => p.walletTags?.find(t => t.providerLabel === label)?.count ?? null;
        for (const [name, label] of [['gmgnSmartMoneyCount', 'smart_degen'], ['gmgnKolCount', 'renowned'], ['gmgnSniperCount', 'sniper'], ['gmgnBundlerCount', 'bundler'], ['gmgnRatTraderCount', 'rat_trader'], ['gmgnWhaleCount', 'whale']]) put(name, tag(label), r);
        put('gmgnCreatorHoldingPct', p.creatorHoldingPct, r); put('gmgnRugRatio', p.rugRatio, r);
        put('gmgnSecurityWarningCount', p.securityWarnings?.length, r);
        put('launchAgeSeconds', p.createdAt !== null && p.createdAt <= observedAt ? (observedAt - p.createdAt) / 1000 : null, r);
        put('launchPlatform', p.launchPlatform, r); put('launchPhase', p.launchPhase, r);
      }
      if (r.provider === 'launch-observer') {
        put('launchAgeSeconds', (observedAt - p.observedAt) / 1000, r); put('launchPlatform', p.platform, r);
      }
      if (r.provider === 'dexscreener') {
        // Select a single pair for all DEX features; never mix windows from different pairs.
        if (dexSelected) continue;
        dexSelected = true;
        put('dexLiquidityUsd', p.liquidityUsd, r); put('dexVolume5mUsd', p.volumes.m5, r); put('dexVolume1hUsd', p.volumes.h1, r);
        put('dexBuys5m', p.transactions.m5.buys, r); put('dexSells5m', p.transactions.m5.sells, r);
        const b = p.transactions.m5.buys, s = p.transactions.m5.sells;
        put('dexBuyPressure5m', b !== null && s !== null && b + s > 0 ? b / (b + s) : null, r);
        put('dexPriceChange5m', p.priceChanges.m5, r); put('dexPriceChange1h', p.priceChanges.h1, r);
        put('dexPairAgeSeconds', p.pairCreatedAt !== null ? (observedAt - p.pairCreatedAt) / 1000 : null, r);
      }
    }
    for (const [name, field] of [['crossSourcePriceRangeBps', 'priceRangeBps'], ['crossSourceLiquidityRatio', 'liquidityMaxRatio'], ['crossSourceAgeSpreadMs', 'sourceAgeSpreadMs'], ['crossSourceCount', 'sourceCount'], ['crossSourceFreshCount', 'freshSourceCount']]) {
      features[name] = cross.metrics[field];
      contributors[name] = { disagreementDigest: cross.normalizedPayloadDigest };
    }
    return { schemaVersion: 1, recordType: 'intelligence_snapshot', ...EVIDENCE, observedAt, capturedAt: observedAt, chain: 'solana', mint,
      provider: 'multi-source', providerVersion: null, sourceEndpoint: 'aggregate', rawResponseDigest: digest(rs.map(r => r.rawResponseDigest).sort()),
      staleness: { budgetsByProvider: Object.fromEntries(rs.map(r => [r.provider, r.staleness.budgetMs])), sourceObservedAt: Object.fromEntries(rs.map(r => [r.normalizedPayloadDigest, r.providerObservedAt])) },
      limitations: ['Research features only', 'Different provider scopes remain incomparable', 'No imputation'],
      features, contributors, dataAvailability: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v !== null])),
      sourceDigests: rs.map(r => r.normalizedPayloadDigest).sort(), normalizedPayloadDigest: digest({ features, contributors }), disagreement: cross };
  });
}
