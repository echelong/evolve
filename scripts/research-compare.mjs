#!/usr/bin/env node
/**
 * Research-provider comparison (Phase 5B, PAPER ONLY).
 *
 *   npm run compare:research -- --mock arena-20260918T081727Z --deepseek <arena-id>
 *
 * Compares two controlled A/B arenas — the canonical deterministic mock control
 * and a future DeepSeek experiment — WITHOUT manufacturing a verdict.
 *
 * The unit of comparison is the WITHIN-RUN delta:
 *
 *   delta(run) = Research arm(run) − its OWN matched Conventional arm(run)
 *
 * and the interesting quantity is the difference between those deltas. Raw
 * DeepSeek-Research against raw Mock-Research is deliberately NOT the headline:
 * if the two runs' matched control populations differ, that comparison measures
 * the controls, not the research provider.
 *
 * Nothing here claims significance, profitability, or deployment readiness.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";

export const RESEARCH_COMPARISON_VERSION = 1;
export const DEFAULT_ARENAS_DIR = path.join(".evolve", "arenas");
export const MOCK_CONTROL_ARENA = "arena-20260918T081727Z";

const BOOLEAN_FLAGS = ["json", "help"];
const VALUE_FLAGS = ["mock", "deepseek", "arenas-dir", "label-a", "label-b"];

export const METRIC_PATHS = Object.freeze([
  { key: "medianArenaScore", group: "arena", path: ["arena", "medianScore"] },
  { key: "medianRank", group: "arena", path: ["arena", "medianRank"] },
  { key: "bestScore", group: "arena", path: ["arena", "bestScore"] },
  { key: "championLeagueCount", group: "arena", path: ["arena", "championLeagueCount"] },
  { key: "groupCount", group: "arena", path: ["arena", "groupCount"] },
  { key: "gatePassedCount", group: "arena", path: ["arena", "gatePassedCount"] },
  { key: "medianNetPaperReturn", group: "trading", path: ["trading", "medianNetPaperReturn"] },
  { key: "medianCostDrag", group: "trading", path: ["trading", "medianCostDrag"] },
  { key: "medianDrawdown", group: "trading", path: ["trading", "medianDrawdown"] },
  { key: "medianTrades", group: "trading", path: ["trading", "medianTrades"] },
  { key: "medianDistinctMints", group: "trading", path: ["trading", "medianDistinctMints"] },
  { key: "stressSurvivalCount", group: "robustness", path: ["robustness", "stressSurvivalCount"] },
  { key: "medianPositiveRegimes", group: "robustness", path: ["robustness", "medianPositiveRegimes"] },
]);

function usage() {
  return [
    "EVOLVE research-provider comparison (PAPER ONLY)",
    "",
    "  npm run compare:research -- --mock <arena-id> --deepseek <arena-id>",
    "",
    "Options:",
    `  --mock <id>         control arena (default ${MOCK_CONTROL_ARENA})`,
    "  --deepseek <id>     provider-experiment arena to compare against the control",
    "  --label-a <text>    display label for the control (default: the arena id)",
    "  --label-b <text>    display label for the comparison run",
    "  --arenas-dir <dir>  arena directory (default .evolve/arenas)",
    "  --json              machine-readable output",
    "",
    "Deltas are computed WITHIN each run (Research − matched Conventional), then",
    "the deltas are compared. No verdict, no significance claim, no profitability",
    "claim is produced.",
  ].join("\n");
}

function pick(object, keys) {
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return Number.isFinite(current) ? current : null;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Read one arena's A/B artifact + research-provider provenance. */
export async function readArenaRun(arenaId, { arenasDir = DEFAULT_ARENAS_DIR } = {}) {
  const dir = path.join(arenasDir, arenaId);
  const comparison = await readJson(path.join(dir, "ab-comparison.json"));
  if (!comparison) {
    return { arenaId, dir, available: false, reason: `no ab-comparison.json in ${dir}` };
  }
  const summary = await readJson(path.join(dir, "summary.json"));
  const experiment = await readJson(path.join(dir, "research-experiment.json"));
  const research = comparison.cohorts?.research ?? {};
  const conventional = comparison.cohorts?.conventional ?? {};
  return {
    arenaId,
    dir,
    available: true,
    researchMode: comparison.researchMode ?? null,
    generatedAt: comparison.generatedAt ?? null,
    datasets: comparison.datasets ?? [],
    provider: {
      provider: experiment?.provider ?? null,
      model: experiment?.model ?? null,
      reasoning: experiment?.reasoning ?? null,
      promptVersion: experiment?.promptVersion ?? null,
      evidenceDigest: experiment?.evidenceDigest ?? null,
      experimentId: experiment?.experimentId ?? null,
      status: experiment?.status ?? null,
      counters: experiment?.counters ?? null,
    },
    cohort: {
      researchEntrants: research.arena?.entrants ?? null,
      conventionalEntrants: conventional.arena?.entrants ?? null,
      equalSize: comparison.cohortSize?.equalSize ?? null,
      uniqueResearchSeeds: comparison.cohortConstruction?.uniqueResearchSeeds ?? null,
      uniqueConventionalSeeds: comparison.cohortConstruction?.uniqueConventionalSeeds ?? null,
      startingResearchSeeds: comparison.cohortConstruction?.startingResearchSeeds ?? null,
      startingConventionalSeeds: comparison.cohortConstruction?.startingConventionalSeeds ?? null,
      clonedToFillQuota: comparison.cohortConstruction?.clonedToFillQuota ?? null,
      requestedMatchMode: comparison.cohortConstruction?.requestedMatchMode ?? null,
      effectiveMatchMode: comparison.cohortConstruction?.effectiveMatchMode ?? null,
      speciesMatched: comparison.species?.matched ?? null,
      speciesCountsResearch: comparison.species?.research ?? null,
      speciesCountsConventional: comparison.species?.conventional ?? null,
      familiesResearch: Object.keys(comparison.families?.research ?? {}).length,
      familiesConventional: Object.keys(comparison.families?.conventional ?? {}).length,
      roleSeeds: comparison.roles?.seedDistribution ?? null,
      requestedPopulation: comparison.cohortConstruction?.requested ?? null,
    },
    seedCounts: summary?.seeds ?? null,
    absolute: Object.fromEntries(
      METRIC_PATHS.map((metric) => [
        metric.key,
        { research: pick(research, metric.path), conventional: pick(conventional, metric.path) },
      ]),
    ),
    deltas: Object.fromEntries(
      METRIC_PATHS.map((metric) => {
        const r = pick(research, metric.path);
        const c = pick(conventional, metric.path);
        return [metric.key, r !== null && c !== null ? round6(r - c) : null];
      }),
    ),
    difference: comparison.comparison ?? null,
    failedGatesResearch: research.failedGates ?? null,
    failedGatesConventional: conventional.failedGates ?? null,
    distinctMintDiagnostics: comparison.distinctMintDiagnostics ?? null,
    limitations: comparison.limitations ?? null,
  };
}

