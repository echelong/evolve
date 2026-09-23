/**
 * EVOLVE Development Governance v1 — external-call policy (§13).
 *
 * External AI/API calls must be bounded. This module records and validates a
 * POLICY; it never performs a call, holds a provider secret, imports a provider
 * SDK or hardwires a specific commercial model. Model-role pairings elsewhere in
 * governance are recommendations only.
 *
 * Required fields: timeoutMs, retryCap, maxCallsPerRun, provider, model,
 * fallback, cache, authorityLevel, circuitBreaker.
 *
 * Evidence-bearing Jev paths: fallback "none", fail closed. An authority level
 * beyond SHADOW requires an explicit evidence reference, because experimental AI
 * components remain shadow/passive until evidence explicitly justifies another
 * authority level.
 *
 * DEVELOPMENT GOVERNANCE ONLY — no trading, evolution or deployment authority.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import {
  AUTHORITY_LADDER,
  EVIDENCE_BEARING_EXTERNAL_REQUIREMENTS,
  EXTERNAL_POLICY_REQUIRED_FIELDS,
  EXTERNAL_POLICY_OPTIONAL_FIELDS,
  GOVERNANCE_CLASSIFICATION,
  MODEL_ROLE_NOTE,
  MODEL_ROLE_RECOMMENDATIONS,
} from "./definition.mjs";
import { PROJECT_ROOT } from "./storage.mjs";

/** Bounded defaults. Every value is explicit; nothing is left to inference. */
export const DEFAULT_EXTERNAL_POLICY = Object.freeze({
  timeoutMs: 60000,
  retryCap: 2,
  maxCallsPerRun: 32,
  provider: "unspecified",
  model: "unspecified",
  fallback: "none",
  cache: "content-addressed",
  authorityLevel: "SHADOW",
  circuitBreaker: Object.freeze({ failureThreshold: 3, cooldownMs: 300000 }),
  failClosed: true,
  evidenceBearing: false,
  evidenceReference: null,
  pricingKnown: false,
  costAccounting: null,
});

export const RETRY_CAP_LIMIT = 5;
export const MAX_CALLS_PER_RUN_LIMIT = 1000;
export const TIMEOUT_WARN_MS = 600000;

/** Secret-shaped values must never be recorded in a policy (§19). */
const SECRET_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bapi[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i,
  /\bbearer\s+[A-Za-z0-9._-]{20,}/i,
]);

/** Merge a declared policy over the bounded defaults. */
export function normalizeExternalPolicy(candidate = {}) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const known = new Set([...EXTERNAL_POLICY_REQUIRED_FIELDS, ...EXTERNAL_POLICY_OPTIONAL_FIELDS]);
  const policy = { ...DEFAULT_EXTERNAL_POLICY };
  const unknownFields = [];
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) {
      unknownFields.push(key);
      continue;
    }
    policy[key] = value;
  }
  if (policy.circuitBreaker && typeof policy.circuitBreaker === "object") {
    policy.circuitBreaker = { ...DEFAULT_EXTERNAL_POLICY.circuitBreaker, ...policy.circuitBreaker };
  }
  return { policy, unknownFields };
}

/** Detect secret-shaped values anywhere in a policy object. */
export function scanPolicyForSecrets(policy) {
  const findings = [];
  const walk = (value, trail) => {
    if (typeof value === "string") {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(value)) findings.push({ field: trail, pattern: String(pattern) });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) walk(entry, trail.length === 0 ? key : `${trail}.${key}`);
    }
  };
  walk(policy ?? {}, "");
  return findings;
}

/* ============================================================================
 * Validation
 * ==========================================================================*/

/**
 * Validate one external-call policy. Explicit problems, never a guess.
 *
 * @param {object} policy
 * @param {{ evidenceBearing?: boolean }} [options]
 */
