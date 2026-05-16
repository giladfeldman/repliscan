/**
 * Self-contained polite-pool Crossref GET helper for repliscan's metadata layer.
 *
 * Copied from CG apps/worker/src/services/crossref.ts (getCrossrefUserAgent +
 * crossrefGet) during Wave 2 repliscan extraction. The worker keeps its own copy
 * intact (it serves the full worker including non-replication plugins). Only the
 * replication metadata layer uses this copy. The @scimeto/shared formatError
 * dependency from crossref.ts is NOT copied here — crossrefGet itself does not
 * use it (only validateDOI does). The mailto is a parameter (no process.env read).
 *
 * This is a deliberate, scoped duplication parallel to FLAGGED DECISION POINT 2.
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { DEFAULT_POLITE_MAILTO } from './credentials.js';

/**
 * Polite-pool User-Agent header that Crossref's polite pool requires for
 * higher rate limits.
 */
export function getCrossrefUserAgent(mailto: string): string {
  return `Scimeto/1.0 (mailto:${mailto})`;
}

/**
 * Shared Crossref GET with polite-pool UA and retry on 429/502/503/504.
 *
 * - 429 honors the Retry-After header (seconds). Falls back to exponential
 *   backoff if absent. Caps the wait per attempt at 30s.
 * - 5xx uses exponential backoff (2s, 4s, 8s).
 * - Up to 3 attempts. After exhausting retries, throws the last error so
 *   callers can decide how to surface the failure.
 */
export async function crossrefGet<T = any>(
  url: string,
  config: AxiosRequestConfig = {},
  mailto: string = DEFAULT_POLITE_MAILTO,
): Promise<AxiosResponse<T>> {
  const maxAttempts = 3;
  const headers = {
    'User-Agent': getCrossrefUserAgent(mailto),
    Accept: 'application/json',
    ...(config.headers ?? {}),
  };

  let lastError: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await axios.get<T>(url, { timeout: 10000, ...config, headers });
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status === 502 || status === 503 || status === 504;
      if (!(isRateLimit || isServerError) || attempt === maxAttempts - 1) {
        throw err;
      }

      let delayMs: number;
      if (isRateLimit) {
        const retryAfterRaw = err.response?.headers?.['retry-after'];
        const retryAfterSec = retryAfterRaw ? parseInt(String(retryAfterRaw), 10) : NaN;
        delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 30000)
          : Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(
          `Crossref 429 for ${url} — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      } else {
        delayMs = 2000 * (attempt + 1);
        console.warn(
          `Crossref ${status} for ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
