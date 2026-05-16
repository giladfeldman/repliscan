import axios from 'axios';
import type { MetadataCredentials } from './credentials.js';
import type { MetadataProvider } from './types.js';
import {
  authorList,
  cleanDoi,
  providerResult,
  resultFromError,
  statusForWork,
  stripHtml,
} from './common.js';

const DATACITE_API = 'https://api.datacite.org/dois';

function creatorName(creator: any): string {
  return creator?.name
    || [creator?.givenName, creator?.familyName].filter(Boolean).join(' ')
    || '';
}

function abstractFromDescriptions(descriptions: any[]): string {
  const abstract = descriptions.find(d => String(d?.descriptionType || '').toLowerCase() === 'abstract');
  return stripHtml(abstract?.description || '');
}

function relatedReferenceDoi(related: any): string | null {
  const relationType = String(related?.relationType || '').toLowerCase();
  const identifierType = String(related?.relatedIdentifierType || '').toLowerCase();
  if (!['cites', 'references'].includes(relationType)) return null;
  if (identifierType !== 'doi') return null;
  return cleanDoi(related.relatedIdentifier);
}

export const dataCiteProvider: MetadataProvider = {
  name: 'datacite',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const { data } = await axios.get(`${DATACITE_API}/${encodeURIComponent(doi)}`, {
        headers: { Accept: 'application/vnd.api+json' },
        timeout: 15000,
      });
      const attrs = data?.data?.attributes;
      if (!attrs) return providerResult('datacite', 'sparse_metadata', null, 'missing attributes payload');

      const relatedRefs = (attrs.relatedIdentifiers || [])
        .map((related: any) => relatedReferenceDoi(related))
        .filter(Boolean)
        .map((refDoi: string) => ({
          openalexId: '',
          doi: refDoi,
          title: '',
          authors: '',
          venue: '',
          firstAuthor: '',
          year: null,
          source: 'datacite' as const,
        }));

      const structuredRefs = (attrs.references || [])
        .map((ref: any) => ({
          openalexId: '',
          doi: cleanDoi(ref.doi || ref.DOI),
          title: ref.title || '',
          authors: ref.creator || '',
          venue: ref.publisher || '',
          firstAuthor: String(ref.creator || '').split(/\s+/)[0] || '',
          year: ref.publicationYear ? Number.parseInt(String(ref.publicationYear), 10) : null,
          source: 'datacite' as const,
        }))
        .filter((ref: any) => ref.doi);

      const creators = attrs.creators || [];
      const work = {
        doi: cleanDoi(attrs.doi),
        title: attrs.titles?.[0]?.title || '',
        authors: authorList(creators.map(creatorName)),
        venue: attrs.publisher || attrs.container?.title || '',
        year: typeof attrs.publicationYear === 'number' ? attrs.publicationYear : null,
        abstract: abstractFromDescriptions(attrs.descriptions || []),
        referencedWorks: [...structuredRefs, ...relatedRefs],
      };

      return providerResult('datacite', statusForWork(work), work);
    } catch (err) {
      return resultFromError('datacite', err);
    }
  },
};
