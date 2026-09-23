/**
 * EVOLVE Development Governance v1 — native role contracts (§2, §3).
 *
 * Five explicit, native EVOLVE roles. Every contract states what the role is
 * for, what it may do, what it must never do, what it must receive, what it
 * must produce and when it is allowed to call itself finished.
 *
 * These are governance contracts, not agent software. Nothing here spawns a
 * model, holds a provider secret or claims to know which model executed a role.
 * The independent-certification rule is enforced as a CONTRACT plus manifest
 * identity fields, because software cannot cryptographically prove that two
 * different language models executed two different roles.
 *
 * DEVELOPMENT GOVERNANCE ONLY — no trading, evolution or deployment authority.
 */

import {
  IDENTITY_CERTIFICATION_NOTE,
  INDEPENDENT_CERTIFICATION_RULE,
  MODEL_ROLE_RECOMMENDATIONS,
  ROLE_CONTRACT_FIELDS,
  ROLE_NAMES,
  SUBSTANTIAL_COMPLETION_REQUIREMENTS,
} from "./definition.mjs";
import { digestOf } from "../lib/hash.mjs";

export const SCOUT_ROLE = Object.freeze({
  name: "SCOUT",
  mission:
    "Read-only repository and evidence investigation: find the relevant files, trace the call path, read the logs and report facts that a frozen plan can be written against.",
  allowedResponsibilities: [
    "read-only repository investigation and file discovery",
    "call-path tracing across scripts/ and src/",
    "log, artifact and evidence-tree inspection (read-only)",
    "factual summaries of what the code currently does",
    "recording digests and counts of existing artifacts",
  ],
  forbiddenResponsibilities: [
    "editing files",
    "changing Git state (commit, reset, restore, clean, checkout, stash)",
    "claiming a fix",
    "altering evidence or any artifact",
    "making protocol decisions",
    "launching trading, evolution, Jev, supervisor or shadow runs",
  ],
  requiredInputs: ["the question or symptom to investigate", "read access to the repository"],
  requiredOutputs: [
    "a factual findings summary",
    "the relevant file list with paths",
    "call-path notes",
    "artifact digests/counts where relevant",
  ],
  completionConditions: [
    "every claim is backed by a file path, a log line or a digest",
    "no file was written and no Git state changed",
    "no fix, protocol decision or evidence change is asserted",
  ],
  modelRecommendation: MODEL_ROLE_RECOMMENDATIONS.SCOUT,
});

export const IMPLEMENTER_ROLE = Object.freeze({
  name: "IMPLEMENTER",
  mission:
    "Implement exactly one frozen, bounded plan/scope, with the smallest change that satisfies it, and hand the diff to independent review and fresh verification.",
  allowedResponsibilities: [
    "implementing the frozen plan/scope and nothing else",
    "minimal-change edits inside the declared file scope",
    "adding or extending tests that the plan declares",
    "recording an explicit justification for any adjacent file it must touch",
    "running local commands to understand its own change (not to self-certify)",
  ],
  forbiddenResponsibilities: [
    "broadening scope",
    "silently changing protocol or frozen semantics",
    "weakening tests, gates or protocols to manufacture a positive result",
    "self-certifying high-risk or substantial work",
    "modifying unrelated files without an explicit justification record",
    "touching evidence trees, wallets, signers, swaps, orders or write-RPC paths",
    "result-driven parameter tuning",
  ],
  requiredInputs: [
    "a frozen plan that passed the governance plan check",
    "the declared file scope",
    "the Global Constraints and Review Focus for the change",
  ],
  requiredOutputs: [
    "a minimal diff confined to the declared scope",
    "the list of changed files",
    "justification records for any adjacent change",
    "an implementer statement of what was and was not done",
  ],
  completionConditions: [
    "the diff matches the frozen plan scope",
    "no gate, test or protocol was weakened",
    "the change is handed to independent code review, protocol review where research/evidence semantics are touched, and fresh verification",
    "no completion claim is made by the implementer alone",
  ],
  modelRecommendation: MODEL_ROLE_RECOMMENDATIONS.IMPLEMENTER,
});

