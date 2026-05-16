// apps/worker/src/services/replication/classifier.ts
import type { ReplicationClassifierInput, ReverseExtractorResult, ReplicationFinding } from './types.js';
import { hasReplicationPhrase } from './phraseDetection.js';
import { extractTargets } from './targetExtraction.js';
import { resolveTarget } from './targetResolution.js';
import { classifyOutcome } from './outcomeClassification.js';
import { scoreConfidence } from './confidence.js';

export function classifyReplication(input: ReplicationClassifierInput): ReverseExtractorResult {
  const { doi, title, authors, venue, year, abstract, referencedWorks } = input;
  const phraseInTitle = hasReplicationPhrase(title);
  const phraseInAbstract = hasReplicationPhrase(abstract);
  const isReplication = phraseInTitle || phraseInAbstract;

  if (!isReplication) {
    return { replicationDoi: doi, isReplication: false, targets: [] };
  }

  const extracted = extractTargets(`${title}. ${abstract}`);
  if (extracted.length === 0) {
    return { replicationDoi: doi, isReplication: true, targets: [] };
  }

  const targets: ReplicationFinding[] = [];
  for (const ext of extracted) {
    const resolved = resolveTarget(ext, referencedWorks);
    if (!resolved.originalDoi) continue; // back-ref gate: drop if no matched reference
    const original = referencedWorks.find(ref => ref.doi === resolved.originalDoi);

    const windowText = `${ext.sentence}\n${abstract}`;
    const outcome = classifyOutcome(windowText);

    const confidence = scoreConfidence({
      backRefConfirmed: true,
      phraseInTitle,
      phraseInAbstract,
      ambiguous: resolved.ambiguous,
    });
    if (confidence === 'low') continue;

    const provenance = ['back-ref-confirmed'];
    if (original?.source) provenance.push(`reference-${original.source}`);
    if (phraseInTitle) provenance.push('phrase-in-title');
    if (phraseInAbstract) provenance.push('phrase-in-abstract');
    if (resolved.ambiguous) provenance.push('ambiguous-target');
    if (outcome.outcome !== 'unknown') provenance.push('outcome-phrase-extracted');

    targets.push({
      originalDoi: resolved.originalDoi,
      originalTitle: original?.title || '',
      originalAuthors: original?.authors || '',
      originalVenue: original?.venue || '',
      originalYear: original?.year ?? null,
      replicationTitle: title,
      replicationAuthors: authors || '',
      replicationVenue: venue || '',
      replicationYear: year ?? null,
      originalReferenceExtracted: ext.authorYearString,
      justificationPhrase: ext.sentence,
      outcomePhrase: outcome.sentence,
      outcome: outcome.outcome,
      confidence,
      evidence: Array.from(new Set([ext.sentence, outcome.sentence].filter(Boolean))),
      signalProvenance: provenance,
      ambiguous: resolved.ambiguous || undefined,
    });
  }

  return { replicationDoi: doi, isReplication: true, targets };
}
