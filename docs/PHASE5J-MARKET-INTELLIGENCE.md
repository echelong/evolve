# Phase 5J — Multi-source market intelligence

EVOLVE remains PAPER ONLY. This phase records passive development research evidence.
It has no wallet, signer, transaction construction, write RPC, order submission,
copy trading or autonomous financial execution. No new feature enters production
entry gates, fitness, rankings, Arena decisions or research-swarm promotion.

## Architecture

`scripts/market-intelligence/` is separate from `scripts/market/`. The existing
Jupiter feed and normalization remain byte-for-byte unchanged. A caller may supply
its current `feed.markets()` array to `createIntelligenceRecorder`; it is copied
and never mutated. The standalone capture CLI instantiates that same feed in
live mode with synthetic fallback disabled. It does not create another Jupiter
client implementation or modify an engine process.
Running standalone intelligence capture beside the engine means two Jupiter
polling streams. An injected existing feed is reused without starting another
poll loop.

GMGN, native DexScreener HTTP and the launch observation interface join by Solana
**mint address**. Name, symbol and display labels never join records. DexScreener
retains individual pair address, DEX, base token and quote token; the base mint is
the canonical identity. A quote mint is not substituted for the base mint.

Normalization → timestamp/freshness checks → descriptive aggregation and
compatibility-aware disagreement → append-safe session storage. All values are
research evidence only. Engine replay consumption is deferred; canonical
serialization and digest fixtures establish deterministic evidence for later
observer replay. Existing historical datasets and PS.2e evidence are untouched.

## Providers and inspected references

Independent native implementations were based on these inspected interfaces;
no upstream code, CLI, MCP, trading bot or repository instructions were vendored.

