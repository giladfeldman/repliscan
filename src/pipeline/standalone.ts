import type { MetadataProviderReport, ReplicationFinding, ReplicationOutcome, ReplicationConfidence, ResolvedWork } from '../classifier/types.js';
import type { MetadataCredentials } from '../metadata/credentials.js';
import { resolveWorkDetailed } from '../metadata/metadataResolver.js';
import { classifyReplication } from '../classifier/classifier.js';
import { extractTargets } from '../classifier/targetExtraction.js';
import { classifyOutcome } from '../classifier/outcomeClassification.js';
import { scoreConfidence } from '../classifier/confidence.js';
import { resolveAuthorYearViaCrossref } from '../metadata/crossrefAuthorYearResolver.js';
import { normalizeLookupDoi as normalizeDoi, isMalformedDoi, isShortFormDoi } from '../util/lookupDoi.js';
import { libraryVersion } from '../util/libraryVersion.js';

export type ExtractorStatus =
  | 'accepted'
  | 'rejected'
  | 'needs_more_metadata'
  | 'ambiguous'
  | 'llm_disagreed';

export interface VerificationResult {
  model: string;
  version?: string;
  agreed: boolean;
  status?: ExtractorStatus;
  reason: string;
  supportingQuote?: string;
  rawJson?: unknown;
}

export interface ExtractorOptions {
  now?: () => Date;
  /** Build identifier stamped on every record. Defaults to `repliscan@<library version>`. */
  codeVersion?: string;
  /**
   * Optional second-opinion verifier (see `VerifierPort`). The library ships no AI provider and no
   * keys: the host supplies the function, typically built with `createLlmVerifier`. When omitted,
   * no verification pass runs.
   */
  verifier?: VerifierPort;
  /** Credentials for the metadata providers (API keys, polite-pool contact email). */
  credentials?: MetadataCredentials;
  /**
   * When true, after the rule-based + back-ref classifier returns no targets but the
   * abstract still contains extractable Author (YYYY) mentions, query Crossref to
   * resolve the original DOI. Default: false.
   *
   * Anti-hallucination: the resolver itself only returns matched=true when the top
   * Crossref candidate scores >= 5 AND beats the runner-up by >= 1. We never invent
   * a DOI here; we only adopt one Crossref returned with high confidence.
   */
  enableCrossrefAuthorYearFallback?: boolean;
}

/** A second-opinion verifier: the host-supplied function that checks a rule-based verdict. */
export type VerifierPort = (input: VerifierInput) => Promise<VerificationResult>;

export interface VerifierInput {
  inputDoi: string;
  normalizedDoi: string;
  status: ExtractorStatus;
  title: string;
  abstract: string;
  targets: ReplicationFinding[];
  unresolvedReason: string;
}

export interface ExtractorRecord {
  inputDoi: string;
  normalizedDoi: string;
  status: ExtractorStatus;
  replicationDoi: string;
  replicationTitle: string;
  replicationAuthors: string;
  replicationVenue: string;
  replicationYear: number | null;
  originalDoi: string;
  originalTitle: string;
  originalAuthors: string;
  originalVenue: string;
  originalYear: number | null;
  originalReferenceExtracted: string;
  justificationPhrase: string;
  outcome: ReplicationOutcome | '';
  outcomePhrase: string;
  confidence: ReplicationConfidence | '';
  matchMethod: string;
  apiSourcesQueried: string[];
  metadataProviderReports: MetadataProviderReport[];
  rawSourceSnippets: string[];
  ruleIdsTriggered: string[];
  signalProvenance: string[];
  modelVerifier: string;
  verifierVersion: string;
  verifierReason: string;
  timestamp: string;
  codeVersion: string;
  unresolvedReason: string;
}

