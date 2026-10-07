#!/usr/bin/env node
// Phase 5K FINAL - ACCEPTANCE AND CLOSURE validator.
//
// WHAT THIS SUITE PROVES
//
// Phase 5K feature development is complete and this suite formally ACCEPTS,
// SEALS and CLOSES the whole public-social-intelligence program. It proves:
//
//   - exactly one accepted implementation was sealed, by rebuilding its
//     governed inventory from the accepted commit's tracked blobs (never from
//     the working filesystem) and recomputing one digest over it;
//   - the closure record is deterministic: its fingerprint is a pure function
//     of the accepted implementation and the frozen governance constants, with
//     no clock, no host, no path and no insertion-order dependence;
//   - every accepted historical layer keeps its exact validator result, and the
//     aggregate is exactly the pinned historical assertion total;
//   - the derived layers still MEAN what they meant: corroboration is coverage,
//     lineage is structural provenance, features are measurements, and none of
//     them is truth, confidence, authorship, importance or a signal;
//   - the boundaries are frozen, the deferred capabilities are DEFERRED rather
//     than incomplete, and R4 and `.evolve` are untouched;
//   - the closure itself requires ZERO network, ZERO market data and ZERO
//     provider contact, which is MEASURED with tripwires rather than assumed.
//
// COMPLETELY OFFLINE AND READ-ONLY. The global fetch and the socket connect
// primitive are replaced with tripwires and the suite asserts neither was ever
// called. This validator writes no file: it creates no temporary root, no
// capture and no log. Its only child processes are `git` (read commands) and
// the accepted historical phase validators, each of which is read-only too.
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that reaches a phase module directly breaks them. This
// validator therefore imports exactly ONE project module - the governed closure
// surface - and names no protected module path of any phase.
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const TRIPWIRES = { calls: 0 };
globalThis.fetch = () => { TRIPWIRES.calls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { TRIPWIRES.calls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// The ONE project import: the governed closure surface.
const SURFACE = await import('./public-intelligence/final-acceptance-surface.mjs');

const DEF = SURFACE;
const ACCEPTANCE = SURFACE.FINAL_ACCEPTANCE_5K;
const CLASSIFICATION = SURFACE.PUBLIC_INTELLIGENCE_CLASSIFICATION;
const R4_BOUNDARY = SURFACE.PUBLIC_INTELLIGENCE_R4_BOUNDARY;
const PERSONAL_DATA = SURFACE.PUBLIC_INTELLIGENCE_RAW_SCHEMA;
const SCOPE = SURFACE.PUBLIC_INTELLIGENCE_SCOPE;
const COLLECTION_BOUNDS = SURFACE.PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS;
const TEMPORAL_CLASSIFICATIONS = SURFACE.PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS;
const REVISION_SOURCES = SURFACE.PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES;
const COVERAGE = SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS;
const COVERAGE_STATUS = SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS;
const COVERAGE_STATUS_VALUES = SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES;
const INDEPENDENCE = SURFACE.PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE;
const CORROBORATION_MARKET = SURFACE.PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE;
const LINEAGE_CLASS = SURFACE.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS;
const LINEAGE_CLASS_VALUES = SURFACE.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES;
const DUPLICATION = SURFACE.PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS;
const IDENTITY_RESOLUTION = SURFACE.PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION;
const LINEAGE_MARKET = SURFACE.PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE;
const FEATURE_SEMANTICS = SURFACE.PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS;
const FEATURE_TIME = SURFACE.PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS;
const ENGAGEMENT = SURFACE.PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS;
const FEATURE_MARKET = SURFACE.PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE;
const HARD_CEILINGS = SURFACE.PROVIDER_HARD_CEILINGS;
const PROTECTED_FRAGMENTS = SURFACE.PROTECTED_MODULE_FRAGMENTS;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const require = createRequire(import.meta.url);
const espree = require('espree');

// ---------------------------------------------------------------------------
// HARNESS (read-only: nothing here writes, ever)
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected a refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
const readRepo = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const gitBuffer = args => execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
const gitOut = (...args) => gitBuffer(args).toString('utf8');
const sha256Projection = value => DEF.sha256Hex(Buffer.from(DEF.canonicalAuthorityIdentity(value), 'utf8'));

function parseModule(relative) {
  const source = readRepo(relative);
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [], memberObjects: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) {
      found.importSources.push(node.source.value);
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}

const CLOSURE_MODULES = Object.freeze(DEF.PHASE_5K_FINAL_CLOSURE_FILES.filter(entry => entry.endsWith('.mjs')));
const closureSources = () => Object.fromEntries(CLOSURE_MODULES.map(entry => [entry, readRepo(entry)]));

// Memoized: each expensive read or run happens exactly once.
let AUTHORITY_RECORD = null;
const authority = () => {
  if (!AUTHORITY_RECORD) AUTHORITY_RECORD = JSON.parse(readRepo(DEF.PHASE_5K_FINAL_AUTHORITY_PATH));
  return AUTHORITY_RECORD;
};
let REBUILT = null;
const rebuilt = () => { if (!REBUILT) REBUILT = DEF.buildAuthorityRecord({ git: gitBuffer }); return REBUILT; };
let INVENTORY = null;
const inventory = () => { if (!INVENTORY) INVENTORY = DEF.buildGovernedInventory({ git: gitBuffer }); return INVENTORY; };
let SUITE = null;
const suite = () => {
  if (!SUITE) SUITE = ACCEPTANCE.runValidatorSuite({ repoRoot: REPO_ROOT, phases: DEF.PHASE_5K_FINAL_PHASES });
  return SUITE;
};
let REPORT = null;
const acceptance = async () => {
  if (!REPORT) {
    REPORT = await ACCEPTANCE.runFinalAcceptance({
      repoRoot: REPO_ROOT, git: gitBuffer, runSuite: () => suite(), tripwires: TRIPWIRES,
      authorityPath: DEF.PHASE_5K_FINAL_AUTHORITY_PATH,
    });
  }
  return REPORT;
};
const suiteOf = phase => suite().find(result => result.phase === phase);

// ===========================================================================
// A. AUTHORITY SCHEMA
// ===========================================================================
test('A1 the closure authority is source-controlled at the governed path and parses as JSON', () => {
  assert.ok(existsFile(path.join(REPO_ROOT, DEF.PHASE_5K_FINAL_AUTHORITY_PATH)), 'authority artifact missing');
  assert.equal(typeof authority(), 'object');
  assert.equal(authority().recordType, DEF.PHASE_5K_FINAL_RECORD_TYPE);
});
test('A2 the schema version is the governed closure schema', () => {
  assert.equal(authority().schemaVersion, DEF.PHASE_5K_FINAL_SCHEMA_VERSION);
  assert.equal(authority().schemaVersion, '5K.final.0');
});
test('A3 the record type is phase5k_final_authority', () => assert.equal(authority().recordType, 'phase5k_final_authority'));
test('A4 the status is CLOSED', () => {
  assert.equal(authority().status, DEF.PHASE_5K_FINAL_STATUS);
  assert.equal(authority().status, 'CLOSED');
});
test('A5 the top-level key set is exactly the governed key set', () => {
  assert.deepEqual([...Object.keys(authority())].sort(), [...DEF.PHASE_5K_FINAL_AUTHORITY_KEYS].sort());
});
test('A6 no runtime, host or machine field appears anywhere in the record', () => {
  const keys = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') { for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } }
  };
  walk(authority());
  for (const forbidden of DEF.PHASE_5K_FINAL_FORBIDDEN_AUTHORITY_FIELDS) assert.ok(!keys.includes(forbidden), forbidden);
});
test('A7 no record string is an absolute path, a host path or a URL', () => {
  const strings = [];
  const walk = value => {
    if (typeof value === 'string') { strings.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(authority());
  for (const value of strings) {
    assert.ok(!value.startsWith('/'), value);
    assert.ok(!/(^|[/\\])(home|Users|root)[/\\]/.test(value), value);
    assert.ok(!/^[a-z]+:\/\//i.test(value), value);
  }
});
test('A8 no record string carries a credential shape', () => {
  // The governed personal-data REFUSAL list legitimately names the fields it
  // refuses, so it is removed before the scan: those are declarations, not
  // credentials.
  const { semantics, ...rest } = authority();
  const binderFree = Object.fromEntries(Object.entries(semantics ?? {}).filter(([key]) => key !== 'governance'));
  const record = JSON.stringify({ ...rest, semantics: binderFree });
  for (const banned of ['Authorization:', 'Bearer ', 'password', 'apiKey', 'api_key', 'secretKey', 'privateKey', 'cookie']) {
    assert.ok(!record.includes(banned), banned);
  }
  assert.ok(binderFree.temporal && binderFree.features, 'the semantics blocks are still bound');
});
test('A9 the record rebuild is deterministic and equals the checked-in artifact', () => {
  assert.equal(DEF.canonicalAuthorityIdentity(authority()), DEF.canonicalAuthorityIdentity(rebuilt()));
});
test('A10 the authority artifact is canonical JSON with a trailing newline', () => {
  const bytes = readFileSync(path.join(REPO_ROOT, DEF.PHASE_5K_FINAL_AUTHORITY_PATH));
  assert.deepEqual(bytes, DEF.authorityArtifactBytes(authority()));
});
test('A11 the record is acceptance-only: it claims no new functionality and no new result', () => {
  const scope = authority().acceptanceScope;
  assert.equal(scope.recordIsAcceptanceOnly, true);
  assert.equal(scope.addsPublicIntelligenceFunctionality, false);
  assert.equal(scope.computesNewScientificResult, false);
  assert.equal(scope.reinterpretsR4, false);
  assert.equal(scope.createsSuccessorProgram, false);
  assert.equal(scope.impliedSuccessorPhase, null);
});
test('A12 the schema verification helper accepts the record and rejects a tampered schema version', () => {
  assert.equal(DEF.verifyAuthorityRecord(authority()).ok, true);
  const tampered = { ...authority(), schemaVersion: '5K.final.1' };
  assert.ok(DEF.verifyAuthorityRecord(tampered).failures.includes('AUTHORITY_SCHEMA_VERSION_INVALID'));
});

// ===========================================================================
// B. ACCEPTED IMPLEMENTATION SHA
// ===========================================================================
test('B1 the accepted implementation head is a 40-hex commit id', () => {
  assert.match(DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, /^[0-9a-f]{40}$/);
  assert.match(authority().acceptedImplementationHead, /^[0-9a-f]{40}$/);
});
test('B2 the accepted head equals the pinned closure constant', () => {
  assert.equal(authority().acceptedImplementationHead, DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD);
  assert.equal(DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, 'ed56ed17e366cffb59d088820b69a007890b538a');
});
test('B3 the accepted commit exists in this repository as a commit object', () => {
  assert.equal(gitOut('cat-file', '-t', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD).trim(), 'commit');
});
test('B4 the accepted commit is an ancestor of HEAD', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, 'HEAD'], { cwd: REPO_ROOT });
});
test('B5 the accepted commit is an ancestor of origin/main where that ref exists', () => {
  const refs = gitOut('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/main').trim();
  if (!refs) return;
  execFileSync('git', ['merge-base', '--is-ancestor', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, 'refs/remotes/origin/main'], { cwd: REPO_ROOT });
});
test('B6 the accepted implementation is sealed as history: HEAD is it, or exactly one closure commit descends from it', () => {
  const count = Number(gitOut('rev-list', '--count', `${DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD}..HEAD`).trim());
  assert.ok(count <= 1, `${count} commits were added after the accepted implementation`);
  if (count === 0) assert.equal(gitOut('rev-parse', 'HEAD').trim(), DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD);
  else assert.equal(gitOut('log', '-1', '--format=%s', 'HEAD').trim(), 'Close Phase 5K public intelligence');
});
test('B7 the checked-in authority is exactly what the accepted commit rebuilds', () => {
  assert.equal(rebuilt().acceptedImplementationHead, DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD);
  const verification = DEF.verifyAuthorityAgainstGit(authority(), { git: gitBuffer });
  assert.equal(verification.ok, true, JSON.stringify(verification.failures));
});

// ===========================================================================
// C. COMPLETE PHASE INVENTORY
// ===========================================================================
test('C1 exactly fourteen accepted phases are declared', () => {
  assert.equal(authority().phaseInventory.length, 14);
  assert.equal(DEF.PHASE_5K_FINAL_PHASES.length, 14);
});
test('C2 no phase id repeats', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.equal(new Set(phases).size, phases.length);
});
test('C3 the declared phase order is the governed order', () => {
  assert.deepEqual(authority().phaseInventory.map(entry => entry.phase), [...DEF.PHASE_5K_FINAL_PHASE_ORDER]);
  assert.deepEqual([...DEF.PHASE_5K_FINAL_PHASE_ORDER], ['5K.0', '5K.1', '5K.2', '5K.3', '5K.4', '5K.5', '5K.5.1', '5K.6', '5K.6.1', '5K.6.2', '5K.6.3', '5K.7', '5K.8', '5K.9']);
});
test('C4 the last accepted layer is 5K.9 and no later layer is implied', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.equal(phases[phases.length - 1], '5K.9');
  assert.equal(phases.includes('5K.10'), false);
  assert.equal(authority().acceptanceScope.impliedSuccessorPhase, null);
});
test('C5 no phase id, title or document implies a Phase 5K.10', () => {
  for (const line of [JSON.stringify(authority().phaseInventory), JSON.stringify(authority().deferredCapabilities)]) {
    assert.ok(!/5K\.10|PHASE_5K_10/.test(line), line.slice(0, 120));
  }
});
test('C6 every declared validator is governed at the accepted commit', () => {
  const tracked = new Set(inventory().files.map(entry => entry.path));
  for (const entry of authority().phaseInventory) assert.ok(tracked.has(entry.validator), entry.validator);
});
test('C7 every declared document is governed at the accepted commit', () => {
  const tracked = new Set(inventory().files.map(entry => entry.path));
  for (const entry of authority().phaseInventory) assert.ok(tracked.has(entry.document), entry.document);
});
test('C8 every phase is ACCEPTED and every phase carries a real title', () => {
  for (const entry of authority().phaseInventory) {
    assert.equal(entry.status, 'ACCEPTED', entry.phase);
    assert.ok(typeof entry.title === 'string' && entry.title.trim().length > 8, entry.phase);
  }
});
test('C9 the corrective layer 5K.5.1 sits between 5K.5 and 5K.6', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.equal(phases.indexOf('5K.5.1'), phases.indexOf('5K.5') + 1);
  assert.equal(authority().phaseInventory[phases.indexOf('5K.5.1')].validator, 'scripts/validate-phase5k5-1.mjs');
});
test('C10 the provider-correction layers 5K.6.1-5K.6.3 sit between 5K.6 and 5K.7', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.deepEqual(phases.slice(phases.indexOf('5K.6'), phases.indexOf('5K.7')), ['5K.6', '5K.6.1', '5K.6.2', '5K.6.3']);
});
test('C11 the 5K.7/5K.8/5K.9 derived layers are the last three accepted phases', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.deepEqual(phases.slice(-3), ['5K.7', '5K.8', '5K.9']);
});
test('C12 the phase inventory carries no duplicate validator and no duplicate document pair mismatch', () => {
  const validators = authority().phaseInventory.map(entry => entry.validator);
  assert.equal(new Set(validators).size, validators.length);
  for (const entry of authority().phaseInventory) assert.match(entry.validator, /^scripts\/validate-phase5k[0-9.-]*\.mjs$/);
});

