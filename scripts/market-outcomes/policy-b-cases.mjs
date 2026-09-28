// Frozen P3-C Policy B (POLICY_B_OBSERVATION_IDENTITY) SENSITIVITY-ONLY cases.
//
// Policy B is a predeclared sensitivity analysis. It never replaces the
// primary Policy A result. These cases are parameterized by both resolvers so
// the same input can be compared side by side.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregate } from '../market-intelligence/aggregate.mjs';
import { observation } from '../market-intelligence/normalize.mjs';
import { canonical, digest } from '../market-intelligence/definition.mjs';
import { createStorage } from '../market-intelligence/storage.mjs';
import { generateOutcomeRun, readSourceSession } from './index.mjs';
import {
  PRIMARY_POLICY, SENSITIVITY_POLICY, SENSITIVITY_RECORD_TYPE, SENSITIVITY_TRUST_ASSUMPTION,
  SENSITIVITY_ALLOWED_COMPARISONS, SENSITIVITY_FORBIDDEN_USES, sensitivityAvailability,
} from './sensitivity.mjs';

const at = 1800000000000;
const mint = 'So11111111111111111111111111111111111111112';
const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PRIMARY_MODULE = 'scripts/market-outcomes/index.mjs';
const SENSITIVITY_MODULE = 'scripts/market-outcomes/sensitivity.mjs';

function records(time, price = 2, identity = mint) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint: identity, payload: { provider, time, price }, normalized, receivedAt: time, staleMs: 60000 });
  });
}
function refresh(s) {
  for (const p of s.staleness.sourceObservations) { const primitive = { ...p }; delete primitive.observationDigest; p.observationDigest = digest(primitive); }
  s.disagreement.normalizedPayloadDigest = digest(s.disagreement.metrics);
  s.contributors.crossSourcePriceRangeBps.disagreementDigest = s.disagreement.normalizedPayloadDigest;
  s.normalizedPayloadDigest = digest({ features: s.features, contributors: s.contributors, sourceObservations: s.staleness.sourceObservations });
  return s;
}
// Strip full-line comments so assertions inspect executable code, not prose.
const executable = file => readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');

// Outcome runs are published read-only (0o555 / 0o444); make them removable.
function removeTree(dir) {
  const walk = p => { try { chmodSync(p, 0o755); } catch { return; } for (const e of readdirSync(p, { withFileTypes: true })) { const child = path.join(p, e.name); if (e.isDirectory()) walk(child); else { try { chmodSync(child, 0o644); } catch {} } } };
  walk(dir); rmSync(dir, { recursive: true, force: true });
}

// Remove the sensitivity-labelling keys so A and B records can be compared
// structurally for everything that is NOT the labelling itself.
const LABELLING_KEYS = ['recordType', 'primaryPolicy', 'sensitivityPolicy', 'sensitivityOnly', 'sensitivityTrustAssumption'];
const untagged = record => { const copy = { ...record }; for (const key of LABELLING_KEYS) delete copy[key]; return copy; };

// A disposable source session plus the matching generateOutcomeRun inputs.
function sourceFixture(times) {
  const root = mkdtempSync(path.join(tmpdir(), 'p3c-policy-b-'));
  const storage = createStorage({ root, sessionId: 'p3c-b', startedAt: times[0] });
  for (const t of times) { const rs = records(t, 2); for (const r of rs) storage.writeObservation(r, { provider: r.provider, time: t, price: 2 }); storage.writeSnapshot(aggregate(rs, { observedAt: t })[0]); }
  storage.finalize({ endedAt: times.at(-1), reason: 'duration reached' });
  return { root, dir: storage.dir };
}
const runInput = (dir, reference, outputRoot) => ({ sources: [{ dir, role: 'cohort' }], references: [reference], outputRoot, runId: 'p3c-b-run', createdAt: at + 600000, sealedCode: { sha: 'fixture-sha', tree: 'fixture-tree' } });

