"use client";

import { useEffect, useState } from "react";

type ObserverSummary = {
  state: string;
  captureStatus: string | null;
  providers: { provider: string; state: string; observations: number; errors: number }[];
  mintsJoined: number;
  freshJoined: number;
  launchEvents: number;
  providerErrors: number;
  maxPriceRangeBps: number | null;
  endedAt: number | null;
};

export function MarketIntelligencePanel() {
  const [summary, setSummary] = useState<ObserverSummary | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/market-intelligence", { cache: "no-store", signal: controller.signal });
        if (response.ok && active) setSummary(await response.json());
      } catch { /* Unavailable observer evidence does not affect engine display. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  return (
    <section className="panel" aria-label="Development market intelligence observer">
      <div className="panel-heading"><h2>Multi-source market intelligence</h2><span>DEVELOPMENT · OBSERVER ONLY · PAPER ONLY</span></div>
      <p>Latest finalized capture · research evidence · no trading authority</p>
      {!summary || summary.state === "NO_FINALIZED_SESSION" ? <p>No finalized observation session available.</p> : (
        <>
          <p>Capture status: {summary.captureStatus} · captured through {summary.endedAt === null ? "unknown" : new Date(summary.endedAt).toISOString()}</p>
          <div className="dashboard-grid">
            {summary.providers.map(p => <div key={p.provider}><strong>{p.provider === "launch" ? "Launch observer" : p.provider === "dexscreener" ? "DexScreener" : p.provider === "gmgn" ? "GMGN" : "Jupiter"}</strong><p>{p.state} · observations {p.observations} · errors {p.errors}</p></div>)}
          </div>
          <p>Mints joined {summary.mintsJoined} · fresh aligned multi-source {summary.freshJoined} · launch events {summary.launchEvents} · provider errors {summary.providerErrors}</p>
          <p>Maximum aligned cross-source price range: {summary.maxPriceRangeBps === null ? "unavailable" : `${summary.maxPriceRangeBps.toFixed(1)} bps`}. Liquidity and volume comparisons require compatible scope and windows.</p>
        </>
      )}
    </section>
  );
}
