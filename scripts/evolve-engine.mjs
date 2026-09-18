#!/usr/bin/env node
/**
 * EVOLVE engine entry point.
 *
 * PAPER TRADING ONLY. This process observes Solana market data, runs an
 * evolutionary population of paper agents against it, and writes a dashboard
 * snapshot to `.evolve/state.json`.
 *
 * It has no wallet, no private keys, no signer, no RPC write path, and no
 * order-submission code. A "trade" is an internal simulated accounting event
 * priced from observed market data.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSimulation } from "./engine/simulation.mjs";
import { DEFAULT_REPLAY_STATE_FILE, runReplay } from "./engine/replay-runner.mjs";
import { serializeForPublic } from "./lib/sanitize.mjs";
import { createMarketConfig, publicConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { REPLAY_BANNER } from "./market/replay.mjs";
import { buildEvidencePacket, runResearchCycle } from "./research/cycle.mjs";
import { loadPriorConclusions, readResearchMemorySummary } from "./research/memory.mjs";
import { PROVIDER_STATUS, providerIdentity, resolveProviderConfig, unknownProviderMessage, validateProviderName } from "./research/provider-config.mjs";
import { listProviderRuns, providerStateSummary } from "./research/provider-runtime.mjs";
import { readResearchExperiment, researchExperimentSummary } from "./research/experiment.mjs";
import { RESEARCH_PROMPT_VERSION } from "./research/prompt.mjs";

export const STATE_DIR = ".evolve";
export const STATE_FILE = "state.json";

/**
 * State isolation: a live/synthetic run writes `state.json`, a historical
 * replay writes `replay-state.json`, and experiment reports live under
 * `.evolve/experiments/<id>/`. A replay can therefore never overwrite the live
 * dashboard snapshot, and the dashboard picks whichever one it asked for.
 */
export const REPLAY_STATE_FILE = DEFAULT_REPLAY_STATE_FILE;

export function statePaths(dir = STATE_DIR) {
  return {
    dir,
    file: path.join(dir, STATE_FILE),
    tempFile: path.join(dir, `${STATE_FILE}.tmp`),
  };
}

/**
 * Build a running engine (no timers started).
 * Useful for tests, smoke runs, and embedding.
 */
export function createEngine({ config = createMarketConfig(), now, random } = {}) {
  let simulation = null;

  const feed = createMarketFeed({
    config,
    now,
    random,
    onEvent: ({ type, message }) => simulation?.addEvent(type, message),
  });

  simulation = createSimulation({
    config,
    feed,
    now,
    random,
    evolution: { enabled: true, ...config.evolution },
  });

  return { config, feed, simulation };
}

export function startupLines({ config }) {
  const lines = [];
  lines.push(`[EVOLVE] PAPER ONLY engine — ${config.engine.population} agents, no wallet, no keys, no on-chain execution.`);
  lines.push(
    `[EVOLVE] market mode request=${config.requestedMode} key=${config.apiKeyConfigured ? "configured" : "not configured"} provider=${config.provider}`,
  );
  if (!config.apiKeyConfigured && config.requestedMode !== "synthetic") {
    // Explicit synthetic mode never touches Jupiter: mentioning the API key here
    // would imply a live probe that does not happen.
    lines.push(
      `[EVOLVE] JUPITER_API_KEY is not set. ${
        config.requestedMode === "live"
          ? "Live mode will report DEGRADED and pause new entries."
          : config.keylessAllowed
            ? "Trying keyless live observations, then synthetic fallback."
            : "Falling back to the synthetic paper market."
      }`,
    );
  }
  if (config.requestedMode === "synthetic") {
    lines.push("[EVOLVE] synthetic mode: no Jupiter requests will be made (offline paper market).");
  }
  if (config.loadedEnvFiles.length > 0) {
    lines.push(`[EVOLVE] env files loaded: ${config.loadedEnvFiles.join(", ")}`);
  }
  lines.push(
    `[EVOLVE] endpoints: ${config.endpoints.map((endpoint) => endpoint.label).join(", ")}`,
  );
  lines.push(
    `[EVOLVE] paper cash $${config.paper.startingCash} · fee ${config.paper.baseFeeBps}bps · min slippage ${config.paper.minSlippageBps}bps · universe max ${config.universeMax}`,
  );
  return lines;
}

