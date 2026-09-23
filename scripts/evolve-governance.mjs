#!/usr/bin/env node
/**
 * EVOLVE Development Governance v1 — single native governance entrypoint.
 *
 * Development infrastructure only. This tool is NOT an agent framework and holds
 * NO trading, evolution or deployment authority. It exists so that substantial
 * EVOLVE development work carries an auditable trail:
 *
 *   frozen plan → scope classification → bounded review package
 *   → fresh verification → preservation proof → manifest
 *
 * Commands:
 *   roles             print the five frozen role contracts
 *   constraints       print the canonical Global Constraints and authority ladder
 *   plan-check        validate a frozen plan (§6)
 *   scope-check       classify changed files against the plan (§7)
 *   review-package    build a bounded review package (§8)
 *   verify            run the verification suite fresh (§9)
 *   preservation      hash protected trees before/after a run (§10, §22)
 *   incident          root-cause incident workflow (§11, §12)
 *   external-policy   record/validate an external-call policy (§13)
 *   orchestrate       run the full sequence and write a run manifest (§16, §17)
 *
 * Every write lands beneath `.evolve/governance/`. Nothing else is written.
 * No wallet, signer, swap, order, real-money or write-RPC functionality.
 * Governance output is NOT canonical, replication, temporal, Arena or trading
 * evidence, and it may not be used to claim profitability.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./lib/hash.mjs";
import { parseGovernanceArgs } from "./governance/cli.mjs";
import {
  AUTHORITY_LADDER,
  AUTOMATIC_PROMOTION_PROHIBITED,
  DEFAULT_REVIEW_FOCUS,
  DEFAULT_REVIEW_FOCUS_DIGEST,
  GLOBAL_CONSTRAINTS,
  GLOBAL_CONSTRAINTS_DIGEST,
  GOVERNANCE_CLASSIFICATION,
  GOVERNANCE_NO_AUTHORITY_TAG,
  GOVERNANCE_ROOT,
  GOVERNANCE_VERSION,
  INCIDENT_PHASES,
  MODEL_ROLE_RECOMMENDATIONS,
} from "./governance/definition.mjs";
import {
  GOVERNANCE_ROLES,
  GOVERNANCE_ROLES_DIGEST,
  assessIndependentCertification,
  fiveRoleSeparationReport,
} from "./governance/roles.mjs";
import {
  PROJECT_ROOT,
  governanceRootAbsolute,
  newGovernanceId,
  worktreeDigestOf,
  writeGovernanceFile,
} from "./governance/storage.mjs";
import { checkPlanFile, runPlanCheckCli } from "./governance/plan-check.mjs";
import {
  changedFilesFromGit,
  isGovernanceRecordPath,
  runScopeCheckCli,
  scopeCheckFromGit,
} from "./governance/scope-check.mjs";
import { buildReviewPackage, runReviewPackageCli, writeReviewPackage } from "./governance/review-package.mjs";
import {
  buildPreservationReport,
  capturePreservation,
  mergeProtectedPaths,
  runPreservationCli,
} from "./governance/preservation.mjs";
import { runFreshVerification, runVerifyCli, DEFAULT_COMMAND_TIMEOUT_MS } from "./governance/verify.mjs";
import { runIncidentCli } from "./governance/incident.mjs";
import { runExternalPolicyCli } from "./governance/external-policy.mjs";

const USAGE = `EVOLVE Development Governance v${GOVERNANCE_VERSION} — ${GOVERNANCE_NO_AUTHORITY_TAG}

usage: node scripts/evolve-governance.mjs <command> [options]

commands:
  roles             print the five frozen role contracts and separation report
  constraints       print the canonical Global Constraints, Review Focus defaults
                    and the frozen shadow-first authority ladder
  plan-check        --plan <path.md> [--json]
  scope-check       [--plan <path.md>] [--changed <path> ...] [--json]
  review-package    [--plan <path.md>] [--file <path> ...] [--protocol <path> ...]
                    [--log <path> ...] [--base <ref>] [--write] [--json]
  verify            [--plan <path.md>] [--command <cmd> ...] [--run-id <id>]
                    [--preserve] [--timeout-ms N] [--json]
  preservation      --phase before|after [--plan <path.md>] [--run-id <id>]
                    [--protected <path> ...] [--allow-declared-write] [--json]
  incident          --action open|update|show|list [--incident-id <id>] [...]
  external-policy   [--file <policy.json>] [--evidence-bearing] [--json]
  orchestrate       --plan <path.md> [--run-id <id>] [--implementer <identity>]
                    [--protocol-reviewer <identity>] [--code-reviewer <identity>]
                    [--verifier <identity>] [--base <ref>] [--head <ref|WORKTREE>]
                    [--skip-verify] [--review-package]
                    [--allow-declared-write] [--json]

writes: everything lands beneath ${GOVERNANCE_ROOT}/ and nowhere else.
`;

function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function stringFlag(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* ============================================================================
 * roles / constraints
 * ==========================================================================*/

