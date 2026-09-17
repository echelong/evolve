# EVOLVE

**Autonomous Evolutionary Markets**

EVOLVE is an experimental evolutionary trading-agent laboratory. A population of agents competes under the same simulated market conditions, high-fitness genomes reproduce, weak agents are terminated, and mutations preserve exploration across generations.

> **Current status:** paper simulation only. The repository contains no wallet keys and cannot submit mainnet trades.

## What is already working

- 96 continuously running paper agents
- Six strategy species
- Individual trading genomes
- Fitness-based natural selection
- Elitism, crossover, mutation, random immigrants
- Birth / death / generation event stream
- Normalized starting capital each generation
- Fees included in paper execution
- Live dashboard polling the engine once per second
- Population equity and return chart
- Species distribution
- Agent leaderboard and genealogy hints
- Simulated token hunting ground

## Run

```bash
npm install
npm run dev:all
```

Open <http://localhost:3000>.

## Architecture

```text
paper market
    |
feature stream
    |
96-agent population
    |
fitness engine
    |
selection
  / | \
elite crossover mutation
    |
next generation
    |
.evolve/state.json
    |
Next.js API
    |
dashboard
```

## Evolution model

Every agent owns a genome containing entry thresholds, risk fraction, exit behavior, holding duration, signal weights, and a contrarian bit.

At the end of a generation:

1. Open paper positions are closed.
2. Fitness is calculated from return, drawdown, win rate, and activity.
3. The strongest elite agents survive unchanged.
4. Breeders create children through mutation and crossover.
5. Weak agents are terminated.
6. Random immigrants enter to prevent premature convergence.
7. Every agent begins the next evaluation with the same normalized paper capital.

## Roadmap

### Phase 1 — evolutionary lab
- [x] Paper swarm
- [x] Live dashboard
- [x] Selection / mutation / crossover
- [ ] Persistent generations in Postgres
- [ ] Replayable deterministic simulations
- [ ] Walk-forward / out-of-sample validation
- [ ] Baselines: random, buy-and-hold, momentum

### Phase 2 — Solana observation
- [ ] Helius WebSocket / LaserStream ingestion
- [ ] Jupiter token and price data
- [ ] Pool / liquidity feature extraction
- [ ] Wallet-flow features
- [ ] Real fees, slippage and failure modeling
- [ ] Rug / concentration / liquidity safety filters

### Phase 3 — shadow execution
- [ ] Live Solana market feed with simulated fills
- [ ] Strategy quarantine and promotion gates
- [ ] Risk-adjusted fitness across multiple regimes
- [ ] Kill switches and loss budgets

### Phase 4 — capped mainnet pilot
Only after out-of-sample evidence and explicit operator approval:
- tiny isolated bankroll
- hard per-agent and global loss caps
- no arbitrary wallet permissions
- signed order-intent layer
- Jupiter execution adapter
- automatic circuit breakers

## Important

Evolution does not create guaranteed alpha. A badly specified fitness function can optimize luck, overfitting, hidden simulator assumptions, or catastrophic tail risk. Real-money execution is intentionally not implemented in the first release.

---

**Built by Cobalt**
