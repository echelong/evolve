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
```

### Statistical honesty

Arena and shadow output report medians, worst-period figures, seed dispersion, and evidence strength
rather than a single flattering number, and every evolved candidate is compared against the same
mandatory Phase 3 baselines (no-trade, random, fixed momentum, buy-and-hold-like) under identical
observations and friction — including when the evolved candidates lose to them. Nothing in the Champion
Arena or the Live Shadow League is a claim that a candidate is profitable, safe, proven, predictive, or
statistically significant.

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
