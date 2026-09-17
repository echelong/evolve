/**
 * Research proposal schema (Phase 5A) — versioned, strict, deterministic.
 *
 * A proposal is a RESEARCH OBJECT, not a trader and not code. It carries a
 * hypothesis, optional regime targets, parent families, and *parameter
 * regions* — numeric [min, max] ranges for genes the deterministic compiler is
 * allowed to set. Validation is a strict allowlist:
 *
 *   - unknown top-level fields are rejected (no smuggled payloads)
 *   - only whitelisted genome keys may appear in `changes`, all values must be
 *     finite numbers or finite [min, max] number pairs
 *   - any nested object inside `changes`, any array that is not a 2-number
 *     range, any string that is not an enum member is rejected
 *   - a static sandbox scan rejects executable-looking strings
 *     (javascript:, eval, require/import, child_process, spawn, fetch, HTTP
 *     URLs, function bodies, assignment operators, semicolon statement chains)
 *   - no proposal field can be a function, symbol, or non-finite number
 *
 * The schema therefore makes "arbitrary code execution via a proposal"
 * structurally impossible: after validation, a proposal is a tree of plain
 * strings, booleans, numbers, and fixed enum references — nothing else.
 *
 * PAPER ONLY research machinery. Nothing here trades or executes.
 */

import { GENOME_KEYS, GENE_BOUNDS } from "../engine/genome.mjs";
import { FAMILY_NAMES } from "../engine/families.mjs";
import { REGIMES } from "../arena/orchestrator.mjs";

export const PROPOSAL_SCHEMA_VERSION = 1;

export const RESEARCHER_ROLES = Object.freeze([
  "signal-researcher",
  "regime-researcher",
  "execution-researcher",
  "risk-researcher",
  "diversity-researcher",
  "adversarial-critic",
]);

/** Enum-typed fields and their allowed values. */
export const PROPOSAL_ENUMS = Object.freeze({
  authorRole: RESEARCHER_ROLES,
});

const ALLOWED_TOP_KEYS = Object.freeze([
  "schemaVersion",
  "proposalId",
  "authorRole",
  "hypothesis",
  "targetRegimes",
  "abstainRegimes",
  "parentFamilies",
  "changes",
  "rationale",
  "risks",
]);

const ALLOWED_REGIMES = Object.freeze([...REGIMES]);
const ALLOWED_FAMILIES = Object.freeze([...FAMILY_NAMES]);

const MAX_LENGTHS = Object.freeze({
  proposalId: 64,
  hypothesis: 600,
  rationale: 900,
  risks: 20, // entries
  riskItem: 200,
  targetRegimes: 6, // entries
  abstainRegimes: 6, // entries
  parentFamilies: 3, // entries
  changes: 12, // keys
});

/** Id pattern keeps ids opaque, short, and free of path/URL structure. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const GENE_KEY_SET = new Set(GENOME_KEYS);
const BINARY_GENES = new Set([
  "momentumGateEnabled",
  "requireConcentrationKnown",
  "requireAuthoritySafe",
  "requireVerified",
  "contrarian",
]);

/* ============================================================================
 * Sandbox scan: no executable artifact may hide in a proposal
 * ==========================================================================*/

