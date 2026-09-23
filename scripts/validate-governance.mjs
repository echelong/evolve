#!/usr/bin/env node
/**
 * Deterministic, offline validation for EVOLVE Development Governance.
 *
 * This validator uses temporary fixtures for mutation and secret tests. It does
 * not run providers, Jupiter, Jev, supervisor, Paper Shadow, Temporal work, or
 * any normal trading/research runtime.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256Hex } from "./lib/hash.mjs";
import {
  AUTHORITY_LADDER,
  DEFAULT_REVIEW_FOCUS,
  DEFAULT_PROTECTED_PATHS,
  GLOBAL_CONSTRAINTS,
  GLOBAL_CONSTRAINTS_DIGEST,
  GOVERNANCE_ROOT,
  MIN_REVIEW_FOCUS_ITEMS,
  REQUIRED_PLAN_SECTIONS,
} from "./governance/definition.mjs";
import {
  GOVERNANCE_ROLES,
  assessIndependentCertification,
  fiveRoleSeparationReport,
} from "./governance/roles.mjs";
import { parsePlan, checkPlan } from "./governance/plan-check.mjs";
import { changedFilesBetweenRefs, checkScope, classifyFile } from "./governance/scope-check.mjs";
import {
  boundedText,
  buildReviewPackage,
  collectRelevantFiles,
  sanitizeText,
  secretPolicyFor,
} from "./governance/review-package.mjs";
import {
  capturePreservation,
  comparePreservation,
} from "./governance/preservation.mjs";
import {
  applyIncidentUpdate,
  evaluateIncident,
  finalizeIncident,
  newIncident,
} from "./governance/incident.mjs";
import {
  DEFAULT_EXTERNAL_POLICY,
  externalPolicyRecord,
  validateExternalPolicy,
} from "./governance/external-policy.mjs";
import {
  assertGovernanceWriteTarget,
  governancePath,
} from "./governance/storage.mjs";
import { commandPolicyFor, runFreshVerification } from "./governance/verify.mjs";

const checks = [];
const pendingChecks = [];
const execFileAsync = promisify(execFile);
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: "PASS" });
  } catch (error) {
    checks.push({ name, status: "FAIL", error: error.message });
  }
}
async function checkAsync(name, fn) {
  pendingChecks.push((async () => {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
    } catch (error) {
      checks.push({ name, status: "FAIL", error: error.message });
    }
  })());
}
function expectFailure(fn, message) {
  assert.throws(fn, message);
}

function validPlanText({ files = ["scripts/example.mjs"], focus = DEFAULT_REVIEW_FOCUS } = {}) {
  return [
    "# Goal",
    "Deliver a bounded development change with independently verifiable behavior.",
    "# Architecture",
    "Keep the implementation isolated from paper trading and research evidence runtimes.",
    "# Files / scope",
    ...files.map((file) => `- ${file}`),
    "# Global Constraints",
    `Global Constraints digest: ${GLOBAL_CONSTRAINTS_DIGEST}`,
    "# Review Focus",
    ...focus.map((item) => `- ${item}`),
    "# Verification",
    "Research/evidence semantics: no",
    "Dedicated validator: npm run validate:governance",
    "Run the declared validator and the repository's fresh validation suite.",
  ].join("\n");
}

check("five role contracts are complete", () => {
  assert.equal(GOVERNANCE_ROLES.length, 5);
  assert.equal(fiveRoleSeparationReport().ok, true);
  for (const role of GOVERNANCE_ROLES) {
    for (const field of ["name", "mission", "allowedResponsibilities", "forbiddenResponsibilities", "requiredInputs", "requiredOutputs", "completionConditions"]) {
      assert.ok(role[field]);
    }
  }
});

check("implementer self-certification is detected", () => {
  const report = assessIndependentCertification({
    implementerIdentity: "same-person",
    codeReviewerIdentity: "same-person",
    verifierIdentity: "same-person",
    protocolReviewerIdentity: "independent",
    touchesResearchSemantics: true,
  });
  assert.equal(report.selfCertificationDetected, true);
  assert.equal(report.status, "INCOMPLETE");
  const researchWithoutProtocol = assessIndependentCertification({
    implementerIdentity: "implementer",
    codeReviewerIdentity: "code-reviewer",
    verifierIdentity: "verifier",
    touchesResearchSemantics: true,
  });
  assert.equal(researchWithoutProtocol.status, "INCOMPLETE");
  assert.ok(researchWithoutProtocol.problems.some((problem) => problem.includes("protocolReviewerIdentity")));
});

check("Global Constraints digest is deterministic", () => {
  assert.equal(GLOBAL_CONSTRAINTS.length, 15);
  assert.equal(sha256Hex(canonicalJson(GLOBAL_CONSTRAINTS)), GLOBAL_CONSTRAINTS_DIGEST);
  assert.equal(new Set(GLOBAL_CONSTRAINTS).size, GLOBAL_CONSTRAINTS.length);
});

check("valid plan passes", () => {
  const report = checkPlan(parsePlan({ planText: validPlanText(), planPath: "fixture.md" }));
  assert.equal(report.status, "PASS");
  assert.equal(report.reviewFocus.length, MIN_REVIEW_FOCUS_ITEMS);
});

check("plan requirements and placeholders fail closed", () => {
  const missing = checkPlan(parsePlan({ planText: "# Goal\nTBD", planPath: "missing.md" }));
  assert.equal(missing.status, "FAIL");
  assert.ok(missing.problems.some((problem) => problem.includes("Global Constraints")));
  const weakFocus = checkPlan(parsePlan({ planText: validPlanText({ focus: ["one", "two", "three", "four"] }), planPath: "weak.md" }));
  assert.equal(weakFocus.status, "FAIL");
  assert.ok(weakFocus.problems.some((problem) => problem.includes("Review Focus")));
  const placeholder = checkPlan(parsePlan({ planText: `${validPlanText()}\nTODO implement later`, planPath: "placeholder.md" }));
  assert.equal(placeholder.status, "FAIL");
  const missingClassification = checkPlan(
    parsePlan({ planText: validPlanText().replace("Research/evidence semantics: no\n", ""), planPath: "classification-missing.md" }),
  );
  assert.equal(missingClassification.status, "FAIL");
  assert.ok(missingClassification.problems.some((problem) => problem.includes("Research/evidence semantics")));
  assert.equal(
    checkPlan(parsePlan({ planText: validPlanText().replace("# Files / scope", "# Files and scope") })).status,
    "PASS",
  );
  const contradictoryResearchPlan = validPlanText({ files: [".evolve/arenas/"] });
  const contradictoryParsed = parsePlan({ planText: contradictoryResearchPlan });
  assert.equal(contradictoryParsed.touchesResearchSemantics, true);
  assert.equal(checkPlan(contradictoryParsed).status, "FAIL");
  assert.ok(checkPlan(contradictoryParsed).problems.some((problem) => problem.includes("marked no")));
});

check("scope classifications enforce minimal change", () => {
  const base = { declaredPaths: ["scripts/example.mjs"], justifications: [], projectRoot: process.cwd() };
  assert.equal(classifyFile("scripts/example.mjs", base).classification, "IN_SCOPE");
  assert.equal(classifyFile("package.json", base).classification, "OUT_OF_SCOPE");
  assert.equal(classifyFile("package.json", { ...base, justifications: [{ path: "package.json", reason: "package script is required by the plan" }] }).classification, "JUSTIFIED_ADJACENT");
  const report = checkScope({ changedFiles: ["scripts/example.mjs", "package.json"], ...base });
  assert.equal(report.counts.IN_SCOPE, 1);
  assert.equal(report.counts.OUT_OF_SCOPE, 1);
});

check("review package sanitizer and bounds are explicit", () => {
  const sanitized = sanitizeText([
    "API_KEY=secretvalue",
    "EVOLVE_JEV_API_KEY=secretvalue",
    "Authorization: Bearer abc123",
    "authorization: bearer abc123",
    "Authorization: Basic credentials",
    "Cookie: sid=abc123",
    "Set-Cookie: sid=abc123; HttpOnly",
    "https://user:password@example.test/x",
    '{"apiKey":"secretvalue","password":"secretvalue"}',
    "api_key='secretvalue'",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
  ].join("\n"));
  assert.equal(sanitized.changed, true);
  for (const secret of ["secretvalue", "abc123", "credentials", "user:password", "eyJhbGciOiJIUzI1NiJ9"]) {
    assert.ok(!sanitized.text.includes(secret), secret);
  }
  const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.ok(sanitizeText(`sha256 ${digest}`).text.includes(digest));
  const bounded = boundedText("0123456789", 4);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.omittedBytes, 6);
  const policy = secretPolicyFor([".env.local", "scripts/example.mjs"]);
  assert.ok(policy.excludedPaths.includes(".env.local"));
});

checkAsync("review package carries bounded scope, commits and canonical constraints", async () => {
  const packageBody = await buildReviewPackage({
    base: "HEAD",
    head: "WORKTREE",
    projectRoot: process.cwd(),
    bounds: { maxDiffBytes: 256, maxFileBytes: 256, maxLogBytes: 256, maxFiles: 1 },
  });
  assert.equal(packageBody.globalConstraintsDigest, GLOBAL_CONSTRAINTS_DIGEST);
  assert.equal(packageBody.scopeCheck.classification.purpose, "EVOLVE_DEVELOPMENT_GOVERNANCE");
  assert.ok(packageBody.changeSet.commits);
  assert.equal(packageBody.changeSet.diffTruncated, true);
  assert.equal(packageBody.changeSet.diffOmittedBytes > 0, true);
  assert.equal(packageBody.changeSet.changedFilesTruncated, true);
  assert.equal(packageBody.scopeCheck.changedFilesTruncated, true);
});

checkAsync("WORKTREE scope discovery includes tracked adds/deletes/renames and untracked names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-governance-scope-"));
  try {
    const git = (args) => execFileAsync("git", args, { cwd: root });
    await git(["init", "-q"]);
    await git(["config", "user.email", "governance@example.invalid"]);
    await git(["config", "user.name", "Governance Fixture"]);
    await writeFile(path.join(root, "old name.txt"), "old\n");
    await writeFile(path.join(root, "deleted.js"), "deleted\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "fixture base"]);
    await rename(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
    await rm(path.join(root, "deleted.js"));
    await writeFile(path.join(root, "added tracked.txt"), "added\n");
    await git(["add", "-A"]);
    await writeFile(path.join(root, "untracked file.txt"), "untracked\n");
    const discovered = await changedFilesBetweenRefs({ base: "HEAD", head: "WORKTREE", projectRoot: root });
    const names = discovered.files.map((entry) => entry.path);
    for (const expected of ["new name.txt", "deleted.js", "added tracked.txt", "untracked file.txt"]) {
      assert.ok(names.includes(expected), expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

checkAsync("fresh verification records command evidence and failures", async () => {
  const pass = await runFreshVerification({ commands: ["node -e \"process.stdout.write('fresh')\""], writeLogs: false, projectRoot: process.cwd() });
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.commands.length, 1);
  assert.equal(pass.commands[0].exitCode, 0);
  for (const field of ["command", "startedAt", "finishedAt", "durationMs", "exitCode", "stdoutDigest", "stderrDigest", "status"]) assert.ok(pass.commands[0][field] !== undefined);
  const fail = await runFreshVerification({ commands: ["node -e \"process.exit(7)\""], writeLogs: false, projectRoot: process.cwd() });
  assert.equal(fail.verdict, "FAIL");
  assert.equal(fail.commands[0].exitCode, 7);
  assert.ok(commandPolicyFor({ commands: ["git diff --check"] }).includes("git diff --check"));
});

check("authority ladder is frozen and cannot auto-promote", () => {
  assert.deepEqual(AUTHORITY_LADDER, ["OBSERVE", "SHADOW", "DEVELOPMENT EVIDENCE", "INDEPENDENT REPLICATION", "TEMPORAL / GENERALIZATION REPLICATION", "UNTOUCHED EVALUATION", "HUMAN / PROTOCOL GATE", "ONLY THEN CONSIDER MORE AUTHORITY"]);
});

check("external policy requires bounds, provider/model and evidence fail-closed behavior", () => {
  assert.equal(validateExternalPolicy({}, { evidenceBearing: true }).status, "FAIL");
  const valid = validateExternalPolicy({ ...DEFAULT_EXTERNAL_POLICY, provider: "fixture", model: "fixture", evidenceBearing: true, fallback: "none", failClosed: true }, { evidenceBearing: true });
  assert.equal(valid.status, "PASS");
  assert.equal(validateExternalPolicy({ ...DEFAULT_EXTERNAL_POLICY, provider: "fixture", model: "fixture", evidenceBearing: true, fallback: "retry", failClosed: false }, { evidenceBearing: true }).status, "FAIL");
  assert.equal(validateExternalPolicy({ ...DEFAULT_EXTERNAL_POLICY, provider: "fixture", model: "fixture", timeoutMs: "60000" }).status, "FAIL");
  assert.equal(validateExternalPolicy({ ...DEFAULT_EXTERNAL_POLICY, provider: "fixture", model: "fixture", pricingKnown: true, costAccounting: null }).status, "FAIL");
  assert.equal(externalPolicyRecord({ candidate: {}, evidenceBearing: false }).validation.status, "FAIL");
});

check("incident cannot jump to VERIFIED and escalates after three distinct refutations", () => {
  const opened = newIncident({ title: "fixture failure", observed: "fixture symptom" });
  assert.notEqual(evaluateIncident(opened).status, "VERIFIED");
  let current = opened;
  for (const statement of ["cause one", "cause two", "cause three"]) {
    current = applyIncidentUpdate(current, { hypothesis: statement }).incident;
    current = applyIncidentUpdate(current, { hypothesisId: `h${current.hypotheses.length}`, hypothesisResult: "REFUTED", hypothesisEvidence: "minimal fixture test" }).incident;
  }
  const escalated = evaluateIncident(current);
  assert.equal(escalated.architectureReviewRequired, true);
  assert.notEqual(escalated.status, "VERIFIED");
  const fixedWithoutCause = applyIncidentUpdate(opened, { fix: "unproven fix" }).incident;
  assert.equal(evaluateIncident(fixedWithoutCause).canClaimFix, false);
  const reviewed = applyIncidentUpdate(current, { architectureNote: "reviewed the system boundary before another fix" }).incident;
  assert.equal(finalizeIncident(reviewed).incident.architectureReview.required, true);
  let afterReview = applyIncidentUpdate(current, { hypothesis: "confirmed root cause" }).incident;
  afterReview = applyIncidentUpdate(afterReview, { hypothesisId: "h4", hypothesisResult: "CONFIRMED", hypothesisEvidence: "boundary fixture" }).incident;
  afterReview = applyIncidentUpdate(afterReview, { minimalTest: "fixture test", failsBeforeFix: true, passesAfterFix: true, fix: "bounded fix" }).incident;
  afterReview = applyIncidentUpdate(afterReview, { verdict: "PASS", verificationCommands: ["fixture verifier"], runId: "fixture-run" }).incident;
  assert.equal(evaluateIncident(afterReview).status, "ESCALATED_ARCHITECTURE_REVIEW");
  const afterArchitectureReview = applyIncidentUpdate(afterReview, { architectureNote: "reviewed the system boundary and rejected another ad-hoc patch" }).incident;
  assert.equal(evaluateIncident(afterArchitectureReview).status, "VERIFIED");
});

checkAsync("protected tree preservation detects mutation and missing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-governance-"));
  try {
    const protectedDir = path.join(root, ".evolve", "fixture-evidence");
    await mkdir(protectedDir, { recursive: true });
    await writeFile(path.join(protectedDir, "record.json"), "original\n");
    const before = await capturePreservation({ protectedPaths: [".evolve/fixture-evidence/"], projectRoot: root });
    await writeFile(path.join(protectedDir, "record.json"), "changed\n");
    const after = await capturePreservation({ protectedPaths: [".evolve/fixture-evidence/"], projectRoot: root });
    assert.equal(comparePreservation(before, after).preserved, false);
    await rm(path.join(protectedDir, "record.json"));
    const missing = await capturePreservation({ protectedPaths: [".evolve/fixture-evidence/"], projectRoot: root });
    assert.equal(comparePreservation(before, missing).preserved, false);
    await writeFile(path.join(protectedDir, "record.json"), "original\n");
    await writeFile(path.join(protectedDir, "new.json"), "new\n");
    const added = await capturePreservation({ protectedPaths: [".evolve/fixture-evidence/"], projectRoot: root });
    assert.equal(comparePreservation(before, added).preserved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

checkAsync(".env content is never collected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-governance-secrets-"));
  try {
    await writeFile(path.join(root, ".env.local"), "API_KEY=do-not-package\n");
    await writeFile(path.join(root, "safe.txt"), "safe\n");
    const files = await collectRelevantFiles({ paths: [".env.local", "safe.txt"], projectRoot: root });
    const secret = files.find((entry) => entry.path === ".env.local");
    assert.equal(secret.included, false);
    assert.ok(!JSON.stringify(files).includes("do-not-package"));
    const git = (args) => execFileAsync("git", args, { cwd: root });
    await git(["init", "-q"]);
    await git(["config", "user.email", "governance@example.invalid"]);
    await git(["config", "user.name", "Governance Fixture"]);
    await git(["add", "."]);
    await git(["commit", "-qm", "secret fixture"]);
    await writeFile(path.join(root, ".env.local"), "API_KEY=changed-secret\n");
    const packageBody = await buildReviewPackage({ projectRoot: root, base: "HEAD", head: "WORKTREE" });
    assert.ok(!packageBody.changeSet.diff.includes("do-not-package"));
    assert.ok(!packageBody.changeSet.diff.includes("changed-secret"));
    assert.ok(!packageBody.changeSet.diff.includes(".env.local"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

check("governance storage is confined", () => {
  assert.ok(governancePath("nested.json").endsWith(path.join(GOVERNANCE_ROOT, "nested.json")));
  expectFailure(() => assertGovernanceWriteTarget(path.join(process.cwd(), "README.md")), /may only write beneath/);
  assert.deepEqual(DEFAULT_PROTECTED_PATHS.length, 6);
  assert.deepEqual(REQUIRED_PLAN_SECTIONS.length, 6);
});

await Promise.all(pendingChecks);
const failed = checks.filter((entry) => entry.status === "FAIL");
console.log(`governance validation: ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.length} checks)`);
for (const entry of checks) console.log(`${entry.status} ${entry.name}${entry.error ? ` — ${entry.error}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;