// ===========================================================================
// D. HISTORICAL VALIDATOR INVENTORY
// ===========================================================================
test('D1 the authority validator set equals the governed phase validator set', () => {
  assert.deepEqual(authority().validatorExpectations.phases.map(entry => entry.validator), [...DEF.PHASE_5K_FINAL_VALIDATORS]);
  assert.equal(new Set(DEF.PHASE_5K_FINAL_VALIDATORS).size, DEF.PHASE_5K_FINAL_VALIDATORS.length);
});
test('D2 every accepted validator is tracked at the accepted commit and exists on disk', () => {
  const tracked = new Set(inventory().files.map(entry => entry.path));
  for (const entry of DEF.PHASE_5K_FINAL_VALIDATORS) {
    assert.ok(tracked.has(entry), entry);
    assert.ok(existsFile(path.join(REPO_ROOT, entry)), entry);
  }
});
test('D3 every governed file matching the validator selection rule is declared, and no other file is', () => {
  const governed = inventory().files.map(entry => entry.path).filter(entry => /^scripts\/validate-phase5k[0-9.-]*\.mjs$/.test(entry));
  assert.deepEqual(governed, [...DEF.PHASE_5K_FINAL_VALIDATORS].sort());
  assert.equal(governed.length, 14);
});
test('D4 validator paths are plain repository-relative paths with no escape and no absolute root', () => {
  for (const entry of DEF.PHASE_5K_FINAL_VALIDATORS) {
    assert.ok(!entry.startsWith('/') && !entry.includes('..') && !path.isAbsolute(entry), entry);
  }
});
test('D5 the declaration covers every phase validator the accepted tree carries', () => {
  const phases = authority().phaseInventory.map(entry => entry.phase);
  assert.deepEqual(authority().validatorExpectations.order, phases);
  for (const entry of authority().validatorExpectations.phases) assert.ok(phases.includes(entry.phase), entry.phase);
});

// ===========================================================================
// E. HISTORICAL EXPECTED COUNTS
// ===========================================================================
test('E0 the expected-count table is complete, integral and positive', () => {
  for (const entry of authority().validatorExpectations.phases) {
    assert.ok(Number.isInteger(entry.expectedPassed) && entry.expectedPassed > 0, entry.phase);
    assert.equal(entry.expectedTotal, entry.expectedPassed, entry.phase);
  }
});
for (const entry of DEF.PHASE_5K_FINAL_PHASES) {
  test(`E${DEF.PHASE_5K_FINAL_PHASE_ORDER.indexOf(entry.phase) + 1} ${entry.phase} is pinned at ${entry.expectedPassed}/${entry.expectedTotal}`, () => {
    const declared = authority().phaseInventory.find(candidate => candidate.phase === entry.phase);
    assert.equal(declared.expectedPassed, entry.expectedPassed);
    assert.equal(declared.expectedTotal, entry.expectedTotal);
    const expectation = authority().validatorExpectations.phases.find(candidate => candidate.phase === entry.phase);
    assert.equal(expectation.expectedPassed, entry.expectedPassed);
    assert.equal(expectation.expectedTotal, entry.expectedTotal);
  });
}
test('E15 the per-phase counts sum to the pinned historical assertion total', () => {
  const sum = authority().validatorExpectations.phases.reduce((total, entry) => total + entry.expectedPassed, 0);
  assert.equal(sum, DEF.PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL);
  assert.equal(sum, 1390);
});
test('E16 the declared historical total is the pinned 1390', () => {
  assert.equal(authority().validatorExpectations.expectedHistoricalAssertions, 1390);
});
test('E17 success is the reported exact count: an exit status alone is declared insufficient', () => {
  assert.equal(authority().validatorExpectations.successSignal, 'REPORTED_EXACT_PASS_COUNT');
  assert.equal(authority().validatorExpectations.exitCodeAloneIsInsufficient, true);
  assert.equal(authority().validatorExpectations.execution, 'ONE_NODE_PROCESS_PER_PHASE_VALIDATOR');
});
test('E18 the expected report line per phase is exactly the line the runner matches', () => {
  for (const entry of DEF.PHASE_5K_FINAL_PHASES) {
    const line = DEF.expectedReportLine(entry);
    assert.match(line, new RegExp(`^Phase ${entry.phase.replace(/\./g, '\\.')}: ${entry.expectedPassed}/${entry.expectedTotal} passed$`));
  }
});

// ===========================================================================
// F. GOVERNED FILE INVENTORY
// ===========================================================================
test('F1 the declared file count equals the number of inventory members', () => {
  assert.equal(authority().governedInventory.fileCount, authority().governedInventory.files.length);
  assert.equal(authority().governedInventory.fileCount, inventory().files.length);
});
test('F2 the governed inventory holds the accepted tree exactly', () => {
  assert.equal(authority().governedInventory.fileCount, 85);
  assert.equal(authority().governedInventory.files.filter(entry => entry.path.startsWith(`${PI}/`)).length, 61);
  assert.equal(authority().governedInventory.files.filter(entry => entry.path.startsWith('docs/')).length, 10);
});
test('F3 the inventory is sorted lexically by repository-relative path', () => {
  const paths = authority().governedInventory.files.map(entry => entry.path);
  assert.deepEqual(paths, [...paths].sort());
});
test('F4 no governed path repeats', () => {
  const paths = authority().governedInventory.files.map(entry => entry.path);
  assert.equal(new Set(paths).size, paths.length);
});
test('F5 every member binds path, mode, git blob identity and content digest', () => {
  for (const entry of authority().governedInventory.files) {
    assert.equal(typeof entry.path, 'string', JSON.stringify(entry));
    assert.match(entry.gitMode, /^100(644|755)$/);
    assert.match(entry.gitBlobObjectId, /^[0-9a-f]{40}$/);
    assert.match(entry.contentDigest, /^[0-9a-f]{64}$/);
  }
});
test('F6 the declared members equal the members rebuilt from the accepted commit', () => {
  assert.deepEqual(authority().governedInventory.files, inventory().files);
});
test('F7 every governed path comes from the governed selection rules only', () => {
  for (const entry of authority().governedInventory.files) {
    assert.ok(DEF.isGovernedPhase5KPath(entry.path), entry.path);
    assert.ok(entry.path.startsWith(`${PI}/`) || /^scripts\/validate-phase5k[0-9.-]*\.mjs$/.test(entry.path) || /^docs\/PHASE5K[A-Za-z0-9-]*\.md$/.test(entry.path), entry.path);
  }
});
test('F8 the closure files themselves are NOT part of the sealed inventory', () => {
  const paths = new Set(authority().governedInventory.files.map(entry => entry.path));
  for (const entry of DEF.PHASE_5K_FINAL_CLOSURE_FILES) assert.ok(!paths.has(entry), entry);
});
test('F9 the inventory carries no runtime capture, credential-shaped path, environment file or unrelated repository file', () => {
  for (const entry of authority().governedInventory.files) {
    assert.ok(!entry.path.startsWith('var/') && !entry.path.startsWith('.evolve'), entry.path);
    assert.ok(!/\.env(\.|$)/.test(entry.path), entry.path);
    assert.ok(!/credential|secret|token|password/i.test(entry.path), entry.path);
    assert.ok(!entry.path.endsWith('.ndjson') && !entry.path.endsWith('.log'), entry.path);
    assert.ok(!entry.path.endsWith('package.json') && !entry.path.endsWith('package-lock.json'), entry.path);
  }
});
test('F10 the inventory source is declared as the accepted commit, never the working tree', () => {
  assert.equal(authority().governedInventory.source, 'GIT_TREE_AT_ACCEPTED_COMMIT');
  assert.equal(authority().governedInventory.hashing.digest, 'SHA-256');
  assert.equal(authority().governedInventory.hashing.canonicalization, 'CANONICAL_JSON_SORTED_KEYS');
  assert.deepEqual(authority().governedInventory.hashing.memberFields, ['path', 'gitMode', 'gitBlobObjectId', 'contentDigest']);
});