function printHumanRoles(report) {
  console.log(`EVOLVE governance roles (${report.roles.length}) — ${GOVERNANCE_NO_AUTHORITY_TAG}`);
  for (const role of report.roles) {
    console.log("");
    console.log(`${role.name} — recommended: ${role.modelRecommendation}`);
    console.log(`  mission: ${role.mission}`);
    console.log("  allowed:");
    for (const entry of role.allowedResponsibilities) console.log(`    - ${entry}`);
    console.log("  forbidden:");
    for (const entry of role.forbiddenResponsibilities) console.log(`    - ${entry}`);
    console.log("  requiredInputs:");
    for (const entry of role.requiredInputs) console.log(`    - ${entry}`);
    console.log("  requiredOutputs:");
    for (const entry of role.requiredOutputs) console.log(`    - ${entry}`);
    console.log("  completionConditions:");
    for (const entry of role.completionConditions) console.log(`    - ${entry}`);
  }
  console.log("");
  console.log(`five-role separation: ${report.separation.ok ? "OK" : "FAIL"}`);
  console.log(`rolesDigest: ${report.rolesDigest}`);
  console.log(`independent certification: ${report.separation.implementerCannotSelfCertify}`);
  for (const problem of report.separation.problems) console.log(`PROBLEM: ${problem}`);
}

async function runRolesCommand(rest) {
  const args = parseGovernanceArgs(rest, { json: true });
  const report = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_ROLE_CONTRACTS",
    version: GOVERNANCE_VERSION,
    noAuthority: GOVERNANCE_NO_AUTHORITY_TAG,
    roles: GOVERNANCE_ROLES,
    separation: fiveRoleSeparationReport(),
    rolesDigest: GOVERNANCE_ROLES_DIGEST,
    modelRoleRecommendations: MODEL_ROLE_RECOMMENDATIONS,
    classification: GOVERNANCE_CLASSIFICATION,
  };
  if (args.flags.json) console.log(canonicalJson(report, 2));
  else printHumanRoles(report);
  process.exitCode = report.separation.ok ? 0 : 1;
  return report;
}

function printHumanConstraints(report) {
  console.log(`EVOLVE Global Constraints (canonical, ${report.globalConstraints.length}) — never truncated`);
  report.globalConstraints.forEach((constraint, index) => console.log(`  ${index + 1}. ${constraint}`));
  console.log("");
  console.log(`globalConstraintsDigest: ${report.globalConstraintsDigest}`);
  console.log("");
  console.log(`default Review Focus (${report.defaultReviewFocus.length}):`);
  for (const item of report.defaultReviewFocus) console.log(`  - ${item}`);
  console.log(`defaultReviewFocusDigest: ${report.defaultReviewFocusDigest}`);
  console.log("");
  console.log("shadow-first authority ladder (frozen):");
  report.authorityLadder.forEach((rung, index) => console.log(`  ${index + 1}. ${rung}`));
  console.log(`automatic promotion permitted: ${report.automaticPromotion.automaticPromotionPermitted}`);
  console.log(`rejected rule: ${report.automaticPromotion.rejectedRule}`);
  console.log("");
  console.log(`incident phases: ${report.incidentPhases.join(" -> ")}`);
  console.log("");
  console.log(`no authority: ${report.noAuthority}`);
}

async function runConstraintsCommand(rest) {
  const args = parseGovernanceArgs(rest, { json: true });
  const report = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_GLOBAL_CONSTRAINTS",
    version: GOVERNANCE_VERSION,
    globalConstraints: GLOBAL_CONSTRAINTS,
    globalConstraintsDigest: GLOBAL_CONSTRAINTS_DIGEST,
    defaultReviewFocus: DEFAULT_REVIEW_FOCUS,
    defaultReviewFocusDigest: DEFAULT_REVIEW_FOCUS_DIGEST,
    authorityLadder: AUTHORITY_LADDER,
    authorityLadderFrozen: true,
    automaticPromotion: AUTOMATIC_PROMOTION_PROHIBITED,
    incidentPhases: INCIDENT_PHASES,
    noAuthority: GOVERNANCE_NO_AUTHORITY_TAG,
    classification: GOVERNANCE_CLASSIFICATION,
  };
  if (args.flags.json) console.log(canonicalJson(report, 2));
  else printHumanConstraints(report);
  process.exitCode = 0;
  return report;
}

