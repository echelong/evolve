# Phase 5I-PS.2c — SOL age-gate counterfactual diagnostic

Research/evidence semantics: yes

DIAGNOSTIC COUNTERFACTUAL • NOT A TRADING RULE. Observer-only, paper-only,
development evidence only. It changes no engine decision and grants no authority.

## Goal

The completed PS.2b session `jsup-20260922T151045Z-063f35` showed 54,202 SOL
genome evaluations, all failing `pool_too_old` (20,531 also `buy_pressure`,
14,378 also `momentum`), zero scores and zero Jev calls. PS.2c answers one
descriptive question: if ONLY the `pool_too_old` failure were ignored for
diagnostic purposes, how often would the existing genomes otherwise consider SOL
eligible, and how often would the existing `scoreMarket` reach the existing
`entryScoreThreshold` (`>=`)? It is not a recommendation to remove or change the
gate and never feeds EVOLVE or Jev.

## Architecture

1. Engine (`scripts/engine/simulation.mjs`). `passesGates`, `failedGateReasons`,
   `assessGates`, `scoreMarket`, the scan loop, `best`/`bestScore` and every
   threshold are unchanged. A new exported pure helper
   `assessPoolAgeCounterfactual(genome, market, options)` calls the existing
   shared `assessGates` once, copies its failure list, removes ONLY the
   `pool_too_old` entry (constant `POOL_TOO_OLD_GATE`), preserves every other
   failure in original order, and calls the existing `scoreMarket(genome, market)`
   only when the remaining counterfactual failure list is empty. It returns
   copied scalars and string arrays only. It is not a gate predicate and nothing
   in the engine reads its result.
2. Engine tap. Inside the existing SOL-only branch of the scan loop, after the
   PS.2b `evaluation` fact, a separate `observeSolFunnel("age_counterfactual", …)`
   call runs the helper inside the existing protected `observeSolFunnel` wrapper
   (null tap / non-SOL returns immediately; exceptions swallowed; return value
   discarded). A separate call keeps the PS.2b `evaluation` fact byte-identical
   and isolates a PS.2c failure from PS.2b counters.
3. Observer (`scripts/jev/supervisor/observer.mjs`). `observeSolFunnel` routes
   `kind === "age_counterfactual"` to a new aggregator and every other kind to the
   unchanged PS.2b funnel. The new snapshot is stored as a separate
   `solAgeCounterfactual` field in observer snapshots, `state.json` and
   `summary.json` (future artifacts only). Nothing is added to `solFunnel`, the
   PS.2a opportunity path, the Jev queue, the Jev packet or `jevInputDigest`.
4. Aggregator (`scripts/jev/supervisor/sol-age-counterfactual.mjs`). Re-derives
   the counterfactual failure set itself from the copied `failedGates`
   (removing only `pool_too_old`), ignores any supplied score when failures
   remain, validates types, and counts malformed facts instead of throwing.
   Reuses the PS.2b bounded histogram (`distribution`, now exported unchanged
   from `sol-funnel.mjs`) for approximate medians with the same persisted method
   and error bound.
5. Dashboard (`scripts/jev/supervisor/dashboard.mjs`, `src/app/page.tsx`). The
   loader forwards `solAgeCounterfactual`; the existing supervisor panel gains a
   `SOL AGE-GATE COUNTERFACTUAL` block labelled
   `DIAGNOSTIC COUNTERFACTUAL • NOT A TRADING RULE`, showing evaluations,
   age-only failures, still blocked without age, would pass remaining gates,
   would be above threshold, would be below threshold. It never uses the words
   opportunity or trade for these values and makes no recommendation.

Counters (full stream; `R` = failedGates minus `pool_too_old`):

- `solAgeCounterfactualEvaluations` — every SOL genome evaluation observed.
- `solProductionPassesGates`, `solFailsPoolTooOld`, `solFailsWithoutPoolTooOld`.
- `solFailsOnlyPoolTooOld` — failedGates is exactly `[pool_too_old]`.
- `solStillFailsWithoutPoolAge` — `R` non-empty. `solStillFailsBuyPressure`,
  `solStillFailsMomentum`, `solStillFailsOther` — marginal membership in `R`
  (an evaluation can be in several).
- `solPassesWithoutPoolAge` — `R` empty (= age-only failures + production passes).
- `solCounterfactualScored` (+ `…FromAgeOnly`, `…FromProductionPass`),
  `solCounterfactualAboveThreshold` (`>=`, includes equality),
  `solCounterfactualBelowThreshold`, `solCounterfactualExactlyThreshold`
  (equality subset inside above), `solCounterfactualNonFiniteScoreOrThreshold`.
- Mean/median/min/max score; mean/median threshold; mean/median/min/max margin.
- Exact overlaps among `pool_too_old` failures: `POOL_AGE_ONLY`,
  `POOL_AGE_PLUS_BUY_PRESSURE`, `POOL_AGE_PLUS_MOMENTUM`,
  `POOL_AGE_PLUS_BUY_PRESSURE_PLUS_MOMENTUM`, `POOL_AGE_PLUS_OTHER` (any other
  remaining gate present) — mutually exclusive, summing to `solFailsPoolTooOld`.
  Additionally `exactFailureCombinationCounts`, keyed by the full ordered
  failure list (`PASS` when empty), derived dynamically for every evaluation and
  bounded at 64 keys plus `OTHER_COMBINATION`; and `stillFailsGateCounts` per
  remaining gate.
