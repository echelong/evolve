// Phase 5K.3 - RUN STORE: write-once, append-only persistence of one collection
// run under a SAFE runtime root that is never `.evolve` and never tracked by Git.
//
//   <runtime-root>/runs/<run-id>/
//     plan.json              write-once, read-only after write
//     requests.ndjson        append-only while the run is active
//     raw-evidence.ndjson    appended by the 5K.1 NDJSON store (raw first)
//     observations.ndjson    appended by the 5K.1 NDJSON store
//     manifest.json          written ONCE, atomically, read-only; never mutated
//
// A run directory without manifest.json is an ABORTED/UNFINALIZED run. The
// verifier reports it as such; nothing ever rewrites it into COMPLETED.
//
// OFFLINE BY CONSTRUCTION: filesystem only. No socket. No clock. No env.
import {
  appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { assertSafeStoreDirectory } from './store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The default, gitignored, project-local runtime root. */
export const PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT = path.join(REPO_ROOT, 'var', 'public-intelligence');

export const PUBLIC_INTELLIGENCE_5K3_RUN_FILES = Object.freeze({
  plan: 'plan.json',
  requests: 'requests.ndjson',
  manifest: 'manifest.json',
  raw: 'raw-evidence.ndjson',
  observations: 'observations.ndjson',
});

const RUN_ID = /^run-[0-9a-f]{32}$/;

function nearestExistingRealpath(target) {
  let current = target;
  const trail = [];
  while (!existsSync(current)) {
    trail.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(realpathSync(current), ...trail);
}

const within = (candidate, base) => candidate === base || candidate.startsWith(base + path.sep);

/**
 * A runtime root is accepted only if, after resolving symlinks, it lies under
 * the project's `var/public-intelligence` or the OS temp directory, contains no
 * `..` segment as supplied, and has no `.evolve` segment anywhere.
 */
export function assertSafeRuntimeRoot(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) failClosed('PUBLIC_INTELLIGENCE_5K3_RUNTIME_ROOT_REQUIRED');
  if (root.split(/[\\/]/).includes('..')) failClosed('PUBLIC_INTELLIGENCE_5K3_RUNTIME_ROOT_TRAVERSAL_REFUSED');
  if (!path.isAbsolute(root)) failClosed('PUBLIC_INTELLIGENCE_5K3_RUNTIME_ROOT_MUST_BE_ABSOLUTE');
  const resolved = path.resolve(root);
  assertSafeStoreDirectory(resolved); // reuses the 5K.1 `.evolve` refusal
  const real = nearestExistingRealpath(resolved);
  if (real.split(path.sep).includes('.evolve')) failClosed('PUBLIC_INTELLIGENCE_5K3_RUNTIME_ROOT_EVOLVE_REFUSED');
  const bases = [nearestExistingRealpath(PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT), realpathSync(tmpdir())];
  if (!bases.some(base => within(real, base))) failClosed('PUBLIC_INTELLIGENCE_5K3_RUNTIME_ROOT_OUTSIDE_ALLOWED_AREAS');
  return resolved;
}

export function runDirectoryOf(root, runId) {
  if (!RUN_ID.test(runId)) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'runs', runId);
}

/** Creates the run directory exclusively. An existing run is never reused. */
export function createRunDirectory(root, runId) {
  const directory = runDirectoryOf(root, runId);
  mkdirSync(path.dirname(directory), { recursive: true });
  try { mkdirSync(directory); } catch (error) {
    if (error?.code === 'EEXIST') failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_ALREADY_EXISTS');
    throw error;
  }
  return directory;
}

export function runDirectoryExists(root, runId) {
  return existsSync(runDirectoryOf(root, runId));
}

/** plan.json: exclusive create, then read-only. */
export function writePlanOnce(directory, plan) {
  const target = path.join(directory, PUBLIC_INTELLIGENCE_5K3_RUN_FILES.plan);
  writeFileSync(target, `${canonical(plan)}\n`, { flag: 'wx', mode: 0o444 });
  return target;
}

/** requests.ndjson: append-only, one canonical line per request. */
export function appendRequestRecord(directory, record) {
  appendFileSync(path.join(directory, PUBLIC_INTELLIGENCE_5K3_RUN_FILES.requests), `${canonical(record)}\n`, 'utf8');
}

/**
 * manifest.json: ATOMIC and WRITE-ONCE. The bytes are written to a temp file,
 * then hard-linked to the final name; `link` fails if the final name exists, so
 * a finalized manifest can never be replaced. The result is read-only.
 */
export function writeManifestOnce(directory, manifest) {
  const target = path.join(directory, PUBLIC_INTELLIGENCE_5K3_RUN_FILES.manifest);
  if (existsSync(target)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_ALREADY_FINALIZED');
  const temp = path.join(directory, '.manifest.tmp');
  writeFileSync(temp, `${canonical(manifest)}\n`, { flag: 'wx', mode: 0o444 });
  try { linkSync(temp, target); } catch (error) {
    if (error?.code === 'EEXIST') failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_ALREADY_FINALIZED');
    throw error;
  } finally { unlinkSync(temp); }
  chmodSync(target, 0o444);
  return target;
}

// ---------------------------------------------------------------------------
// READING (strict: a malformed file is reported, never guessed at)
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  if (!existsSync(file)) return { missing: true, value: null };
  try { return { missing: false, value: JSON.parse(readFileSync(file, 'utf8')) }; } catch { return { missing: false, malformed: true, value: null }; }
}

function readNdjsonFile(file) {
  if (!existsSync(file)) return { missing: true, lines: [] };
  const lines = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { return { missing: false, malformed: true, lines: [] }; }
  }
  return { missing: false, lines };
}

/** Loads every artifact of one run directory. Never throws on a bad file. */
export function loadRunArtifacts(directory) {
  const files = PUBLIC_INTELLIGENCE_5K3_RUN_FILES;
  const plan = readJsonFile(path.join(directory, files.plan));
  const manifest = readJsonFile(path.join(directory, files.manifest));
  const requests = readNdjsonFile(path.join(directory, files.requests));
  const raw = readNdjsonFile(path.join(directory, files.raw));
  const observations = readNdjsonFile(path.join(directory, files.observations));
  const problems = [];
  for (const [name, loaded] of [['plan', plan], ['manifest', manifest], ['requests', requests], ['raw', raw], ['observations', observations]]) {
    if (loaded.malformed) problems.push(`LOAD_MALFORMED:${name}`);
  }
  // An absent raw/observations stream is legitimate ONLY for a run that stored nothing;
  // the verifier decides using the manifest counts.
  return {
    directory,
    plan: plan.value,
    manifest: manifest.value,
    requests: requests.lines,
    raw: raw.lines,
    observations: observations.lines,
    present: { plan: !plan.missing, manifest: !manifest.missing, requests: !requests.missing, raw: !raw.missing, observations: !observations.missing },
    loadProblems: problems,
  };
}
