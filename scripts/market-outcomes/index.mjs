import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, mintIdentity } from '../market-intelligence/definition.mjs';
// R4 hard exclusion enforcement. A methods-only session can never be loaded as
// R4 source evidence, regardless of the role a caller supplies.
import { assertR4NotExcluded } from '../r4-exclusions.mjs';

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
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROTECTED = ['market-intelligence','jev','jev-direction','jev-paper-forensics','arenas','arena','arena-cache','history','research','replication','experiments','champions','classifier','datasets','regimes','stress','hall-of-fame','governance','intelligence','jev-paper-shadow','jev-supervisor-observer','shadow'].map(name => path.join(REPO,'.evolve',name));
const overlaps = (a,b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
function safePath(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('SYMLINK_FORBIDDEN'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
function hashFile(file) {
  safePath(file); if (!lstatSync(file).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
function directories(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [prefix + e.name + '/', ...directories(path.join(dir, e.name), prefix + e.name + '/')] : []);
}
function sourceJson(body) { try { return JSON.parse(body); } catch { fail('SOURCE_FORMAT_INVALID'); } }
function verifiedRows(dir, file, hashes) {
  const full = path.join(dir, file); safePath(full);
  if (!lstatSync(full).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024), rows = [];
    let carry = Buffer.alloc(0);
    for (let pos = 0, n; (n = readSync(fd, chunk, 0, chunk.length, pos)) > 0; pos += n) {
      const bytes = chunk.subarray(0, n); hash.update(bytes);
      const data = carry.length ? Buffer.concat([carry, bytes]) : bytes;
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (end - start > 8 * 1024 * 1024) fail('SOURCE_RECORD_TOO_LARGE');
        if (end > start) rows.push(sourceJson(data.subarray(start, end).toString('utf8')));
        start = end + 1;
      }
      carry = Buffer.from(data.subarray(start));
      if (carry.length > 8 * 1024 * 1024) fail('SOURCE_RECORD_TOO_LARGE');
    }
    if (carry.length) rows.push(sourceJson(carry.toString('utf8')));
    if (hash.digest('hex') !== hashes[file]) fail('SOURCE_CHANGED_DURING_READ');
    return rows;
  } finally { closeSync(fd); }
}
function verifiedJson(dir, file, hashes) {
  const full = path.join(dir,file); safePath(full);
  if (!lstatSync(full).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) fail('SOURCE_NOT_REGULAR_FILE');
    const bytes = readFileSync(fd);
    if (createHash('sha256').update(bytes).digest('hex') !== hashes[file]) fail('SOURCE_CHANGED_DURING_READ');
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}
export function readSourceSession({ dir, role }, policy = R4_SOURCE_POLICY) {
  if (!['cohort', 'maturation'].includes(role)) fail('SOURCE_ROLE_INVALID');
  if (!policy || typeof policy !== 'object' || typeof policy.requireDurationComplete !== 'boolean') fail('SOURCE_POLICY_INVALID');
  dir = safePath(dir); const before = tree(dir), beforeDirs = directories(dir).sort();
  if (!before['manifest.json']) fail('SOURCE_MANIFEST_MISSING');
  const manifest = sourceJson(verifiedJson(dir, 'manifest.json', before));
  if (manifest.schemaVersion !== 1 || manifest.recordType !== 'manifest' || !manifest.files || !/^[a-zA-Z0-9_-]{1,100}$/.test(manifest.sessionId)) fail('SOURCE_MANIFEST_INVALID');
  // Hard exclusion: the five frozen methods-only sessions are rejected at the
  // source-loading boundary, before any role can be trusted.
  assertR4NotExcluded(manifest.sessionId);
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (file === 'manifest.json' || !/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith('/') || file.split('/').some(p => p === '..' || p === '.' || !p)) fail('SOURCE_MANIFEST_PATH_INVALID');
    if (before[file] !== hash) fail('SOURCE_FILE_HASH_MISMATCH');
  }
  const listed = Object.keys(manifest.files).sort(), actual = Object.keys(before).filter(f => f !== 'manifest.json').sort();
  if (canonical(listed) !== canonical(actual) || !['summary.json', 'session.json', 'normalized.ndjson', 'disagreement.ndjson'].every(f => listed.includes(f))) fail('SOURCE_MANIFEST_FILE_SET_INVALID');
  const expectedDirs = new Set(listed.flatMap(f => { const parts = f.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/') + '/'); }));
  if (canonical([...expectedDirs].sort()) !== canonical(directories(dir).sort())) fail('SOURCE_MANIFEST_FILE_SET_INVALID');
  if (digest(manifest.files) !== manifest.fingerprint) fail('SOURCE_FINGERPRINT_MISMATCH');
  if (listed.includes('revisit-scheduler.ndjson')) {
    for (const event of verifiedRows(dir, 'revisit-scheduler.ndjson', before)) {
      if (event.schemaVersion !== 1 || event.recordType !== 'revisit_scheduler_event' ||
          !['scheduled', 'completed', 'failed'].includes(event.result) ||
          !mintIdentity(event.mint) || !stamp(event.targetAt) ||
          !stamp(event.deadlineAt) || event.deadlineAt - event.targetAt !== RESOLUTION_TOLERANCE_MS ||
          !Number.isSafeInteger(event.queueDepth) || event.queueDepth < 0 ||
          (event.result !== 'scheduled' && (!Number.isSafeInteger(event.queueLagMs) || event.queueLagMs < 0 ||
            !Number.isSafeInteger(event.coalescedEntryCount) || event.coalescedEntryCount < 0)) ||
          (event.result === 'completed' && event.failureCode !== null) ||
          (event.result === 'failed' && !['REVISIT_DEADLINE_MISSED', 'REVISIT_TWO_SOURCE_UNAVAILABLE'].includes(event.failureCode)) ||
          (event.requestStartedAt !== undefined && event.requestStartedAt !== null && !stamp(event.requestStartedAt)) ||
          (event.requestReceivedAt !== undefined && event.requestReceivedAt !== null && (!stamp(event.requestReceivedAt) ||
            event.requestStartedAt > event.requestReceivedAt)) ||
          (event.snapshotAt !== undefined && event.snapshotAt !== null && (!stamp(event.snapshotAt) ||
            event.requestReceivedAt > event.snapshotAt))) fail('SOURCE_REVISIT_TELEMETRY_INVALID');
    }
  }
  const summary = sourceJson(verifiedJson(dir, 'summary.json', before));
  const session = sourceJson(verifiedJson(dir, 'session.json', before));
  if (summary.sessionId !== manifest.sessionId || session.sessionId !== manifest.sessionId || summary.recordType !== 'summary' || session.recordType !== 'session') fail('SOURCE_SESSION_IDENTITY_INVALID');
  if (policy.requireDurationComplete && !(summary.status === 'complete' && summary.reason === 'duration reached' && summary.storage?.sessionBoundReached === false)) fail('SOURCE_STATUS_INELIGIBLE');
  if (![session.startedAt, summary.startedAt, summary.endedAt].every(stamp) || session.startedAt !== summary.startedAt || summary.startedAt > summary.endedAt) fail('SOURCE_SESSION_COVERAGE_INVALID');
  const normalized = verifiedRows(dir, 'normalized.ndjson', before), disagreements = verifiedRows(dir, 'disagreement.ndjson', before);
  const tupleKey = values => values.some(value => value !== null && typeof value === 'object')
    ? Symbol('nonprimitive-join-field') : canonical(values.map(value => [typeof value, value === undefined ? null : value]));
  const disagreementKey = d => tupleKey([d.mint, d.observedAt, d.normalizedPayloadDigest]);
  const observationKey = o => tupleKey([o.chain,o.mint,o.provider,o.sourceEndpoint,o.providerObservedAt,o.rawResponseDigest,o.normalizedPayloadDigest]);
  const disagreementIndex = new Map(), observationIndex = new Map();
  for (const d of disagreements) if (d.recordType === 'disagreement') {
    const key = disagreementKey(d), matches = disagreementIndex.get(key) ?? [];
    matches.push(d); disagreementIndex.set(key,matches);
  }
  for (const o of normalized) if (o.recordType === 'market_observation') {
    const key = observationKey(o), matches = observationIndex.get(key) ?? [];
    matches.push(o); observationIndex.set(key,matches);
  }
  const snapshots = normalized.filter(r => r.recordType === 'intelligence_snapshot').map(r => {
    const matches = disagreementIndex.get(tupleKey([r.mint,r.observedAt,r.contributors?.crossSourcePriceRangeBps?.disagreementDigest])) ?? [];
    if (!matches.length) fail('MISSING_DISAGREEMENT_JOIN');
    if (matches.length !== 1) fail('AMBIGUOUS_DISAGREEMENT_JOIN');
    const disagreement = matches[0];
    for (const contributor of disagreement?.metrics?.contributors?.price ?? []) {
      const evidence = observationIndex.get(tupleKey([r.chain,r.mint,contributor.provider,contributor.sourceEndpoint,contributor.providerObservedAt,contributor.rawResponseDigest,contributor.normalizedPayloadDigest])) ?? [];
      const source = r.staleness?.sourceObservations?.find(o => o.provider === contributor.provider && o.normalizedPayloadDigest === contributor.normalizedPayloadDigest && o.rawResponseDigest === contributor.rawResponseDigest && o.providerObservedAt === contributor.providerObservedAt && o.sourceEndpoint === contributor.sourceEndpoint);
      if (evidence.length !== 1 || !source || evidence.some(o => o.staleness?.budgetMs !== source.budgetMs || digest(o.normalized) !== o.normalizedPayloadDigest || !positive(o.normalized.priceUsd) || ![o.providerObservedAt,o.receivedAt,o.capturedAt,o.observedAt].every(stamp) || o.providerObservedAt > o.receivedAt || o.receivedAt > o.capturedAt || o.capturedAt > o.observedAt || o.observedAt > r.observedAt)) fail('SOURCE_PRICE_EVIDENCE_INVALID');
    }
    const full = { ...r, disagreement };
    // The compact snapshot carries the authenticated exposure provenance: the
    // frozen `crossSourcePriceRangeBps` feature, the contributor digest that
    // binds it, and the disagreement payload digest it was derived from. Each
    // was already authenticated by `snapshotMissingReason(full)` above, which
    // proves `digest({features, contributors, sourceObservations})` equals the
    // record's `normalizedPayloadDigest` and that the disagreement metrics hash
    // to its own digest. The exposure value therefore derives from authenticated
    // evidence, not from a caller.
    const compact = { recordType: r.recordType, chain: r.chain, mint: r.mint, observedAt: r.observedAt,
      normalizedPayloadDigest: r.normalizedPayloadDigest,
      exposure: { field: 'crossSourcePriceRangeBps', value: r.features?.crossSourcePriceRangeBps ?? null,
        contributorDigest: r.contributors?.crossSourcePriceRangeBps?.disagreementDigest ?? null,
        disagreementDigest: disagreement.normalizedPayloadDigest ?? null },
      disagreement: { metrics: { priceMedianUsd: disagreement.metrics?.priceMedianUsd,
        contributors: { price: disagreement.metrics?.contributors?.price } } } };
    return { snapshot: compact, validationReason: snapshotMissingReason(full), sessionId: manifest.sessionId, role, snapshotDigest: digest(full) };
  });
  const snapshotsByDigest = new Map();
  for (const candidate of snapshots) { const group = snapshotsByDigest.get(candidate.snapshotDigest) ?? []; group.push(candidate); snapshotsByDigest.set(candidate.snapshotDigest,group); }
  if (canonical(tree(dir)) !== canonical(before) || canonical(directories(dir).sort()) !== canonical(beforeDirs)) fail('SOURCE_CHANGED_DURING_READ');
  return { dir, role, sessionId: manifest.sessionId, fingerprint: manifest.fingerprint, before, beforeDirs,
    coverage: { startedAt: summary.startedAt, endedAt: summary.endedAt }, policy: { ...policy }, snapshots, snapshotsByDigest };
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
export function resolveReference(reference, candidates, coverage = null) {
  const s = reference.snapshot, invalid = Object.hasOwn(reference,'validationReason') ? reference.validationReason : snapshotMissingReason(s);
  const targetAt = stamp(s?.observedAt) && stamp(s.observedAt + PRIMARY_HORIZON_MS) ? s.observedAt + PRIMARY_HORIZON_MS : null;
  const base = { schemaVersion: 1, recordType: 'market_outcome', ...CLASSIFICATION, outcomeDefinitionId: OUTCOME_DEFINITION_ID,
    primaryField: 'absLogReturn300sBps', outcomeType: 'continuous', mint: s?.mint ?? null,
    referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest, referenceNormalizedPayloadDigest: s?.normalizedPayloadDigest ?? null,
    referenceObservedAt: s?.observedAt ?? null, referencePriceUsd: positive(s?.disagreement?.metrics?.priceMedianUsd) ? s.disagreement.metrics.priceMedianUsd : null,
    referencePriceContributors: s?.disagreement?.metrics?.contributors?.price ?? null, targetAt,
    horizonSeconds: PRIMARY_HORIZON_SECONDS, resolutionToleranceMs: RESOLUTION_TOLERANCE_MS };
  const unavailable = (reason, rejectedCandidatesByReason = {}) => ({ ...base, status: 'unavailable', missingReason: reason, rejectedCandidatesByReason, absLogReturn300sBps: null });
  if (invalid || targetAt === null) return unavailable(`REFERENCE_${invalid ?? 'INVALID_TIMESTAMP'}`);
  let window;
  if (candidates instanceof Map) {
    const list = candidates.get(s.mint) ?? [];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].snapshot.observedAt < targetAt) lo = mid + 1; else hi = mid; }
    let end = lo; while (end < list.length && list[end].snapshot.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS) end++;
    window = list.slice(lo,end);
  } else window = candidates.filter(c => c.snapshot.mint === s.mint && stamp(c.snapshot.observedAt) && c.snapshot.observedAt >= targetAt && c.snapshot.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)
    .sort((a, b) => a.snapshot.observedAt - b.snapshot.observedAt || order(a.snapshotDigest, b.snapshotDigest) || order(a.sessionId, b.sessionId));
  const rejected = {}; let future;
  for (const candidate of window) {
    let reason = Object.hasOwn(candidate,'validationReason') ? candidate.validationReason : snapshotMissingReason(candidate.snapshot);
    if (!reason) {
      const futurePrice = candidate.snapshot.disagreement.metrics.contributors.price;
      const referencePrice = s.disagreement.metrics.contributors.price;
      if (futurePrice.some(p => p.providerObservedAt < targetAt)) reason = 'PRE_TARGET_PRICE_EVIDENCE';
      else if (futurePrice.some(p => referencePrice.some(q => p.provider === q.provider && (p.normalizedPayloadDigest === q.normalizedPayloadDigest || p.rawResponseDigest === q.rawResponseDigest)))) reason = 'REUSED_REFERENCE_PRICE_EVIDENCE';
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
    let end = targetAt; for (const span of coverage.slice().sort((a,b) => a.startedAt-b.startedAt)) { if (span.startedAt > end) break; end = Math.max(end, span.endedAt); if (end >= targetAt + RESOLUTION_TOLERANCE_MS) return true; } return false;
  })();
  if (!future) return unavailable(window.length ? 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION' : covered ? 'NO_SAME_MINT_OBSERVATION_IN_WINDOW' : 'SOURCE_COVERAGE_GAP', rejected);
  const f = future.snapshot, ratio = f.disagreement.metrics.priceMedianUsd / base.referencePriceUsd;
  const signed = Math.log(ratio) * 10_000;
  if (!Number.isFinite(signed)) return unavailable('NONFINITE_LOG_RETURN', rejected);
  if (!(s.observedAt < targetAt && f.observedAt >= targetAt && f.observedAt <= targetAt + RESOLUTION_TOLERANCE_MS)) fail('NO_LOOKAHEAD_VIOLATION');
  return { ...base, status: 'resolved', missingReason: null, resolvedAt: f.observedAt, futureObservedAt: f.observedAt,
    resolutionLagMs: f.observedAt - targetAt, futurePriceUsd: f.disagreement.metrics.priceMedianUsd,
    futureSessionId: future.sessionId, futureSnapshotDigest: future.snapshotDigest, futureNormalizedPayloadDigest: f.normalizedPayloadDigest,
    futurePriceContributors: f.disagreement.metrics.contributors.price, rejectedCandidatesByReason: rejected, absLogReturn300sBps: Math.abs(signed),
    logReturn300sBps: signed, logReturn300sBpsRole: 'descriptive / provenance only' };
}

// Explicit frozen references are required. A maturation source can never add references.
export function generateOutcomeRun({ sources, references, outputRoot, runId, createdAt, sourcePolicy = R4_SOURCE_POLICY, sealedCode = null }) {
  if (!Array.isArray(sources) || !sources.length || !Array.isArray(references) || !references.length || !stamp(createdAt) || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || typeof outputRoot !== 'string') fail('RUN_INPUT_INVALID');
  const sessions = sources.map(s => readSourceSession(s, sourcePolicy));
  let primaryError, published = false;
  try {
    if (new Set(sessions.map(s => s.sessionId)).size !== sessions.length) fail('DUPLICATE_SOURCE_SESSION');
    const root = safePath(outputRoot), dir = path.join(root, runId);
    if (PROTECTED.some(p => overlaps(root,p))) fail('OUTPUT_PROTECTED_ROOT');
    for (const s of sessions) if (overlaps(root,s.dir)) fail('OUTPUT_SOURCE_OVERLAP');
    const candidatesByMint = new Map();
    for (const session of sessions) for (const c of session.snapshots) {
      if (!stamp(c.snapshot.observedAt) || c.snapshot.observedAt > createdAt) fail('EVIDENCE_NOT_YET_OBSERVED');
      const group = candidatesByMint.get(c.snapshot.mint) ?? []; group.push(c); candidatesByMint.set(c.snapshot.mint,group);
    }
    for (const group of candidatesByMint.values()) group.sort((a,b) => a.snapshot.observedAt-b.snapshot.observedAt || order(a.snapshotDigest,b.snapshotDigest) || order(a.sessionId,b.sessionId));
    const sessionsById = new Map(sessions.map(s => [s.sessionId,s]));
    const selected = references.map(r => {
      const session = sessionsById.get(r.sessionId);
      if (!session || session.role !== 'cohort') fail('REFERENCE_NOT_IN_COHORT');
      const matches = session.snapshotsByDigest.get(r.snapshotDigest) ?? [];
      if (matches.length !== 1) fail('REFERENCE_IDENTITY_NOT_UNIQUE');
      if (createdAt < matches[0].snapshot.observedAt + PRIMARY_HORIZON_MS + RESOLUTION_TOLERANCE_MS) fail('RESOLUTION_WINDOW_NOT_MATURE');
      return matches[0];
    }).sort((a, b) => order(a.sessionId, b.sessionId) || order(a.snapshotDigest, b.snapshotDigest));
    if (new Set(selected.map(r => `${r.sessionId}/${r.snapshotDigest}`)).size !== selected.length) fail('DUPLICATE_REFERENCE');
    const spans = [];
    for (const span of sessions.map(s => s.coverage).sort((a,b) => a.startedAt-b.startedAt)) {
      const last = spans.at(-1);
      if (last && span.startedAt <= last.endedAt) last.endedAt = Math.max(last.endedAt, span.endedAt);
      else spans.push({ ...span });
    }
    const coverage = { spans };
    const outcomes = selected.map(r => resolveReference(r, candidatesByMint, coverage));
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
    for (const s of sessions) if ((canonical(tree(s.dir)) !== canonical(s.before) || canonical(directories(s.dir).sort()) !== canonical(s.beforeDirs))) fail('SOURCE_CHANGED_AFTER_RESOLUTION');
    mkdirSync(root, { recursive: true }); safePath(root); mkdirSync(dir); // Exclusive reservation, including abandoned partial runs.
    for (const [name, body] of Object.entries(bodies)) {
      const file = path.join(dir, name); writeFileSync(file, body, { flag: 'wx', mode: 0o444 });
      const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    for (const s of sessions) if ((canonical(tree(s.dir)) !== canonical(s.before) || canonical(directories(s.dir).sort()) !== canonical(s.beforeDirs))) fail('SOURCE_CHANGED_AFTER_RESOLUTION');
    const tmp = path.join(dir, 'manifest.json.tmp'), final = path.join(dir, 'manifest.json');
    writeFileSync(tmp, canonical(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    try { lstatSync(final); fail('EEXIST'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    renameSync(tmp, final);
    published = true; // The pre-publication source check is the last successful-run integrity boundary.
    const dfd = openSync(dir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); }
    chmodSync(dir, 0o555);
    return { dir, manifest, outcomes };
  } catch (e) { primaryError = e; throw e;
  } finally {
    if (!published) {
      try { for (const s of sessions) if ((canonical(tree(s.dir)) !== canonical(s.before) || canonical(directories(s.dir).sort()) !== canonical(s.beforeDirs))) fail('SOURCE_CHANGED_AFTER_RESOLUTION'); }
      catch (e) { if (primaryError) throw new AggregateError([primaryError,e], primaryError.message, { cause: primaryError }); throw e; }
    }
  }
}

export function verifyOutcomeRun(dir) {
  dir = safePath(dir);
  const names = readdirSync(dir).sort();
  if (!names.includes('manifest.json')) fail('OUTCOME_MANIFEST_MISSING');
  if (canonical(names) !== canonical(['manifest.json','outcomes.ndjson','summary.json'])) fail('OUTCOME_FILE_SET_INVALID');
  for (const name of names) if (!lstatSync(path.join(dir,name)).isFile()) fail('OUTCOME_FILE_SET_INVALID');
  const manifest = sourceJson(readFileSync(path.join(dir,'manifest.json')));
  if (manifest.recordType !== 'outcome_manifest' || manifest.schemaVersion !== 1 || manifest.status !== 'finalized') fail('OUTCOME_MANIFEST_INVALID');
  if (manifest.outcomeDefinitionId !== OUTCOME_DEFINITION_ID || manifest.horizonSeconds !== PRIMARY_HORIZON_SECONDS || manifest.horizonMs !== PRIMARY_HORIZON_MS || manifest.resolutionToleranceMs !== RESOLUTION_TOLERANCE_MS) fail('OUTCOME_DEFINITION_INVALID');
  for (const [key,value] of Object.entries(CLASSIFICATION)) if (manifest[key] !== value) fail('OUTCOME_CLASSIFICATION_INVALID');
  if (canonical(Object.keys(manifest.files ?? {}).sort()) !== canonical(['outcomes.ndjson','summary.json'])) fail('OUTCOME_FILE_SET_INVALID');
  for (const [name,hash] of Object.entries(manifest.files)) if (hashFile(path.join(dir,name)) !== hash) fail('OUTCOME_FILE_HASH_MISMATCH');
  const { fingerprint, ...content } = manifest;
  if (digest(content) !== fingerprint) fail('OUTCOME_FINGERPRINT_MISMATCH');
  const summary = sourceJson(readFileSync(path.join(dir,'summary.json')));
  if (summary.recordType !== 'outcome_summary' || summary.outcomeDefinitionId !== OUTCOME_DEFINITION_ID || summary.horizonSeconds !== PRIMARY_HORIZON_SECONDS || summary.resolutionToleranceMs !== RESOLUTION_TOLERANCE_MS) fail('OUTCOME_SUMMARY_INVALID');
  for (const [key,value] of Object.entries(CLASSIFICATION)) if (summary[key] !== value) fail('OUTCOME_CLASSIFICATION_INVALID');
  for (const line of readFileSync(path.join(dir,'outcomes.ndjson'),'utf8').trimEnd().split('\n')) {
    const row = sourceJson(line);
    if (row.recordType !== 'market_outcome' || row.outcomeDefinitionId !== OUTCOME_DEFINITION_ID || row.horizonSeconds !== PRIMARY_HORIZON_SECONDS || row.resolutionToleranceMs !== RESOLUTION_TOLERANCE_MS) fail('OUTCOME_ROW_INVALID');
    for (const [key,value] of Object.entries(CLASSIFICATION)) if (row[key] !== value) fail('OUTCOME_CLASSIFICATION_INVALID');
  }
  return manifest;
}
