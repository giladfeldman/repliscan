# repliscan

Replication-study discovery for academic papers, as a TypeScript library:

- **Discovery** — one OR-bundled phrase search per source (OpenAlex, Crossref, Semantic
  Scholar), deterministic keyword expansion, candidate normalization, regex exclusion of
  non-scholarly "replication" (DNA, code, data), a deterministic search score, and a
  resumable, checkpointed run loop (`runDiscovery`).
- **Classification** — a deterministic, rule-based classifier (`classifyReplication`) that
  decides whether a paper reports a replication, extracts the "Author (Year)" targets it
  replicates, confirms each target against the paper's own reference list, and labels the
  outcome (`successful` / `failed` / `mixed` / `unknown`) with a confidence level.
- **Metadata** — a multi-provider resolver (`resolveWork`) that queries OpenAlex, Crossref,
  DataCite, doi.org, Semantic Scholar and OpenCitations in parallel and merges the results
  with per-field provenance, plus a Crossref author-year fallback resolver.

Pure logic plus HTTP clients: no database, no web framework, no environment variables.
Credentials are passed in as arguments, and persistence is an injected interface
(`RunPersistence`). The library was extracted from the Scimeto platform so that the
community can inspect, validate and reuse it.

The full API reference (every export, field and value) is in [docs/API.md](docs/API.md).

## How it works (methodological basis)

**Search.** Every keyword variant in the bundled spec (`search-keywords.yaml`, 26 entries
that expand to 79 phrases), plus any keywords you supply, is quoted and OR-joined into a
single query per source. That is one paginated query per source per run, not one per
phrase. The search APIs cannot tell you *which* phrase matched, so after fetching,
`attributeKeywords` re-matches every phrase against each title and abstract
(case-insensitive, whole-word).

**Exclusion.** Four regex patterns (`exclusion-patterns.yaml`) drop biological
replication (`BIOLOGICAL`, `STRUCTURAL`) and replication of code, data or methods
(`TECHNICAL_OBJECT`, `TECHNICAL_VERB`) before scoring.

**Score.** `computeSearchScore` adds up the weights in `ranking-weights.yaml`:
a title hit counts 1.0, or an abstract-only hit 0.5; two or more distinct keyword ids add
0.2; and two or more sources add 0.1. The total is capped at 1.0. Given the same input and
spec, the score is always the same.

