import type { MetadataCredentials } from './credentials.js';
import { DEFAULT_POLITE_MAILTO } from './credentials.js';
import type { MetadataProvider } from './types.js';
import {
  authorList,
  cleanDoi,
  datePartsYear,
  providerResult,
  resultFromError,
  statusForWork,
  stripHtml,
} from './common.js';
import { crossrefGet } from './crossrefHttp.js';

const CROSSREF_API = 'https://api.crossref.org/works';

function crossrefAuthorName(author: any): string {
  if (!author) return '';
  const parts = [author.given, author.family].filter(Boolean);
  return parts.join(' ') || author.name || '';
}

function yearFromMessage(message: any): number | null {
  return datePartsYear(message?.published?.['date-parts'])
    ?? datePartsYear(message?.['published-print']?.['date-parts'])
    ?? datePartsYear(message?.['published-online']?.['date-parts'])
    ?? datePartsYear(message?.created?.['date-parts']);
}

function referenceFirstAuthor(raw: string | undefined): string {
  if (!raw) return '';
  const first = raw.split(/\s+and\s+|,\s*&\s*|;\s*/i)[0]?.trim() || '';
  return first.split(/\s+/)[0]?.replace(/[.,]/g, '') || '';
}

export const crossrefProvider: MetadataProvider = {
  name: 'crossref',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const { data } = await crossrefGet(`${CROSSREF_API}/${encodeURIComponent(doi)}`, {
        timeout: 15000,
      }, creds?.openAlexMailto);
      const message = data?.message;
      if (!message) return providerResult('crossref', 'sparse_metadata', null, 'missing message payload');

      const work = {
        doi: cleanDoi(message.DOI),
        title: message.title?.[0] || message['short-title']?.[0] || '',
        authors: authorList((message.author || []).map(crossrefAuthorName)),
        venue: message['container-title']?.[0] || message['short-container-title']?.[0] || '',
        year: yearFromMessage(message),
        abstract: stripHtml(message.abstract),
        referencedWorks: (message.reference || [])
          .map((ref: any, index: number) => ({
            openalexId: '',
            doi: cleanDoi(ref.DOI || ref.doi),
            title: ref['article-title'] || ref['series-title'] || ref['volume-title'] || '',
            authors: ref.author || '',
            venue: ref['journal-title'] || '',
            firstAuthor: referenceFirstAuthor(ref.author),
            year: ref.year ? Number.parseInt(String(ref.year), 10) : null,
            source: 'crossref' as const,
            key: ref.key || `crossref-ref-${index}`,
          }))
          .filter((ref: any) => ref.doi),
      };

      return providerResult('crossref', statusForWork(work), work);
    } catch (err) {
      return resultFromError('crossref', err);
    }
  },
};
