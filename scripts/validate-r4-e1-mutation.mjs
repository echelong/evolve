#!/usr/bin/env node
// E1_REFERENCE_LEVEL_MISSINGNESS mutation gate.
//
// Every mutation is a controlled edit to the *text* of a production module. Each
// mutant is loaded from its own disposable mirror of scripts/ and executed
// against the exact same E1 case module the production validator uses, so a
// mutant is killed only when it changes observable E1 behaviour.
//
// A mutant that still passes every case is a SURVIVOR. A non-equivalent critical
// survivor is a freeze failure. Equivalent controls must survive; if a control
// is killed, the harness is not discriminating and every kill result is void.
//
// Synthetic temporary fixtures only. No .evolve evidence is read and no real
// outcome is generated.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { e1Cases, cleanupE1Roots } from './r4-e1-cases.mjs';

const CAPTURE = 'scripts/market-intelligence.mjs';
const QUEUE = 'scripts/market-intelligence/revisits.mjs';
const RESOLVER = 'scripts/market-outcomes/index.mjs';

const GATE_TAIL = `  if (queue.status().pending) return new Error('REVISIT_COVERAGE_FAILED');\n  const violations = typeof queue.invariants === 'function' ? queue.invariants() : [];\n  return violations.length ? new Error('REVISIT_COVERAGE_FAILED') : null;`;

export const E1_MUTATIONS = [
  { id: 'M1', critical: true, file: CAPTURE, name: 'restore failed-OR-pending session failure', find: GATE_TAIL, replace: `  return (queue.status().pending || queue.status().failed) ? new Error('REVISIT_COVERAGE_FAILED') : null;` },
  { id: 'M2', critical: true, file: CAPTURE, name: 'ignore pending scheduler work', find: `  if (queue.status().pending) return new Error('REVISIT_COVERAGE_FAILED');\n`, replace: '' },
  { id: 'M3', critical: true, file: QUEUE, name: 'erase reference-level failure telemetry', find: `    failed++;\n    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;`, replace: `    completed++;\n    failuresByCode[code] = failuresByCode[code] ?? 0;` },
  { id: 'M4', critical: true, file: QUEUE, name: 'let a pending queue report zero pending', find: `pending: pending.size,`, replace: `pending: 0,` },
  { id: 'M5', critical: true, file: RESOLVER, name: 'allow a storage-bound session against the source policy', find: `summary.storage?.sessionBoundReached === false`, replace: `true` },
  { id: 'M6', critical: true, file: RESOLVER, name: 'allow a signal-interrupted session against the source policy', find: `summary.reason === 'duration reached'`, replace: `['duration reached', 'signal'].includes(summary.reason)` },
  { id: 'M7', critical: true, file: RESOLVER, name: 'let capture telemetry name the outcome missingness category', find: `if (!future) return unavailable(window.length ? 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION' : covered ? 'NO_SAME_MINT_OBSERVATION_IN_WINDOW' : 'SOURCE_COVERAGE_GAP', rejected);`, replace: `if (!future) return unavailable('REVISIT_DEADLINE_MISSED', rejected);` },
  { id: 'M8', critical: true, file: RESOLVER, name: 'remove the source-policy duration requirement', find: `if (policy.requireDurationComplete &&`, replace: `if (false &&` },
  { id: 'C1', critical: false, equivalent: true, file: CAPTURE, name: 'CONTROL equivalent: add a comment before the null guard', find: `  if (!queue) return null;`, replace: `  // equivalent control: a null queue has no failure\n  if (!queue) return null;` },
  { id: 'C2', critical: false, equivalent: true, file: CAPTURE, name: 'CONTROL equivalent: compare pending explicitly against zero', find: `  if (queue.status().pending) return new Error('REVISIT_COVERAGE_FAILED');`, replace: `  if (queue.status().pending !== 0) return new Error('REVISIT_COVERAGE_FAILED');` },
];

