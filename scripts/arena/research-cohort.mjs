/**
 * Arena research cohort (Phase 5A.2).
 *
 * The first real Research Arena exposed three problems this module exists to
 * fix:
 *
 *   1. `--research` added EVERY persisted compiled genome as an entrant, so
 *      duplicate compiles consumed duplicate Arena slots. The cohort is now
 *      de-duplicated by `digestOf(genome)` before it ever reaches a slot.
 *   2. Research provenance had to be reconstructed from digests afterwards.
 *      Provenance is now first-class on the entrant and travels with it into
 *      candidates.json, leaderboard.json, deployment candidates, and the
 *      summary.
 *   3. There was no way to compare research against conventional candidates
 *      under equal evolutionary treatment. FAIR COHORT mode does that without
 *      ever cloning a genome to fill a quota.
 *
 * Nothing here trades, signs, or executes anything. PAPER ONLY.
 */

import {
  RESEARCH_COHORT_DEFAULTS,
  cohortUniquenessVerdict,
  dedupeByGenomeDigest,
  familyDistribution,
  genomeDigestOf,
  roleDistribution,
  speciesConcentrationVerdict,
  speciesDistribution,
  uniqueGenomeRatio,
} from "../research/cohort.mjs";
import { listCompiledCandidates, listProposals } from "../research/memory.mjs";

export const RESEARCH_ARENA_MODE = Object.freeze({
  CHALLENGER: "challenger",
  FAIR: "fair",
});

export const RESEARCH_IDENTITY = Object.freeze({
  EXACT: "exact",
  DESCENDANT: "descendant",
});

/** Read the persisted research cohort and de-duplicate it by genome digest. */
export async function buildResearchCohort(root, { limit = 500 } = {}) {
  const compiled = await listCompiledCandidates(root, { limit });
  const proposals = await listProposals(root, { limit });
  const { unique, duplicates, uniqueDigests } = dedupeByGenomeDigest(compiled);
  return {
    proposalsAvailable: proposals.length,
    compiledArtifacts: compiled.length,
    unique,
    duplicates,
    uniqueDigests,
    uniqueCompiledGenomes: unique.length,
    duplicateCompiledGenomes: duplicates.filter((row) => row.reason === "DUPLICATE_GENOME").length,
  };
}

/** Provenance meta stored on a research entrant (exact original genome). */
export function exactResearchMeta(entry) {
  const digest = genomeDigestOf(entry);
  return {
    origin: "research",
    identity: RESEARCH_IDENTITY.EXACT,
    familyId: entry?.familyId ?? null,
    proposalId: entry?.proposalId ?? null,
    authorRole: entry?.authorRole ?? null,
    researchFamily: entry?.family ?? null,
    targetRegimes: [...(entry?.targetRegimes ?? [])],
    abstainRegimes: [...(entry?.abstainRegimes ?? [])],
    researchGenomeDigest: digest,
    species: entry?.species ?? null,
    diversified: entry?.diversified === true,
  };
}

/** Turn de-duplicated compiled candidates into Arena entrants. */
export function researchEntrantsFromCohort(uniqueEntries = []) {
  return uniqueEntries.map((entry) => ({
    genome: entry.genome,
    species: entry.species ?? "Experimental",
    origin: "research",
    digest: genomeDigestOf(entry),
    research: exactResearchMeta(entry),
  }));
}

/**
 * Merge research ancestry from any number of parents. Returns null when no
 * parent carries research ancestry, so conventional lineages stay conventional.
 */
export function mergeResearchAncestry(...parents) {
  const familyIds = new Set();
  const proposalIds = new Set();
  const digests = new Set();
  const roles = new Set();
  for (const parent of parents) {
    if (!parent) continue;
    const meta = parent.research ?? null;
    const ancestry = parent.researchAncestry ?? null;
    if (meta) {
      if (meta.familyId) familyIds.add(meta.familyId);
      if (meta.proposalId) proposalIds.add(meta.proposalId);
      if (meta.researchGenomeDigest) digests.add(meta.researchGenomeDigest);
      if (meta.authorRole) roles.add(meta.authorRole);
    }
    for (const id of ancestry?.familyIds ?? meta?.researchAncestorFamilyIds ?? []) familyIds.add(id);
    for (const id of ancestry?.proposalIds ?? meta?.researchAncestorProposalIds ?? []) proposalIds.add(id);
    for (const role of ancestry?.roles ?? meta?.researchAncestorRoles ?? []) roles.add(role);
  }
  if (familyIds.size === 0 && proposalIds.size === 0) return null;
  return {
    familyIds: [...familyIds].sort(),
    proposalIds: [...proposalIds].sort(),
    digests: [...digests].sort(),
    roles: [...roles].sort(),
  };
}

/**
 * Provenance for a MUTATED DESCENDANT of a research seed. It is explicitly NOT
 * labelled as an exact original research genome: the exact digest is dropped
 * and only ancestry is preserved.
 */
