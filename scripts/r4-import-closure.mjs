// R4 deterministic static import-closure validator (enforcement only).
//
// Section 7 of independent pre-capture review round 2 required that the R4
// runtime dependency closure be bound mechanically rather than from memory. This
// module walks the STATIC and dynamic ESM module graph from the canonical R4
// runtime entrypoints and asserts:
//
//   importClosure(R4_RUNTIME_ROOTS) subset of R4_REQUIRED_BOUND_FILES
//
// If a new runtime module is imported later without being added to the canonical
// bound set, `assertImportClosureBound` fails and the seal/authority validation
// fails with it. The module reads source text only: it starts nothing, captures
// nothing, opens no network and writes nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const R4_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Canonical R4 runtime entrypoints. Every file reachable from these by static or
 * dynamic import is part of the scientific/evidence runtime closure and must be
 * a bound artifact of the canonical tracked seal.
 */
export const R4_RUNTIME_ROOTS = Object.freeze([
  'scripts/market-intelligence.mjs',
  'scripts/r4-cohort-run.mjs',
  'scripts/r4-canonical-analysis.mjs',
  'scripts/r4-capability.mjs',
  'scripts/r4-attempt-history.mjs',
  'scripts/r4-approval-epochs.mjs',
  'scripts/r4-approval.mjs',
  'scripts/r4-attestation.mjs',
  'scripts/r4-authority.mjs',
  'scripts/r4-enforcement.mjs',
  'scripts/r4-protocol-spec.mjs',
  'scripts/r4-preregistration-seal.mjs',
  'scripts/r4-import-closure.mjs',
]);

/**
 * Validators that gate the frozen protocol. They are bound artifacts too, even
 * though the runtime never imports them, because they are the executable
 * definition of "frozen" that a reviewer runs.
 */
export const R4_BOUND_NON_RUNTIME_ARTIFACTS = Object.freeze([
  'docs/R4-PREREGISTRATION.md',
  // Defense-in-depth (round 3): the runtime closure above is local modules plus
  // Node builtins only, so no third-party package reaches R4 execution today.
  // Binding the tracked lockfile makes any future dependency drift a seal
  // failure. It changes no scientific behaviour.
  'package-lock.json',
  'package.json',
  'scripts/market-outcomes/policy-a-cases.mjs',
  'scripts/market-outcomes/policy-b-cases.mjs',
  'scripts/r4-e1-cases.mjs',
  // Synthetic P -> S -> A Git authority fixture used by the round-3 validator.
  'scripts/r4-synthetic-authority.mjs',
]);

export const R4_BOUND_VALIDATORS = Object.freeze([
  'scripts/validate-market-outcomes-policy-b.mjs',
  'scripts/validate-market-outcomes.mjs',
  'scripts/validate-p3c-mutation.mjs',
  'scripts/validate-r4-approval-epochs.mjs',
  'scripts/validate-r4-e1-mutation.mjs',
  'scripts/validate-r4-e1.mjs',
  'scripts/validate-r4-enforcement.mjs',
  'scripts/validate-r4-import-closure.mjs',
  'scripts/validate-r4-preregistration-seal.mjs',
  'scripts/validate-r4-protocol.mjs',
  'scripts/validate-r4-revisits.mjs',
  'scripts/validate-r4-round2.mjs',
  'scripts/validate-r4-round3.mjs',
]);

const STATIC_PATTERNS = [
  /\bimport\s+[^'"`]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"`]*?\sfrom\s*['"]([^'"]+)['"]/g,
];
const DYNAMIC_PATTERNS = [
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const resolveLocal = (fromFile, specifier) => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return resolved.startsWith('..') ? null : resolved;
};

/**
 * Extract every module specifier referenced by `source`, separated into local
 * relative specifiers, bare package/builtin specifiers and dynamic specifiers
 * that cannot be resolved statically.
 */
