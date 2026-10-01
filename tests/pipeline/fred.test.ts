/**
 * Tests for FLoRA Lookup - Pure functions for FORRT FReD replication database
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeLookupDoi as normalizeDoi } from '../../src/util/lookupDoi.js';
import {
  mapFloraOutcome,
  aggregateOutcome,
  checkFloraReplications,
  parseAndIndexFloraCsv,
  FloraDatabase,
} from '../../src/fred/floraLookup.js';

// Small inline test database
const TEST_FLORA_DB: FloraDatabase = {
  version: '1.0.0-test',
  lastUpdated: '2026-03-06',
  source: 'test',
  license: 'MIT',
  totalOriginals: 3,
  totalEntries: 5,
  byDoi: {
    '10.1126/science.aaa0001': {
      title: 'Estimating the reproducibility of psychological science',
      authors: 'Open Science Collaboration et al.',
      journal: 'Science',
      year: 2015,
      replications: [
        {
          doi: '10.1177/0956797618774796',
          title: 'A replication attempt of Study 1',
          authors: 'Replicator A et al.',
          journal: 'Psychological Science',
          year: 2018,
          outcome: 'failed',
          outcomeQuote: 'We failed to replicate the original effect.',
          type: 'replication',
          source: 'RPP',
        },
      ],
    },
    '10.1234/multi.replications': {
      title: 'Study with multiple replications',
      authors: 'Author B',
      journal: 'Journal X',
      year: 2010,
      replications: [
        {
          doi: '10.5555/rep1',
          title: 'First replication',
          authors: 'Rep Author 1',
          journal: 'J1',
          year: 2015,
          outcome: 'successful',
          outcomeQuote: 'We successfully replicated the effect.',
          type: 'replication',
          source: 'ML3',
        },
        {
          doi: '10.5555/rep2',
          title: 'Second replication',
          authors: 'Rep Author 2',
          journal: 'J2',
          year: 2016,
          outcome: 'failed',
          outcomeQuote: 'The effect was not observed.',
          type: 'replication',
          source: 'Independent',
        },
        {
          doi: '10.5555/rep3',
          title: 'Third replication',
          authors: 'Rep Author 3',
          journal: 'J3',
          year: 2017,
          outcome: 'mixed',
          outcomeQuote: '',
          type: 'replication',
          source: 'ML2',
        },
      ],
    },
    '10.9999/successful.only': {
      title: 'Well-replicated study',
      authors: 'Author C',
      journal: 'Nature',
      year: 2005,
      replications: [
        {
          doi: '10.8888/rep-ok',
          title: 'Confirming replication',
          authors: 'Good Replicator',
          journal: 'Nature',
          year: 2008,
          outcome: 'successful',
          outcomeQuote: 'Results were confirmed.',
          type: 'replication',
          source: 'Independent',
        },
      ],
    },
  },
};

describe('FLoRA Lookup', () => {
  describe('normalizeDoi', () => {
    it('should handle basic DOI', () => {
      expect(normalizeDoi('10.1234/test')).toBe('10.1234/test');
    });

    it('should lowercase', () => {
      expect(normalizeDoi('10.1234/TEST')).toBe('10.1234/test');
    });

    it('should trim whitespace', () => {
      expect(normalizeDoi('  10.1234/test  ')).toBe('10.1234/test');
    });

    it('should strip https://doi.org/ prefix', () => {
      expect(normalizeDoi('https://doi.org/10.1234/test')).toBe('10.1234/test');
    });

    it('should strip http://doi.org/ prefix', () => {
      expect(normalizeDoi('http://doi.org/10.1234/test')).toBe('10.1234/test');
    });

    it('should strip http://dx.doi.org/ prefix', () => {
      expect(normalizeDoi('http://dx.doi.org/10.1234/test')).toBe('10.1234/test');
    });

    it('should strip doi: prefix', () => {
      expect(normalizeDoi('doi:10.1234/test')).toBe('10.1234/test');
    });

    it('should decode URL-encoded characters', () => {
      expect(normalizeDoi('10.1002/(sici)1099-0771(199806)11:2%3c107::aid-bdm292%3e3.0.co;2-y'))
        .toBe('10.1002/(sici)1099-0771(199806)11:2<107::aid-bdm292>3.0.co;2-y');
    });

    it('should strip trailing dots and slashes', () => {
      expect(normalizeDoi('10.1234/test./')).toBe('10.1234/test');
      expect(normalizeDoi('10.1234/test...')).toBe('10.1234/test');
    });

    it('should return empty string for empty input', () => {
      expect(normalizeDoi('')).toBe('');
    });

    it('should handle full URL with encoding and case', () => {
      expect(normalizeDoi('HTTPS://DOI.ORG/10.1234/Test%20Value'))
        .toBe('10.1234/test value');
    });
  });

  describe('mapFloraOutcome', () => {
    it('should map successful', () => {
      expect(mapFloraOutcome('successful')).toEqual({ type: 'successful', severity: 'info' });
    });

    it('should map failed', () => {
      expect(mapFloraOutcome('failed')).toEqual({ type: 'failed', severity: 'warning' });
    });

    it('should map mixed to partial', () => {
      expect(mapFloraOutcome('mixed')).toEqual({ type: 'partial', severity: 'warning' });
    });

    it('should map outcomes containing "flawed" to partial', () => {
      expect(mapFloraOutcome('statistically successful but flawed')).toEqual({
        type: 'partial',
        severity: 'warning',
      });
    });

    it('should map outcomes containing "challenges" to partial', () => {
      expect(mapFloraOutcome('computionally successful, robustness challenges')).toEqual({
        type: 'partial',
        severity: 'warning',
      });
    });

    it('should map outcomes containing "issues" to partial', () => {
      expect(mapFloraOutcome('computational issues, robust')).toEqual({
        type: 'partial',
        severity: 'warning',
      });
    });

    it('should map unknown outcomes to unknown', () => {
      expect(mapFloraOutcome('descriptive only')).toEqual({ type: 'unknown', severity: 'info' });
      expect(mapFloraOutcome('uninformative')).toEqual({ type: 'unknown', severity: 'info' });
    });

    it('should handle empty string', () => {
      expect(mapFloraOutcome('')).toEqual({ type: 'unknown', severity: 'info' });
    });

    it('should be case-insensitive', () => {
      expect(mapFloraOutcome('SUCCESSFUL')).toEqual({ type: 'successful', severity: 'info' });
      expect(mapFloraOutcome('Failed')).toEqual({ type: 'failed', severity: 'warning' });
    });
  });

  describe('aggregateOutcome', () => {
    it('should return failed when any replication failed', () => {
      expect(aggregateOutcome(['successful', 'failed', 'partial'])).toBe('failed');
    });

    it('should return partial when worst is partial', () => {
      expect(aggregateOutcome(['successful', 'partial'])).toBe('partial');
    });

    it('should return successful when all are successful', () => {
      expect(aggregateOutcome(['successful', 'successful'])).toBe('successful');
    });

    it('should return unknown for single unknown', () => {
      expect(aggregateOutcome(['unknown'])).toBe('unknown');
    });

    it('should return unknown for empty array', () => {
      expect(aggregateOutcome([])).toBe('unknown');
    });

    it('should rank unknown above successful', () => {
      expect(aggregateOutcome(['successful', 'unknown'])).toBe('unknown');
    });
  });

  describe('checkFloraReplications', () => {
    it('should find a single replication (failed)', () => {
      const result = checkFloraReplications('10.1126/science.aaa0001', TEST_FLORA_DB);
      expect(result).not.toBeNull();
      expect(result!.metadata.replicationType).toBe('failed');
      expect(result!.severity).toBe('warning');
      expect(result!.metadata.replicationCount).toBe(1);
      expect(result!.metadata.source).toBe('FReD');
      expect(result!.metadata.determinationMethod).toBe('FReD curated dataset');
      expect(result!.metadata.replicationDetails).toHaveLength(1);
      expect(result!.metadata.replicationDetails[0].outcomeQuote).toBe(
        'We failed to replicate the original effect.'
      );
    });

    it('should aggregate multiple replications (worst-case)', () => {
      const result = checkFloraReplications('10.1234/multi.replications', TEST_FLORA_DB);
      expect(result).not.toBeNull();
      expect(result!.metadata.replicationType).toBe('failed');
      expect(result!.metadata.replicationCount).toBe(3);
      expect(result!.metadata.replicationDOIs).toHaveLength(3);
      expect(result!.metadata.replicationDetails).toHaveLength(3);
    });

    it('should find successful-only replications', () => {
      const result = checkFloraReplications('10.9999/successful.only', TEST_FLORA_DB);
      expect(result).not.toBeNull();
      expect(result!.metadata.replicationType).toBe('successful');
      expect(result!.severity).toBe('info');
    });

    it('should return null for DOI not in database', () => {
      const result = checkFloraReplications('10.9999/not.in.db', TEST_FLORA_DB);
      expect(result).toBeNull();
    });

    it('should return null for empty DOI', () => {
      const result = checkFloraReplications('', TEST_FLORA_DB);
      expect(result).toBeNull();
    });

    it('should handle DOI normalization during lookup', () => {
      // Pass URL-form DOI that normalizes to a key in the database
      const result = checkFloraReplications(
        'https://doi.org/10.1126/science.aaa0001',
        TEST_FLORA_DB
      );
      expect(result).not.toBeNull();
      expect(result!.metadata.replicationType).toBe('failed');
    });

    it('should handle case-insensitive DOI lookup', () => {
      const result = checkFloraReplications('10.1126/SCIENCE.AAA0001', TEST_FLORA_DB);
      expect(result).not.toBeNull();
    });

    it('should handle empty database', () => {
      const emptyDb: FloraDatabase = {
        version: '1.0.0',
        lastUpdated: '2026-01-01',
        source: 'test',
        license: 'MIT',
        totalOriginals: 0,
        totalEntries: 0,
        byDoi: {},
      };
      const result = checkFloraReplications('10.1234/test', emptyDb);
      expect(result).toBeNull();
    });

    it('should include replication details with correct fields', () => {
      const result = checkFloraReplications('10.1126/science.aaa0001', TEST_FLORA_DB);
      expect(result).not.toBeNull();
      const detail = result!.metadata.replicationDetails[0];
      expect(detail.doi).toBe('10.1177/0956797618774796');
      expect(detail.title).toBe('A replication attempt of Study 1');
      expect(detail.authors).toBe('Replicator A et al.');
      expect(detail.outcomeType).toBe('failed');
      expect(detail.projectSource).toBe('RPP');
    });

    it('should include flora data version', () => {
      const result = checkFloraReplications('10.1126/science.aaa0001', TEST_FLORA_DB);
      expect(result).not.toBeNull();
      expect(result!.metadata.floraDataVersion).toBe('1.0.0-test');
    });
  });

  describe('parseAndIndexFloraCsv', () => {
    it('should parse a minimal CSV', () => {
      const csv = [
        '"doi_o","title_o","author_o","journal_o","year_o","doi_r","title_r","author_r","journal_r","year_r","outcome","outcome_quote","type","source"',
        '"10.1234/orig","Original Title","[]","Journal A","2010","10.5678/rep","Replication Title","[]","Journal B","2015","failed","Did not replicate","replication","Independent"',
      ].join('\n');

      const db = parseAndIndexFloraCsv(csv);
      expect(db.totalOriginals).toBe(1);
      expect(db.totalEntries).toBe(1);
      expect(db.byDoi['10.1234/orig']).toBeDefined();
      expect(db.byDoi['10.1234/orig'].replications).toHaveLength(1);
      expect(db.byDoi['10.1234/orig'].replications[0].outcome).toBe('failed');
    });

    it('should handle empty CSV', () => {
      const db = parseAndIndexFloraCsv('');
      expect(db.totalOriginals).toBe(0);
      expect(db.totalEntries).toBe(0);
    });

    it('should group multiple replications under same original DOI', () => {
      const csv = [
        '"doi_o","title_o","author_o","journal_o","year_o","doi_r","title_r","author_r","journal_r","year_r","outcome","outcome_quote","type","source"',
        '"10.1234/orig","Title","[]","J","2010","10.5555/r1","Rep 1","[]","J1","2015","successful","OK","replication","ML3"',
        '"10.1234/orig","Title","[]","J","2010","10.5555/r2","Rep 2","[]","J2","2016","failed","Nope","replication","ML3"',
      ].join('\n');

      const db = parseAndIndexFloraCsv(csv);
      expect(db.totalOriginals).toBe(1);
      expect(db.totalEntries).toBe(2);
      expect(db.byDoi['10.1234/orig'].replications).toHaveLength(2);
    });

    it('should normalize DOIs in CSV data', () => {
      const csv = [
        '"doi_o","title_o","author_o","journal_o","year_o","doi_r","title_r","author_r","journal_r","year_r","outcome","outcome_quote","type","source"',
        '"10.1234/UPPER","Title","[]","J","2010","10.5678/REP","Rep","[]","J2","2015","successful","","replication",""',
      ].join('\n');

      const db = parseAndIndexFloraCsv(csv);
      expect(db.byDoi['10.1234/upper']).toBeDefined();
      expect(db.byDoi['10.1234/upper'].replications[0].doi).toBe('10.5678/rep');
    });

    it('should handle BOM in CSV', () => {
      const csv = '\uFEFF"doi_o","title_o","author_o","journal_o","year_o","doi_r","title_r","author_r","journal_r","year_r","outcome","outcome_quote","type","source"\n"10.1/x","T","[]","J","2020","10.2/r","R","[]","J2","2021","successful","","replication",""';
      const db = parseAndIndexFloraCsv(csv);
      expect(db.totalOriginals).toBe(1);
    });
  });
});