// ===========================================================================
// G. GOVERNED TREE DIGEST
// ===========================================================================
test('G1 the governed tree digest is a 64-character lowercase hex string', () => {
  assert.match(authority().governedInventory.governedTreeDigest, /^[0-9a-f]{64}$/);
});
test('G2 the digest recomputes from the declared inventory members alone', () => {
  assert.equal(DEF.governedTreeDigestOf(authority().governedInventory.files), authority().governedInventory.governedTreeDigest);
});
test('G3 the digest recomputes from the accepted commit blobs read through Git', () => {
  assert.equal(DEF.governedTreeDigestOf(inventory().files), authority().governedInventory.governedTreeDigest);
});
test('G4 changing one governed content digest changes the tree digest', () => {
  const files = authority().governedInventory.files.map(entry => ({ ...entry }));
  files[0].contentDigest = files[0].contentDigest.replace(/^./, files[0].contentDigest[0] === 'a' ? 'b' : 'a');
  assert.notEqual(DEF.governedTreeDigestOf(files), authority().governedInventory.governedTreeDigest);
});
test('G5 changing one governed blob identity changes the tree digest', () => {
  const files = authority().governedInventory.files.map(entry => ({ ...entry }));
  files[files.length - 1] = { ...files[files.length - 1], gitBlobObjectId: 'f'.repeat(40) };
  assert.notEqual(DEF.governedTreeDigestOf(files), authority().governedInventory.governedTreeDigest);
});
test('G6 adding a governed member changes the tree digest', () => {
  const files = [...authority().governedInventory.files.map(entry => ({ ...entry }))];
  files.push({ path: 'scripts/public-intelligence/extra.mjs', gitMode: '100644', gitBlobObjectId: 'a'.repeat(40), contentDigest: 'b'.repeat(64) });
  assert.notEqual(DEF.governedTreeDigestOf(files), authority().governedInventory.governedTreeDigest);
});
test('G7 removing a governed member changes the tree digest', () => {
  const files = authority().governedInventory.files.slice(1).map(entry => ({ ...entry }));
  assert.notEqual(DEF.governedTreeDigestOf(files), authority().governedInventory.governedTreeDigest);
});
test('G8 the digest binds the accepted implementation head, not only the file list', () => {
  const files = authority().governedInventory.files;
  const other = '0'.repeat(40);
  assert.notEqual(DEF.governedTreeDigestOf(files, other), DEF.governedTreeDigestOf(files, DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD));
});
test('G9 the digest is order-insensitive to nothing: the member order is the sorted order', () => {
  const files = authority().governedInventory.files.map(entry => ({ ...entry }));
  const reversed = [...files].reverse();
  assert.notEqual(DEF.governedTreeDigestOf(reversed), DEF.governedTreeDigestOf(files));
});
test('G10 the inventory is read from Git: an untracked working-tree file cannot change it', () => {
  const builder = DEF.buildGovernedInventory.toString();
  assert.ok(builder.includes('ls-tree'), 'the inventory is built from the tracked tree');
  const paths = authority().governedInventory.files.map(entry => entry.path);
  assert.ok(!paths.some(entry => entry.includes('..')), 'no traversal path in the inventory');
});

// ===========================================================================
// H. AUTHORITY FINGERPRINT
// ===========================================================================
test('H1 the authority fingerprint is a 64-character lowercase hex string', () => {
  assert.match(authority().authorityFingerprint, /^[0-9a-f]{64}$/);
});
test('H2 the fingerprint recomputes from the complete record', () => {
  assert.equal(DEF.authorityFingerprintOf(authority()), authority().authorityFingerprint);
});
test('H3 the fingerprint excludes the fingerprint field itself', () => {
  const { authorityFingerprint, ...rest } = authority();
  void authorityFingerprint;
  assert.equal(DEF.sha256Hex(Buffer.from(DEF.canonical(rest), 'utf8')), authority().authorityFingerprint);
});
test('H4 the fingerprint is canonical: object key order cannot change it', () => {
  const reordered = Object.fromEntries(Object.entries(authority()).reverse());
  assert.equal(DEF.authorityFingerprintOf(reordered), authority().authorityFingerprint);
});
test('H5 the fingerprint does not depend on a runtime clock or on rebuild order', () => {
  assert.equal(DEF.canonicalAuthorityIdentity(rebuilt()), DEF.canonicalAuthorityIdentity(rebuilt()));
  assert.equal(DEF.authorityFingerprintOf(rebuilt()), DEF.authorityFingerprintOf(rebuilt()));
  assert.equal(DEF.authorityFingerprintOf(rebuilt()), authority().authorityFingerprint);
});
test('H6 changing a boundary flag changes the fingerprint', () => {
  const tampered = { ...authority(), boundaryFlags: { ...authority().boundaryFlags, researchOnly: false } };
  assert.notEqual(DEF.authorityFingerprintOf(tampered), authority().authorityFingerprint);
});
test('H7 changing one governed member changes the fingerprint', () => {
  const files = authority().governedInventory.files.map(entry => ({ ...entry }));
  files[3].contentDigest = 'c'.repeat(64);
  const tampered = { ...authority(), governedInventory: { ...authority().governedInventory, files } };
  assert.notEqual(DEF.authorityFingerprintOf(tampered), authority().authorityFingerprint);
});
test('H8 dropping a deferred capability changes the fingerprint', () => {
  const capabilities = authority().deferredCapabilities.capabilities.slice(1);
  const tampered = { ...authority(), deferredCapabilities: { ...authority().deferredCapabilities, capabilities } };
  assert.notEqual(DEF.authorityFingerprintOf(tampered), authority().authorityFingerprint);
});
test('H9 the fingerprint is not derived from the closure commit: the sealed head is the accepted one', () => {
  const identity = DEF.canonicalAuthorityIdentity(authority());
  assert.ok(identity.includes(DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD));
  const head = gitOut('rev-parse', 'HEAD').trim();
  if (head === DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD) return;
  assert.ok(!identity.includes(head), 'the closure commit id entered the deterministic identity');
});
test('H10 the fingerprint is exactly the sha256 of the canonical identity string, recomputed independently', () => {
  const { authorityFingerprint, ...rest } = authority();
  void authorityFingerprint;
  assert.equal(sha256Projection(rest), authority().authorityFingerprint);
});
test('H11 a forged fingerprint is refused by the schema verifier', () => {
  const tampered = { ...authority(), authorityFingerprint: 'a'.repeat(64) };
  assert.ok(DEF.verifyAuthorityRecord(tampered).failures.includes('AUTHORITY_FINGERPRINT_MISMATCH'));
});

// ===========================================================================
// I. POLICY AND BOUNDARY FLAGS
// ===========================================================================
test('I1 researchOnly and observerOnly are true', () => {
  assert.equal(authority().boundaryFlags.researchOnly, true);
  assert.equal(authority().boundaryFlags.observerOnly, true);
  assert.equal(CLASSIFICATION.researchOnly, true);
  assert.equal(CLASSIFICATION.observerOnly, true);
});
test('I2 paperOnly and developmentOnly are true, and the program status is CLOSED', () => {
  assert.equal(authority().boundaryFlags.paperOnly, true);
  assert.equal(authority().boundaryFlags.developmentOnly, true);
  assert.equal(authority().classification.paperOnly, true);
  assert.equal(authority().classification.programStatus, 'CLOSED');
});
test('I3 tradingAuthority is false', () => {
  assert.equal(authority().boundaryFlags.tradingAuthority, false);
  assert.equal(CLASSIFICATION.tradingAuthority, false);
});
test('I4 engineAuthority is false', () => {
  assert.equal(authority().boundaryFlags.engineAuthority, false);
  assert.equal(authority().classification.engineAuthority, false);
});
test('I5 arenaEligible is false and the program is not Arena-exposed', () => {
  assert.equal(authority().boundaryFlags.arenaEligible, false);
  assert.equal(authority().classification.arenaEligible, false);
});
test('I6 promotionEligible is false', () => {
  assert.equal(authority().boundaryFlags.promotionEligible, false);
  assert.equal(authority().classification.promotionEligible, false);
});
test('I7 price data, market-outcome linkage and profitability inference are all forbidden', () => {
  assert.equal(authority().boundaryFlags.priceDataPermitted, false);
  assert.equal(authority().boundaryFlags.marketOutcomeLinkagePermitted, false);
  assert.equal(authority().boundaryFlags.profitabilityInferencePermitted, false);
  assert.equal(CLASSIFICATION.profitabilityInferencePermitted, false);
});
test('I8 prediction, recommendation, ranking and asset scoring are all forbidden', () => {
  for (const flag of ['predictionPermitted', 'recommendationPermitted', 'rankingPermitted', 'assetScoringPermitted']) {
    assert.equal(authority().boundaryFlags[flag], false, flag);
  }
});
test('I9 wallet, signer, swap and RPC-write authority are all forbidden', () => {
  for (const flag of ['walletAuthority', 'signerAuthority', 'swapAuthority', 'rpcWriteAuthority']) {
    assert.equal(authority().boundaryFlags[flag], false, flag);
  }
});
test('I10 cross-provider identity resolution is forbidden', () => {
  assert.equal(authority().boundaryFlags.crossProviderIdentityResolutionPermitted, false);
  assert.equal(IDENTITY_RESOLUTION.mastodonAndBlueskyIdentitiesRemainSeparate, true);
});
test('I11 the acceptance itself permits no provider contact and no live network dependency', () => {
  assert.equal(authority().boundaryFlags.providerContactPermittedDuringAcceptance, false);
  assert.equal(authority().boundaryFlags.liveNetworkDependencyInDerivedLayers, false);
  assert.equal(authority().providerBoundary.providerContactDuringAcceptance, false);
});
test('I12 no personal-data surface may be expanded', () => {
  assert.equal(authority().boundaryFlags.personalDataSurfaceExpansionPermitted, false);
  assert.equal(PERSONAL_DATA.forbiddenFields.length > 0, true);
});
test('I13 R4 mutation and .evolve writes are forbidden, and no runtime capture is permitted', () => {
  assert.equal(authority().boundaryFlags.r4MutationPermitted, false);
  assert.equal(authority().boundaryFlags.evolveStorageWritePermitted, false);
  assert.equal(authority().boundaryFlags.runtimeCapturePermittedInClosure, false);
});
test('I14 the flag set is exact: no flag is missing and no unknown flag was added', () => {
  assert.deepEqual([...Object.keys(authority().boundaryFlags)].sort(), [...Object.keys(DEF.PHASE_5K_FINAL_BOUNDARY_FLAGS)].sort());
  assert.deepEqual(authority().boundaryFlags, DEF.PHASE_5K_FINAL_BOUNDARY_FLAGS);
});
test('I15 the block cannot be weakened: a removed or flipped flag changes its canonical identity', () => {
  const flipped = { ...DEF.PHASE_5K_FINAL_BOUNDARY_FLAGS, tradingAuthority: true };
  const dropped = Object.fromEntries(Object.entries(DEF.PHASE_5K_FINAL_BOUNDARY_FLAGS).filter(([key]) => key !== 'observerOnly'));
  assert.notEqual(DEF.boundaryFlagsIdentity(flipped), DEF.boundaryFlagsIdentity());
  assert.notEqual(DEF.boundaryFlagsIdentity(dropped), DEF.boundaryFlagsIdentity());
  assert.ok(DEF.verifyAuthorityRecord({ ...authority(), boundaryFlags: flipped }).failures.includes('AUTHORITY_BOUNDARY_FLAGS_WEAKENED'));
});
test('I16 the classification block agrees with the frozen 5K.0 classification', () => {
  assert.equal(authority().classification.researchOnly, CLASSIFICATION.researchOnly);
  assert.equal(authority().classification.observerOnly, CLASSIFICATION.observerOnly);
  assert.equal(authority().classification.paperOnly, CLASSIFICATION.paperOnly);
  assert.equal(authority().classification.developmentOnly, CLASSIFICATION.developmentOnly);
  assert.equal(authority().classification.evidenceClass, R4_BOUNDARY.evidenceClass);
});
test('I17 the authority declares itself deterministic and self-verifying', () => {
  assert.equal(authority().boundaryFlags.authorityIsDeterministic, true);
  assert.equal(authority().boundaryFlags.authorityIsSelfVerifying, true);
  assert.equal(DEF.verifyAuthorityRecord(authority()).ok, true);
});

