// apps/worker/src/services/replication/targetExtraction.ts
import type { ExtractedTarget } from './types.js';

// Matches: "Smith (2020)", "Smith et al. (2020)", "Smith & Jones (2020)", "Smith, Jones, & Lee (2020)"
const AUTHOR_YEAR_RE = /([A-Z][a-zA-Z\u00C0-\u024F-]+(?:(?:,\s+[A-Z][a-zA-Z\u00C0-\u024F-]+)*(?:,?\s+(?:&|and)\s+[A-Z][a-zA-Z\u00C0-\u024F-]+)?)?(?:\s+et\s+al\.?)?)\s*\(\s*(\d{4})\s*\)/;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function firstAuthorLastName(authorString: string): string {
  // "Smith" | "Smith et al." | "Smith, Jones, & Lee" | "Smith & Jones"
  return authorString
    .replace(/\s+et\s+al\.?.*$/i, '')
    .split(/,|\s+&\s+|\s+and\s+/i)[0]
    .trim();
}

export function extractTargets(text: string): ExtractedTarget[] {
  if (!text) return [];
  const sentences = splitSentences(text);
  const seen = new Set<string>();
  const out: ExtractedTarget[] = [];

  for (const sentence of sentences) {
    let remainder = sentence;
    while (true) {
      const m = remainder.match(AUTHOR_YEAR_RE);
      if (!m) break;
      const authorString = m[1].trim();
      const year = parseInt(m[2], 10);
      const lastName = firstAuthorLastName(authorString);
      const key = `${lastName.toLowerCase()}|${year}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          authorYearString: `${authorString} (${year})`,
          firstAuthorLastName: lastName,
          year,
          sentence,
        });
      }
      remainder = remainder.slice((m.index ?? 0) + m[0].length);
    }
  }

  return out;
}
