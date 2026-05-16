// repliscan/src/discovery/spec/loader.ts
// Resolves the EffectiveSpec at run start: reads enabled rows from DB config
// tables, normalises them into typed structs, and hashes the result so the
// snapshot stored on the run row is stable and diffable.
import type {
  EffectiveSpec,
  EffectiveKeyword,
  EffectiveExclusion,
  EffectiveRanking,
} from '../types.js';
import { hashSpec } from './canonical.js';

export interface SpecDb {
  query<T = unknown>(table: string): Promise<T[]>;
}

export async function resolveEffectiveSpec(
  db: SpecDb,
  override?: EffectiveSpec | null,
): Promise<EffectiveSpec> {
  if (override) {
    const fresh = freezeOverride(override);
    return { ...fresh, source: 'override', resolvedAt: new Date().toISOString(), hash: rehashSpecBody(fresh) };
  }

  const keywordRows = await db.query<RawKeyword>('discovery_keywords');
  const exclusionRows = await db.query<RawExclusion>('discovery_exclusions');
  const rankingRows = await db.query<RawRanking>('discovery_ranking_config');

  const keywords: EffectiveKeyword[] = keywordRows
    .map((r) => ({
      id: r.slug,
      phrase: r.phrase,
      permutations: r.permutations,
      weight: Number(r.weight),
      fields: (r.fields ?? ['title', 'abstract']) as EffectiveKeyword['fields'],
      notes: r.notes ?? undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const exclusions: EffectiveExclusion[] = exclusionRows
    .map((r) => ({
      id: r.slug,
      regex: r.regex,
      flags: r.flags ?? ['i'],
      description: r.description ?? '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (rankingRows.length === 0) {
    throw new Error('no enabled ranking config row');
  }
  const r = rankingRows[0]!;
  const ranking: EffectiveRanking = {
    title_weight: Number(r.title_weight),
    abstract_weight: Number(r.abstract_weight),
    multi_keyword_bonus: Number(r.multi_keyword_bonus),
    source_diversity_bonus: Number(r.source_diversity_bonus),
    cap: Number(r.cap),
    min_search_score_threshold: Number(r.min_search_score_threshold ?? 0),
  };

  const body = { keywords, exclusions, ranking };
  return {
    ...body,
    hash: hashSpec(body),
    resolvedAt: new Date().toISOString(),
    source: 'defaults',
  };
}

export function mergeOverride(defaults: EffectiveSpec, override: EffectiveSpec | null): EffectiveSpec {
  return override ?? defaults;
}

function freezeOverride(spec: EffectiveSpec): EffectiveSpec {
  return {
    keywords: [...spec.keywords].sort((a, b) => a.id.localeCompare(b.id)),
    exclusions: [...spec.exclusions].sort((a, b) => a.id.localeCompare(b.id)),
    ranking: spec.ranking,
    hash: '', resolvedAt: '', source: 'override',
  };
}

function rehashSpecBody(spec: EffectiveSpec): string {
  return hashSpec({ keywords: spec.keywords, exclusions: spec.exclusions, ranking: spec.ranking });
}

interface RawKeyword {
  slug: string; phrase: string; permutations: string[]; weight: string | number;
  fields: string[] | null; notes: string | null;
}
interface RawExclusion {
  slug: string; regex: string; flags: string[] | null; description: string | null;
}
interface RawRanking {
  title_weight: string | number; abstract_weight: string | number;
  multi_keyword_bonus: string | number; source_diversity_bonus: string | number;
  cap: string | number; min_search_score_threshold: string | number | null;
}
