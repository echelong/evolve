// R4 OUTCOME GENERATION WRAPPER — the ONLY designated canonical real-R4
// generation path (post-cohort runtime governance; enforcement only).
//
// WHAT THIS IS. A thin, hash-attested, UNBOUND orchestration shell around the
// EXISTING SEALED `generateOutcomeRun` in `scripts/market-outcomes/index.mjs`.
// It adds NO outcome science: every scientific rule — the 300s horizon, the 60s
// resolution tolerance, Policy A content uniqueness, the reference list, the
// source policy, the outcome definition, the look-ahead guards and the frozen
// file layout — stays entirely inside the pre-existing sealed code.
//
// WHAT THIS IS NOT.
//   * It is NOT sealed code and is bound by no canonical seal. It is deliberately
//     absent from `R4_REQUIRED_BOUND_FILES`, `R4_RUNTIME_ROOTS`,
//     `R4_BOUND_VALIDATORS` and `R4_BOUND_NON_RUNTIME_ARTIFACTS`, because adding
//     it to the sealed bound set would invalidate Stage C.
//   * It is HASH-ATTESTED, not sealed: the authorization pins the SHA-256 of this
//     file's exact bytes, and this file recomputes and verifies its OWN hash —
//     together with every other pinned implementation hash — BEFORE any outcome
//     work begins. Any mismatch fails CLOSED.
//   * The bare `generateOutcomeRun` export remains technically callable directly,
//     bypassing this wrapper. Enforcement here is procedural/governance
//     enforcement, not a trusted execution environment, and anyone with
//     filesystem authority over this checkout can remove or replace local
//     `.evolve` governance records. This is disclosed rather than overclaimed.
//
// NO DISCRETIONARY INPUT. The only accepted argument is `--execute`. There is no
// `--run-id`, `--created-at`, `--sessions`, `--references`, `--output-root`,
// `--t0`, `--approval`, `--seal` or `--continuation` override, and no other flag
// of any kind: run id, createdAt, output root, source policy and sealed code all
// come from the authorization artifact, and sources/references are re-derived
// mechanically. There is no outcome-dependent branching anywhere below.
//
// SINGLE USE. The authorization is consumed exactly once. An exclusive claim
// record is written (O_EXCL, fsync, 0444) BEFORE generation starts; if the
// process dies after claiming, the run is ABANDONED / CONSUMED-FAILED for
// governance purposes and is never silently reused, never deleted and never
// retried. A retry requires a NEW numbered authorization and review.
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { R4_REPO_ROOT } from './r4-authority.mjs';
import { R4_SESSION_DIR_ROOT } from './r4-enforcement.mjs';
import { generateOutcomeRun, verifyOutcomeRun } from './market-outcomes/index.mjs';
import {
  R4_OUTCOME_AUTHORIZATION_FAILURE, assertImplementationHashes,
  assertOutcomeAuthorizationClaim, assertOutcomeAuthorizationConsumption, authorizationConsumptionState,
  buildOutcomeAuthorizationClaim, buildOutcomeAuthorizationConsumption,
  implementationHashes, outcomeAuthorizationClaimPathForGeneration,
  outcomeAuthorizationConsumptionPathForGeneration,
  verifyOutcomeAuthorization, writeOutcomeRecordOnce,
} from './r4-outcome-authorization.mjs';

const fail = code => { throw new Error(code); };

/**
 * The ONLY argument this wrapper accepts. Every other flag, including every
 * identity/timing/scientific override, is refused before any work happens.
 */
export const GENERATION_ALLOWED_ARGUMENTS = Object.freeze(['execute']);

