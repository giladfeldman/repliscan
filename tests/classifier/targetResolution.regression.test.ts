/**
 * targetResolution regression test (the platform's hardening workflow, 2026-06-08).
 *
 * D5: resolveTarget compared the FULL reference firstAuthor against the
 * prefix-stripped extracted last name, so a nobiliary-prefix surname stored as
 * "de Groot" never matched the extracted "Groot" (the author-year regex skips
 * the lowercase "de"). Now both sides compare on their final name token.
 */
import { describe, it, expect } from '@jest/globals';
import { resolveTarget } from '../../src/classifier/targetResolution.js';
import type { ExtractedTarget, OpenAlexWork } from '../../src/classifier/types.js';

function target(last: string, year: number): ExtractedTarget {
  return { firstAuthorLastName: last, year, authorYearString: `${last} (${year})`, sentence: '' };
}

describe('resolveTarget — nobiliary-prefix surnames (D5)', () => {
  const refs: OpenAlexWork['referencedWorks'] = [
    { openalexId: 'W9', doi: '10.1/degroot-2018', firstAuthor: 'de Groot', year: 2018 },
    { openalexId: 'W10', doi: '10.1/vandenberg-2019', firstAuthor: 'van den Berg', year: 2019 },
  ];

  it('matches "Groot" against a reference stored as "de Groot"', () => {
    const r = resolveTarget(target('Groot', 2018), refs);
    expect(r.originalDoi).toBe('10.1/degroot-2018');
    expect(r.matchCount).toBe(1);
  });

  it('matches "Berg" against a reference stored as "van den Berg"', () => {
    const r = resolveTarget(target('Berg', 2019), refs);
    expect(r.originalDoi).toBe('10.1/vandenberg-2019');
  });
});
