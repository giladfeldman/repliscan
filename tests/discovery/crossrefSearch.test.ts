import { describe, it, expect, jest } from '@jest/globals';
import { CrossrefSourceAdapter } from '../../src/discovery/engine/sources/crossrefSearch.js';
import type { ExpandedKeyword, RunFilters } from '../../src/discovery/types.js';

const KW: ExpandedKeyword[] = [
  { id: 'REP_OF', permutation: 'replication of', weight: 1.0, fields: ['title', 'abstract'] },
  { id: 'DIRECT_REP', permutation: 'direct replication', weight: 0.95, fields: ['title', 'abstract'] },
];

const FILTERS: RunFilters = {
  yearFrom: 2023,
  yearTo: 2023,
  languages: ['en'],
  sources: ['crossref'],
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

describe('CrossrefSourceAdapter', () => {
  it('builds an OR-bundled query.bibliographic and yields candidates', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        message: {
          items: [
            {
              DOI: '10.1037/abc',
              title: ['A direct replication of Smith (2015)'],
              abstract: '<jats:p>We replicated Smith.</jats:p>',
              author: [{ given: 'J', family: 'Doe' }],
              'container-title': ['JESP'],
              'published-print': { 'date-parts': [[2023]] },
              language: 'en',
            },
          ],
          'next-cursor': null,
        },
      }) as never,
    );

    const adapter = new CrossrefSourceAdapter({
      mailto: 'test@example.com',
      verifiedAt: new Date('2026-05-04'),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const gen = adapter.search({ keywords: KW, filters: FILTERS });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.candidates).toHaveLength(1);
    const c = first.value!.candidates[0];
    expect(c.doi).toBe('10.1037/abc');
    expect(c.title).toBe('A direct replication of Smith (2015)');
    expect(c.abstract).toBe('We replicated Smith.');
    expect(c.year).toBe(2023);
    expect(c.journal).toBe('JESP');
    expect(c.authors?.[0].name).toBe('J Doe');

    const after = await gen.next();
    expect(after.done).toBe(true);

    const url = decodeURIComponent(fetchFn.mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(url).toContain('"replication of"');
    expect(url).toContain('"direct replication"');
    expect(url).toContain(' OR ');
    expect(url).toContain('from-pub-date:2023');
    expect(url).toContain('until-pub-date:2023-12-31');
    expect(url).toContain('mailto=test@example.com');
  });

  it('paginates via next-cursor', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        okJson({ message: { items: [], 'next-cursor': 'PAGE2' } }) as never,
      )
      .mockResolvedValueOnce(
        okJson({ message: { items: [], 'next-cursor': null } }) as never,
      );

    const adapter = new CrossrefSourceAdapter({
      mailto: 't@e',
      verifiedAt: new Date(),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW[0]], filters: FILTERS });
    await gen.next();
    await gen.next();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url2 = fetchFn.mock.calls[1][0] as string;
    expect(url2).toContain('cursor=PAGE2');
  });

  it('handles 429 with retry on same cursor', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(tooManyRequests('0') as never)
      .mockResolvedValueOnce(okJson({ message: { items: [], 'next-cursor': null } }) as never);

    const adapter = new CrossrefSourceAdapter({
      mailto: 't@e',
      verifiedAt: new Date(),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW[0]], filters: FILTERS });
    await gen.next();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url1 = fetchFn.mock.calls[0][0] as string;
    const url2 = fetchFn.mock.calls[1][0] as string;
    expect(url1).toContain('cursor=*');
    expect(url2).toContain('cursor=*');
  });

  it('throws after 3 consecutive 429s', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(tooManyRequests('0') as never);

    const adapter = new CrossrefSourceAdapter({
      mailto: 't@e',
      verifiedAt: new Date(),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW[0]], filters: FILTERS });
    await expect(gen.next()).rejects.toThrow(/threshold exceeded/);
  });

  it('drops works without DOI', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        message: {
          items: [{ title: ['No DOI'] }, { DOI: '10.1037/x', title: ['With DOI'] }],
          'next-cursor': null,
        },
      }) as never,
    );

    const adapter = new CrossrefSourceAdapter({
      mailto: 't@e',
      verifiedAt: new Date(),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW[0]], filters: FILTERS });
    const { value } = await gen.next();
    expect(value!.candidates).toHaveLength(1);
    expect(value!.candidates[0].doi).toBe('10.1037/x');
  });

  it('extracts year from published-online when published-print missing', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      okJson({
        message: {
          items: [
            {
              DOI: '10.1/abc',
              title: ['X'],
              'published-online': { 'date-parts': [[2024, 6, 15]] },
            },
          ],
          'next-cursor': null,
        },
      }) as never,
    );

    const adapter = new CrossrefSourceAdapter({
      mailto: 't@e',
      verifiedAt: new Date(),
      ratePerSec: 10,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const gen = adapter.search({ keywords: [KW[0]], filters: FILTERS });
    const { value } = await gen.next();
    expect(value!.candidates[0].year).toBe(2024);
  });

  it('rejects construction without mailto', () => {
    expect(
      () =>
        new CrossrefSourceAdapter({
          mailto: '',
          verifiedAt: new Date(),
          ratePerSec: 10,
        }),
    ).toThrow(/mailto/);
  });
});
