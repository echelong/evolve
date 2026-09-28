// R4 P3-C SENSITIVITY-ONLY policy B resolver.
//
// This module is a predeclared SENSITITY ANALYSIS path, never a primary path.
//
// Isolation architecture (frozen):
//   * The production resolver `resolveReference` in ./index.mjs is NOT modified,
//     NOT imported for its resolution logic here, and never calls into this
//     module. `index.mjs` has no reference to this file, so the primary path
//     cannot reach sensitivity code.
//   * This module has no environment-variable, CLI-flag, config-file, or
//     ambient-state switch. Sensitivity behavior is reachable only by calling
//     `resolveReferencePolicyB` explicitly. There is no auto-selection and no
//     fallback from A to B.
//   * This module imports no filesystem module and performs no writes, so a
//     sensitivity result cannot create, overwrite, or substitute for a primary
//     outcome artifact. Primary outputs are written only by `generateOutcomeRun`
//     in ./index.mjs.
//   * This module holds no mutable module state; every call is a pure function
//     of its arguments.
//   * Every emitted record is tagged with the sensitivity policy, its trust
//     assumption, and a distinct recordType, so a sensitivity record can never
//     be mistaken for a primary `market_outcome` record.
//
// All timing, coverage, freshness, alignment, two-source, no-lookahead and
// window-selection constants are IMPORTED from the primary module. This module
// defines no threshold of its own, so no sensitivity result can move a
// scientific threshold.
import { CLASSIFICATION, OUTCOME_DEFINITION_ID, PRIMARY_HORIZON_SECONDS, PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS, snapshotMissingReason } from './index.mjs';

export const PRIMARY_POLICY = 'POLICY_A_CONTENT_UNIQUENESS';
export const SENSITIVITY_POLICY = 'POLICY_B_OBSERVATION_IDENTITY';
export const SENSITIVITY_RECORD_TYPE = 'market_outcome_sensitivity';

// The provenance decision classified capture provenance as PARTIAL, so policy B
// necessarily carries this explicit trust assumption. Wording is frozen and
// must not be weakened.
export const SENSITIVITY_TRUST_ASSUMPTION = 'A later locally timestamped provider receipt is accepted as evidence of a distinct upstream observation even if the provider supplies identical payload bytes.';

// What may later be compared between A and B. Frozen; nothing else may be
// derived from a sensitivity result.
export const SENSITIVITY_ALLOWED_COMPARISONS = Object.freeze([
  'resolved and unresolved counts',
  'missingness and missing-reason counts',
  'reference availability',
  'the same prespecified R4 primary analysis repeated on the SAME frozen references',
  'the difference between A and B under the same cohort',
]);

// What a sensitivity result may never be used for. Frozen.
export const SENSITIVITY_FORBIDDEN_USES = Object.freeze([
  'redefining the primary R4 conclusion',
  'selecting references from whichever policy looks better',
  'choosing or tuning any threshold after observing results',
  'replacing Policy A in the primary result',
  'expanding or removing cohort members',
  'changing the horizon, tolerance, freshness, or alignment rules',
  'using B to rescue an unfavorable primary result',
]);

const stamp = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => Number.isFinite(n) && n > 0;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = code => { throw new Error(code); };

