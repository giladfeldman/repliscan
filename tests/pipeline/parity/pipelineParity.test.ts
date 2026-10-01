// Parity of the library's lookup pipelines against golden.json, which was recorded from the
// Scimeto worker's implementation BEFORE the pipelines moved here. corpus.ts and golden.json are
// byte-identical to the copies in the worker's tests; a difference is a bug, not an improvement.
import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cannedResolveWork, cannedResolveWorkDetailed, cannedGetCitingWorks, cannedResolveAuthorYear,
  ioCalls, resetIoCalls, runParityCorpus, stableStringify, type ParityApi,
} from './corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden.json');
const HOST_VERSION = 'PARITY-HOST-VERSION';

// The credentials the host (Scimeto's worker) threaded through when the golden was recorded.
const CREDS = {
  openAlexApiKey: 'oa-key', openAlexMailto: 'parity@example.test', semanticScholarApiKey: 's2-key',
  openCitationsBaseUrl: undefined, openCitationsAccessToken: undefined,
};

const cacheLog: Array<[string, string, string]> = [];
const cacheStore = new Map<string, unknown>();
const cache = {
  async get(doi: string, direction: string) { cacheLog.push(['get', doi, direction]); return cacheStore.get(`${doi}|${direction}`) ?? null; },
  async put(doi: string, direction: string, response: unknown) { cacheLog.push(['put', doi, direction]); cacheStore.set(`${doi}|${direction}`, response); },
};

jest.unstable_mockModule('../../../src/metadata/metadataResolver.js', () => ({
  resolveWork: cannedResolveWork,
  resolveWorkDetailed: cannedResolveWorkDetailed,
}));
jest.unstable_mockModule('../../../src/metadata/openAlexClient.js', () => ({
  getCitingWorks: cannedGetCitingWorks,
}));
jest.unstable_mockModule('../../../src/metadata/crossrefAuthorYearResolver.js', () => ({
  resolveAuthorYearViaCrossref: cannedResolveAuthorYear,
}));

const lib = await import('../../../src/pipeline/forward.js');
const reverse = await import('../../../src/pipeline/reverse.js');
const standalone = await import('../../../src/pipeline/standalone.js');
const verifier = await import('../../../src/pipeline/verifier.js');
const fred = await import('../../../src/fred/floraLookup.js');
const bundled = await import('../../../src/fred/bundled.js');
const doi = await import('../../../src/util/lookupDoi.js');

const api: ParityApi = {
  findReplicationsForDoi: (d, opts) => lib.findReplicationsForDoi(d, { ...(opts as any), cache: cache as any, credentials: CREDS }),
  extractReplication: (d) => reverse.extractReplication(d, { cache: cache as any }),
  extractReplicationStandalone: (d, options) => standalone.extractReplicationStandalone(d, { ...(options as any), credentials: CREDS }),
  recordsToCsv: (records) => standalone.recordsToCsv(records),
  dedupFindings: (findings) => lib.dedupFindings(findings),
  checkFloraReplications: (d, db) => fred.checkFloraReplications(d, db),
  parseAndIndexFloraCsv: (csv) => fred.parseAndIndexFloraCsv(csv),
  mapFloraOutcome: (o) => fred.mapFloraOutcome(o),
  aggregateOutcome: (o) => fred.aggregateOutcome(o),
  runVerifier: (input, callLlm) => verifier.createLlmVerifier({ callLlm, version: HOST_VERSION, errorModel: 'test-callback' })(input),
  cacheLog,
  bundledFredChecksum: () => {
    bundled.loadBundledFred(); // must load from where the build puts it
    const bytes = readFileSync(join(HERE, '..', '..', '..', 'data', 'flora-replications.json'));
    const db = JSON.parse(bytes.toString('utf-8'));
    return { sha256: createHash('sha256').update(bytes).digest('hex'), totalOriginals: db.totalOriginals, totalEntries: db.totalEntries };
  },
  normalizeCheck: (inputs) => inputs.map(i => doi.normalizeLookupDoi(i)),
};

describe('lookup pipelines: parity with the recorded golden output', () => {
  let result: Record<string, unknown>;
  beforeAll(async () => {
    resetIoCalls();
    cacheStore.clear();
    result = await runParityCorpus(api);
    result.ioCalls = ioCalls.map(c => ({ fn: c.fn, args: c.args }));
  });

  it('is not vacuous: the corpus reaches accepted, ambiguous, rejected, failed-verifier and FReD paths', () => {
    const sa = result.standalone as Record<string, any[]>;
    const statuses = new Set(Object.values(sa).flat().map(r => r.status));
    for (const s of ['accepted', 'rejected', 'needs_more_metadata', 'ambiguous', 'llm_disagreed']) expect(statuses).toContain(s);
    // KNOWN DEFECT, pinned on purpose: the Crossref author-year fallback is called but can never
    // produce a finding (its own confidence score is always 'low' and low is discarded), so
    // enabling it changes nothing. Parity keeps that; when it is fixed the golden changes deliberately.
    expect((sa['fallback:on'] as any[])[0].status).toBe('needs_more_metadata');
    expect((result.ioCalls as any[]).filter(c => c.fn === 'resolveAuthorYearViaCrossref').length).toBeGreaterThan(0);
    const fwd = result.forward as Record<string, any>;
    expect(fwd.mainNoFred.targets.length).toBeGreaterThan(0);
    expect(fwd.mainWithFred.targets.length).toBeGreaterThan(2);
    expect((result.fredHits as any[]).filter(Boolean).length).toBeGreaterThan(1);
    expect(Object.keys(result.fredDb as any)).toContain('byDoi');
  });

  it('matches golden.json byte for byte', () => {
    const actual = stableStringify(result, HOST_VERSION);
    if (process.env.PARITY_WRITE === '1') {
      writeFileSync(GOLDEN, actual, 'utf-8');
      return;
    }
    // A missing golden is a failure, never a recording: only PARITY_WRITE=1 records.
    expect(existsSync(GOLDEN)).toBe(true);
    // Line endings only: a Windows checkout may rewrite LF as CRLF. Content is compared exactly.
    expect(actual).toBe(readFileSync(GOLDEN, 'utf-8').replace(/\r\n/g, '\n'));
  });
});
