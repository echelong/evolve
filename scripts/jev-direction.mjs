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
 * Phase 5I.1 adds the FROZEN-PROTOCOL REPLICATION surface (also ID-only, also
 * offline for every read):
 *
 *   npm run jev:direction -- --start --replication-session --market SOL-USDC --max-observations 120
 *   npm run jev:direction -- --replication-create --development <canonical-development-id>
 *   npm run jev:direction -- --replication-add    --replication <id> --experiment <fresh-jdir-id>
 *   npm run jev:direction -- --replication-replay --replication <id>
 *   npm run jev:direction -- --replication-stats  --replication <id>
 *
 * No replication command LAUNCHES a session: the operator runs each 120-observation
 * session manually, reviews its integrity, and only then adds it.
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
  DIRECTION_ALL_ACTIONS,
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
  isReplicationAction,
  resolveDirectionAction,
} from "./jev/direction/definition.mjs";
import {
  DEVELOPMENT_EVIDENCE_PROFILE,
  DIRECTION_EVIDENCE_CLASSES,
  REPLICATION_EVIDENCE_CLASS,
  REPLICATION_EVIDENCE_PROFILE,
} from "./jev/direction/evidence.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_INFERENCE_UNIT,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_SESSION_OBSERVATIONS,
  REQUIRED_CLEAN_REPLICATION_SESSIONS,
} from "./jev/direction/replication/protocol.mjs";
import { CANONICAL_DEVELOPMENT_BARRIER } from "./jev/direction/replication/development-barrier.mjs";
import {
  REPLICATION_BOOTSTRAP_STATE,
  REPLICATION_INSUFFICIENT_STATE,
} from "./jev/direction/replication/aggregate.mjs";
import {
  replicationAdd,
  replicationCreate,
  replicationReplay,
  replicationStats,
} from "./jev/direction/replication/runner.mjs";
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
    "(DEVELOPMENT EVIDENCE ONLY by default; replication sessions are labelled CLEAN replication evidence)",
    "(no orders, no PnL, no trading authority)",
    "",
    "  npm run jev:direction -- --start --market SOL-USDC --max-observations 120",
    "  npm run jev:direction -- --resume  --experiment <id>",
    "  npm run jev:direction -- --resolve --experiment <id>",
    "  npm run jev:direction -- --replay  --experiment <id>",
    "  npm run jev:direction -- --stats   --experiment <id>",
    "",
    `Phase ${DIRECTION_PHASE} has TWO evidence classes; the class is chosen when an experiment is CREATED and never changes:`,
    `  ${DEVELOPMENT_EVIDENCE_PROFILE.evidenceClass}   development evidence (default)`,
    `  ${REPLICATION_EVIDENCE_CLASS}   ONE fresh replication session of the frozen protocol`,
    "",
    "Phase 5I.1 REPLICATION (frozen protocol, fresh unseen sessions, ID-ONLY):",
    "  npm run jev:direction -- --start --replication-session --market SOL-USDC --max-observations 120",
    "  npm run jev:direction -- --replication-create --development jdir-20260920T063311Z-3a9163",
    "  npm run jev:direction -- --replication-add --replication <id> --experiment <fresh-jdir-id>",
    "  npm run jev:direction -- --replication-replay --replication <id>",
    "  npm run jev:direction -- --replication-stats --replication <id>",
    "  (a replication command NEVER launches a session: the operator runs each one manually and reviews it first)",
    "",
    "Options:",
    `  --market <id>              ${SUPPORTED_MARKET_IDS.join(" | ")} (Phase ${DIRECTION_PHASE} benchmarks exactly one market)`,
    `  --max-observations <n>     default 120 (bounded)`,
    `  --cadence-seconds <n>      default 30 (bounded)`,
    `  --horizon-seconds <n>      FROZEN at ${HORIZON_SECONDS}; any other value is refused`,
    `  --tolerance-ms <n>         bounded post-target outcome offset. It SELECTS a frozen outcome-resolution policy by its`,
    `                             bound (5000 -> policy v1, 10000 -> policy v2, the default for new experiments)`,
    `  --max-runtime-minutes <n>  bounded runtime per invocation (default 90)`,
    `  --provider <name>          must resolve to ${REQUIRED_PROVIDER} for canonical evidence`,
    `  --experiment <id>          explicit experiment id (REQUIRED for resume/resolve/replay/stats/replication-add)`,
    `  --out <dir>                experiments directory (default ${DIRECTION_EXPERIMENTS_DIR})`,
    "  --allow-mock               explicit OFFLINE run with mock-jev (never canonical evidence)",
    "  --allow-unsafe-model       explicit non-canonical model override (recorded honestly)",
    "  --replication-session      mark this run as ONE CLEAN Phase 5I.1 replication session",
    "  --replication <id>         explicit replication id (REQUIRED for replication-add/replay/stats)",
    "  --development <id>         explicit development experiment id (REQUIRED for replication-create)",
    `  --replication-out <dir>    replication tree (default ${DIRECTION_REPLICATION_ROOT_DIR})`,
    "  --definition               print the frozen definition (market, horizon, digests, omitted feature families)",
    "  --json                     machine-readable output",
    "  --help                     this help",
    "",
    `There is NO "latest": every action except --start needs an EXPLICIT experiment or replication id.`,
    `There is NO confidence threshold: every valid probability is retained (target is P(HIGHER), kept raw).`,
    "FORBIDDEN here (hard error): thresholds, trading, wallets, signing, swaps, Arena, DeepSeek, routing, PnL.",
  ].join("\n");
}

