/**
 * Second-opinion verification of a rule-based replication verdict.
 *
 * The library owns the parts that decide whether a verdict is trustworthy -- the prompt, the
 * JSON parsing, and the anti-hallucination guard that blanks any quote the model returns which
 * is not verbatim in the abstract -- and none of the parts that need credentials. The host
 * supplies `callLlm`: a function that sends the prompt to whatever model it has and returns
 * the raw text. The library ships no AI provider, no keys and no network code for this step.
 *
 * Anti-hallucination guards:
 *   - The prompt tells the model not to infer the outcome from the title, not to cite a
 *     sentence that is not verbatim in the abstract, and to answer "unknown" when unsure.
 *   - Programmatic guard: a non-empty supportingQuote is checked against the abstract as a
 *     case-insensitive substring. If it is not there the quote is blanked and
 *     `(quote-not-in-source)` is appended to the reason, whatever the model's own confidence.
 */

import type { VerifierInput, VerificationResult, ExtractorStatus, VerifierPort } from './standalone.js';

/** The raw answer of a language-model call, as the host returns it from `callLlm`. */
export interface LlmResponse {
  /** The model's raw text answer (expected to be a JSON object). */
  content: string;
  /** Model identifier, recorded on the result as `model`. */
  model?: string;
  /** Provider identifier; used as `model` when `model` is absent. */
  provider?: string;
}

interface LlmJsonOutput {
  isReplication?: 'yes' | 'no' | 'unclear' | string;
  outcome?: 'successful' | 'failed' | 'mixed' | 'unknown' | string;
  supportingQuote?: string;
  confidence?: 'high' | 'medium' | 'low' | string;
  reason?: string;
}

function buildPrompt(input: VerifierInput): string {
  const targetsBlock =
    input.targets.length > 0
      ? input.targets
          .map(
            (t, i) =>
              `[T${i + 1}] doi=${t.originalDoi || ''} title=${(t as any).originalTitle || ''} ` +
              `firstAuthor=${(t as any).originalFirstAuthor || ''} year=${t.originalYear ?? ''}`
          )
          .join('\n')
      : '(none)';

  return [
    'SYSTEM: You are a careful meta-science assistant verifying whether a paper is a replication study.',
    '',
    'Rules (these are non-negotiable):',
    ' - If the abstract does NOT clearly state the replication outcome, answer outcome="unknown" and supportingQuote="".',
    ' - Do NOT infer the outcome from the title. The title alone is insufficient evidence.',
    ' - Do NOT cite a sentence that does not appear verbatim in the input abstract. If you cannot find a verbatim sentence, return supportingQuote="".',
    ' - Output strictly valid JSON with this schema and no prose:',
    '   {"isReplication":"yes"|"no"|"unclear","outcome":"successful"|"failed"|"mixed"|"unknown","supportingQuote":"...","confidence":"high"|"medium"|"low","reason":"..."}',
    '',
    `INPUT DOI: ${input.inputDoi} (normalized: ${input.normalizedDoi})`,
    `RULE-BASED STATUS (for context only): ${input.status}`,
    `RULE-BASED UNRESOLVED REASON: ${input.unresolvedReason || '(none)'}`,
    '',
    `TITLE: ${input.title}`,
    '',
    'ABSTRACT:',
    input.abstract,
    '',
    'CANDIDATE ORIGINAL TARGETS (from rule-based extractor):',
    targetsBlock,
    '',
    'Answer the three questions and return JSON only.',
  ].join('\n');
}

function extractJson(raw: string): { parsed: LlmJsonOutput | null; error?: string } {
  if (!raw || typeof raw !== 'string') {
    return { parsed: null, error: 'empty response' };
  }
  // Try direct parse first
  try {
    return { parsed: JSON.parse(raw) as LlmJsonOutput };
  } catch {
    // fall through
  }
  // Try fenced ```json block
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { parsed: JSON.parse(fenced[1]) as LlmJsonOutput };
    } catch {
      // fall through
    }
  }
  // Try to find the first { ... } object
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return { parsed: JSON.parse(braceMatch[0]) as LlmJsonOutput };
    } catch (err: any) {
      return { parsed: null, error: `parse failed: ${err?.message || 'unknown'}` };
    }
  }
  return { parsed: null, error: 'no JSON object found in response' };
}

function deriveStatus(parsed: LlmJsonOutput): ExtractorStatus {
  const isRepl = (parsed.isReplication || '').toLowerCase();
  const outcome = (parsed.outcome || '').toLowerCase();
  if (isRepl === 'no') return 'rejected';
  if (isRepl === 'unclear') return 'ambiguous';
  if (isRepl === 'yes') {
    if (outcome === 'unknown' || !outcome) return 'needs_more_metadata';
    return 'accepted';
  }
  return 'ambiguous';
}

function quoteAppearsInAbstract(quote: string, abstract: string): boolean {
  if (!quote) return true; // empty quote always passes (nothing to verify)
  return abstract.toLowerCase().includes(quote.toLowerCase());
}

