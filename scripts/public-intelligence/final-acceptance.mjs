#!/usr/bin/env node
// Phase 5K FINAL - READ-ONLY ACCEPTANCE RUNNER.
//
// WHAT THIS RUNS
//
// One deterministic acceptance pass over the CLOSED Phase 5K public-social
// intelligence program:
//
//    1 repository identity and state needed for acceptance
//    2 load the source-controlled final authority
//    3 verify the authority schema
//    4 verify the authority fingerprint
//    5 verify the accepted implementation commit exists and is an ancestor
//    6 reconstruct the governed file inventory from that commit
//    7 verify the governed tree digest
//    8 verify the complete phase inventory
//    9 verify the frozen boundary flags
//   10 verify the semantic declarations still mean what they meant
//   11 run the required validator suite
//   12 verify the exact expected validator counts
//   13 confirm no forbidden authority surface
//   14 confirm R4 isolation
//   15 confirm storage isolation
//   16 confirm network isolation
//   17 confirm the closure surface integrity
//
// WHAT IT NEVER DOES
//
// It never modifies the repository, never writes into the guarded storage
// area, never contacts a provider, never calls a market API, never writes
// network data, never finalizes or re-runs anything belonging to R4 and never
// creates a runtime capture inside the repository. It writes NO file at all:
// the report goes to stdout. The only child processes it starts are `git`
// (read commands) and `node <historical phase validator>`.
//
// The tripwires below turn a real fetch or a real socket connect inside this
// process into a counted failure, so "offline" is measured rather than assumed.
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD,
  PHASE_5K_FINAL_R4_AUTHORITY_HEAD,
  PHASE_5K_FINAL_AUTHORITY_PATH,
  PHASE_5K_FINAL_CLOSURE_FILES,
  PHASE_5K_FINAL_DEFINITION_PATH,
  PHASE_5K_FINAL_DOCUMENT_PATH,
  PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL,
  PHASE_5K_FINAL_PHASES,
  PHASE_5K_FINAL_RUNNER_PATH,
  PHASE_5K_FINAL_SURFACE_PATH,
  PHASE_5K_FINAL_VALIDATOR_PATH,
  boundaryFlagsIdentity,
  buildGovernedInventory,
  authorityFingerprintOf,
  governedTreeDigestOf,
  isClosureSurfacePath,
  isGovernedPhase5KPath,
  livePhase5KSemantics,
  verifyAuthorityRecord,
} from './final-acceptance-definition.mjs';

export const PHASE_5K_FINAL_ACCEPTANCE_STEPS = Object.freeze([
  'REPOSITORY_IDENTITY',
  'AUTHORITY_ARTIFACT',
  'AUTHORITY_SCHEMA',
  'AUTHORITY_FINGERPRINT',
  'ACCEPTED_COMMIT',
  'GOVERNED_INVENTORY',
  'GOVERNED_TREE_DIGEST',
  'PHASE_INVENTORY',
  'BOUNDARY_FLAGS',
  'SEMANTICS_BINDING',
  'VALIDATOR_SUITE',
  'EXPECTED_COUNTS',
  'FORBIDDEN_AUTHORITY_SURFACE',
  'R4_ISOLATION',
  'STORAGE_ISOLATION',
  'NETWORK_ISOLATION',
  'CLOSURE_SURFACE_INTEGRITY',
]);

/** The pinned boundary flags: the ones that must stay TRUE ... */
export const PHASE_5K_FINAL_REQUIRED_TRUE_FLAGS = Object.freeze([
  'researchOnly', 'observerOnly', 'paperOnly', 'developmentOnly',
]);

/** ... and the ones that must stay FALSE, with no semantic weakening. */
export const PHASE_5K_FINAL_REQUIRED_FALSE_FLAGS = Object.freeze([
  'tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible',
  'priceDataPermitted', 'marketOutcomeLinkagePermitted', 'profitabilityInferencePermitted',
  'predictionPermitted', 'recommendationPermitted', 'rankingPermitted',
  'assetScoringPermitted', 'walletAuthority', 'signerAuthority',
  'swapAuthority', 'rpcWriteAuthority', 'crossProviderIdentityResolutionPermitted',
  'providerContactPermittedDuringAcceptance', 'liveNetworkDependencyInDerivedLayers',
  'personalDataSurfaceExpansionPermitted', 'r4MutationPermitted',
  'evolveStorageWritePermitted', 'runtimeCapturePermittedInClosure',
]);

const REPORT_LINE = /^Phase ([0-9A-Za-z.]+): (\d+)\/(\d+) passed/m;

