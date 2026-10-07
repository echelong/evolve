# Phase 5K.5 - Temporal Observation Revisions & Mutable Metadata Semantics

Status: research/observer-only (5K.0, unchanged). `researchOnly` and `observerOnly` are `true`;
every authority flag (`tradingAuthority`, `engineAuthority`, `arenaEligible`, `promotionEligible`,
`profitabilityInferencePermitted`) is `false`.

Mastodon only. No second provider is added. No scraper, no RSS reader, no authenticated endpoint.

## Purpose

Phase 5K.4 gave the system a cross-run corpus with a correct but intentionally coarse rule: two
acquisitions of the same upstream post were "identical evidence" only if they matched after removing
`fetchedAt` and `collectionContext`, and *any* remaining difference was an
`UPSTREAM_IDENTITY_CONTENT_DIVERGENCE`.

That rule is safe but too coarse in one specific, extremely common case. The same public post
observed in a later run usually carries a different engagement count, because people interacted with
it in between. 5K.4 could not tell that apart from a genuinely contradictory record, so it called a
like count going from 10 to 14 a "divergence". That is not corruption; it is the post continuing to
exist.

5K.5 distinguishes three situations that 5K.4 collapsed into one:

| Situation | 5K.4 said | 5K.5 says |
|---|---|---|
| content-bearing evidence differs | `UPSTREAM_IDENTITY_CONTENT_DIVERGENCE` | `PROVIDER_DECLARED_CONTENT_REVISION` **or** `UNVERIFIED_CONTENT_DIVERGENCE` |
| only an engagement counter moved | `UPSTREAM_IDENTITY_CONTENT_DIVERGENCE` | `SAME_CONTENT_UPDATED_STATE` |
| nothing changed | "identical" | `SAME_CONTENT_SAME_STATE` |

Everything else is unchanged. Raw evidence is never rewritten, no run artifact is ever modified, and
the mint rule is untouched.

## Raw Fingerprints Remain Immutable

`rawObservationFingerprint` is 5K.1's function. 5K.5 **imports and re-exports it unchanged** - it
never defines a replacement, never shadows it, and never omits it from a derived record. That
fingerprint remains the authoritative statement of *what was received* in a given acquisition, and it
still changes if a single character of raw evidence changes.

5K.5 adds fingerprints *beside* it, never instead of it:

| Fingerprint | Question it answers |
|---|---|
| `rawObservationFingerprint` (5K.1, unchanged) | exactly what bytes were received in this acquisition |
| `contentFingerprint` | is this the same content-bearing evidence? |
| `observationStateFingerprint` | is this the same mutable provider state? |
| `acquisitionFingerprint` | when and how was this fetched? |

Historical artifacts are append-only and immutable. `raw-evidence.ndjson`,
`observations.ndjson`, `requests.ndjson`, `manifest.json` and every 5K.4 snapshot remain byte-for-byte
as they were. 5K.5 is a purely **derived** layer over them.

## Field Classification

Every retained field of the frozen 5K.1 raw schema, its `rawMetadata`, its `collectionContext`, the
engagement counter set, and the 5K.1 normalized schema is classified as **exactly one** of five
classes. The classification lives in one place (`temporal-projection.mjs`), is exhaustive, and fails
closed.

| Class | Fields | Rationale |
|---|---|---|
| `IDENTITY` | `provider`, `providerObservationId` | the 5K.1 identity rule, unchanged |
| `CONTENT` | `providerAuthorId`, `sourceType`, `sourceUrl`, `publishedAt`, `rawText`, `claimedMint`, `rawMetadata` (except `engagement`) | stable, content-bearing evidence |
| `OBSERVATION_STATE` | `rawMetadata.engagement` and nothing else | provider-supplied public counters |
| `ACQUISITION` | `observedAt`, `fetchedAt`, `collectionContext` | when and how we fetched it |
| `DERIVED` | `schemaVersion`, `recordType`, `classification`, all normalized projections | EVOLVE's own governance/version stamps |

Two decisions worth stating explicitly:

* **`providerAuthorId` is `CONTENT`, not `IDENTITY`.** Mastodon cannot re-assign the author of an
  existing status, so an author change under an unchanged `providerObservationId` is an upstream
  inconsistency about *the same post*, not a different post. Upstream identity stays exactly
  `(provider, providerObservationId)`.
* **Nothing becomes mutable merely because it changed.** Only `engagement` is `OBSERVATION_STATE`.
  `hashtags`, `language`, `cashtags`, `candidateMintAddresses` and the rest are `CONTENT`, so a change
  to any of them is a content event. The mutable set was chosen from the provider's semantics, and
  then frozen - it was not discovered by observing what happens to move.

