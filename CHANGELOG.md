# Changelog

## 0.1.1 — 2026-06-08

Deterministic-classifier hardening (via `citationguard-iterate`). Five fixes to
the offline replication classifier + discovery normalizer, with fails-before /
passes-after regression tests. Suite 167 → 176.

### Fixed
- **False "failed" across sentence boundaries (D2).** The effect-size-collapse
  regex used `[\s\S]{0,220}`, which spanned sentences — "…d = 0.50. Separately,
  d = 0.02." was read as a collapse and labelled a failed replication. Now
  `[^.!?]` keeps the original-vs-replication comparison within one sentence.
- **Sentence split corrupted "Author et al. (year)" (D1).** `splitSentences`
  split on "(", producing an orphan "(year) …" fragment and mangling the
  within-sentence context used for negation detection. Now mirrors
  `targetExtraction.splitSentences` (uppercase-letter lookahead only).
- **Missed replications for prefix surnames (D5).** `resolveTarget` compared the
  full reference `firstAuthor` ("de Groot") against the prefix-stripped extracted
  name ("Groot"), so nobiliary-prefix surnames never matched. Now compares the
  final name token on both sides ("de Groot"/"van den Berg" resolve).
- **DOI dedup divergence (D4).** `candidateNormalizer.normalizeDoi` skipped
  URL-decoding and trailing-dot stripping, so a URL-encoded ("10.1234%2Fabc") or
  trailing-dot ("10.1234/abc.") candidate did not dedup against its clean
  resolved form. Now decodes and strips trailing "."/"/" (space-tolerant "doi: "
  handling preserved).
- **Rate-limiter kept the process alive (D7).** `TokenBucket.take()` scheduled a
  backoff `setTimeout` without `.unref()`, so a pending timer blocked clean
  shutdown (and Jest force-exited). The timer is now unref'd; the await still
  resolves on schedule.

### Notes (triaged, intentionally unchanged)
- `classifierBridge` bare `catch` blocks: line-78 metadata-resolver failure is a
  documented intentional fallback; the classifier `catch` returns an observable
  `'errored'` status. Proper logging needs injected-logger plumbing (out of
  scope); a library should not `console.warn`.
- `runner.ts` `sourcesMatched` diversity bonus is a uniform +0.1 on every
  candidate, so it does not affect ranking (cosmetic/misleading-doc only).
- `isNegated` window: the `\s+$` anchor only inspects the immediately preceding
  word, so widening the window does not catch structurally-distant negation —
  left unchanged.
- `util/normalizeDoi.ts` is a verbatim copy of the worker's `floraLookup.ts`
  ("do not let them diverge") — untouched.

## 0.1.0

- Initial behavior-preserving extraction from the CitationGuard platform.
