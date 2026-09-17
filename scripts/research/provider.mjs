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
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { PROPOSAL_SCHEMA_VERSION, RESEARCHER_ROLES } from "./proposal-schema.mjs";
import { FAMILY_NAMES } from "../engine/families.mjs";
import { REGIMES } from "../arena/orchestrator.mjs";

export const RESEARCH_PROVIDER_VERSION = 1;

export const PROVIDERS = Object.freeze({
  mock: "mock", // deterministic, offline, no LLM
});

/** The role → family affinity used by the mock provider's heuristics. */
const ROLE_FAMILY_AFFINITY = Object.freeze({
  "signal-researcher": "Momentum x Wallet Flow",
  "regime-researcher": "Momentum x Liquidity",
  "execution-researcher": "Momentum x Liquidity",
  "risk-researcher": "Reversal x Liquidity",
  "diversity-researcher": "Reversal x Flow",
  "adversarial-critic": "Genesis x Flow",
});

/** Roles that observe but do not originate proposals in a given cycle. */
const CRITIC_ROLES = new Set(["adversarial-critic"]);

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

/* ============================================================================
 * Mock provider (deterministic, offline)
 * ==========================================================================*/

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
  const families = FAMILY_NAMES;
  const regimeDistribution = evidence?.regimeDistribution ?? {};
  const observedRegimes = Object.keys(regimeDistribution).length > 0 ? Object.keys(regimeDistribution) : regimes;

  const cost = evidence?.costSummary ?? emptyEvidencePacket().costSummary;
  const islands = Array.isArray(evidence?.islandStats) ? evidence.islandStats : [];
  const priorConclusions = Array.isArray(evidence?.priorConclusions) ? evidence.priorConclusions : [];

  // Roles act in a fixed rotation; the critic role proposes critiques-as-data
  // (risk statements about the others), never its own trades.
  const proposingRoles = RESEARCHER_ROLES.filter((role) => !CRITIC_ROLES.has(role));

  for (let index = 0; index < Math.max(1, count); index += 1) {
    const role = proposingRoles[index % proposingRoles.length];
    const regime = observedRegimes[index % observedRegimes.length] ?? regimes[index % regimes.length];
    const family = ROLE_FAMILY_AFFINITY[role] ?? families[index % families.length];

    // Narrow deterministic parameter regions per role.
    let changes;
    switch (role) {
      case "signal-researcher":
        changes = { momentumWeight: [0.3 + random() * 0.2, 0.55 + random() * 0.2], flowWeight: [0.25, 0.55] };
        break;
      case "regime-researcher":
        changes = { momentumWeight: [0.4, 0.7], maxHold: [35, 90] };
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
        changes = { entryScoreThreshold: [0.55, 0.8], minLiquidityQuality: [0.3, 0.6] };
        break;
      default:
        changes = { momentumWeight: [0.3, 0.5] };
    }

    const hypothesis = mockHypothesis({ role, regime, family, cost, islands });
    const rationale = mockRationale({ role, regime, priorConclusions, cost });

    out.push({
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId: proposalIdFor(cycle, role, index),
      authorRole: role,
      hypothesis,
      targetRegimes: [regime],
      abstainRegimes: role === "risk-researcher" ? ["broad-selloff"] : [],
      parentFamilies: [family],
      changes,
      rationale,
      risks: mockRisks({ role, regime }),
    });
  }

  return out.slice(0, Math.max(0, count));
}

function mockHypothesis({ role, regime, family, cost, islands }) {
  switch (role) {
    case "signal-researcher":
      return `Momentum combined with wallet flow persists in ${regime} windows where organic buyers keep accumulating.`;
    case "regime-researcher":
      return `${family} entries specialize cleanly in ${regime} and should abstain elsewhere.`;
    case "execution-researcher":
      return `Cost drag is dominated by short holds so longer maxHold in ${regime} should cut churn without losing edge.`;
    case "risk-researcher":
      return `Tighter stops with smaller size survive ${regime} drawdown better than wide stops with full size.`;
    case "diversity-researcher":
      return `Higher entry thresholds explore untested high-quality regions while ${islands.length} islands stay distinct.`;
    default:
      return `Unexplored parameter region for ${family} in ${regime}.`;
  }
}

function mockRationale({ role, regime, priorConclusions, cost }) {
  const base =
    role === "execution-researcher"
      ? `mean cost drag ${(cost.meanCostDrag ?? 0).toFixed(4)} supports a hold-duration hypothesis`
      : "derived from observed regime and family statistics in this cycle";
  const avoided = priorConclusions
    .filter((entry) => entry?.status === "REJECTED")
    .slice(0, 2)
    .map((entry) => entry.proposalId);
  return avoided.length > 0 ? `${base}, avoiding previously rejected ${avoided.join(", ")}` : `${base} in ${regime}`;
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
 * Resolve a provider by name. Only the offline mock exists in Phase 5A; an
 * external provider would be registered here later, with credentials read
 * from the environment inside its own module (never passed through state).
 *
 * @returns {{ name: string, propose: (input: object) => object[], offline: boolean }}
 */
export function resolveResearchProvider(name = "mock") {
  const normalized = String(name ?? "").toLowerCase();
  if (normalized !== PROVIDERS.mock) {
    // Deliberate: unknown providers fall back to the offline mock rather than
    // attempting network calls, so tests and air-gapped runs never hang.
    return { name: PROVIDERS.mock, propose: mockProviderPropose, offline: true, fallbackFrom: normalized || null };
  }
  return { name: PROVIDERS.mock, propose: mockProviderPropose, offline: true };
}
