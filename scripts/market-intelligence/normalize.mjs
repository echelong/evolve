import { SCHEMA_VERSION, EVIDENCE, digest, number as n, text, epoch, mintIdentity } from './definition.mjs';

export function observation({ provider, endpoint, mint, payload, normalized, receivedAt, capturedAt = receivedAt, observedAt = capturedAt, providerObservedAt = receivedAt, staleMs, limitations = [], timestampBasis = 'received_at', providerVersion = null }) {
  if (!mintIdentity(mint)) return null;
  if (![observedAt, capturedAt, receivedAt, providerObservedAt].every(Number.isFinite) || providerObservedAt > receivedAt || receivedAt > capturedAt || capturedAt > observedAt) throw new Error('NO_LOOKAHEAD_TIMESTAMP');
  const ageMs = observedAt - providerObservedAt;
  const dataAvailability = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, value !== null]));
  return {
    schemaVersion: SCHEMA_VERSION, recordType: 'market_observation', ...EVIDENCE,
    observedAt, capturedAt, provider, providerVersion, sourceEndpoint: endpoint,
    chain: 'solana', mint, rawResponseDigest: digest(payload), normalizedPayloadDigest: digest(normalized),
    providerObservedAt, receivedAt, timestampBasis,
    staleness: { ageMs, fresh: ageMs <= staleMs, staleReason: ageMs > staleMs ? 'FRESHNESS_BUDGET_EXCEEDED' : null, budgetMs: staleMs },
    dataAvailability, limitations, normalized,
  };
}
const pct = value => n(value) === null ? null : n(value) * 100;
export const GMGN_LABEL_FIELDS = Object.freeze({ smart_degen: 'smart_wallets', renowned: 'renowned_wallets', sniper: 'sniper_wallets', bundler: 'bundler_wallets', rat_trader: 'rat_trader_wallets', whale: 'whale_wallets', fresh_wallet: 'fresh_wallets' });
export function normalizeGmgn(result, { mint, observedAt = result.receivedAt, staleMs = 90000 } = {}) {
  const raw = result.payload;
  if (!raw || ![0, '0'].includes(raw.code) || !raw.data || typeof raw.data !== 'object') return [];
  const data = raw.data;
  if (result.kind === 'trenches') {
    // Only the documented new_creation section is collected; other shapes remain raw evidence.
    const items = Array.isArray(data.new_creation) ? data.new_creation : [];
    return items.map(item => gmgnRecord(item, result, raw, mintIdentity(item.address), observedAt, staleMs)).filter(Boolean);
  }
  // pool.address is a pool address, never the mint identity.
  if (result.kind === 'info' && data.address !== mint) return [];
  return [gmgnRecord(data, result, raw, mint, observedAt, staleMs)].filter(Boolean);
}
function gmgnRecord(d, result, raw, mint, observedAt, staleMs) {
  const kind = result.kind;
  const trenches = kind === 'trenches';
  const info = kind === 'info';
  const security = kind === 'security' || trenches;
  const pool = kind === 'pool';
  const trenchTags = { smart_degen: 'smart_degen_count', renowned: 'renowned_count', sniper: 'sniper_count' };
  const tags = trenches ? Object.entries(trenchTags).map(([label, field]) => ({ provider: 'gmgn', providerLabel: label, count: n(d[field]) })) : info ? Object.entries(GMGN_LABEL_FIELDS).map(([label, field]) => ({ provider: 'gmgn', providerLabel: label, count: n(d.wallet_tags_stat?.[field]) })) : null;
  const warningFields = ['is_wash_trading', 'open_source', 'owner_renounced', 'renounced_mint', 'renounced_freeze_account'];
  const warnings = security && warningFields.some(k => Object.hasOwn(d, k)) ? ['is_wash_trading', 'open_source', 'owner_renounced', 'renounced_mint', 'renounced_freeze_account']
    .filter(key => (key === 'is_wash_trading' && d[key] === true) || (key !== 'is_wash_trading' && (d[key] === false || d[key] === 'no')))
    .map(key => ({ provider: 'gmgn', providerLabel: key, value: d[key] })) : null;
  const createdAt = info ? epoch(d.creation_timestamp) : trenches ? epoch(d.created_timestamp) : null;
  const marketVolumes = Object.fromEntries(['5m', '1h', '6h', '24h'].map(w => [w, info ? n(d.price?.[`volume_${w}`]) : trenches && ['1h', '24h'].includes(w) ? n(d[`volume_${w}`]) : null]));
  const tradeActivity = Object.fromEntries(['5m', '1h', '6h', '24h'].map(w => [w, { buys: info ? n(d.price?.[`buys_${w}`]) : trenches && w === '24h' ? n(d.buys_24h) : null, sells: info ? n(d.price?.[`sells_${w}`]) : trenches && w === '24h' ? n(d.sells_24h) : null }]));
  const normalized = {
    creatorAddress: info ? mintIdentity(d.dev?.creator_address) : null,
    marketVolumes: (info || trenches) && Object.values(marketVolumes).some(v => v !== null) ? marketVolumes : null,
    tradeActivity: (info || trenches) && Object.values(tradeActivity).some(v => v.buys !== null || v.sells !== null) ? tradeActivity : null,
    priceUsd: info ? n(d.price?.price) : pool ? n(d.price) : null,
    liquidityUsd: info || pool || trenches ? n(d.liquidity) : null,
    liquidityScope: pool && text(d.address) ? `pair:${d.address}` : info || trenches ? 'gmgn_biggest_pool' : null,
    marketCapUsd: trenches ? n(d.usd_market_cap) : info && n(d.price?.price) !== null && n(d.circulating_supply) !== null ? n(d.price.price) * n(d.circulating_supply) : null,
    volume5mUsd: info ? n(d.price?.volume_5m) : null, volumeWindowMs: info ? 300000 : null,
    volumeScope: info ? 'gmgn_token' : null, holderCount: trenches ? n(d.holder_count) : info ? n(d.holder_count ?? d.stat?.holder_count) : null,
    topHolderPct: info ? pct(d.stat?.top_10_holder_rate) : security ? pct(d.top_10_holder_rate) : null,
    creatorHoldingPct: info ? pct(d.stat?.creator_hold_rate) : security ? pct(d.creator_balance_rate) : null,
    devHoldingPct: info ? pct(d.stat?.dev_team_hold_rate) : security ? pct(d.dev_team_hold_rate) : null,
    rugRatio: security ? n(d.rug_ratio) : null,
    rugRatioProvenance: security && n(d.rug_ratio) !== null ? { provider: 'gmgn', providerLabel: 'rug_ratio' } : null,
    honeypot: security && ['yes', 'no'].includes(d.is_honeypot) ? d.is_honeypot === 'yes' : null,
    mintAuthorityRenounced: security && typeof d.renounced_mint === 'boolean' ? d.renounced_mint : null,
    freezeAuthorityRenounced: security && typeof d.renounced_freeze_account === 'boolean' ? d.renounced_freeze_account : null,
    ownershipRenounced: security ? text(d.owner_renounced) : null, securityWarnings: warnings, walletTags: tags,
    launchPlatform: info || trenches ? text(d.launchpad_platform ?? d.launchpad) : null,
    launchPhase: info ? n(d.launchpad_status) : trenches ? 'new_creation' : null,
    createdAt: createdAt !== null && createdAt <= result.receivedAt ? createdAt : null,
    bondingCurveProgress: info ? n(d.launchpad_progress) : null,
    onCurve: info && typeof d.pool?.is_on_curve === 'boolean' ? d.pool.is_on_curve : null,
    migratedPool: info ? text(d.migrated_pool) : null,
    poolCreatedAt: pool && epoch(d.creation_timestamp) !== null && epoch(d.creation_timestamp) <= result.receivedAt ? epoch(d.creation_timestamp) : null,
    participants: ['holders', 'traders'].includes(kind) ? (Array.isArray(d.list) ? d.list.slice(0, 20).map(p => ({ address: text(p.address), holdingRatio: n(p.amount_percentage), providerTags: Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string').slice(0, 20).map(t => ({ provider: 'gmgn', providerLabel: text(t) })) : null })) : null) : null,
  };
  return observation({ provider: 'gmgn', endpoint: result.endpoint, mint, payload: raw, normalized, receivedAt: result.receivedAt, observedAt, staleMs,
    limitations: ['Provider classifications are not ground truth', 'Exact source update time unavailable; receipt bounds earliest consumption', 'Top participants are a bounded sample, not total tag counts', 'Unknown response shapes retained only as raw evidence'] });
}
export function normalizeDex(result, { observedAt = result.receivedAt, staleMs = 60000 } = {}) {
  if (!Array.isArray(result.payload)) return [];
  return result.payload.filter(p => p?.chainId === 'solana' && mintIdentity(p.baseToken?.address) && p.baseToken.address === result.requestIdentity && text(p.pairAddress)).slice(0, 100).map(p => {
    const windows = Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map(w => [w, n(p.volume?.[w])]));
    const txns = Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map(w => [w, { buys: n(p.txns?.[w]?.buys), sells: n(p.txns?.[w]?.sells) }]));
    const normalized = { pairAddress: text(p.pairAddress), dexId: text(p.dexId), baseToken: { address: p.baseToken.address, symbol: text(p.baseToken.symbol), name: text(p.baseToken.name) },
      quoteToken: { address: text(p.quoteToken?.address), symbol: text(p.quoteToken?.symbol), name: text(p.quoteToken?.name) },
      priceUsd: n(p.priceUsd), liquidityUsd: n(p.liquidity?.usd), liquidityScope: `pair:${p.pairAddress}`,
      fdvUsd: n(p.fdv), marketCapUsd: n(p.marketCap), volumes: windows, transactions: txns,
      priceChanges: Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map(w => [w, n(p.priceChange?.[w])])),
      volume5mUsd: windows.m5, volumeWindowMs: 300000, volumeScope: `pair:${p.pairAddress}`,
      pairCreatedAt: n(p.pairCreatedAt) !== null && n(p.pairCreatedAt) <= result.receivedAt ? n(p.pairCreatedAt) : null,
      boostsActive: n(p.boosts?.active), profile: p.info ? { imageUrl: text(p.info.imageUrl) } : null,
    };
    return observation({ provider: 'dexscreener', endpoint: result.endpoint, mint: p.baseToken.address, payload: result.payload, normalized,
      receivedAt: result.receivedAt, observedAt, staleMs, limitations: ['Pair-specific flow/liquidity, not token aggregate', 'Source update time unavailable; receipt bounds earliest consumption', 'Rolling windows have approximate end times'] });
  });
}
// Feed records are plain data but may contain undefined optional fields after
// universe merging. Represent unavailable values explicitly without mutating them.
export function jupiterAdapterPayload(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid Jupiter numeric value'); return value; }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return Array.from(value, jupiterAdapterPayload);
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jupiterAdapterPayload(item)]));
  }
  throw new Error('Invalid Jupiter adapter data');
}
export function normalizeJupiterMarkets(markets, { observedAt, receivedAt = observedAt, capturedAt = observedAt, staleMs = 60000 }) {
  return markets.filter(m => m.synthetic === false && m.source === 'Jupiter Tokens V2').map(jupiterAdapterPayload).map(m => observation({
    provider: 'jupiter', endpoint: m.endpoint || 'feed.markets()', mint: m.mint, payload: m,
    receivedAt, capturedAt, providerObservedAt: m.lastFetchedAt ?? m.lastObservedAt, observedAt, staleMs, timestampBasis: m.lastFetchedAt === undefined ? 'feed_request_start_and_local_copy' : 'feed_last_seen_request_start_and_local_copy',
    normalized: { priceUsd: n(m.price), liquidityUsd: n(m.liquidity), liquidityScope: 'jupiter_token', volume5mUsd: n(m.volume5m), volumeWindowMs: 300000, volumeScope: 'jupiter_token', holderCount: n(m.holderCount), poolCreatedAt: n(m.poolCreatedAt) },
    limitations: ['Copied normalized feed state; raw upstream response not duplicated', 'Feed timestamp is request start, not upstream update or receipt time', 'Local receipt is the first Phase 5J copy; upstream receipt/update unavailable', 'Jupiter token scope differs from individual DEX pair scope', ...(m.lastFetchedAt === undefined ? [] : ['lastFetchedAt is locally recorded per-mint HTTP-list inclusion, not provider-authenticated price update'])],
  })).filter(Boolean);
}
