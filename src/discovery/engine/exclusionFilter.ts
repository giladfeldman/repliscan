/**
 * Exclusion filter — applies post-fetch regex patterns from exclusion-patterns.yaml
 * to drop candidates whose title+abstract match a non-scholarly replication context
 * (DNA replication, code/data replication, replication fork/origin/stress/timing, etc.).
 *
 * Patterns are applied AFTER the API search returns, not as part of the OR-bundle —
 * no public search API supports negative regex search reliably.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3.3
 */

import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import type { EffectiveExclusion, ExclusionPattern } from '../types.js';

export type ExclusionResult =
  | { excluded: true; reason: string }
  | { excluded: false };

/**
 * Test text against the configured exclusion patterns. Returns the FIRST matching
 * pattern's id as `reason`, or { excluded: false } when no pattern fires.
 */
export function applyExclusions(text: string, patterns: ExclusionPattern[]): ExclusionResult {
  if (!text) return { excluded: false };
  for (const p of patterns) {
    const flags = (p.flags ?? []).join('');
    const re = new RegExp(p.regex, flags);
    if (re.test(text)) {
      return { excluded: true, reason: p.id };
    }
  }
  return { excluded: false };
}

/** Load exclusion-patterns.yaml from a spec directory. */
export function loadExclusionPatterns(specDir: string): ExclusionPattern[] {
  const file = path.join(specDir, 'exclusion-patterns.yaml');
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as { patterns: ExclusionPattern[] };
  return doc.patterns;
}

/**
 * Convert EffectiveExclusion[] (from DB) into the existing ExclusionPattern[] shape.
 */
export function patternsFromEffective(effective: EffectiveExclusion[]): ExclusionPattern[] {
  return effective.map((e) => ({
    id: e.id,
    regex: e.regex,
    flags: e.flags,
    description: e.description,
  }));
}
