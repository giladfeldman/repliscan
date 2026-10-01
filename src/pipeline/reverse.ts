import type { ReverseExtractorResult } from '../classifier/types.js';
import { resolveWork } from '../metadata/metadataResolver.js';
import { classifyReplication } from '../classifier/classifier.js';
import { normalizeLookupDoi as normalizeDoi } from '../util/lookupDoi.js';
import type { CachePort } from './ports.js';

/** Options for `extractReplication`. */
export interface ReverseOptions {
  /** Result cache. When omitted, nothing is read from or written to a cache. */
  cache?: CachePort;
}

/**
 * Is `doi` itself a replication, and of what? Resolves the paper's metadata, then runs
 * `classifyReplication` over its title, abstract and reference list.
 *
 * Note: the metadata lookup here runs with the providers' default credentials (it has done
 * so since before this code moved into the library). Threading caller credentials through
 * is a deliberate behaviour change and is tracked separately.
 */
export async function extractReplication(
  doi: string,
  opts: ReverseOptions = {}
): Promise<ReverseExtractorResult> {
  const norm = normalizeDoi(doi);
  if (!norm) return { replicationDoi: doi, isReplication: false, targets: [] };

  const cached = await opts.cache?.get(norm, 'reverse');
  if (cached) return cached as ReverseExtractorResult;

  const work = await resolveWork(norm);
  if (!work) {
    const empty: ReverseExtractorResult = { replicationDoi: norm, isReplication: false, targets: [] };
    await opts.cache?.put(norm, 'reverse', empty);
    return empty;
  }

  const result = classifyReplication({
    doi: norm,
    title: work.title,
    abstract: work.abstract,
    referencedWorks: work.referencedWorks,
  });

  await opts.cache?.put(norm, 'reverse', result);
  return result;
}