function fail(message, code = 2) {
  console.error(`[jev:direction] ${message}`);
  process.exitCode = code;
}

/* ============================================================================
 * Phase 5I.1 replication commands
 *
 * Four explicit, ID-ONLY operations. NONE of them ever launches a session: the
 * operator runs each 120-observation session manually, reviews its integrity,
 * and only then adds it to the manifest (§18). `--replication-replay` and
 * `--replication-stats` are strictly offline: zero network, zero provider, no
 * credentials.
 * ==========================================================================*/

function replicationContext(args) {
  const baseRoot = args.out !== undefined && String(args.out).trim() !== "" ? String(args.out).trim() : null;
  const replicationRoot =
    args["replication-out"] !== undefined && String(args["replication-out"]).trim() !== ""
      ? String(args["replication-out"]).trim()
      : null;
  const replicationId = args.replication !== undefined ? String(args.replication).trim() : null;
  return { baseRoot, replicationRoot, replicationId };
}

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function printReplicationSessionLine(session) {
  const jev = session.metrics?.jev ?? {};
  console.log(
    `[jev:direction]   ${session.sessionId}  ${String(session.status).padEnd(12)} ` +
      `Brier ${fmt(jev.brier)} · log loss ${fmt(jev.logLoss)} · accuracy ${fmt(jev.accuracy)} ` +
      `(N=${jev.brierSampleCount ?? 0})`,
  );
  console.log(
    `[jev:direction]     window ${session.timing?.earliestObservationAt ?? "n/a"} -> ${session.timing?.latestObservationAt ?? "n/a"} · ` +
      `overlap ${session.timing?.temporalOverlap === true} · protocol ${session.protocolOk === true ? "matches" : "MISMATCH"} · ` +
      `metrics ${String(session.metricsDigest ?? "none").slice(0, 12)}…`,
  );
  for (const reason of session.reasons ?? []) console.log(`[jev:direction]     reason: ${reason}`);
}

