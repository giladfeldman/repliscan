// Ported from the Scimeto worker's standaloneExtractor tests when the pipeline moved into the library.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// resolveWorkDetailed is the only I/O boundary; the classifier and Crossref resolver are the real ones.
jest.unstable_mockModule('../../src/metadata/metadataResolver.js', () => ({
  resolveWorkDetailed: jest.fn<any>().mockResolvedValue({ work: null, sourcesQueried: [], providerReports: [] }),
}));

const { extractReplicationStandalone, recordsToCsv } = await import('../../src/pipeline/standalone.js');
const { resolveWorkDetailed } = await import('../../src/metadata/metadataResolver.js') as any;

const fixedOptions = {
  now: () => new Date('2026-05-04T09:00:00.000Z'),
  codeVersion: 'test-sha',
};

function lookup(work: any) {
  return {
    work: {
      sourcesQueried: ['openalex'],
      providerReports: [{ provider: 'openalex', status: 'found' }],
      fieldProvenance: {},
      ...work,
    },
    sourcesQueried: ['openalex'],
    providerReports: [{ provider: 'openalex', status: 'found' }],
  };
}

describe('extractReplicationStandalone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid or out-of-scope DOIs without network lookup', async () => {
    const records = await extractReplicationStandalone('not-a-doi', fixedOptions);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
    expect(records[0].unresolvedReason).toBe('invalid_or_out_of_scope_doi');
    expect(resolveWorkDetailed).not.toHaveBeenCalled();
  });

  it('rejects papers without replication phrases', async () => {
    (resolveWorkDetailed as any).mockResolvedValue(lookup({
      doi: '10.1234/study',
      title: 'A study on decision making',
      abstract: 'We ran an experiment.',
      referencedWorks: [],
    }));

    const records = await extractReplicationStandalone('https://doi.org/10.1234/STUDY', fixedOptions);
    expect(records[0]).toMatchObject({
      normalizedDoi: '10.1234/study',
      status: 'rejected',
      unresolvedReason: 'no_replication_phrase_detected',
      codeVersion: 'test-sha',
    });
  });

  it('marks replication papers with no references as needing more metadata', async () => {
    (resolveWorkDetailed as any).mockResolvedValue(lookup({
      doi: '10.1234/repl',
      title: 'A direct replication of Smith et al. (2015)',
      abstract: 'We failed to replicate the original finding.',
      referencedWorks: [],
    }));

    const records = await extractReplicationStandalone('10.1234/repl', fixedOptions);
    expect(records[0].status).toBe('needs_more_metadata');
    expect(records[0].unresolvedReason).toBe('replication_phrase_detected_but_no_references_available');
  });

  it('accepts a deterministic hard-grounded target', async () => {
    (resolveWorkDetailed as any).mockResolvedValue(lookup({
      doi: '10.1234/repl',
      title: 'A direct replication of Smith et al. (2015)',
      abstract: 'We failed to replicate the original finding.',
      referencedWorks: [
        { openalexId: 'W1', doi: '10.1234/original', firstAuthor: 'Smith', year: 2015, source: 'openalex' },
      ],
    }));

    const records = await extractReplicationStandalone('10.1234/repl', fixedOptions);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'accepted',
      replicationDoi: '10.1234/repl',
      originalDoi: '10.1234/original',
      outcome: 'failed',
      confidence: 'high',
      matchMethod: 'openalex_reference_backref',
      timestamp: '2026-05-04T09:00:00.000Z',
    });
    expect(records[0].ruleIdsTriggered).toEqual(expect.arrayContaining([
      'HARD_BACKREF_CONFIRMED',
      'REPLICATION_PHRASE_TITLE',
      'OUTCOME_PHRASE_EXTRACTED',
    ]));
  });

  it('marks multiple matching target references as ambiguous', async () => {
    (resolveWorkDetailed as any).mockResolvedValue(lookup({
      doi: '10.1234/repl',
      title: 'A replication of Smith (2015)',
      abstract: 'We successfully replicated the original effect.',
      referencedWorks: [
        { openalexId: 'W1', doi: '10.1234/original-a', firstAuthor: 'Smith', year: 2015, source: 'openalex' },
        { openalexId: 'W2', doi: '10.1234/original-b', firstAuthor: 'Smith', year: 2014, source: 'openalex' },
      ],
    }));

    const records = await extractReplicationStandalone('10.1234/repl', fixedOptions);
    expect(records[0].status).toBe('ambiguous');
    expect(records[0].ruleIdsTriggered).toContain('AMBIGUOUS_TARGET');
  });

  // T0-WIRE-B (2026-05-06): verifier integration assertions
  describe('LLM verifier wiring (T0-WIRE-B)', () => {
    it('passes a fake verifier through and records LLM-verified provenance', async () => {
      (resolveWorkDetailed as any).mockResolvedValue(lookup({
        doi: '10.1234/repl',
        title: 'A direct replication of Smith et al. (2015)',
        abstract: 'We failed to replicate the original finding.',
        referencedWorks: [
          { openalexId: 'W1', doi: '10.1234/original', firstAuthor: 'Smith', year: 2015, source: 'openalex' },
        ],
      }));

      // Outcome 'failed' is already deterministic, so the verifier won't be called
      // for the accepted record. Force the verifier path by using a target with
      // outcome=unknown (no outcome phrase in the abstract).
      (resolveWorkDetailed as any).mockResolvedValueOnce(lookup({
        doi: '10.1234/repl',
        title: 'A direct replication of Smith et al. (2015)',
        abstract: 'We ran the experiment in a new sample.',
        referencedWorks: [
          { openalexId: 'W1', doi: '10.1234/original', firstAuthor: 'Smith', year: 2015, source: 'openalex' },
        ],
      }));

      const verifier = jest.fn(async () => ({
        model: 'test-llm',
        version: 'v1',
        agreed: true,
        status: 'accepted' as const,
        reason: 'llm: outcome=successful',
        supportingQuote: 'We ran the experiment in a new sample.',
      }));

      const records = await extractReplicationStandalone('10.1234/repl', { ...fixedOptions, verifier });
      expect(verifier).toHaveBeenCalledTimes(1);
      expect(records[0].signalProvenance).toContain('LLM-verified');
      expect(records[0].modelVerifier).toBe('test-llm');
    });

    it('tags LLM-disagreed in provenance when verifier disagrees', async () => {
      (resolveWorkDetailed as any).mockResolvedValue(lookup({
        doi: '10.1234/repl',
        title: 'A direct replication of Smith et al. (2015)',
        abstract: 'We ran the experiment in a new sample.',
        referencedWorks: [
          { openalexId: 'W1', doi: '10.1234/original', firstAuthor: 'Smith', year: 2015, source: 'openalex' },
        ],
      }));

      const verifier = jest.fn(async () => ({
        model: 'test-llm',
        agreed: false,
        reason: 'llm: not-a-replication',
      }));

      const records = await extractReplicationStandalone('10.1234/repl', { ...fixedOptions, verifier });
      expect(records[0].status).toBe('llm_disagreed');
      expect(records[0].signalProvenance).toEqual(expect.arrayContaining(['LLM-verified', 'LLM-disagreed']));
    });
  });

  // T0-WIRE-A (2026-05-06): Crossref author-year fallback wiring
  describe('Crossref author-year fallback (T0-WIRE-A)', () => {
    it('does NOT trigger Crossref fallback when option is false', async () => {
      (resolveWorkDetailed as any).mockResolvedValue(lookup({
        doi: '10.1234/repl',
        title: 'A direct replication of Smith et al. (2015)',
        abstract: 'We failed to replicate Smith et al. (2015).',
        referencedWorks: [], // empty → would normally be needs_more_metadata
      }));

      const records = await extractReplicationStandalone('10.1234/repl', {
        ...fixedOptions,
        enableCrossrefAuthorYearFallback: false,
      });
      // No fallback → falls through to needs_more_metadata path
      expect(records[0].status).toBe('needs_more_metadata');
      expect(records[0].signalProvenance).not.toContain('crossref-author-year-resolved');
    });
  });
});

