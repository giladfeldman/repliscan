import type { ExtractedTarget, ResolvedTarget, OpenAlexWork } from './types.js';

const YEAR_WINDOW = 1;

export function resolveTarget(
  target: ExtractedTarget,
  refs: OpenAlexWork['referencedWorks']
): ResolvedTarget {
  const lastName = target.firstAuthorLastName.toLowerCase();
  const matches = refs.filter(r => {
    if (!r.firstAuthor) return false;
    if (r.firstAuthor.toLowerCase() !== lastName) return false;
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