/**
 * Build a failed `VerificationResult` (never agreed, status unchanged). Hosts use it to report
 * that the verifier could not run (no provider, no key, quota) in a form the extractor and the
 * UI already understand.
 */
export function verificationFailure(args: {
  reason: string;
  model: string;
  rawJson?: unknown;
  inputStatus: ExtractorStatus;
  /** Build/version that produced this verdict; persisted as `verifierVersion`. */
  version: string;
}): VerificationResult {
  return {
    model: args.model,
    version: args.version,
    agreed: false,
    status: args.inputStatus,
    reason: args.reason,
    supportingQuote: '',
    rawJson: args.rawJson,
  };
}

/**
 * Sentinel model strings used to communicate routing failures back through the
 * VerificationResult.model field. The UI matches on these to render the right
 * recovery prompt (sign in / add a key / etc.) instead of the misleading
 * "verifier ran and disagreed" state.
 */
export const LLM_VERIFIER_SENTINELS = {
  NO_USER_ID: 'llm-verifier-no-user-id',
  NO_PROVIDER: 'llm-verifier-no-provider',
  NO_DB: 'llm-verifier-no-db',
} as const;

/** The prompt `createLlmVerifier` sends. Exported so a host that routes the call itself can send the same text. */
export function buildVerifierPrompt(input: VerifierInput): string {
  return buildPrompt(input);
}

/**
 * Parse a model answer into a `VerificationResult`, applying the verbatim-quote guard.
 * An unparseable answer becomes a failed result (see `verificationFailure`), never a throw.
 */
export function parseVerifierResponse(
  response: LlmResponse,
  input: VerifierInput,
  version: string,
): VerificationResult {
  return parseAndApply(response, input, version);
}

/**
 * Build a `VerifierPort` from a host-supplied model call. A thrown `callLlm` becomes a failed
 * result with reason `llm: error - <message>` and model `errorModel`, so one bad call never aborts a batch.
 */
export function createLlmVerifier(options: {
  callLlm: (prompt: string) => Promise<LlmResponse>;
  /** Build/version stamped on every result as `verifierVersion`. */
  version: string;
  /** `model` recorded when `callLlm` itself throws. Default `llm-callback`. */
  errorModel?: string;
}): VerifierPort {
  return async (input: VerifierInput): Promise<VerificationResult> => {
    const prompt = buildPrompt(input);
    let response: LlmResponse;
    try {
      response = await options.callLlm(prompt);
    } catch (err: any) {
      return verificationFailure({
        reason: `llm: error - ${err?.message || String(err)}`,
        model: options.errorModel ?? 'llm-callback',
        inputStatus: input.status,
        version: options.version,
      });
    }
    return parseAndApply(response, input, options.version);
  };
}

function parseAndApply(
  response: LlmResponse,
  input: VerifierInput,
  codeVersion: string,
): VerificationResult {
  const { parsed, error: parseError } = extractJson(response.content || '');
  if (!parsed) {
    return verificationFailure({
      reason: `llm: parse - ${parseError || 'unparseable'}`,
      model: response.model || response.provider || 'unknown',
      rawJson: response.content,
      inputStatus: input.status,
      version: codeVersion,
    });
  }

  const isRepl = (parsed.isReplication || '').toLowerCase();
  const outcome = (parsed.outcome || '').toLowerCase();
  const confidence = (parsed.confidence || '').toLowerCase();
  const llmReason = parsed.reason || '';
  let supportingQuote = parsed.supportingQuote || '';
  const llmStatus = deriveStatus(parsed);
  const model = response.model || response.provider || 'unknown';

  // Anti-hallucination guard: verify supportingQuote actually appears in abstract.
  let extraReason = '';
  if (supportingQuote && !quoteAppearsInAbstract(supportingQuote, input.abstract)) {
    supportingQuote = '';
    extraReason = ' (quote-not-in-source)';
  }

  // Special case: rejected (not-a-replication) — short reason, never agreed.
  if (isRepl === 'no') {
    return {
      model,
      version: codeVersion,
      agreed: false,
      status: 'rejected',
      reason: `llm: not-a-replication${llmReason ? ` - ${llmReason}` : ''}${extraReason}`,
      supportingQuote,
      rawJson: parsed,
    };
  }

  // Build short summary reason.
  const reasonParts: string[] = [`llm: outcome=${outcome || 'unknown'}`];
  if (confidence) reasonParts.push(`conf=${confidence}`);
  if (llmReason) reasonParts.push(llmReason);
  const reason = reasonParts.join(', ') + extraReason;

  // Determine agreement: rule-based status must align with LLM verdict.
  const agreed = input.status === llmStatus;

  return {
    model,
    version: codeVersion,
    agreed,
    status: llmStatus,
    reason,
    supportingQuote,
    rawJson: parsed,
  };
}
