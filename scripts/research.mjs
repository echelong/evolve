#!/usr/bin/env node
/**
 * EVOLVE research-cohort CLI (Phase 5B).
 *
 *   npm run research -- --provider deepseek-cline --cycles 1 --dataset <dir>
 *   npm run research -- --stats --experiment <experiment-id>
 *   npm run research -- --list-experiments
 *
 * Generates a FRESH research cohort through the selected provider, storing it in
 * an isolated experiment root under
 * `.evolve/research/experiments/<experiment-id>/`. The provider proposes; the
 * deterministic compiler + uniqueness guard + watchdog dispose; nothing here
 * touches the Arena, champions, wallets, or the canonical mock cohort.
 *
 * A run is always bounded: `--max-calls` caps provider calls for the WHOLE run,
 * so this can never become an uncontrolled LLM loop.
 *
 * PAPER ONLY.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { listDatasets } from "./history/dataset.mjs";
import {
  PROVIDER_DEFAULTS,
  REGISTERED_PROVIDERS,
  UnknownResearchProviderError,
  requireProviderName,
  resolveEffectiveProviderTimeoutMs,
  resolveProviderConfig,
} from "./research/provider-config.mjs";
import { RESEARCH_PROMPT_VERSION, proposingRoles } from "./research/prompt.mjs";
import { generateResearchCohort, inspectResearchCohort } from "./research/cohort-runner.mjs";
import { listResearchExperiments, readResearchExperiment } from "./research/experiment.mjs";
import { listProviderRuns, providerStateSummary } from "./research/provider-runtime.mjs";

const BOOLEAN_FLAGS = ["cache", "no-cache", "stats", "list-experiments", "json", "help"];
const VALUE_FLAGS = [
  "provider",
  "cycles",
  "roles",
  "proposals-per-cycle",
  "max-calls",
  "provider-timeout-ms",
  "experiment",
  "dataset",
  "memory-root",
  "base-root",
  "seed",
  "max-compilations",
];

function usage() {
  return [
    "EVOLVE research cohort generation (PAPER ONLY)",
    "",
    "  npm run research -- [options]",
    "",
    "Options:",
    `  --provider <name>          ${REGISTERED_PROVIDERS.join(" | ")} (default: env EVOLVE_RESEARCH_PROVIDER, else mock)`,
    "  --cycles <n>               bounded number of research cycles (default 1)",
    "  --roles <a,b,..>           researcher roles to call (default: all proposing roles)",
    "  --proposals-per-cycle <n>  provider calls per cycle (default: roles.length)",
    "  --max-calls <n>            hard cap on provider calls for the WHOLE run",
    `  --provider-timeout-ms <n>  wall-clock bound per provider subprocess (default: env, else ${PROVIDER_DEFAULTS.timeoutMs}ms)`,
    "  --experiment <id>          reuse/name the experiment (default: generated)",
    "  --dataset <dir|auto>       recorded dataset for TRAIN evidence (auto = newest recorded)",
    "  --memory-root <dir>        research-memory root read through the filtered view",
    "  --base-root <dir>          base research root (default .evolve/research)",
    "  --seed <text>              deterministic seed for ids/rotations",
    "  --cache | --no-cache       provider-result cache (default: env EVOLVE_RESEARCH_PROVIDER_CACHE)",
    "  --stats                    print proposal/uniqueness/species stats and exit",
    "  --list-experiments         list persisted experiments and exit",
    "  --json                     print the machine-readable report",
    "",
    "The provider proposes hypotheses only. It never trades, never touches a",
    "wallet or key, never changes Arena gates or scores, and never sees",
    "validation/test/out-of-sample evidence.",
    "",
    "Provider selection is FAIL-CLOSED: leaving EVOLVE_RESEARCH_PROVIDER unset",
    "uses the deterministic `mock`; an explicit name must be registered",
    "(`mock` or `deepseek-cline`). Any other explicit name is a configuration",
    "error: the run exits non-zero, calls no provider, creates no experiment,",
    "and is NEVER served by the mock.",
  ].join("\n");
}

async function pickDataset(arg) {
  if (!arg) return null;
  if (arg !== "auto") return path.resolve(arg);
  const datasets = await listDatasets();
  const withFingerprint = datasets.filter((row) => row?.manifest?.fingerprint?.combined);
  const chosen = (withFingerprint.length > 0 ? withFingerprint : datasets).at(-1);
  return chosen?.dir ?? null;
}

async function printStats({ root, experiment, json }) {
  const stats = await inspectResearchCohort(root);
  const runs = await listProviderRuns(path.join(root, "provider"), { limit: 200 });
  const providerState = providerStateSummary({
    identity: {
      provider: experiment?.provider ?? null,
      model: experiment?.model ?? null,
      reasoning: experiment?.reasoning ?? null,
      external: experiment?.provider !== "mock",
    },
    experimentId: experiment?.experimentId ?? null,
    cacheEnabled: experiment?.limits?.cacheEnabled === true,
    runs,
    experiment: experiment?.counters ?? null,
  });
  const report = {
    experimentId: experiment?.experimentId ?? null,
    provider: experiment?.provider ?? null,
    model: experiment?.model ?? null,
    reasoning: experiment?.reasoning ?? null,
    promptVersion: experiment?.promptVersion ?? null,
    status: experiment?.status ?? null,
    counters: experiment?.counters ?? null,
    cohort: stats,
    providerState,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const label = `${report.provider ?? "n/a"}${report.model ? ` / ${report.model}` : ""}${report.reasoning ? ` (${report.reasoning})` : ""}`;
  console.log(`EVOLVE research cohort — ${report.experimentId ?? "unknown experiment"}`);
  console.log(`  provider            ${label}`);
  console.log(`  status              ${report.status ?? "n/a"}   promptVersion ${report.promptVersion ?? "n/a"}`);
  console.log(`  proposals persisted ${stats.proposals}`);
  console.log(
    `  compiled candidates ${stats.compiled}   unique genomes ${stats.uniqueGenomes}   duplicates ${stats.duplicateGenomes}   uniqueness ${(stats.uniquenessRatio * 100).toFixed(1)}%`,
  );
  console.log(`  species             ${JSON.stringify(stats.speciesDistribution)}`);
  console.log(`  families            ${JSON.stringify(stats.familyDistribution)}`);
  console.log(`  roles               ${JSON.stringify(stats.roleDistribution)}`);
  console.log(
    `  provider calls      ${providerState.calls}   failures ${providerState.failures}   cache hits ${providerState.cacheHits}   health ${providerState.health}`,
  );
  console.log(
    `  schema rejects      ${providerState.schemaRejects}   duplicate genomes ${providerState.duplicateGenomes ?? "n/a"}`,
  );
  console.log(`  watchdog            ${JSON.stringify(providerState.watchdog ?? {})}`);
  return report;
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const envConfig = resolveProviderConfig();
  const baseRoot = path.resolve(args["base-root"] ? String(args["base-root"]) : path.join(".evolve", "research"));

  if (args["list-experiments"] === true) {
    const experiments = await listResearchExperiments(baseRoot);
    if (experiments.length === 0) {
      console.log("no research experiments recorded");
      return;
    }
    for (const experiment of experiments) {
      const counters = experiment.counters ?? {};
      console.log(
        `${experiment.experimentId}  provider=${experiment.provider}  status=${experiment.status}  proposals=${counters.schemaValid ?? 0}  providerCalls=${counters.providerCalls ?? 0}  compiled=${counters.compilerAccepted ?? 0}  unique=${counters.uniqueGenomes ?? 0}`,
      );
    }
    return;
  }

  if (args.stats === true) {
    const experimentId = args.experiment ? String(args.experiment) : null;
    const experiments = await listResearchExperiments(baseRoot);
    const chosen = experimentId
      ? experiments.find((row) => row.experimentId === experimentId) ??
        (await readResearchExperiment(path.join(baseRoot, "experiments", experimentId)))
      : experiments.at(-1);
    if (!chosen) {
      console.error("[research] no experiment found to report on");
      process.exitCode = 2;
      return;
    }
    await printStats({
      root: path.join(baseRoot, "experiments", chosen.experimentId),
      experiment: chosen,
      json: args.json === true,
    });
    return;
  }

  // FAIL-CLOSED: resolve the REQUESTED name (flag first, then the environment).
  // An explicit unregistered name throws — the mock provider is never run in its
  // place, and no experiment artifact is created.
  const requestedName = args.provider !== undefined ? String(args.provider) : envConfig.requestedProvider;
  let providerResolution;
  try {
    providerResolution = requireProviderName(requestedName);
  } catch (error) {
    console.error(`[research] ${error.message}`);
    console.error(`[research] registered providers: ${REGISTERED_PROVIDERS.join(", ")}`);
    console.error(
      "[research] there is no provider fallback during an experiment — fix the name, or leave EVOLVE_RESEARCH_PROVIDER unset to use the deterministic mock default.",
    );
    console.error("[research] no experiment was created and no provider was called.");
    process.exitCode = 2;
    return;
  }
  const resolvedProviderName = providerResolution.provider;

  const roles = args.roles
    ? String(args.roles)
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean)
    : proposingRoles();
  const cycles = Math.max(1, Number.parseInt(String(args.cycles ?? 1), 10) || 1);
  const maxCalls = Math.max(
    1,
    Number.parseInt(String(args["max-calls"] ?? envConfig.maxCallsPerRun), 10) || PROVIDER_DEFAULTS.maxCallsPerRun,
  );
  const proposalsPerCycle = Math.max(
    1,
    Number.parseInt(String(args["proposals-per-cycle"] ?? roles.length), 10) || roles.length,
  );
  const requestedProposalTotal = cycles * proposalsPerCycle;
  const datasetDir = await pickDataset(args.dataset ? String(args.dataset) : null);
  const cacheEnabled =
    args.cache === true ? true : args["no-cache"] === true ? false : envConfig.cacheEnabled === true;

  // The ONE resolver shared with the probe CLI and the cohort runner (see
  // `provider-config.mjs`): CLI override → environment → documented default.
  const { timeoutMs: providerTimeoutMs } = resolveEffectiveProviderTimeoutMs({
    cliRaw: args["provider-timeout-ms"],
    envConfig,
    warn: (message) => console.error(message),
  });

  console.log("EVOLVE research cohort generation (PAPER ONLY — no trading, no wallet, no execution)");
  console.log(`  provider            ${resolvedProviderName}${providerResolution.defaulted ? " (default: EVOLVE_RESEARCH_PROVIDER is unset)" : ""}`);
  if (resolvedProviderName !== "mock") {
    console.log(`  model               ${envConfig.model}`);
    console.log(`  reasoning           ${envConfig.reasoning}`);
  }
  console.log(`  prompt version      ${RESEARCH_PROMPT_VERSION}`);
  console.log(`  roles               ${roles.join(", ")}`);
  console.log(`  cycles              ${cycles}`);
  console.log(`  proposals/cycle     ${proposalsPerCycle}`);
  console.log(`  requested total     ${requestedProposalTotal}`);
  console.log(`  max provider calls  ${maxCalls}`);
  console.log(`  provider timeout    ${providerTimeoutMs}ms`);
  console.log(`  retry attempts      ${envConfig.maxAttempts}`);
  console.log(`  cache enabled       ${cacheEnabled ? "true" : "false"}`);
  console.log(`  dataset             ${datasetDir ?? "(none — memory-only evidence)"}`);

  const report = await generateResearchCohort({
    providerName: resolvedProviderName,
    baseRoot,
    cycles,
    roles,
    proposalsPerCycle,
    maxProviderCalls: maxCalls,
    providerTimeoutMs,
    experimentId: args.experiment ? String(args.experiment) : null,
    datasetDir,
    memoryRoot: args["memory-root"] ? path.resolve(String(args["memory-root"])) : baseRoot,
    // Market/dataset config for TRAIN-evidence parsing ONLY — never merged
    // into the provider config (see `cohort-runner.mjs`), so its own
    // `timeoutMs` (the Jupiter quote timeout) can never shadow the provider's.
    config: createMarketConfig(),
    seed: args.seed ? String(args.seed) : "evolve",
    cacheEnabled,
    maxCompilations: args["max-compilations"] ? Number(args["max-compilations"]) : undefined,
  });

  const stats = await printStats({ root: report.experimentRoot, experiment: report.experiment, json: false });

  if (args.json === true) {
    console.log(
      JSON.stringify(
        {
          experimentId: report.experimentId,
          experimentRoot: report.experimentRoot,
          experiment: report.experiment,
          providerState: report.providerState,
          evidenceDigest: report.evidenceDigest,
          registry: report.registry,
        },
        null,
        2,
      ),
    );
  }

  console.log("");
  console.log(`  experiment root   ${report.experimentRoot}`);
  console.log(`  evidence digest   ${report.evidenceDigest.slice(0, 16)}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1) npm run research -- --stats --experiment ${report.experimentId}`);
  console.log(
    `  2) EVOLVE_RESEARCH_ROOT=${report.experimentRoot} EVOLVE_ARENA_AB_SPECIES_MATCHED=1 npm run arena -- --research-mode ab --research ${datasetDir ?? "<dataset-dir>"}`,
  );
  console.log("  3) npm run compare:research -- --mock arena-20260918T081727Z --deepseek <new-arena-id>");

  if (stats.providerState.health === "FAILING") {
    console.error("[research] provider produced no usable proposals — the experiment is recorded as a provider failure.");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  if (error instanceof UnknownResearchProviderError) {
    // Fail-closed by construction: a typo must not produce a mock experiment.
    console.error(`[research] ${error.message}`);
    console.error(`[research] registered providers: ${REGISTERED_PROVIDERS.join(", ")}`);
    console.error("[research] no experiment was created and no provider was called.");
    process.exitCode = 2;
    return;
  }
  console.error("[research] cohort generation failed:", error?.message ?? error);
  process.exitCode = 1;
});
