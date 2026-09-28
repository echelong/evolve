# Generic immutable market outcome foundation

This creates an outcome primitive, **not evidence for R4**. No real R4 cohort has
been collected by this work. It does not preregister R4, calculate shakedown
outcomes, select a metric, fit a regression, or establish predictive edge or
profitability. Phase 5I direction, PS.1 forensic, Jev calibration, and engine
paper P&L outcome systems remain separate and unchanged.

V1 is frozen:

- Definition: `ABS_LOG_RETURN_300S_BPS_V1`, continuous.
- Primary field: `absLogReturn300sBps`.
- Formula: `abs(ln(futurePriceUsd / referencePriceUsd)) * 10_000`.
- Horizon: 300 seconds (300,000 ms).
- Inclusive future resolution window: target through target + 60,000 ms.

This measures **future movement magnitude**, not direction. The signed
`logReturn300sBps` is descriptive / provenance only, never another primary
outcome. Values and input prices use JavaScript binary64 numbers, serialized
without rounding using JSON's round-trip number representation. Reproduce the
value with `Math.abs(Math.log(futurePriceUsd / referencePriceUsd) * 10_000)`.
Nonfinite arithmetic makes the outcome unavailable; it never triggers a price
substitution.

## Offline API and evidence policy

`scripts/market-outcomes/index.mjs` exposes `readSourceSession`,
`generateOutcomeRun`, `verifyOutcomeRun`, and pure validation/resolution helpers. It has no CLI,
network dependency, capture operation, prediction model, or trading capability.
The generation API requires explicit inputs:

```js
const verified = readSourceSession({ dir: syntheticSessionDir, role: 'cohort' });
const result = generateOutcomeRun({
  sources: [
    { dir: syntheticSessionDir, role: 'cohort' },
    { dir: syntheticMaturationDir, role: 'maturation' },
  ],
  references: [{
    sessionId: verified.sessionId,
    snapshotDigest: verified.snapshots[0].snapshotDigest,
  }],
  outputRoot: injectedSeparateRoot,
  runId: 'example-run',
  createdAt: evidenceCutoffEpochMs,
  sealedCode: { sha: suppliedCodeSha, tree: suppliedCodeTree },
});
```

The example names denote synthetic fixtures; do not use it to select a real
cohort. Reference selection is a separate future protocol responsibility. This
API does not automatically treat every snapshot as a predictor. `createdAt` is
an explicit deterministic caller input: all supplied snapshots must already
exist by that cutoff and every reference's entire resolution window must have
matured. No reference information may have timestamps later than its own
`observedAt`.

`R4_SOURCE_POLICY` explicitly requires `summary.status = complete`,
`summary.reason = duration reached`, and
`summary.storage.sessionBoundReached = false`, for every source including
maturation. A non-R4 caller can explicitly supply
`sourcePolicy: { requireDurationComplete: false }`; the selected policy is
recorded in the output. This does not relax the frozen horizon or tolerance.

The interface supports 48 cohort sessions and a separately designated maturation
session without imposing or claiming the later protocol's exact maturation rule.
A maturation session contributes future candidates only. References from it are
rejected. References near one session's end can resolve in another session,
including the designated maturation session. No sessions were started here.

## Price eligibility and ordering

Both reference and future must be existing Solana `intelligence_snapshot`
records with a valid mint identity. Price contributor provenance must name
exactly Jupiter and DexScreener, each once. Source counts alone are insufficient.
Each contributor must match recorded source provenance, including normalized and
raw evidence digests, endpoint, and provider timestamp. Persisted normalized
market observations must corroborate these contributor identities and contain a
positive price; shared raw or normalized evidence cannot masquerade as two
independent providers. Snapshot and disagreement normalized digests are checked.

For each future Jupiter and DexScreener price contributor, `providerObservedAt` must be at or after the frozen target. A future contributor cannot reuse the matching reference provider’s raw response or normalized payload digest. Recorded budgets cannot relax either rule. Each snapshot independently passes recorded freshness budgets and the recorded
alignment rule. Alignment uses the newest fresh recorded source timestamp,
matching Phase 5J's rule. All recorded source timestamps and snapshot capture
timestamps are checked for lookahead. The price basis is the **already computed
genuine two-source Jupiter+DexScreener median**,
`disagreement.metrics.priceMedianUsd`, finite and strictly positive. It is never
recomputed using a different pair-selection rule. Other providers may be present
for unrelated snapshot measurements; none may contribute to this price median.

`targetAt = referenceObservedAt + 300_000`. Among same-mint future snapshots in
the inclusive window, select the first valid candidate ordered by:

1. `observedAt` ascending;
2. full reconstructed snapshot SHA-256 digest ascending (ASCII hex order);
3. session ID ascending, for identical timestamp and digest across sessions.

Candidates are indexed by mint, sorted once in this order, and located by binary search over the frozen target window. Reference digests also have per-session indexes, and merged source-coverage spans are searched by target. Resolution therefore examines only same-mint candidates in that window.

Phase 5J stores snapshots and disagreement separately. Reconstruction indexes disagreement records by mint, timestamp, and recorded digest, and market observations by the full chain/mint/provider/endpoint/provider timestamp/raw digest/normalized digest tuple. A join must have exactly one body or observation; duplicates fail closed. The per-session parsed NDJSON arrays and indexes are released after a compact validated candidate is built. Each candidate retains its full reconstruction digest, cached validation result, timestamps, price median, contributor provenance, and output digests. Missing or ambiguous disagreement bodies reject the source with `MISSING_DISAGREEMENT_JOIN` or `AMBIGUOUS_DISAGREEMENT_JOIN`. The
stored full snapshot digest covers the joined representation, while the original
snapshot and disagreement normalized digests remain source provenance.

