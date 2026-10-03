import { BILLABLE_APPOINTMENT_STATUSES, DOCUMENT_FIELDS, DOCUMENT_FORM_FIELDS } from '@berelax/core'
import { FIXTURE_PACKAGE_OPEN_QUESTION, FIXTURE_PACKAGE_SHAPES } from '@berelax/fixtures'
import { describe, expect, it } from 'vitest'
import {
  drawdownState,
  FIXTURE_PACKAGE_OPEN_QUESTION as ROUTE_PACKAGE_QUESTION,
} from '../app/(admin)/packages/handler.ts'
import { renderTillHtml, TILL_CSS } from '../app/(admin)/till/render.ts'
import {
  TILL_BILLABLE_STATUSES,
  TILL_DOCUMENT_FIELD_KEYS,
  TILL_FIELD_LABELS,
  type TillView,
} from '../app/(admin)/till/view.ts'

/**
 * The till document, asserted without a server (M-TILL-13).
 *
 * The claims here are the ones a pure render can make: the bytes of the document for a given view, the palette
 * rule as a property of the stylesheet, and the lists this screen must not be allowed to drift from —
 * `DOCUMENT_FIELDS`, `BILLABLE_APPOINTMENT_STATUSES` and the fixture's own open-question id. The claims that
 * need a rendered DOM — axe, the RTL geometry, the computed background of every text node, the interaction
 * count — are `till.itest.ts`'s, and that file says why.
 */

const CHROME = { googleReauth: null, sendBacklog: null, returnTo: '/till' } as const

function view(overrides: Partial<TillView> = {}): TillView {
  const base: TillView = {
    screen: 'till',
    direction: 'ltr',
    chrome: CHROME,
    action: '/till?day=2026-09-18',
    tillHref: '/till?day=2026-09-18',
    previewHref: '/till?day=2026-09-18&view=preview',
    cashUpHref: '/till/cash-up?day=2026-09-18',
    packagesHref: '/packages?day=2026-09-18',
    dayLabel: 'Business day 2026-09-18',
    tradingDate: '2026-09-18',
    lede: 'Trading runs from open to close, so a treatment after midnight is billed on the previous day.',
    announcement: 'Pull a completed treatment through, then take the payment.',
    billable: [
      {
        appointmentId: '00000000-0000-4000-8000-00000000ab01',
        description: 'asian normal_massage, 60 min',
        grossLabel: 'AED 200.00',
        startLabel: '15:00',
        customerLabel: 'Walk-in, no record',
        inBasket: true,
      },
    ],
    basket: {
      lines: [
        {
          kind: 'service',
          description: 'asian normal_massage, 60 min',
          grossLabel: 'AED 200.00',
          reason: null,
        },
        {
          kind: 'discount',
          description: 'Discount',
          grossLabel: 'AED -20.00',
          reason: 'service_recovery',
        },
        { kind: 'tip', description: 'Gratuity', grossLabel: 'AED 15.00', reason: null },
      ],
      netLabel: 'AED 171.43',
      vatLabel: 'AED 8.57',
      documentGrossLabel: 'AED 180.00',
      tipLabel: 'AED 15.00',
      dueLabel: 'AED 195.00',
      dueFils: 19_500,
      tenderedLabel: 'AED 195.00',
      outstandingLabel: 'AED 0.00',
      balanced: true,
    },
    posting: {
      lines: [
        { accountCode: '1010', memo: 'cash', debitLabel: 'AED 195.00', creditLabel: '' },
        { accountCode: '4010', memo: 'treatment', debitLabel: '', creditLabel: 'AED 171.43' },
        { accountCode: '2030', memo: 'output vat', debitLabel: '', creditLabel: 'AED 8.57' },
        { accountCode: '2040', memo: 'tips payable', debitLabel: '', creditLabel: 'AED 15.00' },
      ],
      debitTotalLabel: 'AED 195.00',
      creditTotalLabel: 'AED 195.00',
      differenceLabel: 'AED 0.00',
      balanced: true,
    },
    refusal: null,
    issued: null,
    issuer: {
      legalName: 'BE RELAX SPA - L.L.C - O.P.C',
      tradingName: 'BE RELAX - Massage Center and Spa',
      addressLabel: '250 Al Meena Street, Al Zahiyah, Abu Dhabi',
      emirate: 'Abu Dhabi',
      trn: null,
    },
    mandatory: [],
    assumptions: [{ what: 'The TRN has not been entered.', openQuestionId: 'Y1-trn' }],
    form: {
      day: '2026-09-18',
      appointments: ['00000000-0000-4000-8000-00000000ab01'],
      tip: '1500',
      discount: '2000',
      discountReason: 'service_recovery',
      cash: '19500',
      card: '',
      bank: '',
      cardRef: '',
      bankRef: '',
    },
  }
  return { ...base, ...overrides }
}