**Classification.** Each step is a fixed rule, with no model:
1. *Detection.* `hasReplicationPhrase` looks for one of 18 replication phrases in the
   title or abstract ("direct replication", "failed to replicate", "registered report of",
   and so on). A text with a non-scholarly context ("DNA replication", "replication of the
   code") is rejected outright.
2. *Target extraction.* `extractTargets` finds "Smith (2010)", "Smith et al. (2010)" and
   "Smith & Jones (2010)" citations, one sentence at a time.
3. *Back-reference gate.* `resolveTarget` keeps a target only if the paper's reference
   list contains a work with the same first-author surname (last token, so "de Groot"
   matches "Groot") within ±1 year. A target without such a reference is dropped. This is
   the main defence against false positives.
4. *Outcome.* `classifyOutcome` checks for failed, then mixed, then successful phrasing,
   one sentence at a time. It skips a phrase that is directly preceded by a negation, and
   it also treats a collapse in effect size within one sentence (for example `d = 0.45 …
   d = 0.03`) as `failed`.
5. *Confidence.* `scoreConfidence` rates a back-referenced target with a title phrase
   `high` (or `medium` if the target is ambiguous), and one with only an abstract phrase
   `medium`. Targets rated `low` are dropped.

Data sources, by DOI: OpenAlex (Priem, Piwowar & Orr, 2022,
[10.48550/arXiv.2205.01833](https://doi.org/10.48550/arXiv.2205.01833)); Semantic Scholar
(Kinney et al., 2023, [10.48550/arXiv.2301.10140](https://doi.org/10.48550/arXiv.2301.10140));
OpenCitations (Peroni & Shotton, 2020, [10.1162/qss_a_00023](https://doi.org/10.1162/qss_a_00023)).

## Install

**repliscan is distributed as a git-tag dependency, not through npm.** It is deliberately
not published to the npm registry. Pin a tag directly:

```jsonc
// package.json
"dependencies": {
  "repliscan": "github:giladfeldman/repliscan#v0.1.3"
}
```

npm clones the repository and runs the `prepare` script, which builds `dist/`. A tag pin
therefore installs a working build without the registry. Always pin an explicit tag: a
bare `github:giladfeldman/repliscan` follows the default branch, so upstream changes land
in your build without warning. npm 11 prints an `allow-scripts` warning about the
`prepare` script during this install. The build still runs: this was verified with npm
11.16 by installing from a local git URL into an empty project. The package requires Node.js 18 or later and is ESM-only
(`import`, not `require`).

## Quickstart

Both blocks run offline. `node scripts/check-docs-coverage.mjs` executes them against a
fresh build on every run.

Classify one paper. The reference list is what confirms the target:

```js
import { classifyReplication } from 'repliscan';

const result = classifyReplication({
  doi: '10.5555/example-replication',
  title: 'A preregistered direct replication of Smith et al. (2010)',
  abstract:
    'We report a direct replication of Smith et al. (2010) with a larger sample. ' +
    'We failed to replicate the original effect.',
  referencedWorks: [
    { openalexId: '', doi: '10.5555/example-original', firstAuthor: 'Smith', year: 2010,
      title: 'The original study' },
  ],
});

console.log(result.isReplication);            // true
for (const t of result.targets) {
  console.log(t.originalDoi, t.outcome, t.confidence, t.signalProvenance.join(','));
}
// 10.5555/example-original failed high back-ref-confirmed,phrase-in-title,phrase-in-abstract,outcome-phrase-extracted
```

Run the discovery pipeline over an in-memory source, which shows normalization,
exclusion, keyword attribution and scoring:

```js
import { runDiscovery, BUNDLED_SPEC_DIR } from 'repliscan';

const placeholder = { id: 'REP_OF', field: 'title', permutation: 'replication of' };
const fakeSource = {
  id: 'openalex',
  verifiedAt: new Date(),
  reportLimits: () => ({}),
  async *search() {
    yield {
      candidates: [
        { source: 'openalex', doi: 'https://doi.org/10.5555/EXAMPLE-1', matchedKeyword: placeholder,
          title: 'A registered replication report of the facial feedback effect',
          abstract: 'We failed to replicate the original finding.' },
        { source: 'openalex', doi: '10.5555/example-2', matchedKeyword: placeholder,
          title: 'DNA replication fork stalling in yeast' },
      ],
    };
  },
};

const rows = [];
const run = await runDiscovery({
  runId: 'demo',
  config: {
    specVersion: 1,
    keywords: ['replicat*'],
    filters: { languages: [], sources: ['openalex'], maxCandidatesPerSource: 100, skipDoisInFlora: false },
  },
  adapters: { openalex: fakeSource },
  specDir: BUNDLED_SPEC_DIR,
  persistence: null,
  classify: false, // true resolves each DOI's references over the network
  fileWriters: {
    onCandidate: (c, status) => rows.push({ doi: c.doi, score: c.searchScore, status,
      keywords: [...new Set(c.matchedKeywords.map((m) => m.id))].join(',') }),
    onProgress: () => {},
  },
});

console.log(run.status, run.stats.excludedByPattern); // completed { BIOLOGICAL: 1 }  (the DNA paper)
console.table(rows);  // one row: 10.5555/example-1, score 1, status pending,
                      // keywords REGISTERED_REP,FAILED_TO_REP,REGISTERED_REPLICATION_REPORT,USER_REPLICAT_
```

## Using it against the live APIs

These calls need network access and are **not** run by the docs gate. Treat the output as
illustrative, because live data changes.

```js
import {
  resolveWorkDetailed, DEFAULT_METADATA_PROVIDERS, classifyReplication,
  OpenAlexSourceAdapter, CrossrefSourceAdapter, SemanticScholarSourceAdapter,
} from 'repliscan';

const creds = { openAlexApiKey: process.env.MY_OPENALEX_KEY, openAlexMailto: 'you@example.org' };
const { work, providerReports } = await resolveWorkDetailed('10.1126/science.aac4716',
  DEFAULT_METADATA_PROVIDERS, creds);
console.log(providerReports);                 // one { provider, status } per provider
if (work) console.log(classifyReplication(work));

const adapters = {
  openalex: new OpenAlexSourceAdapter({ apiKey: creds.openAlexApiKey, verifiedAt: new Date(), ratePerSec: 5 }),
  crossref: new CrossrefSourceAdapter({ mailto: 'you@example.org', verifiedAt: new Date(), ratePerSec: 1.5 }),
  semantic_scholar: new SemanticScholarSourceAdapter({ verifiedAt: new Date(), ratePerSec: 0.5 }),
};
// pass `adapters` to runDiscovery as in the Quickstart
```

`process.env.MY_OPENALEX_KEY` is *your* code reading *your* variable. The library itself
reads no environment variables.

## API at a glance

| Area | Main exports |
|---|---|
| Run loop | `runDiscovery`, `RunDiscoveryArgs`, `RunResult`, `RunOutcome`, `FileWriters`, `RunPersistence` |
| Source adapters | `OpenAlexSourceAdapter`, `CrossrefSourceAdapter`, `SemanticScholarSourceAdapter`, `SourceAdapter`, `TokenBucket` |
| Keywords | `expandWildcard`, `expandSpecKeyword`, `expandPermutationList`, `expandUserInput`, `expandAll`, `attributeKeywords`, `loadSpecKeywords`, `expandedFromEffective` |
| Filter and rank | `applyExclusions`, `loadExclusionPatterns`, `patternsFromEffective`, `computeSearchScore`, `loadRankingWeights`, `weightsFromEffective`, `normalizeCandidate`, `mergeCandidates` |
| Spec from a database | `resolveEffectiveSpec`, `SpecDb`, `mergeOverride`, `hashSpec`, `canonicalJsonStringify`, `BUNDLED_SPEC_DIR` |
| Classifier | `classifyReplication`, `hasReplicationPhrase`, `findReplicationPhrase`, `extractTargets`, `resolveTarget`, `classifyOutcome`, `scoreConfidence`, `classifyCandidate` |
| Metadata | `resolveWork`, `resolveWorkDetailed`, `DEFAULT_METADATA_PROVIDERS`, `getWork`, `getCitingWorks`, `resolveAuthorYearViaCrossref`, `normalizeDoi` |

Every export, including all the types and small helpers, is documented with its fields
and values in **[docs/API.md](docs/API.md)**.

## Configuration

- **No environment variables.** Pass credentials explicitly: `MetadataCredentials` for the
  metadata resolver, and constructor options for the search adapters. When no credentials
  are given, the metadata providers identify themselves with the built-in contact address
  `DEFAULT_POLITE_MAILTO`. Supply your own `openAlexMailto` so that API operators can
  reach *you*.
- **Spec files** ship in `BUNDLED_SPEC_DIR`: `search-keywords.yaml`,
  `exclusion-patterns.yaml`, `ranking-weights.yaml` and `source-configs.yaml`. To use your
  own spec, pass a directory with the first three files as `specDir`, or pass a
  database-resolved `effectiveSpec` (see `resolveEffectiveSpec`). `source-configs.yaml` is
  reference documentation of each API's limits. **No code reads it**, so its `*_env` keys
  do not cause any environment variable to be read.

## Output

`runDiscovery` resolves to a `RunResult`, `{ status, stats, error? }`. Candidates are
streamed to `fileWriters.onCandidate` and/or `persistence.upsertCandidates` as
`NormalizedCandidate` objects: a normalized lower-case `doi`, title, abstract, year,
authors, journal, and `matchedKeywords` (each with an `id`, a `field` of `title` or
`abstract`, and a `permutation`), plus a `searchScore` between 0 and 1. The classifier
status is one of `accepted`, `ambiguous`, `needs_more_metadata`, `rejected`, `errored`, or
`pending` when classification is off. `classifyReplication` returns a
`ReverseExtractorResult` of `ReplicationFinding` targets. Every field is described in
[docs/API.md](docs/API.md#output-shapes).

## Limitations and failure modes

- **Recall is limited by phrasing.** A replication that uses none of the spec phrases, or
  that cites its target without an "Author (Year)" pattern (for example numbered
  citations), is not found or not classified.
- **The back-reference gate needs references.** A target is kept only if the paper's
  reference list contains a matching first author and year. When the providers return no
  references, the result is `needs_more_metadata`, not a verdict.
- **Outcome labels come from phrases, not statistics.** The only numeric rule is the
  within-sentence effect-size collapse. `unknown` means that no outcome phrase was found.
  It does not mean the replication was inconclusive.
- **A run that hit source errors can still report `completed`.** An HTTP error from a
  source, other than repeated 429s, ends that source's task. It is counted in
  `stats.errorsPerSource` and the run continues. Check `errorsPerSource` before you treat
  a run as complete. Three consecutive 429s from one source return `paused` with the
  reason `rate_limit_threshold`.
- **Adapters with a `verifiedAt` older than 60 days are refused.** The run fails with the
  reason `spec_stale`.
- **Classification during a run does not pass credentials.** `runDiscovery` calls
  `resolveWork(doi)` without credentials, so classification uses the default contact
  address and no API keys. To use credentials, call `classifyCandidate` yourself with
  `deps.resolveWorkFn`.
- **Declared but not acted on.** `RunFilters.skipDoisInFlora`,
  `RunFilters.maxCandidatesPerSource` and `DiscoveryRunConfig.specVersion` are part of the
  config type, but `runDiscovery` does not read them. `DiscoveryStats.floraKnown` is always
  0 and `estimatedRemainingSeconds` is never set. The `SourceId` values `bob_reed`, `i4r`
  and `fred_data` have no adapter in this library. The adapters' `reportLimits()`
  currently always returns `{}`.
- **Source-diversity bonus.** `runDiscovery` gives +0.1 to *every* candidate when two or
  more sources were requested, so this bonus does not change the ranking within a run.
- **At most `maxPhrasesPerQuery` phrases are searched** (100 by default). Any phrases
  beyond that are dropped from the query without a warning.
- **Logging.** The metadata layer writes a few `console.warn` lines for rate limits,
  truncated reference lists (capped at 400 references) and failed reference batches.
- **Hard-coded User-Agent names.** The HTTP User-Agent strings name the Scimeto platform.

## Development

```bash
npm install
npm run build        # tsc + copy the spec YAML into dist/
npm test             # jest, offline (HTTP is mocked); includes the gate's two-sided test
node scripts/check-docs-coverage.mjs   # documentation-drift gate: builds, runs the Quickstart
```

## How to cite

Please cite the software (see [CITATION.cff](CITATION.cff)): Feldman, G. (2026).
*repliscan: replication-study discovery and classification* (Version 0.1.2)
[Computer software]. https://github.com/giladfeldman/repliscan

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
Downstream consumers are listed in [DOWNSTREAM.md](DOWNSTREAM.md).
