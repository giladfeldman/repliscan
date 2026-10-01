/**
 * FReD / FLoRA lookup -- pure functions over the FORRT FReD replication database
 * (https://github.com/forrtproject/FReD-data, CC-BY-4.0; see NOTICE). The bundled
 * snapshot loader lives in ./bundled.ts so these stay free of file-system access.
 */

import { normalizeLookupDoi as normalizeDoi } from '../util/lookupDoi.js';

export interface FloraReplication {
  doi: string;
  title: string;
  authors: string;
  journal: string;
  year: number | null;
  outcome: string;
  outcomeQuote: string;
  type: string;
  source: string;
}

export interface FloraOriginal {
  title: string;
  authors: string;
  journal: string;
  year: number | null;
  replications: FloraReplication[];
}

export interface FloraDatabase {
  version: string;
  lastUpdated: string;
  source: string;
  license: string;
  totalOriginals: number;
  totalEntries: number;
  byDoi: Record<string, FloraOriginal>;
}

export interface FloraReplicationDetail {
  doi: string;
  title?: string;
  authors?: string;
  journal?: string;
  year?: number;
  outcome: string;
  outcomeType: 'successful' | 'failed' | 'partial' | 'unknown';
  outcomeQuote?: string;
  type?: string;
  projectSource?: string;
}

/**
 * Map a FLoRA outcome string to a normalized type and severity.
 */
export function mapFloraOutcome(outcome: string): {
  type: 'successful' | 'failed' | 'partial' | 'unknown';
  severity: 'warning' | 'info';
} {
  const o = (outcome || '').toLowerCase().trim();
  if (o === 'successful') {
    return { type: 'successful', severity: 'info' };
  }
  if (o === 'failed') {
    return { type: 'failed', severity: 'warning' };
  }
  if (o === 'mixed') {
    return { type: 'partial', severity: 'warning' };
  }
  if (o.includes('flawed') || o.includes('challenges') || o.includes('issues')) {
    return { type: 'partial', severity: 'warning' };
  }
  return { type: 'unknown', severity: 'info' };
}

// Priority order for worst-case aggregation: failed > partial > unknown > successful
const OUTCOME_PRIORITY: Record<string, number> = {
  failed: 3,
  partial: 2,
  unknown: 1,
  successful: 0,
};

/**
 * Aggregate multiple replication outcomes to worst-case.
 */
export function aggregateOutcome(
  outcomes: Array<'successful' | 'failed' | 'partial' | 'unknown'>
): 'successful' | 'failed' | 'partial' | 'unknown' {
  if (outcomes.length === 0) return 'unknown';
  let worst: 'successful' | 'failed' | 'partial' | 'unknown' = outcomes[0];
  for (const o of outcomes) {
    if ((OUTCOME_PRIORITY[o] ?? 0) > (OUTCOME_PRIORITY[worst] ?? 0)) {
      worst = o;
    }
  }
  return worst;
}

/**
 * Look up a DOI in the FLoRA database and return a ReplicationIssue-compatible object,
 * or null if not found.
 */
