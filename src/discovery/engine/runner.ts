/**
 * runDiscovery — orchestrates one Discover run end-to-end.
 *
 * With OR-bundling (per source-configs.yaml), one task = one source. The
 * runner streams pages from each source's adapter, normalizes + excludes +
 * dedup-merges within a page, writes to DB or file, optionally classifies,
 * and checkpoints after every page.
 *
 * Honors pause/cancel signals between API calls so an in-flight HTTP request
 * always finishes cleanly (matches checkpointStore's transactional model —
 * one page = one safely resumable unit).
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §4
 */

import type {
  DiscoveryProgress,
  DiscoveryRunConfig,
  DiscoveryStats,
  DiscoveryTask,
  ExpandedKeyword,
  NormalizedCandidate,
  SourceId,
} from '../types.js';
import { applyExclusions, loadExclusionPatterns, patternsFromEffective } from './exclusionFilter.js';
import { computeSearchScore, loadRankingWeights, weightsFromEffective, type RankingWeights } from './candidateRanker.js';
import {
  mergeCandidates,
  normalizeCandidate,
} from './candidateNormalizer.js';
import { attributeKeywords, expandAll, expandedFromEffective, expandUserInput, loadSpecKeywords } from './keywordExpander.js';
import type { EffectiveSpec } from '../types.js';
import { classifyCandidate } from './classifierBridge.js';
import type { RunPersistence } from './runPersistence.js';
import type { SourceAdapter } from './sources/sourceAdapter.js';

const SPEC_FRESHNESS_DAYS = 60;

export type RunOutcome = 'completed' | 'paused' | 'cancelled' | 'failed';

export interface RunResult {
  status: RunOutcome;
  stats: DiscoveryStats;
  error?: { reason: string; details?: unknown };
}

export interface FileWriters {
  /** Called after a candidate is normalized (and optionally classified). */
  onCandidate: (
    candidate: NormalizedCandidate,
    classifierStatus: string,
  ) => Promise<void> | void;
  /** Called after every page. */
  onProgress: (progress: DiscoveryProgress, stats: DiscoveryStats) => Promise<void> | void;
}

export interface RunDiscoveryArgs {
  runId: string;
  config: DiscoveryRunConfig;
  /** Adapters for the sources requested in config.filters.sources. */
  adapters: Partial<Record<SourceId, SourceAdapter>>;
  specDir: string;
  /** When provided, the runner persists progress + candidates via this seam.
   *  CLI / tests / the parity oracle pass null. */
  persistence: RunPersistence | null;
  /** When persistence is null, fileWriters MUST be provided to capture output. */
  fileWriters?: FileWriters;
  /** When true, run classifier on every candidate. Defaults true. */
  classify?: boolean;
  /**
   * Pre-resolved spec from DB. When provided, bypasses YAML file loading for
   * keywords, exclusions, and ranking weights. Also enforces
   * ranking.min_search_score_threshold after scoring.
   */
  effectiveSpec?: EffectiveSpec;
}

const emptyPerSourceCounter = (): Record<SourceId, number> => ({
  openalex: 0,
  crossref: 0,
  semantic_scholar: 0,
  bob_reed: 0,
  i4r: 0,
  fred_data: 0,
});

const initialStats = (totalTasks: number): DiscoveryStats => ({
  totalTasks,
  completedTasks: 0,
  candidatesSeen: 0,
  candidatesKeptAfterExclusion: 0,
  candidatesClassified: 0,
  classifierAccepted: 0,
  classifierAmbiguous: 0,
  classifierNeedsMetadata: 0,
  classifierRejected: 0,
  floraKnown: 0,
  errorsPerSource: emptyPerSourceCounter(),
  apiCallsPerSource: emptyPerSourceCounter(),
  excludedByPattern: {},
  startedAt: new Date().toISOString(),
});

function checkSpecFreshness(adapters: Partial<Record<SourceId, SourceAdapter>>): void {
  for (const adapter of Object.values(adapters)) {
    if (!adapter) continue;
    const ageDays = (Date.now() - adapter.verifiedAt.getTime()) / 86_400_000;
    if (ageDays > SPEC_FRESHNESS_DAYS) {
      throw new Error(
        `Source ${adapter.id} verified ${Math.round(ageDays)} days ago — re-verify before running`,
      );
    }
  }
}

function buildTasks(sources: SourceId[]): DiscoveryTask[] {
  return sources.map((source, idx) => ({
    tid: idx,
    source,
    kid: '__bundle__',     // OR-bundle: one task per source covers all keywords
    perm: 0,
    field: 'default',
    cursor: '*',
    done: false,
  }));
}

function processPageCandidates(
  rawCandidates: NormalizedCandidate[],
  exclusions: ReturnType<typeof loadExclusionPatterns>,
  rawSourceCount: Set<SourceId>,
  weights: RankingWeights,
  stats: DiscoveryStats,
  expanded: ExpandedKeyword[],
): NormalizedCandidate[] {
  // Group by DOI within the page so multi-keyword/multi-source matches merge.
  const byDoi = new Map<string, NormalizedCandidate>();
  for (const cand of rawCandidates) {
    const text = `${cand.title ?? ''} ${cand.abstract ?? ''}`.trim();
    if (text) {
      const result = applyExclusions(text, exclusions);
      if (result.excluded) {
        stats.excludedByPattern[result.reason] = (stats.excludedByPattern[result.reason] ?? 0) + 1;
        continue;
      }
    }
    stats.candidatesKeptAfterExclusion++;
    // Re-attribute matchedKeywords post-fetch via local regex over title+abstract
    // (the source adapter set a placeholder pointing only to keywords[0]).
    const attributed = attributeKeywords(cand.title ?? '', cand.abstract ?? '', expanded);
    if (attributed.length > 0) cand.matchedKeywords = attributed;
    const existing = byDoi.get(cand.doi);
    byDoi.set(cand.doi, existing ? mergeCandidates(existing, cand) : cand);
  }

  for (const c of byDoi.values()) {
    c.searchScore = computeSearchScore(c, rawSourceCount, weights);
  }
  return Array.from(byDoi.values());
}

