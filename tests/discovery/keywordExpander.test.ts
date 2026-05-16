import { describe, it, expect } from '@jest/globals';
import {
  expandWildcard,
  expandSpecKeyword,
  expandUserInput,
  expandAll,
  expandedFromEffective,
  attributeKeywords,
} from '../../src/discovery/engine/keywordExpander.js';
import type { EffectiveKeyword, ExpandedKeyword, KeywordSpec } from '../../src/discovery/types.js';

describe('expandWildcard', () => {
  it('returns empty for empty input', () => {
    expect(expandWildcard('')).toEqual([]);
    expect(expandWildcard('   ')).toEqual([]);
  });

  it('preserves quoted literals without expansion', () => {
    expect(expandWildcard('"exact phrase"')).toEqual(['exact phrase']);
    expect(expandWildcard('"replicat*"')).toEqual(['replicat*']);
  });

  it('expands trailing * via STEM_DICT', () => {
    const out = expandWildcard('replicat*');
    expect(out).toEqual(
      expect.arrayContaining(['replicate', 'replicated', 'replicating', 'replication', 'replications']),
    );
    expect(out.length).toBeGreaterThanOrEqual(5);
  });

  it('preserves prefix and suffix around trailing *', () => {
    const out = expandWildcard('direct replicat*');
    expect(out).toContain('direct replication');
    expect(out).toContain('direct replications');
  });

  it('expands attempt* into common attempt variants', () => {
    const out = expandWildcard('attempt* to replicate');
    expect(out).toEqual([
      'attempt to replicate',
      'attempted to replicate',
      'attempts to replicate',
      'attempting to replicate',
    ]);
  });

  it('expands ? as optional preceding char', () => {
    const out = expandWildcard('pre-?registered');
    expect(out).toEqual(expect.arrayContaining(['preregistered', 'pre-registered']));
    expect(out).toHaveLength(2);
  });

  it('expands alternation groups', () => {
    const out = expandWildcard('(close|high-powered) replication');
    expect(out).toEqual(['close replication', 'high-powered replication']);
  });

  it('combines alternation with trailing wildcard', () => {
    const out = expandWildcard('(direct|conceptual) replicat*');
    expect(out).toContain('direct replication');
    expect(out).toContain('conceptual replication');
    expect(out).toContain('direct replicate');
    expect(out).toContain('conceptual replicate');
  });

  it('returns input unchanged when no wildcards present', () => {
    expect(expandWildcard('successfully replicated')).toEqual(['successfully replicated']);
  });

  it('falls back to literal stem when stem is unknown', () => {
    expect(expandWildcard('zzz*')).toEqual(['zzz']);
  });
});

describe('expandSpecKeyword', () => {
  it('expands template + qualifiers into permutations', () => {
    const spec: KeywordSpec = {
      id: 'REP_QUALIFIED',
      template: '{qualifier} replication',
      qualifiers: ['close', 'high-powered'],
      weight: 0.85,
      fields: ['title', 'abstract'],
    };
    const out = expandSpecKeyword(spec);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'REP_QUALIFIED',
      permutation: 'close replication',
      weight: 0.85,
      fields: ['title', 'abstract'],
    });
    expect(out[1].permutation).toBe('high-powered replication');
  });

  it('expands explicit permutations when no template provided', () => {
    const spec: KeywordSpec = {
      id: 'REP_OF',
      phrase: 'replication of',
      permutations: ['replication of', 'replications of'],
      weight: 1.0,
      fields: ['title', 'abstract'],
    };
    const out = expandSpecKeyword(spec);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.permutation)).toEqual(['replication of', 'replications of']);
  });

  it('expands wildcard templates inside explicit permutations', () => {
    const spec: KeywordSpec = {
      id: 'ATTEMPT_TO_REP',
      phrase: 'attempt to replicate',
      permutations: ['attempt* to replicate'],
      weight: 0.9,
      fields: ['title', 'abstract'],
    };
    const out = expandSpecKeyword(spec);
    expect(out.map((o) => o.permutation)).toEqual([
      'attempt to replicate',
      'attempted to replicate',
      'attempts to replicate',
      'attempting to replicate',
    ]);
  });

  it('returns empty array when neither template nor permutations are set', () => {
    const spec: KeywordSpec = {
      id: 'EMPTY',
      weight: 1.0,
      fields: ['title'],
    };
    expect(expandSpecKeyword(spec)).toEqual([]);
  });
});

describe('expandUserInput', () => {
  it('synthesizes USER_<slug> ids and 0.85 weight', () => {
    const out = expandUserInput(['direct replicat*']);
    expect(out.length).toBeGreaterThan(0);
    for (const k of out) {
      expect(k.id).toMatch(/^USER_/);
      expect(k.weight).toBe(0.85);
      expect(k.fields).toEqual(['title', 'abstract']);
    }
  });

  it('skips empty inputs', () => {
    expect(expandUserInput(['', '   '])).toEqual([]);
  });

  it('keeps the same id across all variants of one user input', () => {
    const out = expandUserInput(['(direct|conceptual) replication']);
    const ids = new Set(out.map((o) => o.id));
    expect(ids.size).toBe(1);
  });
});

