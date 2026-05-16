/**
 * Normalize a DOI for consistent lookup.
 * Handles URL-encoding, case, whitespace, URL prefixes, and trailing chars.
 *
 * Copied verbatim from the CitationGuard worker's floraLookup.ts during the
 * Wave 2 repliscan extraction. The worker keeps its own copy because
 * floraLookup.ts also hosts FLoRA-database logic that is not replication-only.
 * The two copies are intentionally identical; do not let them diverge.
 */
export function normalizeDoi(doi: string): string {
  if (!doi) return '';
  try { doi = decodeURIComponent(doi); } catch { /* keep as-is */ }
  doi = doi.toLowerCase().trim();
  for (const prefix of [
    'https://doi.org/',
    'http://doi.org/',
    'http://dx.doi.org/',
    'https://dx.doi.org/',
  ]) {
    if (doi.startsWith(prefix)) {
      doi = doi.slice(prefix.length);
      break;
    }
  }
  if (doi.startsWith('doi:')) doi = doi.slice(4);
  doi = doi.replace(/[./]+$/, '');
  return doi;
}
