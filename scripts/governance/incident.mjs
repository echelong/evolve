/**
 * EVOLVE Development Governance v1 — root-cause incident workflow (§11, §12).
 *
 * Bug diagnosis follows explicit phases:
 *
 *   OBSERVED → REPRODUCED → EVIDENCE_GATHERED → ROOT_CAUSE_HYPOTHESIS
 *   → MINIMAL_TEST → FIX → VERIFIED
 *
 * NO FIX CLAIM WITHOUT ROOT-CAUSE EVIDENCE: a fix may not be claimed until a
 * hypothesis is CONFIRMED by evidence, and the incident may not be marked
 * VERIFIED until the minimal test passes after the fix and fresh verification
 * passed.
 *
 * After three DISTINCT failed hypotheses for the same incident,
 * `architectureReviewRequired` becomes true and a fourth ad-hoc fix cannot be
 * marked VERIFIED until an explicit architecture-review note is supplied.
 * Governance never modifies architecture automatically.
 *
 * DEVELOPMENT GOVERNANCE ONLY — the only writes are incident records beneath
 * `.evolve/governance/incidents/`.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import {
  ARCHITECTURE_ESCALATION_RULE,
  ARCHITECTURE_ESCALATION_THRESHOLD,
  GOVERNANCE_CLASSIFICATION,
  INCIDENT_PHASES,
  INCIDENT_ROOT_CAUSE_RULE,
} from "./definition.mjs";
import {
  PROJECT_ROOT,
  governanceSubdir,
  newGovernanceId,
  readGovernanceFile,
  writeGovernanceFile,
} from "./storage.mjs";

export const HYPOTHESIS_RESULTS = Object.freeze(["PENDING", "CONFIRMED", "REFUTED"]);

export const INCIDENT_STATUSES = Object.freeze([
  "OPEN",
  "IN_PROGRESS",
  "ROOT_CAUSE_CONFIRMED",
  "FIXED_PENDING_VERIFICATION",
  "ESCALATED_ARCHITECTURE_REVIEW",
  "VERIFIED",
]);

/** A new, empty incident record. Nothing is inferred; every field starts null. */
export function newIncident({ incidentId = null, title = null, observed = null } = {}) {
  const now = new Date().toISOString();
  return {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_INCIDENT_RECORD",
    incidentId: incidentId ?? newGovernanceId("incident"),
    createdAt: now,
    updatedAt: now,
    title: title === null ? null : String(title),
    rule: INCIDENT_ROOT_CAUSE_RULE,
    escalationRule: ARCHITECTURE_ESCALATION_RULE,
    observed: {
      description: observed === null ? null : String(observed),
      observedAt: observed === null ? null : now,
      evidence: [],
    },
    reproduced: { reproduced: false, command: null, steps: null, evidence: [] },
    evidenceGathered: [],
    hypotheses: [],
    minimalTest: { path: null, command: null, failsBeforeFix: null, passesAfterFix: null, addedAt: null },
    fix: { description: null, changedFiles: [], addedAt: null },
    verification: { commands: [], verdict: null, verifiedAt: null, runId: null },
    architectureReview: { required: false, note: null, reviewedAt: null },
    history: [{ at: now, action: "OPENED", note: "incident record created" }],
    classification: GOVERNANCE_CLASSIFICATION,
  };
}

function pushHistory(incident, action, note) {
  return [...(incident.history ?? []), { at: new Date().toISOString(), action, note: note ?? null }];
}

/**
 * Apply one explicit update to an incident record. Records are immutable: this
 * returns a new object and never mutates the input. Unusable fields are reported
 * through the returned `ignored` list instead of being silently dropped.
 */
