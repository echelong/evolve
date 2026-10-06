# Phase 5K.7 — Cross-Provider Corroboration Semantics

## Roadmap label

`PHASE_5K_7` — a READ-ONLY derived layer over the verified public-intelligence
corpus. It adds no provider, no collection, no network capability and no
authority. It describes cross-provider **evidence coverage** and nothing else.

## Purpose

5K.7 answers structural questions about what was observed, by which provider,
for one governed subject identity:

- was an exact mint observed on one provider family or on more than one?
- which provider families and provider namespaces contributed evidence?
- how many distinct upstream observations contributed?
- how many authenticated content versions and observation-state snapshots exist?
- over what authenticated time window was the evidence observed?
- where is exact-mint evidence absent?

It deliberately does **not** answer which mint is better, trending, popular,
important or likely to rise; whether providers "agree"; whether any claim is
true; or whether any trade should be made.

## Corroboration definition

**Corroboration** is used here in one strict sense:

> the same exact governed subject identity appearing in authenticated evidence
> from more than one provider namespace.

It does **not** mean the claims in the posts are true, and it does **not** mean
the providers agree about anything. It is presence-in-more-than-one-place and
nothing more.

## Subject identity

The only canonical cross-provider subject identity is an **exact Solana mint**.

Only observations whose authenticated, already-verified normalized evidence
carries `assetAssociation.status === EXACT_MINT` may participate. No other
signal creates equivalence: **ticker, symbol, cashtag, hashtag, project name,
profile identity, domain, URL, similar text, embedding similarity and fuzzy
matching** are all rejected. `UNASSOCIATED`, `INVALID_MINT` and `AMBIGUOUS`
remain visible coverage states but are never promoted to an exact subject.

## Provider family

A **provider family** is a governed platform: `mastodon` or `bluesky`. The
family of a namespace is the segment before the first `:`.

## Provider namespace

A **provider namespace** is the governed namespace string carried by evidence:
`mastodon:<instance>` or `bluesky:public-appview`. The namespace is the segment
family and scope together.

## Two Mastodon instances

Provider independence for 5K.7 means exactly one thing: **a different governed
provider family**. It never means two posts, two instances, two authors, two
times or two texts.

Two Mastodon instances therefore produce:

```
providerNamespaceCount = 2
providerFamilyCount    = 1
coverageStatus         = SINGLE_PROVIDER_FAMILY
```

`mastodon:instanceA` and `mastodon:instanceB` are **two namespaces of one
family**, and are explicitly **not** cross-platform corroboration. Both counts
are maintained so the distinction can never be lost.

## Coverage status

The closed status vocabulary has exactly two values:

- `SINGLE_PROVIDER_FAMILY`
- `MULTI_PROVIDER_FAMILY`

`MULTI_PROVIDER_FAMILY` requires at least two distinct provider families. There
is deliberately no `LOW` / `MEDIUM` / `HIGH` and no numeric level: an ordinal
tier would read as strength of evidence, which this phase refuses to express.

### Single-provider-family behavior

One family contributes, however many namespaces or observations. Two posts on
one Mastodon instance, two Mastodon instances, or repeated observations across
runs all remain `SINGLE_PROVIDER_FAMILY`.

### Multi-provider-family behavior

Two or more governed families contribute evidence for the same exact mint. One
Mastodon instance plus Bluesky is `MULTI_PROVIDER_FAMILY`; two Mastodon
instances are not.

## Upstream observation accounting

Upstream identity remains **provider-scoped** and is never merged. The same
text, the same mint, the same time and the same URL on two providers are still
**two provider-scoped upstream observations**. This layer aggregates coverage
references; it does not merge underlying evidence.

A post seen in five runs is still **one** upstream observation; its run
appearances are recorded separately as coverage metadata (`memberRunIds`).
Identical text across Mastodon and Bluesky is reported as two provider-scoped
upstream observations across two families — never merged, never called
"independent claims", and no originality or copying is inferred.

## Temporal and version accounting

Two related but separate counts are reported per exact mint:

- `contentVersionCount` — distinct authenticated content versions among the
  contributing observations;
- `observationStateSnapshotCount` — distinct authenticated observation-state
  fingerprints among the contributing observations.

A revised post yields two content versions; an engagement-state change yields a
second state snapshot for the same content. Repeated acquisitions of the same
unchanged observation add neither.

