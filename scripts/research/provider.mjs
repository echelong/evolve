/**
 * Research provider abstraction (Phase 5A).
 *
 * Researchers are role-bound strategists that turn structured market evidence
 * into structured proposal objects. The provider interface is deliberately
 * narrow:
 *
 *   - providers receive EVIDENCE PACKETS (plain, bounded data structures) and
 *     a bounded number of proposal slots
 *   - providers return RAW proposal-shaped objects, which are then validated
 *     by the strict schema, compiled by the deterministic compiler, and only
 *     then become genome candidates
 *   - providers are sandboxed by construction: they never receive source code,
 *     never receive raw market payloads, and their output can never execute
 *
 * The default provider is a deterministic, offline, no-LLM mock: it derives
 * proposals from the evidence packet with pure functions, so Phase 5A runs and
 * the whole validation suite work with no API key and no network. An external
 * provider (if ever configured) implements the same interface; its credentials
 * stay in the environment, server-side only (see market/config.mjs).
 *
 * Phase 5A.2: the mock provider is now *species- and role-aware*, because the
 * first real Research Arena showed every compiled candidate collapsing into the
 * Momentum family. Two causes were fixed here and in the compiler:
 *
 *   1. the provider's first three slots were always routed to the three
 *      Momentum-affine roles, and the compiler stopped after its compilation
 *      cap — so only Momentum families ever compiled;
 *   2. roles had no way to reach Wallet Flow, Liquidity, or Experimental.
 *
 * Role output is still derived from evidence, never from a hardcoded balanced
 * list: the same evidence produces the same proposals, different evidence
 * produces different ones, and when evidence is silent each role falls back to
 * a deterministic rotation that covers all six species.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { PROPOSAL_SCHEMA_VERSION, RESEARCHER_ROLES } from "./proposal-schema.mjs";
import { CANDIDATE_FAMILIES, FAMILY_NAMES } from "../engine/families.mjs";
import { SPECIES } from "../engine/genome.mjs";
import { REGIMES } from "../arena/orchestrator.mjs";
import { createDeepSeekClineProvider } from "./providers/deepseek-cline.mjs";
import { UnknownResearchProviderError, requireProviderName, validateProviderName } from "./provider-config.mjs";

export { UnknownResearchProviderError, unknownProviderMessage, requireProviderName } from "./provider-config.mjs";

export const RESEARCH_PROVIDER_VERSION = 3;

export const PROVIDERS = Object.freeze({
  mock: "mock", // deterministic, offline, no LLM — the default
  // Phase 5B: DeepSeek V4.1 Flash through the locally installed Cline CLI.
  // OPTIONAL and explicitly selected; never a fallback target.
  "deepseek-cline": "deepseek-cline",
});

/**
 * Roles that observe and criticize but do NOT originate compilable proposals.
 *
 * The adversarial critic is advisory-only by design: its job is to falsify
 * other researchers' hypotheses, and Phase 5A has no execution surface for
 * "a criticism" to compile into. It therefore contributes to the evidence
 * packet / review narrative, never to the compiled candidate set. Documented
 * here and in the README rather than left implicit.
 */
export const ADVISORY_ROLES = Object.freeze(["adversarial-critic"]);

/** Roles that can originate a compilable proposal. */
export const PROPOSING_ROLES = Object.freeze(
  RESEARCHER_ROLES.filter((role) => !ADVISORY_ROLES.includes(role)),
);

/** Regime → the species whose evidence the regime hypothesis is about. */
const REGIME_SPECIES = Object.freeze({
  "strong-risk-on": "Momentum",
  "weak-risk-on": "Momentum",
  "sideways-chop": "Reversal",
  "high-volatility": "Wallet Flow",
  "liquidity-expansion": "Liquidity",
  "liquidity-contraction": "Reversal",
  "broad-selloff": "Reversal",
  "launch-heavy": "Genesis Hunter",
  "low-activity": "Experimental",
});

/**
 * Evidence packet: the structured, bounded research evidence researchers see.
 * Built by research/memory.mjs from engine + arena state. Plain data only —
 * never source code, never credentials, never raw provider payloads.
 *
 * @returns {{
 *   researchCycle: number,
 *   regime: string|null,
 *   regimeDistribution: Record<string, number>,
 *   islandStats: object[],
 *   speciesStats: object[],
 *   familyStats: object[],
 *   topGenomes: object[],
 *   costSummary: object,
 *   failureSummary: object,
 *   priorConclusions: object[],
 * }}
 */
