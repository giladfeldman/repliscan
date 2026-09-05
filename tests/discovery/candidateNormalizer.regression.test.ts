/**
 * candidateNormalizer.normalizeDoi regression test (the platform's hardening workflow,
 * 2026-06-08).
 *
 * D4: the local normalizeDoi diverged from the canonical util/normalizeDoi — it
 * skipped URL-decoding and trailing-dot stripping, so a URL-encoded or
 * trailing-dot candidate DOI did not dedup against its clean resolved form. It
 * now delegates to the canonical helper.
 */
import { describe, it, expect } from '@jest/globals';
import { normalizeDoi } from '../../src/discovery/engine/candidateNormalizer.js';

describe('candidateNormalizer.normalizeDoi (D4 — delegates to canonical)', () => {
  it('URL-decodes an encoded slash so encoded and clean DOIs dedup', () => {
    expect(normalizeDoi('10.1234%2Fabc')).toBe('10.1234/abc');
  });

  it('strips a trailing dot', () => {
    expect(normalizeDoi('10.1234/abc.')).toBe('10.1234/abc');
  });

  it('still strips URL prefixes and lowercases', () => {
    expect(normalizeDoi('https://doi.org/10.1234/ABC')).toBe('10.1234/abc');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeDoi('')).toBe('');
  });
});