export const PROTOCOL_REVIEWER_ROLE = Object.freeze({
  name: "PROTOCOL_REVIEWER",
  mission:
    "Review scientific and research integrity of a change: is the evidence still honest, is the protocol still frozen, and can the change support the inference it claims?",
  allowedResponsibilities: [
    "reviewing lookahead exposure in any new code path",
    "reviewing evidence contamination and cross-window leakage",
    "reviewing frozen-protocol drift against the declared protocol digest",
    "reviewing result-driven tuning and post-hoc parameter selection",
    "reviewing artifact mutation or replay mismatch",
    "reviewing evidence classification (development / canonical / replication / temporal / shadow)",
    "reviewing whether an observer or research component can influence execution",
    "reviewing whether the inference drawn from the evidence is valid",
    "recording protocol findings against the diff and the frozen plan",
  ],
  forbiddenResponsibilities: [
    "implementing the change being reviewed",
    "editing files under review",
    "re-running or re-scoring evidence to obtain a better result",
    "re-freezing, extending or relaxing a frozen protocol",
    "promoting development/shadow evidence to canonical, replication or temporal status",
    "drawing a profitability conclusion from development or shadow evidence",
    "granting authority to a model, agent or genome",
  ],
  requiredInputs: [
    "the frozen plan with Global Constraints and Review Focus",
    "the diff (or a bounded review package)",
    "the declared evidence classification of the change",
    "the frozen protocol/definitions the change touches",
  ],
  requiredOutputs: [
    "a protocol verdict per Review Focus item",
    "the evidence classification the change may support",
    "explicit protocol findings with file/line references",
    "a statement of which inferences are and are not permitted",
  ],
  completionConditions: [
    "every Review Focus item has an explicit finding, not a silence",
    "no evidence tree was written, re-scored or re-labelled",
    "the reviewer did not implement the change under review",
    "no profitability or authority claim is asserted from development/shadow evidence",
  ],
  modelRecommendation: MODEL_ROLE_RECOMMENDATIONS.PROTOCOL_REVIEWER,
});

export const CODE_REVIEWER_ROLE = Object.freeze({
  name: "CODE_REVIEWER",
  mission:
    "Review the diff itself against the frozen plan and requirements: correctness, regressions, maintainability, security, performance, scope compliance and failure handling.",
  allowedResponsibilities: [
    "correctness review of the diff",
    "regression review against existing behaviour and tests",
    "maintainability and convention review",
    "security review, including secret handling and injection surface",
    "performance review of hot paths and unbounded work",
    "scope compliance against the plan's declared file scope",
    "failure-handling review, including fail-closed behaviour",
    "requesting changes before verification is accepted",
  ],
  forbiddenResponsibilities: [
    "implementing the change being reviewed",
    "editing files under review",
    "approving its own implementation",
    "accepting weakened tests, gates or skipped checks",
    "accepting out-of-scope changes without a justification record",
    "asserting scientific validity of research results",
    "declaring verification passed without fresh command evidence",
  ],
  requiredInputs: [
    "the frozen plan and its declared file scope",
    "the diff or bounded review package",
    "the scope-check result",
    "the Global Constraints and Review Focus",
  ],
  requiredOutputs: [
    "a per-finding review with severity",
    "a scope-compliance verdict",
    "a failure-handling verdict",
    "an explicit approve/request-changes decision",
  ],
  completionConditions: [
    "the diff was assessed against the frozen plan, not against a paraphrase",
    "every finding is actionable and located",
    "out-of-scope changes are either justified or rejected",
    "the reviewer did not implement the change under review",
  ],
  modelRecommendation: MODEL_ROLE_RECOMMENDATIONS.CODE_REVIEWER,
});

