import { createHash } from 'node:crypto';

/**
 * Stable JSON serialization with object keys sorted recursively, array order preserved.
 *
 * Contract: input must be JSON-serializable plain data — `null`, finite numbers, booleans,
 * strings, arrays, and plain objects with string keys.
 *
 * NOT supported (undefined behavior):
 * - `undefined` (top-level throws; as a property value it is silently dropped, which
 *   means `{a:1,b:undefined}` and `{a:1}` hash to the same value)
 * - Non-finite numbers (`NaN`, `Infinity`) — `JSON.stringify` coerces these to `null`,
 *   producing collision risk with actual `null` values
 * - `Date`, `Map`, `Set`, `BigInt`, `Symbol`, class instances — serialized incorrectly
 *   or throw at runtime
 * - Circular references — cause stack overflow
 *
 * Used to produce stable hashes for `EffectiveSpec` snapshots. Callers must ensure
 * their input is plain JSON-native data; this function does not validate or coerce.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalJsonStringify: undefined is not a supported value');
  }
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * sha256 (lowercase hex) of {@link canonicalJsonStringify}(value). Two values that
 * canonicalize identically produce the same hash. See `canonicalJsonStringify` for
 * the input contract.
 */
export function hashSpec(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}
