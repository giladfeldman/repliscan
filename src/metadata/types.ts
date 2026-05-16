import type { MetadataProviderName, MetadataProviderReport, OpenAlexWork } from '../classifier/types.js';

export type MetadataWork = OpenAlexWork;

export interface MetadataProviderResult {
  provider: MetadataProviderName;
  report: MetadataProviderReport;
  work: MetadataWork | null;
}

export interface MetadataProvider {
  name: MetadataProviderName;
  getWork: (doi: string, creds?: import('./credentials.js').MetadataCredentials) => Promise<MetadataProviderResult>;
}
