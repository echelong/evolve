#!/usr/bin/env node
/**
 * EVOLVE Phase 5I.0b — direct TypeSafe Jev short-horizon PREDICTION BENCHMARK CLI.
 *
 *   npm run jev:direction -- --start --market SOL-USDC --max-observations 120
 *   npm run jev:direction -- --resume  --experiment <id>
 *   npm run jev:direction -- --resolve --experiment <id>
 *   npm run jev:direction -- --replay  --experiment <id>
 *   npm run jev:direction -- --stats   --experiment <id>
 *
 * This is a DIRECTIONAL PREDICTION BENCHMARK:
 *
 *   - it is NOT a trading strategy, produces NO orders (real or paper), and
 *     makes NO profitability claim;
 *   - it does NOT give Jev trading authority, and touches no Arena score, no
 *     evolution, no research cohort, no agent, and no deployment gate;
 *   - it calls exactly ONE decision model: direct TypeSafe Jev
 *     (`typesafe-jev`, `gatewayUsed=false`, model `jev-1.13.0`). Vercel and mock
 *     routes are refused for canonical evidence (`--allow-mock` exists only for
 *     offline development runs and is labelled honestly on every artifact);
 *   - it has NO confidence threshold: every valid probability is retained.
 *
 * Explicit experiment ids only. There is no "latest". No daemon, no background
 * process, bounded runtime, resumable, safe interruption.
 */

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import { resolveJevConfig } from "./jev/config.mjs";
import { createResilientJevProvider } from "./jev/provider.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";
import { createMarketConfig } from "./market/config.mjs";
import {
  DIRECTION_ACTIONS,
  DIRECTION_BOOLEAN_FLAGS,
  DIRECTION_EVIDENCE_CLASS,
  DIRECTION_EXPERIMENTS_DIR,
  DIRECTION_FORBIDDEN_FLAGS,
  DIRECTION_PHASE,
  DIRECTION_ROOT_DIR,
  DIRECTION_VALUE_FLAGS,
  HORIZON_SECONDS,
  RECOMMENDED_ENDPOINT_ORDER,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  SUPPORTED_MARKET_IDS,
  resolveDirectionAction,
} from "./jev/direction/definition.mjs";
import { DIRECTION_QUESTION_SET_ID, DIRECTION_QUESTION_SET_VERSION, buildDirectionQuestions, directionQuestionDigest } from "./jev/direction/questions.mjs";
import { DIRECTION_PACKET_VERSION } from "./jev/direction/packet.mjs";
import {
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
} from "./jev/direction/features.mjs";
import { BASELINE_DEFINITION_DIGEST, BASELINE_DEFINITION_VERSION } from "./jev/direction/baselines.mjs";
import { createSolDirectionObservationSource } from "./jev/direction/observation.mjs";
import { createDirectionFixtureProvider } from "./jev/direction/fixture-provider.mjs";
import {
  buildDirectionRunSettings,
  collectDirectionSettingsProblems,
  enforceDirectionProviderPins,
} from "./jev/direction/settings.mjs";
import { directionStats, replayDirectionExperiment, runDirectionBenchmark } from "./jev/direction/runner.mjs";

loadEnvFiles();

const ALL_FLAGS = new Set([...DIRECTION_BOOLEAN_FLAGS, ...DIRECTION_VALUE_FLAGS]);