export const VERIFIER_ROLE = Object.freeze({
  name: "VERIFIER",
  mission:
    "Fresh independent verification: run the commands again in this invocation and judge only from what actually ran, plus repository and artifact evidence.",
  allowedResponsibilities: [
    "executing the verification suite fresh in this invocation",
    "capturing exit codes, timings and output digests per command",
    "hashing declared protected paths before and after verification",
    "reading repository and artifact evidence",
    "recording lint warnings separately from failures",
    "reporting PASS/FAIL strictly from captured evidence",
  ],
  forbiddenResponsibilities: [
    "inferring success from an implementer or reviewer report",
    "reusing a cached or previously recorded command result",
    "claiming a command passed when it did not run in this invocation",
    "editing source files to make a check pass",
    "weakening, skipping or reordering a required check",
    "writing outside .evolve/governance/",
    "touching evidence trees, trading, evolution or deployment paths",
    "swallowing a failure or truncating a required constraint",
  ],
  requiredInputs: [
    "the plan (for the dedicated validator and declared protected paths)",
    "the verification command policy",
    "write access to .evolve/governance/ only",
  ],
  requiredOutputs: [
    "a per-command record: command, startedAt, finishedAt, durationMs, exitCode, stdoutDigest, stderrDigest, status",
    "bounded log files with explicit truncation metadata",
    "a preservation record for every declared protected path",
    "an overall PASS/FAIL verdict with reasons",
  ],
  completionConditions: [
    "every required command actually ran during this invocation",
    "every failure is reported, never swallowed",
    "every declared protected path is byte-identical before and after",
    "the verdict follows only from captured command and artifact evidence",
  ],
  modelRecommendation: MODEL_ROLE_RECOMMENDATIONS.VERIFIER,
});

export const GOVERNANCE_ROLES = Object.freeze([
  SCOUT_ROLE,
  IMPLEMENTER_ROLE,
  PROTOCOL_REVIEWER_ROLE,
  CODE_REVIEWER_ROLE,
  VERIFIER_ROLE,
]);

/** Stable digest of the five frozen role contracts. */
export const GOVERNANCE_ROLES_DIGEST = digestOf(
  GOVERNANCE_ROLES.map((role) => ROLE_CONTRACT_FIELDS.map((field) => role[field] ?? null)),
);

/* ============================================================================
 * Contract completeness and five-role separation
 * ==========================================================================*/

/** Is one role contract complete? Returns explicit problems, never a guess. */
export function roleContractProblems(role) {
  const problems = [];
  if (!role || typeof role !== "object") return ["role contract is not an object"];
  for (const field of ROLE_CONTRACT_FIELDS) {
    const value = role[field];
    if (field === "name") {
      if (typeof value !== "string" || value.trim().length === 0) problems.push(`${field} is missing`);
      continue;
    }
    if (typeof value === "string") {
      if (value.trim().length === 0) problems.push(`${field} is empty`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      problems.push(`${field} must be a non-empty list`);
      continue;
    }
    if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
      problems.push(`${field} contains an empty entry`);
    }
  }
  return problems;
}

export function roleContractComplete(role) {
  const problems = roleContractProblems(role);
  return { ok: problems.length === 0, name: role?.name ?? null, problems };
}

/**
 * Five-role separation: the frozen role set must be exactly the five declared
 * roles, each name unique, with the implementer and both reviewers separated by
 * contract (a reviewer must not implement the change it reviews).
 */
export function fiveRoleSeparationReport(roles = GOVERNANCE_ROLES) {
  const names = roles.map((role) => role?.name);
  const problems = [];
  if (roles.length !== ROLE_NAMES.length) {
    problems.push(`expected ${ROLE_NAMES.length} roles, got ${roles.length}`);
  }
  for (const required of ROLE_NAMES) {
    if (!names.includes(required)) problems.push(`role ${required} is missing`);
  }
  for (const name of names) {
    if (!ROLE_NAMES.includes(name)) problems.push(`role ${name} is not a declared governance role`);
  }
  if (new Set(names).size !== names.length) problems.push("role names are not unique");
  for (const role of roles) {
    problems.push(...roleContractProblems(role).map((entry) => `${role?.name}: ${entry}`));
  }
  const implementer = roles.find((role) => role?.name === "IMPLEMENTER");
  for (const reviewerName of ["PROTOCOL_REVIEWER", "CODE_REVIEWER"]) {
    const reviewer = roles.find((role) => role?.name === reviewerName);
    const forbids = reviewer?.forbiddenResponsibilities ?? [];
    const separated = forbids.some((entry) => /implementing the change being reviewed/i.test(entry));
    if (!separated) problems.push(`${reviewerName} must forbid implementing the change under review`);
    if (implementer && reviewer && implementer.name === reviewer.name) {
      problems.push("implementer and reviewer must be separate roles");
    }
  }
  return {
    ok: problems.length === 0,
    roles: names,
    roleCount: names.length,
    implementerCannotSelfCertify: INDEPENDENT_CERTIFICATION_RULE,
    problems,
  };
}