export function validateExternalPolicy(policy, options = {}) {
  const problems = [];
  const warnings = [];
  const source = policy && typeof policy === "object" ? policy : {};
  const evidenceBearing = options.evidenceBearing ?? Boolean(source.evidenceBearing);

  const missingFields = EXTERNAL_POLICY_REQUIRED_FIELDS.filter(
    (field) => source[field] === undefined || source[field] === null || source[field] === "",
  );
  for (const field of missingFields) problems.push(`missing required external-call policy field: ${field}`);

  const timeoutMs = source.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    problems.push(`timeoutMs must be a positive finite number, got ${String(source.timeoutMs)}`);
  } else if (timeoutMs > TIMEOUT_WARN_MS) {
    warnings.push(`timeoutMs ${timeoutMs} exceeds ${TIMEOUT_WARN_MS} ms; external calls must stay bounded`);
  }

  const retryCap = source.retryCap;
  if (typeof retryCap !== "number" || !Number.isInteger(retryCap) || retryCap < 0) {
    problems.push(`retryCap must be a non-negative integer, got ${String(source.retryCap)}`);
  } else if (retryCap > RETRY_CAP_LIMIT) {
    problems.push(`retryCap ${retryCap} exceeds the bounded cap of ${RETRY_CAP_LIMIT}`);
  }

  const maxCallsPerRun = source.maxCallsPerRun;
  if (typeof maxCallsPerRun !== "number" || !Number.isInteger(maxCallsPerRun) || maxCallsPerRun <= 0) {
    problems.push(`maxCallsPerRun must be a positive integer, got ${String(source.maxCallsPerRun)}`);
  } else if (maxCallsPerRun > MAX_CALLS_PER_RUN_LIMIT) {
    problems.push(`maxCallsPerRun ${maxCallsPerRun} exceeds the bounded cap of ${MAX_CALLS_PER_RUN_LIMIT}`);
  }

  for (const field of ["provider", "model"]) {
    const value = source[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      problems.push(`${field} must be a non-empty string`);
    } else if (value.trim().toLowerCase() === "unspecified") {
      problems.push(`${field} must identify an explicit provider/model; "unspecified" cannot satisfy the policy`);
    }
  }

  const authorityLevel =
    typeof source.authorityLevel === "string" ? source.authorityLevel.trim().toUpperCase() : null;
  const ladderIndex = AUTHORITY_LADDER.indexOf(authorityLevel);
  const authorityLevelValid = ladderIndex >= 0;
  if (!authorityLevelValid) {
    problems.push(`authorityLevel "${String(source.authorityLevel)}" is not a rung of the frozen shadow-first ladder`);
  } else if (ladderIndex > AUTHORITY_LADDER.indexOf("SHADOW")) {
    const evidenceReference = typeof source.evidenceReference === "string" ? source.evidenceReference.trim() : "";
    if (evidenceReference.length === 0) {
      problems.push(
        `authorityLevel "${authorityLevel}" is beyond SHADOW and requires an explicit evidenceReference; experimental AI components remain shadow/passive until evidence justifies another authority level`,
      );
    }
  }

  return finalizePolicyValidation({
    source,
    evidenceBearing,
    problems,
    warnings,
    missingFields,
    authorityLevel,
    authorityLevelValid,
  });
}

function finalizePolicyValidation({
  source,
  evidenceBearing,
  problems,
  warnings,
  missingFields,
  authorityLevel,
  authorityLevelValid,
}) {
  const breaker = source.circuitBreaker;
  if (!breaker || typeof breaker !== "object") {
    problems.push("circuitBreaker must be an object with failureThreshold and cooldownMs");
  } else {
    const failureThreshold = breaker.failureThreshold;
    const cooldownMs = breaker.cooldownMs;
    if (typeof failureThreshold !== "number" || !Number.isInteger(failureThreshold) || failureThreshold <= 0) {
      problems.push(
        `circuitBreaker.failureThreshold must be a positive integer, got ${String(breaker.failureThreshold)}`,
      );
    }
    if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      problems.push(`circuitBreaker.cooldownMs must be a positive number, got ${String(breaker.cooldownMs)}`);
    }
  }

  const cache = typeof source.cache === "string" ? source.cache.trim() : null;
  if (!cache) problems.push("cache must be a non-empty string");
  else if (evidenceBearing && cache.toLowerCase() === "none") {
    problems.push("evidence-bearing external calls must be cached deterministically so a run can be replayed");
  }

  const fallback = typeof source.fallback === "string" ? source.fallback.trim().toLowerCase() : null;
  if (!fallback) problems.push("fallback must be a non-empty string");
  if (source.pricingKnown !== undefined && typeof source.pricingKnown !== "boolean") {
    problems.push("pricingKnown must be boolean when declared");
  }
  if (source.pricingKnown === true) {
    const costAccounting = source.costAccounting;
    const validCostHook =
      (typeof costAccounting === "string" && costAccounting.trim().length > 0) ||
      (costAccounting && typeof costAccounting === "object" && !Array.isArray(costAccounting));
    if (!validCostHook) problems.push("pricingKnown=true requires a costAccounting hook or declaration");
  }
  if (evidenceBearing) {
    if (fallback !== EVIDENCE_BEARING_EXTERNAL_REQUIREMENTS.fallback) {
      problems.push(
        `evidence-bearing external calls must have fallback "${EVIDENCE_BEARING_EXTERNAL_REQUIREMENTS.fallback}", got "${String(source.fallback)}"`,
      );
    }
    if (source.failClosed !== true) problems.push("evidence-bearing external calls must fail closed");
  } else if (source.failClosed !== true) {
    warnings.push("failClosed is not true; where evidence integrity is concerned failures must fail closed");
  }

  const secretFindings = scanPolicyForSecrets(source);
  for (const finding of secretFindings) {
    problems.push(
      `external-call policy appears to contain a secret at ${finding.field || "(root)"}; secrets are never recorded`,
    );
  }

  return {
    status: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    warnings,
    missingFields,
    evidenceBearing,
    failClosed: source.failClosed === true,
    fallback,
    cache,
    authorityLevel,
    authorityLevelValid,
    secretFindings: secretFindings.length,
    classification: GOVERNANCE_CLASSIFICATION,
  };
}

