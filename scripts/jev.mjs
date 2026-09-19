#!/usr/bin/env node
/**
 * EVOLVE Jev shadow-decision CLI (Phase 5D).
 *
 *   npm run jev -- --provider mock-jev --fixture synthetic
 *   npm run jev -- --provider mock-jev --fixture synthetic --market --save
 *   npm run jev -- --stats --experiment <id>
 *
 * This CLI is a SHADOW-ONLY tool: it asks Jev the fixed question set about a
 * bounded decision packet and records the answer. It never trades, never
 * routes a candidate, and never changes Arena/genome/evolution behaviour.
 *
 * `--fixture synthetic` is the only supported fixture in Phase 5D — a small,
 * explicit, non-real candidate (or market window, with `--market`), so this
 * CLI can be exercised end to end without ever touching a real dataset, a real
 * Arena run, or Wave 2 replication data.
 *
 * PAPER ONLY.
 */

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import {
  REGISTERED_JEV_PROVIDERS,
  UnknownJevProviderError,
  requireJevProviderName,
  resolveJevConfig,
  resolveJevModelName,
} from "./jev/config.mjs";
import { resolveJevProvider } from "./jev/provider.mjs";
import {
  buildCandidateDecisionPacket,
  buildMarketDecisionPacket,
  JEV_DECISION_PACKET_VERSION,
} from "./jev/decision-packet.mjs";
import {
  JEV_CANDIDATE_QUESTION_SET_ID,
  JEV_CANDIDATE_QUESTION_SET_VERSION,
  JEV_MARKET_QUESTION_SET_ID,
  JEV_MARKET_QUESTION_SET_VERSION,
  buildCandidateQuestions,
  buildMarketQuestions,
} from "./jev/questions.mjs";
import { jevDecide } from "./jev/decide.mjs";
import { createJevRunBudget, jevStateSummary, listJevProviderRuns } from "./jev/runtime.mjs";
import {
  createJevExperiment,
  jevDecisionIdFor,
  jevExperimentIdFor,
  jevExperimentRootFor,
  buildJevDecisionRecord,
  readJevCalibration,
  readJevExperiment,
  writeJevDecision,
  writeJevExperiment,
} from "./jev/experiment.mjs";

loadEnvFiles();

const BOOLEAN_FLAGS = ["json", "help", "save", "market", "stats"];
const VALUE_FLAGS = ["provider", "fixture", "experiment", "model", "timeout-ms"];

const SUPPORTED_FIXTURES = Object.freeze(["synthetic"]);

function usage() {
  return [
    "EVOLVE Jev shadow-decision CLI (PAPER ONLY, SHADOW ONLY)",
    "",
    "  npm run jev -- --provider <name> --fixture synthetic [--market] [--save]",
    "  npm run jev -- --stats --experiment <id>",
    "",
    "Options:",
    `  --provider <name>   ${REGISTERED_JEV_PROVIDERS.join(" | ")} (default: env, else disabled)`,
    `  --fixture <name>    ${SUPPORTED_FIXTURES.join(" | ")} (the only supported fixture in Phase 5D)`,
    "  --market            ask the jev-market-v1 regime question instead of the candidate set",
    "  --experiment <id>   persist under this experiment id (created if it does not exist)",
    "  --save              persist the decision even without an explicit --experiment (a new id is generated)",
    "  --stats             print experiment counters/health instead of asking a question",
    "  --json              print machine-readable output",
    "",
    "Jev is SHADOW ONLY: this CLI never trades, never routes a candidate, and never",
    "changes Arena/genome/evolution behaviour.",
  ].join("\n");
}

function syntheticCandidatePacket() {
  return buildCandidateDecisionPacket({
    candidateDigest: "synthetic-fixture-candidate",
    species: "Momentum",
    family: "Momentum x Wallet Flow",
    genomeParams: { momentumWeight: 0.42, maxHold: 48, riskFraction: 0.06 },
    train: {
      paperReturn: 0.01,
      observationCount: 500,
      tradeCount: 30,
      mintDiversity: 6,
      concentration: 0.35,
      costDrag: 0.01,
      drawdown: 0.12,
      regimeDistribution: { "strong-risk-on": 12, "sideways-chop": 8 },
    },
    watchdog: { verdict: "NORMAL", findings: [] },
    researchLifecycleState: "FIXTURE_SYNTHETIC",
    createdAt: new Date(0).toISOString(),
    generatedBy: { fixture: "synthetic" },
  });
}

function syntheticMarketPacket() {
  return {
    packet: buildMarketDecisionPacket({
      windowLabel: "synthetic-fixture-window",
      marketFeatures: { meanReturn: 0.025, dispersion: 0.12, launchHeavyRatio: 0.1, liquidityChange: 0.03 },
    }),
    deterministicRegime: "strong-risk-on",
  };
}

