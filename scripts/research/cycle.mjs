/**
 * Controlled recursive research cycle (Phase 5A).
 *
 *   market evidence -> researchers propose -> schema validation ->
 *   deterministic compilation -> candidate genomes -> (caller injects into
 *   the live/replay population) -> watchdog evaluation of what the PREVIOUS
 *   cycle injected -> research memory -> next cycle
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
 * PAPER ONLY research machinery.
 */

import {
  MEMORY_STATUS,
  appendConclusion,
  appendMemoryRecord,
  createMemoryRecord,
  loadPriorConclusions,
  saveCompiledCandidate,
  saveProposal,
} from "./memory.mjs";
import { validateProposal } from "./proposal-schema.mjs";
import { compileProposals } from "./compiler.mjs";
import { evaluateCandidate, WATCHDOG_VERDICT } from "./watchdog.mjs";
import { resolveResearchProvider } from "./provider.mjs";

export const RESEARCH_CYCLE_VERSION = 1;

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
 *   watchThresholds?: object,
 *   pendingEvidence?: Array<object>,  // from simulation.getResearchEvidence()
 *   now?: () => number,
 * }} options
 * @returns {Promise<{
 *   cycle: number,
 *   proposed: number,
 *   rejectedSchema: Array<{proposalId: string, errors: string[]}>,
 *   compiled: Array<object>,
 *   rejectedCompile: Array<{proposalId: string, reasons: string[]}>,
 *   watchdog: Array<{familyId: string, proposalId: string, verdict: string}>,
 *   clearedFamilyIds: string[],
 * }>}
 */
export async function runResearchCycle({
  root,
  evidence,
  cycle = 1,
  seed = "evolve",
  provider = "mock",
  proposalsPerCycle = 6,
  maxCompilations = 3,
  watchThresholds = {},
  pendingEvidence = [],
  now = () => Date.now(),
} = {}) {
  const watchdogReport = [];
  const clearedFamilyIds = [];

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
      conclusion: record.conclusion,
      at: evaluatedAt,
      watchdog: { ...watchdog, status: result.verdict },
    });

    if (!candidateEvidence.alive) clearedFamilyIds.push(candidateEvidence.familyId);
  }

  // 2) Propose: providers only ever see the bounded evidence packet + prior
  // conclusions, never source code or credentials.
  const priorConclusions = await loadPriorConclusions(root);
  const resolvedProvider = resolveResearchProvider(provider);
  const rawProposals = resolvedProvider.propose({
    evidence: { ...evidence, priorConclusions },
    count: proposalsPerCycle,
    seed,
    cycle,
  });

  const rejectedSchema = [];
  const validProposals = [];
  for (const raw of rawProposals) {
    const { ok, errors, proposal } = validateProposal(raw);
    if (!ok) {
      rejectedSchema.push({ proposalId: raw?.proposalId ?? "unknown", errors });
      continue;
    }
    await saveProposal(root, proposal, { status: MEMORY_STATUS.PROPOSED });
    validProposals.push(proposal);
  }

  // 3) Compile: the deterministic compiler — never the provider — decides
  // which genes exist, their ranges, and the species-aware bounds.
  const { compiled, rejected: rejectedCompile } = compileProposals({
    proposals: validProposals,
    maxCompilations,
    now,
  });

  for (const row of rejectedCompile) {
    await appendConclusion(root, {
      proposalId: row.proposalId,
      authorRole: validProposals.find((p) => p.proposalId === row.proposalId)?.authorRole ?? null,
      status: MEMORY_STATUS.REJECTED,
      conclusion: `compiler rejected: ${row.reasons.join("; ")}`,
      at: new Date(now()).toISOString(),
    });
  }

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
      conclusion: "compiled and injected into a live/replay population",
    });
    await appendMemoryRecord(root, record);
  }

  return {
    cycle,
    proposed: rawProposals.length,
    accepted: validProposals.length,
    rejectedSchema,
    compiled,
    rejectedCompile,
    watchdog: watchdogReport,
    watchdogVerdicts: watchdogReport.reduce((acc, entry) => {
      acc[entry.verdict] = (acc[entry.verdict] ?? 0) + 1;
      return acc;
    }, {}),
    clearedFamilyIds,
  };
}