export function emptyEvidencePacket() {
  return {
    researchCycle: 0,
    regime: null,
    regimeDistribution: {},
    islandStats: [],
    speciesStats: [],
    familyStats: [],
    topGenomes: [],
    costSummary: { meanCostDrag: 0, meanMaxDrawdown: 0, meanHoldTicks: 0 },
    failureSummary: { failedGates: {}, rejectedBeforeEvaluation: 0 },
    priorConclusions: [],
  };
}

/**
 * A proposal id generator. Deterministic per (cycle, role, salt) so offline
 * replay of a research cycle reproduces ids exactly.
 */
export function proposalIdFor(cycle, role, salt) {
  return `P-${digestOf({ cycle, role, salt }).slice(0, 10)}`;
}

/**
 * The approved family that best represents a species: a family whose *lead*
 * parent is that species if one exists (so the compiled species label and the
 * family agree without an explicit override), otherwise any family containing
 * it, otherwise the broadest generic fallback.
 */
export function familyForSpecies(species) {
  for (const name of FAMILY_NAMES) {
    if (CANDIDATE_FAMILIES[name].parents[0] === species) return name;
  }
  for (const name of FAMILY_NAMES) {
    if (CANDIDATE_FAMILIES[name].parents.includes(species)) return name;
  }
  return FAMILY_NAMES[0];
}

/* ============================================================================
 * Mock provider (deterministic, offline)
 * ==========================================================================*/

function islandRows(evidence) {
  return (Array.isArray(evidence?.islandStats) ? evidence.islandStats : []).filter(
    (row) => row && typeof row.name === "string" && SPECIES.includes(row.name),
  );
}

function speciesRows(evidence) {
  return (Array.isArray(evidence?.speciesStats) ? evidence.speciesStats : []).filter(
    (row) => row && typeof row.name === "string" && SPECIES.includes(row.name),
  );
}

/**
 * The species a role's hypothesis is *about*, derived from this cycle's
 * evidence. Returns null when the evidence says nothing, which pushes the
 * caller onto the deterministic all-species rotation instead.
 */
function preferredSpeciesForRole({ role, evidence }) {
  const islands = islandRows(evidence);
  const species = speciesRows(evidence);
  const regime = typeof evidence?.regime === "string" ? evidence.regime : null;

  switch (role) {
    case "signal-researcher": {
      // Strongest evidence among the flow/momentum families.
      const pool = species.filter((row) => ["Momentum", "Wallet Flow", "Liquidity"].includes(row.name));
      const best = pickBest(pool, (row) => (row.avgReturn ?? 0) * Math.log(1 + Math.max(0, row.trades ?? 0)));
      return best?.name ?? null;
    }
    case "regime-researcher": {
      if (regime && REGIME_SPECIES[regime]) return REGIME_SPECIES[regime];
      return null;
    }
    case "execution-researcher": {
      // Churn lives where trade counts are highest: calm that species down.
      const best = pickBest(species, (row) => row.trades ?? 0);
      return best?.name ?? null;
    }
    case "risk-researcher": {
      // Worst paper return this cycle is the species that needs tighter risk.
      const worst = species
        .filter((row) => Number.isFinite(row.avgReturn))
        .sort((a, b) => (a.avgReturn ?? 0) - (b.avgReturn ?? 0))[0];
      return worst?.name ?? null;
    }
    case "diversity-researcher": {
      // Least-represented island is where new search is most valuable.
      const under = pickWorst(islands, (row) => row.population ?? 0);
      return under?.name ?? null;
    }
    default:
      void evidence;
      return null;
  }
}

function pickBest(rows, score) {
  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const value = Number(score(row));
    if (!Number.isFinite(value)) continue;
    if (value > bestScore) {
      bestScore = value;
      best = row;
    }
  }
  return bestScore > -Infinity ? best : null;
}

function pickWorst(rows, score) {
  let worst = null;
  let worstScore = Infinity;
  for (const row of rows) {
    const value = Number(score(row));
    if (!Number.isFinite(value)) continue;
    if (value < worstScore) {
      worstScore = value;
      worst = row;
    }
  }
  return worstScore < Infinity ? worst : null;
}

/**
 * Resolve (species, family, targetSpecies) for one proposal slot. Evidence
 * first; deterministic all-species rotation when the evidence is silent, so
 * every species stays reachable without any evidence being invented.
 */