function applyMutation(text, mutation) {
  const occurrences = text.split(mutation.find).length - 1;
  if (occurrences !== 1) throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${mutation.id}:${occurrences}`);
  const mutated = text.replace(mutation.find, mutation.replace);
  if (mutated === text) throw new Error(`MUTATION_NO_CHANGE:${mutation.id}`);
  return mutated;
}

async function loadApi(root) {
  const capture = await import(pathToFileURL(path.join(root, 'scripts', 'market-intelligence.mjs')).href);
  const queue = await import(pathToFileURL(path.join(root, 'scripts', 'market-intelligence', 'revisits.mjs')).href);
  const storage = await import(pathToFileURL(path.join(root, 'scripts', 'market-intelligence', 'storage.mjs')).href);
  const resolver = await import(pathToFileURL(path.join(root, 'scripts', 'market-outcomes', 'index.mjs')).href);
  return { revisitExitFailure: capture.revisitExitFailure, createRevisitQueue: queue.createRevisitQueue,
    createStorage: storage.createStorage, readSourceSession: resolver.readSourceSession,
    generateOutcomeRun: resolver.generateOutcomeRun, snapshotMissingReason: resolver.snapshotMissingReason };
}

async function runCases(label, root) {
  const api = await loadApi(root);
  const cases = e1Cases(api);
  const failures = [];
  for (const [name, fn] of cases) {
    try { await fn(); } catch (e) { failures.push({ name, error: String(e?.message ?? e).split('\n')[0] }); }
  }
  return { label, total: cases.length, failures };
}

export async function runE1MutationSuite({ log = () => {} } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'r4-e1-mutation-'));
  const rows = [];
  let failed = 0;
  try {
    const baseline = await runCases('BASELINE', '.');
    if (baseline.failures.length) {
      failed++;
      log(`FAIL BASELINE: ${baseline.failures.length}/${baseline.total} E1 case(s) fail against the unmutated modules`);
      for (const f of baseline.failures) log(`  FAIL ${f.name}: ${f.error}`);
    } else log(`PASS BASELINE ${baseline.total}/${baseline.total} E1 cases hold against the unmutated modules`);

    for (const [i, mutation] of E1_MUTATIONS.entries()) {
      const mirror = path.join(workspace, `m${i}`);
      cpSync('scripts', path.join(mirror, 'scripts'), { recursive: true });
      const target = path.join(mirror, mutation.file);
      let mutated;
      try { mutated = applyMutation(readFileSync(path.join(mutation.file), 'utf8'), mutation); }
      catch (e) { failed++; rows.push({ ...mutation, status: 'ANCHOR_ERROR', correct: false }); log(`FAIL ${mutation.id} ${mutation.name}: ${e.message}`); continue; }
      writeFileSync(target, mutated);
      const result = await runCases(mutation.id, mirror);
      const survived = result.failures.length === 0;
      const expectedSurvival = Boolean(mutation.equivalent);
      const correct = survived === expectedSurvival;
      if (!correct) failed++;
      const status = survived ? 'SURVIVED' : `KILLED by ${result.failures.length}/${result.total}`;
      rows.push({ id: mutation.id, critical: Boolean(mutation.critical), name: mutation.name, status, correct, killedBy: result.failures.map(f => `${f.name} :: ${f.error}`) });
      const tag = mutation.equivalent ? 'CONTROL' : mutation.critical ? 'CRITICAL' : 'non-critical';
      if (correct) log(`PASS ${mutation.id} [${tag}] ${mutation.name} -> ${status}`);
      else log(`FAIL ${mutation.id} [${tag}] ${mutation.name} -> ${status} (expected ${expectedSurvival ? 'SURVIVED' : 'KILLED'})`);
      for (const f of result.failures.slice(0, 3)) log(`      killed by: ${f.name} :: ${f.error}`);
    }
  } finally {
    cleanupE1Roots();
    rmSync(workspace, { recursive: true, force: true });
  }
  const critical = rows.filter(r => r.critical);
  const criticalSurvivors = critical.filter(r => r.status === 'SURVIVED');
  const controls = rows.filter(r => r.id.startsWith('C'));
  const controlFailures = controls.filter(r => r.status !== 'SURVIVED');
  if (criticalSurvivors.length) failed++;
  if (controlFailures.length) failed++;
  log('');
  log(`E1 mutation: ${critical.filter(r => r.status.startsWith('KILLED')).length}/${critical.length} critical mutants killed`);
  log(`E1 mutation: non-equivalent critical survivors: ${criticalSurvivors.length}`);
  log(`E1 mutation: equivalent controls proven surviving: ${controls.length - controlFailures.length}/${controls.length}`);
  for (const r of criticalSurvivors) log(`SURVIVOR ${r.id}: ${r.name}`);
  if (controlFailures.length) log('EQUIVALENCE NOT PROVEN: a behaviour-preserving control was killed, so kill results are void');
  return { failed, rows, criticalTotal: critical.length,
    criticalKilled: critical.filter(r => r.status.startsWith('KILLED')).length,
    criticalSurvivors: criticalSurvivors.map(r => r.id),
    controlsTotal: controls.length, controlsSurviving: controls.length - controlFailures.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runE1MutationSuite({ log: (...args) => console.log(...args) })
    .then(summary => { if (summary.failed) process.exitCode = 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
