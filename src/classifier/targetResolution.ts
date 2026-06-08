import type { ExtractedTarget, ResolvedTarget, OpenAlexWork } from './types.js';

const YEAR_WINDOW = 1;

/**
 * Last whitespace-delimited token of a name, lowercased. Lets a nobiliary-prefix
 * surname extracted as "Groot" (from "de Groot (2020)", whose lowercase "de" the
 * author-year regex skips) match a reference whose firstAuthor is stored as the
 * full "de Groot" — comparing only the final token "groot" on both sides (D5).
 */
function lastNameToken(name: string): string {
  return name.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
}

export function resolveTarget(
  target: ExtractedTarget,
  refs: OpenAlexWork['referencedWorks']
): ResolvedTarget {
  const lastName = lastNameToken(target.firstAuthorLastName);
  const matches = refs.filter(r => {
    if (!r.firstAuthor) return false;
    if (lastNameToken(r.firstAuthor) !== lastName) return false;
    if (r.year == null) return false;
    return Math.abs(r.year - target.year) <= YEAR_WINDOW;
  });

  if (matches.length === 0) {
    return { extracted: target, originalDoi: null, ambiguous: false, matchCount: 0 };
  }

  // Prefer exact year, then smaller year delta.
  matches.sort((a, b) => Math.abs((a.year ?? 0) - target.year) - Math.abs((b.year ?? 0) - target.year));

  return {
    extracted: target,
    originalDoi: matches[0].doi ?? null,
    ambiguous: matches.length > 1,
    matchCount: matches.length,
  };
}
