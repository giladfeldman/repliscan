/**
 * Candidate normalizer — converts raw API candidates into a stable internal shape,
 * normalizes the DOI, and prepares for ranker scoring.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3
 */

import type { NormalizedCandidate, RawCandidate } from '../types.js';

/**
 * Normalize a DOI to its canonical form: URL-decode, lowercase, drop a
 * "https://doi.org/" / "doi:" prefix, and strip a trailing "." or "/".
 *
 * The earlier version skipped URL-decoding and only stripped a trailing slash
 * (not a trailing dot), so a URL-encoded ("10.1234%2Fabc") or trailing-dot
 * ("10.1234/abc.") candidate DOI did not dedup against its clean resolved form
 * (D4). Kept self-contained — rather than delegating to util/normalizeDoi — so
 * the space-tolerant "doi: " prefix handling this path relies on is preserved
 * (util/normalizeDoi strips only the literal "doi:" and leaves the space).
 */
export function normalizeDoi(doi: string): string {
  if (!doi) return '';
  let d = doi.trim();
  try {
    d = decodeURIComponent(d);
  } catch {
    /* leave as-is if not valid percent-encoding */
  }
  d = d.toLowerCase().trim();
  d = d.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  d = d.replace(/^doi:\s*/, '');
  d = d.replace(/[./]+$/, '');
  return d;
}

/** Convert a single RawCandidate into a NormalizedCandidate with searchScore=0 (set later by ranker). */
export function normalizeCandidate(raw: RawCandidate): NormalizedCandidate {
  return {
    source: raw.source,
    sourceRecordId: raw.sourceRecordId,
    doi: normalizeDoi(raw.doi),
    title: raw.title?.trim(),
    abstract: raw.abstract?.trim(),
    year: raw.year,
    authors: raw.authors,
    journal: raw.journal?.trim(),
    url: raw.url,
    language: raw.language,
    matchedKeywords: [raw.matchedKeyword],
    searchScore: 0,
  };
}

/**
 * Merge two normalized candidates with the same DOI (e.g., same paper found by
 * two different keywords/sources within one page). Keeps non-null metadata from
 * either side; concatenates matchedKeywords (with dedup); takes the higher search score.
 */
export function mergeCandidates(a: NormalizedCandidate, b: NormalizedCandidate): NormalizedCandidate {
  const seen = new Set<string>();
  const merged: NormalizedCandidate['matchedKeywords'] = [];
  for (const m of [...a.matchedKeywords, ...b.matchedKeywords]) {
    const key = `${m.id}|${m.field}|${m.permutation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
  }
  return {
    source: a.source,                      // keep first-seen source for the row
    sourceRecordId: a.sourceRecordId ?? b.sourceRecordId,
    doi: a.doi,
    title: a.title ?? b.title,
    abstract: a.abstract ?? b.abstract,
    year: a.year ?? b.year,
    authors: a.authors ?? b.authors,
    journal: a.journal ?? b.journal,
    url: a.url ?? b.url,
    language: a.language ?? b.language,
    matchedKeywords: merged,
    searchScore: Math.max(a.searchScore, b.searchScore),
  };
}
