# Phase 5I-PS.2d — Cross-asset production opportunity shadow protocol

Research/evidence semantics: yes

DEVELOPMENT SHADOW • ZERO AUTHORITY. Paper only, shadow only, development evidence
only. PS.2d grants no trading, selection, evolution, Arena, deployment or
authority-promotion right to anything, and it is never canonical, replication or
temporal evidence. Protocol review is required before completion.

## Goal

PS.2b showed that SOL is present and tradeable almost continuously while every
production SOL genome evaluation fails `pool_too_old`, so no SOL production
opportunity ever reached the supervisor. PS.2c showed, in an isolated
counterfactual, that removing only that gate would admit many SOL evaluations;
that result is a reason NOT to weaken the gate. Phase 5I.1a (6 clean sessions)
established no replicated Jev directional advantage over neutral.

PS.2d answers one infrastructure question: can the existing passive supervisor
consume a bounded, deterministic, prospectively frozen sample of GENUINE EVOLVE
production entry proposals across assets, without changing production selection,
execution, genomes, fitness, evolution, the Arena, Jev direction evidence,
replication or temporal evidence? It does not ask whether Jev is profitable or
better than EVOLVE, emits no outcome-based winner, and never generalizes SOL
direction evidence to other assets.

## Architecture

Ordering: production decision/proposal finalized → copied immutable shadow facts
→ normal engine continues (paper execution attempt) → asynchronous supervisor
observes the copied facts. Nothing the supervisor returns is consumed by the
engine. The thirteen parts below are frozen before any live PS.2d run.

### 1. Genuine production opportunity (frozen boundary)

A PS.2d genuine production opportunity is exactly one call of a new passive
engine tap, `observeProductionEntry`, placed in `stepAgent`
(`scripts/engine/simulation.mjs`) after `ctx.bestScore = bestScore` and
immediately before `openPosition(agent, best, ctx)`. It can only fire when ALL of
the following untouched production facts hold for one flat agent on one tick:

1. the agent holds no position;
2. `ctx.allowNewEntries` is true (feed healthy and a non-empty scan);
3. the agent's research posture is not `ABSTAIN`;
4. the unchanged scan over `ctx.tradeable` evaluated every market with the
   unchanged `passesGates`;
5. `best` is the unchanged strict-`>` argmax of the unchanged `scoreMarket` over
   gate-passing markets;
6. `bestScore >= genome.entryScoreThreshold` (the unchanged production `>=`).

`openPosition` has exactly one caller, so every genuine opportunity corresponds
one-to-one to the existing PS.2 `ENTER_LONG`/`ENTRY_SIGNAL` execution proposal.
The proposal is final before the paper execution attempt, so entries later
blocked by paper sizing or fill rules remain genuine; the execution result is
neither part of eligibility nor part of the packet.

Explicitly NOT an opportunity: any exit (SIGNAL, STOP, TAKE, TIME, GEN-END,
STAGE-END); a market that was scored but not selected; a selection below the
threshold; any gate failure; a PS.2a SOL opportunity; a PS.2b funnel fact; a
PS.2c counterfactual pass; paused or abstaining agents; any fact injected by a
non-engine caller that fails the observer's genuineness validation.

The engine thunk copies only scalars, a fresh `assessGates(genome, best, ctx)`
result from the one shared production rule source, and a `structuredClone` of the
selected market. It adds no clock, random, id or asynchronous call; it is lazy,
wrapped in `try/catch`, runs only when an attached tap declares the method, and
its return value is discarded. The engine never names the consumer.

Observer genuineness validation (`validateGenuineProductionEntry`) requires:
source marker `PRODUCTION_ENTRY_PROPOSAL`, action `ENTER_LONG`, selection marker
`PRODUCTION_BEST_SCORE`, `gateAssessment.passes === true` with an empty
`failedGates` array, finite score and threshold with `score >= threshold`, a
market object, and NO key matching `counterfactual` anywhere in the facts (PS.2c
data can never feed PS.2d eligibility). Failures are counted by reason as
`nonGenuineRejected` and never become opportunities.