Every resolved row records reference and future prices, timestamps, session IDs,
full snapshot digests, normalized digests, contributor provenance, target, and
resolution lag. The resolver proves reference < target and target <= future <=
target + tolerance. Outcomes never enter a source session.

## Missing outcomes

Unavailable stays unavailable. There is no single-source, GMGN, launch, engine,
network, interpolation, extrapolation, pre-target, or extended-window fallback.
A row has a null primary value and an exact `missingReason`:

- `REFERENCE_` plus the snapshot validation reason below (or
  `REFERENCE_INVALID_TIMESTAMP`).
- `SOURCE_COVERAGE_GAP` if the union of eligible source session start/end spans does not cover the entire inclusive target-to-target-plus-tolerance interval; this is collection absence, not mint absence.
- `NO_SAME_MINT_OBSERVATION_IN_WINDOW` when that interval is covered but the mint has no candidate.
- `NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION` with exact counts of rejected
  candidates by validation reason.
- `NONFINITE_LOG_RETURN`.

Snapshot validation reasons are `INVALID_SNAPSHOT`, `INVALID_PRICE`,
`INVALID_PRICE_CONTRIBUTORS`, `INVALID_SOURCE_PROVENANCE`,
`NO_LOOKAHEAD_VIOLATION`, `INVALID_SOURCE_BUDGET`, `INVALID_PAYLOAD_DIGEST`,
`INVALID_ALIGNMENT_RULE`, `STALE_PRICE_CONTRIBUTOR`,
`MISALIGNED_PRICE_CONTRIBUTOR`, and `DUPLICATE_PRICE_EVIDENCE`.
Both resolved and unavailable rows persist deterministic `rejectedCandidatesByReason`, including invalid earlier candidates skipped before a valid future. Source integrity, session policy, immature windows, invalid reference selection,
or output conflicts reject the run rather than emitting scientific values from
untrusted evidence.

## Integrity, separate output, and authority

Before interpreting source evidence, verify the manifest schema/identity, exact
listed file set, every listed SHA-256, and the canonical file-map fingerprint.
Reject path traversal, symlinks, missing/unlisted files, identity discrepancies,
and tampering. Evidence reads are checked against verified bytes; NDJSON is parsed one line at a time from bounded read chunks. The tree is rehashed after reading and immediately before publication. Failed runs also rehash during cleanup, preserving a primary error if both fail. Successful runs do not perform a post-publication check that could report a new failure after finalization. These passes authenticate pre-read files, interpreted bytes, and pre-publication immutability independently. Source files and the manifest must remain byte-identical. There is no repair path.

Output goes only to a caller-injected separate tree, suitable later for
`.evolve/market-outcomes/<runId>/`. Implementation validation uses temporary roots
only. Source and output trees cannot overlap. Protected EVOLVE source, history, arena, research, and production-state roots are barred even if not supplied as sources. Exclusive directory creation reserves the run ID, even if a failed write leaves a partial run. Body files use exclusive creation, mode 0444, and fsync. Source integrity is rechecked before manifest publication. The manifest is written to an exclusive temporary file, fsynced, then atomically renamed as the finalization marker; the directory is fsynced and set to mode 0555. A partial run has no final manifest and is not valid evidence. `verifyOutcomeRun` reads only and checks the exact file set, finalized status, hashes, fingerprint, classification, definition, horizon, and tolerance. It never repairs a run. Verification authenticates bytes and structure; file modes are asserted at generation time and are not part of the manifest fingerprint. Source failures on cleanup preserve an earlier primary error in an `AggregateError`. Existing runs are never reopened for writing. This is
application-level immutability, not a claim that a filesystem owner cannot alter
files externally.

Artifacts are `outcomes.ndjson`, `summary.json`, and `manifest.json`. Metadata
records schema version, definition, primary field/type, horizon, tolerance,
source roles/IDs/fingerprints/manifest hashes, input policy, supplied sealed code
identity, createdAt, record/resolved/unresolved counts, missing reason counts,
output file hashes, and final fingerprint. The final fingerprint hashes canonical
manifest content excluding the fingerprint itself; it covers both metadata and
output hashes. Equal explicit inputs yield equal bytes and fingerprints.

Every row, summary, and manifest carries:

```text
developmentOnly = researchOnly = paperOnly = observerOnly = true
tradingAuthority = engineAuthority = arenaEligible = promotionEligible = false
profitabilityInferencePermitted = false
```

This has **zero trading authority**. It computes market outcomes only. Organic
flow fields and coverage are untouched. Later R4 will use non-imputed Jupiter
`organicBuySellRatio` from the exact reference evidence; null stays missing.
There is no new `features.organicFlow` or fake coverage covariate.

## Validation

`npm run validate:market-outcomes` uses synthetic temporary Phase 5J-format
fixtures. It tests frozen timing boundaries, first-valid and digest tie ordering,
mint/provider restrictions, bad prices, known-answer math, provenance/freshness/
alignment/lookahead, explicit missing reasons, integrity failures, byte identity,
deterministic output and fingerprints, exclusive creation, classification,
cross-session maturation, and absence of network or authority dependencies.
The full `npm run validate` includes this validator.
