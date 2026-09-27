/**
 * Normalize a DOI for consistent lookup.
 * Handles URL-encoding, case, whitespace, URL prefixes, and trailing chars.
 *
 * A consuming application keeps an identical copy of this function for its own
 * DOI lookups, so the two must not diverge: change both or neither.
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
