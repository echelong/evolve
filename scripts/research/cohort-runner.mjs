/**
 * DeepSeek (and future) research-cohort generation (Phase 5B).
 *
 * This is the "propose" half of the architecture, driven for an EXTERNAL
 * provider:
 *
 *   TRAIN evidence → provider call (bounded) → strict JSON extraction →
 *   proposal schema → deterministic compiler → uniqueness + watchdog →
 *   persisted compiled candidates (isolated per experiment)
 *
 * Everything after the provider call is the existing, unchanged EVOLVE
 * machinery: the same schema, the same compiler, the same uniqueness guard, the
 * same watchdog, the same research memory. The provider gets no bypass.
 *
 * Isolation: an experiment writes to
 * `.evolve/research/experiments/<experiment-id>/`, so the canonical mock
 * cohort under `.evolve/research/` is untouched. The Arena is pointed at the
 * experiment root explicitly (`EVOLVE_RESEARCH_ROOT=...`).
 *
 * PAPER ONLY research machinery.
 */

import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import {
  MEMORY_OUTCOME,
  listCompiledCandidates,
  listProposals,
  readMemoryIndex,
} from "./memory.mjs";
import { FAMILY_NAMES } from "../engine/families.mjs";
import { buildResearchEvidencePacket, evidenceDigestOf } from "./evidence-packet.mjs";
import { RESEARCH_PROMPT_VERSION, proposingRoles } from "./prompt.mjs";
import { EVIDENCE_PACKET_VERSION } from "./evidence-packet.mjs";
import { RESEARCH_COHORT_DEFAULTS, genomeDigestOf } from "./cohort.mjs";
import { runResearchCycle } from "./cycle.mjs";
import {
  PROVIDER_STATUS,
  UnknownResearchProviderError,
  requireProviderName,
  resolveEffectiveProviderTimeoutMs,
  resolveProviderConfig,
} from "./provider-config.mjs";
import { providerStateSummary } from "./provider-runtime.mjs";
import { RESEARCH_EXPERIMENT_VERSION } from "./experiment.mjs";
import {
  accumulateExperimentCounters,
  createResearchExperiment,
  experimentRootFor,
  researchExperimentIdFor,
  writeResearchExperiment,
} from "./experiment.mjs";
import { resolveResearchProvider } from "./provider.mjs";

export const RESEARCH_COHORT_RUNNER_VERSION = 1;

/* ============================================================================
 * Evidence assembly (TRAIN-only)
 * ==========================================================================*/

/** Counts per family from allowed historical memory — never performance data. */
export function familySummariesFromMemory({ compiled = [], conclusions = [] } = {}) {
  const rows = new Map();
  for (const name of FAMILY_NAMES) {
    rows.set(name, { name, proposals: 0, compiled: 0, duplicateRejections: 0, compilerRejections: 0, note: null });
  }
  for (const entry of compiled) {
    const name = entry?.family ?? entry?.researchFamily ?? null;
    if (!name || !rows.has(name)) continue;
    rows.get(name).compiled += 1;
  }
  for (const conclusion of conclusions) {
    const outcome = conclusion?.outcome ?? conclusion?.status ?? null;
    const name = conclusion?.family ?? null;
    if (!name || !rows.has(name)) continue;
    if (outcome === MEMORY_OUTCOME.REJECTED_DUPLICATE) rows.get(name).duplicateRejections += 1;
    if (outcome === MEMORY_OUTCOME.REJECTED_COMPILER) rows.get(name).compilerRejections += 1;
  }
  for (const row of rows.values()) {
    if (row.compiled > 0) row.proposals = row.compiled;
    row.note =
      row.compiled === 0 && row.duplicateRejections === 0 && row.compilerRejections === 0
        ? "no recorded research activity for this family in permitted memory"
        : null;
  }
  return [...rows.values()];
}

