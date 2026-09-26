import type { ClinicalReadRefusal, RenderedSubmission } from '@berelax/core'
import { CLINICAL_OPEN_QUESTIONS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type IntakePageView,
  renderIntakePageHtml,
} from '../app/(admin)/clients/[id]/intake/render.ts'

/**
 * The intake record screen (C-CRM-08).
 *
 * Asserted against the render function rather than a served page, because the claims are about what the
 * HTML contains and a pure render makes them checkable without a database, a key or a server. The one
 * claim a browser would add — that the page looks right — is the screenshot harness's.
 *
 * The subject throughout is **what must NOT be on the page**. A clinical screen is the one place where a
 * helpful partial render is a disclosure, so every case here has the shape "the payload value is absent"
 * with a control proving the same search finds it when it is present.
 */

const SENTINEL = 'SYNTHETIC-ANSWER-VALUE-9XJ2'

const rendered: RenderedSubmission = {
  templateId: '11111111-1111-1111-1111-111111111111',
  templateVersion: 3,
  answers: [
    {
      key: 'recent_surgery',
      label: 'Any surgery in the last six months?',
      kind: 'boolean',
      value: 'yes',
      missing: false,
    },
    {
      key: 'medication',
      label: 'Are you taking any medication?',
      kind: 'short_text',
      value: SENTINEL,
      missing: false,
    },
    {
      key: 'pressure',
      label: 'Preferred pressure',
      kind: 'choice',
      value: null,
      missing: true,
    },
  ],
  unknownKeys: ['smoker'],
}

const CUSTOMER = '0c8c8c08-0000-7000-8000-000000000001'

const view = (over: Partial<IntakePageView> = {}): IntakePageView => ({
  chrome: { googleReauth: null, returnTo: `/clients/${CUSTOMER}/intake` },
  customerId: CUSTOMER,
  outcome: {
    kind: 'record',
    rendered,
    grantId: '55555555-5555-5555-5555-555555555555',
    statedPurpose: 'checking contraindications before this appointment',
    templateTitle: 'Before your visit',
  },
  direction: 'ltr',
  realIntakePermitted: false,
  residencyQuestionId: CLINICAL_OPEN_QUESTIONS.residency,
  ...over,
})

const refused = (refusal: ClinicalReadRefusal): IntakePageView =>
  view({
    outcome: {
      kind: 'refused',
      refusal,
      because: 'the refusal sentence the store produced',
      submissionId: '77777777-7777-7777-7777-777777777777',
    },
  })

describe('the permitted render', () => {
  it('shows every answer under the CAPTURED version’s own label', () => {
    const html = renderIntakePageHtml(view())
    for (const answer of rendered.answers) expect(html).toContain(answer.label)
    expect(html).toContain('data-version="3"')
    expect(html).toContain('version 3 of this form')
  })

  it('marks an unanswered question rather than leaving it out', () => {
    const html = renderIntakePageHtml(view())
    expect(html).toContain('data-missing="true"')
    expect(html).toContain('not answered')
    // The control: an answered one is not marked missing.
    expect(html).toContain('data-key="recent_surgery"')
    expect(html).toContain('data-missing="false"')
  })

  it('names the keys of answers the captured version does not ask, and none of their values', () => {
    const html = renderIntakePageHtml(view())
    expect(html).toContain('data-unknown-keys="1"')
    expect(html).toContain('smoker')
    expect(html).toContain('a value is health data')
  })

  it('says which grant and which purpose opened it, so the page matches the audit row', () => {
    const html = renderIntakePageHtml(view())
    expect(html).toContain('data-grant="55555555-5555-5555-5555-555555555555"')
    expect(html).toContain('checking contraindications before this appointment')
    expect(html).toContain('on the audit trail')
  })

  it('labels the client by id and invents no name', () => {
    const html = renderIntakePageHtml(view())
    expect(html).toContain(`data-customer="${CUSTOMER}"`)
    expect(html).toContain(`Client ${CUSTOMER}`)
  })
})

