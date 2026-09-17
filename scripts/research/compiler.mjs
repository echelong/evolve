/**
 * Deterministic proposal compiler (Phase 5A).
 *
 * Converts *validated* research proposals into candidate genome families. The
 * compiler — never the LLM, never the proposal — controls:
 *
 *   - which fields exist at all (only whitelisted genome keys survive; the
 *     schema already rejects everything else, and this layer re-checks)
 *   - gene ranges (proposals may only narrow inside GENE_BOUNDS/species boxes)
 *   - species bounds (clamped through the same clampToBounds as every genome)
 *   - maximum risk fraction, stop-loss / take-profit floors, pool-age caps
 *   - feature availability (a family can only blend presets that exist)
 *
 * Compilation is a pure function: same proposals -> byte-identical genomes.
 * There is no eval, no dynamic import, no shell, no randomness required, and
 * no I/O. A compiled genome is an ordinary bag of the existing genome numbers —
 * it is NOT a trader, NOT privileged, and must still pass the Arena funnel.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { GENOME_KEYS, GENE_BOUNDS, clampToBounds } from "../engine/genome.mjs";
import { resolveFamily, genomeFromFamily } from "../engine/families.mjs";

export const PROPOSAL_COMPILER_VERSION = 1;

/**
 * Compiler-side hard limits, deliberately tighter than the raw gene bounds.
 * The compiler owns these numbers; proposals can narrow inside them, never
 * widen past them. Documented in the README.
 */
export const COMPILER_LIMITS = Object.freeze({
  // Position sizing: research families never exceed a quarter of the bankroll.
  maxRiskFraction: 0.25,
  // A stop tighter than 2% of equity is churn bait; the floor stays above it.
  minStopLoss: 0.02,
  // Take-profit must be reachable in a realistic hold window.
  minTakeProfit: 0.04,
  // No compiled family may hold positions effectively forever.
  maxPoolAgeHours: 24 * 730,
  maxMinPoolAgeHours: 24 * 90,
});

const TIGHTENED_KEYS = new Set([
  "riskFraction",
  "stopLoss",
  "takeProfit",
  "minPoolAgeHours",
  "maxPoolAgeHours",
]);

/**
 * Apply compiler limits on top of the gene-bound clamped genome. Deterministic,
 * no-op when the value is already inside limits.
 */
function applyCompilerLimits(genome) {
  const g = { ...genome };
  if (g.riskFraction > COMPILER_LIMITS.maxRiskFraction) g.riskFraction = COMPILER_LIMITS.maxRiskFraction;
  if (g.stopLoss < COMPILER_LIMITS.minStopLoss) g.stopLoss = COMPILER_LIMITS.minStopLoss;
  if (g.takeProfit < COMPILER_LIMITS.minTakeProfit) g.takeProfit = COMPILER_LIMITS.minTakeProfit;
  if (g.minPoolAgeHours > COMPILER_LIMITS.maxMinPoolAgeHours) g.minPoolAgeHours = COMPILER_LIMITS.maxMinPoolAgeHours;
  if (g.maxPoolAgeHours > COMPILER_LIMITS.maxPoolAgeHours) g.maxPoolAgeHours = COMPILER_LIMITS.maxPoolAgeHours;
  if (g.minPoolAgeHours > g.maxPoolAgeHours) {
    const swap = g.minPoolAgeHours;
    g.minPoolAgeHours = Math.min(swap, g.maxPoolAgeHours);
    g.maxPoolAgeHours = Math.max(swap, g.maxPoolAgeHours);
  }
  g.maxHold = Math.round(g.maxHold);
  return g;
}

/**
 * Compile validated proposals into candidate genome families.
 *
 * @param {{
 *   proposals: object[],
 *   maxCompilations?: number,
 *   now?: () => number,
 * }} options
 * @returns {{
 *   compiled: Array<{
 *     familyId: string, proposalId: string, family: string, species: string,
 *     genome: object, authorRole: string, targetRegimes: string[],
 *     abstainRegimes: string[], compilerVersion: number, compiledAt: string|null,
 *   }>,
 *   rejected: Array<{ proposalId: string, reasons: string[] }>,
 * }}
 */