function printReplicationAggregate(summary) {
  console.log(
    `[jev:direction]   status            ${summary.status} · clean sessions ${summary.cleanSessionCount}/${summary.requiredCleanSessions} ` +
      `(total ${summary.totalSessionCount})`,
  );
  console.log(
    `[jev:direction]   inference unit    ${summary.primaryInferenceUnit} · equal-weighted by eligible session ` +
      `${summary.equalWeightedByEligibleSession === true} · observation-level pseudo-replication ${summary.noObservationLevelPseudoReplication !== true}`,
  );
  for (const [comparisonId, block] of Object.entries(summary.comparisons ?? {})) {
    const brier = block.brier ?? {};
    const logLoss = block.logLoss ?? {};
    const accuracy = block.accuracy ?? {};
    console.log(
      `[jev:direction]   Jev - ${comparisonId.padEnd(26)} ` +
        `Brier mean ${fmt(brier.mean)} (n=${brier.sessionCount ?? 0}, better ${brier.jevBetterCount ?? "n/a"}/${brier.baselineBetterCount ?? "n/a"} worse) · ` +
        `log loss mean ${fmt(logLoss.mean)} (better ${logLoss.jevBetterCount ?? "n/a"}) · ` +
        `accuracy mean ${fmt(accuracy.mean)}`,
    );
  }
  console.log(
    `[jev:direction]   Jev absolute      Brier mean ${fmt(summary.absolute?.brier?.mean)} · log loss mean ${fmt(summary.absolute?.logLoss?.mean)} · ` +
      `accuracy mean ${fmt(summary.absolute?.accuracy?.mean)}`,
  );
  const bootstrap = summary.bootstrap ?? {};
  // The state label is an explicit FROZEN constant, never an undefined field:
  // `DESCRIPTIVE_SESSION_BOOTSTRAP` once >=3 CLEAN sessions exist, otherwise
  // `INSUFFICIENT_CLEAN_REPLICATION_SESSIONS`. Descriptive only — the intervals
  // printed below it are session-resampled and carry no p-value, no significance
  // claim, no winner and no profitability inference.
  const bootstrapState =
    summary.bootstrapState ??
    (bootstrap.available === true ? REPLICATION_BOOTSTRAP_STATE : REPLICATION_INSUFFICIENT_STATE);
  console.log(
    `[jev:direction]   uncertainty       ${bootstrapState} ` +
      `(seed ${bootstrap.seed}, resamples ${bootstrap.resamples}, p-value ${bootstrap.pValueEmitted === true ? "PRESENT" : "none"})`,
  );
  if (bootstrap.available === true) {
    for (const [key, interval] of Object.entries(bootstrap.comparisons ?? {})) {
      console.log(`[jev:direction]     ${key.padEnd(34)} mean ${fmt(interval.pointEstimate)} · interval [${fmt(interval.lower)}, ${fmt(interval.upper)}] (descriptive only)`);
    }
  }
  console.log("[jev:direction]   NO winner is emitted; no significance is claimed. Negative Brier/log-loss delta = Jev lower (better).");
}

