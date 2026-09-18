/**
 * Controlled recursive research cycle (Phase 5A / 5A.2).
 *
 *   market evidence -> researchers propose -> schema validation ->
 *   deterministic compilation (genome-digest uniqueness enforced) ->
 *   candidate genomes -> (caller injects into the live/replay population) ->
 *   watchdog evaluation of what the PREVIOUS cycle injected -> research memory
 *   -> next cycle
 *
 * This module is deliberately I/O-light and simulation-agnostic: it takes an
 * evidence packet and a list of evidence records for candidates the caller is
 * currently tracking, and returns compiled genome candidates for the caller
 * to inject. It never touches a population, a genome bank, or the Arena
 * directly — "Research agents propose. Deterministic EVOLVE machinery
 * evaluates. Champion Arena decides," and this module is the "propose" half.
 *
 * Promotion to PROMISING / ARENA_SURVIVOR / SHADOW_ELIGIBLE never happens
 * here — see research/promote.mjs, which only ever upgrades a memory record
 * in response to an actual Arena result. A research cycle can only reach
 * PROPOSED, TESTING, or REJECTED; it cannot self-promote.
 *
 * Phase 5A.2: every step now records an explicit lifecycle OUTCOME
 * (REJECTED_SCHEMA / REJECTED_COMPILER / REJECTED_DUPLICATE / COMPILED /
 * TESTING / WATCH / QUARANTINED) alongside the coarse status, and a compiled
 * genome already present in the persisted cohort is never silently re-added.
 *
 * PAPER ONLY research machinery.
 */

import {
  MEMORY_OUTCOME,
  MEMORY_STATUS,
  appendConclusion,
  appendMemoryRecord,
  createMemoryRecord,
  listCompiledCandidates,
  loadPriorConclusions,
  roleResearchMetrics,
  saveCompiledCandidate,
  saveProposal,
} from "./memory.mjs";
import { validateProposal } from "./proposal-schema.mjs";
import { DUPLICATE_GENOME, PROPOSAL_COMPILER_VERSION, compileProposals } from "./compiler.mjs";
import { evaluateCandidate, WATCHDOG_VERDICT } from "./watchdog.mjs";
import { resolveResearchProvider } from "./provider.mjs";
import {
  RESEARCH_COHORT_DEFAULTS,
  cohortUniquenessVerdict,
  genomeDigestOf,
  roleDistribution,
  speciesDistribution,
} from "./cohort.mjs";

export const RESEARCH_CYCLE_VERSION = 2;

/**
 * Build the bounded, structured evidence packet researchers see, from a
 * simulation snapshot plus prior research memory. Plain data only.
 */
export function buildEvidencePacket({ snapshot, islands = [], priorConclusions = [], cycle = 1 }) {
  const species = Array.isArray(snapshot?.species) ? snapshot.species : [];
  const regimeDistribution = {};
  // `researchRegime` uses the same Arena-vocabulary classifier (REGIMES in
  // arena/orchestrator.mjs) that proposal-schema.mjs validates targetRegimes
  // against — the coarser `marketRegime` label ("RISK-ON"/"CHOP"/…) is a
  // different, dashboard-only vocabulary and must never leak into a proposal.
  const regime = typeof snapshot?.researchRegime === "string" ? snapshot.researchRegime : null;
  // "unknown" is the classifier's own not-enough-data sentinel, never a
  // member of REGIMES — must never be offered as a proposal target.
  if (regime && regime !== "unknown") regimeDistribution[regime] = 1;

  const costs = Number(snapshot?.paper?.costs ?? 0);
  const startingCash = Number(snapshot?.paper?.startingCash ?? 1) || 1;
  const populationSize = Number(snapshot?.stats?.population ?? 1) || 1;

  return {
    researchCycle: cycle,
    regime,
    regimeDistribution,
    islandStats: islands.map((island) => ({
      name: island.name,
      population: island.population,
      target: island.target,
      avgReturn: island.avgReturn,
      trades: island.trades,
      extinct: island.extinct,
    })),
    speciesStats: species.map((row) => ({
      name: row.name,
      count: row.count,
      avgReturn: row.avgReturn,
      trades: row.trades,
    })),
    familyStats: [],
    topGenomes: Array.isArray(snapshot?.topAgents)
      ? snapshot.topAgents.slice(0, 5).map((agent) => ({ species: agent.species, fitness: agent.fitness }))
      : [],
    costSummary: {
      meanCostDrag: costs / (populationSize * startingCash),
      meanMaxDrawdown:
        species.length > 0 ? 0 : 0, // per-agent drawdown is not aggregated at species level; kept 0 (documented, never fabricated)
      meanHoldTicks: 0,
    },
    failureSummary: { failedGates: {}, rejectedBeforeEvaluation: 0 },
    priorConclusions,
  };
}

