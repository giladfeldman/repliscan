import type { MetadataCredentials } from './credentials.js';
import type { MetadataProvider } from './types.js';
import { providerResult, resultFromError, statusForWork } from './common.js';
import { getWork } from './openAlexClient.js';

export const openAlexProvider: MetadataProvider = {
  name: 'openalex',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const work = await getWork(doi, creds);
      if (!work) return providerResult('openalex', 'not_found', null);
      return providerResult('openalex', statusForWork(work), work);
    } catch (err) {
      return resultFromError('openalex', err);
    }
  },
};
