# Phase 5K.9 — Descriptive Social Evidence Features

## Roadmap label

`PHASE_5K_9` — the first descriptive research-feature layer built on the
authenticated public-intelligence evidence stack.

## Purpose

Phase 5K.9 measures what earlier phases already authenticated. It reads
**verified** 5K.4 cross-run corpus content, 5K.5 temporal/revision records,
5K.7 corroboration records, and 5K.8 content versions and lineages, and it emits
a closed, per-mint record of DESCRIPTIVE facts about that evidence.

Nothing new is fetched. Nothing is inferred. The layer is a measurement pass
over evidence that is already admitted, fingerprinted and verifiable.

What it can say, and nothing more:

* how much exact-mint evidence exists;
* how many provider families and provider namespaces contributed;
* how many upstream observations exist;
* how many content versions exist;
* how many observation-state snapshots exist;
* how many content lineages exist, and of which structural class;
* how many revisions, state changes and unverified divergences were recorded;
* how evidence is distributed through a fixed, sparse time grid;
* whether coverage is single-family or multi-family;
* what is present and what is missing.

It produces no asset score, no ranking, no recommendation, no sentiment, no
popularity or trend label, no momentum, no virality, no confidence, no truth
probability, no prediction, no price correlation, no return linkage, no
profitability inference, and no trading, engine or Arena authority.

## Feature vs score

FEATURE != SCORE.

Every output of this phase is an explicit measurement of authenticated evidence.
Each number is a count, a timestamp, an interval, or an availability tally that a
reader can recompute by hand from the same snapshot.

Acceptable facts:

```
providerFamilyCount = 2
upstreamObservationCount = 7
contentLineageCount = 3
observationStateSnapshotCount = 10
observationWindowMs = 3600000
```

Refused, and refused by construction — the phase defines no such vocabulary and
no code path that could produce it:

```
providerBreadthScore = 0.83
socialMomentum = HIGH
confidence = 72
importanceRank = 4
```

There is no weighting. There is no normalization into a quality scalar. There is
no standardization, no z-score, no percentile read as a rank, and no composite.
A count is not a strength, an interval is not a rate, and a state change is not a
signal.

## Subject identity

The only canonical asset subject remains an **exact Solana mint**.

Only observations whose already-verified association status is `EXACT_MINT` may
form a per-mint feature record. `UNASSOCIATED`, `INVALID_MINT` and `AMBIGUOUS`
stay visible at snapshot and coverage level and are never assigned to a mint.
Those three states are counted in the snapshot summary and appear in no other
place.

No symbol, name, ticker, fuzzy match or cross-provider merge can create a
subject, and a mint is never inferred. A name is not an identity and a
similarity is not an identity.

## Provider features

For every mint the record carries a **closed per-provider-family block**. A
family block reports its own namespace count, its own upstream observation
count, its own content version count, its own observation-state snapshot count,
its own member run count, its own first and last observed timestamp, its own
published-at availability, and its own provider-supplied engagement summaries.

Blocks are never combined across families. Provider families are reported in
deterministic name order, and they are never compared by ranking, by size or by
any ordering that would imply one family is better evidence than another.

## Provider-namespace accounting

A **provider namespace** is a concrete source: `mastodon:alpha.example` and
`mastodon:beta.example` are two namespaces; `bluesky:public-appview` is a third.
A **provider family** is the protocol the namespace belongs to.

Two Mastodon instances are therefore two namespaces and ONE family, and a mint
seen only on two Mastodon instances is still `SINGLE_PROVIDER_FAMILY`. Counting
namespaces keeps instances visible without ever inflating coverage, because the
coverage classification is reused unchanged from Phase 5K.7:

```
SINGLE_PROVIDER_FAMILY
MULTI_PROVIDER_FAMILY
```

No new tier is invented. There is no WEAK, STRONG, HIGH, LOW or TRENDING
anywhere in this phase.

## Upstream observation features

One authenticated observation instance is one
`(upstream identity, content version, observation state)` triple.

A repeat acquisition of an UNCHANGED post — the same text with the same
provider-supplied counters — is the same observation and is counted once. A
provider-declared revision, an unverified divergence, or an engagement-only
state change is a NEW observation. Nothing is dropped and nothing is merged
across identities or provider families.

Member run count is the number of distinct member runs that contributed those
observation instances, and it can never exceed the observation count.

Each distinct observation instance carries exactly one authenticated
observation-state snapshot, so `upstreamObservationCount` and
`observationStateSnapshotCount` measure the same deterministic quantity and
coincide for every mint. Both are reported because both are governed fields; one
is never computed from the other.

## Content-version features

A content version is a distinct authenticated content fingerprint for one
upstream identity. A repeated acquisition adds no version. An engagement-only
change adds no version. A provider-declared revision, and an unverified
divergence, each add one.

## Temporal features

Time is copied from authenticated evidence and never invented. No clock is read,
no filesystem mtime is consulted, no directory order is used.

* `firstObservedAt` — the earliest authenticated acquisition of the mint;
* `lastObservedAt` — the latest;
* `observationWindowMs` — `lastObservedAt - firstObservedAt`, an interval and
  nothing more;