// Resolve one reference under the SENSITIVITY policy.
//
// Relative to the primary resolver, exactly one rule differs: the same-provider
// raw/normalized reference digest comparison is omitted. Every other check,
// in the same order and with the same precedence, is unchanged.
export function resolveReferencePolicyB(reference, candidates, coverage = null) {
  const s = reference?.snapshot;
  const invalid = Object.hasOwn(reference, 'validationReason') ? reference.validationReason : snapshotMissingReason(s);
  const targetAt = stamp(s?.observedAt) && stamp(s.observedAt + PRIMARY_HORIZON_MS) ? s.observedAt + PRIMARY_HORIZON_MS : null;
  const base = {
    schemaVersion: 1, recordType: SENSITIVITY_RECORD_TYPE, ...CLASSIFICATION, outcomeDefinitionId: OUTCOME_DEFINITION_ID,
    primaryField: 'absLogReturn300sBps', outcomeType: 'continuous', mint: s?.mint ?? null,
    primaryPolicy: PRIMARY_POLICY, sensitivityPolicy: SENSITIVITY_POLICY, sensitivityOnly: true,
    sensitivityTrustAssumption: SENSITIVITY_TRUST_ASSUMPTION,
    referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest,
    referenceNormalizedPayloadDigest: s?.normalizedPayloadDigest ?? null,
    referenceObservedAt: s?.observedAt ?? null,
    referencePriceUsd: positive(s?.disagreement?.metrics?.priceMedianUsd) ? s.disagreement.metrics.priceMedianUsd : null,
    referencePriceContributors: s?.disagreement?.metrics?.contributors?.price ?? null, targetAt,
    horizonSeconds: PRIMARY_HORIZON_SECONDS, resolutionToleranceMs: RESOLUTION_TOLERANCE_MS,
  };
  const unavailable = (reason, rejectedCandidatesByReason = {}) => ({ ...base, status: 'unavailable', missingReason: reason, rejectedCandidatesByReason, absLogReturn300sBps: null });

  if (invalid || targetAt === null) return unavailable(`REFERENCE_${invalid ?? 'INVALID_TIMESTAMP'}`);

  let window;
  if (candidates instanceof Map) {
    const list = candidates.get(s.mint) ?? [];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].snapshot.observedAt < targetAt) lo = mid + 1; else hi = mid; }
    let end = lo; while (end < list.length && list[end].snapshot.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS) end++;
    window = list.slice(lo, end);
  } else window = candidates.filter(c => c.snapshot.mint === s.mint && stamp(c.snapshot.observedAt) && c.snapshot.observedAt >= targetAt && c.snapshot.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)
    .sort((a, b) => a.snapshot.observedAt - b.snapshot.observedAt || order(a.snapshotDigest, b.snapshotDigest) || order(a.sessionId, b.sessionId));

  const rejected = {}; let future;
  for (const candidate of window) {
    let reason = Object.hasOwn(candidate, 'validationReason') ? candidate.validationReason : snapshotMissingReason(candidate.snapshot);
    if (!reason) {
      const futurePrice = candidate.snapshot.disagreement.metrics.contributors.price;
      // PRE_TARGET_PRICE_EVIDENCE is unchanged and still takes precedence.
      if (futurePrice.some(p => p.providerObservedAt < targetAt)) reason = 'PRE_TARGET_PRICE_EVIDENCE';
      // POLICY B: the same-provider raw/normalized reference digest comparison
      // is intentionally and solely omitted here. Nothing else is relaxed.
    }
    if (!reason) { future = candidate; break; }
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  }

  const covered = !coverage || (() => {
    if (coverage.spans) {
      const spans = coverage.spans; let lo = 0, hi = spans.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (spans[mid].startedAt <= targetAt) lo = mid + 1; else hi = mid; }
      return lo > 0 && spans[lo - 1].endedAt >= targetAt + RESOLUTION_TOLERANCE_MS;
    }
    let end = targetAt;
    for (const span of coverage.slice().sort((a, b) => a.startedAt - b.startedAt)) { if (span.startedAt > end) break; end = Math.max(end, span.endedAt); if (end >= targetAt + RESOLUTION_TOLERANCE_MS) return true; }
    return false;
  })();

  if (!future) return unavailable(window.length ? 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION' : covered ? 'NO_SAME_MINT_OBSERVATION_IN_WINDOW' : 'SOURCE_COVERAGE_GAP', rejected);

  const f = future.snapshot, ratio = f.disagreement.metrics.priceMedianUsd / base.referencePriceUsd;
  const signed = Math.log(ratio) * 10_000;
  if (!Number.isFinite(signed)) return unavailable('NONFINITE_LOG_RETURN', rejected);
  if (!(s.observedAt < targetAt && f.observedAt >= targetAt && f.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)) fail('NO_LOOKAHEAD_VIOLATION');

  return { ...base, status: 'resolved', missingReason: null, resolvedAt: f.observedAt, futureObservedAt: f.observedAt,
    resolutionLagMs: f.observedAt - targetAt, futurePriceUsd: f.disagreement.metrics.priceMedianUsd,
    futureSessionId: future.sessionId, futureSnapshotDigest: future.snapshotDigest, futureNormalizedPayloadDigest: f.normalizedPayloadDigest,
    futurePriceContributors: f.disagreement.metrics.contributors.price, rejectedCandidatesByReason: rejected,
    absLogReturn300sBps: Math.abs(signed), logReturn300sBps: signed, logReturn300sBpsRole: 'descriptive / provenance only' };
}

// The only permitted comparison surface: availability and missingness counts.
export function sensitivityAvailability(records) {
  const summary = { resolvedCount: 0, unresolvedCount: 0, unresolvedByReason: {} };
  for (const r of records) {
    if (r.status === 'resolved') summary.resolvedCount++;
    else { summary.unresolvedCount++; summary.unresolvedByReason[r.missingReason] = (summary.unresolvedByReason[r.missingReason] ?? 0) + 1; }
  }
  return summary;
}
