"use client";

import {
  Activity,
  BrainCircuit,
  Dna,
  Gauge,
  Radio,
  ScanSearch,
  Skull,
  Sparkles,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useMemo, useState } from "react";

type Agent = {
  id: string;
  species: string;
  parents: string[];
  born: number;
  age: number;
  equity: number;
  returnPct: number;
  fitness: number;
  trades: number;
  winRate: number;
  maxDrawdown: number;
  status: string;
  lastAction: string;
  genome: Record<string, number>;
};

type EvolveState = {
  updatedAt: string;
  mode: string;
  generation: number;
  tick: number;
  generationTicks: number;
  marketRegime: string;
  stats: {
    population: number;
    totalEquity: number;
    avgReturn: number;
    holding: number;
    scanning: number;
    bornTotal: number;
    terminatedTotal: number;
    bestFitness: number;
    bestReturn: number;
  };
  topAgents: Agent[];
  species: { name: string; count: number; avgReturn: number }[];
  markets: {
    symbol: string;
    price: number;
    liquidity: number;
    changePct: number;
    buyPressure: number;
    uniqueBuyers: number;
  }[];
  history: {
    t: number;
    generation: number;
    tick: number;
    avgReturn: number;
  }[];
  events: {
    id: string;
    at: string;
    type: string;
    message: string;
  }[];
  lastGenerationSummary: null | {
    generation: number;
    bestId: string;
    bestSpecies: string;
    bestReturn: number;
    averageReturn: number;
  };
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function pct(value: number, digits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function relativeTime(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <div className="panel stat-card">
      <div className="stat-icon">
        <Icon size={18} />
      </div>
      <div>
        <p className="eyebrow">{label}</p>
        <div className="stat-value">{value}</div>
        <p className="muted">{detail}</p>
      </div>
    </div>
  );
}

function Dashboard({ state }: { state: EvolveState }) {
  const progress = (state.tick / state.generationTicks) * 100;
  const best = state.topAgents[0];

  const speciesMax = Math.max(...state.species.map((s) => s.count), 1);

  const chart = useMemo(
    () =>
      state.history.map((p) => ({
        ...p,
        label: `G${p.generation}:${p.tick}`,
      })),
    [state.history],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Dna size={26} />
          </div>
          <div>
            <div className="brand-line">
              <h1>EVOLVE</h1>
              <span className="live-chip">
                <span className="pulse-dot" />
                LIVE
              </span>
            </div>
            <p>Autonomous Evolutionary Markets</p>
          </div>
        </div>

        <div className="header-meta">
          <span className="mode-chip">{state.mode} MODE</span>
          <span className="regime-chip">
            <Radio size={14} />
            {state.marketRegime}
          </span>
        </div>
      </header>

      <section className="hero panel">
        <div>
          <p className="eyebrow">GENERATION</p>
          <div className="generation-number">{state.generation}</div>
        </div>
        <div className="generation-track-wrap">
          <div className="generation-meta">
            <span>Selection cycle</span>
            <span>
              {state.tick} / {state.generationTicks} ticks
            </span>
          </div>
          <div className="generation-track">
            <div
              className="generation-fill"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
          <p className="muted">
            Strong genomes reproduce. Weak genomes are terminated. Random
            immigrants preserve exploration.
          </p>
        </div>
        <div className="hero-best">
          <p className="eyebrow">LEADING GENOME</p>
          <strong>{best?.id ?? "—"}</strong>
          <span>{best?.species ?? "Waiting for engine"}</span>
        </div>
      </section>

      <section className="stats-grid">
        <StatCard
          label="Population"
          value={state.stats.population.toString()}
          detail={`${state.stats.holding} holding · ${state.stats.scanning} scanning`}
          icon={Users}
        />
        <StatCard
          label="Paper Equity"
          value={money.format(state.stats.totalEquity)}
          detail={`${pct(state.stats.avgReturn * 100)} population return`}
          icon={WalletCards}
        />
        <StatCard
          label="Best Agent"
          value={pct(state.stats.bestReturn * 100)}
          detail={`fitness ${state.stats.bestFitness.toFixed(2)}`}
          icon={TrendingUp}
        />
        <StatCard
          label="Born"
          value={compact.format(state.stats.bornTotal)}
          detail="all generations"
          icon={Sparkles}
        />
        <StatCard
          label="Terminated"
          value={compact.format(state.stats.terminatedTotal)}
          detail="culled by selection"
          icon={Skull}
        />
      </section>

      <section className="dashboard-grid">
        <div className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">POPULATION</p>
              <h2>Average return</h2>
            </div>
            <div className="chart-value">
              {pct(state.stats.avgReturn * 100)}
            </div>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 10, right: 4, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="returnFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity={0.38} />
                    <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis
                  tick={{ fill: "#6f7c92", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={54}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0b111c",
                    border: "1px solid #243147",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(value) => [`${Number(value).toFixed(3)}%`, "Avg return"]}
                />
                <Area
                  type="monotone"
                  dataKey="avgReturn"
                  stroke="currentColor"
                  strokeWidth={2}
                  fill="url(#returnFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel species-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ECOSYSTEM</p>
              <h2>Species</h2>
            </div>
            <BrainCircuit size={20} />
          </div>

          <div className="species-list">
            {state.species.map((s) => (
              <div className="species-row" key={s.name}>
                <div className="species-meta">
                  <span>{s.name}</span>
                  <span>
                    {s.count} · {pct(s.avgReturn * 100)}
                  </span>
                </div>
                <div className="species-track">
                  <div
                    className="species-fill"
                    style={{ width: `${(s.count / speciesMax) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="dashboard-grid lower-grid">
        <div className="panel agents-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">FITNESS LEADERBOARD</p>
              <h2>Living agents</h2>
            </div>
            <Gauge size={20} />
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Species</th>
                  <th>Status</th>
                  <th>Return</th>
                  <th>Fitness</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Drawdown</th>
                  <th>Last action</th>
                </tr>
              </thead>
              <tbody>
                {state.topAgents.map((agent, index) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="agent-id">
                        <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{agent.id}</strong>
                          <small>
                            {agent.parents.length
                              ? `from ${agent.parents.join(" × ")}`
                              : "founder"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{agent.species}</td>
                    <td>
                      <span
                        className={
                          agent.status === "HOLDING"
                            ? "status holding"
                            : "status scanning"
                        }
                      >
                        {agent.status}
                      </span>
                    </td>
                    <td className={agent.returnPct >= 0 ? "positive" : "negative"}>
                      {pct(agent.returnPct)}
                    </td>
                    <td>{agent.fitness.toFixed(2)}</td>
                    <td>{agent.trades}</td>
                    <td>{pct(agent.winRate * 100, 0)}</td>
                    <td className="negative">
                      -{(agent.maxDrawdown * 100).toFixed(1)}%
                    </td>
                    <td className="action-cell">{agent.lastAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="side-stack">
          <div className="panel feed-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">SELECTION LOG</p>
                <h2>Evolution feed</h2>
              </div>
              <Activity size={20} />
            </div>
            <div className="feed">
              {state.events.slice(0, 9).map((event) => (
                <div className="feed-item" key={event.id}>
                  <span className={`event-dot ${event.type.toLowerCase()}`} />
                  <div>
                    <strong>{event.type}</strong>
                    <p>{event.message}</p>
                    <small>{relativeTime(event.at)}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="panel markets-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">SIMULATED MARKET</p>
            <h2>Agent hunting ground</h2>
          </div>
          <ScanSearch size={20} />
        </div>

        <div className="market-grid">
          {state.markets.slice(0, 8).map((market) => (
            <div className="market-card" key={market.symbol}>
              <div>
                <strong>{market.symbol}</strong>
                <span>{money.format(market.liquidity)} liquidity</span>
              </div>
              <div className={market.changePct >= 0 ? "positive" : "negative"}>
                {pct(market.changePct)}
              </div>
              <div className="market-sub">
                <span>{Math.round(market.buyPressure * 100)}% buy pressure</span>
                <span>{market.uniqueBuyers} buyers</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>EVOLVE · Built by Cobalt</span>
        <span>
          Paper simulation only · no wallet keys · no mainnet execution
        </span>
      </footer>
    </main>
  );
}

export default function Home() {
  const [state, setState] = useState<EvolveState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) throw new Error("Waiting for evolutionary engine");
        const next = (await response.json()) as EvolveState;
        if (active) {
          setState(next);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Engine offline");
      }
    }

    refresh();
    const timer = window.setInterval(refresh, 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!state) {
    return (
      <main className="loading-shell">
        <div className="loading-card">
          <div className="brand-mark loading-mark">
            <Dna size={28} />
          </div>
          <p className="eyebrow">EVOLVE</p>
          <h1>{error ?? "Starting evolutionary engine…"}</h1>
          <p>
            Run <code>npm run dev:all</code> and this dashboard will attach to
            the live paper population automatically.
          </p>
        </div>
      </main>
    );
  }

  return <Dashboard state={state} />;
}
