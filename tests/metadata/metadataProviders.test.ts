import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosMock = {
  get: jest.fn<any>(),
  post: jest.fn<any>(),
  head: jest.fn<any>(),
  isAxiosError: jest.fn<any>(),
};

jest.unstable_mockModule('axios', () => ({
  default: axiosMock,
  isAxiosError: axiosMock.isAxiosError,
}));

const { crossrefProvider } = await import('../../src/metadata/crossrefProvider.js');
const { dataCiteProvider } = await import('../../src/metadata/dataCiteProvider.js');
const { doiOrgProvider } = await import('../../src/metadata/doiOrgProvider.js');
const { semanticScholarProvider } = await import('../../src/metadata/semanticScholarProvider.js');
const { openCitationsProvider } = await import('../../src/metadata/openCitationsProvider.js');
const { resolveWork } = await import('../../src/metadata/metadataResolver.js');

describe('replication metadata providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axiosMock.isAxiosError.mockImplementation((err: any) => Boolean(err?.isAxiosError || err?.response));
  });

  it('maps Crossref work metadata and DOI references', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: {
        message: {
          DOI: '10.1234/repl',
          title: ['A direct replication of Smith et al. (2015)'],
          author: [{ given: 'Rita', family: 'Replica' }],
          'container-title': ['Journal of Replications'],
          published: { 'date-parts': [[2020, 1, 2]] },
          abstract: '<jats:p>We failed to replicate Smith.</jats:p>',
          reference: [{
            DOI: '10.1234/original',
            author: 'Smith J',
            year: '2015',
            'article-title': 'Original study',
            'journal-title': 'Original Journal',
          }],
        },
      },
    });

    const result = await crossrefProvider.getWork('10.1234/repl');
    expect(result.report.status).toBe('found');
    expect(result.work?.authors).toBe('Rita Replica');
    expect(result.work?.abstract).toBe('We failed to replicate Smith.');
    expect(result.work?.referencedWorks[0]).toMatchObject({
      doi: '10.1234/original',
      firstAuthor: 'Smith',
      source: 'crossref',
    });
  });

  it('maps DataCite metadata and Cites relations without publisher-page scraping', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: {
        data: {
          attributes: {
            doi: '10.5061/dryad.repl',
            titles: [{ title: 'Replication dataset' }],
            creators: [{ givenName: 'Dana', familyName: 'Curator' }],
            publisher: 'DataCite Repository',
            publicationYear: 2021,
            descriptions: [{ descriptionType: 'Abstract', description: '<p>Replication materials.</p>' }],
            relatedIdentifiers: [{
              relationType: 'Cites',
              relatedIdentifierType: 'DOI',
              relatedIdentifier: 'https://doi.org/10.1234/original',
            }],
          },
        },
      },
    });

    const result = await dataCiteProvider.getWork('10.5061/dryad.repl');
    expect(result.report.status).toBe('found');
    expect(result.work?.venue).toBe('DataCite Repository');
    expect(result.work?.referencedWorks[0]).toMatchObject({
      doi: '10.1234/original',
      source: 'datacite',
    });
  });

  it('maps DOI.org content-negotiated CSL metadata and marks missing references', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: {
        DOI: '10.1234/repl',
        title: 'A replication study',
        author: [{ given: 'Rita', family: 'Replica' }],
        'container-title': 'Example Journal',
        issued: { 'date-parts': [[2022]] },
      },
    });

    const result = await doiOrgProvider.getWork('10.1234/repl');
    expect(result.report.status).toBe('missing_references');
    expect(result.work).toMatchObject({
      doi: '10.1234/repl',
      title: 'A replication study',
      authors: 'Rita Replica',
      year: 2022,
    });
  });

  it('maps Semantic Scholar references and distinguishes rate limits', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: {
        externalIds: { DOI: '10.1234/repl' },
        title: 'A replication of Smith (2015)',
        authors: [{ name: 'Rita Replica' }],
        venue: 'S2 Venue',
        year: 2023,
        abstract: 'We replicated Smith (2015).',
        references: [{
          externalIds: { DOI: '10.1234/original' },
          title: 'Original',
          authors: [{ name: 'Jane Smith' }],
          year: 2015,
          venue: 'Original Venue',
        }],
      },
    });

    const found = await semanticScholarProvider.getWork('10.1234/repl');
    expect(found.report.status).toBe('found');
    expect(found.work?.referencedWorks[0]).toMatchObject({
      doi: '10.1234/original',
      firstAuthor: 'Smith',
      source: 'semantic-scholar',
    });

    axiosMock.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429 } });
    const limited = await semanticScholarProvider.getWork('10.1234/repl');
    expect(limited.report.status).toBe('rate_limited');
  });

  it('maps OpenCitations metadata and DOI references', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: [{
        id: 'doi:10.1234/repl openalex:W4246265603 omid:br/0638037894',
        title: 'A direct replication of Smith et al. (2015)',
        author: 'Replica, Rita [orcid:0000-0001-2345-6789]; Co, Author [omid:ra/0610116094]',
        pub_date: '2020',
        venue: 'Journal Of Replications [issn:1234-5678 omid:br/0611018657]',
        type: 'journal article',
      }],
    });
    axiosMock.get.mockResolvedValueOnce({
      data: [
        { cited: 'doi:10.1234/original omid:br/0612345678', oci: '02001-02002' },
        { cited: 'doi:10.5678/Other omid:br/0612345679', oci: '02001-02003' },
        { cited: 'omid:br/0612345680', oci: '02001-02004' },
      ],
    });

    const result = await openCitationsProvider.getWork('10.1234/repl');
    expect(result.report.status).toBe('found');
    expect(result.work?.title).toBe('A direct replication of Smith et al. (2015)');
    expect(result.work?.authors).toBe('Rita Replica, Author Co');
    expect(result.work?.venue).toBe('Journal Of Replications');
    expect(result.work?.year).toBe(2020);
    expect(result.work?.abstract).toBe('');
    expect(result.work?.doi).toBe('10.1234/repl');
    expect(result.work?.referencedWorks).toHaveLength(2);
    expect(result.work?.referencedWorks[0]).toMatchObject({
      doi: '10.1234/original',
      source: 'opencitations',
    });
    expect(result.work?.referencedWorks[1].doi).toBe('10.5678/other');
  });

  it('OpenCitations returns sparse_metadata when metadata payload is empty', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: [] });
    const result = await openCitationsProvider.getWork('10.1234/missing');
    expect(result.report.status).toBe('sparse_metadata');
    expect(result.work).toBeNull();
  });

  it('OpenCitations surfaces 404 from metadata as not_found', async () => {
    axiosMock.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    const result = await openCitationsProvider.getWork('10.1234/missing');
    expect(result.report.status).toBe('not_found');
    expect(result.work).toBeNull();
  });

  it('merges provider fields with source provenance', async () => {
    const providers = [
      {
        name: 'openalex' as const,
        getWork: jest.fn<any>().mockResolvedValue({
          provider: 'openalex',
          report: { provider: 'openalex', status: 'missing_references' },
          work: {
            doi: '10.1234/repl',
            title: 'A replication of Smith (2015)',
            authors: '',
            venue: '',
            year: null,
            abstract: 'We failed to replicate Smith (2015).',
            referencedWorks: [],
          },
        }),
      },
      {
        name: 'crossref' as const,
        getWork: jest.fn<any>().mockResolvedValue({
          provider: 'crossref',
          report: { provider: 'crossref', status: 'found' },
          work: {
            doi: '10.1234/repl',
            title: '',
            authors: 'Rita Replica',
            venue: 'Journal of Replications',
            year: 2020,
            abstract: '',
            referencedWorks: [{
              openalexId: '',
              doi: '10.1234/original',
              firstAuthor: 'Smith',
              year: 2015,
              source: 'crossref',
            }],
          },
        }),
      },
    ];

    const work = await resolveWork('10.1234/repl', providers);
    expect(work?.title).toBe('A replication of Smith (2015)');
    expect(work?.authors).toBe('Rita Replica');
    expect(work?.referencedWorks[0].doi).toBe('10.1234/original');
    expect(work?.fieldProvenance.title).toEqual(['openalex']);
    expect(work?.fieldProvenance.authors).toEqual(['crossref']);
    expect(work?.fieldProvenance.referencedWorks).toEqual(['crossref']);
  });
});
