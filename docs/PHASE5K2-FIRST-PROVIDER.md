# Phase 5K.2 — First Live Public Provider Adapter

Status: research/observer-only. `researchOnly: true`, `observerOnly: true`, and every
authority flag is `false` (5K.0, unchanged). This phase adds a data *acquirer*, not a
decision surface.

```
live public response → transport → provider record → mapper → 5K.1 raw observation
                     → ingestPublicObservation(...)  ← the adapter ends here
```

Files: `scripts/public-intelligence/providers/{common,mastodon-transport,mastodon-mapper,mastodon}.mjs`,
`scripts/public-intelligence/index.mjs` (read-only re-export of the 5K.1 boundary),
`scripts/validate-phase5k2.mjs`.

## 1. Provider chosen

**Mastodon public hashtag timeline** — `GET https://{instance}/api/v1/timelines/tag/{hashtag}`
(default smoke instance: `mastodon.social`).

## 2. Why it was chosen

| Criterion | Mastodon public tag timeline |
|---|---|
| Genuinely public, documented interface | Yes — documented REST API, public timelines |
| Account / cookie / browser session | None for this endpoint (anonymous GET) |
| Deterministic provider IDs | Yes — per-instance status `id` |
| Timestamps | `created_at`, ISO-8601 |
| Source URLs | `url` / `uri` |
| Rate-limit semantics | HTTP 429 plus `X-RateLimit-*` / `Retry-After` headers |
| Scraping bypass / CAPTCHA | None needed or permitted |
| Private data | Excluded by `visibility == "public"` and by construction |

Considered and not chosen: X/Twitter (paid API, credentials), Reddit (credentialed API,
restrictive terms), Telegram/Discord (membership/private-channel model), HTML scraping of
any site (no documented contract, anti-bot friction).

Instance availability is a deployment fact: an instance may require authentication for
public timelines. The adapter treats 401/403 as the explicit `PROVIDER_AUTH_REQUIRED`
state and never works around it.

## 3. Public-data boundary

Only statuses with `visibility === "public"` are mapped. `unlisted`, `private`, `direct`,
missing or differently-cased visibility is refused. Records typed `direct`, `private`,
`dm`, `conversation`, `mention` are refused. Boost wrappers (`reblog != null`) are refused;
the original has its own id. No profile, follower, or following data is requested.

## 4. Transport contract (`mastodon-transport.mjs`)

The **only** network-capable module. It builds the request, enforces bounds, classifies
errors and returns provider-native records plus `fetchedAt`. It does not map, ingest, or
store. Requests are `GET`, `https`, `redirect: 'error'`, `credentials: 'omit'`, with only
`Accept` and `User-Agent` headers. Hosts must be public DNS names (no IP literals, ports,
userinfo, `.local/.internal/...`). Hashtags are `[A-Za-z0-9_]{1,64}`. Pagination uses
`max_id` taken from the last record id; provider-supplied `Link` URLs are never followed.
`fetch` and the clock are injectable, which is how every test runs offline.

## 5. Mapper contract (`mastodon-mapper.mjs`)

`mapStatusToRawObservation(status, context)` is pure: no network, no clock, no environment.
`context` = `{ host, fetchedAt, collectionRunId, collectorMode }`, all required, none
defaulted. Output is passed through `canonicalizeRawObservation`, so the existing **closed**
5K.1 schema is the final gate; unknown provider fields are discarded before they can reach
it. The mapper reads only the fields listed in `MASTODON_CONSUMED_FIELDS`. No sentiment,
score, ranking, recommendation or signal is produced.

`rawText` is the status `content` with tags removed, `<br>` → newline, paragraph breaks →
blank line, entities decoded once. `collectorMode` is `LIVE_PUBLIC_PROVIDER` from the
transport path and `OFFLINE_FIXTURE` for fixtures.

### Collector-mode extension (additive)

5K.1 pinned `collectorMode` to `OFFLINE_FIXTURE`. 5K.2 adds one value,
`LIVE_PUBLIC_PROVIDER`, through a *separate* constant
(`PUBLIC_INTELLIGENCE_5K2_LIVE_COLLECTOR_MODES`) in `observation.mjs`. The 5K.1 constant and
its validator assertions are unchanged; `LIVE_API` and every other value remain refused.

## 6. Rate limits

HTTP 429 → `PROVIDER_RATE_LIMITED` with `retryAfterSeconds`, `rateLimitLimit`,
`rateLimitRemaining`, `rateLimitReset` when present. **Zero retries, fixed.** The transport
never sleeps and never loops on failure; the caller decides what to do with the metadata.
Mastodon's default is 300 requests / 5 minutes per IP; 5K.2 uses at most 5 requests per run.

## 7. Pagination bounds

All explicit, validated, never clamped, never unlimited (`common.mjs`):

| Bound | Default | Hard ceiling |
|---|---|---|
| maxPages | 2 | 5 |
| maxRecords | 40 | 200 |
| maxResponseBytes | 512 KiB | 2 MiB |
| timeoutMs | 10 000 | 20 000 |
| lookbackMs | 24 h | 7 d |
| maxRetries | 0 | 0 |

