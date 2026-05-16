import { describe, it, expect } from '@jest/globals';
import { extractTargets } from '../../src/classifier/targetExtraction.js';

describe('extractTargets', () => {
  it('extracts Author et al. (Year) pattern', () => {
    const targets = extractTargets('We conducted a replication of Carney et al. (2010).');
    expect(targets).toHaveLength(1);
    expect(targets[0].firstAuthorLastName).toBe('Carney');
    expect(targets[0].year).toBe(2010);
    expect(targets[0].authorYearString).toContain('Carney');
  });

  it('extracts Author & Author (Year) pattern', () => {
    const targets = extractTargets('A replication of Smith & Jones (2018) was conducted.');
    expect(targets).toHaveLength(1);
    expect(targets[0].firstAuthorLastName).toBe('Smith');
    expect(targets[0].year).toBe(2018);
  });

  it('extracts single Author (Year)', () => {
    const targets = extractTargets('We replicate Williams (2020) in a larger sample.');
    expect(targets[0].firstAuthorLastName).toBe('Williams');
    expect(targets[0].year).toBe(2020);
  });

  it('extracts multiple distinct targets', () => {
    const targets = extractTargets('We replicate Smith (2015) and Jones et al. (2017).');
    expect(targets).toHaveLength(2);
  });

  it('deduplicates identical targets', () => {
    const targets = extractTargets('Carney et al. (2010) found... We replicate Carney et al. (2010).');
    expect(targets).toHaveLength(1);
  });

  it('returns empty array for text with no author-year pattern', () => {
    expect(extractTargets('This paper discusses replication broadly.')).toEqual([]);
  });

  it('captures the source sentence', () => {
    const targets = extractTargets('Sentence one. We replicate Smith (2015). Sentence three.');
    expect(targets[0].sentence).toContain('Smith (2015)');
  });
});
