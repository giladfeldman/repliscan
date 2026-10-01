// Ported from the Scimeto worker's reverseExtractor tests when the pipeline moved into the library.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/metadata/metadataResolver.js', () => ({
  resolveWork: jest.fn(),
}));
jest.unstable_mockModule('../../src/classifier/classifier.js', () => ({
  classifyReplication: jest.fn(),
}));

const { extractReplication } = await import('../../src/pipeline/reverse.js');
const { resolveWork } = await import('../../src/metadata/metadataResolver.js') as any;
const { classifyReplication } = await import('../../src/classifier/classifier.js') as any;
const getCached = jest.fn<any>().mockResolvedValue(null);
const putCached = jest.fn<any>().mockResolvedValue(undefined);
const cache = { get: getCached, put: putCached };

describe('extractReplication', () => {
  beforeEach(() => { jest.clearAllMocks(); getCached.mockResolvedValue(null); });

  it('returns isReplication=false when no phrase found', async () => {
    (resolveWork as any).mockResolvedValue({
      doi: '10.1/x', title: 'A study on attitudes', abstract: 'Nothing here.', referencedWorks: [],
    });
    // classifyReplication returns false when no replication phrase is present
    classifyReplication.mockReturnValue({ replicationDoi: '10.1/x', isReplication: false, targets: [] });
    const r = await extractReplication('10.1/x', { cache });
    expect(r.isReplication).toBe(false);
    expect(putCached).toHaveBeenCalled();
  });

  it('returns finding when phrase + target + back-ref match', async () => {
    (resolveWork as any).mockResolvedValue({
      doi: '10.1/repl',
      title: 'A direct replication of Carney et al. (2010)',
      abstract: 'We failed to replicate the original.',
      referencedWorks: [{ openalexId: 'W1', doi: '10.1/carney-2010', firstAuthor: 'Carney', year: 2010 }],
    });
    classifyReplication.mockReturnValue({
      replicationDoi: '10.1/repl',
      isReplication: true,
      targets: [{
        originalDoi: '10.1/carney-2010',
        confidence: 'high',
        outcome: 'failed',
        evidence: ['title-phrase'],
        signalProvenance: ['title'],
        originalReferenceExtracted: 'Carney et al. (2010)',
        justificationPhrase: 'direct replication of Carney et al. (2010)',
        outcomePhrase: 'failed to replicate',
      }],
    });
    const r = await extractReplication('10.1/repl', { cache });
    expect(r.isReplication).toBe(true);
    expect(r.targets[0].originalDoi).toBe('10.1/carney-2010');
    expect(r.targets[0].confidence).toBe('high');
  });

  it('returns cached result without calling resolveWork', async () => {
    getCached.mockResolvedValue({ replicationDoi: '10.1/repl', isReplication: false, targets: [] });
    const r = await extractReplication('10.1/repl', { cache });
    expect(r.isReplication).toBe(false);
    expect(resolveWork).not.toHaveBeenCalled();
  });

  it('returns isReplication=false when resolveWork returns null', async () => {
    (resolveWork as any).mockResolvedValue(null);
    const r = await extractReplication('10.1/missing', { cache });
    expect(r.isReplication).toBe(false);
    expect(r.targets).toEqual([]);
  });
});
