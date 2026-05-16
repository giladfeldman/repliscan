// apps/worker/src/services/replication/crossrefAuthorYearResolver.ts
//
// Tier-2 Crossref author-year fallback resolver.
//
// When the rule-based + back-ref replication extractor cannot determine the
// original DOI but an "Author (YYYY)" mention IS extractable from the abstract,
// this service queries Crossref to find the matching original paper.
//
// Anti-hallucination: NEVER invents a DOI. If Crossref returns nothing, no
// candidate scores >= 5, or top/runner-up gap < 1, we return matched=false.
//
// Ported from scripts/replication/hackathon-2026-05-06/resolve-author-year.mjs.
// Scoring algorithm and rate-limit semantics preserved exactly.

import axios from 'axios';
import { cleanDoi } from './common.js';
import { DEFAULT_POLITE_MAILTO } from './credentials.js';

export interface AuthorYearMention {
  /** Raw mention text such as "Carney et al." or "Smith and Jones". */
  author: string;
  year: number;
  sentence?: string;
  replicationTitle?: string;
}

export interface CrossrefAuthorYearCandidate {
  doi: string;
  title: string;
  firstAuthor: string;
  year: number | null;
  container: string;
  score: number;
  reasons: string[];
}

export type AuthorYearResolutionReason =
  | 'no-candidates'
  | 'below-threshold'
  | 'ambiguous'
  | 'confident-match'
  | 'provider-error';

export interface CrossrefAuthorYearResolution {
  matched: boolean;
  doi: string | null;
  score: number;
  runnerUpScore: number;
  candidates: CrossrefAuthorYearCandidate[];
  reason: AuthorYearResolutionReason;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'with', 'from', 'by',
  'this', 'these', 'those', 'that', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'we', 'our', 'their', 'his', 'her', 'its', 'it', 'at', 'as', 'via', 'using', 'through',
  'study', 'studies', 'research', 'paper', 'article', 'findings', 'effect', 'effects',
  'result', 'results', 'data', 'analysis', 'analyses', 'replication', 'replications',
  'replicate', 'replicated', 'reproducing', 'reproducibility', 'registered', 'direct',
  'conceptual', 'preregistered', 'pre-registered', 'attempt', 'attempts', 'attempted',
]);

const REQ_PER_SEC = 1.5;
const MIN_INTERVAL_MS = 1000 / REQ_PER_SEC; // ~667ms

// Module-level rate-limit gate — chained promise so concurrent callers serialise
// their Crossref hits while still resolving fairly in arrival order. The gate
// only enforces a minimum gap BETWEEN calls; the first call after an idle
// period proceeds immediately.
let lastCallAt = 0;
let throttleChain: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const previous = throttleChain;
  let release: () => void = () => undefined;
  throttleChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(async () => {
    const since = Date.now() - lastCallAt;
    const wait = Math.max(0, MIN_INTERVAL_MS - since);
    if (wait > 0) {
      await new Promise<void>((r) => setTimeout(r, wait));
    }
    lastCallAt = Date.now();
    release();
  });
}

