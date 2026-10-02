# Phase 5K.3 — Bounded Public Intelligence Collection Runs

Status: research/observer-only. `researchOnly: true`, `observerOnly: true`, and
`tradingAuthority`, `engineAuthority`, `arenaEligible`, `promotionEligible`,
`profitabilityInferencePermitted` are all `false` (5K.0, unchanged). Every plan, request
record, manifest and stored observation inherits that block; nothing can override it.

5K.3 adds the **collection protocol** around the existing Mastodon adapter (5K.2) and the
5K.1 ingestion pipeline. No new provider, no sentiment, no signal.

```
CollectionPlan ──► run (injected clock) ──► transport ──► mapper ──► ingestPublicObservation
                        │                        │
                        ▼                        ▼
                  plan.json            requests.ndjson (structural only)
                        │
                        ▼
      raw-evidence.ndjson + observations.ndjson (5K.1 NDJSON store, per run)
                        │
                        ▼
            self-verification ──► manifest.json (atomic, write-once)
```

Modules (`scripts/public-intelligence/`): `collection-plan.mjs`, `collection-manifest.mjs`,
`run-store.mjs`, `collection-run.mjs`, `replay.mjs`, `collect.mjs` (CLI); validator
`scripts/validate-phase5k3.mjs`.

## 1. Collection-plan schema

Closed schema (`schemaVersion 5K.3.0`, `recordType public_collection_plan`):

| Field | Meaning |
|---|---|
| `provider` | `mastodon` only |
| `instance` | public DNS host name (never a URL, port, IP literal or path) |
| `query` | `{ type: "HASHTAG", value }`, value must satisfy the 5K.2 hashtag contract |
| `bounds` | `maxPages`, `maxRecords`, `timeoutMs`, `maxResponseBytes`, `maxLookbackMs` — all required |
| `collectionMode` | `OFFLINE_FIXTURE` (requires an injected transport) or `LIVE_PUBLIC_PROVIDER` (forbids one) |
| `createdAt` | integer epoch ms, supplied by the caller |
| `classification` | the frozen 5K.0 block; any other value is refused |

`collectionPlanFingerprint = SHA-256(canonical JSON of the full plan)`. Changing the
instance, query, any bound, the mode, `createdAt` or the classification changes it (a changed
classification is refused outright). No runtime result is ever an input. There is no URL or
endpoint field, so an arbitrary endpoint cannot be expressed; extra keys are refused.

`instance` is an addition to the brief's minimum field list: Mastodon identity is per-instance.

## 2. Run lifecycle

1. Validate the plan (throws before any run identity exists if invalid).
2. `startedAt = clock()`; derive `runId`.
3. If the run directory exists → `REFUSED` (in memory; nothing is written).
4. Create the run directory exclusively; write `plan.json` (write-once, read-only).
5. Acquire through the 5K.2 transport; every request appends one record to `requests.ndjson`.
6. Map each record (5K.2 mapper) and ingest it (5K.1); count every outcome.
7. Build the manifest (accounting invariants must hold or it cannot be built).
8. Self-verify the stored artifacts. If verification fails the run is re-finalized as
   `FAILED_INTEGRITY` (history is never rewritten to look better).
9. Write `manifest.json` atomically and write-once.

A run directory without `manifest.json` is an **unfinalized/aborted** run. The verifier reports
`MANIFEST_MISSING_UNFINALIZED_RUN`; nothing promotes it to `COMPLETED`.

**Run identity.** `runId = "run-" + first 32 hex of SHA-256(canonical{kind, collectionPlanFingerprint, startedAt})`.
It identifies *one execution instance of one plan*. It is deterministic (no randomness), so the
same plan started at the same instant is the same identity and a second attempt is `REFUSED`
instead of silently creating a twin. No scientific/result value ever enters it. The separate
`manifestFingerprint` authenticates what the run actually did and found.

**Clock discipline.** The orchestrator takes an injected `clock`; there is no default. The only
wall-clock read is `Date.now` passed in by the CLI. No lower 5K.3 module references `Date` or
timers, replay invents no timestamps, and validators use counter clocks.

## 3. Manifest schema

Closed schema (`public_collection_run_manifest`): `runId`, `collectionPlanFingerprint`,
`provider`, `instance`, `query`, `startedAt`, `completedAt`, `status`, `requestCount`,
`pageCount`, `providerRecordsSeen`, `recordsMapped`, `recordsIngested`, `duplicates`,
`conflicts`, `refused`, `ingestFailures`, `rawEvidenceRecordsWritten`,
`normalizedRecordsWritten`, `failureCounts`, `refusedReasons`, `providerCursorSummary`
(`firstCursor`, `lastCursor`, `cursorsUsed`, `stopReason`, `nextCursorPresent`),
`requestsFingerprint`, `rawEvidenceFingerprint`, `observationsFingerprint`, `classification`,
`manifestFingerprint`.