const EMPTY_FINDING_FIELDS = {
  replicationTitle: '',
  replicationAuthors: '',
  replicationVenue: '',
  replicationYear: null as number | null,
  originalDoi: '',
  originalTitle: '',
  originalAuthors: '',
  originalVenue: '',
  originalYear: null as number | null,
  originalReferenceExtracted: '',
  justificationPhrase: '',
  outcome: '' as const,
  outcomePhrase: '',
  confidence: '' as const,
  matchMethod: '',
  rawSourceSnippets: [] as string[],
  ruleIdsTriggered: [] as string[],
  signalProvenance: [] as string[],
};

function defaultCodeVersion(): string {
  return `repliscan@${libraryVersion()}`;
}

function isValidDoi(norm: string): boolean {
  return /^10\.\d{4,}\/\S+$/i.test(norm) && !isMalformedDoi(norm) && !isShortFormDoi(norm);
}

function baseRecord(
  inputDoi: string,
  normalizedDoi: string,
  status: ExtractorStatus,
  timestamp: string,
  codeVersion: string,
  unresolvedReason: string,
  metadata: Partial<Pick<ExtractorRecord, 'replicationTitle' | 'replicationAuthors' | 'replicationVenue' | 'replicationYear'>> = {},
  apiSourcesQueried: string[] = [],
  metadataProviderReports: MetadataProviderReport[] = [],
): ExtractorRecord {
  return {
    inputDoi,
    normalizedDoi,
    status,
    replicationDoi: normalizedDoi,
    ...EMPTY_FINDING_FIELDS,
    ...metadata,
    apiSourcesQueried,
    metadataProviderReports,
    modelVerifier: '',
    verifierVersion: '',
    verifierReason: '',
    timestamp,
    codeVersion,
    unresolvedReason,
  };
}

function statusForFinding(finding: ReplicationFinding, acceptedCount: number, totalTargets: number): ExtractorStatus {
  if (finding.ambiguous || totalTargets > 1) return 'ambiguous';
  if (acceptedCount > 0 && finding.originalDoi) return 'accepted';
  return 'needs_more_metadata';
}

function matchMethod(finding: ReplicationFinding): string {
  if (finding.signalProvenance.includes('fred')) return 'flora_fred_known_pair';
  if (finding.signalProvenance.includes('reference-openalex')) return 'openalex_reference_backref';
  if (finding.signalProvenance.includes('back-ref-confirmed')) return 'metadata_reference_backref';
  // T0-WIRE-A (2026-05-06): match-method tag for the Crossref author-year fallback path.
  if (finding.signalProvenance.includes('crossref-author-year-resolved')) return 'crossref_author_year_resolution';
  return 'deterministic_rule';
}

function ruleIdsForFinding(finding: ReplicationFinding): string[] {
  const rules = new Set<string>();
  if (finding.signalProvenance.includes('back-ref-confirmed')) rules.add('HARD_BACKREF_CONFIRMED');
  if (finding.signalProvenance.includes('phrase-in-title')) rules.add('REPLICATION_PHRASE_TITLE');
  if (finding.signalProvenance.includes('phrase-in-abstract')) rules.add('REPLICATION_PHRASE_ABSTRACT');
  if (finding.signalProvenance.includes('outcome-phrase-extracted')) rules.add('OUTCOME_PHRASE_EXTRACTED');
  if (finding.ambiguous) rules.add('AMBIGUOUS_TARGET');
  if (finding.outcome === 'unknown') rules.add('UNKNOWN_OUTCOME');
  return Array.from(rules);
}