An unclassified field is a hard refusal (`PUBLIC_INTELLIGENCE_5K5_FIELD_UNCLASSIFIED`), and
`assertFieldClassificationComplete()` refuses to run if any governed 5K.1 schema gains a field that
5K.5 has not classified.

## Content Identity

`contentProjection(raw)` is a closed, minimized, deterministic view containing exactly the
`CONTENT`-classified fields. `contentFingerprint` is `SHA-256` over EVOLVE canonical JSON of that
projection, namespaced by `temporal-policy-1`. It is anchored to raw evidence, never to normalized
evidence, so a normalization bug cannot launder a content change.

Consequences that are tested rather than asserted:

* changing `fetchedAt` does **not** change the content fingerprint;
* changing `collectionRunId` does **not** change the content fingerprint;
* changing an engagement counter does **not** change the content fingerprint;
* changing text, `sourceUrl`, `publishedAt`, `providerAuthorId`, or the explicit mint claim **does**.

## Acquisition Fields

5K.4 excluded acquisition fields with an ad-hoc strip list. 5K.5 replaces that with a formal
projection derived from the field classification: `acquisitionProjection(raw)` returns exactly
`{ observedAt, fetchedAt, collectionContext }`, and `acquisitionFingerprint` digests it.

Acquisition context therefore *cannot* cause content divergence, and not because someone remembered
to strip two keys - but because those keys were classified `ACQUISITION` and the content projection is
built from the `CONTENT` class.

## Observation State

An observation-state record is a structural snapshot of the provider-supplied counters at one
authenticated acquisition, bound to the run that produced it:

```json
{ "status": "OBSERVED", "values": { "likes": 10, "replies": 0, "reposts": 1 },
  "absentCounters": ["bookmarks", "quotes", "views"] }
```

It contains counters and fingerprints only. It computes no arithmetic across snapshots at all -
`crossSnapshotArithmeticPerformed` is `false` and `deltaComputed` is `false` on every record.

## Engagement Counter Semantics

An engagement change is an authenticated observation-state update:

```
Run 1: status 123, text identical, likes 10
Run 2: status 123, text identical, likes 14
=> same upstream identity
=> same content identity (content fingerprint identical)
=> two authenticated observation-state snapshots
=> SAME_CONTENT_UPDATED_STATE - NOT a conflict
```

The two raw observations are not collapsed. The earlier snapshot is never overwritten. A third
acquisition showing 12 produces a third snapshot, not a mutation of the first two.

**Engagement change is not sentiment.**
**Engagement change is not importance.**
**Engagement change is not momentum.**
**Engagement change is not a trading signal.**

A counter is evidence that an interaction was counted. Nothing in this phase reads it as an opinion,
a preference, a popularity measure or a market input.

## Counter Regression

Counters are not assumed to be monotonic. Providers remove interactions, moderate activity and
recalculate counts, so:

```
Run 1: likes 14      Run 2: likes 10   => SAME_CONTENT_UPDATED_STATE
```

is accepted exactly like the increasing case. `counterRegressionIsFailure` is `false` and
`counterDirectionImpliesIntent` is `false`. No causality is inferred: a decrease is a fact about a
count, not evidence that anyone removed a like deliberately.

## Legitimate Revisions