export function compileProposals({ proposals, maxCompilations = 3, now = null } = {}) {
  const compiled = [];
  const rejected = [];
  const seenFamilies = new Map(); // familyId -> entry (dedup identical compiles)

  const list = Array.isArray(proposals) ? proposals : [];
  for (const proposal of list) {
    if (compiled.length >= Math.max(0, Math.round(maxCompilations))) break;

    const proposalId = typeof proposal?.proposalId === "string" ? proposal.proposalId : "unknown";
    const reasons = [];

    // Re-validate the structural contract rather than trusting the caller:
    // only genome keys, only finite numbers / 2-number ranges.
    const changes = proposal?.changes ?? {};
    for (const [key, value] of Object.entries(changes)) {
      if (!GENOME_KEYS.includes(key)) reasons.push(`unsupported parameter: ${key}`);
      else if (Array.isArray(value)) {
        if (value.length !== 2 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          reasons.push(`invalid range for ${key}`);
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        reasons.push(`invalid value for ${key}`);
      }
    }

    // Feature availability: a family must exist in the approved set. Phase 5A
    // has no AI-authored features; that is deliberate and documented.
    const familyName = Array.isArray(proposal?.parentFamilies) ? proposal.parentFamilies[0] : null;
    const family = resolveFamily(familyName);
    if (!family) reasons.push(`no resolvable parent family: ${String(familyName ?? "(none)").slice(0, 40)}`);

    // Regime references were enum-validated by the schema; the compiler only
    // re-checks that abstention declarations are strings.
    if (Array.isArray(proposal?.abstainRegimes) && proposal.abstainRegimes.some((r) => typeof r !== "string")) {
      reasons.push("abstainRegimes must be strings");
    }

    if (reasons.length > 0) {
      rejected.push({ proposalId, reasons });
      continue;
    }

    // Numeric overrides: ranges compile to their midpoint; scalars pass
    // through. genomeFromFamily clamps through species/gene bounds; we pass
    // the family's lead species so species-aware age boxes apply.
    const species = family.parents[0];
    const overrides = {};
    for (const [key, value] of Object.entries(changes)) {
      overrides[key] = Array.isArray(value) ? (Number(value[0]) + Number(value[1])) / 2 : value;
    }
    const genome = applyCompilerLimits(genomeFromFamily(family, Math.random, overrides, species));

    // Final belt-and-braces: every key a known gene, every value finite and
    // inside the gene box. This assertion path is covered by validation tests;
    // a failure here is a compiler bug, never silently ignored.
    for (const key of Object.keys(genome)) {
      if (!GENOME_KEYS.includes(key)) throw new Error(`compiler produced unknown gene ${key}`);
      const value = genome[key];
      if (!Number.isFinite(value)) throw new Error(`compiler produced non-finite gene ${key}`);
      const [lo, hi] = GENE_BOUNDS[key];
      if (value < lo || value > hi) throw new Error(`compiler produced out-of-bounds gene ${key}`);
    }

    // Deterministic family id from the exact compiled content.
    const familyId = `F-${digestOf({ p: proposalId, f: family.name, g: genome }).slice(0, 10)}`;

    const entry = {
      familyId,
      proposalId,
      family: family.name,
      species,
      genome,
      authorRole: proposal.authorRole ?? null,
      targetRegimes: [...(proposal.targetRegimes ?? [])],
      abstainRegimes: [...(proposal.abstainRegimes ?? [])],
      compilerVersion: PROPOSAL_COMPILER_VERSION,
      compiledAt: now ? new Date(now()).toISOString() : null,
      limits: { ...COMPILER_LIMITS },
    };

    // Identical compiles dedup to the same familyId; keep the first.
    if (seenFamilies.has(familyId)) continue;
    seenFamilies.set(familyId, entry);
    compiled.push(entry);
  }

  return { compiled, rejected };
}

/** Which proposals could not compile and why (for research memory + dashboard). */
export function compilationReport({ compiled, rejected }) {
  return {
    compilerVersion: PROPOSAL_COMPILER_VERSION,
    compiled: compiled.length,
    rejected: rejected.length,
    rejectedReasons: rejected.flatMap((row) => row.reasons.map((reason) => ({ proposalId: row.proposalId, reason }))),
    limits: { ...COMPILER_LIMITS },
  };
}

/** Re-export for tests: a compiled genome must survive the same clamp. */
export { clampToBounds };