function recordFromFinding(
  inputDoi: string,
  normalizedDoi: string,
  finding: ReplicationFinding,
  status: ExtractorStatus,
  timestamp: string,
  codeVersion: string,
  apiSourcesQueried: string[],
  metadataProviderReports: MetadataProviderReport[],
): ExtractorRecord {
  const evidence = Array.from(new Set([
    finding.justificationPhrase,
    finding.outcomePhrase,
    ...(finding.evidence || []),
  ].filter(Boolean)));

  return {
    inputDoi,
    normalizedDoi,
    status,
    replicationDoi: normalizedDoi,
    originalDoi: finding.originalDoi,
    replicationTitle: finding.replicationTitle || '',
    replicationAuthors: finding.replicationAuthors || '',
    replicationVenue: finding.replicationVenue || '',
    replicationYear: finding.replicationYear ?? null,
    originalTitle: finding.originalTitle || '',
    originalAuthors: finding.originalAuthors || '',
    originalVenue: finding.originalVenue || '',
    originalYear: finding.originalYear ?? null,
    originalReferenceExtracted: finding.originalReferenceExtracted,
    justificationPhrase: finding.justificationPhrase,
    outcome: finding.outcome,
    outcomePhrase: finding.outcomePhrase,
    confidence: finding.confidence,
    matchMethod: matchMethod(finding),
    apiSourcesQueried,
    metadataProviderReports,
    rawSourceSnippets: evidence,
    ruleIdsTriggered: ruleIdsForFinding(finding),
    signalProvenance: finding.signalProvenance,
    modelVerifier: '',
    verifierVersion: '',
    verifierReason: '',
    timestamp,
    codeVersion,
    unresolvedReason: status === 'accepted' ? '' : 'multiple_or_ambiguous_targets',
  };
}

function withVerification(record: ExtractorRecord, verification: VerificationResult): ExtractorRecord {
  const status = verification.agreed ? (verification.status ?? record.status) : 'llm_disagreed';
  // T0-WIRE-C (2026-05-06): tag signalProvenance so downstream UI / API consumers
  // can render the per-row chip showing the LLM verifier ran. We tag on every
  // verifier outcome (agreed AND disagreed) — the UI distinguishes via `status`.
  const signalProvenance = Array.from(new Set([
    ...record.signalProvenance,
    'LLM-verified',
    ...(status === 'llm_disagreed' ? ['LLM-disagreed'] : []),
  ]));
  return {
    ...record,
    status,
    modelVerifier: verification.model,
    verifierVersion: verification.version || '',
    verifierReason: verification.reason,
    signalProvenance,
    rawSourceSnippets: Array.from(new Set([
      ...record.rawSourceSnippets,
      verification.supportingQuote || '',
    ].filter(Boolean))),
    unresolvedReason: status === 'llm_disagreed' ? 'llm_verifier_disagreed' : record.unresolvedReason,
  };
}

/**
 * T0-WIRE-A (2026-05-06): Crossref author-year fallback.
 *
 * Called when classifyReplication returns isReplication=true but targets.length===0
 * (i.e. the replication phrase was detected, "Author (YYYY)" mentions were found,
 * but none of them back-resolved to a DOI in the referencedWorks list).
 *
 * For each extracted Author (YYYY) mention we ask Crossref to identify the original
 * paper. The resolver only returns matched=true when its scoring threshold is met
 * (top score >= 5 AND beats runner-up by >= 1) — it will NEVER fabricate a DOI.
 *
 * On a confident match we synthesise a ReplicationFinding with the new originalDoi
 * and tag signalProvenance with `crossref-author-year-resolved`. We then run the
 * existing outcome classifier over the source sentence so the row gets the same
 * `outcome` / `outcomePhrase` treatment as a back-ref-confirmed target.
 *
 * Returns [] when nothing could be confidently resolved — the caller falls through
 * to the existing needs_more_metadata path.
 */