describe('expandAll', () => {
  it('deduplicates across spec and user inputs', () => {
    const spec: KeywordSpec[] = [
      {
        id: 'DIRECT_REP',
        phrase: 'direct replication',
        permutations: ['direct replication'],
        weight: 0.95,
        fields: ['title', 'abstract'],
      },
    ];
    const out = expandAll(spec, ['direct replication']);
    // Spec entry takes precedence, user duplicate dropped
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('DIRECT_REP');
    expect(out[0].weight).toBe(0.95);
  });

  it('preserves both when phrases differ', () => {
    const spec: KeywordSpec[] = [
      {
        id: 'REP_OF',
        permutations: ['replication of'],
        weight: 1.0,
        fields: ['title', 'abstract'],
      },
    ];
    const out = expandAll(spec, ['"failed to replicate"']);
    expect(out.length).toBe(2);
    const ids = out.map((o) => o.id);
    expect(ids).toContain('REP_OF');
    expect(ids.find((i) => i.startsWith('USER_'))).toBeDefined();
  });
});

describe('expandedFromEffective', () => {
  it('expands admin-saved wildcard templates before provider queries', () => {
    const effective: EffectiveKeyword[] = [
      {
        id: 'ATTEMPT_TO_REP',
        phrase: 'attempt to replicate',
        permutations: ['attempt* to replicate'],
        weight: 0.9,
        fields: ['title', 'abstract'],
      },
    ];
    const out = expandedFromEffective(effective);
    expect(out.map((o) => o.permutation)).toEqual([
      'attempt to replicate',
      'attempted to replicate',
      'attempts to replicate',
      'attempting to replicate',
    ]);
    expect(out.some((o) => o.permutation.includes('*'))).toBe(false);
  });
});

describe('attributeKeywords', () => {
  const KEYWORDS: ExpandedKeyword[] = [
    { id: 'REP_OF', permutation: 'replication of', weight: 1, fields: ['title', 'abstract'] },
    { id: 'DIRECT_REP', permutation: 'direct replication', weight: 1, fields: ['title', 'abstract'] },
    { id: 'FAILED_TO_REP', permutation: 'failed to replicate', weight: 1, fields: ['title', 'abstract'] },
    { id: 'TITLE_ONLY', permutation: 'title-only phrase', weight: 1, fields: ['title'] },
  ];

  it('returns empty array when no fields populated', () => {
    expect(attributeKeywords('', '', KEYWORDS)).toEqual([]);
  });

  it('attributes a single hit on title only', () => {
    const out = attributeKeywords('A direct replication of Smith (2015)', '', KEYWORDS);
    const ids = out.map((m) => `${m.id}|${m.field}`);
    expect(ids).toContain('REP_OF|title');
    expect(ids).toContain('DIRECT_REP|title');
    expect(ids).not.toContain('FAILED_TO_REP|title');
  });

  it('attributes hits across title AND abstract for the same keyword separately', () => {
    const out = attributeKeywords(
      'Direct replication of prior work',
      'We failed to replicate the original effect.',
      KEYWORDS,
    );
    const ids = out.map((m) => `${m.id}|${m.field}`);
    expect(ids).toContain('DIRECT_REP|title');
    expect(ids).toContain('FAILED_TO_REP|abstract');
  });

  it('respects per-keyword field whitelist', () => {
    // TITLE_ONLY only allows the 'title' field
    const out = attributeKeywords('', 'A title-only phrase appears in abstract', KEYWORDS);
    expect(out.find((m) => m.id === 'TITLE_ONLY')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const out = attributeKeywords('A DIRECT REPLICATION of Smith (2015)', '', KEYWORDS);
    expect(out.find((m) => m.id === 'DIRECT_REP')).toBeDefined();
  });

  it('uses word boundaries (no partial-word match)', () => {
    const out = attributeKeywords('Predirected replication of foo', '', KEYWORDS);
    // 'replication of' still hits, but 'direct replication' does not
    const ids = out.map((m) => m.id);
    expect(ids).toContain('REP_OF');
    expect(ids).not.toContain('DIRECT_REP');
  });

  it('dedups exact (id,field,permutation) repeats', () => {
    const dupKeywords: ExpandedKeyword[] = [
      ...KEYWORDS,
      { id: 'REP_OF', permutation: 'replication of', weight: 1, fields: ['title', 'abstract'] },
    ];
    const out = attributeKeywords('Replication of foo', '', dupKeywords);
    const repOfHits = out.filter((m) => m.id === 'REP_OF' && m.field === 'title');
    expect(repOfHits).toHaveLength(1);
  });
});
