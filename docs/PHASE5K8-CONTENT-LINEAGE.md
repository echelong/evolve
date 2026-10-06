# Phase 5K.8 — Cross-Provider Content Lineage & Duplication Semantics

## Roadmap label

`PHASE_5K_8` — a READ-ONLY derived layer over the verified public-intelligence
corpus. It adds no provider, no collection, no network capability and no
authority. It describes **content lineage** and nothing else.

## Purpose

Phase 5K.7 answers a structural coverage question: was one **exact mint** seen in
authenticated evidence from more than one provider family? That answer is
correct, and it is not the same question as "is the underlying content
actually distinct?":

```
Mastodon: "Mint XYZ just launched..."
Bluesky:  the SAME TEXT, cross-posted by the same operator
```

5K.7 correctly reports `MULTI_PROVIDER_FAMILY`. 5K.8 adds a **separate**,
read-only lineage layer that can describe:

- distinct content
- exact cross-provider duplicate content
- canonical-equivalent cross-provider content
- directly-declared mirrored / cross-posted content
- unresolved similarity

It deliberately does **not** claim truth, independence of authors, consensus,
confidence, importance, popularity, market relevance or any trading signal.

## Provider diversity is not content diversity

**Provider diversity != content diversity.**

Both dimensions stay separately visible and are never collapsed into one score:

- `providerFamilyCount` — 5K.7's structural coverage count;
- `contentLineageCount` — 5K.8's structural lineage count.

A mint observed on two provider families whose evidence is the *same text twice*
has high provider diversity and low content diversity. A mint observed on two
provider families whose evidence is *two structurally distinct texts* has both.
Neither case implies truth or signal strength.

## Lineage classes

The closed vocabulary has exactly five values, with no ordinal level, no
strength and no confidence anywhere in it:

- `DISTINCT_CONTENT` — one member, and nothing else matches it
- `EXACT_RAW_TEXT_MATCH` — members share one authenticated raw-text digest
- `CANONICAL_TEXT_MATCH` — members share one canonical-text digest only
- `EXPLICIT_CROSS_POST_REFERENCE` — members are joined by a directly declared,
  structurally resolved governed post reference
- `UNRESOLVED` — members are joined only by a mixture of the above mechanisms

A lineage is classified by the **evidenced mechanism** its members share, never
by how many members it has. `LOW` / `MEDIUM` / `HIGH`, and `INDEPENDENT` /
`ORIGINAL` / `COPIED` / `PLAGIARIZED` / `CONSENSUS`, do not exist.

## Duplication is not copying

Even an exact text match across providers does **not** prove copying.
`EXACT_RAW_TEXT_MATCH` means only that the authenticated text payloads are
identical. It does not mean one copied the other, does not mean the same human
author, does not mean the same organization and does not mean the same claim
source. No originality, copying, plagiarism or truth is inferred.

## Raw text matching

Two content versions match at the raw layer when 5K.1's `rawTextFingerprint` —
reused unchanged — is identical. That is exact, character-for-character
equality of the authenticated `rawText`: whitespace, case and punctuation are
all significant. No alternate raw fingerprint is created, and no approximate or
fuzzy matching exists anywhere in this phase.

## Canonical text matching

Two content versions match at the canonical layer when 5K.1's
`canonicalTextFingerprint` is identical while the raw digests differ. The
canonical projection is 5K.1's, reused unchanged: its **only** transformation is
line-ending normalization (CRLF/CR → LF). Nothing is lowercased, stemmed,
lemmatized, translated, tokenized, stop-word removed or semantically
normalized, and no arbitrary words are removed. A canonical match is never
promoted to a raw match.

## Explicit references

A reference is `EXPLICIT_CROSS_POST_REFERENCE` only when authenticated source
evidence carries a **governed provider permalink** that resolves to a different
post identity which is itself present in the authenticated corpus:

- Bluesky: `https://bsky.app/profile/<did>/post/<rkey>`
- Mastodon: `https://<instance>/@<user>/<statusId>`

Any other URL stays ordinary evidence: it is never turned into a content
identity, and nothing is crawled or refetched. A reference is never inferred
from matching text, a close timestamp, a similar handle or a similar display
name. A post's own permalink is not a reference. A resolved reference to a post
in the **same** provider family creates no cross-provider edge.

A governed permalink that resolves to nothing in the corpus is recorded as
`REFERENCE_UNRESOLVED`, which is explicit, reported and creates no edge.

## Content version awareness

A **content version** is 5K.5's own identity: one upstream identity plus one
distinct authenticated content fingerprint. A provider-declared revision is a
separate content version. Every version is retained and nothing is merged across
providers or across identities — there is no latest-wins rewriting, so if
version 1 matched cross-provider and version 2 no longer does, both lineages are
preserved. A repeated acquisition and an engagement-only change add **no** new
content version.

## Same-provider versus cross-provider duplication

Both are tracked, and they are distinguished. Same-provider duplication is
useful corpus structure; cross-provider duplication is what informs 5K.7's
provider-family coverage. Two Mastodon instances carrying identical content
produce:

```
providerNamespaceCount = 2
providerFamilyCount    = 1
=> single-provider lineage, never cross-provider corroboration
```

## Exact-mint integration

