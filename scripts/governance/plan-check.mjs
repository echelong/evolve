/**
 * EVOLVE Development Governance v1 — plan checker (§5, §6).
 *
 * A substantial EVOLVE plan is frozen BEFORE implementation. This checker
 * proves the frozen plan is complete enough to be implemented, reviewed and
 * verified independently:
 *
 *   Goal, Architecture, Files / scope, Global Constraints, Review Focus,
 *   Verification, and preservation requirements when evidence trees are
 *   relevant.
 *
 * It also rejects placeholder language (TBD, TODO, "implement later", "add
 * appropriate tests", "handle edge cases", "etc.", "similar to above"), because
 * a placeholder is a decision that was never made. Only the supplied plan is
 * scanned: ordinary `// TODO` comments in source code are none of this
 * checker's business.
 *
 * Global Constraints are compared against the single canonical definition in
 * ./definition.mjs — never against a locally retyped copy — and a required
 * constraint or Review Focus item is never silently truncated.
 *
 * DEVELOPMENT GOVERNANCE ONLY — read-only, no trading/evolution authority.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import {
  GLOBAL_CONSTRAINTS,
  GLOBAL_CONSTRAINTS_DIGEST,
  GOVERNANCE_CLASSIFICATION,
  MIN_REVIEW_FOCUS_ITEMS,
  PLACEHOLDER_PATTERNS,
  PLAN_SCOPE_SECTION_ALIASES,
  RESEARCH_SEMANTICS_DECLARATION_LABEL,
  REQUIRED_PLAN_SECTIONS,
} from "./definition.mjs";
import { PROJECT_ROOT } from "./storage.mjs";

/** Heading text is compared case-insensitively with punctuation collapsed. */
export function normalizeHeading(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[#*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a markdown plan into heading-delimited sections. */
export function splitPlanSections(planText) {
  const lines = String(planText ?? "").split("\n");
  const sections = [];
  let current = { heading: null, level: 0, body: [], startLine: 1 };
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      sections.push(current);
      current = { heading: heading[2], level: heading[1].length, body: [], startLine: index + 2 };
      return;
    }
    current.body.push({ text: line, line: index + 1 });
  });
  sections.push(current);
  return sections.filter((section) => section.heading !== null || section.body.length > 0);
}

/** Bullet / numbered list items inside a set of body lines. */
export function parseListItems(bodyLines) {
  const items = [];
  for (const entry of bodyLines) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(entry.text);
    if (!match) continue;
    const text = match[1].trim();
    if (text.length > 0) items.push({ text, line: entry.line });
  }
  return items;
}

/** Does this token look like a repository-relative path, directory or pattern? */
export function looksLikePath(token) {
  const text = String(token ?? "").trim();
  if (text.length === 0 || text.length > 240) return false;
  if (!/^[A-Za-z0-9_.@/*? -]+$/.test(text)) return false;
  if (text.includes("*")) return true;
  if (text.endsWith("/")) return true;
  if (text.includes("/")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(text);
}

export function pathEntryKind(token) {
  const text = String(token).trim();
  if (text.includes("*")) return "pattern";
  if (text.endsWith("/")) return "directory";
  return "file";
}

/** Strip inline markdown emphasis/links so path tokens survive. */
function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "");
}

/* ============================================================================
 * Plan parsing
 * ==========================================================================*/

function sectionBodyText(section) {
  return (section?.body ?? []).map((entry) => entry.text).join("\n");
}

function allLines(planText) {
  return String(planText ?? "")
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }));
}

/**
 * Declared file scope. Backticked tokens win; otherwise the first token of a
 * bullet is treated as the path. Fenced blocks inside the scope section are also
 * accepted, so a plan may list paths as a plain block.
 */
