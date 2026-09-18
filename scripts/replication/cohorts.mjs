/**
 * Phase 5C — frozen research cohorts (PAPER ONLY).
 *
 * PRIMARY replication freezes the research cohorts ONCE and re-evaluates those
 * exact genomes against different market datasets. Generating fresh DeepSeek
 * proposals per dataset would allow market-specific adaptation and confound
 * "does this cohort generalize?" with "can the model write a different strategy
 * after seeing this dataset?". Phase 5C primary analysis does the former.
 *
 * Two cohorts are frozen:
 *
 *   mock     the exact 13 unique genomes the canonical mock A/B arena
 *            (`arena-20260918T081727Z`) evaluated, from `.evolve/research`.
 *   deepseek the exact 12 compiled genomes of research experiment
 *            `exp-20260918T115857Z-deepseek-cline-a7abe2`.
 *
 * A frozen cohort is written as an Arena-readable research root:
 *
 *   .evolve/replication/cohorts/<key>/
 *     compiled/F-*.json        byte-identical genome payloads (copies)
 *     experiment.json          provider provenance (only when the source had one)
 *     cohort-manifest.json     immutable manifest + cohortDigest
 *
 * The source artifacts are READ ONLY: nothing here mutates
 * `.evolve/research` or any experiment root. No provider is called. PAPER ONLY.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { listCompiledCandidates } from "../research/memory.mjs";
import { genomeDigestOf } from "../research/cohort.mjs";
import { readResearchExperiment, researchExperimentSummary } from "../research/experiment.mjs";
import { sanitizeForPublic } from "../lib/sanitize.mjs";
import {
  COHORTS_DIR,
  COHORT_MANIFEST_FILE,
  PHASE,
  REPLICATION_SCHEMA_VERSION,
} from "./constants.mjs";

/** The two frozen cohort sources (immutable historical evidence). */
export const FROZEN_COHORT_SOURCES = Object.freeze({
  mock: Object.freeze({
    key: "mock",
    provider: "mock",
    kind: "research-root",
    root: path.join(".evolve", "research"),
    experimentId: null,
    canonicalArenaId: "arena-20260918T081727Z",
    note: "deterministic offline mock baseline (no provider provenance artifact exists)",
  }),
  deepseek: Object.freeze({
    key: "deepseek",
    provider: "deepseek-cline",
    kind: "experiment",
    root: path.join(".evolve", "research", "experiments", "exp-20260918T115857Z-deepseek-cline-a7abe2"),
    experimentId: "exp-20260918T115857Z-deepseek-cline-a7abe2",
    canonicalArenaId: "arena-20260918T120841Z",
    note: "frozen DeepSeek V4.1 Flash cohort; Phase 5C never re-queries the provider",
  }),
});

/** Deterministic per-seed lineage id (stable, digest-derived — never index-derived). */
export function lineageSeedIdFor(genomeDigest) {
  return typeof genomeDigest === "string" && genomeDigest.length >= 12 ? `seed-${genomeDigest.slice(0, 12)}` : null;
}

/** One manifest entry per frozen genome. */
export function cohortEntryFor(entry, { provider, experimentId }) {
  const genomeDigest = genomeDigestOf(entry);
  const role = entry?.authorRole ?? null;
  return {
    genomeDigest,
    lineageSeedId: lineageSeedIdFor(genomeDigest),
    species: entry?.species ?? null,
    targetSpecies: entry?.targetSpecies ?? null,
    family: entry?.family ?? entry?.researchFamily ?? null,
    familyId: entry?.familyId ?? null,
    proposalId: entry?.proposalId ?? null,
    authorRole: role,
    // Full role ancestry: a single-role seed here, but kept as a list so a
    // multi-parent seed (if a cohort ever contains one) is never collapsed.
    roleAncestry: role ? [role] : [],
    provider,
    researchExperimentId: experimentId,
    diversified: entry?.diversified === true,
  };
}

/**
 * Deterministic cohort digest.
 *
 * Computed over the IDENTITY-BEARING fields only (genome digest, species,
 * family, proposal/role attribution, provider), so the digest is stable across
 * re-reads and independent of the freeze artifact. The freeze digest is
 * recorded alongside, not folded in, to keep the two identities separable.
 */
export function cohortDigestOf({ provider, entries = [] }) {
  const sorted = [...entries].sort((a, b) => String(a.genomeDigest).localeCompare(String(b.genomeDigest)));
  return digestOf({
    provider,
    entries: sorted.map((entry) => ({
      genomeDigest: entry.genomeDigest,
      species: entry.species,
      family: entry.family,
      familyId: entry.familyId,
      proposalId: entry.proposalId,
      authorRole: entry.authorRole,
      targetSpecies: entry.targetSpecies,
    })),
  });
}