### 2. Prospective asset identity (no allowlist)

Identity is generic and derived from mints only: `baseMint` = selected market
mint, `quoteMint` = the USDC mint used as the USD numeraire (EVOLVE observes
Jupiter USD prices; this is the existing Phase 5I numeraire convention), and
`marketId = <baseMint>/<quoteMint>`. The symbol is descriptive only: it never
enters the identity, bounded variants are recorded per identity, and two mints
sharing a symbol are always separate assets. There is no allowlist, no SOL special
case, no performance- or outcome-based selection, and PS.2c data is never read.

### 3. Schema eligibility (frozen, pre-outcome only)

A genuine opportunity is schema-eligible only when every required frozen
pre-outcome field is present and well formed. Ineligibility reasons, checked in
this fixed order: `invalid_base_mint` (not a 32-44 character base58 string),
`base_equals_quote_numeraire`, `synthetic_market`, `market_not_fresh`,
`invalid_reference_price`, `invalid_liquidity`, `invalid_proposal_time`,
`missing_market_observed_at`, `observed_after_proposal` (lookahead guard:
`marketObservedAt > proposalAt`), `missing_agent_identity`,
`non_finite_feature`, `packet_audit_failed`, `packet_build_error`. `poolAgeMs`
and `topHoldersPercentage` are nullable exactly as production allows.

### 4. Generic packet `EVOLVE_CROSS_ASSET_PRODUCTION_PROPOSAL` v1

Built by `buildCrossAssetPacket` in `cross-asset-packet.mjs` from copied facts,
deep-frozen at capture. Sections: `packetVersion`, `packetKind`, `protocolId`,
`evidenceClassification`; `proposal` (action, source, selection, proposalAt,
generation, generationTick, agentId, species); `market` (marketId, baseMint, quoteMint,
symbol, referencePriceUsd, liquidityUsd, poolAgeMs, marketObservedAt,
marketStateAgeMs, priceChangePct, volume5mUsd, buySellRatio,
organicBuySellRatio, holderCount, topHoldersPercentage, verified,
mintAuthorityDisabled, freezeAuthorityDisabled); `production`
(productionScore, entryScoreThreshold, scoreMargin, thresholdComparison `>=`,
gates `{ allPassed, failedGates }`, eligibleMarketCount, tradeableMarketCount,
engineRegime, and the 17 whitelisted production scoring/gate features);
`limitations` (fixed strings). No microstructure, order book, L2 or L3 data is
fabricated; no execution result, future price, outcome, horizon or PS.2c field
exists. `capturedAt` (observer receipt time) and `lineageId`/`researchFamilyId`
are persisted on the observation record but are NOT model-visible, so packets
stay replay-deterministic. Every packet passes the existing
`auditJevDecisionPacket` plus a PS.2d key audit forbidding outcome, future,
forward, horizon, realized, pnl, profit, return, fill, execution and
counterfactual keys.

### 5. Complete input digest

`jevInputDigest = digestOf({ provider, model, questionSetId,
questionSetVersion, questions, packet })` — the COMPLETE frozen model-visible
payload plus the pinned provider/model identity. There is no partial-state
digest and no volatile-field exclusion. The packet contains only finite numbers,
strings, booleans, null, arrays and plain objects (validated), so canonical
serialization is unambiguous: byte-equivalent canonical packets reproduce the
digest and any model-visible change changes it.

### 6. Deterministic bounded sampling (`cross-asset-sampler.mjs`)