/** Replace the two live-network primitives with counting tripwires. */
export function installNetworkTripwires() {
  const state = { calls: 0 };
  globalThis.fetch = () => { state.calls += 1; throw new Error('TRIPWIRE: acceptance attempted a real fetch'); };
  net.Socket.prototype.connect = function acceptanceTripwire() {
    state.calls += 1;
    throw new Error('TRIPWIRE: acceptance attempted a socket connect');
  };
  return state;
}

/** The only git reader the acceptance run uses: read-only, byte-exact. */
export function createGitReader(repoRoot) {
  return args => execFileSync('git', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
}

const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };

/**
 * Run the required validator suite: exactly one `node` process per accepted
 * phase, in the governed order. Success is the REPORTED EXACT PASS COUNT - an
 * exit status alone proves nothing here.
 */
export function runValidatorSuite({ repoRoot, phases = PHASE_5K_FINAL_PHASES } = {}) {
  return phases.map(entry => {
    const output = execFileSync('node', [entry.validator], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const matched = output.match(REPORT_LINE);
    const reported = matched ? { phase: matched[1], passed: Number(matched[2]), total: Number(matched[3]) } : null;
    return { phase: entry.phase, validator: entry.validator, exitCode: 0, reported, ok: Boolean(reported) };
  });
}

/** The acceptance pass. Pure with respect to the repository: read-only. */
export async function runFinalAcceptance({
  repoRoot,
  git = createGitReader(repoRoot),
  runSuite = runValidatorSuite,
  authorityPath = PHASE_5K_FINAL_AUTHORITY_PATH,
  tripwires = installNetworkTripwires(),
} = {}) {
  const steps = [];
  const failures = [];
  const step = (id, fn) => {
    try {
      const detail = fn();
      steps.push({ id, ok: true, detail: detail ?? null });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      steps.push({ id, ok: false, detail });
      failures.push(`${id}:${detail}`);
      return false;
    }
  };
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const utf8 = args => git(args).toString('utf8');

  // 1. Repository identity ---------------------------------------------------
  let head = null;
  step('REPOSITORY_IDENTITY', () => {
    require(utf8(['rev-parse', '--is-inside-work-tree']).trim() === 'true', 'not a git work tree');
    head = utf8(['rev-parse', 'HEAD']).trim();
    require(/^[0-9a-f]{40}$/.test(head), 'HEAD is not a commit id');
    execFileSync('git', ['merge-base', '--is-ancestor', PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, head], { cwd: repoRoot });
    return `HEAD=${head}`;
  });

  // 2. Authority artifact ----------------------------------------------------
  let record = null;
  step('AUTHORITY_ARTIFACT', () => {
    const target = path.join(repoRoot, authorityPath);
    require(existsFile(target), `missing authority artifact: ${authorityPath}`);
    record = JSON.parse(readFileSync(target, 'utf8'));
    return authorityPath;
  });

  // 3. Schema ----------------------------------------------------------------
  step('AUTHORITY_SCHEMA', () => {
    require(record, 'authority artifact not loaded');
    const verification = verifyAuthorityRecord(record);
    require(verification.ok, verification.failures.join(','));
    return `status=${record.status} phases=${record.phaseInventory.length}`;
  });

  // 4. Fingerprint -----------------------------------------------------------
  step('AUTHORITY_FINGERPRINT', () => {
    require(record, 'authority artifact not loaded');
    const recomputed = authorityFingerprintOf(record);
    require(recomputed === record.authorityFingerprint, 'authority fingerprint mismatch');
    return record.authorityFingerprint;
  });

  // 5. Accepted commit -------------------------------------------------------
  step('ACCEPTED_COMMIT', () => {
    const type = utf8(['cat-file', '-t', PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD]).trim();
    require(type === 'commit', `accepted implementation head is a ${type}`);
    require(utf8(['rev-parse', `${PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD}^{commit}`]).trim() === PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, 'accepted head is not a commit');
    return PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD;
  });

  // 6. Governed inventory ----------------------------------------------------
  let inventory = null;
  step('GOVERNED_INVENTORY', () => {
    inventory = buildGovernedInventory({ git });
    const declared = record.governedInventory.files;
    require(inventory.files.length === declared.length, `inventory length ${inventory.files.length} != ${declared.length}`);
    require(inventory.files.length === record.governedInventory.fileCount, 'declared file count mismatch');
    for (let index = 0; index < inventory.files.length; index += 1) {
      const left = inventory.files[index];
      const right = declared[index];
      require(left.path === right.path && left.gitBlobObjectId === right.gitBlobObjectId
        && left.gitMode === right.gitMode && left.contentDigest === right.contentDigest,
      `governed member drift at ${left.path}`);
    }
    return `${inventory.files.length} files`;
  });

  // 7. Governed tree digest --------------------------------------------------
  step('GOVERNED_TREE_DIGEST', () => {
    const recomputed = governedTreeDigestOf(inventory.files);
    require(recomputed === record.governedInventory.governedTreeDigest, 'governed tree digest mismatch');
    return recomputed;
  });

  // 8. Phase inventory -------------------------------------------------------
  step('PHASE_INVENTORY', () => {
    const phases = record.phaseInventory.map(entry => entry.phase);
    require(new Set(phases).size === phases.length, 'duplicate phase');
    require(phases.includes('5K.10') === false, 'an implied Phase 5K.10 exists');
    const tracked = new Set(inventory.files.map(entry => entry.path));
    for (const entry of record.phaseInventory) {
      require(tracked.has(entry.validator), `validator not governed: ${entry.validator}`);
      require(tracked.has(entry.document), `document not governed: ${entry.document}`);
      require(entry.status === 'ACCEPTED', `phase ${entry.phase} is not ACCEPTED`);
    }
    return `${phases.join(',')}`;
  });

  // 9. Boundary flags --------------------------------------------------------
  step('BOUNDARY_FLAGS', () => {
    require(boundaryFlagsIdentity(record.boundaryFlags) === boundaryFlagsIdentity(), 'boundary flags weakened');
    for (const flag of PHASE_5K_FINAL_REQUIRED_TRUE_FLAGS) {
      require(record.boundaryFlags[flag] === true, `${flag} is not true`);
    }
    for (const flag of PHASE_5K_FINAL_REQUIRED_FALSE_FLAGS) {
      require(record.boundaryFlags[flag] === false, `${flag} is not false`);
    }
    return `${Object.keys(record.boundaryFlags).length} flags frozen`;
  });

  // 10. Semantics ------------------------------------------------------------
  step('SEMANTICS_BINDING', () => {
    require(JSON.stringify(record.semantics) === JSON.stringify(livePhase5KSemantics()), 'semantic declarations changed');
    return 'temporal/corroboration/lineage/features bound';
  });

  // 11. Suite ----------------------------------------------------------------
  let suite = null;
  step('VALIDATOR_SUITE', () => {
    suite = runSuite({ repoRoot, phases: PHASE_5K_FINAL_PHASES });
    require(suite.length === PHASE_5K_FINAL_PHASES.length, 'suite length mismatch');
    for (const result of suite) {
      require(result.exitCode === 0, `${result.validator} exited ${result.exitCode}`);
      require(result.reported, `${result.validator} printed no report line`);
    }
    return `${suite.length} validators executed`;
  });

  // 12. Expected counts ------------------------------------------------------
  let aggregate = null;
  step('EXPECTED_COUNTS', () => {
    let passed = 0;
    let total = 0;
    for (const entry of PHASE_5K_FINAL_PHASES) {
      const result = suite.find(candidate => candidate.phase === entry.phase);
      require(result, `no suite result for ${entry.phase}`);
      require(result.reported.passed === entry.expectedPassed && result.reported.total === entry.expectedTotal,
        `${entry.phase} reported ${result.reported.passed}/${result.reported.total}`);
      require(result.reported.phase === entry.phase, `${entry.validator} reported phase ${result.reported.phase}`);
      passed += result.reported.passed;
      total += result.reported.total;
    }
    aggregate = { passed, total, expected: PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL };
    require(passed === PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL, `aggregate ${passed} != ${PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL}`);
    return `${passed}/${total} historical assertions`;
  });

  // 13. No forbidden authority surface ---------------------------------------
  step('FORBIDDEN_AUTHORITY_SURFACE', () => {
    // A DECLARATION may legitimately name what it refuses or defers. What no
    // closure module may do is CALL a financial primitive, BIND a financial
    // identifier or IMPORT a decision surface.
    const bannedCall = /\b(?:signTransaction|sendTransaction|executeSwap|submitTrade|placeOrder|submitOrder|promoteChampion|arenaScore|getPrice|fetchPrice)\s*\(/;
    const bannedProperty = /\.(?:priceUsd|marketCap|futureReturn|walletAddress|solanaRpc)\b/;
    const bannedBinding = /\b(?:signer|wallet|keypair|privateKey|secretKey)\s*[=(]/;
    const importSource = /\bfrom\s+['"]([^'"]+)['"]/g;
    const decisionSurface = /(engine|arena|champions|market-outcomes|r4-)/;
    for (const relative of PHASE_5K_FINAL_CLOSURE_FILES.filter(entry => entry.endsWith('.mjs'))) {
      const source = readFileSync(path.join(repoRoot, relative), 'utf8');
      require(!bannedCall.test(source), `${relative} calls a financial primitive`);
      require(!bannedProperty.test(source), `${relative} reads a market field`);
      require(!bannedBinding.test(source), `${relative} binds a financial identifier`);
      for (const matched of source.matchAll(importSource)) {
        require(!decisionSurface.test(matched[1]), `${relative} imports a decision surface: ${matched[1]}`);
      }
    }
    require(Array.isArray(record.deferredCapabilities.capabilities), 'deferred capabilities missing');
    require(record.deferredCapabilities.requiresSeparateGovernedProgram === true, 'deferred work is not gated');
    return 'no market, trading, wallet, signer, swap, RPC or engine authority';
  });

  // 14. R4 isolation ---------------------------------------------------------
  step('R4_ISOLATION', () => {
    const r4Paths = ['governance/r4', '.evolve', 'scripts/r4-finalization.mjs', 'scripts/r4-result-attestation.mjs'];
    const changed = git(['diff', '--name-only', PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, 'HEAD', '--', ...r4Paths]).toString('utf8').trim();
    require(changed === '', `the guarded r4Paths changed since the accepted head: ${changed}`);
    for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
      const now = git(['show', `HEAD:${bound}`]);
      const atC1 = git(['show', `${PHASE_5K_FINAL_R4_AUTHORITY_HEAD}:${bound}`]);
      require(now.equals(atC1), `R4 bound artifact modified: ${bound}`);
    }
    return `R4 C1 ${PHASE_5K_FINAL_R4_AUTHORITY_HEAD.slice(0, 12)} untouched`;
  });

  // 15. Storage isolation ----------------------------------------------------
  step('STORAGE_ISOLATION', () => {
    require(utf8(['ls-files', 'var']).trim() === '', 'a runtime capture is tracked under var/');
    require(utf8(['ls-files', '.evolve']).trim() === '', '.evolve is tracked');
    for (const line of utf8(['status', '--porcelain']).split('\n').filter(Boolean)) {
      const entry = line.slice(3).trim();
      require(!entry.startsWith('var/') && !entry.startsWith('.evolve'), `guarded area is dirty: ${line}`);
    }
    return '.evolve untouched, 0 tracked runtime captures';
  });

  // 16. Network isolation ----------------------------------------------------
  step('NETWORK_ISOLATION', () => {
    require(tripwires.calls === 0, `acceptance made ${tripwires.calls} network calls`);
    return '0 network calls, 0 provider contacts, 0 market calls';
  });

  // 17. Closure surface integrity --------------------------------------------
  step('CLOSURE_SURFACE_INTEGRITY', () => {
    for (const relative of PHASE_5K_FINAL_CLOSURE_FILES) {
      require(existsFile(path.join(repoRoot, relative)), `missing closure file: ${relative}`);
    }
    require(existsFile(path.join(repoRoot, PHASE_5K_FINAL_VALIDATOR_PATH)), 'missing final validator');
    require(existsFile(path.join(repoRoot, PHASE_5K_FINAL_DEFINITION_PATH)), 'missing closure definition');
    require(existsFile(path.join(repoRoot, PHASE_5K_FINAL_RUNNER_PATH)), 'missing acceptance runner');
    require(existsFile(path.join(repoRoot, PHASE_5K_FINAL_SURFACE_PATH)), 'missing closure surface');
    require(existsFile(path.join(repoRoot, PHASE_5K_FINAL_DOCUMENT_PATH)), 'missing closure document');
    const status = utf8(['diff', '--name-status', PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, '--'])
      .split('\n').filter(Boolean).map(line => ({ code: line[0], path: line.slice(2) }));
    for (const entry of status) {
      if (!isGovernedPhase5KPath(entry.path)) continue;
      if (entry.code === 'A') { require(isClosureSurfacePath(entry.path), `unexpected addition in the governed tree: ${entry.path}`); continue; }
      require(false, `accepted implementation modified: ${entry.code} ${entry.path}`);
    }
    return `${PHASE_5K_FINAL_CLOSURE_FILES.length} closure files, accepted implementation unmodified`;
  });

  const status = failures.length === 0 && steps.every(entry => entry.ok) ? 'PASS' : 'FAIL';
  return { status, steps, failures, historical: aggregate, suite, head, authorityPath };
}

/** Render the concise PASS/FAIL report. */
export function renderAcceptanceReport(report) {
  const lines = [];
  lines.push('PHASE 5K FINAL ACCEPTANCE');
  for (const entry of report.steps) lines.push(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.id}${entry.detail ? ` - ${entry.detail}` : ''}`);
  if (report.historical) lines.push(`HISTORICAL ASSERTIONS ${report.historical.passed}/${report.historical.total} (expected ${report.historical.expected})`);
  lines.push(`PHASE_5K_FINAL_ACCEPTANCE: ${report.status}`);
  return lines.join('\n');
}

/** CLI entry point. Prints the report and sets the exit code. Never writes. */
export async function main({ repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') } = {}) {
  const report = await runFinalAcceptance({ repoRoot });
  console.log(renderAcceptanceReport(report));
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('phase 5K final acceptance crashed:', error); process.exitCode = 1; });
}