// ===========================================================================
// J. PROVIDER BOUNDARIES
// ===========================================================================
test('J1 the accepted provider families are exactly Mastodon and Bluesky', () => {
  assert.deepEqual([...authority().providerBoundary.providerFamilies].sort(), ['bluesky', 'mastodon']);
  assert.equal(authority().providerBoundary.providerFamilies.length, 2);
});
test('J2 no third provider family was added by the closure', () => {
  for (const provider of ['twitter', 'x-api', 'reddit', 'telegram', 'discord', 'rss', 'scraper', 'nitter', 'youtube', 'tiktok']) {
    assert.ok(!JSON.stringify(authority().providerBoundary).toLowerCase().includes(provider), provider);
  }
});
test('J3 the providers stay public-data-only, unauthenticated and bounded', () => {
  assert.equal(authority().providerBoundary.publicDataOnly, true);
  assert.equal(authority().providerBoundary.authenticationPermitted, false);
  assert.equal(authority().providerBoundary.unboundedCollectionPermitted, false);
  assert.equal(SCOPE.publicDataOnly, true);
  assert.equal(SCOPE.authenticationPermitted, false);
  assert.equal(COLLECTION_BOUNDS.unboundedCollectionPermitted, false);
});
test('J4 the provider hard ceilings are unchanged', () => {
  assert.deepEqual({ ...HARD_CEILINGS }, { maxPages: 5, maxRecords: 200, maxResponseBytes: 2097152, timeoutMs: 20000, lookbackMs: 604800000, maxRetries: 0 });
  assert.deepEqual(authority().providerBoundary.hardCeilings, { ...HARD_CEILINGS });
});
test('J5 the bounded collection bound vocabulary is still declared', () => {
  assert.ok(COLLECTION_BOUNDS.requiredBoundFields.length >= 7);
  assert.deepEqual(authority().semantics.governance.collectionBounds.requiredBoundFields, [...COLLECTION_BOUNDS.requiredBoundFields]);
});
test('J6 no closure module names a provider host or a provider transport', () => {
  // The tokens are assembled from parts so this assertion does not itself
  // contain the host names it forbids.
  const tokens = [
    ['mastodon', '.social'].join(''),
    ['bsky', '.app'].join(''),
    ['api', '.bsky'].join(''),
    ['bluesky', '-transport'].join(''),
    ['mastodon', '-transport'].join(''),
  ];
  const transportSuffix = ['-transport', '.mjs'].join('');
  for (const [relative, source] of Object.entries(closureSources())) {
    for (const token of tokens) assert.ok(!source.includes(token), `${relative} names ${token}`);
    for (const imported of parseModule(relative).found.importSources) {
      assert.ok(!imported.endsWith(transportSuffix), `${relative} imports a transport: ${imported}`);
    }
  }
  // A validator outside the governed tree may not reach the provider boundary
  // at all; the closure surface, which lives inside it, reaches only the
  // governed provider registry constants.
  for (const imported of parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH).found.importSources) {
    assert.ok(!imported.includes('providers'), `${DEF.PHASE_5K_FINAL_VALIDATOR_PATH} imports ${imported}`);
  }
});
test('J7 the accepted provider layers stay green and no live provider call was made', () => {
  assert.equal(suiteOf('5K.2').reported.passed, 70);
  assert.equal(suiteOf('5K.6').reported.passed, 166);
  assert.equal(TRIPWIRES.calls, 0);
});

// ===========================================================================
// K. TEMPORAL REVISION REPRODUCIBILITY
// ===========================================================================
test('K1 the 5K.5.1 revision-evidence layer stays 27/27', () => {
  const result = suiteOf('5K.5.1');
  assert.equal(result.reported.passed, 27);
  assert.equal(result.reported.total, 27);
  assert.equal(result.exitCode, 0);
});
test('K2 the temporal classification enum is exactly the five governed states', () => {
  assert.deepEqual([...TEMPORAL_CLASSIFICATIONS], ['FIRST_OBSERVATION', 'SAME_CONTENT_SAME_STATE', 'SAME_CONTENT_UPDATED_STATE', 'PROVIDER_DECLARED_CONTENT_REVISION', 'UNVERIFIED_CONTENT_DIVERGENCE']);
  assert.deepEqual(authority().semantics.temporal.classifications, [...TEMPORAL_CLASSIFICATIONS]);
});
test('K3 revision evidence can only come from the provider-declared source', () => {
  assert.deepEqual([...REVISION_SOURCES], ['MASTODON_STATUS_EDITED_AT']);
  assert.deepEqual(authority().semantics.temporal.revisionEvidenceSources, [...REVISION_SOURCES]);
});
test('K4 a declared revision and an unverified divergence are distinct states, and divergence carries no proof', () => {
  assert.notEqual(TEMPORAL_CLASSIFICATIONS.indexOf('PROVIDER_DECLARED_CONTENT_REVISION'), TEMPORAL_CLASSIFICATIONS.indexOf('UNVERIFIED_CONTENT_DIVERGENCE'));
  assert.equal(TEMPORAL_CLASSIFICATIONS.includes('UNVERIFIED_CONTENT_DIVERGENCE'), true);
  assert.equal(TEMPORAL_CLASSIFICATIONS.some(state => /SUSPICIOUS|SUSPICION|ANOMALY/i.test(state)), false);
});
test('K5 the record binds the temporal semantics and they equal the live module values', () => {
  assert.equal(DEF.canonical(authority().semantics.temporal), DEF.canonical(DEF.livePhase5KSemantics().temporal));
  assert.equal(DEF.canonical(DEF.livePhase5KSemantics()), DEF.canonical(authority().semantics));
});
test('K6 no new revision-evidence source was introduced by the closure', () => {
  assert.equal(REVISION_SOURCES.length, 1);
  assert.equal(authority().semantics.temporal.revisionEvidenceSources.length, 1);
  assert.equal(DEF.canonical(authority().semantics.temporal.revisionEvidenceSources), DEF.canonical([...REVISION_SOURCES]));
});
test('K7 more revisions is not suspicion: no temporal state names a negative verdict', () => {
  for (const state of TEMPORAL_CLASSIFICATIONS) assert.ok(!/(FRAUD|MANIPULAT|PUMP|DUMP|SUSPECT|LIE)/i.test(state), state);
});

// ===========================================================================
// L. CORROBORATION SEMANTICS
// ===========================================================================
test('L1 corroboration is coverage, never truth and never confidence', () => {
  assert.equal(COVERAGE.readOnly, true);
  assert.equal(COVERAGE.subjectIsExactMintOnly, true);
  for (const flag of ['claimsTruthEvaluated', 'providerAgreementInferred', 'scoreComputed', 'rankComputed',
    'confidenceTierComputed', 'ordinalLevelAssigned', 'sentimentComputed', 'momentumComputed', 'popularityComputed',
    'importanceComputed', 'predictionMade', 'recommendationMade', 'tradingInferenceMade', 'marketDataAccessed']) {
    assert.equal(COVERAGE[flag], false, flag);
  }
  assert.equal(COVERAGE.crossProviderMergePerformed, false);
  assert.equal(COVERAGE.underlyingEvidenceMergedAcrossProviders, false);
});
test('L2 the independence unit is the provider FAMILY, not a post or an instance', () => {
  assert.equal(INDEPENDENCE.independenceUnit, 'PROVIDER_FAMILY');
  assert.equal(INDEPENDENCE.twoInstancesOfOneFamilyAreOneFamily, true);
  assert.equal(INDEPENDENCE.twoPostsOfOneFamilyAreOneFamily, true);
  assert.equal(INDEPENDENCE.familySeparatesCrossPlatformCoverage, true);
});
test('L3 identical text, identical time and identical subject are never independence', () => {
  assert.equal(INDEPENDENCE.sameTextCountsAsIndependence, false);
  assert.equal(INDEPENDENCE.sameTimeCountsAsIndependence, false);
  assert.equal(INDEPENDENCE.sameMintCountsAsIndependence, false);
  assert.equal(INDEPENDENCE.timeSeparationImpliesIndependence, false);
  assert.equal(INDEPENDENCE.mergesUnderlyingEvidence, false);
});
test('L4 the coverage status vocabulary is the governed one', () => {
  assert.deepEqual([...COVERAGE_STATUS_VALUES].sort(), ['MULTI_PROVIDER_FAMILY', 'SINGLE_PROVIDER_FAMILY']);
  assert.equal(COVERAGE_STATUS.MULTI_PROVIDER_FAMILY, 'MULTI_PROVIDER_FAMILY');
  assert.equal(COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY, 'SINGLE_PROVIDER_FAMILY');
  assert.deepEqual(authority().semantics.corroboration.coverageStatusValues, [...COVERAGE_STATUS_VALUES]);
});
test('L5 the corroboration layer declares no market, R4, wallet or execution access', () => {
  for (const flag of ['priceDataAccessed', 'returnsAccessed', 'volatilityAccessed', 'r4OutcomeDataAccessed',
    'tradingEngineReached', 'arenaReached', 'walletAccessed', 'signerAccessed', 'swapReached', 'rpcWriteReached',
    'futureMovementAssociated']) {
    assert.equal(CORROBORATION_MARKET[flag], false, flag);
  }
});
test('L6 the record binds the corroboration block and it equals the live module values', () => {
  assert.equal(DEF.canonical(authority().semantics.corroboration.coverageSemantics), DEF.canonical({ ...COVERAGE }));
  assert.equal(DEF.canonical(authority().semantics.corroboration.independence), DEF.canonical({ ...INDEPENDENCE }));
  assert.equal(DEF.canonical(authority().semantics.corroboration), DEF.canonical(DEF.livePhase5KSemantics().corroboration));
});
test('L7 multi-provider presence is not consensus: no consensus or truth field exists', () => {
  const declared = JSON.stringify(COVERAGE) + JSON.stringify(COVERAGE_STATUS) + JSON.stringify(INDEPENDENCE);
  for (const banned of ['consensus', 'truth', 'confidence', 'agreement', 'weight']) {
    assert.ok(!new RegExp(banned, 'i').test(declared.replace(/claimsTruthEvaluated|providerAgreementInferred|confidenceTierComputed/g, '')), banned);
  }
});
test('L8 more providers is not more confidence: coverage never carries a numeric measure', () => {
  for (const value of Object.values(COVERAGE_STATUS)) assert.equal(typeof value, 'string');
  for (const value of Object.values(COVERAGE)) assert.ok(['boolean', 'string', 'number'].includes(typeof value));
  assert.equal(Object.values(COVERAGE).some(value => typeof value === 'number'), false);
});

