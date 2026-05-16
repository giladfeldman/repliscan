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

const { resolveAuthorYearViaCrossref } = await import(
  '../../src/metadata/crossrefAuthorYearResolver.js'
);

function crossrefResponse(items: any[]) {
  return { data: { message: { items } } };
}

describe('resolveAuthorYearViaCrossref', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axiosMock.isAxiosError.mockImplementation((err: any) => Boolean(err?.isAxiosError || err?.response));
  });

  it('returns confident match when first-author + year + title overlap line up', async () => {
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1037/A0017824',
        title: ['Power Posing: Brief Nonverbal Displays Affect Hormonal Levels'],
        author: [{ given: 'Dana', family: 'Carney' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Psychological Science'],
      },
      {
        DOI: '10.9999/UNRELATED',
        title: ['Some other unrelated topic about gardening'],
        author: [{ given: 'X', family: 'Other' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Other Journal'],
      },
    ]));

    const result = await resolveAuthorYearViaCrossref({
      author: 'Carney et al.',
      year: 2010,
      replicationTitle: 'A replication of power posing hormonal changes',
    });

    expect(result.matched).toBe(true);
    expect(result.reason).toBe('confident-match');
    expect(result.doi).toBe('10.1037/a0017824');
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.score - result.runnerUpScore).toBeGreaterThanOrEqual(1);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].reasons.some((r) => r.startsWith('first-author-match'))).toBe(true);
  });

  it('returns below-threshold when only year matches', async () => {
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1234/year-only',
        title: ['Completely unrelated topic about marine biology'],
        author: [{ given: 'A', family: 'Different' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Marine Journal'],
      },
    ]));

    const result = await resolveAuthorYearViaCrossref({
      author: 'Carney et al.',
      year: 2010,
      replicationTitle: 'Power posing replication',
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toBe('below-threshold');
    expect(result.doi).toBeNull();
    expect(result.score).toBeLessThan(5);
  });

  it('returns ambiguous when top and runner-up are within 1 point', async () => {
    // Two candidates each scoring exactly 5 (author match +3, year exact +2).
    // Both need to NOT have a title overlap and NOT have replication penalty.
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1234/twin-a',
        title: ['Unrelated marine biology topic'],
        author: [{ given: 'D', family: 'Carney' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Journal A'],
      },
      {
        DOI: '10.1234/twin-b',
        title: ['Different unrelated chemistry topic'],
        author: [{ given: 'D', family: 'Carney' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Journal B'],
      },
    ]));

    const result = await resolveAuthorYearViaCrossref({
      author: 'Carney et al.',
      year: 2010,
      replicationTitle: 'Power posing brief nonverbal',
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toBe('ambiguous');
    expect(result.score).toBe(result.runnerUpScore);
    expect(result.score).toBeGreaterThanOrEqual(5);
  });

  it('returns no-candidates when Crossref returns empty items', async () => {
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([]));

    const result = await resolveAuthorYearViaCrossref({
      author: 'Nobody',
      year: 2010,
      replicationTitle: 'Anything',
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toBe('no-candidates');
    expect(result.candidates).toEqual([]);
  });

  it('returns provider-error when Crossref throws (does not propagate)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    axiosMock.get.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        isAxiosError: true,
        response: { status: 503 },
      }),
    );

    const result = await resolveAuthorYearViaCrossref({
      author: 'Smith',
      year: 2015,
      replicationTitle: 'something',
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toBe('provider-error');
    expect(result.doi).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('lowercases the DOI returned by Crossref via cleanDoi', async () => {
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1037/X.Y.Z',
        title: ['Power Posing Brief Nonverbal Hormonal'],
        author: [{ given: 'D', family: 'Carney' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Psych Science'],
      },
    ]));

    const result = await resolveAuthorYearViaCrossref({
      author: 'Carney',
      year: 2010,
      replicationTitle: 'Power posing hormonal nonverbal',
    });

    expect(result.matched).toBe(true);
    expect(result.doi).toBe('10.1037/x.y.z');
  });

  it('parses author last name correctly across mention formats', async () => {
    // "Carney et al." -> "Carney" should match family "Carney"
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1234/match',
        title: ['Power Posing Brief Nonverbal Hormonal Behavioral'],
        author: [{ given: 'D', family: 'Carney' }],
        issued: { 'date-parts': [[2010]] },
        'container-title': ['Psych Science'],
      },
    ]));
    // Note: lastNameOf matches the .mjs script exactly — it strips "et al." but
    // does NOT strip a trailing "(YYYY)" paren. Mentions are expected to be
    // pre-cleaned (year is stored separately on the AuthorYearMention).
    const r1 = await resolveAuthorYearViaCrossref({
      author: 'Carney et al.',
      year: 2010,
      replicationTitle: 'Power posing hormonal nonverbal',
    });
    expect(r1.candidates[0].reasons).toContain('first-author-match:carney');

    // "van der Berg, Jones, & Smith" -> "Berg" (last token of first comma-split).
    // Confirm that it MATCHES family "Berg" and NOT family "Smith".
    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1234/berg',
        title: ['Cognitive load and decision making'],
        author: [{ given: 'P', family: 'Berg' }],
        issued: { 'date-parts': [[2018]] },
        'container-title': ['JEP'],
      },
    ]));
    const r2 = await resolveAuthorYearViaCrossref({
      author: 'van der Berg, Jones, & Smith',
      year: 2018,
      replicationTitle: 'cognitive load decision making',
    });
    expect(r2.candidates[0].reasons.some((r) => r.startsWith('first-author-match:berg'))).toBe(true);

    axiosMock.get.mockResolvedValueOnce(crossrefResponse([
      {
        DOI: '10.1234/smith',
        title: ['Cognitive load and decision making'],
        author: [{ given: 'J', family: 'Smith' }],
        issued: { 'date-parts': [[2018]] },
        'container-title': ['JEP'],
      },
    ]));
    const r3 = await resolveAuthorYearViaCrossref({
      author: 'van der Berg, Jones, & Smith',
      year: 2018,
      replicationTitle: 'cognitive load decision making',
    });
    // 'berg' is not contained in 'smith', so no first-author-match or partial.
    expect(r3.candidates[0].reasons.some((r) => r.startsWith('first-author-match'))).toBe(false);
  });
});