async function runReplicationAction(action, args) {
  const { baseRoot, replicationRoot, replicationId } = replicationContext(args);
  const json = args.json === true;

  if (action === "replication-create") {
    const developmentId =
      args.development !== undefined && String(args.development).trim() !== "" ? String(args.development).trim() : null;
    const result = await replicationCreate({ replicationRoot, baseRoot, developmentExperimentId: developmentId });
    if (!result.ok) {
      fail(result.error ?? "replication-create failed", 1);
      return;
    }
    if (json) {
      console.log(JSON.stringify({ ...result, summary: undefined }, null, 2));
      return;
    }
    console.log(`EVOLVE Phase 5I.1 replication created — ${result.replicationId}`);
    console.log(`[jev:direction]   artifacts         ${result.root}`);
    console.log(`[jev:direction]   development       ${result.developmentExperimentId} (metricsDigest ${String(result.developmentMetricsDigest ?? CANONICAL_DEVELOPMENT_BARRIER.metricsDigest).slice(0, 12)}…)`);
    console.log(`[jev:direction]   barrier digest    ${result.developmentBarrierDigest ?? "n/a"}`);
    console.log(`[jev:direction]   protocol digest   ${result.replicationProtocolDigest}`);
    console.log(`[jev:direction]   development tree  ${result.developmentArtifactsPresent ? "verified READ ONLY" : "absent here — the source-pinned barrier was used"}`);
    console.log(`[jev:direction]   sessions          0 added · status ${result.status} · needs ${result.requiredCleanSessions} CLEAN sessions`);
    console.log("[jev:direction]   NOTHING was launched: run each session manually with --start --replication-session, then --replication-add.");
    return;
  }

  if (!replicationId) {
    fail(`--${action} requires an explicit --replication <id>; there is NO "latest"`);
    return;
  }
  if (replicationId.toLowerCase() === "latest" || replicationId.toLowerCase() === "all") {
    fail(`--replication ${replicationId} is refused: Phase 5I.1 never guesses which replication you meant`);
    return;
  }

  if (action === "replication-add") {
    const sessionId = args.experiment !== undefined ? String(args.experiment).trim() : null;
    const result = await replicationAdd({ replicationId, sessionId, replicationRoot, baseRoot });
    if (!result.ok) {
      fail(result.error ?? "replication-add failed", 1);
      return;
    }
    if (json) {
      console.log(JSON.stringify({ ...result, summary: undefined }, null, 2));
      return;
    }
    console.log(`EVOLVE Phase 5I.1 replication ${replicationId} — added ${result.sessionId}`);
    console.log(`[jev:direction]   session status    ${result.sessionStatus} (eligible ${result.sessionEligible})`);
    console.log(`[jev:direction]   network           ${result.networkCalls} · jev calls ${result.jevCalls} · launched sessions ${result.launchedSessions}`);
    console.log(`[jev:direction]   protocol digest   ${result.protocolDigest} (${result.protocolOk ? "matches" : "MISMATCH — ineligible"})`);
    console.log(`[jev:direction]   clean sessions    ${result.cleanSessionCount}/${REQUIRED_CLEAN_REPLICATION_SESSIONS} · status ${result.status}`);
    for (const reason of result.sessionReasons ?? []) console.error(`[jev:direction]   reason            ${reason}`);
    return;
  }

  if (action === "replication-replay") {
    const report = await replicationReplay({ replicationId, replicationRoot, baseRoot });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`EVOLVE Phase 5I.1 offline replication replay — ${replicationId}`);
      console.log(`[jev:direction]   integrity         ${report.ok ? "OK" : "FAIL"}`);
      console.log(`[jev:direction]   read only         yes · network ${report.networkCalls} · jev ${report.jevCalls} · arena ${report.arenaRuns} · trading ${report.tradingCalls} · launched sessions ${report.launchedSessions}`);
      console.log(`[jev:direction]   evidence class    ${report.evidenceClass ?? "n/a"}`);
      console.log(`[jev:direction]   development       ${report.developmentExperimentId ?? "n/a"} (metricsDigest ${String(report.developmentMetricsDigest ?? "n/a").slice(0, 12)}…)`);
      console.log(`[jev:direction]   protocol digest   ${report.replicationProtocolDigest ?? "n/a"}`);
      console.log(`[jev:direction]   counts            ${JSON.stringify(report.counts ?? {})}`);
      console.log(`[jev:direction]   manifest digest   ${report.manifestDigestMatches ? "reproduced" : "MISMATCH"} · session records ${report.sessionsDigestMatches ? "reproduced" : "MISMATCH"}`);
      console.log(`[jev:direction]   aggregation       ${report.metricsMatch ? "reproduced" : "MISMATCH"}`);
      for (const problem of report.problems ?? []) console.error(`[jev:direction]   problem           ${problem}`);
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const stats = await replicationStats({ replicationId, replicationRoot, baseRoot });
  if (!stats.ok) {
    fail(stats.error ?? "replication-stats failed", 1);
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ...stats, storedSummary: undefined }, null, 2));
    return;
  }
  console.log(`EVOLVE Phase 5I.1 replication stats — ${replicationId} (READ ONLY, REPLICATION EVIDENCE — no profitability claim)`);
  console.log(`[jev:direction]   evidence class    ${stats.manifest.evidenceClass}`);
  console.log(`[jev:direction]   protocol digest   ${stats.manifest.replicationProtocolDigest}`);
  console.log(`[jev:direction]   development       ${stats.manifest.developmentExperimentId} (metricsDigest ${String(stats.manifest.developmentMetricsDigest).slice(0, 12)}…)`);
  console.log(`[jev:direction]   aggregation       ${stats.metricsMatch ? "reproduces the stored summary" : "DOES NOT reproduce the stored summary"}`);
  for (const session of stats.sessions ?? []) printReplicationSessionLine(session);
  printReplicationAggregate(stats.summary);
  console.log("[jev:direction]   evidence class    CLEAN_JEV_DIRECTION_REPLICATION_EVIDENCE — replicationOnly, paper/shadow, no profitability/trading/deployment inference");
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
  console.log(`[jev:direction]   evidence classes: ${DIRECTION_EVIDENCE_CLASSES.join(", ")}`);
  console.log(`[jev:direction]   research tree:    ${DIRECTION_ROOT_DIR}/experiments/<experiment-id>/`);
  console.log(`[jev:direction]   replication tree: ${DIRECTION_REPLICATION_ROOT_DIR}/<replication-id>/ (Phase 5I.1)`);
  console.log(`[jev:direction]   protocol digest:  ${REPLICATION_PROTOCOL_DIGEST} (frozen replication contract)`);
  console.log(
    `[jev:direction]   replication:      ${REQUIRED_CLEAN_REPLICATION_SESSIONS} independent sessions x ` +
      `${REPLICATION_SESSION_OBSERVATIONS} observations; primary inference unit ${REPLICATION_INFERENCE_UNIT}`,
  );
  console.log(
    `[jev:direction]   development:      ${CANONICAL_DEVELOPMENT_BARRIER.experimentId} ` +
      `(metricsDigest ${CANONICAL_DEVELOPMENT_BARRIER.metricsDigest.slice(0, 12)}…) — DEVELOPMENT evidence only`,
  );
  console.log("[jev:direction]   omitted families: orderBookImbalance, queueDepth, cvd, makerFlow, quoteSpread, routePriceImpact (not observable in EVOLVE's schema)");
}

