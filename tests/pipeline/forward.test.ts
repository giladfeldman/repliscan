// Ported from the Scimeto worker's forwardFinder tests when the pipeline moved into the library.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// The metadata providers are the only I/O the pipeline performs: mock them, keep the real classifier.
jest.unstable_mockModule('../../src/metadata/openAlexClient.js', () => ({
  getCitingWorks: jest.fn<any>().mockResolvedValue({ targetWorkId: null, candidates: [] }),
}));
jest.unstable_mockModule('../../src/metadata/metadataResolver.js', () => ({
  resolveWorkDetailed: jest.fn<any>().mockResolvedValue({ work: null, sourcesQueried: [], providerReports: [] }),
}));

const { findReplicationsForDoi } = await import('../../src/pipeline/forward.js');
const { getCitingWorks } = await import('../../src/metadata/openAlexClient.js');

describe('findReplicationsForDoi', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns empty when no candidates + no FReD hit', async () => {
    (getCitingWorks as any).mockResolvedValue({ targetWorkId: 'W0', targetFirstAuthor: 'X', targetYear: 2010, candidates: [] });
    const r = await findReplicationsForDoi('10.1234/original', { floraHit: null });
    expect(r.targets).toEqual([]);
  });

  it('rejects invalid DOI', async () => {
    const r = await findReplicationsForDoi('not-a-doi', { floraHit: null });
    expect(r.targets).toEqual([]);
    expect(getCitingWorks).not.toHaveBeenCalled();
  });

  it('returns FReD hit with replicationDoi populated', async () => {
    const flora = {
      metadata: {
        replicationDetails: [{ doi: '10.1234/repl', outcomeType: 'failed', outcomeQuote: 'failed to replicate', authors: 'X', year: 2015 }],
      },
    };
    const r = await findReplicationsForDoi('10.1234/original', { floraHit: flora as any });
    expect(r.targets.length).toBeGreaterThan(0);
    expect(r.targets[0].confidence).toBe('high');
    expect(r.targets[0].replicationDoi).toBe('10.1234/repl');
    expect(r.targets[0].signalProvenance).toContain('fred');
  });

  it('promotes citation-graph candidate with back-ref ID match', async () => {
    (getCitingWorks as any).mockResolvedValue({
      targetWorkId: 'W0',
      targetFirstAuthor: 'Smith',
      targetYear: 2010,
      candidates: [
        {
          openalexId: 'W1',
          doi: '10.1234/r1',
          title: 'A direct replication of Smith et al. (2010)',
          abstract: 'We failed to replicate.',
          referencedWorkIds: ['W0', 'W99'],  // contains target
        },
      ],
    });
    const r = await findReplicationsForDoi('10.1234/original', { floraHit: null });
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].outcome).toBe('failed');
    expect(r.targets[0].confidence).toBe('high');
    expect(r.targets[0].replicationDoi).toBe('10.1234/r1');
  });

  it('drops candidate whose referenced_works do not include target W-id', async () => {
    (getCitingWorks as any).mockResolvedValue({
      targetWorkId: 'W0',
      targetFirstAuthor: 'Smith',
      targetYear: 2010,
      candidates: [
        {
          openalexId: 'W1',
          doi: '10.1234/r1',
          title: 'A replication of something',
          abstract: 'We replicated something.',
          referencedWorkIds: ['W99', 'W88'],  // does NOT contain target
        },
      ],
    });
    const r = await findReplicationsForDoi('10.1234/original', { floraHit: null });
    expect(r.targets).toEqual([]);
  });
});
