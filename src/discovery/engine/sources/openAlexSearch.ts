/**
 * OpenAlexSourceAdapter — OR-bundled phrase search against the OpenAlex /works endpoint.
 *
 * Strategy (per source-configs.yaml openalex.query.strategy = "or_bundle"):
 *   - Build ONE big ?search=("p1" OR "p2" OR ...) query containing every phrase permutation.
 *   - Per-keyword and per-field attribution is computed POST-fetch by the runner via the
 *     existing phraseDetection regexes — we don't need separate title/abstract calls.
 *   - Cursor-paginate up to max_pages_per_query.
 *   - 429 → halve bucket rate, sleep Retry-After, retry same cursor (idempotent).
 *
 * Auth: API key required since Feb 13, 2026 (OPENALEX_API_KEY env var). See
 * RATE_LIMITS_VERIFIED.md for the deprecation notice and current rate cap.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3.7, §4.5
 */

import type {
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

interface OpenAlexAdapterConfig {
  apiKey?: string;
  mailto?: string;
  verifiedAt: Date;
  ratePerSec: number;
  /** OR operator separator between quoted phrases. From source-configs.yaml. */
  orOperator?: string;
  /** Phrase quote character. From source-configs.yaml. */
  phraseQuote?: string;
  /** Cap on how many phrases get bundled into one query (URL length safety). */
  maxPhrasesPerQuery?: number;
  /** Page size; OpenAlex max is 200. */
  perPage?: number;
  /** Stop after this many pages per OR-bundled query (safety bound). */
  maxPagesPerQuery?: number;
  /** Inject a fetch implementation for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

interface OpenAlexAuthorship {
  author?: { display_name?: string; orcid?: string };
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  publication_year?: number | null;
  authorships?: OpenAlexAuthorship[];
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  language?: string | null;
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
  meta?: { next_cursor?: string | null };
}

const OPENALEX_HARD_RATE_CAP_PER_SEC = 100;

/**
 * Reconstruct readable text from OpenAlex's inverted-index abstract format.
 * (OpenAlex doesn't ship plain abstracts due to publisher copyright concerns,
 * but the inverted index is reconstructible word-by-word.)
 */
function abstractIndexToText(idx: Record<string, number[]>): string {
  const positions: Array<[number, string]> = [];
  for (const [word, posList] of Object.entries(idx)) {
    for (const p of posList) positions.push([p, word]);
  }
  positions.sort(([a], [b]) => a - b);
  return positions.map(([, w]) => w).join(' ');
}

export class OpenAlexSourceAdapter implements SourceAdapter {
  readonly id: SourceId = 'openalex';
  readonly verifiedAt: Date;

  private readonly bucket: TokenBucket;
  private readonly apiKey?: string;
  private readonly mailto?: string;
  private readonly orOperator: string;
  private readonly phraseQuote: string;
  private readonly maxPhrasesPerQuery: number;
  private readonly perPage: number;
  private readonly maxPagesPerQuery: number;
  private readonly fetchFn: typeof fetch;

  private consecutive429s = 0;
  private lastLimitReport: RateLimitReport = {};

  constructor(opts: OpenAlexAdapterConfig) {
    if (opts.ratePerSec <= 0 || opts.ratePerSec > OPENALEX_HARD_RATE_CAP_PER_SEC) {
      throw new Error(
        `OpenAlexSourceAdapter: ratePerSec must be in (0, ${OPENALEX_HARD_RATE_CAP_PER_SEC}] (got ${opts.ratePerSec})`,
      );
    }
    this.apiKey = opts.apiKey;
    this.mailto = opts.mailto;
    this.verifiedAt = opts.verifiedAt;
    this.bucket = new TokenBucket({ ratePerSec: opts.ratePerSec, burst: 5 });
    this.orOperator = opts.orOperator ?? ' OR ';
    this.phraseQuote = opts.phraseQuote ?? '"';
    this.maxPhrasesPerQuery = opts.maxPhrasesPerQuery ?? 100;
    this.perPage = opts.perPage ?? 50;
    this.maxPagesPerQuery = opts.maxPagesPerQuery ?? 20;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  reportLimits(): RateLimitReport {
    return { ...this.lastLimitReport };
  }

  async *search(args: SearchArgs): AsyncGenerator<SearchPage, void> {
    if (args.keywords.length === 0) return;

    const phrases = args.keywords.slice(0, this.maxPhrasesPerQuery).map((k) => k.permutation);
    const searchExpression = this.buildOrExpression(phrases);

    let cursor = args.cursor ?? '*';
    let page = 0;

    while (true) {
      await this.bucket.take();

      const url = this.buildUrl(searchExpression, args.filters, cursor);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const res = await this.fetchFn(url, { headers });

      if (res.status === 429) {
        this.consecutive429s++;
        if (this.consecutive429s >= 3) {
          throw new Error('OpenAlex 429 threshold exceeded — paused by adapter');
        }
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
        // Defensive halving of rate
        this.bucket.setRate(this.bucket.getRate() / 2);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue; // retry same cursor — idempotent
      }
      this.consecutive429s = 0;

      if (!res.ok) {
        throw new Error(`OpenAlex error ${res.status} for ${url}`);
      }

      const json = (await res.json()) as OpenAlexResponse;
      const candidates: RawCandidate[] = (json.results ?? [])
        .map((w) => this.workToRawCandidate(w, args.keywords))
        .filter((c): c is RawCandidate => c !== null);

      const next = json.meta?.next_cursor ?? undefined;
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
    // OpenAlex phrase syntax doesn't support nested quotes — strip them defensively.
    return phrase.replace(/["\\]/g, '');
  }

  private buildUrl(searchExpression: string, filters: RunFilters, cursor: string): string {
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', searchExpression);

    const filterParts: string[] = ['type:article', 'has_abstract:true'];
    if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
      const from = filters.yearFrom ?? '';
      const to = filters.yearTo ?? '';
      filterParts.push(`publication_year:${from}-${to}`);
    }
    if (filters.languages.length > 0) {
      filterParts.push(`language:${filters.languages.join('|')}`);
    }
    url.searchParams.set('filter', filterParts.join(','));
    url.searchParams.set(
      'select',
      'id,doi,title,abstract_inverted_index,publication_year,authorships,primary_location,language',
    );
    url.searchParams.set('per-page', String(this.perPage));
    url.searchParams.set('cursor', cursor);
    if (!this.apiKey && this.mailto) {
      url.searchParams.set('mailto', this.mailto);
    }
    return url.toString();
  }

  private workToRawCandidate(w: OpenAlexWork, keywords: ExpandedKeyword[]): RawCandidate | null {
    const rawDoi = (w.doi ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    if (!rawDoi) return null;

    const abstract = w.abstract_inverted_index
      ? abstractIndexToText(w.abstract_inverted_index)
      : undefined;

    const authors: Array<{ name: string; orcid?: string }> = [];
    for (const a of w.authorships ?? []) {
      const name = a.author?.display_name?.trim();
      if (!name) continue;
      const orcid = a.author?.orcid?.trim();
      const entry: { name: string; orcid?: string } = { name };
      if (orcid) entry.orcid = orcid;
      authors.push(entry);
    }

    return {
      source: 'openalex',
      sourceRecordId: (w.id ?? '').replace('https://openalex.org/', ''),
      doi: rawDoi,
      title: w.title?.trim() ?? undefined,
      abstract,
      year: w.publication_year ?? undefined,
      authors: authors.length > 0 ? authors : undefined,
      journal: w.primary_location?.source?.display_name?.trim() ?? undefined,
      url: w.doi ? `https://doi.org/${rawDoi}` : undefined,
      language: w.language ?? undefined,
      // First keyword is a placeholder — runner re-attributes via local regex over title+abstract.
      matchedKeyword: {
        id: keywords[0].id,
        field: keywords[0].fields.includes('title') ? 'title' : 'abstract',
        permutation: keywords[0].permutation,
      },
    };
  }
}

