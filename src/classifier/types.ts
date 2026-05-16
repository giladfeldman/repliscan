// apps/worker/src/services/replication/types.ts

export type ReplicationOutcome = 'successful' | 'failed' | 'mixed' | 'unknown';
export type ReplicationConfidence = 'high' | 'medium' | 'low';
export type MetadataProviderName =
  | 'openalex'
  | 'crossref'
  | 'datacite'
  | 'doi.org'
  | 'semantic-scholar'
  | 'opencitations';

export type MetadataProviderStatus =
  | 'found'
  | 'not_found'
  | 'rate_limited'
  | 'provider_error'
  | 'sparse_metadata'
  | 'missing_references';

export interface MetadataProviderReport {
  provider: MetadataProviderName;
  status: MetadataProviderStatus;
  message?: string;
}

export type FieldProvenance = Partial<Record<
  'doi' | 'title' | 'authors' | 'venue' | 'year' | 'abstract' | 'referencedWorks',
  MetadataProviderName[]
>>;

export interface ExtractedTarget {
  authorYearString: string;  // "Carney et al. (2010)"
  firstAuthorLastName: string;
  year: number;
  sentence: string;          // source sentence for this extraction
}

export interface ResolvedTarget {
  extracted: ExtractedTarget;
  originalDoi: string | null;
  ambiguous: boolean;
  matchCount: number;
}

export interface OpenAlexWork {
  doi: string | null;
  title: string;
  authors: string;
  venue: string;
  year: number | null;
  abstract: string;
  referencedWorks: Array<{
    openalexId: string;
    doi: string | null;
    title?: string;
    authors?: string;
    venue?: string;
    firstAuthor?: string;
    year?: number | null;
    source?: MetadataProviderName;
  }>;
}

export interface ResolvedWork extends OpenAlexWork {
  sourcesQueried: MetadataProviderName[];
  providerReports: MetadataProviderReport[];
  fieldProvenance: FieldProvenance;
}

export interface ReplicationClassifierInput {
  doi: string;
  title: string;
  authors?: string;
  venue?: string;
  year?: number | null;
  abstract: string;
  referencedWorks: OpenAlexWork['referencedWorks'];
}

export interface ReplicationFinding {
  originalDoi: string;
  originalTitle?: string;
  originalAuthors?: string;
  originalVenue?: string;
  originalYear?: number | null;
  replicationTitle?: string;
  replicationAuthors?: string;
  replicationVenue?: string;
  replicationYear?: number | null;
  originalReferenceExtracted: string;
  justificationPhrase: string;
  outcomePhrase: string;
  outcome: ReplicationOutcome;
  confidence: ReplicationConfidence;
  evidence: string[];
  signalProvenance: string[];
  ambiguous?: boolean;
  replicationDoi?: string;
}

export interface ReverseExtractorResult {
  replicationDoi: string;
  isReplication: boolean;
  targets: ReplicationFinding[];
}
