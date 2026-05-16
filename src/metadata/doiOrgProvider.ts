import axios from 'axios';
import type { MetadataCredentials } from './credentials.js';
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

const DOI_ORG = 'https://doi.org';

function cslAuthorName(author: any): string {
  if (!author) return '';
  if (author.literal) return author.literal;
  return [author.given, author.family].filter(Boolean).join(' ');
}

export const doiOrgProvider: MetadataProvider = {
  name: 'doi.org',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const { data } = await axios.get(`${DOI_ORG}/${encodeURIComponent(doi)}`, {
        headers: { Accept: 'application/vnd.citationstyles.csl+json' },
        timeout: 15000,
        maxRedirects: 5,
      });

      const work = {
        doi: cleanDoi(data?.DOI || data?.doi || doi),
        title: data?.title || '',
        authors: authorList((data?.author || []).map(cslAuthorName)),
        venue: data?.['container-title'] || data?.publisher || '',
        year: datePartsYear(data?.issued?.['date-parts']),
        abstract: stripHtml(data?.abstract),
        referencedWorks: [],
      };

      return providerResult('doi.org', statusForWork(work), work);
    } catch (err) {
      return resultFromError('doi.org', err);
    }
  },
};