Applied to schema-eligible opportunities in engine encounter order at TICK
granularity. Within one tick (keyed by `generation` + `generationTick`) the
sampler runs in ascending complete-input digest order, NOT population order:
after every generation the engine's population array is fitness-ranked (elites
first), so raw population order would let past fitness decide which same-tick
proposal wins a per-asset cooldown or the last global-cap slots. The observer
buffers exactly one tick and samples it when the next tick starts, when the
PS.2d worker loop runs (only possible between synchronous engine ticks), or at
finalization, so decisions never depend on flush timing. A defensive 4096-entry
tick bound (the engine produces at most one entry per agent per tick and the
population is clamped to 512) would force an early flush; that is counted and
reported as `withinTickOrderGuaranteed: false`, never hidden. No randomness, no
score/performance/outcome/Jev input. Precedence, first match wins:

1. `suppressedDuplicateDigest` — digest equals an already admitted digest (a
   structural safety rule: the packet carries agentId and tick, so the engine
   itself cannot produce a duplicate and this counter is expected to stay 0);
2. `suppressedPerAssetCap` — the asset already has the per-asset maximum admitted;
3. `suppressedAssetCooldown` — `proposalAt - lastAdmittedAt(asset)` is below the
   per-asset minimum spacing (engine time, not wall clock);
4. `suppressedGlobalCap` — the run already has the global maximum admitted;
5. otherwise ADMITTED.

The first eligible opportunity of an asset is admitted unless the global cap is
already reached. Per-asset state depends only on that asset's own admissions, so
asset A can suppress asset B only through the explicit global cap.

Frozen constants (one module, `cross-asset-protocol.mjs`):

- per-asset maximum Jev calls per run: 10
- per-asset minimum observation spacing: 60 seconds
- profile `canary`: global maximum 20 Jev calls per run (infrastructure only)
- profile `full`: global maximum 120 Jev calls per run
- queue capacity equals the profile global maximum (admission is never lost to a
  full queue in the CLI profiles)
- offline validation profile (not CLI-selectable): global maximum 8, queue
  capacity 2, used only to prove queue-full safety

These are development bounds, not tuned trading parameters, and are frozen
before any live PS.2d run.

### 7. Question and typed response contract

The existing question set (`jev-microstructure-direction-v1`) is intrinsically
SOL/USDC and is not reused or modified. New set
`jev-cross-asset-production-proposal-v1` v1, one `noul` question
`productionProposalSupported`: do the supplied frozen pre-outcome facts support
EVOLVE's production proposal to open a long PAPER position in the identified
asset at the frozen reference price?

Typed response: exactly one answer named `productionProposalSupported`, type
`noul`, finite probability `pSupport` in `[0, 1]`. Anything else (missing,
extra names, wrong type, non-finite, out of range, provider failure) is a
recorded failure and never a stance. Stance, exact comparisons without tolerance:
`SUPPORTS_PROPOSAL` (p > 0.5), `DOES_NOT_SUPPORT_PROPOSAL` (p < 0.5),
`EXACTLY_HALF` (p === 0.5). Stance is Jev's report about the frozen facts only:
it is not correctness, not an outcome, not agreement-as-truth and not a signal.
The packet deliberately contains EVOLVE's own proposal, so PS.2d responses are
anchored by design and are not comparable with PS.2 / PS.2a / 5I direction
evidence.

### 8. Evidence classification

`DEVELOPMENT_CROSS_ASSET_SUPERVISOR_SHADOW` with `developmentOnly`, `paperOnly`,
`shadowOnly`, `noProfitabilityInference`, `noTradingInference`,
`noDeploymentInference`, `noAuthorityPromotion` all true and `canonicalEvidence`,
`replicationEvidence`, `temporalReplicationEvidence` all false. No
`CLEAN_JEV_DIRECTION_*` classification is used.

### 9. External-call policy (Governance v1)

