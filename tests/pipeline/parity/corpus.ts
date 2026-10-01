/**
 * Parity corpus for the replication lookup pipelines (FReD lookup, forward / reverse /
 * standalone extraction, LLM verifier).
 *
 * Everything here is SYNTHETIC: invented DOIs under the 10.5555 test prefix, invented titles,
 * invented abstracts. No real article text (custody rule). The same file is used, byte for
 * byte, in two repositories:
 *   - the Scimeto worker tests   (runs the worker's adapters)
 *   - the repliscan tests        (runs the library functions)
 * and both must produce exactly `golden.json`, which was recorded from the Scimeto worker BEFORE
 * the pipelines moved. A difference is a bug, not an improvement.
 *
 * The metadata providers are the only I/O the moving code performs, so they are replaced by the
 * canned functions below. The classifier is always the real one.
 */

// ---------------------------------------------------------------------------------------------
// Canned I/O
// ---------------------------------------------------------------------------------------------

export interface IoCall { fn: string; args: unknown[] }
export const ioCalls: IoCall[] = [];
export function resetIoCalls(): void { ioCalls.length = 0; }

const ORIG = (n: number, author: string, year: number) => ({
  openalexId: `W${n}`, doi: `10.5555/orig.${n}`, title: `Original study ${n}`, authors: `${author} et al.`,
  venue: 'Journal of Synthetic Psychology', firstAuthor: author, year,
});

type Work = {
  doi: string | null; title: string; authors: string; venue: string; year: number | null; abstract: string;
  referencedWorks: Array<Record<string, unknown>>;
};

const WORKS: Record<string, Work> = {
  // a replication that failed, with a back-referenced original
  '10.5555/rep.failed': {
    doi: '10.5555/rep.failed', title: 'A direct replication of Smith et al. (2010) on anchoring', authors: 'A. Replicator',
    venue: 'Replication Reports', year: 2019,
    abstract: 'We conducted a direct replication of Smith et al. (2010). We failed to replicate the original effect; the replication found no evidence for anchoring.',
    referencedWorks: [ORIG(101, 'Smith', 2010), ORIG(102, 'Other', 2005)],
  },
  // a replication with a successful outcome
  '10.5555/rep.success': {
    doi: '10.5555/rep.success', title: 'Replication of Jones and Lee (2012)', authors: 'B. Replicator',
    venue: 'Replication Reports', year: 2020,
    abstract: 'This study replicates Jones and Lee (2012). The original effect was successfully replicated in a larger sample.',
    referencedWorks: [ORIG(103, 'Jones', 2012)],
  },
  // replication phrase, but two possible originals by the same author-year
  '10.5555/rep.ambiguous': {
    doi: '10.5555/rep.ambiguous', title: 'A replication of Brown (2011)', authors: 'C. Replicator', venue: 'Replication Reports', year: 2021,
    abstract: 'We report a replication of Brown (2011). The results were inconclusive.',
    referencedWorks: [ORIG(104, 'Brown', 2011), ORIG(105, 'Brown', 2011)],
  },
  // replication phrase but no references at all
  '10.5555/rep.norefs': {
    doi: '10.5555/rep.norefs', title: 'A conceptual replication of Green (2008)', authors: 'D. Replicator', venue: 'Replication Reports', year: 2018,
    abstract: 'We conducted a conceptual replication of Green (2008) and the effect did not replicate.',
    referencedWorks: [],
  },
  // replication phrase, references present but none matches the cited author-year
  '10.5555/rep.noresolve': {
    doi: '10.5555/rep.noresolve', title: 'A replication of White (2003)', authors: 'E. Replicator', venue: 'Replication Reports', year: 2017,
    abstract: 'We replicate White (2003) with a new sample. The original finding was partially supported.',
    referencedWorks: [ORIG(106, 'Unrelated', 1999)],
  },
  // not a replication at all
  '10.5555/not.replication': {
    doi: '10.5555/not.replication', title: 'Attitudes toward synthetic beverages', authors: 'F. Author', venue: 'Journal of Synthetic Psychology', year: 2015,
    abstract: 'We surveyed participants about beverages. Attitudes were mixed.',
    referencedWorks: [ORIG(107, 'Anyone', 2001)],
  },
  // replication phrase; the original is only reachable through the Crossref author-year fallback
  '10.5555/rep.fallback': {
    doi: '10.5555/rep.fallback', title: 'A replication of Black (2009)', authors: 'G. Replicator', venue: 'Replication Reports', year: 2022,
    abstract: 'We replicate Black (2009). The original effect failed to replicate.',
    referencedWorks: [ORIG(108, 'Unrelated', 2000)],
  },
  // replication of an original whose outcome sentence is absent (unknown outcome)
  '10.5555/rep.unknown': {
    doi: '10.5555/rep.unknown', title: 'A replication of Gray (2014)', authors: 'H. Replicator', venue: 'Replication Reports', year: 2023,
    abstract: 'This is a replication of Gray (2014) using materials from the original authors.',
    referencedWorks: [ORIG(109, 'Gray', 2014)],
  },
};