export function resolveProposalTarget({ role, index, evidence }) {
  const preferred = preferredSpeciesForRole({ role, evidence });
  const species = preferred ?? SPECIES[index % SPECIES.length];
  const familyName = familyForSpecies(species);
  const family = CANDIDATE_FAMILIES[familyName];
  const lead = family?.parents?.[0] ?? null;
  return {
    species,
    source: preferred ? "evidence" : "rotation",
    family: familyName,
    // Only needed when the family cannot express the species on its own
    // (Experimental has no preset blend, and a non-lead parent is ambiguous).
    targetSpecies: lead === species ? null : species,
  };
}

/**
 * The mock provider derives proposals from evidence heuristics. Each proposal
 * is a hypothesis statement plus parameter regions; every one still has to
 * survive schema validation and deterministic compilation like any other.
 *
 * @param {{
 *   evidence: object,
 *   count: number,
 *   seed: string,
 *   cycle: number,
 * }} input
 * @returns {object[]} raw proposal objects (unvalidated)
 */
export function mockProviderPropose({ evidence, count = 6, seed = "mock", cycle = 1 }) {
  const random = createSeededRandom(`mock:${seed}:${cycle}`);
  const out = [];
  const regimes = REGIMES;
  const regimeDistribution = evidence?.regimeDistribution ?? {};
  const observedRegimes = Object.keys(regimeDistribution).length > 0 ? Object.keys(regimeDistribution) : regimes;

  const cost = evidence?.costSummary ?? emptyEvidencePacket().costSummary;
  const islands = Array.isArray(evidence?.islandStats) ? evidence.islandStats : [];
  const priorConclusions = Array.isArray(evidence?.priorConclusions) ? evidence.priorConclusions : [];

  for (let index = 0; index < Math.max(1, count); index += 1) {
    const role = PROPOSING_ROLES[index % PROPOSING_ROLES.length];
    const regime = observedRegimes[index % observedRegimes.length] ?? regimes[index % regimes.length];
    const target = resolveProposalTarget({ role, index, evidence });

    // Narrow deterministic parameter regions per role. Every role declares at
    // least one non-degenerate range, which is what lets the compiler
    // diversify a genuine collision faithfully (inside the declared region)
    // instead of fabricating noise.
    let changes;
    switch (role) {
      case "signal-researcher":
        changes = {
          momentumWeight: [0.3 + random() * 0.15, 0.55 + random() * 0.15],
          flowWeight: [0.25, 0.55],
          entryScoreThreshold: [0.4, 0.6],
        };
        break;
      case "regime-researcher":
        changes = {
          momentumWeight: [0.35, 0.7],
          maxHold: [35, 90],
          minLiquidityQuality: [0.2, 0.5],
        };
        break;
      case "execution-researcher":
        // Cost drag high? Propose calmer trading: tighter size, longer holds.
        changes =
          cost.meanCostDrag > 0.05
            ? { riskFraction: [0.04, 0.09], maxHold: [60, 120] }
            : { maxHold: [30, 70], momentumWeight: [0.3, 0.5] };
        break;
      case "risk-researcher":
        changes = { stopLoss: [0.05, 0.09], riskFraction: [0.04, 0.1], takeProfit: [0.08, 0.16] };
        break;
      case "diversity-researcher":
        changes = {
          entryScoreThreshold: [0.55, 0.8],
          minLiquidityQuality: [0.3, 0.6],
          maxTopHolderPct: [20, 60],
        };
        break;
      default:
        changes = { momentumWeight: [0.3, 0.5] };
    }

    const hypothesis = mockHypothesis({ role, regime, family: target.family, target, islands });
    const rationale = mockRationale({ role, regime, priorConclusions, cost, target });
    const abstain = role === "risk-researcher" ? ["broad-selloff"] : [];

    out.push({
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId: proposalIdFor(cycle, role, index),
      authorRole: role,
      hypothesis,
      targetRegimes: [regime],
      abstainRegimes: abstain,
      parentFamilies: [target.family],
      ...(target.targetSpecies ? { targetSpecies: target.targetSpecies } : {}),
      changes,
      rationale,
      risks: mockRisks({ role, regime }),
    });
  }

  return out.slice(0, Math.max(0, count));
}

