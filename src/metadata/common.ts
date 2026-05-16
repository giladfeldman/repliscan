import axios from 'axios';
import type {
  MetadataProviderName,
  MetadataProviderReport,
  MetadataProviderStatus,
  OpenAlexWork,
} from '../classifier/types.js';
import type { MetadataProviderResult, MetadataWork } from './types.js';
import { normalizeDoi } from '../util/normalizeDoi.js';

export function cleanDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return normalizeDoi(doi);
}

export function emptyWork(doi: string | null): MetadataWork {
  return {
    doi,
    title: '',
    authors: '',
    venue: '',
    year: null,
    abstract: '',
    referencedWorks: [],
  };
}

export function providerResult(
  provider: MetadataProviderName,
  status: MetadataProviderStatus,
  work: MetadataWork | null,
  message?: string,
): MetadataProviderResult {
  return {
    provider,
    report: {
      provider,
      status,
      ...(message ? { message } : {}),
    },
    work,
  };
}

export function axiosErrorReport(provider: MetadataProviderName, err: unknown): MetadataProviderReport {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 404) return { provider, status: 'not_found' };
    if (status === 429) return { provider, status: 'rate_limited', message: 'rate limited' };
    if (status) return { provider, status: 'provider_error', message: `HTTP ${status}` };
    return { provider, status: 'provider_error', message: err.message };
  }
  return { provider, status: 'provider_error', message: err instanceof Error ? err.message : 'unknown error' };
}

export function resultFromError(provider: MetadataProviderName, err: unknown): MetadataProviderResult {
  return { provider, report: axiosErrorReport(provider, err), work: null };
}

export function statusForWork(work: OpenAlexWork): MetadataProviderStatus {
  if (!work.title && !work.authors && !work.year && !work.venue && !work.abstract) {
    return 'sparse_metadata';
  }
  if (work.referencedWorks.length === 0) return 'missing_references';
  return 'found';
}

export function datePartsYear(parts: unknown): number | null {
  if (!Array.isArray(parts)) return null;
  const first = parts[0];
  if (!Array.isArray(first)) return null;
  const year = first[0];
  return typeof year === 'number' ? year : null;
}

export function stripHtml(value: string | null | undefined): string {
  return (value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function authorList(names: Array<string | null | undefined>): string {
  return names.filter(Boolean).join(', ');
}

export function firstAuthor(authors: string | null | undefined): string {
  if (!authors) return '';
  const first = authors.split(',')[0]?.trim() || '';
  const parts = first.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || first;
}