* `temporalBuckets` — the observed buckets of the fixed grid below.

The grid is fixed by policy: **15-minute buckets aligned to the UTC epoch**
(`bucketPolicyVersion = feature-buckets-15m-1`, width `900000` ms). Buckets are
SPARSE: only buckets that actually contain authenticated evidence are emitted.
No empty bucket is imputed, no bucket is zero-filled, nothing is interpolated,
no moving average is taken, and no rate is computed. A bucket reports structural
counts only — `bucketStart`, `bucketEnd`, `upstreamObservationCount`,
`contentVersionCount`, `stateSnapshotCount` — and is never labelled an activity
level or a trend.

The window and the buckets together are the entire temporal description. Counts
per window are counts per window; they are never interpreted as momentum.

## Lineage features

Lineage facts are reused verbatim from Phase 5K.8 and reported as raw counts:

```
contentLineageCount
exactRawMatchLineageCount
canonicalMatchLineageCount
distinctContentLineageCount
explicitReferenceLineageCount
unresolvedLineageCount
```

Every class name is a governed 5K.8 value. `lineageCoverageStatus` is a pure
count partition — `NO_LINEAGE`, `SINGLE_LINEAGE`, `MULTIPLE_LINEAGES` — and it
carries no ordinal meaning.

No diversity score, originality score, independence score or duplication ratio
is computed. If a ratio were mathematically possible it is still not emitted:
raw counts describe duplication, and a scalar would interpret it.

## Revision/state features

Reused from Phase 5K.5 as counts only:

```
contentVersionCount
providerDeclaredRevisionCount
unverifiedDivergenceCount
stateChangeCount
observationStateSnapshotCount
```

A provider-declared revision is counted as a revision. A content change with no
provider-declared proof is counted as an unverified divergence, never promoted to
a revision. An engagement-only change is counted as a state change and adds no
version.

Many revisions are not a suspicion. Many state changes are not popularity. Many
observations are not importance. These are counts, and the record contains no
field whose name or value could be read as a risk flag.

## Missingness

Missingness is first class. Every governed category reports an explicit
availability pair:

```
publishedAt      { available, missing }
observedAt       { available, missing }
providerAuthorId { available, missing }
sourceUrl        { available, missing }
engagement       { available, missing }
```

Each pair partitions the mint's upstream observation count, and the block also
states, as data, that `absentTreatedAsZero` is false and
`observationSilentlyDropped` is false. The category names are governed labels:
no author identifier, URL or personal value is ever stored under them.

A missing engagement block is a missing engagement block. It is never converted
to zero. `engagementMissingCount = 4` is a valid measurement; `likes = 0` for a
post that never supplied a like count is not, and this phase cannot express it.

An unknown is reported as missing, never folded into a count of zero.

## Engagement handling

Engagement counters are provider-defined measurements. A Mastodon favourite and
a Bluesky like may be structurally similar and are still not the same
measurement, so every engagement summary is reported **per provider family** and
**field by field**. Nothing is aggregated across incomparable counter types and
nothing is aggregated across families — the mint record exposes no merged
counter at all.

For each governed counter name the summary is closed:

```
counter, observedCount, missingCount,
minObservedValue, maxObservedValue, firstObservedValue, lastObservedValue
```

An unobserved counter reports null extrema and is never filled with zero. A
provider-supplied zero is an ordinary OBSERVED value (`observedCount` includes
it, extrema are zero). A regression is a valid observation: the phase computes no
absolute change, no momentum, no growth, no velocity, no popularity, no ratio and
no score, and it never treats an increase as positive evidence or a decrease as
negative evidence.

## Snapshot

A feature snapshot is immutable and write-once, stored under `feature-corpora/`
in its own namespace. It holds the per-mint feature records, the
revision-evidence sidecar it was derived with, and a closed manifest:

* schema version, record type, phase and `snapshotId`;
* each source layer's policy version, plus the bucket policy and width;
* the source corpus fingerprint, the source temporal, corroboration and lineage
  snapshot ids and fingerprints, and the revision-evidence fingerprint;
* member run ids and source run manifest fingerprints;
* `mintFeatureCount`, the unassociated / invalid-mint / ambiguous observation
  counts, the exact-mint observation count, the single-family and multi-family
  mint counts, and the total observation, content-version, state-snapshot,
  lineage and provider-family counts;
* `earliestObservedAt` and `latestObservedAt`;
* `featuresDigest` and `summaryDigest`;
* the frozen observer-only classification and the manifest fingerprint.

Storage is write-once: rebuilding the same snapshot is refused if any stored
artifact differs, and stored files are read-only on disk. No snapshot artifact is
ever repaired, and no file is ever written under `.evolve`.

## Snapshot identity

The snapshot id is deterministic:

```
featsnap-<32 hex of SHA-256({
  kind, featurePolicyVersion, lineagePolicyVersion, corroborationPolicyVersion,
  temporalPolicyVersion, corpusPolicyVersion, eligibleStatuses, bucketPolicyVersion,
  sorted runManifestFingerprints }))
```