/** Compare two runs by their within-run deltas (never raw-vs-raw as headline). */
export function compareRuns(runA, runB) {
  const deltaOfDeltas = {};
  for (const metric of METRIC_PATHS) {
    const a = runA?.deltas?.[metric.key];
    const b = runB?.deltas?.[metric.key];
    deltaOfDeltas[metric.key] = Number.isFinite(a) && Number.isFinite(b) ? round6(b - a) : null;
  }
  return {
    metricGroups: Object.fromEntries(METRIC_PATHS.map((metric) => [metric.key, metric.group])),
    deltaOfDeltas,
    sameDataset:
      JSON.stringify((runA?.datasets ?? []).map((row) => row?.fingerprint ?? row?.id)) ===
      JSON.stringify((runB?.datasets ?? []).map((row) => row?.fingerprint ?? row?.id)),
    sameRequestedPopulation:
      runA?.cohort?.requestedPopulation !== null &&
      runA?.cohort?.requestedPopulation === runB?.cohort?.requestedPopulation,
    bothSpeciesMatched: runA?.cohort?.speciesMatched === true && runB?.cohort?.speciesMatched === true,
  };
}

function formatRun(run, label) {
  if (!run?.available) {
    return [`${label}: UNAVAILABLE (${run?.reason ?? "unknown"})`];
  }
  const provider = run.provider ?? {};
  const cohort = run.cohort ?? {};
  const lines = [
    `${label} — ${run.arenaId}`,
    `  provider            ${provider.provider ?? "unknown"}${provider.model ? ` / ${provider.model}` : ""}${provider.reasoning ? ` (${provider.reasoning})` : ""}`,
    `  research experiment ${provider.experimentId ?? "n/a"}   status ${provider.status ?? "n/a"}`,
    `  prompt version      ${provider.promptVersion ?? "n/a"}`,
    `  match mode          ${cohort.effectiveMatchMode ?? "n/a"} (requested ${cohort.requestedMatchMode ?? "n/a"})   species matched ${cohort.speciesMatched === true}`,
    `  cohort              research ${cohort.researchEntrants ?? "?"} vs conventional ${cohort.conventionalEntrants ?? "?"}   equalSize ${cohort.equalSize === true}`,
    `  unique seeds        research ${cohort.uniqueResearchSeeds ?? "?"} / conventional ${cohort.uniqueConventionalSeeds ?? "?"}   clonedToFillQuota ${cohort.clonedToFillQuota ?? "n/a"}`,
    `  diversity           species(research) ${JSON.stringify(cohort.speciesCountsResearch ?? {})}   families research ${cohort.familiesResearch} / conventional ${cohort.familiesConventional}`,
    `  role seeds          ${JSON.stringify(cohort.roleSeeds ?? {})}`,
    `  gate failures       research ${JSON.stringify(run.failedGatesResearch ?? {})}   conventional ${JSON.stringify(run.failedGatesConventional ?? {})}`,
    "  within-run deltas (research − its own matched conventional):",
  ];
  for (const metric of METRIC_PATHS) {
    const value = run.deltas?.[metric.key];
    lines.push(`    ${metric.key.padEnd(22)} ${value === null || value === undefined ? "n/a" : value}`);
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }
  const arenasDir = String(args["arenas-dir"] ?? DEFAULT_ARENAS_DIR);
  const mockId = String(args.mock ?? MOCK_CONTROL_ARENA);
  const deepseekId = args.deepseek ? String(args.deepseek) : null;
  const labelA = String(args["label-a"] ?? `control (${mockId})`);
  const labelB = String(args["label-b"] ?? (deepseekId ? `provider run (${deepseekId})` : "provider run"));

  const runA = await readArenaRun(mockId, { arenasDir });
  const runB = deepseekId ? await readArenaRun(deepseekId, { arenasDir }) : null;

  const report = {
    schemaVersion: RESEARCH_COMPARISON_VERSION,
    comparison: "research-provider",
    paperOnly: true,
    controlArenaId: mockId,
    comparisonArenaId: deepseekId,
    units: "deltas are computed WITHIN each run (research − matched conventional), then compared",
    control: runA,
    comparisonRun: runB,
    deltaOfDeltas: runB ? compareRuns(runA, runB) : null,
    verdict: null,
    verdictNote:
      "No verdict is produced. A null or worse result is a valid outcome; provider differences can also come from cohort composition, not the provider. Read deltaOfDeltas as an observation with the sample size and limitations shown, not as a result.",
  };

  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("EVOLVE research-provider comparison (PAPER ONLY)");
    console.log("=".repeat(72));
    for (const line of formatRun(runA, labelA)) console.log(line);
    console.log("");
    if (!runB) {
      console.log("No comparison arena supplied. Re-run with --deepseek <arena-id> after a DeepSeek A/B run.");
    } else {
      for (const line of formatRun(runB, labelB)) console.log(line);
      console.log("");
      console.log("delta-of-deltas (provider run minus control, each measured against its OWN matched control):");
      for (const metric of METRIC_PATHS) {
        const value = report.deltaOfDeltas.deltaOfDeltas[metric.key];
        console.log(`  ${metric.key.padEnd(22)} ${value === null ? "n/a" : value}`);
      }
      console.log("");
      console.log(
        `properties: sameDataset ${report.deltaOfDeltas.sameDataset} · sameRequestedPopulation ${report.deltaOfDeltas.sameRequestedPopulation} · bothSpeciesMatched ${report.deltaOfDeltas.bothSpeciesMatched}`,
      );
      console.log("");
      console.log(report.verdictNote);
    }
  }

  if (!runA.available) process.exitCode = 2;
}

// Only run the CLI when this file is executed directly: the Phase 5B validator
// imports `readArenaRun` / `compareRuns` from this module, and importing it must
// never print a report or exit.
const invokedDirectly =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[compare:research] comparison failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
