import { describe, it, expect } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSearchScore,
  loadRankingWeights,
  type RankingWeights,
} from '../../src/discovery/engine/candidateRanker.js';
import {
  normalizeCandidate,
  normalizeDoi,
  mergeCandidates,
} from '../../src/discovery/engine/candidateNormalizer.js';
import type {
  NormalizedCandidate,
  RawCandidate,
  SourceId,
} from '../../src/discovery/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_DIR = path.resolve(
  __dirname,
  '../../src/discovery/spec',
);

const WEIGHTS: RankingWeights = {
  formula: {
    contributions: [
      { field: 'title_match', weight: 1.0 },
      { field: 'abstract_match', weight: 0.5 },
      { field: 'multi_keyword_bonus', weight: 0.2 },
      { field: 'source_diversity_bonus', weight: 0.1 },
    ],
    cap: 1.0,
  },
};

const mkCand = (
  matched: NormalizedCandidate['matchedKeywords'],
): Pick<NormalizedCandidate, 'matchedKeywords'> => ({ matchedKeywords: matched });

describe('normalizeDoi', () => {
  it('lowercases and strips https://doi.org/ prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1037/ABC')).toBe('10.1037/abc');
  });

  it('strips dx.doi.org prefix', () => {
    expect(normalizeDoi('https://dx.doi.org/10.1037/abc')).toBe('10.1037/abc');
  });

  it('strips doi: prefix', () => {
    expect(normalizeDoi('doi: 10.1037/abc')).toBe('10.1037/abc');
  });

  it('strips trailing slash', () => {
    expect(normalizeDoi('10.1037/abc/')).toBe('10.1037/abc');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeDoi('')).toBe('');
  });
});

describe('normalizeCandidate', () => {
  it('preserves authors object verbatim and sets searchScore to 0', () => {
    const raw: RawCandidate = {
      source: 'openalex',
      doi: 'https://doi.org/10.1037/ABC',
      title: '  A direct replication ',
      abstract: '  We replicated...  ',
      year: 2021,
      authors: [{ name: 'Doe, J' }],
      journal: 'JESP',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    };
    const out = normalizeCandidate(raw);
    expect(out.doi).toBe('10.1037/abc');
    expect(out.title).toBe('A direct replication');
    expect(out.abstract).toBe('We replicated...');
    expect(out.searchScore).toBe(0);
    expect(out.matchedKeywords).toEqual([{ id: 'REP_OF', field: 'title', permutation: 'replication of' }]);
  });
});

describe('mergeCandidates', () => {
  it('unions matchedKeywords (dedup by id|field|permutation)', () => {
    const a = normalizeCandidate({
      source: 'openalex',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    const b = normalizeCandidate({
      source: 'crossref',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'WE_REPLICATED', field: 'abstract', permutation: 'we replicated' },
    });
    const merged = mergeCandidates(a, b);
    expect(merged.matchedKeywords).toHaveLength(2);
    expect(merged.matchedKeywords.map((m) => m.id).sort()).toEqual(['REP_OF', 'WE_REPLICATED']);
  });

  it('drops duplicate matchedKeywords entries', () => {
    const a = normalizeCandidate({
      source: 'openalex',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    const b = normalizeCandidate({
      source: 'openalex',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    const merged = mergeCandidates(a, b);
    expect(merged.matchedKeywords).toHaveLength(1);
  });

  it('takes higher searchScore', () => {
    const a = normalizeCandidate({
      source: 'openalex',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    a.searchScore = 0.7;
    const b = normalizeCandidate({
      source: 'crossref',
      doi: '10.1037/abc',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    b.searchScore = 0.9;
    expect(mergeCandidates(a, b).searchScore).toBe(0.9);
  });

  it('fills nullish metadata from the other side', () => {
    const a = normalizeCandidate({
      source: 'openalex',
      doi: '10.1037/abc',
      title: 'X',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    });
    const b = normalizeCandidate({
      source: 'crossref',
      doi: '10.1037/abc',
      abstract: 'Y',
      matchedKeyword: { id: 'REP_OF', field: 'abstract', permutation: 'replication of' },
    });
    const merged = mergeCandidates(a, b);
    expect(merged.title).toBe('X');
    expect(merged.abstract).toBe('Y');
  });
});

describe('computeSearchScore', () => {
  const oneSource = new Set<SourceId>(['openalex']);
  const twoSources = new Set<SourceId>(['openalex', 'crossref']);

  it('1.0 for title hit + multi keyword + multi source (capped)', () => {
    const cand = mkCand([
      { id: 'REP_OF', field: 'title', permutation: 'replication of' },
      { id: 'WE_REPLICATED', field: 'title', permutation: 'we replicated' },
    ]);
    expect(computeSearchScore(cand, twoSources, WEIGHTS)).toBe(1.0);
  });

  it('0.5 for abstract-only hit, single keyword, single source', () => {
    const cand = mkCand([{ id: 'REP_OF', field: 'abstract', permutation: 'replication of' }]);
    expect(computeSearchScore(cand, oneSource, WEIGHTS)).toBe(0.5);
  });

  it('1.0 for title hit even when only one keyword + one source', () => {
    const cand = mkCand([{ id: 'REP_OF', field: 'title', permutation: 'replication of' }]);
    expect(computeSearchScore(cand, oneSource, WEIGHTS)).toBe(1.0);
  });

  it('abstract_match does NOT add when title also matched', () => {
    const cand = mkCand([
      { id: 'REP_OF', field: 'title', permutation: 'replication of' },
      { id: 'REP_OF', field: 'abstract', permutation: 'replication of' },
    ]);
    expect(computeSearchScore(cand, oneSource, WEIGHTS)).toBe(1.0);
  });

  it('caps at weights.formula.cap', () => {
    const cand = mkCand([
      { id: 'REP_OF', field: 'title', permutation: 'replication of' },
      { id: 'WE_REPLICATED', field: 'title', permutation: 'we replicated' },
      { id: 'DIRECT_REP', field: 'title', permutation: 'direct replication' },
    ]);
    expect(computeSearchScore(cand, twoSources, WEIGHTS)).toBe(1.0);
  });

  it('multi_keyword_bonus only fires for ≥2 distinct keyword IDs', () => {
    const cand = mkCand([
      { id: 'REP_OF', field: 'abstract', permutation: 'replication of' },
      { id: 'REP_OF', field: 'abstract', permutation: 'replications of' },
    ]);
    // 0.5 (abstract) + 0 (multi-kw doesn't fire — one id) + 0 (one source) = 0.5
    expect(computeSearchScore(cand, oneSource, WEIGHTS)).toBe(0.5);
  });
});

describe('loadRankingWeights', () => {
  it('loads the committed spec file with expected formula', () => {
    const w = loadRankingWeights(SPEC_DIR);
    expect(w.formula.cap).toBe(1.0);
    expect(w.formula.contributions.length).toBeGreaterThanOrEqual(4);
    const fields = w.formula.contributions.map((c) => c.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'title_match',
        'abstract_match',
        'multi_keyword_bonus',
        'source_diversity_bonus',
      ]),
    );
  });
});