export function applyIncidentUpdate(incident, update = {}) {
  const now = new Date().toISOString();
  const next = structuredClone(incident);
  const ignored = [];

  if (typeof update.title === "string" && update.title.trim().length > 0) next.title = update.title.trim();

  if (typeof update.observed === "string" && update.observed.trim().length > 0) {
    next.observed.description = update.observed.trim();
    next.observed.observedAt = next.observed.observedAt ?? now;
    next.history = pushHistory(next, "OBSERVED", update.observed.trim());
  }

  if (update.reproduced === true || typeof update.reproCommand === "string" || typeof update.reproSteps === "string") {
    if (typeof update.reproCommand === "string") next.reproduced.command = update.reproCommand.trim();
    if (typeof update.reproSteps === "string") next.reproduced.steps = update.reproSteps.trim();
    if (update.reproduced === true) {
      next.reproduced.reproduced = true;
      next.history = pushHistory(next, "REPRODUCED", next.reproduced.command ?? next.reproduced.steps);
    }
  }

  for (const entry of update.evidence ?? []) {
    const reference = typeof entry === "string" ? entry : entry?.reference;
    if (!reference) {
      ignored.push("evidence entry without a reference");
      continue;
    }
    next.evidenceGathered.push({
      kind: typeof entry === "object" && entry !== null ? (entry.kind ?? "reference") : "reference",
      reference: String(reference),
      note: typeof entry === "object" && entry !== null ? (entry.note ?? null) : null,
      addedAt: now,
    });
    next.history = pushHistory(next, "EVIDENCE_GATHERED", String(reference));
  }

  if (typeof update.hypothesis === "string" && update.hypothesis.trim().length > 0) {
    next.hypotheses.push({
      id: `h${next.hypotheses.length + 1}`,
      statement: update.hypothesis.trim(),
      predictedObservation: update.predictedObservation ?? null,
      testCommand: update.testCommand ?? null,
      result: "PENDING",
      evidence: [],
      addedAt: now,
      resolvedAt: null,
    });
    next.history = pushHistory(next, "ROOT_CAUSE_HYPOTHESIS", update.hypothesis.trim());
  }

  if (typeof update.hypothesisId === "string" && typeof update.hypothesisResult === "string") {
    const result = update.hypothesisResult.trim().toUpperCase();
    const target = next.hypotheses.find((entry) => entry.id === update.hypothesisId);
    if (!target) ignored.push(`unknown hypothesis id: ${update.hypothesisId}`);
    else if (!HYPOTHESIS_RESULTS.includes(result)) ignored.push(`unknown hypothesis result: ${result}`);
    else {
      target.result = result;
      target.resolvedAt = now;
      if (typeof update.hypothesisEvidence === "string") target.evidence.push(update.hypothesisEvidence.trim());
      next.history = pushHistory(next, `HYPOTHESIS_${result}`, `${target.id}: ${target.statement}`);
    }
  }

  if (typeof update.minimalTest === "string" && update.minimalTest.trim().length > 0) {
    next.minimalTest.path = update.minimalTest.trim();
    next.minimalTest.addedAt = now;
    next.history = pushHistory(next, "MINIMAL_TEST", update.minimalTest.trim());
  }
  if (typeof update.minimalTestCommand === "string") next.minimalTest.command = update.minimalTestCommand.trim();
  if (update.failsBeforeFix === true || update.failsBeforeFix === false) {
    next.minimalTest.failsBeforeFix = update.failsBeforeFix;
  }
  if (update.passesAfterFix === true || update.passesAfterFix === false) {
    next.minimalTest.passesAfterFix = update.passesAfterFix;
  }

  if (typeof update.fix === "string" && update.fix.trim().length > 0) {
    next.fix.description = update.fix.trim();
    next.fix.addedAt = now;
    next.history = pushHistory(next, "FIX", update.fix.trim());
  }
  for (const changed of update.changedFiles ?? []) {
    const text = String(changed).trim();
    if (text.length > 0 && !next.fix.changedFiles.includes(text)) next.fix.changedFiles.push(text);
  }

  if (typeof update.verdict === "string" && update.verdict.trim().length > 0) {
    next.verification.verdict = update.verdict.trim().toUpperCase();
    next.verification.verifiedAt = now;
    if (typeof update.runId === "string") next.verification.runId = update.runId.trim();
    for (const command of update.verificationCommands ?? []) {
      const text = String(command).trim();
      if (text.length > 0 && !next.verification.commands.includes(text)) next.verification.commands.push(text);
    }
    next.history = pushHistory(next, "VERIFICATION_RECORDED", next.verification.verdict);
  }

  if (typeof update.architectureNote === "string" && update.architectureNote.trim().length > 0) {
    next.architectureReview.note = update.architectureNote.trim();
    next.architectureReview.reviewedAt = now;
    next.history = pushHistory(next, "ARCHITECTURE_REVIEW", update.architectureNote.trim());
  }

  next.updatedAt = now;
  return { incident: next, ignored };
}