function extractKeywords(title: string | undefined | null, n = 6): string[] {
  if (!title) return [];
  const words = title.toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

function lastNameOf(authorString: string): string {
  // "Smith and Johnson" -> "Smith"
  // "Smith et al." -> "Smith"
  // "Smith, Jones, & Roe" -> "Smith"
  // "van der Berg, Jones, & Smith" -> "Berg" (last token of first comma-split)
  const cleaned = authorString
    .replace(/\bet\s+al\.?/gi, '')
    .split(/\s+(?:and|&|,)\s+|,\s+/)[0]
    .trim();
  const tokens = cleaned.split(/\s+/);
  return tokens[tokens.length - 1] || cleaned;
}

function tokenize(s: string | undefined | null): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

interface ScoreResult {
  score: number;
  reasons: string[];
}

function scoreMatch(
  crItem: any,
  mention: AuthorYearMention,
  replicationTitleKeywords: string[],
): ScoreResult {
  let score = 0;
  const reasons: string[] = [];

  // First-author last-name match
  const crFirstAuthor = crItem.author?.[0];
  const crLastName: string = String(crFirstAuthor?.family || '').toLowerCase();
  const mentionLastName = lastNameOf(mention.author).toLowerCase();
  if (crLastName && mentionLastName && crLastName === mentionLastName) {
    score += 3;
    reasons.push(`first-author-match:${crLastName}`);
  } else if (
    crLastName && mentionLastName &&
    (crLastName.includes(mentionLastName) || mentionLastName.includes(crLastName))
  ) {
    score += 1;
    reasons.push(`first-author-partial:${crLastName}~${mentionLastName}`);
  }

  // Year exact match
  const rawYear = crItem.issued?.['date-parts']?.[0]?.[0]
    ?? crItem.published?.['date-parts']?.[0]?.[0]
    ?? crItem['published-print']?.['date-parts']?.[0]?.[0]
    ?? crItem['published-online']?.['date-parts']?.[0]?.[0];
  const crYearNum = rawYear != null ? parseInt(String(rawYear), 10) : NaN;
  if (!Number.isNaN(crYearNum) && crYearNum === mention.year) {
    score += 2;
    reasons.push(`year-exact:${crYearNum}`);
  } else if (!Number.isNaN(crYearNum) && Math.abs(crYearNum - mention.year) <= 1) {
    score += 0.5;
    reasons.push(`year-close:${crYearNum}`);
  }

  // Title keyword overlap (replication title keywords as weak proxy for original-title keywords)
  const crTitle = String(crItem.title?.[0] || '').toLowerCase();
  if (crTitle && replicationTitleKeywords.length) {
    const crTokens = tokenize(crTitle);
    const repTokens = new Set(replicationTitleKeywords);
    const overlap = jaccardOverlap(crTokens, repTokens);
    if (overlap >= 0.2) {
      score += 2;
      reasons.push(`title-overlap:${overlap.toFixed(2)}`);
    } else if (overlap >= 0.1) {
      score += 1;
      reasons.push(`title-overlap-weak:${overlap.toFixed(2)}`);
    }
  }

  // Penalize if candidate title looks like a replication itself (we want the original)
  if (crTitle && /replicat|reproduc/i.test(crTitle)) {
    score -= 1;
    reasons.push('penalty-title-replication');
  }

  return { score, reasons };
}

function buildCandidate(item: any, score: number, reasons: string[]): CrossrefAuthorYearCandidate {
  const rawDoi = String(item?.DOI || '');
  const normalized = cleanDoi(rawDoi) || rawDoi.toLowerCase();
  const firstAuthorObj = item?.author?.[0];
  const firstAuthorName = firstAuthorObj
    ? `${String(firstAuthorObj.given || '')} ${String(firstAuthorObj.family || '')}`.trim()
    : '';
  const yearRaw = item?.issued?.['date-parts']?.[0]?.[0]
    ?? item?.published?.['date-parts']?.[0]?.[0]
    ?? null;
  const yearNum = yearRaw != null ? parseInt(String(yearRaw), 10) : NaN;
  return {
    doi: normalized,
    title: String(item?.title?.[0] || ''),
    firstAuthor: firstAuthorName,
    year: Number.isNaN(yearNum) ? null : yearNum,
    container: String(item?.['container-title']?.[0] || ''),
    score,
    reasons,
  };
}

export async function resolveAuthorYearViaCrossref(
  mention: AuthorYearMention,
  options: { signal?: AbortSignal; mailto?: string } = {},
): Promise<CrossrefAuthorYearResolution> {
  const mailto = options.mailto || DEFAULT_POLITE_MAILTO;
  const titleKeywords = extractKeywords(mention.replicationTitle, 6);

  const params = new URLSearchParams();
  const queryAuthor = mention.author.replace(/\bet\s+al\.?/gi, '').trim();
  if (queryAuthor) params.set('query.author', queryAuthor);
  if (titleKeywords.length) params.set('query.bibliographic', titleKeywords.join(' '));
  params.set(
    'filter',
    `from-pub-date:${mention.year - 1},until-pub-date:${mention.year + 1},type:journal-article`,
  );
  params.set('rows', '5');
  params.set('select', 'DOI,title,author,issued,container-title');
  if (mailto) params.set('mailto', mailto);

  const url = `https://api.crossref.org/works?${params.toString()}`;
  const headers: Record<string, string> = mailto
    ? { 'User-Agent': `Scimeto-AuthorYearResolver/1.0 (mailto:${mailto})` }
    : {};

  await throttle();

  let items: any[] = [];
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers,
      signal: options.signal,
    });
    items = Array.isArray(data?.message?.items) ? data.message.items : [];
  } catch (err) {
    const status = (err as any)?.response?.status;
    if (status === 429) {
      console.warn('[crossrefAuthorYearResolver] rate limited (HTTP 429)');
    } else {
      console.warn(
        '[crossrefAuthorYearResolver] provider error:',
        (err as any)?.message || String(err),
      );
    }
    return {
      matched: false,
      doi: null,
      score: 0,
      runnerUpScore: 0,
      candidates: [],
      reason: 'provider-error',
    };
  }

  if (items.length === 0) {
    return {
      matched: false,
      doi: null,
      score: 0,
      runnerUpScore: 0,
      candidates: [],
      reason: 'no-candidates',
    };
  }

  const scored = items
    .map((item) => {
      const { score, reasons } = scoreMatch(item, mention, titleKeywords);
      return buildCandidate(item, score, reasons);
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1];
  const topScore = top?.score ?? 0;
  const runnerUpScore = runnerUp?.score ?? 0;

  if (!top || !top.doi) {
    return {
      matched: false,
      doi: null,
      score: topScore,
      runnerUpScore,
      candidates: scored,
      reason: 'no-candidates',
    };
  }

  if (topScore < 5) {
    return {
      matched: false,
      doi: null,
      score: topScore,
      runnerUpScore,
      candidates: scored,
      reason: 'below-threshold',
    };
  }

  if (runnerUp && topScore - runnerUpScore < 1) {
    return {
      matched: false,
      doi: null,
      score: topScore,
      runnerUpScore,
      candidates: scored,
      reason: 'ambiguous',
    };
  }

  return {
    matched: true,
    doi: top.doi,
    score: topScore,
    runnerUpScore,
    candidates: scored,
    reason: 'confident-match',
  };
}