function usage() {
  return [
    `EVOLVE Phase ${DIRECTION_PHASE} — direct TypeSafe Jev short-horizon DIRECTIONAL PREDICTION BENCHMARK`,
    "(DEVELOPMENT EVIDENCE ONLY — no orders, no PnL, no trading authority)",
    "",
    "  npm run jev:direction -- --start --market SOL-USDC --max-observations 120",
    "  npm run jev:direction -- --resume  --experiment <id>",
    "  npm run jev:direction -- --resolve --experiment <id>",
    "  npm run jev:direction -- --replay  --experiment <id>",
    "  npm run jev:direction -- --stats   --experiment <id>",
    "",
    "Options:",
    `  --market <id>              ${SUPPORTED_MARKET_IDS.join(" | ")} (Phase ${DIRECTION_PHASE} benchmarks exactly one market)`,
    `  --max-observations <n>     default 120 (bounded)`,
    `  --cadence-seconds <n>      default 30 (bounded)`,
    `  --horizon-seconds <n>      FROZEN at ${HORIZON_SECONDS}; any other value is refused`,
    `  --tolerance-ms <n>         future-observation tolerance around targetAt (default 5000)`,
    `  --max-runtime-minutes <n>  bounded runtime per invocation (default 90)`,
    `  --provider <name>          must resolve to ${REQUIRED_PROVIDER} for canonical evidence`,
    `  --experiment <id>          explicit experiment id (REQUIRED for resume/resolve/replay/stats)`,
    `  --out <dir>                experiments directory (default ${DIRECTION_EXPERIMENTS_DIR})`,
    "  --allow-mock               explicit OFFLINE run with mock-jev (never canonical evidence)",
    "  --allow-unsafe-model       explicit non-canonical model override (recorded honestly)",
    "  --definition               print the frozen definition (market, horizon, digests, omitted feature families)",
    "  --json                     machine-readable output",
    "  --help                     this help",
    "",
    `There is NO "latest": every action except --start needs an EXPLICIT experiment id.`,
    `There is NO confidence threshold: every valid probability is retained (target is P(HIGHER), kept raw).`,
    "FORBIDDEN here (hard error): thresholds, trading, wallets, signing, swaps, Arena, DeepSeek, routing, PnL.",
  ].join("\n");
}

function fail(message, code = 2) {
  console.error(`[jev:direction] ${message}`);
  process.exitCode = code;
}

function printDefinition() {
  console.log(`[jev:direction] Phase ${DIRECTION_PHASE} — frozen definition`);
  console.log(`[jev:direction]   market:           ${SUPPORTED_MARKET_IDS.join(", ")}`);
  console.log(`[jev:direction]   horizon:          ${HORIZON_SECONDS}s (frozen; no horizon optimization)`);
  console.log(`[jev:direction]   provider:         ${REQUIRED_PROVIDER} (direct, gatewayUsed=false)`);
  console.log(`[jev:direction]   model:            ${REQUIRED_MODEL}`);
  console.log(`[jev:direction]   question set:     ${DIRECTION_QUESTION_SET_ID} v${DIRECTION_QUESTION_SET_VERSION}`);
  console.log(`[jev:direction]   question digest:  ${directionQuestionDigest()}`);
  console.log(`[jev:direction]   packet:           JEV_MICROSTRUCTURE_DIRECTION_PACKET v${DIRECTION_PACKET_VERSION}`);
  console.log(`[jev:direction]   features:         direction-feature-definition-v${DIRECTION_FEATURE_DEFINITION_VERSION} (${DIRECTION_FEATURE_DEFINITION_DIGEST.slice(0, 12)}…)`);
  console.log(`[jev:direction]   baselines:        direction-baseline-definition-v${BASELINE_DEFINITION_VERSION} (${BASELINE_DEFINITION_DIGEST.slice(0, 12)}…)`);
  console.log(`[jev:direction]   evidence class:   ${DIRECTION_EVIDENCE_CLASS} (developmentOnly, no profitability/trading/deployment inference)`);
  console.log(`[jev:direction]   research tree:    ${DIRECTION_ROOT_DIR}/experiments/<experiment-id>/`);
  console.log("[jev:direction]   omitted families: orderBookImbalance, queueDepth, cvd, makerFlow, quoteSpread, routePriceImpact (not observable in EVOLVE's schema)");
}