function mockHypothesis({ role, regime, family, target, islands }) {
  const species = target?.species ?? "the population";
  switch (role) {
    case "signal-researcher":
      return `${species} combined with wallet flow persists in ${regime} windows where organic buyers keep accumulating.`;
    case "regime-researcher":
      return `${family} entries specialize cleanly in ${regime} and should abstain elsewhere.`;
    case "execution-researcher":
      return `Cost drag is dominated by short holds so longer maxHold in ${regime} should cut churn without losing edge.`;
    case "risk-researcher":
      return `Tighter stops with smaller size survive ${regime} drawdown better than wide stops with full size.`;
    case "diversity-researcher":
      return `Higher entry thresholds explore untested high-quality ${species} regions while ${islands.length} islands stay distinct.`;
    default:
      return `Unexplored parameter region for ${family} in ${regime}.`;
  }
}

function mockRationale({ role, regime, priorConclusions, cost, target }) {
  const base =
    role === "execution-researcher"
      ? `mean cost drag ${(cost.meanCostDrag ?? 0).toFixed(4)} supports a hold-duration hypothesis`
      : `derived from observed ${target?.source === "evidence" ? "species" : "regime"} statistics in this cycle`;
  const avoided = priorConclusions
    .filter((entry) => entry?.status === "REJECTED")
    .slice(0, 2)
    .map((entry) => entry.proposalId);
  const speciesNote = target?.species ? ` for ${target.species}` : "";
  return avoided.length > 0
    ? `${base}${speciesNote}, avoiding previously rejected ${avoided.join(", ")}`
    : `${base}${speciesNote} in ${regime}`;
}

function mockRisks({ role, regime }) {
  const shared = [`regime dependence on ${regime}`, "paper results are not future performance"];
  if (role === "signal-researcher") shared.push("higher turnover");
  if (role === "risk-researcher") shared.push("stop clustering");
  if (role === "execution-researcher") shared.push("slower reaction to reversals");
  return shared;
}

/* ============================================================================
 * Provider registry
 * ==========================================================================*/

/**
 * Resolve a provider by name.
 *
 * Phase 5B.1 — FAIL-CLOSED. There is no fallback branch:
 *
 *   no name / empty name   → `mock` (the deterministic default)
 *   `mock`                 → `mock`
 *   `deepseek-cline`       → DeepSeek via the local Cline CLI
 *   anything else          → throws `UnknownResearchProviderError`
 *
 * A typo therefore can never execute the mock provider, and a recognized
 * provider that fails at runtime still only ever produces failure statuses — it
 * is never replaced by the mock. An injected `options.provider` object is
 * honoured (tests use it to drive a specific cohort deterministically), but it
 * is never reached by an unrecognized NAME.
 *
 * @param {string} name
 * @param {{ provider?: object, root?: string|null, experimentId?: string|null, env?: object,
 *           now?: () => number, spawnImpl?: Function|null, replayRunIds?: string[], roles?: string[]|null,
 *           config?: object }} [options]
 * @returns {{ name: string, propose: (input: object) => object[]|Promise<object[]>, offline: boolean, [key: string]: unknown }}
 * @throws {UnknownResearchProviderError}
 */
export function resolveResearchProvider(name = "", options = {}) {
  if (options?.provider && typeof options.provider.propose === "function") {
    // An injected provider still has to declare a REGISTERED name, so a
    // mislabeled experiment artifact cannot be produced.
    const requested = String(name ?? "").trim();
    if (requested.length > 0 && !validateProviderName(requested).recognized) {
      throw new UnknownResearchProviderError(requested);
    }
    return options.provider;
  }

  const resolution = requireProviderName(name);

  if (resolution.provider === PROVIDERS["deepseek-cline"]) {
    return createDeepSeekClineProvider({
      config: options.config ?? undefined,
      env: options.env ?? process.env,
      root: options.root ?? null,
      experimentId: options.experimentId ?? null,
      now: options.now,
      spawnImpl: options.spawnImpl ?? null,
      replayRunIds: options.replayRunIds ?? [],
      roles: options.roles ?? null,
    });
  }

  return {
    name: PROVIDERS.mock,
    propose: mockProviderPropose,
    offline: true,
    model: null,
    reasoning: null,
    defaulted: resolution.defaulted,
    describe() {
      return {
        provider: PROVIDERS.mock,
        model: null,
        reasoning: null,
        offline: true,
        external: false,
        deterministic: true,
        defaulted: resolution.defaulted,
      };
    },
  };
}
