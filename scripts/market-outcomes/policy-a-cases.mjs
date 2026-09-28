// Frozen P3-C Policy A (POLICY_A_CONTENT_UNIQUENESS) boundary cases.
//
// These cases are parameterized by an injected resolver so that the production
// validator and the P3-C mutation harness execute byte-identical assertions
// against the unmodified and the mutated resolver respectively. The module
// itself is a pure fixture builder: it never imports the production resolver.
//
// Frozen primary rule under test (docs/R4-P3C-PREREGISTRATION.md):
//   PRE_TARGET_PRICE_EVIDENCE takes precedence, and a same-provider raw OR
//   normalized digest match to the reference rejects the whole candidate as
//   REUSED_REFERENCE_PRICE_EVIDENCE. Zero movement stays admissible when the
//   evidence identity is distinct. No cross-provider comparison is a reuse test.
import assert from 'node:assert/strict';
import { aggregate } from '../market-intelligence/aggregate.mjs';
import { observation } from '../market-intelligence/normalize.mjs';
import { canonical, digest } from '../market-intelligence/definition.mjs';

const at = 1800000000000;
const mint = 'So11111111111111111111111111111111111111112';
const TARGET_OFFSET = 300000;

function records(time, price = 2) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint, payload: { provider, time, price }, normalized, receivedAt: time, staleMs: 60000 });
  });
}

function refresh(s) {
  for (const p of s.staleness.sourceObservations) { const primitive = { ...p }; delete primitive.observationDigest; p.observationDigest = digest(primitive); }
  s.disagreement.normalizedPayloadDigest = digest(s.disagreement.metrics);
  s.contributors.crossSourcePriceRangeBps.disagreementDigest = s.disagreement.normalizedPayloadDigest;
  s.normalizedPayloadDigest = digest({ features: s.features, contributors: s.contributors, sourceObservations: s.staleness.sourceObservations });
  return s;
}

const MATCH_SHAPES = {
  rawOnly: ['rawResponseDigest'],
  normalizedOnly: ['normalizedPayloadDigest'],
  bothEqual: ['rawResponseDigest', 'normalizedPayloadDigest'],
};
const PROVIDERS = ['jupiter', 'dexscreener'];

