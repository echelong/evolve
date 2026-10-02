# Phase 5K.4 — Cross-Run Evidence Corpus & Snapshot Integrity

Status: research/observer-only (5K.0, unchanged). `researchOnly` and `observerOnly` are `true`;
`tradingAuthority`, `engineAuthority`, `arenaEligible`, `promotionEligible` and
`profitabilityInferencePermitted` are `false` on every membership-bearing artifact, observation and
snapshot. No artifact can widen that block.

- Corpus coverage is NOT sentiment.
- Corpus frequency is NOT importance.
- Duplicate appearances are NOT popularity.
- No trading inference is permitted.

## 1. Purpose

Runs (5K.3) are immutable, per-execution evidence. A corpus is a separate, **derived** research
index over a chosen set of authenticated runs. It never writes into a run directory; the validator
hashes run trees before and after to prove it. Only Mastodon exists as a provider; the corpus
itself is provider-neutral.

Modules (`scripts/public-intelligence/`): `corpus-membership.mjs`, `corpus-index.mjs`,
`corpus-snapshot.mjs`, `corpus-verify.mjs`, `corpus-query.mjs`, `corpus-cli.mjs`, and
`research-surface.mjs` (read-only re-exports for tooling). Validator: `scripts/validate-phase5k4.mjs`.

## 2. Run eligibility

A corpus *policy* is closed: `{ corpusPolicyVersion: "corpus-policy-1", eligibleStatuses }`.

| Run status | Corpus eligibility |
|---|---|
| `COMPLETED` | eligible (the **default** policy admits only this) |
| `PARTIAL` | eligible only under an explicit `includePartial` policy; always marked `partial: true` and counted separately |
| `RATE_LIMITED`, `TIMEOUT`, `PROVIDER_ERROR` | never eligible — a policy listing them is refused |
| `FAILED_INTEGRITY` | never eligible |
| `REFUSED` | never persisted, therefore never present |

Nothing is trusted. `authenticateRun` requires: the directory name equals the manifest's run id;
the full 5K.3 verification passes (plan, request sequence, manifest, accounting, raw evidence,
normalized observations, provenance, dedup identity, classification, offline replay); and the
status is admitted by the policy. A symlinked, missing or unfinalized run is refused with a reason.

Building a snapshot is all-or-nothing: one ineligible run refuses the whole build and writes nothing.

**Discovery** (`discoverRuns`) enumerates `<root>/runs` sorted by name (never filesystem order) and
classifies each entry `ELIGIBLE`, `INELIGIBLE_STATUS`, `INVALID`, `UNFINALIZED` or `IGNORED`.
Temp files, dot-files and names not starting `run-` are `IGNORED`; anything that looks like a run
but fails is reported explicitly, never silently skipped. Discovery is informational: `build`
takes **explicit run ids** (there is no "all runs" mode).

## 3. Membership

Closed record `public_corpus_membership`: `corpusPolicyVersion`, `runId`, `runManifestFingerprint`,
`collectionPlanFingerprint`, `provider`, `instance`, `query`, `startedAt`, `completedAt`, `status`,
`partial`, `rawRecordCount`, `normalizedRecordCount`, `providerRecordsSeen`, `membershipFingerprint`.
The fingerprint covers every other field, including the run's own manifest fingerprint, so any
change to the underlying run makes the membership (and the snapshot) invalid.

## 4. Cross-run identity

`upstreamIdentity` is the unchanged 5K.1 identity, `dedupIdentity5K1(provider, providerObservationId)`.
It is never derived from text, URL, mint, timestamp, author or a text hash. The provider string is
instance-namespaced (`mastodon:<host>`), so the same id on two instances is two identities.

## 5. Dedup

Within a run, 5K.1 already guarantees one record per identity. Across runs:

- **Same identity + identical evidence** → one canonical corpus observation whose `appearances`
  list every run that carried it (`memberRunIds`, `memberRunManifestFingerprints`, `appearanceCount`).
- **Same identity + different evidence** → a **conflict**, never a canonical observation.
- **Different providers** never collapse.

