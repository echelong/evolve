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
  genomeDigestOf,
  speciesConcentrationVerdict,
  speciesDistribution,
  uniqueGenomeRatio,
} from "../research/cohort.mjs";
import { listCompiledCandidates, listProposals } from "../research/memory.mjs";
import { AB_COHORT } from "../research/ab-cohort.mjs";
import { readResearchExperiment, researchExperimentSummary } from "../research/experiment.mjs";

export const RESEARCH_ARENA_MODE = Object.freeze({
  CHALLENGER: "challenger",
  FAIR: "fair",
  // Phase 5A.3: matched, equal-resource research-vs-conventional A/B benchmark.
  // Challenger asks "can fresh research challengers beat mature incumbents?";
  // fair asks "what happens when research ancestry participates under equal
  // evolutionary rules?"; A/B asks "does research-guided INITIALIZATION beat a
  // matched conventional control when both cohorts get identical resources?".
  AB: "ab",
});

export const RESEARCH_IDENTITY = Object.freeze({
  EXACT: "exact",
  DESCENDANT: "descendant",
});

/**
 * Read the persisted research cohort and de-duplicate it by genome digest.
 *
 * Also reads this root's `experiment.json` (Phase 5B), if any, so the
 * experiment/provider/model/reasoning that produced this cohort travels with
 * it into `summarizeResearchCohort`'s `cohort`/`armResearch` blocks — no
 * per-genome plumbing needed, since every genome in one cohort root comes
 * from the SAME one research experiment. Never touches the compiler or the
 * proposal/compiled artifacts themselves.
 */