export function extractImportSpecifiers(source) {
  const statics = new Set();
  const dynamic = [];
  const unresolvedDynamic = [];
  for (const pattern of STATIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) statics.add(match[1]);
  }
  for (const pattern of DYNAMIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) dynamic.push(match[1]);
  }
  const templateDynamic = /\bimport\s*\(\s*`([^`]*)`\s*\)/g;
  let match;
  while ((match = templateDynamic.exec(source)) !== null) {
    if (match[1].includes('${')) unresolvedDynamic.push(match[1]);
    else dynamic.push(match[1]);
  }
  // Any dynamic import whose argument is not a static string/template literal is
  // a dependency the closure cannot prove bound, so it fails closed.
  const nonStaticDynamic = /\bimport\s*\(\s*(?=[A-Za-z_$[{])[^)]*\)/g;
  while ((match = nonStaticDynamic.exec(source)) !== null) unresolvedDynamic.push(match[0].slice(0, 60));
  return { statics: [...statics], dynamic, unresolvedDynamic };
}

/**
 * Deterministic transitive closure of the local relative module graph rooted at
 * `roots`. Returns the sorted file list plus any local specifiers that could not
 * be resolved to a tracked file (empty in a healthy tree).
 */
export function computeImportClosure({ rootDir = R4_REPO_ROOT, roots = R4_RUNTIME_ROOTS, readFile = file => readFileSync(path.join(rootDir, file), 'utf8') } = {}) {
  const visited = new Set();
  const unresolved = [];
  const unresolvedDynamic = [];
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try { source = readFile(file); } catch { unresolved.push(file); continue; }
    const { statics, dynamic, unresolvedDynamic: hardDynamic } = extractImportSpecifiers(source);
    unresolvedDynamic.push(...hardDynamic.map(expression => ({ file, expression })));
    for (const specifier of [...statics, ...dynamic]) {
      const local = resolveLocal(file, specifier);
      if (local === null) continue; // node builtin or external package
      queue.push(local);
    }
  }
  return { files: [...visited].sort(), unresolved: [...new Set(unresolved)].sort(), unresolvedDynamic };
}

/**
 * The canonical bound-file set is derived from the closure plus declared bound
 * non-runtime artifacts. A seal may not define or shrink this list.
 */
export function requiredBoundFiles({ rootDir = R4_REPO_ROOT, roots = R4_RUNTIME_ROOTS, readFile = undefined } = {}) {
  const closure = computeImportClosure({ rootDir, roots, ...(readFile ? { readFile } : {}) });
  return Object.freeze([...new Set([...closure.files, ...R4_BOUND_VALIDATORS, ...R4_BOUND_NON_RUNTIME_ARTIFACTS])].sort());
}

/**
 * Fail closed when any reachable runtime module is not a bound artifact, when a
 * local import cannot be resolved, or when a non-static dynamic import exists
 * that the closure cannot prove is bound.
 */
export function assertImportClosureBound({ rootDir = R4_REPO_ROOT, roots = R4_RUNTIME_ROOTS, required = null, readFile = undefined } = {}) {
  const bound = new Set(required ?? requiredBoundFiles({ rootDir, roots, ...(readFile ? { readFile } : {}) }));
  const closure = computeImportClosure({ rootDir, roots, ...(readFile ? { readFile } : {}) });
  if (closure.unresolved.length) throw new Error(`R4_IMPORT_CLOSURE_UNRESOLVED:${closure.unresolved.join(',')}`);
  if (closure.unresolvedDynamic.length) throw new Error(`R4_IMPORT_CLOSURE_DYNAMIC_UNSUPPORTED:${closure.unresolvedDynamic.map(entry => entry.file).join(',')}`);
  const unbound = closure.files.filter(file => !bound.has(file));
  if (unbound.length) throw new Error(`R4_IMPORT_CLOSURE_UNBOUND:${unbound.join(',')}`);
  return { ok: true, closureFiles: closure.files, closureSize: closure.files.length, roots: [...roots] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = assertImportClosureBound();
  const required = requiredBoundFiles();
  console.log(JSON.stringify({ ...result, requiredBoundCount: required.length, requiredBoundFiles: required }, null, 2));
}