function resolved(w: Work) {
  return {
    ...w,
    sourcesQueried: ['openalex', 'crossref'],
    providerReports: [{ provider: 'openalex', status: 'found' }, { provider: 'crossref', status: 'found' }],
    fieldProvenance: { title: ['openalex'], abstract: ['openalex'] },
  };
}

export async function cannedResolveWork(doi: string, ...rest: unknown[]) {
  ioCalls.push({ fn: 'resolveWork', args: [doi, ...rest] });
  const w = WORKS[doi];
  return w ? resolved(w) : null;
}

export async function cannedResolveWorkDetailed(doi: string, providers?: unknown, creds?: unknown) {
  ioCalls.push({ fn: 'resolveWorkDetailed', args: [doi, providers ?? null, creds ?? null] });
  if (doi === '10.5555/enrich.throws') throw new Error('provider exploded');
  if (doi.startsWith('10.5555/cand.')) {
    // enrichment for citing-work candidates: a longer abstract for the thin ones
    const long = `${'Extended abstract text for enrichment. '.repeat(8)}We replicated Target et al. (2010) and failed to replicate the original effect.`;
    return {
      work: { ...resolved({ doi, title: `Enriched ${doi}`, authors: 'X', venue: 'V', year: 2020, abstract: long, referencedWorks: [] }) },
      sourcesQueried: ['openalex'], providerReports: [{ provider: 'openalex', status: 'found' }],
    };
  }
  const w = WORKS[doi];
  if (!w) {
    return { work: null, sourcesQueried: ['openalex', 'crossref'], providerReports: [{ provider: 'openalex', status: 'not_found' }, { provider: 'crossref', status: 'not_found' }] };
  }
  const r = resolved(w);
  return { work: r, sourcesQueried: r.sourcesQueried, providerReports: r.providerReports };
}

const CAND_LONG_ABSTRACT = `${'This is a long abstract that already exceeds the enrichment threshold. '.repeat(5)}We conducted a replication of Target et al. (2010) and the effect was not replicated.`;

