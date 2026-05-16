/**
 * Keyword expander — turns user wildcards and the spec's keyword list into a flat
 * array of (keyword id, phrase variant) rows that the runner OR-bundles into one
 * search query per source.
 *
 * Wildcard syntax (used by both the tab UI and the CLI config):
 *   replicat*                          → trailing-stem expansion via STEM_DICT
 *   pre-?registered                    → optional preceding char (zero/one)
 *   (close|high-powered) replication   → alternation groups
 *   "exact phrase"                     → quoted literal, no expansion
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3
 */

import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import type { EffectiveKeyword, ExpandedKeyword, KeywordSpec } from '../types.js';

/**
 * Hand-curated stems used by trailing-* wildcards. Adding a new stem is the
 * recommended way to extend wildcard support; introducing fuller morphology
 * (e.g. via a stemmer library) would compromise the deterministic guarantee
 * that "same input → same expansion" across TS and the future Python port.
 */
const STEM_DICT: Record<string, string[]> = {
  attempt: ['attempt', 'attempted', 'attempts', 'attempting'],
  replicat: ['replicate', 'replicated', 'replicates', 'replicating', 'replication', 'replications'],
  reproduc: ['reproduce', 'reproduced', 'reproduces', 'reproducing', 'reproducible', 'reproducibility'],
};

/**
 * Expand a single user-input string with wildcards into the literal phrases it stands for.
 * Order of operations: quoted literal → alternation group → optional char → trailing star.
 */
export function expandWildcard(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // Quoted literal: "exact phrase" — no expansion
  const quoted = trimmed.match(/^"(.+)"$/);
  if (quoted) return [quoted[1]];

  // Alternation: (a|b|c) — recurse on each branch
  const altRegex = /\(([^()]+)\)/;
  const altMatch = trimmed.match(altRegex);
  if (altMatch) {
    const opts = altMatch[1].split('|').map((s) => s.trim()).filter(Boolean);
    const expanded = opts.flatMap((opt) => expandWildcard(trimmed.replace(altRegex, opt)));
    return Array.from(new Set(expanded));
  }

  // Optional char: x?  — both with and without preceding char (one ? at a time, recurse for more)
  const optMatch = trimmed.match(/(.)\?/);
  if (optMatch) {
    const [match, ch] = optMatch;
    const idx = optMatch.index!;
    const without = trimmed.slice(0, idx) + trimmed.slice(idx + match.length);
    const withCh = trimmed.slice(0, idx) + ch + trimmed.slice(idx + match.length);
    return Array.from(new Set([...expandWildcard(without), ...expandWildcard(withCh)]));
  }

  // Trailing wildcard: replicat*  → stem expansion via STEM_DICT, fallback to literal
  if (trimmed.includes('*')) {
    const starMatch = trimmed.match(/^(.*?)(\w+)\*(.*)$/);
    if (starMatch) {
      const [, prefix, stem, suffix] = starMatch;
      const stems = STEM_DICT[stem.toLowerCase()] ?? [stem];
      return stems.map((s) => `${prefix}${s}${suffix}`);
    }
  }

  return [trimmed];
}

/**
 * Expand a single spec entry (template+qualifiers OR explicit permutations) into
 * flat ExpandedKeyword rows.
 */
export function expandSpecKeyword(spec: KeywordSpec): ExpandedKeyword[] {
  const out: ExpandedKeyword[] = [];

  if (spec.template && spec.qualifiers) {
    for (const q of spec.qualifiers) {
      out.push({
        id: spec.id,
        permutation: spec.template.replace('{qualifier}', q),
        weight: spec.weight,
        fields: spec.fields,
      });
    }
    return out;
  }

  for (const perm of expandPermutationList(spec.permutations ?? [])) {
    out.push({ id: spec.id, permutation: perm, weight: spec.weight, fields: spec.fields });
  }
  return out;
}

/**
 * Expand and dedupe a list of literal phrases or wildcard templates while
 * preserving the user's ordering as much as possible.
 */
export function expandPermutationList(permutations: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const permutation of permutations) {
    for (const expanded of expandWildcard(permutation)) {
      const key = expanded.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(expanded);
    }
  }
  return out;
}

