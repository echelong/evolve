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

The default (and, for now, only) provider is `mock` — a **deterministic, offline, no-LLM** heuristic
provider (`scripts/research/provider.mjs`). The whole validation suite, and Phase 5A itself, work with
no network access and no LLM API key. An external provider can be added later behind the same interface
(`resolveResearchProvider`); it would read its own credential from the environment
(`EVOLVE_RESEARCH_API_KEY` / `EVOLVE_LLM_API_KEY`, non-enumerable, never persisted to proposals, memory,
state, or logs) and an unrecognized provider name always falls back to the offline mock rather than
attempting a network call.

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

### 10. Deterministic mock provider (DeepSeek is NOT integrated)

Phase 5A.2 remains offline-testable, deterministic, and reproducible with **no provider key and no
network**. `mock` is still the only implemented provider and remains the baseline any future provider
must be compared against. **DeepSeek is explicitly not integrated.** The future intended experiment is
documented only as:

> **DeepSeek V4.1 Flash via Cline, xhigh**

It is not implemented, there is no client, no key handling beyond the existing environment-only
placeholder, and an unrecognized provider name still falls back to the offline mock instead of making a
network call. Until that experiment runs, every research number in this repository comes from the
deterministic mock.

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
npm run validate:phase5a3                       # Phase 5A.3 suite (69 offline cases)
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
  species-matched mode is on), from the specific conventional construction chosen, or from luck

**No profitability claim is made anywhere.** A higher paper score in one cohort is not evidence of
future profit, and zero Deployment Candidates remains a completely acceptable outcome.

### A future provider experiment (documented, NOT implemented)

The A/B benchmark is the instrument built to evaluate a real research provider later:

> **DeepSeek V4.1 Flash via Cline, xhigh**

It is **not implemented** in this phase. There is no client, no new key handling, and an unrecognized
provider name still falls back to the offline deterministic mock rather than making a network call.
DeepSeek is not part of Phase 5A.3. The framework is now ready to run that experiment when it is
explicitly started — see `## Roadmap`.

### Commands

```bash
npm run arena -- --research-mode ab <dataset>              # matched A/B benchmark
EVOLVE_ARENA_POPULATION=200 npm run arena -- --research-mode ab <dataset>
EVOLVE_ARENA_AB_EXPAND=1 npm run arena -- --research-mode ab <dataset>          # opt-in descendant expansion
EVOLVE_ARENA_AB_SPECIES_MATCHED=1 npm run arena -- --research-mode ab <dataset> # species-matched control
EVOLVE_ARENA_AB_BOOTSTRAP_ITERATIONS=5000 npm run arena -- --research-mode ab <dataset>
EVOLVE_ARENA_WORKERS=8 npm run arena -- --research-mode ab <dataset>
npm run validate:phase5a3                                  # Phase 5A.3 suite (69 offline cases)
```

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

Phase 5A adds `npm run validate:phase5a` (63 offline cases):

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
  secret-shaped ever reaches disk; researchers demonstrably consult prior `REJECTED` conclusions; an
  unknown provider name always falls back to the offline mock, never a network call
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
- [x] Mock provider remains the deterministic default; DeepSeek NOT integrated
- [x] `npm run validate:phase5a2` — 60 offline cases
- [ ] Non-mock provider experiment: **DeepSeek V4.1 Flash via Cline, xhigh** (documented, not implemented)
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
- [ ] Real provider experiment: **DeepSeek V4.1 Flash via Cline, xhigh** (documented, NOT implemented —
      DeepSeek is not part of Phase 5A.3)

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