async function tryCrossrefAuthorYearFallback(
  work: ResolvedWork,
  abstract: string,
  title: string,
  options: { signal?: AbortSignal; mailto?: string } = {},
): Promise<ReplicationFinding[]> {
  const extracted = extractTargets(`${title}. ${abstract}`);
  if (extracted.length === 0) return [];

  const findings: ReplicationFinding[] = [];
  for (const ext of extracted) {
    let resolution;
    try {
      resolution = await resolveAuthorYearViaCrossref(
        {
          author: ext.firstAuthorLastName,
          year: ext.year,
          sentence: ext.sentence,
          replicationTitle: title,
        },
        { signal: options.signal, mailto: options.mailto },
      );
    } catch (err) {
      console.warn(
        '[standaloneExtractor] crossref author-year fallback threw:',
        (err as Error)?.message || String(err),
      );
      continue;
    }
    if (!resolution.matched || !resolution.doi) continue;

    const outcome = classifyOutcome(`${ext.sentence}\n${abstract}`);
    const confidence = scoreConfidence({
      backRefConfirmed: false,
      phraseInTitle: false,
      phraseInAbstract: true,
      ambiguous: false,
    });
    if (confidence === 'low') continue;

    const provenance = ['crossref-author-year-resolved'];
    if (outcome.outcome !== 'unknown') provenance.push('outcome-phrase-extracted');

    const topCandidate = resolution.candidates[0];

    findings.push({
      originalDoi: resolution.doi,
      originalTitle: topCandidate?.title || '',
      originalAuthors: topCandidate?.firstAuthor || '',
      originalVenue: topCandidate?.container || '',
      originalYear: topCandidate?.year ?? null,
      replicationTitle: work.title,
      replicationAuthors: work.authors,
      replicationVenue: work.venue,
      replicationYear: work.year,
      originalReferenceExtracted: ext.authorYearString,
      justificationPhrase: ext.sentence,
      outcomePhrase: outcome.sentence,
      outcome: outcome.outcome,
      confidence,
      evidence: Array.from(new Set([ext.sentence, outcome.sentence].filter(Boolean))),
      signalProvenance: provenance,
      ambiguous: false,
    });
  }
  return findings;
}

function isCrossrefFallbackEnabled(options: ExtractorOptions): boolean {
  return options.enableCrossrefAuthorYearFallback === true;
}

/**
 * Extract the replication records for one DOI: resolve its metadata across the providers, classify
 * it, optionally resolve unresolved targets through Crossref and verify uncertain rows with the
 * host's `verifier`. Never throws for a DOI that is merely unresolvable -- it returns a record whose
 * `status` and `unresolvedReason` say why.
 */
