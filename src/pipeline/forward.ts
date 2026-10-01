import type { ReplicationFinding, ReplicationOutcome } from '../classifier/types.js';
import type { MetadataCredentials } from '../metadata/credentials.js';
import { getCitingWorks } from '../metadata/openAlexClient.js';
import { classifyReplication } from '../classifier/classifier.js';
import { resolveWorkDetailed } from '../metadata/metadataResolver.js';
import { normalizeLookupDoi as normalizeDoi } from '../util/lookupDoi.js';
import type { CachePort } from './ports.js';

/**
 * 2026-05-07: candidate metadata enrichment via the multi-provider resolver.
 *
 * The plugin previously classified candidates using only the OpenAlex
 * `cited-by` payload. When OpenAlex's abstract was empty/short (~30% of
 * cases per ad-hoc audit), the classifier had nothing to work with and
 * returned 'low' confidence → the finding was dropped at the high/medium
 * filter, costing real recall.
 *
 * `resolveWorkDetailed` queries OpenAlex + Crossref + S2 + DataCite +
 * doi.org + OpenCitations and merges the richest fields. Same code path
 * the Lookup / Extraction Runs surface uses. We only invoke it when the
 * OpenAlex abstract is short (cheap heuristic) to keep cost bounded —
 * MAX_CANDIDATES (20) per reference is the upper bound on enrichment
 * calls.
 */
const ENRICHMENT_ABSTRACT_THRESHOLD = 200;
const ENRICHMENT_TIMEOUT_MS = 4000;

