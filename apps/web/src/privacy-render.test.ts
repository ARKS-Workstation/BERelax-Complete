import { describe, expect, it } from 'vitest'
import { type PrivacyPageView, renderPrivacyHtml } from '../app/(admin)/settings/privacy/render.ts'

/**
 * The privacy screen's document (C-CRM-10). Pure: a view in, HTML out.
 *
 * The claims worth testing here are the ones a reader of the page would act on, and each is paired with the
 * mutation that would make the page WRONG WHILE STILL LOOKING RIGHT — which is the only interesting failure
 * a rendered surface has. A page that lost its withheld-response notice still renders every heading, every
 * class and every retention; nothing about it looks broken; and the first person to read it concludes the
 * business can answer a data subject in writing.
 */

const BASE: PrivacyPageView = {
  chrome: { googleReauth: null, sendBacklog: null, returnTo: '/settings/privacy' },
  readAtIso: '2099-06-02T09:00:00.000Z',
  slaDays: 30,
  slaOpenQuestionId: 'Y1-entity',
  slaProvenance: 'Thirty days is the shortest deadline of the regimes this build can see.',
  supervisoryAuthority: '',
  responseCanBeIssued: false,
  regulatoryProfileVersion: 1,
  erasureOverridesRetention: false,
  clinicalRetentionYears: 25,
  financialRetentionYears: 5,
  realIntakePermitted: false,
  requests: [
    {
      id: '01a0dc9b-cd6e-7861-ae40-0884f6b44d9c',
      requestType: 'erasure',
      subjectLabel: 'record 01a0dc9b',
      receivedAtIso: '2099-06-01T09:00:00.000Z',
      dueAtIso: '2099-07-01T09:00:00.000Z',
      state: 'in_progress',
      isOverdue: true,
      verifiedVia: 'otp',
    },
  ],
  overdueCount: 1,
  probes: [
    { axis: 'customer_reference', columnCount: 24 },
    { axis: 'contact_detail', columnCount: 40 },
    { axis: 'foreign_key_child', columnCount: 12 },
    { axis: 'credential', columnCount: 16 },
    { axis: 'free_text_note', columnCount: 7 },
  ],
  unclassifiedColumnCount: 0,
  classes: [
    { dataClass: 'identity', actions: ['pseudonymise', 'redact'], columnCount: 6 },
    { dataClass: 'financial', actions: ['retain_statutory'], columnCount: 11 },
  ],
  retentions: [
    {
      participant: 'public.invoice',
      columnName: 'customer_phone',
      action: 'retain_statutory',
      why: 'A completed erasure leaves a phone number here, in the clear, because the FTA requires it.',
      obligationColumn: 'financial_retention_years',
      obligationYears: 5,
    },
    {
      participant: 'public.suppression',
      columnName: 'key_hmac',
      action: 'retain_for_subject',
      why: 'Deleting it would make the person messageable again after a re-import.',
      obligationColumn: null,
      obligationYears: null,
    },
  ],
}

describe('the privacy screen', () => {
  it('says the written response is WITHHELD, and why, when no authority is recorded', () => {
    const html = renderPrivacyHtml(BASE)
    expect(html).toContain('Written responses are withheld')
    // Two things beyond the notice, and they are the substance of it: that the requests are still carried
    // out, and which question answering would settle it.
    expect(html).toContain('requests are still carried out in full')
    expect(html).toContain('Y1-entity')
    // The control, and it is the mutation that matters: once an authority IS recorded the page names it and
    // the withheld notice goes. A page that showed the notice unconditionally would pass every assertion
    // above for ever, including after somebody answered the question.
    const answered = renderPrivacyHtml({
      ...BASE,
      supervisoryAuthority: 'A named authority',
      responseCanBeIssued: true,
    })
    expect(answered).not.toContain('Written responses are withheld')
    expect(answered).toContain('A named authority')
  })

  it('names an overdue request as overdue', () => {
    expect(renderPrivacyHtml(BASE)).toContain('OVERDUE')
    // The control: a request inside its deadline is NOT marked, so the word means something.
    // Destructured and CHECKED rather than asserted non-null: `noNonNullAssertion` is an error in this
    // repository, and the check is better anyway — a `BASE` that stopped carrying a request would make the
    // control below vacuous rather than failing here.
    const [first] = BASE.requests
    if (first === undefined)
      throw new Error('BASE must carry a request for this control to mean anything')
    const inHand = renderPrivacyHtml({
      ...BASE,
      requests: [{ ...first, isOverdue: false }],
      overdueCount: 0,
    })
    expect(inHand).not.toContain('OVERDUE')
    expect(inHand).not.toContain('past their deadline')
  })

  it('states what an erasure RETAINS and the reason, not merely that something is retained', () => {
    const html = renderPrivacyHtml(BASE)
    // The reason is on the page, in the words the registry uses. A page that listed the tables without the
    // reasons would be a list of things the business keeps with no defence for any of them.
    expect(html).toContain('the FTA requires it')
    expect(html).toContain('messageable again after a re-import')
    // The obligation and the figure, so nobody has to guess where five years came from.
    expect(html).toContain('financial_retention_years')
    expect(html).toContain('5 year(s)')
    // And the two uncomfortable retentions are named in the prose rather than left to the list, because a
    // reader scanning headings has to meet them.
    expect(html).toContain('keeps their name')
    expect(html).toContain('clear a safety block')
  })

  it('reports an unclassified column as a REFUSAL rather than as a count', () => {
    const broken = renderPrivacyHtml({ ...BASE, unclassifiedColumnCount: 3 })
    expect(broken).toContain('3 column(s) are unclassified')
    // The wording matters: the engine refuses, so the page must not read as a tidy-up task.
    expect(broken).toContain('REFUSE to run')
    // The control: with nothing unclassified the page says so positively and the refusal wording is absent.
    expect(renderPrivacyHtml(BASE)).toContain('accounted for by name')
    expect(renderPrivacyHtml(BASE)).not.toContain('REFUSE to run')
  })

  it('explains the clinical conflict in the direction the profile actually resolves it', () => {
    const retained = renderPrivacyHtml(BASE)
    expect(retained).toContain('clinical CONTENT is retained')
    // And says plainly that the subject is unreachable regardless, which is the claim that stops the
    // retention reading as a refusal to honour the request.
    expect(retained).toContain('unreachable either way')
    // The control: flipping the profile flips the sentence. A page with one hard-coded explanation would be
    // wrong for whichever profile it was not written for, and nothing would say so.
    const destroyed = renderPrivacyHtml({ ...BASE, erasureOverridesRetention: true })
    expect(destroyed).toContain('clinical content is destroyed')
    expect(destroyed).not.toContain('clinical CONTENT is retained')
  })

  it('carries no brand in the title and is noindex', () => {
    const html = renderPrivacyHtml(BASE)
    expect(html).toContain('<title>Data-subject rights — privacy admin</title>')
    expect(html).toContain('noindex, nofollow, noarchive')
  })
})
