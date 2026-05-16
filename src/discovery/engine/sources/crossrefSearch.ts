/**
 * CrossrefSourceAdapter — OR-bundled phrase search against Crossref /works.
 *
 * Strategy mirrors OpenAlex (see openAlexSearch.ts):
 *   - One ?query.bibliographic="p1" OR "p2" OR ... per source per run
 *   - Local regex pass for per-keyword/per-field attribution
 *   - Cursor pagination (deep paging via &cursor=*)
 *   - Polite pool via User-Agent: ".../1.0 (mailto:CROSSREF_EMAIL)"
 *
 * Crossref doesn't ship abstracts on most records — when absent, the
 * candidate's abstract field is undefined and the runner's text-attribution
 * step works on title alone for that record.
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

interface CrossrefAdapterConfig {
  /** Polite-pool email; sent in User-Agent and as mailto query param. */
  mailto: string;
  verifiedAt: Date;
  ratePerSec: number;
  orOperator?: string;
  phraseQuote?: string;
  maxPhrasesPerQuery?: number;
  perPage?: number;
  maxPagesPerQuery?: number;
  fetchFn?: typeof fetch;
}

const CROSSREF_HARD_RATE_CAP_PER_SEC = 50;

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
  ORCID?: string;
}

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  abstract?: string;
  author?: CrossrefAuthor[];
  'container-title'?: string[];
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  language?: string;
  URL?: string;
}

interface CrossrefResponse {
  message?: {
    items?: CrossrefWork[];
    'next-cursor'?: string | null;
  };
}

function authorToCandidateAuthor(a: CrossrefAuthor): CandidateAuthor | null {
  const name =
    a.name ??
    [a.given, a.family].filter(Boolean).join(' ') ??
    a.family ??
    null;
  if (!name) return null;
  const out: CandidateAuthor = { name };
  if (a.ORCID) out.orcid = a.ORCID;
  return out;
}

function extractYear(work: CrossrefWork): number | undefined {
  const parts = work['published-print']?.['date-parts']?.[0] ?? work['published-online']?.['date-parts']?.[0];
  return parts && parts.length > 0 ? parts[0] : undefined;
}

/** Strip Crossref's HTML wrapping ("<jats:p>...</jats:p>") if present. */
function cleanAbstract(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<\/?jats:[a-z]+[^>]*>/gi, '')
    .replace(/<\/?p>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class CrossrefSourceAdapter implements SourceAdapter {
  readonly id: SourceId = 'crossref';
  readonly verifiedAt: Date;

  private readonly bucket: TokenBucket;
  private readonly mailto: string;
  private readonly orOperator: string;
  private readonly phraseQuote: string;
  private readonly maxPhrasesPerQuery: number;
  private readonly perPage: number;
  private readonly maxPagesPerQuery: number;
  private readonly fetchFn: typeof fetch;

  private consecutive429s = 0;
  private lastLimitReport: RateLimitReport = {};

  constructor(opts: CrossrefAdapterConfig) {
    if (opts.ratePerSec <= 0 || opts.ratePerSec > CROSSREF_HARD_RATE_CAP_PER_SEC) {
      throw new Error(
        `CrossrefSourceAdapter: ratePerSec must be in (0, ${CROSSREF_HARD_RATE_CAP_PER_SEC}] (got ${opts.ratePerSec})`,
      );
    }
    if (!opts.mailto) {
      throw new Error('CrossrefSourceAdapter: mailto is required for polite pool');
    }
    this.mailto = opts.mailto;
    this.verifiedAt = opts.verifiedAt;
    this.bucket = new TokenBucket({ ratePerSec: opts.ratePerSec, burst: 5 });
    this.orOperator = opts.orOperator ?? ' OR ';
    this.phraseQuote = opts.phraseQuote ?? '"';
    this.maxPhrasesPerQuery = opts.maxPhrasesPerQuery ?? 100;
    this.perPage = opts.perPage ?? 100;
    this.maxPagesPerQuery = opts.maxPagesPerQuery ?? 20;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  reportLimits(): RateLimitReport {
    return { ...this.lastLimitReport };
  }

  async *search(args: SearchArgs): AsyncGenerator<SearchPage, void> {
    if (args.keywords.length === 0) return;

    const phrases = args.keywords.slice(0, this.maxPhrasesPerQuery).map((k) => k.permutation);
    const queryExpression = this.buildOrExpression(phrases);

    let cursor = args.cursor ?? '*';
    let page = 0;

    while (true) {
      await this.bucket.take();
      const url = this.buildUrl(queryExpression, args.filters, cursor);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': `SciMeto/1.0 (mailto:${this.mailto})`,
      };

      const res = await this.fetchFn(url, { headers });

      if (res.status === 429) {
        this.consecutive429s++;
        if (this.consecutive429s >= 3) {
          throw new Error('Crossref 429 threshold exceeded — paused by adapter');
        }
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
        this.bucket.setRate(this.bucket.getRate() / 2);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      this.consecutive429s = 0;

      if (!res.ok) {
        throw new Error(`Crossref error ${res.status} for ${url}`);
      }

      const json = (await res.json()) as CrossrefResponse;
      const candidates: RawCandidate[] = (json.message?.items ?? [])
        .map((w) => this.workToRawCandidate(w, args.keywords))
        .filter((c): c is RawCandidate => c !== null);

      const next = json.message?.['next-cursor'] ?? undefined;
      yield { candidates, nextCursor: next ?? undefined };

      if (!next) return;
      cursor = next;
      page++;
      if (page >= this.maxPagesPerQuery) return;
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

  private buildUrl(queryExpression: string, filters: RunFilters, cursor: string): string {
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query.bibliographic', queryExpression);

    const filterParts: string[] = ['type:journal-article', 'has-abstract:true'];
    if (filters.yearFrom !== undefined) filterParts.push(`from-pub-date:${filters.yearFrom}`);
    if (filters.yearTo !== undefined) filterParts.push(`until-pub-date:${filters.yearTo}-12-31`);
    url.searchParams.set('filter', filterParts.join(','));
    url.searchParams.set('rows', String(this.perPage));
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('mailto', this.mailto);
    return url.toString();
  }

  private workToRawCandidate(w: CrossrefWork, keywords: ExpandedKeyword[]): RawCandidate | null {
    const doi = (w.DOI ?? '').toLowerCase();
    if (!doi) return null;

    const title = w.title?.[0]?.trim() ?? undefined;
    const abstract = cleanAbstract(w.abstract);
    const authors = (w.author ?? []).map(authorToCandidateAuthor).filter((a): a is CandidateAuthor => a !== null);
    const journal = w['container-title']?.[0]?.trim() ?? undefined;

    return {
      source: 'crossref',
      sourceRecordId: doi,
      doi,
      title,
      abstract,
      year: extractYear(w),
      authors: authors.length > 0 ? authors : undefined,
      journal,
      url: w.URL ?? `https://doi.org/${doi}`,
      language: w.language ?? undefined,
      matchedKeyword: {
        id: keywords[0].id,
        field: keywords[0].fields.includes('title') ? 'title' : 'abstract',
        permutation: keywords[0].permutation,
      },
    };
  }
}