export async function cannedGetCitingWorks(doi: string, maxResults?: number, creds?: unknown) {
  ioCalls.push({ fn: 'getCitingWorks', args: [doi, maxResults ?? null, creds ?? null] });
  if (doi === '10.5555/target.none') return { targetWorkId: null, candidates: [] };
  if (doi === '10.5555/target.empty') {
    return { targetWorkId: 'W900', targetFirstAuthor: 'Target', targetYear: 2010, candidates: [] };
  }
  if (doi === '10.5555/target.main' || doi === '10.5555/target.abort' || doi === '10.5555/target.fred') {
    return {
      targetWorkId: 'W500', targetTitle: 'Target original study', targetAuthors: 'Target and Co.', targetVenue: 'Journal of Synthetic Psychology',
      targetFirstAuthor: 'Target', targetYear: 2010,
      candidates: [
        // thin abstract: needs enrichment; back-references the target
        { openalexId: 'W601', doi: '10.5555/cand.thin', title: 'Thin candidate', abstract: 'Short.', referencedWorkIds: ['W500', 'W1'] },
        // long abstract: no enrichment; back-references the target
        { openalexId: 'W602', doi: '10.5555/cand.long', title: 'A replication of Target et al. (2010)', abstract: CAND_LONG_ABSTRACT, referencedWorkIds: ['W500'] },
        // does not back-reference the target: filtered out
        { openalexId: 'W603', doi: '10.5555/cand.noref', title: 'Unrelated citing study', abstract: CAND_LONG_ABSTRACT, referencedWorkIds: ['W2'] },
        // no DOI: skipped
        { openalexId: 'W604', doi: null, title: 'No doi candidate', abstract: CAND_LONG_ABSTRACT, referencedWorkIds: ['W500'] },
        // enrichment throws: falls back to the OpenAlex text
        { openalexId: 'W605', doi: '10.5555/enrich.throws', title: 'Throwing candidate', abstract: 'Tiny.', referencedWorkIds: ['W500'] },
      ],
    };
  }
  return { targetWorkId: null, candidates: [] };
}

export async function cannedResolveAuthorYear(mention: { author: string; year: number; sentence: string; replicationTitle?: string }, options?: unknown) {
  ioCalls.push({ fn: 'resolveAuthorYearViaCrossref', args: [mention, options ?? null] });
  if (mention.author === 'Black') {
    return {
      matched: true, doi: '10.5555/orig.black', reason: 'unique_top_candidate', score: 7,
      candidates: [{ doi: '10.5555/orig.black', title: 'Original study by Black', firstAuthor: 'Black', year: 2009, container: 'Journal of Synthetic Psychology', score: 7 }],
    };
  }
  return { matched: false, doi: null, reason: 'no_candidate', score: 0, candidates: [] };
}

// ---------------------------------------------------------------------------------------------
// FReD data
// ---------------------------------------------------------------------------------------------

export const FRED_CSV = '﻿doi_o,title_o,author_o,journal_o,year_o,doi_r,title_r,author_r,journal_r,year_r,outcome,outcome_quote,type,source\r\n'
  + '10.5555/ORIG.1,"Original, with a comma","[{""given"":""Ada"",""family"":""Alpha""},{""given"":""Bo"",""family"":""Beta""}]",Journal A,2001,https://doi.org/10.5555/fred.r1,Replication one,"[{""given"":""Cy"",""family"":""Gamma""}]",Journal B,2010,failed,"The effect ""did not"" replicate.",direct,Many Labs\r\n'
  + '10.5555/ORIG.1,"Original, with a comma","[{""given"":""Ada"",""family"":""Alpha""},{""given"":""Bo"",""family"":""Beta""}]",Journal A,2001,10.5555/fred.r2,Replication two,Plain Author,Journal C,,Mixed,"Mixed support",conceptual,Lab\r\n'
  + 'doi:10.5555/orig.2,Second original,,Journal D,not-a-year,10.5555/fred.r3,Replication three,,,2015,successful,,direct,\r\n'
  + ',No original doi,,,,10.5555/fred.r4,Skipped row,,,,failed,,direct,\r\n';

// ---------------------------------------------------------------------------------------------
// Verifier answers
// ---------------------------------------------------------------------------------------------

export const LLM_ANSWERS: Record<string, string | Error> = {
  agree: '{"isReplication":"yes","outcome":"failed","supportingQuote":"the replication found no evidence for anchoring","confidence":"high","reason":"clear"}',
  fenced: '```json\n{"isReplication":"yes","outcome":"mixed","supportingQuote":"","confidence":"low","reason":"fenced"}\n```',
  embedded: 'Sure! Here you go: {"isReplication":"no","outcome":"unknown","supportingQuote":"","confidence":"high","reason":"not a replication"} hope that helps',
  unclear: '{"isReplication":"unclear","outcome":"unknown","supportingQuote":"","confidence":"low","reason":"unsure"}',
  badQuote: '{"isReplication":"yes","outcome":"failed","supportingQuote":"a sentence that is not in the abstract","confidence":"high","reason":"hallucinated"}',
  unknownOutcome: '{"isReplication":"yes","outcome":"unknown","supportingQuote":"","confidence":"medium","reason":"no outcome stated"}',
  garbage: 'I cannot answer that.',
  broken: '{"isReplication": "yes", ',
  throws: new Error('upstream 503'),
};

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

