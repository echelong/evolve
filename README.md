# EVOLVE

**Autonomous Evolutionary Markets**

EVOLVE is an experimental evolutionary trading-agent laboratory. A population of agents competes under identical market conditions, high-fitness genomes reproduce, weak agents are terminated, and mutations preserve exploration across generations.

> **Current status:** Phase 5A.3 — controlled, matched Research vs Conventional **A/B benchmarking**
> (on top of the Phase 5A.2 research-cohort correctness pass, the Phase 5A.1 integration correctness
> pass, and the Phase 5A controlled research swarm), on top of Phase 4's Champion Arena,
> regime/stress testing, and Live Shadow League, on top of Phase 3's historical capture, deterministic
> replay, and walk-forward evolution. The repository contains no wallet keys, no signer, and no
> transaction path. It cannot spend real SOL because that capability does not exist in it.

Every monetary number the system produces is **PAPER P&L**. Simulated returns are not real profits.
Historical backtests and paper results **do not** guarantee future profitability.

## What works

- 48 / 96 / 192 (or arbitrary) continuously running paper agents across six strategy species
- Soft, diversity-protected strategy islands (evidence-weighted, floored/capped, exact global population)
- Individual trading genomes with species-specific signal specialisation
- Live Solana market observations from the Jupiter Developer Platform (Tokens V2)
- Explicit `auto` / `live` / `synthetic` / `replay` market modes with honest labels
- Rolling, deduplicated token universe (by mint), bounded and TTL-evicted
- Market feed health: staleness, backoff, error and rate-limit counters
- Simulated fills with fees, minimum slippage, liquidity-dependent slippage, and an adverse buffer
- Fitness measured **net** of simulated costs (gross vs net P&L both reported)
- Fitness-based natural selection: elitism, crossover, mutation, random immigrants
- Birth / death / generation / market event stream
- Normalized starting capital each generation
- Historical market recorder producing timestamped NDJSON datasets
- Deterministic, accelerated replay of recorded datasets through the same engine
- Walk-forward evolution with hard TRAIN → VALIDATE → TEST separation and no look-ahead
- Robustness scoring, minimum-evidence gates, and a champion genome archive
- Baselines (no-trade, random, momentum, buy-and-hold-like) under identical friction
- Multi-seed evaluation with median/mean/worst aggregation, species survival analysis, genealogy
- Dashboard polling the engine once per second, with isolated live / replay state
- Champion Arena: large-scale tournament with regime/stress testing and a transparent Arena Score
- Live Shadow League: frozen Deployment Candidates paper-trading genuine current market data
- Validation suites, syntax sweep, offline engine, replay, and arena smoke runs
- Matched A/B Arena mode: equal-resource Research vs Conventional cohorts, no cloning, cohort/lineage
  attribution through evolution, cross-cohort crossover disabled, and a dedicated `ab-comparison.json`

## Run

```bash
npm install
npm run dev:all
```

Open <http://localhost:3000>.

The dashboard shows a permanently visible mode banner:

| Banner | Meaning |
| --- | --- |
| `LIVE SOLANA DATA • PAPER MONEY` | Real Jupiter observations are flowing and fresh. Paper entries are open. |
| `LIVE FEED DEGRADED • NEW ENTRIES PAUSED` | Forced live mode cannot currently see live data. New paper positions are blocked; existing ones are marked at their last observed price. |
| `SYNTHETIC MARKET • PAPER MONEY` | The internal simulator is active (requested, or explicitly fallen back to). Never labelled live. |
| `HISTORICAL REPLAY • PAPER MONEY` | A recorded dataset is being replayed. The numbers describe recorded paper observations, not the live market. |

Commands:

```bash
npm run engine          # paper engine only (writes .evolve/state.json)
npm run dev:all         # dashboard + engine together
npm run probe:market    # read-only Jupiter connectivity probe
npm run record:market   # capture normalized market snapshots into a dataset
npm run replay -- <dir> # replay a recorded dataset through the paper engine
npm run experiment -- <dir>  # walk-forward TRAIN/VALIDATE/TEST research run
npm run fixture:market  # write a small deterministic synthetic fixture dataset
npm run validate         # syntax + every phase validation suite + every smoke run
npm run validate:market  # Phase 2 behaviour checks (offline)
npm run validate:history # Phase 3 checks (offline)
npm run validate:arena   # Phase 4 arena/shadow checks (offline)
npm run validate:phase41 # Phase 4.1 correctness-pass checks (offline)
npm run validate:phase5a # Phase 5A + 5A.1 research-swarm checks (offline)
npm run validate:phase5a2# Phase 5A.2 research-cohort checks (offline)
npm run validate:phase5a3# Phase 5A.3 matched research-vs-conventional A/B checks (offline)
npm run validate:phase5b # Phase 5B DeepSeek-provider checks (offline, stub Cline)
npm run validate:phase5c # Phase 5C multi-dataset replication checks (offline)
npm run validate:phase5c2# Phase 5C.2 replication-wave checks (offline)
npm run datasets:research # Phase 5C dataset registry (classification, overlap, eligibility)
npm run replicate:research -- --cohorts  # inspect the frozen research cohorts (read-only)
npm run replicate:research -- --wave wave-2 --plan  # predeclared wave plan (zero Arena)
npm run smoke:engine     # deterministic synthetic-mode evolution smoke run
npm run smoke:replay     # offline record → replay → walk-forward smoke run
npm run smoke:arena      # tiny offline Champion Arena funnel
npm run smoke:swarm      # offline 192-agent island-divergence + swarm-state smoke run
```

## Market modes

`EVOLVE_MARKET_MODE` controls where observations come from.

**`auto` (default)** — try live. If live cannot be established (missing key, rejected key, network
failure, rate limits) or stops working, fall back to synthetic **explicitly**: the banner changes, an
event is logged, a reason is reported in the feed-health panel, and fallback data is never labelled
live. EVOLVE keeps probing live on a slow cadence and promotes itself back as soon as live
observations succeed again. Auto may use keyless Jupiter access (`EVOLVE_ALLOW_KEYLESS`) when no key
is configured.

**`live`** — require genuine live observations. If `JUPITER_API_KEY` is missing, requests fail, or
data becomes stale, the feed reports `LIVE FEED DEGRADED • NEW ENTRIES PAUSED` and new paper
positions are blocked. Live mode **never** silently switches to synthetic data. Existing simulated
positions retain their last observed price.

**`synthetic`** — the Phase 1 simulator only, clearly labelled synthetic. Works with no internet
connection and no API key.