async function printStats(experimentId) {
  if (!experimentId) {
    console.error("[jev] --stats requires --experiment <id>");
    process.exitCode = 2;
    return;
  }
  const root = jevExperimentRootFor(undefined, experimentId);
  const experiment = await readJevExperiment(root);
  if (!experiment) {
    console.error(`[jev] no experiment found at ${root}`);
    process.exitCode = 2;
    return;
  }
  const runs = await listJevProviderRuns(root);
  const calibration = await readJevCalibration(root);
  const summary = jevStateSummary({
    identity: { provider: experiment.provider, model: experiment.model },
    mode: experiment.mode,
    experimentId,
    cacheEnabled: experiment.cacheEnabled,
    runs,
    calibration,
  });
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  if (args.stats === true) {
    await printStats(args.experiment ? String(args.experiment) : null);
    return;
  }

  const envConfig = resolveJevConfig();
  const requestedName = args.provider !== undefined ? String(args.provider) : envConfig.requestedProvider;

  let resolution;
  try {
    resolution = requireJevProviderName(requestedName);
  } catch (error) {
    console.error(`[jev] ${error.message}`);
    console.error(`[jev] registered providers: ${REGISTERED_JEV_PROVIDERS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (resolution.provider === null) {
    console.error("[jev] Jev is disabled (EVOLVE_JEV_PROVIDER is not set / no --provider given). Nothing to do.");
    process.exitCode = 2;
    return;
  }

  const fixture = args.fixture ? String(args.fixture) : null;
  if (!fixture || !SUPPORTED_FIXTURES.includes(fixture)) {
    console.error(`[jev] --fixture must be one of: ${SUPPORTED_FIXTURES.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  // Each provider has its OWN canonical model default (the direct route pins
  // `jev-1.13.0`; the Vercel AI Gateway route uses `typesafe-ai/jev`). An
  // explicit --model always wins.
  const model = resolveJevModelName(envConfig, {
    provider: resolution.provider,
    override: args.model !== undefined ? String(args.model) : null,
  });
  const timeoutMs = args["timeout-ms"] ? Number.parseInt(String(args["timeout-ms"]), 10) : envConfig.timeoutMs;
  const provider = resolveJevProvider(resolution.provider, {
    apiKey: envConfig.apiKey,
    gatewayApiKey: envConfig.gatewayApiKey,
    model,
    baseURL: envConfig.baseURL,
    timeoutMs,
  });

  const isMarket = args.market === true;
  const questionSetId = isMarket ? JEV_MARKET_QUESTION_SET_ID : JEV_CANDIDATE_QUESTION_SET_ID;
  const questionSetVersion = isMarket ? JEV_MARKET_QUESTION_SET_VERSION : JEV_CANDIDATE_QUESTION_SET_VERSION;
  const questions = isMarket ? buildMarketQuestions() : buildCandidateQuestions();

  let packet;
  let deterministicComparators = {};
  let subjectDigest;
  if (isMarket) {
    const built = syntheticMarketPacket();
    packet = built.packet;
    deterministicComparators = { deterministicRegime: built.deterministicRegime };
    subjectDigest = packet.windowLabel;
  } else {
    packet = syntheticCandidatePacket();
    subjectDigest = packet.candidate.candidateDigest;
  }

  const shouldPersist = args.save === true || args.experiment !== undefined;
  let experimentId = args.experiment ? String(args.experiment) : null;
  let root = null;

  if (shouldPersist) {
    if (!experimentId) experimentId = jevExperimentIdFor({ provider: resolution.provider, startedAt: Date.now() });
    root = jevExperimentRootFor(undefined, experimentId);
    const existing = await readJevExperiment(root);
    if (!existing) {
      await writeJevExperiment(
        root,
        createJevExperiment({
          experimentId,
          provider: resolution.provider,
          model: provider.model ?? model,
          decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
          questionSetId,
          questionSetVersion,
          cacheEnabled: envConfig.cacheEnabled,
          maxCallsPerRun: envConfig.maxCallsPerRun,
        }),
      );
    }
  }

  const budget = createJevRunBudget(envConfig.maxCallsPerRun);
  const { run, decision } = await jevDecide({
    provider,
    packet,
    questions,
    questionSetId,
    questionSetVersion,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    experimentId,
    root,
    cacheEnabled: envConfig.cacheEnabled,
    budget,
  });

  if (root) {
    const decisionId = jevDecisionIdFor({ experimentId, packetKind: packet.packetKind, subjectDigest, questionSetId });
    await writeJevDecision(
      root,
      buildJevDecisionRecord({
        decisionId,
        experimentId,
        packetKind: packet.packetKind,
        subjectDigest,
        questionSetId,
        questionSetVersion,
        decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
        stateDigest: run.stateDigest,
        jevRunId: run.jevRunId,
        provider: run.provider,
        model: run.model,
        status: run.status,
        answers: decision === "NO_JEV_DECISION" ? null : decision,
        syntheticDecision: run.syntheticDecision === true,
        deterministicComparators,
        predictedAt: run.completedAt,
      }),
    );
  }

  const output = {
    experimentId,
    questionSetId,
    questionSetVersion,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    status: run.status,
    reason: run.reason,
    latencyMs: run.latencyMs,
    decision: decision === "NO_JEV_DECISION" ? "NO_JEV_DECISION" : decision,
    persisted: root !== null,
  };

  if (args.json === true) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("EVOLVE Jev shadow decision (PAPER ONLY, SHADOW ONLY)");
    console.log(`  provider     ${resolution.provider}`);
    console.log(`  question set ${questionSetId} v${questionSetVersion}`);
    console.log(`  status       ${run.status}`);
    console.log(`  latency      ${Number.isFinite(run.latencyMs) ? `${run.latencyMs}ms` : "n/a"}`);
    console.log(`  persisted    ${root ? `yes (${experimentId})` : "no"}`);
    console.log(`  decision     ${JSON.stringify(output.decision)}`);
  }

  process.exitCode = run.status === "JEV_OK" ? 0 : 3;
}

main().catch((error) => {
  if (error instanceof UnknownJevProviderError) {
    console.error(`[jev] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error("[jev] Jev CLI failed:", error?.message ?? error);
  process.exitCode = 1;
});
