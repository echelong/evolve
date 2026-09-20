#!/usr/bin/env node
/**
 * EVOLVE — Jev-assisted PAPER SHADOW dashboard experiment CLI.
 *
 *   npm run jev:paper
 *   npm run jev:paper -- --minutes 60
 *   npm run jev:paper -- --minutes 60 --cadence-ms 30000
 *
 * A DEVELOPMENT / OBSERVABILITY experiment ONLY. It runs a separate,
 * Jev-controlled PAPER account beside the normal EVOLVE dashboard and paper
 * evolutionary engine, observing SOL/USDC with genuine live Jupiter data and
 * performing deterministic simulated paper entries/exits.
 *
 * It is NOT canonical predictive evidence, NOT replication evidence, and must
 * never be treated as either. It does not touch Phase 5I evidence, the Arena,
 * the Shadow League, evolution, the research swarm, or the deployment gates.
 *
 * There is no wallet, no signing, no swap, no order, no RPC write, and no
 * real-money execution. PAPER ONLY.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import { resolveJevConfig } from "./jev/config.mjs";
import { createResilientJevProvider } from "./jev/provider.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createSolDirectionObservationSource } from "./jev/direction/observation.mjs";
import { buildDirectionQuestions } from "./jev/direction/questions.mjs";
import {
  PAPER_SHADOW_ACCOUNTING_NOTE,
  PAPER_SHADOW_DEFAULT_CADENCE_MS,
  PAPER_SHADOW_DEFAULT_DURATION_MINUTES,
  PAPER_SHADOW_EXCLUSION_NOTE,
  PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS,
  PAPER_SHADOW_LABEL,
  PAPER_SHADOW_MAX_DECISIONS,
  PAPER_SHADOW_MARKET_ID,
  PAPER_SHADOW_POSITION_FRACTION,
  PAPER_SHADOW_ROOT_DIR,
  PAPER_SHADOW_STARTING_CASH,
  PAPER_SHADOW_SUPPORTED_MARKET_IDS,
  PAPER_SHADOW_RECOMMENDED_ENDPOINT_ORDER,
  paperShadowSessionIdFor,
  paperShadowSessionRootFor,
} from "./jev/paper-shadow/definition.mjs";
import { buildPaperShadowSettings, enforcePaperShadowProviderPins } from "./jev/paper-shadow/settings.mjs";
import { runPaperShadow } from "./jev/paper-shadow/runner.mjs";

const BOOLEAN_FLAGS = ["help", "json"];
const VALUE_FLAGS = ["minutes", "cadence-ms", "market", "session", "out"];

function usage() {
  return [
    "EVOLVE — Jev-assisted PAPER SHADOW dashboard experiment (DEVELOPMENT ONLY)",
    "",
    "  npm run jev:paper",
    "  npm run jev:paper -- --minutes 60",
    "  npm run jev:paper -- --minutes 60 --cadence-ms 30000",
    "",
    "Options:",
    `  --minutes <n>       bounded run duration in minutes (default ${PAPER_SHADOW_DEFAULT_DURATION_MINUTES})`,
    `  --cadence-ms <n>    decision cadence in ms (default ${PAPER_SHADOW_DEFAULT_CADENCE_MS})`,
    `  --market <id>       ${PAPER_SHADOW_SUPPORTED_MARKET_IDS.join(" | ")} (the experiment observes exactly one market)`,
    `  --session <id>      explicit session id (default jpaper-<UTC timestamp>-<digest>)`,
    `  --out <dir>         session tree (default ${PAPER_SHADOW_ROOT_DIR})`,
    "  --json              machine-readable result",
    "  --help              this help",
    "",
    `Frozen: market ${PAPER_SHADOW_MARKET_ID} · starting cash $${PAPER_SHADOW_STARTING_CASH} · position fraction ${PAPER_SHADOW_POSITION_FRACTION}`,
    "Provider: direct TypeSafe Jev (typesafe-jev), model jev-1.13.0, gatewayUsed=false, cache disabled.",
    "No fallback to mock-jev, the Vercel AI Gateway, a cached answer, or another model.",
    "",
    `Isolation: writes only under ${PAPER_SHADOW_ROOT_DIR}/<session>/ and NEVER into ${PAPER_SHADOW_FORBIDDEN_WRITE_ROOTS.join(", ")}.`,
    PAPER_SHADOW_ACCOUNTING_NOTE,
    PAPER_SHADOW_EXCLUSION_NOTE,
    "No daemon. Ctrl+C finalizes the summary cleanly. PAPER ONLY.",
  ].join("\n");
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const settings = buildPaperShadowSettings(args);
  if (settings.problems.length > 0) {
    for (const problem of settings.problems) console.error(`[jev:paper] ${problem}`);
    console.error("[jev:paper] nothing was started; no artifact was written and no provider was called.");
    process.exitCode = 2;
    return;
  }

  // ---- FAIL-CLOSED provider enforcement (direct TypeSafe only) --------------
  const envConfig = resolveJevConfig();
  const pins = enforcePaperShadowProviderPins({ envConfig });
  if (!pins.ok) {
    for (const problem of pins.problems) console.error(`[jev:paper] ${problem}`);
    console.error(
      "[jev:paper] refusing to start: this experiment requires direct TypeSafe Jev. No artifact was written and no provider was called.",
    );
    process.exitCode = 2;
    return;
  }

  // ---- genuine live market observation only --------------------------------
  const marketEnv = { ...process.env, EVOLVE_MARKET_MODE: "live" };
  if (!String(marketEnv.EVOLVE_JUPITER_ENDPOINTS ?? "").trim()) {
    marketEnv.EVOLVE_JUPITER_ENDPOINTS = PAPER_SHADOW_RECOMMENDED_ENDPOINT_ORDER.join(",");
  }
  const marketConfig = createMarketConfig(marketEnv);
  const source = createSolDirectionObservationSource({ config: marketConfig });

  // ---- session identity (known before the run so provider health is isolated) ----
  const sessionId = settings.sessionId ?? paperShadowSessionIdFor({ startedAt: Date.now() });
  const baseRoot = settings.baseRoot ?? PAPER_SHADOW_ROOT_DIR;
  const sessionRoot = paperShadowSessionRootFor(baseRoot, sessionId);
  const healthRoot = path.join(sessionRoot, "provider-health");
  await mkdir(healthRoot, { recursive: true });

  const resilient = createResilientJevProvider({
    selectedProvider: pins.provider,
    // No chain: no gateway route can ever answer as a substitute.
    config: { ...envConfig, transportChain: [] },
    modelOverride: null,
    timeoutMs: envConfig.timeoutMs,
    healthRoot,
  });
  const provider = resilient.provider;

  const questions = buildDirectionQuestions();
  const budget = createJevRunBudget(PAPER_SHADOW_MAX_DECISIONS);

  const control = { stopped: false };
  const onSigint = () => {
    if (control.stopped) return;
    control.stopped = true;
    console.error(`[jev:paper] interrupt received — finalizing ${sessionId} cleanly`);
  };
  process.on("SIGINT", onSigint);

  const verbose = args.json !== true;
  const onEvent = verbose
    ? (event) => {
        if (event.type !== "DECISION") return;
        const p = Number.isFinite(event.pHigher) ? event.pHigher.toFixed(4) : "n/a";
        console.log(
          `[jev:paper] #${String(event.sequence).padStart(4, "0")} ${String(event.action).padEnd(9)} ` +
            `pHigher=${p} intent=${event.modelIntent ?? "n/a"} ` +
            `price=${event.referencePrice ?? "n/a"} equity=$${Number(event.equity ?? 0).toFixed(4)} ` +
            `net=$${Number(event.netPnl ?? 0).toFixed(4)}${event.actionReason ? ` (${event.actionReason})` : ""}`,
        );
      }
    : null;

  try {
    const result = await runPaperShadow({
      settings: { ...settings, sessionId },
      provider,
      source,
      questions,
      friction: marketConfig.paper,
      baseRoot,
      control,
      budget,
      onEvent,
    });

    if (args.json === true) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            sessionId: result.sessionId,
            root: result.root,
            status: result.session.status,
            provider: result.session.provider,
            model: result.session.model,
            gatewayUsed: false,
            summary: result.summary,
            paperOnly: true,
            canonicalEvidence: false,
            replicationEvidence: false,
          },
          null,
          2,
        ),
      );
      return;
    }

    const s = result.summary;
    console.log("");
    console.log(`${PAPER_SHADOW_LABEL}`);
    console.log(`[jev:paper]   artifacts        ${result.root}`);
    console.log(`[jev:paper]   status           ${result.session.status}`);
    console.log(`[jev:paper]   provider/model   ${result.session.provider} / ${result.session.model} (gatewayUsed=false)`);
    console.log(`[jev:paper]   market           ${PAPER_SHADOW_MARKET_ID} · ${result.session.market.baseSymbol}/${result.session.market.quoteSymbol}`);
    console.log(`[jev:paper]   decisions        ${s.decisions} · Jev ok ${s.jevOk} · Jev failures ${s.jevFailures}`);
    console.log(`[jev:paper]   actions          enter ${s.enterCount} · exit ${s.exitCount} · hold ${s.holdCount} · cash ${s.cashCount}`);
    console.log(`[jev:paper]   closed trades    ${s.winningClosedTrades} winning · ${s.losingClosedTrades} losing`);
    console.log(`[jev:paper]   ending equity    $${s.endingEquity ?? "n/a"} (start $${s.startingCash})`);
    console.log(`[jev:paper]   net P&L          $${s.netPnl ?? "n/a"} · gross $${s.grossPnl ?? "n/a"} · costs $${s.totalCosts ?? "n/a"}`);
    console.log(`[jev:paper]   max drawdown     ${s.maxDrawdown != null ? (s.maxDrawdown * 100).toFixed(2) : "n/a"}%`);
    console.log(`[jev:paper]   ${PAPER_SHADOW_ACCOUNTING_NOTE}`);
    console.log(`[jev:paper]   ${PAPER_SHADOW_EXCLUSION_NOTE}`);
    process.exitCode = 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
    source.close();
  }
}

main().catch((error) => {
  console.error("[jev:paper] failed:", error?.stack ?? error?.message ?? error);
  process.exitCode = 1;
});
