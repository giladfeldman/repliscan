/**
 * SourceAdapter — interface every per-source search adapter implements.
 *
 * Each adapter knows how to construct an OR-bundled phrase query for ONE
 * upstream source (OpenAlex, Crossref, Semantic Scholar, etc.) and stream
 * candidates back page by page. The runner doesn't care which source it's
 * talking to — same shape, same async-generator contract.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3.7
 */

import type {
  ExpandedKeyword,
  RawCandidate,
  RunFilters,
  SourceId,
} from '../../types.js';

export interface SearchArgs {
  /**
   * The full set of expanded keywords to OR-bundle into one search call. The
   * adapter handles quoting, joining, and per-source URL/parameter encoding.
   */
  keywords: ExpandedKeyword[];
  filters: RunFilters;
  /** Resume cursor from a previous page; if undefined, the adapter starts fresh. */
  cursor?: string;
}

export interface SearchPage {
  candidates: RawCandidate[];
  /** Cursor for the next page; undefined when there are no more pages. */
  nextCursor?: string;
}

export interface RateLimitReport {
  requestsRemaining?: number;
  resetAt?: Date;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly verifiedAt: Date;

  /**
   * Stream pages of candidates that match the OR-bundled keyword query. The
   * yielded `nextCursor` (when present) lets the runner persist where we are
   * for crash-safe resume; the next call passes it back via `args.cursor`.
   *
   * The adapter is responsible for:
   *   - rate-limiting via an internal TokenBucket
   *   - 429 handling with Retry-After + bucket-rate halving
   *   - graceful exit when max_pages_per_query is reached
   *   - returning when there are no more results (omit nextCursor)
   */
  search(args: SearchArgs): AsyncGenerator<SearchPage, void>;

  reportLimits(): RateLimitReport;
}
