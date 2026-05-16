/**
 * SemanticScholarSourceAdapter — OR-bundled phrase search against
 * Semantic Scholar's /paper/search endpoint.
 *
 * Strategy mirrors OpenAlex/Crossref:
 *   - One ?query="p1" | "p2" | ... per source per run (S2 uses pipe for OR)
 *   - Local regex pass for per-keyword/per-field attribution
 *   - Offset/limit pagination (S2 caps at offset 999, limit 100)
 *   - Auth: x-api-key header from SEMANTIC_SCHOLAR_API_KEY
 *
 * S2 ships abstracts when present; we don't have to do anything special
 * for missing ones (undefined → runner attribution falls back to title).
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3.7
 */

import type {
  CandidateAuthor,
  ExpandedKeyword,
  RawCandidate,
  RunFilters,
  SourceId,
} from '../../types.js';
import type {
  RateLimitReport,
  SearchArgs,
  SearchPage,
  SourceAdapter,
} from './sourceAdapter.js';
import { TokenBucket } from './tokenBucket.js';

interface S2AdapterConfig {
  apiKey?: string;
  verifiedAt: Date;
  ratePerSec: number;
  orOperator?: string;
  phraseQuote?: string;
  maxPhrasesPerQuery?: number;
  perPage?: number;
  /** S2 hard caps total results at 1000 across all pages of a query. */
  maxTotal?: number;
  fetchFn?: typeof fetch;
}

const S2_HARD_RATE_CAP_PER_SEC = 10;

interface S2Author {
  authorId?: string;
  name?: string;
}

interface S2ExternalIds {
  DOI?: string;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  year?: number;
  authors?: S2Author[];
  externalIds?: S2ExternalIds;
  venue?: string;
}

interface S2Response {
  total?: number;
  offset?: number;
  next?: number;
  data?: S2Paper[];
}

export class SemanticScholarSourceAdapter implements SourceAdapter {
  readonly id: SourceId = 'semantic_scholar';
  readonly verifiedAt: Date;

  private readonly bucket: TokenBucket;
  private readonly apiKey?: string;
  private readonly orOperator: string;
  private readonly phraseQuote: string;
  private readonly maxPhrasesPerQuery: number;
  private readonly perPage: number;
  private readonly maxTotal: number;
  private readonly fetchFn: typeof fetch;

  private consecutive429s = 0;
  private lastLimitReport: RateLimitReport = {};

  constructor(opts: S2AdapterConfig) {
    if (opts.ratePerSec <= 0 || opts.ratePerSec > S2_HARD_RATE_CAP_PER_SEC) {
      throw new Error(
        `SemanticScholarSourceAdapter: ratePerSec must be in (0, ${S2_HARD_RATE_CAP_PER_SEC}] (got ${opts.ratePerSec})`,
      );
    }
    this.apiKey = opts.apiKey;
    this.verifiedAt = opts.verifiedAt;
    this.bucket = new TokenBucket({ ratePerSec: opts.ratePerSec, burst: 3 });
    this.orOperator = opts.orOperator ?? ' | ';
    this.phraseQuote = opts.phraseQuote ?? '"';
    this.maxPhrasesPerQuery = opts.maxPhrasesPerQuery ?? 100;
    this.perPage = opts.perPage ?? 100;
    this.maxTotal = opts.maxTotal ?? 1000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  reportLimits(): RateLimitReport {
    return { ...this.lastLimitReport };
  }

  async *search(args: SearchArgs): AsyncGenerator<SearchPage, void> {
    if (args.keywords.length === 0) return;

    const phrases = args.keywords.slice(0, this.maxPhrasesPerQuery).map((k) => k.permutation);
    const queryExpression = this.buildOrExpression(phrases);

    let offset = args.cursor ? parseInt(args.cursor, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) offset = 0;

    while (offset < this.maxTotal) {
      await this.bucket.take();
      const url = this.buildUrl(queryExpression, args.filters, offset);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;

      const res = await this.fetchFn(url, { headers });

      if (res.status === 429) {
        this.consecutive429s++;
        if (this.consecutive429s >= 3) {
          throw new Error('Semantic Scholar 429 threshold exceeded — paused by adapter');
        }
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
        this.bucket.setRate(this.bucket.getRate() / 2);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      this.consecutive429s = 0;

      if (!res.ok) {
        throw new Error(`Semantic Scholar error ${res.status} for ${url}`);
      }

      const json = (await res.json()) as S2Response;
      const candidates: RawCandidate[] = (json.data ?? [])
        .map((p) => this.paperToRawCandidate(p, args.keywords))
        .filter((c): c is RawCandidate => c !== null);

      const next = json.next;
      const nextCursor = next !== undefined && next < this.maxTotal ? String(next) : undefined;
      yield { candidates, nextCursor };

      if (nextCursor === undefined) return;
      offset = next as number;
    }
  }

  private buildOrExpression(phrases: string[]): string {
    return phrases
      .map((p) => `${this.phraseQuote}${this.escapePhrase(p)}${this.phraseQuote}`)
      .join(this.orOperator);
  }

  private escapePhrase(phrase: string): string {
    return phrase.replace(/["\\]/g, '');
  }

  private buildUrl(query: string, filters: RunFilters, offset: number): string {
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(this.perPage));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('fields', 'title,abstract,year,authors,externalIds,venue');
    if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
      const from = filters.yearFrom ?? '';
      const to = filters.yearTo ?? '';
      url.searchParams.set('year', `${from}-${to}`);
    }
    return url.toString();
  }

  private paperToRawCandidate(p: S2Paper, keywords: ExpandedKeyword[]): RawCandidate | null {
    const doi = p.externalIds?.DOI?.toLowerCase();
    if (!doi) return null;

    const authors: CandidateAuthor[] = (p.authors ?? [])
      .map((a) => (a.name ? { name: a.name } : null))
      .filter((a): a is CandidateAuthor => a !== null);

    return {
      source: 'semantic_scholar',
      sourceRecordId: p.paperId,
      doi,
      title: p.title?.trim() ?? undefined,
      abstract: p.abstract?.trim() ?? undefined,
      year: p.year ?? undefined,
      authors: authors.length > 0 ? authors : undefined,
      journal: p.venue?.trim() ?? undefined,
      url: `https://doi.org/${doi}`,
      matchedKeyword: {
        id: keywords[0].id,
        field: keywords[0].fields.includes('title') ? 'title' : 'abstract',
        permutation: keywords[0].permutation,
      },
    };
  }
}
