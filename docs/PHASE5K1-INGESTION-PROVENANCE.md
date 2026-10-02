# Phase 5K.1 — Public Social Intelligence Ingestion & Provenance

EVOLVE remains **PAPER ONLY** and **OBSERVER ONLY**. Phase 5K.1 adds no wallet, no
signer, no transaction construction, no write RPC, no order submission and no
autonomous financial execution. Nothing in 5K.1 enters production entry gates,
fitness, rankings, Arena decisions, champion selection or research-swarm
promotion.

This document specifies **Phase 5K.1 — offline ingestion and provenance
foundation**. It extends, and never rewrites, the governance frozen in
`docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md` and
`scripts/public-intelligence/definition.mjs`.

## 1. Purpose

Build the deterministic machinery that turns a raw public social observation
into a frozen, provenance-anchored, provider-scoped research record — with no
network access, no provider SDK and no canonical identity other than an exact
Solana mint address.

The scientific question 5K.1 answers is narrow and answerable:

> Given one public observation, can EVOLVE state exactly what evidence it holds,
> where that evidence came from, when it was observed and fetched, which exact
> mint (if any) it is bound to, and whether the record has been tampered with —
> with the same answer on every machine, every run, forever?

## 2. Non-goals

5K.1 is explicitly **not**:

- a live provider integration (no X, Reddit, Telegram, Discord, Farcaster,
  Bluesky, Mastodon, RSS or any HTTP client);
- a scraper, a browser, a headless client or a rate-limit negotiator;
- a credential, cookie, session-token or account system;
- a sentiment, toxicity, embedding, topic-model or LLM-interpretation stage;
- a scoring, ranking, recommendation, alpha or trading-signal stage;
- a production database or a distributed store;
- anything that writes under `.evolve`.

Provider adapters are **Phase 5K.2**. Research math is **Phase 5K.4**. Nothing
here is a partial implementation of either.

## 3. Module layout

| Module | Responsibility |
| --- | --- |
| `definition.mjs` | **5K.0, unchanged.** Governance, canonical identity, canonical JSON. |
| `observation.mjs` | Closed raw schema, validation, immutable canonicalization. |
| `provenance.mjs` | Deterministic raw-evidence fingerprints, tamper verification. |
| `normalize.mjs` | Normalized projection, exact-mint association, missingness. |
| `dedup.mjs` | Provider-scoped identity, dedup decision, conflict refusal. |
| `store.mjs` | Bounded local storage; `.evolve` refusal. |
| `ingest.mjs` | The nine-stage pipeline. |
| `fixtures.mjs` | Synthetic, entirely fictional provider fixtures. |

5K.1 modules import `definition.mjs` and nothing else from the repository apart
from the shared canonical-JSON helper. The transitive closure is proven by test
`I4`.

## 4. Raw observation schema