export function policyBCases(api) {
  const { resolveReference, snapshotMissingReason, resolveReferencePolicyB } = api;
  if ([resolveReference, snapshotMissingReason, resolveReferencePolicyB].some(f => typeof f !== 'function')) throw new Error('POLICY_B_API_INVALID');
  const cases = [];
  const test = (name, fn) => cases.push([name, fn]);

  const snapshot = (time = at, price = 2, identity = mint) => aggregate(records(time, price, identity), { observedAt: time })[0];
  const entry = (s, sessionId = 'fixture') => ({ snapshot: s, snapshotDigest: digest(s), sessionId, role: 'cohort' });
  const contributor = (s, provider) => s.disagreement.metrics.contributors.price.find(p => p.provider === provider);
  const source = (s, provider) => s.staleness.sourceObservations.find(x => x.provider === provider);
  const A = (candidates, r = entry(snapshot())) => resolveReference(r, candidates.map(s => entry(s)));
  const B = (candidates, r = entry(snapshot())) => resolveReferencePolicyB(r, candidates.map(s => entry(s)));

  // A later, separately persisted, post-target, otherwise fully valid observation
  // whose same-provider raw AND normalized bytes equal the reference's.
  const identicalBytes = (referenceSnapshot, provider) => {
    const f = snapshot(at + 300000, 2);
    for (const key of ['rawResponseDigest', 'normalizedPayloadDigest']) {
      contributor(f, provider)[key] = contributor(referenceSnapshot, provider)[key];
      source(f, provider)[key] = contributor(referenceSnapshot, provider)[key];
    }
    return refresh(f);
  };

  // ------------------------------------------------------------------ case 1
  test('P3-C B accepts same-provider identical raw+normalized bytes with a later valid observation identity', () => {
    const r = snapshot(at);
    for (const provider of ['jupiter', 'dexscreener']) {
      const f = identicalBytes(r, provider);
      assert.equal(snapshotMissingReason(f), null, 'the observation must be fully valid; only the reuse rule differs');
      assert.ok(f.observedAt > r.observedAt, 'it is a genuinely later observation');
      assert.notEqual(f.normalizedPayloadDigest, r.normalizedPayloadDigest, 'it is separately persisted, not a copied snapshot');
      const out = B([f], entry(r));
      assert.equal(out.status, 'resolved');
      assert.equal(out.absLogReturn300sBps, 0, 'the flat observation is retained rather than censored');
      assert.deepEqual(out.rejectedCandidatesByReason, {});
    }
  });

  // ------------------------------------------------------------------ case 2
  test('P3-C B the same input is rejected under the primary policy A', () => {
    const r = snapshot(at);
    for (const provider of ['jupiter', 'dexscreener']) {
      const out = A([identicalBytes(r, provider)], entry(r));
      assert.equal(out.status, 'unavailable');
      assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });
    }
  });

  // ------------------------------------------------------------------ case 3
  test('P3-C B PRE_TARGET is still rejected, and still takes precedence over identical bytes', () => {
    const r = snapshot(at);
    const matching = identicalBytes(r, 'dexscreener');
    contributor(matching, 'dexscreener').providerObservedAt = at + 299999;
    source(matching, 'dexscreener').providerObservedAt = at + 299999;
    source(matching, 'dexscreener').budgetMs = 1000000;
    refresh(matching);
    assert.equal(snapshotMissingReason(matching), null);
    assert.deepEqual(B([matching], entry(r)).rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1 });

    const distinct = snapshot(at + 300000, 9);
    contributor(distinct, 'jupiter').providerObservedAt = at + 299999;
    source(distinct, 'jupiter').providerObservedAt = at + 299999;
    source(distinct, 'jupiter').budgetMs = 1000000;
    refresh(distinct);
    assert.deepEqual(B([distinct], entry(r)).rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1 });
  });

  // ------------------------------------------------------------------ case 4
  test('P3-C B invalid provenance is still rejected', () => {
    const r = snapshot(at);
    const tampered = snapshot(at + 300000);
    source(tampered, 'jupiter').observationDigest = '0'.repeat(64);
    assert.deepEqual(B([tampered], entry(r)).rejectedCandidatesByReason, { INVALID_SOURCE_PROVENANCE: 1 });

    const broken = snapshot(at + 300000);
    broken.staleness.sourceObservations[0].receivedAt = at + 1;
    refresh(broken);
    assert.deepEqual(B([broken], entry(r)).rejectedCandidatesByReason, { NO_LOOKAHEAD_VIOLATION: 1 });

    const explicit = { ...entry(snapshot(at + 300000)), validationReason: 'REFERENCE_IDENTITY_NOT_UNIQUE' };
    assert.deepEqual(resolveReferencePolicyB(entry(r), [explicit]).rejectedCandidatesByReason, { REFERENCE_IDENTITY_NOT_UNIQUE: 1 });
  });

  // ------------------------------------------------------------------ case 5
  test('P3-C B duplicate within-snapshot evidence is still rejected', () => {
    const r = snapshot(at);
    const f = snapshot(at + 300000);
    contributor(f, 'jupiter').rawResponseDigest = contributor(f, 'dexscreener').rawResponseDigest;
    source(f, 'jupiter').rawResponseDigest = contributor(f, 'dexscreener').rawResponseDigest;
    refresh(f);
    assert.equal(snapshotMissingReason(f), 'DUPLICATE_PRICE_EVIDENCE');
    assert.deepEqual(B([f], entry(r)).rejectedCandidatesByReason, { DUPLICATE_PRICE_EVIDENCE: 1 });
  });

  // ------------------------------------------------------------------ case 6
  test('P3-C B freshness rules are unchanged', () => {
    const r = snapshot(at);
    for (const provider of ['jupiter', 'dexscreener']) {
      const stale = snapshot(at + 300000);
      source(stale, provider).budgetMs = 0; stale.observedAt++; stale.disagreement.observedAt++; refresh(stale);
      assert.equal(snapshotMissingReason(stale), 'STALE_PRICE_CONTRIBUTOR');
      assert.deepEqual(B([stale], entry(r)).rejectedCandidatesByReason, { STALE_PRICE_CONTRIBUTOR: 1 });
    }
  });

  // ------------------------------------------------------------------ case 7
  test('P3-C B alignment rules are unchanged', () => {
    const r = snapshot(at);
    const f = snapshot(at + 300000);
    const p = contributor(f, 'jupiter'), src = source(f, 'jupiter');
    src.providerObservedAt -= 15001; p.providerObservedAt -= 15001; refresh(f);
    assert.equal(snapshotMissingReason(f), 'MISALIGNED_PRICE_CONTRIBUTOR');
    assert.deepEqual(B([f], entry(r)).rejectedCandidatesByReason, { MISALIGNED_PRICE_CONTRIBUTOR: 1 });
  });

  // ------------------------------------------------------------------ case 8
  test('P3-C B candidate ordering is unchanged', () => {
    const r = snapshot(at);
    const invalid = snapshot(at + 300000); invalid.disagreement.metrics.priceMedianUsd = 0;
    const valid = snapshot(at + 310000, 5);
    const later = snapshot(at + 320000, 9);
    for (const ordering of [[invalid, valid, later], [later, valid, invalid], [valid, later, invalid]]) {
      const out = B(ordering, entry(r));
      assert.equal(out.status, 'resolved');
      assert.equal(out.resolvedAt, at + 310000, 'the earliest valid candidate in window order still wins');
      assert.deepEqual(out.rejectedCandidatesByReason, { INVALID_PRICE: 1 });
    }
    const tied = entry(snapshot(at + 310000, 5), 'a'), alsoTied = entry(snapshot(at + 310000, 5), 'z');
    assert.equal(resolveReferencePolicyB(entry(r), [alsoTied, tied]).futureSessionId, 'a', 'digest then session-ID tie-break is preserved');
  });

  // ------------------------------------------------------------------ case 9
  test('P3-C B every output explicitly identifies the sensitivity policy and its trust assumption', () => {
    const r = snapshot(at);
    for (const candidates of [[identicalBytes(r, 'jupiter')], [snapshot(at + 300000, 3)], []]) {
      const out = B(candidates, entry(r));
      assert.equal(out.sensitivityPolicy, SENSITIVITY_POLICY);
      assert.equal(out.primaryPolicy, PRIMARY_POLICY);
      assert.equal(out.sensitivityOnly, true);
      assert.equal(out.sensitivityTrustAssumption, SENSITIVITY_TRUST_ASSUMPTION);
      assert.equal(out.recordType, SENSITIVITY_RECORD_TYPE);
      assert.notEqual(out.recordType, 'market_outcome', 'a sensitivity record must never carry the primary record type');
    }
    assert.equal(SENSITIVITY_TRUST_ASSUMPTION, 'A later locally timestamped provider receipt is accepted as evidence of a distinct upstream observation even if the provider supplies identical payload bytes.');
  });

  // ----------------------------------------------------------------- case 10
  test('P3-C B sensitivity output cannot overwrite or substitute a primary output', () => {
    const code = readFileSync(SENSITIVITY_MODULE, 'utf8');
    assert(!/from\s+['"]node:fs['"]/.test(code), 'the sensitivity module must not import the filesystem');
    const executableCode = executable(SENSITIVITY_MODULE);
    for (const forbidden of ['writeFileSync', 'mkdirSync', 'renameSync', 'openSync', 'createWriteStream', 'generateOutcomeRun', 'verifyOutcomeRun']) {
      assert(!executableCode.includes(forbidden), `the sensitivity module must not call ${forbidden}`);
    }
    assert(!/^(let|var)\s+\w+/m.test(executableCode), 'the sensitivity module must declare no mutable module-level state');
    const withoutImports = executableCode.replace(/^import[\s\S]*?from\s+'[^']+';?$/gm, '');
    for (const line of withoutImports.split('\n')) {
      if (line.trim() === '' || /^\s/.test(line) || /^[\/*})\]]/.test(line.trim())) continue;
      assert(/^(export\s+)?(const|function)\b/.test(line), `unexpected top-level statement in the sensitivity module: ${line.slice(0, 60)}`);
    }

    const { root, dir } = sourceFixture([at, at + 300000]);
    try {
      const reference = { sessionId: 'p3c-b', snapshotDigest: readSourceSession({ dir, role: 'cohort' }).snapshots[0].snapshotDigest };
      const before = generateOutcomeRun(runInput(dir, reference, path.join(root, 'primary-a')));
      const primaryBytes = readFileSync(path.join(before.dir, 'outcomes.ndjson'), 'utf8');
      B([snapshot(at + 300000, 3)], entry(snapshot(at)));
      const after = generateOutcomeRun(runInput(dir, reference, path.join(root, 'primary-b')));
      assert.equal(before.manifest.fingerprint, after.manifest.fingerprint, 'sensitivity must not perturb the primary result');
      assert.equal(readFileSync(path.join(after.dir, 'outcomes.ndjson'), 'utf8'), primaryBytes);
      for (const artifact of readdirSync(before.dir)) assert(!/sensitiv/i.test(artifact), 'no sensitivity artifact may appear in a primary run directory');
      assert(!primaryBytes.includes('POLICY_B'), 'a primary outcome file must never contain a sensitivity policy tag');
    } finally { removeTree(root); }
  });

  // ----------------------------------------------------------------- case 11
  test('P3-C B the default invocation always uses primary policy A', () => {
    const primary = readFileSync(PRIMARY_MODULE, 'utf8');
    assert(!primary.includes('sensitivity'), 'the primary resolver must not reference the sensitivity module');
    assert(!primary.includes('POLICY_B'), 'the primary resolver must not name Policy B');
    assert(!primary.includes('process.env'), 'the primary resolver must not read ambient environment state');

    const r = snapshot(at);
    const out = A([identicalBytes(r, 'jupiter')], entry(r));
    assert.equal(out.recordType, 'market_outcome', 'the default entry point still emits the primary record type');
    assert.equal(out.sensitivityPolicy, undefined);
    assert.equal(out.primaryPolicy, undefined);
    assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });

    const { root, dir } = sourceFixture([at, at + 300000]);
    try {
      const reference = { sessionId: 'p3c-b', snapshotDigest: readSourceSession({ dir, role: 'cohort' }).snapshots[0].snapshotDigest };
      const run = generateOutcomeRun(runInput(dir, reference, path.join(root, 'default')));
      for (const artifact of ['outcomes.ndjson', 'summary.json', 'manifest.json']) {
        const body = readFileSync(path.join(run.dir, artifact), 'utf8');
        assert(!/sensitiv|POLICY_B/i.test(body), `the default ${artifact} must carry no sensitivity tag`);
      }
    } finally { removeTree(root); }
  });

  // ----------------------------------------------------------------- case 12
  test('P3-C B no sensitivity result can alter primary selection, thresholds, cohort membership or output files', () => {
    const executableCode = executable(SENSITIVITY_MODULE);
    // Every scientific constant is imported from the primary module, never redefined.
    for (const constant of ['PRIMARY_HORIZON_MS =', 'RESOLUTION_TOLERANCE_MS =', 'PRIMARY_HORIZON_SECONDS =']) {
      assert(!executableCode.includes(`const ${constant}`), `the sensitivity module must not redefine ${constant}`);
    }
    assert(executableCode.includes('PRIMARY_HORIZON_SECONDS, PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS'), 'thresholds must be imported from the primary module');
    // The sensitivity resolver consumes one reference; it never selects one.
    assert(!/\breferences\b\s*[:=]/.test(executableCode), 'the sensitivity module must not take or build a reference list');
    assert.equal(SENSITIVITY_ALLOWED_COMPARISONS.length, 5);
    assert(SENSITIVITY_ALLOWED_COMPARISONS.every(s => typeof s === 'string' && s.length > 0));
    assert.equal(SENSITIVITY_FORBIDDEN_USES.length, 7);
    assert(SENSITIVITY_FORBIDDEN_USES.some(u => /replacing Policy A/.test(u)));
    assert(SENSITIVITY_FORBIDDEN_USES.some(u => /rescue an unfavorable primary result/.test(u)));
    assert.deepEqual(sensitivityAvailability([B([]), B([snapshot(at + 300000, 3)])]), { resolvedCount: 1, unresolvedCount: 1, unresolvedByReason: { NO_SAME_MINT_OBSERVATION_IN_WINDOW: 1 } });
  });

  // Differential equivalence: A and B must agree on EVERYTHING except the reuse rule.
  test('P3-C A and B differ only on the same-provider reuse rule', () => {
    const r = snapshot(at);
    const stale = snapshot(at + 300000); source(stale, 'jupiter').budgetMs = 0; stale.observedAt++; stale.disagreement.observedAt++; refresh(stale);
    const misaligned = snapshot(at + 305000); const mp = contributor(misaligned, 'jupiter'), msrc = source(misaligned, 'jupiter'); msrc.providerObservedAt -= 15001; mp.providerObservedAt -= 15001; refresh(misaligned);
    const duplicate = snapshot(at + 310000); contributor(duplicate, 'jupiter').rawResponseDigest = contributor(duplicate, 'dexscreener').rawResponseDigest; source(duplicate, 'jupiter').rawResponseDigest = contributor(duplicate, 'dexscreener').rawResponseDigest; refresh(duplicate);
    const preTarget = snapshot(at + 315000); contributor(preTarget, 'jupiter').providerObservedAt = at + 314999; source(preTarget, 'jupiter').providerObservedAt = at + 314999; source(preTarget, 'jupiter').budgetMs = 1000000; refresh(preTarget);
    const invalidPrice = snapshot(at + 320000); invalidPrice.disagreement.metrics.priceMedianUsd = 0;

    const scenarios = {
      'no candidates': [],
      'distinct valid': [snapshot(at + 300000, 3)],
      'distinct flat': [snapshot(at + 300000, 2)],
      'stale contributor': [stale],
      'misaligned contributor': [misaligned],
      'duplicate within snapshot': [duplicate],
      'pre-target contributor': [preTarget],
      'invalid price': [invalidPrice],
      'other mint only': [snapshot(at + 300000, 4, other)],
      'stale then valid': [stale, snapshot(at + 300000, 3)],
      'misaligned then valid': [misaligned, snapshot(at + 300000, 3)],
      'pre-target then valid': [preTarget, snapshot(at + 300000, 3)],
      'outside window': [snapshot(at + 360001, 3)],
      'before target': [snapshot(at + 299999, 3)],
    };
    for (const [name, candidates] of Object.entries(scenarios)) {
      assert.equal(canonical(untagged(A(candidates, entry(r)))), canonical(untagged(B(candidates, entry(r)))), `A and B must agree on: ${name}`);
    }
    // And they must differ exactly where the reuse rule fires, and only there.
    const identical = identicalBytes(r, 'dexscreener');
    const aOut = A([identical], entry(r)), bOut = B([identical], entry(r));
    assert.equal(aOut.status, 'unavailable');
    assert.equal(bOut.status, 'resolved');
    assert.deepEqual(aOut.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });
    assert.deepEqual(bOut.rejectedCandidatesByReason, {});
    // Every reference-identifying field is identical; only the verdict differs.
    for (const field of ['mint', 'referenceSessionId', 'referenceSnapshotDigest', 'referenceNormalizedPayloadDigest', 'referenceObservedAt', 'referencePriceUsd', 'targetAt', 'horizonSeconds', 'resolutionToleranceMs', 'outcomeDefinitionId', 'primaryField']) {
      assert.equal(canonical(aOut[field]), canonical(bOut[field]), `reference field must match across policies: ${field}`);
    }
    assert.equal(bOut.futureSnapshotDigest, digest(identical), 'the sensitivity result selects the same candidate the primary rule rejects');
  });

  return cases;
}
