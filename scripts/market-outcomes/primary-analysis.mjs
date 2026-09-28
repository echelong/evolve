// R4 primary analysis — CONTINUOUS_RANK_ASSOCIATION, Kendall's tau-b with a
// mint-clustered bootstrap.
//
// Frozen executable specification (docs/R4-PREREGISTRATION.md):
//   estimand            Kendall's tau-b between crossSourcePriceRangeBps and
//                       absLogReturn300sBps
//   population          all D2 valid references (availability denominator)
//   outcome denominator Policy-A resolved references only
//   dependence          cluster bootstrap by mint
//   replicates          10,000
//   PRNG                SplitMix64 (BigInt), outcome-independent seed
//   interval            two-sided 95% percentile interval (type-7 quantile)
//   floors              >=100 resolved references AND >=30 resolved mints
//   degenerate          <1000 defined replicates => no interval
//
// This module is pure: no filesystem access, no network, no capture and no
// trading authority. It never reads real R4 outcomes on its own.
import { digest } from '../market-intelligence/definition.mjs';
import { CLASSIFICATION } from './index.mjs';

export const PRIMARY_ANALYSIS_SPEC_VERSION = 'R4-PRIMARY-TAU-B-V1';
export const PRIMARY_EXPOSURE_FIELD = 'crossSourcePriceRangeBps';
export const PRIMARY_OUTCOME_FIELD = 'absLogReturn300sBps';
export const PRIMARY_ESTIMAND = 'kendall_tau_b';
export const CLUSTER_KEY = 'mint';
export const BOOTSTRAP_REPLICATES = 10_000;
export const MIN_RESOLVED_REFERENCES = 100;
export const MIN_RESOLVED_MINTS = 30;
export const MIN_DEFINED_REPLICATES = 1_000;
export const CI_LEVEL = 0.95;
export const QUANTILE_METHOD = 'type7';
export const SEED_DERIVATION = 'sha256(canonical({specVersion, sealFingerprint, horizonMs, toleranceMs, referenceIdentities}))';
export const MASK_64 = (1n << 64n) - 1n;

/* ---------------------------------------------------------------- Kendall */

function tieCorrection(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) total += (count * (count - 1)) / 2;
  return total;
}

/** Kendall's tau-b with native tie correction. Deterministic and dependency-free. */
export function kendallTauB(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) throw new Error('TAU_INPUT_MISMATCH');
  const n = x.length;
  if (n < 2) return { defined: false, reason: 'INSUFFICIENT_OBSERVATIONS', n, numerator: 0, effectivePairs: 0 };
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[j] - x[i]);
      if (dx === 0) continue;
      const dy = Math.sign(y[j] - y[i]);
      numerator += dx * dy;
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const n1 = tieCorrection(x);
  const n2 = tieCorrection(y);
  const denominator = Math.sqrt((n0 - n1) * (n0 - n2));
  if (!(denominator > 0)) return { defined: false, reason: 'DEGENERATE_TIES', n, numerator, n0, n1, n2, effectivePairs: 0 };
  return { defined: true, tauB: numerator / denominator, n, numerator, n0, n1, n2, effectivePairs: Math.sqrt((n0 - n1) * (n0 - n2)) };
}

/* ------------------------------------------------------------------- PRNG */

/** Deterministic SplitMix64 over a 64-bit BigInt state. */
export function splitmix64(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('SEED_INVALID');
  let state = BigInt(`0x${seedHex}`) & MASK_64;
  return function next() {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  };
}

/** Unbiased integer in [0, n) via rejection sampling. */
export function randomBelow(next, n) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('RANDOM_BOUND_INVALID');
  const bound = BigInt(n);
  const limit = (1n << 64n) - ((1n << 64n) % bound);
  for (;;) { const value = next(); if (value < limit) return Number(value % bound); }
}

/**
 * Outcome-independent deterministic seed. Inputs are the preregistration seal
 * fingerprint, the specification version, the frozen horizon/tolerance and the
 * D2 reference identities. No price, return, direction or model value enters.
 */
export function deriveAnalysisSeed({ sealFingerprint, referenceIdentities, specVersion = PRIMARY_ANALYSIS_SPEC_VERSION, horizonMs, toleranceMs }) {
  if (typeof sealFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sealFingerprint)) throw new Error('SEED_SEAL_FINGERPRINT_INVALID');
  if (!Array.isArray(referenceIdentities) || referenceIdentities.length === 0) throw new Error('SEED_REFERENCES_INVALID');
  return digest({ specVersion, sealFingerprint, horizonMs, toleranceMs, referenceIdentities: [...referenceIdentities].sort() });
}

/* -------------------------------------------------------------- Bootstrap */

