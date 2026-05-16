// apps/worker/tests/replication/openAlexClient.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosMock = {
  get: jest.fn<any>(),
  isAxiosError: jest.fn<any>(),
};

jest.unstable_mockModule('axios', () => ({
  default: axiosMock,
  isAxiosError: axiosMock.isAxiosError,
}));

const { getWork, getCitingWorks } = await import('../../src/metadata/openAlexClient.js');

describe('openAlexClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Note: repliscan reads no env vars; creds are passed as parameters.
    // The env var set here is kept for documentation but has no effect.
    process.env.OPENALEX_API_KEY = 'test-key';
  });

  it('getWork returns normalized shape', async () => {
    // First call: work by DOI
    axiosMock.get.mockResolvedValueOnce({
      data: {
        doi: 'https://doi.org/10.1/abc',
        title: 'A Replication Study',
        abstract_inverted_index: { 'We': [0], 'replicated': [1], 'Smith': [2] },
        referenced_works: ['W1', 'W2'],
      },
    });
    // Second call: batch get referenced works
    axiosMock.get.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'W1',
            doi: 'https://doi.org/10.1/smith-2010',
            title: 'Smith Original',
            publication_year: 2010,
            authorships: [{ author: { display_name: 'John Smith' }, author_position: 'first' }],
          },
        ],
      },
    });

    const work = await getWork('10.1/abc');
    expect(work?.doi).toBe('10.1/abc');
    expect(work?.title).toBe('A Replication Study');
    expect(work?.abstract).toBe('We replicated Smith');
    expect(work?.referencedWorks).toHaveLength(1);
    expect(work?.referencedWorks[0].doi).toBe('10.1/smith-2010');
  });

  it('getWork returns null on 404', async () => {
    const err = { isAxiosError: true, response: { status: 404 } };
    axiosMock.get.mockRejectedValueOnce(err);
    axiosMock.isAxiosError.mockReturnValue(true);

    const work = await getWork('10.1/missing');
    expect(work).toBeNull();
  });

  it('getCitingWorks returns target metadata + candidates with raw ref IDs', async () => {
    // 1) Resolve DOI -> target work (with authorships + year for synthetic ref)
    axiosMock.get.mockResolvedValueOnce({
      data: {
        id: 'https://openalex.org/W100',
        publication_year: 2010,
        authorships: [{ author_position: 'first', author: { display_name: 'Jane Carney' } }],
      },
    });
    // 2) Fetch candidates that cite W100
    axiosMock.get.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'https://openalex.org/W10',
            doi: 'https://doi.org/10.1/r1',
            title: 'A replication of X',
            abstract_inverted_index: null,
            referenced_works: ['https://openalex.org/W100', 'https://openalex.org/W2'],
          },
        ],
      },
    });

    const result = await getCitingWorks('10.1/original');
    expect(result.targetWorkId).toBe('W100');
    expect(result.targetFirstAuthor).toBe('Carney');
    expect(result.targetYear).toBe(2010);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].referencedWorkIds).toEqual(['W100', 'W2']);
    expect(result.candidates[0].doi).toBe('10.1/r1');

    const secondCallArgs = axiosMock.get.mock.calls[1];
    expect((secondCallArgs[1] as any).params.filter).toContain('cites:W100');
    expect((secondCallArgs[1] as any).params.filter).toContain('default.search:replication');
  });

  it('getCitingWorks returns empty result on 404 when resolving DOI', async () => {
    axiosMock.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    axiosMock.isAxiosError.mockReturnValue(true);

    const result = await getCitingWorks('10.1/nonexistent');
    expect(result.targetWorkId).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
