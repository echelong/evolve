/**
 * EVOLVE Development Governance v1 — CLI argument adapter.
 *
 * Tokenizing stays with the repository's shared parser (`scripts/lib/args.mjs`),
 * so governance never invents a second argv dialect. This adapter only:
 *
 *   1. turns a governance flag spec (`{ name: true }` = boolean, `{ name: false }`
 *      = value) into the shared parser's `booleanFlags` / `valueFlags` lists;
 *   2. reshapes the flat result into `{ flags, positional }`;
 *   3. expands comma-separated values for list flags, because the shared parser
 *      keeps only the last occurrence of a repeated flag. A list flag therefore
 *      accepts `--file a,b` as well as `--file a`.
 *
 * PAPER ONLY: this module only shapes argv. It executes nothing.
 */

import { parseArgs } from "../lib/args.mjs";

/**
 * @param {string[]} argv
 * @param {Record<string, boolean>} [flagSpec] `true` = boolean flag, `false` = value flag
 * @param {{ multi?: string[] }} [options] flags whose value is a comma-separated list
 * @returns {{ flags: Record<string, string|boolean|string[]|undefined>, positional: string[] }}
 */
export function parseGovernanceArgs(argv, flagSpec = {}, options = {}) {
  const multi = new Set(options.multi ?? []);
  const booleanFlags = [];
  const valueFlags = [];
  for (const [key, isBoolean] of Object.entries(flagSpec ?? {})) {
    if (isBoolean === true) booleanFlags.push(key);
    else valueFlags.push(key);
  }

  const parsed = parseArgs(Array.isArray(argv) ? argv : [], { booleanFlags, valueFlags });
  const flags = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "_") continue;
    if (multi.has(key) && typeof value === "string") {
      flags[key] = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      continue;
    }
    flags[key] = value;
  }
  return { flags, positional: Array.isArray(parsed._) ? parsed._ : [] };
}

export default parseGovernanceArgs;