/** Species coverage of the persisted cohort (counts only; no metrics). */
export function speciesSummariesFromCohort(compiled = []) {
  const counts = new Map();
  for (const entry of compiled) {
    const name = entry?.species ?? null;
    if (typeof name !== "string" || name.length === 0) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count, avgReturn: null, trades: null }));
}

/**
 * Build the bounded, TRAIN-only evidence packet for a cohort run.
 *
 * Sources: an optional recorded dataset (its TRAIN intervals only), permitted
 * research memory, and cohort coverage counts. NOT included: validation, test,
 * out-of-sample, stress, or deployment outcomes — those classes are declared as
 * excluded inside the packet and audited by tests.
 */
export async function buildCohortEvidence({
  experimentId = null,
  memoryRoot = null,
  cohortRoot = null,
  datasetDir = null,
  config = null,
  cycle = 1,
  now = () => Date.now(),
  limits = {},
} = {}) {
  const dataset = datasetDir ? await trainEvidenceFromDatasetSafe({ datasetDir, config, now }) : null;

  let memoryRecords = [];
  let conclusions = [];
  if (memoryRoot) {
    memoryRecords = await readMemoryIndex(memoryRoot, { limit: 100 }).catch(() => []);
    const memory = await readResearchMemoryForEvidence(memoryRoot);
    conclusions = memory.conclusions;
  }

  const compiled = cohortRoot ? await listCompiledCandidates(cohortRoot, { limit: 500 }).catch(() => []) : [];

  return buildResearchEvidencePacket({
    experimentId,
    researchCycle: cycle,
    createdAt: new Date(now()).toISOString(),
    datasetRefs: dataset ? [dataset.datasetRef] : [],
    regimeObservations: dataset?.regimeObservations ?? [],
    regimeDistribution: dataset?.regimeDistribution ?? {},
    speciesSummaries: speciesSummariesFromCohort(compiled),
    familySummaries: familySummariesFromMemory({ compiled, conclusions }),
    marketFeatures: dataset?.marketFeatures ?? null,
    memoryRecords,
    limits,
    generatedBy: { runner: RESEARCH_COHORT_RUNNER_VERSION, datasetDir: datasetDir ?? null },
  });
}

/** Read conclusions from a research root, tolerating a missing file. */
async function readResearchMemoryForEvidence(root) {
  const { readFile } = await import("node:fs/promises");
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "conclusions.json"), "utf8"));
    return { conclusions: Array.isArray(parsed?.entries) ? parsed.entries : [] };
  } catch {
    return { conclusions: [] };
  }
}

async function trainEvidenceFromDatasetSafe({ datasetDir, config }) {
  try {
    const { trainEvidenceFromDataset } = await import("./evidence-packet.mjs");
    return await trainEvidenceFromDataset({ datasetDir, config, maxWindows: 3 });
  } catch (error) {
    return {
      datasetRef: { id: path.basename(datasetDir), sourceType: null, trainWindows: 0 },
      regimeObservations: [],
      regimeDistribution: {},
      marketFeatures: {
        interval: "TRAIN",
        windows: 0,
        unavailable: `dataset TRAIN evidence could not be derived: ${error?.message ?? error}`,
      },
    };
  }
}
/* ============================================================================
 * Run-level call budget (Phase 5B.1 bugfix)
 * ==========================================================================*/

/**
 * ONE explicit budget shared across every cycle of a run. `maxCalls` is fixed
 * at creation and never shrinks or gets recreated per cycle — that was the
 * bug: a per-call ceiling was previously recomputed from `proposalsPerCycle`
 * (`min(remaining, count)`), which coincidentally equalled the real budget on
 * cycle 1 but became a stale, already-exhausted ceiling on cycle 2.
 *
 * A `PROVIDER_BUDGET_EXCEEDED` refusal is bookkeeping, not a call: it never
 * reaches the provider subprocess, so it does not consume `attemptedCalls`.
 * `providerFailures` counts real attempts that did not succeed (timeouts,
 * process errors, schema rejections, …) — never the refusals themselves.
 */
