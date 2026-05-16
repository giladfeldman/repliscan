import { canonicalJsonStringify, hashSpec } from '../../../src/discovery/spec/canonical.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('preserves array order (arrays are ordered data)', () => {
    expect(canonicalJsonStringify({ x: [3, 1, 2] })).toBe('{"x":[3,1,2]}');
  });
  it('recurses into nested structures', () => {
    expect(canonicalJsonStringify({ z: { b: 1, a: 2 }, a: [4, 3] })).toBe('{"a":[4,3],"z":{"a":2,"b":1}}');
  });
  it('serializes null, true, false, numbers, strings unchanged', () => {
    expect(canonicalJsonStringify({ n: null, t: true, f: false, i: 1, s: 'hi' })).toBe(
      '{"f":false,"i":1,"n":null,"s":"hi","t":true}',
    );
  });
});

describe('hashSpec', () => {
  it('returns the same sha256 for two equivalent specs with different key order', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(hashSpec(a)).toBe(hashSpec(b));
  });
  it('returns different hashes for different specs', () => {
    expect(hashSpec({ x: 1 })).not.toBe(hashSpec({ x: 2 }));
  });
  it('returns a 64-char hex string', () => {
    expect(hashSpec({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('canonicalJsonStringify edge cases (documented behavior)', () => {
  it('throws on top-level undefined', () => {
    expect(() => canonicalJsonStringify(undefined)).toThrow(/undefined is not a supported value/);
  });

  it('drops undefined property values (collision: same hash as object without that key)', () => {
    // This is JSON.stringify's behavior. Documented as a contract limitation, not a bug.
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(hashSpec({ a: 1, b: undefined })).toBe(hashSpec({ a: 1 }));
  });

  it('coerces NaN/Infinity to null (collision risk with actual null)', () => {
    expect(canonicalJsonStringify({ x: NaN })).toBe('{"x":null}');
    expect(canonicalJsonStringify({ x: Infinity })).toBe('{"x":null}');
    expect(hashSpec({ x: NaN })).toBe(hashSpec({ x: null }));
  });
});
