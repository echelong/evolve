/**
 * Secret-safe serialization helpers.
 *
 * The engine writes a public dashboard snapshot to disk and that snapshot is
 * served by an unauthenticated API route. Two guarantees are enforced here:
 *
 *   1. Keys that look like credentials are never emitted.
 *   2. If a known secret string shows up anywhere (including inside an error
 *      message or a URL), it is replaced with `[redacted]`.
 *
 * Numeric safety is enforced as well: `NaN`, `Infinity`, `undefined`, and
 * functions cannot survive a round trip through this module, so the dashboard
 * can never receive an unserializable value.
 */

/**
 * Credential *field names* only. A field called `apiKey` is dropped, while
 * `apiKeyConfigured` (a boolean the dashboard legitimately displays) is kept.
 */
const SENSITIVE_KEY =
  /^(api[_-]?key|apikey|key|secret|client[_-]?secret|private[_-]?key|secret[_-]?key|gateway[_-]?api[_-]?key|seed[_-]?ph\w+|mnem\w+|passphrase|authorization|bearer|access[_-]?token|refresh[_-]?token|secretvalues|wallet[_-]?secret)$/i;

const REDACTION = "[redacted]";
const MAX_DEPTH = 12;

/** Is this a value we can treat as a plain object? */
export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Replace every occurrence of a known secret, plus any generic credential
 * pattern, inside arbitrary text. Used for logs, error messages, and state.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join(REDACTION);
  }

  return out.replace(
    /((?:x-api-key|api[_-]?key|apikey|authorization|bearer|access[_-]?token)[\s"':=]+)([^\s"',}]+)/gi,
    `$1${REDACTION}`,
  );
}

/** Does this field name hold credential material? */
export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

/**
 * Recursively produce a JSON-safe, secret-free clone of `value`.
 *
 * @param {unknown} value
 * @param {{ secrets?: string[], maxDepth?: number }} [options]
 */
export function sanitizeForPublic(value, { secrets = [], maxDepth = MAX_DEPTH } = {}) {
  const seen = new WeakSet();
  const secretList = secrets.filter((entry) => typeof entry === "string" && entry.length >= 4);

  const walk = (input, depth) => {
    if (input === null) return null;

    const kind = typeof input;
    if (kind === "number") return Number.isFinite(input) ? input : null;
    if (kind === "string") return redactSecrets(input, secretList);
    if (kind === "boolean") return input;
    if (kind === "bigint") return Number(input);
    if (kind === "undefined" || kind === "function" || kind === "symbol") return undefined;

    if (depth >= maxDepth) return null;

    if (Array.isArray(input)) {
      const out = [];
      for (const item of input) {
        const next = walk(item, depth + 1);
        if (next !== undefined) out.push(next);
      }
      return out;
    }

    // Date / anything exposing toJSON (e.g. Date instances).
    if (input instanceof Date) {
      const time = input.getTime();
      return Number.isFinite(time) ? input.toISOString() : null;
    }

    if (typeof input === "object") {
      if (seen.has(input)) return "[circular]";
      seen.add(input);

      const out = {};
      for (const [key, raw] of Object.entries(input)) {
        if (SENSITIVE_KEY.test(key)) continue;
        const next = walk(raw, depth + 1);
        if (next !== undefined) out[key] = next;
      }

      seen.delete(input);
      return out;
    }

    return undefined;
  };

  return walk(value, 0);
}

/** Serialize a snapshot with a stable, secret-free shape. */
export function serializeForPublic(value, options) {
  return JSON.stringify(sanitizeForPublic(value, options));
}
