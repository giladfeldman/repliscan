import { describe, it, expect } from '@jest/globals';
import { resolveTarget } from '../../src/classifier/targetResolution.js';
import type { ExtractedTarget, OpenAlexWork } from '../../src/classifier/types.js';

const refs: OpenAlexWork['referencedWorks'] = [
  { openalexId: 'W1', doi: '10.1/carney-2010', firstAuthor: 'Carney', year: 2010 },
  { openalexId: 'W2', doi: '10.1/smith-2015', firstAuthor: 'Smith', year: 2015 },
  { openalexId: 'W3', doi: '10.1/smith-2014', firstAuthor: 'Smith', year: 2014 },
];

function target(last: string, year: number): ExtractedTarget {
  return { firstAuthorLastName: last, year, authorYearString: `${last} (${year})`, sentence: '' };
}

describe('resolveTarget', () => {
  it('resolves exact match unambiguously', () => {
    const r = resolveTarget(target('Carney', 2010), refs);
    expect(r.originalDoi).toBe('10.1/carney-2010');
    expect(r.ambiguous).toBe(false);
    expect(r.matchCount).toBe(1);
  });

  it('allows ±1 year fuzz', () => {
    const r = resolveTarget(target('Carney', 2011), refs);
    expect(r.originalDoi).toBe('10.1/carney-2010');
    expect(r.matchCount).toBe(1);
  });

  it('flags ambiguous when multiple authors match within year window', () => {
    const r = resolveTarget(target('Smith', 2015), refs);
    expect(r.ambiguous).toBe(true);
    expect(r.matchCount).toBe(2);
    expect(r.originalDoi).toBe('10.1/smith-2015'); // exact year wins
  });

  it('returns null when no match', () => {
    const r = resolveTarget(target('Jones', 2018), refs);
    expect(r.originalDoi).toBeNull();
    expect(r.matchCount).toBe(0);
  });

  it('last-name match is case-insensitive', () => {
    const r = resolveTarget(target('CARNEY', 2010), refs);
    expect(r.originalDoi).toBe('10.1/carney-2010');
  });
});
