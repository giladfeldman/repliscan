import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const getCitingWorks = jest.fn<any>();
jest.unstable_mockModule('../../src/metadata/openAlexClient.js', () => ({ getCitingWorks }));
jest.unstable_mockModule('../../src/metadata/metadataResolver.js', () => ({
  resolveWork: jest.fn<any>().mockResolvedValue(null),
  resolveWorkDetailed: jest.fn<any>().mockResolvedValue({ work: null, sourcesQueried: ['openalex'], providerReports: [] }),
}));

const { runCli, credentialsFromEnv, CLI_USAGE } = await import('../../src/cli/main.js');
const { loadBundledFred } = await import('../../src/fred/bundled.js');
const { libraryVersion } = await import('../../src/util/libraryVersion.js');

function io(argv: string[], env: Record<string, string | undefined> = {}, stdin = '') {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { argv, env, stdin: async () => stdin, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
}

describe('repliscan command line', () => {
  beforeEach(() => { getCitingWorks.mockReset(); getCitingWorks.mockResolvedValue({ targetWorkId: null, candidates: [] }); });

  it('prints usage and exits 0 for --help and for no arguments', async () => {
    for (const argv of [['--help'], []]) {
      const r = io(argv);
      expect(await runCli(r.io)).toBe(0);
      expect(r.out.join('')).toBe(CLI_USAGE);
    }
  });

  it('looks a DOI up in the bundled FReD without any network access', async () => {
    const db = loadBundledFred();
    const doi = Object.keys(db.byDoi)[0];
    const r = io(['fred', '--doi', `https://doi.org/${doi.toUpperCase()}`]);
    expect(await runCli(r.io)).toBe(0);
    const body = JSON.parse(r.out.join(''));
    expect(body.command).toBe('fred');
    expect(body.libraryVersion).toBe(libraryVersion());
    expect(body.result.found).toBe(true);
    expect(body.result.hit.metadata.replicationCount).toBe(db.byDoi[doi].replications.length);
    expect(body.result.hit.metadata.source).toBe('FReD');
    expect(getCitingWorks).not.toHaveBeenCalled();
  });

  it('reports found:false for a paper FReD does not know', async () => {
    const r = io(['fred', '--doi', '10.5555/not-in-fred']);
    expect(await runCli(r.io)).toBe(0);
    expect(JSON.parse(r.out.join('')).result).toEqual({ found: false, hit: null });
  });

  it('passes credentials from the environment to the network commands', async () => {
    const r = io(['replications', '--doi', '10.5555/x.1'], { OPENALEX_API_KEY: 'k', OPENALEX_MAILTO: 'me@example.test' });
    expect(await runCli(r.io)).toBe(0);
    expect(getCitingWorks).toHaveBeenCalledWith('10.5555/x.1', 50, expect.objectContaining({ openAlexApiKey: 'k', openAlexMailto: 'me@example.test' }));
    expect(JSON.parse(r.out.join('')).result).toEqual({ originalDoi: '10.5555/x.1', targets: [] });
  });

  it('extract emits records, or CSV with --format csv', async () => {
    const j = io(['extract', '--doi', '10.5555/unknown.1']);
    expect(await runCli(j.io)).toBe(0);
    const rec = JSON.parse(j.out.join('')).result.records[0];
    expect(rec.status).toBe('needs_more_metadata');
    expect(rec.unresolvedReason).toBe('doi_not_found_in_metadata_providers');
    expect(rec.codeVersion).toBe(`repliscan@${libraryVersion()}`);
    const c = io(['extract', '--doi', '10.5555/unknown.1', '--format', 'csv']);
    expect(await runCli(c.io)).toBe(0);
    expect(JSON.parse(c.out.join('')).result.csv.split('\n')[0]).toMatch(/^inputDoi,normalizedDoi,status/);
  });

  it('reads one request from stdin', async () => {
    const r = io(['--stdin'], {}, JSON.stringify({ command: 'fred', doi: '10.5555/not-in-fred' }));
    expect(await runCli(r.io)).toBe(0);
    expect(JSON.parse(r.out.join('')).result.found).toBe(false);
  });

  it.each([
    [['bogus', '--doi', 'x'], 'unknown command'],
    [['fred'], '--doi is required'],
    [['fred', '--doi', 'x', '--nope'], 'unknown option'],
    [['extract', '--doi', 'x', '--format', 'xml'], '--format must be'],
  ])('rejects bad arguments %j with exit 1 and a JSON error', async (argv, message) => {
    const r = io(argv as string[]);
    expect(await runCli(r.io)).toBe(1);
    expect(r.out).toEqual([]);
    expect(JSON.parse(r.err.join('')).error).toContain(message);
  });

  it('rejects malformed stdin with exit 1', async () => {
    for (const text of ['not json', '[]', JSON.stringify({ command: 'fred' }), JSON.stringify({ command: 'zzz', doi: 'x' })]) {
      const r = io(['--stdin'], {}, text);
      expect(await runCli(r.io)).toBe(1);
      expect(JSON.parse(r.err.join('')).error).toBeTruthy();
    }
  });

  it('turns a thrown pipeline error into a JSON error and exit 1, never a stack trace', async () => {
    getCitingWorks.mockRejectedValue(new Error('network down'));
    const r = io(['replications', '--doi', '10.5555/x.1']);
    expect(await runCli(r.io)).toBe(1);
    expect(JSON.parse(r.err.join(''))).toMatchObject({ error: 'network down', command: 'replications' });
  });

  it('credentialsFromEnv accepts S2_API_KEY as the Semantic Scholar key', () => {
    expect(credentialsFromEnv({ S2_API_KEY: 's2' }).semanticScholarApiKey).toBe('s2');
    expect(credentialsFromEnv({}).openAlexMailto).toBeUndefined();
  });
});