const FORBIDDEN_STRING_PATTERNS = Object.freeze([
  { label: "javascript-url", re: /javascript\s*:/i },
  { label: "eval", re: /\beval\b/i },
  { label: "new-function", re: /new\s+function\b/i },
  { label: "dynamic-import", re: /\bimport\s*\(/ },
  { label: "import-statement", re: /\bimport\b|\bexport\b/ },
  { label: "require", re: /\brequire\s*\(|\brequire\b/i },
  { label: "process-exec", re: /\bprocess\b|\bchild_process\b/i },
  { label: "spawn-exec", re: /\bspawn\b|\bexecSync\b|\bexec\b/i },
  { label: "shell-meta", re: /\bsh\s+-c\b|\bbash\b|\bcmd\.exe\b/i },
  { label: "url", re: /https?:\/\/|ftp:\/\//i },
  { label: "proto-pollution", re: /__proto__|constructor\s*\[|prototype\s*\[/i },
  { label: "function-literal", re: /function\b|=>|function\s*\*/i },
  { label: "assignment-operator", re: /[^=!<>]==?[^=]/ },
  { label: "statement-chain", re: /;\s*\S/ },
  { label: "template-exec", re: /\$\{[^}]*\}/ },
]);

/**
 * True when a proposal string contains an executable-looking artifact.
 * Deliberately broad: a false positive costs a proposal, a false negative
 * would cost a sandbox. Exported for validation tests.
 */
export function containsExecutableArtifact(text) {
  if (typeof text !== "string") return false;
  for (const { label, re } of FORBIDDEN_STRING_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/* ============================================================================
 * Validation
 * ==========================================================================*/

/**
 * Validate a research proposal object.
 *
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   proposal: object|null,
 * }}
 */
export function validateProposal(raw, { schemaVersion = PROPOSAL_SCHEMA_VERSION } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["proposal must be a plain object"], proposal: null };
  }

  // Unknown top-level fields are rejected outright: an allowlist, not a
  // denylist, so a renamed smuggled field cannot slip through.
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.includes(key)) fail(`unknown top-level field: ${key}`);
  }

  const schema = Number(raw.schemaVersion);
  if (!Number.isInteger(schema) || schema !== schemaVersion) {
    fail(`schemaVersion must be ${schemaVersion}`);
  }

  const proposalId = raw.proposalId;
  if (typeof proposalId !== "string" || !ID_PATTERN.test(proposalId)) {
    fail("proposalId must be 1-64 chars of [A-Za-z0-9._-]");
  }

  const authorRole = raw.authorRole;
  if (!PROPOSAL_ENUMS.authorRole.includes(authorRole)) {
    fail(`authorRole must be one of ${PROPOSAL_ENUMS.authorRole.join(", ")}`);
  }

  const hypothesis = typeof raw.hypothesis === "string" ? raw.hypothesis.trim() : "";
  if (hypothesis.length < 12 || hypothesis.length > MAX_LENGTHS.hypothesis) {
    fail(`hypothesis must be 12-${MAX_LENGTHS.hypothesis} chars`);
  }
  const hypothesisArtifact = containsExecutableArtifact(hypothesis);
  if (hypothesisArtifact) fail(`hypothesis contains forbidden artifact (${hypothesisArtifact})`);

  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (rationale.length < 6 || rationale.length > MAX_LENGTHS.rationale) {
    fail(`rationale must be 6-${MAX_LENGTHS.rationale} chars`);
  }
  const rationaleArtifact = containsExecutableArtifact(rationale);
  if (rationaleArtifact) fail(`rationale contains forbidden artifact (${rationaleArtifact})`);

  // Regime references: enum members only.
  const targetRegimes = sanitizeStringList(raw.targetRegimes, MAX_LENGTHS.targetRegimes, ALLOWED_REGIMES, "targetRegimes", fail);
  const abstainRegimes = sanitizeStringList(raw.abstainRegimes, MAX_LENGTHS.abstainRegimes, ALLOWED_REGIMES, "abstainRegimes", fail);

  const parentFamilies = sanitizeStringList(raw.parentFamilies, MAX_LENGTHS.parentFamilies, ALLOWED_FAMILIES, "parentFamilies", fail);

  const risks = sanitizeStringList(raw.risks, MAX_LENGTHS.risks, null, "risks", fail, MAX_LENGTHS.riskItem);

  const changes = validateChanges(raw.changes, fail);

  if (errors.length > 0) return { ok: false, errors, proposal: null };

  return {
    ok: true,
    errors,
    proposal: {
      schemaVersion,
      proposalId,
      authorRole,
      hypothesis,
      targetRegimes,
      abstainRegimes,
      parentFamilies,
      changes,
      rationale,
      risks,
    },
  };
}

function sanitizeStringList(value, maxItems, allowed, label, fail, maxItemLength = 120) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
    return [];
  }
  if (value.length > maxItems) {
    fail(`${label} exceeds ${maxItems} items`);
    return [];
  }
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") {
      fail(`${label} entries must be strings`);
      return [];
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > maxItemLength) {
      fail(`${label} entries must be 1-${maxItemLength} chars`);
      return [];
    }
    const artifact = containsExecutableArtifact(trimmed);
    if (artifact) {
      fail(`${label} entry contains forbidden artifact (${artifact})`);
      return [];
    }
    if (allowed && !allowed.includes(trimmed)) {
      fail(`${label} entry '${trimmed.slice(0, 40)}' is not an allowed value`);
      return [];
    }
    out.push(trimmed);
  }
  return out;
}