export function descendantResearchMeta(ancestry) {
  if (!ancestry) return null;
  return {
    origin: "research",
    identity: RESEARCH_IDENTITY.DESCENDANT,
    // A bred child is NOT the original research genome: no family id, no
    // proposal id, no exact digest. Only ancestry survives.
    familyId: null,
    proposalId: null,
    authorRole: null,
    researchFamily: null,
    targetRegimes: [],
    abstainRegimes: [],
    researchGenomeDigest: null,
    researchAncestorFamilyIds: [...(ancestry.familyIds ?? [])],
    researchAncestorProposalIds: [...(ancestry.proposalIds ?? [])],
    // Lineage attribution only — "whose hypothesis does this descendant come
    // from", never "who authored this exact genome".
    researchAncestorRoles: [...(ancestry.roles ?? [])],
  };
}

/**
 * Normalize provenance from an entrant / candidate row / leaderboard row.
 *
 * Idempotent: a row that already carries a normalized provenance object is
 * classified from that object's own `isResearch` flag, so re-normalizing a
 * conventional row never turns it into a research row.
 */
export function researchProvenance(row) {
  const research = row?.research ?? null;
  const ancestry = row?.researchAncestry ?? null;
  const hasExactFields = Boolean(research?.familyId || research?.proposalId || research?.researchGenomeDigest);
  const hasAncestorFields = Boolean(
    (research?.researchAncestorFamilyIds ?? []).length || (research?.researchAncestorProposalIds ?? []).length,
  );
  const isResearch =
    research?.isResearch === true ||
    (!research && row?.origin === "research") ||
    Boolean(ancestry) ||
    hasExactFields ||
    hasAncestorFields;
  return {
    isResearch,
    origin: isResearch ? "research" : row?.origin ?? null,
    identity: research?.identity ?? (ancestry ? RESEARCH_IDENTITY.DESCENDANT : null),
    familyId: research?.familyId ?? null,
    proposalId: research?.proposalId ?? null,
    // For an exact original this is the author; for a descendant it is the
    // ANCESTOR role (lineage attribution), with `identity` distinguishing them.
    authorRole: research?.authorRole ?? (research?.researchAncestorRoles ?? [])[0] ?? null,
    researchFamily: research?.researchFamily ?? null,
    targetRegimes: [...(research?.targetRegimes ?? [])],
    abstainRegimes: [...(research?.abstainRegimes ?? [])],
    researchGenomeDigest: research?.researchGenomeDigest ?? null,
    researchAncestorFamilyIds: [
      ...(research?.researchAncestorFamilyIds ?? ancestry?.familyIds ?? []),
    ],
    researchAncestorProposalIds: [
      ...(research?.researchAncestorProposalIds ?? ancestry?.proposalIds ?? []),
    ],
    researchAncestorRoles: [...(research?.researchAncestorRoles ?? ancestry?.roles ?? [])],
    diversified: research?.diversified === true,
  };
}

/**
 * Compose an FAIR COHORT: research seeds and conventional entrants of a
 * requested size, each retaining lineage, with NO cloning to fill shortfalls.
 *
 * @param {{
 *   population: number,
 *   researchEntrants: object[],     // de-duplicated, provenance-carrying
 *   conventionalEntrants: object[], // already built to the requested size
 *   researchShare: number,          // 0..1
 * }} options
 */
export function composeFairCohort({
  population,
  researchEntrants = [],
  conventionalEntrants = [],
  researchShare = 0.5,
} = {}) {
  const total = Math.max(0, Math.round(population));
  const share = Math.min(1, Math.max(0, Number.isFinite(researchShare) ? researchShare : 0.5));
  const requestedResearch = Math.round(total * share);
  const researchSlots = Math.min(requestedResearch, researchEntrants.length);
  const shortage = Math.max(0, requestedResearch - researchEntrants.length);

  const chosenResearch = researchEntrants.slice(0, researchSlots);
  // Missing research quota is given to CONVENTIONAL entrants — never filled by
  // cloning a research genome, which would fake lineage diversity.
  const conventionalSlots = Math.max(0, total - chosenResearch.length);
  const chosenConventional = conventionalEntrants.slice(0, conventionalSlots);

  return {
    entrants: [...chosenResearch, ...chosenConventional],
    accounting: {
      requestedPopulation: total,
      requestedResearchShare: share,
      requestedResearchSeeds: requestedResearch,
      startingResearchSeeds: chosenResearch.length,
      startingConventionalSeeds: chosenConventional.length,
      researchShortage: shortage,
      clonedToFillQuota: 0,
      note:
        "FAIR COHORT: research and conventional entrants receive identical pre-evolution, datasets, seeds, stress profiles, scoring, and gates. Shortfalls are reported, never padded by cloning.",
    },
  };
}

