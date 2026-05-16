/**
 * Replication Discovery — core type definitions.
 *
 * These types describe the data flowing through the discovery pipeline:
 *   user wildcards
 *     → expanded keywords (per-source query strings)
 *     → raw API candidates
 *     → normalized + deduped candidates
 *     → classified candidates persisted to Postgres
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3, §2
 */

export type SourceId =
  | 'openalex'
  | 'crossref'
  | 'semantic_scholar'
  | 'bob_reed'
  | 'i4r'
  | 'fred_data';

export type SearchField = 'title' | 'abstract' | 'default';

export type DiscoveryRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ClassifierStatus =
  | 'pending'
  | 'accepted'
  | 'ambiguous'
  | 'needs_more_metadata'
  | 'rejected'
  | 'errored';

export type FloraStatus =
  | 'not_in_flora'
  | 'flora_known_replication'
  | 'flora_known_original'
  | 'flora_match_pending';

// --- Keyword spec (loaded from search-keywords.yaml) ---

export interface KeywordSpec {
  id: string;
  /** Canonical phrase, used for human-readable display. */
  phrase?: string;
  /**
   * Template-with-qualifiers form. Mutually exclusive with `permutations`.
   * Example: template "{qualifier} replication" + qualifiers ["close","high-powered"]
   *   => "close replication", "high-powered replication"
   */
  template?: string;
  qualifiers?: string[];
  /** Explicit phrase variants. Used when no template is provided. */
  permutations?: string[];
  /** 0.0 – 1.0; contributes to search_score weighting. */
  weight: number;
  /** Which API fields to search this keyword in. */
  fields: SearchField[];
  /** Optional human notes. */
  notes?: string;
}

/** A single (keyword id, phrase variant) pair after spec + user-input expansion. */
export interface ExpandedKeyword {
  id: string;
  permutation: string;
  weight: number;
  fields: SearchField[];
}

// --- Exclusion patterns ---

export interface ExclusionPattern {
  id: string;
  /** PCRE-compatible source. */
  regex: string;
  /** Regex flags, e.g. ["i"]. */
  flags?: string[];
  description?: string;
}

// --- Run config ---

export interface RunFilters {
  yearFrom?: number;
  yearTo?: number;
  /** ISO 639-1 codes; empty array = no language filter. */
  languages: string[];
  sources: SourceId[];
  maxCandidatesPerSource: number;
  /** When true, candidates whose DOI is already known to FReD are skipped. */
  skipDoisInFlora: boolean;
}

export interface DiscoveryRunConfig {
  specVersion: number;
  /** Raw user input keywords (with wildcards), before expansion. */
  keywords: string[];
  filters: RunFilters;
}

// --- Candidate flow ---

export interface CandidateAuthor {
  name: string;
  orcid?: string;
}

export interface RawCandidate {
  source: SourceId;
  /** Source-native ID (OpenAlex W-id, Crossref item ID, S2 paper ID). */
  sourceRecordId?: string;
  doi: string;
  title?: string;
  abstract?: string;
  year?: number;
  authors?: CandidateAuthor[];
  journal?: string;
  url?: string;
  language?: string;
  /** Which keyword + field returned this candidate. */
  matchedKeyword: { id: string; field: SearchField; permutation: string };
}

export interface NormalizedCandidate extends Omit<RawCandidate, 'matchedKeyword'> {
  /** Cumulative list of (keyword, field, permutation) hits across all matches for this DOI. */
  matchedKeywords: Array<{ id: string; field: SearchField; permutation: string }>;
  /** Computed by candidateRanker. 0.0 – 1.0. */
  searchScore: number;
}

export interface CandidateRecord extends NormalizedCandidate {
  runId: string;
  discoveredAt: Date;
  classifierStatus: ClassifierStatus;
  classifierResult?: unknown;
  classifierProcessedAt?: Date;
  floraStatus: FloraStatus;
}

// --- Job-runner state (persisted as progress_json in DB) ---

export interface DiscoveryTask {
  /** Task id (Cartesian-product index, stable across run). */
  tid: number;
  source: SourceId;
  /** Keyword id from spec. */
  kid: string;
  /** Permutation index within the keyword. */
  perm: number;
  field: SearchField;
  /** Source-specific cursor (OpenAlex `*`, Crossref `*`, S2 offset string, etc.). */
  cursor: string;
  done: boolean;
}

export interface DiscoveryProgress {
  tasks: DiscoveryTask[];
  /** Index into tasks of the currently-executing or next-up task. */
  currentTid: number;
  /** Per-task page counter for ETA estimation. */
  pageCountPerTid: Record<string, number>;
}

export interface DiscoveryStats {
  totalTasks: number;
  completedTasks: number;
  candidatesSeen: number;
  candidatesKeptAfterExclusion: number;
  candidatesClassified: number;
  classifierAccepted: number;
  classifierAmbiguous: number;
  classifierNeedsMetadata: number;
  classifierRejected: number;
  floraKnown: number;
  errorsPerSource: Record<SourceId, number>;
  apiCallsPerSource: Record<SourceId, number>;
  /** Per-pattern count of candidates dropped by the exclusion regex filter. */
  excludedByPattern: Record<string, number>;
  /** Candidates that passed exclusion but were dropped because searchScore < minScore. */
  candidatesDroppedByThreshold?: number;
  currentTask?: { tid: number; source: SourceId; keyword: string; field: SearchField; page: number };
  startedAt?: string;
  estimatedRemainingSeconds?: number;
}

// --- Source-config types (loaded from source-configs.yaml) ---

export interface SourceRateLimit {
  verified_at: string | null;
  requests_per_second: number | null;
  requests_per_day?: number | null;
}

export interface SourceConfig {
  base_url: string;
  works_endpoint: string;
  auth?: Record<string, string>;
  rate_limit: SourceRateLimit;
  query_template: Record<SearchField, string>;
  pagination: Record<string, unknown>;
  filters: Record<string, unknown>;
}

// --- Effective spec (DB-resolved, runtime config) ---

export interface EffectiveKeyword {
  id: string;        // slug
  phrase: string;
  permutations: string[];
  weight: number;
  fields: SearchField[];
  notes?: string;
}

export interface EffectiveExclusion {
  id: string;        // slug
  regex: string;
  flags: string[];
  description: string;
}

export interface EffectiveRanking {
  title_weight: number;
  abstract_weight: number;
  multi_keyword_bonus: number;
  source_diversity_bonus: number;
  cap: number;
  min_search_score_threshold: number;
}

export interface EffectiveSpec {
  keywords:   EffectiveKeyword[];
  exclusions: EffectiveExclusion[];
  ranking:    EffectiveRanking;
  hash:       string;
  resolvedAt: string;
  source:     'defaults' | 'override';
}
