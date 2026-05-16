// Public API barrel — populated as modules are moved in (Tasks 2-14).
export * from './discovery/types.js';
export * from './classifier/types.js';
export * from './classifier/phraseDetection.js';
export * from './classifier/targetExtraction.js';
export * from './classifier/targetResolution.js';
export * from './classifier/outcomeClassification.js';
export * from './classifier/confidence.js';
export * from './classifier/classifier.js';
export * from './discovery/engine/keywordExpander.js';
// candidateNormalizer also defines a local normalizeDoi (simpler, for internal candidate use).
// Only normalizeCandidate + mergeCandidates are barrel-exported from it; the authoritative
// public normalizeDoi comes from util/normalizeDoi (full-featured, floraLookup-parity).
export { normalizeCandidate, mergeCandidates } from './discovery/engine/candidateNormalizer.js';
export * from './discovery/engine/candidateRanker.js';
export * from './discovery/engine/exclusionFilter.js';
export * from './discovery/spec/canonical.js';
export * from './discovery/spec/loader.js';
export * from './discovery/engine/sources/sourceAdapter.js';
export * from './discovery/engine/sources/tokenBucket.js';
export * from './util/normalizeDoi.js';
export * from './discovery/engine/sources/openAlexSearch.js';
export * from './discovery/engine/sources/crossrefSearch.js';
export * from './discovery/engine/sources/semanticScholarSearch.js';
export * from './metadata/credentials.js';
export * from './metadata/types.js';
export * from './metadata/common.js';
export * from './metadata/openAlexClient.js';
export * from './metadata/metadataResolver.js';
export * from './metadata/crossrefAuthorYearResolver.js';
export * from './discovery/engine/classifierBridge.js';
export * from './discovery/engine/runPersistence.js';
export * from './discovery/engine/runner.js';
