import { describe, it, expect, jest } from '@jest/globals';
import { classifyCandidate } from '../../src/discovery/engine/classifierBridge.js';
import type { NormalizedCandidate } from '../../src/discovery/types.js';
import type { ResolvedWork, ReverseExtractorResult } from '../../src/classifier/types.js';

const baseCandidate = (over: Partial<NormalizedCandidate> = {}): NormalizedCandidate => ({
  source: 'openalex',
  doi: '10.1037/abc',
  title: 'A direct replication of Smith (2015)',
  abstract: 'We replicated...',
  matchedKeywords: [],
  searchScore: 0,
  ...over,
});

const fakeResolvedWork = (over: Partial<ResolvedWork> = {}): ResolvedWork => ({
  doi: '10.1037/abc',
  title: 'A direct replication of Smith (2015)',
  authors: 'Doe, J',
  venue: 'JESP',
  year: 2021,
  abstract: 'We replicated Smith.',
  referencedWorks: [],
  sourcesQueried: [],
  providerReports: [],
  fieldProvenance: {},
  ...over,
});

describe('classifyCandidate', () => {
  it('returns needs_more_metadata when both title and abstract are blank', async () => {
    const v = await classifyCandidate(baseCandidate({ title: '', abstract: '' }), {
      resolveWorkFn: jest.fn() as never,
      classifyFn: jest.fn() as never,
    });
    expect(v.status).toBe('needs_more_metadata');
    expect(v.result).toBeNull();
  });

  it('returns needs_more_metadata when resolveWork returns null', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => null)) as never,
      classifyFn: jest.fn() as never,
    });
    expect(v.status).toBe('needs_more_metadata');
  });

  it('returns rejected when classifier says isReplication=false', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => fakeResolvedWork())) as never,
      classifyFn: ((): ReverseExtractorResult => ({
        replicationDoi: '10.1037/abc',
        isReplication: false,
        targets: [],
      })) as never,
    });
    expect(v.status).toBe('rejected');
  });

  it('returns needs_more_metadata when isReplication=true but no targets', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => fakeResolvedWork())) as never,
      classifyFn: ((): ReverseExtractorResult => ({
        replicationDoi: '10.1037/abc',
        isReplication: true,
        targets: [],
      })) as never,
    });
    expect(v.status).toBe('needs_more_metadata');
  });

  it('returns accepted with single unambiguous target', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => fakeResolvedWork())) as never,
      classifyFn: ((): ReverseExtractorResult => ({
        replicationDoi: '10.1037/abc',
        isReplication: true,
        targets: [
          {
            originalDoi: '10.1037/orig',
            originalReferenceExtracted: 'Smith (2015)',
            justificationPhrase: 'A direct replication of Smith (2015)',
            outcomePhrase: 'we replicated',
            outcome: 'successful',
            confidence: 'high',
            evidence: ['A direct replication of Smith (2015)'],
            signalProvenance: ['back-ref-confirmed', 'phrase-in-title'],
          },
        ],
      })) as never,
    });
    expect(v.status).toBe('accepted');
  });

  it('returns ambiguous when any target is ambiguous', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => fakeResolvedWork())) as never,
      classifyFn: ((): ReverseExtractorResult => ({
        replicationDoi: '10.1037/abc',
        isReplication: true,
        targets: [
          {
            originalDoi: '10.1037/orig',
            originalReferenceExtracted: 'Smith (2015)',
            justificationPhrase: 'X',
            outcomePhrase: '',
            outcome: 'unknown',
            confidence: 'medium',
            evidence: [],
            signalProvenance: [],
            ambiguous: true,
          },
        ],
      })) as never,
    });
    expect(v.status).toBe('ambiguous');
  });

  it('returns errored when classifier throws', async () => {
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => fakeResolvedWork())) as never,
      classifyFn: ((): ReverseExtractorResult => {
        throw new Error('boom');
      }) as never,
    });
    expect(v.status).toBe('errored');
    expect(v.result).toBeNull();
  });

  it('survives metadata resolver throwing (treats as missing references)', async () => {
    const calls: string[] = [];
    const v = await classifyCandidate(baseCandidate(), {
      resolveWorkFn: (jest.fn(async () => {
        throw new Error('network');
      })) as never,
      classifyFn: ((input: any): ReverseExtractorResult => {
        calls.push(JSON.stringify(input.referencedWorks));
        return { replicationDoi: '10.1037/abc', isReplication: true, targets: [] };
      }) as never,
    });
    expect(v.status).toBe('needs_more_metadata');
    expect(calls).toEqual(['[]']); // classifier was called with empty references
  });
});