/**
 * Phase 5A: drives the controlled recursive research cycle from the live
 * engine loop. The heavy lifting (propose / validate / compile / watchdog /
 * memory) lives in research/cycle.mjs and is simulation-agnostic; this
 * controller is the thin, engine-specific glue: when to run a cycle, how to
 * turn a live snapshot into an evidence packet, and how to inject whatever
 * the cycle compiles back into the running population.
 *
 * Failures here are always caught and logged — a research cycle can delay
 * research, never the paper engine itself.
 */
export function createResearchController({ config, simulation }) {
  const researchConfig = config.research ?? {};
  // Phase 5B.1 — FAIL-CLOSED provider selection. A typo in
  // EVOLVE_RESEARCH_PROVIDER must never silently run the mock provider in the
  // live engine either: research is disabled, the requested (invalid) name is
  // reported on the dashboard, and no cycle/provider call happens. The paper
  // trading engine itself keeps running.
  const providerValidation = validateProviderName(researchConfig.provider ?? "");
  const providerSpecified = typeof researchConfig.provider === "string" && researchConfig.provider.trim().length > 0;
  const requestedProvider = providerSpecified ? String(researchConfig.provider).trim().toLowerCase() : "";
  const providerConfigError =
    providerSpecified && !providerValidation.recognized ? unknownProviderMessage(requestedProvider) : null;
  const enabled = researchConfig.enabled !== false && providerConfigError === null;
  const root = researchConfig.root ?? ".evolve/research";
  const cycleEveryGenerations = Math.max(0, Math.round(researchConfig.cycleEveryGenerations ?? 2));

  let cycle = 0;
  let lastGenerationRun = -1;
  // The Phase 5A research-swarm state contract. Everything the dashboard needs
  // to describe the CURRENT swarm lives here — this object is what `state.json`
  // persists as `researchSwarm`, and it is deliberately kept in a field whose
  // name cannot collide with the API's historical/replay research bucket.
  const summary = {
    enabled,
    provider: providerSpecified ? requestedProvider : "mock",
    // Phase 5B.1: a provider configuration error is reported, never hidden.
    providerError: providerConfigError,
    providerConfigValid: providerConfigError === null,
    // Phase 5B: the provider contract the dashboard exposes — provider, model,
    // reasoning, prompt version, experiment id, health, calls, failures, cache
    // hits, schema rejects, watchdog counts. Counts and identity ONLY: never a
    // prompt, never a raw response, never a credential.
    providerState: providerConfigError
      ? {
          provider: requestedProvider,
          model: null,
          reasoning: null,
          external: false,
          health: PROVIDER_STATUS.CONFIG_ERROR,
          calls: 0,
          failures: 0,
          cacheHits: 0,
          error: providerConfigError,
          note: "provider configuration is invalid: research is disabled (no fallback exists)",
        }
      : null,
    promptVersion: RESEARCH_PROMPT_VERSION,
    cycle: 0, // current research cycle
    regime: null, // current research regime (Arena classifier vocabulary)
    proposalsGenerated: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
    compiledCandidates: 0,
    compiledFamilies: 0, // accepted proposals whose families were compiled
    uniqueRatio: 0, // most recent cohort's unique-genome ratio
    duplicateRejections: 0, // cumulative duplicate genomes refused a slot
    speciesDistribution: {}, // most recent cohort's compiled species mix
    outcomes: {}, // cumulative explicit lifecycle outcomes
    roleMetrics: {}, // per-researcher-role contribution
    injectedCandidates: 0, // research candidates live in the population right now
    memoryRecords: 0,
    conclusions: 0,
    evaluations: 0,
    researcherRoles: {}, // researcher role -> memory records authored
    watchdog: {
      normal: 0,
      watch: 0,
      quarantined: 0,
      evaluated: 0,
      lastEvaluatedAt: null,
    },
    lastRunAt: null,
    lastError: null,
    log: [], // bounded, most-recent-first, for the dashboard activity feed
  };

  function dueThisGeneration() {
    if (!enabled) return false;
    const generation = simulation.generation;
    if (generation === lastGenerationRun) return false;
    if (cycleEveryGenerations === 0) return true;
    return generation - Math.max(0, lastGenerationRun) >= cycleEveryGenerations;
  }

  async function runIfDue() {
    // A provider configuration error means NO research runs: no provider call,
    // no proposals, no silent mock substitution.
    if (providerConfigError !== null) {
      summary.lastError = providerConfigError;
      return summary;
    }
    if (!dueThisGeneration()) return summary;
    lastGenerationRun = simulation.generation;
    cycle += 1;

    try {
      const snapshot = simulation.snapshot();
      const priorConclusions = await loadPriorConclusions(root);
      const evidence = buildEvidencePacket({
        snapshot,
        islands: snapshot.islands ?? [],
        priorConclusions,
        cycle,
      });
      const pendingEvidence = simulation.getResearchEvidence();

      const report = await runResearchCycle({
        root,
        evidence,
        cycle,
        seed: `${config.seed ?? "evolve"}:${config.engine.population}`,
        provider: researchConfig.provider,
        proposalsPerCycle: researchConfig.proposalsPerCycle,
        maxCompilations: researchConfig.maxCompilationsPerCycle,
        // Phase 5A.2 cohort guards (uniqueness + species concentration).
        maxSpeciesShare: researchConfig.maxSpeciesShare,
        minUniqueRatio: researchConfig.minUniqueRatio,
        strictUniqueness: researchConfig.strictUniqueness === true,
        watchThresholds: config.researchWatch ?? {},
        pendingEvidence,
      });

      for (const entry of report.compiled) {
        simulation.injectResearchCandidate({
          genome: entry.genome,
          species: entry.species,
          familyId: entry.familyId,
          proposalId: entry.proposalId,
          authorRole: entry.authorRole,
          targetRegimes: entry.targetRegimes,
          abstainRegimes: entry.abstainRegimes,
        });
      }
      simulation.clearResearchEvidence(report.clearedFamilyIds);

      // Re-read memory so the summary always reflects what is actually on
      // disk (records, conclusions, role counts, watchdog roll-up) rather than
      // an in-memory guess — the same numbers the dashboard and any audit see.
      const memory = await readResearchMemorySummary(root);

      summary.cycle = cycle;
      summary.regime = snapshot.researchRegime ?? summary.regime;
      summary.proposalsGenerated += report.proposed;
      summary.proposalsAccepted += report.accepted ?? 0;
      summary.proposalsRejected += report.rejectedSchema.length + report.rejectedCompile.length;
      summary.compiledCandidates += report.compiled.length;
      summary.uniqueRatio = report.uniqueRatio ?? 0;
      summary.duplicateRejections += report.rejectedDuplicates ?? 0;
      summary.speciesDistribution = { ...(report.speciesDistribution ?? {}) };
      summary.roleMetrics = report.roleMetrics ?? {};
      for (const [outcome, count] of Object.entries(report.outcomes ?? {})) {
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + count;
      }
      summary.compiledFamilies = memory.compiledFamilies;
      summary.injectedCandidates = simulation.population.filter((agent) => agent.researchMeta).length;
      summary.memoryRecords = memory.memoryRecords;
      summary.conclusions = memory.conclusions;
      summary.evaluations += report.watchdog.length;
      summary.researcherRoles = { ...memory.byRole };
      summary.watchdog = {
        normal: memory.watchdog.NORMAL ?? 0,
        watch: memory.watchdog.WATCH ?? 0,
        quarantined: memory.watchdog.QUARANTINED ?? 0,
        evaluated: memory.watchdog.evaluated ?? 0,
        lastEvaluatedAt: memory.watchdog.lastEvaluatedAt ?? null,
      };
      summary.lastRunAt = new Date().toISOString();
      summary.lastError = null;
      // Phase 5B provider roll-up: identity + counts, derived from the persisted
      // provider run records (which hold digests, not payloads). A provider
      // failure is reported here and never disguised as research.
      try {
        const providerRoot = path.join(root, "provider");
        const [runs, experiment] = await Promise.all([
          listProviderRuns(providerRoot, { limit: 200 }),
          readResearchExperiment(root),
        ]);
        const providerConfig = resolveProviderConfig();
        const identity = providerIdentity({
          provider: providerSpecified ? requestedProvider : providerConfig.provider,
          model: providerConfig.model,
          reasoning: providerConfig.reasoning,
        });
        summary.providerState = providerStateSummary({
          identity,
          experimentId: researchExperimentSummary(experiment)?.experimentId ?? null,
          cacheEnabled: providerConfig.cacheEnabled,
          runs,
          experiment: experiment?.counters ?? null,
        });
      } catch (error) {
        summary.providerState = {
          provider: researchConfig.provider ?? null,
          health: "UNKNOWN",
          note: `provider state unavailable: ${error?.message ?? error}`,
        };
      }
      summary.log.unshift({
        cycle,
        at: summary.lastRunAt,
        proposed: report.proposed,
        accepted: report.accepted ?? 0,
        compiled: report.compiled.length,
        rejected: report.rejectedSchema.length + report.rejectedCompile.length,
        duplicateRejections: report.rejectedDuplicates ?? 0,
        uniqueRatio: report.uniqueRatio ?? 0,
        species: { ...(report.speciesDistribution ?? {}) },
        watchdogEvaluated: report.watchdog.length,
        watchdogVerdicts: report.watchdogVerdicts ?? {},
      });
      summary.log = summary.log.slice(0, 10);
    } catch (error) {
      summary.lastError = error?.message ?? String(error);
    }

    return summary;
  }

  return { runIfDue, summary: () => summary };
}

