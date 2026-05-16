import { describe, it, expect } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyExclusions,
  loadExclusionPatterns,
} from '../../src/discovery/engine/exclusionFilter.js';
import type { ExclusionPattern } from '../../src/discovery/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_DIR = path.resolve(
  __dirname,
  '../../src/discovery/spec',
);

const TEST_PATTERNS: ExclusionPattern[] = [
  {
    id: 'BIOLOGICAL',
    regex: '\\b(?:dna|rna|viral|virus|cell|cellular|chromosome|plasmid)\\s+replication\\b',
    flags: ['i'],
  },
  {
    id: 'TECHNICAL_OBJECT',
    regex:
      '\\b(?:replication of (?:the )?(?:apparatus|code|dataset|data|database|model|method|pipeline|protocol|software|simulation)|(?:apparatus|code|dataset|data|database|model|method|pipeline|protocol|software|simulation)\\s+replication)\\b',
    flags: ['i'],
  },
  {
    id: 'STRUCTURAL',
    regex: '\\breplication (?:fork|origin|stress|timing)\\b',
    flags: ['i'],
  },
];

describe('applyExclusions', () => {
  it('returns excluded:false on empty text', () => {
    expect(applyExclusions('', TEST_PATTERNS)).toEqual({ excluded: false });
  });

  it('drops biological replication contexts', () => {
    expect(applyExclusions('DNA replication during S phase', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'BIOLOGICAL',
    });
    expect(applyExclusions('Viral replication mechanism', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'BIOLOGICAL',
    });
  });

  it('drops technical-object replication contexts (both verb-of-noun and noun-noun forms)', () => {
    expect(applyExclusions('We performed a replication of the code from prior work', TEST_PATTERNS)).toEqual(
      { excluded: true, reason: 'TECHNICAL_OBJECT' },
    );
    expect(applyExclusions('replication of the dataset used in Smith 2015', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'TECHNICAL_OBJECT',
    });
    expect(applyExclusions('Code replication and reproducibility in ML', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'TECHNICAL_OBJECT',
    });
    expect(applyExclusions('Data replication in distributed systems', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'TECHNICAL_OBJECT',
    });
    expect(applyExclusions('Pipeline replication for ETL workflows', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'TECHNICAL_OBJECT',
    });
  });

  it('drops structural-biology replication terms', () => {
    expect(applyExclusions('Replication fork progression', TEST_PATTERNS)).toEqual({
      excluded: true,
      reason: 'STRUCTURAL',
    });
  });

  it('keeps psychological replication phrases', () => {
    expect(applyExclusions('A direct replication of Smith (2015)', TEST_PATTERNS)).toEqual({
      excluded: false,
    });
    expect(applyExclusions('We failed to replicate the original effect', TEST_PATTERNS)).toEqual({
      excluded: false,
    });
  });

  it('returns the FIRST matching pattern when multiple would match', () => {
    // Both BIOLOGICAL and STRUCTURAL would match this; first wins per array order.
    const text = 'DNA replication fork stalling';
    expect(applyExclusions(text, TEST_PATTERNS).excluded).toBe(true);
    expect((applyExclusions(text, TEST_PATTERNS) as any).reason).toBe('BIOLOGICAL');
  });

  it('is case-insensitive when flags include i', () => {
    expect(applyExclusions('REPLICATION FORK', TEST_PATTERNS).excluded).toBe(true);
    expect(applyExclusions('Dna Replication', TEST_PATTERNS).excluded).toBe(true);
  });
});

describe('loadExclusionPatterns', () => {
  it('loads the committed spec file with 4 patterns', () => {
    const patterns = loadExclusionPatterns(SPEC_DIR);
    expect(patterns).toHaveLength(4);
    expect(patterns.map((p) => p.id).sort()).toEqual(
      ['BIOLOGICAL', 'STRUCTURAL', 'TECHNICAL_OBJECT', 'TECHNICAL_VERB'].sort(),
    );
  });

  it('every pattern has regex + flags', () => {
    const patterns = loadExclusionPatterns(SPEC_DIR);
    for (const p of patterns) {
      expect(p.regex).toBeTruthy();
      expect(Array.isArray(p.flags)).toBe(true);
    }
  });
});