export function createRunBudget(maxCalls) {
  const budget = {
    maxCalls: Math.max(1, Math.round(Number(maxCalls) || 1)),
    attemptedCalls: 0,
    successfulCalls: 0,
    providerFailures: 0,
    callsByCycle: {},
    get remainingCalls() {
      return Math.max(0, budget.maxCalls - budget.attemptedCalls);
    },
    /** Fold one cycle's provider-run delta into the shared, run-level totals. */
    recordCycle(cycle, runs = []) {
      const key = cycle === null || cycle === undefined ? "unknown" : String(cycle);
      let attempted = 0;
      for (const run of Array.isArray(runs) ? runs : []) {
        if (run?.status === PROVIDER_STATUS.BUDGET_EXCEEDED) continue; // a refusal, not a call
        // A cache hit or a replay never reaches the subprocess (see
        // `deepseek-cline.mjs`: `stats.calls` is not incremented for either
        // path), so neither one consumes the real-call budget.
        if (run?.cacheHit === true || run?.replay === true) continue;
        attempted += 1;
        if (run?.status === PROVIDER_STATUS.OK) budget.successfulCalls += 1;
        else budget.providerFailures += 1;
      }
      budget.attemptedCalls += attempted;
      if (attempted > 0) budget.callsByCycle[key] = (budget.callsByCycle[key] ?? 0) + attempted;
      return budget;
    },
  };
  return budget;
}

/* ============================================================================
 * Cohort generation
 * ==========================================================================*/

/**
 * Run a bounded research-cohort generation for one provider.
 *
 * FAIL-CLOSED (Phase 5B.1): the requested provider name is resolved BEFORE any
 * experiment root, experiment artifact, proposal, or provider call exists. An
 * explicit but unregistered name throws `UnknownResearchProviderError`, so a
 * typo can neither run the mock provider nor leave behind an artifact that looks
 * like a valid mock/DeepSeek experiment.
 *
 * The provider is called at most `maxProviderCalls` times in total, across all
 * cycles — a single run can never become an unbounded LLM loop.
 */
