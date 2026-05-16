// NOTE: no /g flag — would make lastIndex stateful across calls (LESSONS.md #15).
const REPLICATION_PHRASES = [
  /\breplication of\b/i,
  /\bwe replicated\b/i,
  /\bwe replicate\b/i,
  /\breplicating the findings\b/i,
  /\bdirect replication\b/i,
  /\bconceptual replication\b/i,
  /\bpreregistered replication\b/i,
  /\bregistered replication\b/i,
  /\bfailed to replicate\b/i,
  /\bdid not replicate\b/i,
  /\bcould not reproduce\b/i,
  /\bsuccessfully replicated\b/i,
  /\breproducibility of\b/i,
  // Registered Report conventions (Round 3 tuning)
  /\breplication and extensions?\b/i,
  /\bregistered report of\b/i,
  /\b(?:close|high[-\s]powered|pre[-\s]?registered|large[-\s]scale)\s+replication\b/i,
  /\breplication (?:and|&) extension\b/i,
  /\breproduce[ds]?\s+(?:the\s+)?(?:original\s+)?(?:findings?|effects?|results?)\b/i,
];

const NON_SCHOLARLY_REPLICATION_CONTEXTS = [
  /\b(?:dna|rna|viral|virus|cell|cellular|chromosome|plasmid)\s+replication\b/i,
  /\breplication of (?:the )?(?:apparatus|code|dataset|data|database|model|method|pipeline|protocol|software|simulation)\b/i,
  /\breplicat(?:e|ed|ing)\s+(?:the )?(?:apparatus|code|dataset|data|database|model|method|pipeline|protocol|software|simulation)\b/i,
  /\breplication (?:fork|origin|stress|timing)\b/i,
];

function isNonScholarlyContext(text: string): boolean {
  return NON_SCHOLARLY_REPLICATION_CONTEXTS.some(re => re.test(text));
}

export function hasReplicationPhrase(text: string): boolean {
  if (!text) return false;
  if (isNonScholarlyContext(text)) return false;
  return REPLICATION_PHRASES.some(re => re.test(text));
}

export function findReplicationPhrase(text: string): string | null {
  if (!text) return null;
  if (isNonScholarlyContext(text)) return null;
  for (const re of REPLICATION_PHRASES) {
    const m = text.match(re);
    if (m) return m[0].toLowerCase();
  }
  return null;
}
