import axios from 'axios';
import type { MetadataCredentials } from './credentials.js';
import type { MetadataProvider } from './types.js';
import {
  cleanDoi,
  firstAuthor,
  providerResult,
  resultFromError,
  statusForWork,
} from './common.js';
import { DEFAULT_POLITE_MAILTO } from './credentials.js';

// OpenCitations split their APIs in 2024+: Meta API for paper metadata, Index API for citations.
// The legacy COCI API at /index/coci/api/v1 returns 410 Gone. The current endpoints:
//   - Metadata: https://opencitations.net/meta/api/v1/metadata/doi:{doi}
//   - References: https://opencitations.net/index/api/v2/references/doi:{doi}
// The base URL covers the host + version-prefixed paths under /meta and /index respectively.
const DEFAULT_BASE = 'https://opencitations.net';

// Hard cap on reference list size — matches OpenAlex client cap. Belt-and-suspenders to keep
// payloads sane on pathological 1000+-ref papers.
const REFERENCE_CAP = 400;

function baseUrl(creds?: MetadataCredentials): string {
  return creds?.openCitationsBaseUrl || DEFAULT_BASE;
}

function metadataUrl(doi: string, creds?: MetadataCredentials): string {
  return `${baseUrl(creds)}/meta/api/v1/metadata/doi:${encodeURIComponent(doi)}`;
}

function referencesUrl(doi: string, creds?: MetadataCredentials): string {
  return `${baseUrl(creds)}/index/api/v2/references/doi:${encodeURIComponent(doi)}`;
}

function userAgent(creds?: MetadataCredentials): string {
  const mailto = creds?.openAlexMailto || DEFAULT_POLITE_MAILTO;
  return `Scimeto/1.65 (replication-discovery; mailto:${mailto})`;
}

function requestHeaders(creds?: MetadataCredentials): Record<string, string> {
  const hdrs: Record<string, string> = {
    'User-Agent': userAgent(creds),
    Accept: 'application/json',
  };
  // Optional auth token — OpenCitations docs note that an access token raises rate limits.
  const token = creds?.openCitationsAccessToken;
  if (token) hdrs.authorization = token;
  return hdrs;
}

// OpenCitations Meta authors come as "Last, First [omid:ra/123]; Last, First [orcid:0000-...]".
function normalizeAuthors(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .split(';')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      // Drop trailing identifier blocks in [omid:..], [orcid:..], etc.
      const noIds = trimmed.replace(/\s*\[[^\]]*\]\s*/gu, '').trim();
      const segments = noIds.split(',').map(s => s.trim()).filter(Boolean);
      if (segments.length >= 2) {
        return `${segments[1]} ${segments[0]}`;
      }
      return noIds;
    })
    .filter(Boolean)
    .join(', ');
}

function parseYear(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const match = String(raw).match(/(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

// `id` field looks like "doi:10.1037/x openalex:W123 omid:br/0123". Pull the DOI.
// `venue` field looks like "Journal Name [issn:.. issn:.. omid:..]". Strip identifier block.
function extractDoiFromId(id: string | undefined | null, fallback: string | null): string | null {
  if (!id) return fallback;
  const match = String(id).match(/doi:(\S+)/i);
  return cleanDoi(match?.[1]) || fallback;
}

function stripIdentifierBlock(value: string | undefined | null): string {
  if (!value) return '';
  return String(value).replace(/\s*\[[^\]]*\]\s*$/u, '').trim();
}

// Reference rows have `cited` like "doi:10.1234/x omid:br/0123" — sometimes only an omid (no DOI).
function citedDoi(cited: string | undefined | null): string | null {
  if (!cited) return null;
  const match = String(cited).match(/doi:(\S+)/i);
  return cleanDoi(match?.[1]);
}

interface OpenCitationsMetadataRow {
  id?: string;
  title?: string;
  author?: string;
  pub_date?: string;
  // Legacy COCI fields preserved for callers configured against the old endpoint.
  year?: string;
  source_title?: string;
  doi?: string;
  venue?: string;
}

interface OpenCitationsReferenceRow {
  cited?: string;
  oci?: string;
}

export const openCitationsProvider: MetadataProvider = {
  name: 'opencitations',
  async getWork(doi: string, creds?: MetadataCredentials) {
    try {
      const metadataResp = await axios.get<OpenCitationsMetadataRow[]>(
        metadataUrl(doi, creds),
        {
          headers: requestHeaders(creds),
          timeout: 15000,
        },
      );
      const rows = Array.isArray(metadataResp.data) ? metadataResp.data : [];
      if (rows.length === 0) {
        return providerResult('opencitations', 'sparse_metadata', null, 'no metadata returned');
      }
      const meta = rows[0] || {};
      const authorsString = normalizeAuthors(meta.author);

      let referenceRows: OpenCitationsReferenceRow[] = [];
      try {
        const refResp = await axios.get<OpenCitationsReferenceRow[]>(
          referencesUrl(doi, creds),
          {
            headers: requestHeaders(creds),
            timeout: 15000,
          },
        );
        referenceRows = Array.isArray(refResp.data) ? refResp.data : [];
      } catch (err) {
        // Don't lose the metadata-only result on a references failure (rate-limit, transient 5xx).
        // 404 means no references available; same effective outcome.
        referenceRows = [];
      }

      const cappedRows = referenceRows.length > REFERENCE_CAP
        ? referenceRows.slice(0, REFERENCE_CAP)
        : referenceRows;
      if (referenceRows.length > REFERENCE_CAP) {
        console.warn(`[openCitationsProvider] references hard-capped from ${referenceRows.length} to ${REFERENCE_CAP}`);
      }

      const referencedWorks = cappedRows
        .map((ref, index) => {
          // Index API v2 returns "doi:10.x omid:br/..." — citedDoi extracts the DOI segment.
          // Legacy COCI returned a bare DOI URL/string in `cited` — fall back via cleanDoi only
          // when the value has no `omid:` token (avoids matching `omid:br/...` as a pseudo-DOI).
          const refDoi = citedDoi(ref.cited)
            || (ref.cited && !/(?:^|\s)omid:/i.test(ref.cited) ? cleanDoi(ref.cited) : null);
          if (!refDoi) return null;
          return {
            openalexId: '',
            doi: refDoi,
            title: '',
            authors: '',
            venue: '',
            firstAuthor: '',
            year: null as number | null,
            source: 'opencitations' as const,
            key: ref.oci || `oc-ref-${index}`,
          };
        })
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

      const work = {
        doi: extractDoiFromId(meta.id, cleanDoi(meta.doi) || cleanDoi(doi)),
        title: meta.title || '',
        authors: authorsString,
        venue: stripIdentifierBlock(meta.venue) || meta.source_title || '',
        year: parseYear(meta.pub_date || meta.year),
        // OpenCitations does not expose abstracts.
        abstract: '',
        referencedWorks,
      };

      // Re-derive firstAuthor on each reference using the helper (no-op when authors is empty).
      for (const ref of work.referencedWorks) {
        ref.firstAuthor = ref.firstAuthor || firstAuthor(ref.authors);
      }

      return providerResult('opencitations', statusForWork(work), work);
    } catch (err) {
      return resultFromError('opencitations', err);
    }
  },
};