- [GMGN source](https://github.com/GMGNAI/gmgn-skills), inspected tree
  `e742b4e83002a0caa7c818ab30466d34c57984bd`: OpenApiClient, token/market field
  references, authentication query format and request weights.
- [DexScreener reference client](https://github.com/vibeforge1111/dexscreener-cli-mcp-tool),
  tree `177295c5ad3704c8647ee3eb4a3e9598e9224e5f`: cache, limiter, bounded retries,
  malformed payload handling and pair endpoints. Runtime uses no Python CLI/MCP.
- [DexScreener public API](https://docs.dexscreener.com/api/reference): native
  `GET /token-pairs/v1/solana/{mint}`. Its pair-family budget is documented as
  300 requests/minute; this implementation stays far below that.
- [Launch listener reference](https://github.com/chainstacklabs/pumpfun-bonkfun-bot),
  tree `b7aae5e33387aeb28f276773e6a1720379b7688a`: universal logs listener,
  Pump.fun CreateEvent listener and listener limitations. Create/CreateV2 must be
  exact whole-line matches; program context and event discriminators must be
  verified, and CPI/version changes complicate decoding.

GMGN permits only six declared routes: GET `/v1/token/info`, `/v1/token/security`,
`/v1/token/pool_info`, `/v1/market/token_top_holders`,
`/v1/market/token_top_traders`, and observation POST `/v1/trenches`.
Trenches POST requests only the bounded `new_creation` section, with no scoring
filters. API-key-only authentication uses X-APIKEY, Unix-second timestamp and a
random client_id. No critical signing authentication is implemented. Key absence
is `DISABLED_NO_KEY`, not a fault. Top-holder/trader lists are bounded samples;
they are not total wallet-tag counts. Unknown payload shapes remain raw evidence
and do not invent normalized values. Token info uses nested `price`, `stat` and
`wallet_tags_stat`; Trenches uses its documented flat fields. Unverified new
Trenches response shapes fail closed rather than guessed parsing.

GMGN security, launch status, curve progress, migration pool, holder concentration,
creator/dev holdings, supplied tag counts, current market values and bounded
participant lists are collected. OHLCV, wallet activity, global labelled wallet
lists and near-completion/completed Trenches are intentionally deferred. They
would need separate request budgeting, sampling and temporal protocols.

**"smart money", "insider", "sniper", "bundler", "rug score" and similar terms
are third-party provider classifications, not EVOLVE ground truth.** Tag counts
retain `{provider: "gmgn", providerLabel: "smart_degen", count: ...}` provenance.
`rug_ratio` is a GMGN value, never an EVOLVE rug probability. There is no composite
alpha score, copied scanner score, recommendation or threshold gate.

DexScreener supplies raw USD price, liquidity, FDV, market cap, rolling m5/h1/h6/h24
volume, transaction buys/sells, price changes, pair creation time and embedded
boost/profile metadata. It does not poll separate boost/profile ranking feeds.

Launch observation is a **complete decoded-event interface with disabled live
transport**, not a running network detector. Both `pump_fun` and `lets_bonk`
fixtures are normalized. The current environment has no configured read-only
Solana RPC/WSS endpoint. Program layouts and endpoint completeness have not been
validated together. `start()` returns `DISABLED_UNVERIFIED_TRANSPORT`, `poll()`
returns only externally ingested decoded events (none without a verified producer), and health never claims subscription coverage. No invented
program IDs or launch events are generated. The interface includes start, stop,
poll, ingest, health and duplicate suppression. Allowed future subscription
methods are logsSubscribe/logsUnsubscribe only; no network subscription currently
occurs. Decoded events are not transaction constructors. No Shred or PumpPortal
path is included. Live launch transport and time-to-first-observation research
are deferred until verified read-only decoding is available.

## Evidence schema (version 1)

Every observation, snapshot and disagreement has `schemaVersion: 1` and:

```
evidenceClassification: DEVELOPMENT_MULTI_SOURCE_MARKET_INTELLIGENCE
developmentOnly: true
observerOnly: true
paperOnly: true
tradingAuthority: false
futureOutcomeIncluded: false
```

`market_observation` fields:

```
recordType, observedAt, capturedAt,
provider, providerVersion (null when unavailable), sourceEndpoint,
chain: solana, mint,
rawResponseDigest, normalizedPayloadDigest,
providerObservedAt, receivedAt, timestampBasis,
staleness: {ageMs, fresh, staleReason, budgetMs},
dataAvailability: {normalizedField: boolean}, limitations: string[], normalized
```

All envelope timestamps are Unix milliseconds. `normalizedPayloadDigest` hashes
only the normalized object. `rawResponseDigest` hashes the secret-redacted source
payload, not credentials or HTTP headers. Jupiter's source payload is the copied
normalized feed record, explicitly identified as such. Exact upstream server
update times are unavailable for GMGN/DexScreener; they use receipt time with a
recorded limitation, not a claim of historical timestamp precision.
The Jupiter adapter explicitly converts undefined optional data to null in a
separate plain-data copy, preserves array order, and rejects nonfinite numbers
and executable/non-data values. The original feed record is never changed.
Its `providerObservedAt` preserves the feed's request-start timestamp;
`receivedAt` is the first local Phase 5J copy and `capturedAt` is local capture.
For repeated reads of the same mint/endpoint/source state, the recorder retains
its first payload and receipt time instead of refreshing availability from
derived age fields/features. Newly available source fields create a new local
copy with a new receipt, even if the legacy feed timestamp is unchanged.
Exact upstream receipt/update timestamps are unavailable.

Snapshot staleness provenance is a sorted `sourceObservations` list. Each entry
retains chain, mint, provider, sourceEndpoint, providerObservedAt, receivedAt, capturedAt,
observedAt, normalizedPayloadDigest, rawResponseDigest and budgetMs, with a
canonical observationDigest covering all those fields. Repeated identical
payloads at different times or from different providers remain represented.
Snapshot normalizedPayloadDigest covers features, contributors and this list;
input permutations yield identical serialized evidence and digests.

GMGN normalized payload fields:

```
creatorAddress, marketVolumes, tradeActivity,
priceUsd, liquidityUsd, liquidityScope, marketCapUsd,
volume5mUsd, volumeWindowMs, volumeScope, holderCount,
topHolderPct, creatorHoldingPct, devHoldingPct,
rugRatio, rugRatioProvenance, honeypot,
mintAuthorityRenounced, freezeAuthorityRenounced, ownershipRenounced,
securityWarnings, walletTags, launchPlatform, launchPhase, createdAt,
bondingCurveProgress, onCurve, migratedPool, poolCreatedAt, participants
```

Market volume and trade-activity maps preserve supplied 5m/1h/6h/24h windows;
unavailable maps are null. Creator address is retained only when supplied in
`dev.creator_address`. Percent fields convert documented ratios to percentages. Participant items retain
address, holdingRatio and supplied providerTags. No missing field becomes zero.
Security warnings count only supplied provider flags; unavailable warnings stay
null. Trenches phase is its requested section label; token-info phase preserves
the provider's numeric status.

DexScreener normalized payload fields:

```
pairAddress, dexId, baseToken, quoteToken, priceUsd, liquidityUsd,
liquidityScope, fdvUsd, marketCapUsd, volumes, transactions, priceChanges,
volume5mUsd, volumeWindowMs, volumeScope, pairCreatedAt, boostsActive, profile
```

Window maps use `m5`, `h1`, `h6`, `h24`. Tokens retain address/symbol/name. Profile
contains only an available image URL. Unknown and missing fields remain null.

Launch payload:

```
schemaVersion, observedAt, chain: solana, platform: pump_fun|lets_bonk,
mint, transactionSignature, slot, sourceKind: logs|blocks|geyser|other,
programId, creator, metadata: {name, symbol, uri}|null, rawDigest
```

Its enclosing market observation supplies all evidence flags, provenance and
freshness. Optional fields are null unless genuinely supplied by a verified
read-only decoder. Duplicate identity is platform + mint + signature + slot.
Pending decoded events are bounded to 128 and drained once by `poll()`.
After 10,000 remembered identities, ingestion fails closed instead of evicting
identities and recounting duplicates.

`intelligence_snapshot` retains `observedAt`, `capturedAt`, chain/mint, provider
`multi-source`, endpoint `aggregate`, version null, a combined source-response
digest, per-source staleness timestamps/budgets, limitations, exact features,
per-feature contributors, dataAvailability, sorted sourceDigests and a digest of
`{features, contributors}`. Every contributing value identifies its source time,
endpoint and raw/normalized digests. Cross-source features point to the separately
persisted disagreement digest. No source record is rewritten as time advances.

`disagreement` records carry the same evidence flags, chain/mint, observation and
capture time, provider `multi-source`, endpoint `disagreement`, source-response
digest, availability/limitations, alignmentMs, source times, metrics and a digest
of those metrics. `sourceAgeSpreadMs` describes all recorded source timestamps;
value disagreements use only fresh, aligned contributors.

## Exact descriptive research features

```
launchAgeSeconds, launchPlatform, launchPhase,
gmgnSmartMoneyCount, gmgnKolCount, gmgnSniperCount, gmgnBundlerCount,
gmgnRatTraderCount, gmgnWhaleCount, gmgnCreatorHoldingPct,
gmgnRugRatio, gmgnSecurityWarningCount,
dexLiquidityUsd, dexVolume5mUsd, dexVolume1hUsd, dexBuys5m, dexSells5m,
dexBuyPressure5m, dexPriceChange5m, dexPriceChange1h, dexPairAgeSeconds,
crossSourcePriceRangeBps, crossSourceLiquidityRatio, crossSourceAgeSpreadMs,
crossSourceCount, crossSourceFreshCount
```

DEX buy pressure is buys/(buys+sells), available only when both counts exist and
the sum is positive. All DEX features use one deterministic selected pair, never
mixing metrics from different pairs. Launch age derives only from a known
creation/event timestamp at or before observation time. GMGN tag counts are
provider classifications; their prefix is deliberate.

## Alignment, staleness and disagreement

Defaults: Jupiter 60s, GMGN 90s, DexScreener 60s, launch events 300s. They are
independent budgets, stored in each record. Cache hits preserve original receipt
and source times. Aggregation recomputes freshness at the snapshot time.
Stale sources remain evidence but do not contribute feature values.

Alignment defaults to 15s relative to the freshest available source. One
observation per provider is selected deterministically by timestamp, pair
liquidity and digest; multiple DexScreener pairs never count as independent sources.
Selection is independent for each metric: unavailable price does not remove
valid liquidity, volume or holder evidence. Cross-source age spread selects one
fresh aligned observation per provider and is unavailable with fewer than two
distinct providers.
Missing sources mean missing evidence, not zero-valued measurements.

Disagreement metrics:

```
sourceCount, freshSourceCount, alignedSourceCount,
priceMedianUsd, priceRangeBps, priceMaxDeviationBps,
liquidityComparable, liquidityMedianUsd, liquidityMaxRatio, liquidityReason,
volumeComparable, volumeDisagreementRatio, volumeReason,
holderCountRange, poolAgeComparable, poolAgeReason, sourceAgeSpreadMs,
contributors: {price, liquidity, volume, holders, age}
```

Price range is (max-min)/median × 10,000; max deviation is maximum absolute
movement from the median divided by median × 10,000. Positive prices from at
least two providers are required. Ratios require positive minima.
Liquidity and volume comparisons require matching scopes. Volume additionally
requires matching windows. Jupiter token aggregates, GMGN biggest-pool liquidity
and a specific DEX pair are materially different scopes: these comparisons stay
incomparable by default. Compatible injected observations are tested. First-pool
age versus selected-pair age remains explicitly incomparable. No 5m-to-24h
comparison or historical holder backfill is permitted.

## No-lookahead

`providerObservedAt <= receivedAt <= capturedAt <= observedAt` is enforced at normalization.
Aggregation/disagreement reject records whose provider, receipt, capture or observation
time exceeds consumption time. Future launch/pair-creation timestamps are
unavailable. Receipt is the earliest time a current response may later be used;
current data is never assigned to an earlier market time. No candle endpoints
are called, so no completed candle can be presented at candle start. Unknown
historical alignment is null, never imputed.

## Storage and deterministic evidence

```
.evolve/market-intelligence/sessions/<timestamp-uuid>/
  session.json
  raw/jupiter.ndjson
  raw/gmgn.ndjson
  raw/dexscreener.ndjson
  raw/launch-events.ndjson
  normalized.ndjson
  disagreement.ndjson
  errors.ndjson
  summary.json
  manifest.json
```

Raw envelopes include timestamp, provider/version, endpoint/type, request identity,
chain/mint, raw digest, normalized digest when available, evidence flags,
availability, limitations, staleness and bounded payload. Responses with no
normalized records have an explicit unavailable-normalization flag. Error records
contain only bounded safe codes, provider and observation time with evidence flags.
No failed HTTP response bodies or credential-bearing request URLs are persisted.

Raw HTTP responses and individual raw records are bounded to 256 KiB; session
appends are bounded to 64 MiB, reserving 16 KiB for finalization. Final summary and
manifest each have an 8 KiB limit. Cache capacity is 256 entries/provider, retained
mint/endpoint identities 10,000, remembered duplicate launches 10,000. Old stale
in-memory observations expire; persisted evidence never changes.
Jupiter first-copy receipts are independently capped at 10,000 mint/endpoint
identities and fail closed at capacity. GMGN route cursors are capped by the
10,000-mint eligible universe, with inactive mints removed. GMGN has an independent
mint cursor and per-mint five-route rotation; one request slot is reserved for
Trenches. A budget of one therefore collects Trenches only. Stable eligible
universes with a token-route budget eventually receive all five routes regardless
of factors shared by universe size, route count or request budget.

Session creation is exclusive. Existing sessions cannot be reopened, and finalized
storage rejects appends/finalization. Provider filenames use a fixed mapping;
unknown providers, traversal and absolute path inputs are rejected. Every write
checks ancestors through its destination, including sessions and raw directories,
and rejects symlinks. File opens use O_NOFOLLOW where supported and verify regular
file identity; append opens do not create missing/replaced files. NDJSON
appends use O_APPEND, complete writes and fsync. Summary/manifest finalization uses
exclusive temporary files and atomic renames. A process crash may leave an
unfinished session; it is never silently resumed or treated as finalized evidence.
Normal Ctrl+C/SIGTERM waits for the bounded in-flight capture, stops and finalizes.
Capture/storage failures finalize with status `incomplete` and return nonzero.

Manifest includes file/record/provider/error counts, first/last recorded observation
time, unique mint count, capture metrics, health and SHA-256 hashes of session,
raw, normalized, disagreement, error and summary files. The combined fingerprint
is SHA-256 of the canonical sorted file-hash map. Canonical JSON recursively sorts
object keys, preserves array order and rejects nonfinite/undefined values. The
manifest does not hash itself. Fixtures prove identical evidence yields identical
hashes and fingerprints across separate directories.

## Network, secrets, health and rate limits

Exact HTTPS origins, methods and paths are validated both by provider declarations
and the transport. Redirects are rejected. GMGN paths cannot reach trade/cooking
routes; DexScreener permits only GET token pairs. There is no arbitrary URL API.
Single in-flight request per provider and 1.2s minimum spacing enforce bounded
concurrency. Default cycle budgets are six requests/provider every 30s. One GMGN
request is reserved for Trenches; remaining per-mint routes rotate across info,
security, pool, holders and traders. Candidate cohorts rotate by mint. This is
bounded sampling, not complete coverage. Actual collection cadence may exceed the
poll period when requests are slow.

GMGN documents weighted free-tier buckets (info/security/pool weight 1;
holders/traders weight 5). Conservative spacing does not promise a provider plan's
availability. A 429 sets at least 60s cooldown, respecting longer Retry-After
seconds/date and GMGN X-RateLimit-Reset. No immediate retry loop runs during
cooldown. Other failures use exponential 2s–256s cooldown, capped at 300s.
Cache defaults to 30s, retaining observation times. Request timeout defaults to
8s including bounded body streaming. Safe counters include requests, errors,
cache hits, throttling, concurrency limit and cooldown. Provider errors are
recorded independently; another provider or the engine is not stopped.

`EVOLVE_GMGN_API_KEY` takes precedence over optional `GMGN_API_KEY` using the
existing non-overriding `.env.local`/`.env` loader policy. API key and redaction
secrets are non-enumerable frozen properties. Headers and auth query values are
never logged or persisted. Credential-shaped fields and configured secret values
are removed/redacted recursively before raw normalization/persistence. Exceptions
are reduced to safe fixed codes. No signing credential is loaded or requested.

Read-only settings are in `.env.example`: GMGN enabled/key/base URL/timeout/poll/
request budget/cache/stale; DexScreener enabled/timeout/poll/budget/cache/stale;
Jupiter observer freshness, alignment and launch freshness. The GMGN base setting
accepts only the exact official origin, not arbitrary endpoints. No RPC/WSS setting
is needed until direct launch transport exists, and no wallet setting exists.

## CLI and dashboard

```
npm run intelligence:market -- doctor
npm run intelligence:market -- probe
npm run intelligence:market -- capture --minutes 30
npm run intelligence:market -- summary
npm run validate:phase5j
```

Capture runs beside EVOLVE, not as an engine gate. It prints one moving progress
line with elapsed time, mint/provider counts, launch events, aligned fresh joins
and errors; Ctrl+C finalizes. No terminal takeover or shell exit helper is used.
Probe issues one small Solana DexScreener query; GMGN token info runs only when
an API key already exists. Missing GMGN key is explicitly reported as skipped.
Disabled launch transport produces no probe events.

The separate `/api/market-intelligence` route supplies only finite numeric summary
fields and allowlisted provider health enums. The development observer panel
shows the latest **finalized** session, its timestamp, health/counts and maximum
aligned price disagreement. It verifies the summary hash against the finalized manifest and displays complete
or incomplete capture status. It never claims real-time live health from a
finalized session and never exposes raw payloads, participants, URLs or secrets.
It has no action/recommendation controls and does not change existing state APIs.

## Validation and deferred scientific work

`validate:phase5j` is offline and uses deterministic injected HTTP fixtures,
independently authored payloads, temporary storage and syntax-tree capability
checks. It covers the 35 required contracts plus provider-budget/timeout/origin,
UI summary, receipt-cache, zero/missing, deterministic contributor and
immutable-session edge cases. It is included in full validation only after its
own suite passed. Existing market/replay/engine/Arena/JEV validations remain intact.
The remediation extends the suite from 42 to 63 tests: genuine feed/universe
missing-field and delayed-response fixtures, eventual coverage for eight universe
sizes and four request budgets, path/symlink/prior-session adversaries, repeated
payload permutations, independent metric eligibility and cross-provider age
selection. Actual manifest files are re-hashed directly with node:crypto and
their fingerprint and line counts independently checked. Tests write only to
temporary directories, never existing observation/evidence sessions.

No R1–R6 question is answered by implementation. Future experiments may test:

1. Launch platform/age beyond Jupiter first-pool age (R1).
2. Provider-labelled sniper/bundler/rat-trader concentrations versus later paper
   outcomes (R2).
3. Holder structure beyond Jupiter holderDistribution (R3).
4. Cross-source price/liquidity disagreement and unstable market states (R4).
5. Provider-labelled smart-money participation after controlling for momentum,
   liquidity and organic flow (R5).
6. Direct launch detection versus time-to-first-observation (R6), after transport
   verification and completeness measurement.

Recommended first protocol: precommit R4's aligned price-disagreement bins and
sampling/availability criteria, collect a passive fixed-duration cohort, then
join later immutable paper outcomes by mint and time in a separate research
session. Control for liquidity, momentum, organic flow, source staleness and
coverage. No new gate or fitness change follows without separate evidence review.

## Build compatibility note

The sealed baseline reproduced a Turbopack failure when the existing Phase 5E
CLI install path was treated as a bundled directory asset containing an external
Python symlink. The config now constructs the exact same cross-platform path as
a runtime string. Its value is regression-tested; no tool installation, Local
JEV configuration or build command changes. The observer dashboard reads
finalized evidence at runtime, with explicit tracing exclusions on those dynamic
filesystem reads so captured evidence is not packaged as dashboard build assets.
Existing dynamic-filesystem build warnings and four existing lint warnings are
reported separately from Phase 5J validation failures.
