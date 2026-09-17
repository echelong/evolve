/**
 * Candidate strategy families and the abstention policy (Phase 5A).
 *
 * A *family* is a named combination of existing species presets that a research
 * proposal (or the meta-evolution layer) can target. Every family still
 * resolves to plain, existing deterministic genome fields — Phase 5A adds no
 * new signal, no executable artifact, and no feature outside GENE_BOUNDS.
 * "Momentum × Wallet Flow" is literally a blend of the two presets' weights
 * with their gate/risk genes drawn from named parents by fixed rules, so the
 * result is inspectable and reproducible run to run.
 *
 * The abstention policy is also fully deterministic: a family/genome can express
 * ACTIVE, REDUCED_RISK, or ABSTAIN for the current regime. "Don't trade in this
 * regime" is a legitimate strategy; abstention is scored against opportunity
 * (how many tradeable tokens were actually eligible) rather than treated as
 * automatic failure, and a specialist is never mislabelled universally robust.
 *
 * Everything here is PAPER ONLY research machinery.
 */

import { SPECIES_PRESETS, clampToBounds } from "./genome.mjs";

export const ABSTAIN_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  REDUCED_RISK: "REDUCED_RISK",
  ABSTAIN: "ABSTAIN",
});

/** Ordered rule table; the first matching rule decides the posture. */
export const DEFAULT_ABSTENTION_RULES = Object.freeze([
  {
    state: ABSTAIN_STATE.ABSTAIN,
    // Broad selloff: nothing is eligible by these gates — stand down.
    when: (ctx) => ctx.regime === "broad-selloff" && !ctx.hasEligibleTarget,
    reason: "broad-selloff and no eligible token: abstain",
  },
  {
    state: ABSTAIN_STATE.ABSTAIN,
    // The market is degraded enough that new paper entries are paused anyway;
    // owning the decision beats drifting into it.
    when: (ctx) => ctx.allowNewEntries === false && !ctx.hasPosition,
    reason: "feed degraded / entries paused: abstain",
  },
  {
    state: ABSTAIN_STATE.REDUCED_RISK,
    // Contraction or high volatility: trade, but at reduced size.
    when: (ctx) => ctx.regime === "liquidity-contraction" || ctx.regime === "high-volatility",
    reason: "adverse regime for exposure: reduce risk",
  },
  {
    state: ABSTAIN_STATE.ABSTAIN,
    // Explicit specialist abstention: the genome declares regimes it will not
    // trade (see research proposals' targetRegimes + abstainRegimes).
    when: (ctx) => Array.isArray(ctx.abstainRegimes) && ctx.abstainRegimes.includes(ctx.regime),
    reason: "declared abstention regime",
  },
  {
    state: ABSTAIN_STATE.REDUCED_RISK,
    // Low-activity windows: some evidence, but thin.
    when: (ctx) => ctx.regime === "low-activity" && ctx.eligibleCount < 2,
    reason: "low-activity market with almost no eligible tokens: reduce risk",
  },
]);

function ctx_label(ctx) {
  return typeof ctx?.regime === "string" ? ctx.regime : "unknown";
}

/**
 * Deterministic posture decision. Pure: same inputs -> same state.
 *
 * @param {{
 *   regime?: string|null,
 *   allowNewEntries?: boolean,
 *   hasPosition?: boolean,
 *   eligibleCount?: number,
 *   abstainRegimes?: string[]|null,
 *   rules?: Array<{state: string, when: (ctx: object) => boolean, reason?: string}>,
 * }} context
 * @returns {{ state: string, reason: string }}
 */
export function abstentionDecision(context = {}) {
  const ctx = {
    regime: context.regime ?? null,
    allowNewEntries: context.allowNewEntries !== false,
    hasPosition: context.hasPosition === true,
    eligibleCount: Math.max(0, Number.isFinite(context.eligibleCount) ? Math.round(context.eligibleCount) : 0),
    abstainRegimes: Array.isArray(context.abstainRegimes) ? context.abstainRegimes : null,
  };
  const rules = Array.isArray(context.rules) && context.rules.length > 0 ? context.rules : DEFAULT_ABSTENTION_RULES;

  for (const rule of rules) {
    let matched = false;
    try {
      matched = rule.when(ctx) === true;
    } catch {
      matched = false; // a throwing rule is skipped, never fatal
    }
    if (matched) {
      return { state: rule.state, reason: `${rule.reason ?? "matched rule"} (${ctx_label(ctx)})` };
    }
  }

  return { state: ABSTAIN_STATE.ACTIVE, reason: "default active posture" };
}

/**
 * Fraction of the genome's riskFraction to deploy under a posture.
 * Deterministic and conservative.
 */
export function riskMultiplierFor(state) {
  switch (state) {
    case ABSTAIN_STATE.ABSTAIN:
      return 0;
    case ABSTAIN_STATE.REDUCED_RISK:
      return 0.5;
    default:
      return 1;
  }
}

/* ============================================================================
 * Candidate families: named, deterministic combinations of existing presets
 * ==========================================================================*/

function blendWeights(presets) {
  const out = {};
  const keys = Object.keys(presets[0].weights);
  for (const key of keys) {
    out[key] = presets.reduce((sum, p) => sum + (p.weights[key] ?? 0), 0) / presets.length;
  }
  return out;
}