Mastodon supports edited posts and declares the fact itself: `Status.edited_at` ("timestamp of when
the status was last edited", added in Mastodon 3.5.0), plus a `StatusEdit` history at
`GET /api/v1/statuses/:id/history`.

**A revision is recognized only when the provider declares it.** Two different texts are never
treated as proof of an edit: a provider can silently re-render, truncate, renumber, delete-and-repost
under a reused id, or serve inconsistent replicas. Inferring "the author edited it" from "the text
differs" would manufacture a benign story out of an unexplained one.

The proof must also be **ordered**: a declared `edited_at` counts only when it is strictly later than
the *earlier* observation's fetch instant. An `edited_at` that precedes the previous fetch would mean
the edit was already visible then, so the earlier evidence - not this one - would be the anomaly.
Such a record is refused rather than accepted.

### Why revision evidence is a sidecar, not a new raw field

5K.1's raw observation schema is **frozen and closed**: an unknown field is a hard refusal, which is
precisely what stops an upstream rename from silently changing a research number. Adding
`providerRevision` to it would mean editing a schema that 5K.0/5K.1 froze, and would also force a
change to the 5K.2 mapper and to the 5K.2 validator's field assertions.

5K.5 therefore uses the governed additive path instead: a separate, closed, independently fingerprinted
record (`public_provider_revision_evidence`) bound to the **unchanged** 5K.1
`rawObservationFingerprint`.

* Nothing inside a 5K.1 raw record moves.
* No historical artifact is rewritten.
* A sidecar asserts a fact about one specific authenticated raw observation, identified by that
  observation's own fingerprint, so it cannot be replayed onto different evidence.
* A sidecar bound to a raw fingerprint no authenticated observation carries is a hard refusal.
* Records captured before 5K.5 simply have no sidecar, remain valid, and route content divergence to
  `UNVERIFIED_CONTENT_DIVERGENCE` - the correct conservative outcome for evidence that predates the
  field.

### Revision evidence is persisted with the snapshot (5K.5.1)

A sidecar is not decoration: `providerRevisionTimestamp` on every derived record, the
`PROVIDER_DECLARED_CONTENT_REVISION` classification and the revision-chain link all exist *only*
because a sidecar was supplied when the index was built. A snapshot that stored a declared revision
but did not store the sidecar it came from was therefore not reproducible - its verifier rebuilt
without the proof and produced `UNVERIFIED_CONTENT_DIVERGENCE` where the snapshot said
`PROVIDER_DECLARED_CONTENT_REVISION`, and a conflicted identity's unproven link could not pass the
revision-chain proof rules at all.

5K.5.1 closes that gap additively, using the same pattern 5K.7-5K.9 already use:

* the sidecar is persisted beside the derived records as `source-revision-evidence.ndjson`;
* the manifest binds it with `revisionEvidenceCount` and `revisionEvidenceDigest`, a SHA-256 over
  the canonical, validated, raw-fingerprint-sorted evidence array, so the digest is a pure function
  of the evidence **set** and not of the order a caller collected it in;
* the file is governed, write-once, mode `0444`, and written even when empty - a corpus with no
  declared revision records its *absence* of evidence as an authenticated empty sidecar rather than
  losing the distinction between "no proof was supplied" and "the proof was lost";
* the verifier rebuilds from the sidecar **stored with the snapshot**, never from an empty default
  and never by re-deriving proof from the snapshot's own output;
* a conflicted identity is verified as a conflict - structure only, since demanding a declaration on
  its unproven link would demand the very proof whose absence defines the outcome - while a fully
  proven chain is still held to every proof-order rule.

The sidecar carries a provider, an observation id, a raw fingerprint, one declared timestamp and a
fingerprint; it duplicates no post body, no URL, no author identity and no credential, and it adds
no new authority of any kind.

## Unverified Divergence

Same upstream identity, different content fingerprint, **no valid provider proof** is a
`UNVERIFIED_CONTENT_DIVERGENCE`: a conflict.

* No version is discarded.
* **No winner is selected.**
* `getLatestProviderDeclaredVersion` refuses outright on a conflicted identity rather than papering
  over the ambiguity with a "latest".

## Revision Chains

A revision chain retains **every** authenticated version:

```
v0 --(edited_at = T1)--> v1 --(edited_at = T2)--> v2
```

There is no "latest wins" and no "oldest wins". Every version stays individually addressable and
individually fingerprinted. "Latest" exists only as an explicit, deterministic temporal **query**, and
performing it mutates nothing.

Chain verification checks that indexes are contiguous from 0, that each version supersedes exactly
its predecessor's content fingerprint, that each declared timestamp is strictly later than the fetch
of the version it supersedes, and that declared timestamps do not go backwards along the chain.

## Missingness

Missing is missing, and is never repaired:

* an absent `engagement` object stays `NO_OBSERVATION` with `values: null`;
* an absent key inside a supplied object stays absent and is listed in `absentCounters`;
* a provider-supplied `0` is `OBSERVED`, and is distinguishable from absence;
* nothing is zero-filled, carried forward, or interpolated.

A later acquisition that lacks a counter does **not** inherit the earlier value, and an earlier value
is never pushed forward onto a missing observation. Observed and missing both remain explicit,
individually addressable facts.

## Temporal Ordering

Ordering derives only from authenticated timestamps and content-addressed tie-breaks:

1. `fetchedAt` (ascending) - the acquisition instant, copied from raw evidence;
2. `rawObservationFingerprint` (ascending) - content-addressed, so identical instants still order;
3. `runId` (ascending).

Never used: filesystem `mtime`, the current time, `Map` insertion order, directory enumeration order.
The ordering is verified to be independent of input run order, and identical timestamps are verified
to break deterministically.

## Snapshot Accounting

5K.5 extends the accounting so a state update is not mistaken for a redundant appearance:

| Count | Meaning |
|---|---|
| `upstreamIdentityCount` | distinct `(provider, providerObservationId)` pairs |
| `contentVersionCount` | distinct content fingerprints across the corpus |
| `observationRecordCount` | authenticated acquisitions |
| `observationStateSnapshotCount` | one per authenticated acquisition |
| `duplicateAppearanceCount` | appearances adding no new content, state or membership |
| `sameContentUpdatedStateCount` | same content, newly observed state (**not** duplicates) |
| `providerDeclaredRevisionCount` | provider-declared revisions |
| `unverifiedDivergenceCount` | conflicts |
| `conflictedUpstreamIdentityCount` | identities with at least one unproven transition |

Equations asserted on every build, and re-asserted on every verification:

```
firstObservationCount                                   = upstreamIdentityCount
observationStateSnapshotCount                           = observationRecordCount
firstObservationCount + duplicateAppearanceCount
  + sameContentUpdatedStateCount
  + providerDeclaredRevisionCount
  + unverifiedDivergenceCount                           = observationRecordCount
sum(temporalClassificationCounts)                       = observationRecordCount
```

Any drift fails closed rather than being silently reconciled.

## Queries

Retrieval only, read-only:

* `getContent` / `listContents` - one canonical content record per upstream identity;
* `listByExactMint`, `listByProvider` - exact string matches, never folded, never inferred;
* `getObservationStateHistory` - deterministic chronological counter snapshots;
* `listAllVersions`, `getRevisionChain` - the complete, non-destructive history;
* `getLatestProviderDeclaredVersion` - a deterministic temporal read that mutates nothing;
* `listConflicts`, `accounting` - structural coverage.

There is no engagement score, momentum, velocity, growth ranking, virality score or trading signal,
and none is derivable from what these functions return.

## Privacy

The personal-data surface does not expand. Observation-state records contain structural counters and
fingerprints only. There is no display name, bio, avatar, follower or following graph, mention graph,
geolocation, address, or credential data anywhere in a 5K.5 artifact. The privacy refusals frozen in
5K.1 remain in force at the ingestion boundary, and 5K.5 adds no enrichment path of any kind.

## Exact-Mint Behavior

Mint inference is unchanged: a mint is inherited verbatim from authenticated normalized evidence, and
`claimedMint` is classified `CONTENT` only so that an explicit mint-evidence change registers as a
content event.

* A changing engagement count has **zero** effect on mint association - the association is copied from
  the verified normalized record and is byte-identical across runs whose only difference is a counter.
* A content revision that changes explicit mint evidence produces a distinct content version and
  retains both associations. Association history is never silently rewritten.
* A mint lookup is exact string equality. Solana addresses are base58 and case-sensitive; a
  differently cased address is a different identity, never a match.

## Backward Compatibility

* 5K.3 runs still verify under the unchanged 5K.3 replay verifier.
* 5K.4 corpus snapshots still verify under the unchanged 5K.4 verifier.
* 5K.5 stores under `temporal-corpora/tsnap-<id>/`, never beside 5K.4's `corpora/snap-<id>/`.
* 5K.5 uses its own versioned names: schema `5K.5.0`, policy `temporal-policy-1`, snapshot policy
  `temporal-snapshot-1`. Richer semantics never invalidate a historical artifact.
* Building the same temporal corpus twice is write-once and reports `ALREADY_EXISTS_IDENTICAL`.
* No 5K.0-5K.4 module, validator or document is modified by 5K.5.
* The 5K.5.1 revision-evidence binding is **optional on read**. A snapshot written before 5K.5.1 has
  neither the binding fields nor the sidecar file, and keeps verifying exactly as it always did
  whenever nothing it stores depends on revision evidence. When its stored records DO carry a
  provider-declared revision timestamp, the missing sidecar is a specific, named verification
  failure (`REVISION_EVIDENCE_REQUIRED_BUT_ABSENT`) - never a silent empty default and never a
  reconstruction. A binding that is present is all-or-nothing, and deleting a bound sidecar is
  `REVISION_EVIDENCE_ARTIFACT_MISSING`. No unaffected historical fixture is invalidated by any of
  this; the schema stays closed, and an unknown field is still a hard refusal.

## Non-Goals

Deliberately not implemented in 5K.5: sentiment, trend or popularity scoring, engagement velocity,
ranking, recommendation, prediction, correlation with price, market linkage, trading inference, LLM
interpretation, bot detection, author reputation, a second provider, or any enrichment of raw evidence.

## Engine / Arena Boundary

5K.5 imports nothing that can open a socket, sign, or write to a chain. It reaches no engine, Arena,
wallet, signer, promotion or champion-selection module, starts no process, and writes nothing under
`.evolve`. Runtime storage, when used, is confined to the same safe runtime roots 5K.3 established.
