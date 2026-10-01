/**
 * Ports: the small interfaces a host application fills in so the lookup pipelines
 * carry no storage, queue, AI-provider or environment code of their own.
 */

/** Which way a replication lookup runs. */
export type ReplicationDirection = 'forward' | 'reverse';

/**
 * Result cache for the lookup pipelines. `get` returns the previously stored response
 * for (doi, direction) or null when there is none or it has expired -- expiry (TTL) is
 * the host's decision, not the library's. `put` stores a response. A failing cache must
 * not be hidden: let the error propagate rather than return a stale or empty value.
 */
export interface CachePort {
  get(doi: string, direction: ReplicationDirection): Promise<unknown | null>;
  put(doi: string, direction: ReplicationDirection, response: unknown): Promise<void>;
}