export async function generateResearchCohort(options = {}) {
  const warn = options.warn ?? ((message) => console.warn(message));
  const envConfig = resolveProviderConfig(options.env ?? process.env, { warn });

  // The ONE resolver every entry point uses (see `provider-config.mjs`):
  // explicit override (here, `options.providerTimeoutMs`, e.g. the `research`
  // CLI's `--provider-timeout-ms`) → environment → documented default. This is
  // deliberately kept separate from `options.config`, which is an unrelated
  // market/dataset config used only to build TRAIN evidence below — merging the
  // two previously let an 9000ms Jupiter-quote timeout silently overwrite the
  // 180000ms provider default whenever `options.config` happened to also carry
  // a `timeoutMs` field.
  const { timeoutMs: providerTimeoutMs } = resolveEffectiveProviderTimeoutMs({
    cliRaw: options.providerTimeoutMs ?? null,
    envConfig,
    warn,
  });

  // `options.providerName` is an EXPLICIT request; otherwise the environment (or
  // its absence) decides. Either way an explicit unregistered name fails closed.
  const explicitName =
    options.providerName === undefined || options.providerName === null
      ? ""
      : String(options.providerName).trim();
  if (explicitName.length === 0 && envConfig.configError) {
    // The typo came from the environment: fail before touching the filesystem.
    throw new UnknownResearchProviderError(envConfig.requestedProvider);
  }
  const resolution = requireProviderName(explicitName.length > 0 ? explicitName : envConfig.provider);
  const providerName = resolution.provider;

  const now = options.now ?? (() => Date.now());
  const baseRoot = options.baseRoot ?? path.join(".evolve", "research");
  const maxProviderCalls = Math.max(
    1,
    Math.round(Number(options.maxProviderCalls ?? envConfig.maxCallsPerRun) || envConfig.maxCallsPerRun),
  );
  const roles = (options.roles && options.roles.length > 0 ? options.roles : proposingRoles()).slice();
  const proposalsPerCycle = Math.max(1, Math.round(Number(options.proposalsPerCycle ?? roles.length) || roles.length));
  const cycles = Math.max(1, Math.round(Number(options.cycles ?? 1) || 1));
  const limits = {
    maxContextChars: options.limits?.maxContextChars ?? envConfig.maxContextChars,
    maxMemoryRecords: options.limits?.maxMemoryRecords ?? envConfig.maxMemoryRecords,
  };

  const startedAtMs = now();
  const experimentId =
    options.experimentId ??
    researchExperimentIdFor({
      provider: providerName,
      startedAt: startedAtMs,
      datasetIds: options.datasetDir ? [path.basename(options.datasetDir)] : [],
    });
  const experimentRoot = experimentRootFor(baseRoot, experimentId);

  // ---- provider ------------------------------------------------------------
  // `providerConfig` carries ONLY the resolved provider identity/limits
  // (never the unrelated `options.config` market/dataset config — see above).
  const providerConfig = { ...envConfig, timeoutMs: providerTimeoutMs };
  const provider =
    options.provider ??
    resolveResearchProvider(providerName, {
      config: providerConfig,
      env: options.env ?? process.env,
      root: path.join(experimentRoot, "provider"),
      experimentId,
      now,
      spawnImpl: options.spawnImpl ?? null,
      roles,
    });

  // ---- evidence ------------------------------------------------------------
  const evidence = await buildCohortEvidence({
    experimentId,
    memoryRoot: options.memoryRoot ?? baseRoot,
    cohortRoot: experimentRoot,
    datasetDir: options.datasetDir ?? null,
    config: options.config ?? null,
    cycle: 1,
    now,
    limits,
  });
  const evidenceDigest = evidenceDigestOf(evidence);

  const experiment = createResearchExperiment({
    experimentId,
    provider: providerName,
    model: typeof provider.model === "string" ? provider.model : providerName === "mock" ? null : envConfig.model,
    reasoning:
      typeof provider.reasoning === "string" ? provider.reasoning : providerName === "mock" ? null : envConfig.reasoning,
    providerFormatVersion: envConfig.formatVersion,
    promptVersion: RESEARCH_PROMPT_VERSION,
    evidencePacketVersion: EVIDENCE_PACKET_VERSION,
    evidenceDigest,
    datasetRefs: evidence.datasetRefs ?? [],
    seed: options.seed ?? null,
    startedAt: startedAtMs,
    limits: {
      maxContextChars: limits.maxContextChars,
      maxMemoryRecords: limits.maxMemoryRecords,
      maxProviderCalls,
      cacheEnabled: (options.cacheEnabled ?? envConfig.cacheEnabled) === true,
      // The EFFECTIVE timeout (CLI override → env → documented default), not
      // just the env-resolved value — this is the number that actually governed
      // every provider subprocess in this run.
      timeoutMs: providerTimeoutMs,
      maxAttemptsPerCall: envConfig.maxAttempts,
    },
    rolePlan: roles,
  });
  const requestedProposalTotal = cycles * proposalsPerCycle;
  experiment.request = {
    requestedCycles: cycles,
    proposalsPerCycle,
    requestedProposalTotal,
    maxProviderCalls,
    providerTimeoutMs,
    maxAttemptsPerCall: envConfig.maxAttempts,
  };
  experiment.counters.cyclesRequested = cycles;
  experiment.notes.push(
    `evidence classes: ${(evidence.evidenceClasses ?? []).join(", ") || "none"}; excluded: ${(evidence.excludedEvidenceClasses ?? []).join(", ")}`,
  );
  if (evidence.truncation?.occurred) {
    experiment.notes.push(`evidence packet truncated: ${evidence.truncation.reasons.join(", ")}`);
  }
  await writeResearchExperiment(experimentRoot, experiment);
// ---- cycles --------------------------------------------------------------
  const providerRuns = [];
  const cycleResults = [];
  const seenProposalIds = new Set();
  const runCursor = { value: Array.isArray(provider.runs) ? provider.runs.length : 0 };

  // ONE run-level budget, created once and shared across every cycle (Phase
  // 5B.1 bugfix: `proposalsPerCycle` must never define the global call cap —
  // see `createRunBudget`). `maxCalls` never shrinks or gets recreated per
  // cycle; only `attemptedCalls` grows as real (non-refused) provider calls
  // happen.
  const runBudget = createRunBudget(maxProviderCalls);

  const wrapper = {
    name: provider.name ?? providerName,
    model: provider.model ?? null,
    reasoning: provider.reasoning ?? null,
    offline: provider.offline === true,
    async propose(input) {
      if (runBudget.remainingCalls === 0) return [];
      const proposals = await provider.propose({
        ...input,
        roles,
        root: path.join(experimentRoot, "provider"),
        experimentId,
        cacheEnabled: options.cacheEnabled ?? envConfig.cacheEnabled,
        // The run-level ceiling is CONSTANT for the whole run — never a
        // per-call "remaining" value recomputed from `proposalsPerCycle`. A
        // provider compares its own cumulative call count against this same
        // constant every time, so cycle 2 never mistakes "5 already used" for
        // "budget exhausted at 5".
        maxCallsPerRun: maxProviderCalls,
      });
      const all = Array.isArray(provider.runs) ? provider.runs : [];
      const delta = all.slice(runCursor.value);
      runCursor.value = all.length;
      providerRuns.push(...delta);
      runBudget.recordCycle(input.cycle ?? null, delta);
      return disambiguateProposalIds(Array.isArray(proposals) ? proposals : [], seenProposalIds);
    },
  };

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const result = await runResearchCycle({
      root: experimentRoot,
      evidence,
      cycle,
      seed: options.seed ?? "evolve",
      provider: wrapper,
      proposalsPerCycle,
      maxCompilations: options.maxCompilations ?? 3,
      maxSpeciesShare: options.maxSpeciesShare ?? RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
      minUniqueRatio: options.minUniqueRatio ?? RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
      strictUniqueness: false,
      watchThresholds: options.watchThresholds ?? {},
      pendingEvidence: [],
      now,
    });
    cycleResults.push(result);
    if (runBudget.remainingCalls === 0) break;
  }

  // ---- finalize ------------------------------------------------------------
  experiment.counters = accumulateExperimentCounters({
    counters: experiment.counters,
    cycleResults,
    providerRuns,
    proposalsRequested: cycles * proposalsPerCycle,
    proposalsReturned: providerRuns.filter((run) => run.status === PROVIDER_STATUS.OK).length,
  });
  experiment.providerRunIds = providerRuns.map((run) => run.providerRunId);
  experiment.schemaVersion = RESEARCH_EXPERIMENT_VERSION;

  // The precise, unambiguous run-level accounting (Phase 5B.1): distinct from
  // `counters.providerCalls` (every record, including budget refusals).
  experiment.counters.attemptedProviderCalls = runBudget.attemptedCalls;
  experiment.counters.successfulProviderCalls = runBudget.successfulCalls;
  experiment.counters.failedProviderCalls = runBudget.providerFailures;
  experiment.counters.budgetRemaining = runBudget.remainingCalls;
  experiment.counters.callsByCycle = { ...runBudget.callsByCycle };

  const anyProposal = cycleResults.some((result) => (result?.accepted ?? 0) > 0);
  const anyFailure = providerRuns.some((run) => run.status !== PROVIDER_STATUS.OK);
  experiment.status = anyProposal
    ? anyFailure
      ? "COMPLETED_WITH_PROVIDER_FAILURES"
      : "COMPLETED"
    : anyFailure
      ? "PROVIDER_FAILED"
      : "EMPTY";
  experiment.completedAt = new Date(now()).toISOString();

  const providerState = providerStateSummary({
    identity: {
      provider: providerName,
      model: experiment.model,
      reasoning: experiment.reasoning,
      external: provider.offline !== true,
    },
    experimentId,
    cacheEnabled: (options.cacheEnabled ?? envConfig.cacheEnabled) === true,
    runs: providerRuns,
    experiment: experiment.counters,
  });

  await writeResearchExperiment(experimentRoot, experiment);

  return {
    runnerVersion: RESEARCH_COHORT_RUNNER_VERSION,
    experimentId,
    experimentRoot,
    providerRoot: path.join(experimentRoot, "provider"),
    experiment,
    providerState,
    providerRuns,
    cycles: cycleResults,
    evidence,
    evidenceDigest,
    registry: {
      root: experimentRoot,
      proposals: (await listProposals(experimentRoot, { limit: 500 })).length,
      compiled: (await listCompiledCandidates(experimentRoot, { limit: 500 })).length,
    },
  };
}

