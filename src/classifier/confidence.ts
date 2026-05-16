import type { ReplicationConfidence } from './types.js';

export interface ConfidenceSignals {
  fredHit?: boolean;
  fredFuzzyHit?: boolean;
  backRefConfirmed?: boolean;
  phraseInTitle?: boolean;
  phraseInAbstract?: boolean;
  ambiguous?: boolean;
}

export function scoreConfidence(s: ConfidenceSignals): ReplicationConfidence {
  if (s.fredHit && !s.ambiguous) return 'high';

  if (s.backRefConfirmed && s.phraseInTitle) {
    return s.ambiguous ? 'medium' : 'high';
  }
  if (s.backRefConfirmed && s.phraseInAbstract) return 'medium';
  if (s.fredFuzzyHit) return 'medium';
  if (s.fredHit && s.ambiguous) return 'medium';
  return 'low';
}
