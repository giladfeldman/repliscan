import { describe, it, expect } from '@jest/globals';
import { scoreConfidence } from '../../src/classifier/confidence.js';

describe('scoreConfidence', () => {
  it('FReD hit is HIGH', () => {
    expect(scoreConfidence({ fredHit: true })).toBe('high');
  });
  it('back-ref + title phrase is HIGH', () => {
    expect(scoreConfidence({ backRefConfirmed: true, phraseInTitle: true })).toBe('high');
  });
  it('back-ref + abstract-only phrase is MEDIUM', () => {
    expect(scoreConfidence({ backRefConfirmed: true, phraseInAbstract: true })).toBe('medium');
  });
  it('ambiguous resolution is MEDIUM at best', () => {
    expect(scoreConfidence({ backRefConfirmed: true, phraseInTitle: true, ambiguous: true })).toBe('medium');
  });
  it('fuzzy FReD match is MEDIUM', () => {
    expect(scoreConfidence({ fredFuzzyHit: true })).toBe('medium');
  });
  it('phrase alone with no back-ref is LOW', () => {
    expect(scoreConfidence({ phraseInAbstract: true })).toBe('low');
  });
  it('nothing is LOW', () => {
    expect(scoreConfidence({})).toBe('low');
  });
});