/**
 * Keep persisted proposal ids unique within one experiment.
 *
 * A model may reuse an id (or reuse a cached identical request). Ids are opaque
 * bookkeeping — never a strategy value — so a collision is disambiguated with a
 * deterministic suffix instead of silently overwriting an earlier proposal in
 * research memory. Genome-level duplicates remain the compiler's job.
 */
export function disambiguateProposalIds(proposals = [], seen = new Set()) {
  const out = [];
  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== "object") {
      out.push(proposal);
      continue;
    }
    const id = typeof proposal.proposalId === "string" ? proposal.proposalId : null;
    if (!id) {
      out.push(proposal);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(proposal);
      continue;
    }
    let suffixed = `${id.slice(0, 52)}.${digestOf({ id, n: seen.size }).slice(0, 4)}`;
    let guard = 0;
    while (seen.has(suffixed) && guard < 16) {
      guard += 1;
      suffixed = `${id.slice(0, 52)}.${digestOf({ id, n: seen.size, guard }).slice(0, 4)}`;
    }
    seen.add(suffixed);
    out.push({ ...proposal, proposalId: suffixed });
  }
  return out;
}

/**
 * Inspect a generated cohort: proposal / uniqueness / species / family / role
 * statistics. Reads persisted artifacts only; it evaluates nothing and changes
 * nothing.
 */