export function extractDeclaredFiles(section) {
  const entries = [];
  const seen = new Set();
  const push = (token, line) => {
    const text = String(token ?? "")
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/[,;]$/, "");
    if (!looksLikePath(text) || seen.has(text)) return;
    seen.add(text);
    entries.push({ path: text, kind: pathEntryKind(text), line });
  };

  let inFence = false;
  for (const entry of section?.body ?? []) {
    if (/^\s*```/.test(entry.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      push(entry.text.trim(), entry.line);
      continue;
    }
    const backticked = [...entry.text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
    if (backticked.length > 0) {
      for (const token of backticked) push(token, entry.line);
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(entry.text);
    if (!bullet) continue;
    push(stripMarkdown(bullet[1]).split(/\s+/)[0], entry.line);
  }
  return entries;
}

/** Review Focus items: bullets first, then a single `a; b; c` line. */
export function extractReviewFocus(section) {
  const items = parseListItems(section?.body ?? []).map((item) => ({
    text: stripMarkdown(item.text).replace(/^`+|`+$/g, "").trim(),
    line: item.line,
  }));
  if (items.length > 0) return items.filter((item) => item.text.length > 0);

  const inline = [];
  for (const entry of section?.body ?? []) {
    const text = entry.text.trim();
    if (text.length === 0) continue;
    for (const piece of text.split(/[;,]/)) {
      const trimmed = stripMarkdown(piece).trim();
      if (trimmed.length > 0) inline.push({ text: trimmed, line: entry.line });
    }
  }
  return inline;
}

/** Protected paths: an explicit `Protected paths:` label, or a preservation list. */
export function extractProtectedPaths(planText, sections) {
  const lines = allLines(planText);
  const entries = [];
  const seen = new Set();
  const push = (token, line) => {
    const text = String(token ?? "")
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/[,;]$/, "");
    if (text.length === 0 || seen.has(text)) return;
    seen.add(text);
    entries.push({ path: text, line });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const label = /^\s*(?:[-*+]\s*)?protected\s+paths?\s*[:=]?\s*(.*)$/i.exec(lines[index].text);
    if (!label) continue;
    const inline = label[1].trim();
    if (inline.length > 0) {
      for (const piece of inline.split(",")) push(piece, lines[index].line);
      continue;
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[next].text);
      if (!bullet) {
        if (lines[next].text.trim().length === 0) continue;
        break;
      }
      push(bullet[1], lines[next].line);
    }
  }
  if (entries.length > 0) return entries;

  const preservation = sections.find((section) =>
    /preservation|protected|immutable/.test(normalizeHeading(section.heading)),
  );
  for (const item of parseListItems(preservation?.body ?? [])) {
    const text = stripMarkdown(item.text)
      .replace(/^`+|`+$/g, "")
      .trim()
      .split(/\s+/)[0];
    if (looksLikePath(text)) push(text, item.line);
  }
  return entries;
}

/** `Dedicated validator: <command>` anywhere in the plan. */
export function extractDedicatedValidator(planText) {
  const match = /^\s*(?:[-*+]\s*)?(?:dedicated|governance)\s+validator\s*[:=]\s*(.+)$/im.exec(
    String(planText ?? ""),
  );
  if (!match) return null;
  const command = match[1].trim().replace(/^`+|`+$/g, "").trim();
  return command.length > 0 ? command : null;
}

/** Parse the explicit protocol-review classification required by orchestration. */
export function extractResearchSemanticsDeclaration(planText) {
  const label = RESEARCH_SEMANTICS_DECLARATION_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(yes|true|no|false)\\s*$`, "im").exec(String(planText ?? ""));
  if (!match) return null;
  return /^(yes|true)$/i.test(match[1]);
}

