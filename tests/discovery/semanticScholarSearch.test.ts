import { describe, it, expect, jest } from '@jest/globals';
import { SemanticScholarSourceAdapter } from '../../src/discovery/engine/sources/semanticScholarSearch.js';
import type { ExpandedKeyword, RunFilters } from '../../src/discovery/types.js';

const KW: ExpandedKeyword[] = [
  { id: 'REP_OF', permutation: 'replication of', weight: 1.0, fields: ['title', 'abstract'] },
];

const FILTERS: RunFilters = {
  yearFrom: 2023,
  yearTo: 2023,
  languages: ['en'],
  sources: ['semantic_scholar'],
  maxCandidatesPerSource: 50,
  skipDoisInFlora: false,
};

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  json: async () => body,
});

const tooManyRequests = (retryAfter = '0') => ({
  ok: false,
  status: 429,
  headers: new Map([['Retry-After', retryAfter]]),
  json: async () => ({}),
});

describe('SemanticScholarSourceAdapter', () => {
  it('builds OR-bundled query with pipe operator', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        total: 1,
        offset: 0,
        next: undefined,
        data: [
          {
            paperId: 'abc123',
            title: 'A direct replication of Smith (2015)',
            abstract: 'We replicated...',
            year: 2023,
            authors: [{ name: 'Doe, J' }],
            externalIds: { DOI: '10.1037/abc' },
            venue: 'JESP',
          },
        ],
      }) as never,
    );

    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'test-key',
      verifiedAt: new Date('2026-05-04'),
      ratePerSec: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const gen = adapter.search({
      keywords: [
        ...KW,
        { id: 'DIRECT_REP', permutation: 'direct replication', weight: 0.95, fields: ['title', 'abstract'] },
      ],
      filters: FILTERS,
    });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.candidates).toHaveLength(1);
    expect(first.value!.candidates[0].doi).toBe('10.1037/abc');

    const url = decodeURIComponent(fetchFn.mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(url).toContain('"replication of"');
    expect(url).toContain('"direct replication"');
    expect(url).toContain(' | '); // S2 uses pipe for OR
    expect(url).toContain('year=2023-2023');
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
    });
  });

  it('paginates via offset using next field', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(okJson({ next: 100, data: [] }) as never)
      .mockResolvedValueOnce(okJson({ next: undefined, data: [] }) as never);

    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: KW, filters: FILTERS });
    const first = await gen.next();
    expect(first.value!.nextCursor).toBe('100');
    const second = await gen.next();
    expect(second.value?.nextCursor).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url2 = decodeURIComponent(fetchFn.mock.calls[1][0] as string);
    expect(url2).toContain('offset=100');
  });

  it('handles 429 by retrying same offset', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(tooManyRequests('0') as never)
      .mockResolvedValueOnce(okJson({ data: [] }) as never);

    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: KW, filters: FILTERS });
    await gen.next();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws after 3 consecutive 429s', async () => {
    const fetchFn = jest.fn().mockResolvedValue(tooManyRequests('0') as never);
    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: KW, filters: FILTERS });
    await expect(gen.next()).rejects.toThrow(/threshold exceeded/);
  });

  it('respects maxTotal cap', async () => {
    const fetchFn = jest.fn().mockImplementation(async () => okJson({ next: 100, data: [] }));

    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 5,
      maxTotal: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: KW, filters: FILTERS });
    let pages = 0;
    for await (const _ of gen) pages++;
    expect(pages).toBe(1);
  });

  it('drops papers without externalIds.DOI', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        next: undefined,
        data: [
          { paperId: '1', title: 'no doi', externalIds: {} },
          { paperId: '2', title: 'has doi', externalIds: { DOI: '10.1/x' } },
        ],
      }) as never,
    );
    const adapter = new SemanticScholarSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 1,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { value } = await adapter.search({ keywords: KW, filters: FILTERS }).next();
    expect(value!.candidates).toHaveLength(1);
    expect(value!.candidates[0].doi).toBe('10.1/x');
  });
});