/** Strict gene-range validation. Only whitelisted numeric genes survive. */
function validateChanges(changes, fail) {
  if (changes === undefined || changes === null) return {};
  if (typeof changes !== "object" || Array.isArray(changes)) {
    fail("changes must be an object of gene -> number | [number, number]");
    return {};
  }
  const keys = Object.keys(changes);
  if (keys.length > MAX_LENGTHS.changes) {
    fail(`changes exceeds ${MAX_LENGTHS.changes} keys`);
    return {};
  }

  const out = {};
  for (const key of keys) {
    if (!GENE_KEY_SET.has(key)) {
      fail(`changes.${key} is not a supported genome field`);
      continue;
    }
    const value = changes[key];
    const range = Array.isArray(value) ? value : null;

    if (range) {
      if (range.length !== 2 || range.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        fail(`changes.${key} range must be exactly two finite numbers`);
        continue;
      }
      const [lo, hi] = range;
      if (lo > hi) {
        fail(`changes.${key} range min must be <= max`);
        continue;
      }
      // Binary genes must propose a degenerate range pinned to 0 or 1.
      if (BINARY_GENES.has(key)) {
        const pinned = (lo === 0 && hi === 0) || (lo === 1 && hi === 1) ? (lo === 1 ? 1 : 0) : null;
        if (pinned === null) {
          fail(`changes.${key} is a binary gene and must be [0,0] or [1,1]`);
          continue;
        }
        out[key] = [pinned, pinned];
        continue;
      }
      const [gLo, gHi] = GENE_BOUNDS[key];
      if (lo < gLo || hi > gHi) {
        fail(`changes.${key} range [${lo}, ${hi}] escapes gene bounds [${gLo}, ${gHi}]`);
        continue;
      }
      out[key] = [lo, hi];
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(`changes.${key} must be a finite number or [min, max]`);
      continue;
    }
    if (BINARY_GENES.has(key)) {
      if (value !== 0 && value !== 1) {
        fail(`changes.${key} is a binary gene and must be 0 or 1`);
        continue;
      }
      out[key] = value;
      continue;
    }
    const [gLo, gHi] = GENE_BOUNDS[key];
    if (value < gLo || value > gHi) {
      fail(`changes.${key} value ${value} escapes gene bounds [${gLo}, ${gHi}]`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Compact, safe-to-render summary of a validated proposal. */
export function proposalSummary(proposal) {
  if (!proposal) return null;
  return {
    proposalId: proposal.proposalId,
    schemaVersion: proposal.schemaVersion,
    authorRole: proposal.authorRole,
    hypothesis: proposal.hypothesis.length > 96 ? `${proposal.hypothesis.slice(0, 96)}…` : proposal.hypothesis,
    targetRegimes: [...(proposal.targetRegimes ?? [])],
    parentFamilies: [...(proposal.parentFamilies ?? [])],
    changeCount: Object.keys(proposal.changes ?? {}).length,
    riskCount: (proposal.risks ?? []).length,
  };
}