/** `Global Constraints digest: <sha256>` anywhere in the plan. */
export function extractGlobalConstraintsDigest(planText) {
  const match = /global\s+constraints\s+digest\s*[:=]\s*([0-9a-fA-F]{64})/i.exec(String(planText ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/** Whitespace-collapsed, case-insensitive comparison basis. */
export function canonicalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


/** `Intended writes:` — explicit exemption declarations for protected paths. */
export function extractIntendedWrites(planText, sections) {
  const lines = String(planText ?? "")
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }));
  const entries = [];
  const seen = new Set();
  const push = (token, line) => {
    const value = String(token ?? "")
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/[,;]$/, "");
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    entries.push({ path: value, line });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const label = /^\s*(?:[-*+]\s*)?intended\s+writes?\s*[:=]?\s*(.*)$/i.exec(lines[index].text);
    if (!label) continue;
    const inline = label[1].trim();
    if (inline.length > 0) {
      for (const piece of inline.split(",")) push(piece, lines[index].line);
      continue;
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[next].text);
      if (!bullet) {
        if (lines[next].text.trim().length === 0) continue;
        break;
      }
      push(bullet[1], lines[next].line);
    }
  }
  if (entries.length > 0) return entries;

  const section = (sections ?? []).find((entry) => /intended\s+writes?/.test(normalizeHeading(entry.heading)));
  for (const item of parseListItems(section?.body ?? [])) {
    push(item.text.split(/\s+/)[0], item.line);
  }
  return entries;
}

/** Adjacent-file justifications from a justification/adjacent section. */
export function extractJustifications(sections) {
  const justifications = [];
  const matched = sections.filter((section) => /justif|adjacent/.test(normalizeHeading(section.heading)));
  for (const section of matched) {
    for (const item of parseListItems(section.body)) {
      const match = /^`([^`]+)`\s*(?:—|--|:)\s*(.+)$/.exec(item.text) ?? /^`?([^`\s]+)`?\s*(?:—|--|:)\s*(.+)$/.exec(item.text);
      if (!match) continue;
      const target = match[1].trim();
      if (!looksLikePath(target)) continue;
      justifications.push({ path: target, reason: match[2].trim(), line: item.line });
    }
  }
  return justifications;
}