export async function buildResearchCohort(root, { limit = 500 } = {}) {
  const compiled = await listCompiledCandidates(root, { limit });
  const proposals = await listProposals(root, { limit });
  const { unique, duplicates, uniqueDigests } = dedupeByGenomeDigest(compiled);
  const experiment = await readResearchExperiment(root).catch(() => null);
  const experimentSummary = experiment ? researchExperimentSummary(experiment) : null;
  return {
    proposalsAvailable: proposals.length,
    compiledArtifacts: compiled.length,
    unique,
    duplicates,
    uniqueDigests,
    uniqueCompiledGenomes: unique.length,
    duplicateCompiledGenomes: duplicates.filter((row) => row.reason === "DUPLICATE_GENOME").length,
    experimentId: experimentSummary?.experimentId ?? null,
    provider: experimentSummary?.provider ?? null,
    model: experimentSummary?.model ?? null,
    reasoning: experimentSummary?.reasoning ?? null,
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
  const lineage = row?.lineage ?? null;
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
  const ancestorRoles = [...(research?.researchAncestorRoles ?? ancestry?.roles ?? [])];
  // Phase 5A.3.2: the FULL set of roles that contributed ancestry to this
  // genome — never collapsed to one. A bred child of a `signal-researcher`
  // parent and a `risk-researcher` parent carries BOTH roles here; picking
  // just one (as `authorRole` below does, for legacy single-value display)
  // would fabricate sole authorship that never existed.
  const researchRoles = [
    ...new Set([
      ...(research?.authorRole ? [research.authorRole] : []),
      ...ancestorRoles,
      ...(lineage?.roles ?? []),
    ]),
  ].sort();
  const researchFamilyNames = [
    ...new Set([...(research?.researchFamily ? [research.researchFamily] : []), ...(lineage?.researchFamilies ?? [])]),
  ].sort();
  return {
    isResearch,
    origin: isResearch ? "research" : row?.origin ?? null,
    identity: research?.identity ?? (ancestry ? RESEARCH_IDENTITY.DESCENDANT : null),
    familyId: research?.familyId ?? null,
    proposalId: research?.proposalId ?? null,
    // LEGACY single-value field, kept for backward compatibility: for an
    // exact original this is the true sole author; for a descendant it is
    // only the FIRST ancestor role (alphabetically), never a claim that it is
    // the only contributing role. Prefer `researchRoles` (below) for anything
    // that needs the complete, honest ancestry.
    authorRole: research?.authorRole ?? ancestorRoles[0] ?? null,
    researchFamily: research?.researchFamily ?? null,
    // The complete, non-collapsed role/family ancestry (Phase 5A.3.2). Use
    // these for any report that must not fabricate single-role/-family
    // attribution for a multi-parent descendant.
    researchRoles,
    researchFamilyNames,
    multiRoleAncestry: researchRoles.length > 1,
    targetRegimes: [...(research?.targetRegimes ?? [])],
    abstainRegimes: [...(research?.abstainRegimes ?? [])],
    researchGenomeDigest: research?.researchGenomeDigest ?? null,
    researchAncestorFamilyIds: [
      ...(research?.researchAncestorFamilyIds ?? ancestry?.familyIds ?? []),
    ],
    researchAncestorProposalIds: [
      ...(research?.researchAncestorProposalIds ?? ancestry?.proposalIds ?? []),
    ],
    researchAncestorRoles: ancestorRoles,
    diversified: research?.diversified === true,
    // Phase 5A.3: cohort tag travels with provenance when present, so A/B
    // attribution survives into every artifact. Null outside A/B mode.
    //
    // IMPORTANT: `cohort` (arm membership — "which A/B sandbox this genome
    // evolved in") is a DIFFERENT question from `isResearch` (ancestry —
    // "does this genome trace back to an actual research proposal"). A
    // Research-arm entrant can legitimately have `isResearch: false` if its
    // proposal ancestry went extinct through generations of selection and
    // random immigration — that is an honest evolutionary outcome, not a
    // provenance-tracking failure. Never conflate the two (see
    // `summarizeResearchCohort`'s `armEntrants` vs `researchEntrants`).
    cohort: row?.cohort ?? lineage?.cohort ?? null,
    // Exact-original vs bred-descendant vs immigrant, and generation depth —
    // useful even for arm members with no traceable research ancestry.
    lineageIdentity: lineage?.identity ?? null,
    founderKind: lineage?.founderKind ?? null,
    generation: Number.isFinite(lineage?.generation) ? lineage.generation : null,
    lineageId: row?.lineageId ?? lineage?.lineageId ?? null,
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
 * Count-attribution histogram: every key an entry carries gets +1 — never
 * collapsed to a single "representative" key. This is what makes a
 * multi-parent descendant's role/family distribution honest: a genome bred
 * from a `signal-researcher` parent and a `risk-researcher` parent adds one
 * to EACH role's count, rather than fabricating sole authorship for whichever
 * one happened to sort first.
 */
function multiKeyDistribution(entries, keysOf) {
  const out = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const key of keysOf(entry) ?? []) {
      if (typeof key !== "string" || key.length === 0) continue;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** Per-cohort-arm rollup shared by the research and conventional arm blocks. */
function summarizeArm(rows, { championSet, deploymentSet }) {
  const scores = rows.map((row) => row.score).filter((score) => Number.isFinite(score));
  const ranks = rows.map((row) => row.finalRank).filter((rank) => Number.isFinite(rank));
  const withAncestry = rows.filter((row) => row.provenance.isResearch);
  return {
    entrants: rows.length,
    withResearchAncestryCount: withAncestry.length,
    withoutResearchAncestryCount: rows.length - withAncestry.length,
    speciesDistribution: speciesDistribution(rows.map((row) => ({ species: row.provenance.species ?? row.species }))),
    familyDistribution: multiKeyDistribution(rows, (row) => row.provenance.researchFamilyNames),
    roleDistribution: multiKeyDistribution(rows, (row) => row.provenance.researchRoles),
    multiRoleAncestryCount: rows.filter((row) => row.provenance.multiRoleAncestry).length,
    bestRank: ranks.length > 0 ? Math.min(...ranks) : null,
    medianRank: median(ranks),
    bestScore: scores.length > 0 ? Math.max(...scores) : null,
    medianScore: median(scores),
    top8Count: rows.filter((row) => championSet.has(row.digest)).length,
    top50Count: rows.filter((row) => Number.isFinite(row.finalRank) && row.finalRank <= 50).length,
    groupCount: rows.filter((row) => row.highestStage && row.highestStage !== "QUALIFICATION").length,
    championLeagueCount: rows.filter((row) => championSet.has(row.digest)).length,
    deploymentCount: rows.filter((row) => deploymentSet.has(row.digest)).length,
  };
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

  // ---- A/B ARM membership (Phase 5A.3.2) ------------------------------
  // DISTINCT from research ANCESTRY above. `research` (and every
  // `research*` field above it) answers "how many entrants still carry
  // traceable research-proposal ancestry" — the Phase 5A.2 question, still
  // meaningful in CHALLENGER/FAIR mode where there is no A/B arm at all.
  // `armResearch`/`armConventional` below answer "how many entrants belong
  // to which A/B arm" — the Phase 5A.3 question. An A/B arm entrant can
  // legitimately have zero research ancestry (a random immigrant introduced
  // inside that arm's own evolutionary sandbox, or a descendant whose
  // proposal lineage lost out to one over many generations) while still
  // correctly counting toward that arm's formal size — that is an honest
  // evolutionary outcome, not a provenance-tracking failure. `armResearch`
  // must always equal the formal A/B comparison's own
  // `cohorts.research.arena.entrants` count for the SAME candidate set.
  const hasCohortTags = withProvenance.some((row) => row.provenance.cohort != null);
  const armResearchRows = hasCohortTags
    ? withProvenance.filter((row) => row.provenance.cohort === AB_COHORT.RESEARCH)
    : [];
  const armConventionalRows = hasCohortTags
    ? withProvenance.filter((row) => row.provenance.cohort === AB_COHORT.CONVENTIONAL)
    : [];
  const armAccounting = { championSet, deploymentSet };
  const armResearch = hasCohortTags ? summarizeArm(armResearchRows, armAccounting) : null;
  const armConventional = hasCohortTags ? summarizeArm(armConventionalRows, armAccounting) : null;

  return {
    enabled: Boolean(enabled),
    mode: mode ?? null,
    paperOnly: true,
    // ---- cohort ----------------------------------------------------------
    proposalsAvailable: cohort?.proposalsAvailable ?? 0,
    compiledArtifacts: cohort?.compiledArtifacts ?? 0,
    uniqueCompiledGenomes: cohort?.uniqueCompiledGenomes ?? 0,
    duplicateCompiledGenomes: cohort?.duplicateCompiledGenomes ?? 0,
    // Which research experiment/provider/model produced this cohort (Phase
    // 5A.3.2). One value for the whole cohort, not per-genome: every entrant
    // in `research`/`armResearch` below was compiled from the SAME research
    // experiment root, so this answers "which experiment/provider/model" for
    // all of them at once, without needing per-genome plumbing through the
    // compiler. Null for the canonical offline mock cohort (no experiment.json).
    researchExperimentId: cohort?.experimentId ?? null,
    researchProvider: cohort?.provider ?? null,
    researchModel: cohort?.model ?? null,
    researchReasoning: cohort?.reasoning ?? null,
    // ---- entrants --------------------------------------------------------
    researchEntrants: research.length,
    uniqueResearchEntrants: uniqueDigests.size,
    uniqueRatio: ratio.ratio,
    uniquenessThreshold: uniqueness.threshold,
    uniquenessOk: uniqueness.ok,
    uniquenessWarning: uniqueness.warning,
    speciesDistribution: speciesDistribution(researchSpecies),
    // Phase 5A.3.2: count-attribution, not a collapsed single value — a
    // multi-parent descendant contributes to EVERY family/role its ancestry
    // actually carries (see `researchProvenance`'s `researchFamilyNames` /
    // `researchRoles`). Previously this used `familyDistribution`/
    // `roleDistribution` over the single collapsed `researchFamily`/
    // `authorRole` fields, which silently fabricated sole attribution for
    // any genome with more than one contributing family or role.
    familyDistribution: multiKeyDistribution(research, (row) => row.provenance.researchFamilyNames),
    roleDistribution: multiKeyDistribution(research, (row) => row.provenance.researchRoles),
    multiRoleAncestryCount: research.filter((row) => row.provenance.multiRoleAncestry).length,
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
    // ---- A/B arm membership (Phase 5A.3.2) --------------------------------
    // Null outside A/B mode (no candidate carries a `cohort` tag). Inside A/B
    // mode, `armResearch.entrants` is the number that must agree with the
    // formal A/B comparison's `cohorts.research.arena.entrants` — see the
    // note above `armResearch`'s computation for why it can differ from
    // `researchEntrants`.
    armResearch,
    armConventional,
    // ---- supporting roll-ups --------------------------------------------
    roleMetrics: roleMetrics ?? null,
    accounting: accounting ?? null,
    note:
      "Research entrants (`research*` fields) are genomes with TRACEABLE RESEARCH-PROPOSAL ANCESTRY, evaluated by the same funnel and gates as everyone else — no research-only bonus exists, and zero research survivors remains an acceptable outcome. In A/B mode this is NOT the same as A/B arm membership: `armResearch`/`armConventional` report the two experiment arms, and an arm entrant can legitimately carry zero research ancestry (an in-arm random immigrant, or a descendant whose proposal lineage went extinct through selection) while still correctly belonging to that arm.",
  };
}