Evidence-bearing shadow: provider `typesafe-jev` (direct, gateway refused), model
`jev-1.13.0`, timeout 20000 ms, transport attempts 2 (retryCap 1, transient
failures only; malformed output is never retried). The complete transport policy
(`PS2D_TRANSPORT_SETTINGS`: attempts 2, backoff 1000-10000 ms, transport cooldown
60000-900000 ms) is spread AFTER the environment configuration, so no
`EVOLVE_JEV_*` variable can change it; worst case per logical call is
2 × 20000 ms + the transport's 60000 ms Retry-After ceiling. maxCallsPerRun = profile
global maximum, fallback `none`, failClosed true, no provider cache (every typed
response is persisted with its complete-input digest for replay), authority
`SHADOW`, circuit breaker 5 consecutive failures then 300000 ms open (items
dequeued while open are recorded `SKIPPED_CIRCUIT_OPEN`, no call; one half-open
probe after the cooldown). A transport provider-health cooldown answer makes no
network request, so it is recorded `SKIPPED_TRANSPORT_COOLDOWN`: not a Jev call,
not a failure, and never fed to the PS.2d breaker. usage fields
recorded per judgment as the cost-accounting hook (pricing unknown). The CLI
builds a dedicated PS.2d provider instance with an empty transport chain and a
separate provider-health directory. The CLI validates the policy with the
Governance v1 validator before any artifact or provider exists (refusal = exit 2),
and the observer re-checks a fail-closed policy self-check and the pins before
every call (`SKIPPED_POLICY_INVALID` / `SKIPPED_PIN_MISMATCH`, no call). A PS.2d-only run budget equal to the profile maximum is enforced as a
second ceiling.

### 10. Queue and worker

A separate bounded queue (`createBoundedObserverQueue`) with depth, high-water,
drop and failure counters. The engine never awaits it. A DEDICATED PS.2d worker
loop drains it sequentially, so a slow PS.2d call can never delay, or cause queue
drops in, the PS.2 / PS.2a observer work. Final flush policy: at finalize the tap stops admitting;
an in-flight call is awaited only up to the existing bounded finalize timeout
(then counted `inFlightAtFinalize`, its late answer ignored, and
`session.json` `finalizeTimedOut` set — that flag was previously always false
because it read `running` after it had been cleared); still-queued items are
drained WITHOUT a Jev call and recorded `UNSENT_AT_FINALIZE`.

### 11. Accounting and bounded storage

Counters: `productionEntryFactsReceived`, `nonGenuineRejected` (by reason),
`genuineProductionOpportunitiesObserved`, `schemaEligible`, `schemaIneligible`
(by reason), `uniqueAssetsObserved`, `callsEligibleBeforeBounds`, the four
suppression counters, `admittedBySampler`, `queuedForJev`, `queueDropped`,
`jevCalls`, `jevOk`, `jevFailures`, `skippedPinMismatch`, `skippedCircuitOpen`,
`unsentAtFinalize`, `inFlightAtFinalize`, and stance counts. Identities:

- received = nonGenuineRejected + genuine + buffered (not-yet-sampled tick) +
  tapErrorsUnaccounted
- genuine = schemaEligible + schemaIneligible
- callsEligibleBeforeBounds = schemaEligible = four suppressions + admitted
- admitted = queuedForJev + queueDropped
- queuedForJev = processed + unsentAtFinalize + queue depth + in-flight
- processed = jevCalls + skippedPinMismatch + skippedPolicyInvalid +
  skippedCircuitOpen + skippedTransportCooldown
- jevCalls = jevOk + jevFailures + inFlightAtFinalize

Per-asset rows (every genuine asset, never only the sent ones): marketId,
baseMint, quoteMint, symbol, bounded symbol variants, encounter ordinal, and all
of the counters above per asset. Rows are kept in ENCOUNTER order and never
ranked. At most 2048 assets are tracked in memory (overflow aggregated
explicitly); at most 128 rows are persisted, with `totalAssetCount`,
`rowsStored`, `rowsTruncated`, a `truncatedRowsAggregate` and an
`aggregateDigest` over every tracked row, so truncation is never silent.
Per-event storage is one NDJSON line per ADMITTED observation only
(`cross-asset-observations.ndjson`, at most the profile maximum lines).

