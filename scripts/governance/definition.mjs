/**
 * EVOLVE Development Governance v1 — canonical definitions.
 *
 * This module is the SINGLE SOURCE OF TRUTH for every governance string:
 * the Global Constraints, the default Review Focus, the five role names, the
 * shadow-first authority ladder, the plan placeholder blacklist, the default
 * verification suite and the external-call policy requirements. Validators
 * import from here instead of duplicating strings by hand, so a constraint can
 * never silently drift between the docs, the checker and the tests.
 *
 * CLASSIFICATION — this whole tree is development infrastructure:
 *
 *   purpose: EVOLVE_DEVELOPMENT_GOVERNANCE
 *   developmentOnly: true
 *   researchEvidence: false
 *   canonicalEvidence: false
 *   replicationEvidence: false
 *   temporalReplicationEvidence: false
 *   tradingAuthority: false
 *   evolutionAuthority: false
 *   deploymentAuthority: false
 *
 * Governance has NO authority. It may read the repository, invoke verification
 * commands and write records beneath `.evolve/governance/` only. It never
 * touches paper trading, genomes, scoring, evolution, selection, Arena, Jev
 * experiments, replication, temporal replication, Paper Shadow, supervisor
 * evidence or market data. The runtime engine never imports this module.
 *
 * PAPER ONLY. Nothing here is scientific evidence.
 */

import { digestOf } from "../lib/hash.mjs";

export const GOVERNANCE_VERSION = 1;
export const GOVERNANCE_PURPOSE = "EVOLVE_DEVELOPMENT_GOVERNANCE";

/** Frozen classification stamped onto every governance record. */
export const GOVERNANCE_CLASSIFICATION = Object.freeze({
  purpose: GOVERNANCE_PURPOSE,
  developmentOnly: true,
  researchEvidence: false,
  canonicalEvidence: false,
  replicationEvidence: false,
  temporalReplicationEvidence: false,
  tradingAuthority: false,
  evolutionAuthority: false,
  deploymentAuthority: false,
});

export const GOVERNANCE_NO_AUTHORITY_TAG = "NO AUTHORITY • DEVELOPMENT GOVERNANCE ONLY • PAPER ONLY";

/* ============================================================================
 * Global Constraints (§4) — canonical, verbatim, never truncated
 * ==========================================================================*/

export const GLOBAL_CONSTRAINTS = Object.freeze([
  "PAPER ONLY unless a separately approved phase explicitly says otherwise.",
  "No wallet, signer, swap, order, real-money or write-RPC functionality may be introduced by ordinary development work.",
  "Canonical/replication/temporal evidence is immutable.",
  "No lookahead.",
  "No result-driven parameter tuning.",
  "No profitability claim from development/shadow evidence.",
  "No weakening of gates/tests/protocols to manufacture a positive result.",
  "AI outputs cannot self-certify scientific validity.",
  "Arena / untouched future data remains authoritative.",
  "Experimental AI components remain shadow/passive until evidence explicitly justifies another authority level.",
  "External AI/API calls must be bounded.",
  "Failures must fail closed where evidence integrity is concerned.",
  "Existing repo attribution must not be modified unless explicitly requested.",
  "No AI assistant/co-author attribution.",
  "No AGENTS.md or CLAUDE.md.",
]);

/** Stable digest of the canonical Global Constraints. */
export const GLOBAL_CONSTRAINTS_DIGEST = digestOf(GLOBAL_CONSTRAINTS.map((text) => text));

/* ============================================================================
 * Review Focus (§5)
 * ==========================================================================*/

export const DEFAULT_REVIEW_FOCUS = Object.freeze([
  "Evidence contamination",
  "Hidden lookahead",
  "Frozen-protocol drift",
  "Observer/research component influencing execution",
  "Artifact mutation or replay mismatch",
]);

export const MIN_REVIEW_FOCUS_ITEMS = 5;
export const DEFAULT_REVIEW_FOCUS_DIGEST = digestOf(DEFAULT_REVIEW_FOCUS.map((text) => text));

/* ============================================================================
 * Independent certification (§3)
 * ==========================================================================*/

export const INDEPENDENT_CERTIFICATION_RULE = "IMPLEMENTER CANNOT SELF-CERTIFY";

export const SUBSTANTIAL_COMPLETION_REQUIREMENTS = Object.freeze([
  "implementation",
  "protocol review when research/evidence semantics are touched",
  "code review",
  "fresh verification",
]);

export const ROLE_NAMES = Object.freeze([
  "SCOUT",
  "IMPLEMENTER",
  "PROTOCOL_REVIEWER",
  "CODE_REVIEWER",
  "VERIFIER",
]);

