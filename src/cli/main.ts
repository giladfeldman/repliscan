import type { MetadataCredentials } from '../metadata/credentials.js';
import { loadBundledFred } from '../fred/bundled.js';
import { checkFloraReplications } from '../fred/floraLookup.js';
import { findReplicationsForDoi } from '../pipeline/forward.js';
import { extractReplication } from '../pipeline/reverse.js';
import { extractReplicationStandalone, recordsToCsv } from '../pipeline/standalone.js';
import { libraryVersion } from '../util/libraryVersion.js';

/** Everything the command line needs from its surroundings; tests pass fakes. */
export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const COMMANDS = ['fred', 'replications', 'targets', 'extract'] as const;
type Command = typeof COMMANDS[number];

export const CLI_USAGE = `repliscan <command> --doi <doi> [options]

Commands
  fred           look the paper up in the bundled FReD database (offline)
  replications   find replications OF this paper (FReD + citation graph; network)
  targets        is this paper a replication, and of what? (network)
  extract        full per-target record for a replication paper (network); --format json|csv

Options
  --doi <doi>                    the paper's DOI (a doi.org URL or doi: prefix is accepted)
  --format json|csv              extract only; default json
  --crossref-author-year         extract only: enable the Crossref author-year fallback
  --stdin                        read one JSON request {"command": "...", "doi": "..."} from stdin
  --help                         this text

Environment (network commands): OPENALEX_API_KEY, OPENALEX_MAILTO (your contact email for the
polite pool), SEMANTIC_SCHOLAR_API_KEY, OPENCITATIONS_BASE_URL, OPENCITATIONS_ACCESS_TOKEN.
Output is one JSON object on stdout; errors are one JSON object on stderr with exit code 1.
`;

export function credentialsFromEnv(env: Record<string, string | undefined>): MetadataCredentials {
  return {
    openAlexApiKey: env.OPENALEX_API_KEY,
    openAlexMailto: env.OPENALEX_MAILTO,
    semanticScholarApiKey: env.SEMANTIC_SCHOLAR_API_KEY || env.S2_API_KEY,
    openCitationsBaseUrl: env.OPENCITATIONS_BASE_URL,
    openCitationsAccessToken: env.OPENCITATIONS_ACCESS_TOKEN,
  };
}

interface Request { command: Command; doi: string; format: 'json' | 'csv'; crossrefAuthorYear: boolean }

function parseArgs(argv: string[]): { request?: Request; stdin?: true; help?: true; error?: string } {
  const args = argv.slice();
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.includes('--stdin')) return { stdin: true };
  const command = args.shift() as Command;
  if (!COMMANDS.includes(command)) return { error: `unknown command "${command}"` };
  let doi = ''; let format: 'json' | 'csv' = 'json'; let crossrefAuthorYear = false;
  while (args.length) {
    const a = args.shift()!;
    if (a === '--doi') doi = args.shift() ?? '';
    else if (a === '--format') { const f = args.shift(); if (f !== 'json' && f !== 'csv') return { error: '--format must be json or csv' }; format = f; }
    else if (a === '--crossref-author-year') crossrefAuthorYear = true;
    else return { error: `unknown option "${a}"` };
  }
  if (!doi) return { error: '--doi is required' };
  return { request: { command, doi, format, crossrefAuthorYear } };
}

function parseStdinRequest(text: string): { request?: Request; error?: string } {
  let obj: any;
  try { obj = JSON.parse(text); } catch { return { error: 'stdin is not valid JSON' }; }
  if (!obj || typeof obj !== 'object') return { error: 'stdin must be a JSON object' };
  if (!COMMANDS.includes(obj.command)) return { error: `unknown command "${obj.command}"` };
  if (typeof obj.doi !== 'string' || !obj.doi) return { error: '"doi" is required' };
  const format = obj.format === 'csv' ? 'csv' : 'json';
  return { request: { command: obj.command, doi: obj.doi, format, crossrefAuthorYear: obj.crossrefAuthorYear === true } };
}

async function execute(req: Request, env: CliIo['env']): Promise<unknown> {
  const credentials = credentialsFromEnv(env);
  switch (req.command) {
    case 'fred': {
      const hit = checkFloraReplications(req.doi, loadBundledFred());
      return { found: hit !== null, hit };
    }
    case 'replications': {
      const floraHit = checkFloraReplications(req.doi, loadBundledFred());
      return findReplicationsForDoi(req.doi, { floraHit, credentials });
    }
    case 'targets':
      return extractReplication(req.doi);
    case 'extract': {
      const records = await extractReplicationStandalone(req.doi, {
        credentials,
        enableCrossrefAuthorYearFallback: req.crossrefAuthorYear,
      });
      return req.format === 'csv' ? { csv: recordsToCsv(records) } : { records };
    }
  }
}

/** Run the command line. Returns the process exit code; never throws. */
export async function runCli(io: CliIo): Promise<number> {
  const parsed = parseArgs(io.argv);
  if (parsed.help) { io.stdout(CLI_USAGE); return 0; }
  let request = parsed.request;
  let error = parsed.error;
  if (parsed.stdin) {
    const s = parseStdinRequest(await io.stdin());
    request = s.request; error = s.error;
  }
  if (error || !request) {
    io.stderr(JSON.stringify({ error: error ?? 'no request', usage: 'repliscan --help' }) + '\n');
    return 1;
  }
  try {
    const result = await execute(request, io.env);
    io.stdout(JSON.stringify({ command: request.command, doi: request.doi, libraryVersion: libraryVersion(), result }) + '\n');
    return 0;
  } catch (err) {
    io.stderr(JSON.stringify({ error: (err as Error)?.message ?? String(err), command: request.command, doi: request.doi }) + '\n');
    return 1;
  }
}
