/**
 * outcomeClassification regression tests (the platform's hardening workflow, 2026-06-08).
 *
 * D2: ES_COLLAPSE_RE used `[\s\S]{0,220}` which spanned sentence boundaries, so
 *     two unrelated effects in different sentences were read as an effect-size
 *     collapse -> false 'failed'. Now `[^.!?]` keeps the comparison in-sentence.
 * D1: splitSentences split on "(", turning "Author et al. (year) failed..." into
 *     an orphan "(year) failed..." fragment and corrupting sentence context.
 */
import { describe, it, expect } from '@jest/globals';
import { classifyOutcome } from '../../src/classifier/outcomeClassification.js';

describe('classifyOutcome — effect-size collapse sentence boundary (D2)', () => {
  it('does NOT flag a collapse across a sentence boundary', () => {
    const r = classifyOutcome(
      'The original study reported d = 0.50. In an unrelated robustness check, d = 0.02.',
    );
    expect(r.outcome).toBe('unknown');
  });

  it('still flags a within-sentence collapse', () => {
    const r = classifyOutcome(
      'The original effect was d = 0.50 but our replication produced only d = 0.02.',
    );
    expect(r.outcome).toBe('failed');
  });
});

describe('classifyOutcome — sentence split keeps "Author et al. (year)" intact (D1)', () => {
  it('reports the full sentence, not an orphan "(year) ..." fragment', () => {
    const r = classifyOutcome(
      'Smith et al. (2010) failed to replicate the anchoring effect.',
    );
    expect(r.outcome).toBe('failed');
    // Before the fix the sentence was the orphan "(2010) failed..." fragment.
    expect(r.sentence).toContain('Smith et al.');
  });
});
