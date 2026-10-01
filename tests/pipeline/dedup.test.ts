/**
 * dedupFindings — outcome-merge regression tests.
 *
 * Regression for defect D8 (2026-06-08): OUTCOME_RANK tied
 * `mixed` and `successful` at 2, so merging two findings for the same DOI
 * resolved the tie by iteration order — a partial ("mixed") replication could
 * surface to the user as a clean "successful" one. `successful` is now ranked
 * below `mixed`, so the merge is deterministic and conservative.
 */
import { describe, it, expect } from '@jest/globals';
import { dedupFindings } from '../../src/pipeline/forward.js';

function finding(over: Record<string, unknown> = {}) {
  return {
    originalDoi: '10.1/orig',
    replicationDoi: '10.1/rep',
    outcome: 'unknown',
    confidence: 'medium',
    outcomePhrase: '',
    signalProvenance: [] as string[],
    evidence: [] as string[],
    justificationPhrase: '',
    ...over,
  };
}

describe('dedupFindings — conservative outcome merge (D8)', () => {
  it('keeps "mixed" over "successful" regardless of iteration order', () => {
    const a = dedupFindings([finding({ outcome: 'successful' }), finding({ outcome: 'mixed' })] as any);
    const b = dedupFindings([finding({ outcome: 'mixed' }), finding({ outcome: 'successful' })] as any);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].outcome).toBe('mixed');
    expect(b[0].outcome).toBe('mixed'); // before D8 this merged to 'successful'
  });

  it('"failed" still wins over everything', () => {
    const r = dedupFindings([finding({ outcome: 'successful' }), finding({ outcome: 'failed' })] as any);
    expect(r[0].outcome).toBe('failed');
  });

  it('unions signal provenance and evidence across merged findings', () => {
    const r = dedupFindings([
      finding({ outcome: 'successful', signalProvenance: ['fred'], evidence: ['e1'] }),
      finding({ outcome: 'mixed', signalProvenance: ['openalex'], evidence: ['e2'] }),
    ] as any);
    expect(r[0].signalProvenance.sort()).toEqual(['fred', 'openalex']);
    expect(r[0].evidence.sort()).toEqual(['e1', 'e2']);
  });

  it('keeps findings with distinct replication DOIs separate', () => {
    const r = dedupFindings([
      finding({ replicationDoi: '10.1/a' }),
      finding({ replicationDoi: '10.1/b' }),
    ] as any);
    expect(r).toHaveLength(2);
  });

  it('does not merge no-DOI ("na") findings', () => {
    const r = dedupFindings([
      finding({ replicationDoi: 'na' }),
      finding({ replicationDoi: 'na' }),
    ] as any);
    expect(r).toHaveLength(2);
  });
});
