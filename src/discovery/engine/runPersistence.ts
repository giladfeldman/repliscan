/**
 * RunPersistence — the DB seam for runDiscovery.
 *
 * runDiscovery is library-pure: it never imports a database client. When the
 * caller wants candidates + progress persisted, it passes a RunPersistence
 * implementation; when it doesn't (CLI, tests, the parity oracle), it passes
 * null and supplies `fileWriters` instead.
 *
 * The four methods mirror, exactly, the four DB functions the runner called
 * before the Wave 2 extraction (candidateWriter.upsertCandidates /
 * updateClassifierResult, checkpointStore.updateProgress / checkPauseSignal).
 * The CitationGuard worker implements this interface in discoveryJobRunner.ts,
 * closing over its Neon client. The method signatures intentionally drop the
 * leading `db` argument the worker functions take — the implementation closes
 * over `db` instead.
 */
import type {
  ClassifierStatus,
  DiscoveryProgress,
  DiscoveryRunStatus,
  DiscoveryStats,
  NormalizedCandidate,
} from '../types.js';

export interface RunPersistence {
  /** Idempotent upsert of a page of candidates for this run. */
  upsertCandidates(runId: string, candidates: NormalizedCandidate[]): Promise<void>;
  /** Persist one candidate's classifier verdict. */
  updateClassifierResult(
    runId: string,
    doi: string,
    source: string,
    status: ClassifierStatus,
    result: unknown,
  ): Promise<void>;
  /** Persist progress + stats after a page. */
  updateProgress(runId: string, progress: DiscoveryProgress, stats: DiscoveryStats): Promise<void>;
  /** Cheap status read for pause/cancel signalling between pages. */
  checkPauseSignal(runId: string): Promise<DiscoveryRunStatus | null>;
}
