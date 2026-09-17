/**
 * Hashing helpers.
 *
 * Two distinct jobs:
 *
 *   1. Dataset fingerprints — SHA-256 of the dataset files, so an experiment can
 *      prove which exact bytes produced its numbers.
 *   2. Canonical digests — a stable hash of a JS value (a genome, a state
 *      object) used to prove that a frozen stage did not mutate anything.
 *
 * No signing, no keys, no crypto authority: these are integrity checks only.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

export const HASH_ALGORITHM = "sha256";

export function sha256Hex(value) {
  return createHash(HASH_ALGORITHM).update(value).digest("hex");
}

/** Canonical stringify: sorted object keys, so digests are stable. */
export function canonicalJson(value) {
  const seen = new WeakSet();

  const walk = (input) => {
    if (input === null) return "null";
    const kind = typeof input;
    if (kind === "number") return Number.isFinite(input) ? String(input) : "null";
    if (kind === "boolean") return input ? "true" : "false";
    if (kind === "string") return JSON.stringify(input);
    if (kind === "undefined" || kind === "function" || kind === "symbol") return "null";
    if (kind === "bigint") return String(input);

    if (input instanceof Date) return JSON.stringify(input.toISOString());

    if (Array.isArray(input)) {
      return `[${input.map((entry) => walk(entry)).join(",")}]`;
    }

    if (seen.has(input)) return '"__circular__"';
    seen.add(input);

    const keys = Object.keys(input).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${walk(input[key])}`)
      .join(",");

    seen.delete(input);
    return `{${body}}`;
  };

  return walk(value);
}

/** Stable digest of any JS value (used for genome identity checks). */
export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

/** Short digest for display in dashboards and manifests. */
export function shortDigest(value, length = 12) {
  return digestOf(value).slice(0, length);
}

/** Hash a file by streaming it: no size limit, bounded memory. */
export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash(HASH_ALGORITHM);
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Hash a small file we are happy to hold in memory. */
export async function hashFileBuffered(filePath) {
  return sha256Hex(await readFile(filePath));
}
