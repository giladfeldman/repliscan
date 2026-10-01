/**
 * DOI helpers used by the lookup pipelines (FReD lookup, forward / reverse /
 * standalone extraction).
 *
 * `normalizeLookupDoi` is deliberately NOT the same function as `normalizeDoi`
 * (util/normalizeDoi.ts). It also strips a trailing `,` `;` `)` or `]` -- the
 * punctuation that PDF and reference text appends to a DOI -- which `normalizeDoi`
 * leaves in place. The two were separate copies in the consuming application and
 * the lookup pipelines always used the stricter one, so they keep it here:
 * moving the pipelines into this library must not change a single output byte.
 * Unifying the two is a behaviour change and is tracked separately.
 */

/**
 * Normalize a DOI for storage and lookup: URL-decode once, lowercase, strip the
 * doi.org URL prefixes and the `doi:` scheme, and strip trailing `. , ; ) ] /`.
 * Returns '' for nullish or empty input. Idempotent.
 */
export function normalizeLookupDoi(doi: string | null | undefined): string {
  if (!doi) return '';
  let s = String(doi);
  try { s = decodeURIComponent(s); } catch { /* keep as-is on malformed input */ }
  s = s.toLowerCase().trim();
  for (const prefix of [
    'https://doi.org/',
    'http://doi.org/',
    'https://dx.doi.org/',
    'http://dx.doi.org/',
  ]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  if (s.startsWith('doi:')) s = s.slice(4);
  s = s.replace(/[.,;)\]/]+$/, '');
  return s;
}

/**
 * True when `doi` looks malformed or truncated (e.g. `10.1037/0`, `10.1146/annurev`
 * pass; `10.1146` does not). Lookup must skip these: passing a partial DOI to a
 * metadata provider yields meaningless results that contaminate replication output.
 * Accepts the standard `10.<registrant>/<suffix>` shape and the short-DOI form `10/<token>`.
 */
export function isMalformedDoi(doi: string): boolean {
  if (typeof doi !== 'string') return true;
  const d = doi.trim();
  if (!d) return true;
  if (/^10\.\d{3,9}\/\S+$/.test(d)) return false;
  if (/^10\/[A-Za-z0-9._-]+$/.test(d)) return false;
  return true;
}

/**
 * True for the short-DOI form (`10/<token>`): a redirect alias issued by shortdoi.org,
 * not a canonical DOI. Replication lookup skips these because citation-graph queries
 * for unresolved short-DOIs return noisy, contaminated candidate sets.
 */
export function isShortFormDoi(doi: string): boolean {
  if (typeof doi !== 'string') return false;
  return /^10\/[A-Za-z0-9._-]+$/.test(doi.trim());
}