Closed schema: unknown fields are refused, at the top level and inside
`rawMetadata`, so an upstream rename cannot silently change a research number.

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | record schema version (5K.0's version, un forked) |
| `recordType` | yes | `public_social_raw_observation` |
| `provider` | yes | provider identity |
| `providerObservationId` | yes | provider-assigned observation id |
| `providerAuthorId` | explicit `null` | public author id, or absent |
| `sourceType` | yes | `POST` / `REPLY` / `THREAD_ITEM` / `PROFILE_BIO` |
| `sourceUrl` | explicit `null` | canonical public URL, or absent |
| `publishedAt` | explicit `null` | publication instant, or absent |
| `observedAt` | explicit `null` | provider observation instant, or absent |
| `fetchedAt` | yes | EVOLVE fetch instant |
| `rawText` | yes | public body text, preserved verbatim |
| `rawMetadata` | yes | provider-supplied metadata, closed schema |
| `claimedMint` | explicit `null` | the exact address asserted by evidence |
| `collectionContext` | yes | run id, adapter name/version, collector mode |
| `classification` | yes | the frozen 5K.0 classification block |

"Explicit `null`" means the field is always **present** and may be `null`.
Absence is a value, not a missing key: a missing key would make canonical
serialization ambiguous, and ambiguity in a fingerprint input is fatal.

### 4.1 Evidence preservation

- `rawText` is stored **character for character** as received. It is never
  trimmed, folded, lowercased, stemmed or truncated. Any string, including
  empty, whitespace-only and multi-line text, is valid evidence.
- `rawMetadata` is deep-frozen at canonicalization and is immutable from the
  moment of ingestion onward.
- Normalization **reads** raw evidence and never writes back to it.
  Non-mutation is *proven*, not asserted: `normalizeObservation5K1` fingerprints
  raw evidence before and after and throws
  `PUBLIC_INTELLIGENCE_5K1_NORMALIZATION_MUTATED_RAW` if the two differ.

### 4.2 Non-representable values

`undefined`, `NaN`, `Infinity`, functions and symbols are **refused**, never
coerced. So is any field named in the forbidden list, at any nesting depth:
private messages, group messages, contact details, real names, geolocation,
follower/following lists, cookies, session cookies, access/refresh/bearer
tokens, API keys and secrets, private keys, mnemonics, seed phrases and
authorization headers.

// @@CHUNK2@@


## 5. Normalized schema

A deterministic projection of raw evidence. Every field is a pure function of
raw evidence, so identical raw input always yields an identical normalized
record.

`schemaVersion`, `recordType`, `phase`, `rawObservationFingerprint`, `raw`,
`provider`, `providerObservationId`, `providerAuthorId`, `sourceType`,
`sourceUrl`, `dedupIdentity`, `canonicalText`, `canonicalTextFingerprint`,
`normalizedAuthorIdentity`, `publishedAt`, `observedAt`, `fetchedAt`,
`availabilityAt`, `assetAssociation`, `engagement`, `missingness`,
`provenance`, `classification`.

`canonicalText` is a **structural** projection, not an interpreted one: only
CRLF/CR line endings are normalized to LF, because that difference is a
transport artifact rather than content. There is no lowercasing, stemming,
tokenization, stop-word removal or truncation. The authoritative text remains
`raw.rawText`, which travels with the record untouched.

## 6. Mint association rules

Canonical identity requires an **exact Solana mint address**. Nothing else binds
a subject — not symbol, ticker, token name, cashtag, hashtag, display name,
profile handle, edit distance, prefix, embedding or any natural-language
similarity.

`assetAssociation` reports:

| Field | Meaning |
| --- | --- |
| `status` | `EXACT_MINT` / `UNASSOCIATED` / `INVALID_MINT` / `AMBIGUOUS` |
| `mint` | the exact base58 address, or `null` |
| `method` | `EXACT_MINT_ADDRESS` or `UNASSOCIATED` |
| `evidence` | what was claimed, what was refused, and why |

The decision table is total:

| Evidence | Status | Mint |
| --- | --- | --- |
| no claimed mint | `UNASSOCIATED` | `null` |
| claimed mint is exact base58 | `EXACT_MINT` | that exact string |
| claimed mint present but not exact base58 | `INVALID_MINT` | `null` |
| >1 distinct exact candidate mints | `AMBIGUOUS` | `null` |

Three consequences worth stating plainly:

- **`UNASSOCIATED` is valid data.** A post naming a token but carrying no
  address is a complete observation with no canonical subject. It is not a
  defect, and no later phase may repair it by guessing.
- **Nothing is invented.** No mint is interpolated, normalized, case-folded,
  resolved through a registry or inferred from context. A non-`EXACT_MINT`
  status always carries `mint: null`, and an `EXACT_MINT` status always carries
  a string that exists verbatim in the evidence.
- **Case sensitivity.** Solana addresses are case-sensitive, so a lowercase
  address is a *different identity*, never a match for the uppercase form. No
  canonicalization step repairs a differently-cased address.

`evidence.refusedIdentitySignals` records which non-canonical identity signals
were present and deliberately **not** used as identity (for example
`SYMBOL_ONLY`, `TOKEN_NAME_ONLY`, `PROFILE_NAME_SIMILARITY`). This makes each
refusal auditable after the fact, and is deliberately inert: it cannot influence
`status` or `mint`.

// @@CHUNK3@@

## 7. Provenance

Every normalized record carries a closed provenance block proving four things
and nothing more: **which provider**, **which provider observation id**, **when
it was fetched**, and **what raw evidence was received**.

Fingerprinting rules:

- **Algorithm:** SHA-256. **Serialization:** `EVOLVE_CANONICAL_JSON` (the shared
  canonical JSON from `scripts/market-intelligence/definition.mjs`).
- **Anchored to raw evidence.** The canonical raw fingerprint covers the raw
  record as received, including `provider`, `providerObservationId`, `fetchedAt`,
  `rawText`, `rawMetadata` and `claimedMint`. Normalized content never
  substitutes for raw content, so a normalization bug cannot launder mutated
  evidence.
- **Reproducible.** Identical evidence yields an identical fingerprint on any
  machine. Mutating any evidence field, by a single character, changes it.
- **Mutable runtime fields are excluded** (`ingestSequence`, `storageLocation`,
  and similar bookkeeping). Without that exclusion, replaying identical evidence
  would yield a different identity, which would make deduplication impossible.
- **Fails closed on unknown fields.** A provenance block carrying an undeclared
  field is refused.

Sub-fingerprints exist so provenance can be checked piecewise:
`rawObservationFingerprint`, `rawTextFingerprint`, `rawMetadataFingerprint`.

`verifyProvenance5K1(provenance, raw)` re-derives every claim from raw evidence
and compares. Any mismatch is fatal: a mismatch is never repaired, downgraded or
ignored. Provenance is verified **before** persistence, so a record that cannot
prove its own origin never reaches disk.

## 8. Deduplication

An upstream observation is identified by **`(provider, providerObservationId)`**.
That is the whole identity rule.

| Case | Outcome |
| --- | --- |
| same provider + same observation id + identical evidence | `DUPLICATE` (idempotent no-op) |
| same provider + same observation id + different evidence | `CONFLICT` (refused) |
| same provider + different observation id | `INSERTED` (distinct) |
| different providers, anything | `INSERTED` (never collapsed) |

Notes that matter:

- **Text equality is never identity**, in either direction. Content hashing is
  similarity matching with a different threshold, so `text` is not an input to
  the dedup digest at all. Two authors posting identical words, or one author
  reposting, produce two records.
- **Cross-provider collapse is permanently refused**, not merely deferred.
  Collapsing would require a similarity judgement, which 5K.0 prohibits as
  canonical identity. The same text from two providers remains two observations.
- **Conflicts are surfaced, not resolved.** If one upstream identity carries two
  different byte sequences, the ingestion is refused with
  `PUBLIC_INTELLIGENCE_5K1_INGEST_CONFLICT_REFUSED`. Last-write-wins would
  silently destroy evidence.
- **There is no URL or content fallback.** With no provider observation id there
  is no upstream identity, and identity is explicitly unknown rather than
  derived from a digest.

## 9. Timestamps

Three clocks are kept strictly distinct and are never collapsed:

| Field | Meaning |
| --- | --- |
| `publishedAt` | when the item was published; `null` if the provider supplied none |
| `observedAt` | when the provider first reported it; `null` if unknown |
| `fetchedAt` | when EVOLVE read it; always required |

Semantics: integer milliseconds since the UNIX epoch, UTC.

**Rejected, never coerced:** `NaN`, `Infinity`, `-Infinity`, non-integer values
(epoch milliseconds are integers), non-numbers (including numeric strings),
negative values, and an absent `fetchedAt`.

**Ordering.** `fetchedAt >= observedAt` when both are present; EVOLVE cannot
fetch what it had not yet observed, and a violation is refused outright.

**No implicit clock.** The pipeline never reads a clock. `fetchedAt` is supplied
by the caller as evidence, because a pipeline that stamps its own clock cannot be
replayed deterministically. This is proven structurally: no 5K.1 module references
`Date`, `performance`, `hrtime` or `process` (tests `F4`).

**No look-ahead.** Availability is judged on `fetchedAt` — the only clock EVOLVE
controls — inclusively. `isAvailableAt5K1` and `selectAvailableAt5K1` fail closed
on a non-finite reference instant and admit nothing.

**A missing `publishedAt` stays missing.** It is never replaced by `fetchedAt`,
never inferred, and the absence is itself evidence: a record with
`publishedAt: null` fingerprints differently from the same record with a
synthesized publication time.

// @@CHUNK4@@


## 10. Missingness

Missing social evidence is **missing**. It is never converted into `0`, `0.0`,
`false`, `''`, a fabricated identifier, a fabricated mint or the current clock.

Each optional field reports an explicit state drawn from 5K.0's vocabulary:
`OBSERVED`, `NO_OBSERVATION`, `PROVIDER_UNAVAILABLE`, `ASSOCIATION_UNAVAILABLE`,
`RATE_LIMITED`, `UNKNOWN_MINT`, `NOT_YET_PUBLISHED`.

| Field | Absent state | Notes |
| --- | --- | --- |
| `providerAuthorId` | `NO_OBSERVATION` | never enriched or deanonymized |
| `sourceUrl` | `NO_OBSERVATION` | never synthesized from provider + id |
| `publishedAt` | `NOT_YET_PUBLISHED` | never replaced by `fetchedAt` |
| `observedAt` | `NO_OBSERVATION` | never replaced by `fetchedAt` |
| `engagement` | `NO_OBSERVATION` | `values: null`, never zeros |
| `assetAssociation` | `ASSOCIATION_UNAVAILABLE` | distinct from missing evidence |

Two asymmetries are load-bearing:

- **A provider-supplied `0` is observed, not missing.** A post with zero likes is
  a real measurement. `engagement.values.reposts === 0` is `OBSERVED`.
- **A partially supplied engagement object is carried as-is.** Absent keys stay
  absent; they are not filled with `0`.

An unassociated observation is a *complete* observation whose subject is
unknown, which is why it is reported as `ASSOCIATION_UNAVAILABLE` rather than
`NO_OBSERVATION`.

## 11. Storage semantics

5K.1 needs persistence with certain properties, not a production database. Two
backends provide them: an in-memory store (hermetic unit tests) and an
append-only NDJSON store (durability and append-only behaviour).

| Property | Guarantee |
| --- | --- |
| Raw before normalized | raw evidence is appended to its own stream **first** |
| Raw preserved | raw evidence round-trips byte-for-byte |
| Append-only | records are never rewritten; lines are only ever added |
| No in-place mutation | stored records are frozen snapshots, not live views |
| Deterministic identity | record identity **is** the dedup identity |
| Idempotent ingest | re-ingesting identical evidence appends nothing |
| Provider-aware dedup | see §8 |
| Read-only querying | `list`, `rawList`, `count`, `get`, `has`, `providers` |
| Conflicts never overwrite | see §8 |

**Layout.** The NDJSON backend writes two append-only streams into the
caller-supplied directory:

| Stream | Contents | Order |
| --- | --- | --- |
| `raw-evidence.ndjson` | one canonical raw record per line | written **first** |
| `observations.ndjson` | one canonical envelope per line | written after |

Writing raw evidence to its own stream before the envelope is what makes "raw
before normalization" verifiable rather than merely asserted: if the process
dies between the two appends, raw evidence still survives on disk and is never
lost behind a failed normalization. The raw stream is independently readable via
`rawList()`, and a record read from it re-fingerprints to the stored identity.

Note that the *envelope* stores keys in canonical (alphabetical) order, so
`normalized` sorts before `raw` within a line. The ordering guarantee is
therefore a property of the **write sequence**, not of key order, which is why
it is implemented as two streams rather than one.

**`.evolve` is permanently off limits.** Every write path is validated by
`assertSafeStoreDirectory`, which resolves the path and refuses any path
containing a forbidden root segment. Direct, relative and `..`-traversal paths
into `.evolve` are all refused, and nothing under `.evolve` is created while
proving it. Tests write only to OS temp directories.

// @@CHUNK5@@


## 12. Ingest pipeline

```
ingestPublicObservation(rawInput, context) -> frozen deterministic result
```

1. **Closed-schema validation** — unknown field, forbidden field, bad timestamp
   or non-representable value is refused here.
2. **Raw canonicalization** — a new deep-frozen clone; evidence unaltered.
3. **Raw fingerprint** — anchored to raw evidence.
4. **Exact-mint validation** — only when a mint is explicitly claimed. This can
   only accept the exact string already present in evidence, or refuse it. It
   never creates a mint.
5. **Normalized projection** — a pure function of raw, proven non-mutating.
6. **Provenance generation** — source identity plus three fingerprints.
7. **Dedup decision** — provider-scoped; `INSERTED` / `DUPLICATE` / `CONFLICT`.
8. **Persistence** — raw written alongside normalization, after provenance
   verifies.
9. **Deterministic return** — frozen; a pure function of (input, store state).

No network call. No provider SDK. No credential. No environment read. No clock
read. A malformed mint claim is *not* an exception: the observation is still
valid evidence, it simply has no canonical subject, which the association
projection records.

## 13. Privacy and security boundary

Public, publicly accessible observations only. Permanently out of scope, and
refused structurally rather than by convention:

- private messages, group messages, direct messages;
- private accounts, restricted content, private profiles and groups;
- credentials, cookies, session tokens, browser authentication, device
  fingerprints;
- authentication or CAPTCHA bypass, scraping-bypass techniques;
- account takeover, impersonation or session replay;
- identity enrichment, deanonymization, contact discovery, private-person
  profiling;
- follower/following graphs, subscriber counts, real names, locations.

No provider-specific credential handling exists in 5K.1, because there is no
provider integration in 5K.1.

## 14. Future provider adapter interface (Phase 5K.2)

A 5K.2 adapter must satisfy all of the following:

- produce a **closed-schema raw observation** and nothing else — provider payload
  shapes must not leak into research records;
- be pinned to `collectorMode`, which 5K.1 currently fixes at
  `OFFLINE_FIXTURE`, so a live adapter cannot appear behind an unchanged schema
  version;
- hold **no credential inside the research module** — authentication lives
  outside the ingestion boundary entirely;
- respect explicit, pre-declared collection bounds (duration, results per page,
  request budget, storage bound, provider cooldown/rate-limit handling);
- remain read-only, public-data-only, and incapable of writing to any RPC;
- adapt into the one canonical normalized representation, so an upstream field
  rename cannot silently change a research number.

There is **no unbounded crawler**. Scheduled collection is Phase 5K.5.

// @@CHUNK6@@


## 15. Why no trading path exists

There is no import path from Phase 5K.1 into any live decision surface. The
5K.1 import closure is proven to contain only 5K.1's own modules, 5K.0
governance, and the shared canonical-JSON helper — no engine, Arena, promotion,
champion-selection, wallet, signer, swap or RPC-write module is even reachable
(tests `I3`, `I4`, `I5`). No `.evolve` write exists (test `I7`).

Every 5K.1 record carries the frozen 5K.0 classification block verbatim:
`researchOnly: true`, `observerOnly: true`, `paperOnly: true`,
`tradingAuthority: false`, `engineAuthority: false`, `arenaEligible: false`,
`promotionEligible: false`, `profitabilityInferencePermitted: false`.

5K.1 computes **no** sentiment, score, ranking, recommendation, alpha or trading
signal, and 5K.1's research output is not an input to any production gate.

## 16. A note on the 5K.0 roadmap label

5K.0's `PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.roadmap` labels `5K.1` as
"Authority Benchmark". That label predates this phase and is preserved
**verbatim and unmodified**, because 5K.0 governance is frozen and rewriting it
would weaken it. What 5K.1 actually delivers is the ingestion and provenance
foundation specified in this document. The roadmap entry should be reconciled in
a separate, explicitly governed 5K.0 revision rather than by silently editing a
locked definition.

## Validation

`node scripts/validate-phase5k1.mjs` is completely offline and deterministic,
covering 64 contracts in ten categories: classification (A), exact-mint
association (B), raw evidence integrity (C), provenance (D), deduplication (E),
timestamp discipline (F), missingness (G), storage (H), architectural isolation
(I), and phase ancestry/integrity (J).

Capability and import audits use a real parse tree (espree), not string
matching. Tests write only to temporary directories; the repository tree and
`.evolve` are unchanged by validation.

`node scripts/validate-phase5k.mjs` remains **32/32**, unweakened. 5K.1 extends
5K.0 and never modifies `definition.mjs`.

**Not implemented in 5K.1:** any live collection, provider client, scraper,
authentication, provider SDK, model inference, sentiment, trading signal or
deployment gate.