/** Parse argv into command tokens, refusing anything not exactly `--execute`. */
export function assertGenerationArguments(argv = []) {
  const flags = (Array.isArray(argv) ? argv : []).filter(value => typeof value === 'string' && value.startsWith('--'));
  if (flags.length !== 1 || GENERATION_ALLOWED_ARGUMENTS.includes(flags[0].slice(2)) === false) {
    fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.override}:ARGS`);
  }
  return { execute: true };
}

/**
 * `sealedCode` is the authenticated S6/P identity plus the authorization
 * fingerprint that authorized this run. It is placed in the sealed manifest
 * metadata; it carries NO scientific input and selects nothing.
 */
export function buildSealedCodeBinding({ facts, authorization }) {
  return {
    sha: facts.resolution.authority.sealAuthorityCommit,
    tree: facts.seal.protocolTree,
    sealFingerprint: facts.seal.fingerprint,
    authorizationFingerprint: authorization.fingerprint,
  };
}

/** Any entry already present in the authorized outcome output root. */
export function listOutcomeRuns({ cwd = R4_REPO_ROOT, outputRoot }) {
  let entries;
  try { entries = readdirSync(path.resolve(cwd, outputRoot)); } catch { return []; }
  return entries.filter(entry => lstatSync(path.resolve(cwd, outputRoot, entry)).isDirectory());
}

/**
 * The single real-R4 generation entrypoint. Sequence, in order:
 *
 *   1. Verify the authorization COMPLETELY (independent full re-verification).
 *   2. Verify the implementation hashes, including THIS FILE's own hash.
 *   3. Verify the authorization has not been consumed or claimed.
 *   4. Verify the outcome output root contains no canonical completed run.
 *   5. Verify the exact authorized runId path does not already exist.
 *   6. Re-derive canonical membership and canonical references mechanically.
 *   7. Construct the source list mechanically from canonical membership.
 *   8. Consume the authorization with an exclusive claim, then call the EXISTING
 *      SEALED `generateOutcomeRun` with the authorized inputs, then finalize the
 *      write-once consumption record binding the resulting outcome fingerprint.
 *
 * There is no outcome-dependent branching: every input is either authorized or
 * mechanically derived, and `generateOutcomeRun` itself decides every outcome.
 */
export function generateAuthorizedOutcomeRun({ cwd = R4_REPO_ROOT, argv = [], now = Date.now, generate = generateOutcomeRun } = {}) {
  // 0. Arguments: `--execute` and nothing else.
  assertGenerationArguments(argv);
  // 1. Full independent verification of the authorization record.
  const verified = verifyOutcomeAuthorization({ cwd });
  const authorization = verified.record;
  const facts = verified.facts;
  // 2. Implementation hashes, including this wrapper's OWN bytes.
  const liveHashes = implementationHashes({ cwd });
  assertImplementationHashes({ declared: authorization.implementationHashes, actual: liveHashes });
  // 3. Single use: an existing claim or consumption permanently blocks reuse.
  const state = authorizationConsumptionState({ cwd, generation: authorization.authorizationGeneration });
  if (state !== 'UNCONSUMED') fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.consumed}:${state}`);
  // 4. The output root must contain no canonical completed run.
  const present = listOutcomeRuns({ cwd, outputRoot: authorization.outputRoot });
  if (present.length) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts}:${present.sort().join(',')}`);
  // 5. The exact authorized runId path must not already exist. A partial run left
  //    by a crash is NEVER deleted; it simply blocks a second generation.
  const runDir = path.resolve(cwd, authorization.outputRoot, authorization.runId);
  if (existsSync(runDir)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.runDir}:${authorization.runId}`);
  // 6 + 7. Sources are constructed mechanically from the DERIVED canonical
  //        membership and the DERIVED canonical references. Nothing is supplied.
  const sources = facts.canonicalMembership.map(sessionId => ({
    dir: path.resolve(facts.evidenceRoot, R4_SESSION_DIR_ROOT, sessionId),
    role: 'cohort',
  }));
  if (sources.length !== authorization.canonicalMembership.length) fail('R4_OUTCOME_AUTHORIZATION_SOURCE_COUNT_MISMATCH');
  const references = facts.canonicalReferences.map(reference => ({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest }));
  if (references.length !== authorization.referenceCount) fail('R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT_MISMATCH');
  // CONSUME FIRST. The exclusive claim is written BEFORE any outcome work, so a
  // crash after this point can never silently reuse the authorization.
  const claim = buildOutcomeAuthorizationClaim({ generation: authorization.authorizationGeneration, authorization, claimedAt: now() });
  assertOutcomeAuthorizationClaim(claim);
  writeOutcomeRecordOnce(path.resolve(cwd, outcomeAuthorizationClaimPathForGeneration(authorization.authorizationGeneration)), `${JSON.stringify(claim)}\n`);
  // 8. The EXISTING SEALED implementation. This wrapper implements no outcome
  //    science: it passes the authorized runId/createdAt/outputRoot, the frozen
  //    source policy, the mechanically derived sources and references, and a
  //    sealedCode derived from the authenticated S6/P identity.
  const generated = generate({
    sources,
    references,
    outputRoot: authorization.outputRoot,
    runId: authorization.runId,
    createdAt: authorization.createdAt,
    sourcePolicy: JSON.parse(authorization.sourcePolicy),
    sealedCode: buildSealedCodeBinding({ facts, authorization }),
  });
  // VERIFY the sealed product with the sealed verifier, then bind it.
  const manifest = verifyOutcomeRun(path.resolve(cwd, authorization.outputRoot, authorization.runId));
  if (manifest.fingerprint !== generated.manifest.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_OUTCOME_MANIFEST_MISMATCH');
  if (manifest.sealedCode?.authorizationFingerprint !== authorization.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_SEALED_CODE_BINDING_MISSING');
  const consumption = buildOutcomeAuthorizationConsumption({
    generation: authorization.authorizationGeneration, authorization, outcomeRun: manifest, consumedAt: now(),
  });
  assertOutcomeAuthorizationConsumption(consumption);
  writeOutcomeRecordOnce(path.resolve(cwd, outcomeAuthorizationConsumptionPathForGeneration(authorization.authorizationGeneration)), `${JSON.stringify(consumption)}\n`);
  return { authorization, manifest, claim, consumption, runDir };
}

/* -------------------------------------------------------------------- CLI */

const USAGE = 'Usage: node scripts/r4-outcome-generate.mjs --execute';

export async function main(argv = process.argv.slice(2), { cwd = R4_REPO_ROOT } = {}) {
  assertGenerationArguments(argv);
  const result = generateAuthorizedOutcomeRun({ cwd, argv });
  console.log(JSON.stringify({
    ok: true, command: 'generate',
    authorizationFingerprint: result.authorization.fingerprint,
    runId: result.authorization.runId,
    createdAt: result.authorization.createdAt,
    outputRoot: result.authorization.outputRoot,
    runDir: path.relative(cwd, result.runDir),
    outcomeManifestFingerprint: result.manifest.fingerprint,
    consumptionFingerprint: result.consumption.fingerprint,
    claimFingerprint: result.claim.fingerprint,
  }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