export interface ParityApi {
  findReplicationsForDoi(doi: string, opts: Record<string, unknown>): Promise<unknown>;
  extractReplication(doi: string): Promise<unknown>;
  extractReplicationStandalone(doi: string, options: Record<string, unknown>): Promise<any[]>;
  recordsToCsv(records: any[]): string;
  dedupFindings(findings: any[]): any[];
  checkFloraReplications(doi: string, db: any): unknown;
  parseAndIndexFloraCsv(csv: string): any;
  mapFloraOutcome(outcome: string): unknown;
  aggregateOutcome(outcomes: any[]): unknown;
  /** Run the verifier path with a canned model answer; `callLlm` returns the raw text or throws. */
  runVerifier(input: any, callLlm: (prompt: string) => Promise<{ content: string; model?: string; provider?: string }>): Promise<unknown>;
  /** What the cache saw, in order: [op, doi, direction]. */
  cacheLog: Array<[string, string, string]>;
  bundledFredChecksum(): { sha256: string; totalOriginals: number; totalEntries: number };
  normalizeCheck(inputs: string[]): string[];
}

const NOW = () => new Date('2026-05-04T09:00:00.000Z');
const FIXED = { now: NOW, codeVersion: 'parity-build' };

const VERIFIER_INPUT = {
  inputDoi: '10.5555/rep.failed', normalizedDoi: '10.5555/rep.failed', status: 'needs_more_metadata',
  title: 'A direct replication of Smith et al. (2010) on anchoring',
  abstract: 'We conducted a direct replication of Smith et al. (2010). We failed to replicate the original effect; the replication found no evidence for anchoring.',
  targets: [{ originalDoi: '10.5555/orig.101', originalTitle: 'Original study 101', originalYear: 2010 }],
  unresolvedReason: 'unknown_outcome_or_ambiguous_target',
};

async function attempt<T>(fn: () => Promise<T> | T): Promise<unknown> {
  try { return await fn(); } catch (err) { return { threw: (err as Error)?.message ?? String(err) }; }
}