`manifestFingerprint` is the SHA-256 of the canonical manifest without that field. The three
evidence fingerprints bind the manifest to the ordered request records, the ordered raw
fingerprints and the ordered normalized fingerprints. `ingestFailures`, `refusedReasons` and
the evidence fingerprints extend the brief's minimum list.

## 4. Request records

One closed record per provider request (`public_collection_request_record`):
`requestIndex`, `provider`, `instance`, `query`, `cursor` (the `max_id` used), `requestedAt`,
`completedAt`, `outcome` (`OK` or a failure class), `httpStatus`, `recordsReturned`,
`responseBytes`, `rateLimit` (exactly `retryAfterSeconds`, `rateLimitLimit`,
`rateLimitRemaining`, `rateLimitReset`, copied by whitelist), `nextCursor`.

Never persisted: credentials, cookies, authorization or any other header, URLs with query
strings, or the response body. The transport reports these through an optional `onRequest`
observer that is handed structural metadata only.

## 5. Bounds

The plan bounds are the 5K.2 hard ceilings and can only be tightened:
`maxPages ≤ 5`, `maxRecords ≤ 200`, `timeoutMs ≤ 20000`, `maxResponseBytes ≤ 2097152` (per
response), `maxLookbackMs ≤ 7 days`. Each must be an integer ≥ 1: `0`, negatives, fractions,
`Infinity`, `NaN` and strings are refused, so there is no "unlimited". Retries are fixed at
zero. `maxResponseBytes` is also checked against every stored request record at verification.

## 6. Accounting invariants

Derived from the real 5K.1 ingest semantics (each mapped record ends in exactly one of: stored,
`ALREADY_PRESENT`, conflict refusal, other refusal; a stored record writes one raw line and one
normalized line; a duplicate writes nothing):

1. `providerRecordsSeen = recordsMapped + refused`
2. `recordsMapped = recordsIngested + duplicates + conflicts + ingestFailures`
3. `rawEvidenceRecordsWritten = recordsIngested = normalizedRecordsWritten`
4. `requestCount = pageCount + failedRequests`, with `failedRequests ≤ 1` (no retries)
5. `failureCounts.MAPPING_REFUSED = refused = Σ refusedReasons`; `failureCounts.INGEST_CONFLICT = conflicts`; `failureCounts.INTEGRITY_FAILURE ≥ ingestFailures`
6. Σ request-failure classes = `failedRequests`
7. `providerRecordsSeen ≤ Σ recordsReturned` and `≤ plan.maxRecords`; `requestCount ≤ plan.maxPages`
8. `startedAt ≤ completedAt`
9. `status` equals the status the counts imply (one shared `deriveRunStatus` function)

`providerRecordsSeen` counts records handed to the mapper; records the transport drops for
being older than the lookback window are not counted. Ingest dedup is per run: each run has its
own store, so cross-run dedup is not claimed here.

## 7. Failure states

Terminal run status:

| Status | Exactly when |
|---|---|
| `COMPLETED` | all requests succeeded; stop reason is planned (`END_OF_TIMELINE`, `MAX_PAGES`, `MAX_RECORDS`, `LOOKBACK_REACHED`); no conflicts; no integrity failure. Mapper refusals (e.g. non-public posts) are counted, not failures |
| `PARTIAL` | requests succeeded but acquisition is knowingly incomplete: unusable pagination cursor, or ≥ 1 ingest conflict |
| `RATE_LIMITED` | provider returned 429; no retry; earlier evidence kept |
| `TIMEOUT` | a request exceeded `timeoutMs`; no retry |
| `PROVIDER_ERROR` | network error, auth required, 4xx, 5xx, invalid or oversized response |
| `REFUSED` | a valid plan was refused before provider contact (run id already exists). In-memory result only |
| `FAILED_INTEGRITY` | an ingest/integrity failure, or self-verification failed |

Every non-`COMPLETED` state may still hold valid partial evidence; counts say how much.

Failure classes (counts only, never messages or evidence): `RATE_LIMITED`, `TIMEOUT`,
`NETWORK_ERROR`, `PROVIDER_AUTH_REQUIRED`, `PROVIDER_4XX`, `PROVIDER_5XX`,
`INVALID_PROVIDER_RESPONSE`, `OVERSIZED_RESPONSE`, `MAPPING_REFUSED`, `INGEST_CONFLICT`,
`INTEGRITY_FAILURE`.