function printMetricsBlock(metrics) {
  if (!metrics) return;
  const fmt = (value, digits = 4) => (Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a");
  // Denominators are printed on EVERY score so a tiny sample can never look more
  // meaningful than it is: a Brier of 0.1764 is shown as "(N=1)".
  const n = (block) => block?.brierSampleCount ?? block?.sampleCount ?? 0;
  const allValid = metrics.allValidPredictionStats ?? metrics.probabilityStats?.allValidPredictions ?? null;
  const scoredStats = metrics.scoredPredictionStats ?? metrics.probabilityStats?.scoredBinary ?? null;
  console.log(`[jev:direction]   observations      ${metrics.observationCount} (valid ${metrics.validPredictionCount} · invalid ${metrics.invalidPredictionCount})`);
  console.log(`[jev:direction]   scored            ${metrics.scoredCount} binary · HIGHER ${metrics.higherCount} · LOWER ${metrics.lowerCount} · TIE ${metrics.tieCount} (ties excluded from binary scoring)`);
  console.log(
    `[jev:direction]   Jev Brier         ${fmt(metrics.jev?.brierScore)} (N=${n(metrics.jev)}) · log loss ${fmt(metrics.jev?.logLoss)} ` +
      `(N=${metrics.jev?.logLossSampleCount ?? metrics.jev?.sampleCount ?? 0}) · accuracy ${fmt(metrics.jev?.accuracy)} ` +
      `(N=${metrics.jev?.accuracySampleCount ?? metrics.jev?.sampleCount ?? 0})`,
  );
  console.log(
    `[jev:direction]   all-valid pHigher  mean ${fmt(allValid?.meanPHigher)} · median ${fmt(allValid?.medianPHigher)} (N=${allValid?.count ?? 0})`,
  );
  console.log(
    `[jev:direction]   scored pHigher     mean ${fmt(scoredStats?.meanPHigher)} · median ${fmt(scoredStats?.medianPHigher)} (N=${scoredStats?.count ?? 0})`,
  );
  for (const [baselineId, delta] of Object.entries(metrics.brierDeltas ?? {})) {
    const baselineN = n(metrics.baselines?.[baselineId]);
    console.log(
      `[jev:direction]   Δ vs ${baselineId.padEnd(26)} Brier ${fmt(delta.jevMinusBaselineBrier)} (N=${baselineN}) · log loss ${fmt(delta.jevMinusBaselineLogLoss)} · accuracy ${fmt(delta.jevMinusBaselineAccuracy)}`,
    );
  }
  // v2 timing diagnostics use count/mean/median/p90/p95/max; the legacy v1
  // `resolutionLag` block only has count/min/mean/max — read both shapes.
  const stat = (block, key) => block?.[key] ?? block?.[`${key}Ms`] ?? null;
  const offsetStats = metrics.outcomeOffsetStats ?? metrics.resolutionLag ?? null;
  const horizonStats = metrics.achievedHorizonStats ?? null;
  const statLine = (label, block) =>
    `[jev:direction]   ${label} mean ${fmt(stat(block, "mean"), 0)}ms · median ${fmt(stat(block, "median"), 0)}ms · ` +
    `p90 ${fmt(stat(block, "p90"), 0)}ms · p95 ${fmt(stat(block, "p95"), 0)}ms · max ${fmt(stat(block, "max"), 0)}ms (N=${block?.count ?? 0})`;
  if (offsetStats) console.log(statLine("outcome offset   ", offsetStats));
  if (horizonStats) console.log(statLine("achieved horizon ", horizonStats));
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
    console.error(`[jev:direction] actions: ${DIRECTION_ALL_ACTIONS.map((name) => `--${name}`).join(" | ")}`);
    return;
  }

  // ---- Phase 5I.1 replication commands are dispatched FIRST ----------------
  // None of them needs a provider, a credential, or a market: `--replication-add`
  // replays an already-completed session OFFLINE, and `--replication-replay` /
  // `--replication-stats` only ever read persisted artifacts. Dispatching here
  // means a replication command can NEVER construct a market config or a model
  // provider, even by accident.
  if (isReplicationAction(action)) {
    await runReplicationAction(action, args);
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
        console.log(
          `[jev:direction]   resolution policy v${report.outcomeResolutionPolicyVersion ?? "?"} ` +
            `(maximumOffsetMs=${report.maximumOffsetMs ?? "?"}) · metric definition v${report.metricDefinitionVersion ?? "?"}`,
        );
        console.log(
          `[jev:direction]   scored            ${report.counts?.scoredCount ?? 0} binary · outcome-window exclusions ${report.counts?.outcomeWindowExclusions ?? 0}`,
        );
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
    const statsClass = stats.experiment?.evidenceClass ?? DIRECTION_EVIDENCE_CLASS;
    const statsProfile = statsClass === REPLICATION_EVIDENCE_CLASS ? REPLICATION_EVIDENCE_PROFILE : DEVELOPMENT_EVIDENCE_PROFILE;
    console.log(`EVOLVE Phase ${DIRECTION_PHASE} prediction-quality stats — ${experimentId} (READ ONLY, ${statsProfile.evidenceScope} EVIDENCE)`);
    console.log(`[jev:direction]   metrics digest    ${stats.metricsDigest}${stats.metricsMatch === null ? " (no summary stored yet)" : stats.metricsMatch ? " (matches stored summary)" : " (does NOT match stored summary)"}`);
    printMetricsBlock(stats.metrics);
    console.log(
      `[jev:direction]   evidence class    ${statsClass} — ${statsProfile.id === "replication" ? "replicationOnly, one session of the frozen protocol, not a wave result" : "developmentOnly, not replication"}, not profitability`,
    );
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
      // The evidence class is chosen HERE and recorded on every artifact of the
      // run. It changes NO predictive semantics: the frozen protocol digest is
      // identical for both classes and is verified fail-closed either way.
      evidenceProfile: settings.evidenceProfileId,
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
            evidenceClass: result.evidenceClass ?? result.experiment?.evidenceClass ?? DIRECTION_EVIDENCE_CLASS,
            developmentOnly: (result.experiment?.developmentOnly ?? true) === true,
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
    console.log(
      `[jev:direction]   NOTE              ${result.experiment.evidenceClass ?? DIRECTION_EVIDENCE_CLASS} — ` +
        "not a strategy, no orders were produced, and no profitability/trading/deployment inference is permitted.",
    );
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