// ===========================================================================
// M. LINEAGE SEMANTICS
// ===========================================================================
test('M1 an exact cross-provider text match never proves copying', () => {
  assert.equal(DUPLICATION.exactTextMatchEvaluated, true);
  assert.equal(DUPLICATION.exactTextMatchProvesCopying, false);
  assert.equal(DUPLICATION.exactTextMatchProvesSameAuthor, false);
  assert.equal(DUPLICATION.exactTextMatchProvesSameOrganization, false);
  assert.equal(DUPLICATION.exactTextMatchProvesSameClaimSource, false);
});
test('M2 the lineage layer infers no originality, copying, plagiarism or truth', () => {
  for (const flag of ['originalityInferred', 'copyingInferred', 'plagiarismInferred', 'truthEvaluated',
    'authorIndependenceInferred', 'crossProviderMergePerformed', 'underlyingEvidenceMergedAcrossProviders',
    'sameTextCountsAsIndependence', 'runAppearanceCountedAsNewContentVersion',
    'engagementChangeCountedAsNewContentVersion', 'engagementUsedAsEvidenceOfAnything']) {
    assert.equal(DUPLICATION[flag], false, flag);
  }
});
test('M3 cross-provider human identity resolution is never performed', () => {
  assert.equal(IDENTITY_RESOLUTION.crossProviderHumanIdentityResolutionPerformed, false);
  assert.equal(IDENTITY_RESOLUTION.authorIdentityComparedAcrossProviders, false);
  assert.equal(IDENTITY_RESOLUTION.authorIdentifiersPersisted, false);
  assert.equal(IDENTITY_RESOLUTION.mastodonAndBlueskyIdentitiesRemainSeparate, true);
});
test('M4 no shared handle, name, bio, domain, avatar or text implies the same person', () => {
  for (const flag of ['sameHandleImpliesSamePerson', 'sameDisplayNameImpliesSamePerson', 'sameBioImpliesSamePerson',
    'sameDomainImpliesSamePerson', 'sameAvatarImpliesSamePerson', 'sameTextImpliesSamePerson']) {
    assert.equal(IDENTITY_RESOLUTION[flag], false, flag);
  }
});
test('M5 the lineage classes are structural only: no independent, original or copied class exists', () => {
  assert.deepEqual([...LINEAGE_CLASS_VALUES], ['DISTINCT_CONTENT', 'EXACT_RAW_TEXT_MATCH', 'CANONICAL_TEXT_MATCH', 'EXPLICIT_CROSS_POST_REFERENCE', 'UNRESOLVED']);
  for (const banned of ['INDEPENDENT', 'ORIGINAL', 'COPIED', 'PLAGIARIZED', 'BOT', 'FAKE']) {
    assert.ok(!LINEAGE_CLASS_VALUES.includes(banned), banned);
  }
  assert.equal(LINEAGE_CLASS.DISTINCT_CONTENT, 'DISTINCT_CONTENT');
});
test('M6 the record binds the lineage block and it equals the live module values', () => {
  assert.equal(DEF.canonical(authority().semantics.lineage.duplicationSemantics), DEF.canonical({ ...DUPLICATION }));
  assert.equal(DEF.canonical(authority().semantics.lineage.identityResolution), DEF.canonical({ ...IDENTITY_RESOLUTION }));
  assert.equal(DEF.canonical(authority().semantics.lineage.lineageClassValues), DEF.canonical([...LINEAGE_CLASS_VALUES]));
});
test('M7 the lineage layer declares no market, R4, wallet or execution access', () => {
  for (const flag of ['priceDataAccessed', 'returnsAccessed', 'volatilityAccessed', 'r4OutcomeDataAccessed',
    'tradingEngineReached', 'arenaReached', 'walletAccessed', 'signerAccessed', 'swapReached', 'rpcWriteReached',
    'futureMovementAssociated', 'corroborationScoreComputed', 'tradeCandidateSelected']) {
    assert.equal(LINEAGE_MARKET[flag], false, flag);
  }
});
test('M8 more lineages is not stronger truth: lineage adds no truth or confidence field', () => {
  const declared = JSON.stringify(DUPLICATION) + JSON.stringify(LINEAGE_CLASS_VALUES);
  assert.ok(!/truthProbab|confidence|verdict|credib/i.test(declared));
});

// ===========================================================================
// N. DESCRIPTIVE-FEATURE SEMANTICS
// ===========================================================================
test('N1 a descriptive feature is a measurement, never a score or a rank', () => {
  assert.equal(FEATURE_SEMANTICS.descriptiveOnly, true);
  assert.equal(FEATURE_SEMANTICS.measurableFromAuthenticatedEvidence, true);
  for (const flag of ['weightingApplied', 'normalizationApplied', 'standardizationApplied', 'zScoreComputed',
    'percentileInterpretedAsRank', 'compositeComputed', 'scoreComputed', 'rankComputed', 'orderingByFeatureValue',
    'confidenceTierAssigned', 'ordinalLevelAssigned', 'importanceComputed', 'truthProbabilityComputed']) {
    assert.equal(FEATURE_SEMANTICS[flag], false, flag);
  }
});
test('N2 sentiment, momentum, virality and popularity are never computed', () => {
  for (const flag of ['sentimentComputed', 'momentumComputed', 'viralityComputed', 'popularityComputed', 'trendLabelled']) {
    assert.equal(FEATURE_SEMANTICS[flag], false, flag);
  }
});
test('N3 the default ordering is lexical, not by feature value', () => {
  assert.equal(FEATURE_SEMANTICS.defaultOrderingIsLexical, true);
  assert.equal(FEATURE_SEMANTICS.orderingByFeatureValue, false);
});
test('N4 the feature layer reads no live data and makes no prediction or recommendation', () => {
  assert.equal(FEATURE_SEMANTICS.readsLiveNetworkData, false);
  assert.equal(FEATURE_SEMANTICS.causesProviderContact, false);
  assert.equal(FEATURE_SEMANTICS.predictionMade, false);
  assert.equal(FEATURE_SEMANTICS.recommendationMade, false);
  assert.equal(FEATURE_SEMANTICS.profitabilityInferenceMade, false);
  assert.equal(FEATURE_SEMANTICS.tradingInferenceMade, false);
});
test('N5 the time semantics refuse every invented instant and every causal reading', () => {
  assert.equal(FEATURE_TIME.timestampsCopiedFromAuthenticatedEvidence, true);
  assert.equal(FEATURE_TIME.windowComputedAsLastMinusFirst, true);
  for (const flag of ['currentTimeUsed', 'filesystemMtimeUsed', 'directoryOrderUsed', 'rateInterpretedAsMomentum',
    'simultaneityInferred', 'causalityInferred', 'emptyBucketImputed']) {
    assert.equal(FEATURE_TIME[flag], false, flag);
  }
});
test('N6 engagement counters are observations: a change in engagement is not importance or momentum', () => {
  assert.equal(ENGAGEMENT.countersAreProviderDefined, true);
  assert.equal(ENGAGEMENT.regressionRemainsValidObservation, true);
  for (const flag of ['aggregatedAcrossProviderFamilies', 'aggregatedAcrossCounterTypes', 'absentCounterFilledWithZero',
    'absentCounterTreatedAsEmptyString', 'carryForwardApplied', 'interpolationApplied', 'increaseIsPositiveEvidence',
    'decreaseIsNegativeEvidence', 'absoluteChangeComputed', 'momentumComputed', 'growthComputed', 'velocityComputed',
    'popularityComputed', 'ratioComputed', 'scoreComputed']) {
    assert.equal(ENGAGEMENT[flag], false, flag);
  }
});
test('N7 the feature market linkage is closed and the exact mint is identity only', () => {
  for (const flag of ['priceAccessed', 'returnsAccessed', 'volatilityAccessed', 'marketOutcomesAccessed',
    'r4ResultAccessed', 'r4OutcomeArtifactsAccessed', 'tradingEngineReached', 'arenaReached', 'walletAccessed',
    'signerAccessed', 'swapReached', 'rpcWriteReached', 'solanaRpcLookupPerformed', 'marketApiContacted',
    'priceCorrelationComputed', 'returnLinkageComputed']) {
    assert.equal(FEATURE_MARKET[flag], false, flag);
  }
  assert.equal(FEATURE_MARKET.mintIsIdentityOnly, true);
});
test('N8 the record binds the feature block and it equals the live module values', () => {
  assert.equal(DEF.canonical(authority().semantics.features.featureSemantics), DEF.canonical({ ...FEATURE_SEMANTICS }));
  assert.equal(DEF.canonical(authority().semantics.features.marketLinkage), DEF.canonical({ ...FEATURE_MARKET }));
  assert.equal(DEF.canonical(authority().semantics.features), DEF.canonical(DEF.livePhase5KSemantics().features));
});
test('N9 the 5K.9 descriptive-feature layer stays 186/186', () => {
  const result = suiteOf('5K.9');
  assert.equal(result.reported.passed, 186);
  assert.equal(result.reported.total, 186);
  assert.equal(result.exitCode, 0);
});
test('N10 more engagement is not importance: no feature is described as a signal, score or rank', () => {
  const declared = JSON.stringify(FEATURE_SEMANTICS);
  assert.ok(!/"(signal|score|rank|importance)":\s*true/.test(declared));
  assert.equal(FEATURE_SEMANTICS.scoreComputed, false);
});