**`replay`** — a recorded dataset is streamed through the identical engine. See
[Phase 3](#phase-3--historical-capture--deterministic-replay--walk-forward) below.

## Configuration

Copy `.env.example` to `.env.local` (gitignored). The engine loads `.env.local`, then `.env`, and
never overrides values already present in the real environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JUPITER_API_KEY` | _(empty)_ | Sent server-side only as an `x-api-key` header. Never exposed to the browser, logs, API responses, or git. Never `NEXT_PUBLIC_`. |
| `EVOLVE_MARKET_MODE` | `auto` | `auto` \| `live` \| `synthetic` |
| `EVOLVE_LIVE_STALE_MS` | `60000` | Live data older than this pauses new entries |
| `EVOLVE_MARKET_UNIVERSE_MAX` | `150` | Rolling universe size (unique mints) |
| `EVOLVE_PAPER_STARTING_CASH` | `100` | Normalized paper bankroll per agent, per generation |
| `EVOLVE_PAPER_BASE_FEE_BPS` | `10` | Simulated base trading cost |
| `EVOLVE_PAPER_MIN_SLIPPAGE_BPS` | `20` | Simulated minimum slippage per side |
| `EVOLVE_SEED` | `evolve` | Replay/experiment randomness seed |
| `EVOLVE_EVAL_SEEDS` | _(empty)_ | Comma-separated seeds for multi-seed evaluation |
| `EVOLVE_REPLAY_DATASET` | _(empty)_ | Dataset directory for `replay`/`experiment` |
| `EVOLVE_REPLAY_SPEED` | `1` | Replay pacing: `1`, `100`, or `max` (unthrottled) |
| `EVOLVE_WF_TRAIN_MINUTES` | `360` | TRAIN window length |
| `EVOLVE_WF_VALIDATE_MINUTES` | `120` | VALIDATE window length |
| `EVOLVE_WF_TEST_MINUTES` | `120` | TEST window length |
| `EVOLVE_WF_STEP_MINUTES` | `120` | Window step (walk-forward stride) |
| `EVOLVE_MIN_TRADES` | `20` | Minimum closed paper trades before champion status |
| `EVOLVE_MIN_DISTINCT_MINTS` | `4` | Minimum distinct token mints traded |
| `EVOLVE_MIN_OBSERVATIONS` | `200` | Minimum market observations |
| `EVOLVE_MIN_EXPOSURE_TICKS` | `40` | Minimum ticks exposed to the market |
| `EVOLVE_DASHBOARD_SOURCE` | `auto` | Which isolated state file the dashboard reads |

Additional tuning variables (`EVOLVE_JUPITER_*`, `EVOLVE_POPULATION`, `EVOLVE_GENERATION_TICKS`,
`EVOLVE_TICK_MS`, `EVOLVE_ALLOW_KEYLESS`, `EVOLVE_PAPER_SLIPPAGE_*`, `EVOLVE_MIN_LIQUIDITY_USD`,
`EVOLVE_RECORD_*`, `EVOLVE_HISTORY_ROOT`, `EVOLVE_CHAMPIONS_DIR`, `EVOLVE_EXPERIMENTS_DIR`,
`EVOLVE_MUTATION_SCALE`, `EVOLVE_CROSSOVER_RATE`, `EVOLVE_IMMIGRANT_RATE`, `EVOLVE_BASELINES_ENABLED`, …)
are documented inline in `.env.example`.

## Observation, not execution

EVOLVE reads market data and cannot place an order. There is no wallet key loading, no signing, no
transaction construction, no RPC write call, no swap endpoint, and no execution dependency — the
validation suite scans the entire codebase for those capabilities and fails the build of trust if any
appear.

Provider calls are read-only `GET` requests against Jupiter Tokens V2 market information:

- `/tokens/v2/recent` — freshly created first pools (recent means **recent pool creation**)
- `/tokens/v2/toporganicscore/5m?limit=100`
- `/tokens/v2/toptrending/5m?limit=100`

Each observation is normalized defensively: missing, null, string-typed, `NaN`, and `Infinity` fields
all collapse to safe values, and no non-finite number can reach agent state, P&L, the API, or the
dashboard. Failure classification (401/403, 429, 5xx, timeouts, network, unreadable payload) drives
exponential backoff with jitter so Jupiter is never hammered. The last valid snapshot is retained
while requests fail.

Normalized per-token fields include mint, name, symbol, icon, decimals, first-pool creation
timestamp, pool age, USD price, liquidity, market cap, FDV, holder count, top-holder concentration,
organic score and label, verified flag, tags, mint/freeze authority status, and 5-minute statistics
(price, liquidity, volume, holder change, buy/sell volume, organic buy/sell volume, buy/sell counts,
traders, organic buyers, net buyers).

## Agent signals and species

Agents decide from normalized features only, never from raw provider payloads:

token pool age · 5m price momentum · liquidity · liquidity change · market cap · organic score ·
holder count · top-holder concentration · buy/sell volume ratio · organic buy/sell ratio · trader
count · organic buyer count · net buyers · volume change · audit/authority flags.

Species specialise meaningfully:

| Species | Focus |
| --- | --- |
| Genesis Hunter | young pools, thin-but-real liquidity, organic score, rising buyer counts |
| Momentum | 5m momentum, volume expansion, buy pressure, liquidity |
| Reversal | negative momentum, surviving liquidity, improving flow (contrarian genome bit) |
| Wallet Flow | traders, organic buyers, net buyer imbalance, order flow |
| Liquidity | deep liquidity, safe authorities, low concentration, seasoned pools |
| Experimental | broad mutable combinations across the whole gene space |

None of these signals are claimed to predict profit. They exist so that natural selection has
heritable variation to work on.

## Paper execution

A trade creates an internal accounting event and nothing else:

- buys execute above, and sells below, the last observed price
- simulated slippage is `max(minimum, liquidity impact)`, capped
- a small adverse execution buffer applies to both sides
- fees are taken out of the filled quantity, so agent equity is net of costs by construction
- position sizing is capped by both bankroll fraction and a fraction of observed pool liquidity
- prices are only ever real observations: no tick is invented between observations
- when the live feed is stale, new entries are blocked and existing positions keep their last mark

Fitness is computed from net equity plus an explicit cost-drag penalty, so churning a paper account
into fee dust is selected against.

## Architecture

```text
Jupiter Tokens V2 (read-only GET)        synthetic simulator        recorded dataset (NDJSON)
        |                                       |                              |
        +--------------- market feed --------------------------+--------------+
                 mode: auto / live / synthetic / replay
                 universe: dedup by mint, TTL, bounded
                        |
             normalized market observations
                        |
                 feature stream
                        |
                 96-agent population
                        |
                  fitness engine (net)
                        |
                    selection
                  /     |      \
            elite  crossover  mutation
                        |
                 next generation
                        |
        state: state.json | replay-state.json | experiments/<id>/
                        |
                  Next.js API (sanitized, source-selectable)
                        |
                     dashboard
```

## Phase 3 — historical capture + deterministic replay + walk-forward

The question Phase 3 exists to answer is narrow: **does an evolved genome generalise to a Solana
market period it never saw, or is it just fitted to whatever happened to be live?** Everything in this
section is a research instrument for that question, and all of it is still paper-only.

### Historical capture

```bash
npm run record:market                              # honours EVOLVE_MARKET_MODE
EVOLVE_MARKET_MODE=live npm run record:market      # record genuine Jupiter observations
EVOLVE_MARKET_MODE=synthetic npm run record:market # record the simulator (development fixture)
npm run record:market -- --minutes 30 --interval 5000
```

The recorder writes **exactly the normalized market representation the agents consume**
(`feed.markets()` plus `feed.health()`) — there is no second normalization pipeline, so what an agent
saw live is what gets written, and what gets read back is what an agent sees during replay. The API
key is never passed to the recorder and never appears in a dataset.

Storage is append-only NDJSON under `.evolve/history/`, which is gitignored:

```text
.evolve/history/2026-09-17/session-20260917T120000Z/
  manifest.json     dataset id, schema version, mode, counts, interval stats, classification, SHA-256 fingerprint
  snapshots.ndjson  line 1 = session header (row layout), then one line per snapshot (columnar rows)
  events.ndjson     feed events (mode changes, failures, start/stop)
```

Crash safety: every record is a single awaited line write, unreadable or truncated lines are skipped
by the reader rather than failing the dataset, and the manifest is rewritten atomically on close
(status `complete`/`interrupted`) so a killed run is still identifiable and partially usable. Ctrl+C
finalizes cleanly.

A dataset is always classified — `live-only`, `synthetic-only`, `mixed`, or `empty` — and a dataset
containing synthetic observations can never masquerade as real Solana history. The manifest states
the classification in plain words (`usableForRealMarketReplay: false` for anything synthetic/mixed).

### Deterministic replay

```bash
npm run replay -- .evolve/history/2026-09-17/session-…
EVOLVE_REPLAY_SPEED=max EVOLVE_SEED=12345 npm run replay -- <dataset>
```

Replay implements the same provider interface as live and synthetic (`markets()`, `health()`,
`advance()`), so the evolutionary engine cannot tell where observations come from. The simulation
clock is the dataset's own timestamps — never wall-clock time — which makes acceleration safe:

| `EVOLVE_REPLAY_SPEED` | Behaviour |
| --- | --- |
| `1` | roughly real time |
| `100` | 100× faster |
| `max` | as fast as the machine allows |

Speed changes only how long the process waits. Given the same dataset, config, and `EVOLVE_SEED`, the
run produces identical genomes, mutations, crossovers, immigrants, decisions, paper fills, selection,
and generation results (asserted by digest comparison in `npm run validate:history`). Randomness comes
from a seeded generator, ids from a deterministic factory, and time from the dataset.

### No look-ahead, by construction

- the dataset reader is **forward-only**: there is no seek, rewind, or random-access API
- the replay provider throws `RangeError` if asked for market state newer than the loaded snapshot
- each walk-forward stage opens its own feed restricted to its own interval
- features are derived from the current observation plus the *previous* observation only
- frozen stages run with breeding disabled, and genomes are compared by content digest before and
after, so a mutation during VALIDATE or TEST fails the run loudly

### Walk-forward evaluation

```text
Window 1:  TRAIN A          VALIDATE B   TEST C
Window 2:         TRAIN B   VALIDATE C   TEST D
Window 3:                TRAIN C   VALIDATE D   TEST E
```

| Stage | What is allowed |
| --- | --- |
| TRAIN | trade, reproduce, mutate, crossover, die. Anything may adapt. |
| VALIDATE | candidates are **frozen**; no breeding, no selection pressure, no parameter edits. Ranking only. |
| TEST | survivors frozen again, on data neither earlier stage influenced. Nothing adapts. Ever. |

```bash
npm run experiment -- <dataset>
EVOLVE_EVAL_SEEDS=11,22,33,44,55 npm run experiment -- <dataset>
```

Windows step forward, so training periods overlap by design (that is what walk-forward means) while
every test window is data later windows may train on but earlier ones never saw. A dataset too short
for the requested windows **fails with a suggested development configuration** rather than silently
inventing history.

### Champion selection and robustness

A genome is never a champion because it won one generation. It must clear minimum evidence gates —
closed paper trades, distinct token mints traded, market observations, ticks exposed — and is then
ranked by a transparent robustness score, not raw return:

```text
score = 100 × clamp(raw, -1, 1) × confidence

raw = 0.40 · tanh(netReturn / scale)      net return, saturating
    − 0.25 · maxDrawdown                  pain taken to get there
    − 0.10 · min(1, costDrag / scale)     friction dependence
    − 0.12 · max(topMintShare, topTradeShare)   single-name / single-trade luck
    + 0.10 · (2 · consistency − 1)        time-consistency of P&L
    + 0.05 · min(1, trades / minTrades)   evidence of activity
    − 0.20 · catastrophic                 tail blow-up penalty

confidence = sqrt(evidence gates met / total gates)
```

A genome earning +100% from one lucky paper trade therefore cannot outrank a genome earning +20%
across many independent observations. When there is not enough evidence, the result is reported as
`INSUFFICIENT SAMPLE` — never as validated. Champion records live in `.evolve/champions/` and carry
the genome, lineage id, parents, originating generation, dataset id **and fingerprint**, seeds, the
train/validate/test windows with their metrics, costs, robustness, classification, and an overfit
warning when test performance falls well short of validation. This score is a ranking heuristic for
penalising how paper backtests lie; **it does not predict profit**.

### Baselines

Every experiment also runs four non-evolutionary baselines over the same windows: **no-trade**
(100 paper cash stays 100), **random** entries, a fixed **momentum** rule, and a **buy-and-hold-like**
hold of the deepest-liquidity token. They see the same snapshots, pay the same simulated fees,
slippage, adverse buffer, and liquidity caps, and cannot see the future. The point is the comparison:
is evolution doing anything a trivial rule does not?

### Multiple seeds, species, genealogy

One seed is not evidence. `EVOLVE_EVAL_SEEDS` runs the population per seed and reports **median**,
mean, worst and best net return, median and worst robustness, worst drawdown and trade counts —
selection prefers median/robust statistics rather than the luckiest seed. Out-of-sample results are
aggregated per species (population share, births, deaths, extinction events, median validation and
test return, champion count), and champion lineage chains are stored compactly (ids, generations,
parents, origin) so a champion can be traced back to its founders without duplicating genomes.

### Experiment reports

```text
.evolve/experiments/<experiment-id>/
  manifest.json    dataset, fingerprint, config, seeds, windows, engine version, git commit
  summary.json     headline aggregates, baselines, honest failure/insufficient-sample counts
  windows.json     per-window train / validation / test detail
  champions.json   champion records written by this experiment
  windows.csv, champions.csv, baselines.csv
```

Reports contain no `NaN`/`Infinity`, no credentials, and enough metadata (dataset fingerprint, seeds,
config, window plan) to reproduce the run.

### State isolation

| File | Written by |
| --- | --- |
| `.evolve/state.json` | live / synthetic engine |
| `.evolve/replay-state.json` | historical replay |
| `.evolve/experiments/<id>/` | experiment reports |
| `.evolve/champions/` | champion archive |

A replay can never overwrite the live dashboard snapshot. The dashboard asks for a source
(`?source=live|replay|auto`, or the `LIVE` / `REPLAY` / `AUTO` switch) and merges the newest
experiment summary plus the champion index for the research and out-of-sample panels.

### Phase 3 dashboard additions

- `HISTORICAL REPLAY • PAPER MONEY` banner with the dataset id, class, speed, and integrity status
- **Research / Replay** panel: dataset, timestamp, progress %, speed, current stage, current window
  and total windows, seed(s), and the train / validate / test periods of the active window
- **Out-of-sample** panel: train, validation and test returns, test drawdown, trades, distinct tokens,
  simulated costs, robustness, result classification, overfit warnings, and baseline comparison
- **Evolution research** panel: best lineage, champion archive size, lineages lost, generation,
  mutation / crossover / immigrant rates, per-species survival, and an inline SVG genealogy chain

No badge says “successful strategy” merely because a return is positive.

## Phase 4 — Champion Arena, regime/stress testing, Live Shadow League

**Still PAPER TRADING ONLY.** There is no private key, seed phrase, keypair, wallet adapter, signer,
transaction construction, transaction broadcast, RPC write path, or Jupiter swap/order execution
anywhere in this repository. Phase 4 adds a large-scale tournament and a long-running paper shadow
evaluation on top of the same replay engine and simulated fill machinery from Phase 3 — it does not add
any new capability to spend real SOL.

### Champion Arena

```bash
npm run arena                                       # registry sweep over .evolve/history
npm run arena -- <dataset-dir> [<dataset-dir> ...]   # specific dataset(s)
EVOLVE_ARENA_POPULATION=500 EVOLVE_ARENA_WORKERS=8 EVOLVE_ARENA_GENERATIONS=20 npm run arena
```

Entrants — newly evolved genomes, archived champions (re-entering, never protected), and random
immigrants — compete across every supplied dataset, seed, regime, and stress profile through a fixed
funnel:

```text
QUALIFICATION -> GROUP -> STRESS -> OUT-OF-SAMPLE -> CHAMPION LEAGUE -> DEPLOYMENT CANDIDATES
```

`EVOLVE_ARENA_GENERATIONS` (default 1) runs cheap, single-seed, no-stress pre-evolution rounds — each
one breeds the next round's pool from the previous round's top scorers — before the final generation
runs the full funnel with stress and out-of-sample evaluation and writes output. Every candidate sees
identical observations and identical applicable friction; agents never alter simulated market prices.

### Dataset registry and real-vs-synthetic evidence

`buildDatasetRegistry()` (`scripts/arena/orchestrator.mjs`) walks `.evolve/history/` and classifies each
dataset as `REAL`, `SYNTHETIC`, or `MIXED` using the same `usableForRealMarketReplay` flag the Phase 3
recorder already writes — a synthetic or mixed dataset is *never* aggregated into real-market evidence.
`registrySummary()` reports real and synthetic dataset counts and observed durations **separately**, and
arena and dashboard output always print both, e.g.:

```text
Real datasets:       8   Real observation:    41h
Synthetic datasets:  3   Synthetic duration:  12h
```

### Regime classifier

Deterministic, rule-based, and strictly backward-looking: `computeRegimeMetrics()` derives median
return, dispersion, positive-return ratio, liquidity/volume change, buy/sell and organic ratios, active
token count, and launch-heavy ratio from only the snapshots inside one window, and
`classifyRegimeFromMetrics()` matches an ordered rule list (first match wins, so the result is
inspectable) into one of: `strong-risk-on`, `weak-risk-on`, `sideways-chop`, `high-volatility`,
`liquidity-expansion`, `liquidity-contraction`, `broad-selloff`, `launch-heavy`, `low-activity`. Regime
labels are a heuristic, not ground truth — the supporting metrics are always stored alongside the label.

### Stress engine

Stress profiles (`none`, `mild`, `moderate`, `severe`, `extreme`) scale **execution conditions only** —
fee multiplier, slippage multiplier, an adverse-execution buffer, observation delay, missing-snapshot
rate, stale-interval length, liquidity haircut, and position-cap pressure — never historical prices. A
deterministic token-failure plan (`buildTokenFailurePlan`) simulates tokens disappearing mid-window: no
new entries open on a disappeared mint, an existing position closes on its last defensible observed
mark, and no future price is ever fabricated.

### Arena Score

`computeArenaScore()` is a transparent, multi-component heuristic — **not** raw return. It blends median
and worst out-of-sample return, drawdown, stress survival, regime breadth, seed consistency, distinct-
token breadth, concentration penalty, cost sensitivity under added friction, a catastrophic-loss
penalty, and evidence strength, each as a named, inspectable component (see `arenaScore.components` in
any arena output). The formula string ships in every arena's `summary.json` and here:

> `ArenaScore = 100 * weighted mean of: medianOOS tanh(netReturn/scale), worstPeriod tanh(worst/scale),
> drawdown (1-DD/scale), stressSurvival (survived/total), regimeBreadth (positive regimes/known),
> seedConsistency (1-std/scale), tokenBreadth log-scaled distinct mints, concentration (1-topMintShare),
> costSensitivity (1-loss-under-2x-friction), catastrophic (0 if any blow-up), evidence (trades+mints+
> windows coverage)`

**Arena Score does not predict future profitability.**

### Survival gates, Deployment Candidates, and Hall of Fame

Every candidate lands in one explicit state: `INSUFFICIENT EVIDENCE`, `ELIMINATED`, `ARENA SURVIVOR`, or
`DEPLOYMENT CANDIDATE`. `evaluateSurvivalGates()` checks minimum trades, distinct mints, genuine
real-market datasets, out-of-sample windows, seeds, stress profiles survived, maximum drawdown, mint
concentration, mild-stress survival, and zero catastrophic events — **any single failed gate**
eliminates the candidate regardless of score, and insufficient evidence can never qualify no matter how
high the score reads. A specialist that clears every gate becomes an `ARENA SURVIVOR`, not automatically
a `DEPLOYMENT CANDIDATE` — it still needs demonstrated regime breadth.

The Hall of Fame (`.evolve/hall-of-fame/index.json`) is historical/research recognition only — membership
never implies deployment eligibility, profitability, or safety. Previous champions re-enter every future
arena unprotected, can lose their title, and their appearances, title defenses, and eliminations are all
tracked side by side.

### Diversity protection and adaptive mutation

`computeGenomeMetrics()` reports deterministic, bounded genome diversity, species distribution, and
lineage concentration (a Herfindahl index, correctly falling back to the genome digest — not a shared
"unknown" bucket — for entrants without an explicit lineage id). `diversityVerdict()` flags a collapsing
population, and `adaptMutationScale()` nudges the mutation scale up under sustained low diversity and
back toward baseline once diversity recovers, always within `MUTATION_LIMITS` — performance still ranks
above novelty; diversity only protects against total convergence.

### Live Shadow League

```bash
npm run shadow                                # admits DEPLOYMENT CANDIDATE(s) only
npm run shadow -- --dev <genome.json|digest>  # labelled UNQUALIFIED SHADOW TEST — clearly not qualified
```

`LIVE SHADOW LEAGUE • PAPER MONEY` observes genuine current market data while frozen candidate genomes
paper trade — **no mutation, no crossover, no threshold adaptation, no learning from shadow results, and
no genome parameter ever changes for the life of the run.** Each candidate tracks bankroll, gross/net
P&L, drawdown, simulated costs, trades, distinct mints, current positions, and feed-health exposure;
state is persisted under `.evolve/shadow/<candidateId>.json` with no secrets and no genome mutation.
Duration milestones (1h / 6h / 24h / 3d / 7d / 30d) progress a status from `SHADOW TESTING` through
`SHADOW PROVISIONAL` to `SHADOW VALIDATED` as paper evidence accumulates — even `SHADOW VALIDATED` is
still paper-only and never enables real trading. A degraded live feed blocks *new* shadow entries
(`shadowEntryGate`); existing positions keep their last defensible observed mark.

### Caching and parallel evaluation

Arena evaluation results are cached under `.evolve/arena-cache/`, keyed by `arenaCacheKey()` over the
dataset fingerprint(s), genome digest, seed, stage, stress profile, and the arena/scoring code versions
— any one of those changing invalidates the cache; everything else reuses it.
`EVOLVE_ARENA_WORKERS=<n>` bounds evaluation across worker threads (default: inline, single-threaded).
Each worker evaluates one candidate independently against seeded, deterministic replay stages, so the
result is identical regardless of worker count — this is asserted by `validate:arena`.

### Commands

```bash
npm run arena           # run the Champion Arena (see EVOLVE_ARENA_* env vars above)
npm run shadow          # run the Live Shadow League against the active market feed
npm run champions       # print the champion archive and the Hall of Fame
npm run smoke:arena     # tiny, fully offline, deterministic funnel smoke run
npm run validate:arena  # Phase 4 validation suite (26 offline cases)
npm run validate:phase41  # Phase 4.1 correctness-pass regression suite (26 offline cases)
```

### Statistical honesty

Arena and shadow output report medians, worst-period figures, seed dispersion, and evidence strength
rather than a single flattering number, and every evolved candidate is compared against the same
mandatory Phase 3 baselines (no-trade, random, fixed momentum, buy-and-hold-like) under identical
observations and friction — including when the evolved candidates lose to them. Nothing in the Champion
Arena or the Live Shadow League is a claim that a candidate is profitable, safe, proven, predictive, or
statistically significant.

## Phase 4.1 — correctness pass

Still **PAPER TRADING ONLY**, with no new capability of any kind. Phase 4.1 fixes six correctness issues
found by inspecting the first genuine 1-hour Solana Arena run (`.evolve/arenas/arena-20260917T134825Z`)
in detail, then reran the exact same historical dataset with the same seeds/config to compare before vs
after. Every fix narrows behavior toward "more honest," never toward "more likely to produce a survivor."

- **Concentration (`topMintShare`) is now measured by pooled executed notional.** It used to be
  `maxMintPnl / positiveTotal` from a single run — share of *profit*, not trading size, denominated
  against only the profitable mints — which saturated to `1.0` any time a candidate had exactly one
  mint with positive P&L, regardless of how many mints or trades it actually ran. It is now
  `max(notional by mint) / total notional`, pooled across every OOS and stress run in a candidate's full
  evidence set (not the max of independent per-run shares, which had the same saturation problem one
  level up). Paper trades now carry their executed notional so this is computable at all.
- **The regime classifier is now actually wired into the arena.** `buildRegimeMap` existed and was
  covered by its own validation cases, but the arena CLI never called it — every dataset's
  `regimesByWindow` was an empty object, so every OOS window fell into `unknown` by construction, not by
  evidence. A second, independent bug meant that even with `regimesByWindow` supplied, the tournament
  runner flattened every dataset's runs into one array per candidate before scoring, discarding the tag
  needed to look its window back up — regime is now stamped on each individual run rather than on the
  wrapping per-dataset object, so it survives that flattening. `buildRegimeMap` itself was also rewritten
  to classify each window strictly from that window's own TEST-interval snapshots (queried directly by
  timestamp range) instead of a single forward-only cumulative buffer, which had been silently bleeding
  earlier windows' training data into later windows whenever walk-forward windows overlap.
- **Live evolutionary selection is evidence-aware and less aggressive by default.** Reproduction used to
  be "top ~10% (elites) survive, everyone else dies," which meant ~90% replacement per generation at the
  default 10% elite fraction, and raw fitness (no evidence gate) meant a one-trade lucky result could
  win a large reproductive share. There is now a wider, evidence-ranked **survivor tier**
  (`EVOLVE_LIVE_SURVIVOR_FRACTION`, default 35% of the population) that lives on unculled beyond the
  elites, and agents are ranked for elite/breeder selection with evidence-sufficiency
  (`EVOLVE_LIVE_MIN_TRADES_FOR_SELECTION`, `EVOLVE_LIVE_MIN_OBSERVATIONS_FOR_SELECTION`) checked *before*
  fitness — an under-evidenced agent can still survive, it just cannot out-rank a properly evidenced one
  on a lucky result. `EVOLVE_LIVE_ELITE_FRACTION` and `EVOLVE_LIVE_MIN_GENERATION_TICKS` (a floor under
  `generationTicks`, a no-op at every default/test config) round out the knobs. This governs live/replay
  reproduction only — Arena deployment gates are untouched.
- **Gene bounds are species-specific and sane.** Every species used to mutate `minPoolAgeHours` /
  `maxPoolAgeHours` against one *global* bound box spanning roughly 114 years (wide enough to hold
  `MAX_POOL_AGE_UNBOUNDED` as a reachable "no age gate" sentinel some presets used outright). Mutation
  jitter is proportional to that span, so a Genesis Hunter genome — whose preset starts at a sane 48h —
  could drift to something like 844,533h within a handful of generations: the step size was scaled for a
  different species' range entirely. Each species now mutates against its own finite, niche-appropriate
  box (`SPECIES_AGE_BOUNDS` in `scripts/engine/genome.mjs`): Genesis Hunter stays within hours-to-days,
  Momentum/Reversal/Wallet Flow get progressively broader multi-week ranges, Liquidity explicitly allows
  older seasoned pools, and Experimental stays broad but finite. No preset relies on the unbounded
  sentinel anymore, so every species is now genuinely age-aware.
- **Compact leaderboard elimination context.** `leaderboard.json` rows now carry a `failedGates` array
  (gate labels only, e.g. `["reasonable concentration"]`) alongside score/status, so a candidate's
  elimination reason is visible without cross-referencing `candidates.json`.
- **STRESS funnel semantics are documented, not just implemented.** STRESS genuinely culls
  (`stressSurvived >= 1` across the configured profiles) — the funnel now carries a `rule` string per
  stage explaining exactly what "survivors" means there, since a candidate that failed every stress
  profile is still recorded in `candidates.json` with full detail even though it never reaches this
  stage's survivor count.

None of these fixes weaken a deployment gate, and the corrected rerun can still — and does — produce
zero Deployment Candidates. See `npm run validate:phase41` (26 offline cases) for the regression suite,
and the Phase 4.1 correctness-pass report for the full before/after Arena comparison.

## Phase 5A — Controlled Research Swarm

Still **PAPER ONLY**, with no wallet, no signing, and no execution path of any kind. Phase 5A adds a
bounded research layer whose job is to make EVOLVE better at *searching* the existing strategy space —
discovering hypotheses, combining existing signal families, criticizing apparent edge, preserving
strategic diversity, specializing by regime, remembering failed research, and abstaining when the
market is unsuitable. Research agents **propose**; the existing deterministic engine (selection, the
watchdog, the Champion Arena) **decides**. Nothing in this phase can place a live trade, alter an Arena
gate, or promote its own output.

### Configurable population

`EVOLVE_POPULATION_SIZE` (default `96`; the older `EVOLVE_POPULATION` name still works, and the new
name wins if both are set) replaces the previous hard-coded population. 48, 96, 192, and arbitrary
sensible sizes all work: the population is exact after every generation (births restore precisely
`populationSize - survivors`), accounting stays internally consistent
(`bornTotal - terminatedTotal == population` at all times), and the same seed/config always initializes
the same population byte-for-byte. Invalid values (negative, non-numeric, absurdly large) clamp to a
safe range rather than crashing. No internal code assumes exactly 96 agents.

### Strategy islands

The population is split into semi-isolated **islands** — one per existing species (Genesis Hunter,
Momentum, Reversal, Wallet Flow, Liquidity, Experimental) — that breed primarily from their own members
(`scripts/engine/islands.mjs`, wired into `breedGeneration` in `scripts/engine/simulation.mjs`). At 192
agents this **starts** at 32/32/32/32/32/32 — but that is an initialization, not a quota. See
[Phase 5A.1](#phase-5a1--integration-correctness-pass) for the soft, diversity-protected model that
replaced the original hard equal per-island target. Breeding always draws from a fixed, pre-generation
snapshot of each island's own top performers — never from siblings born earlier in the same generation.
On top of that:

- **Migration** (`EVOLVE_ISLAND_MIGRATION_RATE`, `EVOLVE_ISLAND_MAX_MIGRATIONS`): a bounded fraction of
  survivors relabel to a different island each generation (genome carried over, breeding boundary
  changed).
- **Cross-species crossover** (`EVOLVE_CROSS_SPECIES_CROSSOVER_RATE`): a bounded fraction of births pick
  their second parent from a different island's breeder pool.
- **Random immigration** (`EVOLVE_RANDOM_IMMIGRANT_RATE`): on top of the pre-existing global
  `EVOLVE_IMMIGRANT_RATE` floor, a bounded fraction of each island's own births are fresh random genomes.
- **Revival** (`EVOLVE_ISLAND_REVIVE_EXTINCT`): an island with zero survivors is re-seeded with fresh
  random genomes rather than left permanently at zero — it still has to earn its way back through
  ordinary evidence-ranked selection from there. A poor island is never protected from selection; only
  total extinction is prevented from being permanent.

Per-island population, population share, initialization target, evidence-adjusted soft target,
reproductive weight, floor, cap, births, deaths, migrations in/out, revivals, extinction events, paper
return, mean/median fitness, trade count, and evidence-sufficient-agent count are all visible in
`state.json` under `islands` and rendered on the dashboard's Strategy Islands panel.

### Research swarm roles

Six structured researcher roles read a bounded, plain-data **evidence packet** (regime, island/species
stats, cost summary, prior conclusions — never source code, credentials, or raw provider payloads) and
propose hypotheses as structured proposals:

- **Signal Researcher** — combinations of existing approved signals.
- **Regime Researcher** — regime-specific specialization and transitions.
- **Execution Researcher** — friction, slippage, turnover, holding time, churn.
- **Risk Researcher** — drawdown, concentration, stop/take-profit, sizing.
- **Diversity Researcher** — island collapse, lineage dominance, unexplored genome regions.
- **Adversarial Critic** — reserved as a non-proposing role; its purpose is to falsify others' hypotheses
  rather than add its own.

The default provider is `mock` — a **deterministic, offline, no-LLM** heuristic provider
(`scripts/research/provider.mjs`). The whole validation suite, and Phases 5A–5B, work with no network
access and no LLM API key. Phase 5B adds exactly one more provider behind the same interface
(`resolveResearchProvider`): **`deepseek-cline`**, which asks DeepSeek V4.1 Flash (via the locally
installed Cline CLI) for bounded, schema-validated hypotheses. `mock` remains the default and the
baseline; provider selection is **fail-closed** (Phase 5B.1) — leaving `EVOLVE_RESEARCH_PROVIDER`
unset uses `mock`, an explicit name must be registered, and an explicit *invalid* name
(e.g. `deepseek-clnie`) is a configuration error that refuses to run rather than being served by the
mock. See `## Research providers`.

### Structured research proposals

A proposal (`scripts/research/proposal-schema.mjs`) is declarative data, never code:

```json
{
  "schemaVersion": 1,
  "proposalId": "P-...",
  "authorRole": "regime-researcher",
  "hypothesis": "Momentum improves during liquidity expansion when buyer flow persists.",
  "targetRegimes": ["liquidity-expansion"],
  "abstainRegimes": ["broad-selloff"],
  "parentFamilies": ["Momentum x Wallet Flow"],
  "changes": { "momentumWeight": [0.45, 0.75], "flowWeight": [0.3, 0.65], "maxHold": [35, 90] },
  "rationale": "...",
  "risks": ["cost drag", "regime dependence"]
}
```

Validation is a strict allowlist, not a denylist: unknown top-level fields are rejected outright; only
whitelisted genome keys may appear in `changes`, as a finite number or a finite `[min, max]` range inside
`GENE_BOUNDS`; `targetRegimes`/`abstainRegimes` must be real `REGIMES` members (never the classifier's own
`"unknown"` sentinel); and a static sandbox scan rejects `eval`, `require`/`import`, `child_process`,
`fetch`, raw URLs, shell metacharacters, assignment/statement chains, and template-literal execution
anywhere in any string field. After validation, a proposal is a tree of plain strings, booleans, numbers,
and enum references — nothing that can execute.

### Deterministic proposal compiler

`scripts/research/compiler.mjs` turns validated proposals into candidate genome families. The compiler —
never the proposal, never the provider — owns which genes exist, their ranges, species-aware bounds
(the same `clampToBounds`/`SPECIES_AGE_BOUNDS` every other genome goes through), and its own tighter
safety ceilings (`COMPILER_LIMITS`: max 25% risk fraction, min 2% stop-loss, min 4% take-profit, capped
pool-age ranges) — proposals may narrow inside these, never widen past them. Compilation is a pure
function: the same proposals compile to byte-identical genomes every time, with no `eval`, no dynamic
import, no shell, and no I/O.

### Research memory

`.evolve/research/` persists, as sanitized JSON (no secrets, no code, no non-finite numbers):

```text
.evolve/research/
  proposals/<proposalId>.json   one validated proposal per file
  compiled/<familyId>.json      the exact compiled genome (for later Arena digest matching)
  memory/index.json             bounded structured evaluation records
  conclusions.json              one aggregated line per proposal outcome
```

Statuses are `PROPOSED → TESTING → REJECTED`, or (Arena-gated only, see below) `PROMISING`,
`ARENA_SURVIVOR`, `SHADOW_ELIGIBLE`. Each memory record also carries a structured `watchdog` object
(status, flag labels, reasons, the trade count the verdict was based on, and `evaluatedAt`), mirrored
onto its conclusion line, so watchdog evidence is queryable (`readWatchdogEvaluations`, `watchdogStats`)
without parsing a sentence. Each research cycle reloads prior conclusions first, so researchers
do not endlessly re-propose the same rejected region — the mock provider's rationale explicitly
references prior `REJECTED` proposal ids it is avoiding.

### The recursive research cycle

`scripts/research/cycle.mjs` runs the bounded pipeline (market evidence → researchers propose →
schema validation → deterministic compilation → candidate genomes → injection → watchdog evaluation →
research memory → next cycle), driven from the live engine's tick loop every
`EVOLVE_RESEARCH_CYCLE_EVERY_GENERATIONS` generations (`scripts/evolve-engine.mjs`,
`createResearchController`). A compiled candidate is injected by replacing the population's current
lowest-fitness agent (population size is invariant — a replace, never an append) and from that instant
on is an ordinary genome subject to the exact same fitness/selection/death rules as every other agent.
Its accumulated evidence (trades, distinct mints, per-mint notional, cost drag, drawdown — bounded by
mint count, never by trade count, so long-lived candidates cannot grow this without limit) is captured
the moment it is culled or replaced, and evaluated by the watchdog on the *next* research cycle. A research
cycle can only ever leave a memory record at `PROPOSED`, `TESTING`, or `REJECTED` — see Promotion below
for the only path to anything further.

### Reward-hacking watchdog and quarantine

`scripts/research/watchdog.mjs` is a deterministic, inspection-only screen (`NORMAL` / `WATCH` /
`QUARANTINED`) over: single-mint dominance, single-window/regime/seed dependence, very-low trade count,
single-trade-return dominance, high cost drag, replay-vs-live discrepancy, missing-data dependence,
parameter-boundary saturation, train→OOS collapse, and stress collapse. A flag does not kill a candidate;
enough flags move it to `WATCH` (labelled, continues) or `QUARANTINED`. **A `QUARANTINED` candidate can
never become a Deployment Candidate, cannot hold `PROMISING`/`ARENA_SURVIVOR`/`SHADOW_ELIGIBLE` status,
and cannot self-clear** — clearance requires a later, independent evaluation whose verdict is `NORMAL` or
`WATCH` (`clearQuarantine`). The watchdog is advisory to the research layer only: it never touches an
Arena gate.

### Meta-evolution: approved family combinations

`scripts/engine/families.mjs` defines the only combinations Phase 5A may target — deterministic blends of
two existing species presets (`Momentum x Wallet Flow`, `Genesis x Flow`, `Reversal x Liquidity`,
`Momentum x Liquidity`, `Reversal x Flow`, plus the Phase 5A.2 directions `Genesis Hunter x Momentum`,
`Wallet Flow x Reversal`, and `Liquidity x Wallet Flow`) with fixed blending rules (weights average, binary gates AND,
risk genes take the most conservative parent). A family still resolves to plain existing genome fields —
Phase 5A introduces no new signal and no executable artifact. Arbitrary feature/indicator-source
generation is explicitly out of scope for this phase.

### Regime specialization and ACTIVE / REDUCED_RISK / ABSTAIN

A research candidate may declare `targetRegimes` (where it specializes) and `abstainRegimes` (where it
should stand down). Deterministic posture rules (`abstentionDecision` in `families.mjs`) resolve to
`ACTIVE`, `REDUCED_RISK` (half position size), or `ABSTAIN` (skip the tick entirely) from the *same*
regime classifier the Arena uses on historical windows (`classifyWindowRegime`), applied live over a
small rolling buffer of already-observed ticks — so replaying the same data reproduces the same
activation-state sequence. This is scoped to research-declared candidates only: an agent with no declared
`targetRegimes`/`abstainRegimes` (every pre-5A species agent) is completely unaffected — the mechanism is
a byte-for-byte no-op for the rest of the population. Abstention is not a failure; a specialist is never
presented as globally robust (see `topAgents[].research.posture` in `state.json`).

### Arena-gated promotion — researchers cannot self-promote

`scripts/research/promote.mjs` is the **only** place a memory record can reach `PROMISING`,
`ARENA_SURVIVOR`, or `SHADOW_ELIGIBLE`, and it only ever runs against a real, already-finished
`npm run arena` result. Matching is by genome digest (`digestOf`, the same value the Arena already uses
for its own leaderboard rows) — the compiled candidate genome persisted under
`.evolve/research/compiled/` is looked up against the Arena leaderboard, and its research memory record
is upgraded accordingly. A `QUARANTINED` family is blocked from promotion even if its genome happens to
match a leaderboard entry. Run `npm run arena -- --research` (or `EVOLVE_ARENA_INCLUDE_RESEARCH=1`) to
add persisted research candidates as additional Arena entrants; promotion itself runs on every
`npm run arena` invocation regardless of that flag, so a research candidate added in an earlier run can
still be promoted from a later one.

### Shared market feed

Population scaling does not multiply market traffic: `feed.markets(at)` / `feed.health(at)` are each
called exactly once per tick regardless of population size, and every agent in the tick loop reads the
same already-fetched snapshot. 48, 96, and 192 agents issue the identical number of feed calls per tick —
population scaling increases local strategy evaluation only, never external request volume (verified by
`npm run validate:phase5a`, case 50).

### The upcoming 192-agent live experiment

```bash
EVOLVE_MARKET_MODE=live \
EVOLVE_POPULATION_SIZE=192 \
EVOLVE_LIVE_SURVIVOR_FRACTION=0.35 \
EVOLVE_LIVE_MIN_TRADES_FOR_SELECTION=3 \
EVOLVE_LIVE_MIN_OBSERVATIONS_FOR_SELECTION=30 \
npm run engine
```

This is a configuration, not an instruction to run it — start it deliberately, and record a market feed
in parallel (`npm run record:market`) so the same window can be replayed later. Zero Deployment
Candidates remains a completely acceptable outcome of the eventual Arena run over whatever this produces.

### Commands

```bash
npm run validate:phase5a         # Phase 5A + 5A.1 validation suite (78 offline cases)
npm run smoke:swarm              # offline 192-agent island-divergence + swarm-state smoke run
npm run arena -- --research      # include persisted research candidates as Arena entrants,
                                  # and promote research memory from the result
```

## Phase 5A.1 — integration correctness pass

Still **PAPER ONLY**, with no new capability of any kind. Phase 5A.1 fixes three integration defects
found by inspecting the first genuine 192-agent live research run (66 proposals, 33 compiled families,
46 memory records, watchdog conclusions, generation 22): the dashboard showed a stale Phase 3 replay
instead of the live swarm, watchdog results were only readable as prose, and every island had been
frozen at exactly 32 agents. Each fix narrows behaviour toward "more honest", never toward "more likely
to produce a survivor".

- **The two research concepts are now two distinct state fields.** `researchSwarm` is the CURRENT Phase 5A
  research swarm (enabled, cycle, provider, current research regime, proposals
  generated/accepted/rejected, compiled families, injected candidates, memory records,
  conclusions/evaluations, per-role counts, and watchdog NORMAL/WATCH/QUARANTINED counts — all
  machine-readable). `historicalResearch` is Phase 3/4 reference data (replay metadata, the newest
  experiment report, champion archive, newest arena, Hall of Fame, Shadow League) and is explicitly
  labelled `kind: "historical"` with a pointer back at `researchSwarm`. The ambiguous old `research`
  field — which meant "historical replay data" while reading like "the research state" — is gone. Two
  root causes were fixed: `auto` source selection preferred an existing *replay* document over an
  existing (merely stale) live one, so the whole dashboard flipped to an older replay file that has no
  swarm summary at all; and the swarm summary itself was never attached to the response except through
  the live document. `auto` now serves the live document whenever it exists (a stale live snapshot is
  still *the* live run — it simply renders the stale strip), only falling back to replay when there is
  no live state at all, and the swarm summary additionally falls back to the live state file so browsing
  a historical replay never blanks the swarm panel. All of this lives in
  `scripts/lib/dashboard-state.mjs`, so the offline validation suite exercises the exact contract the
  browser consumes.
- **Watchdog results are structured and queryable.** Every research-memory record (and its mirrored
  conclusion line) now carries a `watchdog` object: machine status, flag labels, human reasons, the
  trade count the verdict was based on, and `evaluatedAt` — so "which candidates are quarantined, and
  why?" is answered by `readWatchdogEvaluations(root, { status })` and a `watchdogStats()` roll-up
  instead of by parsing a sentence. Memory stays **append-only** and a research cycle still cannot leave
  anything beyond `PROPOSED` / `TESTING` / `REJECTED`: a `QUARANTINED` verdict remains structured
  evidence attached to a `TESTING` record (it restricts and blocks promotion, it does not reject), and
  the Champion Arena remains the only promotion path.
- **Islands are soft diversity-protected, not hard equal quotas.** Births used to be allocated against a
  fixed even target every generation, so every island snapped back to exactly `populationSize / N`
  regardless of evidence — 32/32/32/32/32/32 forever at 192 agents. Now each island's
  **evidence-adjusted reproductive weight** becomes a desired share (`islandReproductiveWeights`); the
  advantage is damped by how much of that island's surviving population actually has sufficient
  evidence, so one lucky barely-evidenced agent buys essentially nothing. Movement toward the desired
  share is bounded per generation (`EVOLVE_ISLAND_MAX_SHARE_DELTA`, default 6% of the population — the
  anti-takeover bound), the resulting soft target is clamped into an explicit
  **floor** (`EVOLVE_ISLAND_MIN_SHARE`, default 8% → 15 agents at 192; `0` re-enables the pre-5A.1
  "an island may go extinct" path) and **cap** (`EVOLVE_ISLAND_MAX_SHARE`, default 30% → 58 agents at
  192), and births fill the floor first, then move each island toward its soft target, then place any
  residue by weight. The one hard invariant is global: `sum(island populations) == EVOLVE_POPULATION_SIZE`
  exactly, always. Genuine divergence is therefore possible and evidence-driven (for example
  34/33/33/32/31/29 after 40 offline generations, or 25/41/38/34/22/32 in the live run's terminology),
  while a one-generation lucky island cannot consume the population, a weak island shrinks substantially
  without being wiped out, and migration / cross-species crossover / random immigration stay bounded.
  `EVOLVE_ISLAND_TARGETS` still expresses an initialization/base-weight preference rather than a quota.

## Phase 5A.2 — research cohort correctness + experimental quality

Still **PAPER ONLY**, with no new capability of any kind. Phase 5A.2 is a focused correctness and
experimental-quality pass over the first genuine Research Arena. That run supplied 233 entrants
(200 conventional + 33 research), and the research cohort behaved worse than the numbers suggested:
33 research entrant slots collapsed to only **13 unique genomes**, every compiled candidate was a
**Momentum** genome, two researcher roles never compiled at all, and `--research <dataset>` silently
ran a registry sweep over every recorded dataset. Each defect below was reproduced, root-caused, and
fixed without weakening a single Arena gate. **No live recording was rerun for this pass** — every
number below is reproducible offline.

### 1. `--research` is a boolean flag (CLI parsing)

The shared parser treated every `--flag` as taking a value, so `npm run arena -- --research DATASET`
bound `DATASET` to `research` and left no positional at all — the run silently swept the entire
dataset registry. `scripts/lib/args.mjs` now knows which flags are boolean. All three spellings are
equivalent and always leave the dataset positional:

```bash
npm run arena -- --research DATASET
npm run arena -- DATASET --research
npm run arena -- --research=true DATASET
```

Flags that legitimately take a value (`--research-mode fair`, `--max-windows 3`, `--seed abc`) still
work, `--research=false` / `--no-research` disable research, and an unknown flag followed by a value
still consumes it (backwards compatible). Arena startup now prints the selected dataset count and ids,
whether research is enabled and in which mode, the requested population, the research candidates
discovered, the conventional entrants, and the total entrant count, so a misconfigured experiment is
hard to miss.

### 2. Research genome uniqueness is enforced by digest

A research candidate's canonical identity is `digestOf(genome)`. The previous compiler keyed its
deduplication on a *proposal-scoped* `familyId`, so byte-identical genomes produced by different
proposals were written as separate artifacts and each consumed its own Arena slot. The compiler
(`scripts/research/compiler.mjs`) now:

1. compiles the proposal,
2. computes `digestOf(genome)`,
3. accepts it if the digest is new to the cohort,
4. otherwise **deterministically diversifies inside the region the proposal itself declared** — a
   proposal that declares `[min, max]` has already declared every point in that range acceptable, so a
   collision re-draws a different point from that same range using a seed derived from the proposal id
   and the colliding digest (never random noise, and never outside `GENE_BOUNDS`/compiler limits),
5. recompiles and rechecks, and
6. rejects as `DUPLICATE_GENOME` when there is no declared range to move inside.

Diversification is recorded on the compiled entry (`diversified`, `diversificationAttempt`) and in
research memory. Nothing about it is faithful-by-luck: the same proposals always produce the same
cohort.

### 3. Research novelty metrics

`EVOLVE_RESEARCH_MIN_UNIQUE_RATIO` (default `0.90`) is the minimum fraction of a research cohort that
must be genuinely unique genomes:

```text
uniqueGenomeRatio = uniqueDigests / acceptedResearchEntrants
```

Below the threshold the run emits an explicit warning, and `EVOLVE_RESEARCH_STRICT_UNIQUENESS=1`
refuses to run the Arena with a degraded cohort. Research memory records every duplicate rejection
(`REJECTED_DUPLICATE`) and every diversification, so the cohort is auditable without reconstructing
digests by hand.

### 4. Species/family collapse

Root cause, reproduced against the real persisted artifacts: `compileProposals` stopped after
`maxCompilations` while iterating proposals in order, and the first three proposals were always the
signal / regime / execution roles — whose families were all Momentum blends. So every compiled
candidate was Momentum, and the risk / diversity roles were compiled **zero** times. A second cause
compounded it: the mock provider's per-role parameter regions were constant (except the signal role),
so each role produced the identical genome every cycle.

Fixes, all evidence-driven and none of them a quota:

- the compiler now orders valid compile jobs **round-robin across target families**, so a small
  `maxCompilations` spreads across families instead of taking the first N;
- proposals may declare an explicit `targetSpecies` (enum-validated against the six real species), which
  is what makes **Experimental** reachable at all — it has no preset to blend;
- three additional approved two-preset families were added (`Genesis Hunter x Momentum`,
  `Wallet Flow x Reversal`, `Liquidity x Wallet Flow`) so Wallet Flow and Liquidity are reachable as
  compiled species. They add no new signal and no executable artifact;
- the mock provider now chooses species from the evidence packet (regime, island/species statistics,
  cost drag, under-representation) and only falls back to a deterministic all-species rotation when the
evidence is genuinely silent — so all six species are reachable and the mix is evidence-driven, not a
  hardcoded balanced list;
- `EVOLVE_RESEARCH_MAX_SPECIES_SHARE` (default `0.60`) is a research-**diversity** guard, never a
  performance rule. If one species exceeds the configured share the compiler tries alternative
  evidence-supported proposals, and if none exist it **preserves the proposals and emits an explicit
  concentration warning** rather than fabricating diversity. Arena gates are never weakened.

### 5. Role diversity and role metrics

`adversarial-critic` is a documented **advisory-only** role: it criticizes other researchers'
hypotheses and never originates a compilable proposal, so it consumes no Arena slot. The other five
roles each declare at least one non-degenerate parameter range, so repeated cycles with changing
evidence produce different genomes. Role-level metrics (proposals generated, schema accepted,
compilation accepted, duplicate rejected, unique genomes, Arena entrants, median Arena score, best
Arena rank, gate failures, watchdog NORMAL/WATCH/QUARANTINED) are computed by `roleResearchMetrics()`
from persisted records. Arena score feedback never mutates a future proposal — train/validate/test
separation is untouched, and research memory can only inform future hypotheses through prior
conclusions, exactly as before.

### 6. First-class Arena provenance

Every research entrant now carries `origin`, `familyId`, `proposalId`, `authorRole`, the research
family, `targetRegimes`, `abstainRegimes`, and `researchGenomeDigest`, and that provenance is
propagated into the entrant, `candidates.json`, `leaderboard.json`, the Champion League artifact,
deployment-candidate output, `rounds.json`, and the summary's `researchSummary`. Identifying a research
candidate no longer requires digest reconstruction. When a research seed is later bred, its children are
labelled `identity: "descendant"` with `researchAncestorFamilyIds` / `researchAncestorProposalIds` and
**no** `researchGenomeDigest` — a mutated descendant is never passed off as an exact original research
genome.

### 7. Arena status semantics

`status = ARENA SURVIVOR` never meant "one of the Champion League eight"; it meant "cleared every
deployment gate but was classified a specialist". The concepts are now separate and unambiguous:

| Field | Values |
| --- | --- |
| `gateStatus` / `deploymentGateStatus` | `GATES_PASSED` \| `GATES_FAILED` \| `INSUFFICIENT_EVIDENCE` |
| `deploymentEligible` | `true` only for a Deployment Candidate |
| `highestStage` | the last tournament stage survived (`QUALIFICATION` … `CHAMPION LEAGUE`) |
| `eliminatedAtStage` | the stage that culled the candidate (`null` for a finalist) |
| `finalRank` | 1..n rank over every entrant |
| `isChampionLeagueFinalist` | membership in the explicit `championLeague` list |

Every candidate exposes all of them, and `summary.championLeague` is the Champion League final eight as
an explicit list. The legacy `CANDIDATE_STATUS` labels are retained for the Hall of Fame and the Shadow
League, and promotion now reads explicit stage/gate information (with the legacy status string only as a
fallback for older leaderboards).

### 8. Challenger mode (default) and FAIR COHORT mode

```bash
npm run arena -- --research DATASET                    # challenger (default)
npm run arena -- --research-mode fair DATASET          # equal treatment
```

**`challenger`** preserves the existing behaviour: build the conventional population, pre-evolve it for
`EVOLVE_ARENA_GENERATIONS`, then append fresh research candidates. It answers *can fresh research ideas
beat already-evolved incumbents?*

**`fair`** puts research and conventional seeds into **one mixed cohort** that receives identical
pre-evolution, datasets, seeds, stress profiles, scoring, gates, and generations. Cohort composition is
configurable (`EVOLVE_ARENA_RESEARCH_SHARE`, default `0.5`, or `EVOLVE_ARENA_RESEARCH_COUNT`). If fewer
**unique** research genomes exist than requested, the shortfall is **reported** and absorbed by
conventional seeds — genomes are never cloned to fill a quota (`clonedToFillQuota` is always `0`), and
lineage is preserved so descendants of research seeds remain identifiable. The summary reports starting
research/conventional seeds, final unique research/conventional lineages, median and best score by
ancestry, Champion League representation by ancestry, and deployment representation by ancestry.

### 9. Distinct-mint diagnostics (the gate is unchanged)

22 of the 33 research candidates failed `minimum distinct mints` in the real run. That gate is
**unchanged** (`EVOLVE_DEPLOYMENT_GATES.minDistinctMints = 4`, still frozen). Instead the engine now
records *why* a candidate traded too few mints — opportunities observed, eligible mints after filters,
mints actually entered, blocked entries, abstained ticks, no-eligible-token ticks, below-threshold ticks,
paused ticks, trade count, distinct mints, and the top-mint notional share — and the Arena pools those
into a per-candidate `distinctMintDiagnostics` block with a plain-language `explanation`. The research
system has to learn to produce broader-evidence candidates; the gate is not tuned to let it through.

### 10. Deterministic mock provider (the baseline)

Phase 5A.2 remains offline-testable, deterministic, and reproducible with **no provider key and no
network**. `mock` is still the DEFAULT provider and remains the baseline any other provider must be
compared against. Since Phase 5B there is exactly one additional provider — `deepseek-cline` — which is
**optional, explicitly selected, and never automatic**: it is a hypothesis *source*, and everything
after the hypothesis (schema, compiler, uniqueness, watchdog, Arena, gates, promotion) is the same
deterministic EVOLVE machinery the mock already exercises. See `## Research providers` for the full
contract, the evidence boundary, and the experiment commands. Until a real DeepSeek A/B run is executed
and recorded, every research number in this repository still comes from the deterministic mock.

### 11. Research candidate lifecycle

`PROPOSED → (schema) → REJECTED_SCHEMA` \| `→ (compiler) → REJECTED_COMPILER` \|
`→ (uniqueness) → REJECTED_DUPLICATE` \| `→ COMPILED → injected → TESTING → (watchdog) → WATCH` \|
`QUARANTINED → (Arena) → ARENA_EVALUATED → PROMISING / ARENA_SURVIVOR / SHADOW_ELIGIBLE`. Each record
carries the granular `outcome` next to the coarse, unchanged `status` (`PROPOSED` / `TESTING` /
`REJECTED` / promoted), so no existing reader breaks. `WATCH` candidates continue but are labelled;
`QUARANTINED` can never become deployment/shadow eligible and can never self-clear.

### Commands

```bash
npm run arena -- --research <dataset>           # challenger research cohort (default)
npm run arena -- DATASET --research             # identical, flag after the dataset
npm run arena -- --research=true DATASET        # identical, explicit boolean
npm run arena -- --research-mode fair DATASET   # equal-treatment cohort
EVOLVE_RESEARCH_MIN_UNIQUE_RATIO=0.95 npm run arena -- --research-mode fair <dataset>
EVOLVE_RESEARCH_MAX_SPECIES_SHARE=0.5 EVOLVE_ARENA_RESEARCH_SHARE=0.4 npm run arena -- --research-mode fair <dataset>
npm run validate:phase5a2                       # Phase 5A.2 suite (60 offline cases)
npm run arena -- --research-mode ab DATASET     # matched A/B benchmark (Phase 5A.3)
npm run validate:phase5a3                       # Phase 5A.3 suite (82 offline cases)
```

## Phase 5A.3 — controlled research vs conventional A/B benchmarking

Still **PAPER ONLY**, with no wallet, no signing, and no execution path of any kind. Phase 5A.3 adds
one thing: a way to ask a *controlled* question instead of an encouraging-looking one.

Phase 5A.2's fair mode was a real improvement, but it could not separate "research works" from
"research was most of the population": in the 200-entrant fair run, research ancestry supplied 169
entrants (≈84.5%) against 31 conventional ones, all 8 Champion League finalists were research
descendants, and the research cohort held 47 of the top 50. That is a striking pattern — and it is
**not a controlled comparison**, because the two populations were wildly different sizes.

The question Phase 5A.3 exists to answer is narrow:

> **Does research-guided evolution outperform conventional evolution when both cohorts receive equal
> resources and equal evolutionary treatment?**

The system is *not* tuned toward a positive answer. A null or negative result is a valid outcome, and
the report says so in plain language.

### Three separate research modes

| Mode | Question it answers |
| --- | --- |
| `challenger` (default) | Can fresh research challengers beat already-evolved incumbents? |
| `fair` | What happens when research ancestry participates under equal evolutionary rules in one mixed cohort? |
| `ab` | Does research-guided **initialization** beat a **matched** conventional control under identical resources? |

These are deliberately kept as three different experiments. A/B does not replace either of the others.

### Matched cohort construction and the no-cloning policy

```bash
EVOLVE_ARENA_POPULATION=200 npm run arena -- --research-mode ab <dataset>
```

With `EVOLVE_ARENA_POPULATION=200` a 50/50 A/B test targets **100 research + 100 conventional**.
Sizing is matched, not requested-and-hoped-for:

```text
requestedPerCohort = requested total / 2            (symmetric by construction)
matchedPerCohort   = min(requestedPerCohort,
                         unique research seed genomes,
                         unique conventional seed genomes)
```

If only 42 genuinely unique research genomes exist, the run is **42 vs 42** — never 42 vs 158. The
shortfall is reported (`requestedPerCohort`, `actualPerCohort`, `seedShortage`, `matchedDowngrade`,
`shortageReason`) and startup prints it before anything is evaluated:

```text
[arena] A/B cohorts: research=42 conventional=42 total=84 (requested 100 per cohort)
[arena] A/B unique seeds: research 42 (0 duplicate digest(s) rejected) conventional 100 (...)
[arena] A/B SHORTAGE: matched cohort downgraded to 42 per cohort. only 42 unique research seed ...
[arena] A/B shortage handling: BOTH cohorts were reduced symmetrically — never 42 vs 158, and never by cloning.
```

**A genome is never cloned to fill a slot.** A duplicate seed digest occupies no second slot, on either
side, and `clonedToFillQuota` is always `0`. Descendants may legitimately converge onto the same genome
during evolution; that is recorded as **convergence** (`descendantConvergence`, `repeatedDigests`)
rather than silently de-duplicated.

If a cohort would otherwise be too small to say anything, descendant expansion can be enabled
explicitly (`EVOLVE_ARENA_AB_EXPAND=1`). That grows each cohort to the requested size by **ordinary
evolution under identical rules** — ancestry preserved, seed accounting unchanged — not by duplicating
seeds or jittering duplicates into looking distinct.

### Cohort identity, lineage, and independence

Every entrant and every descendant in A/B mode carries:

- `cohort: research | conventional`
- `lineageId` (digest-derived and stable — never index-derived)
- the original seed digest(s)
- `parentLineageIds`
- `generation` (0 for a founder)
- `identity: exact-original | descendant`, plus `founderKind: seed | immigrant | descendant`
- research family / proposal / author-role ancestry where applicable

**Cross-cohort crossover is disabled for the benchmark.** Research breeds only with research, and
conventional only with conventional: the two cohorts are pre-evolved in complete isolation, each from
its own survivors. `childLineage` still *reports* `crossCohort: true` if it is ever asked to merge two
cohorts, and every artifact records `crossCohortCrossovers` — it must be `0`. Hybrid experiments that
deliberately allow crossing are a different experiment and are not this benchmark.

### Equal evolution, equal scoring, equal evaluation

Neither cohort gets a custom mutation rate, selection rule, survivor fraction, breeder share, immigrant
budget, scoring bonus, or gate. Both are pre-evolved by the same builder with the same parameters; the
only difference between the two calls is the RNG seed label, so the two independent cohorts do not draw
identical random numbers.

Benchmark construction and evaluation are separated, so no cohort can receive evaluation feedback the
other does not:

```text
1. seed creation (unique digests, matched size)
2. equal cohort expansion / pre-evolution (identical rounds, rules, budgets)
3. freeze the two candidate pools
4. ONE shared tournament evaluation — same datasets, windows, seeds, stress profiles, scoring, gates
5. funnel
6. comparative report
```

Both cohorts are evaluated in a **single** `runArenaTournament` call, which is what guarantees dataset,
window, seed, stress, scoring and gate parity rather than merely asserting it. The artifact records it:
`equalStartingSlots`, `equalEvolutionaryRules`, `equalScoring`, `equalGates`,
`scoringBonusForEitherCohort: 0`, `crossCohortCrossover: false`.

### Conventional control construction

**Conventional** means: the ordinary Arena entrant-pool construction the repository already uses —
archived champions re-entering (never protected), mutated/crossover children, and random species
immigrants. It is built to the matched size and de-duplicated by genome digest exactly like the research
side.

Because species mix can move results on its own, an optional **species-matched** control is available:

```bash
EVOLVE_ARENA_AB_SPECIES_MATCHED=1 npm run arena -- --research-mode ab <dataset>
```

That builds fresh standard species/genome controls whose species counts equal the Research cohort's,
removing species composition as a confound. Whether or not it is enabled, the report always prints both
species distributions and `species.matched`, and lists an unmatched species mix as a **limitation**.

#### Strict species matching (Phase 5A.3.1)

Species matching is **enforced at the formal evaluation freeze**, not merely applied to the starting
seeds. Phase 5A.3.1 fixed a real correctness bug: matching used to be applied only to the conventional
SEEDS, while pre-evolution (random-species immigrants + score-based survivor selection) then changed both
cohorts' distributions. A run could therefore request species matching, report
`matchMode: "species-matched"`, and still report `matched: false` — an artifact that looked like a valid
species-controlled baseline but was not one. Matching now works like this:

- the reference distribution is the Research cohort **as naturally produced** (never reshaped, never
  re-sorted by performance);
- the Conventional control is generated to those exact counts, and every control digest is unique —
  no cloning, and no control is ever a copy of a Research genome;
- **both** cohorts then evolve with **independent per-species sub-cohorts** under identical resources
  (same generations, survivor/breeder/mutation/crossover rules, immigrant budget, all quotas), so the
  distribution cannot drift: a species whose members lose the cheap screen falls back to its own members,
  and random immigrants stay inside their species;
- the invariant `speciesCounts(research) === speciesCounts(conventional)` is asserted at the freeze.
  It passes loudly (`species match invariant: PASS`) or the run **stops before evaluation** — nothing is
  evaluated, no artifact is written, and no species-matched claim is made;
- if a requested species cannot be filled with unique controls, **both** cohorts shrink symmetrically by
  the same per-species amount (still: never cloned, never substituted). A match that cannot be built at
  all fails with an explicit reason.

The artifact records `species.requestedMatchMode`, `species.effectiveMatchMode`, `species.matched` and a
`species.invariant` block (reference counts, agreed per-species quotas, shortfall, no-cloning).
`effectiveMatchMode` can never say `species-matched` while `matched` is `false`, and
`species.matchMode` is an alias of the EFFECTIVE mode. The startup log prints the requested flag, the
reference Research species counts and the constructed Conventional counts.

### Metrics

`summary.json` carries a compact `abComparison` block; the full report is written to
`.evolve/arenas/<arena-id>/ab-comparison.json`:

- **Cohort size** — requested, actual, unique seed lineages, unique final genomes, genome diversity,
  descendant convergence, seed duplicates rejected, shortage and reason
- **Arena performance** — best/median/mean score, score quartiles and IQR, best/median rank, top-10 /
  top-25 / top-50 counts, GROUP / STRESS / Champion League counts, deployment count
- **Trading evidence** (paper) — median trades, distinct mints, top-mint notional share, drawdown, net
  paper return, gross paper return, cost drag
- **Robustness** — stress survival (overall, mild, moderate), regime coverage, OOS behaviour, failed-gate
  distribution per cohort
- **Diversity** — unique genome ratio, lineage concentration, species distribution, family distribution
- **Role-lineage** (section below)
- **Distinct-mint diagnostics** (section below)
- **Statistics** — descriptive medians/means/IQRs and a **deterministic** percentile bootstrap of the
  difference (fixed seed and iteration count, so re-running reproduces the interval byte-for-byte)

### Role-level research performance

For every research role (`signal-researcher`, `regime-researcher`, `execution-researcher`,
`risk-researcher`, `diversity-researcher`, `adversarial-critic`) the artifact reports starting unique
seeds, descendants at the freeze, median Arena score, best rank, GROUP / STRESS / Champion League counts,
failed gates, median distinct mints, median drawdown, and median net paper return. A role that produces
no compilable strategy — the adversarial critic is advisory by construction — is reported as
**advisory / inactive**. No entrant is ever fabricated to fill a role.

### Distinct-mint issue: research problem or general problem?

The previous fair run had 38 `minimum distinct mints` failures. The gate is **unchanged**
(`minDistinctMints = 4`, still frozen). Instead the A/B report now shows the same diagnostic block for
**both** cohorts — candidate opportunities, eligible mints, traded mints, distinct mints, blocked /
abstained / below-threshold ticks, failure count against the gate, and a distribution of the recorded
rejection reasons. That is what makes it possible to tell whether narrow market coverage is specific to
research-guided genomes or a general property of the strategy space.

### Interpreting the result

Read the A/B report as an **observation**, not a finding:

- "Research cohort higher/lower/equal on the observed paper metric" — that is the strongest claim made
- no significance test is performed, no p-value is claimed, and `statistics.significance` is `null` with
  an explanation
- sample sizes are small, walk-forward windows overlap by design, and observations within a cohort are
  not statistically independent, so the bootstrap interval describes spread rather than proving anything
- the cohorts are matched by construction, but a difference can still come from species mix (unless
  species-matched mode is on — and then the match is enforced at the freeze, or the run refuses to
  evaluate), from the specific conventional construction chosen, or from luck

**No profitability claim is made anywhere.** A higher paper score in one cohort is not evidence of
future profit, and zero Deployment Candidates remains a completely acceptable outcome.

### A provider experiment (implemented, not yet run)

The A/B benchmark is the instrument built to evaluate a real research provider:

> **DeepSeek V4.1 Flash via Cline, xhigh**

Since Phase 5B that provider exists as `deepseek-cline` behind the same provider interface as the
deterministic mock — optional, explicitly selected, bounded, and with no fallback of any kind. Provider
selection is **fail-closed**: an explicit unregistered name is a configuration error that exits
non-zero, calls nothing, and creates no artifact (it is never served by the mock); leaving the variable
unset uses the deterministic mock. The instrument (strict species-matched A/B, isolation, provenance,
comparison tooling) is ready; the real 58-minute dataset run has **not** been executed here, and no
result is implied. See `## Phase 5B — optional DeepSeek research provider (Cline CLI)` and
`## Roadmap`.

### Commands

```bash
npm run arena -- --research-mode ab <dataset>              # matched A/B benchmark
EVOLVE_ARENA_POPULATION=200 npm run arena -- --research-mode ab <dataset>
EVOLVE_ARENA_AB_EXPAND=1 npm run arena -- --research-mode ab <dataset>          # opt-in descendant expansion
EVOLVE_ARENA_AB_SPECIES_MATCHED=1 npm run arena -- --research-mode ab <dataset> # strict species-matched control
EVOLVE_ARENA_AB_BOOTSTRAP_ITERATIONS=5000 npm run arena -- --research-mode ab <dataset>
EVOLVE_ARENA_WORKERS=8 npm run arena -- --research-mode ab <dataset>
npm run validate:phase5a3                                  # Phase 5A.3 suite (82 offline cases)
npm run validate:phase5a31                                 # Phase 5A.3.1 strict species-match suite (24 offline cases)
```

## Phase 5B — optional DeepSeek research provider (Cline CLI)

Phase 5B adds **DeepSeek V4.1 Flash (via the locally installed Cline CLI) as an OPTIONAL Research Swarm
intelligence provider**. It changes nothing about how EVOLVE trades, tests, scores, gates, or promotes.

```
DeepSeek V4.1 Flash xHigh
  → structured research proposal
  → schema validation
  → deterministic compiler
  → uniqueness / watchdog
  → CPU evolutionary system
  → Arena
  → evidence decides
```

**LLMs think; EVOLVE trades/tests.** DeepSeek does not trade, place orders, touch wallets or keys, sign
anything, build transactions, call Solana write RPCs, alter positions or genomes directly, change Arena
gates or scores, promote itself, decide whether it won, or see future/test/OOS information. Everything
remains **PAPER ONLY**, and **no profitability claim is made anywhere**.

### Provider architecture

| Piece | File | Responsibility |
| --- | --- | --- |
| Provider config + statuses | `scripts/research/provider-config.mjs` | names, model, reasoning, timeout/attempt/call/context budgets, status vocabulary |
| Registry | `scripts/research/provider.mjs` | `mock` (default) and `deepseek-cline`; fail-closed resolution — an explicit unregistered name throws |
| DeepSeek provider | `scripts/research/providers/deepseek-cline.mjs` | one bounded subprocess call per proposal slot, provenance, cache, replay, probe |
| Runtime | `scripts/research/provider-runtime.mjs` | argv construction, spawn (no shell), strict JSON extraction, digests, cache/replay store, provider-state summary |
| Prompt contract | `scripts/research/prompt.mjs` | versioned, role-aware, single-JSON-object contract |
| Evidence packet | `scripts/research/evidence-packet.mjs` | versioned TRAIN-only packet, digesting, memory projection, context budget, leak audit |
| Experiment identity | `scripts/research/experiment.mjs` | `experiment.json` counters + isolated root naming |
| Cohort runner | `scripts/research/cohort-runner.mjs` | bounded generate → validate → compile → record pipeline |
| CLI | `scripts/research.mjs` | bounded cohort generation / stats / listing |
| CLI | `scripts/probe-research-provider.mjs` | cheap structured provider probe |
| CLI | `scripts/research-compare.mjs` | within-run A/B delta comparison (mock vs DeepSeek) |

### Research providers

Mock (default, deterministic baseline):

```bash
EVOLVE_RESEARCH_PROVIDER=mock
```

DeepSeek (optional, explicit):

```bash
EVOLVE_RESEARCH_PROVIDER=deepseek-cline
EVOLVE_RESEARCH_MODEL=deepseek/deepseek-v4.1-flash
EVOLVE_RESEARCH_REASONING=xhigh
```

- **mock is the default** and stays deterministic, reproducible, offline, subprocess-free, and usable
  when Cline is unavailable. It is the baseline every other provider is compared against.
- **DeepSeek proposes hypotheses only.** It never trades and never touches a wallet, key, order, or RPC.
- **The deterministic compiler controls genomes.** DeepSeek cannot add genome fields, change bounds, or
  smuggle a non-whitelisted key; the existing schema and compiler remain authoritative.
- **The CPU engine performs evolution** and **the Arena decides through evidence.** Gates, scores,
  stress, walk-forward, and promotion are untouched.
- **Selection is explicit and fail-closed.** Leaving `EVOLVE_RESEARCH_PROVIDER` unset (or empty)
  uses the deterministic `mock`. An explicit name must be registered: `mock` or `deepseek-cline`.
  **Any other explicit name is a configuration error** — the CLI exits non-zero, no provider is
  called, no proposals are generated, and no experiment artifact is created, so a typo like
  `deepseek-clnie` can never masquerade as a valid mock or DeepSeek experiment:
  `Unknown research provider: deepseek-clnie`.
- **There is no provider fallback during an experiment.** Not from an invalid name to the mock, and not
  from a failing `deepseek-cline` to the mock: a provider failure is recorded as a provider-failure
  status (`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_PROCESS_ERROR`,
  `PROVIDER_INVALID_OUTPUT`, `PROVIDER_SCHEMA_REJECTED`, `PROVIDER_BUDGET_EXCEEDED`) and the run
  reports it. The live engine behaves the same way: an invalid provider disables research for that
  process, reports `providerState.health = PROVIDER_CONFIG_ERROR` plus the requested name on the
  dashboard, and never substitutes the mock.

### Fail-closed provider selection (Phase 5B.1)

| `EVOLVE_RESEARCH_PROVIDER` | Behaviour |
| --- | --- |
| unset / empty | deterministic **`mock`** (the default; no subprocess, no network) |
| `mock` | deterministic **`mock`** |
| `deepseek-cline` | **DeepSeek V4.1 Flash** via the local Cline CLI (`xhigh`) |
| anything else (e.g. `deepseek-clnie`) | **configuration error**: `Unknown research provider: deepseek-clnie` — exit code 2, no provider call, no proposals, no experiment artifact |

- No provider fallback exists anywhere during an experiment: an invalid name resolves to **no** provider
  (never the mock), and a failing `deepseek-cline` produces provider-failure statuses (never mock
  proposals).
- The same rule applies to `npm run research`, `npm run probe:research-provider`, experiment
  construction, and the live engine (which disables research and reports
  `providerState.health = PROVIDER_CONFIG_ERROR` instead of silently using the mock while keeping the
  paper trading loop running).
- Provider experiment metadata always names the provider that was actually used.

### Evidence boundary (no look-ahead)

The provider receives exactly one **versioned evidence packet** (`packetVersion`), built from
`TRAIN_EVIDENCE` only: TRAIN-window regime classifications, permitted family/species coverage counts,
aggregate market feature distributions inside TRAIN intervals, and a filtered view of research memory.
`VALIDATION` / `TEST` / `OOS` / `STRESS` / `DEPLOYMENT` classes are declared **excluded** inside the
packet; the memory projection keeps only `{proposalId, authorRole, status, outcome, conclusion}` (so a
score, rank, return, or mint name cannot travel through it); quarantined and provider-error records are
dropped; and `auditEvidencePacket()` walks the packet for forbidden keys (`oosReturn`, `finalRank`,
`deploymentStatus`, `futureSnapshots`, `hiddenLabel`, credential-shaped names, …). Context is bounded
(`EVOLVE_RESEARCH_MAX_CONTEXT_CHARS`, `EVOLVE_RESEARCH_MAX_MEMORY_RECORDS`), truncation is
deterministic and recorded, and the **evidence digest** (which excludes the clock) is what the cache is
keyed on — so a cached proposal can never be reused across a different evidence packet.

### Strict structured output, provenance, replay

The prompt asks for **exactly one JSON object, no Markdown**. Extraction tries a direct parse, then a
single fenced block, then exactly one balanced object in the surrounding text; zero objects, several
objects, a top-level array, or a truncated payload are **rejected** — nothing is ever "repaired" by
inventing strategy values. Every call (accepted or rejected) records provider, model, reasoning, prompt
version, evidence-packet version, evidence digest, prompt digest, raw-output digest, provider run id,
request start/completion timestamps, latency, author role, token usage, and status — never credentials,
never the raw prompt, never the raw response body. Each accepted proposal is persisted under the
experiment's `provider/outputs/` so it can be **replayed without calling the model at all**, which is
how LLM variability is separated from EVOLVE evaluation variability. Caching is explicit and off by
default (`EVOLVE_RESEARCH_PROVIDER_CACHE=1`), and the CLI call is bounded by
`EVOLVE_RESEARCH_PROVIDER_TIMEOUT_MS`, `EVOLVE_RESEARCH_MAX_PROVIDER_CALLS`, and the response/stream
size caps.

### Security posture

The CLI is spawned with `spawn(command, argv[])` — **never** through a shell, so the prompt (which
carries evidence text) is one argv element and cannot become a command. `--auto-approve false` is
passed so the model has no tools to act with, and the subprocess runs in a dedicated empty work
directory. Model output is untrusted DATA: it is parsed as JSON, validated against the existing
proposal schema, and compiled by the deterministic compiler. Nothing the model emits is executed,
fetched, or treated as a path. A static scan in `npm run validate:phase5b` enforces that no Phase 5B
module contains a wallet/signing/execution path.

### Experiment isolation

A provider experiment gets a fresh identity and its own root:

```
.evolve/research/experiments/<experiment-id>/
  experiment.json      provider, model, reasoning, promptVersion, evidenceDigest, counters
  proposals/ compiled/ memory/ conclusions.json      the usual research memory
  provider/ runs/ outputs/ cache/ workdir/           provider artifacts
```

The canonical mock baseline (`.evolve/arenas/arena-20260918T081727Z`) and the existing
`.evolve/research` memory are never touched, and the baseline is never reinterpreted retrospectively.
The Arena reads an experiment by pointing `EVOLVE_RESEARCH_ROOT` at it.

### Commands

```bash
npm run probe:research-provider                    # cheap structured provider probe (no Arena/champion mutation)
npm run probe:research-provider -- --provider mock  # probe the offline baseline

# generate a FRESH, bounded DeepSeek research cohort (never the existing mock genomes)
EVOLVE_RESEARCH_PROVIDER=deepseek-cline npm run research -- \
  --cycles 1 --roles signal-researcher,regime-researcher,execution-researcher,risk-researcher,diversity-researcher \
  --max-calls 12 --dataset .evolve/history/2026-09-17/session-20260917T164922Z-live

npm run research -- --stats --experiment <experiment-id>   # proposals / unique genomes / species / family / role stats
npm run research -- --list-experiments

# eventual strict species-matched A/B against the SAME dataset as the mock baseline
EVOLVE_RESEARCH_ROOT=.evolve/research/experiments/<experiment-id> \
EVOLVE_ARENA_AB_SPECIES_MATCHED=1 EVOLVE_ARENA_POPULATION=200 \
npm run arena -- --research-mode ab .evolve/history/2026-09-17/session-20260917T164922Z-live

# compare that arena with the canonical mock control, using WITHIN-RUN deltas
npm run compare:research -- --mock arena-20260918T081727Z --deepseek <new-arena-id>

npm run validate:phase5b                           # Phase 5B suite (96 offline cases, stub Cline, no network)
```

The comparison unit is `Research arm − its own matched Conventional arm` for each run, then the
deltas are compared. Raw DeepSeek-Research against raw Mock-Research is deliberately NOT the headline:
if the matched control populations differ, that would measure the controls. No verdict is manufactured,
and a null or worse result remains a valid outcome.

Every A/B number comes from `ab-comparison.json`'s **cohort membership** (`cohort === research` vs
`cohort === conventional`) — never from the ancestry flag `isResearch`, and never from the ancestry-only
`researchSummary` counts (an arm entrant can legitimately carry zero research ancestry). The report
separates seven blocks: experiment metadata, the mock within-run A/B, the DeepSeek within-run A/B, the
delta-of-deltas, research-generation characteristics, cohort comparability, and limitations. Lower-is-
better metrics (cost drag, drawdown, final rank) keep their raw sign; direction travels as separate
metadata, and `verdict`/`significance` stay `null`.

### Operational note

`mock` is the default everywhere, so nothing in the normal engine loop ever waits on a model. If an
external provider IS selected for the live engine, a research cycle awaits one bounded call per slot
(`EVOLVE_RESEARCH_PROVIDER_TIMEOUT_MS`), which bounds — but can still delay — that tick; a provider
failure is caught, recorded as a provider status, and the paper engine continues. For real provider
experiments, prefer the bounded cohort command above (generate once, then point the Arena at the
experiment root), which keeps the live loop on the deterministic mock.

## Phase 5C — Multi-Dataset Replication

Still **PAPER ONLY**, with no wallet, no signing, and no execution path of any kind. Phase 5C does
not add any new capability to trade, and it does not tune anything.

Phase 5B answered a narrow question on **one development dataset**: did the DeepSeek research cohort
beat the deterministic mock cohort in a matched A/B Arena on
`session-20260917T164922Z-live`? The answer was an observation, not a result — no significance claim
and no winner. Phase 5C asks a different question:

> **Do the observed Research-vs-Conventional deltas REPLICATE across independent market samples?**

### What Phase 5C is (and is not)

```text
frozen Mock research cohort
  + frozen DeepSeek research cohort
  + multiple INDEPENDENT real datasets
  + the SAME strict, species-matched A/B Arena
  → per-dataset within-run deltas
  → cross-dataset descriptive replication analysis
```

Key properties, stated plainly:

- **Research cohorts are frozen.** Primary replication never asks DeepSeek for new hypotheses. Phase 5C
  tests whether an *already-created* cohort generalizes, not whether a model can write a different
  strategy after seeing each dataset. That would be research generation, not replication.
- **Primary replication makes ZERO LLM calls.** The frozen cohort is a directory of compiled genomes;
  the Arena reads it with `EVOLVE_RESEARCH_ROOT` and generates each provider's own conventional control
  deterministically. `freeze.replication.llmCallsRequired` is `false` and the runner pins
  `EVOLVE_RESEARCH_PROVIDER=mock` so no external provider is even resolvable.
- **New datasets must be independent real captures.** A capture is a replication dataset only if it is
  `REAL` (live-only), `complete`, fingerprinted, long enough, rich enough, has zero temporal overlap
  with the already-selected datasets, and is not fingerprint-identical to one already counted.
- **Internal species matching remains per provider × dataset.** The Mock arm is matched to its own
  conventional control; the DeepSeek arm is matched to *its* own control. The two provider arms are
  deliberately **not** species-identical to each other — that is what keeps the provider comparison
  honest.
- **The unit of replication is the DATASET.** Individual genomes are never pooled across datasets as
  independent observations, and walk-forward windows sliced out of one capture are never treated as
  separate datasets.
- **Synthetic does not count as real**, mixed data does not count as real, and an interrupted
  (`recording`) capture is not a replication sample — a `*-live` directory is validated, never assumed.
- **Overlapping datasets do not count independently.** Overlap duration and both overlap fractions are
  computed; any overlap marks the pair `NOT_INDEPENDENT` and excludes the later capture.
- **No tuning from replication outcomes.** Eligibility is performance-blind by construction: no
  eligibility function ever receives a score, return, rank, or gate outcome.
- **Descriptive statistics only.** No significance test, no p-value, `significance: null`,
  `verdict: null`. Uncertainty, where shown, is a deterministic **dataset-level** bootstrap.
- **No profitability claim.** A replication status describes observed paper deltas. Nothing here
  predicts profit, and zero Deployment Candidates remains a perfectly acceptable outcome.

### The freeze artifact

`npm run replicate:research -- --verify-freeze` compares the LIVE code/config against
`.evolve/replication/phase5c-freeze.json` and **fails** on critical drift — a changed Arena score
version, generations, gate table, prompt version, proposal-schema version, evidence-packet version,
compiler version, watchdog version, species-match mode, or DeepSeek model/reasoning would all be a
different experiment and are refused. Advisory (non-fatal) drift is reported separately. The
`freezeDigest` is deterministic (it excludes only the wall-clock `createdAt`), and every replication
unit records it.

### Frozen cohorts

```text
.evolve/replication/cohorts/<key>/
  compiled/F-*.json        exactly the frozen genomes (Arena-readable)
  experiment.json          provider provenance, when the source recorded one
  cohort-manifest.json     genome digest, species, family, proposal/role ancestry, cohortDigest
```

Two cohorts are frozen, from sources that are **never mutated**:

| Cohort | Source | Provider |
| --- | --- | --- |
| `mock` | `.evolve/research` (the canonical mock A/B cohort) | `mock` (deterministic, offline) |
| `deepseek` | `exp-20260918T115857Z-deepseek-cline-a7abe2` | `deepseek-cline` / `deepseek/deepseek-v4.1-flash` (`xhigh`) |

A research root is staged per unit, so a run's Arena promotion step can never write into the frozen
artifact or into the historical `.evolve/research` memory.

### Dataset registry, independence, leakage, eligibility

```bash
npm run datasets:research          # human table
npm run datasets:research -- --json
```

Every dataset under `.evolve/history` is classified `REAL` / `SYNTHETIC` / `MIXED` / `INVALID` and
validated (manifest present, `complete`, fingerprint valid, positive duration, snapshots present).
The report includes id, path, fingerprint, start/end, duration, snapshots, observations, unique mints,
feed source, capture interval, completion state, error counts, temporal overlap with every other REAL
capture (with both overlap fractions), the eligibility decision and its reasons, and the
`DEVELOPMENT` / `REPLICATION` / `CONTAMINATED` / `UNKNOWN` / `INELIGIBLE` / `NON_REAL` / `INVALID` role.

The **leakage matrix** classifies every (cohort × dataset) pair:

| Class | Meaning |
| --- | --- |
| `DEVELOPMENT` | the development/original-benchmark dataset — never an independent replication sample |
| `CONTAMINATED` | used to generate a cohort's TRAIN evidence, recorded in a prior manual decision, or evaluated by a prior Arena (Arena/gate tuning exposure) |
| `CLEAN_REPLICATION` | no recorded use by research generation, compiler/arena/gate tuning, or a prior manual decision |
| `UNKNOWN` | the provenance records needed to decide are unavailable — conservatively NOT eligible |

Only `CLEAN_REPLICATION` pairs may support a cross-dataset generalization statement.

### Running replication

Exactly **one action runs per invocation**. `--write-freeze`, `--verify-freeze`, `--cohorts`, `--plan`
and `--summary` are actions, not additive flags; combining two of them is a hard error rather than a
silent pick, and `--rerun`/`--dev` only apply to the normal replication run.

```bash
npm run replicate:research -- --write-freeze       # write/update the freeze, print its digest, and STOP
npm run replicate:research -- --verify-freeze      # verify only: FAIL on critical config drift
npm run replicate:research -- --cohorts            # print the frozen cohort manifests (read-only; nothing is created or rewritten)
npm run replicate:research -- --plan               # deterministic plan, no Arena is run
npm run replicate:research -- --summary            # cross-dataset summary, read from existing artifacts
npm run replicate:research -- --freeze phase5c --datasets auto
npm run replicate:research -- --datasets session-A,session-B
```

`--write-freeze` writes the freeze artifact and nothing else: no cohorts are frozen, no dataset is
discovered, no plan is built, no Arena subprocess is started, and zero replication units execute. Only
the normal run (no action flag) may plan or execute replication, and it requires a freeze artifact to
already exist — a run can never certify itself against a freeze it just created.

Every command is **read-only with respect to the frozen cohorts**. `--plan`, `--summary`,
`--meta-summary`, `--verify-freeze`, `--cohorts` and the normal run all load the immutable frozen
cohorts through a non-mutating loader (`loadFrozenCohorts`) and never create or rewrite a
`cohort-manifest.json`; a missing cohort fails closed instead of being silently created. The
`freezeDigest` recorded in a cohort manifest is a creation-time provenance back-reference, not a
per-wave mutable slot, so a wave that only *references* the frozen Mock/DeepSeek cohorts leaves their
manifests byte-identical. Only the explicit freeze-creation lifecycle (`--write-freeze`,
`--write-freeze --wave <id>`) writes freeze/cohort bindings.

For each eligible dataset the runner executes the same strict species-matched A/B experiment twice —
once with the frozen Mock cohort, once with the frozen DeepSeek cohort — each against its own freshly
generated deterministic conventional control. Execution is **synchronous and resumable**: the run
manifest is rewritten after every completed unit, finished units are never redone, failed units are
retried on resume, and `--rerun` re-executes a completed unit only when explicitly asked (labelled
with the unit it replaces). There is no daemon and no hidden background process.

Run identity is deterministic: `rep-<digest>` over the freeze digest, the frozen cohort digests, the
providers, and the frozen evaluation config; `unit-<digest>` over the replication id, provider, dataset
fingerprint, and cohort digest. Re-running the identical experiment reproduces the identical ids and is
detected rather than silently replaced. A run whose commit or working tree does not match the freeze is
refused unless `--dev` is passed, and is then permanently labelled `NON_CANONICAL`.

### Aggregation

For each dataset with both providers complete:

```text
mockDelta     = Mock     research arm − its own matched conventional arm
deepseekDelta = DeepSeek research arm − its own matched conventional arm
deltaOfDeltas = deepseekDelta − mockDelta        (the SAME dataset)
```

Cross-dataset aggregation then reports, per metric: n, per-dataset delta, median, mean, min, max, q1,
q3, positive/negative/zero counts, and direction consistency. Lower-is-better metrics (cost drag,
drawdown, final rank) keep their **raw** sign — `direction` is metadata only, and nothing is rewritten
into an artificial benefit. If at least three CLEAN datasets exist, leave-one-dataset-out sensitivity
is reported (labelled sensitivity analysis, never cross-validation). Regime composition is read-only
context from the existing classifier; no threshold is fitted.

Replication status vocabulary (descriptive, not a rating):

| CLEAN datasets with both providers COMPLETED | Status |
| --- | --- |
| 0 | `NO_REPLICATION_EVIDENCE` |
| 1 | `SINGLE_REPLICATION` |
| 2 | `LIMITED_REPLICATION` |
| 3+ | `MULTI_DATASET_REPLICATION` |
| fewer than 2 eligible CLEAN datasets SELECTED | `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` |

### Minimum-dataset policy

Walk-forward windows from one capture are **not** independent datasets, and Phase 5C never manufactures
extra datasets by slicing one hour-long capture into pseudo-independent pieces. If the repository does
not hold enough independent clean real captures, the correct result is
`INSUFFICIENT_INDEPENDENT_REAL_DATASETS`: the implementation is complete and the replication run simply
waits for future captures. Real market history is collected with the existing, unmodified commands:

```bash
EVOLVE_MARKET_MODE=live npm run record:market -- --minutes 60 --interval 5000
```

Capture separate sessions at different times and regimes, let each run finalize (`complete`, with a
fingerprint), and do not change capture behavior, endpoints, or filters to influence how a strategy
scores. Observation remains strictly read-only.

### Readiness, execution and evidence

Three different questions used to be answered by one field, which made `--plan` contradict itself:
a plan executes **zero** units, so a completed-units-derived status could only ever say
`INSUFFICIENT_INDEPENDENT_REAL_DATASETS` — even for a plan that had selected three eligible CLEAN
datasets and printed "Clean independent real replication datasets available: 3". Plan reporting now
keeps the three questions separate, and no gate is weakened by it:

| Statement | Derived from | Values |
| --- | --- | --- |
| `datasetReadiness` | the **SELECTED** eligible `CLEAN_REPLICATION` datasets | `MULTI_DATASET_REPLICATION` (3+), `LIMITED_REPLICATION` (2), else `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` |
| `executionStatus` | the planned units' own recorded statuses | `PLANNED` while every unit is still `PENDING`, then `RUNNING` / `PARTIAL_RUNNING` / `COMPLETED` / `PARTIAL_FAILED` / `FAILED` / `SKIPPED` |
| `evidenceStatus` | datasets with **both providers COMPLETED** | `NO_REPLICATION_EVIDENCE`, `SINGLE_REPLICATION`, `LIMITED_REPLICATION`, `MULTI_DATASET_REPLICATION` — or `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` when the SELECTION itself was short |

So a plan with three eligible datasets, six planned units and zero executed units reports
`replicationStatus: PLANNED`, `datasetReadiness: MULTI_DATASET_REPLICATION`, `executionStatus: PLANNED`,
`evidenceStatus: NO_REPLICATION_EVIDENCE` and `completedDatasets: 0` — never "insufficient independent
datasets". `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` still means exactly one thing everywhere: not enough
ELIGIBLE independent datasets were selected/available (0 or 1 clean dataset), which is also when the
capture guidance is printed. A completed run keeps reporting exactly what it reported before — the plan
projection is additive reporting, never a replacement for the summary.

### Commands

```bash
npm run replicate:research -- --cohorts
npm run replicate:research -- --verify-freeze
npm run replicate:research -- --plan
npm run replicate:research -- --freeze phase5c --datasets auto
npm run replicate:research -- --summary
npm run datasets:research
npm run validate:phase5c
```

### Dashboard

The Research/Arena state carries a compact `replication` block (freeze digest, real datasets, clean
replication datasets, frozen cohort counts, completed/pending/failed units, current replication
status) and a small Phase 5C panel. It reads only tiny artifacts — never the full per-dataset metric
tables — and exposes no credentials.

## Phase 5C.2 — Replication Waves

Still **PAPER ONLY**. Phase 5C.1 made the replication CLI an exclusive action-per-invocation tool.
Phase 5C.2 adds **waves**: a prospective set of datasets is declared by name, with pinned
fingerprints, *before* anything is evaluated — so a new wave is never silently mixed with an
already-completed one by `--datasets auto`.

### Why waves exist

Once a second wave of captures exists, `--datasets auto` would select the first wave's datasets
too, silently turning a prospective replication into a rerun of already-published evidence. A wave
manifest fixes membership up front and fails closed on anything else.

### Wave manifest

```text
.evolve/replication/waves/wave-2.json
```

| field | meaning |
|---|---|
| `version` / `waveId` / `phase` | versioned wave identity (`5C.2`) |
| `freezeDigest` | the frozen experiment the wave runs under |
| `mockCohortDigest` / `deepseekCohortDigest` | the two **frozen** research cohorts |
| `datasetIds` | the **predeclared** membership, in order |
| `datasetFingerprints` | each member's pinned SHA-256 capture fingerprint |
| `priorWaveIds` | waves that must not be reused |
| `excludedDatasetIds` | explicitly excluded ids (Wave 1) |
| `status` / `notes` / `createdAt` | lifecycle + prose (never digested) |
| `replicationId` | the derived wave-bound replication id (never digested) |
| `manifestDigest` | deterministic digest of the definition |

The digest is computed over every definition field with the clock and lifecycle removed, so
rebuilding the same logical wave at a different second — or after its status flips — yields the
**same** digest, while changing membership or a fingerprint changes it.

### Waves

* **Wave 1** (`wave-1`) is **HISTORICAL**: it points at the already-evaluated canonical replication
  `rep-66884de4e460`. It is derived read-only from existing facts and is never re-run or rewritten.
* **Wave 2** (`wave-2`) is **PROSPECTIVE**: exactly three untouched REAL captures
  (`session-20260919T040641Z-live`, `session-20260919T051349Z-live`, `session-20260919T062122Z-live`),
  with pinned fingerprints, evaluated against the **same** frozen Mock and frozen DeepSeek cohorts.
  Wave 1 ids are explicitly excluded. Membership is predeclared and performance-blind: no outcome,
  Arena result or metric informed the list.

Wave 2's replication identity binds the wave manifest digest, so it is deterministic
(`rep-6198716691c8`) and can never equal the canonical Wave 1 id.

### Wave validation (fail closed)

Before a wave plan/run/summary runs, every declared dataset must exist, match its pinned fingerprint,
be REAL, be `CLEAN_REPLICATION`, satisfy the existing Phase 5C eligibility criteria, carry a unique
fingerprint, and not overlap another member in time. Membership must not reuse any dataset from a
completed prior wave, must explicitly exclude prior-wave ids, must match the frozen cohort digests and
the stored freeze, must declare no Jev participation and no required provider call. Any failure aborts
the command before a plan is built.

### Wave plan

`--wave wave-2 --plan` yields exactly `3 datasets × 2 frozen cohorts = 6 units` — dataset × Mock and
dataset × DeepSeek for each of the three Wave 2 captures. No Wave 1 dataset appears, and no provider
is called (the frozen cohorts already exist as compiled genomes).

### Wave and cross-wave summaries

Each completed wave has its own summary, aggregated at the **dataset** level (never pooling genomes,
never counting walk-forward windows as independent). Delta-of-deltas are paired `DeepSeek − Mock` on
the same dataset; medians/means/min/max/q1/q3, +/-/0 counts, direction consistency, a deterministic
dataset-level bootstrap and leave-one-dataset-out sensitivity are reported, with `significance: null`
and `verdict: null`.

The **meta-summary** is a read-only roll-up across named waves. It reads already-completed wave
manifests and summaries, never re-runs a dataset, and reports total clean datasets, datasets per wave,
wave-level and combined dataset-level statistics, per-dataset delta-of-deltas, between-wave descriptive
differences, and optional leave-one-wave-out sensitivity. **It is not cross-validation** and makes no
profitability claim. Phase 5D / Jev does not participate in any wave.

### Commands

```bash
npm run replicate:research -- --wave wave-2 --plan        # plan the predeclared wave (zero Arena)
npm run replicate:research -- --wave wave-2 --summary     # summarize the wave's own run artifacts
npm run replicate:research -- --wave wave-2 --dev         # run the wave (the ONLY execution path)
npm run replicate:research -- --meta-summary              # read-only Wave 1 + Wave 2 meta-summary
npm run validate:phase5c2
```

### Isolation

Wave support does not touch Wave 1, the historical freeze, the frozen Mock/DeepSeek cohorts, the
Wave 2 captures, or any Phase 5D / Jev state. The canonical `rep-66884de4e460`, the freeze digest and
the cohort digests stay byte-identical; the wave-less replication identity is reproduced exactly.

## Phase 5C.3 — Canonical Per-Wave Freezes

Phase 5C.2 introduced waves, but a wave was still expected to run against the **historical root freeze**.
Because the full freeze digest digests the git commit, running a NEW wave against the OLD freeze could
only be done with `--dev`, which made that wave `NON_CANONICAL`. Phase 5C.3 fixes that properly, without
weakening freeze integrity and without rewriting Wave 1.

### Per-wave freezes

| | Wave 1 | Wave 2 |
| --- | --- | --- |
| freeze path | `.evolve/replication/phase5c-freeze.json` (historical, frozen) | `.evolve/replication/freezes/wave-2.json` |
| freeze digest | `4959974d1b78635e63c0d9038c582c9ceb5a7411366d9c95c82e7ee3bac3f500` | generated after the source commit lands |
| full freeze canonicality | canonical against freeze A | canonical against freeze B |
| evaluation contract | `evaluationContractDigest` (clock- and commit-independent) | must EQUAL Wave 1's |

The wave manifest records `freezePath`, `freezeDigest` and `evaluationContractDigest`, so every run is
tied to the exact freeze it was canonical against. Wave 1 keeps referencing its historical evidence: its
freeze, its replication `rep-66884de4e460`, its frozen Mock/DeepSeek cohort digests, and its three
datasets stay byte-identical forever, and Wave 1 is never re-run.

A wave freeze is **generated, not inferred**:

```bash
npm run replicate:research -- --write-freeze --wave wave-2   # clean tree required; writes ONLY that freeze
npm run replicate:research -- --verify-freeze --wave wave-2  # fail-closed verification
npm run replicate:research -- --wave wave-2 --plan           # inspect the plan (zero Arena)
npm run replicate:research -- --wave wave-2                  # canonical run (NO --dev)
```

`--write-freeze` captures the current `HEAD`, uses the wave's own evaluation configuration and the SAME
frozen Mock/DeepSeek cohorts, binds the manifest to the new freeze digest and evaluation contract,
recomputes the manifest digest and replication id, executes **zero** Arena units, **zero** Jev calls and
**zero** DeepSeek calls, and returns immediately. A normal `RUN` never auto-creates a freeze: a missing or
stale freeze fails closed.

### Full freeze canonicality vs. cross-wave comparability

These are deliberately two different questions:

- **FULL FREEZE CANONICALITY** — "was this run executed by the exact commit/config its freeze pins?" This
  uses the complete freeze digest, which continues to include the git commit and all canonical
  provenance. Wave 1 is canonical against freeze A; Wave 2 is canonical against freeze B; A ≠ B is
  expected and fine.
- **CROSS-WAVE COMPARABILITY** — "may these two waves be aggregated?" This is decided by the
  **evaluation contract digest** plus both frozen cohort digests. Different evaluator semantics can
  never be combined.

The evaluation contract digest is a deterministic digest of the experiment/evaluator semantics only:
Arena scoring version/config, gate definitions, population/generations/seeds, worker and equivalence
semantics, stress profiles, survivor fraction, breeder/mutation/crossover/immigration settings, strict
species matching, no-cloning semantics, cross-cohort crossover behaviour, normalized bankroll semantics,
cost model, drawdown and concentration definitions, evidence thresholds, regime handling, bootstrap
configuration, dataset-as-unit aggregation, the PAPER-only setting, frozen-provider evaluation
semantics, and A/B comparison semantics.

**Excluded** (orchestration/provenance only, nothing that can change an evaluation result): the git
commit, `createdAt`, `waveId`, artifact paths and the manifest path. Including or excluding these is
enforced as explicit lists (`CONTRACT_EXCLUDED_FIELDS`) and proven by test: a commit-only change moves
the full freeze digest while leaving the evaluation contract digest untouched, and adding/changing
intelligence or Jev orchestration code does exactly the same — while a change to Arena scoring, a gate,
population, generations, control flow, the cost model or the cohort identity DOES move the contract.

### Incomparable waves are refused

`--meta-summary` compares the evaluation contract digests (and both cohort digests) before aggregating
anything. If they differ it returns:

```
INCOMPARABLE_WAVES
```

with the explicit differing fields, and aggregates **nothing** — it never silently combines waves.

### Noncanonical evidence

`--dev` still exists for forensic/debug work, but `--dev` runs are `NON_CANONICAL`, are excluded from the
canonical meta-summary by default, and are never the documented way to run a wave.

## Phase 5D — Jev Shadow Supervisor

Jev ("TypeSafe AI"'s System One model) is integrated as a **SHADOW DECISION SUPERVISOR**: a fast,
typed-judgment API that observes bounded TRAIN-safe evidence and returns typed
probabilities/choices/scores. Jev **THINKS FAST**; **EVOLVE still DECIDES**.

**Jev does not trade. Jev does not generate strategies. Jev does not alter Arena outcomes.** It has
ZERO authority over trading, genome construction, research compilation, evolution, Arena scoring,
gates, species matching, DeepSeek calls, deployment eligibility, or replication. Every prediction is
recorded and timestamped *before* any outcome exists; calibration against real deterministic outcomes
happens later, offline, without ever calling Jev again. A bad Jev result is an acceptable, expected
outcome — no threshold is promoted to an operational gate from one experiment.

Architecture:

```
deterministic EVOLVE state
  -> bounded TRAIN-safe decision packet   (scripts/jev/decision-packet.mjs)
  -> Jev typed questions                  (scripts/jev/questions.mjs)
  -> shadow prediction                    (scripts/jev/decide.mjs)
  -> persisted immutable prediction       (scripts/jev/experiment.mjs)
  -> normal deterministic EVOLVE proceeds UNCHANGED
  -> (later) outcomes occur
  -> calibration comparison               (scripts/jev/calibration.mjs, offline, no provider call)
```

### Provider (`scripts/jev/`)

A dedicated provider subsystem, entirely separate from the research-provider abstraction in
`scripts/research/`. Jev is **not** a research proposal provider, and neither namespace can select
the other's provider.

| Provider | Selected by | Transport | Upstream | Credential | Behavior |
| --- | --- | --- | --- | --- | --- |
| *(unset)* | default | — | — | — | **DISABLED** — every call records `JEV_DISABLED` / `NO_JEV_DECISION`, zero network calls are ever possible |
| `mock-jev` | `EVOLVE_JEV_PROVIDER=mock-jev` | offline | `evolve-mock` | none | deterministic, offline, no network — the offline test baseline |
| `typesafe-jev` | `EVOLVE_JEV_PROVIDER=typesafe-jev` | `typesafe-sdk` | `typesafe-ai` | `EVOLVE_JEV_API_KEY` | the real TypeSafe AI HTTP provider (DIRECT), through the official `@typesafe-ai/sdk` |
| `vercel-jev` | `EVOLVE_JEV_PROVIDER=vercel-jev` | `vercel-ai-gateway` | `typesafe-ai` | `AI_GATEWAY_API_KEY` | the same model through the Vercel AI Gateway, using the AI SDK `experimental_evaluate` API |

Selection is fail-closed: an unrecognized explicit name throws `UnknownJevProviderError` — there is no
fallback to `mock-jev` and no silent disabled state for a typo. `EVOLVE_JEV_MODE` must be `shadow`
(the only supported operational mode in Phase 5D); `active`/`enforce`/`trade`/`route` do not exist yet.

#### Two real routes, two different credentials (no substitution, ever)

`typesafe-jev` and `vercel-jev` reach the **same upstream model** (`typesafe-ai`) by **different routes**,
and each route uses a **different credential** that belongs to a different service:

| Route | Endpoint | Credential | Which key belongs here |
| --- | --- | --- | --- |
| `typesafe-jev` | `https://api.typesafe.ai/v1/systemone` (official SDK) | `EVOLVE_JEV_API_KEY` | a **TypeSafe AI** API key |
| `vercel-jev` | the Vercel AI Gateway evaluation-model transport | `AI_GATEWAY_API_KEY` | a **Vercel AI Gateway** key |

- **A Vercel AI Gateway key must not be sent directly to `api.typesafe.ai`.** It is a Vercel credential,
  not a TypeSafe AI key; `typesafe-jev` would be rejected (or, worse, would look like a bad key) if it were
  placed in `EVOLVE_JEV_API_KEY`. The reverse is equally true: a TypeSafe AI key is not a gateway key.
- **The two variables are never copied into one another.** `AI_GATEWAY_API_KEY` is read into its own
  `gatewayApiKey` field and is only ever used by the `vercel-jev` provider; `EVOLVE_JEV_API_KEY` is only
  ever used by `typesafe-jev`. Neither is written to a run record, an artifact, a log, or the dashboard.
- **There is NO provider fallback of any kind.** No silent substitution between the two real routes, and
  none to `mock-jev`. A missing credential produces `JEV_CONFIG_ERROR` **before any request is attempted**;
  it never quietly switches to a route that happens to have a key configured.
- **`vercel-jev` is SHADOW ONLY and PAPER ONLY**, exactly like the direct route. It is orchestration and
  shadow infrastructure: it cannot change Arena scoring, gates, the replication evaluator, frozen cohorts,
  Wave 1, or Wave 2.

Environment variables:

```
EVOLVE_JEV_PROVIDER        mock-jev | typesafe-jev | vercel-jev (unset = disabled)
EVOLVE_JEV_MODE            shadow (default and only supported value)
EVOLVE_JEV_API_KEY         DIRECT TypeSafe AI credential — never persisted, never logged
AI_GATEWAY_API_KEY         Vercel AI Gateway credential — never persisted, never logged
EVOLVE_JEV_MODEL           explicit model override (applies to the selected provider)
EVOLVE_JEV_BASE_URL        default: https://api.typesafe.ai
EVOLVE_VERCEL_JEV_MODEL    default: typesafe-ai/jev (never `jev-latest` unless explicitly requested)
EVOLVE_JEV_TIMEOUT_MS      default: 20000, clamped to [1000, 120000]; applies to BOTH real routes
EVOLVE_JEV_MAX_CALLS       default: 20, clamped to [1, 500]; applies identically to vercel-jev
Jev has no runtime confidence threshold. All valid shadow predictions are retained; confidence thresholds are evaluated only retrospectively during offline calibration and are never promoted automatically to an operational gate.
EVOLVE_JEV_CACHE           default: true
EVOLVE_JEV_MAX_ATTEMPTS    default: 3, clamped to [1, 5]; PHYSICAL attempts per LOGICAL decision
EVOLVE_JEV_BACKOFF_BASE_MS default: 1000; exponential backoff base (attempt 1 ~base, attempt 2 ~2x)
EVOLVE_JEV_BACKOFF_MAX_MS  default: 30000; backoff ceiling
EVOLVE_JEV_COOLDOWN_MS     default: 60000; cooldown after an exhausted transient decision (escalating)
EVOLVE_JEV_COOLDOWN_MAX_MS default: 900000 (15 min); hard ceiling for the escalated cooldown
EVOLVE_JEV_TRANSPORT_CHAIN empty (default) = single selected provider; vercel-jev,typesafe-jev opts in
EVOLVE_JEV_HEALTH_DIR      default: .evolve/jev/provider-health (bounded cooldown state, no secrets)
```

The direct route's default model is the pinned `jev-1.13.0`; the gateway route's default model is the
gateway-qualified `typesafe-ai/jev`. Each provider defaults to its **own** canonical id, so a gateway run
can never accidentally request the direct route's pinned version (or vice versa).

### SDK verification

**Direct route (`typesafe-jev`).** Verified against the official `@typesafe-ai/sdk@0.6.0` (installed
dependency) and the published docs at `docs.typesafe.ai`: `POST https://api.typesafe.ai/v1/systemone`,
`Authorization: Bearer <key>`, `client.systemOne({ state, questions, model })` returning
`{ model, answers, usage }`. The pinned model `jev-1.13.0` is the versioned id behind the
`jev-latest`/`jev-preview` aliases at the time of verification — canonical Phase 5D evidence always
requests the versioned id, never an alias that can move underneath a repeated experiment. The real
provider is exercised in tests exclusively through the SDK's own `fetch` override, so no live network
call is required to validate this subsystem.

**Gateway route (`vercel-jev`).** Verified against the installed `ai@^7` (AI SDK 7) evaluation API:
`experimental_evaluate({ model, state, questions, maxRetries: 0, abortSignal })` with the gateway-qualified
model `typesafe-ai/jev`, which the AI Gateway resolves to upstream provider `typesafe-ai`. EVOLVE passes
`maxRetries: 0` so one EVOLVE call is exactly one provider attempt, and wires the existing Jev timeout
through the SDK's `abortSignal`. The gateway's typed answers are converted back into the **same raw wire
shape** the direct SDK returns, so `runtime.mjs#normalizeAnswers` normalizes both routes identically and
no Vercel-specific object ever reaches the decision packet, the experiment layer, calibration, or the
dashboard. Tests stub the AI SDK evaluation layer, so no live network call (and no gateway key) is
required to validate this subsystem.

### Gateway metadata, errors, and boundedness (`vercel-jev`)

Each run record carries a **bounded, non-secret** `providerMetadata` block: `provider`, `upstreamProvider`,
`model`, `transport`, `gatewayUsed`, `providerAttemptCount`, `providerStatus`/`httpStatus`, `latencyMs`,
`tokenUsage`, `generationId`, and the gateway-reported `gatewayCost` / `marketCost` **when available**.
Raw provider metadata is never persisted — only allowlisted scalars plus upstream metadata key *names*.
Authorization headers, the API key, cookies, environment dumps, and raw credential-bearing request
objects are dropped by the normalizer. **All monetary values are observational only**: nothing bills,
charges, or infers profitability from them.

Gateway failures are mapped into EVOLVE's existing status vocabulary, with these distinctions made
explicitly: `401`/`403` → `JEV_AUTH_ERROR`; `429` → `JEV_RATE_LIMIT`; upstream `5xx` (including `503`) →
`JEV_UNAVAILABLE` — **never** an authentication failure; `400`/`404`/`422` → `JEV_CONFIG_ERROR`;
malformed typed answers → `JEV_INVALID_RESPONSE`; an aborted/timed-out call → `JEV_TIMEOUT`; anything
unexpected → `JEV_INTERNAL_ERROR`. There is still **no automatic provider fallback**.

### Decision packet (`jev-decision-packet-v1`) and question sets

The decision packet is a versioned, WHITELIST-ONLY projection (`scripts/jev/decision-packet.mjs`):
bounded genome parameters, TRAIN paper metrics, TRAIN trade/observation counts, mint diversity,
concentration, cost drag, drawdown, TRAIN regime composition, watchdog-visible TRAIN evidence, and the
deterministic research lifecycle state. It explicitly EXCLUDES VALIDATE/TEST/OOS results, Arena ranking
and score, gate results, Champion League and deployment status, future observations, Shadow League
outcomes, and future replication results — and `auditJevDecisionPacket` walks every packet for a
forbidden key or a credential-shaped value, the same structural guarantee Phase 5B's evidence packet
uses.

Two fixed, versioned question sets — never dynamically invented:

- **`jev-question-set-v1`** (candidate-level): `gateFailureRisk` (noul — elevated risk of failing an
  unchanged Arena gate on unseen data; the raw probability is persisted, never thresholded into a real
  gate), `primaryRisk` (choice over 8 bounded labels), `evidenceQuality` (score, 5-level fixed rubric),
  `generalizationConfidence` (noul — a prediction to calibrate later, **never** a profitability
  probability), `researchDisposition` (choice, SHADOW ONLY — Jev does not route the candidate).
- **`jev-market-v1`** (market window): Jev classifies a completed past TRAIN window into EVOLVE's
  EXISTING regime vocabulary. The deterministic regime label is intentionally withheld from the packet
  so Jev classifies blind; EVOLVE compares Jev's choice against the deterministic classifier afterward.
  The deterministic classifier is never modified or bypassed.

### Fail-closed statuses

`JEV_OK`, `JEV_DISABLED`, `JEV_UNAVAILABLE`, `JEV_TIMEOUT`, `JEV_HTTP_ERROR`, `JEV_INVALID_RESPONSE`,
`JEV_BUDGET_EXCEEDED`, `JEV_CONFIG_ERROR`, `JEV_AUTH_ERROR`, `JEV_RATE_LIMIT`, `JEV_INTERNAL_ERROR`.
A Jev failure never changes an EVOLVE strategy, never switches to another provider silently, never
fabricates a decision, and never blocks deterministic EVOLVE operation — shadow mode records
`NO_JEV_DECISION` and EVOLVE continues unchanged.

### Cache, budget, and storage

Cache identity is `provider + model + decisionPacketVersion + questionSetId/Version + stateDigest +
questionDigest`; a cache hit replays the persisted answer with zero network calls and records
`cacheHit: true` plus the original run id. A run-level call budget bounds live attempts; failures
consume attempted-call budget, cache hits do not, and an exhausted budget refuses further calls without
ever reaching the provider.

Storage is fully isolated under `.evolve/jev/experiments/<experiment-id>/` (`experiment.json`,
`decisions/*.json`, `outcomes/*.json`, `calibration.json`, `provider/runs|cache/*.json`) — Jev never
writes into `.evolve/research/` and never mutates a prior Arena artifact.

### Calibration — offline, post-outcome, no provider call

`scripts/jev/calibration.mjs` is a pure evaluator: it joins a previously timestamped Jev decision to a
LATER deterministic Arena gate result by id only, and NEVER calls Jev again. `gateFailureRisk` and
`generalizationConfidence` are scored with Brier score, absolute calibration error, and reliability
bins against pre-registered target definitions (`GATE_FAILURE_TARGET_DEFINITION_V1`,
`GENERALIZATION_TARGET_DEFINITION_V1`) that are versioned and never re-chosen after seeing results.
`primaryRisk` is evaluated as MULTI-LABEL membership (does the selected risk appear in the actual
failed-gate set?) rather than a forced single-label accuracy. An OFFLINE confidence-threshold analysis
(`0.50`–`0.90`) reports coverage/accuracy/abstention for each threshold — **analysis only; no threshold
is promoted to an operational gate in Phase 5D.**

### CLI

```bash
npm run jev -- --provider mock-jev --fixture synthetic
npm run jev -- --provider mock-jev --fixture synthetic --market --save
npm run jev -- --stats --experiment <id>
npm run calibrate:jev -- --experiment <id> --arena <arena-id>
npm run probe:jev -- --provider mock-jev
```

The live providers are never called automatically. Load a key **without writing it into shell history or
the repository** (paste it at the prompt; it is read silently and never echoed):

```bash
read -rsp "Paste Vercel AI Gateway key: " AI_GATEWAY_API_KEY
echo
export AI_GATEWAY_API_KEY
```

Then probe the gateway route once:

```bash
EVOLVE_JEV_PROVIDER=vercel-jev npm run probe:jev -- --provider vercel-jev
```

For the direct route the credential is the **TypeSafe AI** key, loaded the same way into
`EVOLVE_JEV_API_KEY`, and selected explicitly:

```bash
EVOLVE_JEV_PROVIDER=typesafe-jev npm run probe:jev -- --provider typesafe-jev
```

Never place a real key in an example, a committed file, or a command you share. The probe makes exactly
one bounded call against synthetic, non-market state, prints provider/upstream/model/mode/status/latency/
typed-answer validity (and which credential variable it expects, never its value), and writes nothing
unless `--save` is given. A successful gateway probe therefore reads:

```
provider: vercel-jev
upstream: typesafe-ai
model: typesafe-ai/jev
mode: shadow
typed answer valid: yes
```

### Dashboard

A compact `jevShadow` panel (provider, model, `mode: SHADOW`, health, question-set/decision-packet
version, calls/failures/cache hits, mean latency, decision count, calibration count, Brier score, last
decision timestamp) — counts and identity only, never prompts, raw state, or the API key.

### Tests

`npm run validate:phase5d` (131 offline cases) covers the provider registry and fail-closed selection,
typed-answer normalization for all three providers (`mock-jev`, `typesafe-jev`, `vercel-jev`), the
decision packet's leakage audit, both fixed
question sets, deterministic state/question digests, cache identity and no-call replay, run-budget
accounting, timeout/HTTP-error/connection-error classification, secret hygiene, mock determinism, the
shadow-only invariant (byte-identical deterministic Arena scoring/gates whether Jev is disabled or a
shadow prediction runs alongside), prediction persistence before any outcome exists, the pure
calibration layer (Brier score, reliability bins, multi-label `primaryRisk` agreement, regime-shadow
comparison, threshold-coverage analysis with no promoted threshold), the absence of any Jev reference
inside Arena/compiler/watchdog/simulation code, the absence of any wallet/signing/execution capability,
and non-interference with Phase 5B, the canonical Phase 5C replication (`rep-66884de4e460`), its frozen
cohort digests, and the untouched Wave 2 dataset.

## Phase 5E — External Intelligence Shadow Layer

Phase 5E adds an **isolated, read-only, SHADOW external-intelligence capability** on top of
[Agent-Reach](https://github.com/Panniantong/Agent-Reach) (pinned `v1.5.0`, tag commit
`f65526cbaaad3879473acc1ba6dbefd195caf2be`, MIT, Python ≥ 3.10, verified 2026-09-19).

Agent-Reach is an **external intelligence acquisition** layer. It is **not** a strategy generator, not a
trading agent, not an Arena scorer, not a gate, not a wallet tool, not an execution engine, and not a
replacement for Jev or DeepSeek:

```
market data + external intelligence → bounded evidence → Jev shadow judgment
   → optional future DeepSeek escalation → deterministic compiler → Arena
```

Only the **capture** layer is active in Phase 5E. No Agent-Reach result can affect trading, evolution,
Arena scoring, gates, species matching, cohorts or replication.

**The first real capture (`capture-20260919T122601Z`, one GitHub record) is INFRASTRUCTURE PROOF ONLY.**
It demonstrates that the plumbing works end to end — one read-only call, one record, zero failures, a
verifiable immutable manifest — and nothing more. It is a single record from a single channel, so it is
deliberately **not** used as evidence for anything, and it was **never routed** to Jev or DeepSeek.

### Live internet is never used inside the Arena

Observations are **captured, frozen, fingerprinted and replayed from disk**:

```
.evolve/intelligence/<YYYY-MM-DD>/<captureId>/
  manifest.json   immutable, written LAST (finalization record)
  records.ndjson  normalized evidence
  queries.json    the exact deterministic query plan that was executed
  health.json     per-channel statuses/counts/failures/timeouts
  x.ndjson · web.ndjson · exa.ndjson · reddit.ndjson · rss.ndjson · github.ndjson
```

Every normalized record carries `captureId`, `capturedAt`, `channel`, `backend`, `queryId`, `query`,
`canonicalId`, `canonicalUrl`, `publishedAt`, `authorId`, `title`, a **bounded** text excerpt, numeric
`engagement`, `sourceVersion`, `agentReachVersion`, `backendVersion`, `rawDigest` and
`normalizedDigest`. A capture is written once and never overwritten; replaying the same capture is
byte-equivalent and performs **zero** network calls. Tampered evidence is refused (`CaptureIntegrityError`)
instead of being replayed with silently different bytes.

### Provider configuration (fail closed)

```bash
EVOLVE_INTELLIGENCE_PROVIDER=disabled|mock|agent-reach   # default: disabled
EVOLVE_INTELLIGENCE_MODE=shadow                          # the ONLY mode Phase 5E allows
EVOLVE_REACH_BIN / EVOLVE_REACH_TIMEOUT_MS / EVOLVE_REACH_MAX_CALLS
EVOLVE_REACH_CHANNELS / EVOLVE_REACH_MAX_RESULTS / EVOLVE_REACH_MAX_BYTES
```

An unknown provider or mode is a hard error — there is **no automatic fallback**, and the mock provider is
never selected implicitly.

### Channels (narrow allowlist)

Enabled: `x`, `web`, `exa`, `reddit`, `rss`, `github`.

Disabled for canonical Phase 5E: `facebook`, `instagram`, `linkedin`, `xiaohongshu`, `bilibili`, `boss`,
`xueqiu`, `xiaoyuzhou`, `youtube`, `v2ex`, `opencli` — browser-login and write-capable channels are
refused outright, and a request for one fails closed instead of being silently skipped.

### Read-only policy

EVOLVE may only ever request `search`, `read`, `fetch`, `list`, `metadata`. Posting, replying, commenting,
liking, following, forking, opening issues/PRs, pushing, writing, deleting or modifying account state are
rejected **before any call**. GitHub writes, X posts and browser-cookie loading are refused by explicit
guards (action allowlist, argv allowlist, executable allowlist, `shell: false`, sanitized environment).

### Two-tier executable architecture (health/router vs. data acquisition)

Agent-Reach is a **capability/install/doctor/router** layer: its CLI provides `version`, `doctor`,
`install`, `configure`, `setup`, `skill`, … but **no generic `search …` / `read …` wrapper**. EVOLVE
therefore uses it for exactly one purpose — health — and performs reads with the upstream tools it
documents:

```
Agent-Reach (pinned, project-local)      → version · doctor --json     (health/router ONLY)
EVOLVE frozen capability map             → chooses the approved read operation
approved upstream CLI                    → performs the bounded read/search
e.g. gh · twitter · rdt · mcporter · curl
frozen EVOLVE capture                    → normalization / fingerprint / replay
```

| tier | executable | operations |
| --- | --- | --- |
| health | pinned `.tools/agent-reach/bin/agent-reach` | `version`, `doctor --json` |
| data | `gh` | `github` search + repo read |
| data | `twitter` | `x` search + tweet read |
| data | `rdt` | `reddit` search + thread read |
| data | `mcporter` | `exa` / `web` search |
| data | `curl` | `web` (Jina Reader) + `rss` read |

A read is never sent to `agent-reach`: `gh search repos …` runs `gh`, `curl -fsSL …` runs `curl`. The
executable is chosen by the **frozen capability map**, never by a caller, a query, a candidate, a genome,
a proposal or an LLM answer, and never by `EVOLVE_REACH_BIN` (which can only name the pinned CLI).

### Executable resolution and PATH handling

`resolveCapabilityExecutable(capability, options)` resolves a bare allowlisted basename against the
**sanitized PATH** — the same environment the child receives — using a bounded, shell-free search
implemented in Node: split the PATH, keep absolute de-duplicated directories (relative and empty entries
are dropped), build `<dir>/<basename>`, check the executable bit (`X_OK`), and take the first legitimate
match, recording the basename plus the resolved path/realpath as diagnostic metadata. `bash -c`,
`sh -c`, `which` and command interpolation are never used.

A missing approved tool is a **bounded, recorded failure** for that query/channel
(`ReachExecutableUnavailableError`, `unavailable: true`, `spawned: false`): nothing is installed, the
pinned `agent-reach` CLI is never used as a fallback, no other backend is substituted, and the capture
continues with its normal failure accounting. There is no dynamic backend selection during a canonical
capture.

### Isolation and sandboxing

Agent-Reach's Python package is never imported into Arena/evolution code. A dedicated adapter
(`scripts/intelligence/agent-reach.mjs`) launches the resolved executable as a bounded subprocess with an
argument array, `shell: false`, a hard timeout, an output byte limit, a per-capture call budget, a frozen
command map (no arbitrary command pass-through) and a sanitized environment that can never inherit wallet,
signer, seed, key, token, cookie or credential variables. `assertReadOnlyArgv()` runs before every spawn,
and `commandPreview` always names the executable that was actually launched. Cookie/credential values are
never persisted.

Installation is **project-local** (`.tools/agent-reach/`, gitignored) and user-run: no global/system
changes, no browser extensions, no cookie import, no account login, and canonical tests never require
Agent-Reach — or any upstream tool — to be installed at all (the suite resolves against a fixture PATH and
never executes a stub).

> **Build note (known environmental limitation).** Next 16 builds with Turbopack, which resolves every
> symlink below the project root and fails with `Symlink [project]/.tools/agent-reach/venv/bin/python is
> invalid, it points out of the filesystem root` on the venv's absolute interpreter symlink
> (`venv/bin/python3 → /usr/bin/python3`). This is a Turbopack/venv interaction, **not** a defect in the
> intelligence layer: `npm run build` fails identically at any commit while `.tools/` exists, and
> `npx next build --webpack` succeeds with `.tools/` in place. Nothing in the repository is configured to
> hide it; if a Turbopack production build is required together with the project-local install, run
> `npx next build --webpack` (or install the venv with `python3 -m venv --copies`).

### Deterministic query sets

Canonical Phase 5E never lets an LLM invent web queries. `reach-query-set-v1` renders queries from fixed
templates over whitelisted token metadata only (`symbol`, `name`, `domain`, `mint`, `handle`); every
template declares its read-only operation, so `rss` (a read channel) renders one deterministic feed URL.
Arbitrary free-form queries are rejected (`ArbitraryQueryError`).

### Bounded features, not raw social text

Raw social text never reaches a strategy. A capture is reduced to a versioned, deterministic feature
vector: `mentionCount`, `uniqueAuthors`, `postsPerMinute`, `engagementTotal`, `engagementMedian`,
`duplicateTextRatio`, `repeatedAuthorRatio`, `linkDomainConcentration`, `accountConcentration`,
`sourceCount`, `sourceDiversity`, `queryCoverage`, `captureAgeMs` (presentation-only, excluded from the
digest), `fetchFailureRate`, and `coordinationIndicators`. Suspicious patterns are reported as
`coordinationIndicators` — deterministic observations over the captured bytes, explicitly **not** a bot
probability.

## Phase 5E.2 — Versioned Feature Transforms

Phase 5E.2 fixes two correctness gaps found in the first real capture. It adds **no** capability: no
wallet, no signing, no routing, no provider call, no Arena participation, and no change to any Arena or
replication gate.

### Capture bytes and feature interpretation are versioned SEPARATELY

A capture freezes **bytes**. The transform that turns those bytes into a feature vector used to be
imported "as current" at replay time, so a future edit to `features.mjs` could silently reinterpret an
old immutable capture and move its `featuresDigest`, `replayDigest` and `packetDigest` — even though not
one frozen byte changed. Two independent versions now exist:

| Layer | Version | Where |
| --- | --- | --- |
| Capture manifest schema | `captureSchemaVersion` (`2` for new captures, `1` legacy) | `manifest.json` |
| Feature transform | `featureVersion` = `external-intelligence-features-v1` \| `-v2` | `manifest.json` (`transforms`-free, one explicit field) |
| Replay semantics | `external-intelligence-replay-v2` | replay result provenance |
| Packet schema | `external-intelligence-packet-v1` (unchanged — it already carries `featureVersion`) | packet |

`featureExtractorFor(version)` is the **only** way a version becomes an extractor, and it is
**fail-closed**: an unknown, empty or whitespace version throws `UnknownFeatureVersionError` and is
never mapped to "latest". A **new** capture explicitly pins `external-intelligence-features-v2`.

### Legacy schema-v1 captures stay on feature V1

A legacy manifest **without** a `featureVersion` pin is resolved to `external-intelligence-features-v1`
by an explicit **backwards-compatibility rule** (not a default-to-latest rule), and the V1 algorithm is
frozen: it is never "corrected", and a schema-2 manifest that pins nothing fails closed instead. Old
manifests are never rewritten — the legacy interpretation happens in code.

The first real capture therefore still replays to exactly the same digest it always did
(`replayDigest b3904fe2…`, `packetDigest ce82b740…`), and a committed schema-1 fixture
(`scripts/intelligence/fixtures/legacy-capture-schema1/`) pins the V1 output so nobody can later "tidy
up" the old extractor and invalidate historical replays.

### Missing metadata is UNKNOWN, not concentration

V1 divided by the record count unconditionally, so a record with **no author field** made
`repeatedAuthorRatio` read `1.0` — "everyone repeats" — when the truth was "no author was observed at
all". That produced a meaningless `fewAuthors` indicator from a single GitHub record with no author.

V2 separates three different quantities everywhere it matters:

- **record count** — `mentionCount`;
- **observed-field count** — `authorObservedCount`, `textObservedCount`, `linkObservedCount`,
  `publishedAtObservedCount`, `engagementObservedCount`;
- **distinct-value count** — `uniqueAuthors`, `uniqueTexts`, `uniqueLinkDomains`.

Every ratio now uses its **own observed-field denominator and is `null` when nothing was observed**:

- `repeatedAuthorRatio = 1 − uniqueAuthors / authorObservedCount` (`null` with no author observed) — a
  missing author is UNKNOWN, never a repeat;
- `duplicateTextRatio` is over `textObservedCount` (`null` when no bounded text exists);
- `sourceDiversity = distinctDomains / linkObservedCount` (`null` when no link was observed) — it is
  never divided by all records just because some channel does not expose URLs;
- `linkDomainConcentration` and `accountConcentration` are computed over observed values only, and are
  `null` when there are none;
- `postsPerMinute` only counts publication timestamps that actually exist, and stays `null` when the
  sample cannot define a span;
- `engagementTotal`/`engagementMedian` still ignore missing engagement, which is also counted.

Bounded coverage ratios (`authorCoverage`, `textCoverage`, `linkCoverage`, `publishedAtCoverage`,
`engagementCoverage`) expose how much of the capture actually carried each field. No raw text, URL or
author is ever exposed.

### Coordination indicators require a minimum relevant sample

A single record is not coordination evidence. Every V2 indicator may fire only when its **relevant
observed-field count** reaches `COORDINATION_MIN_OBSERVATIONS = 5`:

| Indicator | Requires |
| --- | --- |
| `repeatedText` | `textObservedCount ≥ 5` and `duplicateTextRatio ≥ 0.5` |
| `fewAuthors` | `authorObservedCount ≥ 5` and `repeatedAuthorRatio ≥ 0.7` |
| `singleLinkDomain` | `linkObservedCount ≥ 5` and `linkDomainConcentration ≥ 0.6` |
| `burstRate` | `publishedAtObservedCount ≥ 5` and `postsPerMinute ≥ 30` |

The thresholds are unchanged definitions and were deliberately **not** tuned against the first live
capture — the minimum-sample rule is a semantic validity requirement, not outcome optimisation. Under
V2 the one-record GitHub capture reports `repeatedAuthorRatio: null`, no `fewAuthors`, no
`singleLinkDomain`, and `coordinationIndicators.count: 0`.

These indicators remain **descriptive observations only**: never a bot probability, never a risk
probability, never an Arena gate, never a trading input.

### Jev / DeepSeek boundaries

A whitelist-only `external-intelligence-packet-v1` exists as a **future** handoff to Phase 5D Jev (which
could later decide `ignore` / `observe` / `escalate_to_deep_research`). Nothing is routed today:
`jevRoutingActive: false`, `deepseekRoutingActive: false`, no live Jev call, and no DeepSeek call. The
packet carries identity, counts, health and bounded features — never raw text, URLs or credentials.

### Commands

```bash
npm run intelligence -- --provider mock --fixture synthetic   # offline fixture capture
npm run intelligence:capture -- --query-set reach-query-set-v1 --candidates candidates.json
npm run intelligence:replay -- --capture <id>                 # offline, byte-equivalent
npm run intelligence:stats -- --capture <id>                  # read-only inventory
npm run intelligence:doctor                                   # provider/health report
npm run probe:reach                                           # Agent-Reach doctor/probe
npm run intelligence:doctor -- --probe                        # side-effect-free version + doctor --json
```

Nothing is persisted by the doctor/probe unless `--save` is passed, no login is ever performed, and the
probe is never run automatically. The probe deliberately uses `doctor --json` (the text `doctor` path
installs skill files upstream, the JSON path does not).

### Dashboard

A compact `externalIntelligence` panel (provider, `mode: SHADOW`, Agent-Reach version/license, health,
enabled channels, captures, records, failures, timeouts, evidence quality, replay mode, last capture
timestamp, latest capture digest, per-channel statuses). Counts and identity only — raw social content,
URLs, cookies and tokens are never sent to the browser.

### Caveat

Social evidence may be noisy, duplicated or manipulated. External intelligence is **unproven** inside
EVOLVE: it has to demonstrate value experimentally before any future use, and it can never bypass the
deterministic evaluator.

## Phase 5F.0 — External Intelligence → Jev Shadow Experiment Bridge

Phase 5F.0 adds an **explicit SHADOW experiment harness** that lets Phase 5D Jev inspect a frozen
external-intelligence packet. It is **experimentation, not operational routing**.

```text
Frozen External Capture
  → Offline Replay (zero network)
  → external-intelligence-packet-v1 (audited)
  → dedicated bounded Jev projection (a SECOND whitelist)
  → jev-external-intelligence-v1 (fixed question set)
  → explicit SHADOW Jev experiment (one bounded provider call)
  → persisted hypothetical disposition (immutable decision record)
  → STOP
```

**Operational external-intelligence routing remains OFF.** `JEV_ROUTING_ACTIVE` and
`DEEPSEEK_ROUTING_ACTIVE` are still hard-coded `false`; the intelligence subsystem can never invoke Jev
automatically, and **Jev can never invoke DeepSeek**. Even a recorded `escalate_to_deep_research`
disposition is only a hypothetical — it triggers no research, no DeepSeek call, no capture, no Arena run.

### New packet kind and version

The bridge does **not** overload the candidate or market packet. It introduces its own kind and its own
version constant (`JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET_VERSION = 1`); the existing
`JEV_DECISION_PACKET_VERSION` is untouched.

| Item | Value |
| --- | --- |
| Packet kind | `JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET` |
| Packet version | `1` (separate constant) |
| Question set | `jev-external-intelligence-v1` (v1) |

### Bounded Jev projection

`buildExternalIntelligenceJevPacket(...)` accepts an already-built `external-intelligence-packet-v1`,
**first** requires `assertPacketAllowed(externalPacket)`, then requires
`packet.routing.jevRoutingActive === false`, `packet.routing.deepseekRoutingActive === false`,
`shadowOnly === true`, `paperOnly === true` and `readOnly === true`. Only then does it build a **second
whitelist projection**.

Allowed: `packetVersion`, `packetKind`, `sourceCapture` (`captureId`, `captureManifestDigest`,
`packetDigest`, `provider`, `querySetId`, `featureVersion`, `channels`), `counts` (`records`, `channels`,
`failures`, `timeouts`, `calls`), the bounded feature vector (`mentionCount` … `fetchFailureRate`,
`coordinationIndicatorCount`, `coordinationIndicatorIds`) and fixed `limitations`.

Excluded by construction: raw records, raw text, text excerpts, URLs, author ids, repository names,
search-result descriptions, credentials, API keys, cookies, executable material, command previews,
`captureAgeMs`, Arena results, candidate outcomes, validation/test/OOS outcomes, future observations,
the deterministic `evidenceQuality` label, and the coordination indicators' prose `rule` strings (only
their bounded ids and count are carried).

### Deterministic evidenceQuality is withheld, then recorded as a comparator

The external packet carries a deterministic `evidenceQuality` label. Jev is asked to **judge evidence
quality independently**, so the label is deliberately **not** put in the Jev state. It is recorded
afterwards as post-build comparator metadata:

```json
deterministicComparators: {
  externalEvidenceQuality, coordinationIndicatorCount, recordCount,
  sourceCount, queryCoverage, fetchFailureRate
}
```

These are things EVOLVE already knows from the frozen capture — they are never future outcomes.

### Fixed question set `jev-external-intelligence-v1`

No question is generated dynamically; the set is never the candidate/TRAIN set (`jev-question-set-v1`)
nor the market-regime set (`jev-market-v1`).

| Question | Type | Meaning |
| --- | --- | --- |
| `evidenceSufficiency` | noul | Is the frozen evidence broad/corroborated enough to support a research conclusion beyond observation? (never a profitability probability) |
| `primaryConcern` | choice | One dominant concern from a fixed six-label vocabulary |
| `evidenceQuality` | score | Five-level 0..4 rubric, judged **blind** |
| `corroborationConfidence` | noul | Is there meaningful corroboration across independent observations/sources? |
| `researchDisposition` | choice | Hypothetical next research step |

`primaryConcern` vocabulary (fixed): `insufficient_sample`, `source_concentration`,
`low_field_coverage`, `coordination_pattern`, `fetch_instability`, `no_obvious_concern`.

`researchDisposition` vocabulary (exactly the existing future external-intelligence vocabulary):
`ignore`, `observe`, `escalate_to_deep_research`. **Even `escalate_to_deep_research` must not invoke
DeepSeek** — it is only a recorded hypothetical disposition.

### Machine reuse, budget and persistence

The bridge reuses the existing Phase 5D machinery — provider resolution (`mock-jev`, `typesafe-jev`,
`vercel-jev`), typed normalization, the status vocabulary, timeout handling, the call budget, provider
metadata, caching, `jevDecide()`, the immutable decision store, and the existing
`.evolve/jev/experiments/<id>/` storage. It creates no second provider subsystem, no second cache, and no
parallel `.evolve/jev-external` hierarchy.

- Provider selection is explicit and **fail-closed**: unset ⇒ disabled, an unknown name is a hard error,
  and there is **no fallback** of any kind.
- The call budget is checked **before** the provider is invoked. The external CLI defaults
  `EVOLVE_JEV_MAX_CALLS` to `1`.
- `--save` writes a normal Jev experiment plus provider run, cache entry (when enabled) and an immutable
  decision record. The decision's `subjectDigest` is the source external packet's `packetDigest`; its
  `packetKind` is `JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET`; its `questionSetId` is
  `jev-external-intelligence-v1`. No raw capture file is duplicated into Jev storage.

### CLI

```bash
npm run jev:external -- --capture <capture-id> --provider <provider> [--save]
```

It requires an EXISTING frozen capture, replays it offline, performs integrity verification, builds the
external packet, runs `assertPacketAllowed`, derives the dedicated Jev packet, builds
`jev-external-intelligence-v1`, optionally calls exactly one selected provider, and persists only when
requested. It never calls Agent-Reach, never takes a capture, never touches live internet except the
explicitly selected Jev provider, never calls DeepSeek and never runs the Arena.

### Caveat

The first V2 capture (`capture-20260919T130756Z`) is a one-record GitHub **infrastructure** capture with
`evidenceQuality: WEAK`. It is suitable for proving plumbing end to end — **not** for claiming any useful
market signal. A `WEAK` evidence label and a Jev `observe`/`ignore` disposition are the expected result.
Calibration of external-intelligence decisions is out of scope for Phase 5F.0: an external decision has
no Arena outcome contract yet, so `npm run calibrate:jev` is not extended to it and missing Arena
outcomes are never treated as a failure.

## Phase 5F.1 — Resilient Jev Transport

Phase 5D/5F.0 deliberately sent `maxRetries: 0` to the AI SDK and made exactly **one** physical attempt
per EVOLVE call. That correctly prevented hidden retry storms — and it also meant a single transient
HTTP 429 ended an entire shadow experiment (`JEV_RATE_LIMIT`, one attempt, stop). Phase 5F.1 adds an
**explicit, EVOLVE-owned** resilience layer *below* one logical decision. It does not guarantee HTTP 200;
it maximizes the probability of eventually obtaining a valid `JEV_OK` while staying bounded, auditable,
and honest about every failure.

### Logical decisions vs physical attempts

```text
ONE logical Jev decision            (counted once against EVOLVE_JEV_MAX_CALLS)
  └── 1..N PHYSICAL transport attempts
        attempt 1 -> 429   -> backoff -> retry
        attempt 2 -> 503   -> backoff -> retry
        attempt 3 -> 200   -> JEV_OK
```

That is still **ONE shadow decision**, and it reports `providerAttemptCount: 3` with all three attempt
records — the failed ones are never discarded. Counting a retried call as several Jev decisions would
corrupt every calibration and provenance number EVOLVE produces.

| Budget | Meaning | Default | Bounds |
| --- | --- | --- | --- |
| `EVOLVE_JEV_MAX_CALLS` | maximum **LOGICAL** Jev decisions per run (unchanged) | `20` (`1` in `jev:external`) | 1..500 |
| `EVOLVE_JEV_MAX_ATTEMPTS` | maximum **PHYSICAL** attempts per logical decision | `3` | 1..5 |

### What is retried, and what is not

| Retried (transient) | Never retried |
| --- | --- |
| HTTP `429` / `JEV_RATE_LIMIT` | `400`, `401`, `402`, `403`, `404`, `422` |
| HTTP `502`, `503`, `504` (and retryable `5xx`) | malformed typed response (`JEV_INVALID_RESPONSE`) |
| `JEV_TIMEOUT` | invalid question schema |
| temporary connection reset / DNS / network failures (`JEV_UNAVAILABLE`) | configuration error, authentication error |
| | unknown provider / unknown model, packet-audit failure |

The HTTP status code decides whenever one is available, which is what keeps the DIRECT TypeSafe route
honest: it classifies 429/5xx as `JEV_HTTP_ERROR` (pinned Phase 5D behaviour), so retryability is read
from the status code rather than the label. An auth or config error will not improve by sleeping, so it
is never retried and never opens a cooldown.

### Backoff, jitter and `Retry-After`

Exponential backoff with bounded jitter: `base · 2^(attempt-1)`, clamped to `EVOLVE_JEV_BACKOFF_MAX_MS`,
then multiplied by a factor drawn from `[0.75, 1.25)` — so attempt 1 waits ~1s, attempt 2 ~2s, and
simultaneous agents never retry in lockstep.

A standard `Retry-After` is recognized from the bounded error/header shapes the AI SDK and Gateway errors
expose (integer seconds **or** an HTTP-date, including one `RetryError` unwrap level) and is used instead
of the schedule for that wait. It is **clamped** to 60 seconds, a malformed value is ignored, and only a
single bounded `retryAfterMs` number is ever persisted — raw headers, cookies and credentials never are.

`sleepImpl` and `randomImpl` are injectable, so the whole suite runs offline with zero real delay and a
deterministic jitter draw.

### Provider-health cooldown (bounded circuit breaker)

Cross-run protection lives under the Jev subsystem at `.evolve/jev/provider-health/<provider>.json`
(`EVOLVE_JEV_HEALTH_DIR` overrides the location) and contains exactly:

```json
{ "provider", "model", "consecutiveTransientFailures", "lastFailureStatus",
  "lastFailureAt", "cooldownUntil", "lastSuccessAt", "formatVersion" }
```

No secrets of any kind. When a logical decision exhausts every attempt on **exclusively** transient
failures, the streak increments and a cooldown opens, escalating geometrically and clamped at
`EVOLVE_JEV_COOLDOWN_MAX_MS` (default 15 minutes):

```text
first exhausted transient run   ->  60s
second                          -> 120s
third                           -> 240s   (… clamped at 15 minutes, never indefinite)
```

While a cooldown is active the call **fails safely** with an explicit `JEV_COOLDOWN` and makes **zero**
network attempts — the provider is never touched merely to rediscover that it is still rate limited. Only
an explicit `--override-cooldown` bypasses it. A successful `JEV_OK` resets the streak and clears the
cooldown; auth/config/invalid-response failures are recorded but never create one.

### Optional same-Jev transport failover

```bash
EVOLVE_JEV_TRANSPORT_CHAIN=vercel-jev,typesafe-jev
```

Empty (the default) means the single selected provider only. When enabled — and only when **both** routes
have their **own** real credential (`AI_GATEWAY_API_KEY` for `vercel-jev`, `EVOLVE_JEV_API_KEY` for
`typesafe-jev`) — Vercel Jev is tried first under the bounded transient policy, and if it exhausts its
attempts the DIRECT TypeSafe Jev route is tried. This is allowed because it stays **Jev → Jev**.
`mock-jev` may never appear in the chain, and no other decision model (GPT, Claude, Gemini, DeepSeek, …)
is reachable — `EVOLVE_JEV_TRANSPORT_CHAIN` rejects anything that is not a registered same-Jev route as a
configuration error.

Credentials are never borrowed: the gateway key is never sent to `api.typesafe.ai`, the direct key is
never sent to the AI Gateway, and a chain entry whose own credential is missing is **skipped** (and
reported), never substituted.

Provider and transport are part of the provenance of every attempt (`provider`, `model`, `transport`), so
a decision obtained through the Gateway is never mistaken for a byte-identical DIRECT TypeSafe decision,
and calibration can stratify by transport later.

The offline `mock-jev` and any fail-closed config-error provider are returned **unwrapped** — no network
to protect, no retry that could help — so their Phase 5D/5F.0 behaviour is byte-for-byte unchanged.

### Attempt provenance

Each physical attempt is persisted in `providerAttempts` with **only** these bounded fields:

```json
{ "attemptNumber", "provider", "model", "transport", "startedAt", "completedAt",
  "latencyMs", "status", "httpStatus", "retryable", "retryAfterMs", "backoffMs",
  "generationId", "successful" }
```

Never an API key, Authorization header, cookie, raw state, raw questions, raw response or raw headers.
The run also reports `providerAttemptCount` (actual physical attempts: `1` for an ordinary
single-attempt call, `0` for a cache hit / disabled provider / exhausted budget), and the immutable
decision record carries the same attempts so a later offline calibration can see exactly which transport
produced it.

The `vercel-jev` request itself still sends **`maxRetries: 0`**: EVOLVE owns all retry behaviour, and SDK
retries are never enabled at the same time — otherwise attempt accounting would become opaque.

### Validation

```bash
npm run validate:phase5f1   # 64 offline cases: classification, Retry-After, backoff, cooldown, chain, identity
```

## Phase 5G.0 — classifier.dev Frozen External-Intelligence Classification

```text
Agent-Reach
  → frozen public observations              (immutable capture, never re-queried)
  → deterministic bounded text projection   (title + textExcerpt only)
  → classifier.dev FAST tier                (ONE request, fixed taxonomy)
  → frozen classification artifact
  → STOP
```

classifier.dev is a **bounded, external, descriptive labelling step** over observations that are already
frozen. Phase 5G.0 proves the plumbing and freezes the semantics; it does **not** decide whether the labels
are useful. That needs a later prospective experiment.

- classifier.dev **does not trade**.
- classifier.dev **does not generate strategies**.
- classifier.dev **does not call Jev** and is **not a Jev fallback**.
- classifier.dev **does not invoke DeepSeek**.
- classifier.dev **labels are descriptive and unverified**.
- classifier.dev output has **no authority** over the Arena, evolution, gates, replication or deployment.
- **Smart tier is disabled.** It can involve another reasoning-model provider, which would add a second model
  to provenance.
- Nothing is routed anywhere: `external-intelligence-packet-v1`, `external-intelligence-features-v2`, the Jev
  packet projection and question sets are all unchanged.

### Endpoint and request

`POST https://classifier.dev/v1/classify` via native `fetch` (the versioned REST route — not MCP, not the bare
`POST /`). The request contains exactly `inputs`, the frozen `labels`, `tier: "fast"`, the frozen
`instructions` and `multi: false` (`max_labels` is never sent). No credential exists: **no `Authorization`
header, no gateway key, no Jev key, no cookie.** Redirects are never followed. At most 1,000 inputs per
request; more eligible records **fail closed** (nothing is truncated, nothing is silently dropped).

### Frozen classifier `reach-signal-type-v1` (version 1)

Exactly nine labels, never extended dynamically and never supplied by a caller:

`technical_activity` · `project_announcement` · `exchange_or_listing` · `liquidity_or_market_structure` ·
`security_or_risk` · `governance_or_admin` · `community_attention` · `promotion_or_marketing` ·
`unrelated_or_noise`

The instruction text is pinned (`instructionsDigest` `79be0792…`):

> Classify the primary research-relevant type of this public external observation. Describe what kind of
> observation it is, not whether an asset should be bought or sold. Do not infer price direction,
> profitability, legitimacy, coordinated manipulation, identity, or intent. Choose unrelated_or_noise when
> none of the other categories clearly applies.

The labels are **descriptive**. `promotion_or_marketing` does **not** mean scam, manipulation, malicious, pump
or fraud, and `security_or_risk` means only that the text is principally *about* a security/risk topic — not
that EVOLVE verified any claim.

### Input projection `classifier-input-projection-v1`

Only **`title`** and **`textExcerpt`** of a normalized record can reach classifier.dev — joined
deterministically, whitespace-normalized, secret-shaped strings redacted (EVOLVE's existing sanitizer plus a
few bare credential shapes), embedded URLs replaced with `[URL]`, bounded to **800 characters**, empty input
skipped. Never sent: `query`, `queryId`, `canonicalId`, `canonicalUrl`, `authorId`, `rawDigest`, `captureId`,
`backend`, `engagement`, `publishedAt`, nor any genome, candidate parameter, P&L, paper return, Arena/gate/
replication result, research proposal, DeepSeek/Jev output, wallet, transaction, credential, environment
variable, filesystem path or raw provider object. Nothing is prepended (no symbol, price, query, channel,
author, URL, reputation or EVOLVE state).

`inputDigest = digestOf(final classifier input)` is persisted; the input text itself is **not** (the capture
already holds the frozen excerpt and the projection re-derives the input).

### Response validation

Whitelisted and checked field by field: `tier` must be `fast`; `results.length` must equal the input count
(order preserved); every `label` must be in the taxonomy; `confidence` must be finite and in `[0, 1]`;
`scores` must be an object whose keys are taxonomy labels and whose values are finite and in `[0, 1]`;
`usage.escalated` must not exceed 0. A malformed, partial or reordered answer is **rejected**, never repaired.
Unknown additive fields are ignored. The raw HTTP response is never persisted.

### Frozen artifact

```text
.evolve/classifier/experiments/clexp-<UTC stamp>-<resultDigest[:8]>/
  experiment.json            identity + provenance + counts + resultDigest   (written LAST, immutable)
  results.ndjson             one bounded record per classified source record, in capture order
  provider/runs/run-0001.json   bounded attempt metadata
```

The capture directory is never written to and the source capture is never copied. A classification record holds
only `recordDigest` (the source `normalizedDigest`), `inputProjectionVersion`, `inputDigest`, `classifierId`,
`classifierVersion`, `label`, `confidence`, `scores`, `provider`, `model`, `tier` — no title, excerpt, URL,
author, query or raw response. `resultDigest = digestOf(ordered classification records)`; re-reading the
stored experiment offline reproduces it exactly.

Only descriptive counts are derived (classified count, `labelCounts`, mean confidence, returned model, API
version, latency). There is deliberately **no** bullishness, expected return, trade confidence, buy/sell
probability, token-quality, scam or profitability number.

### Transport recovery

Bounded and EVOLVE-owned: **retry** 429, 502, 503, 504, timeout and temporary network failure; **never retry**
400, 404, other 4xx/5xx, a malformed response, an invalid classifier definition, an invalid capture or a
failed integrity check. `EVOLVE_CLASSIFIER_MAX_ATTEMPTS` (default 3, clamped 1..5), exponential backoff from
`EVOLVE_CLASSIFIER_BACKOFF_BASE_MS` (1000) to `EVOLVE_CLASSIFIER_BACKOFF_MAX_MS` (30000) with ±25% jitter, and
`Retry-After` honoured as a floor (integer seconds or HTTP-date, clamped to 60s). Only bounded parsed rate-limit
metadata is persisted — `httpStatus`, `retryAfterMs`, `rateLimitLimit`, `rateLimitRemaining`,
`rateLimitPolicy`, `attemptNumber`, `latencyMs`, `status` (`null` when unavailable) — never raw headers.
`fetchImpl`, `sleepImpl` and `randomImpl` are injectable, so tests use zero real delay.

### Capture integrity requirement

Before anything is sent: the capture manifest must exist, `immutable === true`, `finalized === true`, and the
existing capture integrity verification must pass. Only then are the frozen normalized records loaded and the
inputs built locally. Classification never calls Agent-Reach and never triggers a capture.

### CLI

```bash
# the provider is DISABLED unless chosen explicitly; nothing is classified after a capture automatically
npm run intelligence:classify -- --capture <capture-id> --classifier reach-signal-type-v1 --provider classifier-dev [--save]

# offline inspection — zero network calls, no reclassification
npm run intelligence:classify -- --stats  --experiment <clexp-id>
npm run intelligence:classify -- --replay --experiment <clexp-id>
```

`--replay` recomputes `resultDigest`, verifies the source capture identity and integrity, re-projects the
frozen records and checks every stored `recordDigest`/`inputDigest` in order. `--tier smart`, `--multi`,
`--labels` and `--instructions` are refused. Without `--save` the result is printed and nothing is persisted; a
failed classification persists nothing.

### Validation

```bash
npm run validate:phase5g   # 74 offline cases: endpoint/tier/taxonomy pins, projection, response validation,
                           # retry, no-credential, storage, replay, no-routing, identity barriers
```

## Phase 5G.1 — Offline Classifier Taxonomy Evaluation

```text
DEVELOPMENT-only Agent-Reach captures
  → frozen normalized records
  → Phase 5G.0 classifier experiments  (clexp-…)
  → explicit immutable DEVELOPMENT cohort  (clcohort-…)
  → OFFLINE descriptive taxonomy evaluation  (cleval-…)
  → STOP
```

Phase 5G.1 consumes **multiple already-frozen** classifier experiments and describes the classifier's
behaviour across them. It is an **evaluation of classifier behaviour**, not of truth: it does **not** establish
truth, predictive value or profitability, and it routes nothing downstream.

- Every cohort and evaluation is pinned to `evidenceClass: "DEVELOPMENT_CLASSIFIER_EVIDENCE"` — **never**
  `CLEAN_REPLICATION`, `VALIDATION`, `TEST`, `OOS` or `PRODUCTION`. No future clean artifact may depend on it.
- The evaluator is **offline only**: it reads classifier experiment artifacts and their frozen source captures
  and makes **zero network calls** — no classifier.dev, no Agent-Reach, no Jev, no DeepSeek, no Arena.
- The taxonomy is **frozen**. Phase 5G.1 never edits `reach-signal-type-v1`; a future `reach-signal-type-v2`
  would be a separate phase evaluated on **new** development captures. There is no automatic
  evaluate → mutate → rerun loop.

### Cohort manifest

```text
.evolve/classifier/cohorts/<cohort-id>.json      cohort-id = clcohort-<UTC stamp>-<cohortDigest[:8]>
```

The cohort contains **only** `cohortId`, `purpose` (`DEVELOPMENT`), `evidenceClass`, `classifierId`,
`classifierVersion`, `inputProjectionVersion`, `experimentIds`, `sourceCaptureIds`, `experimentDigests`,
`resultDigests`, `recordCounts`, `createdAt`, `immutable`, `note` and `cohortDigest`. It embeds **no** raw text,
title, excerpt, URL or author, and it is immutable (never overwritten). Freezing requires **explicit**
`clexp-*` ids — there is no "latest experiment" search.

A cohort is **rejected** if it lists a duplicate experiment id, an experiment whose classifier id, version or
input projection does not match the frozen definition, a non-finalized experiment, an experiment that fails its
own integrity check, a missing source capture, or a source capture that fails integrity. The canonical Phase 5G.0
one-record **infrastructure experiment** (`clexp-20260919T143623Z-69170f53`) is excluded from the meaningful
development cohort by default.

### Evaluation artifact

```text
.evolve/classifier/evaluations/<evaluation-id>/evaluation.json   evaluation-id = cleval-<UTC stamp>-<evaluationDigest[:8]>
```

The artifact persists `evaluationId`, `cohortId`, `evidenceClass`, `classifierId`, `classifierVersion`,
`inputProjectionVersion`, `experimentCount`, `captureCount`, `recordCount`, `channelCounts`, `metrics`,
`cohortDigest`, `evaluationDigest`, `createdAt`, `immutable`, `descriptiveOnly`, `noGroundTruth` and
`noProfitabilityInference`. It contains **no** raw text, URL, author or secret.

### Descriptive metrics

- **Label distribution** — per-label count/fraction over all nine labels, `totalClassified`, `labelsObserved`,
  and `labelDiversity` = normalized Shannon entropy (0 = one label, 1 = uniform over nine). High diversity is
  **not** "good".
- **Confidence** — mean, median, p10/p25/p75/p90, min, max, plus fixed descriptive bands (`< 0.50`, `< 0.70`,
  `>= 0.90`). These thresholds are **not** acceptance gates.
- **Per-label confidence** — count, mean, median, p25, p75 for every observed label. No label is ranked.
- **Score margin** — `top1Score`, `top2Score`, `scoreMargin = top1 - top2`; mean, median, p10/p25/p75/p90 and
  fixed descriptive ambiguity bands (`< 0.05`, `< 0.10`, `< 0.20`). No gate.
- **Score entropy** — the nine scores normalized by their sum (only when nonnegative and sum > 0), then
  normalized Shannon entropy; an unnormalizable vector is stored as `null` — a missing value is never invented.
- **Channel × label** — classifications are joined back to the frozen source records by
  `recordDigest === normalizedDigest`; the source `channel` is the only grouping key (no text is copied).
  Reported per channel: `recordCount`, `labelCounts`, `labelFractions`, mean/median confidence and mean/median
  margin. A missing source record **fails closed**.
- **Channel coverage** — channels represented, count and fraction per channel. More channels is **not**
  automatically better evidence.
- **Noise** — exactly `unrelated_or_noise` count/fraction. These records are **not** discarded in Phase 5G.1.
- **Promotion** — exactly `promotion_or_marketing` count/fraction, a descriptive category only — **not** scam,
  manipulation, bot activity, fraud or spam.
- **Concentration** — `largestLabelCount` / `largestLabelFraction`. There is **no** "taxonomy passed" / "taxonomy
  failed" / "good" / "bad" verdict anywhere, and **no** accuracy, precision, recall, F1, ROC or calibration
  metric (there is no ground truth), and **no** correlation against returns, price, P&L, Arena score, survival
  or gate outcomes.

### Human audit view (ephemeral)

```bash
npm run intelligence:classify-eval -- --cohort <cohort-id> --audit
npm run intelligence:classify-eval -- --cohort <cohort-id> --audit-low-confidence [N]   # default 20, clamped 1..100
```

These read the original frozen capture and print **bounded** rows to the terminal only: shortened `recordDigest`,
channel, a bounded title/text excerpt (URLs redacted), the predicted label, confidence and the top two scores.
They never show a canonical URL, author id, query or credential, and they write **no** artifact. Sampling is
deterministic (up to three observations per observed label by lowest digest order; the lowest-confidence audit is
sorted by confidence then digest) — no randomness.

### CLI

```bash
# freeze an explicit DEVELOPMENT cohort from exact experiment ids
npm run intelligence:classify-eval -- --freeze-cohort --experiments <clexp-id,clexp-id,...>

# create the offline evaluation artifact
npm run intelligence:classify-eval -- --cohort <cohort-id>

# offline, zero-network inspection
npm run intelligence:classify-eval -- --stats  --evaluation <cleval-id>
npm run intelligence:classify-eval -- --replay --evaluation <cleval-id>
```

`--replay` verifies the cohort identity, every classifier experiment and every source capture, recomputes every
metric, reproduces `evaluationDigest` exactly and proves the stored evaluation carries no raw text, URL or
author. `--freeze-cohort` validates every experiment **before** writing anything.

### Validation

```bash
npm run validate:phase5g1   # 75 offline cases: taxonomy/definition/projection pins, cohort rejection rules,
                            # DEVELOPMENT evidence class, every metric, no-truth/no-profitability/no-verdict,
                            # text-free artifact, deterministic audit, offline replay/stats, identity barriers
```

## Phase 5H.0 — Deterministic Classifier-Derived Features

```text
frozen 5G.1 cohort  (clcohort-…)
  → verify frozen cohort
  → verify frozen classifier experiments  (clexp-…)
  → verify frozen source captures
  → classifier-feature-definition-v1
  → record-level deterministic extraction
  → classifier-feature artifact  (clfeat-…)
  → offline replay / audit / stats
  → STOP
```

Phase 5H.0 is a **pure deterministic transformation** over evidence that is already frozen. It pools the
classifier records of ONE explicit cohort and derives **19 numeric features**. There is **no routing** from this
phase and no downstream consumer yet.

```text
Jev:      false
DeepSeek: false
Arena:    false
Trading:  false
```

- The classifier-derived features are **DESCRIPTIVE ONLY**. They are **not** alpha, **not** signal strength,
  **not** sentiment, **not** trading direction, **not** project quality, **not** legitimacy, **not** fraud
  probability, **not** profitability, **not** expected return, **not** market health and **not** buy/sell
  probability. They have no authority over the Arena, evolution, gates, replication or deployment.
- Phase 5H.0 is **DEVELOPMENT-only**: the source evidence class is `DEVELOPMENT_CLASSIFIER_EVIDENCE` and the
  only permitted transition is

  ```text
  DEVELOPMENT_CLASSIFIER_EVIDENCE  →  DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES
  ```

  Any other source evidence class **fails closed**. A 5H.0 artifact never claims `CLEAN_REPLICATION`,
  `VALIDATION`, `TEST`, `OOS` or `PRODUCTION`. **A future clean validation requires entirely new evidence** —
  no 5H.0 artifact may be relabelled or reused for it.
- Phase 5H.0 is **offline only**: it reads frozen classifier experiments and their frozen source captures from
  disk and makes **zero network calls** — no classifier.dev, no Agent-Reach, no Jev, no DeepSeek, no Arena, no
  trading. It never reclassifies and never captures.
- **One evidence unit = ONE frozen cohort.** There is no automatic cohort discovery, no "latest cohort", no
  multi-cohort artifact, no source-capture-level artifact and no classifier-experiment-level artifact. If one
  experiment needs features, the operator first freezes a one-experiment cohort.
- **Aggregation is record-weighted and reconstructed record by record** from the frozen cohort evidence —
  never averaged from experiment summaries: `C = Σ classifiedCount_e`, `n_l = Σ n_e,l`,
  `fraction = total count / total classified count`.
- **Aggregation is never inferred from partial evidence**: `0` never stands for unknown. Unavailable derived
  quantities are `null`.
- The definition **imports** the frozen classifier identity (`reach-signal-type-v1` v1, nine labels, the
  classifier definition digest, the instructions digest and `classifier-input-projection-v1`) from the sealed
  Phase 5G.0 module and never redeclares it. A wrong classifier id/version/projection or a **mixed** version,
  projection, classifier-definition digest or instructions digest is **refused** (no fallback to "latest").

### Feature definition — `classifier-feature-definition-v1` (Phase 5H.0)

```text
classifierId            reach-signal-type-v1          (imported)
classifierVersion       1                             (imported)
taxonomyLabels          9 descriptive labels          (imported)
entropyNormalizationK   9
entropyLogBase          natural (Math.log)
confidenceLow           { comparator: "lt",  threshold: 0.50 }   # 0.50 is NOT low
confidenceHigh          { comparator: "gte", threshold: 0.90 }   # 0.90 IS high
marginAmbiguous         { comparator: "lt",  threshold: 0.10 }   # 0.10 is NOT ambiguous
scoreVectorCompleteness all_nine_labels_present
rounding                round6
quantileMethod          linear_interpolation_sorted_ascending
featureValueDomain      number|null
groups                  {}                                    # no grouped semantic features
```

The definition carries a **computed** digest (`FEATURE_DEFINITION_DIGEST`) that is never hard-coded; the CLI,
the artifact audit and the validation suite all report the actual value. Print it with
`npm run intelligence:classify-features -- --definition`.

### The 19 canonical features (exact order)

```text
 1. label_fraction_technical_activity
 2. label_fraction_project_announcement
 3. label_fraction_exchange_or_listing
 4. label_fraction_liquidity_or_market_structure
 5. label_fraction_security_or_risk
 6. label_fraction_governance_or_admin
 7. label_fraction_community_attention
 8. label_fraction_promotion_or_marketing
 9. label_fraction_unrelated_or_noise
10. observed_label_count
11. label_entropy_normalized
12. largest_label_fraction
13. confidence_mean
14. confidence_median
15. confidence_low_fraction
16. confidence_high_fraction
17. score_margin_mean
18. score_margin_median
19. score_margin_ambiguous_fraction
```

No other field is persisted in v1. `observed_label_fraction` is **deliberately absent** (redundant), HHI is
**absent**, score entropy stays **evaluation-only**, and the `<0.05` / `<0.20` margin bands and the p10/p25/p75/p90/
min/max confidence diagnostics stay in the Phase 5G.1 evaluation — they are never copied here.

### Formulas

```text
C    = pooled classified records over the cohort (Σ classifiedCount_e)
n_l  = pooled classified records whose label === l

label_fraction_l              = round6(n_l / C)                      # 0 is a TRUE ZERO, never missingness
observed_label_count          = # of taxonomy labels with n_l > 0     # integer
label_entropy_normalized      = round6( -Σ(p_l · ln p_l) / ln(9) )   # p_l = 0 terms ignored
largest_label_fraction        = round6(max(n_l) / C)                 # ties: frozen taxonomy order

confidence_mean               = round6(mean(confidence))
confidence_median             = round6(linear quantile at 0.5)
confidence_low_fraction       = round6(count(confidence <  0.50) / C)
confidence_high_fraction      = round6(count(confidence >= 0.90) / C)

margin                        = highest_score - second_highest_score  # COMPLETE vectors only
C_s                           = # of classified records with a complete score vector
score_margin_mean             = round6(mean(margin))
score_margin_median           = round6(linear quantile at 0.5)
score_margin_ambiguous_fraction = round6(count(margin < 0.10) / C_s)
```

Entropy is always normalized over the **entire taxonomy** (`ln(9)`), never over the number of observed labels;
a single observed label is exactly `0`. High entropy is descriptive only — it is **not** "good" and it is
**not** "bad". Each record's margin is rounded to 6 decimals **before** aggregation, so the persisted
mean/median/ambiguous-fraction reproduce the sealed 5G.1 `scoreMargin` diagnostics exactly.

### Null and missing semantics

```text
classifiedCount = 0                     → FeatureNoEvidenceError, nothing is written
confidence missing / NaN / < 0 / > 1    → integrity error, never skipped silently
score vector incomplete                 → that record is excluded from the MARGIN denominator only;
                                          label/confidence features still use it
no complete score vector                → all three margin features are null (never 0)
```

A present-but-out-of-range or non-numeric score is an integrity error, never coerced. The artifact records
`scoreVectorCompleteCount` / `scoreVectorIncompleteCount`, `recordCount`, `classifiedCount`,
`skippedEmptyCount` and `nullFeatureCount`, so every excluded record is accounted for.

### Feature artifact

```text
.evolve/classifier/features/<feature-id>/feature.json
feature-id = clfeat-<UTC stamp>-<first 8 hex of the IDENTITY digest>
```

The artifact persists the schema version and phase, `featureId`, `featureDefinitionVersion`,
`featureDefinitionDigest`, the derivation evidence class pair (`sourceEvidenceClass` → `evidenceClass`), the
classifier identity (`classifierId`, `classifierVersion`, `classifierDefinitionDigest`, `instructionsDigest`,
`inputProjectionVersion`), the cohort identity (`cohortId`, `cohortDigest`), provenance counts and digests
(`experimentCount`, `captureCount`, `experimentIds`, `sourceCaptureIds`, `experimentDigests`, `resultDigests`,
`captureManifestDigests`, `recordsDigests`, `experimentRecordCounts`, `infrastructureExperimentPresent`),
pooled counts (`recordCount`, `classifiedCount`, `skippedEmptyCount`, `distinctRecordDigestCount`,
`duplicateRecordDigestCount`, `scoreVectorCompleteCount`, `scoreVectorIncompleteCount`, `nullFeatureCount`),
the descriptive `counts` block (`labelCounts`, `largestLabel`, `largestLabelCount`), the 19 `features`, the
`aggregation` block, the `timeline`, the `routing` block, the frozen flags (`immutable`, `finalized`,
`descriptiveOnly`, `developmentOnly`, `noGroundTruth`, `noProfitabilityInference`), `createdAt`, `featureDigest`
and a `note`.

It contains **no** raw source text, title, excerpt, URL, author, query, credential, raw provider response,
classifier input, HTTP header or API key. Feature keys are **numeric or null only**.

Duplicate record digests are **reported, never refused**: `distinctRecordDigestCount` and
`duplicateRecordDigestCount` are persisted and are not reinterpreted (legitimate overlap across experiments is
allowed).

### Identity and digests

```text
featureId     = clfeat-<UTC stamp of createdAt>-<identityDigest[:8]>
identityDigest = digestOf(artifact EXCLUDING featureId and featureDigest)
featureDigest  = digestOf(artifact EXCLUDING only featureDigest)   # covers featureId, createdAt, provenance, features, flags
```

Replay rederives **both**. There is no second, parallel canonical hash.

### Timeline (no lookahead, no backdating)

```text
timeline.earliestCaptureAt    earliest frozen source-capture time
latestCaptureAt               latest frozen source-capture time
latestExperimentAt            latest classifier-experiment creation time
evidenceAsOf                  max(latestCaptureAt, latestExperimentAt)
featureCreatedAt              the build clock
```

`featureCreatedAt >= evidenceAsOf` is enforced: a build earlier than its evidence throws `FeatureTimelineError`.
There is no retrospective injection. A later classifier experiment requires a **new cohort** and therefore a
**new feature artifact** — an existing artifact is never mutated.

### Write-once

Feature artifacts are written once with exclusive semantics. An existing artifact is **never** overwritten: a
byte-identical rebuild throws `FeatureExistsError` and leaves the bytes untouched. The feature output root must be
outside the capture root. Source captures, classifier experiments and cohorts are never modified.

### Audit (before write, during replay, in validation)

One exported audit function proves, for every artifact: exact top-level key whitelist; exact 19 feature keys in
canonical order; numeric-or-null values only; a frozen semantic-smuggling name denylist (`bullish`, `bearish`,
`alpha`, `signal_strength`, `opportunity`, `risk_score`, `legitimacy`, `quality`, `fraud`, `buy`, `sell`,
`profit`, `pnl`, `expected_return`, `market_health`, `token_quality`, `direction`, …) plus the sealed 5G.1
forbidden metric keys; an empty group space (explicitly rejecting `technical_fraction`,
`market_structure_fraction`, `governance_admin_fraction`, `announcement_fraction` and any persisted
`groups` container); text-free (no raw text key, no URL-like string, no author/query/credential); all four routing
flags strictly false; and the arithmetic invariants

```text
Σ labelCounts === classifiedCount                label fractions ∈ [0, 1], Σ ≈ 1 (≤ 0.0000045)
observed_label_count === nonzero label count     largestLabelCount === max count
0 ≤ entropy ≤ 1                                  single observed label ⇒ entropy === 0
complete + incomplete === classifiedCount        recordCount === classifiedCount + skippedEmptyCount
nullFeatureCount === actual null count           all vectors complete ⇒ nullFeatureCount === 0
```

### CLI

```bash
# build + freeze ONE feature artifact from ONE explicit frozen cohort
npm run intelligence:classify-features -- --cohort <clcohort-id>

# offline, zero-network replay (identity, digests, cohort/experiment/capture integrity, every feature)
npm run intelligence:classify-features -- --replay --feature <clfeat-id>

# offline stats (works WITHOUT a capture root)
npm run intelligence:classify-features -- --stats  --feature <clfeat-id>

# print the frozen definition and its ACTUAL digest
npm run intelligence:classify-features -- --definition
```

Options: `--out <classifier-root>`, `--captures <capture-root>`, `--json`, `--help`. There is **no** provider
option, **no** network option, **no** routing option and **no** classification option; there is **no latest** —
every action needs an explicit `clcohort-*`/`clfeat-*` id, exactly one action at a time, and replay/stats are
mutually exclusive. Errors are prefixed `[classify-features]` and exit non-zero.

`--replay` proves: `featureReadable`, `featureId`, `featureDigest`, `featureIdentity`, `definitionPin`,
`frozenFlags`, `evidenceClass`, `sourceEvidenceClass`, `noRawText`, `noForbiddenKeys`, `noForbiddenNames`,
`featuresNumericOnly`, `noGroupKeys`, `routingInactive`, `timeline`, `cohortPresent`, `cohortIdentity`,
`cohortDigest`, `cohortEvidenceClass`, `cohortClassifier`, `cohortProjection`, `experimentsIntegrity`,
`capturesIntegrity`, `counts`, `labelDistribution`, `confidence`, `scoreMargin` and
`featureDigestReproduced` — with `networkCalls: 0`, no reclassification and no writes.

`--stats` reports the feature id, definition version + digest status, evidence class pair, cohort id + digest
status + cohort verification, experiment/capture counts, record/classified/skipped counts, distinct/duplicate
record digests, complete/incomplete score vectors, null feature count, all nine label counts and fractions,
observed label count, entropy, largest label/count/fraction, confidence mean/median/low/high, margin
mean/median/ambiguous, the **display aliases** `noise fraction` and `promotion fraction` (the same two canonical
features, never additional ones), `evidenceAsOf`, `createdAt`, the feature digest + status, the four routing
flags and `networkCalls: 0`. There is **no verdict, no ranking, no gate and no predictive claim**.

### Boundaries

- **No Jev packet exists in Phase 5H.0** (documented only). A future phase MAY whitelist the 19 numeric features
  plus `featureId`, `featureDefinitionVersion`, `featureDefinitionDigest`, `cohortId`, `cohortDigest`,
  `featureDigest`, `evidenceClass`, `sourceEvidenceClass`, `classifiedCount`, `recordCount`, `skippedEmptyCount`,
  `experimentCount`, `captureCount`, `scoreVectorCompleteCount` and `evidenceAsOf`. Raw label counts, the largest
  label string, duplicate-record details, other timeline fields, evaluation-only diagnostics, text, URLs,
  authors, audit samples, per-label confidence, score entropy and channel breakdowns are **not** for Jev.
- **No dashboard changes in Phase 5H.0.** A future display MAY surface the numeric features and the two display
  aliases; nothing under `src/**` or `scripts/lib/dashboard-state.mjs` is touched by this phase.
- 5H.0 **activates nothing**: no routing, no thresholds, no gates and no automatic loop.

### Validation

```bash
npm run validate:phase5h   # 139 offline checks: definition pin + 19-feature order, identity/digest exclusions,
                           # record-weighted aggregation (50-record vs 5-record proof), every formula and boundary,
                           # null semantics, every refusal, the artifact audit, replay tamper cases, stats/CLI,
                           # timeline, existing barriers, a canonical 5G.1 cross-check and the canonical 5H.0 barrier
```

The suite also cross-checks the real frozen 5G.1 evidence when it exists locally: it recomputes the 5H.0 values
from the canonical cohort **without writing anything** and proves that all nine label fractions, the entropy
(`labelDiversity`), the largest-label concentration, the confidence mean/median/`<0.50`/`>=0.90` fractions, the
margin mean/median/`<0.10` fraction and both aliases agree **exactly** with the frozen evaluation.

### Canonical Phase 5H.0 barrier

The operator froze exactly **ONE** canonical 5H.0 artifact and replayed it successfully. It is the permanent
research barrier for the phase, pinned in `scripts/validate-phase5h.mjs`:

```text
feature id         clfeat-20260919T173844Z-7a9193bb
feature digest     65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b

definition version classifier-feature-definition-v1
definition digest  9227c8ef12414951bd48fe4c4c2a9ea2d1b69f4485f1019157912e32bc0093bd

source cohort      clcohort-20260919T163609Z-4d7c6dd9
cohort digest      2a8b9ca38f6f1f9dad7a46426c9a42cece2ca9fa3722815c430d42098b9e1a04
evidence class     DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES
source class       DEVELOPMENT_CLASSIFIER_EVIDENCE
evidenceAsOf       2026-09-19T16:34:12.867Z
```

When the artifact is present locally the suite inspects it **READ-ONLY** (it never creates, rewrites or
reclassifies anything) and verifies the exact id/digest, both recomputations, the definition version/digest, the
source cohort id/digest, the evidence classes, `evidenceAsOf`, `100 / 100 / 0` records / classified / skipped,
`100` distinct and `0` duplicate record digests, `100` complete and `0` incomplete score vectors, `0` null
features, the exact 19 canonical values, record-weighted aggregation with `experimentsAveraged === false`, all
four routing flags strictly false, every frozen flag true, a clean artifact audit, and an offline replay whose
integrity is OK and whose reproduced feature digest is the pinned one with **zero network calls**. When the
artifact is absent (e.g. fresh CI without the operator's local evidence) those cases **skip cleanly** rather
than failing; all other barriers still run.

This is **DEVELOPMENT evidence**, and it is **descriptive only**. It **proves no predictive edge**, has **no
routing authority** (Jev, DeepSeek, Arena and trading all stay false), and **any future clean replication
requires entirely new data** — the label is never reusable. The canonical `.evolve` artifact itself **remains
local and gitignored** (`.evolve/` is never committed) and is **never copied into source control**; only this
documented barrier — the ids and digests above — is tracked in Git.

### Phase 5H.0 checklist

- [x] Frozen `classifier-feature-definition-v1` importing (never redeclaring) the sealed classifier identity, with a computed definition digest
- [x] Exactly 19 numeric features in canonical order; no groups, no HHI, no `observed_label_fraction`, no score entropy, no evaluation-only diagnostics
- [x] Record-weighted cohort aggregation reconstructed record by record (`C = Σ classifiedCount_e`), never averaged experiment summaries
- [x] `0` never stands for unknown: incomplete score vectors are excluded from the margin denominator only and yield `null` margin features
- [x] One-entry evidence-class transition `DEVELOPMENT_CLASSIFIER_EVIDENCE → DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES`; anything else fails closed
- [x] Fail-closed refusals: zero evidence, wrong/mixed classifier id/version/projection/definition digest/instructions digest, unknown label, bad cohort digest, unmapped evidence class, backdated build, output root inside the capture root
- [x] Audit before write + during replay + in validation: exact key whitelist, numeric-only values, semantic-smuggling denylist, empty group space, text-free, routing all false, arithmetic invariants
- [x] Write-once artifact under `.evolve/classifier/features/clfeat-…/feature.json`, outside the capture root; `clfeat` identity and `featureDigest` both rederived on replay
- [x] Offline `--replay` / `--stats` / `--definition` CLI with zero network calls, no provider/network/routing/classification option and no implicit latest
- [x] Timeline barrier: `evidenceAsOf = max(latestCaptureAt, latestExperimentAt)` and `featureCreatedAt >= evidenceAsOf`
- [x] Duplicate record digests reported (distinct + duplicate counts), never refused or reinterpreted
- [x] Routing stays false (Jev/DeepSeek/Arena/Trading); no Jev packet and no dashboard change in 5H.0
- [x] Canonical 5G.1 cohort/evaluation/experiments/captures, Wave 1, Wave 2, the frozen cohorts, six datasets and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5h` — 139 offline checks
- [x] Canonical `clfeat-20260919T173844Z-7a9193bb` artifact — operator-frozen and successfully replayed, now a permanent READ-ONLY research barrier (see **Canonical Phase 5H.0 barrier** above); it is **not** evidence about profitability or market usefulness

```bash
npm run intelligence:classify-features -- --cohort clcohort-20260919T163609Z-4d7c6dd9
```

## Phase 5I.0b — Direct TypeSafe Jev Short-Horizon Directional Prediction Benchmark

> **Phase 5I.0b is a direct-TypeSafe Jev directional prediction benchmark.** It measures **predictive
> information only**. It is **not** a profitability claim, **not** an execution simulator, and it gives Jev
> **no trading authority whatsoever**.

The frozen research question is:

> Does direct TypeSafe Jev contain short-horizon directional information about SOL/USDC price movement beyond
> simple deterministic baselines, using only information available before the outcome?

### Scope, frozen

| Element | Frozen value |
| --- | --- |
| Market | **SOL / USDC only** |
| Primary horizon | **30 seconds** (`targetAt = stateFrozenAt + 30s`) |
| Default protocol | 120 scheduled observations, 30-second cadence (~1 hour) |
| Evidence class | `DEVELOPMENT_JEV_DIRECTION_EVIDENCE` — development evidence only |
| Provider | `typesafe-jev` only (`upstreamProvider: typesafe-ai`, `gatewayUsed: false`, `mode: shadow`) |
| Model | `jev-1.13.0` only |
| Question set | `jev-microstructure-direction-v1` v1 |
| Packet | `JEV_MICROSTRUCTURE_DIRECTION_PACKET` v1 |
| Outcome | `HIGHER` / `LOWER` / `TIE`, ties **retained** and excluded from binary scoring |

### Development evidence only

5I.0b artifacts are **development** evidence. They are never called validation, out-of-sample, test or
replication evidence, and they carry `developmentOnly`, `paperOnly`, `shadowOnly`,
`noProfitabilityInference`, `noTradingInference`, `noDeploymentInference` and
`noGroundTruthBeyondObservedFutureOutcome`. A later Phase 5I.1 must use **fresh unseen data** before anything
can be described as replicated.

### No confidence threshold, every valid prediction retained

There is **no** runtime Jev confidence threshold in this phase. `EVOLVE_JEV_MIN_CONFIDENCE` does not exist,
`minConfidence` is not a resolved config property, and no prediction is discarded because `pHigher` is close
to `0.5`. Every valid probability pair is stored, and a near-neutral `pHigher = 0.500001` is retained and
scored. Offline analysis may inspect probability bins later; the runtime never thresholds.

### The question

```text
Using ONLY the frozen market state supplied with this request (information observed at or before
stateObservedAt, with no future data), will the SOL/USDC reference price be HIGHER 30 seconds after
stateObservedAt than its reference price at stateObservedAt?
```

Jev answers with a `noul` probability. The stored output is the raw pair `pHigher` / `pLower` with
`pLower = 1 - pHigher`; it is **never** reduced to BUY/SELL or UP/DOWN, and Jev never chooses the horizon, the
target definition, whether an observation is scored, or anything about risk or routing.

### Reference price

One deterministic, versioned definition, derived only from the frozen observation and identical for `t0` and
for the outcome: the observed **USD reference price of the base mint in the same observation cycle** — the
price EVOLVE already derives from its Jupiter observation, not a new parallel price feed. The exact formula,
version and digest are printed by `npm run jev:direction -- --definition` and recorded in every experiment
manifest. The definition is **never** optimized against 5I outcomes.

### Timestamps — no collapsed clock

Market time, receipt time, freeze time, model time and outcome time are **separate persisted fields**:
`sourceEventAt`, `receivedAt`, `stateObservedAt`, `stateFrozenAt`, `predictionStartedAt`,
`predictionCompletedAt`, `predictionFinalizedAt`, `targetAt`, `outcomeSourceEventAt`, `outcomeReceivedAt`,
`outcomeObservedAt`. An unavailable **source** timestamp is `null` — local receipt time is never relabelled as
venue time. The full causal chain (`sourceEventAt <= receivedAt <= stateFrozenAt <= predictionStartedAt <=
[predictionCompletedAt] < targetAt <= outcomeReceivedAt`) is enforced, and a violation makes the observation
invalid. Staleness is measured with **separately named** source-age and receipt-age fields against a frozen
conservative cutoff; a stale scheduled observation stays stale and is never refreshed or replaced.

### Baselines and same-state fairness

Deterministic baselines (`neutral`, `momentum`, `meanReversion`, plus quote/liquidity ones where the observed
data genuinely supports them) are computed from **the exact same frozen state** Jev receives. Every baseline
pins the same `stateDigest`, and replay proves it. A baseline that cannot produce a real prediction from that
state is **excluded** from its own metrics rather than scored as a fabricated `0.50` call. No coefficient is
fitted to 5I outcomes.

### Strict no-lookahead audit

The lookahead audit is **behavioural**, not a source-code scan: for every historical `t0`, features and
baselines are recomputed from history ending at `t0`, then observations occurring **after** `t0` are appended
and the **same** `t0` value is recomputed. Any change is a **hard lookahead failure**. A separate
**recursive/startup stability** audit recomputes the same `t0` with different valid pre-`t0` startup lengths
(30/60/120/240/full) and reports divergence as a **diagnostic** — startup instability is never labelled
lookahead, and warmup is never tuned against target outcomes.

### Jupiter data is not L2/L3 order-book data

EVOLVE observes an **aggregate** Jupiter feed. A Jupiter quote is **not** an order book. No order-book
imbalance, CVD, queue depth, queue position, maker flow, L2 depth, L3 order or aggressive-buyer/seller volume
concept exists in 5I — those families are declared **unavailable** with reasons instead of being approximated,
and a static + behavioural granularity guard rejects any feature vocabulary that implies them.

### Immutability, outcome attachment, replay

A prediction is written **before** an outcome exists and is never mutated; its digest is frozen. The outcome
artifact references that digest and re-verifies it, and a mismatch **fails closed** (no scoring, no
reinterpretation). An outcome is resolved only at or after `targetAt`, from the first acceptable future
observation within a frozen tolerance; otherwise the result is `OUTCOME_UNAVAILABLE`.

```bash
npm run jev:direction -- --replay --experiment <id>   # networkCalls: 0, jevCalls: 0, writing nothing
npm run jev:direction -- --stats   --experiment <id>  # read-only metrics report
```

Replay and stats require **no provider and no credential**; they re-derive every identity and digest, verify
timestamp causality, recompute features, baselines, labels and metrics, and emit explicit tamper failures for
a mutated prediction, a mutated outcome, a foreign baseline state, an inserted future observation or a moved
`targetAt`.

### Metrics

Brier score, binary log loss (with a frozen numerical epsilon used **only** for log-loss safety — stored
probabilities are never clamped), directional accuracy, scorable/HIGHER/LOWER/TIE/failed/late/stale counts,
mean and median `pHigher`, **fixed predeclared** calibration bins, Jev-minus-neutral and Jev-minus-baseline
Brier and accuracy deltas, full latency stats (mean/median/p90/p95/max) and physical-attempt statistics. There
is **no** PnL, profitability, Sharpe, Sortino, trade count, returns, expected return, deployment verdict or
automated winner — and no "Jev wins" label.

### Boundaries

- No trade execution, no wallet, no signer, no transaction, no order placement, no RPC write. 5I is prediction-only.
- No Vercel (`vercel-jev`) and no `mock-jev` fallback for canonical evidence; a failed direct call stays a failed observation.
- No routing into Arena scoring/gates, the genome compiler, evolution, champions, deployment, Shadow League, DeepSeek, classifier.dev, Agent-Reach or Phase 5H feature routing. The routing flags are persisted all-false, with `jevPredictionActive: true` distinguished from `jevTradingRoutingActive: false`.
- **Maker/queue simulation is deferred to a future Phase 5I.2**, and only after Phase 5I.1 replication and a genuinely granular feed (real depth, queue-ahead, placement/cancel timestamps, partial fills, fees, slippage). A touch must never imply a fill, and L2/L3 will never be manufactured from Jupiter quotes.
- New evidence tree `.evolve/jev-direction/experiments/<experiment-id>/` — separate from Phase 5D experiment storage.

### Canonical Phase 5I.0b development barrier

The completed canonical development experiment is a source-pinned, READ-ONLY historical identity. It is
never rewritten, and its interpretation is frozen as written words rather than an automated verdict:

```text
Canonical Phase 5I.0b development experiment:
jdir-20260920T063311Z-3a9163

120 / 120 observations were valid and scorable.

Jev:
Brier 0.2546
log loss 0.7024
accuracy 0.5000

Neutral baseline:
Jev delta Brier +0.0046
Jev delta log loss +0.0093
Jev delta accuracy -0.0167

The development dataset did not show a clear Jev advantage over neutral.

This is not replication and makes no profitability claim.
```

The remaining canonical relative results are preserved verbatim: vs `momentum-v1` −0.0145 / −0.0314 /
+0.0294, vs `mean-reversion-v1` −0.0001 / −0.0011 / −0.0294, vs `volume-flow-imbalance-v1`
+0.0058 / +0.0118 / +0.0083, and vs `momentum-liquidity-v1` −0.0021 / −0.0042 / +0.0294
(Brier delta / log-loss delta / accuracy delta). Its infrastructure was clean: 120 `JEV_OK`, 0 failed,
0 late, 0 transport retries, 0 tamper, 0 outcome-window exclusions and 7140 lookahead recomputation pairs;
outcome offsets averaged 5977 ms (max 6005 ms), the achieved horizon averaged 36118 ms, and Jev latency
averaged 698 ms. `npm run validate:phase5i` verifies all of it read only whenever the experiment directory
is present locally, and skips those filesystem-specific cases cleanly when it is absent.

The frozen interpretation is:

> Phase 5I.0b showed no clear directional advantage for Jev over the neutral baseline. This is DEVELOPMENT
> evidence only. No persistent edge has been established. No profitability inference is permitted.

No automated winner is emitted anywhere, and **none** of the predictive protocol was modified because of
these results.

### Validation

```bash
npm run validate:phase5i   # 287 offline checks, zero network, sections A–AL
```

Sections: frozen identities, question-set contract, packet whitelist, feature formulas, warmup/null
behaviour, lookahead integrity, recursive/startup stability, reference-price contract, 30-second target
semantics, timestamp causality, staleness rules, prediction immutability, outcome attachment, TIE semantics,
probability validation, deterministic baselines, same-state fairness, Brier/log-loss/accuracy, calibration
bins, latency stats, provider/model/gateway enforcement, no runtime confidence threshold,
transport-attempt provenance, failed-prediction preservation, resume semantics, replay/tamper detection,
data-granularity integrity, zero routing/trading authority, frozen historical evidence preservation, CLI
behaviour, the canonical development barrier (AH), Phase 5I.1 session eligibility and drift rejection (AI),
the replication wave end to end (AJ), the replication CLI (AK) and 5I.1 isolation/no-tuning (AL). The suite
never creates canonical 5I evidence and never runs a real replication session: every fixture lives in a temp
directory, and the real `.evolve/jev-direction` tree (including its replication subtree) is asserted
byte-unchanged at the end.

### CLI

```bash
npm run jev:direction -- --start  --market SOL-USDC --max-observations 120
npm run jev:direction -- --resume  --experiment <id>
npm run jev:direction -- --resolve --experiment <id>
npm run jev:direction -- --replay  --experiment <id>
npm run jev:direction -- --stats   --experiment <id>
```

`--start` is the only action that may create an experiment; every other action requires an **explicit**
experiment id (there is no `--latest`). Runs are bounded and resumable, never a daemon. `--start` never
auto-runs from the dashboard, and there is no silent overwrite: reusing an existing id is refused.

## Phase 5I.1 — Fresh Jev Direction Replication

> **Phase 5I.1 is replication, not development, and still PAPER ONLY.** It re-runs the **exact frozen Phase
> 5I.0b protocol** against **fresh, unseen** SOL/USDC sessions. It adds no signal, changes no question
> wording, no feature formula, no baseline coefficient, no horizon, no outcome tolerance, no staleness
> cutoff, no calibration bin, no metric formula and no threshold, and it gives Jev **no** authority.

The frozen scientific question is:

> Does the exact Phase 5I.0b direct-TypeSafe Jev directional protocol reproduce its predictive behavior on
> multiple fresh, unseen SOL/USDC market sessions?

### Frozen protocol — fail closed, no "compatible enough"

A session is replication evidence only when **every** semantic pin matches the frozen development experiment
**and its digest**: market `SOL-USDC`, provider `typesafe-jev`, model `jev-1.13.0`, `gatewayUsed: false`,
mode `shadow`, horizon 30 s, cadence 30 s, 120 observations per session, outcome-resolution **v2**
(10000 ms), question set `jev-microstructure-direction-v1`, feature definition
`direction-feature-definition-v1`, baseline definition `direction-baseline-definition-v1`, the exact
Phase 5I.0b reference-price definition, metric definition **v2**, and **no confidence threshold**. Any
mismatch makes the session ineligible — it is never reconciled.

### One deterministic protocol digest

`replicationProtocolDigest` is derived from the frozen source constants as they are today, and is
**reproduced identically** by the canonical development experiment and by every replication session. No
timestamp, session id, experiment id or file path is ever part of it.

```text
1cc0661cf207d861e9809b3374ff70ce3a6434a7b49acc17598d5928935a5fb3
```

It covers the market and mints, the reference-price definition, the horizon and target basis, the cadence,
the session size, the provider/upstream/model/gateway/mode forecaster identity, the question set and packet,
the feature definition, the baselines, the metrics, the outcome-resolution policy (version, digest, bound and
selection rule), the staleness policy (version, digest and both cutoffs), the probability semantics, and the
no-threshold rule.

### Replication evidence class

Real replication sessions carry the distinct class `CLEAN_JEV_DIRECTION_REPLICATION_EVIDENCE` and the flags
`developmentOnly: false`, `replicationOnly: true`, `noProfitabilityInference`, `noTradingInference`,
`noDeploymentInference`, `paperOnly`, `shadowOnly`. They are **never** labelled
`DEVELOPMENT_JEV_DIRECTION_EVIDENCE`. The class is chosen when an experiment is created
(`--start --replication-session`) and can never be changed afterwards.

### Freshness and independence

A replication session must start **after** the canonical development experiment completed, and its
observation window must not overlap the development window or another session's window. Every session
persists `sessionStartedAt`, `sessionCompletedAt`, `earliestObservationAt`, `latestObservationAt`,
`developmentExperimentId`, `developmentLatestObservationAt` and `temporalOverlap`, and a wave requires
`temporalOverlap = false`. Overlap is **symmetric**: a newly added session that overlaps an existing CLEAN
session contaminates **both**, so the manifest can never keep a stale "clean" label. An overlapping session
is recorded as `CONTAMINATED` with its reasons and excluded from aggregation — never silently discarded.

### Three independent sessions, aggregated by SESSION

```text
3 independent real sessions × 120 observations each
primary inference unit: dataset/session  (never the individual observation)
```

The three sessions are **never** concatenated into a single N=360 experiment, and the cross-session summary
is **equal-weighted by eligible session**, so a session with a few more scorable observations is never
weighted more heavily. For each of the five frozen comparisons (`neutral-v1`, `momentum-v1`,
`mean-reversion-v1`, `volume-flow-imbalance-v1`, `momentum-liquidity-v1`) the summary reports
`sessionCount`, `values`, `mean`, `median`, `min`, `max`, `positiveCount`, `negativeCount` and `zeroCount`,
plus `jevBetterCount` / `baselineBetterCount` / `equalCount` for Brier and log loss. The sign convention is
unchanged and printed on every report:

```text
negative Brier delta    = Jev has a LOWER Brier score than the baseline
negative log-loss delta = Jev has a LOWER log loss than the baseline
accuracy delta is Jev minus baseline (higher is better)
```

No winner field is ever produced, and no observation-level pseudo-replication is permitted.

### Uncertainty — descriptive only

With fewer than 3 CLEAN sessions the wave reports `INSUFFICIENT_CLEAN_REPLICATION_SESSIONS` and no interval.
With 3 or more, a **deterministic, session-level** bootstrap (fixed `mulberry32` seed, fixed resample count)
resamples **sessions**, never observations, and reports a percentile interval described as exactly that: an
interval. There is **no p-value, no significance label, no "statistically proven" language**, and no verdict.

### Replication tree and manifest

```text
.evolve/jev-direction/replication/<replication-id>/
  replication.json   frozen manifest: development id + digest, protocol digest, every expected pin, no-tuning rules
  sessions.json      one record per ADDED session — CLEAN, CONTAMINATED or INELIGIBLE, with explicit reasons
  summary.json       the frozen cross-session aggregation, its digest and the descriptive interval
```

The manifest **references** the immutable `jdir-*` experiments by id (and pins each one's metrics digest). It
never copies, edits or re-scores their raw artifacts, and the observation-level detail stays exactly where it
was frozen.

### Operator-only, never automatic

The implementation **never launches a replication session**. The operator runs each 120-observation session
manually, reviews its integrity, and only then adds it to the manifest.

```bash
# 1. create the manifest (source-pins the canonical development barrier; runs nothing)
npm run jev:direction -- --replication-create \
  --development jdir-20260920T063311Z-3a9163

# 2. run ONE fresh session by hand (real direct-TypeSafe Jev; 120 observations, ~1 hour)
npm run jev:direction -- --start --replication-session \
  --market SOL-USDC --max-observations 120

# 3. review and record it (offline: reads + replays the finished session, launches nothing)
npm run jev:direction -- --replication-add \
  --replication <replication-id> --experiment <fresh-jdir-id>

# 4. verify and read the wave (both offline, zero network)
npm run jev:direction -- --replication-replay --replication <replication-id>
npm run jev:direction -- --replication-stats  --replication <replication-id>
```

There is no `--latest`: every command takes an explicit id. `--replication-session` refuses `--allow-mock`,
`--allow-unsafe-model`, a non-120 session size, a non-30 s cadence and any outcome bound other than policy
v2 **before** a single observation is taken, so a mistyped replication run cannot burn an hour of real
observations and then be discarded. After session 1, after session 2 and after session 3 the protocol is
**not** modified: if infrastructure breaks, the wave is declared interrupted and incomparable rather than
silently patched midway.

### Frozen interpretation

A replication session is **not** a replication result. Wave-level description comes only from the frozen
cross-session aggregation over CLEAN sessions, and even that makes **no profitability, trading or deployment
claim**, and establishes nothing about the future. As of this phase, **no real replication session has been
run**, and the canonical development result above still stands: no clear directional advantage over neutral,
no persistent edge, no profitability inference.

### Preserved barriers

`jdir-20260920T060810Z-3a9163` (v1 canary) and `jdir-20260920T062804Z-3a9163` (v2 canary) stay immutable
infrastructure evidence and are **never** promoted to replication evidence, as is the canonical development
experiment itself. Phase 5H.0 (`clfeat-20260919T173844Z-7a9193bb`, digest
`65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b`) and `evaluationContractDigest`
`4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052` are unchanged.

## Validation

```bash
npm run validate
```

- **Normalization** — null/missing/hostile fields, string numerics, non-finite rejection
- **Pool age** — derived from `firstPool.createdAt`, never from mint creation, epoch s and ms both handled
- **Ratios** — buy/sell ratios can never be `NaN` or `Infinity`
- **Universe** — duplicate mints merge, the universe is bounded, TTL eviction works
- **Stale feed** — a stale live feed blocks new entries and pauses flat agents
- **`auto` fallback** — explicit, reason-carrying, event-logged fallback to synthetic
- **`live` mode** — never silently falls back; degraded banner and paused entries instead
- **Secrets** — the API key never appears in config spread, state, errors, URLs, or request bodies
- **Paper fills** — fees and liquidity-dependent slippage are applied and capped
- **Fitness** — follows the documented net-of-cost formula, not gross
- **No execution path** — static scan of the repo plus dependency check
- **Synthetic offline** — works with no network and no key
- **State hygiene** — serializes with no `NaN`, `Infinity`, `undefined`, or secrets
- **Engine smoke** — generations, births, deaths, and paper trades all advance

Phase 3 adds `npm run validate:history` (30 offline cases):

- **Dataset format** — valid NDJSON, session header, columnar rows, manifest counts/intervals/fingerprint
- **Secrets** — no API key in a dataset, a manifest, an event log, or dashboard state
- **Classification** — live-only / synthetic-only / mixed / empty, with real-market replay denied to
  anything synthetic or mixed
- **Order and determinism** — replay preserves capture order; same dataset + config + seed reproduces
  genomes, fills, and statistics; different seeds diverge
- **Accelerated replay** — pacing changes wall-clock waiting only, never a decision or a genome
- **Look-ahead** — no observation newer than the current tick reaches an agent, backward-only features,
  forward-only reader, future reads rejected, stages bounded to their own intervals
- **Protocol** — training evolves; VALIDATE and TEST freeze genomes; frozen simulations cannot edit a
  genome even if asked to breed; reported digests match the frozen inputs
- **Windows** — contiguous train/validate/test slots, non-overlapping test periods, oversized requests
  fail clearly, scaled development windows available explicitly
- **Baselines** — no-trade keeps exactly its starting cash; traded baselines pay real simulated
  friction and never use future data
- **Champions** — minimum-evidence gates, explicit `INSUFFICIENT SAMPLE`, dataset fingerprint and seed
  recorded, unproven genomes denied champion status
- **Aggregation and fitness** — median/mean/worst/best across seeds, net-of-cost fitness, cumulative
  stage evidence that survives per-generation resets
- **Reports and integrity** — no `NaN`/`Infinity`, forbidden-capability scan, tamper detection via
  fingerprint, truncated/corrupt lines tolerated, live/replay/experiment state isolation
- **Phase 2 preserved** — synthetic mode still works offline, live mode still degrades instead of
  fabricating observations
- **Replay smoke** — record → replay → train/validate/test end to end, offline, in milliseconds

Phase 4 adds `npm run validate:arena` (26 offline cases):

- **Dataset registry** — real/synthetic/mixed classification, real evidence never counted from synthetic
- **Regime classification** — no look-ahead (a window's classification is unaffected by later windows),
  deterministic, ordered-rule and unknown-on-no-data
- **Stress engine** — every profile changes execution friction only, never price data; deterministic
  token-disappearance plan with a conservative close policy and no fabricated price
- **Arena Score** — penalises one-trade, one-token, one-seed, and catastrophic-drawdown profiles; pure
  and deterministic; bounded to [0, 100]
- **Survival gates** — insufficient evidence can never qualify; every gate must pass for a Deployment
  Candidate; mild-stress survival and zero-catastrophic-events are enforced when configured
- **Specialist/generalist** — classification reflects regime breadth honestly, with no data defaulting
  to generalist rather than a guessed label
- **Diversity and mutation** — genome diversity and lineage concentration are deterministic and bounded;
  adaptive mutation never leaves its configured bounds
- **Hall of Fame** — membership never implies Deployment Candidate status; title defenses require
  back-to-back qualifying arenas, not a first promotion
- **Champion re-entry** — a previous champion enters the pool and can be eliminated at qualification or
  keep winning at the group stage, exactly like any other entrant
- **Shadow League** — genomes are frozen (a milestone advance never touches the genome); development
  overrides are permanently labelled `UNQUALIFIED SHADOW TEST`; duration milestones only move forward; a
  degraded feed blocks new entries without fabricating a price
- **Cache** — keys change with dataset fingerprint, seed, stage, stress profile, and code version; reads
  reproduce exact writes; no secret-shaped string ever lands in a cache file
- **Tournament** — the full funnel runs end to end with no `NaN`/`Infinity`; ranking is deterministic;
  worker count never changes the evaluated result
- **No execution path** — the arena/shadow code is scanned for wallet, signing, and transaction-execution
  patterns exactly like Phase 2 and Phase 3

Phase 4.1 adds `npm run validate:phase41` (26 offline cases):

- **Concentration** — notional-based `topMintShare` bounded [0, 1]; equal/skewed/single-mint/no-trade
  cases; pools correctly across seeds and windows without max-of-per-run saturation
- **Regime wiring** — real-shaped fixture snapshots classify non-`unknown` labels; a window is classified
  only from its own TEST-interval snapshots; deterministic; the arena entrypoint actually threads
  `regimesByWindow` through to `regimePerformance` end to end
- **Live selection** — a one-trade lucky winner cannot outrank an evidenced moderate performer; evidence
  gate requires both trades and observations; default replacement stays in the configured 40–75% band;
  population size and birth/death bookkeeping stay exact across generations
- **Gene bounds** — Genesis Hunter's age bounds stay young-pool sane under 500 generations of mutation
  and under crossover with a wide-bounded species; every species keeps a distinct, finite pool-age
  niche; non-age gene bounds still hold
- **Output schema** — leaderboard rows carry compact `failedGates`, never the full candidate object;
  every funnel stage carries a `rule` string
- **No non-finite state** — a full arena run and a multi-generation live snapshot contain no
  `NaN`/`Infinity`

Phase 5A adds `npm run validate:phase5a` (78 offline cases):

- **Configurable population** — 48/96/192/arbitrary sizes stay exact across generations; invalid values
  clamp safely; `EVOLVE_POPULATION_SIZE` takes priority over the legacy `EVOLVE_POPULATION`; births
  restore the population exactly; deterministic initialization
- **Strategy islands** — target-count apportionment always sums exactly to the population (even split and
  explicit weights); birth allocation never gives an over-target island new births; island populations
  stay near target over many generations at 192; migration respects its per-generation cap; islands can
  be disabled without breaking population accounting
- **Proposal schema** — valid proposals accepted; unknown fields, unsupported genes, out-of-bounds
  ranges, and non-degenerate binary-gene ranges rejected; nine distinct executable-content payloads
  (`eval`, `require`, `process`, `fetch`, `javascript:`, dynamic `import`, shell, `new Function`, template
  execution) rejected; every researcher role produces an acceptable proposal
- **Deterministic compiler** — identical proposals compile to byte-identical genomes; compiled genomes
  never escape `GENE_BOUNDS`; compiler limits are tighter than or equal to the raw gene bounds; an
  unresolvable family is rejected; `maxCompilations` is enforced; every family name resolves via `x`/`×`/`*`
- **Research memory** — proposals/records/conclusions persist and reload; nothing non-finite or
  secret-shaped ever reaches disk; researchers demonstrably consult prior `REJECTED` conclusions;
  provider selection is fail-closed (unset → offline mock; an explicit unregistered name throws and
  never reaches the mock or the network)
- **Watchdog + quarantine** — single-mint dominance, very-low trade count, train→OOS collapse, and stress
  collapse are each independently flagged; enough flags escalate `NORMAL → WATCH → QUARANTINED`;
  `QUARANTINED` can never self-clear
- **Recursive cycle + promotion** — a full offline cycle proposes/validates/compiles/persists; a research
  cycle can never itself write `PROMISING`/`ARENA_SURVIVOR`/`SHADOW_ELIGIBLE`; promotion only happens
  from a genome-digest match against a real Arena leaderboard and is blocked for any quarantined family;
  an unmatched candidate is skipped, never promoted
- **Arena/paper-only protections untouched** — `DEFAULT_DEPLOYMENT_GATES` and `ARENA_SCORE_VERSION` stay
  exactly as Phase 4/4.1 left them; `PAPER_ONLY` stays `true`; every research module is scanned for
  wallet/signing/execution patterns exactly like Phase 2–4
- **ACTIVE/REDUCED_RISK/ABSTAIN** — deterministic and regime-driven; a research candidate's posture
  sequence replays identically for the same seed; an ordinary (non-research) agent's behavior is a
  byte-for-byte no-op
- **Shared feed** — `feed.markets()` is called exactly once per tick regardless of population size (48 vs
  192 issue the identical call count)
- **No non-finite state, no look-ahead** — a live run with islands and an injected research candidate
  stays fully finite; `"unknown"` (the classifier's no-data sentinel) is never offered as a proposable
  regime; culled research-candidate evidence survives until explicitly cleared

Phase 5A.1 is folded into `npm run validate:phase5a` (78 offline cases), which also covers the
`researchSwarm` vs `historicalResearch` state contract and source-selection rules.

Phase 5A.2 adds `npm run validate:phase5a2` (60 offline cases):

- **CLI parsing** — `--research DATASET`, `DATASET --research`, and `--research=true DATASET` all produce
  `research === true` with the dataset still positional and the exact requested dataset count preserved;
  `--research=false` / `--no-research` disable it; value flags and unknown-flag values still work
- **Uniqueness** — duplicate compiled genomes consume one slot, not several; rejection is deterministic;
  deterministic diversification stays inside the declared range **and** inside compiler bounds and
  reproduces exactly; compiler stats (requested / compiled / duplicate / diversified) are accurate
- **Novelty** — `uniqueGenomeRatio` arithmetic, the warning/failure thresholds at the configured minimum,
  and `ratioEnv` clamping/fallback; repeated provider output can never silently consume multiple slots
- **Species reachability** — all six strategy species are reachable through provider + compiler; the
  compiler does not silently default every proposal to Momentum; a small `maxCompilations` still spreads
  across families; the concentration guard flags a concentrated cohort, **preserves** the proposals, and
  never converts one into an unrelated species or alters a genome; evidence-driven targeting picks a
  different species than the silent-evidence rotation
- **Roles** — the adversarial critic is advisory-only; role-level metrics count proposals, schema
  acceptance, compilation, duplicate rejections, unique genomes, entrants, median score, best rank, gate
  failures, and watchdog verdicts; Arena scores are reported, never fed back into proposals
- **Provenance** — provenance is first-class on the entrant, survives into `candidates.json`, the
  leaderboard, and `summary.researchSummary`; exact research identity is distinguishable from descendant
  ancestry; a bred child never claims the original genome digest but keeps its ancestor ids
- **Status semantics** — gate status is explicit and separate from the legacy survivor label; a
  specialist that clears every gate reports `GATES_PASSED` while staying `ARENA SURVIVOR` and *not*
  deployment-eligible; every candidate exposes `highestStage`, `eliminatedAtStage`, `finalRank`, and a
  deployment gate status; the final eight are an explicit list
- **Promotion** — promotion reads explicit stage/gate information first and the legacy status string only
  as a fallback; a real Arena match is still required; quarantine still blocks promotion
- **Modes** — challenger appends research on top of the requested population; fair builds one mixed
  cohort, gives both lineages the same pre-evolution builder, never clones to fill a missing quota, and
  reports the shortfall
- **Accounting and diagnostics** — every entrant is ranked exactly once with dense 1..n ranks; top-50 /
  GROUP / failed-gate / top-8 research counts match the underlying rows; live runs carry distinct-mint
  diagnostics; the `minimum distinct mints` gate is verified unchanged
- **Determinism and safety** — a research Arena run is identical across worker counts; real vs synthetic
  evidence accounting is preserved; evaluated candidates keep species-specific gene bounds; no Phase 5A.2
  module contains a wallet, signing, or transaction-execution path

Phase 5C adds `npm run validate:phase5c` (96 offline cases):

- **CLI dispatch** — every command mode is exclusive (a table resolves exactly one action per
  invocation, and conflicting or impossible combinations fail loudly instead of silently choosing one);
  `--write-freeze` writes the freeze artifact and stops, with zero cohorts frozen, zero dataset
  discovery (proven with a non-directory history root that would fail loudly), zero plans, zero Arena
  subprocesses and zero unit artifacts; `--verify-freeze`, `--cohorts`, `--plan` and `--summary` each
  execute zero Arena subprocesses and write nothing; only the normal run executes units (proven against
  a stub Arena that records its own invocation); the canonical `rep-66884de4e460`, its freeze digest and
  the frozen cohort digests stay byte-identical throughout the suite
- **Freeze** — the artifact is clock-independent and deterministic; the digest is stable for identical
  config and changes when anything does; the critical Arena/runner/cache/evaluator versions, population,
  generations, seeds, stress profiles, survivor/breeder/mutation values, the gate table, evidence
  thresholds, concentration bounds, provider config and every research version are all recorded;
  critical drift FAILS verification while advisory drift is reported separately; a dirty tree or a
  changed commit is labelled `NON_CANONICAL`
- **Frozen cohorts** — the mock and DeepSeek cohorts are frozen with unique genomes, deterministic
  cohort digests, and a payload that verifies byte-for-byte against the manifest; refreezing is
  idempotent and never overwrites a different cohort
- **Datasets** — discovery validates contents instead of trusting a `-live` name; synthetic/mixed are
  separated and never counted as real; duplicate fingerprints count once; temporal overlap is detected
  with both overlap fractions; invalid/incomplete captures are rejected; the development dataset is
  classified `DEVELOPMENT` and never selected; walk-forward windows are never separate datasets
- **Leakage & eligibility** — clean captures are `CLEAN_REPLICATION`, a previously-evaluated dataset is
  `CONTAMINATED` (naming the arena), unavailable provenance is conservatively `UNKNOWN` and ineligible,
  and eligibility is proven performance-blind (adding scores/returns/ranks/gate status cannot change a
  decision)
- **Identity, resume, provenance** — deterministic `rep-`/`unit-` ids, one unit per provider × dataset,
  frozen cohorts staged into a unit-private research root that is never written to, the freeze digest
  and dataset fingerprint recorded on every unit, crash-safe resume (failed units are retried, completed
  units are not), an explicit labelled rerun, and equal resources / no cloning / strict species matching
- **Metrics & pairing** — within-run deltas, raw lower-is-better signs, a delta-of-deltas that requires
  the SAME dataset on both sides and is exactly `deepseek − mock`
- **Aggregation** — the dataset is the unit, genome rows are never pooled, positive/negative/zero counts,
  medians/means/quantiles, a deterministic dataset-level bootstrap, leave-one-out sensitivity (disabled
  below three datasets), read-only regime context, `significance: null`, `verdict: null`, the status
  vocabulary, and the `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` message
- **Plan status semantics** — a plan derives READINESS from its SELECTED eligible CLEAN datasets,
  EXECUTION from the units' own recorded statuses, and EVIDENCE from datasets with both providers
  complete: three datasets × two providers with zero executed units is `PLANNED` +
  `MULTI_DATASET_REPLICATION` and never `INSUFFICIENT_INDEPENDENT_REAL_DATASETS`, a 0/1-dataset selection
  still reports insufficient with the capture guidance (counting THIS command's selection), the plan
  writes nothing and spawns no Arena, and the completed-run aggregation/status vocabulary is frozen
  byte-for-byte
- **Integrity & safety** — the canonical Phase 5B arenas and the DeepSeek research experiment stay
  byte-identical, `compare:research` still declares no winner, the Phase 5B and strict A/B invariants
  still hold, no Phase 5C module contains a wallet/signing/execution path, and replication shells out
  only to the project's own Arena CLI with the deterministic provider pinned

Phase 5C.2 adds `npm run validate:phase5c2` (40 offline cases):

- **Predeclared definitions** — Wave 2 holds exactly the three declared dataset ids in order with
exactly the pinned fingerprints; Wave 1 ids are explicitly excluded; the manifest digest is
deterministic, ignores the clock and lifecycle, and changes with membership or any fingerprint
- **Stored manifests** — the on-disk `wave-1`/`wave-2` manifests equal the predeclared definitions;
Wave 1 is historical and points at `rep-66884de4e460`; the real Wave 2 captures still match the pins;
the wave-less replication identity is reproduced exactly and the Wave 2 id is deterministic and
distinct
- **Fail-closed validation** — duplicate ids/fingerprints, prior-wave reuse, Wave 1 inclusion,
contamination, the development dataset, synthetic/incomplete captures, altered fingerprints, unknown
datasets, temporal overlap, wrong cohort digests, freeze mismatch, Jev participation and provider
dependence are each rejected with a named reason
- **Plan & execution boundaries** — the wave plan is exactly six units with both providers per dataset
and no Wave 1 unit; it is deterministic; `--plan`, `--summary` and `--meta-summary` execute zero Arena
subprocesses; only the normal wave run executes units (six spawns against a stub Arena, never the real
`scripts/arena.mjs`)
- **Meta-summary** — dataset-level only, six observations across two waves, per-wave and combined
statistics, +/-/0 counts, dataset bootstrap, leave-one-dataset-out, leave-one-wave-out and between-wave
differences, `significance: null` and `verdict: null`; unfinished waves are reported as pending, never
fabricated; unknown wave ids fail closed
- **Isolation & byte-identity** — no Jev import/call, no network/provider, no wallet/signing/write path;
the canonical Wave 1 replication, the historical freeze, the frozen cohorts, both wave manifests and
all three Wave 2 captures stay byte-identical throughout the suite

Phase 5D adds `npm run validate:phase5d` (131 offline cases):

- **Registry & fail-closed selection** — Jev is disabled by default (zero network calls ever possible),
  `mock-jev`/`typesafe-jev`/`vercel-jev` are selected by name only, an unregistered name (including a
  typo near `vercel-jev`) throws `UnknownJevProviderError`, an unsupported `EVOLVE_JEV_MODE` is a
  configuration error, and Jev configuration is completely independent from `EVOLVE_RESEARCH_PROVIDER`
- **Provider factories** — all providers answer with the same normalized typed shape; `mock-jev` is
  deterministic and marks every answer `syntheticDecision: true`; `typesafe-jev` calls the documented
  endpoint with the pinned model and a Bearer header (verified through an injected `fetch`, never a
  live network call) and classifies HTTP 401/403, 429/5xx, connection failures, and timeouts into
  distinct explicit statuses; a missing API key never even constructs the SDK client
- **Vercel AI Gateway route** — `vercel-jev` defaults to `typesafe-ai/jev` (never `jev-latest`), sends
  the SAME fixed question set with `noul` mapped to the AI SDK's `boolean` type, passes `maxRetries: 0`
  so one EVOLVE call is exactly one provider attempt, wires the Jev timeout through an `AbortSignal`,
  and maps the gateway's typed answers back into the identical normalized shape. The two credentials
  are proven strictly separate (a gateway key never authenticates the direct route and vice versa),
  the gateway key is never printed, persisted, or copied into `EVOLVE_JEV_API_KEY`, a missing
  `AI_GATEWAY_API_KEY` is a configuration error *before* any request, and there is no fallback to
  `typesafe-jev` or to `mock-jev`. Gateway errors are distinguished explicitly (401/403 → auth,
  429 → rate limit, 5xx/503 → unavailable — never auth, 400/404/422 → config, malformed → invalid),
  metadata is bounded and cost-observational-only, and the whole route is exercised through a stubbed
  AI SDK evaluation layer with zero live network calls
- **Decision packet** — non-whitelisted genome parameters and invented regime labels are dropped,
  every excluded evidence class is declared, `auditJevDecisionPacket` flags every forbidden key (however
  deeply nested) and credential-shaped value, the market packet never carries the deterministic regime
  label, and `jevDecide` refuses to send a packet that fails the leakage audit
- **Question sets** — the fixed candidate and market question sets, their bounded vocabularies, and the
  5-level evidence-quality rubric match the specification exactly and are never dynamically regenerated
- **Cache & budget** — cache identity is sensitive to every one of its six components, a cache hit makes
  zero provider calls, a corrupted cache entry is never reused, an exhausted budget refuses a call
  without ever reaching the provider, and a failed live call still consumes attempted-call budget
- **Shadow-only invariant** — no Arena/compiler/watchdog/simulation/genome source file references Jev in
  any way, and deterministic Arena scoring and gate evaluation are byte-identical whether Jev is
  disabled or a shadow prediction runs alongside
- **Calibration** — a pure, offline, post-outcome evaluator with correct Brier score / reliability bins
  / calibration error on crafted fixtures, pre-registered versioned target definitions, multi-label
  `primaryRisk` agreement (never a forced single-label ground truth), regime-shadow agreement computed
  without waiting for a later outcome, fixed threshold-coverage analysis with `noThresholdPromoted: true`
  always reported, and no import of the provider/runtime/decide path anywhere in the calibration module
  or CLI
- **Secrets & safety** — no Jev module contains a wallet/signing/shell-execution path, the real provider
  is only an HTTPS decision-API client with no filesystem/process access, and no dashboard/run-record
  field ever carries the API key
- **Regression & isolation** — Phase 5B stays fully green, the canonical Phase 5C replication
  (`rep-66884de4e460`), its freeze digest, and both frozen cohort digests stay byte-identical, no Jev
  source file references the untouched Wave 2 dataset, and exercising the Jev subsystem never touches
  `.evolve/datasets`, `.evolve/history`, or any Phase 5C artifact

Phase 5C.3 adds `npm run validate:phase5c3` (36 offline cases):

- **Byte identity** — Wave 1's freeze, its replication `rep-66884de4e460`, its frozen Mock/DeepSeek
  cohort digests and its three datasets stay byte-identical, and the historical freeze digest is
  unchanged
- **Evaluation contract** — deterministic, clock- and commit-independent, with the exact include/exclude
  lists declared in code; it is derived from the STORED historical freeze for Wave 1 (never regenerated
  from the current tree)
- **Isolation proofs** — a commit-only change alters the full freeze digest but NOT the evaluation
  contract digest; adding/changing intelligence or Jev orchestration code changes the git commit/full
  freeze but NOT the contract (proven through the contract's real import graph); an Arena scoring change,
  a gate change and a population/generation change each DO alter the contract; a cohort change blocks
  comparability
- **Freeze lifecycle** — `--write-freeze --wave` requires a clean tree, writes only that wave's freeze,
  binds the manifest to it, recomputes the manifest digest and replication id, and executes zero Arena
  units / zero Jev calls / zero DeepSeek calls; missing or stale wave freezes block a canonical run;
  `--dev` remains `NON_CANONICAL` and is excluded from the canonical meta-summary by default
- **Comparability** — the meta-summary accepts different full freeze digests when the evaluation
  contracts and both cohort digests match, and refuses with `INCOMPARABLE_WAVES` plus the explicit
  differing fields when they do not
- **Wave 2 barriers** — Wave 2 membership and fingerprints are asserted from registry metadata only,
  and Wave 1 stays excluded from Wave 2

Phase 5E adds `npm run validate:phase5e` (65 offline cases):

- **Fail-closed provider** — disabled by default and refuses every call, an unknown provider throws
  instead of falling back to the mock, and `shadow` is the only accepted mode
- **Mock parity** — the deterministic offline provider returns the exact same normalized record schema
  as the real adapter, and marks every observation `syntheticIntelligence: true`
- **Two-tier executables** — `version`/`health` resolve the exact pinned project-local `agent-reach`
  binary and nothing else; every data capability resolves the executable the frozen map declares
  (`gh`/`twitter`/`rdt`/`mcporter`/`curl`); an **offline spawn-spy** asserts the executable handed to
  `spawn` for all twelve capability entries (so `agent-reach search repos …` can never come back); an
  arbitrary, path-qualified or non-allowlisted executable is refused; query/candidate metadata and
  `EVOLVE_REACH_BIN` cannot change the executable; PATH handling is bounded, absolute-entry-only and
  shell-free; `commandPreview` names the launched executable; a missing tool is a bounded UNAVAILABLE
  failure with no install and no fallback, and a whole capture on such a machine fails every channel
  closed; `doctor` runs no upstream query
- **Subprocess security** — `shell: false`, non-interactive stdio, executable allowlist, read-only
  action allowlist, write actions refused before any spawn, timeout, call budget, output byte limit, and
  a sanitized environment that can never inherit wallet/signer/key/token/cookie variables
- **Query sets** — versioned, deterministic, metadata-only rendering; order-independent; a non-whitelisted
  candidate field never reaches a query; arbitrary free-form queries are refused (unit and CLI)
- **Capture/replay** — manifests deterministic apart from their clock fields, normalized and raw digests
  deterministic, captures immutable and never overwritten, replay byte-equivalent with zero network
  calls, tampering detected and refused (`CaptureIntegrityError`), the whole CLI pipeline exercised
  offline
- **Features** — exact source count, unique-author count, duplicate-text ratio, source diversity,
  link-domain concentration, engagement and failure-rate arithmetic, with clock fields excluded from the
  feature digest
- **Packet & routing** — whitelist-only `external-intelligence-packet-v1`, forbidden keys rejected at any
  depth, `jevRoutingActive`/`deepseekRoutingActive` hard-coded false, no Jev/DeepSeek call reachable
- **Isolation** — nothing in the intelligence layer imports Arena, evolution, Jev or replication code;
  nothing in Arena/Jev/replication imports the intelligence layer; the dashboard is the only consumer and
  exposes counts/identity only; the Wave 2 dataset ids and fingerprints never appear in the layer, and
  the three Wave 2 captures stay byte-untouched (metadata + pinned fingerprints) across the whole suite
- **No Agent-Reach required** — every adapter test injects a `spawn` stub and resolves against a fixture
  PATH of non-executed stub files, no binary is installed or launched, no live intelligence capture is
  taken, and nothing needs a system-wide install

Phase 5E.2 adds `npm run validate:phase5e2` (36 offline cases):

- **Registry** — exactly two transforms are registered (`v1`, `v2`), each resolves to a different
  implementation, and an unknown/empty/whitespace version throws `UnknownFeatureVersionError` rather
  than falling back to "latest"
- **Resolution** — a schema-1 manifest with no pin resolves to V1; an explicit pin resolves to exactly
  that transform; a schema-2 manifest with no pin and an unknown pin both fail closed
- **New captures** — a capture taken by the suite pins `external-intelligence-features-v2` at schema 2,
  the pin survives a round-trip through disk, and replay reports both the schema and feature version
- **V1 preservation** — the frozen fixture's whole V1 vector, feature digest and replay digest are
  asserted byte-for-byte, and the documented Phase 5E sample still produces its exact numbers
- **V2 semantics** — authorless/textless/linkless records have `null` ratios (not `1`), missing values
  are excluded from their own denominators, distinct-value counts differ from observed-field counts, and
  coverage is an honest zero
- **Minimum sample** — each of the four indicators is shown unable to fire below the minimum relevant
  observation count (including the GitHub-shaped one-record case, which yields zero indicators) and able
  to fire when the sample minimum and threshold are legitimately met
- **Real-capture identity** — the first real capture still verifies and still replays to exactly
  `b3904fe2…`, with packet digest exactly `ce82b740…`, under the frozen V1 transform (skipped, with an
  explicit note, on a checkout that does not contain that workspace artifact)
- **Determinism** — V1 and V2 feature and replay digests are deterministic, clock-derived fields stay
  out of both digests, and the packet still audits while containing no raw text and no URL

Phase 5G.0 adds `npm run validate:phase5g` (74 offline cases; `fetch` is a scripted stub, so no classifier.dev
request is ever made):

- **Pins** — endpoint exactly `/v1/classify`, API major `v1`, FAST tier only (smart rejected in request, provider,
  response and CLI), `multi: false`, taxonomy id/version/nine labels, dynamic labels refused, instruction text and
  digest, input projection version
- **Projection** — only `title`/`textExcerpt` are read; query, URL metadata, author, capture id, and any
  P&L/Arena/Jev/genome/wallet/env state cannot enter; URLs and secret shapes are sanitized; input bounded;
  empty input skipped; `recordDigest`/`inputDigest` preserved and deterministic
- **Persistence** — no raw input, title or excerpt anywhere in the artifact; results map to record order
- **Response** — unknown labels, out-of-range confidence, malformed scores, partial/extra results and smart-tier
  escalation rejected; model/tier captured; `resultDigest` deterministic; offline replay reproduces it and detects
  tampering with zero network calls
- **Transport** — 429 with `Retry-After` (seconds/HTTP-date/clamped/malformed), 502/503/504, timeout and network
  failure retried; 400/404/other/malformed never retried; max attempts and jitter bounded; zero real delay
- **Credentials** — no `Authorization`, no gateway key, no Jev/TypeSafe key, only `EVOLVE_CLASSIFIER_*` env read
- **Isolation** — stored outside the capture, capture byte-identical, failed integrity refuses before any request,
  no Agent-Reach/Jev/DeepSeek/Arena/wallet code reachable, packet/feature version/routing flags/Jev experiments/
  provider-health unchanged, real V2 + legacy V1 captures, Wave 1, Wave 2, cohorts, six datasets and the
  evaluation contract digest all unchanged

Phase 5G.1 adds `npm run validate:phase5g1` (75 offline cases; every fixture is built in a temp dir and no
classifier.dev request is ever made):

- **Frozen pins** — taxonomy id/version/nine labels, classifier-definition digest, input projection version, and
  the canonical one-record infrastructure experiment are unchanged
- **Cohort rejection** — explicit ids required; duplicate, missing, non-finalized, integrity-failed, mixed
  classifier id/version/projection, missing capture and tampered capture are all refused; the infrastructure
  experiment is excluded by default; the cohort is immutable and pinned to `DEVELOPMENT_CLASSIFIER_EVIDENCE`
- **Text-free cohort** — no raw text, URL, author or query is embedded, and the key set is exactly the frozen one
- **Offline only** — the evaluator and its CLI make zero classifier.dev / Agent-Reach / Jev / DeepSeek / Arena
  calls and touch no trading or transaction code
- **Metrics** — label counts, fractions and normalized label entropy; confidence mean/median/quantiles and the
  three fixed bands; per-label confidence; top1/top2 extraction, margins and the three fixed ambiguity bands;
  score entropy (with zero-sum → `null`); the channel × label matrix and channel confidence stats; noise and
  promotion fractions; largest-label concentration
- **Join** — classifications join to frozen source records by `recordDigest === normalizedDigest` only, and a
  missing source record fails closed
- **No verdict / no truth / no profitability** — no pass/fail key exists, no accuracy/precision/recall/F1/ROC/
  calibration metric exists, and nothing correlates labels against returns, P&L, Arena score, survival or gates
- **Artifact hygiene** — the evaluation carries no raw text, no URL and no author
- **Audit** — the deterministic label sample and the lowest-confidence audit are stable, produce no artifact, and
  never show a URL, author, query or credential
- **Replay / stats** — both run with zero network calls; replay recomputes every metric and reproduces
  `evaluationDigest`; changing one stored label or one stored confidence breaks replay integrity
- **Isolation** — packet, feature versions, Jev projection/question sets, Jev/DeepSeek routing flags, Jev
  experiments, provider-health, real V2 + legacy V1 captures, Wave 1, Wave 2, cohorts, six datasets and
  `evaluationContractDigest` all unchanged

Phase 5F.1 adds `npm run validate:phase5f1` (64 offline cases):

- **Retry classification** — 429/5xx/timeout/network retried; 400/401/402/403/404/422, malformed
  responses, config/auth errors and packet-audit failures never retried
- **Budgets** — `EVOLVE_JEV_MAX_CALLS` stays a LOGICAL count while `EVOLVE_JEV_MAX_ATTEMPTS` bounds
  PHYSICAL attempts; one retried decision is still one decision
- **Retry-After** — integer seconds and HTTP-date parsed, malformed values ignored, values clamped,
  and only a bounded `retryAfterMs` number persisted (never raw headers)
- **Backoff/jitter** — exponential, bounded, jittered; injected `sleepImpl`/`randomImpl` mean zero real
  delay and fully deterministic tests
- **Provenance** — `providerAttemptCount` exact, every attempt persisted, failed attempts retained after
  an eventual success, strict absence of credentials/headers/raw payloads
- **Cooldown** — created only by exhausted transient decisions, blocks all network calls while active,
  survives expiry, resets on success, escalates geometrically and clamps, and is never triggered by an
  auth or config error
- **Same-Jev chain** — disabled by default, requires each route's OWN credential, never crosses
  credentials, recovers when the first route exhausts transient failures, and never falls back to a
  non-Jev model
- **Identity barriers** — the real V2 capture, the legacy V1 capture, Wave 1, Wave 2, the six datasets,
  the frozen cohorts and the evaluation contract digest are all unchanged

Phase 5F.0 adds `npm run validate:phase5f` (49 offline cases):

- **Packet kind/version** — the new kind is explicit and distinct from candidate/market, the new version
  constant is `1`, and the existing candidate/market packet version is proven un-bumped
- **Projection whitelist** — the Jev projection has only the allowed top-level keys; raw records, text,
  URLs, author ids and repository names cannot enter it (including a packet that tries to smuggle raw
  content under an innocuous nested name), and the audit flags forbidden keys/values when injected
- **Withheld label** — `captureAgeMs` and the deterministic `evidenceQuality` label are absent from the
  whole Jev state, while `evidenceQuality` is allowed only as post-build comparator metadata
- **Refusals** — a packet that fails its own audit, a routing-active packet, and non-shadow/non-paper/
  non-read-only packets are each refused before projection
- **Question set** — the id/version are pinned, all five question names/types are fixed, the
  `primaryConcern` and `researchDisposition` vocabularies are exact, and repeated builds are byte-identical
- **Provider reuse** — the registered provider set, the disabled default, the unknown-name failure, and
  the mock/typesafe/vercel adapters (with an injected `fetch`/`evaluateImpl` stub) are all exercised offline
- **Budget/cache/state** — the budget is checked before the provider is called, one live call consumes one
  slot, cache identity depends on the packet version + question-set identity + state/question digests, and
  the same capture + packet + questions produce a stable state digest (a different capture does not)
- **Persistence** — a shadow decision lands in the existing Jev experiment storage, the decision references
  the source packet digest and stores no raw capture records, a second identical run is a cache hit with
  zero extra provider calls, and calibration is not attempted
- **Behavioural isolation** — an injected provider returning `escalate_to_deep_research` is proven to invoke
  NOTHING: it is recorded verbatim while no Agent-Reach/research/Arena/DeepSeek code is reachable from the
  bridge or CLI, no repository `.evolve` artifact changes, and the routing constants stay `false`
- **Identity barriers** — the real V2 capture stays byte-identical with pinned manifest/records/replay/
  packet digests (and `evidenceQuality: WEAK`), the legacy V1 capture replays to `b3904fe2…`, Wave 1,
  Wave 2, the six datasets and the frozen cohorts stay byte-identical, and the evaluation contract digest
  remains exactly `4cf8ac1f…`
- **Barriers** — Wave 1, Wave 2, the six replication datasets and the two frozen cohorts are verified
  byte-identical, the evaluation contract digest is exactly `4cf8ac1f…`, nothing under `.evolve/` changes
  while the suite runs, and no Jev call, DeepSeek call, Arena run, provider call or network call is
  reachable

## Roadmap

### Phase 1 — evolutionary lab
- [x] Paper swarm, live dashboard, selection / mutation / crossover

### Phase 2 — Solana observation + paper trading
- [x] Jupiter Tokens V2 observation with honest mode labelling
- [x] Rolling deduplicated token universe with feed health and backoff
- [x] Normalized market representation with defensive numeric handling
- [x] Species-specialised genomes driven by live market features
- [x] Simulated fills with fees, slippage, and adverse execution buffer
- [x] Net-of-cost fitness, gross vs net reporting
- [x] Validation suite + offline smoke run
- [ ] Persistent generations in Postgres

### Phase 3 — historical capture, deterministic replay, walk-forward evolution
- [x] Historical recorder writing the exact normalized representation agents consume
- [x] Crash-safe NDJSON datasets with manifests, classifications, and SHA-256 fingerprints
- [x] `replay` market provider with a dataset clock and configurable acceleration
- [x] Seeded determinism across genomes, decisions, fills, and generations
- [x] Structural look-ahead prevention with tests that fail on leakage
- [x] Walk-forward TRAIN / VALIDATE / TEST with frozen, immutable evaluation stages
- [x] Champion archive with minimum-evidence gates and lineage chains
- [x] Robustness scoring that penalises drawdown, churn, concentration, and single-trade luck
- [x] Baselines: no-trade, random, momentum, buy-and-hold-like under identical friction
- [x] Multi-seed aggregation, species survival analysis, machine-readable experiment reports
- [x] Isolated live / replay / experiment state and Phase 3 dashboard panels

### Phase 4 — Champion Arena, regime/stress testing, Live Shadow League
- [x] Large-scale tournament (qualification → group → stress → OOS → champion league → deployment)
- [x] Dataset registry with explicit real/synthetic/mixed evidence accounting
- [x] Deterministic, no-look-ahead market regime classifier
- [x] Deterministic execution-side stress engine and token-disappearance handling
- [x] Transparent, multi-component Arena Score with the formula shipped in output and docs
- [x] Survival gates, Deployment Candidates, and a Hall of Fame that never implies eligibility
- [x] Champion re-entry: previous champions compete unprotected and can lose
- [x] Genetic diversity protection and bounded adaptive mutation
- [x] Live Shadow League: frozen genomes, paper-only, admission-gated, duration milestones
- [x] Arena result caching and bounded parallel (worker-thread) evaluation
- [ ] WebSocket / streaming market ingestion (still polling-based)
- [ ] Strategy quarantine and promotion gates beyond the Shadow League's own milestones
- [ ] Kill switches and loss budgets (paper-only; there is nothing real to halt yet)

### Phase 5A — Controlled Research Swarm
- [x] Configurable population (`EVOLVE_POPULATION_SIZE`: 48/96/192/arbitrary, exact and deterministic)
- [x] Strategy islands: species-as-breeding-boundary, bounded migration, cross-species crossover, random
      immigration, and extinction revival — tracked per island, actually driving breeding
- [x] Soft, diversity-protected island allocation: evidence-adjusted reproductive weights, bounded
      per-generation share movement, explicit floor/cap, and an exact global population (Phase 5A.1)
- [x] Six structured researcher roles over a bounded, plain-data evidence packet; deterministic offline
      `mock` provider (no LLM key/network required); pluggable provider interface for later
- [x] Strict-allowlist proposal schema with a static executable-content sandbox scan
- [x] Deterministic proposal compiler with its own tighter-than-`GENE_BOUNDS` safety ceilings
- [x] Persistent research memory (proposals, compiled candidates, structured evaluation records,
      conclusions) that later cycles actually read back
- [x] Controlled recursive research cycle wired into the live engine loop (propose → validate → compile →
      inject → watchdog → memory → next cycle)
- [x] Deterministic reward-hacking watchdog with `NORMAL`/`WATCH`/`QUARANTINED` and non-self-clearing
      quarantine
- [x] Meta-evolution over approved existing-family combinations (no new signals, no code generation)
- [x] Deterministic regime specialization and `ACTIVE`/`REDUCED_RISK`/`ABSTAIN`, scoped to research
      candidates, replay-reproducible
- [x] Arena-gated promotion by genome digest — researchers cannot self-promote
- [x] Dashboard: Strategy Islands panel and Research Swarm panel, both labelled `PAPER RESEARCH`
- [ ] A non-mock research provider (still just an interface; only the offline mock is implemented)
- [ ] Automatic Arena re-entry of every compiled candidate on a fixed cadence (currently manual via
      `npm run arena -- --research`)

### Phase 5A.1 — integration correctness pass
- [x] Distinct state fields: `researchSwarm` (current swarm) vs `historicalResearch` (Phase 3/4 reference
      data), never merged, both reachable through the dashboard's state contract
- [x] `auto` state source prefers the live document and can no longer be hijacked by a stale replay;
      the live swarm summary survives while browsing a historical replay
- [x] Swarm state exposes enabled / cycle / provider / regime / proposals generated, accepted, rejected /
      compiled families / injected candidates / memory records / conclusions / evaluations / per-role
      counts / watchdog NORMAL-WATCH-QUARANTINED counts
- [x] Watchdog results are machine-readable in research memory and conclusions (status, flags, reasons,
      trade count, `evaluatedAt`) without parsing prose, with memory still append-only and Arena-gated
- [x] Offline smoke (`npm run smoke:swarm`): 192 agents, exact island total, real island divergence, and
      live swarm state visible through the same contract the dashboard reads

### Phase 5A.2 — research cohort correctness + experimental quality
- [x] Boolean-aware CLI parsing: `--research DATASET`, `DATASET --research`, `--research=true DATASET`
- [x] Arena startup prints dataset count/ids, research enabled + mode, requested population, research
      candidates discovered, conventional entrants, and total entrants
- [x] Research genome uniqueness by `digestOf(genome)`, with deterministic in-range diversification and
      `DUPLICATE_GENOME` rejection; duplicate rejections and diversifications recorded in memory
- [x] Research-cohort novelty metric + `EVOLVE_RESEARCH_MIN_UNIQUE_RATIO` warning/failure
- [x] Species collapse fixed: breadth-first compilation, explicit `targetSpecies`, three additional
      approved families, evidence-driven species targeting, and all six species reachable
- [x] `EVOLVE_RESEARCH_MAX_SPECIES_SHARE` diversity guard that warns instead of fabricating diversity
- [x] Role diversity: advisory-only critic documented; the other five roles contribute distinct,
      changing search behaviour; per-role metrics computed from persisted records
- [x] First-class Arena research provenance (entrant → candidates → leaderboard → champion league →
      deployment → summary), with ancestry kept separate from exact identity
- [x] Explicit gate status, tournament stage, `eliminatedAtStage`, `finalRank`, and an explicit Champion
      League final eight; promotion reads stage/gate information
- [x] CHALLENGER mode preserved as the default; FAIR COHORT mode with equal treatment and no cloning
- [x] Distinct-mint diagnostics explaining thin mint counts, with the gate itself unchanged
- [x] Mock provider remains the deterministic default; DeepSeek NOT integrated in this phase
- [x] `npm run validate:phase5a2` — 60 offline cases
- [x] Non-mock provider integrated in Phase 5B as an OPTIONAL provider (`deepseek-cline`), never automatic
- [ ] Automatic Arena re-entry of every compiled candidate on a fixed cadence

### Phase 5A.3 — controlled research vs conventional A/B benchmarking
- [x] `--research-mode ab`: two matched cohorts (`research`, `conventional`) with equal starting slots
- [x] Symmetric sizing: a shortfall shrinks BOTH cohorts (`matchedPerCohort`), never 42 vs 158
- [x] No-cloning policy enforced and reported (`clonedToFillQuota: 0`, duplicate seed digests rejected)
- [x] Opt-in descendant expansion (`EVOLVE_ARENA_AB_EXPAND=1`) via ordinary identical evolution
- [x] Cohort/lineage attribution on every entrant: cohort, lineageId, seed digest, parent lineages,
      generation, exact-original vs descendant, founder kind, research family/role ancestry
- [x] Cross-cohort crossover disabled; cohorts pre-evolved in complete isolation; `crossCohortCrossovers`
      reported and required to be `0`
- [x] Evolution / scoring / dataset / window / seed / stress / gate parity enforced by one shared
      evaluation and recorded in the artifact
- [x] Conventional control = ordinary Arena entrant-pool construction; optional species-matched control
- [x] Primary metrics (cohort size, Arena performance, paper trading evidence, robustness, diversity)
- [x] Descriptive statistics plus a deterministic percentile bootstrap; no significance claim
- [x] Role-level research lineage metrics, advisory roles marked instead of fabricated
- [x] Comparative distinct-mint diagnostics for both cohorts, with the gate unchanged
- [x] `ab-comparison.json` artifact plus a compact `abComparison` block in `summary.json`
- [x] One-command A/B run with explicit startup accounting
- [x] `npm run validate:phase5a3` — 69 offline cases
- [x] Challenger, fair, and normal Arena modes unchanged
- [x] `deepseek-cline` available as an OPTIONAL provider since Phase 5B — the A/B instrument is ready for it, no run executed here
- [ ] Real provider A/B result: **DeepSeek V4.1 Flash via Cline, xhigh** — implementation + instrument are ready; the 58-minute matched run has not been executed

### Phase 5C — multi-dataset replication
- [x] Versioned experiment freeze (`phase5c-freeze.json`) with a deterministic `freezeDigest`
- [x] Freeze verification that FAILS on critical config drift (score/gates/prompt/compiler/species match)
- [x] Frozen Mock and DeepSeek research cohorts as immutable, Arena-readable manifests
- [x] Dataset registry: REAL/SYNTHETIC/MIXED/INVALID, fingerprints, completion state, error counts
- [x] Temporal overlap analysis (both fractions) — overlapping captures are never independent
- [x] Explicit, performance-blind eligibility criteria persisted with reasons per dataset
- [x] Leakage matrix (DEVELOPMENT / CONTAMINATED / CLEAN_REPLICATION / UNKNOWN) per cohort × dataset
- [x] Synchronous, resumable replication runner (`rep-`/`unit-` deterministic ids, no daemon)
- [x] Frozen cohorts re-evaluated against each dataset with fresh species-matched controls per provider
- [x] Zero LLM calls during replication; provider pinned to the deterministic mock
- [x] Per-dataset metrics, paired delta-of-deltas, cross-dataset aggregation at the dataset level
- [x] Descriptive statistics + deterministic dataset-level bootstrap; `significance: null`, `verdict: null`
- [x] Leave-one-dataset-out sensitivity (≥3 clean datasets) and read-only regime context
- [x] Replication status vocabulary + `INSUFFICIENT_INDEPENDENT_REAL_DATASETS` handling
- [x] `datasets:research`, `replicate:research` (freeze/cohorts/plan/run/summary), dashboard block
- [x] `npm run validate:phase5c` — 73 offline cases
- [ ] Canonical real Phase 5C replication run — waits for ≥2 independent CLEAN real captures

### Phase 5B — optional DeepSeek research provider (Cline CLI)
- [x] `deepseek-cline` provider behind the existing provider abstraction; `mock` stays the default
- [x] Explicit selection (`EVOLVE_RESEARCH_PROVIDER`), explicit model (`deepseek/deepseek-v4.1-flash`), explicit reasoning (`xhigh`)
- [x] No automatic fallback: a recognized provider's failure is a provider failure status, never mock proposals
- [x] Fail-closed provider selection (Phase 5B.1): unset → `mock`; explicit `mock`/`deepseek-cline` resolve; any other explicit name is a configuration error (`Unknown research provider: …`) that exits non-zero, calls no provider, creates no experiment, and is never served by the mock
- [x] Fail-closed in every resolution path: `npm run research`, `npm run probe:research-provider`, the live engine (research disabled + `PROVIDER_CONFIG_ERROR` on the dashboard), and experiment construction
- [x] Subprocess contract via `spawn` + argv array (no shell), tool auto-approval disabled, isolated workdir
- [x] Versioned, role-aware prompt contract (`RESEARCH_PROMPT_VERSION`) reusing the existing proposal schema
- [x] Versioned TRAIN-only evidence packet with digest, leak audit, memory projection, and deterministic bounded truncation
- [x] Strict JSON extraction: one object or nothing (no repair, no invented values)
- [x] Bounded timeout, conservative retries, per-run provider-call budget, cache keyed on the evidence digest
- [x] Provider-output persistence + replay path (prove LLM variability separately from EVOLVE variability)
- [x] Provider provenance on every run; no credentials, prompts, or raw responses persisted
- [x] Provider probe (`npm run probe:research-provider`) that never touches the Arena or champions
- [x] Bounded cohort generation (`npm run research`) with isolated `.evolve/research/experiments/<id>` roots
- [x] Within-run A/B delta comparison tool (`npm run compare:research`) with no manufactured verdict
- [x] Dashboard/provider state: provider, model, reasoning, health, experiment id, calls, failures, cache hits, rejects, watchdog counts
- [x] `npm run validate:phase5b` — 96 offline cases (stub Cline, no network, no key)
- [ ] First real DeepSeek cohort + strict species-matched A/B (commands documented in `## Phase 5B`)

### Phase 5D — Jev shadow decision supervisor
- [x] Dedicated `scripts/jev/` provider subsystem, fully independent from `scripts/research/`
- [x] Fail-closed provider selection: disabled by default, `mock-jev`/`typesafe-jev`/`vercel-jev` by explicit name only, any other name is a configuration error, `EVOLVE_JEV_MODE` restricted to `shadow`
- [x] Real direct provider verified against the official `@typesafe-ai/sdk@0.6.0` and docs.typesafe.ai; pinned model `jev-1.13.0`, never the moving `jev-latest` alias
- [x] Real gateway route `vercel-jev` verified against AI SDK 7 `experimental_evaluate` (`typesafe-ai/jev`), with DISTINCT credentials (`AI_GATEWAY_API_KEY` vs `EVOLVE_JEV_API_KEY`), no fallback between the two routes, `maxRetries: 0`, an `AbortSignal`-wired timeout, bounded observational metadata, and distinct auth/rate-limit/unavailable/config/invalid statuses
- [x] Versioned, whitelist-only decision packet (`jev-decision-packet-v1`) with a leakage audit excluding every VALIDATE/TEST/OOS/Arena/gate/deployment/champion/shadow-league/replication field
- [x] Fixed candidate question set (`jev-question-set-v1`: gateFailureRisk, primaryRisk, evidenceQuality, generalizationConfidence, researchDisposition) and market question set (`jev-market-v1`, blind regime classification into EVOLVE's existing vocabulary)
- [x] Cache keyed on provider/model/packet-version/question-set-version/state-digest/question-digest; run-level call budget; explicit `JEV_*` fail-closed statuses
- [x] Zero authority: no Jev reference anywhere in Arena/compiler/watchdog/simulation code; deterministic Arena scoring/gates proven byte-identical with Jev disabled vs. shadow
- [x] Predictions persisted and timestamped BEFORE any outcome exists; pure offline post-outcome calibration (Brier score, reliability bins, multi-label `primaryRisk` agreement, regime-shadow comparison, threshold-coverage analysis) that never calls Jev again and promotes no operational threshold
- [x] `npm run jev`, `npm run calibrate:jev`, `npm run probe:jev`, and a bounded `jevShadow` dashboard panel
- [x] `npm run validate:phase5d` — 131 offline cases
- [ ] First real Jev shadow experiment against real candidates — recommended AFTER Wave 2 replication completes (see `## Phase 5D`)
- [ ] First real Vercel-AI-Gateway `vercel-jev` synthetic shadow probe (command in `## Phase 5D`)

### Phase 5C.3 — canonical per-wave freezes
- [x] Per-wave freeze architecture (`freezePath` + `freezeDigest` + `evaluationContractDigest` on every wave manifest); Wave 1 keeps its historical freeze and evidence untouched
- [x] Deterministic `evaluationContractDigest` over experiment/evaluator semantics only, with documented include/exclude lists
- [x] `--write-freeze --wave <wave>` / `--verify-freeze --wave <wave>`; clean tree required, zero Arena units, zero Jev/DeepSeek calls, no auto-freeze during a normal run
- [x] Missing/stale freeze fails closed; canonical runs need no `--dev`; `--dev` evidence stays `NON_CANONICAL` and is excluded by default
- [x] Cross-wave comparability decided by the evaluation contract + both frozen cohort digests; `INCOMPARABLE_WAVES` with explicit differing fields instead of silent aggregation
- [x] `npm run validate:phase5c3` — 36 offline cases
- [x] Canonical Wave 2 freeze + canonical Wave 2 run — `rep-ffe4b968e51a`, 6/6 units COMPLETED, 3 CLEAN datasets, `CANONICAL`, under the same evaluation contract as Wave 1 (see `## Phase 5C.3`)

### Phase 5E — external intelligence shadow layer
- [x] Isolated, read-only Agent-Reach adapter pinned to `v1.5.0` (commit `f65526c…`, MIT, Python ≥3.10): no upstream package import, `shell: false`, executable/action/argv allowlists, timeout, call budget, byte limit, sanitized environment; the pinned CLI is used for `version`/`doctor --json` health only, while data acquisition runs the upstream read tool (`gh`/`twitter`/`rdt`/`mcporter`/`curl`) the frozen capability map declares
- [x] Narrow channel allowlist (`x`, `web`, `exa`, `reddit`, `rss`, `github`); browser-login/write-capable channels refused; GitHub writes and X posts rejected before any call
- [x] Capture → freeze → verify → **offline replay** storage with immutable manifests, per-record raw/normalized digests and tamper detection; live internet is never read inside the Arena
- [x] Versioned deterministic query sets (`reach-query-set-v1`, metadata-only, arbitrary queries refused) and a bounded deterministic feature vector with `coordinationIndicators` (never a bot probability)
- [x] `external-intelligence-packet-v1` interface only: `jevRoutingActive: false`, `deepseekRoutingActive: false`, no Jev/DeepSeek calls
- [x] Mock provider, `intelligence:doctor`/`probe:reach` (nothing persisted without `--save`), and a compact shadow dashboard panel with counts/identity only
- [x] `npm run validate:phase5e` — 65 offline cases
- [x] One real, bounded, read-only public-data capture — `capture-20260919T122601Z`, one GitHub record, `immutable`, `integrity ok`, **infrastructure proof only**, never routed

### Phase 5E.2 — versioned feature transforms
- [x] Versioned feature transforms: the current algorithm is frozen as `external-intelligence-features-v1`, `external-intelligence-features-v2` is added, and `featureExtractorFor(version)` is the only registry (unknown version fails closed, never "latest")
- [x] Legacy schema-v1 captures with no `featureVersion` resolve to V1 by an explicit backwards-compatibility rule; new captures pin `external-intelligence-features-v2` at `captureSchemaVersion: 2`; old manifests are never rewritten
- [x] V2 denominator semantics: observed-field counts and distinct-value counts are separated from the record count, so missing data is UNKNOWN (`null`) rather than concentration
- [x] `COORDINATION_MIN_OBSERVATIONS = 5` — every coordination indicator requires its relevant observed-field sample minimum; thresholds are documented, not tuned
- [x] Replay resolves the transform from the frozen manifest (`external-intelligence-replay-v2`), reports `featureVersion` + `captureSchemaVersion`, and keeps `external-intelligence-packet-v1` (the packet already carried `featureVersion`)
- [x] Committed schema-1 compatibility fixture (`scripts/intelligence/fixtures/legacy-capture-schema1/`) with a frozen expected V1 vector, digest and replay digest
- [x] `npm run validate:phase5e2` — 36 offline cases
- [x] A NEW one-channel GitHub capture under V2, replayed twice offline and integrity-verified — `capture-20260919T130756Z`, one record, replay digest `14f8a36c…`, packet digest `8997cde2…`, `evidenceQuality: WEAK` (**infrastructure evidence only**)

### Phase 5F.0 — external intelligence → Jev shadow experiment bridge
- [x] Dedicated packet kind `JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET` (+ separate version `1`) so the candidate/market packets are neither overloaded nor bumped
- [x] `buildExternalIntelligenceJevPacket(...)` — mandatory `assertPacketAllowed` first, routing flags/`shadowOnly`/`paperOnly`/`readOnly` re-checked, then a SECOND whitelist projection (no raw records/text/URLs/author ids/`captureAgeMs`; coordination indicator ids only, never prose rules)
- [x] The deterministic `evidenceQuality` label is withheld from the Jev state and recorded afterwards as a deterministic comparator (`externalEvidenceQuality`, `coordinationIndicatorCount`, `recordCount`, `sourceCount`, `queryCoverage`, `fetchFailureRate`)
- [x] Fixed question set `jev-external-intelligence-v1` (evidenceSufficiency, primaryConcern, evidenceQuality, corroborationConfidence, researchDisposition) — never dynamic, never the candidate/market sets
- [x] Explicit CLI `npm run jev:external -- --capture <id> --provider <name> [--save]`, reusing the existing providers/timeout/budget/cache/`jevDecide()`/experiment storage (no second provider subsystem, no second cache, no `.evolve/jev-external` tree); fail-closed provider selection, `EVOLVE_JEV_MAX_CALLS=1` default checked before the call
- [x] Decision record uses the new packet kind, the source packet digest as `subjectDigest`, `questionSetId: jev-external-intelligence-v1`, and the six deterministic comparators; no raw capture is duplicated into Jev storage
- [x] `escalate_to_deep_research` is proven a pure SHADOW ANSWER: zero DeepSeek, zero Agent-Reach, zero capture, zero Arena, zero routing-constant change, zero filesystem mutation outside the temporary Jev experiment root
- [x] Calibration of external-intelligence decisions is OUT OF SCOPE for Phase 5F.0 (no Arena outcome contract); missing Arena outcomes are never a failure
- [x] `npm run validate:phase5f` — 49 offline cases

### Phase 5F.1 checklist

- [x] Explicit EVOLVE-owned transport resilience below one logical decision: bounded `EVOLVE_JEV_MAX_ATTEMPTS` (1..5) PHYSICAL attempts per LOGICAL decision, with `providerAttemptCount` and `providerAttempts` provenance on the run and the immutable decision
- [x] Retry ONLY transient failures (429 / 502 / 503 / 504 / retryable 5xx / timeout / network); 400/401/402/403/404/422, malformed responses, invalid question schemas, config/auth errors, unknown provider/model and packet-audit failures are never retried
- [x] Exponential backoff with bounded jitter, injectable `sleepImpl`/`randomImpl`, and a bounded `Retry-After` (seconds or HTTP-date) that is clamped and persisted only as a number — never raw headers
- [x] SDK `maxRetries` remains `0`; EVOLVE owns all retries and never runs them alongside SDK retries
- [x] Bounded provider-health cooldown under `.evolve/jev/provider-health/` with geometric escalation clamped at 15 minutes, safe `JEV_COOLDOWN` failure with zero network calls, and success reset
- [x] Optional same-Jev transport chain, disabled by default, credential-gated per route, never crossing credentials and never reaching a non-Jev model
- [x] External-intelligence bridge semantics unchanged: one logical decision, `escalate_to_deep_research` still invokes nothing, and zero Agent-Reach/DeepSeek/Arena/trading activity
- [x] Real V2 capture, legacy V1 capture, Wave 1, Wave 2, the six datasets, the frozen cohorts and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5f1` — 64 offline cases
- [ ] First real resilience test on `capture-20260919T130756Z` — operator-run AFTER this commit, 1 logical call / up to 3 transport attempts, `vercel-jev`, `typesafe-ai/jev`, `--save`; its disposition is **not** evidence that external intelligence adds value

### Phase 5G.0 checklist

- [x] classifier.dev `POST /v1/classify` (REST, native `fetch`), **FAST tier only**, single-label only, no credential of any kind, redirects never followed
- [x] Frozen classifier `reach-signal-type-v1` v1: exactly nine descriptive labels, pinned instruction text and `instructionsDigest`, dynamic labels and the smart tier refused
- [x] `classifier-input-projection-v1`: ONLY `title` + `textExcerpt`, whitespace-normalized, secret-redacted, URLs → `[URL]`, bounded to 800 characters, empty skipped; `inputDigest` persisted, raw input NOT persisted
- [x] Whitelisted, fail-closed response validation (tier, count, order, label, confidence, scores, no escalation); raw HTTP response never persisted
- [x] Frozen artifact under `.evolve/classifier/experiments/clexp-…` (`experiment.json`, `results.ndjson`, `provider/runs/*.json`), outside the immutable capture, no raw text, deterministic `resultDigest`
- [x] Bounded transport recovery (429/502/503/504/timeout/network; never 400/404/malformed), `Retry-After` seconds + HTTP-date clamped to 60s, bounded jitter, injectable `fetchImpl`/`sleepImpl`/`randomImpl`
- [x] Capture integrity gate (manifest, `immutable`, `finalized`, existing verification) before any request; more than 1,000 eligible records fail closed
- [x] Explicit CLI `npm run intelligence:classify` (provider disabled by default) + offline `--stats` / `--replay` (zero network)
- [x] No downstream routing: packet, feature version, Jev projection/question sets, Jev/DeepSeek routing flags, Arena, evolution, gates, replication all unchanged
- [x] Real V2 capture, legacy V1 capture, Wave 1, Wave 2, cohorts, six datasets and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5g` — 74 offline cases
- [ ] First real infrastructure test on `capture-20260919T130756Z` — operator-run AFTER this commit, ONE request, `classifier-dev`, `fast`, `--save`; the label it returns is **not** evidence about profitability or market usefulness

### Phase 5G.1 checklist

- [x] Explicit immutable cohort manifest under `.evolve/classifier/cohorts/clcohort-…` containing ONLY ids/digests/counts/`createdAt`/`immutable`/`note` — no raw text, title, excerpt, URL or author
- [x] Cohort rejects duplicate/missing/mixed-classifier/mixed-version/mixed-projection/non-final/integrity-failed experiments and missing or tampered source captures; requires explicit `clexp-*` ids
- [x] Canonical Phase 5G.0 one-record infrastructure experiment excluded from the meaningful cohort by default
- [x] Every cohort and evaluation pinned to `evidenceClass: DEVELOPMENT_CLASSIFIER_EVIDENCE` — never CLEAN_REPLICATION/VALIDATION/TEST/OOS/PRODUCTION
- [x] Offline-only evaluator (`npm run intelligence:classify-eval`) with ZERO classifier.dev / Agent-Reach / Jev / DeepSeek / Arena calls
- [x] Deterministic descriptive metrics: label distribution + normalized label diversity, confidence stats + fixed bands, per-label confidence, score margin + fixed ambiguity bands, score entropy (null when unnormalizable), channel × label, channel coverage, noise, promotion, concentration
- [x] Text-free evaluation artifact at `.evolve/classifier/evaluations/cleval-…/evaluation.json` with `descriptiveOnly`/`noGroundTruth`/`noProfitabilityInference`
- [x] No automated verdict, no accuracy/precision/recall/F1/ROC/calibration (no ground truth) and no profitability/Arena correlation
- [x] Ephemeral deterministic `--audit` / `--audit-low-confidence` (terminal only, no artifact, no URL/author/query shown)
- [x] Offline `--replay` (verifies cohort + every experiment + every capture, recomputes metrics, reproduces `evaluationDigest`) and `--stats`
- [x] Frozen taxonomy v1 untouched — no automatic evaluate → mutate → rerun loop; a future v2 is a separate phase on new captures
- [x] Real V2 capture, legacy V1 capture, Wave 1, Wave 2, cohorts, six datasets and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5g1` — 75 offline cases
- [ ] First meaningful DEVELOPMENT cohort — operator-run AFTER this commit, fresh development captures across several healthy read-only channels, `classifier-dev`/`reach-signal-type-v1`/`fast`; its metrics are **not** proof that classifier.dev adds predictive value

### Phase 5H.0 checklist

- [x] `classifier-feature-definition-v1` freezing the imported classifier identity, thresholds, rounding, quantile method and the computed `FEATURE_DEFINITION_DIGEST`
- [x] EXACTLY 19 canonical feature keys in canonical order — no groups, no HHI, no score entropy, no `observed_label_fraction`, no `<0.05`/`<0.20` bands
- [x] One cohort = one artifact; record-by-record, record-weighted pooling across experiments (`C = Σ classifiedCount_e`)
- [x] `0` is never unknown; incomplete score vectors affect the margin denominator only and produce `null` margin features
- [x] `DEVELOPMENT_CLASSIFIER_EVIDENCE → DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES` is the ONLY transition; future clean validation needs new evidence
- [x] Fail-closed refusals (zero evidence, mixed classifiers/projections/digests, unknown labels, bad digests, unmapped evidence class, backdating, output root inside the capture root)
- [x] Audit before write + during replay: whitelist, numeric-only, smuggling/group denylists, text-free, routing false, arithmetic invariants
- [x] Write-once `clfeat-…` artifact with rederived identity/digest on replay; no mutation of captures, experiments or cohorts
- [x] Offline `--replay` / `--stats` / `--definition` CLI with `networkCalls: 0`, no provider/network/routing/classification option and no latest
- [x] Routing stays false; no Jev packet and no dashboard change in 5H.0
- [x] Canonical 5G.1 evidence, Wave 1, Wave 2, the frozen cohorts, six datasets and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5h` — 139 offline checks, plus a canonical 5G.1 cross-check that agrees exactly and a READ-ONLY canonical 5H.0 barrier (`clfeat-20260919T173844Z-7a9193bb`)
- [x] Canonical `clfeat-20260919T173844Z-7a9193bb` artifact — operator-frozen from `clcohort-20260919T163609Z-4d7c6dd9` and successfully replayed, pinned as a permanent barrier; the artifact stays local/gitignored and its values are **not** evidence about profitability or market usefulness

### Phase 5I.0b checklist

- [x] Frozen research question, market (SOL/USDC), 30-second primary horizon and default protocol (120 observations / 30s cadence), all versioned and pinned in the experiment manifest
- [x] Dedicated question set `jev-microstructure-direction-v1` (one `noul` probability question) and packet `JEV_MICROSTRUCTURE_DIRECTION_PACKET` v1 — neither reuses the Phase 5D or regime question sets
- [x] Frozen feature definition + digest with only genuinely observable pre-`t0` fields; unavailable families (order book, CVD, queue depth, maker flow, L2/L3) declared with reasons instead of approximated
- [x] Deterministic, versioned SOL/USDC reference-price definition derived only from the frozen observation and optimized against nothing
- [x] `pHigher` / `pLower` with `pLower = 1 - pHigher`, range and tolerance validated; never reduced to BUY/SELL
- [x] `HIGHER` / `LOWER` / `TIE` outcomes with ties retained in provenance and excluded from binary Brier/log-loss/accuracy
- [x] BEHAVIOURAL lookahead audit (append future observations, recompute the same `t0`, require equality) over every feature AND every baseline
- [x] Separate recursive/startup stability audit across 30/60/120/240/full pre-`t0` histories, reported as diagnostics and never as lookahead
- [x] Multi-timestamp provenance (`sourceEventAt` → `receivedAt` → `stateFrozenAt` → `prediction*` → `targetAt` → `outcome*`) with null-for-unknown source times, a causality check and a frozen staleness cutoff
- [x] Deterministic event ordering where baselines and Jev consume the SAME frozen `stateDigest`; Jev never sees a fresher state
- [x] Two-stage immutable evidence: prediction written before any outcome exists, outcome re-verifies the prediction digest, and a mismatch FAILS CLOSED
- [x] Deterministic baselines (`neutral` + momentum/mean-reversion + quote/liquidity where supported) with no outcome-fitted coefficients and per-baseline scoping
- [x] Offline metrics: Brier, log loss (frozen epsilon for numerical safety only), accuracy, counts, mean/median `pHigher`, fixed calibration bins, Jev-minus-baseline deltas, latency and attempt statistics — and no PnL/Sharpe/returns/winner
- [x] Canonical evidence requires `typesafe-jev` + `jev-1.13.0` + `gatewayUsed: false` + `mode: shadow`; `vercel-jev`, `mock-jev` and gateway routes are refused, with no silent fallback
- [x] No runtime confidence threshold: `EVOLVE_JEV_MIN_CONFIDENCE` unsupported, no `minConfidence` property, every valid low-confidence prediction retained and scorable
- [x] Bounded, resumable CLI (`--start` / `--resume` / `--resolve` / `--replay` / `--stats`) with explicit ids, no `--latest`, no daemon, no silent overwrite, and an interruption sweep that resolves (or refuses) an already-frozen observation without rewriting it
- [x] Replay/stats make zero network, provider, Jev, Agent-Reach, classifier, DeepSeek, Arena or trading calls; tamper tests fail closed on a mutated prediction/outcome, a foreign baseline state, an injected future observation or a moved `targetAt`
- [x] Zero routing/trading authority: no wallet/signer/order/swap path exists and every routing flag is persisted false while `jevPredictionActive` is true
- [x] New evidence tree `.evolve/jev-direction/`; Phase 5G.1, Phase 5H.0 (`clfeat-20260919T173844Z-7a9193bb`), Wave 1, Wave 2 and `evaluationContractDigest` all byte-unchanged
- [x] `npm run validate:phase5i` — 287 offline checks, zero network, zero canonical 5I evidence created and no real replication session launched
- [x] First real direct-TypeSafe canaries: `jdir-20260920T060810Z-3a9163` (v1 outcome policy) and `jdir-20260920T062804Z-3a9163` (v2) — immutable, operator-run, never promoted to replication evidence
- [x] Canonical 120-observation development benchmark `jdir-20260920T063311Z-3a9163` (`metricsDigest` `984cc26dd9f247dbd625dc8c7bfb07d82600ed9a353fe7ef2bba423cc79f29ba`) — **DEVELOPMENT evidence only**: no clear advantage over the neutral baseline, no persistent edge, no profitability inference

### Phase 5I.1 checklist

- [x] Source-pinned, READ-ONLY canonical development barrier (id, metrics digest, counts, metrics, relative results, infrastructure, timing, session window, interpretation)
- [x] One deterministic `replicationProtocolDigest` covering every predictive semantic, derived from frozen source constants with no timestamps or ids, and reproduced identically by the development experiment and by every replication session
- [x] Distinct `CLEAN_JEV_DIRECTION_REPLICATION_EVIDENCE` class with `developmentOnly: false`, `replicationOnly: true`, paper/shadow only and no profitability/trading/deployment inference
- [x] Fail-closed session eligibility: direct TypeSafe, pinned model, gateway false, exact frozen question/feature/baseline/reference-price/metric/policy pins, correct horizon+cadence+session size, no threshold, no tamper, lookahead clean, finalized, real observations only — with every reason persisted
- [x] Freshness + symmetric temporal independence against the development experiment and against every other session; overlapping sessions are `CONTAMINATED`, preserved and excluded
- [x] `mock`/fixture, gateway, model, threshold, question, feature, baseline, outcome-policy, metric, horizon and cadence drift all rejected with explicit reasons
- [x] Session-level aggregation only: 3 independent sessions × 120 observations, never concatenated, equal-weighted by eligible session, with `sessionCount`/`values`/`mean`/`median`/`min`/`max`/positive/negative/zero and Brier/log-loss better/worse/equal counts
- [x] Frozen sign convention (negative Brier/log-loss delta = Jev lower = better) documented and asserted
- [x] Deterministic session-level bootstrap (fixed seed, fixed resample count) that resamples sessions, and only once 3 CLEAN sessions exist — otherwise `INSUFFICIENT_CLEAN_REPLICATION_SESSIONS`; no p-value, no significance label, no verdict
- [x] Operator-only commands (`--replication-create` / `--replication-add` / `--replication-replay` / `--replication-stats`) with explicit ids, no `--latest`, offline replay/stats (zero network) and **no** automatic session launch
- [x] No tuning from development and no tuning between sessions; an interrupted wave is declared incomparable rather than patched
- [x] Zero routing/trading authority, zero wallet/signer/order/swap path, and zero automated winner
- [x] Phase 5H.0, Wave 1, Wave 2, `evaluationContractDigest`, the canonical development experiment and both canaries all byte-unchanged
- [ ] **NOT RUN YET** — no real Phase 5I.1 replication session has been executed. The operator runs each 120-observation session manually, reviews it, and only then records it; nothing in the code launches one

### Phase 5 — capped mainnet pilot
Not implemented, and not planned without explicit operator approval and out-of-sample evidence.
Real-money execution does not exist in this repository.

## Important

Evolution does not create guaranteed alpha. A badly specified fitness function can optimize luck,
overfitting, hidden simulator assumptions, or catastrophic tail risk. Live market observations,
historical replay, and walk-forward validation make the simulation more honest about the world it is
competing in; they do not make any result real.

**Historical backtests and paper results do not guarantee future profitability.** A genome that
passed a test window has passed one simulated paper window on one dataset. Nothing here should be read
as investment advice.

---

**Built by Cobalt**
