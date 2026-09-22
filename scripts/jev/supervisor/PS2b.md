# Phase 5I-PS.2b — SOL opportunity funnel diagnostics

Diagnostic only. No thresholds, genomes, gates, asset scope, universe selection,
scan order, best/bestScore comparison, paper execution or evolution rules change.
No diagnostic facts enter Jev. Direct TypeSafe pins, PS.2a complete-input digest,
first actionable agent/generation capture and judgment reuse remain unchanged.

## Observation boundaries and storage

The optional synchronous engine tap emits copied scalar facts; its return value
is ignored and exceptions are contained. It adds no clock, random or ID calls.
A tick is observed after the existing `byMint` and capped `ctx.tradeable` are
constructed and before agents step. `flatAgentEntryScans` counts scans actually
reached after position, feed-health and abstention handling, including scans that
reject every candidate. It is not a count of all flat agents on paused ticks.

An evaluation occurs only when the existing scan visits wrapped SOL. Its gate
assessment uses the same ordered pure iterator as `passesGates`. The predicate
stops on the first failure, preserving original short-circuit behavior; diagnostic
assessment exhausts the iterator inside the protected observer call. Scoring and
threshold comparisons use the original score and genome threshold.

`solFunnel` is stored in existing session `state.json` and `summary.json`, also
available in observer snapshots and the existing `SOL OPPORTUNITY FUNNEL`
dashboard panel (which keeps `NO AUTHORITY • PAPER ONLY` prominent). Idle
workers publish state even if no opportunity or supported execution arrives, so
a funnel-only session is still observable; that publish goes through the same
bounded `SUPERVISOR_STATE_PUBLISH_INTERVAL_MS` throttle as every other publish.
No new root or per-tick/per-agent NDJSON is created. Recent presence and score
samples each retain at most 32 rows; species have a 64-label backstop plus OTHER.
The actual engine species vocabulary is smaller. Gate counts use the fixed gate
vocabulary.

Tick facts are recorded under the explicit presence vocabulary
`solObservedInUniverse`, `solPresentInTradeable`, `solFresh`, `solReferencePrice`
and `solLiquidity`, derived in one place from the same tick facts as the shorter
internal names (they cannot drift). Per-species rows carry evaluations, gate
passes/failures, above/below/exact threshold, pre-dedup candidates and captures.

## Frozen gate convention

Record **all evaluable failures plus firstFailedGate in original gate order**:

1. missing_features
2. market_not_fresh
3. invalid_price
4. invalid_liquidity
5. below_global_min_liquidity
6. liquidity_quality
7. organic_score
8. concentration_unknown
9. top_holder_concentration
10. mint_authority
11. freeze_authority
12. verification
13. pool_age_unknown
14. pool_too_young
15. pool_too_old
16. buy_pressure
17. momentum

Missing features stops assessment, matching the existing guard: downstream
feature failures are not invented. The existing authority OR is expanded into
its two component failure names, mint first; the trading predicate still stops
before reading freeze authority if mint authority fails. Null/undefined,
finite-number fallbacks, strict flag comparisons, age sentinel, contrarian
momentum and equality boundaries retain their original semantics. All-failure
counts can sum to more than failed evaluations. First-failure counts sum to the
failed evaluations when diagnostics are intact.

Stale, non-positive-price and non-positive-liquidity SOL normally never reach
agent gates because the existing tradeable filter already excludes them. Their
facts remain visible at tick level. No SOL is injected or pinned. Presence records
include `inByMint`, `inFeedUniverse` (separate raw feed-universe membership),
`inTradeable` (after the existing scan cap), freshness, reference price, liquidity
and entry permission. The dashboard's universe count means byMint ticks.

## Accounting

With diagnostics intact and finite original genome scores/thresholds:

- engineTicksObserved = ticksWithSolInTradeable + ticksWithoutSolInTradeable
- engineTicksObserved = ticksWithSolInByMint + ticksWithoutSolInByMint
- solAgentEvaluations = solPassesGates + solFailsGates
- solPassesGates = solScored = solAboveEntryThreshold + solBelowEntryThreshold
- solAboveEntryThreshold = scoreMarginZero + scoreMarginPositive
- solBelowEntryThreshold = scoreMarginNegative
- solExactlyEntryThreshold = scoreMarginZero (the equality subset, INSIDE above)
- solOpportunityCandidatesBeforeDedup = solAboveEntryThreshold
- candidates = captured + dedup suppressed, absent capture errors