/* ============================================================================
 * Independent certification (§3) — IMPLEMENTER CANNOT SELF-CERTIFY
 * ==========================================================================*/

function normalizeIdentity(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Assess the independent-certification contract for one governance run.
 *
 * Software cannot prove which model executed which role, so this is a CONTRACT:
 * the operator declares four identities, governance records them verbatim
 * (never fabricated), and the run is marked incomplete when the implementer is
 * also the sole reviewer/verifier, or when an identity required for substantial
 * work was not declared at all.
 */
export function assessIndependentCertification({
  implementerIdentity = null,
  protocolReviewerIdentity = null,
  codeReviewerIdentity = null,
  verifierIdentity = null,
  touchesResearchSemantics = false,
  requireIndependentReview = true,
  implementationComplete = true,
  freshVerificationPassed = true,
} = {}) {
  const identities = {
    implementerIdentity: normalizeIdentity(implementerIdentity),
    protocolReviewerIdentity: normalizeIdentity(protocolReviewerIdentity),
    codeReviewerIdentity: normalizeIdentity(codeReviewerIdentity),
    verifierIdentity: normalizeIdentity(verifierIdentity),
  };
  const problems = [];
  const warnings = [];

  const implementer = identities.implementerIdentity;
  const collisions = [];
  if (implementer !== null) {
    if (identities.codeReviewerIdentity === implementer) collisions.push("codeReviewerIdentity");
    if (identities.verifierIdentity === implementer) collisions.push("verifierIdentity");
    if (touchesResearchSemantics && identities.protocolReviewerIdentity === implementer) {
      collisions.push("protocolReviewerIdentity");
    }
  }
  const selfCertificationDetected = collisions.length > 0;
  if (selfCertificationDetected) {
    problems.push(`${INDEPENDENT_CERTIFICATION_RULE}: implementerIdentity is also ${collisions.join(", ")}`);
  }

  if (
    identities.protocolReviewerIdentity !== null &&
    identities.protocolReviewerIdentity === identities.codeReviewerIdentity
  ) {
    warnings.push("protocolReviewerIdentity and codeReviewerIdentity are the same declared identity");
  }

  const missing = Object.entries(identities)
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  for (const field of missing) {
    warnings.push(`${field} was not declared; governance never fabricates an identity`);
  }

  const independentReviewDeclared =
    implementer !== null &&
    identities.codeReviewerIdentity !== null &&
    identities.verifierIdentity !== null &&
    (!touchesResearchSemantics || identities.protocolReviewerIdentity !== null) &&
    !selfCertificationDetected;

  if (touchesResearchSemantics && identities.protocolReviewerIdentity === null) {
    problems.push("research/evidence semantics are touched but no protocolReviewerIdentity was declared");
  }
  if (!implementationComplete) problems.push("implementation is not complete");
  if (!freshVerificationPassed) problems.push("fresh verification did not pass");
  if (requireIndependentReview && !independentReviewDeclared && !selfCertificationDetected) {
    problems.push(
      `independent review is not declared (${missing.length > 0 ? missing.join(", ") : "role collision"}); substantial EVOLVE work cannot be certified by the implementer`,
    );
  }

  return {
    rule: INDEPENDENT_CERTIFICATION_RULE,
    requirements: SUBSTANTIAL_COMPLETION_REQUIREMENTS,
    identities,
    touchesResearchSemantics,
    independentReviewDeclared,
    selfCertificationDetected,
    incomplete: problems.length > 0,
    status: problems.length === 0 ? "COMPLETE" : "INCOMPLETE",
    problems,
    warnings,
    note: IDENTITY_CERTIFICATION_NOTE,
  };
}