- Species rows (sorted by label, never ranked): evaluations, failsOnlyPoolTooOld,
  stillFailsWithoutPoolAge, passesWithoutPoolAge, aboveThreshold, belowThreshold,
  exactThreshold. 64-label backstop plus OTHER.
- Bounded recent sample: at most 32 counterfactual-scored rows.
- `malformedFacts` count.

Disclosures: only the gate is ignored — the existing `scoreMarket` age term
(`ageWeight × ageYouth`) still applies. `pool_too_young` is a separate gate and is
kept, so a genome with min age above max age lands in `POOL_AGE_PLUS_OTHER`.
Pass/score/threshold counts include evaluations that already pass production
(split out by `…FromAgeOnly` / `…FromProductionPass`). Counts are per agent per
scan and autocorrelated. "Above threshold" does not mean SOL would be selected.

Identities (diagnostics intact): evaluations = passesWithoutPoolAge +
stillFailsWithoutPoolAge; evaluations = productionPasses + failsPoolTooOld +
failsWithoutPoolTooOld; sum(overlap buckets) = failsPoolTooOld;
passesWithoutPoolAge = failsOnlyPoolTooOld + productionPasses = scored;
scored = above + below + nonFinite; exact ⊆ above.

## Files / scope

- `scripts/engine/simulation.mjs`
- `scripts/jev/supervisor/sol-age-counterfactual.mjs`
- `scripts/jev/supervisor/sol-funnel.mjs`
- `scripts/jev/supervisor/observer.mjs`
- `scripts/jev/supervisor/summary.mjs`
- `scripts/jev/supervisor/dashboard.mjs`
- `scripts/jev/supervisor/PS2c.md`
- `scripts/validate-phase5i-ps2.mjs`
- `src/app/page.tsx`

Protected paths: `.evolve/jev-direction/`, `.evolve/jev-paper-shadow/`, `.evolve/jev-paper-forensics/`, `.evolve/jev-supervisor-observer/`, `.evolve/shadow/`, `.evolve/arenas/`

PS.2c declares no intended write to any protected path. In particular the
session `jsup-20260922T151045Z-063f35` under the supervisor root is preserved
byte-for-byte.

## Justified adjacent

These files were already staged (Governance v1 itself) before PS.2c started and
are not modified by PS.2c; they appear in the worktree diff against HEAD only.

- `README.md` — pre-existing staged Governance v1 change, untouched by PS.2c
- `package.json` — pre-existing staged Governance v1 change, untouched by PS.2c
- `docs/DEVELOPMENT-GOVERNANCE.md` — pre-existing staged Governance v1 file, untouched by PS.2c
- `scripts/evolve-governance.mjs` — pre-existing staged Governance v1 file, untouched by PS.2c
- `scripts/validate-governance.mjs` — pre-existing staged Governance v1 file, untouched by PS.2c
- `scripts/governance/*` — pre-existing staged Governance v1 files, untouched by PS.2c

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
PS.2c is PAPER ONLY, adds no wallet/signer/swap/order/write-RPC capability, adds
no external call, does not tune any parameter and makes no profitability claim.

## Review Focus

- Counterfactual feedback into the engine: any PS.2c value reaching `best`,
  `bestScore`, market selection, paper action, position, cash, equity, fitness,
  genome, selection, birth/death or generation transition.
- Production gate drift: `passesGates` short-circuit semantics, `pool_too_old`,
  max pool age, genomes or thresholds changed, or an alternate production gate
  predicate introduced.
- Jev contamination: a counterfactual pass creating a PS.2a opportunity, a Jev
  enqueue/call, a reused judgment, or altering the Jev packet or `jevInputDigest`.
- Overlap mis-accounting: removing more than `pool_too_old`, losing a non-age
  failure, non-exclusive or non-exhaustive overlap buckets, or equality
  classified below threshold.
- Scoring outside the counterfactual pass set: `scoreMarket` computed when a
  non-age failure remains, or a supplied score trusted despite remaining failures.
- PS.2b regression: `solFunnel` counters or the PS.2b `evaluation` fact changed.
- Artifact mutation: historical PS.2/PS.2a/PS.2b sessions, especially
  `jsup-20260922T151045Z-063f35`, rewritten; unbounded per-evaluation storage.
- Dashboard framing: counterfactual values presented as opportunities, trades or
  a recommendation to remove the gate.

## Verification

Dedicated validator: npm run validate:jev-supervisor

Required proofs in `scripts/validate-phase5i-ps2.mjs`: production
`pool_too_old` still rejects SOL; age-only becomes counterfactual pass; age plus
buy pressure, age plus momentum and age plus both remain failures; non-age
failures are never removed (every gate fixture); exact overlap buckets;
scoring only when remaining failures are empty; below / equal (`>=`) / above;
counterfactual pass creates no PS.2a opportunity and no Jev call; production
selection unchanged; observer off/on every-tick engine equivalence; throwing and
malformed PS.2c diagnostics cannot affect the engine; PS.2b funnel snapshot
unchanged; PS.2a packet and input digest unchanged; persisted state/summary carry
bounded aggregates; historical artifacts unchanged.

Fresh commands: `npm run validate:governance`, `npm run validate:jev-supervisor`,
`npm run validate:jev-paper-forensics`, `npm run validate:jev-paper`,
`npm run validate:phase5i`, `npm run validate`, `npx tsc --noEmit`,
`npm run lint`, `npm run build -- --webpack`, `git diff --check`.

No live TypeSafe, Jupiter, supervisor, Paper Shadow or Temporal run. No commit.