*Why a content fingerprint.* Raw fingerprints cannot match across runs because each raw record
embeds its own `fetchedAt` and `collectionContext.collectionRunId`. "Identical evidence" is therefore
defined as identical after removing **only** those acquisition fields
(`evidenceContentFingerprint`). Text, metadata (including engagement counters), `publishedAt`, URL,
author and claimed mint remain in the comparison. Consequence, by design: a public counter that
changed between two runs (e.g. likes) is a conflict. The corpus does not pick a version or merge
fields; drift is surfaced as evidence.

Observation record (`public_corpus_observation`): `upstreamIdentity`, `provider`,
`providerObservationId`, `evidenceContentFingerprint`, reference `rawObservationFingerprint` /
`normalizedObservationFingerprint` / `provenanceFingerprint` (those of the earliest appearance — a
pointer, since all appearances carry content-identical evidence; every appearance's own fingerprints
are listed), `publishedAt`, `firstSeenAt`, `lastSeenAt`, `appearances`, member run lists,
`assetAssociation {status, mint, method}`, `engagement`, `missingness` (copied verbatim from verified
normalized evidence), `classification`, `observationFingerprint`. Post bodies are not copied.

**First/last seen.** `firstSeenAt` / `lastSeenAt` are the min / max `fetchedAt` of the persisted raw
appearances. No filesystem time, no current time, nothing invented at reconstruction.

## 6. Conflicts

Closed record `public_corpus_conflict`: `conflictType` (`UPSTREAM_IDENTITY_CONTENT_DIVERGENCE`),
`upstreamIdentity`, provider, id, `conflictingContentFingerprints`, `conflictingRawFingerprints`,
`runIds`, per-run `appearances`, `conflictFingerprint`. A conflicted identity has no canonical
observation, no "newest", "oldest", "winner" or merged field. Statistics keep canonical observations
and conflicted identities separate.

## 7. Snapshot identity

- `snapshotId = "snap-" + first 32 hex of SHA-256(corpus policy + sorted run manifest fingerprints)`.
  The same authenticated run set under the same policy has the same id, regardless of run order or
  build time. **`createdAt` does not participate.** A different policy or any different run changes it.
- `snapshotFingerprint` = SHA-256 of the complete canonical manifest without that field. It **does**
  cover `createdAt` and authenticates the persisted manifest.
- Reproducible content: memberships, observations, conflicts, counts, digests. Execution metadata:
  `createdAt` and the fingerprint that covers it.

Manifest (`public_corpus_snapshot`, closed): `snapshotId`, policy, `createdAt`, `membershipCount`,
`runIds`, `runManifestFingerprints`, `providerCounts`, `statusCounts`, `partialRunCount`,
`rawRecordsReferenced`, `normalizedRecordsReferenced`, `uniqueUpstreamObservations`,
`canonicalObservationCount`, `duplicateAppearancesAcrossRuns`, `conflictedUpstreamIdentities`,
`conflictedAppearances`, the four association counts, `coverage`, `membershipDigest`,
`observationIndexDigest`, `conflictDigest`, `classification`, `snapshotFingerprint`.

Count invariants: `rawRecordsReferenced = normalizedRecordsReferenced = canonicalObservationCount +
duplicateAppearancesAcrossRuns + conflictedAppearances`; `uniqueUpstreamObservations =
canonicalObservationCount + conflictedUpstreamIdentities`; association counts sum to
`canonicalObservationCount`. All aggregates are sorted (by run id, upstream identity, fingerprint).

## 8. Storage

```
<runtime-root>/corpora/<snapshot-id>/
  membership.ndjson   observations.ndjson   conflicts.ndjson   snapshot.json
```

The same safe-root rules as runs (absolute, no `..`, no `.evolve`, symlink-resolved, under `var/public-intelligence`
or the OS temp directory). A snapshot is written into a private `.building-<id>` directory (all files
`wx`, read-only) and renamed into place atomically, so a snapshot directory is complete or absent.
Re-building an existing id returns `ALREADY_EXISTS_IDENTICAL` if the reproducible content matches
(nothing written, `createdAt` of the original kept) and is refused (`SNAPSHOT_EXISTS_DIFFERENT`)
otherwise. Nothing is overwritten.