describe('acceptance — the palette rule holds as a property of the stylesheet', () => {
  it('names no colour literal and never puts copy on a decorative surface', () => {
    // `pnpm colours` scans the repository; this is the same claim made where a reader will look for it — and
    // made about THIS page's stylesheet rather than about the rendered document, because the document also
    // embeds `tokensCss()`, which is the token layer and is where the hex literals belong.
    expect(TILL_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // The acceptance line: no body text sits on `--surface-clay`, `--decor-gold` or `--decor-tan` on any till
    // screen. One stylesheet serves all three surfaces, so this is one place the rule can be broken.
    for (const token of ['--color-surface-clay', '--color-decor-gold', '--color-decor-tan']) {
      expect(TILL_CSS, `${token} is a decorative surface and carries no copy`).not.toContain(token)
    }
    // Two controls. The stylesheet really does set colours through tokens, so a file with no colour rules at
    // all could not satisfy the assertions above; and the accent gold IS used, as a border and an outline,
    // which is what makes "no body text on decor-gold" a narrower claim than "decor-gold is never named".
    expect(TILL_CSS).toContain('var(--color-ground)')
    expect(TILL_CSS).toContain('var(--color-accent-gold)')
  })

  it('the control: a stylesheet that put copy on the decorative gold IS caught by the same scan', () => {
    const bad = `${TILL_CSS}\n  p.promo { background: var(--color-decor-gold); color: var(--color-ink); }`
    expect(bad).toContain('--color-decor-gold')
  })
})

describe('acceptance — the screen cannot drift from the lists it reads', () => {
  it('labels exactly the document fields core declares, in both directions', () => {
    // Both directions, because each failure is a different defect: a key with no label prints `issuerTrn` on a
    // screen somebody reviews, and a label for a key that no longer exists is a field the preview claims the
    // document states. Answering Y11-vat-invoice therefore fails here rather than being silently absent.
    expect([...TILL_DOCUMENT_FIELD_KEYS].sort()).toEqual([...DOCUMENT_FIELDS].sort())
    expect(Object.keys(TILL_FIELD_LABELS).sort()).toEqual([...DOCUMENT_FIELDS].sort())
    for (const key of DOCUMENT_FIELDS) expect(TILL_FIELD_LABELS[key].length).toBeGreaterThan(2)
  })

  it('bills exactly the statuses core says emit revenue', () => {
    // `packages/db` may never import `packages/core`, so `readBillableAppointments` spells `'completed'` in
    // SQL. This is the only place the two can be held equal.
    expect([...TILL_BILLABLE_STATUSES]).toEqual([...BILLABLE_APPOINTMENT_STATUSES])
  })

  it('names the same package open question the fixture seeds', () => {
    // The route may not import `@berelax/fixtures` (a devDependency of this app), so the id is spelled twice.
    // A test is the only thing that can stop the two drifting.
    expect(ROUTE_PACKAGE_QUESTION).toBe(FIXTURE_PACKAGE_OPEN_QUESTION)
  })
})

describe('acceptance — the till document says what it can and cannot do', () => {
  it('serves two forms, a keypad and a total column, and marks the TRN absent', () => {
    const html = renderTillHtml(view())
    expect(html).toContain('data-testid="till-basket-form"')
    expect(html).toContain('data-testid="till-tender-form"')
    expect(html).toContain('data-testid="till-keypad"')
    expect(html).toContain('data-testid="till-total-column"')
    /*
      The absence, stated. Not a stand-in, and the question named beside it (brief rule 15).

      The WHOLE cell and not just `data-absent="1"`: that attribute comes from `view.issuer.trn === null`, so a
      render that printed `TRN-PENDING-Y1-TRN` inside the absent cell would still emit it — measured, by a gate
      mutant that did exactly that and was not caught. And not just `<code>Y1-trn</code>` either, because the
      assumptions panel prints that id too.
    */
    expect(html).toContain('data-field="trn" data-absent="1"')
    expect(html).toContain('<span class="absent">not entered</span> <code>Y1-trn</code>')
    expect(html).not.toContain('TRN-PENDING')
    // Each form has exactly ONE submit button, which is what makes Enter do the one thing that form is for.
    expect(html.match(/type="submit"/g)).toHaveLength(2)
  })

  it('renders the same bytes twice for the same view', () => {
    // Purity, stated as an assertion: a render that read a clock or a random would differ here, and the
    // screenshot matrix's zero-pixel-diff claim depends on it doing neither.
    expect(renderTillHtml(view())).toBe(renderTillHtml(view()))
  })

  it('mirrors for dir=rtl without a second stylesheet', () => {
    expect(renderTillHtml(view({ direction: 'rtl' }))).toContain('<html lang="en" dir="rtl"')
    // Logical properties only. A physical side here would pass every text assertion in this file and fail the
    // geometry assertion in `till.itest.ts`, which is the one that says the keypad really changed side.
    expect(TILL_CSS).not.toMatch(/\b(margin|padding|border)-(left|right)\b/)
    expect(TILL_CSS).toContain('border-inline-start-color')
  })

  it('offers no tender form and no keypad while the basket is empty', () => {
    // A *Take payment* button above an empty basket is a control known to fail. Asserted rather than assumed,
    // because the keyboard count in the itest depends on the tender form appearing only once there is a basket.
    const html = renderTillHtml(view({ basket: null, posting: null }))
    // The OPENING TAG and not the testid on its own. The inline keypad script names both selectors as strings,
    // so a bare `not.toContain('data-testid="till-tender-form"')` is satisfied by no document this file can
    // produce — it failed the first time it was written, which is the only reason it says so here.
    expect(html).not.toContain('<form method="post" data-testid="till-tender-form"')
    expect(html).not.toContain('<div class="keypad" data-testid="till-keypad"')
    expect(html).toContain('data-testid="till-basket-empty"')
  })

  it('carries the refusal code and its question when the till will not take the money', () => {
    const html = renderTillHtml(
      view({
        refusal: {
          code: 'issuer_trn_not_configured',
          sentence: 'No document can be issued.',
          openQuestionId: 'Y1-trn',
        },
      }),
    )
    expect(html).toContain('data-till-refusal="issuer_trn_not_configured"')
    expect(html).toContain('data-testid="till-refusal-question"')
  })
})

describe('acceptance — the preview enumerates the field list and marks what is missing', () => {
  it('states every field of the simplified form, with the TRN absent and named', () => {
    const fields = DOCUMENT_FORM_FIELDS.simplified_invoice
    const html = renderTillHtml(
      view({
        screen: 'preview',
        mandatory: fields.map((key) => ({
          key,
          label: TILL_FIELD_LABELS[key],
          value: key === 'issuerTrn' ? null : 'stated',
          openQuestionId: key === 'issuerTrn' ? 'Y1-trn' : null,
        })),
      }),
    )
    for (const key of fields) expect(html, key).toContain(`data-field-key="${key}"`)
    expect(html).toContain('data-field-key="issuerTrn" data-absent="1"')
    expect(html).toContain('not stated — the system holds no value')
    // The control on the enumeration: the list is not empty and not one field long, so a preview that printed
    // nothing could not satisfy the loop above.
    expect(fields.length).toBeGreaterThan(10)
  })
})

describe('acceptance — a drawdown state is read off the rows, never stored', () => {
  const cases = [
    { sessionsRedeemed: 0, sessionsTotal: 5, expired: false, expected: 'untouched' },
    { sessionsRedeemed: 2, sessionsTotal: 5, expired: false, expected: 'part used' },
    { sessionsRedeemed: 5, sessionsTotal: 5, expired: false, expected: 'fully used' },
    { sessionsRedeemed: 3, sessionsTotal: 10, expired: true, expected: 'expired with a balance' },
    // A fully-used balance that has also expired is FULLY USED, not expired-with-a-balance: there is no
    // balance left to be expired with, and labelling it otherwise would put it on a report of money owed.
    { sessionsRedeemed: 5, sessionsTotal: 5, expired: true, expected: 'fully used' },
  ] as const

  it('names the four states the fixture salon seeds', () => {
    for (const probe of cases) {
      expect(drawdownState(probe), JSON.stringify(probe)).toBe(probe.expected)
    }
    // And the four the fixture asks for are exactly the four this function can answer, so a fifth shape added
    // to the seed without a label here fails rather than rendering as one of the others.
    expect([...new Set(FIXTURE_PACKAGE_SHAPES.map((shape) => shape.state))].sort()).toEqual([
      'expired with a balance',
      'fully used',
      'part used',
      'untouched',
    ])
  })
})