Three counters are persisted under both a spec name and the canonical name used
internally; each alias is derived in `snapshot()` from its single canonical
counter, so no second accumulator exists and they are asserted equal:
`ticksWithSolObservedInUniverse` = `ticksWithSolInByMint`,
`ticksWithoutSolObservedInUniverse` = `ticksWithoutSolInByMint`, and
`opportunitiesSuppressedByAgentGenerationDedup` =
`solOpportunitySuppressedByAgentGenerationDedup`.

Above threshold includes equality, exactly as the existing `>=` opportunity test,
so equality is never classified as below and is never added a third time:
`solPassesGates` is the two-term sum above, not a three-term sum including
`solExactlyEntryThreshold`. Candidates count at scoring, before PS.2a dedup. Captured means a PS.2a draft was
successfully frozen and retained, not that Jev processed it or a fill occurred.
Subsequent queue loss is already exposed in the existing SOL queue-drop counters.
`solOpportunityCaptureErrors` records exceptions during capture. Invalid/missing
agent identity or generation can make PS.2a reject an external malformed caller;
normal engine agents have both. The existing engine feed supplies unique mints;
PS.2a's one-handle-per-scan guard still applies if a nonstandard caller supplies
duplicate SOL market rows. Observer hook failures can leave partial diagnostic
counts; they cannot affect trading. No accounting identity hides these limits.

`solNonFiniteScoreOrThreshold` explicitly counts scored evaluations excluded from
numeric aggregates/comparisons. `scoreMarket` already returns a finite value and
normal genome thresholds are finite. No diagnostic repairs or changes them.

## Scores and species

Full-stream sums, counts, means, extrema and negative/zero/positive margin counts
use original floating-point values. Recent samples preserve exact `solScore`,
`entryScoreThreshold`, and their subtraction `scoreMargin`.

Medians are explicitly **approximate** to keep memory/storage bounded. Each of
three fixed histograms spans [-2,2] with bin width 0.0001 (at most 40,001 occupied
bins), retaining count and observed min/max in each occupied bin. The estimate
uses the midrange of the central rank's bin, averaging the two central ranks for
an even population. Absolute error is at most 0.00005, apart from floating-point
roundoff; constant bins are exact. The method and error bound are persisted.
Normal score [-1,1], genome threshold [0.05,0.85] and margin [-1.85,0.95] domains
fit the histogram. Out-of-range values retain means/extrema but make that median
null and increment its explicit out-of-range count. Histograms themselves are
not serialized. No tuning or threshold recommendation is produced.

Species aggregate independently in encounter order: evaluations, gate passes and
failures, above/below threshold and captures, with no species ranking or advice.

## Proposal counters (future artifacts only)

- `totalExecutionProposalsObserved`: every execution proposal reaching the tap,
  before unsupported bypass or queueing, including blocked paper attempts.
- `executedTradeProposals`: legacy alias of that total; not a count of fills.
- `proposalsObserved`: retained legacy count of supported proposals processed by
  the asynchronous worker. It excludes bypassed unsupported traffic and drops.
- `unsupportedProposals`: total unsupported proposals, never queued for Jev.
- `unsupportedRecentSampleCount`: actual persisted bounded sample length. It is
  DERIVED as `unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE)`
  `.length`, never accumulated separately, so it always equals the stored array
  length. The sample bound is the existing `SUPERVISOR_MAX_UNSUPPORTED_SAMPLE`
  constant, used by the observer, the summary builder and the dashboard loader
  alike (no magic literal).

Old session artifacts are never rewritten.

## Offline proofs and future run

`npm run validate:jev-supervisor` includes a frozen pre-change gate oracle,
boundary/null/flag fixtures and 5,000 seeded cross-product fixtures; all gate
categories; absent/stale/tradeable SOL, including SOL present in `byMint` but
excluded from `ctx.tradeable` by the existing scan cap; below/equal/above
threshold; equality-is-actionable accounting; species and dedup accounting;
spec-name alias equality; the explicit presence vocabulary; malformed funnel
facts; bounded aggregates; persisted counter semantics including
`unsupportedRecentSampleCount === unsupportedRecentSample.length` against the
bounded-sample constant; a funnel-only session reaching the dashboard; exact
packet and input-digest comparison with/without diagnostic facts; and every-tick
engine snapshot/full-population equivalence under normal, throwing, delayed and
malformed observers/providers. Existing first-actionable and generation-reset
proofs remain. All fixture providers are local; network is denied by the
supervisor suite.

After separately authorizing a future live session, with existing direct TypeSafe
credentials/configuration: `npm run jev:supervisor -- --minutes 60`.
This implementation does not start that command.