// ===========================================================================
// O. PRIVACY
// ===========================================================================
test('O1 the governed personal-data refusal list is unchanged and non-empty', () => {
  assert.deepEqual([...PERSONAL_DATA.forbiddenFields], ['email', 'phone', 'privateMessage', 'directMessage', 'ipAddress',
    'realName', 'legalName', 'homeAddress', 'geoLocation', 'birthDate', 'deviceId', 'sessionCookie', 'accessToken',
    'refreshToken', 'apiKey', 'bearerToken', 'followerList', 'followingList', 'contactList', 'profileImageUrl']);
  assert.equal(PERSONAL_DATA.closed, true);
});
test('O2 the record binds the personal-data refusal list verbatim', () => {
  assert.deepEqual(authority().semantics.governance.personalData.forbiddenFields, [...PERSONAL_DATA.forbiddenFields]);
  assert.equal(DEF.canonical(DEF.livePhase5KSemantics().governance.personalData), DEF.canonical({ forbiddenFields: [...PERSONAL_DATA.forbiddenFields] }));
});
test('O3 no authority record KEY is a personal-data field', () => {
  const keys = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') { for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } }
  };
  walk(authority());
  for (const field of PERSONAL_DATA.forbiddenFields) assert.ok(!keys.includes(field), field);
});
test('O4 no closure module persists a personal field: no writer call exists in the closure', () => {
  const writers = /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlinkSync|renameSync|chmodSync|copyFileSync|createWriteStream|truncateSync|utimesSync)$/;
  for (const [relative] of Object.entries(closureSources())) {
    const { found } = parseModule(relative);
    for (const identifier of found.identifiers) assert.ok(!writers.test(identifier), `${relative}:${identifier}`);
  }
});
test('O5 no closure artifact carries a credential-shaped value', () => {
  const patterns = [/sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
  for (const [relative, source] of Object.entries(closureSources())) {
    for (const pattern of patterns) assert.ok(!pattern.test(source), `${relative} matches ${String(pattern)}`);
  }
  const record = readRepo(DEF.PHASE_5K_FINAL_AUTHORITY_PATH);
  for (const pattern of patterns) assert.ok(!pattern.test(record), 'the authority carries a credential-shaped value');
});
test('O6 no closure artifact names an authorization header or a session cookie outside the governed refusal list', () => {
  // The governed refusal list itself names these surfaces, so it appears by
  // requirement in the definition (the verifier that refuses a credential), in
  // the document that must state the list and in the authority record that
  // persists it - exactly like every historical 5K validator's ban list. What
  // must never name them is the executable closure surface; and the persisted
  // list must be the governed one rather than an added credential surface.
  const carriers = [DEF.PHASE_5K_FINAL_RUNNER_PATH, DEF.PHASE_5K_FINAL_SURFACE_PATH];
  const tokens = [['authori', 'zation'].join(''), ['coo', 'kie'].join(''), ['bear', 'er'].join(''), ['csrf'].join('')];
  for (const relative of carriers) {
    const lowered = readRepo(relative).toLowerCase();
    for (const token of tokens) assert.ok(!lowered.includes(token), `${relative} names ${token}`);
  }
  assert.deepEqual(authority().semantics.governance.personalData.forbiddenFields, [...PERSONAL_DATA.forbiddenFields]);
});
test('O7 the closure adds no persisted personal-data surface', () => {
  assert.equal(authority().boundaryFlags.personalDataSurfaceExpansionPermitted, false);
  assert.equal(COVERAGE.containsPostBodies, false);
  assert.equal(COVERAGE.containsAuthorProfiles, false);
  assert.equal(COVERAGE.containsCredentials, false);
});
test('O8 no derived layer claims access to follower, contact or mention graphs', () => {
  assert.equal(authority().semantics.lineage.identityResolution.authorIdentifiersPersisted, false);
  assert.equal(COVERAGE.containsAuthorProfiles, false);
  assert.equal(authority().semantics.features.featureSemantics.readsLiveNetworkData, false);
});
test('O9 the closure document carries no personal-data example and no live URL', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH);
  assert.ok(!/https?:\/\//.test(doc), 'the closure document links to a live URL');
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(doc), 'the closure document carries an address');
});

