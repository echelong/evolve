/**
 * Shared command-line argument parser (Phase 5A.2).
 *
 * The original parser (still exported from make-fixture.mjs) greedily consumed
 * the next positional token as the value of ANY `--flag`, which meant
 * `--research DATASET` bound the dataset to `research` and left no positional
 * at all. That made `npm run arena -- --research DATASET` silently run a
 * registry sweep over every dataset instead of the one requested.
 *
 * This parser keeps the same simple shape (`args._` for positionals) but adds
 * *knowledge of which flags are boolean*:
 *
 *   --research DATASET        -> research === true, DATASET stays positional
 *   DATASET --research        -> research === true, DATASET stays positional
 *   --research=true DATASET   -> research === true, DATASET stays positional
 *   --research=false          -> research === false
 *   --research-mode fair      -> research-mode === "fair" (a value flag)
 *   --seed abc                -> seed === "abc" (unknown flag, value follows)
 *   --verbose                 -> verbose === true (unknown, nothing follows)
 *   --no-cache                -> "no-cache" === true
 *
 * Flags that legitimately take a value keep working: anything listed in
 * `valueFlags`, and — for backward compatibility — any flag not known to be
 * boolean whose following token is not itself a flag.
 *
 * PAPER ONLY: this module only shapes argv, it never executes anything.
 */

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

/**
 * Interpret an explicit `--flag=value` payload as a JS value. For boolean flags
 * we honour true/false spellings; anything else is passed through as a string
 * so a value flag never loses information.
 */
export function coerceArgValue(raw, { boolean = false } = {}) {
  if (raw === undefined || raw === null) return boolean ? true : "";
  const text = String(raw);
  if (boolean) {
    const lower = text.trim().toLowerCase();
    if (FALSE_VALUES.has(lower)) return false;
    if (TRUE_VALUES.has(lower)) return true;
    return text.length > 0;
  }
  return text;
}

/**
 * @param {string[]} argv
 * @param {{
 *   booleanFlags?: string[] | Set<string>,
 *   valueFlags?: string[] | Set<string>,
 * }} [options]
 * @returns {{ _: string[], [key: string]: string|boolean|string[] }}
 */
export function parseArgs(argv, { booleanFlags = [], valueFlags = [] } = {}) {
  const booleans = booleanFlags instanceof Set ? booleanFlags : new Set(booleanFlags);
  const values = valueFlags instanceof Set ? valueFlags : new Set(valueFlags);
  const tokens = Array.isArray(argv) ? argv.map((token) => String(token)) : [];
  const args = { _: [] };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token === "--") {
      args._.push(token);
      continue;
    }

    let key = token.slice(2);
    let inline;
    const equals = key.indexOf("=");
    if (equals >= 0) {
      inline = key.slice(equals + 1);
      key = key.slice(0, equals);
    }
    if (key.length === 0) continue;

    // `--no-<flag>` negates a known boolean flag.
    if (inline === undefined && key.startsWith("no-") && booleans.has(key.slice(3))) {
      args[key.slice(3)] = false;
      continue;
    }

    if (inline !== undefined) {
      args[key] = booleans.has(key) ? coerceArgValue(inline, { boolean: true }) : coerceArgValue(inline);
      continue;
    }

    if (booleans.has(key)) {
      args[key] = true;
      continue;
    }

    const next = tokens[index + 1];
    const takesValue = values.has(key) || (next !== undefined && !next.startsWith("--"));
    if (!takesValue) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }

  return args;
}

export default parseArgs;