/** Persist the snapshot atomically so the dashboard never reads a partial file. */
export async function persist(state, { dir = STATE_DIR } = {}) {
  const paths = statePaths(dir);
  await mkdir(paths.dir, { recursive: true });
  const payload = serializeForPublic(state);
  await writeFile(paths.tempFile, payload, "utf8");
  await rename(paths.tempFile, paths.file);
}

export async function startEngine({ config = createMarketConfig(), dir = STATE_DIR } = {}) {
  const { feed, simulation } = createEngine({ config });

  for (const line of startupLines({ config })) console.log(line);

  simulation.addEvent("SYSTEM", `EVOLVE engine online with ${config.engine.population} paper agents.`);
  simulation.addEvent(
    "SYSTEM",
    "Paper mode enforced. No wallet keys are loaded and no on-chain execution path exists.",
  );

  const research = createResearchController({ config, simulation });

  const snapshotWithConfig = () => ({
    ...simulation.snapshot(),
    config: publicConfig(config),
    // Named distinctly from the API route's pre-existing `research` bucket
    // (experiment/champions/arena/hall-of-fame/shadow reference data) so the
    // two are never confused: this is the Phase 5A research-swarm cycle
    // summary specifically.
    researchSwarm: research.summary(),
  });

  await persist(snapshotWithConfig(), { dir });

  feed.start({ intervalMs: Math.min(1000, config.engine.tickMs) });

  let ticking = false;

  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      simulation.advanceTick();
      // Best-effort and bounded: a research cycle can only run once per
      // newly-reached generation boundary (see dueThisGeneration), and any
      // failure inside it is caught and logged without ever throwing here —
      // research can lag, the paper engine tick loop must not.
      await research.runIfDue();
      await persist(snapshotWithConfig(), { dir });
    } catch (error) {
      console.error("[EVOLVE] tick failed:", error?.message ?? error);
    } finally {
      ticking = false;
    }
  }, config.engine.tickMs);

  const shutdown = async (signal) => {
    console.log(`[EVOLVE] ${signal} received — flushing state and exiting.`);
    clearInterval(timer);
    feed.stop();
    try {
      await persist(snapshotWithConfig(), { dir });
    } catch {
      // best effort on shutdown
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`[EVOLVE] dashboard state -> ${path.join(dir, STATE_FILE)}`);
  console.log(`[EVOLVE] paper engine running: ${config.engine.population} agents`);

  return { feed, simulation, timer };
}