/** Digest every compiled candidate already persisted for this cohort. */
async function loadExistingCompiledDigests(root) {
  const existing = await listCompiledCandidates(root, { limit: 500 });
  const digests = new Set();
  const byDigest = new Map();
  for (const entry of existing) {
    const digest = genomeDigestOf(entry);
    if (!digest) continue;
    digests.add(digest);
    if (!byDigest.has(digest)) byDigest.set(digest, entry);
  }
  return { digests: [...digests], byDigest };
}

/**
 * Run one research cycle: evaluate what the previous cycle injected, then
 * propose + validate + compile the next batch.
 *
 * @param {{
 *   root: string,
 *   evidence: object,
 *   cycle: number,
 *   seed: string,
 *   provider?: string,
 *   proposalsPerCycle?: number,
 *   maxCompilations?: number,
 *   maxSpeciesShare?: number,
 *   minUniqueRatio?: number,
 *   strictUniqueness?: boolean,
 *   watchThresholds?: object,
 *   pendingEvidence?: Array<object>,  // from simulation.getResearchEvidence()
 *   now?: () => number,
 * }} options
 */
export async function runResearchCycle({
  root,
  evidence,
  cycle = 1,
  seed = "evolve",
  provider = "mock",
  proposalsPerCycle = 6,
  maxCompilations = 3,
  maxSpeciesShare = RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
  minUniqueRatio = RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
  strictUniqueness = false,
  watchThresholds = {},
  pendingEvidence = [],
  now = () => Date.now(),
} = {}) {
  const watchdogReport = [];
  const clearedFamilyIds = [];
  const outcomes = {};
  const bump = (key, count = 1) => {
    outcomes[key] = (outcomes[key] ?? 0) + count;
  };

  // 1) Evaluate whatever the previous cycle(s) are still tracking. A
  // candidate needs at least a few trades before its watchdog verdict means
  // anything; thin evidence is left TESTING rather than judged prematurely.
  for (const candidateEvidence of pendingEvidence) {
    if (!candidateEvidence?.familyId) continue;
    const minTrades = Number.isFinite(watchThresholds.minTrades) ? watchThresholds.minTrades : 8;
    if ((candidateEvidence.trades ?? 0) < Math.min(3, minTrades)) continue; // not enough to say anything yet

    const result = evaluateCandidate(candidateEvidence, watchThresholds);
    const evaluatedAt = new Date(now()).toISOString();
    // Structured, queryable watchdog evidence — attached to the memory record
    // (and the conclusion) so "which candidates are QUARANTINED and why" never
    // requires parsing the human-readable conclusion sentence.
    const watchdog = {
      status: result.verdict,
      flags: result.flags,
      trades: candidateEvidence.trades ?? 0,
      evaluatedAt,
    };
    watchdogReport.push({
      familyId: candidateEvidence.familyId,
      proposalId: candidateEvidence.proposalId,
      verdict: result.verdict,
      flags: result.flags.map((f) => f.flag),
      tradeCount: candidateEvidence.trades ?? 0,
      evaluatedAt,
    });

    // A research cycle may only ever leave PROPOSED / TESTING / REJECTED.
    // QUARANTINED restricts (it blocks promotion and further injection); it is
    // deliberately NOT a rejection, so the record stays TESTING and the verdict
    // lives in structured watchdog evidence. Promotion stays Arena-gated.
    const status = MEMORY_STATUS.TESTING;
    const outcome =
      result.verdict === WATCHDOG_VERDICT.QUARANTINED
        ? MEMORY_OUTCOME.QUARANTINED
        : result.verdict === WATCHDOG_VERDICT.WATCH
          ? MEMORY_OUTCOME.WATCH
          : MEMORY_OUTCOME.TESTING;
    bump(outcome);

    const record = createMemoryRecord({
      proposalId: candidateEvidence.proposalId,
      authorRole: candidateEvidence.authorRole,
      hypothesis: candidateEvidence.hypothesis ?? "",
      candidateFamily: candidateEvidence.familyId,
      tradeCount: candidateEvidence.trades,
      distinctMints: candidateEvidence.distinctMints,
      medianOosReturn: null,
      worstOosReturn: null,
      drawdown: candidateEvidence.maxDrawdown,
      costDrag: candidateEvidence.costDrag,
      status,
      outcome,
      watchdog,
      evaluatedAt,
      conclusion:
        result.verdict === WATCHDOG_VERDICT.QUARANTINED
          ? `QUARANTINED: ${result.flags.map((f) => f.flag).join(", ")}`
          : `watchdog ${result.verdict.toLowerCase()} after ${candidateEvidence.trades ?? 0} trades`,
    });

    await appendMemoryRecord(root, record);
    await appendConclusion(root, {
      proposalId: candidateEvidence.proposalId,
      authorRole: candidateEvidence.authorRole,
      status,
      outcome,
      conclusion: record.conclusion,
      at: evaluatedAt,
      watchdog: { ...watchdog, status: result.verdict },
    });

    if (!candidateEvidence.alive) clearedFamilyIds.push(candidateEvidence.familyId);
  }

  // 2) Propose: providers only ever see the bounded evidence packet + prior
  // conclusions, never source code or credentials.
  const priorConclusions = await loadPriorConclusions(root);
  // A provider is anything with a `propose` function: the built-in offline
  // mock by name, or an explicitly injected provider object (used by tests to
  // drive specific cohorts deterministically).
  const resolvedProvider =
    typeof provider?.propose === "function" ? provider : resolveResearchProvider(provider);
  // Phase 5B: a provider may be asynchronous (an external model call) or
  // synchronous (the offline mock). `await` accepts both, so the cycle code has
  // no idea which kind it is talking to — which is the point.
  const rawProposals = await resolvedProvider.propose({
    evidence: { ...evidence, priorConclusions },
    count: proposalsPerCycle,
    seed,
    cycle,
  });
  const rawList = Array.isArray(rawProposals) ? rawProposals : [];
  bump(MEMORY_OUTCOME.PROPOSED, rawList.length);

  const rejectedSchema = [];
  const validProposals = [];
  for (const raw of rawList) {
    const { ok, errors, proposal } = validateProposal(raw);
    if (!ok) {
      const proposalId = raw?.proposalId ?? "unknown";
      rejectedSchema.push({ proposalId, errors });
      bump(MEMORY_OUTCOME.REJECTED_SCHEMA);
      // Explicit lifecycle: a schema rejection is remembered, so researchers
      // can see (and avoid) the region rather than rediscovering it.
      const schemaAt = new Date(now()).toISOString();
      await appendMemoryRecord(
        root,
        createMemoryRecord({
          proposalId,
          authorRole: typeof raw?.authorRole === "string" ? raw.authorRole : null,
          hypothesis: typeof raw?.hypothesis === "string" ? raw.hypothesis : "",
          status: MEMORY_STATUS.REJECTED,
          outcome: MEMORY_OUTCOME.REJECTED_SCHEMA,
          conclusion: `schema rejected: ${errors.join("; ")}`,
          evaluatedAt: schemaAt,
        }),
      );
      await appendConclusion(root, {
        proposalId,
        authorRole: typeof raw?.authorRole === "string" ? raw.authorRole : null,
        status: MEMORY_STATUS.REJECTED,
        outcome: MEMORY_OUTCOME.REJECTED_SCHEMA,
        conclusion: `schema rejected: ${errors.join("; ")}`,
        at: schemaAt,
      });
      continue;
    }
    await saveProposal(root, proposal, { status: MEMORY_STATUS.PROPOSED });
    validProposals.push(proposal);
  }

  // 3) Compile: the deterministic compiler — never the provider — decides
  // which genes exist, their ranges, the species-aware bounds, and
  // (Phase 5A.2) whether a compiled genome is genuinely NEW to this cohort.
  const existing = await loadExistingCompiledDigests(root);
  const { compiled, rejected: rejectedCompile, stats: compileStats } = compileProposals({
    proposals: validProposals,
    maxCompilations,
    maxSpeciesShare,
    existingDigests: existing.digests,
    now,
  });

  const rejectedDuplicates = rejectedCompile.filter((row) => row.code === DUPLICATE_GENOME);
  for (const row of rejectedCompile) {
    const outcome = row.code === DUPLICATE_GENOME ? MEMORY_OUTCOME.REJECTED_DUPLICATE : MEMORY_OUTCOME.REJECTED_COMPILER;
    bump(outcome);
    const authorRole = validProposals.find((p) => p.proposalId === row.proposalId)?.authorRole ?? null;
    const conclusion = `${outcome.toLowerCase().replace(/_/g, " ")}: ${row.reasons.join("; ")}`;
    const rejectedAt = new Date(now()).toISOString();
    // Duplicate rejection (and compiler rejection) is RECORDED, not silent.
    await appendMemoryRecord(
      root,
      createMemoryRecord({
        proposalId: row.proposalId,
        authorRole,
        hypothesis: "",
        status: MEMORY_STATUS.REJECTED,
        outcome,
        conclusion,
        evaluatedAt: rejectedAt,
      }),
    );
    await appendConclusion(root, {
      proposalId: row.proposalId,
      authorRole,
      status: MEMORY_STATUS.REJECTED,
      outcome,
      conclusion,
      at: rejectedAt,
    });
  }

  const roleDistributionInCycle = roleDistribution(compiled);
  for (const entry of compiled) {
    await saveCompiledCandidate(root, entry);
    const proposal = validProposals.find((p) => p.proposalId === entry.proposalId);
    const record = createMemoryRecord({
      proposalId: entry.proposalId,
      authorRole: entry.authorRole,
      hypothesis: proposal?.hypothesis ?? "",
      candidateFamily: entry.familyId,
      regimesTested: entry.targetRegimes,
      status: MEMORY_STATUS.TESTING,
      outcome: MEMORY_OUTCOME.COMPILED,
      conclusion: entry.diversified
        ? `compiled (deterministically diversified inside the proposal's declared range) and injected into a live/replay population`
        : "compiled and injected into a live/replay population",
    });
    // Carry the canonical identity + provenance onto the memory record.
    record.genomeDigest = entry.genomeDigest ?? genomeDigestOf(entry);
    record.species = entry.species ?? null;
    record.family = entry.family ?? null;
    record.diversified = entry.diversified === true;
    await appendMemoryRecord(root, record);
    bump(MEMORY_OUTCOME.COMPILED);
  }

  const acceptedEntrants = compiled.length;
  const uniqueDigests = new Set(compiled.map((entry) => entry.genomeDigest)).size;
  const uniqueness = cohortUniquenessVerdict({
    uniqueDigests,
    acceptedEntrants,
    minUniqueRatio,
    strict: strictUniqueness,
  });

  const roleMetrics = roleResearchMetrics({
    proposals: validProposals.map((proposal) => ({ proposal })),
    compiled,
  });

  return {
    cycle,
    version: RESEARCH_CYCLE_VERSION,
    compilerVersion: PROPOSAL_COMPILER_VERSION,
    // Which provider authored this cycle (provenance; never a credential).
    provider: typeof resolvedProvider?.name === "string" ? resolvedProvider.name : null,
    model: typeof resolvedProvider?.model === "string" ? resolvedProvider.model : null,
    reasoning: typeof resolvedProvider?.reasoning === "string" ? resolvedProvider.reasoning : null,
    providerOffline: resolvedProvider?.offline === true,
    proposed: rawList.length,
    accepted: validProposals.length,
    rejectedSchema,
    rejectedCompile,
    rejectedDuplicates: rejectedDuplicates.length,
    compiled,
    watchdog: watchdogReport,
    watchdogVerdicts: watchdogReport.reduce((acc, entry) => {
      acc[entry.verdict] = (acc[entry.verdict] ?? 0) + 1;
      return acc;
    }, {}),
    clearedFamilyIds,
    outcomes,
    roleMetrics,
    roleDistribution: roleDistributionInCycle,
    speciesDistribution: speciesDistribution(compiled),
    uniqueGenomes: uniqueDigests,
    duplicateGenomes: Math.max(0, acceptedEntrants - uniqueDigests) + rejectedDuplicates.length,
    uniqueRatio: uniqueness.ratio,
    uniquenessThreshold: uniqueness.threshold,
    uniquenessVerdict: uniqueness,
    compileStats,
  };
}