describe('escaping', () => {
  /**
   * An intake answer is text a CLIENT typed, so it is the most obviously untrusted string on any admin
   * screen — and it is interpolated into a document. Asserted here rather than left to `safeText`'s own
   * tests, because the thing that breaks is a call site: somebody drops the wrapper while moving a line.
   */
  const INJECTION = '</dd><script>alert(1)</script>'

  const withInjection = (): IntakePageView =>
    view({
      outcome: {
        kind: 'record',
        rendered: {
          ...rendered,
          answers: [
            {
              key: 'medication',
              label: 'Are you taking any medication?',
              kind: 'short_text',
              value: INJECTION,
              missing: false,
            },
          ],
        },
        grantId: '55555555-5555-5555-5555-555555555555',
        statedPurpose: 'checking contraindications before this appointment',
        templateTitle: 'Before your visit',
      },
    })

  it('escapes an answer value, so a client cannot put markup on an admin screen', () => {
    const html = renderIntakePageHtml(withInjection())
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('</dd><script')
    // The control: the value IS on the page, escaped. Without it this passes for a render that drops the
    // answer entirely, which would be a different bug wearing the same green tick.
    expect(html).toContain('&lt;/dd&gt;&lt;script&gt;')
  })

  it('escapes a question LABEL too, which is copy an admin typed into a template', () => {
    const html = renderIntakePageHtml(
      view({
        outcome: {
          kind: 'record',
          rendered: {
            ...rendered,
            answers: [
              {
                key: 'k',
                label: '<img src=x onerror=alert(1)>',
                kind: 'short_text',
                value: 'ok',
                missing: false,
              },
            ],
          },
          grantId: '55555555-5555-5555-5555-555555555555',
          statedPurpose: 'p',
          templateTitle: 'Before your visit',
        },
      }),
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('escapes the template title and the customer id', () => {
    const html = renderIntakePageHtml(
      view({
        customerId: '"><b>x</b>',
        outcome: {
          kind: 'record',
          rendered,
          grantId: 'g',
          statedPurpose: 'p',
          templateTitle: '<b>title</b>',
        },
      }),
    )
    expect(html).not.toContain('<b>title</b>')
    expect(html).not.toContain('"><b>x</b>')
    expect(html).toContain('&lt;b&gt;title&lt;/b&gt;')
  })
})

describe('the refused render', () => {
  const REFUSALS: readonly ClinicalReadRefusal[] = [
    'clinical_consent_not_established',
    'clinical_consent_withdrawn',
    'clinical_step_up_required',
    'clinical_step_up_expired',
    'clinical_step_up_revoked',
    'clinical_step_up_purpose_mismatch',
    'clinical_read_purpose_not_stated',
  ]

  it('holds NO answer value and no label for any refusal', () => {
    // The assertion the whole screen exists for. A refused record renders nothing of the record — not a
    // redacted placeholder shaped like a value, and not a count of how many answers are hidden.
    for (const refusal of REFUSALS) {
      const html = renderIntakePageHtml(refused(refusal))
      expect(html, `${refusal} leaked a payload value`).not.toContain(SENTINEL)
      for (const answer of rendered.answers) {
        expect(html, `${refusal} leaked a question label`).not.toContain(answer.label)
      }
      expect(html).not.toContain('data-unknown-keys')
    }
  })

  it('control: the permitted render DOES contain the value the refused one must not', () => {
    // Without this, the case above is satisfied by a render that never shows an answer at all.
    expect(renderIntakePageHtml(view())).toContain(SENTINEL)
  })

  it('names the rule verbatim and gives a remedy for every refusal', () => {
    for (const refusal of REFUSALS) {
      const html = renderIntakePageHtml(refused(refusal))
      expect(html).toContain(`data-refusal="${refusal}"`)
      // The rule name appears as text too, so an operator can quote it and a reviewer can search for it.
      expect(html).toContain(`<p class="rule">${refusal}</p>`)
      expect(html).toContain('data-outcome="refused"')
    }
  })

  it('every refusal has a remedy of its own, not one sentence seven times', () => {
    const remedies = REFUSALS.map((refusal) => {
      const html = renderIntakePageHtml(refused(refusal))
      const match = /<p class="rule">[^<]*<\/p><p>([^<]*)<\/p>/.exec(html)
      return match?.[1] ?? ''
    })
    expect(remedies.filter((r) => r.length > 0)).toHaveLength(REFUSALS.length)
    expect(new Set(remedies).size).toBe(REFUSALS.length)
  })

  it('a consent refusal talks about consent and not about a second factor', () => {
    // The two have different remedies and sending somebody to re-authenticate over a record they may not
    // see at all is the specific confusion this separation exists to prevent.
    const html = renderIntakePageHtml(refused('clinical_consent_not_established'))
    expect(html).toContain('Take a consent from the client')
    expect(html).not.toContain('second factor')
  })
})

describe('the absent render', () => {
  it('says there is no form, and does not read as something being hidden', () => {
    const html = renderIntakePageHtml(view({ outcome: { kind: 'absent' } }))
    expect(html).toContain('data-outcome="absent"')
    expect(html).toContain('Nothing is wrong and nothing is hidden')
    expect(html).not.toContain('data-refusal')
    expect(html).not.toContain(SENTINEL)
  })

  it('the three outcomes are distinguishable by attribute, not only by prose', () => {
    const outcomes = [
      renderIntakePageHtml(view()),
      renderIntakePageHtml(refused('clinical_step_up_required')),
      renderIntakePageHtml(view({ outcome: { kind: 'absent' } })),
    ]
    const markers = outcomes.map((html) => /data-outcome="([a-z]+)"/.exec(html)?.[1])
    expect(markers).toEqual(['record', 'refused', 'absent'])
  })
})

describe('the Unconfirmed Assumptions panel on the page', () => {
  it('says the records are synthetic while Y5-residency is open, naming the question', () => {
    const html = renderIntakePageHtml(view())
    expect(html).toContain(`data-unconfirmed-assumption="${CLINICAL_OPEN_QUESTIONS.residency}"`)
    expect(html).toContain('Synthetic records only')
    expect(html).toContain('Y5-residency')
  })

  it('and stops saying it once real intake data is permitted', () => {
    // The control. A banner that could never disappear would be decoration, and the thing being asserted
    // is that the page reflects the setting rather than carrying a fixed sentence.
    const html = renderIntakePageHtml(view({ realIntakePermitted: true }))
    expect(html).not.toContain('Synthetic records only')
    expect(html).not.toContain('data-unconfirmed-assumption')
  })
})

describe('the document itself', () => {
  it('is noindex, is a full document, and mirrors on ?dir=rtl', () => {
    const html = renderIntakePageHtml(view())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).toContain('<html lang="en" dir="ltr">')
    expect(renderIntakePageHtml(view({ direction: 'rtl' }))).toContain('dir="rtl"')
  })

  it('carries the Google re-auth banner slot', () => {
    // `google-reauth-banner.test.ts` walks every admin document for the CALL; this asserts the rendered
    // result, so a call that produced nothing would still fail here.
    const html = renderIntakePageHtml(
      view({
        chrome: {
          // The real view shape, every field spelled out. A partial cast produced `undefined` where the
          // renderer escapes a string, and the failure named `escapeHtml` rather than the fixture.
          googleReauth: {
            state: 'broken',
            headline: 'The Google connection needs reconnecting',
            detail: 'Reconnect to keep review replies working.',
            dismissible: false,
            connectionId: '88888888-8888-8888-8888-888888888888',
            googleEmail: null,
          },
          returnTo: '/clients/x/intake',
        },
      }),
    )
    expect(html).toContain('data-google-reauth')
  })

  it('renders identically twice, so a screenshot is diffable', () => {
    expect(renderIntakePageHtml(view())).toBe(renderIntakePageHtml(view()))
  })

  it('holds no literal colour, only tokens', () => {
    // `pnpm colours` enforces this repository-wide; this is the same rule where it is cheapest to see.
    const html = renderIntakePageHtml(view())
    expect(/#[0-9a-f]{3,8}\b/i.test(html.slice(html.indexOf(INTAKE_STYLE_MARKER)))).toBe(false)
  })
})

/** Where the page's own stylesheet starts, after the token block which legitimately holds colours. */
const INTAKE_STYLE_MARKER = '*, *::before, *::after { box-sizing: border-box; }'