export async function runDiscovery(args: RunDiscoveryArgs): Promise<RunResult> {
  const specKeywords = args.effectiveSpec
    ? null
    : loadSpecKeywords(args.specDir);
  const exclusions = args.effectiveSpec
    ? patternsFromEffective(args.effectiveSpec.exclusions)
    : loadExclusionPatterns(args.specDir);
  const weights = args.effectiveSpec
    ? weightsFromEffective(args.effectiveSpec.ranking)
    : loadRankingWeights(args.specDir);

  try {
    checkSpecFreshness(args.adapters);
  } catch (e) {
    return {
      status: 'failed',
      stats: initialStats(0),
      error: { reason: 'spec_stale', details: (e as Error).message },
    };
  }

  // When effectiveSpec is provided, DB-backed keywords replace YAML spec keywords.
  // Wildcard templates saved by the admin UI are expanded before provider queries.
  // Dedup by phrase (case-insensitive): spec-derived entries win over user-input duplicates,
  // mirroring the same rule in expandAll.
  const expanded: ExpandedKeyword[] = args.effectiveSpec
    ? (() => {
        const seen = new Set<string>();
        const out: ExpandedKeyword[] = [];
        for (const k of expandedFromEffective(args.effectiveSpec.keywords)) {
          const key = k.permutation.toLowerCase();
          if (!seen.has(key)) { seen.add(key); out.push(k); }
        }
        for (const k of expandUserInput(args.config.keywords)) {
          const key = k.permutation.toLowerCase();
          if (!seen.has(key)) { seen.add(key); out.push(k); }
        }
        return out;
      })()
    : expandAll(specKeywords!, args.config.keywords);
  const requestedSources = args.config.filters.sources.filter((s) => args.adapters[s]);
  if (requestedSources.length === 0) {
    return { status: 'failed', stats: initialStats(0), error: { reason: 'no_sources_configured' } };
  }

  const tasks = buildTasks(requestedSources);
  const stats = initialStats(tasks.length);
  const progress: DiscoveryProgress = { tasks, currentTid: 0, pageCountPerTid: {} };

  const classifyOn = args.classify ?? true;
  const minScore = args.effectiveSpec?.ranking.min_search_score_threshold ?? 0;
  const sourcesMatched: Set<SourceId> = new Set(requestedSources);

  for (const task of tasks) {
    if (task.done) continue;
    progress.currentTid = task.tid;

    const adapter = args.adapters[task.source];
    if (!adapter) {
      task.done = true;
      stats.completedTasks++;
      continue;
    }

    try {
      let pageNumber = 0;
      for await (const page of adapter.search({
        keywords: expanded,
        filters: args.config.filters,
        cursor: task.cursor,
      })) {
        stats.apiCallsPerSource[task.source]++;
        stats.candidatesSeen += page.candidates.length;

        const normalizedRaws = page.candidates.map(normalizeCandidate);
        const candidatesAfterExclusion = processPageCandidates(
          normalizedRaws,
          exclusions,
          sourcesMatched,
          weights,
          stats,
          expanded,
        );
        const filtered = candidatesAfterExclusion.filter((c) => {
          if (c.searchScore >= minScore) return true;
          stats.candidatesDroppedByThreshold = (stats.candidatesDroppedByThreshold ?? 0) + 1;
          return false;
        });

        if (args.persistence) {
          await args.persistence.upsertCandidates(args.runId, filtered);
        }

        for (const c of filtered) {
          let classifierStatus: string = 'pending';
          if (classifyOn) {
            const verdict = await classifyCandidate(c);
            classifierStatus = verdict.status;
            stats.candidatesClassified++;
            if (verdict.status === 'accepted') stats.classifierAccepted++;
            else if (verdict.status === 'ambiguous') stats.classifierAmbiguous++;
            else if (verdict.status === 'needs_more_metadata') stats.classifierNeedsMetadata++;
            else if (verdict.status === 'rejected') stats.classifierRejected++;
            if (args.persistence) {
              await args.persistence.updateClassifierResult(
                args.runId,
                c.doi,
                c.source,
                verdict.status,
                verdict.result,
              );
            }
          }
          if (args.fileWriters) {
            await args.fileWriters.onCandidate(c, classifierStatus);
          }
        }

        // Update progress + check pause signal after each page.
        task.cursor = page.nextCursor ?? task.cursor;
        progress.pageCountPerTid[String(task.tid)] = ++pageNumber;
        stats.currentTask = {
          tid: task.tid,
          source: task.source,
          keyword: '__bundle__',
          field: 'default',
          page: pageNumber,
        };
        if (args.persistence) await args.persistence.updateProgress(args.runId, progress, stats);
        if (args.fileWriters) await args.fileWriters.onProgress(progress, stats);

        if (args.persistence) {
          const sig = await args.persistence.checkPauseSignal(args.runId);
          if (sig === 'paused' || sig === 'cancelled') {
            return { status: sig, stats };
          }
        }

        if (!page.nextCursor) break;
      }
      task.done = true;
      stats.completedTasks++;
    } catch (e) {
      stats.errorsPerSource[task.source]++;
      const msg = (e as Error).message ?? '';
      if (msg.includes('threshold exceeded')) {
        return {
          status: 'paused',
          stats,
          error: { reason: 'rate_limit_threshold', details: msg },
        };
      }
      // Other errors: log via stats and proceed to next task.
    }
  }

  return { status: 'completed', stats };
}