The same authenticated source set with the same feature policy yields the same
id regardless of run order, discovery order, filesystem order or build time.
`createdAt` is execution metadata: it is deliberately excluded from the id and
covered by the manifest fingerprint instead.

## Queries

The query layer is read-only retrieval over a VERIFIED snapshot:

```
getFeaturesForMint(mint)
listFeatureMints()
getFeatureSummary()
getProviderFamilyFeatures(mint, family)
getTemporalBucketsForMint(mint)
getMissingnessForMint(mint)
getLineageFeaturesForMint(mint)
getRevisionFeaturesForMint(mint)
```

Nothing else is exported, and no name such as `rankMints`, `topMints`,
`scoreMint`, `recommendMint`, `predictMint`, `compareBestMint`, `socialSignal`,
`momentum` or `sentiment` exists anywhere in the layer.

## Deterministic ordering

Every list uses deterministic lexical ordering: mint identity, provider family
name, counter name, bucket start, timestamp. No list is ever ordered by a feature
value, and no default ordering is descending by observation count or engagement.
`listFeatureMints()` returns the mints in lexical order. Records are stored in
lexical mint order, so byte-for-byte equality is a meaningful check.

Input order does not matter. Run order does not matter. Filesystem order does not
matter. Provider ordering does not matter. The same authenticated source set with
the same feature policy produces the same feature content.

## Verification

`verifyFeatureSnapshot(root, snapshotId)` trusts nothing it reads. It:

1. validates the stored manifest against the closed schema and its own
   fingerprint, and re-derives the deterministic snapshot id;
2. verifies every SOURCE snapshot that is present on disk — the 5K.5 temporal,
   5K.7 corroboration and 5K.8 lineage snapshots — each against its own runs;
3. re-authenticates every member run from the run directories;
4. rebuilds the 5K.5/5K.7/5K.8 derivation and recomputes every feature from
   scratch, using the revision evidence the snapshot recorded;
5. compares source ids and fingerprints, every stored record against the rebuild
   (modified, removed, injected, duplicated, non-canonical order), the artifact
   and summary digests, and every manifest count and field.

Every discrepancy is reported by name and nothing is repaired. Tampering with a
mint, a provider or namespace count, a lineage count, a state count, a timestamp,
a window, a bucket, missingness, an engagement extremum, an injected or removed
record, a source fingerprint, a snapshot count, a digest or the classification is
detected and reported.

## Privacy

No personal-data expansion.

A feature record contains aggregate structural evidence facts only. It never
persists post text, a display name, a handle, a bio, an avatar, a follower or
following relation, a mention or contact graph, a geolocation, an address, a
credential or a cookie. Author identifiers are not persisted; the missingness
block names `providerAuthorId` only as a governed availability CATEGORY, and
holds no value for it.

## Determinism

No clock, no environment, no socket, no randomness, no unordered iteration. The
derivation is a pure function of the authenticated run set, the corpus policy and
the recorded revision evidence. Snapshot ids are invariant to member run order;
feature records are invariant to input order; repeated verification of the same
snapshot returns exactly the same result.

## Non-goals

* No score, rank, weight, tier, level, quality grade or composite.
* No sentiment, topic, entity or language analysis.
* No price, return, volume, liquidity, market-cap or market outcome.
* No R4 result or R4 outcome artifact.
* No engine, Arena, wallet, signer, swap or RPC access of any kind.
* No symbol or name resolution, no fuzzy identity, no cross-provider merge.
* No recommendation, prediction, forecast or truth probability.
* No profitability or trading inference, and no trading authority.

## No NLP and no LLM

No LLM call, no embedding, no sentiment model, no topic classifier, no keyword
classifier, no named-entity recognition, no semantic similarity and no text
mining. No fixed lexicon is applied. The phase reads structural, already
authenticated data only, and it never reads post text.

## No market or trading linkage

The import closure contains zero access to price, returns, market outcomes, the
R4 result, the engine, the Arena, a wallet, a signer, a swap or an RPC write. No
market API is contacted and no Solana RPC lookup is performed. The exact mint is
an IDENTITY ONLY.

## More is not better

More observations != more truth.

More providers != more confidence.

More engagement != importance.

More lineages != stronger corroboration.

More revisions != suspicion.

Coverage is not importance. A count of two provider families states that two
families contributed; it does not state that the evidence is stronger. A longer
observation window states that observations spanned more time; it does not state
that anything is developing. An engagement increase states that a provider
reported a larger number; it does not state that anything is happening. More
revisions state that content changed more often; they do not state that anything
is wrong.

## No feature is a trading signal

No feature, count, timestamp, bucket, availability tally or aggregate in this
phase is a trading signal, and none may be used as one. The output is a
descriptive measurement of authenticated public evidence, produced under an
observer-only classification with `tradingAuthority`, `engineAuthority`,
`arenaEligible`, `promotionEligible` and `profitabilityInferencePermitted` all
false.

## Offline and read-only

This phase performs zero live network calls. There is no smoke test, no provider
contact and no market call. Every artifact comes from authenticated local
fixtures and snapshots. `.evolve` is untouched and `var/` is never tracked.