## 9. Verification

`verifySnapshot` trusts nothing stored. It re-derives the id, re-authenticates every member run from
the run directories, **rebuilds the whole corpus**, and compares: memberships, observations and
conflicts (removed / injected / modified / duplicated / order), each record's own fingerprint, every
count and digest (against both the rebuild and the stored artifacts), classification, and the policy.
Named failures include `MEMBERSHIP_REMOVED|INJECTED|MODIFIED`, `OBSERVATION_REMOVED|INJECTED|MODIFIED`,
`CONFLICT_SUPPRESSED|INJECTED|MODIFIED`, `COUNT_DRIFT:*`, `DIGEST_DRIFT:*`,
`SNAPSHOT_FINGERPRINT_MISMATCH`, `RUN_NOT_ADMITTED`, `RUN_MANIFEST_FINGERPRINT_CHANGED`,
`CLASSIFICATION_MISMATCH`. Re-signing the manifest after tampering does not help, because the rebuild
is compared, not the stored digests alone.

## 10. Reconstruction

`rebuildCorpusSnapshot({ root, runIds, policy })` reproduces the content from runs alone, offline.
Content, ids and digests are identical across machines, run-set orderings and clean copies of the runs;
only `createdAt` / `snapshotFingerprint` are execution metadata.

## 11. Coverage accounting

Run counts (total / completed / partial), provider counts (runs, appearances, canonical observations,
conflicted identities), query counts, status counts, records seen, unique / duplicate / conflicted
counts, association-status counts, earliest and latest published and fetched time. Evidence coverage
only.

## 12. Missingness

Nothing is defaulted. A missing `publishedAt`, mint, author, URL or engagement stays `null` / its explicit
missingness state; provider-supplied zero stays an observed zero. `UNASSOCIATED` observations stay in the
corpus. Time coverage is `null` when no source time exists.

## 13. Query API

Read-only: `getObservation`, `listObservations`, `listByExactMint`, `listUnassociated`,
`listByAssociationStatus`, `listByProvider`, `membershipRunsOf`, `getConflict`, `listConflicts`,
`listMemberships`, `coverage`, `manifest`. Results are deep-frozen. A snapshot opens only if it verifies.
There is no ranking, scoring, sentiment, momentum, recommendation, selection or prediction API.

## 14. Privacy boundary

Artifacts hold identities, fingerprints, timestamps, run membership, association and structural
coverage. No display names, bios, avatars, follower counts, mention graphs, geolocation, addresses,
cookies or credentials, and no post bodies.

## 15. Mint boundary

The corpus has zero mint authority: it copies `assetAssociation` from verified normalized evidence and
never changes it. No symbol lookup, registry, fuzzy match or hashtag inference exists (checked by AST).
`listByExactMint` is an exact string match.

## 16. CLI

`corpus-cli.mjs discover|build|verify|inspect --root <runtime-root>`; `build --runs <id,id,...>`
(explicit ids required), `--include-partial` for the explicit PARTIAL policy; `verify|inspect --snapshot <id>`.
`discover` and `inspect` are read-only; output is aggregate/structural only. The CLI is the sole wall-clock
boundary (`createdAt`) and is never invoked by a validator.

## 17. Non-goals

No second provider, sentiment, LLM interpretation, ranking, scoring, price correlation, prediction, signals,
profitability inference, scheduler, "all runs" mode, or any change to 5K.0–5K.3.

## 18. Known 5K.0 roadmap label mismatch (retained)

5K.0's `PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.roadmap` labels early phases with names that predate the
delivered scope (`5K.1` is listed as "Authority Benchmark"). The frozen 5K.0 definition is deliberately
not edited; the roadmap should be reconciled in a separate, explicitly governed 5K.0 revision.