5K.7 remains authoritative for provider-family coverage. 5K.8 enriches the
structural interpretation with lineage counts and never changes 5K.7 records
destructively. Only `EXACT_MINT` evidence participates in exact-mint subject
coverage, and lineage is never used to infer a mint. Example:

```
Mint A: providerFamilyCount = 2, contentLineageCount = 1
  => multi-provider presence, one matched content lineage
Mint B: providerFamilyCount = 2, contentLineageCount = 2
  => multi-provider presence, two structurally distinct content lineages
```

Neither case implies truth or signal strength. `MULTI_PROVIDER_FAMILY` plus one
lineage does **not** mean false corroboration, and `MULTI_PROVIDER_FAMILY` plus
two distinct lineages does **not** mean stronger truth. These are
provenance/coverage descriptors only.

## Temporal

Time is copied from authenticated evidence and never invented. `firstObservedAt`
and `lastObservedAt` are the min and max of the authenticated fetch instants of
the members. Never used: the current clock, filesystem mtimes or directory
order. Permitted structural facts are only "content A was observed before
content B" and "the same text appeared on provider X and later provider Y".
Causality, copying direction and origin are never inferred, and simultaneity is
never inferred.

## Missingness

Missingness is explicit and never repaired. 5K.1's raw schema requires `rawText`
to be a string, so absent text is **not representable** in authenticated
evidence and this layer cannot fabricate matchability: an observation whose
authenticated text cannot be resolved fails closed rather than matching. What
remains representable is an unresolved reference, reported explicitly. An
unassociated post is a complete, expected observation that simply carries no
exact mint.

## Snapshot identity

- `snapshotId = "linsnap-" + first 32 hex of SHA-256(canonical{ kind,
  lineagePolicyVersion, corroborationPolicyVersion, temporalPolicyVersion,
  corpusPolicyVersion, eligibleStatuses, sorted run manifest fingerprints })`.
  Same authenticated source set + same policy ⇒ same id, regardless of run
  order, discovery order or build time. `createdAt` does **not** participate.
- `snapshotFingerprint` is SHA-256 of the complete canonical manifest minus that
  field, and **does** cover `createdAt`, so it authenticates the persisted
  artifact.

The manifest records the source temporal snapshot identity and fingerprint, the
source corroboration snapshot identity and fingerprint, the source corpus
fingerprint, the member run set and the revision evidence digest. Storage is
write-once under `lineage-corpora/`, in its own namespace, and never writes
under `.evolve`.

## Query API

Read-only entry points only:

```
getLineage(lineageId)                       listLineagesForMint(mint)
listLineagesForProviderFamily(family)       listExactDuplicateLineages()
listCanonicalDuplicateLineages()            listDistinctContentLineages()
getContentDiversityForMint(mint)            getLineageSummary()
```

`getContentDiversityForMint` returns **discrete structural facts only** — no
ratio interpreted as quality and no scalar score. There is deliberately **no**
`scoreDiversity`, `scoreCorroboration`, `rankMints`, `rankLineages`,
`confidence`, `recommendation` or `prediction`.

## Verification

The verifier trusts nothing stored. It re-authenticates every member run from
the run directories, rebuilds the verified 5K.5 temporal index, the 5K.7
corroboration coverage view and the whole lineage layer from scratch — using
the revision evidence the snapshot recorded — and reports a named failure for
every discrepancy. Nothing is repaired.

Detected tamper classes: member added, member removed, wrong provider family,
wrong upstream identity, wrong content fingerprint, wrong lineage class, wrong
exact mint, count drift, digest drift, source snapshot substitution,
classification widening, and a malformed stored file.

## Privacy

Derived lineage artifacts contain **structural references only**: lineage id and
class, upstream identity strings, governed provider family/namespace,
fingerprints, counts and timestamps. They never contain post bodies, display
names, handles, bios, avatars, follower or mention graphs, geolocation,
addresses, credentials, cookies or URLs.

## No identity resolution

5K.8 is content lineage, **not** identity resolution. A Mastodon account and a
Bluesky DID remain separate identities forever. No same-handle, same-display-
name, same-bio, same-domain, same-avatar or same-text inference is permitted,
and no author identifier is persisted in a lineage artifact.

## No market linkage

5K.8 has no access to price data, returns, volatility, R4 outcome data, the
trading engine, Arena, wallets, signers, swaps or RPC writes. It makes no
association with future movement and never uses the R4 result.

## Determinism

Run order, provider ordering, filesystem ordering and key enumeration order
never matter: every aggregate is sorted by a stable key, every array is sorted
and de-duplicated, and every timestamp is copied from authenticated evidence.
Same authenticated source set + same policy ⇒ identical deterministic content.

## Non-goals

- No scoring, ranking, confidence tier, ordinal level or "strength".
- No diversity ratio, no scalar score and no collapsing of the two dimensions.
- No semantic matching: no LLM, no embedding, no vector or semantic similarity,
  no topic model, no fuzzy NLP and no sentiment model.
- No prediction, recommendation or trade-candidate selection.
- No cross-provider merge, no deduplication across providers, no inference of
  originality or copying.
- No inference of a mint from lineage.
- No interpretation of a coverage gap.

## Coverage is not importance

A mint present on more providers, or with more lineages, is not more important,
more popular or more promising. The counts describe what was collected.

## No trading inference is permitted

Nothing in this phase may be read as a reason to trade, and no market or
outcome data is reachable from it.