/** Build the recorded policy object (normalized policy + validation + digest). */
export function externalPolicyRecord({ candidate = null, evidenceBearing = null, source = null } = {}) {
  const { policy, unknownFields } = normalizeExternalPolicy(candidate ?? {});
  if (evidenceBearing === true || evidenceBearing === false) policy.evidenceBearing = evidenceBearing;
  const validationInput = candidate === null ? policy : { ...candidate };
  if (evidenceBearing === true || evidenceBearing === false) validationInput.evidenceBearing = evidenceBearing;
  const validation = validateExternalPolicy(validationInput);
  const body = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_EXTERNAL_CALL_POLICY",
    createdAt: new Date().toISOString(),
    source: source ?? null,
    requiredFields: EXTERNAL_POLICY_REQUIRED_FIELDS,
    policy,
    unknownFields,
    validation,
    evidenceBearingRequirements: EVIDENCE_BEARING_EXTERNAL_REQUIREMENTS,
    modelRoleRecommendations: MODEL_ROLE_RECOMMENDATIONS,
    modelRoleNote: MODEL_ROLE_NOTE,
    classification: GOVERNANCE_CLASSIFICATION,
  };
  return { ...body, policyDigest: sha256Hex(canonicalJson(body)) };
}

/* ============================================================================
 * CLI
 * ==========================================================================*/

function printHumanPolicy(record) {
  console.log(`external-policy: ${record.validation.status}`);
  console.log(`authorityLevel: ${record.policy.authorityLevel}`);
  console.log(
    `bounds: timeoutMs=${record.policy.timeoutMs} retryCap=${record.policy.retryCap} maxCallsPerRun=${record.policy.maxCallsPerRun}`,
  );
  console.log(`provider/model: ${record.policy.provider} / ${record.policy.model}`);
  console.log(
    `fallback=${record.policy.fallback} cache=${record.policy.cache} failClosed=${record.policy.failClosed}`,
  );
  console.log(
    `circuitBreaker: failureThreshold=${record.policy.circuitBreaker?.failureThreshold} cooldownMs=${record.policy.circuitBreaker?.cooldownMs}`,
  );
  console.log(`evidenceBearing: ${record.policy.evidenceBearing}`);
  for (const problem of record.validation.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of record.validation.warnings) console.log(`WARNING: ${warning}`);
  console.log(`policyDigest: ${record.policyDigest}`);
}

/** `external-policy [--file <policy.json>] [--evidence-bearing] [--json]` */
export async function runExternalPolicyCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, { json: true, file: false, "evidence-bearing": true });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const filePath =
    typeof args.flags.file === "string" && args.flags.file.trim().length > 0 ? args.flags.file.trim() : null;

  let candidate = null;
  if (filePath !== null) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
    candidate = JSON.parse(await readFile(absolute, "utf8"));
  }

  const record = externalPolicyRecord({
    candidate,
    evidenceBearing: args.flags["evidence-bearing"] === true ? true : null,
    source: filePath,
  });

  if (args.flags.json) console.log(canonicalJson(record, 2));
  else printHumanPolicy(record);
  process.exitCode = record.validation.status === "PASS" ? 0 : 1;
  return record;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runExternalPolicyCli();
}
