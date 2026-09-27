import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, digest, mintIdentity } from '../market-intelligence/definition.mjs';

export const OUTCOME_DEFINITION_ID = 'ABS_LOG_RETURN_300S_BPS_V1';
export const PRIMARY_HORIZON_SECONDS = 300;
export const PRIMARY_HORIZON_MS = 300_000;
export const RESOLUTION_TOLERANCE_MS = 60_000;
export const CLASSIFICATION = Object.freeze({ developmentOnly: true, researchOnly: true, paperOnly: true, observerOnly: true,
  tradingAuthority: false, engineAuthority: false, arenaEligible: false, promotionEligible: false, profitabilityInferencePermitted: false });
export const R4_SOURCE_POLICY = Object.freeze({ requireDurationComplete: true });
const stamp = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => Number.isFinite(n) && n > 0;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = code => { throw new Error(code); };
function safePath(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
function hashFile(file) {
  safePath(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    for (let p = 0, n; (n = readSync(fd, buffer, 0, buffer.length, p)) > 0; p += n) hash.update(buffer.subarray(0, n));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function tree(dir, prefix = '') {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => order(a.name, b.name)).flatMap(e => {
    const name = prefix + e.name, file = path.join(dir, e.name);
    if (e.isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    return e.isDirectory() ? Object.entries(tree(file, name + '/')) : [[name, hashFile(file)]];
  }));
}
function verifiedJson(dir, file, hashes) {
  const bytes = readFileSync(path.join(dir, file));
  if (createHash('sha256').update(bytes).digest('hex') !== hashes[file]) fail('SOURCE_CHANGED_DURING_READ');
  return bytes.toString('utf8');
}
export function readSourceSession({ dir, role }, policy = R4_SOURCE_POLICY) {
  if (!['cohort', 'maturation'].includes(role)) fail('SOURCE_ROLE_INVALID');
  if (typeof policy.requireDurationComplete !== 'boolean') fail('SOURCE_POLICY_INVALID');
  dir = safePath(dir); const before = tree(dir);
  if (!before['manifest.json']) fail('SOURCE_MANIFEST_MISSING');
  const manifest = JSON.parse(verifiedJson(dir, 'manifest.json', before));
  if (manifest.schemaVersion !== 1 || manifest.recordType !== 'manifest' || !manifest.files || !/^[a-zA-Z0-9_-]{1,100}$/.test(manifest.sessionId)) fail('SOURCE_MANIFEST_INVALID');
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (file === 'manifest.json' || !/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith('/') || file.split('/').some(p => p === '..' || p === '.' || !p)) fail('SOURCE_MANIFEST_PATH_INVALID');
    if (before[file] !== hash) fail('SOURCE_FILE_HASH_MISMATCH');
  }
  const listed = Object.keys(manifest.files).sort(), actual = Object.keys(before).filter(f => f !== 'manifest.json').sort();
  if (canonical(listed) !== canonical(actual) || !['summary.json', 'session.json', 'normalized.ndjson', 'disagreement.ndjson'].every(f => listed.includes(f))) fail('SOURCE_MANIFEST_FILE_SET_INVALID');
  if (digest(manifest.files) !== manifest.fingerprint) fail('SOURCE_FINGERPRINT_MISMATCH');
  const summary = JSON.parse(verifiedJson(dir, 'summary.json', before));
  const session = JSON.parse(verifiedJson(dir, 'session.json', before));
  if (summary.sessionId !== manifest.sessionId || session.sessionId !== manifest.sessionId || summary.recordType !== 'summary' || session.recordType !== 'session') fail('SOURCE_SESSION_IDENTITY_INVALID');
  if (policy.requireDurationComplete && !(summary.status === 'complete' && summary.reason === 'duration reached' && summary.storage?.sessionBoundReached === false)) fail('SOURCE_STATUS_INELIGIBLE');
  const rows = file => verifiedJson(dir, file, before).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const normalized = rows('normalized.ndjson'), disagreements = rows('disagreement.ndjson');
  const snapshots = normalized.filter(r => r.recordType === 'intelligence_snapshot').map(r => {
    const matches = disagreements.filter(d => d.recordType === 'disagreement' && d.mint === r.mint && d.observedAt === r.observedAt && d.normalizedPayloadDigest === r.contributors?.crossSourcePriceRangeBps?.disagreementDigest);
    const unique = new Map(matches.map(d => [digest(d), d]));
    const disagreement = unique.size === 1 ? [...unique.values()][0] : null;
    for (const contributor of disagreement?.metrics?.contributors?.price ?? []) {
      const evidence = normalized.filter(o => o.recordType === 'market_observation' && o.chain === r.chain && o.mint === r.mint &&
        ['provider', 'sourceEndpoint', 'providerObservedAt', 'rawResponseDigest', 'normalizedPayloadDigest'].every(k => o[k] === contributor[k]));
      const source = r.staleness?.sourceObservations?.find(o => o.provider === contributor.provider && o.normalizedPayloadDigest === contributor.normalizedPayloadDigest && o.rawResponseDigest === contributor.rawResponseDigest && o.providerObservedAt === contributor.providerObservedAt && o.sourceEndpoint === contributor.sourceEndpoint);
      if (!evidence.length || !source || evidence.some(o => o.staleness?.budgetMs !== source.budgetMs || digest(o.normalized) !== o.normalizedPayloadDigest || !positive(o.normalized.priceUsd) || o.observedAt > r.observedAt)) fail('SOURCE_PRICE_EVIDENCE_INVALID');
    }
    return { snapshot: { ...r, disagreement }, sessionId: manifest.sessionId, role, snapshotDigest: digest({ ...r, disagreement }) };
  });
  if (canonical(tree(dir)) !== canonical(before)) fail('SOURCE_CHANGED_DURING_READ');
  return { dir, role, sessionId: manifest.sessionId, fingerprint: manifest.fingerprint, before, snapshots };
}

// Validate the recorded provenance; never reconstruct a median or select a different pair.
export function snapshotMissingReason(s) {
  if (s?.recordType !== 'intelligence_snapshot' || s.chain !== 'solana' || !mintIdentity(s.mint) || !stamp(s.observedAt)) return 'INVALID_SNAPSHOT';
  if (s.futureOutcomeIncluded !== false || s.disagreement?.futureOutcomeIncluded !== false) return 'NO_LOOKAHEAD_VIOLATION';
  if (!positive(s.disagreement?.metrics?.priceMedianUsd)) return 'INVALID_PRICE';
  const price = s.disagreement.metrics.contributors?.price;
  if (!Array.isArray(price) || price.length !== 2 || price.some(p => !p || typeof p !== 'object') || canonical(price.map(p => p.provider).sort()) !== canonical(['dexscreener', 'jupiter'])) return 'INVALID_PRICE_CONTRIBUTORS';
  const sources = s.staleness?.sourceObservations;
  if (!Array.isArray(sources) || !sources.length) return 'INVALID_SOURCE_PROVENANCE';
  if (!stamp(s.capturedAt) || s.capturedAt > s.observedAt || s.disagreement.observedAt !== s.observedAt || !stamp(s.disagreement.capturedAt) || s.disagreement.capturedAt > s.observedAt) return 'NO_LOOKAHEAD_VIOLATION';
  for (const source of sources) {
    if (!source || typeof source !== 'object') return 'INVALID_SOURCE_PROVENANCE';
    if (source.chain !== 'solana' || source.mint !== s.mint || !['observedAt', 'providerObservedAt', 'receivedAt', 'capturedAt'].every(k => stamp(source[k]) && source[k] <= s.observedAt) || source.providerObservedAt > source.receivedAt || source.receivedAt > source.capturedAt || source.capturedAt > source.observedAt) return 'NO_LOOKAHEAD_VIOLATION';
    if (!Number.isFinite(source.budgetMs) || source.budgetMs < 0) return 'INVALID_SOURCE_BUDGET';
    const { observationDigest, ...primitive } = source;
    if (digest(primitive) !== observationDigest) return 'INVALID_SOURCE_PROVENANCE';
  }
  if (!Array.isArray(s.disagreement.staleness?.sourceObservedAt) || s.disagreement.staleness.sourceObservedAt.some(t => !stamp(t) || t > s.observedAt)) return 'NO_LOOKAHEAD_VIOLATION';
  if (digest(s.disagreement.metrics) !== s.disagreement.normalizedPayloadDigest || digest({ features: s.features, contributors: s.contributors, sourceObservations: sources }) !== s.normalizedPayloadDigest) return 'INVALID_PAYLOAD_DIGEST';
  const alignment = s.disagreement.alignmentMs;
  if (!Number.isFinite(alignment) || alignment < 0 || s.disagreement.staleness?.alignmentMs !== alignment) return 'INVALID_ALIGNMENT_RULE';
  const fresh = sources.filter(p => s.observedAt - p.providerObservedAt <= p.budgetMs);
  const newest = Math.max(...fresh.map(p => p.providerObservedAt));
  for (const p of price) {
    if (!/^[a-f0-9]{64}$/.test(p.normalizedPayloadDigest) || !/^[a-f0-9]{64}$/.test(p.rawResponseDigest) || typeof p.sourceEndpoint !== 'string') return 'INVALID_SOURCE_PROVENANCE';
    const matches = sources.filter(v => ['provider', 'normalizedPayloadDigest', 'rawResponseDigest', 'providerObservedAt', 'sourceEndpoint'].every(k => v[k] === p[k]));
    if (matches.length !== 1) return 'INVALID_SOURCE_PROVENANCE';
    if (s.observedAt - matches[0].providerObservedAt > matches[0].budgetMs) return 'STALE_PRICE_CONTRIBUTOR';
    if (newest - p.providerObservedAt > alignment) return 'MISALIGNED_PRICE_CONTRIBUTOR';
  }
  if (price[0].normalizedPayloadDigest === price[1].normalizedPayloadDigest || price[0].rawResponseDigest === price[1].rawResponseDigest) return 'DUPLICATE_PRICE_EVIDENCE';
  return null;
}
export function resolveReference(reference, candidates) {
  const s = reference.snapshot, invalid = snapshotMissingReason(s);
  const targetAt = stamp(s?.observedAt) && stamp(s.observedAt + PRIMARY_HORIZON_MS) ? s.observedAt + PRIMARY_HORIZON_MS : null;
  const base = { schemaVersion: 1, recordType: 'market_outcome', ...CLASSIFICATION, outcomeDefinitionId: OUTCOME_DEFINITION_ID,
    primaryField: 'absLogReturn300sBps', outcomeType: 'continuous', mint: s?.mint ?? null,
    referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest, referenceNormalizedPayloadDigest: s?.normalizedPayloadDigest ?? null,
    referenceObservedAt: s?.observedAt ?? null, referencePriceUsd: positive(s?.disagreement?.metrics?.priceMedianUsd) ? s.disagreement.metrics.priceMedianUsd : null,
    referencePriceContributors: s?.disagreement?.metrics?.contributors?.price ?? null, targetAt,
    horizonSeconds: PRIMARY_HORIZON_SECONDS, resolutionToleranceMs: RESOLUTION_TOLERANCE_MS };
  const unavailable = (reason, rejectedCandidatesByReason = {}) => ({ ...base, status: 'unavailable', missingReason: reason, rejectedCandidatesByReason, absLogReturn300sBps: null });
  if (invalid || targetAt === null) return unavailable(`REFERENCE_${invalid ?? 'INVALID_TIMESTAMP'}`);
  const window = candidates.filter(c => c.snapshot.mint === s.mint && stamp(c.snapshot.observedAt) && c.snapshot.observedAt >= targetAt && c.snapshot.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)
    .sort((a, b) => a.snapshot.observedAt - b.snapshot.observedAt || order(a.snapshotDigest, b.snapshotDigest) || order(a.sessionId, b.sessionId));
  const rejected = {}; let future;
  for (const candidate of window) {
    const reason = snapshotMissingReason(candidate.snapshot);
    if (!reason) { future = candidate; break; }
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  }
  if (!future) return unavailable(window.length ? 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION' : 'NO_SAME_MINT_OBSERVATION_IN_WINDOW', rejected);
  const f = future.snapshot, ratio = f.disagreement.metrics.priceMedianUsd / base.referencePriceUsd;
  const signed = Math.log(ratio) * 10_000;
  if (!Number.isFinite(signed)) return unavailable('NONFINITE_LOG_RETURN', rejected);
  if (!(s.observedAt < targetAt && f.observedAt >= targetAt && f.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)) fail('NO_LOOKAHEAD_VIOLATION');
  return { ...base, status: 'resolved', missingReason: null, resolvedAt: f.observedAt, futureObservedAt: f.observedAt,
    resolutionLagMs: f.observedAt - targetAt, futurePriceUsd: f.disagreement.metrics.priceMedianUsd,
    futureSessionId: future.sessionId, futureSnapshotDigest: future.snapshotDigest, futureNormalizedPayloadDigest: f.normalizedPayloadDigest,
    futurePriceContributors: f.disagreement.metrics.contributors.price, absLogReturn300sBps: Math.abs(signed),
    logReturn300sBps: signed, logReturn300sBpsRole: 'descriptive / provenance only' };
}

// Explicit frozen references are required. A maturation source can never add references.
export function generateOutcomeRun({ sources, references, outputRoot, runId, createdAt, sourcePolicy = R4_SOURCE_POLICY, sealedCode = null }) {
  if (!Array.isArray(sources) || !sources.length || !Array.isArray(references) || !references.length || !stamp(createdAt) || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || typeof outputRoot !== 'string') fail('RUN_INPUT_INVALID');
  const sessions = sources.map(s => readSourceSession(s, sourcePolicy));
  try {
    if (new Set(sessions.map(s => s.sessionId)).size !== sessions.length) fail('DUPLICATE_SOURCE_SESSION');
    const root = safePath(outputRoot), dir = path.join(root, runId);
    for (const s of sessions) if (root === s.dir || root.startsWith(s.dir + path.sep) || s.dir.startsWith(root + path.sep)) fail('OUTPUT_SOURCE_OVERLAP');
    const candidates = sessions.flatMap(s => s.snapshots);
    if (candidates.some(c => !stamp(c.snapshot.observedAt) || c.snapshot.observedAt > createdAt)) fail('EVIDENCE_NOT_YET_OBSERVED');
    const selected = references.map(r => {
      const session = sessions.find(s => s.sessionId === r.sessionId);
      if (!session || session.role !== 'cohort') fail('REFERENCE_NOT_IN_COHORT');
      const matches = session.snapshots.filter(c => c.snapshotDigest === r.snapshotDigest);
      if (matches.length !== 1) fail('REFERENCE_IDENTITY_NOT_UNIQUE');
      if (createdAt < matches[0].snapshot.observedAt + PRIMARY_HORIZON_MS + RESOLUTION_TOLERANCE_MS) fail('RESOLUTION_WINDOW_NOT_MATURE');
      return matches[0];
    }).sort((a, b) => order(a.sessionId, b.sessionId) || order(a.snapshotDigest, b.snapshotDigest));
    if (new Set(selected.map(r => `${r.sessionId}/${r.snapshotDigest}`)).size !== selected.length) fail('DUPLICATE_REFERENCE');
    const outcomes = selected.map(r => resolveReference(r, candidates));
    const unresolvedByReason = {};
    for (const o of outcomes) if (o.status === 'unavailable') unresolvedByReason[o.missingReason] = (unresolvedByReason[o.missingReason] ?? 0) + 1;
    const metadata = { schemaVersion: 1, ...CLASSIFICATION, outcomeDefinitionId: OUTCOME_DEFINITION_ID, primaryField: 'absLogReturn300sBps', outcomeType: 'continuous',
      horizonSeconds: PRIMARY_HORIZON_SECONDS, horizonMs: PRIMARY_HORIZON_MS, resolutionToleranceMs: RESOLUTION_TOLERANCE_MS, runId, createdAt, sealedCode, sourcePolicy,
      sources: sessions.map(s => ({ sessionId: s.sessionId, role: s.role, fingerprint: s.fingerprint, manifestSha256: s.before['manifest.json'] })).sort((a, b) => order(a.sessionId, b.sessionId)),
      recordCount: outcomes.length, resolvedCount: outcomes.filter(o => o.status === 'resolved').length, unresolvedCount: outcomes.filter(o => o.status === 'unavailable').length, unresolvedByReason };
    const bodies = { 'outcomes.ndjson': outcomes.map(o => canonical(o) + '\n').join(''), 'summary.json': canonical({ ...metadata, recordType: 'outcome_summary' }) + '\n' };
    const hashes = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, createHash('sha256').update(body).digest('hex')]));
    const content = { ...metadata, recordType: 'outcome_manifest', status: 'finalized', files: hashes };
    const manifest = { ...content, fingerprint: digest(content) };
    for (const s of sessions) if (canonical(tree(s.dir)) !== canonical(s.before)) fail('SOURCE_CHANGED_AFTER_RESOLUTION');
    mkdirSync(root, { recursive: true }); safePath(root); mkdirSync(dir); // Exclusive reservation, including abandoned partial runs.
    for (const [name, body] of Object.entries({ ...bodies, 'manifest.json': canonical(manifest) + '\n' })) {
      const file = path.join(dir, name); writeFileSync(file, body, { flag: 'wx', mode: 0o444 });
      const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return { dir, manifest, outcomes };
  } finally {
    for (const s of sessions) if (canonical(tree(s.dir)) !== canonical(s.before)) fail('SOURCE_CHANGED_AFTER_RESOLUTION');
  }
}