export const ROLE_CONTRACT_FIELDS = Object.freeze([
  "name",
  "mission",
  "allowedResponsibilities",
  "forbiddenResponsibilities",
  "requiredInputs",
  "requiredOutputs",
  "completionConditions",
]);

/** Manifest identity fields. Governance never fabricates these. */
export const IDENTITY_MANIFEST_FIELDS = Object.freeze([
  "implementerIdentity",
  "protocolReviewerIdentity",
  "codeReviewerIdentity",
  "verifierIdentity",
]);

export const IDENTITY_CERTIFICATION_NOTE =
  "Identity strings are a governance contract, not a cryptographic proof. No software can prove that two different language models executed two roles; the manifest records what the operator declared and flags the run incomplete when the implementer also acted as the sole reviewer/verifier.";

/* ============================================================================
 * Plan placeholder blacklist (§6)
 * ==========================================================================*/

export const PLACEHOLDER_PATTERNS = Object.freeze([
  { id: "TBD", pattern: /\bTBD\b/i, description: "unresolved decision left in a frozen plan" },
  { id: "TODO", pattern: /\bTODO\b/i, description: "deferred work left in a frozen plan" },
  { id: "implement later", pattern: /implement\s+later/i, description: "deferred implementation" },
  { id: "add appropriate tests", pattern: /add\s+appropriate\s+tests/i, description: "unspecified test obligation" },
  { id: "handle edge cases", pattern: /handle\s+edge\s+cases/i, description: "unspecified failure handling" },
  { id: "etc.", pattern: /\betc\./i, description: "open-ended list" },
  { id: "similar to above", pattern: /similar\s+to\s+above/i, description: "unstated cross-reference" },
]);

/** Plan sections every substantial EVOLVE plan must contain (§6). */
export const REQUIRED_PLAN_SECTIONS = Object.freeze([
  "Goal",
  "Architecture",
  "Files / scope",
  "Global Constraints",
  "Review Focus",
  "Verification",
]);

/** Every plan must explicitly classify whether protocol review is required. */
export const RESEARCH_SEMANTICS_DECLARATION_LABEL = "Research/evidence semantics";
export const RESEARCH_SEMANTICS_DECLARATION_VALUES = Object.freeze({
  YES: true,
  NO: false,
});

/** Section headings that satisfy the "Files / scope" requirement. */
export const PLAN_SCOPE_SECTION_ALIASES = Object.freeze([
  "files / scope",
  "files/scope",
  "files and scope",
  "files",
  "scope",
  "file scope",
]);

/* ============================================================================
 * Scope classifications (§7)
 * ==========================================================================*/

export const SCOPE_CLASSIFICATIONS = Object.freeze(["IN_SCOPE", "JUSTIFIED_ADJACENT", "OUT_OF_SCOPE"]);

export const GENERATED_LOCK_FILES = Object.freeze(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

/* ============================================================================
 * Verification suite (§9) and preservation (§10, §22)
 * ==========================================================================*/

export const DEFAULT_VERIFICATION_COMMANDS = Object.freeze([
  "npm run validate",
  "npx tsc --noEmit",
  "npm run lint",
  "npm run build -- --webpack",
  "git diff --check",
  "git status --short",
]);

/** Commands whose warnings are recorded separately from failures (§9). */
export const WARNING_TOLERANT_COMMANDS = Object.freeze(["npm run lint"]);

/** Evidence trees that must be byte-identical across any governance run (§22). */
export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  ".evolve/jev-direction/",
  ".evolve/jev-paper-shadow/",
  ".evolve/jev-paper-forensics/",
  ".evolve/jev-supervisor-observer/",
  ".evolve/shadow/",
  ".evolve/arenas/",
]);

/* ============================================================================
 * Governance storage layout (§8, §11, §16)
 * ==========================================================================*/

export const GOVERNANCE_ROOT = ".evolve/governance";

export const GOVERNANCE_SUBDIRS = Object.freeze({
  runs: "runs",
  reviews: "reviews",
  incidents: "incidents",
});

export const GOVERNANCE_RUN_FILES = Object.freeze([
  "manifest.json",
  "plan-check.json",
  "scope-check.json",
  "verification.json",
  "preservation.json",
]);

/* ============================================================================
 * Root-cause incident workflow (§11, §12)
 * ==========================================================================*/

export const INCIDENT_PHASES = Object.freeze([
  "OBSERVED",
  "REPRODUCED",
  "EVIDENCE_GATHERED",
  "ROOT_CAUSE_HYPOTHESIS",
  "MINIMAL_TEST",
  "FIX",
  "VERIFIED",
]);

export const INCIDENT_ROOT_CAUSE_RULE = "NO FIX CLAIM WITHOUT ROOT-CAUSE EVIDENCE";

