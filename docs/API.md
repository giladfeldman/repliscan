# repliscan API reference

Every name exported from `repliscan` (the package entry, `src/index.ts`), grouped by what
it does. `node scripts/check-docs-coverage.mjs` derives the public surface from the source
and fails if any export, member, parameter, string value or spec id is missing from this
file or from the README.

- [Discovery run](#discovery-run)
- [Source adapters](#source-adapters)
- [Keyword expansion](#keyword-expansion)
- [Normalize, exclude, rank](#normalize-exclude-rank)
- [Spec: bundled files and database-resolved spec](#spec)
- [Replication classifier](#replication-classifier)
- [Metadata resolution](#metadata-resolution)
- [Output shapes](#output-shapes)
- [Discovery data types](#discovery-data-types)

---

## Discovery run

### `runDiscovery(args: RunDiscoveryArgs): Promise<RunResult>`

Runs one discovery run from start to finish. The steps are:

1. Load the keywords, exclusions and ranking weights, either from YAML in `specDir` or from
   `effectiveSpec`.
2. Refuse the run if any adapter's `verifiedAt` is more than 60 days old. The result is
   `status: 'failed'` with `error.reason: 'spec_stale'`.
3. Expand the spec keywords and the user keywords (`config.keywords`). The spec wins
   phrase duplicates.
4. Build one task per requested source in `config.filters.sources` that has an adapter. If
   there are none, the result is `failed` with `no_sources_configured`.
5. For each page an adapter yields:
   - normalize each candidate and apply the exclusions, counting drops in
     `stats.excludedByPattern`;
   - re-attribute the keywords (`attributeKeywords`), merge candidates with the same DOI,
     and score them;
   - drop candidates below `ranking.min_search_score_threshold`, which applies only with
     `effectiveSpec` (drops are counted in `candidatesDroppedByThreshold`);
   - persist the candidates and optionally classify each one (`classifyCandidate`);
   - checkpoint the progress, then check `persistence.checkPauseSignal`.
6. A thrown error whose message contains `threshold exceeded` (three consecutive 429s)
   returns `paused` with `error.reason: 'rate_limit_threshold'`. Any other error ends
   that source's task and is counted in `stats.errorsPerSource`. The run then continues
   and can still return `completed`.

`RunDiscoveryArgs`:

| Field | Type | Meaning |
|---|---|---|
| `runId` | `string` | Your run identifier, passed back to the `persistence` methods. |
| `config` | `DiscoveryRunConfig` | The user keywords and the filters. |
| `adapters` | `Partial<Record<SourceId, SourceAdapter>>` | The adapter for each source. A source listed in `filters.sources` without an adapter is skipped. |
| `specDir` | `string` | The directory holding the spec YAML. Usually `BUNDLED_SPEC_DIR`. It is ignored when `effectiveSpec` is given. |
| `persistence` | `RunPersistence \| null` | The database seam. Pass `null` to use `fileWriters` instead. |
| `fileWriters` | `FileWriters?` | Callbacks, required when `persistence` is `null`. |
| `classify` | `boolean?` | Classify each candidate. The default is `true`, which makes network calls through `resolveWork`. |
| `effectiveSpec` | `EffectiveSpec?` | A pre-resolved spec that replaces the YAML and enables `min_search_score_threshold`. |

`FileWriters`: `onCandidate(candidate, classifierStatus)` is called for each kept
candidate, and `onProgress(progress, stats)` is called after each page. Both may return a
promise.

`RunResult`: `{ status: RunOutcome, stats: DiscoveryStats, error?: { reason, details? } }`.
`RunOutcome` is `'completed' | 'paused' | 'cancelled' | 'failed'`.

### `RunPersistence`

The database seam. Implement it to have a run persisted and resumable:

| Method | Called |
|---|---|
| `upsertCandidates(runId, candidates)` | once per page, with the filtered candidates. It must be idempotent. |
| `updateClassifierResult(runId, doi, source, status, result)` | once per classified candidate. |
| `updateProgress(runId, progress, stats)` | after every page. |
| `checkPauseSignal(runId)` | after every page. Return `'paused'` or `'cancelled'` to stop the run cleanly; any other `DiscoveryRunStatus`, or `null`, continues it. |

`DiscoveryRunStatus`: `pending`, `running`, `paused`, `completed`, `failed`, `cancelled`.

### `classifyCandidate(candidate, deps?): Promise<ClassifierVerdict>`

Classifies one discovered candidate:

1. It calls `deps.resolveWorkFn` (by default `resolveWork`, with no credentials) to fetch
   the reference list and richer metadata.
2. It builds a `ReplicationClassifierInput`.
3. It calls `deps.classifyFn` (by default `classifyReplication`).
4. It maps the result to a status.

`ClassifierBridgeDeps`: `{ resolveWorkFn?, classifyFn? }`. `ClassifierVerdict`:
`{ status: ClassifierStatus, result: ReverseExtractorResult | null }`.

| `status` | When |
|---|---|
| `rejected` | The classifier found no replication phrase. |
| `needs_more_metadata` | The title and abstract are both empty, the DOI did not resolve, or a phrase was found but no target passed the back-reference gate. |
| `accepted` | At least one target was found and none is ambiguous. |
| `ambiguous` | At least one target matched more than one reference. |
| `errored` | The classifier threw. Nothing is logged. |

A metadata-resolver exception does not fail the candidate. The candidate is classified
with an empty reference list, which yields `needs_more_metadata` or `rejected`.

`ClassifierStatus` also includes `pending`, the status reported when `classify: false`.

---

## Source adapters

All three adapters implement `SourceAdapter`:

- `id: SourceId`
- `verifiedAt: Date`
- `search(args: SearchArgs): AsyncGenerator<SearchPage>`
- `reportLimits(): RateLimitReport`

Each adapter quotes every phrase, strips any `"` or `\` from it, OR-joins the phrases into
one query, and pages through the results.

Rate handling is the same for all three. Every request first calls `take()` on an internal
`TokenBucket`. On a 429 the adapter halves the rate, waits `Retry-After` seconds (5 when the
header is missing) and retries the same page. A third consecutive 429 throws
`… 429 threshold exceeded`. Any other non-OK response throws.

The first phrase is stored in each `RawCandidate.matchedKeyword` only as a placeholder.
`runDiscovery` replaces it using `attributeKeywords`.

- `SearchArgs`: `{ keywords: ExpandedKeyword[], filters: RunFilters, cursor?: string }`.
- `SearchPage`: `{ candidates: RawCandidate[], nextCursor?: string }`. A missing
  `nextCursor` means there are no more pages.
- `RateLimitReport`: `{ requestsRemaining?, resetAt? }`. No adapter fills it in yet, so
  `reportLimits()` returns `{}`.

Each adapter is constructed as `new OpenAlexSourceAdapter(opts)` (and likewise for the
other two), where `opts` holds these options:

| Option | `OpenAlexSourceAdapter` | `CrossrefSourceAdapter` | `SemanticScholarSourceAdapter` |
|---|---|---|---|
| `verifiedAt` (required) | the date the API limits were last checked. Runs are refused when it is more than 60 days old. | same | same |
| `ratePerSec` (required) | must be in (0, 100] | must be in (0, 50] | must be in (0, 10] |
| `apiKey` | sent as `Authorization: Bearer` | — | sent as `x-api-key` |
| `mailto` | added as `mailto=` only when there is no `apiKey` | **required**. Sent in the User-Agent and as `mailto=` | — |
| `orOperator` | `" OR "` | `" OR "` | `" \| "` |
| `phraseQuote` | `"` | `"` | `"` |
| `maxPhrasesPerQuery` | 100 | 100 | 100 |
| `perPage` | 50 | 100 | 100 |
| `maxPagesPerQuery` | 20 | 20 | — |
| `maxTotal` | — | — | 1000 (the API caps offsets at 999) |
| `fetchFn` | the `fetch` implementation to use (for tests). The default is the global `fetch`. | same | same |

Filters sent to each source:

| Source | Filters |
|---|---|
| OpenAlex | `type:article`, `has_abstract:true`, the publication-year range and `languages` |
| Crossref | `type:journal-article`, `has-abstract:true`, and `from-pub-date` / `until-pub-date` |
| Semantic Scholar | `year=from-to` |

Only OpenAlex applies `RunFilters.languages`. OpenAlex abstracts are rebuilt from the
inverted index.

### `TokenBucket`

`new TokenBucket({ ratePerSec, burst })` (`TokenBucketOptions`; both values must be > 0).
It has three methods:

- `take()` waits until a token is free, then uses it. The wait timer is unref'd, so it
  does not keep the process alive.
- `setRate(ratePerSec)` changes the rate. Values ≤ 0 are ignored.
- `getRate()` returns the current rate.

---

## Keyword expansion

| Function | Does |
|---|---|
| `expandWildcard(input)` | Expands one pattern into literal phrases. `"exact phrase"` stays as one literal. `(a\|b) x` gives one phrase per alternative. `pre-?registered` gives the phrase with and without the character before `?`. A trailing `*` on a known stem (`replicat*`, `reproduc*`, `attempt*`) gives its word forms; an unknown stem stays literal. |
| `expandSpecKeyword(spec)` | Turns one `KeywordSpec` into `ExpandedKeyword` rows. It uses `template` × `qualifiers` when both are set, and `permutations` otherwise. |
| `expandPermutationList(permutations)` | Expands each item with `expandWildcard` and removes case-insensitive duplicates, keeping the order. |
| `expandUserInput(rawKeywords)` | Expands your own keywords. Each one gets the id `USER_<SLUG>` (at most 32 characters), weight 0.85, and the fields `title` and `abstract`. |
| `expandAll(specKeywords, userKeywords)` | The spec keywords plus the user keywords, with phrase duplicates removed. The spec entry wins a duplicate. |
| `expandedFromEffective(effective)` | The same, for `EffectiveKeyword[]`: wildcard templates saved in a database are expanded here. |
| `loadSpecKeywords(specDir)` | Reads `search-keywords.yaml` and returns `KeywordSpec[]`. |
| `attributeKeywords(title, abstractText, keywords)` | Returns the `{ id, field, permutation }` hits in the title and abstract: case-insensitive, whole-word and literal, with duplicates removed. |

---

## Normalize, exclude, rank

| Function | Does |
|---|---|
| `normalizeCandidate(raw)` | Converts a `RawCandidate` into a `NormalizedCandidate`. The DOI is URL-decoded and lower-cased, the `https://doi.org/` or `doi:` prefix and any trailing `.` or `/` are removed, text fields are trimmed, and `searchScore` starts at 0. |
| `mergeCandidates(a, b)` | Merges two candidates with the same DOI: missing metadata is filled from either side, `matchedKeywords` are combined without duplicates, `searchScore` is the maximum, and `source` is the first one seen. |
| `applyExclusions(text, patterns)` | Returns an `ExclusionResult`: `{ excluded: true, reason: <first matching pattern id> }` or `{ excluded: false }`. |
| `loadExclusionPatterns(specDir)` | Reads `exclusion-patterns.yaml` and returns `ExclusionPattern[]`. |
| `patternsFromEffective(effective)` | Converts `EffectiveExclusion[]` to `ExclusionPattern[]`. |
| `computeSearchScore(candidate, sourcesMatched, weights)` | Adds the title-match weight (or the abstract-match weight when the title does not match), then `multi_keyword_bonus` if there are ≥ 2 distinct keyword ids and `source_diversity_bonus` if there are ≥ 2 sources, and caps the total at `formula.cap`. |
| `loadRankingWeights(specDir)` | Reads `ranking-weights.yaml` and returns `RankingWeights`. |
| `weightsFromEffective(r)` | Converts an `EffectiveRanking` to `RankingWeights`. |

`RankingWeights` is `{ formula: { contributions: { field, weight, condition? }[], cap } }`.
The contribution fields are `title_match`, `abstract_match`, `multi_keyword_bonus` and
`source_diversity_bonus`.

---

## Spec

### Bundled files

`BUNDLED_SPEC_DIR` is the absolute path of the bundled spec directory (`dist/discovery/spec/`).

| File | Read by | Contents |
|---|---|---|
| `search-keywords.yaml` | `loadSpecKeywords` | 26 `KeywordSpec` entries, which expand to 79 phrases. |
| `exclusion-patterns.yaml` | `loadExclusionPatterns` | 4 `ExclusionPattern` regexes. |
| `ranking-weights.yaml` | `loadRankingWeights` | The score formula: title 1.0, abstract 0.5, multi-keyword +0.2, source diversity +0.1, cap 1.0. |
| `source-configs.yaml` | nothing: it is reference only | The endpoints, query syntax and verified rate limits of each API (shape: `SourceConfig`). |

Keyword ids in `search-keywords.yaml`, which appear in `matchedKeywords[].id`:

`REP_OF`, `WE_REPLICATED`, `WE_REPLICATE`, `REPLICATING_FINDINGS`, `DIRECT_REP`,
`CONCEPTUAL_REP`, `PREREGISTERED_REP`, `REGISTERED_REP`, `FAILED_TO_REP`, `DID_NOT_REP`,
`COULD_NOT_REPRODUCE`, `SUCCESSFULLY_REPLICATED`, `REPRODUCIBILITY_OF`,
`REP_AND_EXTENSION`, `REGISTERED_REPLICATION_REPORT`, `REPLICATION_STUDY`,
`REPLICABILITY_OF`, `ATTEMPTED_REPLICATION`, `FAIL_TO_REPLICATE`,
`REPRODUCIBILITY_PROJECT`, `REP_QUALIFIED`, `REPRODUCE_FINDINGS`, `NON_REPLICATION`,
`NO_REPLICATION_OF`, `TEST_REPLICABILITY`, `REPRODUCIBILITY_STUDY`. User keywords get the
id `USER_<SLUG>`.

Exclusion ids in `exclusion-patterns.yaml`, which appear as `excludedByPattern` keys:

| Id | Drops |
|---|---|
| `BIOLOGICAL` | DNA, RNA, viral or cell replication |
| `TECHNICAL_OBJECT` | "replication of the code, data or model" and "data replication" |
| `TECHNICAL_VERB` | "replicated the dataset" and similar |
| `STRUCTURAL` | replication fork, origin, stress or timing |

### Database-resolved spec

`resolveEffectiveSpec(db: SpecDb, override?)` builds an `EffectiveSpec` from three
tables, read through `SpecDb.query(table)`:

| Table | Columns used |
|---|---|
| `discovery_keywords` | `slug`, `phrase`, `permutations`, `weight`, `fields` (default title and abstract), `notes` |
| `discovery_exclusions` | `slug`, `regex`, `flags` (default `i`), `description` |
| `discovery_ranking_config` | the first row: `title_weight`, `abstract_weight`, `multi_keyword_bonus`, `source_diversity_bonus`, `cap`, `min_search_score_threshold` |

Keywords and exclusions are sorted by id and the result is hashed. `source` is
`'defaults'`, or `'override'` when an `override` spec is passed (it is re-sorted and
re-hashed). If the ranking table has no rows, the function throws
`no enabled ranking config row`. Your `query` implementation decides what counts as
"enabled".

- `mergeOverride(defaults, override)` returns `override` when it is set, and `defaults`
  otherwise.
- `canonicalJsonStringify(value)` produces JSON with recursively sorted keys. It accepts
  plain JSON data only, and throws on a top-level `undefined`.
- `hashSpec(value)` returns the lower-case hex SHA-256 of `canonicalJsonStringify(value)`.

---

## Replication classifier

### `classifyReplication(input: ReplicationClassifierInput): ReverseExtractorResult`

This function is deterministic, synchronous and makes no network calls. It combines the
steps below (see the README for the rules).

`ReplicationClassifierInput`:

| Field | Required | Meaning |
|---|---|---|
| `doi` | yes | The DOI of the replication paper. It is copied into the result as `replicationDoi`. |
| `title` | yes | The title. It is used for phrase detection and target extraction. |
| `abstract` | yes | The abstract. It is used for phrase detection, target extraction and the outcome. |
| `referencedWorks` | yes | The paper's reference list (the element shape of `OpenAlexWork.referencedWorks`). Only `firstAuthor` and `year` take part in matching. |
| `authors` | no | Copied into each finding. |
| `venue` | no | Copied into each finding. |
| `year` | no | Copied into each finding. |

| Step | Export | Returns |
|---|---|---|
| Detect | `hasReplicationPhrase(text)` | `boolean`. It is `false` for non-scholarly contexts. |
| Detect | `findReplicationPhrase(text)` | the first matching phrase in lower case, or `null` |
| Extract | `extractTargets(text)` | `ExtractedTarget[]`, with duplicates removed by surname and year |
| Resolve | `resolveTarget(target, refs)` | a `ResolvedTarget` (same surname token, year ±1, the closest year wins) |
| Outcome | `classifyOutcome(text)` | `{ outcome, phrase, sentence }`, where `outcome` is a `ReplicationOutcome` |
| Confidence | `scoreConfidence(s: ConfidenceSignals)` | a `ReplicationConfidence` |

`ConfidenceSignals` has the fields `fredHit`, `fredFuzzyHit`, `backRefConfirmed`,
`phraseInTitle`, `phraseInAbstract` and `ambiguous`, which give these ratings:

| Signals | Rating |
|---|---|
| `fredHit` without `ambiguous` | `high` |
| `backRefConfirmed` and `phraseInTitle` | `high` (`medium` if `ambiguous`) |
| `backRefConfirmed` and `phraseInAbstract` | `medium` |
| `fredFuzzyHit`, or `fredHit` with `ambiguous` | `medium` |
| anything else | `low` |

`classifyReplication` sets only the back-reference and phrase signals. The two FReD
signals exist for callers that look papers up in an external replication database
themselves.

`ReplicationOutcome` is `successful`, `failed`, `mixed` or `unknown`.
`ReplicationConfidence` is `high`, `medium` or `low`.

---

## Metadata resolution

### `resolveWork(doi, providers?, creds?)` / `resolveWorkDetailed(doi, providers?, creds?)`

These functions query every provider in parallel. The default provider list is
`DEFAULT_METADATA_PROVIDERS`: OpenAlex, Crossref, DataCite, doi.org, Semantic Scholar and
OpenCitations.

The results are merged field by field. The first provider in list order that has a
non-empty value supplies each field. References are combined and de-duplicated by DOI. Each
field records which providers supplied it in `fieldProvenance`.

`resolveWork` returns a `ResolvedWork`, or `null` when no provider found the work.
`resolveWorkDetailed` returns a `WorkMetadataLookup`: `{ work, sourcesQueried,
providerReports }`. Use it when you need to tell "not found" apart from "rate limited".

`MetadataCredentials` (every field is optional):

| Field | Used by |
|---|---|
| `openAlexApiKey` | OpenAlex (`api_key=`). Without it, OpenAlex gets `mailto=` instead. |
| `openAlexMailto` | the contact address for OpenAlex, Crossref and OpenCitations. It falls back to `DEFAULT_POLITE_MAILTO`. |
| `semanticScholarApiKey` | Semantic Scholar (`x-api-key`) |
| `openCitationsBaseUrl` | the OpenCitations host (the default is `https://opencitations.net`) |
| `openCitationsAccessToken` | the OpenCitations `authorization` header |

DataCite and doi.org use no credentials.

`MetadataProvider` is `{ name: MetadataProviderName, getWork(doi, creds?) }`, where
`getWork` returns a `MetadataProviderResult` (`{ provider, report, work }`). You can pass
your own list of providers. `MetadataWork` is an alias of `OpenAlexWork`.

`MetadataProviderName` is one of `openalex`, `crossref`, `datacite`, `doi.org`,
`semantic-scholar` or `opencitations`. `MetadataProviderReport` is
`{ provider, status, message? }`, where `status` (`MetadataProviderStatus`) is one of:

| Status | Meaning |
|---|---|
| `found` | The work has metadata and references. |
| `not_found` | HTTP 404, or no record. |
| `rate_limited` | HTTP 429. |
| `provider_error` | Any other failure. The reason is in `message`. |
| `sparse_metadata` | There is no title, authors, year, venue or abstract. |
| `missing_references` | There is metadata but the reference list is empty. |

The OpenAlex and OpenCitations providers truncate reference lists longer than 400
entries to 400, with a `console.warn`.

### OpenAlex client

- `getWork(doi, creds?)` returns an `OpenAlexWork` with the details of each reference, or
  `null` on a 404. It throws on other errors.
- `getCitingWorks(doi, maxResults = 50, creds?)` does a forward lookup: it finds the works
  that cite `doi` and match `replication`. It returns a `CitingWorksResult` with the
  fields `targetWorkId`, `targetTitle`, `targetAuthors`, `targetVenue`,
  `targetFirstAuthor`, `targetYear` and `candidates`. Each `CitingCandidate` has an
  `openalexId`, `doi`, `title`, `abstract` and `referencedWorkIds` (raw OpenAlex ids, so
  you can check the back-reference yourself).

### `resolveAuthorYearViaCrossref(mention, options?)`

A fallback for when the reference list cannot confirm a target. It searches Crossref for
an `AuthorYearMention` (`author`, `year`, plus the optional `sentence` and
`replicationTitle`). The options are `{ signal?: AbortSignal, mailto?: string }`. Calls are
throttled to 1.5 requests per second for the whole module.

Each of the top five results is scored:

| Rule | Score |
|---|---|
| Exact first-author surname | +3 |
| Partial first-author surname | +1 |
| Exact year | +2 |
| Year ±1 | +0.5 |
| Title-keyword overlap ≥ 0.2 | +2 |
| Title-keyword overlap ≥ 0.1 | +1 |
| The result's own title looks like a replication | −1 |

It never invents a DOI. It returns a `CrossrefAuthorYearResolution`:
`{ matched, doi, score, runnerUpScore, candidates, reason }`. `reason` is an
`AuthorYearResolutionReason`:

| `reason` | Meaning |
|---|---|
| `confident-match` | The top score is ≥ 5 and leads the runner-up by at least 1. |
| `below-threshold` | The top score is below 5. |
| `ambiguous` | The top two scores are less than 1 apart. |
| `no-candidates` | Crossref returned no results. |
| `provider-error` | The request failed. |

Each `CrossrefAuthorYearCandidate` has the fields `doi`, `title`, `firstAuthor`, `year`,
`container`, `score` and `reasons`.

### Helpers

| Function | Does |
|---|---|
| `normalizeDoi(doi)` | URL-decodes and lower-cases the DOI, strips a `https://doi.org/`, `dx.doi.org` or `doi:` prefix, and strips trailing `.` or `/`. |
| `cleanDoi(doi)` | Runs `normalizeDoi`, returning `null` for empty input. |
| `emptyWork(doi)` | Returns a blank `MetadataWork`. |
| `providerResult(provider, status, work, message?)` | Builds a `MetadataProviderResult`. |
| `axiosErrorReport(provider, err)` | Maps an HTTP error to a `MetadataProviderReport`: 404 to `not_found`, 429 to `rate_limited`, and anything else to `provider_error`. |
| `resultFromError(provider, err)` | Returns the same report, with `work: null`. |
| `statusForWork(work)` | Returns `found`, `sparse_metadata` or `missing_references`. |
| `datePartsYear(parts)` | Returns the year from Crossref-style `date-parts`, or `null`. |
| `stripHtml(value)` | Removes tags and collapses whitespace. |
| `authorList(names)` | Joins the non-empty names with `, `. |
| `firstAuthor(authors)` | Returns the last token of the first comma-separated author. |

`DEFAULT_POLITE_MAILTO` is the built-in contact address used when you pass none.

---

## Output shapes

### `ReverseExtractorResult`

`{ replicationDoi, isReplication, targets: ReplicationFinding[] }`. `isReplication: true`
with an empty `targets` list means that a replication phrase was found but no target was
confirmed.

### `ReplicationFinding`

| Field | Meaning |
|---|---|
| `originalDoi` | The DOI of the confirmed original study, taken from the reference list. |
| `originalTitle`, `originalAuthors`, `originalVenue`, `originalYear` | The original's metadata from the reference entry. Empty or `null` when it is unknown. |
| `replicationDoi` | Optional; `classifyReplication` does not set it. The paper's DOI is `ReverseExtractorResult.replicationDoi`. |
| `replicationTitle`, `replicationAuthors`, `replicationVenue`, `replicationYear` | Copied from the input. |
| `originalReferenceExtracted` | The citation as extracted, for example `Smith et al. (2010)`. |
| `justificationPhrase` | The sentence the citation was extracted from. |
| `outcomePhrase` | The sentence that set the outcome. Empty for `unknown`. |
| `outcome` | A `ReplicationOutcome`. |
| `confidence` | A `ReplicationConfidence`. `low` is never emitted. |
| `evidence` | The distinct non-empty sentences: the justification and the outcome. |
| `signalProvenance` | Tags explaining the verdict: `back-ref-confirmed`, `reference-<provider>`, `phrase-in-title`, `phrase-in-abstract`, `ambiguous-target` and `outcome-phrase-extracted`. |
| `ambiguous` | `true` when more than one reference matched. Otherwise the field is absent. |

### Classifier intermediate types

- `ExtractedTarget`: `{ authorYearString, firstAuthorLastName, year, sentence }`.
- `ResolvedTarget`: `{ extracted, originalDoi, ambiguous, matchCount }`.

### `OpenAlexWork` / `ResolvedWork`

`OpenAlexWork` has the fields `doi`, `title`, `authors` (comma-joined), `venue`, `year`,
`abstract` and `referencedWorks`. Each reference is `{ openalexId, doi, title?, authors?,
venue?, firstAuthor?, year?, source? }`, where `source` is the `MetadataProviderName` that
supplied it.

`ResolvedWork` adds `sourcesQueried`, `providerReports` and `fieldProvenance`
(`FieldProvenance`). `fieldProvenance` maps each of `doi`, `title`, `authors`, `venue`,
`year`, `abstract` and `referencedWorks` to the providers that supplied it.

### `DiscoveryStats`

| Field | Meaning |
|---|---|
| `totalTasks`, `completedTasks` | There is one task per source. |
| `candidatesSeen` | The raw candidates returned by the sources. |
| `candidatesKeptAfterExclusion` | The candidates that passed the exclusion regexes. |
| `excludedByPattern` | The number of candidates dropped by each exclusion id. |
| `candidatesDroppedByThreshold` | The candidates below `min_search_score_threshold`. |
| `candidatesClassified`, `classifierAccepted`, `classifierAmbiguous`, `classifierNeedsMetadata`, `classifierRejected` | The classifier tallies. `errored` is not counted separately. |
| `floraKnown` | Always 0: nothing in this library sets it. |
| `errorsPerSource`, `apiCallsPerSource` | Counters for each `SourceId`. **Check `errorsPerSource` before you trust a `completed` run.** |
| `currentTask` | `{ tid, source, keyword, field, page }` of the last page processed. |
| `startedAt` | An ISO timestamp. |
| `estimatedRemainingSeconds` | Declared but never set. |

`DiscoveryProgress` is `{ tasks: DiscoveryTask[], currentTid, pageCountPerTid }`. A
`DiscoveryTask` is `{ tid, source, kid, perm, field, cursor, done }`, where `kid` is
`__bundle__` because one task covers all the keywords, and `cursor` is the resume point.

---

## Discovery data types

- **`SourceId`:** `openalex`, `crossref` and `semantic_scholar` have adapters here.
  `bob_reed`, `i4r` and `fred_data` are reserved ids with no adapter.
- **`SearchField`:** `title`, `abstract` or `default`.
- **`KeywordSpec`:** `{ id, phrase?, template?, qualifiers?, permutations?, weight, fields,
  notes? }`. A `template` such as `{qualifier} replication` is combined with each of the
  `qualifiers`.
- **`ExpandedKeyword`:** `{ id, permutation, weight, fields }`.
- **`ExclusionPattern`:** `{ id, regex, flags?, description? }`, where `flags` is a
  JavaScript regex flag list such as `["i"]`.
- **`DiscoveryRunConfig`:** `{ specVersion, keywords, filters }`. `specVersion` is not read
  by `runDiscovery`.
- **`RunFilters`:**

  | Field | Status |
  |---|---|
  | `yearFrom`, `yearTo` | Sent to all three sources. |
  | `languages` | ISO 639-1 codes, used by OpenAlex only. |
  | `sources` | The sources to run. |
  | `maxCandidatesPerSource`, `skipDoisInFlora` | Declared but not read by `runDiscovery`. |

- **`CandidateAuthor`:** `{ name, orcid? }`.
- **`RawCandidate`:** one search hit, as an adapter yields it:

  ```ts
  { source, sourceRecordId?, doi, title?, abstract?, year?, authors?, journal?, url?,
    language?, matchedKeyword: { id, field, permutation } }
  ```

  `sourceRecordId` is the source's own id (an OpenAlex W-id, a Crossref DOI or a Semantic
  Scholar paper id). `language` is filled in by OpenAlex and Crossref only.
- **`NormalizedCandidate`:** the same fields as `RawCandidate`, with `matchedKeywords[]`
  in place of `matchedKeyword`, plus `searchScore`.
- **`CandidateRecord`:** a `NormalizedCandidate` plus `runId`, `discoveredAt`,
  `classifierStatus`, `classifierResult?`, `classifierProcessedAt?` and `floraStatus`.
  It is a suggested row shape for persistence and is not produced by the library.
- **`FloraStatus`:** `not_in_flora`, `flora_known_replication`, `flora_known_original` or
  `flora_match_pending`. The library does not set it.
- **`EffectiveSpec`:** `{ keywords, exclusions, ranking, hash, resolvedAt, source }`, where
  `source` is `defaults` or `override`. Its parts are:
  - `EffectiveKeyword`: `{ id, phrase, permutations, weight, fields, notes? }`.
  - `EffectiveExclusion`: `{ id, regex, flags, description }`.
  - `EffectiveRanking`: `{ title_weight, abstract_weight, multi_keyword_bonus,
    source_diversity_bonus, cap, min_search_score_threshold }`.
- **`SourceConfig` / `SourceRateLimit`:** the shape of one entry in `source-configs.yaml`:
  - `SourceConfig`: `base_url`, `works_endpoint`, `auth`, `rate_limit`, `query_template`,
    `pagination` and `filters`.
  - `SourceRateLimit`: `verified_at`, `requests_per_second` and `requests_per_day`.
