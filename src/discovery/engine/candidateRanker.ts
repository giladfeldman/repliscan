/**
 * Candidate ranker — computes the deterministic search_score for a NormalizedCandidate
 * using the formula in ranking-weights.yaml.
 *
 * Pure function. Same candidate + same weights file → same score.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3.5
 */

import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import type { EffectiveRanking, NormalizedCandidate, SourceId } from '../types.js';

type RankingFieldName = 'title_match' | 'abstract_match' | 'multi_keyword_bonus' | 'source_diversity_bonus';

export interface RankingWeights {
  formula: {
    contributions: Array<{ field: string; weight: number; condition?: string }>;
    cap: number;
  };
}

export function loadRankingWeights(specDir: string): RankingWeights {
  const file = path.join(specDir, 'ranking-weights.yaml');
  return yaml.load(fs.readFileSync(file, 'utf-8')) as RankingWeights;
}

/** Helper: pull a contribution weight by field name. Returns 0 if not present. */
const w = (weights: RankingWeights, key: RankingFieldName): number =>
  weights.formula.contributions.find((c) => c.field === key)?.weight ?? 0;

/**
 * Compute search_score for a candidate.
 *
 * Inputs:
 *   - candidate: the NormalizedCandidate (whose matchedKeywords array drives the score)
 *   - sourcesMatched: set of source IDs that returned this DOI in the run
 *   - weights: parsed ranking-weights.yaml
 *
 * Formula contributions (as configured):
 *   - title_match (1.0):  any keyword matched the title
 *   - abstract_match (0.5): any keyword matched the abstract — only counted if no title match
 *   - multi_keyword_bonus (0.2): two or more distinct keyword IDs matched
 *   - source_diversity_bonus (0.1): two or more sources returned this DOI
 *
 * Result is capped at weights.formula.cap (1.0).
 */
export function computeSearchScore(
  candidate: Pick<NormalizedCandidate, 'matchedKeywords'>,
  sourcesMatched: Set<SourceId>,
  weights: RankingWeights,
): number {
  let score = 0;

  const titleHit = candidate.matchedKeywords.some((m) => m.field === 'title');
  const abstractHit = candidate.matchedKeywords.some((m) => m.field === 'abstract');
  const distinctKeywordIds = new Set(candidate.matchedKeywords.map((m) => m.id)).size;

  if (titleHit) {
    score += w(weights, 'title_match');
  } else if (abstractHit) {
    score += w(weights, 'abstract_match');
  }
  if (distinctKeywordIds >= 2) score += w(weights, 'multi_keyword_bonus');
  if (sourcesMatched.size >= 2) score += w(weights, 'source_diversity_bonus');

  return Math.min(score, weights.formula.cap);
}

/**
 * Convert EffectiveRanking (from DB) into the existing RankingWeights shape used by computeSearchScore.
 */
export function weightsFromEffective(r: EffectiveRanking): RankingWeights {
  const contributions: Array<{ field: RankingFieldName; weight: number }> = [
    { field: 'title_match', weight: r.title_weight },
    { field: 'abstract_match', weight: r.abstract_weight },
    { field: 'multi_keyword_bonus', weight: r.multi_keyword_bonus },
    { field: 'source_diversity_bonus', weight: r.source_diversity_bonus },
  ];
  return {
    formula: {
      contributions,
      cap: r.cap,
    },
  };
}
