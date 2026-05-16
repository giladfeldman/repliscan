// apps/worker/tests/replication/classifier.test.ts
import { describe, it, expect } from '@jest/globals';
import { classifyReplication } from '../../src/classifier/classifier.js';
import type { ReplicationClassifierInput } from '../../src/classifier/types.js';

const baseRefs = [
  { openalexId: 'W1', doi: '10.1/carney-2010', firstAuthor: 'Carney', year: 2010 },
];

describe('classifyReplication', () => {
  it('returns empty targets when no replication phrase', () => {
    const input: ReplicationClassifierInput = {
      doi: '10.1/x', title: 'A study on attitudes', abstract: 'We surveyed undergraduates.', referencedWorks: baseRefs,
    };
    const r = classifyReplication(input);
    expect(r.isReplication).toBe(false);
    expect(r.targets).toEqual([]);
  });

  it('produces HIGH finding with title phrase + back-ref + unambiguous target', () => {
    const input: ReplicationClassifierInput = {
      doi: '10.1/replication',
      title: 'A direct replication of Carney et al. (2010)',
      abstract: 'We failed to replicate the original finding.',
      referencedWorks: baseRefs,
    };
    const r = classifyReplication(input);
    expect(r.isReplication).toBe(true);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].confidence).toBe('high');
    expect(r.targets[0].outcome).toBe('failed');
    expect(r.targets[0].originalDoi).toBe('10.1/carney-2010');
    expect(r.targets[0].signalProvenance).toContain('back-ref-confirmed');
  });

  it('produces MEDIUM finding when phrase only in abstract', () => {
    const input: ReplicationClassifierInput = {
      doi: '10.1/replication',
      title: 'A study on power posing',
      abstract: 'We conducted a replication of Carney et al. (2010) and failed to replicate.',
      referencedWorks: baseRefs,
    };
    const r = classifyReplication(input);
    expect(r.targets[0].confidence).toBe('medium');
  });

  it('drops LOW findings (no back-ref)', () => {
    const input: ReplicationClassifierInput = {
      doi: '10.1/replication',
      title: 'A direct replication of Jones et al. (2018)',  // Jones not in refs
      abstract: 'We failed to replicate.',
      referencedWorks: baseRefs,
    };
    const r = classifyReplication(input);
    expect(r.isReplication).toBe(true);
    expect(r.targets).toEqual([]);
  });

  it('vague replication with no target returns isReplication=true, targets=[]', () => {
    const input: ReplicationClassifierInput = {
      doi: '10.1/x',
      title: 'A replication of prior findings on social priming',
      abstract: 'We tested several effects.',
      referencedWorks: baseRefs,
    };
    const r = classifyReplication(input);
    expect(r.isReplication).toBe(true);
    expect(r.targets).toEqual([]);
  });
});