/** Gates: numeric genes average; binary genes AND only if every parent demands it. */
function blendGates(presets) {
  const out = {};
  const keys = Object.keys(presets[0].gates);
  const binary = new Set(["momentumGateEnabled", "requireConcentrationKnown", "requireAuthoritySafe", "requireVerified"]);
  for (const key of keys) {
    if (binary.has(key)) {
      out[key] = presets.every((p) => p.gates[key] === 1) ? 1 : 0;
    } else {
      out[key] = presets.reduce((sum, p) => sum + p.gates[key], 0) / presets.length;
    }
  }
  return out;
}

/** Risk: most conservative of the parents (smallest stop, smallest size, shortest hold). */
function blendRisk(presets) {
  const out = {};
  for (const key of ["stopLoss", "takeProfit", "maxHold", "riskFraction"]) {
    out[key] = Math.min(...presets.map((p) => p.risk[key]));
  }
  return out;
}

function defineFamily({ name, parents, description }) {
  const resolved = parents.map((p) => SPECIES_PRESETS[p]).filter(Boolean);
  if (resolved.length !== parents.length) return null;
  return Object.freeze({
    name,
    parents: Object.freeze([...parents]),
    description,
    weights: Object.freeze(blendWeights(resolved)),
    gates: Object.freeze(blendGates(resolved)),
    risk: Object.freeze(blendRisk(resolved)),
  });
}

/**
 * Approved meta-evolution families (Phase 5A scope: preset combinations only).
 * A family is not a species: agents keep their species label for dashboard
 * grouping, and the family only shapes the *initial genome*.
 */
export const CANDIDATE_FAMILIES = Object.freeze({
  "Momentum x Wallet Flow": defineFamily({
    name: "Momentum x Wallet Flow",
    parents: ["Momentum", "Wallet Flow"],
    description: "momentum + volume expansion confirmed by trader activity and net buyer imbalance",
  }),
  "Genesis x Flow": defineFamily({
    name: "Genesis x Flow",
    parents: ["Genesis Hunter", "Wallet Flow"],
    description: "young pools gated by genuine organic buyer flow",
  }),
  "Reversal x Liquidity": defineFamily({
    name: "Reversal x Liquidity",
    parents: ["Reversal", "Liquidity"],
    description: "contrarian entries only in deep, safe, seasoned pools",
  }),
  "Momentum x Liquidity": defineFamily({
    name: "Momentum x Liquidity",
    parents: ["Momentum", "Liquidity"],
    description: "momentum entries with institutional-grade liquidity and safety gates",
  }),
  "Reversal x Flow": defineFamily({
    name: "Reversal x Flow",
    parents: ["Reversal", "Wallet Flow"],
    description: "contrarian re-entries timed by net buyer flow turns",
  }),
});

export const FAMILY_NAMES = Object.freeze(Object.keys(CANDIDATE_FAMILIES));

/**
 * Resolve a family name to its frozen definition, tolerating the separators
 * "x", "×" (U+00D7), and "*" in proposals.
 */
export function resolveFamily(name) {
  if (typeof name !== "string") return null;
  const normalized = name.trim().replace(/\s*[×*]\s*/g, " x ");
  return CANDIDATE_FAMILIES[normalized] ?? null;
}

/**
 * Build a genome from a family, clamped through the SAME gene bounds as any
 * other genome. The optional `overrides` are plain numeric ranges/values that
 * the proposal compiler has already validated; they are clamped, never trusted.
 * No new fields are introduced — a family genome has exactly GENE_KEYS fields.
 *
 * @param {object} family resolved family definition
 * @param {() => number} [random]
 * @param {Record<string, number>} [overrides] validated numeric overrides
 * @param {string|null} [species] species label the resulting agent carries
 */
export function genomeFromFamily(family, random = Math.random, overrides = {}, species = null) {
  const genome = {};
  for (const [key, value] of Object.entries(family.weights)) genome[`${key}Weight`] = clampToBounds(`${key}Weight`, value, species);
  for (const [key, value] of Object.entries(family.gates)) genome[key] = clampToBounds(key, value, species);
  for (const [key, value] of Object.entries(family.risk)) genome[key] = clampToBounds(key, value, species);
  genome.maxHold = Math.round(genome.maxHold);
  // A family blend is never contrarian by construction; the parents' flag is
  // the honest vote: any Reversal parent makes the family contrarian, because
  // that is the behaviour the parent's preset encodes.
  genome.contrarian = family.parents.some((p) => SPECIES_PRESETS[p]?.contrarian === 1) ? 1 : 0;

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in genome)) continue; // unknown fields were rejected upstream
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    // Ranges arrive as [min, max]: take the midpoint. Scalars are used as-is.
    const target = Array.isArray(value) && value.length === 2 ? (Number(value[0]) + Number(value[1])) / 2 : numeric;
    if (!Number.isFinite(target)) continue;
    genome[key] = clampToBounds(key, target, species);
  }
  genome.maxHold = Math.round(genome.maxHold);

  // Age band coherence, same invariant mutateGenome enforces.
  if (genome.minPoolAgeHours > genome.maxPoolAgeHours) {
    const swap = genome.minPoolAgeHours;
    genome.minPoolAgeHours = Math.min(swap, genome.maxPoolAgeHours);
    genome.maxPoolAgeHours = Math.max(swap, genome.maxPoolAgeHours);
  }
  return genome;
}
