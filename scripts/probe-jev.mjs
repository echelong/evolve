#!/usr/bin/env node
/**
 * EVOLVE Jev provider probe (Phase 5D).
 *
 *   npm run probe:jev -- --provider mock-jev
 *   npm run probe:jev -- --provider typesafe-jev
 *   npm run probe:jev -- --provider typesafe-jev --save
 *
 * ONE bounded call against SYNTHETIC, non-market state — never a real
 * candidate, never real market data. Verifies, cheaply and explicitly:
 *
 *   - the provider name is registered (fail-closed otherwise)
 *   - a structured response can be obtained
 *   - the answer normalizer and typed-answer validator both accept it
 *   - confidence/probability values are actually present
 *
 * It performs NO Arena work, touches no dataset, no replication artifact, no
 * champion, and no research memory. It writes nothing unless `--save` is
 * explicitly supplied, and even then only its own probe record under
 * `.evolve/jev/probes/`.
 *
 * PAPER ONLY.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { loadEnvFiles } from "./lib/env.mjs";
import {
  JEV_PROVIDER,
  REGISTERED_JEV_PROVIDERS,
  UnknownJevProviderError,
  requireJevProviderName,
  resolveJevConfig,
} from "./jev/config.mjs";
import { resolveJevProvider } from "./jev/provider.mjs";
import { buildCandidateDecisionPacket, JEV_DECISION_PACKET_VERSION } from "./jev/decision-packet.mjs";
import {
  JEV_CANDIDATE_QUESTION_SET_ID,
  JEV_CANDIDATE_QUESTION_SET_VERSION,
  buildCandidateQuestions,
} from "./jev/questions.mjs";
import { jevDecide } from "./jev/decide.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";

loadEnvFiles();

const BOOLEAN_FLAGS = ["json", "help", "save"];
const VALUE_FLAGS = ["provider", "timeout-ms", "model"];

function usage() {
  return [
    "EVOLVE Jev provider probe (PAPER ONLY, SHADOW ONLY)",
    "",
    "  npm run probe:jev -- [options]",
    "",
    "Options:",
    `  --provider <name>   ${REGISTERED_JEV_PROVIDERS.join(" | ")} (default: env, else disabled)`,
    "  --timeout-ms <n>    wall-clock bound for the probe call",
    "  --model <id>        model override (default: the pinned Jev model)",
    "  --save              write the probe artifact under .evolve/jev/probes/ (nothing else is touched)",
    "  --json              print the machine-readable probe result",
    "",
    "Uses SYNTHETIC, non-market state only — never a real candidate or real market data.",
    "Provider selection is FAIL-CLOSED: an explicit unregistered provider name is a",
    "configuration error (exit code 2) and nothing is probed.",
  ].join("\n");
}

/** Bounded, synthetic (never real) candidate packet for the probe. */
function syntheticPacket() {
  return buildCandidateDecisionPacket({
    experimentId: null,
    candidateDigest: "synthetic-probe-candidate",
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
    researchLifecycleState: "PROBE_SYNTHETIC",
    createdAt: new Date(0).toISOString(),
    generatedBy: { probe: true },
  });
}

function describeAnswers(answers) {
  const out = {};
  for (const [name, answer] of Object.entries(answers ?? {})) {
    out[name] = {
      type: answer?.type ?? null,
      hasProbabilityOrScore:
        answer?.type === "noul"
          ? Number.isFinite(answer.probability)
          : answer?.type === "score"
            ? Number.isFinite(answer.score)
            : answer?.type === "choice"
              ? Number.isFinite(answer.confidence)
              : false,
      hasConfidence: answer?.type !== "noul" ? Number.isFinite(answer?.confidence) : null,
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const envConfig = resolveJevConfig();
  const requestedName = args.provider !== undefined ? String(args.provider) : envConfig.requestedProvider;

  let resolution;
  try {
    resolution = requireJevProviderName(requestedName);
  } catch (error) {
    console.error(`[probe:jev] ${error.message}`);
    console.error(`[probe:jev] registered providers: ${REGISTERED_JEV_PROVIDERS.join(", ")}`);
    console.error("[probe:jev] there is no provider fallback: fix the name, or leave EVOLVE_JEV_PROVIDER unset (disabled).");
    console.error("[probe:jev] no provider was called and no probe artifact was written.");
    process.exitCode = 2;
    return;
  }

  if (resolution.provider === null) {
    console.error("[probe:jev] Jev is disabled (EVOLVE_JEV_PROVIDER is not set / no --provider given).");
    console.error(`[probe:jev] pass --provider mock-jev or --provider ${JEV_PROVIDER.TYPESAFE} to probe a provider.`);
    process.exitCode = 2;
    return;
  }

  const model = args.model ? String(args.model) : envConfig.model;
  const timeoutMs = args["timeout-ms"] ? Number.parseInt(String(args["timeout-ms"]), 10) : envConfig.timeoutMs;

  const provider = resolveJevProvider(resolution.provider, {
    apiKey: envConfig.apiKey,
    model,
    baseURL: envConfig.baseURL,
    timeoutMs,
  });

  const packet = syntheticPacket();
  const questions = buildCandidateQuestions();
  const budget = createJevRunBudget(1);

  const { run, decision } = await jevDecide({
    provider,
    packet,
    questions,
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    experimentId: null,
    root: null, // a probe leaves no trace unless --save is given (handled below)
    cacheEnabled: false,
    budget,
  });

  const result = {
    schemaVersion: 1,
    probe: "jev-provider",
    provider: resolution.provider,
    model: run.model ?? model,
    status: run.status,
    reason: run.reason,
    latencyMs: run.latencyMs,
    requestId: run.requestId,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    stateDigest: run.stateDigest,
    questionTypes: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type])),
    typedAnswerValid: decision !== "NO_JEV_DECISION",
    answers: decision === "NO_JEV_DECISION" ? null : describeAnswers(decision),
    checkedAt: new Date().toISOString(),
    paperOnly: true,
    shadowOnly: true,
    note: "Synthetic probe only. No Arena, dataset, replication, champion, or research-memory artifact was touched.",
  };

  if (args.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("EVOLVE Jev provider probe (PAPER ONLY, SHADOW ONLY)");
    console.log(`  provider              ${result.provider}`);
    console.log(`  model                 ${result.model}`);
    console.log(`  status                ${result.status}`);
    console.log(`  latency               ${Number.isFinite(result.latencyMs) ? `${result.latencyMs}ms` : "n/a"}`);
    console.log(`  typed answer valid    ${result.typedAnswerValid ? "yes" : "no"}`);
    console.log(`  decision packet ver.  ${result.decisionPacketVersion}`);
    console.log(`  question set          ${result.questionSetId} v${result.questionSetVersion}`);
    if (result.reason) console.log(`  reason                ${result.reason}`);
    console.log("  note                  no secrets are printed; no Arena/dataset/champion state was touched");
  }

  if (args.save === true) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(".evolve", "jev", "probes");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${result.provider}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(result, null, 2), "utf8");
    console.log(`  artifact              ${file}`);
  }

  process.exitCode = result.status === "JEV_OK" ? 0 : 3;
}

main().catch((error) => {
  if (error instanceof UnknownJevProviderError) {
    console.error(`[probe:jev] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error("[probe:jev] Jev provider probe failed:", error?.message ?? error);
  process.exitCode = 1;
});