/* ============================================================================
 * Phase evaluation (§11) and escalation (§12)
 * ==========================================================================*/

/**
 * Evaluate an incident against the phase ladder. Pure: it never mutates the
 * record and never invents evidence.
 */
export function evaluateIncident(incident) {
  const hypotheses = incident?.hypotheses ?? [];
  const statementOf = (entry) => String(entry?.statement ?? "").trim().toLowerCase();
  const distinctStatements = new Set(hypotheses.map(statementOf).filter(Boolean));
  const refuted = hypotheses.filter((entry) => entry.result === "REFUTED");
  const distinctRefuted = new Set(refuted.map(statementOf).filter(Boolean));
  const confirmed = hypotheses.find((entry) => entry.result === "CONFIRMED") ?? null;

  const architectureReviewRequired = distinctRefuted.size >= ARCHITECTURE_ESCALATION_THRESHOLD;
  const architectureNote = incident?.architectureReview?.note ?? null;

  const minimalTest = incident?.minimalTest ?? {};
  const minimalTestPresent = Boolean(minimalTest.path || minimalTest.command);
  const fixClaimed = Boolean(incident?.fix?.description);
  const verificationPassed = String(incident?.verification?.verdict ?? "").toUpperCase() === "PASS";

  const canClaimFix = Boolean(confirmed);
  const blockingReasons = [];
  if (!confirmed) blockingReasons.push("no CONFIRMED root-cause hypothesis");
  if (!minimalTestPresent) blockingReasons.push("no minimal test recorded");
  if (minimalTest.passesAfterFix !== true) {
    blockingReasons.push("minimal test is not recorded as passing after the fix");
  }
  if (!verificationPassed) blockingReasons.push("fresh verification did not pass");
  if (architectureReviewRequired && !architectureNote) {
    blockingReasons.push(
      `architecture review required after ${distinctRefuted.size} distinct refuted hypotheses; no architecture-review note supplied`,
    );
  }
  const canMarkVerified = blockingReasons.length === 0;

  const phases = {
    OBSERVED: Boolean(incident?.observed?.description),
    REPRODUCED: Boolean(incident?.reproduced?.reproduced),
    EVIDENCE_GATHERED: (incident?.evidenceGathered ?? []).length > 0,
    ROOT_CAUSE_HYPOTHESIS: Boolean(confirmed),
    MINIMAL_TEST: minimalTestPresent && minimalTest.failsBeforeFix === true,
    FIX: fixClaimed && Boolean(confirmed),
    VERIFIED: canMarkVerified,
  };
  const currentPhase = INCIDENT_PHASES.find((phase) => !phases[phase]) ?? "VERIFIED";

  const problems = [];
  const warnings = [];
  if (fixClaimed && !confirmed) {
    problems.push(`${INCIDENT_ROOT_CAUSE_RULE}: a fix is claimed but no hypothesis is CONFIRMED`);
  }
  if (verificationPassed && !canMarkVerified) {
    problems.push(`incident may not be marked VERIFIED: ${blockingReasons.join("; ")}`);
  }
  if (minimalTestPresent && minimalTest.failsBeforeFix !== true) {
    warnings.push("minimal test is not recorded as failing before the fix");
  }
  if (architectureReviewRequired) {
    warnings.push(
      `${ARCHITECTURE_ESCALATION_THRESHOLD} distinct refuted hypotheses reached — ${ARCHITECTURE_ESCALATION_RULE}`,
    );
  }

  let status = "OPEN";
  if (phases.REPRODUCED || phases.EVIDENCE_GATHERED) status = "IN_PROGRESS";
  if (confirmed) status = "ROOT_CAUSE_CONFIRMED";
  if (fixClaimed && confirmed && !canMarkVerified) status = "FIXED_PENDING_VERIFICATION";
  if (architectureReviewRequired && !architectureNote) status = "ESCALATED_ARCHITECTURE_REVIEW";
  if (canMarkVerified) status = "VERIFIED";

  const evaluation = {
    incidentId: incident?.incidentId ?? null,
    title: incident?.title ?? null,
    rule: INCIDENT_ROOT_CAUSE_RULE,
    escalationRule: ARCHITECTURE_ESCALATION_RULE,
    phaseOrder: INCIDENT_PHASES,
    phases,
    currentPhase,
    status,
    hypothesisCount: hypotheses.length,
    distinctHypothesisCount: distinctStatements.size,
    refutedCount: refuted.length,
    distinctRefutedCount: distinctRefuted.size,
    confirmedHypothesis: confirmed,
    architectureReviewRequired,
    architectureReviewNote: architectureNote,
    minimalTestPresent,
    fixClaimed,
    verificationPassed,
    canClaimFix,
    canMarkVerified,
    blockingReasons,
    problems,
    warnings,
  };
  return { ...evaluation, evaluationDigest: sha256Hex(canonicalJson(evaluation)) };
}

