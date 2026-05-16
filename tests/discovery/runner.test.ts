import { describe, it, expect, jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiscovery } from '../../src/discovery/engine/runner.js';
import type {
  DiscoveryRunConfig,
  ExpandedKeyword,
  RawCandidate,
  RunFilters,
  SourceId,
} from '../../src/discovery/types.js';
import type { SourceAdapter } from '../../src/discovery/engine/sources/sourceAdapter.js';

// Stub the classifier bridge so we don't hit metadata resolver.
jest.unstable_mockModule(
  '../../src/discovery/engine/classifierBridge.js',
  () => ({
    classifyCandidate: jest.fn(async () => ({ status: 'rejected', result: null })),
  }),
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_DIR = path.resolve(__dirname, '../../src/discovery/spec');

const FILTERS: RunFilters = {
  yearFrom: 2023,
  yearTo: 2023,
  languages: ['en'],
  sources: ['openalex'],
  maxCandidatesPerSource: 50,
  skipDoisInFlora: false,
};

const CONFIG: DiscoveryRunConfig = {
  specVersion: 1,
  keywords: [],
  filters: FILTERS,
};

function makeAdapter(
  pages: Array<{ candidates: RawCandidate[]; nextCursor?: string }>,
  id: SourceId = 'openalex',
): SourceAdapter {
  return {
    id,
    verifiedAt: new Date(),
    reportLimits: () => ({}),
    search: async function* () {
      for (const page of pages) {
        yield page;
      }
    },
  };
}

const mkRaw = (doi: string, source: SourceId = 'openalex'): RawCandidate => ({
  source,
  doi,
  title: `A direct replication of Smith (2015) for ${doi}`,
  abstract: 'We replicated and found...',
  matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
});

describe('runDiscovery', () => {
  it('runs end-to-end with no DB and reports completed', async () => {
    const adapter = makeAdapter([
      { candidates: [mkRaw('10.1037/abc'), mkRaw('10.1037/def')], nextCursor: undefined },
    ]);

    const seen: Array<{ doi: string; status: string }> = [];
    const result = await runDiscovery({
      runId: 'test-run',
      config: CONFIG,
      adapters: { openalex: adapter },
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: {
        onCandidate: (c, status) => {
          seen.push({ doi: c.doi, status });
        },
        onProgress: () => {},
      },
      classify: false,
    });

    expect(result.status).toBe('completed');
    expect(result.stats.candidatesSeen).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.doi).sort()).toEqual(['10.1037/abc', '10.1037/def']);
  });

  it('drops candidates that match the exclusion regex', async () => {
    const biological: RawCandidate = {
      source: 'openalex',
      doi: '10.1038/dna',
      title: 'Mechanisms of DNA replication in mammalian cells',
      abstract: 'DNA replication during S phase ...',
      matchedKeyword: { id: 'REP_OF', field: 'title', permutation: 'replication of' },
    };
    const adapter = makeAdapter([{ candidates: [biological], nextCursor: undefined }]);

    const seen: Array<{ doi: string; status: string }> = [];
    const result = await runDiscovery({
      runId: 'test-run',
      config: CONFIG,
      adapters: { openalex: adapter },
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: {
        onCandidate: (c) => {
          seen.push({ doi: c.doi, status: 'pending' });
        },
        onProgress: () => {},
      },
      classify: false,
    });

    expect(result.status).toBe('completed');
    expect(result.stats.candidatesSeen).toBe(1);
    expect(result.stats.candidatesKeptAfterExclusion).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('paginates across multiple pages', async () => {
    const adapter = makeAdapter([
      { candidates: [mkRaw('10.1037/p1')], nextCursor: 'page2' },
      { candidates: [mkRaw('10.1037/p2')], nextCursor: undefined },
    ]);

    let progressTicks = 0;
    const result = await runDiscovery({
      runId: 'r',
      config: CONFIG,
      adapters: { openalex: adapter },
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: {
        onCandidate: () => {},
        onProgress: () => {
          progressTicks++;
        },
      },
      classify: false,
    });

    expect(result.status).toBe('completed');
    expect(result.stats.candidatesSeen).toBe(2);
    expect(result.stats.apiCallsPerSource.openalex).toBe(2);
    expect(progressTicks).toBe(2);
  });

  it('fails fast when no requested source has an adapter', async () => {
    const result = await runDiscovery({
      runId: 'r',
      config: CONFIG,
      adapters: {}, // openalex requested but no adapter
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: { onCandidate: () => {}, onProgress: () => {} },
      classify: false,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.reason).toBe('no_sources_configured');
  });

  it('returns paused when adapter throws "threshold exceeded"', async () => {
    const adapter: SourceAdapter = {
      id: 'openalex',
      verifiedAt: new Date(),
      reportLimits: () => ({}),
      search: async function* () {
        throw new Error('OpenAlex 429 threshold exceeded — paused by adapter');
        yield { candidates: [] };
      },
    };

    const result = await runDiscovery({
      runId: 'r',
      config: CONFIG,
      adapters: { openalex: adapter },
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: { onCandidate: () => {}, onProgress: () => {} },
      classify: false,
    });

    expect(result.status).toBe('paused');
    expect(result.error?.reason).toBe('rate_limit_threshold');
  });

  it('fails on stale spec freshness', async () => {
    const stale: SourceAdapter = {
      id: 'openalex',
      verifiedAt: new Date(Date.now() - 100 * 86_400_000), // 100 days ago
      reportLimits: () => ({}),
      search: async function* () {
        yield { candidates: [] };
      },
    };

    const result = await runDiscovery({
      runId: 'r',
      config: CONFIG,
      adapters: { openalex: stale },
      specDir: SPEC_DIR,
      persistence: null,
      fileWriters: { onCandidate: () => {}, onProgress: () => {} },
      classify: false,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.reason).toBe('spec_stale');
  });
});
