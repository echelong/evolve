# EVOLVE

**Autonomous Evolutionary Markets**

EVOLVE is an experimental evolutionary trading-agent laboratory. A population of agents competes under identical market conditions, high-fitness genomes reproduce, weak agents are terminated, and mutations preserve exploration across generations.

> **Current status:** Phase 4 — Champion Arena, regime/stress testing, and the Live Shadow League, on
> top of Phase 3's historical capture, deterministic replay, and walk-forward evolution. The repository
> contains no wallet keys, no signer, and no transaction path. It cannot spend real SOL because that
> capability does not exist in it.

Every monetary number the system produces is **PAPER P&L**. Simulated returns are not real profits.
Historical backtests and paper results **do not** guarantee future profitability.

## What works

- 96 continuously running paper agents across six strategy species
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
npm run validate        # syntax + market + history validation + both smoke runs
npm run validate:market # Phase 2 behaviour checks (15 cases, offline)
npm run validate:history# Phase 3 checks (30 cases, offline)
npm run smoke:engine    # deterministic synthetic-mode evolution smoke run
npm run smoke:replay    # offline record → replay → walk-forward smoke run
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
agents this starts at 32/32/32/32/32/32. Islands are not just a display grouping: each generation,
births are allocated per island in proportion to how far under its target it currently sits (deficit
proportional, largest-remainder apportionment, so the total is always exact), and breeding draws from a
fixed, pre-generation snapshot of each island's own top performers — never from siblings born earlier in
the same generation. On top of that:

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

Per-island population, target, births, deaths, migrations in/out, revivals, extinction events, avg
return/fitness, trade count, and evidence-sufficient-agent count are all visible in `state.json` under
`islands` and rendered on the dashboard's Strategy Islands panel.

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
`ARENA_SURVIVOR`, `SHADOW_ELIGIBLE`. Each research cycle reloads prior conclusions first, so researchers
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
`Momentum x Liquidity`, `Reversal x Flow`) with fixed blending rules (weights average, binary gates AND,
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
npm run validate:phase5a         # Phase 5A validation suite (63 offline cases)
npm run arena -- --research      # include persisted research candidates as Arena entrants,
                                  # and promote research memory from the result
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
- [x] Meta-evolution over five approved existing-family combinations (no new signals, no code generation)
- [x] Deterministic regime specialization and `ACTIVE`/`REDUCED_RISK`/`ABSTAIN`, scoped to research
      candidates, replay-reproducible
- [x] Arena-gated promotion by genome digest — researchers cannot self-promote
- [x] Dashboard: Strategy Islands panel and Research Swarm panel, both labelled `PAPER RESEARCH`
- [ ] A non-mock research provider (still just an interface; only the offline mock is implemented)
- [ ] Automatic Arena re-entry of every compiled candidate on a fixed cadence (currently manual via
      `npm run arena -- --research`)

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