function printMetricsBlock(metrics) {
  if (!metrics) return;
  const fmt = (value, digits = 4) => (Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a");
  console.log(`[jev:direction]   observations      ${metrics.observationCount} (valid ${metrics.validPredictionCount} · invalid ${metrics.invalidPredictionCount})`);
  console.log(`[jev:direction]   scored            ${metrics.scoredCount} binary · HIGHER ${metrics.higherCount} · LOWER ${metrics.lowerCount} · TIE ${metrics.tieCount} (ties excluded from binary scoring)`);
  console.log(`[jev:direction]   Jev Brier         ${fmt(metrics.jev?.brierScore)} · log loss ${fmt(metrics.jev?.logLoss)} · accuracy ${fmt(metrics.jev?.accuracy)}`);
  console.log(`[jev:direction]   mean pHigher      ${fmt(metrics.probabilityStats?.scoredBinary?.meanPHigher)} · median ${fmt(metrics.probabilityStats?.scoredBinary?.medianPHigher)}`);
  for (const [baselineId, delta] of Object.entries(metrics.brierDeltas ?? {})) {
    console.log(
      `[jev:direction]   Δ vs ${baselineId.padEnd(26)} Brier ${fmt(delta.jevMinusBaselineBrier)} · log loss ${fmt(delta.jevMinusBaselineLogLoss)} · accuracy ${fmt(delta.jevMinusBaselineAccuracy)}`,
    );
  }
  const latency = metrics.latency?.jevOkOnly ?? {};
  console.log(`[jev:direction]   latency (ok)      mean ${fmt(latency.meanMs, 0)}ms · median ${fmt(latency.medianMs, 0)}ms · p90 ${fmt(latency.p90Ms, 0)}ms · p95 ${fmt(latency.p95Ms, 0)}ms · max ${fmt(latency.maxMs, 0)}ms`);
  console.log(`[jev:direction]   retries           ${metrics.latency?.observationsWithTransportRetries ?? 0} observation(s) needed >1 transport attempt`);
  console.log("[jev:direction]   NO winner is emitted automatically; lower Brier/log loss is better. No PnL, no Sharpe, no trade count.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleanFlags: DIRECTION_BOOLEAN_FLAGS,
    valueFlags: DIRECTION_VALUE_FLAGS,
  });

  if (args.help === true) {
    console.log(usage());
    return;
  }

  if (args.definition === true) {
    printDefinition();
    return;
  }

  // ---- forbidden options are a hard error, never silently ignored ----------
  // The FORBIDDEN check runs FIRST, so a trading/threshold-looking flag gets the
  // precise "this phase forbids it" message rather than a generic "unknown".
  const supplied = Object.keys(args).filter((key) => key !== "_");
  for (const key of supplied) {
    if (DIRECTION_FORBIDDEN_FLAGS.includes(key)) {
      fail(`--${key} is FORBIDDEN in Phase ${DIRECTION_PHASE} (this benchmark has no thresholds, no routing, no trading, and no PnL)`);
      return;
    }
    if (!ALL_FLAGS.has(key)) {
      fail(`unknown option --${key}; Phase ${DIRECTION_PHASE} accepts only: ${[...ALL_FLAGS].sort().join(", ")}`);
      return;
    }
  }

  const { action, error: actionError } = resolveDirectionAction(args);
  if (actionError) {
    fail(actionError);
    console.error(`[jev:direction] actions: ${DIRECTION_ACTIONS.map((name) => `--${name}`).join(" | ")}`);
    return;
  }

  const experimentId = args.experiment !== undefined ? String(args.experiment).trim() : null;
  if (action !== "start") {
    if (!experimentId) {
      fail(`${action} requires an explicit --experiment <id>; there is NO "latest"`);
      return;
    }
  }
  if (experimentId !== null && (experimentId.toLowerCase() === "latest" || experimentId.toLowerCase() === "all")) {
    fail(`--experiment ${experimentId} is refused: Phase ${DIRECTION_PHASE} never guesses which experiment you meant`);
    return;
  }

  const settings = buildDirectionRunSettings({ ...args, experiment: experimentId });
  const baseRoot = settings.baseRoot ?? null;

  // ---------------------------------------------------------------------------
  // OFFLINE ACTIONS FIRST (--replay / --stats).
  //
  // These two actions read persisted artifacts and NOTHING else: zero network
  // calls, zero provider calls, zero credentials required. They are therefore
  // dispatched BEFORE provider/model/transport pin enforcement — a replay must
  // never depend on a live credential existing, and must never be able to touch
  // a provider even by accident.
  // ---------------------------------------------------------------------------
  if (action === "replay" || action === "stats") {
    if (settings.problems.length > 0) {
      for (const problem of settings.problems) console.error(`[jev:direction] ${problem}`);
      console.error("[jev:direction] nothing was read; no provider was called.");
      process.exitCode = 2;
      return;
    }
    if (action === "replay") {
      const report = await replayDirectionExperiment({ experimentId, baseRoot });
      if (args.json === true) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`EVOLVE Phase ${DIRECTION_PHASE} offline replay — ${experimentId}`);
        console.log(`[jev:direction]   integrity         ${report.ok ? "OK" : "FAIL"}`);
        console.log(
          `[jev:direction]   read only         yes · network ${report.networkCalls} · jev ${report.jevCalls} · agentReach ` +
            `${report.agentReachCalls} · classifier ${report.classifierCalls} · deepseek ${report.deepseekCalls} · arena ` +
            `${report.arenaRuns} · trading ${report.tradingCalls}`,
        );
        console.log(`[jev:direction]   provider/model    ${report.provider} / ${report.model} (gatewayUsed=${report.gatewayUsed})`);
        console.log(`[jev:direction]   counts            ${JSON.stringify(report.counts ?? {})}`);
        console.log(`[jev:direction]   checks            ${JSON.stringify(report.checks ?? {})}`);
        console.log(`[jev:direction]   lookahead         ${report.lookaheadAudit?.ok ? "clean" : "FAILED"} (${report.lookaheadAudit?.recomputationPairs ?? 0} recomputation pairs)`);
        if (!report.metricsMatch) console.log(`[jev:direction]   metrics           stored ${report.storedMetricsDigest ?? "none"} vs recomputed ${report.recomputedMetricsDigest}`);
        for (const problem of report.problems ?? []) console.error(`[jev:direction]   problem           ${problem}`);
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    const stats = await directionStats({ experimentId, baseRoot });
    if (!stats.ok) {
      fail(stats.error ?? "stats failed", 1);
      return;
    }
    if (args.json === true) {
      console.log(JSON.stringify({ ...stats, experiment: { ...stats.experiment }, metrics: stats.metrics }, null, 2));
      return;
    }
    console.log(`EVOLVE Phase ${DIRECTION_PHASE} prediction-quality stats — ${experimentId} (READ ONLY, DEVELOPMENT EVIDENCE)`);
    console.log(`[jev:direction]   metrics digest    ${stats.metricsDigest}${stats.metricsMatch === null ? " (no summary stored yet)" : stats.metricsMatch ? " (matches stored summary)" : " (does NOT match stored summary)"}`);
    printMetricsBlock(stats.metrics);
    console.log("[jev:direction]   evidence class    DEVELOPMENT_JEV_DIRECTION_EVIDENCE — developmentOnly, not replication, not profitability");
    return;
  }

  // ---- start / resume / resolve: pins are enforced BEFORE anything happens --
  const envConfig = resolveJevConfig();
  const pinResult = {
    ...enforceDirectionProviderPins({ settings, envConfig }),
    questionDigest: directionQuestionDigest(),
  };
  const problems = collectDirectionSettingsProblems(settings, pinResult);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[jev:direction] ${problem}`);
    console.error("[jev:direction] nothing was started; no artifact was written and no provider was called.");
    process.exitCode = 2;
    return;
  }

  // ---- start / resume / resolve: live market observation required ----------
  // Live-only observation (the synthetic simulator can never become benchmark
  // evidence), and the recommended endpoint ORDER when the operator has not
  // pinned one explicitly — the engine's own endpoint set, ordered so the
  // reference-price stamp lands as early in a cycle as the venue allows.
  const marketEnv = { ...process.env, EVOLVE_MARKET_MODE: "live" };
  if (!String(marketEnv.EVOLVE_JUPITER_ENDPOINTS ?? "").trim()) {
    marketEnv.EVOLVE_JUPITER_ENDPOINTS = RECOMMENDED_ENDPOINT_ORDER.join(",");
  }
  const marketConfig = createMarketConfig(marketEnv);
  pinResult.observationEndpoints = marketConfig.endpoints.map((endpoint) => endpoint.id);
  const source = createSolDirectionObservationSource({ config: marketConfig });

  let provider = null;
  let offlineFixture = false;
  if (settings.allowMock === true) {
    // Explicit offline development fixture. Never canonical evidence: the run is
    // recorded as offlineFixture=true with the exact implementation name.
    provider = createDirectionFixtureProvider();
    offlineFixture = true;
  } else {
    const resilient = createResilientJevProvider({
      selectedProvider: pinResult.resolution.provider,
      // The chain is EMPTY here by construction as well as refused above: no
      // gateway route can ever answer as a substitute for the direct route.
      config: { ...envConfig, transportChain: [] },
      modelOverride: settings.modelOverride || null,
      timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : envConfig.timeoutMs,
    });
    provider = resilient.provider;
  }
  pinResult.offlineFixture = offlineFixture;
  pinResult.providerImplementation = provider?.implementation ?? provider?.name ?? null;

  const budget = createJevRunBudget(settings.maxObservations);
  const control = { stopped: false };
  const onSigint = () => {
    if (control.stopped) return;
    control.stopped = true;
    console.error("[jev:direction] interrupt received — finishing the current step, then persisting progress and summary (resumable)");
  };
  process.on("SIGINT", onSigint);

  const questions = buildDirectionQuestions();
  const verbose = args.json !== true;
  const onProgress = verbose
    ? (event) => {
        if (event.type === "PREDICTION_FROZEN") {
          console.log(
            `[jev:direction] #${String(event.observationIndex).padStart(4, "0")} ${event.observationId} ` +
              `pHigher=${Number.isFinite(event.pHigher) ? Number(event.pHigher).toFixed(4) : "n/a"} ` +
              `latency=${Number.isFinite(event.latencyMs) ? `${event.latencyMs}ms` : "n/a"} price=${event.referencePrice ?? "n/a"}`,
          );
        } else if (event.type === "PREDICTION_INVALID") {
          console.log(`[jev:direction] #${String(event.observationIndex).padStart(4, "0")} ${event.observationId} INVALID (${event.invalidReason})`);
        } else if (event.type === "OUTCOME_RESOLVED") {
          console.log(`[jev:direction]          outcome ${event.actualOutcome ?? "unresolved"} (scorable=${event.scorable === true}, lag=${event.resolutionLagMs ?? "n/a"}ms)`);
        } else if (event.type === "OUTCOME_REFUSED") {
          console.log(`[jev:direction]          outcome REFUSED (${event.reason})`);
        } else if (event.type === "EXPERIMENT_CREATED") {
          console.log(`[jev:direction] experiment ${event.experimentId} created at ${event.root}`);
        } else if (event.type === "RESUME" || event.type === "RESOLVE") {
          console.log(`[jev:direction] ${event.type.toLowerCase()} ${event.experimentId} at ${event.root}`);
        }
      }
    : null;

  try {
    const result = await runDirectionBenchmark({
      action,
      settings,
      provider,
      source,
      baseRoot,
      control,
      onProgress,
      budget,
      questions,
      experimentId,
      pinResult,
    });

    if (!result.ok) {
      fail(result.error ?? "run failed", 1);
      return;
    }

    if (args.json === true) {
      const summary = result.summary;
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: result.action,
            experimentId: result.experimentId,
            root: result.root,
            interrupted: result.interrupted === true,
            report: result.report ?? null,
            metrics: summary.metrics,
            metricsDigest: summary.metricsDigest,
            evidenceClass: DIRECTION_EVIDENCE_CLASS,
            developmentOnly: true,
            noProfitabilityInference: true,
            noTradingInference: true,
            noDeploymentInference: true,
            gatewayUsed: false,
            provider: result.experiment.provider,
            model: result.experiment.model,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("");
    console.log(`EVOLVE Phase ${DIRECTION_PHASE} — ${result.action} finished for ${result.experimentId}`);
    console.log(`[jev:direction]   artifacts         ${result.root}`);
    console.log(`[jev:direction]   status            ${result.experiment.status}${result.interrupted ? " (resumable: npm run jev:direction -- --resume --experiment " + result.experimentId + ")" : ""}`);
    console.log(`[jev:direction]   provider/model    ${result.experiment.provider} / ${result.experiment.model} (gatewayUsed=${result.experiment.gatewayUsed})`);
    console.log(`[jev:direction]   this invocation   ${JSON.stringify(result.report ?? {})}`);
    console.log(`[jev:direction]   counters          ${JSON.stringify(result.experiment.counters ?? {})}`);
    printMetricsBlock(result.metrics);
    console.log("[jev:direction]   NOTE              DEVELOPMENT_JEV_DIRECTION_EVIDENCE only — not replication, not a strategy, no orders were produced.");
    process.exitCode = 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
    source.close();
  }
}

main().catch((error) => {
  console.error("[jev:direction] failed:", error?.stack ?? error?.message ?? error);
  process.exitCode = 1;
});