async function enrichCandidateMetadata(cand: { doi: string | null; title: string; abstract: string }, creds: MetadataCredentials | undefined): Promise<{ title: string; abstract: string }> {
  if (!cand.doi) return { title: cand.title, abstract: cand.abstract };
  if ((cand.abstract?.length ?? 0) >= ENRICHMENT_ABSTRACT_THRESHOLD) {
    return { title: cand.title, abstract: cand.abstract };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const enriched = await Promise.race([
      resolveWorkDetailed(cand.doi, undefined, creds),
      new Promise<null>(resolve => {
        timeoutHandle = setTimeout(() => resolve(null), ENRICHMENT_TIMEOUT_MS);
        // Don't let the losing race timer linger after the resolver wins — an
        // uncleared 4s timer leaks past test teardown (Jest force-exit) and keeps
        // the event loop busy in production.
        timeoutHandle.unref?.();
      }),
    ]);
    if (!enriched?.work) return { title: cand.title, abstract: cand.abstract };
    return {
      title: enriched.work.title || cand.title,
      abstract: enriched.work.abstract || cand.abstract,
    };
  } catch {
    return { title: cand.title, abstract: cand.abstract };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Options for `findReplicationsForDoi`. */
export interface ForwardOptions {
  floraHit?: any | null;
  targetTitle?: string;
  targetAuthors?: string;
  targetVenue?: string;
  targetFirstAuthor?: string;
  targetYear?: number;
  /**
   * Cancellation signal from the per-plugin AbortController. When aborted,
   * we short-circuit before kicking off the candidate enrichment fan-out
   * (the expensive part). Doesn't interrupt an in-flight `getCitingWorks`
   * call, but stops us from doing more work after the timeout fires.
   */
  signal?: AbortSignal;
  /** Result cache. When omitted, nothing is read from or written to a cache. */
  cache?: CachePort;
  /** Credentials for the metadata providers (API keys, polite-pool contact email). */
  credentials?: MetadataCredentials;
}

export interface ForwardResult {
  originalDoi: string;
  targets: ReplicationFinding[];
}

const MAX_CANDIDATES = 20;
const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;

/** Turn a FReD hit (from `checkFloraReplications`) into replication findings. */
export function floraHitToFindings(floraHit: any, originalDoi: string): ReplicationFinding[] {
  const details = floraHit?.metadata?.replicationDetails ?? floraHit?.replicationDetails ?? [];
  return details.map((d: any) => {
    const outcome: ReplicationOutcome =
      d.outcomeType === 'partial' ? 'mixed'
      : d.outcomeType === 'failed' ? 'failed'
      : d.outcomeType === 'successful' ? 'successful'
      : 'unknown';
    return {
      originalDoi,
      replicationDoi: d.doi,
      originalTitle: floraHit?.metadata?.title || floraHit?.title || '',
      originalAuthors: floraHit?.metadata?.authors || floraHit?.authors || '',
      originalVenue: floraHit?.metadata?.journal || floraHit?.journal || '',
      originalYear: floraHit?.metadata?.year ?? floraHit?.year ?? null,
      replicationTitle: d.title || '',
      replicationAuthors: d.authors || '',
      replicationVenue: d.journal || '',
      replicationYear: d.year ?? null,
      originalReferenceExtracted: floraHit?.metadata?.title || floraHit?.title || '',
      justificationPhrase: d.title || '',
      outcomePhrase: d.outcomeQuote || '',
      outcome,
      confidence: 'high' as const,
      evidence: d.outcomeQuote ? [d.outcomeQuote] : [],
      signalProvenance: ['fred'],
    };
  });
}

/**
 * Find the replications of the paper `doi`: the curated FReD hit (`opts.floraHit`, looked up by
 * the caller) merged with replications discovered through the citation graph, each confirmed by a
 * back-reference to the target and classified by `classifyReplication`.
 */
export async function findReplicationsForDoi(
  doi: string,
  opts: ForwardOptions = {}
): Promise<ForwardResult> {
  const norm = normalizeDoi(doi);
  if (!norm || !DOI_PATTERN.test(norm)) return { originalDoi: doi, targets: [] };

  const cached = await opts.cache?.get(norm, 'forward');
  if (cached) return cached as ForwardResult;

  const findings: ReplicationFinding[] = [];

  if (opts.floraHit) {
    findings.push(...floraHitToFindings(opts.floraHit, norm));
  }

  const {
    targetWorkId,
    targetTitle,
    targetAuthors,
    targetVenue,
    targetFirstAuthor,
    targetYear,
    candidates,
  } = await getCitingWorks(norm, 50, opts.credentials);

  if (opts.signal?.aborted) {
    return { originalDoi: doi, targets: findings };
  }

  if (targetWorkId) {
    // Back-ref gate: candidate's raw referenced_works IDs must include target's W-id.
    // Untruncated, O(1) set check — no per-candidate HTTP call needed.
    const backRefConfirmed = candidates.filter(c => c.referencedWorkIds.includes(targetWorkId));

    // Author/year for extraction matching: prefer caller-provided, fall back to
    // OpenAlex-authoritative metadata fetched alongside the target.
    const firstAuthor = opts.targetFirstAuthor || targetFirstAuthor;
    const year = opts.targetYear || targetYear;
    const syntheticRef = firstAuthor && year
      ? [{
          openalexId: targetWorkId,
          doi: norm,
          title: opts.targetTitle || targetTitle,
          authors: opts.targetAuthors || targetAuthors,
          venue: opts.targetVenue || targetVenue,
          firstAuthor,
          year,
        }]
      : [];

    // Enrich + classify candidates in parallel. Each enrichment is an
    // independent multi-provider fetch (≤4s timeout, see ENRICHMENT_TIMEOUT_MS)
    // and classifyReplication is pure local CPU. Previously serial — on a
    // reference with 20 thin-abstract candidates the worst case was 20×4s = 80s
    // just on enrichment, multiplied by every reference in the doc. Now bounded
    // by the slowest single candidate, ~4s.
    const candsToEnrich = backRefConfirmed.slice(0, MAX_CANDIDATES).filter(c => !!c.doi);
    const candResults = await Promise.all(
      candsToEnrich.map(async cand => {
        const enriched = await enrichCandidateMetadata(cand, opts.credentials);
        const result = classifyReplication({
          doi: cand.doi!,
          title: enriched.title,
          abstract: enriched.abstract,
          referencedWorks: syntheticRef,
        });
        return { cand, enriched, result };
      })
    );
    for (const { cand, enriched, result } of candResults) {
      for (const t of result.targets) {
        if (t.originalDoi === norm && (t.confidence === 'high' || t.confidence === 'medium')) {
          // Tag enrichment in signal provenance so admins can see whether
          // the multi-provider path contributed to this finding.
          const enrichedProvenance = enriched.abstract !== cand.abstract
            ? Array.from(new Set([...(t.signalProvenance ?? []), 'metadata-enriched']))
            : t.signalProvenance;
          findings.push({ ...t, replicationDoi: cand.doi!, signalProvenance: enrichedProvenance });
        }
      }
    }
  }

  const merged = dedupFindings(findings);
  const out: ForwardResult = { originalDoi: norm, targets: merged };
  await opts.cache?.put(norm, 'forward', out);
  return out;
}

const CONFIDENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
// Ranked most-to-least cautious so a merge is deterministic AND conservative:
// 'mixed' (partial replication) must never be silently upgraded to 'successful'
// when two findings for the same DOI are merged. The old successful:2 tied with
// mixed:2, so the merged label depended on iteration order — a paper with mixed
// evidence could surface to the user as a clean "successful" replication (D8).
const OUTCOME_RANK: Record<string, number> = { failed: 3, mixed: 2, successful: 1, unknown: 0 };

/**
 * Merge findings that target the same replication DOI. When two signals agree,
 * that's evidence of corroboration — union the signal provenance so the UI can
 * show "confirmed by FReD + OpenAlex citation-graph". Keep the strongest
 * confidence and the most specific outcome.
 */
export function dedupFindings(findings: ReplicationFinding[]): ReplicationFinding[] {
  const byDoi = new Map<string, ReplicationFinding>();
  const noDoi: ReplicationFinding[] = [];

  for (const f of findings) {
    const key = f.replicationDoi;
    if (!key || key === 'na') { noDoi.push(f); continue; }
    const prev = byDoi.get(key);
    if (!prev) { byDoi.set(key, f); continue; }

    const better = (CONFIDENCE_RANK[f.confidence] ?? 0) > (CONFIDENCE_RANK[prev.confidence] ?? 0) ? f : prev;
    const weaker = better === f ? prev : f;
    const outcome = (OUTCOME_RANK[f.outcome] ?? 0) >= (OUTCOME_RANK[prev.outcome] ?? 0) ? f.outcome : prev.outcome;
    const outcomePhrase = f.outcome === outcome && f.outcomePhrase ? f.outcomePhrase
                        : prev.outcome === outcome && prev.outcomePhrase ? prev.outcomePhrase
                        : better.outcomePhrase || weaker.outcomePhrase;

    const mergedProvenance = Array.from(new Set([...(prev.signalProvenance || []), ...(f.signalProvenance || [])]));
    const mergedEvidence = Array.from(new Set([...(prev.evidence || []), ...(f.evidence || [])].filter(Boolean)));

    byDoi.set(key, {
      ...better,
      outcome,
      outcomePhrase,
      justificationPhrase: better.justificationPhrase || weaker.justificationPhrase,
      signalProvenance: mergedProvenance,
      evidence: mergedEvidence,
    });
  }

  return [...byDoi.values(), ...noDoi];
}
