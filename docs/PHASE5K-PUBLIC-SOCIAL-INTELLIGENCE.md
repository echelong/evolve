# Phase 5K — Public Social Intelligence

EVOLVE remains **PAPER ONLY** and **OBSERVER ONLY**. Phase 5K records passive,
public, read-only social research evidence. It has no wallet, no signer, no
transaction construction, no write RPC, no order submission, no copy trading and
no autonomous financial execution. Nothing in Phase 5K enters production entry
gates, fitness, rankings, Arena decisions, champion selection or research-swarm
promotion.

This document and `scripts/public-intelligence/definition.mjs` specify
**Phase 5K.0 — Research Governance only**. 5K.1–5K.5 are declared as intent
here and are **not** implemented.

## 1. Purpose

Public, read-only social research associated with **exact canonical Solana mint
addresses**. The long-term purpose is to collect and study public social
observations — initially public X observations — attached to exact mint
identities.

The first scientific milestone is **not** prediction and **not** trading. It is:

> Can EVOLVE reproducibly associate public social observations with exact
> canonical Solana mint addresses while preserving deterministic evidence,
> provenance, timing, freshness, deduplication and research-only
> classification?

## 2. Classification

Every 5K artifact carries this classification block verbatim. It is frozen and
cannot be widened at runtime:

```
developmentOnly: true
researchOnly: true
observerOnly: true
paperOnly: true

tradingAuthority: false
engineAuthority: false
arenaEligible: false
promotionEligible: false
profitabilityInferencePermitted: false
```

## 3. Hard boundary from R4

- **R4 is closed.** Its canonical result stands: availability denominator 3516,
  resolved references 2341, distinct resolved mints 90, Kendall tau-b
  0.40163549403930066, 95% mint-cluster bootstrap CI
  [0.2762661417066577, 0.4971652649589867], 10,000/10,000 bootstrap replicates.
- **5K is post-R4** and lives entirely outside the R4 seal.
- **5K evidence is not R4 evidence.** It has its own evidence class
  (`PUBLIC_SOCIAL_RESEARCH_EVIDENCE`).
- 5K may not change R4 **membership**, **outcomes**, **analysis** or
  **interpretation**.
- 5K may not become a hidden R4 sensitivity analysis.
- No 5K result retroactively changes how R4 is read.
- R4's positive association is a research finding and is **never** permission to
  act.

R4 remains `researchOnly` / `paperOnly` / `observerOnly` with
`tradingAuthority = false` and `profitabilityInferencePermitted = false`.

## 4. Canonical subject identity

Social observations attach to an **exact canonical Solana mint address** and
nothing else. The following are **never** canonical identity:

- symbol alone
- token name alone
- ticker guessing
- fuzzy token matching
- prefix / edit-distance matching
- embedding or natural-language similarity
- profile-name guessing
- manual or heuristic guessing

Canonical association requires an exact mint address, validated as base58 and
case-sensitive. A public post that cannot be associated with an exact mint
**remains unassociated**. A match is never forced. Solana addresses are
case-sensitive, so a lowercase address is not a canonical match.


## 5. Raw evidence model

The future raw social observation record is a **closed schema**:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | record schema version |
| `recordType` | `public_social_raw_observation` |
| `provider` | provider identity |
| `providerObservationId` | provider-stable observation id |
| `sourcePublishedAt` | when the author/provider published it |
| `providerObservedAt` | when the provider first reported it |
| `retrievedAt` | when EVOLVE read it |
| `canonicalUrl` | public source identity |
| `authorPublicId` | public author id only |
| `textDigest` | SHA-256 of the public text |
| `rawPayloadDigest` | SHA-256 of the raw provider payload |
| `candidateMintAddresses` | exact mints found, association unverified |
| `exactAssociatedMintAddresses` | exact mints this record is associated to |
| `associationMethod` | `EXACT_MINT_ADDRESS` or `UNASSOCIATED` |
| `provenance` | provenance block |
| `classification` | the §2 classification block |

Storage is minimized to what future reproducibility requires. The schema
explicitly **forbids** personal and private fields: email, phone, private or
direct messages, IP address, real/legal name, home address, geo-location, birth
date, device id, session cookie, access/refresh tokens, API keys, bearer tokens,
follower/following/contact lists and profile image URLs.

## 6. Normalized evidence model

Deterministic normalized fields are defined **separately** from raw evidence.
Normalization **never mutates raw evidence**: it reads a raw record, produces a
new frozen object, and carries the raw fingerprint forward as provenance.

Permitted normalized categories in 5K.0:

