#!/usr/bin/env node
// R4 runtime import-closure validator and tamper gate (round-2 blocker B3).
//
// Positive path: the deterministic closure of the canonical R4 runtime
// entrypoints is a subset of the canonical bound-file set, every bound file
// exists, and every declared validator is bound.
//
// Tamper gate: adding an unbound runtime import, or an unresolvable / non-static
// dynamic import, must make the closure validator fail. A surviving tamper is a
// freeze failure.
//
// Read-only with respect to evidence: it reads source text only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './market-intelligence/definition.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import {
  R4_RUNTIME_ROOTS, R4_BOUND_VALIDATORS, computeImportClosure, requiredBoundFiles, assertImportClosureBound,
} from './r4-import-closure.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadFile = file => readFileSync(path.join(REPO, file), 'utf8');

let failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; failures.push(name); console.error(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
}
const throwsCode = (fn, prefix) => assert.throws(fn, error => String(error?.message ?? error).startsWith(prefix), `expected ${prefix}`);

const closure = computeImportClosure({ rootDir: REPO });
const required = requiredBoundFiles({ rootDir: REPO });

check('the canonical bound-file set is sorted, unique and frozen', () => {
  const list = [...R4_REQUIRED_BOUND_FILES];
  assert.equal(list.length, new Set(list).size, 'no duplicates');
  assert.equal(canonical(list), canonical([...list].sort()), 'must be sorted');
});

check('the canonical bound-file set equals the declared closure plus bound non-runtime artifacts', () => {
  assert.equal(canonical([...R4_REQUIRED_BOUND_FILES].sort()), canonical([...required].sort()));
});

check('the runtime import closure is fully bound', () => {
  const result = assertImportClosureBound({ rootDir: REPO, required: R4_REQUIRED_BOUND_FILES });
  assert(result.closureSize > 0);
  assert.equal(result.closureSize, closure.files.length);
  assert.equal(closure.unresolved.length, 0);
  assert.equal(closure.unresolvedDynamic.length, 0);
  console.log(`      closure: ${closure.files.length} runtime modules; bound set: ${R4_REQUIRED_BOUND_FILES.length} artifacts`);
});

check('every bound artifact exists in the working tree', () => {
  for (const file of R4_REQUIRED_BOUND_FILES) assert(existsSync(path.join(REPO, file)), `missing bound artifact ${file}`);
});

check('every declared validator is bound', () => {
  for (const file of R4_BOUND_VALIDATORS) assert(R4_REQUIRED_BOUND_FILES.includes(file), `validator not bound: ${file}`);
});

check('every canonical runtime entrypoint is bound', () => {
  for (const file of R4_RUNTIME_ROOTS) assert(R4_REQUIRED_BOUND_FILES.includes(file), `root not bound: ${file}`);
});

check('TAMPER: a new unbound runtime import fails the closure validator', () => {
  const injected = './lib/new-unbound-runtime-module.mjs';
  const readFile = file => file === 'scripts/lib/new-unbound-runtime-module.mjs'
    ? 'export const x = 1;\n'
    : (file === 'scripts/r4-protocol-spec.mjs' ? `import '${injected}';\n${loadFile(file)}` : loadFile(file));
  throwsCode(() => assertImportClosureBound({ rootDir: REPO, required: R4_REQUIRED_BOUND_FILES, readFile }), 'R4_IMPORT_CLOSURE_UNBOUND');
});

check('TAMPER: a non-static dynamic import fails the closure validator', () => {
  const readFile = file => file === 'scripts/r4-protocol-spec.mjs'
    ? `const name = './lib/env.mjs';\nimport(name);\n${loadFile(file)}`
    : loadFile(file);
  throwsCode(() => assertImportClosureBound({ rootDir: REPO, required: R4_REQUIRED_BOUND_FILES, readFile }), 'R4_IMPORT_CLOSURE_DYNAMIC_UNSUPPORTED');
});

check('TAMPER: an omitted runtime dependency is not silently tolerated', () => {
  const shrunk = R4_REQUIRED_BOUND_FILES.filter(file => file !== 'scripts/market-intelligence/recorder.mjs');
  throwsCode(() => assertImportClosureBound({ rootDir: REPO, required: shrunk }), 'R4_IMPORT_CLOSURE_UNBOUND');
});

console.log('');
console.log(`R4 import closure: ${failures.length ? failures.length : 0} failure(s); closure assets are source-only reads`);
if (failed) process.exitCode = 1;
