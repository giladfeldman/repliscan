import axios from 'axios';
import type { MetadataCredentials } from './credentials.js';
import type { MetadataProvider } from './types.js';
import {
  authorList,
  cleanDoi,
  firstAuthor,
  providerResult,
  resultFromError,
  statusForWork,
} from './common.js';

const S2_API = 'https://api.semanticscholar.org/graph/v1/paper';

function headers(creds?: MetadataCredentials): Record<string, string> {
  return creds?.semanticScholarApiKey ? { 'x-api-key': creds.semanticScholarApiKey } : {};
}

function doiFromExternalIds(externalIds: any): string | null {
  return cleanDoi(externalIds?.DOI || externalIds?.doi);
}

export const semanticScholarProvider: MetadataProvider = {
  name: 'semantic-scholar',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const fields = [
        'externalIds',
        'title',
        'abstract',
        'year',
        'venue',
        'authors.name',
        'references.externalIds',
        'references.title',
        'references.authors.name',
        'references.year',
        'references.venue',
      ].join(',');
      const { data } = await axios.get(`${S2_API}/${encodeURIComponent(`DOI:${doi}`)}`, {
        params: { fields },
        headers: headers(creds),
        timeout: 15000,
      });

      const work = {
        doi: doiFromExternalIds(data?.externalIds) || cleanDoi(doi),
        title: data?.title || '',
        authors: authorList((data?.authors || []).map((author: any) => author?.name || '')),
        venue: data?.venue || '',
        year: typeof data?.year === 'number' ? data.year : null,
        abstract: data?.abstract || '',
        referencedWorks: (data?.references || [])
          .map((ref: any) => {
            const authors = authorList((ref?.authors || []).map((author: any) => author?.name || ''));
            return {
              openalexId: '',
              doi: doiFromExternalIds(ref?.externalIds),
              title: ref?.title || '',
              authors,
              venue: ref?.venue || '',
              firstAuthor: firstAuthor(authors),
              year: typeof ref?.year === 'number' ? ref.year : null,
              source: 'semantic-scholar' as const,
            };
          })
          .filter((ref: any) => ref.doi),
      };

      return providerResult('semantic-scholar', statusForWork(work), work);
    } catch (err) {
      return resultFromError('semantic-scholar', err);
    }
  },
};