export async function extractReplicationStandalone(
  inputDoi: string,
  options: ExtractorOptions = {},
): Promise<ExtractorRecord[]> {
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const codeVersion = options.codeVersion ?? defaultCodeVersion();
  const normalizedDoi = normalizeDoi(inputDoi);

  if (!normalizedDoi || !isValidDoi(normalizedDoi)) {
    return [baseRecord(inputDoi, normalizedDoi, 'rejected', timestamp, codeVersion, 'invalid_or_out_of_scope_doi')];
  }

  const lookup = await resolveWorkDetailed(normalizedDoi, undefined, options.credentials);
  const work = lookup.work;
  if (!work) {
    return [baseRecord(
      inputDoi,
      normalizedDoi,
      'needs_more_metadata',
      timestamp,
      codeVersion,
      'doi_not_found_in_metadata_providers',
      {},
      lookup.sourcesQueried,
      lookup.providerReports,
    )];
  }

  const result = classifyReplication({
    doi: normalizedDoi,
    title: work.title,
    authors: work.authors,
    venue: work.venue,
    year: work.year,
    abstract: work.abstract,
    referencedWorks: work.referencedWorks,
  });

  if (!result.isReplication) {
    return [baseRecord(inputDoi, normalizedDoi, 'rejected', timestamp, codeVersion, 'no_replication_phrase_detected', {
      replicationTitle: work.title,
      replicationAuthors: work.authors,
      replicationVenue: work.venue,
      replicationYear: work.year,
    }, work.sourcesQueried, work.providerReports)];
  }

  const verifier = options.verifier;

  if (result.targets.length === 0) {
    // T0-WIRE-A (2026-05-06): try Crossref author-year fallback before giving up.
    let fallbackTargets: ReplicationFinding[] = [];
    if (isCrossrefFallbackEnabled(options)) {
      fallbackTargets = await tryCrossrefAuthorYearFallback(work, work.abstract, work.title, { mailto: options.credentials?.openAlexMailto });
    }

    if (fallbackTargets.length > 0) {
      // We synthesised one or more findings via Crossref. Treat them like the
      // back-ref-confirmed path below, including verifier pass when configured.
      const acceptedFallbackCount = fallbackTargets.filter(t => t.originalDoi).length;
      const fallbackRecords = fallbackTargets.map(finding => recordFromFinding(
        inputDoi,
        normalizedDoi,
        finding,
        statusForFinding(finding, acceptedFallbackCount, fallbackTargets.length),
        timestamp,
        codeVersion,
        work.sourcesQueried,
        work.providerReports,
      ));

      if (!verifier) return fallbackRecords;
      const verifiedFallback: ExtractorRecord[] = [];
      for (const record of fallbackRecords) {
        if (record.status === 'accepted' && record.outcome !== 'unknown') {
          verifiedFallback.push(record);
          continue;
        }
        const verification = await verifier({
          inputDoi,
          normalizedDoi,
          status: record.status,
          title: work.title,
          abstract: work.abstract,
          targets: fallbackTargets,
          unresolvedReason: record.unresolvedReason || 'crossref_fallback_unknown_outcome',
        });
        verifiedFallback.push(withVerification(record, verification));
      }
      return verifiedFallback;
    }

    const unresolvedReason = work.referencedWorks.length === 0
      ? 'replication_phrase_detected_but_no_references_available'
      : 'replication_phrase_detected_but_no_resolvable_target';
    const pending = baseRecord(inputDoi, normalizedDoi, 'needs_more_metadata', timestamp, codeVersion, unresolvedReason, {
      replicationTitle: work.title,
      replicationAuthors: work.authors,
      replicationVenue: work.venue,
      replicationYear: work.year,
    }, work.sourcesQueried, work.providerReports);
    if (verifier) {
      const verification = await verifier({
        inputDoi,
        normalizedDoi,
        status: pending.status,
        title: work.title,
        abstract: work.abstract,
        targets: [],
        unresolvedReason,
      });
      return [withVerification(pending, verification)];
    }
    return [pending];
  }

  const acceptedTargets = result.targets.filter(t => t.originalDoi);
  const records = result.targets.map(finding => recordFromFinding(
    inputDoi,
    normalizedDoi,
    finding,
    statusForFinding(finding, acceptedTargets.length, result.targets.length),
    timestamp,
    codeVersion,
    work.sourcesQueried,
    work.providerReports,
  ));

  if (!verifier) return records;

  const verified: ExtractorRecord[] = [];
  for (const record of records) {
    if (record.status === 'accepted' && record.outcome !== 'unknown') {
      verified.push(record);
      continue;
    }
    const verification = await verifier({
      inputDoi,
      normalizedDoi,
      status: record.status,
      title: work.title,
      abstract: work.abstract,
      targets: result.targets,
      unresolvedReason: record.unresolvedReason || 'unknown_outcome_or_ambiguous_target',
    });
    verified.push(withVerification(record, verification));
  }
  return verified;
}

export const EXTRACTOR_CSV_COLUMNS = [
  'inputDoi',
  'normalizedDoi',
  'status',
  'replicationDoi',
  'replicationTitle',
  'replicationAuthors',
  'replicationVenue',
  'replicationYear',
  'originalDoi',
  'originalTitle',
  'originalAuthors',
  'originalVenue',
  'originalYear',
  'originalReferenceExtracted',
  'justificationPhrase',
  'outcome',
  'outcomePhrase',
  'confidence',
  'matchMethod',
  'apiSourcesQueried',
  'metadataProviderReports',
  'rawSourceSnippets',
  'ruleIdsTriggered',
  'signalProvenance',
  'modelVerifier',
  'verifierVersion',
  'verifierReason',
  'timestamp',
  'codeVersion',
  'unresolvedReason',
] as const;

function csvEscape(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map(item => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join(' | ')
    : String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function recordsToCsv(records: ExtractorRecord[]): string {
  const header = EXTRACTOR_CSV_COLUMNS.join(',');
  const rows = records.map(record => EXTRACTOR_CSV_COLUMNS.map(col => csvEscape(record[col])).join(','));
  return `${header}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}