/**
 * Expand user-supplied raw keywords (with wildcards). Each user keyword becomes its own
 * synthetic id (USER_<slug>) so its hits can be attributed back to the user input that
 * triggered them.
 */
export function expandUserInput(rawKeywords: string[]): ExpandedKeyword[] {
  const out: ExpandedKeyword[] = [];
  for (const raw of rawKeywords) {
    const variants = expandWildcard(raw);
    if (variants.length === 0) continue;
    const id = `USER_${raw.replace(/[^a-z0-9]/gi, '_').toUpperCase().slice(0, 32)}`;
    for (const v of variants) {
      out.push({ id, permutation: v, weight: 0.85, fields: ['title', 'abstract'] });
    }
  }
  return out;
}

/**
 * Combine spec-defined keywords + user-supplied keywords into a single deduplicated
 * ExpandedKeyword list. Dedup is by phrase (case-insensitive) — if a user types a
 * phrase that the spec already covers, the spec entry wins (its id and weight are
 * preserved; the user-input row is dropped). This keeps the OR-bundle minimal.
 */
export function expandAll(specKeywords: KeywordSpec[], userKeywords: string[]): ExpandedKeyword[] {
  const seen = new Set<string>();
  const out: ExpandedKeyword[] = [];
  const consider = (k: ExpandedKeyword) => {
    const key = k.permutation.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(k);
  };
  for (const s of specKeywords) for (const e of expandSpecKeyword(s)) consider(e);
  for (const e of expandUserInput(userKeywords)) consider(e);
  return out;
}

/** Load search-keywords.yaml from a spec directory. */
export function loadSpecKeywords(specDir: string): KeywordSpec[] {
  const file = path.join(specDir, 'search-keywords.yaml');
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as { keywords: KeywordSpec[] };
  return doc.keywords;
}

const REGEX_META = /[.+?^${}()|[\]\\]/g;

/**
 * Attribute which keyword/field/permutation hits a candidate's title and
 * abstract. The OR-bundle search returns a candidate whenever any phrase
 * matches; attribution reconstructs *which* phrases actually hit so the
 * benchmark's dead-keyword analysis and per-keyword ranking work.
 *
 * Matching is case-insensitive, word-boundary-sensitive, and uses the
 * literal permutation string (no wildcards — those were already expanded
 * upstream).
 */
export function attributeKeywords(
  title: string,
  abstractText: string,
  keywords: ExpandedKeyword[],
): Array<{ id: string; field: 'title' | 'abstract'; permutation: string }> {
  if (!title && !abstractText) return [];
  const titleLow = (title ?? '').toLowerCase();
  const absLow = (abstractText ?? '').toLowerCase();
  const out: Array<{ id: string; field: 'title' | 'abstract'; permutation: string }> = [];
  const seen = new Set<string>();

  for (const kw of keywords) {
    const escaped = kw.permutation.toLowerCase().replace(REGEX_META, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (kw.fields.includes('title') && titleLow && re.test(titleLow)) {
      const key = `${kw.id}|title|${kw.permutation}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: kw.id, field: 'title', permutation: kw.permutation });
      }
    }
    if (kw.fields.includes('abstract') && absLow && re.test(absLow)) {
      const key = `${kw.id}|abstract|${kw.permutation}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ id: kw.id, field: 'abstract', permutation: kw.permutation });
      }
    }
  }
  return out;
}

/**
 * Convert resolved EffectiveKeywords (from DB) into the existing ExpandedKeyword[] shape
 * that the runner consumes.
 *
 * EffectiveKeyword.permutations may contain either literal phrases or compact wildcard
 * templates saved by the admin UI. Source providers such as OpenAlex do not support
 * those wildcard operators, so they are expanded into literal phrases here before
 * query construction.
 */
export function expandedFromEffective(effective: EffectiveKeyword[]): ExpandedKeyword[] {
  return effective.flatMap((k) =>
    expandPermutationList(k.permutations).map((perm) => ({
      id: k.id,
      permutation: perm,
      weight: k.weight,
      fields: k.fields,
    })),
  );
}