### 12. Historical compatibility and dashboard

Historical PS.2, PS.2a, PS.2b and PS.2c sessions, including
`jsup-20260922T151045Z-063f35` and `jsup-20260923T042620Z-d1368a`, are never
rewritten. New fields (`crossAssetShadow`) appear only in new sessions; readers
treat absence as not-run. The existing supervisor panel gains a separate
`CROSS-ASSET PRODUCTION SHADOW` block labelled
`DEVELOPMENT SHADOW • ZERO AUTHORITY` with neutral counters and a bounded
encounter-order per-asset table (no green/red, no winner, no profitability).

### 13. Live run protocol (prepared, NOT executed in this phase)

CLI flag `--cross-asset canary|full` (absent = PS.2d disabled, prior behaviour).
Canary, infrastructure verification only, after separate authorization:
`npm run jev:supervisor -- --minutes 30 --cross-asset canary`.
Only if the canary infrastructure is clean:
`npm run jev:supervisor -- --minutes 60 --cross-asset full`.
Infrastructure defects may be fixed between them; the sampling, eligibility,
packet and question rules stay frozen, and nothing is tuned from canary results.

## Files / scope

- `scripts/jev/supervisor/PS2d.md`
- `scripts/jev/supervisor/cross-asset-protocol.mjs`
- `scripts/jev/supervisor/cross-asset-packet.mjs`
- `scripts/jev/supervisor/cross-asset-questions.mjs`
- `scripts/jev/supervisor/cross-asset-sampler.mjs`
- `scripts/jev/supervisor/cross-asset-observer.mjs`
- `scripts/jev/supervisor/observer.mjs`
- `scripts/jev/supervisor/summary.mjs`
- `scripts/jev/supervisor/storage.mjs`
- `scripts/jev/supervisor/dashboard.mjs`
- `scripts/jev/supervisor/definition.mjs`
- `scripts/jev/supervisor/settings.mjs`
- `scripts/jev-supervisor.mjs`
- `scripts/engine/simulation.mjs`
- `scripts/validate-phase5i-ps2d.mjs`
- `scripts/validate-phase5i-ps2.mjs`
- `package.json`
- `src/app/page.tsx`

`scripts/validate-phase5i-ps2.mjs` changes only its package-script assertion so
`validate:jev-supervisor` must run BOTH the PS.2 and the PS.2d suites.

Protected paths: `.evolve/jev-direction/`, `.evolve/jev-paper-shadow/`, `.evolve/jev-paper-forensics/`, `.evolve/jev-supervisor-observer/`, `.evolve/shadow/`, `.evolve/arenas/`

PS.2d declares no intended write to any protected path. Validation writes only to
temporary directories.

## Global Constraints

Global Constraints digest: d196aaaf46bd22e8a3e3ffb1f9fd2c3096b476426be7598aad492533da66eb94

1. PAPER ONLY unless a separately approved phase explicitly says otherwise.
2. No wallet, signer, swap, order, real-money or write-RPC functionality may be introduced by ordinary development work.
3. Canonical/replication/temporal evidence is immutable.
4. No lookahead.
5. No result-driven parameter tuning.
6. No profitability claim from development/shadow evidence.
7. No weakening of gates/tests/protocols to manufacture a positive result.
8. AI outputs cannot self-certify scientific validity.
9. Arena / untouched future data remains authoritative.
10. Experimental AI components remain shadow/passive until evidence explicitly justifies another authority level.
11. External AI/API calls must be bounded.
12. Failures must fail closed where evidence integrity is concerned.
13. Existing repo attribution must not be modified unless explicitly requested.
14. No AI assistant/co-author attribution.
15. No AGENTS.md or CLAUDE.md.

