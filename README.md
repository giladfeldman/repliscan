# repliscan

Replication-study discovery for academic papers: multi-source candidate search
(OpenAlex, Crossref, Semantic Scholar), deterministic keyword expansion,
candidate normalization / ranking / exclusion, a multi-provider metadata
resolver, and a deterministic rule-based replication classifier.

Pure logic + HTTP clients — no database, no app framework. Credentials (API
keys, polite-pool mailto) are passed in as parameters; the library never reads
environment variables. Persistence is injected via a `RunPersistence` interface.

Extracted from the CitationGuard platform so the community can validate and
reuse it. Accuracy iteration is ongoing — see [CHANGELOG.md](./CHANGELOG.md) and
the [release tags](https://github.com/giladfeldman/repliscan/tags) for the
current version. (No version is quoted here on purpose; a hardcoded one goes
stale silently.)

## Install

**Distributed as a git-tag dependency, not via npm.** This package is
deliberately not published to the npm registry. Pin a tag directly:

```jsonc
// package.json
"dependencies": {
  "repliscan": "github:giladfeldman/repliscan#v0.1.1"
}
```

npm clones the repo and runs the `prepare` script, which builds `dist/` — a tag
pin installs a working build with no registry involved. The `files` field in
`package.json` is standard packaging metadata kept ready for a possible future
publish; it has no effect on the git-tag install path.

Always pin an explicit tag. A bare `github:giladfeldman/repliscan` floats on the
default branch, so upstream changes land in your build silently.

## API

- `runDiscovery(args)` — drive one discovery run end-to-end over injected source adapters
- `OpenAlexSourceAdapter` / `CrossrefSourceAdapter` / `SemanticScholarSourceAdapter` — per-source search adapters
- `classifyReplication(input)` — deterministic rule-based replication classifier
- `resolveWork(doi, creds?)` / `resolveWorkDetailed(doi, creds?)` — multi-provider metadata resolver
- `resolveAuthorYearViaCrossref(mention, opts?)` — Crossref author-year fallback resolver
- Keyword / exclusion / ranking helpers, the `SpecDb` + `RunPersistence` seams, and all pipeline types