/** Count occurrences by key, skipping null/empty keys. */
function countsBy(entries, keyOf) {
  const out = {};
  for (const entry of entries) {
    const key = keyOf(entry);
    if (typeof key !== "string" || key.length === 0) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Build an immutable cohort manifest from a source research root.
 * Reads only; never writes.
 */
export async function buildCohortManifest({
  key,
  source = FROZEN_COHORT_SOURCES[key],
  freezeDigest = null,
  createdAt = Date.now(),
  limit = 500,
} = {}) {
  if (!source) throw new Error(`unknown frozen cohort '${key}'`);
  const compiled = await listCompiledCandidates(source.root, { limit });
  const experiment = source.experimentId ? await readResearchExperiment(source.root).catch(() => null) : null;
  const provider = experiment?.provider ?? source.provider;

  const seen = new Set();
  const entries = [];
  let duplicatesRejected = 0;
  let duplicatedErrors = 0;
  for (const row of compiled) {
    const digest = genomeDigestOf(row);
    if (!digest) {
      duplicatedErrors += 1;
      continue;
    }
    if (seen.has(digest)) {
      duplicatesRejected += 1;
      continue;
    }
    seen.add(digest);
    entries.push(cohortEntryFor(row, { provider, experimentId: source.experimentId }));
  }
  entries.sort((a, b) => String(a.genomeDigest).localeCompare(String(b.genomeDigest)));

  const cohortDigest = cohortDigestOf({ provider, entries });

  return {
    schemaVersion: REPLICATION_SCHEMA_VERSION,
    phase: PHASE,
    cohortKey: key,
    provider,
    kind: source.kind,
    frozen: true,
    immutable: true,
    paperOnly: true,
    origin: {
      root: source.root,
      experimentId: source.experimentId,
      canonicalArenaId: source.canonicalArenaId,
      note: source.note,
    },
    freezeDigest,
    experiment: experiment ? researchExperimentSummary(experiment) : null,
    createdAt: new Date(createdAt).toISOString(),
    compiledArtifacts: compiled.length,
    duplicatesRejected,
    unusableEntries: duplicatedErrors,
    count: entries.length,
    speciesCounts: countsBy(entries, (entry) => entry.species),
    familyCounts: countsBy(entries, (entry) => entry.family),
    roleCounts: countsBy(entries, (entry) => entry.authorRole),
    entries,
    cohortDigest,
    note:
      "Frozen research cohort. The genomes are re-evaluated against independent market datasets; the provider is never called again. Frozen does not mean validated, profitable, or significant.",
  };
}

/* ============================================================================
 * Persistence
 * ==========================================================================*/

export function cohortDirFor(baseDir, key) {
  return path.join(baseDir, COHORTS_DIR, key);
}

export function cohortManifestPath(baseDir, key) {
  return path.join(cohortDirFor(baseDir, key), COHORT_MANIFEST_FILE);
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

/** Payload files for a cohort: the exact compiled genome records. */
export async function readCompiledPayload(source) {
  const dir = path.join(source.root, "compiled");
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { files: [], experiment: null };
  }
  const files = [];
  for (const name of names) {
    try {
      files.push({ name, record: JSON.parse(await readFile(path.join(dir, name), "utf8")) });
    } catch {
      // An unreadable compiled artifact is skipped here; the manifest count
      // (built from the same listCompiledCandidates reader) reports it.
    }
  }
  const experiment = source.experimentId ? await readResearchExperiment(source.root).catch(() => null) : null;
  return { files, experiment };
}

/**
 * Persist a frozen cohort. Immutable: an existing manifest with a DIFFERENT
 * cohort digest is a hard error unless `overwrite` is explicitly set.
 */
export async function writeFrozenCohort({ baseDir, manifest, overwrite = false } = {}) {
  if (!baseDir || !manifest?.cohortKey) throw new Error("writeFrozenCohort requires baseDir and a cohort manifest");
  const manifestPath = cohortManifestPath(baseDir, manifest.cohortKey);
  const existing = await readFrozenCohort(baseDir, manifest.cohortKey);
  if (existing && existing.cohortDigest !== manifest.cohortDigest && overwrite !== true) {
    throw new Error(
      `frozen cohort '${manifest.cohortKey}' already exists with digest ${existing.cohortDigest.slice(0, 12)}; ` +
        `refusing to overwrite with ${String(manifest.cohortDigest).slice(0, 12)} (pass overwrite to replace explicitly)`,
    );
  }

  const source = FROZEN_COHORT_SOURCES[manifest.cohortKey];
  const payload = source ? await readCompiledPayload(source) : { files: [], experiment: null };
  const dir = cohortDirFor(baseDir, manifest.cohortKey);
  const compiledDir = path.join(dir, "compiled");
  // Rebuild the payload from scratch so the frozen directory contains EXACTLY
  // the manifest's frozen genomes — no stale duplicate compiled artifacts.
  await rm(compiledDir, { recursive: true, force: true });
  await mkdir(compiledDir, { recursive: true });

  const frozenDigests = new Set((manifest.entries ?? []).map((entry) => entry.genomeDigest));
  const written = new Set();
  for (const file of payload.files) {
    const digest = genomeDigestOf(file.record);
    // Only the frozen genomes, and only the FIRST record for each digest, so
    // the payload is byte-for-byte what the cohort manifest describes.
    if (!frozenDigests.has(digest) || written.has(digest)) continue;
    written.add(digest);
    await writeJsonAtomic(path.join(compiledDir, file.name), sanitizeForPublic(file.record));
  }
  if (payload.experiment) {
    await writeJsonAtomic(path.join(dir, "experiment.json"), sanitizeForPublic(payload.experiment));
  }
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export async function readFrozenCohort(baseDir, key) {
  try {
    return JSON.parse(await readFile(cohortManifestPath(baseDir, key), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify a frozen cohort's payload still matches its manifest digest — i.e.
 * "frozen genomes unchanged". Read-only.
 */
export async function verifyFrozenCohort(baseDir, key) {
  const manifest = await readFrozenCohort(baseDir, key);
  if (!manifest) return { ok: false, key, reason: "no frozen cohort manifest", digestMatches: false };
  const dir = path.join(cohortDirFor(baseDir, key), "compiled");
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { ok: false, key, reason: "frozen cohort payload directory is missing", digestMatches: false };
  }
  const digests = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      const digest = genomeDigestOf(record);
      if (digest) digests.push(digest);
    } catch {
      // unreadable file contributes nothing
    }
  }
  const recomputed = cohortDigestOf({
    provider: manifest.provider,
    entries: manifest.entries ?? [],
  });
  const payloadMatchesManifest =
    digests.length === (manifest.entries ?? []).length &&
    digests.every((digest) => (manifest.entries ?? []).some((entry) => entry.genomeDigest === digest));
  const digestMatches = recomputed === manifest.cohortDigest;
  return {
    ok: digestMatches && payloadMatchesManifest,
    key,
    count: manifest.count,
    payloadFiles: digests.length,
    digestMatches,
    payloadMatchesManifest,
    cohortDigest: manifest.cohortDigest,
    recomputedDigest: recomputed,
    freezeDigest: manifest.freezeDigest ?? null,
    reason: digestMatches ? null : "frozen cohort digest does not match its manifest",
  };
}

/**
 * Freeze (or load) every requested cohort. Idempotent: re-freezing the same
 * sources yields the same cohort digests and rewrites nothing that differs.
 */
export async function freezeCohorts({
  baseDir,
  freezeDigest = null,
  keys = Object.keys(FROZEN_COHORT_SOURCES),
  overwrite = false,
  createdAt = Date.now(),
} = {}) {
  const manifests = {};
  for (const key of keys) {
    const existing = await readFrozenCohort(baseDir, key);
    const built = await buildCohortManifest({ key, freezeDigest, createdAt });
    if (existing && existing.cohortDigest === built.cohortDigest && overwrite !== true) {
      // The GENOMES are unchanged, so the frozen payload is never rewritten.
      // Only the freeze-digest back-reference is refreshed when it was recorded
      // before a freeze artifact existed.
      if (existing.freezeDigest !== freezeDigest && freezeDigest) {
        const refreshed = { ...existing, freezeDigest };
        await writeJsonAtomic(cohortManifestPath(baseDir, key), refreshed);
        manifests[key] = refreshed;
        continue;
      }
      manifests[key] = existing;
      continue;
    }
    manifests[key] = await writeFrozenCohort({ baseDir, manifest: built, overwrite });
  }
  return manifests;
}

/** Compact, human-inspectable cohort summary (section Y). */
export function inspectCohort(manifest) {
  if (!manifest) return null;
  return {
    cohortKey: manifest.cohortKey,
    provider: manifest.provider,
    count: manifest.count,
    cohortDigest: manifest.cohortDigest,
    freezeDigest: manifest.freezeDigest ?? null,
    experimentId: manifest.origin?.experimentId ?? null,
    sourceRoot: manifest.origin?.root ?? null,
    speciesCounts: manifest.speciesCounts ?? {},
    familyCounts: manifest.familyCounts ?? {},
    roleCounts: manifest.roleCounts ?? {},
    duplicatesRejected: manifest.duplicatesRejected ?? 0,
    entries: (manifest.entries ?? []).map((entry) => ({
      genomeDigest: entry.genomeDigest,
      species: entry.species,
      family: entry.family,
      proposalId: entry.proposalId,
      authorRole: entry.authorRole,
      familyId: entry.familyId,
      lineageSeedId: entry.lineageSeedId,
    })),
  };
}