- observation identity
- exact mint associations
- timestamps
- public engagement counts, provider-supplied only
- deterministic text digest
- deterministic normalized-text digest
- provider / source identity
- freshness metadata

Explicitly **deferred and not implemented**: sentiment, toxicity, LLM
interpretation, embeddings, topic modeling, trading signals, scoring, ranking,
recommendation, author reputation, bot detection and engagement-weighted or
alpha scores.

## 7. Provenance

Every normalized observation is traceable to exactly one immutable raw record
via a deterministic SHA-256 fingerprint over EVOLVE canonical JSON. A normalized
record may not be orphaned, and no observation is ever silently rewritten. A
provenance fingerprint mismatch fails closed.

## 8. Timestamps

Three distinct clocks, never collapsed:

- `sourcePublishedAt` — publication time
- `providerObservedAt` — provider observation time
- `retrievedAt` — EVOLVE retrieval time

Clock semantics: **integer milliseconds since the UNIX epoch, UTC**. A value
that is not a finite safe integer fails closed; it is never coerced and never
defaulted to zero. Absent values use explicit missingness, not a sentinel.
`retrievedAt` is the authoritative availability instant because it is the only
clock EVOLVE controls.

## 9. Deduplication

Deterministic dedup identity is `(provider, providerObservationId)`, preferring
the provider-stable observation id. **Text equality alone is never identity.**
Cross-provider duplicates remain **distinguishable**; they are never silently
collapsed without an explicit later research rule.

## 11. Bounded collection

Future collection must declare explicit bounds before it starts: duration,
results/page limits, storage bounds, request budget, and provider
cooldown/rate-limit handling. There is **no unbounded crawler**. Scheduled
collection is Phase 5K.5.

## 12. Provider isolation

Provider-specific raw formats never leak into research calculations. Each
provider adapts into the one canonical normalized representation, and unknown
fields are rejected, so an upstream rename cannot silently change a research
number.

## 13. No hidden look-ahead

A study evaluated at a reference instant may use only evidence available at or
before it, judged on `retrievedAt` (inclusive). Future evidence is never
admitted and can never influence an earlier reference. Research math is Phase
5K.4.

## 14. Missingness

Missing social evidence is **missing**. It is never converted into `0`, `0.0`,
`false` or `''`. Explicit states: `OBSERVED`, `NO_OBSERVATION`,
`PROVIDER_UNAVAILABLE`, `ASSOCIATION_UNAVAILABLE`, `RATE_LIMITED`,
`UNKNOWN_MINT`, `NOT_YET_PUBLISHED`. Only `OBSERVED` carries a measurement, and
an observed `0` (a post with zero likes) is observed, not missing.

## 15. Reproducibility

A future research session binds provider configuration, collection bounds, raw
evidence fingerprints, normalized evidence fingerprints, exact mint
associations, source timestamps, software/version identity and a deterministic
session fingerprint.

## 16. Privacy / public data scope

Only publicly accessible observations are in scope. Phase 5K permanently
excludes private-account access, authentication bypass, scraping restricted
content, private-message ingestion, identity enrichment, deanonymization,
contact discovery and private-person profiling.

## 17. No social-to-trading path

There is **no import path** from Phase 5K into engine decisions, paper
execution, fitness, breeding, Arena, champion selection, deployment gates or
live entry/exit. `scripts/validate-phase5k.mjs` proves this with a real parse
tree over the module's transitive import closure, and also proves that no live
surface imports 5K.0.

## Validation

`node scripts/validate-phase5k.mjs` is completely offline and covers 32
contracts: permanent classification, exact-mint-only identity, rejection of
symbol/name/fuzzy association, valid-but-unassociated observations,
deterministic raw and normalized fingerprints, no hidden look-ahead,
non-mutable raw evidence, distinct timestamps, fail-closed invalid timestamps,
provider-scoped dedup identity, cross-provider non-collapse, explicit
missingness, provenance mismatch, closed schemas, malformed mint rejection,
reproducible session fingerprints, absence of network imports, absence of
wallet/signing/swap/RPC-write capability, absence of engine and
Arena/promotion import paths, absence of any R4 import or mutation, R4 artifact
preservation with HEAD at the canonical continuation commit, declared (not
implemented) privacy scope, bounded collection and provider isolation, and
temporary-fixture-only writes. Capability and import audits use AST analysis,
not string matching.

**Not implemented in 5K.0:** any live collection, X API client, scraper,
authentication, provider SDK, model inference, sentiment, trading signal or
deployment gate.


## 10. Freshness

Freshness is **descriptive metadata only** in 5K.0. No empirical threshold is
chosen here, because none exists in committed authority and none is invented.
The Evidence Freshness Gate is **Phase 5K.3**.
