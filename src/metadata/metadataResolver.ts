import type {
  FieldProvenance,
  MetadataProviderName,
  MetadataProviderReport,
  OpenAlexWork,
  ResolvedWork,
} from '../classifier/types.js';
import type { MetadataProvider, MetadataProviderResult, MetadataWork } from './types.js';
import type { MetadataCredentials } from './credentials.js';
import { cleanDoi, firstAuthor } from './common.js';
import { openAlexProvider } from './openAlexProvider.js';
import { crossrefProvider } from './crossrefProvider.js';
import { dataCiteProvider } from './dataCiteProvider.js';
import { doiOrgProvider } from './doiOrgProvider.js';
import { semanticScholarProvider } from './semanticScholarProvider.js';
import { openCitationsProvider } from './openCitationsProvider.js';

export const DEFAULT_METADATA_PROVIDERS: MetadataProvider[] = [
  openAlexProvider,
  crossrefProvider,
  dataCiteProvider,
  doiOrgProvider,
  semanticScholarProvider,
  openCitationsProvider,
];

export interface WorkMetadataLookup {
  work: ResolvedWork | null;
  sourcesQueried: MetadataProviderName[];
  providerReports: MetadataProviderReport[];
}

function addProvenance(
  provenance: FieldProvenance,
  field: keyof FieldProvenance,
  provider: MetadataProviderName,
): void {
  const existing = provenance[field] || [];
  if (!existing.includes(provider)) provenance[field] = [...existing, provider];
}

function assignField<K extends keyof Pick<OpenAlexWork, 'doi' | 'title' | 'authors' | 'venue' | 'year' | 'abstract'>>(
  target: OpenAlexWork,
  provenance: FieldProvenance,
  field: K,
  value: OpenAlexWork[K],
  provider: MetadataProviderName,
): void {
  const hasValue = typeof value === 'number'
    ? true
    : value !== null && value !== undefined && String(value).trim() !== '';
  if (!hasValue) return;

  const current = target[field];
  const currentHasValue = typeof current === 'number'
    ? true
    : current !== null && current !== undefined && String(current).trim() !== '';

  if (!currentHasValue) {
    target[field] = value;
  }
  if (target[field] === value || !currentHasValue) addProvenance(provenance, field, provider);
}

function referenceKey(ref: OpenAlexWork['referencedWorks'][number]): string | null {
  const doi = cleanDoi(ref.doi);
  return doi ? `doi:${doi}` : null;
}

function mergeReferences(
  target: OpenAlexWork,
  provenance: FieldProvenance,
  work: MetadataWork,
  provider: MetadataProviderName,
): void {
  for (const ref of work.referencedWorks) {
    const key = referenceKey(ref);
    if (!key) continue;
    const doi = cleanDoi(ref.doi);
    const source = ref.source || provider;
    const existing = target.referencedWorks.find(candidate => referenceKey(candidate) === key);
    if (!existing) {
      target.referencedWorks.push({
        openalexId: ref.openalexId || '',
        doi,
        title: ref.title || '',
        authors: ref.authors || '',
        venue: ref.venue || '',
        firstAuthor: ref.firstAuthor || firstAuthor(ref.authors),
        year: ref.year ?? null,
        source,
      });
      addProvenance(provenance, 'referencedWorks', source);
      continue;
    }

    if (!existing.openalexId && ref.openalexId) existing.openalexId = ref.openalexId;
    if (!existing.title && ref.title) existing.title = ref.title;
    if (!existing.authors && ref.authors) existing.authors = ref.authors;
    if (!existing.venue && ref.venue) existing.venue = ref.venue;
    if (!existing.firstAuthor && (ref.firstAuthor || ref.authors)) {
      existing.firstAuthor = ref.firstAuthor || firstAuthor(ref.authors);
    }
    if (existing.year == null && ref.year != null) existing.year = ref.year;
    if (!existing.source) existing.source = source;
    addProvenance(provenance, 'referencedWorks', source);
  }
}

function mergeResults(doi: string, results: MetadataProviderResult[]): ResolvedWork | null {
  const reports: MetadataProviderReport[] = results.map(result => result.report);
  const found = results.filter(result => result.work);
  if (found.length === 0) return null;

  const merged: OpenAlexWork = {
    doi: cleanDoi(doi),
    title: '',
    authors: '',
    venue: '',
    year: null,
    abstract: '',
    referencedWorks: [],
  };
  const fieldProvenance: FieldProvenance = {};

  for (const result of found) {
    const work = result.work;
    if (!work) continue;
    assignField(merged, fieldProvenance, 'doi', cleanDoi(work.doi) || merged.doi, result.provider);
    assignField(merged, fieldProvenance, 'title', work.title, result.provider);
    assignField(merged, fieldProvenance, 'authors', work.authors, result.provider);
    assignField(merged, fieldProvenance, 'venue', work.venue, result.provider);
    assignField(merged, fieldProvenance, 'year', work.year, result.provider);
    assignField(merged, fieldProvenance, 'abstract', work.abstract, result.provider);
    mergeReferences(merged, fieldProvenance, work, result.provider);
  }

  return {
    ...merged,
    sourcesQueried: results.map(result => result.provider),
    providerReports: reports,
    fieldProvenance,
  };
}

export async function resolveWork(
  doi: string,
  providers: MetadataProvider[] = DEFAULT_METADATA_PROVIDERS,
  creds?: MetadataCredentials,
): Promise<ResolvedWork | null> {
  const lookup = await resolveWorkDetailed(doi, providers, creds);
  return lookup.work;
}

export async function resolveWorkDetailed(
  doi: string,
  providers: MetadataProvider[] = DEFAULT_METADATA_PROVIDERS,
  creds?: MetadataCredentials,
): Promise<WorkMetadataLookup> {
  const results = await Promise.all(providers.map(provider => provider.getWork(doi, creds)));
  const work = mergeResults(doi, results);
  return {
    work,
    sourcesQueried: results.map(result => result.provider),
    providerReports: results.map(result => result.report),
  };
}