/**
 * Replay mode through the standard entry point:
 *
 *   EVOLVE_MARKET_MODE=replay EVOLVE_REPLAY_DATASET=<dir> npm run engine
 *
 * Identical simulation, dataset-driven clock, state written to the replay state
 * file so the live dashboard snapshot is untouched.
 */
export async function startReplayEngine({ config = createMarketConfig(), dir = STATE_DIR } = {}) {
  console.log(`[EVOLVE] ${REPLAY_BANNER}`);
  console.log("[EVOLVE] PAPER ONLY — no wallet, no keys, no signing, no on-chain execution.");
  console.log(`[EVOLVE] dataset ${config.replay.dataset ?? "(unset)"} · speed ${config.replay.speed} · seed ${config.seed}`);

  let stopping = false;
  const onSignal = (signal) => {
    stopping = true;
    console.log(`[EVOLVE] ${signal} received — finalizing replay state.`);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  const result = await runReplay({ config, dir, shouldStop: () => stopping });

  console.log(
    `[EVOLVE] replay complete: ${result.ticks} ticks · generations ${result.state.generation} · state -> ${result.statePath}`,
  );
  return result;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const config = createMarketConfig();
  const run = config.requestedMode === "replay" ? startReplayEngine({ config }) : startEngine({ config });
  run.catch((error) => {
    console.error("[EVOLVE] fatal bootstrap error:", error?.message ?? error);
    process.exitCode = 1;
  });
}
