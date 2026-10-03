import { describe, expect, it } from 'vitest'
import {
  jargonGlossesFor,
  prioritiseSeoActions,
  renderSeoWeeklyReport,
  SEO_FINDING_PRIORITY,
  SEO_REPORT_JARGON,
  SEO_REPORT_MAX_SENTENCE_WORDS,
  SEO_REPORT_READABILITY_EXEMPT,
  SEO_WEEKLY_ACTION_CAP,
  type SeoReportMetric,
  type SeoWeeklyAction,
  type SeoWeeklyReportInput,
  seoReportReadability,
} from './weekly-report.ts'

/**
 * The weekly report, over the two counts the acceptance criterion names and the prose rules.
 *
 * The assertion that earns its place is the THREE-finding one: a report that always finds five has a
 * floor rather than a finding, and padding is invisible to any test that only asks whether five rows
 * were rendered.
 */

const action = (kind: SeoWeeklyAction['kind'], n: number): SeoWeeklyAction => ({
  kind,
  finding: `Finding ${n} about ${kind}.`,
  expectedEffect:
    'More of the people who search for a massage near the Corniche should find this site.',
  humanAction: `Open the page and change the heading, step ${n}.`,
})

const METRICS: readonly SeoReportMetric[] = [
  {
    label: 'People who saw you in Google',
    value: '1,240',
    explanation: 'This counts every time one of your pages appeared in a result list.',
  },
  {
    label: 'People who clicked through',
    value: '61',
    explanation: 'This counts the ones who went on to open the site.',
  },
]

const HEARTBEAT = {
  lastSuccessAtIso: '2026-10-01T02:00:00.000Z',
  nextRunDueAtIso: '2026-10-08T02:00:00.000Z',
  costToDateFils: 4_350,
}

const inputWith = (overrides: Partial<SeoWeeklyReportInput> = {}): SeoWeeklyReportInput => ({
  weekEndingIso: '2026-10-02',
  findings: [],
  metrics: METRICS,
  heartbeat: HEARTBEAT,
  clicks: null,
  degradedBecause: null,
  maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS,
  ...overrides,
})