Stop reasons: `MAX_PAGES`, `MAX_RECORDS`, `LOOKBACK_REACHED`, `END_OF_TIMELINE`,
`PAGINATION_CURSOR_UNUSABLE`. No recursive discovery, no daemon, no "fetch everything".

## 8. Credential handling

None required: the endpoint is anonymous. The adapter has no credential input, reads no
environment variable, sends no `Authorization`/cookie, and stores nothing secret. If an
instance demands authentication the run stops with `PROVIDER_AUTH_REQUIRED`. Defense in
depth: any provider record containing a credential-shaped key (`access_token`, `cookie`,
`api_key`, `private_key`, …, at any depth, case/punctuation-insensitive) or credential-shaped
text (bearer tokens, PEM private keys, JWTs, `api_key=…`, base58 runs ≥ 64 chars) is refused.
Refusals report the class, never the value.

## 9. Privacy exclusions

Never carried: account handle, display name, bio, avatar/header, follower/following counts
and lists, mentions (`mentionedHandles` is always `[]`), media, polls, spoiler text,
application, geolocation/address fields, email/phone, cookies/tokens/keys. The only author
datum is the instance-namespaced numeric account id (`{host}:{id}`).

## 10. Timestamp mapping

- `publishedAt` ← `created_at`, strictly parsed (ISO-8601 with zone; calendar overflow such
  as Feb 31 refused). Malformed → `PROVIDER_TIMESTAMP_MALFORMED`. Absent → `null`; it is
  **never** replaced by `fetchedAt`.
- `observedAt` ← `null` (the provider does not supply it; the adapter does not invent it).
- `fetchedAt` ← supplied by the transport (the only clock read in 5K.2). The mapper never
  reads a clock.

## 11. Provider ID semantics

`provider = "mastodon:{host}"`, `providerObservationId = status.id` (required, digits only).
Status ids are per-instance, so the instance is part of the provider namespace: the same id
on two instances is two observations. Text is never an identity. Dedup is the unchanged 5K.1
`(provider, providerObservationId)` rule. `providerAuthorId = "{host}:{account.id}"` or `null`.

## 12. Mint extraction rule

`claimedMint` is set only when **exactly one** distinct, valid, case-exact base58 Solana mint
string appears in the post text. Zero → `null` (5K.1: `UNASSOCIATED`). Two or more distinct →
`null` (no guess between them), all listed in `candidateMintAddresses`; 5K.1 records `UNASSOCIATED` with reason `EXACT_CANDIDATES_PRESENT_BUT_NOT_CLAIMED`. Never inferred from
ticker, symbol, project name, username, hashtag, cashtag, URL slug or fuzzy match.
Cashtags and hashtags are recorded as text evidence only.

## 13. Error states

`PROVIDER_BOUNDS_INVALID`, `_HOST_INVALID`, `_QUERY_INVALID`, `_TIMEOUT`, `_NETWORK_ERROR`,
`_RATE_LIMITED`, `_SERVER_ERROR_5XX`, `_AUTH_REQUIRED`, `_CLIENT_ERROR_4XX`,
`_UNEXPECTED_CONTENT_TYPE`, `_RESPONSE_TOO_LARGE`, `_MALFORMED_RESPONSE`, `_RECORD_REFUSED`
(plus `PROVIDER_TIMESTAMP_MALFORMED`). Transport errors abort the run. A single refused
record is counted by reason and skipped; it is never repaired and never aborts good records.

## 14. Live smoke-test procedure

Explicit, never run by the validator, tiny (1 page, ≤ 5 records, 10 s):

```
node scripts/public-intelligence/providers/mastodon.mjs smoke
node scripts/public-intelligence/providers/mastodon.mjs smoke --host mastodon.social --hashtag solana
node scripts/public-intelligence/providers/mastodon.mjs smoke --out /tmp/evolve-5k2-smoke   # optional temp store
```

It prints redacted structure only (counts, stop reason, refusal reasons, ingest outcomes,
rate-limit remaining) — no text, URLs, ids or authors. Without `--out` nothing is persisted;
`--out` must not be under `.evolve`.

## 15. Non-goals

No second provider, no scheduler/daemon, no crawling, no authentication, no sentiment/score/
ranking/signal, no association heuristics, no storage under `.evolve`, no change to 5K.0.

## 16. Why no trading path exists

The adapter's import closure contains only 5K.2 modules, the 5K.1 ingestion boundary and 5K.0
governance. No engine, Arena, promotion, champion, wallet, signer, swap or RPC-write module
is reachable, and nothing outside `scripts/public-intelligence/` imports the adapter (checked
by AST in `validate-phase5k2.mjs`). Output carries the frozen 5K.0 classification, and
`profitabilityInferencePermitted` is `false`.

## 17. Known 5K.0 roadmap label mismatch

5K.0's `PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.roadmap` still labels the early phases with
names that predate the delivered scope (`5K.1` is listed as "Authority Benchmark"; 5K.1
actually delivered ingestion + provenance, and this phase, 5K.2, delivers the first
provider adapter). The frozen 5K.0 definition is **deliberately not edited** here; the
roadmap should be reconciled in a separate, explicitly governed 5K.0 revision.