export async function runParityCorpus(api: ParityApi): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // --- DOI normalisation through the pipelines' entry points
  out.normalize = api.normalizeCheck([
    'https://doi.org/10.5555/ABC.1)', 'doi:10.5555/abc.1;', 'HTTP://DX.DOI.ORG/10.5555/abc.1],', '10.5555%2Fabc.1.', '', '  10.5555/abc.1/ ', '10.5555/abc(1)',
  ]);

  // --- FReD
  const db = api.parseAndIndexFloraCsv(FRED_CSV);
  // lastUpdated is "today" -- not part of the contract under test
  out.fredDb = { ...db, lastUpdated: '<today>' };
  out.fredHits = ['10.5555/orig.1', 'https://doi.org/10.5555/ORIG.1', 'doi:10.5555/orig.2', '10.5555/missing', '', 'not a doi'].map(d => api.checkFloraReplications(d, db));
  out.fredOutcomes = ['successful', 'FAILED', ' mixed ', 'methodologically flawed', 'faces challenges', 'some issues', '', 'whatever'].map(o => api.mapFloraOutcome(o));
  out.fredAggregate = [[], ['successful'], ['successful', 'partial'], ['unknown', 'successful'], ['partial', 'failed', 'successful']].map(o => api.aggregateOutcome(o));
  out.fredBundled = api.bundledFredChecksum();

  // --- reverse
  api.cacheLog.length = 0;
  out.reverse = {};
  for (const doi of ['10.5555/rep.failed', '10.5555/rep.success', '10.5555/rep.ambiguous', '10.5555/rep.unknown', '10.5555/not.replication', '10.5555/missing', 'https://doi.org/10.5555/REP.FAILED)', '']) {
    (out.reverse as any)[doi || '<empty>'] = await attempt(() => api.extractReplication(doi));
  }
  out.reverseCache = [...api.cacheLog];

  // --- forward
  api.cacheLog.length = 0;
  const fredHit = api.checkFloraReplications('10.5555/orig.1', db);
  const fredHitMain = {
    type: 'replication-status', metadata: {
      title: 'Target original study', authors: 'Target and Co.', journal: 'Journal of Synthetic Psychology', year: 2010,
      replicationDetails: [
        // same replication DOI the citation graph also finds: exercises the corroboration merge
        { doi: '10.5555/cand.long', title: 'A replication of Target et al. (2010)', authors: 'Q. R.', journal: 'J', year: 2019, outcomeType: 'partial', outcomeQuote: 'only partly replicated' },
        { doi: '10.5555/fred.only', title: 'FReD only', authors: 'S. T.', journal: 'J', year: 2012, outcomeType: 'successful', outcomeQuote: '' },
        { doi: '', title: 'No-doi FReD entry', outcomeType: 'weird' },
      ],
    },
  };
  out.forward = {} as Record<string, unknown>;
  const fwd = out.forward as Record<string, unknown>;
  fwd.invalid = await attempt(() => api.findReplicationsForDoi('not-a-doi', {}));
  fwd.shortDoi = await attempt(() => api.findReplicationsForDoi('10/abc', {}));
  fwd.noTarget = await attempt(() => api.findReplicationsForDoi('10.5555/target.none', { floraHit: null }));
  fwd.emptyCandidates = await attempt(() => api.findReplicationsForDoi('10.5555/target.empty', { floraHit: null }));
  fwd.fredOnlyFromCsv = await attempt(() => api.findReplicationsForDoi('10.5555/orig.1', { floraHit: fredHit }));
  fwd.mainNoFred = await attempt(() => api.findReplicationsForDoi('https://doi.org/10.5555/TARGET.MAIN.', { floraHit: null }));
  fwd.mainWithFred = await attempt(() => api.findReplicationsForDoi('10.5555/target.fred', { floraHit: fredHitMain }));
  fwd.callerAuthorYear = await attempt(() => api.findReplicationsForDoi('10.5555/target.main', { floraHit: null, targetFirstAuthor: 'Target', targetYear: 2010, targetTitle: 'Caller title', targetAuthors: 'Caller authors', targetVenue: 'Caller venue' }));
  const ac = new AbortController();
  ac.abort();
  fwd.aborted = await attempt(() => api.findReplicationsForDoi('10.5555/target.abort', { floraHit: fredHitMain, signal: ac.signal }));
  out.forwardCache = [...api.cacheLog];

  // --- dedup, directly
  const f = (over: Record<string, unknown>) => ({
    originalDoi: '10.5555/orig.1', originalReferenceExtracted: 'X (2010)', justificationPhrase: '', outcomePhrase: '', outcome: 'unknown',
    confidence: 'low', evidence: [], signalProvenance: [], replicationDoi: '10.5555/r', ...over,
  });
  out.dedup = api.dedupFindings([
    f({ confidence: 'medium', outcome: 'successful', outcomePhrase: 'worked', signalProvenance: ['a'], evidence: ['e1'], justificationPhrase: 'j1' }),
    f({ confidence: 'high', outcome: 'mixed', outcomePhrase: 'partly', signalProvenance: ['b', 'a'], evidence: ['e2', 'e1'], justificationPhrase: '' }),
    f({ replicationDoi: 'na', signalProvenance: ['c'] }),
    f({ replicationDoi: '', signalProvenance: ['d'] }),
    f({ replicationDoi: '10.5555/other', outcome: 'failed', confidence: 'high' }),
    f({ replicationDoi: '10.5555/other', outcome: 'unknown', confidence: 'medium', outcomePhrase: 'late phrase' }),
  ]);

  // --- standalone
  const sa: Record<string, unknown> = {};
  out.standalone = sa;
  const verifierCalls: unknown[] = [];
  const canned = (answer: string | Error) => async (input: any) => {
    verifierCalls.push({ doi: input.normalizedDoi, status: input.status, unresolvedReason: input.unresolvedReason, targets: input.targets.length });
    return api.runVerifier(input, async () => { if (answer instanceof Error) throw answer; return { content: answer, model: 'canned-model' }; });
  };
  for (const doi of [
    '10.5555/rep.failed', '10.5555/rep.success', '10.5555/rep.ambiguous', '10.5555/rep.norefs', '10.5555/rep.noresolve',
    '10.5555/not.replication', '10.5555/missing', '10.5555/rep.unknown', 'garbage', '10/shortdoi', '10.1234', 'https://doi.org/10.5555/REP.FAILED)',
  ]) {
    sa[doi] = await attempt(() => api.extractReplicationStandalone(doi, { ...FIXED }));
  }
  sa['fallback:off'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.fallback', { ...FIXED }));
  sa['fallback:on'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.fallback', { ...FIXED, enableCrossrefAuthorYearFallback: true }));
  sa['fallback:on+verifier'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.fallback', { ...FIXED, enableCrossrefAuthorYearFallback: true, verifier: canned(LLM_ANSWERS.unknownOutcome) }));
  sa['fallback:explicit-off'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.fallback', { ...FIXED, enableCrossrefAuthorYearFallback: false }));
  for (const [name, answer] of Object.entries(LLM_ANSWERS)) {
    sa[`verifier:${name}:rep.unknown`] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.unknown', { ...FIXED, verifier: canned(answer) }));
  }
  sa['verifier:agree:ambiguous'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.ambiguous', { ...FIXED, verifier: canned(LLM_ANSWERS.agree) }));
  sa['verifier:fenced:norefs'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.norefs', { ...FIXED, verifier: canned(LLM_ANSWERS.fenced) }));
  sa['verifier:accepted-row-is-not-reverified'] = await attempt(() => api.extractReplicationStandalone('10.5555/rep.failed', { ...FIXED, verifier: canned(LLM_ANSWERS.agree) }));
  out.verifierCalls = verifierCalls;
  out.csv = api.recordsToCsv([
    ...(sa['10.5555/rep.failed'] as any[]), ...(sa['10.5555/rep.ambiguous'] as any[]), ...(sa['10.5555/missing'] as any[]),
    ...(sa['verifier:garbage:rep.unknown'] as any[]),
  ]);
  out.csvEmpty = api.recordsToCsv([]);

  // --- the verifier on its own
  const vr: Record<string, unknown> = {};
  out.verifier = vr;
  for (const [name, answer] of Object.entries(LLM_ANSWERS)) {
    vr[name] = await attempt(() => api.runVerifier(VERIFIER_INPUT, async () => { if (answer instanceof Error) throw answer; return { content: answer, provider: 'canned-provider' }; }));
  }
  vr.promptSeen = await (async () => {
    let seen = '';
    await api.runVerifier(VERIFIER_INPUT, async (p) => { seen = p; return { content: LLM_ANSWERS.agree as string }; });
    return seen;
  })();

  return out;
}

/**
 * Stable serialisation: sorted keys, 2-space indent, trailing newline.
 * `maskedVersion` is the host's own release version (it changes every release and is not part
 * of what the pipelines compute); every occurrence of it inside a string value is replaced by '<host-version>'.
 */
export function stableStringify(value: unknown, maskedVersion?: string): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
    : (maskedVersion !== undefined && typeof v === 'string' && v.includes(maskedVersion)) ? v.split(maskedVersion).join('<host-version>')
    : v;
  return JSON.stringify(sort(value), null, 2) + '\n';
}