/** After this many distinct failed hypotheses an architecture review is required (§12). */
export const ARCHITECTURE_ESCALATION_THRESHOLD = 3;

export const ARCHITECTURE_ESCALATION_RULE =
  "After three distinct failed fix hypotheses for the same incident, architectureReviewRequired becomes true and a fourth ad-hoc fix cannot be marked VERIFIED until an explicit architecture-review note is supplied. Governance never modifies architecture automatically.";

/* ============================================================================
 * External-call governance (§13)
 * ==========================================================================*/

export const EXTERNAL_POLICY_REQUIRED_FIELDS = Object.freeze([
  "timeoutMs",
  "retryCap",
  "maxCallsPerRun",
  "provider",
  "model",
  "fallback",
  "cache",
  "authorityLevel",
  "circuitBreaker",
]);

export const EXTERNAL_POLICY_OPTIONAL_FIELDS = Object.freeze([
  "pricingKnown",
  "costAccounting",
  "failClosed",
  "evidenceBearing",
  "evidenceReference",
]);

/** Evidence-bearing Jev paths: no fallback, fail closed. */
export const EVIDENCE_BEARING_EXTERNAL_REQUIREMENTS = Object.freeze({
  fallback: "none",
  failClosed: true,
});

/* ============================================================================
 * Shadow-first authority ladder (§14)
 * ==========================================================================*/

export const AUTHORITY_LADDER = Object.freeze([
  "OBSERVE",
  "SHADOW",
  "DEVELOPMENT EVIDENCE",
  "INDEPENDENT REPLICATION",
  "TEMPORAL / GENERALIZATION REPLICATION",
  "UNTOUCHED EVALUATION",
  "HUMAN / PROTOCOL GATE",
  "ONLY THEN CONSIDER MORE AUTHORITY",
]);

export const AUTHORITY_LADDER_FROZEN = true;

export const AUTOMATIC_PROMOTION_PROHIBITED = Object.freeze({
  automaticPromotionPermitted: false,
  automaticModelPromotionPermitted: false,
  automaticAgentPromotionPermitted: false,
  rejectedRule: "model performed better once → grant authority",
  statement:
    "Authority only ever moves up the ladder through pre-declared protocol steps and an explicit human gate. A single favourable result — from a model, an agent, a genome or a shadow run — never grants authority.",
});

/* ============================================================================
 * Model-role recommendations (§15) — recommendations, never dependencies
 * ==========================================================================*/

export const MODEL_ROLE_RECOMMENDATIONS = Object.freeze({
  SCOUT: "low-cost/read-only model",
  IMPLEMENTER: "cheapest model capable of completing frozen scope reliably",
  PROTOCOL_REVIEWER: "strongest reasoning model appropriate to scientific risk",
  CODE_REVIEWER: "independent model/context appropriate to diff complexity",
  VERIFIER: "deterministic tooling first; LLM interpretation secondary",
});

export const MODEL_ROLE_NOTE =
  "Recommendations only. No provider secret, provider SDK or specific commercial model is hardwired anywhere in governance, and no governance behaviour depends on a model class being available.";

/* ============================================================================
 * Repository hygiene (§19, §20)
 * ==========================================================================*/

export const FORBIDDEN_REPOSITORY_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);

/** Attribution patterns governance content must never introduce. */
export const FORBIDDEN_ATTRIBUTION_PATTERNS = Object.freeze([
  { id: "claude", pattern: /\bclaude\b/i },
  { id: "cline", pattern: /\bcline\b/i },
  { id: "copilot", pattern: /\bcopilot\b/i },
  { id: "chatgpt", pattern: /\bchatgpt\b/i },
  { id: "openai-gpt", pattern: /\bgpt-[345]\b/i },
  { id: "gemini", pattern: /\bgemini\b/i },
  { id: "deepseek", pattern: /\bdeepseek\b/i },
  { id: "co-author-trailer", pattern: /co-authored-by:/i },
  { id: "generated-with", pattern: /generated with\b/i },
]);

/** Secret-bearing paths governance never packages or reads (§19). */
export const FORBIDDEN_GOVERNANCE_PATHS = Object.freeze([
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[^/]*$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_rsa(\.[^/]*)?$/,
  /(^|\/)(wallet|signer|keystore|mnemonic)[^/]*$/i,
]);

export function isForbiddenGovernancePath(relativePath) {
  const text = String(relativePath ?? "").replace(/\\/g, "/");
  return FORBIDDEN_GOVERNANCE_PATHS.some((pattern) => pattern.test(text));
}

/** Stable governance digest helper (canonical JSON, sorted keys). */
export function governanceDigestOf(value) {
  return digestOf(value);
}