describe('recordsToCsv', () => {
  it('emits a Google-Sheet-compatible CSV with escaped evidence', async () => {
    const csv = recordsToCsv([{
      inputDoi: '10.1234/repl',
      normalizedDoi: '10.1234/repl',
      status: 'accepted',
      replicationDoi: '10.1234/repl',
      replicationTitle: 'A replication study',
      replicationAuthors: 'Example Author',
      replicationVenue: 'Example Journal',
      replicationYear: 2026,
      originalDoi: '10.1234/original',
      originalTitle: 'Original study',
      originalAuthors: 'Original Author',
      originalVenue: 'Original Journal',
      originalYear: 2015,
      originalReferenceExtracted: 'Smith (2015)',
      justificationPhrase: 'A replication of Smith (2015), with comma',
      outcome: 'failed',
      outcomePhrase: 'failed to replicate',
      confidence: 'high',
      matchMethod: 'openalex_reference_backref',
      apiSourcesQueried: ['openalex'],
      metadataProviderReports: [{ provider: 'openalex', status: 'found' }],
      rawSourceSnippets: ['A replication of Smith (2015), with comma'],
      ruleIdsTriggered: ['HARD_BACKREF_CONFIRMED'],
      signalProvenance: ['back-ref-confirmed'],
      modelVerifier: '',
      verifierVersion: '',
      verifierReason: '',
      timestamp: '2026-05-04T09:00:00.000Z',
      codeVersion: 'test-sha',
      unresolvedReason: '',
    }]);

    expect(csv).toContain('inputDoi,normalizedDoi,status');
    expect(csv).toContain('"A replication of Smith (2015), with comma"');
  });
});