/** Hyndman–Fan type-7 quantile of an ascending-sorted numeric array. */
export function percentileType7(sorted, p) {
  const n = sorted.length;
  if (n === 0) throw new Error('PERCENTILE_EMPTY');
  if (!(p >= 0 && p <= 1)) throw new Error('PERCENTILE_INVALID');
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Mint-cluster bootstrap: resample mints with replacement, pooling each cluster's rows. */
export function clusterBootstrap({ rows, seedHex, replicates = BOOTSTRAP_REPLICATES }) {
  if (!Number.isSafeInteger(replicates) || replicates <= 0) throw new Error('BOOTSTRAP_REPLICATES_INVALID');
  const byMint = new Map();
  for (const row of rows) { const group = byMint.get(row.mint) ?? []; group.push(row); byMint.set(row.mint, group); }
  const mints = [...byMint.keys()].sort();
  if (mints.length === 0) return { values: [], definedCount: 0, requested: replicates };
  const next = splitmix64(seedHex);
  const values = [];
  for (let b = 0; b < replicates; b++) {
    const xs = [], ys = [];
    for (let draw = 0; draw < mints.length; draw++) {
      const group = byMint.get(mints[randomBelow(next, mints.length)]);
      for (const row of group) { xs.push(row.exposureValue); ys.push(row.outcomeValue); }
    }
    const result = kendallTauB(xs, ys);
    if (result.defined) values.push(result.tauB);
  }
  return { values, definedCount: values.length, requested: replicates };
}

/* ------------------------------------------------------------ Row assembly */

/**
 * Join the D2 reference exposure values to the Policy-A outcome rows by the
 * frozen `sessionId/snapshotDigest` identity. `references` carry the exposure
 * read from the authenticated reference snapshot's frozen feature
 * `crossSourcePriceRangeBps`; unresolved references stay in the list with a
 * null outcome (they are never imputed away).
 */
export function assembleAnalysisRows({ references, outcomes }) {
  if (!Array.isArray(references) || references.length === 0) throw new Error('ANALYSIS_REFERENCES_INVALID');
  if (!Array.isArray(outcomes) || outcomes.length === 0) throw new Error('ANALYSIS_OUTCOMES_INVALID');
  const byIdentity = new Map();
  for (const row of outcomes) {
    const key = `${row.referenceSessionId}/${row.referenceSnapshotDigest}`;
    if (byIdentity.has(key)) throw new Error('ANALYSIS_DUPLICATE_OUTCOME_ROW');
    byIdentity.set(key, row);
  }
  const rows = references.map(reference => {
    const key = `${reference.sessionId}/${reference.snapshotDigest}`;
    const row = byIdentity.get(key);
    if (!row) throw new Error('ANALYSIS_OUTCOME_MISSING');
    return { mint: row.mint, referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest,
      referenceObservedAt: row.referenceObservedAt, exposureValue: reference.exposureValue ?? null,
      outcomeValue: row.status === 'resolved' ? row.absLogReturn300sBps : null,
      status: row.status, missingReason: row.missingReason };
  });
  rows.sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)
    || (a.referenceSessionId < b.referenceSessionId ? -1 : a.referenceSessionId > b.referenceSessionId ? 1 : 0)
    || (a.referenceSnapshotDigest < b.referenceSnapshotDigest ? -1 : a.referenceSnapshotDigest > b.referenceSnapshotDigest ? 1 : 0));
  return rows;
}

/* --------------------------------------------------------------- Analysis */

export function runPrimaryAnalysis({ rows, referenceIdentities, sealFingerprint, replicates = BOOTSTRAP_REPLICATES, horizonMs = 300_000, toleranceMs = 60_000 }) {
  const resolved = rows.filter(row => row.status === 'resolved' && Number.isFinite(row.outcomeValue) && Number.isFinite(row.exposureValue));
  const resolvedMints = new Set(resolved.map(row => row.mint));
  const floorsMet = resolved.length >= MIN_RESOLVED_REFERENCES && resolvedMints.size >= MIN_RESOLVED_MINTS;
  const seedDigest = deriveAnalysisSeed({ sealFingerprint, referenceIdentities, horizonMs, toleranceMs });
  const unresolvedByReason = {};
  for (const row of rows) if (row.status !== 'resolved') unresolvedByReason[row.missingReason] = (unresolvedByReason[row.missingReason] ?? 0) + 1;

  const base = { schemaVersion: 1, recordType: 'r4_primary_analysis', ...CLASSIFICATION,
    specVersion: PRIMARY_ANALYSIS_SPEC_VERSION, exposureField: PRIMARY_EXPOSURE_FIELD, outcomeField: PRIMARY_OUTCOME_FIELD,
    estimand: PRIMARY_ESTIMAND, clusterKey: CLUSTER_KEY, bootstrapReplicates: replicates, ciLevel: CI_LEVEL, quantileMethod: QUANTILE_METHOD,
    seedDerivation: SEED_DERIVATION, seedDigest, sealFingerprint,
    availabilityDenominator: rows.length, resolvedReferenceCount: resolved.length, distinctResolvedMintCount: resolvedMints.size,
    unresolvedByReason, floorsMet, minResolvedReferences: MIN_RESOLVED_REFERENCES, minResolvedMints: MIN_RESOLVED_MINTS,
    minDefinedReplicates: MIN_DEFINED_REPLICATES };

  if (!floorsMet) return { ...base, descriptiveOnly: true, inferentialClaimMade: false, pointEstimate: null, ciLower: null, ciUpper: null,
    replicatesDefined: 0, intervalStatus: 'NOT_COMPUTED_FLOORS_NOT_MET' };

  const estimate = kendallTauB(resolved.map(row => row.exposureValue), resolved.map(row => row.outcomeValue));
  const bootstrap = clusterBootstrap({ rows: resolved, seedHex: seedDigest, replicates });
  const intervalStatus = bootstrap.definedCount < MIN_DEFINED_REPLICATES ? 'INSUFFICIENT_DEFINED_REPLICATES' : 'COMPUTED';
  const sorted = [...bootstrap.values].sort((a, b) => a - b);
  const ci = intervalStatus === 'COMPUTED'
    ? { ciLower: percentileType7(sorted, (1 - CI_LEVEL) / 2), ciUpper: percentileType7(sorted, 1 - (1 - CI_LEVEL) / 2) }
    : { ciLower: null, ciUpper: null };
  return { ...base, descriptiveOnly: false, inferentialClaimMade: intervalStatus === 'COMPUTED',
    pointEstimate: estimate.defined ? estimate.tauB : null, pointEstimateDefined: estimate.defined,
    exposureTies: estimate.n1, outcomeTies: estimate.n2, pairs: estimate.n0,
    replicatesDefined: bootstrap.definedCount, intervalStatus, ...ci };
}