## 8. Storage layout

Runtime root: default `var/public-intelligence/` (added to `.gitignore` as `/var/`; the repo had
no prior runtime-directory convention). A root is accepted only if it is absolute, has no `..`,
no `.evolve` segment (checked again after symlink resolution), and lies under the default root
or the OS temp directory.

```
<runtime-root>/runs/<run-id>/
  plan.json            write-once, read-only
  requests.ndjson      append-only
  raw-evidence.ndjson  5K.1 store, raw written first
  observations.ndjson  5K.1 store
  manifest.json        temp file + hard link (fails if it exists), read-only, never mutated
```

This reuses the 5K.1 NDJSON store unchanged, one store per run directory. Runtime captures are
never committed.

## 9. Replay

`replay.mjs` is offline: its import closure contains no transport and no network primitive.
It re-validates the stored raw evidence, re-derives provenance, dedup identity and normalized
fingerprints, and re-ingests the raw stream into a fresh in-memory store, requiring identical
results. It never re-fetches and invents no timestamps. Duplicates, conflicts and refusals leave
no stored record, so those counts are verified through the accounting invariants.

## 10. Tamper verification

`verifyRunArtifacts` checks: plan validity and fingerprint; manifest schema, classification and
fingerprint; run id re-derivation; request schema, contiguity, monotone time, count and
fingerprint; all accounting invariants and status consistency; raw schema, count and fingerprint;
run id / mode / provider on each raw record; envelope-versus-raw equality; provenance;
dedup identity uniqueness and correctness; normalized fingerprints; replay.
Editing one raw observation, removing a request or a record, changing a count (even when
re-signing the manifest), or downgrading the status each produces a named failure. Malformed
files are reported (`LOAD_MALFORMED:*`), never guessed at.

## 11. Privacy

Manifests and request records hold aggregate counts, enums, ids, fingerprints and the
instance/query only. No handles, display names, bios, follower counts, geolocation, addresses,
mention or contact graphs, headers, cookies or credentials. Raw evidence remains governed by
5K.1/5K.2 (the public status URL, which names the author's public path, is retained by 5K.1
design; profile fields are not).

## 12. Mint-association boundary

The orchestrator has zero authority over association. It passes each record through the
unchanged 5K.2 mapper and 5K.1 pipeline; only those apply the exact-mint rule. No symbol,
project, registry or fuzzy lookup exists in any 5K.3 module (checked by AST).

## 13. CLI

Never invoked by a validator; no daemon, no scheduler.

```
node scripts/public-intelligence/collect.mjs collect --instance mastodon.social --hashtag solana \
     --max-pages 1 --max-records 10 [--timeout-ms N] [--max-response-bytes N] [--max-lookback-ms N] \
     [--output <runtime-root>]                      # live bounded run, persisted
node scripts/public-intelligence/collect.mjs collect ... --dry-run          # validate plan, print fingerprint; NO provider contact
node scripts/public-intelligence/collect.mjs collect ... --dry-run --fetch  # live request in memory; persists NOTHING
node scripts/public-intelligence/collect.mjs verify --run <run-directory>   # offline replay + verification
```

Unknown flags and malformed numbers are refused; bounds above the ceilings fail plan
validation; `--output` is validated as in §8. Output is aggregate counts only, never post text.
(The CLI lives in `collect.mjs`, not `index.mjs`, because `index.mjs` is the read-only 5K.1
re-export used by the adapter and importing the orchestrator there would create a cycle.)

## 14. Changes to 5K.2 (additive)

- `assertPublicHost` / `assertHashtag` moved to `providers/common.mjs` (re-exported from the
  transport) so plan validation and replay stay network-free.
- The transport gained an optional `onRequest` observer and attaches already-acquired records
  to a thrown error (`error.partial`) so a mid-run 429 does not discard evidence.
- 5K.2 behaviour and its validator (70/70) are unchanged.

## 15. Non-goals

No second provider, no sentiment/LLM interpretation, no scoring, ranking, signals, predictions
or profitability claims, no scheduler/daemon, no cross-run dedup, no credential handling, no
storage under `.evolve`, no change to 5K.0, 5K.1 or the 5K.2 mapper.

## 16. Known 5K.0 roadmap label mismatch (retained)

5K.0's `PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.roadmap` labels early phases with names that
predate the delivered scope (`5K.1` is listed as "Authority Benchmark"; 5K.1 delivered ingestion
and provenance, 5K.2 the first provider adapter, 5K.3 these collection runs). The frozen 5K.0
definition is deliberately **not** edited; the roadmap should be reconciled in a separate,
explicitly governed 5K.0 revision.