export async function inspectResearchCohort(root) {
  const proposals = await listProposals(root, { limit: 1000 });
  const compiled = await listCompiledCandidates(root, { limit: 1000 });
  const bySpecies = {};
  const byFamily = {};
  const byRole = {};
  const digests = new Set();
  let duplicates = 0;
  for (const entry of compiled) {
    const digest = genomeDigestOf(entry);
    if (!digest) continue;
    if (digests.has(digest)) duplicates += 1;
    digests.add(digest);
    const species = entry?.species ?? "unknown";
    const family = entry?.family ?? "unknown";
    const role = entry?.authorRole ?? "unknown";
    bySpecies[species] = (bySpecies[species] ?? 0) + 1;
    byFamily[family] = (byFamily[family] ?? 0) + 1;
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return {
    root,
    proposals: proposals.length,
    compiled: compiled.length,
    uniqueGenomes: digests.size,
    duplicateGenomes: duplicates,
    uniquenessRatio: compiled.length > 0 ? digests.size / compiled.length : 0,
    speciesDistribution: bySpecies,
    familyDistribution: byFamily,
    roleDistribution: byRole,
    familyCount: Object.keys(byFamily).length,
    speciesCount: Object.keys(bySpecies).length,
    roleCount: Object.keys(byRole).length,
  };
}