function makeCases(api) {
  const { resolveReference, snapshotMissingReason } = api;
  if (typeof resolveReference !== 'function' || typeof snapshotMissingReason !== 'function') throw new Error('POLICY_A_API_INVALID');
  const cases = [];
  const test = (name, fn) => cases.push([name, fn]);

  const snapshot = (time = at, price = 2) => aggregate(records(time, price), { observedAt: time })[0];
  const entry = (s, sessionId = 'fixture') => ({ snapshot: s, snapshotDigest: digest(s), sessionId, role: 'cohort' });
  const contributor = (s, provider) => s.disagreement.metrics.contributors.price.find(p => p.provider === provider);
  const source = (s, provider) => s.staleness.sourceObservations.find(x => x.provider === provider);
  const resolve = (candidates, r = entry(snapshot())) => resolveReference(r, candidates.map(s => entry(s)));

  // Copy the reference contributor's digests onto a later, post-target, otherwise
  // valid future candidate so that only the reuse rule can decide eligibility.
  const reuseInto = (referenceSnapshot, future, provider, keys) => {
    for (const key of keys) { contributor(future, provider)[key] = contributor(referenceSnapshot, provider)[key]; source(future, provider)[key] = contributor(referenceSnapshot, provider)[key]; }
    return refresh(future);
  };

  // ---------------------------------------------------------------- cases 1-9
  // Each provider crossed with each digest-equality shape.
  for (const provider of PROVIDERS) for (const [shape, keys] of Object.entries(MATCH_SHAPES)) {
    test(`P3-C A ${provider} ${shape} same-provider match rejects as REUSED_REFERENCE_PRICE_EVIDENCE`, () => {
      const r = snapshot(at);
      const f = reuseInto(r, snapshot(at + TARGET_OFFSET), provider, keys);
      assert.equal(snapshotMissingReason(f), null, 'future candidate must be structurally valid so only the reuse rule can reject it');
      const out = resolve([f], entry(r));
      assert.equal(out.status, 'unavailable');
      assert.equal(out.missingReason, 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION');
      assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });
      assert.equal(out.absLogReturn300sBps, null);
    });
  }

  // ------------------------------------------------------------------ case 10
  // A cross-provider digest equality is never a reference-reuse test, while the
  // otherwise identical same-provider equality is.
  test('P3-C A cross-provider reference digest match does not trigger REUSED_REFERENCE_PRICE_EVIDENCE', () => {
    const r = snapshot(at);
    const crossProvider = () => {
      const f = snapshot(at + TARGET_OFFSET);
      contributor(f, 'jupiter').rawResponseDigest = contributor(r, 'dexscreener').rawResponseDigest;
      source(f, 'jupiter').rawResponseDigest = contributor(r, 'dexscreener').rawResponseDigest;
      return refresh(f);
    };
    const cross = crossProvider();
    assert.equal(snapshotMissingReason(cross), null);
    const crossOut = resolve([cross], entry(r));
    assert.equal(crossOut.status, 'resolved', 'cross-provider digest equality must not reject');
    assert.deepEqual(crossOut.rejectedCandidatesByReason, {});

    const same = reuseInto(r, snapshot(at + TARGET_OFFSET), 'jupiter', ['rawResponseDigest']);
    const sameOut = resolve([same], entry(r));
    assert.deepEqual(sameOut.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 }, 'the same bytes on the same provider must still reject');
  });

  // ------------------------------------------------------------------ case 11
  // PRE_TARGET_PRICE_EVIDENCE takes precedence over the reuse code, both when the
  // content also matches the reference and when it differs.
  test('P3-C A PRE_TARGET takes precedence over REUSED for a matching same-provider digest', () => {
    const r = snapshot(at);
    const f = reuseInto(r, snapshot(at + TARGET_OFFSET), 'dexscreener', MATCH_SHAPES.bothEqual);
    contributor(f, 'dexscreener').providerObservedAt = at + TARGET_OFFSET - 1;
    source(f, 'dexscreener').providerObservedAt = at + TARGET_OFFSET - 1;
    source(f, 'dexscreener').budgetMs = 1000000;
    refresh(f);
    assert.equal(snapshotMissingReason(f), null);
    const out = resolve([f], entry(r));
    assert.deepEqual(out.rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1 });
    assert.equal(out.rejectedCandidatesByReason.REUSED_REFERENCE_PRICE_EVIDENCE, undefined);
  });
  test('P3-C A PRE_TARGET rejects changed content with no digest match at all', () => {
    const f = snapshot(at + TARGET_OFFSET, 9);
    contributor(f, 'jupiter').providerObservedAt = at + TARGET_OFFSET - 1;
    source(f, 'jupiter').providerObservedAt = at + TARGET_OFFSET - 1;
    source(f, 'jupiter').budgetMs = 1000000;
    refresh(f);
    assert.equal(snapshotMissingReason(f), null);
    assert.deepEqual(resolve([f]).rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1 });
  });

  // ------------------------------------------------------------------ case 12
  test('P3-C A rejection counts record reuse alongside other reasons', () => {
    const r = snapshot(at);
    const preTarget = snapshot(at + TARGET_OFFSET);
    contributor(preTarget, 'jupiter').providerObservedAt = at + TARGET_OFFSET - 1;
    source(preTarget, 'jupiter').providerObservedAt = at + TARGET_OFFSET - 1;
    source(preTarget, 'jupiter').budgetMs = 1000000;
    refresh(preTarget);
    const reusedRaw = reuseInto(r, snapshot(at + 310000), 'jupiter', MATCH_SHAPES.rawOnly);
    const reusedNormalized = reuseInto(r, snapshot(at + 320000), 'dexscreener', MATCH_SHAPES.normalizedOnly);
    const valid = snapshot(at + 330000, 3);
    const out = resolve([preTarget, reusedRaw, reusedNormalized, valid], entry(r));
    assert.equal(out.status, 'resolved');
    assert.equal(out.resolvedAt, at + 330000);
    assert.deepEqual(out.rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1, REUSED_REFERENCE_PRICE_EVIDENCE: 2 });
  });

  // ------------------------------------------------------------------ case 13
  test('P3-C A first reused candidate is skipped for the later valid candidate', () => {
    const r = snapshot(at);
    const reused = reuseInto(r, snapshot(at + TARGET_OFFSET), 'jupiter', MATCH_SHAPES.rawOnly);
    const valid = snapshot(at + 310000, 5);
    const out = resolve([reused, valid], entry(r));
    assert.equal(out.status, 'resolved');
    assert.equal(out.resolvedAt, at + 310000);
    assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });
    assert.equal(canonical(out), canonical(resolve([valid, reused], entry(r))), 'candidate selection must be input-order independent');
  });
  test('P3-C A later valid ties resolve deterministically after a reused candidate', () => {
    const r = snapshot(at);
    const reused = entry(reuseInto(r, snapshot(at + TARGET_OFFSET), 'dexscreener', MATCH_SHAPES.bothEqual));
    const tied = entry(snapshot(at + 310000, 5), 'a');
    const alsoTied = entry(snapshot(at + 310000, 5), 'z');
    assert.equal(tied.snapshotDigest, alsoTied.snapshotDigest);
    const out = resolveReference(entry(r), [alsoTied, reused, tied]);
    assert.equal(out.status, 'resolved');
    assert.equal(out.futureSessionId, 'a');
    assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 1 });
  });

  // ------------------------------------------------------------------ case 14
  test('P3-C A all candidates reused leaves the reference unavailable', () => {
    const r = snapshot(at);
    const candidates = [
      reuseInto(r, snapshot(at + 300000), 'jupiter', MATCH_SHAPES.rawOnly),
      reuseInto(r, snapshot(at + 310000), 'dexscreener', MATCH_SHAPES.normalizedOnly),
      reuseInto(r, snapshot(at + 320000), 'jupiter', MATCH_SHAPES.bothEqual),
    ];
    const out = resolve(candidates, entry(r));
    assert.equal(out.status, 'unavailable');
    assert.equal(out.missingReason, 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION');
    assert.deepEqual(out.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 3 });
    assert.equal(out.absLogReturn300sBps, null);
    assert.equal(out.logReturn300sBps, undefined);
  });

  // ------------------------------------------------------------------ case 15
  // Policy A rejects evidence identity reuse, not zero movement.
  test('P3-C A distinct flat evidence with zero movement is admissible', () => {
    const r = snapshot(at, 2);
    const f = snapshot(at + TARGET_OFFSET, 2);
    assert.equal(f.disagreement.metrics.priceMedianUsd, r.disagreement.metrics.priceMedianUsd, 'the numeric price must be unchanged');
    for (const provider of PROVIDERS) {
      assert.notEqual(contributor(f, provider).rawResponseDigest, contributor(r, provider).rawResponseDigest);
      assert.notEqual(contributor(f, provider).normalizedPayloadDigest, contributor(r, provider).normalizedPayloadDigest);
    }
    assert.equal(snapshotMissingReason(f), null);
    const out = resolve([f], entry(r));
    assert.equal(out.status, 'resolved');
    assert.equal(out.logReturn300sBps, 0);
    assert.equal(out.absLogReturn300sBps, 0);
    assert.deepEqual(out.rejectedCandidatesByReason, {});
  });

  // ------------------------------------------------------------------ case 16
  test('P3-C A resolution is byte-identical under candidate and source reordering', () => {
    const r = snapshot(at);
    const candidates = [
      reuseInto(r, snapshot(at + 300000), 'jupiter', MATCH_SHAPES.rawOnly),
      reuseInto(r, snapshot(at + 310000), 'dexscreener', MATCH_SHAPES.normalizedOnly),
      snapshot(at + 320000, 5),
      snapshot(at + 330000, 7),
    ];
    const permutations = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
    const results = permutations.map(order => resolveReference(entry(r), order.map(i => entry(candidates[i], 's' + i))));
    const [first, ...rest] = results;
    for (const other of rest) {
      assert.equal(canonical(other), canonical(first), 'reordered inputs must produce a byte-identical result');
      assert.deepEqual(other.rejectedCandidatesByReason, first.rejectedCandidatesByReason);
    }
    assert.equal(first.resolvedAt, at + 320000, 'the earliest surviving candidate in window order wins');
    assert.deepEqual(first.rejectedCandidatesByReason, { REUSED_REFERENCE_PRICE_EVIDENCE: 2 });

    // The production indexed (Map) path used by generateOutcomeRun must agree too.
    const indexed = candidates.map((s, i) => entry(s, 's' + i)).sort((a, b) => a.snapshot.observedAt - b.snapshot.observedAt);
    const byMint = new Map([[mint, indexed]]);
    assert.equal(canonical(resolveReference(entry(r), byMint)), canonical(first));
  });

  return cases;
}

export const POLICY_A_SNAPSHOT_OFFSET = TARGET_OFFSET;
export const POLICY_A_FIXTURE_TIME = at;
export const POLICY_A_FIXTURE_MINT = mint;
export function policyACases(api) { return makeCases(api); }
