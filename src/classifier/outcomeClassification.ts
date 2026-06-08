import type { ReplicationOutcome } from "./types.js";

interface OutcomeMatch {
  outcome: ReplicationOutcome;
  phrase: string;
  sentence: string;
}

const FAILED_RE =
  /(failed to replicate|failed to produce significant effects|did not replicate|do not support (?:the )?(?:existence|original|effect|hypothesis|finding)|could not reproduce|contrary to (?:the )?original|no significant effect|failed replication|effect was not replicated|no evidence for (?:the )?(?:original\s+)?(?:effect|hypothesis|finding)|we found no (?:significant\s+)?(?:effect|support|evidence)|(?:effect|finding|result) was not (?:supported|replicated|significant)|null (?:effect|result|finding)|no (?:reliable|detectable|clear) (?:effect|evidence)|(?:near[- ]zero|close to zero) (?:effect|difference)|(?:our|the) (?:meta[- ]?analysis|pooled) (?:revealed|showed|found) (?:a |an )?(?:null|no)|effect (?:was|is) (?:substantially|much) smaller|95% (?:CI|confidence interval) (?:includ|contain|span|cross|overlap)(?:s|ed|ped)? (?:zero|0\b)|confidence interval (?:includ|contain|span|cross|overlap)(?:s|ed|ped)? (?:zero|0\b))/i;
const SUCCESS_RE =
  /(successfully replicate[sd]|replication was successful|we replicate[d]? (?:the )?(?:original|finding)|consistent with the original|supported the original|confirmed the (?:original|previous) finding|(?:results|findings) (?:were|are) consistent with|we found support for|(?:original|previous) (?:effect|finding|result) was (?:supported|replicated)|replicated (?:the |original )?(?:effect|finding|result)|did not differ from (?:the )?original|statistically indistinguishable from (?:the )?original)/i;
const MIXED_RE =
  /(partial(?:ly)? replicated|mixed (?:evidence|results|findings)?|replicated in some|inconsistent (?:across|results)|only partial support|some but not all|one study replicated.*(?:another|one) did not|replicated for .* but not|significant .*effect .*absence .*eliminated .*presence|effect .*absence .*eliminated .*presence)/i;
// The original-vs-replication effect comparison must sit within ONE sentence.
// `[^.!?]{0,180}?` stays inside a sentence; the old `[\s\S]{0,220}?` spanned
// sentence boundaries and mis-classified e.g. "...d = 0.50. Separately, d = 0.02."
// (two unrelated effects in different sentences) as an effect-size collapse, a
// false 'failed' replication verdict (D2).
const ES_COLLAPSE_RE =
  /\b(d|g|r|beta|b)\s*=\s*(0\.[2-9]\d?)[^.!?]{0,180}?\b\1\s*=\s*(0\.0\d)\b/i;

function splitSentences(text: string): string[] {
  // Split on a sentence terminator followed by an uppercase letter. The lookahead
  // used to also allow "(", which split "Smith et al. (2010) failed to replicate"
  // into an orphan "(2010) failed..." fragment and corrupted the within-sentence
  // context isNegated relies on (D1). Mirrors targetExtraction.splitSentences.
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNegated(sentence: string, index: number): boolean {
  const before = sentence.slice(Math.max(0, index - 24), index).toLowerCase();
  return /(?:not|never|neither|no evidence that|did not|didn't|does not|doesn't|was not|wasn't|were not|weren't)\s+$/.test(
    before,
  );
}

function findUnnegated(sentence: string, re: RegExp): RegExpMatchArray | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let match: RegExpExecArray | null;
  while ((match = global.exec(sentence)) !== null) {
    if (!isNegated(sentence, match.index)) return match;
  }
  return null;
}

function effectSizeCollapse(text: string): RegExpMatchArray | null {
  const match = text.match(ES_COLLAPSE_RE);
  if (!match) return null;
  const metric = match[1].toLowerCase();
  const original = Number.parseFloat(match[2]);
  const observed = Number.parseFloat(match[3]);
  const threshold = metric === "r" ? 0.2 : 0.3;
  if (original >= threshold && observed >= 0 && observed < 0.1) return match;
  return null;
}

export function classifyOutcome(text: string): OutcomeMatch {
  if (!text) return { outcome: "unknown", phrase: "", sentence: "" };
  const sentences = splitSentences(text);

  for (const s of sentences) {
    const m = findUnnegated(s, FAILED_RE);
    if (m) return { outcome: "failed", phrase: m[0], sentence: s };
  }

  const esMatch = effectSizeCollapse(text);
  if (esMatch) {
    const phrase = `${esMatch[1]} = ${esMatch[3]}`;
    const sentence = sentences.find((s) => s.includes(phrase)) || esMatch[0];
    return { outcome: "failed", phrase, sentence };
  }

  for (const s of sentences) {
    const m = findUnnegated(s, MIXED_RE);
    if (m) return { outcome: "mixed", phrase: m[0], sentence: s };
  }

  for (const s of sentences) {
    const m = findUnnegated(s, SUCCESS_RE);
    if (m) return { outcome: "successful", phrase: m[0], sentence: s };
  }

  return { outcome: "unknown", phrase: "", sentence: "" };
}