/** Sync the escalation flag onto the record and return both. */
export function finalizeIncident(incident) {
  const evaluation = evaluateIncident(incident);
  const next = structuredClone(incident);
  next.architectureReview.required = evaluation.architectureReviewRequired;
  return { incident: next, evaluation };
}

/* ============================================================================
 * Storage (governance-confined)
 * ==========================================================================*/

export function incidentRelativePath(incidentId) {
  return `incidents/${incidentId}/incident.json`;
}

export async function loadIncident(incidentId, options = {}) {
  return JSON.parse(await readGovernanceFile(incidentRelativePath(incidentId), options));
}

export async function saveIncident(incident, options = {}) {
  return writeGovernanceFile(incidentRelativePath(incident.incidentId), `${canonicalJson(incident, 2)}\n`, options);
}

export async function listIncidents(options = {}) {
  try {
    const dir = governanceSubdir("incidents", options);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/* ============================================================================
 * CLI
 * ==========================================================================*/

function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function stringFlag(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const INCIDENT_FLAGS = Object.freeze({
  json: true,
  action: false,
  "incident-id": false,
  title: false,
  observed: false,
  reproduced: true,
  "repro-command": false,
  "repro-steps": false,
  evidence: false,
  hypothesis: false,
  "predicted-observation": false,
  "test-command": false,
  "hypothesis-id": false,
  "hypothesis-result": false,
  "hypothesis-evidence": false,
  "minimal-test": false,
  "minimal-test-command": false,
  "fails-before-fix": true,
  "passes-after-fix": true,
  fix: false,
  changed: false,
  verdict: false,
  "verification-command": false,
  "run-id": false,
  "architecture-note": false,
});

/** Turn CLI flags into one explicit update object. */
export function collectIncidentUpdate(flags = {}) {
  const update = {};
  const setString = (key, flag) => {
    const value = stringFlag(flags[flag]);
    if (value !== null) update[key] = value;
  };
  setString("title", "title");
  setString("observed", "observed");
  setString("reproCommand", "repro-command");
  setString("reproSteps", "repro-steps");
  if (flags.reproduced === true) update.reproduced = true;
  const evidence = asList(flags.evidence);
  if (evidence.length > 0) update.evidence = evidence;
  setString("hypothesis", "hypothesis");
  setString("predictedObservation", "predicted-observation");
  setString("testCommand", "test-command");
  setString("hypothesisId", "hypothesis-id");
  setString("hypothesisResult", "hypothesis-result");
  setString("hypothesisEvidence", "hypothesis-evidence");
  setString("minimalTest", "minimal-test");
  setString("minimalTestCommand", "minimal-test-command");
  if (flags["fails-before-fix"] === true) update.failsBeforeFix = true;
  if (flags["passes-after-fix"] === true) update.passesAfterFix = true;
  setString("fix", "fix");
  const changed = asList(flags.changed);
  if (changed.length > 0) update.changedFiles = changed;
  setString("verdict", "verdict");
  const verificationCommands = asList(flags["verification-command"]);
  if (verificationCommands.length > 0) update.verificationCommands = verificationCommands;
  setString("runId", "run-id");
  setString("architectureNote", "architecture-note");
  return update;
}

function printHumanIncident(payload) {
  const evaluation = payload.evaluation;
  console.log(`incident: ${evaluation.incidentId}`);
  console.log(`title: ${evaluation.title ?? "(none)"}`);
  console.log(`status: ${evaluation.status}`);
  console.log(`currentPhase: ${evaluation.currentPhase}`);
  console.log(
    `phases: ${evaluation.phaseOrder.map((phase) => `${phase}=${evaluation.phases[phase] ? "yes" : "no"}`).join(" ")}`,
  );
  console.log(
    `hypotheses: ${evaluation.hypothesisCount} (distinct ${evaluation.distinctHypothesisCount}, refuted ${evaluation.refutedCount}, distinct refuted ${evaluation.distinctRefutedCount})`,
  );
  console.log(`confirmedHypothesis: ${evaluation.confirmedHypothesis?.statement ?? "(none)"}`);
  console.log(`architectureReviewRequired: ${evaluation.architectureReviewRequired}`);
  console.log(`canClaimFix: ${evaluation.canClaimFix}  canMarkVerified: ${evaluation.canMarkVerified}`);
  for (const reason of evaluation.blockingReasons) console.log(`BLOCKED: ${reason}`);
  for (const problem of evaluation.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of evaluation.warnings) console.log(`WARNING: ${warning}`);
  for (const ignored of payload.ignored ?? []) console.log(`IGNORED: ${ignored}`);
  if (payload.record) console.log(`written: ${payload.record.path} (${payload.record.bytes} bytes)`);
}

/**
 * `incident --action open|update|show|list [--incident-id <id>] [--title <text>]
 * [--observed <text>] [--reproduced] [--repro-command <cmd>] [--evidence <ref> ...]
 * [--hypothesis <text>] [--hypothesis-id <id> --hypothesis-result CONFIRMED|REFUTED]
 * [--minimal-test <path>] [--fails-before-fix] [--passes-after-fix] [--fix <text>]
 * [--changed <path> ...] [--verdict PASS|FAIL] [--architecture-note <text>] [--json]`
 */
export async function runIncidentCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, INCIDENT_FLAGS, { multi: ["evidence", "changed", "verification-command"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const action = (stringFlag(args.flags.action) ?? "show").toLowerCase();

  if (action === "list") {
    const incidents = await listIncidents({ projectRoot });
    if (args.flags.json) console.log(canonicalJson({ incidents }, 2));
    else {
      console.log(`incidents: ${incidents.length}`);
      for (const incidentId of incidents) console.log(`  ${incidentId}`);
    }
    process.exitCode = 0;
    return { incidents };
  }

  if (action === "open") {
    const update = collectIncidentUpdate(args.flags);
    if (!update.title || !update.observed) {
      console.error("usage: incident --action open --title <text> --observed <text> [--json]");
      process.exitCode = 1;
      return null;
    }
    const base = newIncident({ incidentId: stringFlag(args.flags["incident-id"]), title: update.title });
    const applied = applyIncidentUpdate(base, update);
    const { incident, evaluation } = finalizeIncident(applied.incident);
    const record = await saveIncident(incident, { projectRoot });
    const payload = { incident, evaluation, ignored: applied.ignored, record };
    if (args.flags.json) console.log(canonicalJson({ evaluation, ignored: applied.ignored, record }, 2));
    else printHumanIncident(payload);
    process.exitCode = 0;
    return payload;
  }

  if (action !== "update" && action !== "show") {
    console.error("usage: incident --action open|update|show|list [--incident-id <id>] [--json]");
    process.exitCode = 1;
    return null;
  }

  const incidentId = stringFlag(args.flags["incident-id"]);
  if (incidentId === null) {
    console.error("usage: incident --action update|show --incident-id <id> [--json]");
    process.exitCode = 1;
    return null;
  }

  let loaded;
  try {
    loaded = await loadIncident(incidentId, { projectRoot });
  } catch (error) {
    console.error(`incident ${incidentId} could not be read: ${error.message}`);
    process.exitCode = 1;
    return null;
  }

  let current = loaded;
  let ignored = [];
  let record = null;
  if (action === "update") {
    const applied = applyIncidentUpdate(loaded, collectIncidentUpdate(args.flags));
    current = applied.incident;
    ignored = applied.ignored;
  }
  const finalized = finalizeIncident(current);
  if (action === "update") record = await saveIncident(finalized.incident, { projectRoot });

  const payload = { incident: finalized.incident, evaluation: finalized.evaluation, ignored, record };
  if (args.flags.json) console.log(canonicalJson({ evaluation: finalized.evaluation, ignored, record }, 2));
  else printHumanIncident(payload);
  process.exitCode = finalized.evaluation.problems.length === 0 ? 0 : 1;
  return payload;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runIncidentCli();
}
