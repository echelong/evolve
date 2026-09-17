/**
 * Minimal dependency-free .env loader.
 *
 * The engine is plain Node ESM and runs outside of Next.js, so Next's own
 * .env handling never applies to it. This loader is intentionally tiny:
 *   - never overrides values already present in process.env
 *   - supports `KEY=value`, quotes, and `# comment` lines
 *   - never prints or logs secret values
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_ENV_FILES = [".env.local", ".env"];

/** Parse a dotenv-style file body into a plain object. */
export function parseEnvFile(contents) {
  const parsed = {};

  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    const doubleQuoted = value.length > 1 && value.startsWith('"') && value.endsWith('"');
    const singleQuoted = value.length > 1 && value.startsWith("'") && value.endsWith("'");

    if (doubleQuoted || singleQuoted) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment such as:   KEY=value  # note
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    parsed[key] = value;
  }

  return parsed;
}

/**
 * Load env files into process.env (without clobbering real environment values).
 * Returns the list of files that were actually read.
 */
export function loadEnvFiles({ dir = process.cwd(), files = DEFAULT_ENV_FILES } = {}) {
  const loaded = [];

  for (const file of files) {
    const fullPath = path.isAbsolute(file) ? file : path.join(dir, file);
    if (!existsSync(fullPath)) continue;

    try {
      const parsed = parseEnvFile(readFileSync(fullPath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      loaded.push(file);
    } catch {
      // An unreadable .env file must never crash the paper engine.
    }
  }

  return loaded;
}