/** Median of a numeric list (0 for empty input). */
function median(values) {
  const finite = (values ?? []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return finite[Math.floor(finite.length / 2)];
}

/**
 * The Arena `researchSummary` block. Every count is derived from the actual
 * entrant and candidate rows of this run — nothing is inferred from a status
 * string.
 *
 * @param {{
 *   enabled: boolean,
 *   mode: string|null,
 *   cohort: object|null,
 *   candidates: object[],           // ALL candidate rows of this run
 *   championLeagueDigests?: Iterable<string>,
 *   deploymentDigests?: Iterable<string>,
 *   minUniqueRatio?: number,
 *   maxSpeciesShare?: number,
 *   accounting?: object|null,       // fair-mode accounting
 *   roleMetrics?: object|null,
 * }} options
 */
export function summarizeResearchCohort({
  enabled = false,
  mode = null,
  cohort = null,
  candidates = [],
  championLeagueDigests = [],
  deploymentDigests = [],
  minUniqueRatio = RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
  maxSpeciesShare = RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
  accounting = null,
  roleMetrics = null,
} = {}) {
  const withProvenance = (Array.isArray(candidates) ? candidates : []).map((row) => ({
    ...row,
    provenance: researchProvenance(row),
  }));
  const research = withProvenance.filter((row) => row.provenance.isResearch);

  const digests = research.map((row) => row.digest).filter((digest) => typeof digest === "string");
  const uniqueDigests = new Set(digests);
  const uniqueness = cohortUniquenessVerdict({
    uniqueDigests: uniqueDigests.size,
    acceptedEntrants: research.length,
    minUniqueRatio,
  });
  const concentration = speciesConcentrationVerdict({
    entries: research.map((row) => ({ species: row.species })),
    total: research.length,
    maxSpeciesShare,
  });

  const championSet = new Set(championLeagueDigests ?? []);
  const deploymentSet = new Set(deploymentDigests ?? []);
  const scores = research.map((row) => row.score).filter((score) => Number.isFinite(score));
  const ranks = research.map((row) => row.finalRank).filter((rank) => Number.isFinite(rank));
  const researchSpecies = research.map((row) => ({ species: row.provenance.species ?? row.species }));

  const failedGateCounts = {};
  for (const row of research) {
    for (const gate of row.failedGates ?? []) failedGateCounts[gate] = (failedGateCounts[gate] ?? 0) + 1;
  }

  const gatePassed = research.filter((row) => row.gateStatus === "GATES_PASSED");
  const exactOriginalSurvivors = gatePassed.filter((row) => row.provenance.identity === RESEARCH_IDENTITY.EXACT).length;
  const descendantSurvivors = gatePassed.filter((row) => row.provenance.identity === RESEARCH_IDENTITY.DESCENDANT).length;

  const ratio = uniqueGenomeRatio({ uniqueDigests: uniqueDigests.size, acceptedEntrants: research.length });

  return {
    enabled: Boolean(enabled),
    mode: mode ?? null,
    paperOnly: true,
    // ---- cohort ----------------------------------------------------------
    proposalsAvailable: cohort?.proposalsAvailable ?? 0,
    compiledArtifacts: cohort?.compiledArtifacts ?? 0,
    uniqueCompiledGenomes: cohort?.uniqueCompiledGenomes ?? 0,
    duplicateCompiledGenomes: cohort?.duplicateCompiledGenomes ?? 0,
    // ---- entrants --------------------------------------------------------
    researchEntrants: research.length,
    uniqueResearchEntrants: uniqueDigests.size,
    uniqueRatio: ratio.ratio,
    uniquenessThreshold: uniqueness.threshold,
    uniquenessOk: uniqueness.ok,
    uniquenessWarning: uniqueness.warning,
    speciesDistribution: speciesDistribution(researchSpecies),
    familyDistribution: familyDistribution(
      research.map((row) => ({ family: row.provenance.researchFamily })),
    ),
    roleDistribution: roleDistribution(research.map((row) => ({ authorRole: row.provenance.authorRole }))),
    concentration: {
      ok: concentration.ok,
      share: concentration.share,
      threshold: concentration.threshold,
      topSpecies: concentration.topSpecies,
      warning: concentration.warning,
    },
    // ---- performance (paper) --------------------------------------------
    bestResearchRank: ranks.length > 0 ? Math.min(...ranks) : null,
    medianResearchRank: median(ranks),
    bestResearchScore: scores.length > 0 ? Math.max(...scores) : null,
    medianResearchScore: median(scores),
    researchTop8Count: research.filter((row) => championSet.has(row.digest)).length,
    researchTop50Count: research.filter((row) => Number.isFinite(row.finalRank) && row.finalRank <= 50).length,
    researchGroupCount: research.filter((row) => row.highestStage && row.highestStage !== "QUALIFICATION").length,
    researchChampionLeagueCount: research.filter((row) => championSet.has(row.digest)).length,
    researchDeploymentCount: research.filter((row) => deploymentSet.has(row.digest)).length,
    failedGateCounts,
    exactOriginalResearchSurvivors: exactOriginalSurvivors,
    descendantResearchSurvivors: descendantSurvivors,
    // ---- supporting roll-ups --------------------------------------------
    roleMetrics: roleMetrics ?? null,
    accounting: accounting ?? null,
    note:
      "Research entrants are PAPER hypotheses evaluated by the same funnel and gates as everyone else. No research-only bonus exists, and zero research survivors remains an acceptable outcome.",
  };
}