describe('the weekly SEO report', () => {
  it('renders exactly five actions from six findings, and says two words about the rest', () => {
    const six = [
      action('suggestion', 1),
      action('suggestion', 2),
      action('coverage', 3),
      action('gbp_inconsistency', 4),
      action('traffic_anomaly', 5),
      action('structured_data', 6),
    ]
    const report = renderSeoWeeklyReport(inputWith({ findings: six }))
    expect(report.actions.found).toBe(6)
    expect(report.actions.shown).toBe(SEO_WEEKLY_ACTION_CAP)
    expect(report.actions.withheld).toBe(1)
    expect(report.body).toContain('We found 6 things worth doing')
    expect(report.body).toContain('1 left for next week')
    // The order is the declared one, and the two suggestions are the ones held back — not the two that
    // happened to arrive last.
    expect(report.actions.actions.map((a) => a.kind)).toEqual([
      'gbp_inconsistency',
      'traffic_anomaly',
      'coverage',
      'structured_data',
      'suggestion',
    ])
    // `\n` on the front, because a metric line ending "61." contains "1. " and the first version of this
    // assertion passed for that reason rather than for the right one.
    expect(report.body).toContain('\n5. ')
    expect(report.body).not.toContain('\n6. ')
  })

  it('renders three from three and states the honest count rather than padding', () => {
    // THE case: five is a cap, not a floor. A report that reached five here would be padding, and
    // padding is invisible to a test that only counts rows.
    const three = [action('coverage', 1), action('suggestion', 2), action('site_structure', 3)]
    const report = renderSeoWeeklyReport(inputWith({ findings: three }))
    expect(report.actions.found).toBe(3)
    expect(report.actions.shown).toBe(3)
    expect(report.actions.withheld).toBe(0)
    expect(report.body).toContain('We found 3 things worth doing. That is all of them.')
    expect(report.body).not.toContain('left for next week')
    expect(report.body).toContain('\n3. ')
    expect(report.body).not.toContain('\n4. ')
  })

  it('says nothing needs doing when nothing was found, rather than printing an empty list', () => {
    const report = renderSeoWeeklyReport(inputWith())
    expect(report.actions.found).toBe(0)
    expect(report.body).toContain('Nothing needs doing this week')
    expect(report.body).not.toContain('\n1. ')
  })

  it('names the finding, the expected effect and the human action for every row', () => {
    const report = renderSeoWeeklyReport(inputWith({ findings: [action('coverage', 1)] }))
    expect(report.body).toContain('Finding 1 about coverage.')
    expect(report.body).toContain('What it should do:')
    expect(report.body).toContain('What you need to do:')
  })

  it('renders the click discrepancy when it is non-zero and omits it when it is zero', () => {
    const withGap = renderSeoWeeklyReport(
      inputWith({
        clicks: {
          queryClicks: 61,
          pageClicks: 74,
          queryImpressions: 1_100,
          pageImpressions: 1_240,
        },
      }),
    )
    expect(withGap.body).toContain('Search Console withholds 13 of these 74 clicks')

    // Both branches, which is what the acceptance line asks for. Equal totals mean there is nothing to
    // explain, and the dashboard's own "that is unusual" sentence belongs beside the query report rather
    // than in a five-action email.
    const noGap = renderSeoWeeklyReport(
      inputWith({
        clicks: {
          queryClicks: 74,
          pageClicks: 74,
          queryImpressions: 1_240,
          pageImpressions: 1_240,
        },
      }),
    )
    // `Search Console` and not `withholds`: `rareQueryGapExplanation` has a CONFIDENT sentence for a
    // window with nothing withheld ("That is unusual, and normal only for a short window…") which does
    // not contain the word. The first version of this assertion checked for `withholds` and passed with
    // the zero-case sentence rendered — gate case 172h is what found it.
    expect(noGap.body).not.toContain('Search Console')
    expect(noGap.body).not.toContain('That is unusual')

    // And a window with no snapshot at all is a third state, not the zero one.
    expect(renderSeoWeeklyReport(inputWith({ clicks: null })).body).not.toContain('Search Console')
  })

  it('states a degraded run in one plain sentence, and says nothing when the run was ordinary', () => {
    const degraded = renderSeoWeeklyReport(
      inputWith({ degradedBecause: 'the Google connection needs reconnecting.' }),
    )
    expect(degraded.body).toContain('come from the copy we keep, not from Google')
    expect(degraded.body).toContain('the Google connection needs reconnecting.')
    expect(degraded.body).toContain('The actions below still stand.')
    expect(renderSeoWeeklyReport(inputWith()).body).not.toContain('not from Google')
  })

  it('carries the heartbeat facts, and distinguishes never-succeeded from an instant', () => {
    const report = renderSeoWeeklyReport(inputWith())
    expect(report.body).toContain('last finished on 2026-10-01T02:00:00.000Z')
    expect(report.body).toContain('next one is due on 2026-10-08T02:00:00.000Z')
    expect(report.body).toContain('cost 43.50 AED so far')

    const never = renderSeoWeeklyReport(
      inputWith({
        heartbeat: { lastSuccessAtIso: null, nextRunDueAtIso: null, costToDateFils: 0 },
      }),
    )
    expect(never.body).toContain('never finished successfully yet')
    expect(never.body).toContain('no next run on the books')
    expect(never.body).toContain('cost 0.00 AED so far')
  })

  it('keeps every sentence inside the configured maximum', () => {
    const six = SEO_FINDING_PRIORITY.map((kind, index) => action(kind, index + 1))
    const report = renderSeoWeeklyReport(
      inputWith({
        findings: six,
        clicks: {
          queryClicks: 61,
          pageClicks: 74,
          queryImpressions: 1_100,
          pageImpressions: 1_240,
        },
        degradedBecause: 'the Google connection needs reconnecting.',
      }),
    )
    expect(
      seoReportReadability(report, {
        maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS,
        metrics: METRICS,
      }),
    ).toEqual([])
  })

  it('names only an exemption that is still needed', () => {
    // The exempted sentence must be PRESENT and must be OVER the maximum. The day somebody shortens
    // `rareQueryGapExplanation` this fails and the exemption is deleted deliberately, rather than
    // persisting as a permission nobody can see a reason for.
    const report = renderSeoWeeklyReport(
      inputWith({
        clicks: {
          queryClicks: 61,
          pageClicks: 74,
          queryImpressions: 1_100,
          pageImpressions: 1_240,
        },
      }),
    )
    for (const entry of SEO_REPORT_READABILITY_EXEMPT) {
      const sentence = report.body
        .split('\n')
        .flatMap((line) => line.split(/(?<=[.!?])\s+/))
        .find((candidate) => entry.matches.test(candidate.trim()))
      expect(
        sentence,
        `${entry.owner} is exempt and its sentence is no longer rendered`,
      ).toBeDefined()
      const words = (sentence ?? '').split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length
      expect(
        words,
        `${entry.owner} is exempt for being over the maximum and is now inside it. Delete the exemption.`,
      ).toBeGreaterThan(SEO_REPORT_MAX_SENTENCE_WORDS)
    }
  })

  it('reports a sentence over the maximum, so the check above is not vacuous', () => {
    const long = 'word '.repeat(SEO_REPORT_MAX_SENTENCE_WORDS + 1).trim()
    const findings = seoReportReadability(
      { body: `${long}.` },
      {
        maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS,
        metrics: [],
      },
    )
    expect(findings.map((finding) => finding.rule)).toEqual(['sentence_too_long'])
    // And the control: a sentence exactly at the maximum is permitted, or the rule is off by one.
    expect(
      seoReportReadability(
        { body: `${'word '.repeat(SEO_REPORT_MAX_SENTENCE_WORDS).trim()}.` },
        { maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS, metrics: [] },
      ),
    ).toEqual([])
  })

  it('reports a metric printed with no explanation', () => {
    const findings = seoReportReadability(
      { body: 'People who clicked through: 61.' },
      { maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS, metrics: METRICS },
    )
    expect(findings.map((finding) => finding.rule)).toEqual(['metric_without_explanation'])
  })

  it('reports a scope URL, SQL and a raw identifier', () => {
    for (const body of [
      'We read https://www.googleapis.com/auth/business.manage for this.',
      'We ran select clicks from seo_gsc_daily to get it.',
      'Your property is sc-domain:example.com.',
      'The listing is locations/fake-al-zahiyah-1.',
    ]) {
      const findings = seoReportReadability(
        { body },
        { maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS, metrics: [] },
      )
      expect(
        findings.map((f) => f.rule),
        body,
      ).toContain('forbidden_content')
    }
    // The control: an ordinary sentence of this report is not flagged, or every body would fail.
    expect(
      seoReportReadability(
        { body: 'We found 3 things worth doing. That is all of them.' },
        { maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS, metrics: [] },
      ),
    ).toEqual([])
  })

  it('reports a jargon term used with no line defining it, and glosses only what is said', () => {
    const findings = seoReportReadability(
      { body: 'Your CTR fell this week.' },
      { maxSentenceWords: SEO_REPORT_MAX_SENTENCE_WORDS, metrics: [] },
    )
    expect(findings.map((finding) => finding.rule)).toEqual(['jargon_without_gloss'])

    // Nothing is glossed that is not used: a glossary of six terms in a report that uses one is four
    // lines pushing the actions below the fold.
    expect(jargonGlossesFor('Your CTR fell this week.')).toEqual([SEO_REPORT_JARGON['CTR']])
    expect(jargonGlossesFor('Nothing needs doing this week.')).toEqual([])
  })

  it('refuses a cap of zero, which is a stopped agent rather than a quiet week', () => {
    expect(() => prioritiseSeoActions([], 0)).toThrow('at least one action')
    expect(() => prioritiseSeoActions([], 1.5)).toThrow('at least one action')
  })

  it('declares a priority order covering every finding kind exactly once', () => {
    // A kind missing from the order sorts to -1 and silently becomes the most urgent thing in the report.
    expect([...SEO_FINDING_PRIORITY].sort()).toEqual([...new Set(SEO_FINDING_PRIORITY)].sort())
    expect(SEO_FINDING_PRIORITY).toHaveLength(6)
  })
})