/* ============================================================================
 * orchestrate (§16, §17)
 * ==========================================================================*/

const ORCHESTRATE_FLAGS = Object.freeze({
  json: true,
  plan: false,
  "run-id": false,
  implementer: false,
  "protocol-reviewer": false,
  "code-reviewer": false,
  verifier: false,
  "skip-verify": true,
  "review-package": true,
  "allow-declared-write": true,
  "timeout-ms": false,
  base: false,
  head: false,
  command: false,
});

function numberFlag(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * plan-check → scope-check → preservation-before → verification →
 * preservation-after → manifest. Fail closed at every step.
 */
async function runOrchestrateCommand(rest, options = {}) {
  const args = parseGovernanceArgs(rest, ORCHESTRATE_FLAGS, { multi: ["command"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const planPath = stringFlag(args.flags.plan);
  if (planPath === null) {
    console.error("usage: node scripts/evolve-governance.mjs orchestrate --plan <path.md> [options]");
    console.error(USAGE);
    process.exitCode = 1;
    return null;
  }

  const runId = stringFlag(args.flags["run-id"]) ?? newGovernanceId("run");
  const createdAt = new Date().toISOString();
  const problems = [];
  const warnings = [];
  const records = [];

  const writeRecord = async (relative, body) => {
    const record = await writeGovernanceFile(relative, `${canonicalJson(body, 2)}\n`, { projectRoot });
    records.push({ path: record.path, bytes: record.bytes, digest: record.digest });
    return record;
  };

  const worktreeBefore = await worktreeDigestOf({ cwd: projectRoot });

  /* 1. plan-check */
  let planReport;
  try {
    planReport = await checkPlanFile(planPath, { projectRoot });
  } catch (error) {
    console.error(`orchestrate: plan could not be read: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
  await writeRecord(`runs/${runId}/plan-check.json`, planReport);
  if (planReport.status !== "PASS") {
    problems.push(`plan-check did not pass (${planReport.problems.length} problems)`);
    problems.push(...planReport.problems);
  }
  warnings.push(...planReport.warnings);

  /* 2. scope-check */
  const scopeReport = await scopeCheckFromGit({
    planReport,
    projectRoot,
    base: stringFlag(args.flags.base),
    head: stringFlag(args.flags.head) ?? "WORKTREE",
  });
  await writeRecord(`runs/${runId}/scope-check.json`, scopeReport);
  if (scopeReport.status !== "PASS") {
    problems.push(`scope-check did not pass (${scopeReport.counts.OUT_OF_SCOPE} out-of-scope changes)`);
    problems.push(...scopeReport.problems);
  }
  warnings.push(...scopeReport.warnings);

  /* 3. preservation-before */
  const protectedPaths = mergeProtectedPaths(planReport.protectedPaths ?? [], [], projectRoot);
  const preservationBefore = await capturePreservation({ protectedPaths, projectRoot });
  await writeRecord(`runs/${runId}/preservation-before.json`, preservationBefore);

  /* 4. fresh verification */
  const explicitSkip = args.flags["skip-verify"] === true;
  const planBlocked = planReport.status !== "PASS";
  let verification = null;
  if (explicitSkip || planBlocked) {
    const reason = explicitSkip ? "--skip-verify was supplied" : "plan-check did not pass (fail closed)";
    verification = {
      purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
      kind: "GOVERNANCE_VERIFICATION_RECORD",
      runId,
      verdict: "SKIPPED",
      skipped: true,
      reason,
      problems: [],
      warnings: [],
      commands: [],
      counts: {},
      commandPolicy: [],
      verificationDigest: null,
    };
    problems.push(`fresh verification was not run: ${reason}; the run cannot be certified COMPLETE`);
  } else {
    const explicitCommands = asList(args.flags.command);
    verification = await runFreshVerification({
      planReport,
      commands: explicitCommands.length > 0 ? explicitCommands : null,
      runId,
      projectRoot,
      timeoutMs: numberFlag(args.flags["timeout-ms"], DEFAULT_COMMAND_TIMEOUT_MS),
      writeLogs: true,
      preserve: true,
      onProgress: args.flags.json
        ? null
        : (entry) => console.log(`  ... ${entry.status} ${entry.command} (${entry.durationMs}ms)`),
    });
    await writeRecord(`runs/${runId}/verification.json`, verification);
    if (verification.verdict !== "PASS") problems.push(...verification.problems);
    warnings.push(...verification.warnings);
  }

  /* 5. preservation-after */
  const preservationAfter = await capturePreservation({ protectedPaths, projectRoot });
  const preservation = buildPreservationReport({
    before: preservationBefore,
    after: preservationAfter,
    intendedWrites: planReport.intendedWrites ?? [],
    allowDeclaredWrites: Boolean(args.flags["allow-declared-write"]),
    protectedPaths,
    projectRoot,
  });
  await writeRecord(`runs/${runId}/preservation.json`, preservation);
  if (preservation.status !== "PASS") problems.push(...preservation.problems);
  warnings.push(...preservation.warnings);

  return finishOrchestration({
    args,
    runId,
    createdAt,
    projectRoot,
    planPath,
    planReport,
    scopeReport,
    verification,
    preservation,
    protectedPaths,
    preservationBefore,
    preservationAfter,
    worktreeBefore,
    problems,
    warnings,
    records,
    writeRecord,
  });
}

/** Certification, isolation check, manifest assembly and output. */
async function finishOrchestration({
  args,
  runId,
  createdAt,
  projectRoot,
  planPath,
  planReport,
  scopeReport,
  verification,
  preservation,
  preservationBefore,
  preservationAfter,
  worktreeBefore,
  problems,
  warnings,
  records,
  writeRecord,
}) {
  /* 6. optional bounded review package */
  let reviewPackage = null;
  if (args.flags["review-package"] === true) {
    const packageBody = await buildReviewPackage({
      planPath,
      runId,
      base: stringFlag(args.flags.base) ?? "HEAD",
      head: stringFlag(args.flags.head) ?? "WORKTREE",
      projectRoot,
    });
    reviewPackage = await writeReviewPackage(packageBody, { projectRoot });
    records.push({ path: reviewPackage.path, bytes: reviewPackage.bytes, digest: reviewPackage.digest });
  }

  /* 7. independent certification (§3) */
  const certification = assessIndependentCertification({
    implementerIdentity: stringFlag(args.flags.implementer),
    protocolReviewerIdentity: stringFlag(args.flags["protocol-reviewer"]),
    codeReviewerIdentity: stringFlag(args.flags["code-reviewer"]),
    verifierIdentity: stringFlag(args.flags.verifier),
    touchesResearchSemantics: Boolean(planReport.touchesResearchSemantics),
    requireIndependentReview: true,
    implementationComplete: scopeReport.status === "PASS",
    freshVerificationPassed: verification?.verdict === "PASS",
  });
  problems.push(...certification.problems);
  warnings.push(...certification.warnings);

  /* 8. isolation: governance may only have written beneath its own root */
  const { files: finalChanged } = await changedFilesFromGit({ projectRoot });
  const scopeChanged = new Set(scopeReport.changedFiles.map((entry) => entry.path));
  const governanceWrites = finalChanged
    .filter((entry) => isGovernanceRecordPath(entry.path))
    .map((entry) => entry.path);
  const unexpectedWrites = finalChanged
    .filter((entry) => !isGovernanceRecordPath(entry.path) && !scopeChanged.has(entry.path))
    .map((entry) => entry.path);
  if (unexpectedWrites.length > 0) {
    problems.push(
      `governance run observed changes outside the classified scope and outside ${GOVERNANCE_ROOT}/: ${unexpectedWrites.join(", ")}`,
    );
  }
  const worktreeAfter = await worktreeDigestOf({ cwd: projectRoot });

  const status = problems.length === 0 && !certification.incomplete ? "COMPLETE" : "INCOMPLETE";
  const body = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_RUN_MANIFEST",
    version: GOVERNANCE_VERSION,
    runId,
    startedAt: createdAt,
    createdAt,
    finishedAt: new Date().toISOString(),
    status,
    incomplete: status !== "COMPLETE",
    noAuthority: GOVERNANCE_NO_AUTHORITY_TAG,
    classification: GOVERNANCE_CLASSIFICATION,
    gitHead: worktreeBefore.gitHead,
    worktreeDigest: worktreeBefore.worktreeDigest,
    planDigest: planReport.planDigest,
    globalConstraintsDigest: planReport.globalConstraintsDigest,
    roles: GOVERNANCE_ROLES.map((role) => role.name),
    implementerIdentity: certification.identities.implementerIdentity,
    protocolReviewerIdentity: certification.identities.protocolReviewerIdentity,
    codeReviewerIdentity: certification.identities.codeReviewerIdentity,
    verifierIdentity: certification.identities.verifierIdentity,
    independentReviewDeclared: certification.independentReviewDeclared,
    plan: {
      path: planReport.planPath ?? planPath,
      planDigest: planReport.planDigest,
      planCheckStatus: planReport.status,
      declaredFiles: planReport.declaredFilePaths,
      reviewFocus: planReport.reviewFocus,
      protectedPaths: planReport.protectedPaths,
      intendedWrites: planReport.intendedWrites,
      dedicatedValidator: planReport.dedicatedValidator,
      evidenceTreesRelevant: planReport.evidenceTreesRelevant,
      touchesResearchSemantics: planReport.touchesResearchSemantics,
    },
    scope: {
      status: scopeReport.status,
      counts: scopeReport.counts,
      outOfScope: scopeReport.changedFiles
        .filter((entry) => entry.classification === "OUT_OF_SCOPE")
        .map((entry) => entry.path),
      justifications: scopeReport.justifications,
    },
    verification: {
      verdict: verification?.verdict ?? null,
      skipped: Boolean(verification?.skipped),
      counts: verification?.counts ?? {},
      commandPolicy: verification?.commandPolicy ?? [],
      verificationDigest: verification?.verificationDigest ?? null,
    },
    preservation: {
      status: preservation.status,
      protectedPaths: preservation.protectedPaths,
      exempted: preservation.exempted,
      beforeCaptureDigest: preservationBefore.captureDigest,
      afterCaptureDigest: preservationAfter.captureDigest,
      preservationDigest: preservation.preservationDigest,
    },
    certification,
    reviewPackage,
    governanceWrites,
    unexpectedWrites,
    worktree: { before: worktreeBefore, after: worktreeAfter },
    records,
    problems,
    warnings,
  };
  const manifest = { ...body, manifestDigest: sha256Hex(canonicalJson(body)) };
  const manifestRecord = await writeRecord(`runs/${runId}/manifest.json`, manifest);

  if (args.flags.json) console.log(canonicalJson({ manifest, record: manifestRecord }, 2));
  else printHumanManifest(manifest, manifestRecord);
  process.exitCode = manifest.status === "COMPLETE" ? 0 : 1;
  return manifest;
}

function printHumanManifest(manifest, record) {
  console.log(`governance run: ${manifest.runId}`);
  console.log(`status: ${manifest.status}`);
  console.log(`plan: ${manifest.plan.path} plan-check=${manifest.plan.planCheckStatus}`);
  console.log(
    `scope: ${manifest.scope.status} (IN_SCOPE ${manifest.scope.counts.IN_SCOPE}, JUSTIFIED_ADJACENT ${manifest.scope.counts.JUSTIFIED_ADJACENT}, OUT_OF_SCOPE ${manifest.scope.counts.OUT_OF_SCOPE})`,
  );
  console.log(`verification: ${manifest.verification.verdict}${manifest.verification.skipped ? " (skipped)" : ""}`);
  console.log(`preservation: ${manifest.preservation.status} (exempted ${manifest.preservation.exempted.length})`);
  console.log(
    `certification: ${manifest.certification.status} independentReviewDeclared=${manifest.certification.independentReviewDeclared} selfCertificationDetected=${manifest.certification.selfCertificationDetected}`,
  );
  console.log(`governance writes: ${manifest.governanceWrites.length}`);
  console.log(`unexpected writes: ${manifest.unexpectedWrites.length}`);
  console.log(`records: ${manifest.records.length}`);
  for (const entry of manifest.records) console.log(`  ${entry.path} (${entry.bytes} bytes)`);
  for (const problem of manifest.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of manifest.warnings) console.log(`WARNING: ${warning}`);
  console.log(`manifestDigest: ${manifest.manifestDigest}`);
  console.log(`no authority: ${manifest.noAuthority}`);
  if (record) console.log(`written: ${record.path} (${record.bytes} bytes)`);
}

/* ============================================================================
 * Dispatcher
 * ==========================================================================*/

const COMMANDS = Object.freeze({
  roles: (rest) => runRolesCommand(rest),
  constraints: (rest) => runConstraintsCommand(rest),
  "plan-check": (rest) => runPlanCheckCli(rest),
  "scope-check": (rest) => runScopeCheckCli(rest),
  "review-package": (rest) => runReviewPackageCli(rest),
  verify: (rest) => runVerifyCli(rest),
  preservation: (rest) => runPreservationCli(rest),
  incident: (rest) => runIncidentCli(rest),
  "external-policy": (rest) => runExternalPolicyCli(rest),
  orchestrate: (rest) => runOrchestrateCommand(rest),
});

export async function runGovernanceCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exitCode = command === undefined ? 1 : 0;
    return null;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    console.error(`unknown governance command: ${command}`);
    console.error(USAGE);
    process.exitCode = 1;
    return null;
  }
  return handler(rest);
}

export { governanceRootAbsolute, PROJECT_ROOT };

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) await runGovernanceCli();
