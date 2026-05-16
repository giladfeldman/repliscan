import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { OpenAlexSourceAdapter } from '../../src/discovery/engine/sources/openAlexSearch.js';
import type { ExpandedKeyword, RunFilters } from '../../src/discovery/types.js';

const KW_REP_OF: ExpandedKeyword = {
  id: 'REP_OF',
  permutation: 'replication of',
  weight: 1.0,
  fields: ['title', 'abstract'],
};
const KW_DIRECT: ExpandedKeyword = {
  id: 'DIRECT_REP',
  permutation: 'direct replication',
  weight: 0.95,
  fields: ['title', 'abstract'],
};

const FILTERS: RunFilters = {
  yearFrom: 2020,
  yearTo: 2026,
  languages: ['en'],
  sources: ['openalex'],
  maxCandidatesPerSource: 50,
  skipDoisInFlora: false,
};

interface MockResponse {
  ok: boolean;
  status: number;
  headers: Map<string, string>;
  json: () => Promise<unknown>;
}

const okJson = (body: unknown): MockResponse => ({
  ok: true,
  status: 200,
  headers: new Map(),
  json: async () => body,
});

const tooManyRequests = (retryAfter = '0'): MockResponse => ({
  ok: false,
  status: 429,
  headers: new Map([['Retry-After', retryAfter]]),
  json: async () => ({}),
});

describe('OpenAlexSourceAdapter', () => {
  it('builds an OR-bundled search expression and yields candidates', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        results: [
          {
            id: 'https://openalex.org/W123',
            doi: 'https://doi.org/10.1037/abc',
            title: 'A direct replication of Smith (2015)',
            abstract_inverted_index: { replication: [3], smith: [5] },
            publication_year: 2021,
            authorships: [{ author: { display_name: 'Doe, J' } }],
            primary_location: { source: { display_name: 'JESP' } },
            language: 'en',
          },
        ],
        meta: { next_cursor: null },
      }) as never,
    );

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'test',
      verifiedAt: new Date('2026-05-04'),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const gen = adapter.search({ keywords: [KW_REP_OF, KW_DIRECT], filters: FILTERS });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.candidates).toHaveLength(1);
    expect(first.value!.candidates[0].doi).toBe('10.1037/abc');
    expect(first.value!.candidates[0].title).toBe('A direct replication of Smith (2015)');
    expect(first.value!.candidates[0].source).toBe('openalex');

    const after = await gen.next();
    expect(after.done).toBe(true);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // URLSearchParams encodes spaces as `+` and decodeURIComponent doesn't undo that
    const calledUrl = decodeURIComponent(fetchFn.mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(calledUrl).toContain('"replication of"');
    expect(calledUrl).toContain('"direct replication"');
    expect(calledUrl).toContain(' OR ');
    expect(calledUrl).toContain('publication_year:2020-2026');
    expect(calledUrl).toContain('language:en');
    expect(calledUrl).toContain('cursor=*');
  });

  it('paginates via cursor', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(okJson({ results: [], meta: { next_cursor: 'PAGE2' } }) as never)
      .mockResolvedValueOnce(okJson({ results: [], meta: { next_cursor: null } }) as never);

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });
    await gen.next();
    await gen.next();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url2 = fetchFn.mock.calls[1][0] as string;
    expect(url2).toContain('cursor=PAGE2');
  });

  it('handles 429 by halving rate, sleeping Retry-After, retrying same cursor', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(tooManyRequests('0') as never)
      .mockResolvedValueOnce(okJson({ results: [], meta: { next_cursor: null } }) as never);

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });

    const first = await gen.next();
    expect(first.done).toBe(false);
    // Both calls used the same cursor=*
    const url1 = fetchFn.mock.calls[0][0] as string;
    const url2 = fetchFn.mock.calls[1][0] as string;
    expect(url1).toContain('cursor=*');
    expect(url2).toContain('cursor=*');
  });

  it('throws after 3 consecutive 429s', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(tooManyRequests('0') as never)
      .mockResolvedValueOnce(tooManyRequests('0') as never)
      .mockResolvedValueOnce(tooManyRequests('0') as never);

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });
    await expect(gen.next()).rejects.toThrow(/threshold exceeded/);
  });

  it('skips works without DOIs', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        results: [
          { id: 'https://openalex.org/W1', doi: null, title: 'No DOI here' },
          { id: 'https://openalex.org/W2', doi: 'https://doi.org/10.1037/abc', title: 'With DOI' },
        ],
        meta: { next_cursor: null },
      }) as never,
    );

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });
    const { value } = await gen.next();
    expect(value!.candidates).toHaveLength(1);
    expect(value!.candidates[0].doi).toBe('10.1037/abc');
  });

  it('reconstructs abstract from inverted index', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        results: [
          {
            id: 'https://openalex.org/W1',
            doi: 'https://doi.org/10.1037/abc',
            title: 'X',
            abstract_inverted_index: { we: [0], replicated: [1], smith: [2] },
          },
        ],
        meta: { next_cursor: null },
      }) as never,
    );

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });
    const { value } = await gen.next();
    expect(value!.candidates[0].abstract).toBe('we replicated smith');
  });

  it('respects max_pages_per_query', async () => {
    const fetchFn = jest.fn(async () =>
      okJson({ results: [], meta: { next_cursor: 'NEVER_ENDING' } }),
    );

    const adapter = new OpenAlexSourceAdapter({
      apiKey: 'k',
      verifiedAt: new Date(),
      ratePerSec: 100,
      maxPagesPerQuery: 3,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW_REP_OF], filters: FILTERS });

    let pages = 0;
    for await (const _ of gen) {
      pages++;
    }
    expect(pages).toBe(3);
  });
});