## Missingness

Missingness is explicit and preserved. Every upstream identity carries exactly
one structural observation-coverage record, classified by the association of its
head (earliest) authenticated evidence:

- `EXACT_MINT`, `UNASSOCIATED`, `INVALID_MINT`, `AMBIGUOUS`.

An unassociated post is a complete, expected observation that simply carries no
exact mint. It is visible as coverage state and can never become an exact
subject.

## Coverage gaps

`listCoverageGaps()` reports where exact-mint evidence is absent: mints with no
Mastodon evidence, mints with no Bluesky evidence, and governed families with no
evidence at all. **Absence from one provider is not evidence of absence.** The
gap view interprets nothing: `absenceImpliesAbsence`, `gapInterpreted` and
`gapScored` are all reported `false`.

## Snapshot identity

A corroboration snapshot is derived from a set of authenticated runs.

- `snapshotId = "crsnap-" + first 32 hex of SHA-256(canonical{ kind,
  corroborationPolicyVersion, temporalPolicyVersion, corpusPolicyVersion,
  eligibleStatuses, sorted run manifest fingerprints })`.
  - Same authenticated source set + same policy => same id, regardless of run
    order or build time. `createdAt` does **not** participate.
- `snapshotFingerprint` is SHA-256 of the complete canonical manifest minus that
  field, and **does** cover `createdAt`, so it authenticates the persisted
  artifact.

The manifest records the derived temporal snapshot identity, a temporal content
fingerprint, a source corpus fingerprint and the member run set, so the source
is unambiguous and independently re-derivable. Storage is write-once under
`corroboration-corpora/`, in its own namespace, and never writes under
`.evolve`.

## Query API

Read-only entry points only:

```
getCoverageForExactMint(mint)          listMultiProviderFamilyMints()
listSingleProviderFamilyMints()        listProviderFamiliesForMint(mint)
listProviderNamespacesForMint(mint)    listUpstreamObservationsForMint(mint)
getCoverageSummary()                   listUnassociatedCoverage()
listCoverageGaps()
```

There is deliberately **no** `rankByProviderCount`, `rankByObservationCount`,
`rankByEngagement`, `scoreMint`, `scoreCorroboration`, `recommendMint`,
`predictMint` or `selectTradeCandidate`. The validator inspects the exported API
names for prohibited semantics.

## Verification

The verifier trusts nothing stored. It re-authenticates every member run from
the run directories, rebuilds the whole coverage view from scratch, and reports
a named failure for every discrepancy. Nothing is repaired.

Tamper cases that must fail: change mint, change provider family, add/remove
namespace, remove or inject an upstream observation, change any count, change a
source fingerprint, change a status, change a digest, and classification
widening.

## Determinism

Run order, provider ordering, filesystem ordering and key enumeration order
never matter: every aggregate is sorted by a stable key, every array is sorted
and de-duplicated, and every timestamp is copied from authenticated evidence.
Same authenticated source set + same policy => identical deterministic content.

## Privacy

Derived corroboration artifacts contain **structural evidence references only**:
exact mint, governed provider family/namespace, upstream identity strings,
counts, timestamps and fingerprints. They never contain post bodies, display
names, bios, avatars, follower graphs, mention graphs, geolocation, addresses,
credentials or cookies.

## No market linkage

5K.7 has no access to price data, returns, volatility, R4 outcome data, the
trading engine, Arena, wallets, signers, swaps or RPC writes. It makes no
association with future movement and never uses the R4 result.

## Non-goals

- No scoring, ranking, confidence tier, ordinal level or "strength".
- No sentiment, momentum, virality or popularity.
- No prediction, recommendation or trade-candidate selection.
- No cross-provider merge, no deduplication across providers, no inference of
  originality or copying.
- No interpretation of a coverage gap.

## Coverage is not consensus

Two providers carrying the same exact mint is not agreement. The claims may
conflict, and 5K.7 does not read them.

## Coverage is not importance

A mint present on more providers is not more important, more popular or more
promising. The counts describe what was collected.

## Coverage is not a signal

`MULTI_PROVIDER_FAMILY` is a structural statement about evidence presence. It is
not a signal, not a score and not a tier.

## No trading inference is permitted

Nothing in this phase may be read as a reason to trade, and no market or outcome
data is reachable from it.
