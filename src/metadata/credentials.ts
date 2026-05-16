/**
 * Credentials threaded into the metadata HTTP clients. repliscan never reads
 * process.env; the consuming app populates this from its own environment.
 * Every field is optional — when absent, each provider falls back to the same
 * default it used before extraction (polite-pool mailto, no API key, etc.).
 */
export interface MetadataCredentials {
  /** OpenAlex API key. When absent, OpenAlex is queried with mailto only. */
  openAlexApiKey?: string;
  /** Polite-pool contact email for OpenAlex / OpenCitations / Crossref author-year. */
  openAlexMailto?: string;
  /** Semantic Scholar API key. */
  semanticScholarApiKey?: string;
  /** OpenCitations base URL override. */
  openCitationsBaseUrl?: string;
  /** OpenCitations access token (raises rate limits). */
  openCitationsAccessToken?: string;
}

/** The default polite-pool mailto used when none is supplied — identical to the
 *  hardcoded fallback that was previously inlined in each provider. */
export const DEFAULT_POLITE_MAILTO = 'collaborativeopenscience@gmail.com';