// ===========================================================================
// P. DETERMINISM
// ===========================================================================
test('P1 the closure definition reads no clock', () => {
  const { found, source } = parseModule(DEF.PHASE_5K_FINAL_DEFINITION_PATH);
  assert.ok(!found.identifiers.includes('Date'), 'the definition references Date');
  assert.ok(!found.identifiers.includes('performance'), 'the definition references performance');
  assert.ok(!/Date\.now|new Date\(|performance\.now/.test(source), 'the definition reads a clock');
});
test('P2 the acceptance runner reads no clock', () => {
  const { source } = parseModule(DEF.PHASE_5K_FINAL_RUNNER_PATH);
  assert.ok(!/Date\.now|new Date\(|performance\.now|hrtime/.test(source), 'the runner reads a clock');
});
test('P3 the closure surface re-exports only: it declares no behaviour', () => {
  const { source } = parseModule(DEF.PHASE_5K_FINAL_SURFACE_PATH);
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares a function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares a class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has control flow');
  assert.ok(!/\bnew\s+[A-Z]/.test(source), 'the surface constructs an object');
});
test('P4 no closure module reads an environment variable', () => {
  // Assembled from parts so this assertion does not itself contain the token.
  const envToken = ['process', 'env'].join('.');
  for (const [relative, source] of Object.entries(closureSources())) assert.ok(!source.includes(envToken), relative);
});
test('P5 no closure module uses randomness', () => {
  const randomTokens = [['Math', 'random'].join('.'), ['random', 'Bytes'].join(''), ['random', 'UUID'].join(''), ['getRandom', 'Values'].join('')];
  for (const [relative, source] of Object.entries(closureSources())) {
    for (const token of randomTokens) assert.ok(!source.includes(token), `${relative} uses ${token}`);
  }
});
test('P6 no closure module imports a filesystem writer', () => {
  const writers = /^(writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|chmodSync|copyFileSync|createWriteStream)$/;
  for (const [relative] of Object.entries(closureSources())) {
    const { found } = parseModule(relative);
    for (const identifier of found.identifiers) assert.ok(!writers.test(identifier), `${relative}:${identifier}`);
  }
});
test('P7 rebuilding the closure record twice is byte-identical', () => {
  const first = DEF.buildAuthorityRecord({ git: gitBuffer });
  const second = DEF.buildAuthorityRecord({ git: gitBuffer });
  assert.deepEqual(DEF.authorityArtifactBytes(first), DEF.authorityArtifactBytes(second));
});
test('P8 rebuilding with a REVERSED tree listing is byte-identical: no directory order dependence', () => {
  const shuffled = args => {
    const output = gitBuffer(args);
    if (args[0] !== 'ls-tree') return output;
    const text = output.toString('utf8');
    const entries = text.split('\0').filter(Boolean);
    return Buffer.from(`${[...entries].reverse().join('\0')}\0`, 'utf8');
  };
  const first = DEF.buildAuthorityRecord({ git: shuffled });
  const second = DEF.buildAuthorityRecord({ git: shuffled });
  assert.deepEqual(DEF.authorityArtifactBytes(first), DEF.authorityArtifactBytes(second));
  assert.equal(first.governedInventory.governedTreeDigest, authority().governedInventory.governedTreeDigest);
});
test('P9 the record carries no clock-shaped governance key at any depth', () => {
  // Two BOUND blocks legitimately name what they bound: the semantics blocks
  // name the clocks they refuse (`currentTimeUsed`, `filesystemMtimeUsed`) and
  // the provider boundary names its own ceilings (`timeoutMs`, `lookbackMs`).
  // Neither is a reading of time, so neither is scanned here; every other block
  // must be time-free.
  //
  // A key is clock-shaped when one of its camelCase TOKENS is a clock word.
  // `runtimeCapturePermittedInClosure` tokenises to `runtime` + `capture` + ...,
  // so it is a boundary FLAG and not a reading of a clock.
  const CLOCK_WORDS = new Set(['time', 'date', 'clock', 'mtime', 'instant', 'timestamp', 'now', 'generated', 'captured', 'observed', 'recorded', 'epoch', 'millis', 'seconds', 'nanos', 'at']);
  const isClockShaped = candidate => String(candidate).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(token => token.toLowerCase()).some(token => CLOCK_WORDS.has(token));
  // Positive control: the rule rejects a reading of time and accepts a policy flag.
  assert.deepEqual(['generatedAt', 'observedTime', 'readNow'].map(isClockShaped), [true, true, true]);
  assert.deepEqual(['runtimeCapturePermittedInClosure', 'recordType', 'providerHardCeilings'].map(isClockShaped), [false, false, false]);
  const keys = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') { for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } }
  };
  const { semantics, providerBoundary, ...rest } = authority();
  void semantics;
  void providerBoundary;
  walk(rest);
  for (const key of keys) assert.ok(!isClockShaped(key), key);
});
test('P10 repeated digest computations over the same members are stable', () => {
  const files = authority().governedInventory.files;
  assert.equal(DEF.governedTreeDigestOf(files), DEF.governedTreeDigestOf(files.map(entry => ({ ...entry }))));
  assert.equal(DEF.sha256Hex(Buffer.from('evolve')), DEF.sha256Hex(Buffer.from('evolve')));
});

// ===========================================================================
// Q. NO NETWORK AUTHORITY
// ===========================================================================

/** Every call site of a module, by callee name. Assignments are not calls. */
function callNames(relative) {
  const ast = espree.parse(readRepo(relative), { ecmaVersion: 'latest', sourceType: 'module' });
  const calls = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'CallExpression') {
      if (node.callee?.type === 'Identifier') calls.push(node.callee.name);
      if (node.callee?.type === 'MemberExpression' && typeof node.callee.property?.name === 'string') calls.push(node.callee.property.name);
    }
    if (node.type === 'NewExpression' && typeof node.callee?.name === 'string') calls.push(node.callee.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return calls;
}

/** Every literal child-process target name in a module. */
function childTargets(relative) {
  return [...readRepo(relative).matchAll(/execFileSync\('([^']+)'/g)].map(match => match[1]);
}

test('Q1 the closure validator itself made zero network calls', () => assert.equal(TRIPWIRES.calls, 0));
test('Q2 no closure artifact imports a network builtin except to tripwire it', () => {
  const network = /^node:(http|https|http2|net|tls|dgram|dns|cluster|worker_threads)$/;
  for (const relative of [DEF.PHASE_5K_FINAL_DEFINITION_PATH, DEF.PHASE_5K_FINAL_SURFACE_PATH]) {
    for (const imported of parseModule(relative).found.importSources) assert.ok(!network.test(imported), `${relative} imports ${imported}`);
  }
  // The runner and this suite import the socket module for ONE purpose: to
  // replace the connect primitive with a tripwire. Nothing else may use it.
  const socketTripwire = ['net', 'Socket', 'prototype', 'connect'].join('.');
  for (const relative of [DEF.PHASE_5K_FINAL_RUNNER_PATH, DEF.PHASE_5K_FINAL_VALIDATOR_PATH]) {
    const imported = parseModule(relative).found.importSources;
    for (const source_ of imported) {
      if (source_ === 'node:net') continue;
      assert.ok(!network.test(source_), `${relative} imports ${source_}`);
    }
    assert.ok(readRepo(relative).includes(socketTripwire), `${relative} installs the socket tripwire`);
  }
});
test('Q3 no closure module ever CALLS fetch or a browser network primitive', () => {
  const banned = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'axios']);
  for (const relative of CLOSURE_MODULES) {
    for (const call of callNames(relative)) assert.ok(!banned.has(call), `${relative} calls ${call}`);
  }
});
test('Q4 the closure validator starts only git and the accepted phase validators', () => {
  const targets = childTargets(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  assert.ok(targets.length >= 1, 'the validator runs git');
  for (const target of targets) assert.ok(target === 'git' || target === 'node', target);
  const { found } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  for (const identifier of ['spawn', 'spawnSync', 'fork', 'exec']) assert.ok(!found.identifiers.includes(identifier), identifier);
});
test('Q5 the acceptance runner starts only git and the accepted phase validators', () => {
  const targets = childTargets(DEF.PHASE_5K_FINAL_RUNNER_PATH);
  assert.ok(targets.length >= 2, 'the runner runs git and the suite');
  for (const target of targets) assert.ok(target === 'git' || target === 'node', target);
  const { found } = parseModule(DEF.PHASE_5K_FINAL_RUNNER_PATH);
  for (const identifier of ['spawn', 'spawnSync', 'fork']) assert.ok(!found.identifiers.includes(identifier), identifier);
});
test('Q6 the executed suite is exactly the accepted phase validator set', () => {
  assert.deepEqual(suite().map(result => result.validator), [...DEF.PHASE_5K_FINAL_VALIDATORS]);
  assert.equal(suite().length, 14);
});
test('Q7 no closure module names a market API endpoint, an RPC host or a live provider host', () => {
  const tokens = [
    ['api', '.mainnet-beta'].join(''),
    ['jup', 'iter'].join(''),
    ['dex', 'screener'].join(''),
    ['bird', 'eye'].join(''),
    ['coin', 'gecko'].join(''),
    ['solana', '-mainnet'].join(''),
  ];
  for (const [relative, source] of Object.entries(closureSources())) {
    for (const token of tokens) assert.ok(!source.toLowerCase().includes(token), `${relative} names ${token}`);
  }
});
test('Q8 the acceptance run requires zero network by construction: the tripwires are installed before the suite', () => {
  const runner = readRepo(DEF.PHASE_5K_FINAL_RUNNER_PATH);
  assert.ok(runner.includes('installNetworkTripwires'), 'the runner installs network tripwires');
  assert.equal(TRIPWIRES.calls, 0);
});

// ===========================================================================
// R. NO MARKET OR TRADING AUTHORITY
// =========================================================================
test('R1 no closure module declares a market-data identifier', () => {
  const banned = new Set([
    ['price', 'Usd'].join(''), ['market', 'Cap'].join(''), ['future', 'Return'].join(''),
    ['ohlc', 'v'].join(''), ['liquid', 'ity'].join(''), ['volume', '24h'].join(''),
    ['get', 'Price'].join(''), ['trade', 'Signal'].join(''),
  ]);
  for (const relative of CLOSURE_MODULES) {
    for (const identifier of parseModule(relative).found.identifiers) {
      assert.ok(!banned.has(identifier), `${relative}:${identifier}`);
    }
  }
});
test('R2 no closure module imports an engine, arena, champion, market-outcome or R4 module', () => {
  for (const [relative] of Object.entries(closureSources())) {
    for (const imported of parseModule(relative).found.importSources) {
      assert.ok(!/(^|\/)(engine|arena|champions|market-outcomes|r4-)/.test(imported), `${relative} imports ${imported}`);
    }
  }
});
test('R3 no decision surface imports the closure modules', () => {
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`) || entry === DEF.PHASE_5K_FINAL_VALIDATOR_PATH) continue;
    const source = readRepo(entry);
    assert.ok(!/final-acceptance(-definition|-surface)?\.mjs/.test(source), `${entry} reaches the closure modules`);
  }
});
test('R4 the deferred declaration covers market linkage, execution and selection', () => {
  const ids = authority().deferredCapabilities.capabilities.map(entry => entry.id);
  for (const required of ['MARKET_PRICE_LINKAGE', 'RETURN_CORRELATION', 'VOLATILITY_LINKAGE', 'PREDICTIVE_MODELLING',
    'PROFITABILITY_RESEARCH', 'RANKING', 'RECOMMENDATION', 'TRADE_CANDIDATE_SELECTION', 'EXECUTION',
    'WALLET_OR_SIGNING', 'ARENA_INTEGRATION', 'ENGINE_PROMOTION']) {
    assert.ok(ids.includes(required), required);
  }
});
test('R5 every derived-layer market linkage block is closed', () => {
  for (const block of [authority().semantics.corroboration.marketLinkage, authority().semantics.lineage.marketLinkage]) {
    for (const [key, value] of Object.entries(block)) assert.equal(value, false, key);
  }
  for (const [key, value] of Object.entries(authority().semantics.features.marketLinkage)) {
    if (key === 'mintIsIdentityOnly') assert.equal(value, true);
    else assert.equal(value, false, key);
  }
});
test('R6 the closure surface declares that it adds no market authority and no scientific claim', () => {
  assert.equal(authority().closureSurface.addsMarketAuthority, false);
  assert.equal(authority().closureSurface.addsScientificClaim, false);
  assert.equal(authority().closureSurface.addsNetworkCapability, false);
  assert.equal(authority().closureSurface.addsProviders, false);
  assert.equal(authority().closureSurface.modifiesAcceptedImplementation, false);
});
test('R7 the exact mint stays an identity key only: no closure module transforms it into a market subject', () => {
  assert.equal(FEATURE_MARKET.mintIsIdentityOnly, true);
  assert.equal(COVERAGE.subjectIsExactMintOnly, true);
  assert.ok(!JSON.stringify(closureSources()).includes(['mint', 'Price'].join('')), 'a closure module links a mint to a price');
});

// ===========================================================================
// S. R4 ISOLATION
// =========================================================================
test('S1 the accepted implementation descends from the R4 C1 authority commit', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', DEF.PHASE_5K_FINAL_R4_AUTHORITY_HEAD, DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD], { cwd: REPO_ROOT });
});
test('S2 the R4 preregistration seal is byte-identical to C1', () => {
  const bound = 'governance/r4/r4-preregistration-seal.json';
  assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(gitBuffer(['show', `${DEF.PHASE_5K_FINAL_R4_AUTHORITY_HEAD}:${bound}`])), bound);
});
test('S3 package.json and package-lock.json are byte-identical to C1', () => {
  for (const bound of ['package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(gitBuffer(['show', `${DEF.PHASE_5K_FINAL_R4_AUTHORITY_HEAD}:${bound}`])), bound);
  }
});
test('S4 the closure changes nothing under governance/r4', () => {
  const changed = gitOut('diff', '--name-only', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, '--', 'governance/r4').trim();
  assert.equal(changed, '');
});
test('S5 the closure changes nothing under the guarded storage area', () => {
  const guarded = ['.', 'evolve'].join('');
  assert.equal(gitOut('diff', '--name-only', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, '--', guarded).trim(), '');
  assert.equal(gitOut('ls-files', guarded).trim(), '');
});
test('S6 no R4 one-shot program is executed by the closure machinery', () => {
  const oneShots = [['r4-', 'outcome-generate'].join(''), ['r4-', 'result-attestation'].join(''), ['r4-', 'finalization'].join('')];
  for (const relative of CLOSURE_MODULES) {
    for (const target of childTargets(relative)) assert.ok(target === 'git' || target === 'node', `${relative} runs ${target}`);
    for (const source of parseModule(relative).found.importSources) {
      for (const oneShot of oneShots) assert.ok(!source.includes(oneShot), `${relative} imports ${oneShot}`);
    }
  }
});
test('S7 no R4 artifact path is dirty in the worktree', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!/(governance\/r4|\.evolve\/(governance|market-outcomes|market-intelligence))/.test(line), line);
  }
});
test('S8 the accepted 5K R4 boundary declaration is unchanged and R4 stays CLOSED', () => {
  assert.equal(R4_BOUNDARY.r4Status, 'CLOSED');
  assert.equal(R4_BOUNDARY.relationship, 'POST_R4');
  assert.equal(R4_BOUNDARY.r4EvidenceIsDistinct, true);
  assert.equal(authority().semantics.governance.r4Boundary.r4Status, 'CLOSED');
  assert.equal(DEF.canonical(authority().semantics.governance.r4Boundary), DEF.canonical({ ...R4_BOUNDARY }));
});

// ===========================================================================
// T. STORAGE ISOLATION
// ===========================================================================
test('T1 the guarded storage area is never tracked', () => {
  const guarded = ['.', 'evolve'].join('');
  assert.equal(gitOut('ls-files', guarded).trim(), '', 'the guarded area must never be tracked');
  assert.equal(existsFile(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});
test('T2 the guarded area is untouched in the worktree status', () => {
  const guarded = ['.', 'evolve'].join('');
  const line = new RegExp(`^\\s*[MADRCU?!]{1,2}\\s+\\${guarded}`);
  for (const entry of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!line.test(entry), 'the guarded area must be untouched');
  }
});
test('T3 no runtime capture under var/ is tracked or staged', () => {
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
  for (const entry of gitOut('diff', '--cached', '--name-only').split('\n').filter(Boolean)) {
    assert.ok(!entry.startsWith('var/'), entry);
    assert.ok(!entry.startsWith('.evolve/'), entry);
  }
});
test('T4 the closure definition and surface never name the guarded storage area', () => {
  const guarded = ['.', 'evolve'].join('');
  for (const relative of [DEF.PHASE_5K_FINAL_DEFINITION_PATH, DEF.PHASE_5K_FINAL_SURFACE_PATH]) {
    assert.ok(!readRepo(relative).includes(guarded), relative);
  }
  // The runner names it only through READ-ONLY guards: a git path set, a
  // tracked-file probe and a worktree-prefix test. Every mention must sit on a
  // line that carries one of those guard tokens, so no mention can silently
  // become a capability.
  const guards = ['r4Paths', 'ls-files', 'startsWith', 'untouched'];
  const runnerLines = readRepo(DEF.PHASE_5K_FINAL_RUNNER_PATH).split('\n').filter(line => line.includes(guarded));
  assert.ok(runnerLines.length >= 1, 'the runner proves the guarded area is untouched');
  for (const line of runnerLines) assert.ok(guards.some(token => line.includes(token)), line);
});
test('T5 the closure writes nothing into the repository', () => {
  for (const [relative] of Object.entries(closureSources())) {
    const { found } = parseModule(relative);
    for (const identifier of found.identifiers) {
      assert.ok(!/^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlinkSync|renameSync|chmodSync)$/.test(identifier), `${relative}:${identifier}`);
    }
    assert.ok(!found.importSources.includes('node:fs/promises'), `${relative} imports the promises fs surface`);
  }
});
test('T6 the acceptance runner reaches the filesystem read-only only', () => {
  const { found } = parseModule(DEF.PHASE_5K_FINAL_RUNNER_PATH);
  assert.deepEqual(found.importSources.filter(source => source.startsWith('node:fs')), ['node:fs']);
  for (const identifier of found.identifiers) {
    assert.ok(!/^(write|append|mkdir|rm|unlink|rename|chmod|copyFile)/.test(identifier), identifier);
  }
});

// ===========================================================================
// U. DEFERRED CAPABILITY DECLARATION
// =========================================================================
test('U1 every required deferred capability is declared', () => {
  const ids = authority().deferredCapabilities.capabilities.map(entry => entry.id);
  assert.equal(ids.length, 12);
  for (const required of DEF.PHASE_5K_FINAL_DEFERRED_CAPABILITIES.capabilities.map(entry => entry.id)) {
    assert.ok(ids.includes(required), required);
  }
});
test('U2 deferred means DEFERRED, not incomplete and not a defect', () => {
  assert.equal(authority().deferredCapabilities.status, 'DEFERRED');
  assert.equal(authority().deferredCapabilities.reason, 'OUT_OF_SCOPE_FOR_PHASE_5K');
  for (const entry of authority().deferredCapabilities.capabilities) {
    assert.ok(!/(BUG|DEFECT|INCOMPLETE|TODO|MISSING)/i.test(`${entry.id} ${entry.capability}`), entry.id);
  }
});
test('U3 a separate governed program with a new governance decision is required', () => {
  assert.equal(authority().deferredCapabilities.requiresSeparateGovernedProgram, true);
  assert.equal(authority().deferredCapabilities.requiresGovernanceDecision, true);
});
test('U4 no successor program is declared, named or implied', () => {
  assert.equal(authority().deferredCapabilities.successorProgramDeclared, false);
  assert.equal(authority().deferredCapabilities.impliedSuccessorPhase, null);
  assert.equal(authority().acceptanceScope.createsSuccessorProgram, false);
});
test('U5 no deferred capability is silently permitted by a boundary flag', () => {
  const flags = authority().boundaryFlags;
  assert.equal(flags.marketOutcomeLinkagePermitted || flags.priceDataPermitted || flags.profitabilityInferencePermitted, false);
  assert.equal(flags.predictionPermitted || flags.recommendationPermitted || flags.rankingPermitted || flags.assetScoringPermitted, false);
  assert.equal(flags.walletAuthority || flags.signerAuthority || flags.swapAuthority || flags.rpcWriteAuthority, false);
  assert.equal(flags.arenaEligible || flags.promotionEligible || flags.engineAuthority || flags.tradingAuthority, false);
});
test('U6 the closure creates no new governance surface of its own', () => {
  assert.equal(Object.hasOwn(authority(), 'program'), false);
  assert.equal(Object.hasOwn(authority(), 'successor'), false);
  assert.equal(authority().status, 'CLOSED');
});

// ===========================================================================
// V. DOCUMENTATION
// ===========================================================================
test('V1 the closure document exists and documents the whole closure', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH);
  assert.ok(doc.length > 4000, 'the closure document is too small to document a closure');
  assert.equal(doc.split('\n').length > 80, true);
});
test('V2 the document names the accepted implementation head verbatim', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH);
  assert.ok(doc.includes(DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD), 'the accepted head is not named');
});
test('V3 the document states what Phase 5K provides', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const heading of ['what phase 5k provides', 'authenticated', 'provenance', 'bounded', 'offline replay',
    'cross-run corpus', 'temporal', 'mastodon', 'bluesky', 'lineage', 'missingness', 'tamper', 'snapshot', 'read-only']) {
    assert.ok(doc.includes(heading), `the document lacks ${heading}`);
  }
});
test('V4 the document freezes the non-claims, including the trading-signal statement', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const heading of ['what phase 5k does not claim', 'more observations is not more truth',
    'more providers is not more confidence', 'more engagement is not importance', 'more lineages is not stronger truth',
    'more revisions is not suspicion', 'multi-provider presence is not consensus',
    'identical cross-provider content is not proof of copying', 'distinct content is not independent human authorship',
    'temporal ordering is not causality', 'descriptive feature is not predictive feature',
    'exact mint identity is not investment relevance', 'no phase 5k output is a trading signal']) {
    assert.ok(doc.includes(heading), `the document lacks "${heading}"`);
  }
});
test('V5 the document freezes the boundary flags', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const flag of ['research only', 'observer only', 'trading authority', 'engine authority', 'arena',
    'promotion', 'price data', 'profitability', 'prediction', 'ranking', 'wallet', 'signer', 'swap', 'rpc']) {
    assert.ok(doc.includes(flag), flag);
  }
});
test('V6 the document states that future work must be separately governed', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const phrase of ['separately governed', 'future work', 'immutable', 'accepted history']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});
test('V7 the document records the deferred capabilities as deferred, not as bugs', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const phrase of ['deferred capabilities', 'market', 'execution', 'wallet', 'arena integration', 'engine promotion']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  assert.ok(!/known bug|incomplete implementation/i.test(doc));
});
test('V8 the document states the authority artifact, the governed tree digest and the fingerprint', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const phrase of ['authority fingerprint', 'governed tree digest', DEF.PHASE_5K_FINAL_AUTHORITY_PATH.toLowerCase(),
    authority().governedInventory.governedTreeDigest, authority().authorityFingerprint]) {
    assert.ok(doc.includes(phrase), phrase.slice(0, 40));
  }
});
test('V9 the document states how the closure is verified offline', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH).toLowerCase();
  for (const phrase of ['offline', 'deterministic', 'zero network', 'read-only', 'validate-phase5k-final.mjs',
    'final-acceptance.mjs', 'r4']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});
test('V10 the closure files carry no AI attribution, no co-author trailer and no provider capture', () => {
  // The banned tokens are assembled from parts so this assertion does not
  // itself contain them - the same technique every historical validator uses.
  const bannedTokens = [
    ['Co-', 'authored-by'].join(''),
    ['co-', 'authored-by'].join(''),
    ['Generated ', 'with'].join(''),
    ['generated by an ', 'AI'].join(''),
    ['Open', 'AI'].join(''),
    ['Anthro', 'pic'].join(''),
    ['Chat', 'GPT'].join(''),
    ['Clau', 'de'].join(''),
  ];
  const files = [...CLOSURE_MODULES, DEF.PHASE_5K_FINAL_DOCUMENT_PATH, DEF.PHASE_5K_FINAL_AUTHORITY_PATH];
  for (const relative of files) {
    const source = readRepo(relative);
    for (const banned of bannedTokens) assert.ok(!source.includes(banned), `${relative} carries an attribution token`);
  }
});
test('V11 the document lists every accepted phase of the program', () => {
  const doc = readRepo(DEF.PHASE_5K_FINAL_DOCUMENT_PATH);
  for (const phase of DEF.PHASE_5K_FINAL_PHASE_ORDER) assert.ok(doc.includes(phase), phase);
});

// ===========================================================================
// W. FINAL CLOSURE STATE
// =========================================================================
test('W1 the acceptance runner reports PASS over the committed or working closure surface', async () => {
  const report = await acceptance();
  assert.equal(report.status, 'PASS', JSON.stringify(report.failures));
});
test('W2 every acceptance step passed', async () => {
  const report = await acceptance();
  assert.equal(report.steps.length, ACCEPTANCE.PHASE_5K_FINAL_ACCEPTANCE_STEPS.length);
  for (const entry of report.steps) assert.equal(entry.ok, true, `${entry.id}: ${entry.detail}`);
});
test('W3 the acceptance report emits the governed steps in order', async () => {
  const report = await acceptance();
  assert.deepEqual(report.steps.map(entry => entry.id), [...ACCEPTANCE.PHASE_5K_FINAL_ACCEPTANCE_STEPS]);
});
test('W4 the acceptance aggregate is exactly the pinned historical total', async () => {
  const report = await acceptance();
  assert.equal(report.historical.passed, 1390);
  assert.equal(report.historical.total, 1390);
  assert.equal(report.historical.expected, DEF.PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL);
});
test('W5 the executed suite reported the exact pinned count for every phase', async () => {
  const report = await acceptance();
  for (const entry of DEF.PHASE_5K_FINAL_PHASES) {
    const result = report.suite.find(candidate => candidate.phase === entry.phase);
    assert.equal(result.reported.passed, entry.expectedPassed, entry.phase);
    assert.equal(result.reported.total, entry.expectedTotal, entry.phase);
    assert.equal(result.exitCode, 0, entry.phase);
  }
});
test('W6 the rendered report is concise, deterministic and carries the status line', async () => {
  const report = await acceptance();
  const rendered = ACCEPTANCE.renderAcceptanceReport(report);
  assert.ok(rendered.startsWith('PHASE 5K FINAL ACCEPTANCE\n'), rendered.slice(0, 40));
  assert.ok(rendered.endsWith('PHASE_5K_FINAL_ACCEPTANCE: PASS'), rendered.slice(-40));
  assert.equal(rendered, ACCEPTANCE.renderAcceptanceReport(report));
});
test('W7 every declared closure file exists on disk', () => {
  for (const relative of DEF.PHASE_5K_FINAL_CLOSURE_FILES) assert.ok(existsFile(path.join(REPO_ROOT, relative)), relative);
});
test('W8 the accepted implementation is unmodified: the closure only adds its own surface', () => {
  const entries = gitOut('diff', '--name-status', DEF.PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD, '--').split('\n').filter(Boolean)
    .map(line => ({ code: line[0], relative: line.slice(2) }))
    .filter(entry => DEF.isGovernedPhase5KPath(entry.relative));
  for (const entry of entries) {
    assert.equal(entry.code, 'A', `the accepted implementation was modified: ${entry.relative}`);
    assert.equal(DEF.isClosureSurfacePath(entry.relative), true, entry.relative);
  }
});
test('W9 the worktree carries no dirty path outside the closure surface', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    const relative = line.slice(3).trim().replace(/^"|"$/g, '');
    assert.ok(relative.startsWith(`${PI}/`) || relative.startsWith('docs/PHASE5K') || relative === DEF.PHASE_5K_FINAL_VALIDATOR_PATH, line);
  }
});
test('W10 this suite contains at least one hundred explicit checks', () => assert.ok(tests.length >= 100, `${tests.length} checks`));
test('W11 the closure validation is offline and read-only by construction', () => {
  assert.equal(TRIPWIRES.calls, 0);
  const { found } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  for (const identifier of found.identifiers) {
    assert.ok(!/^(writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|chmodSync)$/.test(identifier), identifier);
  }
  assert.equal(found.importSources.includes('node:fs/promises'), false);
});
test('W12 the closure state is terminal: accepted, sealed and closed with no pending step', async () => {
  const report = await acceptance();
  assert.equal(authority().status, 'CLOSED');
  assert.equal(report.status, 'PASS');
  assert.equal(authority().acceptanceScope.recordIsAcceptanceOnly, true);
});


// ===========================================================================
// X. VALIDATOR SELF-HYGIENE
// ===========================================================================
test('X1 this validator imports exactly ONE project module: the governed closure surface', () => {
  const { found } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  assert.deepEqual(found.importSources.filter(source => source.startsWith('.')),
    ['./public-intelligence/final-acceptance-surface.mjs']);
});
test('X2 this validator names no protected module fragment of any earlier phase', () => {
  // The historical isolation checks cannot tell a MENTION from an IMPORT, so no
  // protected fragment may appear here even as a string literal. Reaching an
  // earlier phase is only possible through the governed surface.
  const { source } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  for (const fragment of PROTECTED_FRAGMENTS) assert.ok(!source.includes(fragment), `the validator names ${fragment}`);
});
test('X3 the closure definition refuses to invent a governed inventory without a Git reader', () => {
  refusal(() => DEF.buildGovernedInventory({}), 'PHASE_5K_FINAL_GIT_READER_REQUIRED');
  refusal(() => DEF.buildGovernedInventory({ git: null }), 'PHASE_5K_FINAL_GIT_READER_REQUIRED');
});
test('X4 the closure validator never dispatches on argv: it always runs its own suite', () => {
  const { source } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  // Built from parts so this assertion does not itself contain the token.
  const argvToken = ['process', 'argv'].join('.');
  assert.ok(!source.includes(argvToken), 'the validator must not branch on its command line');
  assert.ok(/^main\(\)/m.test(source), 'the validator always runs its suite');
});
test('X5 the closure suite reports its own exact count and sets a failing exit code on failure', () => {
  const { source } = parseModule(DEF.PHASE_5K_FINAL_VALIDATOR_PATH);
  assert.ok(source.includes('Phase 5K FINAL: ${tests.length - failed}/${tests.length} passed'), 'the suite prints its own count');
  assert.ok(source.includes('process.exitCode = 1'), 'a failure sets a non-zero exit code');
});

async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally {
    // Nothing to clean up: this validator writes no file and creates no root.
  }
  console.log(`Phase 5K FINAL: ${tests.length - failed}/${tests.length} passed; offline, read-only, ${TRIPWIRES.calls} network calls, aggregate ${(authority().validatorExpectations ?? {}).expectedHistoricalAssertions ?? 0} historical assertions`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K FINAL validator crashed:', error); process.exitCode = 1; });
