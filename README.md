# repliscan

Replication-study discovery for academic papers: multi-source candidate search
(OpenAlex, Crossref, Semantic Scholar), deterministic keyword expansion,
candidate normalization / ranking / exclusion, a multi-provider metadata
resolver, and a deterministic rule-based replication classifier.

Pure logic + HTTP clients — no database, no app framework. Credentials (API
keys, polite-pool mailto) are passed in as parameters; the library never reads
environment variables. Persistence is injected via a `RunPersistence` interface.

Extracted from the CitationGuard platform so the community can validate and
reuse it. Status: 0.1.0, behavior-preserving extraction; accuracy iteration is
ongoing.

## API

- `runDiscovery(args)` — drive one discovery run end-to-end over injected source adapters
- `OpenAlexSourceAdapter` / `CrossrefSourceAdapter` / `SemanticScholarSourceAdapter` — per-source search adapters
- `classifyReplication(input)` — deterministic rule-based replication classifier
- `resolveWork(doi, creds?)` / `resolveWorkDetailed(doi, creds?)` — multi-provider metadata resolver
- `resolveAuthorYearViaCrossref(mention, opts?)` — Crossref author-year fallback resolver
- Keyword / exclusion / ranking helpers, the `SpecDb` + `RunPersistence` seams, and all pipeline types
