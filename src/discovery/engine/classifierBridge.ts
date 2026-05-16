/**
 * Classifier bridge — wraps the existing deterministic classifier so the
 * discovery runner can use it without depending on its internals.
 *
 * For each candidate the bridge:
 *   1. Fetches full metadata (incl. referencedWorks) via the existing
 *      metadataResolver — leverages the 7-day replication_cache so re-runs
 *      are free.
 *   2. Builds a ReplicationClassifierInput.
 *   3. Calls classifyReplication.
 *   4. Maps the result to a ClassifierStatus suitable for replication_candidates.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §3
 */

import { classifyReplication } from '../../classifier/classifier.js';
import { resolveWork } from '../../metadata/metadataResolver.js';
import type {
  ReplicationClassifierInput,
  ReverseExtractorResult,
} from '../../classifier/types.js';
import type { ClassifierStatus, NormalizedCandidate } from '../types.js';

export interface ClassifierVerdict {
  status: ClassifierStatus;
  result: ReverseExtractorResult | null;
}

export interface ClassifierBridgeDeps {
  /** Override resolveWork for testing. Defaults to the metadataResolver implementation. */
  resolveWorkFn?: typeof resolveWork;
  /** Override classifyReplication for testing. Defaults to the canonical classifier. */
  classifyFn?: typeof classifyReplication;
}

/**
 * Run the classifier on a single discovered candidate.
 *
 * Returns a ClassifierVerdict whose `status` is one of:
 *   - 'rejected'           — classifier says not a replication
 *   - 'needs_more_metadata' — phrase detected but no resolvable target,
 *                             OR resolveWork returned null (DOI not found),
 *                             OR title+abstract empty
 *   - 'accepted'           — at least one unambiguous target found, no ambiguous targets
 *   - 'ambiguous'          — at least one target is ambiguous (multi-match)
 *   - 'errored'            — exception thrown (logged, candidate retained for retry)
 */
export async function classifyCandidate(
  candidate: NormalizedCandidate,
  deps: ClassifierBridgeDeps = {},
): Promise<ClassifierVerdict> {
  if (!candidate.title?.trim() && !candidate.abstract?.trim()) {
    return { status: 'needs_more_metadata', result: null };
  }

  const resolveFn = deps.resolveWorkFn ?? resolveWork;
  const classifyImpl = deps.classifyFn ?? classifyReplication;

  let referencedWorks: ReplicationClassifierInput['referencedWorks'] = [];
  let resolvedTitle = candidate.title ?? '';
  let resolvedAbstract = candidate.abstract ?? '';
  let resolvedAuthors = (candidate.authors ?? []).map((a) => a.name).join('; ');
  let resolvedVenue = candidate.journal ?? '';
  let resolvedYear: number | null = candidate.year ?? null;

  try {
    const work = await resolveFn(candidate.doi);
    if (!work) {
      return { status: 'needs_more_metadata', result: null };
    }
    referencedWorks = work.referencedWorks ?? [];
    // Prefer resolved metadata when richer than the search-time snapshot.
    resolvedTitle = work.title || resolvedTitle;
    resolvedAbstract = work.abstract || resolvedAbstract;
    resolvedAuthors = work.authors || resolvedAuthors;
    resolvedVenue = work.venue || resolvedVenue;
    resolvedYear = work.year ?? resolvedYear;
  } catch {
    // Metadata resolver failure shouldn't crash the run; treat as missing references
    // and let the classifier fall through to needs_more_metadata.
    referencedWorks = [];
  }

  const input: ReplicationClassifierInput = {
    doi: candidate.doi,
    title: resolvedTitle,
    authors: resolvedAuthors,
    venue: resolvedVenue,
    year: resolvedYear,
    abstract: resolvedAbstract,
    referencedWorks,
  };

  let result: ReverseExtractorResult;
  try {
    result = classifyImpl(input);
  } catch {
    return { status: 'errored', result: null };
  }

  if (!result.isReplication) return { status: 'rejected', result };
  if (result.targets.length === 0) return { status: 'needs_more_metadata', result };
  const anyAmbiguous = result.targets.some((t) => t.ambiguous === true);
  return { status: anyAmbiguous ? 'ambiguous' : 'accepted', result };
}