/** Does the plan make evidence trees relevant (§22)? */
export function detectEvidenceRelevance(planText) {
  const text = String(planText ?? "");
  if (
    /(^|\s|`)\.evolve\/(jev-|shadow|arenas|research|replication|champions|datasets|history|intelligence)/.test(text)
  ) {
    return true;
  }
  return /\bevidence tree\b|\bcanonical evidence\b|\breplication evidence\b|\btemporal replication\b|\bpaper shadow\b|\bsupervisor evidence\b|\bshadow league\b/i.test(
    text,
  );
}

/** Deterministic evidence-facing markers that cannot be classified as ordinary work. */
export function detectResearchSemanticsMarkers(planText) {
  const text = String(planText ?? "");
  return (
    detectEvidenceRelevance(text) ||
    /\b(?:Arena|Jev)\b.{0,80}\b(?:evidence|protocol|semantics|replication|lookahead)\b/i.test(text) ||
    /\b(?:research\s+evaluation|evidence\s+classification|result-driven\s+(?:parameter\s+)?tuning|lookahead(?:-sensitive)?\s+code|observer[/-]research\s+component\s+influencing\s+execution|immutable\s+evidence)\b/i.test(text)
  );
}

/** Placeholder scan over the plan only (§6). */
export function detectPlaceholders(planText) {
  const findings = [];
  for (const entry of allLines(planText)) {
    for (const rule of PLACEHOLDER_PATTERNS) {
      if (!rule.pattern.test(entry.text)) continue;
      const quote = entry.text.trim();
      findings.push({
        id: rule.id,
        line: entry.line,
        quote: quote.length > 160 ? `${quote.slice(0, 160)}… [TRUNCATED]` : quote,
        quoteTruncated: quote.length > 160,
      });
    }
  }
  return findings;
}

/** Does the plan touch research/evidence semantics (protocol review required)? */
export function detectResearchSemantics(planText) {
  return extractResearchSemanticsDeclaration(planText);
}

/**
 * Parse a frozen plan into the facts the checkers and manifest need.
 *
 * @param {{ planText?: string, planPath?: string|null }} [options]
 */
export function parsePlan({ planText = "", planPath = null } = {}) {
  const text = String(planText ?? "");
  const sections = splitPlanSections(text);
  const headings = sections.map((section) => normalizeHeading(section.heading));

  const scopeSection = sections.find((section) =>
    PLAN_SCOPE_SECTION_ALIASES.includes(normalizeHeading(section.heading)),
  );
  const reviewFocusSection = sections.find((section) =>
    normalizeHeading(section.heading).includes("review focus"),
  );
  const constraintsSection = sections.find((section) =>
    normalizeHeading(section.heading).includes("global constraints"),
  );

  const declaredFiles = extractDeclaredFiles(scopeSection);
  const reviewFocus = extractReviewFocus(reviewFocusSection);
  const protectedPaths = extractProtectedPaths(text, sections);
  const dedicatedValidator = extractDedicatedValidator(text);
  const justifications = extractJustifications(sections);
  const placeholders = detectPlaceholders(text);
  const markerSource = sections
    .filter((section) => !/^(?:review\s+focus|global\s+constraints)$/i.test(normalizeHeading(section.heading)))
    .map((section) => [section.heading ?? "", ...section.body.map((entry) => entry.text)].join("\n"))
    .join("\n");
  const researchSemanticsMarkers = detectResearchSemanticsMarkers(markerSource);
  const evidenceTreesRelevant = researchSemanticsMarkers;
  const intendedWrites = extractIntendedWrites(text, sections);
  const researchSemanticsDeclaration = extractResearchSemanticsDeclaration(text);

  return {
    planPath,
    planDigest: sha256Hex(text),
    sections,
    headings,
    sectionPresent: Object.fromEntries(
      REQUIRED_PLAN_SECTIONS.map((required) => {
        if (required === "Files / scope") return [required, scopeSection !== undefined];
        if (required === "Review Focus") return [required, reviewFocusSection !== undefined];
        if (required === "Global Constraints") return [required, constraintsSection !== undefined];
        return [required, headings.some((heading) => heading.includes(normalizeHeading(required)))];
      }),
    ),
    sectionsByHeading: {
      scope: scopeSection ?? null,
      reviewFocus: reviewFocusSection ?? null,
      globalConstraints: constraintsSection ?? null,
    },
    declaredFiles,
    declaredFilePaths: declaredFiles.map((entry) => entry.path),
    declaredGlobalConstraintsDigest: extractGlobalConstraintsDigest(text),
    reviewFocus,
    protectedPaths,
    protectedPathList: protectedPaths.map((entry) => entry.path),
    intendedWrites,
    intendedWritePaths: intendedWrites.map((entry) => entry.path),
    dedicatedValidator,
    justifications,
    placeholders,
    evidenceTreesRelevant: evidenceTreesRelevant || researchSemanticsDeclaration === true,
    touchesResearchSemantics: researchSemanticsDeclaration === true || researchSemanticsMarkers,
    researchSemanticsDeclaration,
    researchSemanticsMarkers,
    lockFilesAllowed: /lock[- ]?files?\s*[:=]?\s*(allowed|permitted|generated|ok)\b/i.test(text),
    planBytes: Buffer.byteLength(text),
  };
}

/* ============================================================================
 * The check itself (§6)
 * ==========================================================================*/

/**
 * Validate a parsed frozen plan. Returns PASS/FAIL with explicit problems.
 *
 * Never silently truncates a required Global Constraint or Review Focus item:
 * a missing constraint is reported in full.
 *
 * @param {ReturnType<typeof parsePlan>} parsed
 */
export function checkPlan(parsed) {
  const problems = [];
  const warnings = [];

  for (const required of REQUIRED_PLAN_SECTIONS) {
    if (!parsed.sectionPresent[required]) problems.push(`missing required plan section: ${required}`);
  }

  const bodyOf = (section) => sectionBodyText(section).trim();
  const requiredSectionByName = {
    "Files / scope": parsed.sectionsByHeading.scope,
    "Review Focus": parsed.sectionsByHeading.reviewFocus,
    "Global Constraints": parsed.sectionsByHeading.globalConstraints,
  };
  for (const [name, section] of Object.entries(requiredSectionByName)) {
    if (section && bodyOf(section).length === 0) problems.push(`plan section is present but empty: ${name}`);
  }
  for (const required of ["Goal", "Architecture", "Verification"]) {
    const section = parsed.sections.find(
      (entry) => entry.heading !== null && normalizeHeading(entry.heading).includes(normalizeHeading(required)),
    );
    if (section && bodyOf(section).length === 0) {
      problems.push(`plan section is present but empty: ${required}`);
    }
  }

  if (parsed.sectionPresent["Files / scope"] && parsed.declaredFiles.length === 0) {
    warnings.push(
      "Files / scope section declares no parseable file scope; scope-check will classify every changed file OUT_OF_SCOPE",
    );
  }

  if (parsed.researchSemanticsDeclaration === null) {
    problems.push(
      `missing explicit "${RESEARCH_SEMANTICS_DECLARATION_LABEL}: yes|no" declaration; protocol-review requirements cannot be inferred from plan prose`,
    );
  }
  if (parsed.researchSemanticsDeclaration === false && parsed.researchSemanticsMarkers) {
    problems.push(
      "Research/evidence semantics is explicitly marked no but the plan contains deterministic evidence-facing markers; declare yes and provide a protocol reviewer",
    );
  }

  /* Global Constraints: canonical digest line OR every constraint verbatim. */
  const constraintsText = canonicalizeText(bodyOf(parsed.sectionsByHeading.globalConstraints));
  let constraintsSatisfied = false;
  if (parsed.declaredGlobalConstraintsDigest !== null) {
    if (parsed.declaredGlobalConstraintsDigest === GLOBAL_CONSTRAINTS_DIGEST) {
      constraintsSatisfied = true;
    } else {
      problems.push(
        `declared Global Constraints digest ${parsed.declaredGlobalConstraintsDigest} does not match the canonical digest ${GLOBAL_CONSTRAINTS_DIGEST}`,
      );
    }
  }
  if (!constraintsSatisfied) {
    const missingConstraints = [];
    GLOBAL_CONSTRAINTS.forEach((constraint, index) => {
      if (constraintsText.includes(canonicalizeText(constraint))) return;
      missingConstraints.push(index + 1);
      problems.push(`Global Constraint ${index + 1} missing: "${constraint}"`);
    });
    if (missingConstraints.length > 0) {
      problems.push(
        `Global Constraints incomplete (${missingConstraints.length}/${GLOBAL_CONSTRAINTS.length} missing); supply the full list or "Global Constraints digest: ${GLOBAL_CONSTRAINTS_DIGEST}"`,
      );
    }
  }

  /* Review Focus: at least MIN_REVIEW_FOCUS_ITEMS concrete items. */
  const focusItems = parsed.reviewFocus.map((item) => item.text);
  if (focusItems.length < MIN_REVIEW_FOCUS_ITEMS) {
    problems.push(
      `Review Focus must contain at least ${MIN_REVIEW_FOCUS_ITEMS} items, found ${focusItems.length}`,
    );
  }
  parsed.reviewFocus.forEach((item, index) => {
    if (item.text.length < 8) {
      problems.push(`Review Focus item ${index + 1} is not concrete enough: "${item.text}"`);
    }
    for (const rule of PLACEHOLDER_PATTERNS) {
      if (rule.pattern.test(item.text)) {
        problems.push(
          `Review Focus item ${index + 1} contains placeholder language "${rule.id}": "${item.text}"`,
        );
      }
    }
  });

  /* Placeholder language anywhere in the plan. */
  for (const finding of parsed.placeholders) {
    problems.push(`placeholder language "${finding.id}" at plan line ${finding.line}: ${finding.quote}`);
  }

  /* Verification and preservation. */
  if (parsed.sectionPresent.Verification && parsed.dedicatedValidator === null) {
    warnings.push(
      'Verification section does not declare "Dedicated validator: <command>"; the governance validator will not be part of fresh verification',
    );
  }
  if (parsed.evidenceTreesRelevant && parsed.protectedPaths.length === 0) {
    problems.push(
      "plan makes evidence trees relevant but declares no protected paths; Preservation requirements are mandatory in that case",
    );
  }
  for (const intendedWrite of parsed.intendedWrites) {
    const declaredProtected = parsed.protectedPathList.some((protectedPath) => {
      const prefix = protectedPath.endsWith("/") ? protectedPath : `${protectedPath}/`;
      return intendedWrite.path === protectedPath || intendedWrite.path.startsWith(prefix);
    });
    if (!declaredProtected) {
      warnings.push(
        `intended write declared for a path that is not a protected path: ${intendedWrite.path}`,
      );
    }
  }

  return {
    status: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    warnings,
    declaredFiles: parsed.declaredFiles,
    declaredFilePaths: parsed.declaredFilePaths,
    reviewFocus: focusItems,
    globalConstraintsDigest: GLOBAL_CONSTRAINTS_DIGEST,
    planDigest: parsed.planDigest,
    planPath: parsed.planPath,
    planBytes: parsed.planBytes,
    sectionPresent: parsed.sectionPresent,
    evidenceTreesRelevant: parsed.evidenceTreesRelevant,
    touchesResearchSemantics: parsed.touchesResearchSemantics,
    protectedPaths: parsed.protectedPathList,
    intendedWrites: parsed.intendedWritePaths,
    dedicatedValidator: parsed.dedicatedValidator,
    lockFilesAllowed: parsed.lockFilesAllowed,
    justifications: parsed.justifications,
    placeholders: parsed.placeholders,
    classification: GOVERNANCE_CLASSIFICATION,
  };
}

/** Read a plan file and check it. Read-only. */
export async function checkPlanFile(planPath, { projectRoot = PROJECT_ROOT } = {}) {
  const absolute = path.isAbsolute(String(planPath)) ? String(planPath) : path.resolve(projectRoot, String(planPath));
  const planText = await readFile(absolute, "utf8");
  const relative = path.relative(projectRoot, absolute) || absolute;
  return checkPlan(parsePlan({ planText, planPath: relative }));
}

function printHumanReport(report) {
  console.log(`plan-check: ${report.status}`);
  console.log(
    `plan: ${report.planPath ?? "(inline)"} (${report.planBytes} bytes, planDigest ${String(report.planDigest).slice(0, 12)})`,
  );
  console.log(`declared file scope: ${report.declaredFilePaths.length} entries`);
  console.log(`review focus items: ${report.reviewFocus.length}`);
  console.log(`protected paths: ${report.protectedPaths.length}`);
  console.log(`evidence trees relevant: ${report.evidenceTreesRelevant}`);
  console.log(`research/evidence semantics touched: ${report.touchesResearchSemantics}`);
  console.log(`dedicated validator: ${report.dedicatedValidator ?? "(none declared)"}`);
  console.log(`global constraints digest: ${report.globalConstraintsDigest}`);
  for (const problem of report.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
}

/** `plan-check --plan <path.md> [--json]`. Exit 0 on PASS, 1 on FAIL. */
export async function runPlanCheckCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, { json: true, plan: false });
  const planPath = args.flags.plan;
  if (typeof planPath !== "string" || planPath.trim().length === 0) {
    console.error("usage: node scripts/evolve-governance.mjs plan-check --plan <path.md> [--json]");
    console.error("   or: node scripts/governance/plan-check.mjs --plan <path.md> [--json]");
    process.exitCode = 1;
    return null;
  }
  let report;
  try {
    report = await checkPlanFile(planPath, options);
  } catch (error) {
    console.error(`plan-check failed to read plan: ${error.message}`);
    process.exitCode = 1;
    return null;
  }
  if (args.flags.json) console.log(canonicalJson(report, 2));
  else printHumanReport(report);
  process.exitCode = report.status === "PASS" ? 0 : 1;
  return report;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runPlanCheckCli();
}
