// apps/worker/src/services/replication/openAlexClient.ts
import axios from 'axios';
import type { OpenAlexWork } from '../classifier/types.js';
import { normalizeDoi } from '../util/normalizeDoi.js';
import type { MetadataCredentials } from './credentials.js';
import { DEFAULT_POLITE_MAILTO } from './credentials.js';

const BASE = 'https://api.openalex.org';

function authParams(creds?: MetadataCredentials): Record<string, string> {
  const key = creds?.openAlexApiKey || null;
  return key
    ? { api_key: key }
    : { mailto: creds?.openAlexMailto || DEFAULT_POLITE_MAILTO };
}

function invertedIndexToText(idx: Record<string, number[]> | null | undefined): string {
  if (!idx) return '';
  const positions: Array<[number, string]> = [];
  for (const [word, pos] of Object.entries(idx)) {
    for (const p of pos) positions.push([p, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(' ');
}

function stripDoiPrefix(url: string | null | undefined): string | null {
  if (!url) return null;
  const norm = normalizeDoi(url);
  return norm || null;
}

function authorFirst(authorships: any[] | undefined): string {
  if (!Array.isArray(authorships)) return '';
  const first = authorships.find(a => a.author_position === 'first') || authorships[0];
  const name: string = first?.author?.display_name || '';
  return name.split(/\s+/).pop() || '';
}

function authorList(authorships: any[] | undefined): string {
  if (!Array.isArray(authorships)) return '';
  return authorships
    .map(a => a?.author?.display_name)
    .filter(Boolean)
    .join(', ');
}

function venueName(work: any): string {
  return work?.primary_location?.source?.display_name
    || work?.host_venue?.display_name
    || work?.locations?.find?.((location: any) => location?.source?.display_name)?.source?.display_name
    || '';
}

async function batchGetWorks(ids: string[], creds?: MetadataCredentials): Promise<any[]> {
  if (ids.length === 0) return [];
  // OpenAlex filter URL caps at ~50 IDs per call. Paginate to recover full reference lists
  // (heavily-referenced papers were silently dropped before the 2026-05-06 hackathon fix).
  const HARD_CAP = 400; // belt-and-suspenders: refuse pathological 1000+-ref papers
  const ALL = ids.slice(0, HARD_CAP);
  if (ids.length > HARD_CAP) {
    console.warn(`[openAlexClient] referenced_works hard-capped from ${ids.length} to ${HARD_CAP}`);
  }
  const all: any[] = [];
  for (let i = 0; i < ALL.length; i += 50) {
    const chunk = ALL.slice(i, i + 50);
    const filter = `openalex_id:${chunk.join('|')}`;
    try {
      const { data } = await axios.get(`${BASE}/works`, {
        params: { filter, per_page: 50, ...authParams(creds) },
        timeout: 15000,
      });
      if (Array.isArray(data?.results)) all.push(...data.results);
    } catch (err) {
      // Don't fail the whole resolution on a single batch error; downstream uses partial refs.
      console.warn(`[openAlexClient] batchGetWorks chunk ${i}-${i + 50} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return all;
}

export async function getWork(doi: string, creds?: MetadataCredentials): Promise<OpenAlexWork | null> {
  const norm = normalizeDoi(doi);
  if (!norm) return null;
  try {
    const { data } = await axios.get(`${BASE}/works/${encodeURIComponent(`doi:${norm}`)}`, {
      params: authParams(creds),
      timeout: 15000,
    });
    const refs: string[] = data.referenced_works || [];
    const refDetails = await batchGetWorks(refs, creds);
    return {
      doi: stripDoiPrefix(data.doi),
      title: data.title || '',
      authors: authorList(data.authorships),
      venue: venueName(data),
      year: typeof data.publication_year === 'number' ? data.publication_year : null,
      abstract: invertedIndexToText(data.abstract_inverted_index),
      referencedWorks: refDetails.map((r: any) => ({
        openalexId: r.id,
        doi: stripDoiPrefix(r.doi),
        title: r.title,
        authors: authorList(r.authorships),
        venue: venueName(r),
        firstAuthor: authorFirst(r.authorships),
        year: r.publication_year ?? null,
      })),
    };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

function stripOpenAlexIdPrefix(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.replace(/^https?:\/\/openalex\.org\//, '');
}

export interface CitingCandidate {
  openalexId: string;
  doi: string | null;
  title: string;
  abstract: string;
  referencedWorkIds: string[];  // raw OpenAlex IDs, untruncated
}

export interface CitingWorksResult {
  targetWorkId: string | null;
  targetTitle?: string;
  targetAuthors?: string;
  targetVenue?: string;
  targetFirstAuthor?: string;
  targetYear?: number;
  candidates: CitingCandidate[];
}

/**
 * Forward-direction lookup. Given an original paper's DOI, return:
 *   - the OpenAlex work ID of the target (for back-ref checks by ID)
 *   - target's authoritative firstAuthor + publication year (for author-year extraction matching)
 *   - candidates: works that cite the target AND have "replication" in title/abstract
 *
 * Each candidate carries its raw `referenced_works` IDs, so the caller can verify
 * back-reference to the target by O(1) ID set lookup — no per-candidate HTTP call
 * and no 50-ref truncation.
 */
export async function getCitingWorks(doi: string, maxResults = 50, creds?: MetadataCredentials): Promise<CitingWorksResult> {
  const norm = normalizeDoi(doi);
  if (!norm) return { targetWorkId: null, candidates: [] };

  let targetData: any;
  try {
    const resp = await axios.get(`${BASE}/works/${encodeURIComponent(`doi:${norm}`)}`, {
      params: authParams(creds),
      timeout: 15000,
    });
    targetData = resp.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return { targetWorkId: null, candidates: [] };
    }
    throw err;
  }
  const targetWorkId = stripOpenAlexIdPrefix(targetData?.id);
  if (!targetWorkId) return { targetWorkId: null, candidates: [] };

  const targetTitle = targetData.title || undefined;
  const targetAuthors = authorList(targetData.authorships) || undefined;
  const targetVenue = venueName(targetData) || undefined;
  const targetFirstAuthor = authorFirst(targetData.authorships) || undefined;
  const targetYear = typeof targetData.publication_year === 'number' ? targetData.publication_year : undefined;

  const filter = `cites:${targetWorkId},default.search:replication`;
  const { data } = await axios.get(`${BASE}/works`, {
    params: { filter, per_page: Math.min(maxResults, 200), ...authParams(creds) },
    timeout: 20000,
  });
  const results = (data.results || []) as any[];
  const candidates: CitingCandidate[] = results.map((r: any) => ({
    openalexId: stripOpenAlexIdPrefix(r.id),
    doi: stripDoiPrefix(r.doi),
    title: r.title || '',
    abstract: invertedIndexToText(r.abstract_inverted_index),
    referencedWorkIds: (r.referenced_works || []).map(stripOpenAlexIdPrefix),
  }));

  return { targetWorkId, targetTitle, targetAuthors, targetVenue, targetFirstAuthor, targetYear, candidates };
}
