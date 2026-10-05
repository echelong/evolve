// Phase 5K.6.3 - PROVIDER-NEUTRAL PAGINATION CURSOR.
//
// ONE closed generic validator for a pagination cursor token. Pure, offline, no
// clock, no filesystem, no network, no environment.
//
// WHY THIS MODULE EXISTS
//
// The 5K.3 request-record schema used to validate cursors with a Mastodon-shaped
// rule (`^[0-9]{1,32}$`). That was a provider-specific assumption baked into a
// schema that is supposed to be GENERIC. It became invalid the moment 5K.6 added
// a second governed provider: Bluesky pagination cursors are provider-issued
// OPAQUE strings (`"c1"`, `"3lt..."`, and similar), so a perfectly valid
// multi-page Bluesky collection was rejected as an integrity failure.
//
// THE LAYER CONTRACT
//
//   generic layer (this module):   the cursor is an OPAQUE BOUNDED TOKEN.
//                                  It governs ONLY structural properties.
//   provider layer (each adapter): decides whether a cursor is valid FOR THAT
//                                  PROVIDER. Mastodon may still require numeric
//                                  IDs; Bluesky treats the token as opaque.
//
// The generic layer therefore NEVER interprets cursor syntax. It does not parse
// it, normalise it, case-fold it, trim it, decode it, compare it against any
// provider protocol pattern, or use it to decide anything about a provider's
// semantics. It asks exactly one question: is this structurally safe to persist
// and to hand back to a transport?
//
// A CURSOR IS NOT A URL. It is not an endpoint, not an arbitrary query fragment,
// not an authorization token and not executable input. A transport always builds
// its OWN fixed endpoint and inserts the cursor only into the governed provider
// parameter, so a cursor can never redirect a request or move a host. This module
// additionally refuses URL and credential syntax outright, which is the generic
// layer's half of that guarantee.
//
// NO CASE FOLDING, NO TRIMMING, NO NORMALISATION. Whatever the provider issued is
// preserved exactly after validation, so replay and the request fingerprint bind
// the precise token the provider supplied.
//
// Pure and offline by construction. It imports only the 5K.1 fail-closed helper,
// so a refusal is the same typed refusal every other governed layer raises.
import { failClosed } from './observation.mjs';

// ---------------------------------------------------------------------------
// THE GENERIC CURSOR CONTRACT
// ---------------------------------------------------------------------------
//
//   null            -> VALID ABSENCE. There is no next cursor; this is how a
//                      provider signals natural exhaustion.
//   string          -> VALID only when ALL of the following hold:
//        - length >= 1                       a present cursor must be non-empty
//        - length <= 256                     explicit conservative ceiling
//        - no ASCII control character        0x00-0x1F and 0x7F
//        - specifically no NUL, no LF, no CR
//        - not URL syntax                    a cursor is not an endpoint
//        - not credential syntax             not an authorization token
//   anything else   -> INVALID (number, boolean, array, object, symbol, ...)
//
// NOTHING ELSE IS GOVERNED HERE. Alphabetic, alphanumeric, digits-only and the
// punctuation real opaque tokens use are all accepted, because the generic layer
// must not encode any provider's idea of a valid token.

/**
 * Maximum accepted cursor length, in code units.
 *
 * WHY 256:
 *   - The largest provider cursor shape already in the codebase is Mastodon's
 *     32-digit numeric ID, so this ceiling sits far above every known provider
 *     shape and cannot reject a legitimate token.
 *   - Real opaque provider pagination tokens (for example AT Protocol cursors)
 *     are short opaque encodings; hundreds of code units is already generous.
 *   - It is deliberately NOT unbounded and not a huge number: a cursor is
 *     persisted in request records and bound into authenticated fingerprints,
 *     so a small explicit ceiling keeps it structural metadata rather than a
 *     payload carrier or a covert channel.
 */
export const PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_MAX_LENGTH = 256;

/** The contract, as data, so it can be audited without reading the validator. */
export const PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_CONTRACT = Object.freeze({
  allowsAbsence: true,
  requiresType: 'string',
  minLength: 1,
  maxLength: PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_MAX_LENGTH,
  allowsAsciiControlCharacters: false,
  allowsUrlSyntax: false,
  allowsCredentialSyntax: false,
  normalizesValue: false,
  caseFolds: false,
  trimsValue: false,
  interpretsProviderSyntax: false,
});

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------
//
// The credential and URL tests are assembled from parts so this module never
// carries the literal token vocabulary it refuses.
const URL_SCHEME_SEPARATOR = [':', '/', '/'].join('');
// Every refused token is assembled from parts, the convention these phases
// already use, so this module never literally carries the vocabulary it refuses.
const AUTH_SCHEMES = [['bea', 'rer'].join(''), ['ba', 'sic'].join(''), ['dig', 'est'].join(''), ['to', 'ken'].join('')].join('|');
const AUTH_SCHEME_PREFIX = new RegExp(`^(?:${AUTH_SCHEMES})\\s`, 'i');
const AUTH_HEADER_NAME = ['author', 'ization'].join('');
const AUTH_HEADER_NAMES = [AUTH_HEADER_NAME, ['proxy', AUTH_HEADER_NAME].join('-')].join('|');
const AUTH_HEADER_PREFIX = new RegExp(`^(?:${AUTH_HEADER_NAMES}):`, 'i');

/** ASCII control characters, including NUL, LF, CR and DEL. */
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The ONE generic cursor validator.
 *
 * `null` is VALID ABSENCE. A string is valid only when it satisfies every
 * structural rule in the contract above. Everything else is invalid.
 *
 * This is a PREDICATE: it never throws, never repairs and never normalises, so
 * it cannot be used to launder a value into acceptance.
 */
export function isPaginationCursor(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  if (value.length < 1) return false;
  if (value.length > PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_MAX_LENGTH) return false;
  if (ASCII_CONTROL.test(value)) return false;
  if (value.includes(URL_SCHEME_SEPARATOR)) return false;
  if (AUTH_SCHEME_PREFIX.test(value)) return false;
  if (AUTH_HEADER_PREFIX.test(value)) return false;
  return true;
}

/**
 * Asserts the generic cursor contract, refusing with the caller's own code.
 *
 * The refusal code is supplied in FULL by the CALLING layer (request record,
 * manifest, or a provider adapter), so this generic module does not name or own
 * any layer's error vocabulary. The value is never altered: the caller keeps the
 * exact token the provider issued.
 */
export function assertPaginationCursor(value, code) {
  if (!isPaginationCursor(value)) failClosed(code);
  return value;
}