export function checkFloraReplications(
  doi: string,
  floraData: FloraDatabase
): {
  type: 'replication-status';
  severity: 'warning' | 'info';
  code: string;
  description: string;
  location: string;
  suggestion: string;
  metadata: {
    doi: string;
    replicationType: 'successful' | 'failed' | 'partial' | 'unknown';
    replicationCount: number;
    replicationDOIs: string[];
    source: string;
    determinationMethod: string;
    floraDataVersion: string;
    replicationDetails: FloraReplicationDetail[];
  };
} | null {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  const entry = floraData.byDoi[normalized];
  if (!entry) return null;

  const details: FloraReplicationDetail[] = entry.replications.map(rep => {
    const mapped = mapFloraOutcome(rep.outcome);
    return {
      doi: rep.doi,
      title: rep.title || undefined,
      authors: rep.authors || undefined,
      journal: rep.journal || undefined,
      year: rep.year ?? undefined,
      outcome: rep.outcome,
      outcomeType: mapped.type,
      outcomeQuote: rep.outcomeQuote || undefined,
      type: rep.type || undefined,
      projectSource: rep.source || undefined,
    };
  });

  const outcomeTypes = details.map(d => d.outcomeType);
  const aggregated = aggregateOutcome(outcomeTypes);
  const severity = aggregated === 'failed' || aggregated === 'partial' ? 'warning' : 'info';

  const replicationDOIs = details.map(d => d.doi).filter(Boolean);

  const outcomeLabel = aggregated === 'partial' ? 'mixed' : aggregated;
  const description = `${details.length} replication study/studies found (${outcomeLabel}) - FReD curated database`;

  return {
    type: 'replication-status',
    severity,
    code: 'REPLICATION_FOUND',
    description,
    location: doi,
    suggestion: 'Review the replication studies to understand reproduction outcomes',
    metadata: {
      doi,
      replicationType: aggregated,
      replicationCount: details.length,
      replicationDOIs,
      source: 'FReD',
      determinationMethod: 'FReD curated dataset',
      floraDataVersion: floraData.version,
      replicationDetails: details,
    },
  };
}

/**
 * Parse FLoRA CSV text and build an indexed database.
 * Shared between the conversion script and runtime refresh.
 */
export function parseAndIndexFloraCsv(csvText: string): FloraDatabase {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return {
      version: '1.0.0', // version-ok: FLoRA data-schema version, not the product version
      lastUpdated: new Date().toISOString().slice(0, 10),
      source: 'FORRT FReD (FLoRA)',
      license: 'MIT',
      totalOriginals: 0,
      totalEntries: 0,
      byDoi: {},
    };
  }

  const headers = rows[0];
  const byDoi: Record<string, FloraOriginal> = {};
  let totalEntries = 0;

  for (let r = 1; r < rows.length; r++) {
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = rows[r][c] || '';
    }

    const doiO = normalizeDoi(row.doi_o);
    if (!doiO) continue;
    totalEntries++;

    if (!byDoi[doiO]) {
      byDoi[doiO] = {
        title: row.title_o || '',
        authors: parseAuthorField(row.author_o),
        journal: row.journal_o || '',
        year: parseYear(row.year_o),
        replications: [],
      };
    }

    byDoi[doiO].replications.push({
      doi: normalizeDoi(row.doi_r),
      title: row.title_r || '',
      authors: parseAuthorField(row.author_r),
      journal: row.journal_r || '',
      year: parseYear(row.year_r),
      outcome: (row.outcome || '').trim().toLowerCase(),
      outcomeQuote: (row.outcome_quote || '').trim(),
      type: (row.type || '').trim().toLowerCase(),
      source: (row.source || '').trim(),
    });
  }

  return {
    version: '1.0.0', // version-ok: FLoRA data-schema version, not the product version
    lastUpdated: new Date().toISOString().slice(0, 10),
    source: 'FORRT FReD (FLoRA)',
    license: 'MIT',
    totalOriginals: Object.keys(byDoi).length,
    totalEntries,
    byDoi,
  };
}

function parseAuthorField(field: string): string {
  if (!field) return '';
  try {
    const authors = JSON.parse(field);
    if (Array.isArray(authors) && authors.length > 0) {
      const first = authors[0];
      let name = ((first.given || '') + ' ' + (first.family || '')).trim();
      if (authors.length > 1) name += ' et al.';
      return name;
    }
  } catch { /* not JSON, return raw */ }
  return field;
}

function parseYear(val: string): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/**
 * Simple RFC 4180 CSV parser that handles quoted fields with embedded commas,
 * newlines, and escaped quotes.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  // Skip BOM
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        i++; // skip opening quote
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (i + 1 < text.length && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === ',') {
        i++;
      } else {
        break;
      }
    }
    if (i < text.length && text[i] === '\r') i++;
    if (i < text.length && text[i] === '\n') i++;
    if (row.length > 1 || (row.length === 1 && row[0].trim())) {
      rows.push(row);
    }
  }
  return rows;
}