All fifteen canonical constraints of `scripts/governance/definition.mjs` apply.
PS.2d changes no gate, threshold, genome, score or selection rule, adds no
wallet/signer/swap/order/write-RPC capability, bounds every external call, and
makes no profitability claim.

## Review Focus

- Engine influence: any PS.2d value (tap return, thrown error, mutated copy,
  queue state, Jev response) reaching `best`, `bestScore`, market selection,
  `openPosition`, paper fills, positions, cash, equity, fitness, genomes,
  selection, births/deaths or generation transitions; any await, clock, random or
  id call added to the engine path.
- Opportunity boundary drift: an event that is not the finalized production
  entry proposal (exit, unselected scored market, below-threshold, gate failure,
  paused/abstaining agent, PS.2a/PS.2b/PS.2c fact) becoming PS.2d eligible, or a
  genuine entry silently excluded.
- PS.2c contamination: counterfactual gates, ignored `pool_too_old`, lowered
  thresholds or alternate scoring feeding eligibility, the packet or the digest.
- Incomplete input digest: any model-visible byte (packet, questions, model)
  not covered by `jevInputDigest`, or two different payloads sharing a digest,
  repeating the PS.2a partial-digest defect.
- Sampling bias: randomness, performance-, score-, outcome- or Jev-dependent
  sampling; wrong precedence; asset A suppressing asset B outside the global cap;
  wall-clock dependence; symbol collisions merging mints.
- Hidden lookahead or outcome leakage: future prices, execution results,
  horizons or forward returns entering the packet; market observations stamped
  after the proposal.
- Retroactive cherry-picking and silent truncation: persisting only sent assets,
  ranking assets, or truncating per-asset rows without counts and digest.
- External-call governance: fallback, gateway, cache reuse, unbounded retries,
  missing circuit breaker, malformed output becoming a stance, or calls beyond
  the profile cap.
- Historical mutation and SOL path drift: PS.2/PS.2a packet, question set or
  input digest behaviour changed; historical sessions rewritten or unreadable.
- Dashboard framing: winner, ranking, green/red or profitability presentation;
  missing `DEVELOPMENT SHADOW • ZERO AUTHORITY` label; any automatic authority
  promotion path.

## Verification

Dedicated validator: npm run validate:jev-supervisor

`scripts/validate-phase5i-ps2d.mjs` (run by `validate:jev-supervisor` after the
unchanged PS.2 suite) proves, fully offline with network denied: genuine
production proposal becomes eligible; PS.2c-shaped and counterfactual-carrying
facts, failed gates, below-threshold, non-production sources and exits are
rejected; digest changes for every model-visible leaf mutation and reproduces
for byte-identical canonical packets; duplicate, cooldown, per-asset cap and
global cap suppression with exact precedence; deterministic encounter order and
no randomness; asset independence outside the global cap; malformed schema
fails closed; symbol collision and symbol variation identity; no future,
outcome, execution or PS.2c keys in packets; engine equivalence (per-tick
population digest, engine digest, trades, positions, cash/equity, generation)
with the supervisor disabled, working, slow, throwing, malformed and queue-full;
Jev responses (p=0, p=1, malformed) cannot alter paper actions,
`best`/`bestScore`, selection, evolution or fitness; PS.2/PS.2a SOL packets,
question set and input digests unchanged with PS.2d enabled; historical sessions
readable and byte-identical; external policy validates with no fallback and
fails closed; bounded runtime writes; encounter-order per-asset rows with no
ranking and explicit truncation metadata; dashboard labels; no automatic
authority promotion.

Fresh commands: `npm run validate:governance`, `npm run validate:jev-supervisor`,
`npm run validate:jev-paper-forensics`, `npm run validate:jev-paper`,
`npm run validate:phase5i`, `npm run validate`, `npx tsc --noEmit`,
`npm run lint`, `npm run build -- --webpack`, `git diff --check`.

No live Jev, Jupiter, supervisor, Temporal or Paper Shadow run. No commit, no
push.
