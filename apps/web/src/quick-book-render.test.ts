import type { BookableVariantRow } from '@berelax/db'
import { WHATSAPP_REF_CODE_HTML_PATTERN, WHATSAPP_REF_CODE_LENGTH } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { firstGridStart, gridStartsFor } from '../app/(admin)/quick-book/handler.ts'
import { QUICK_BOOK_CSS, renderQuickBookHtml } from '../app/(admin)/quick-book/render.ts'
import {
  QUICK_BOOK_FIELDS,
  type QuickBookView,
  THERAPIST_REFUSAL_REASONS,
  therapistRefusalSentence,
} from '../app/(admin)/quick-book/view.ts'

/**
 * B-UI-04 — the quick-book DOCUMENT, asserted without a server.
 *
 * The render is pure: a view in, a document out. Everything here is a claim about the bytes, which is the
 * half of this unit that does not need a browser. The measured walk-in, the pointer-free run, axe and the
 * narrowing script are `quick-book.itest.ts`'s, because a keystroke, a `pointerEvents: 'none'` context and a
 * computed style cannot be checked by reading source.
 *
 * ## The one claim that has to be made HERE and not in a browser
 *
 * *"The WhatsApp ref field is the FIRST optional field in DOM order."* That is a statement about the
 * document's byte order, and a browser is the wrong instrument for it: `page.locator` answers in DOM order
 * too, but a test that walked the rendered inputs would be satisfied by a CSS `order` that moved the field
 * visually while leaving the tab order alone — and DOM order is what a keyboard and a screen reader follow.
 * So the assertion below is on the INDEX of the substring, which is the thing the acceptance line is about.
 */

const CHROME = { googleReauth: null, returnTo: '/settings/integrations' } as const

const VARIANT_A = '01a00000-0000-7000-8000-0000000000a1'
const VARIANT_B = '01a00000-0000-7000-8000-0000000000a2'
const ROOM = '01a00000-0000-7000-8000-0000000000b1'
const THERAPIST_A = '01a00000-0000-7000-8000-0000000000c1'
const THERAPIST_B = '01a00000-0000-7000-8000-0000000000c2'

function view(over: Partial<QuickBookView> = {}): QuickBookView {
  return {
    chrome: CHROME,
    direction: 'ltr',
    action: '/quick-book',
    dayLabel: 'Trading day 2099-06-18, 11:00 to 02:00, open now.',
    lede: 'Phone, treatment, who it is for and a start.',
    announcement: 'Ready. Type the mobile number.',
    phoneHint: 'Any spelling of a UAE mobile.',
    refHint: 'Four characters from A-Z and 2-9.',
    refCodePattern: WHATSAPP_REF_CODE_HTML_PATTERN,
    refCodeLength: WHATSAPP_REF_CODE_LENGTH,
    genderWhy: 'Required, and not this screen’s choice.',
    startHint: 'The next 8 quarter-hours.',
    variants: [
      { serviceVariantId: VARIANT_A, label: 'Asian Normal Massage — 60 min — AED 200.00' },
      { serviceVariantId: VARIANT_B, label: 'Asian Normal Massage — 90 min — AED 300.00' },
    ],
    starts: [
      {
        value: '2099-06-18T15:00:00.000Z',
        label: '19:00',
        serviceVariantIds: [VARIANT_A, VARIANT_B],
      },
      { value: '2099-06-18T15:15:00.000Z', label: '19:15', serviceVariantIds: [VARIANT_A] },
    ],
    form: {
      phone: '',
      ref: '',
      variant: VARIANT_A,
      gender: '',
      start: '2099-06-18T15:00:00.000Z',
      notes: '',
      therapist: '',
    },
    checked: null,
    booked: null,
    refusal: null,
    refNotice: null,
    rate: {
      matched: 0,
      unknownCode: 0,
      notOffered: 3,
      total: 3,
      claim: 'loop_unconfirmed',
      sentence: 'Reported, not judged.',
      openQuestionId: 'Y12-ref-loop',
    },
    assumptions: [
      { what: 'The desk books with 0 minutes’ notice.', openQuestionId: 'Y9-lead' },
      { what: 'The desk is NOT expected to paste the code.', openQuestionId: 'Y12-ref-loop' },
    ],
    ...over,
  }
}

const assignment = () => ({
  treatmentLabel: 'Asian Normal Massage — 60 min — AED 200.00',
  startLabel: '19:00 on 2099-06-18',
  roomId: ROOM,
  roomLabel: 'room-2 — Treatment Room 2',
  therapists: [{ therapistId: THERAPIST_A, reference: 'Therapist 07' }],
  priceLabel: 'AED 200.00',
  alternatives: [{ therapistId: THERAPIST_B, reference: 'Therapist 11' }],
  excluded: [
    {
      therapistId: '01a00000-0000-7000-8000-0000000000c3',
      reference: 'Therapist 12',
      reason: 'credential_expired' as const,
      sentence: therapistRefusalSentence('credential_expired'),
    },
  ],
})

/** The document's field order, as the indexes of the test ids a keyboard would reach in turn. */
function orderOf(html: string, testIds: readonly string[]): readonly number[] {
  return testIds.map((id) => html.indexOf(`data-testid="${id}"`))
}

/** A trading day in the premises' own zone: 11:00 to 02:00 the next calendar day. */
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+04:00`)
const OPENS = at('2099-06-18', '11:00')
const CLOSES = at('2099-06-19', '02:00')

const variantRow = (durationMinutes: number, id: string) =>
  ({
    serviceVariantId: id,
    serviceId: 'service',
    style: 'asian',
    treatmentKey: 'normal_massage',
    slug: 'asian-normal-massage',
    publicDisplayName: 'Normal Massage (Asian)',
    durationMinutes,
    grossFils: '20000',
  }) satisfies BookableVariantRow

describe('the grid of starts the screen offers', () => {
  it('rounds the first start UP to the quarter hour and never down', () => {
    // Up and never down, because a start below the lead floor is one the availability engine refuses — so
    // rounding down would put a control known to fail at the top of the list, and the first thing the desk
    // would learn about the lead setting is that the first option never works.
    const now = at('2099-06-18', '14:07')
    expect(firstGridStart({ now, opensAt: OPENS, leadMinutes: 0 })).toBe(at('2099-06-18', '14:15'))
    // Already on the grid: unchanged rather than pushed to the next one.
    expect(firstGridStart({ now: at('2099-06-18', '14:15'), opensAt: OPENS, leadMinutes: 0 })).toBe(
      at('2099-06-18', '14:15'),
    )
    // The lead time is added BEFORE the rounding, not after: 14:07 plus 20 minutes is 14:27, which rounds to
    // 14:30. Rounding first and then adding would answer 14:35, which is not on the grid at all.
    expect(firstGridStart({ now, opensAt: OPENS, leadMinutes: 20 })).toBe(at('2099-06-18', '14:30'))
  })

  it('starts at the OPEN when the clock is earlier, and at the clock when it is later', () => {
    // Both directions, because `max` with the arguments the wrong way round passes one of them.
    expect(firstGridStart({ now: at('2099-06-18', '06:30'), opensAt: OPENS, leadMinutes: 0 })).toBe(
      OPENS,
    )
    expect(firstGridStart({ now: at('2099-06-18', '19:00'), opensAt: OPENS, leadMinutes: 0 })).toBe(
      at('2099-06-18', '19:00'),
    )
  })

  it('cuts each treatment at the close less its OWN duration', () => {
    /*
      The rule that makes `data-variants` load-bearing rather than decorative, and the one an end-to-end test
      cannot see: the same clock time is offerable for a 45-minute treatment and not for a 120-minute one, so
      a shared cut would either offer a start the solver refuses or hide one it would have taken.

      From 00:30, with the day closing at 02:00: a 45-minute treatment fits at 00:30, 00:45, 01:00 and 01:15;
      a 90-minute one fits at 00:30 only.
    */
    const short = variantRow(45, VARIANT_A)
    const long = variantRow(90, VARIANT_B)
    const starts = gridStartsFor({
      variants: [short, long],
      from: at('2099-06-19', '00:30'),
      closesAt: CLOSES,
      count: 8,
    })
    expect(starts.map((start) => start.label)).toEqual(['00:30', '00:45', '01:00', '01:15'])
    expect(starts[0]?.serviceVariantIds).toEqual([VARIANT_A, VARIANT_B])
    // And the later ones carry the short treatment alone, which is the whole claim.
    expect(starts[1]?.serviceVariantIds).toEqual([VARIANT_A])
    expect(starts.at(-1)?.serviceVariantIds).toEqual([VARIANT_A])
  })

  it('emits no instant that no treatment suits, rather than one that is disabled for all of them', () => {
    // An option no choice of treatment can enable is a control known to fail whatever else the operator does.
    const starts = gridStartsFor({
      variants: [variantRow(120, VARIANT_A)],
      from: at('2099-06-19', '01:00'),
      closesAt: CLOSES,
      count: 8,
    })
    expect(starts).toEqual([])
    // The control: the same treatment three hours earlier IS offered, so the emptiness above is the cut and
    // not a function that answers nothing. Eight, because all eight quarter-hours from 21:00 still end before
    // the close for a 120-minute treatment — the first version of this line guessed one and was simply wrong
    // about the arithmetic it was checking.
    expect(
      gridStartsFor({
        variants: [variantRow(120, VARIANT_A)],
        from: at('2099-06-18', '21:00'),
        closesAt: CLOSES,
        count: 8,
      }),
    ).toHaveLength(8)
    // And the cut is INCLUSIVE at exactly the latest start: a 120-minute treatment beginning two hours before
    // the close ends ON the close, which the trading window is half-open about, so it is offered.
    const boundary = gridStartsFor({
      variants: [variantRow(120, VARIANT_A)],
      from: at('2099-06-19', '00:00'),
      closesAt: CLOSES,
      count: 8,
    })
    expect(boundary).toHaveLength(1)
    expect(boundary[0]?.label).toBe('00:00')
  })

  it('gives every option a distinct value, which is what makes the select settable', () => {
    const starts = gridStartsFor({
      variants: [variantRow(45, VARIANT_A), variantRow(60, VARIANT_B)],
      from: OPENS,
      closesAt: CLOSES,
      count: 8,
    })
    expect(starts).toHaveLength(8)
    // Two treatments and eight options, not sixteen. A duplicate value is a select nothing can set by value:
    // the browser takes the first match, which after narrowing may be a disabled option belonging to the
    // other treatment — and the field then submits empty.
    expect(new Set(starts.map((start) => start.value)).size).toBe(starts.length)
    // Every value is a parseable instant, because the option's value is what the server resolves.
    for (const start of starts) expect(Number.isNaN(Date.parse(start.value))).toBe(false)
  })
})

describe('the ref field is the first optional field in DOM order', () => {
  it('puts it after the phone and before every other optional control', () => {
    const html = renderQuickBookHtml(view())
    const [phone, ref, variant, gender, start, notes] = orderOf(html, [
      'quick-book-phone',
      'quick-book-ref',
      'quick-book-variant',
      'quick-book-gender',
      'quick-book-start',
      'quick-book-notes',
    ])
    // Every one present, which is the control: `indexOf` answers -1 for an absent id and -1 < anything, so
    // an ordering assertion alone would be satisfied by a field that is not there at all.
    for (const [name, index] of Object.entries({ phone, ref, variant, gender, start, notes })) {
      expect(index, `${name} is absent from the document`).toBeGreaterThan(-1)
    }
    expect(phone).toBeLessThan(ref as number)
    // THE claim: the ref precedes every other field, and the only optional one among them is the note.
    expect(ref).toBeLessThan(variant as number)
    expect(ref).toBeLessThan(gender as number)
    expect(ref).toBeLessThan(start as number)
    expect(ref).toBeLessThan(notes as number)
  })

  it('marks it optional in words as well as by the absence of `required`', () => {
    const html = renderQuickBookHtml(view())
    // Sliced from the ref INPUT's own id forwards. The first version of this reached 400 bytes backwards
    // and caught the phone field's `required` — a check whose stated claim was not what it measured, and it
    // failed loudly rather than passing, which is the only reason it is worth recording here.
    const field = html.slice(
      html.indexOf('id="quick-book-ref"'),
      html.indexOf('data-testid="quick-book-ref-hint"'),
    )
    expect(field).not.toContain('required')
    expect(html).toContain('data-testid="quick-book-ref-optional"')
    // And the phone IS required, which is the control on the assertion above: a render that emitted
    // `required` nowhere would satisfy it.
    const phone = html.slice(
      html.indexOf('data-testid="quick-book-phone"'),
      html.indexOf('data-testid="quick-book-phone"') + 300,
    )
    expect(phone).toContain('required')
  })

  it('carries the shared pattern, which accepts what the normaliser can fold', () => {
    const html = renderQuickBookHtml(view())
    expect(html).toContain(`pattern="${WHATSAPP_REF_CODE_HTML_PATTERN}"`)
    // Lower case IS admitted by the field, because a code pasted off a phone arrives in whatever case the
    // phone had it and the server folds case before it compares. The canonical-only pattern blocked the
    // submit with the browser's own validation bubble and no request was made — a page that silently did
    // nothing. `packages/shared/src/whatsapp-ref.test.ts` holds the property; this is the attribute.
    expect(html).toContain('a-hj-np-z')
    expect(html).toContain(`maxlength="${WHATSAPP_REF_CODE_LENGTH}"`)
    // `autocomplete="off"`: a code belongs to ONE conversation, and a browser offering the last one is a
    // browser offering a wrong attribution.
    expect(html).toContain('autocomplete="off"')
  })
})

describe('an unknown code warns and does not block', () => {
  it('renders the warning beside a confirm button that is still there and still enabled', () => {
    const html = renderQuickBookHtml(
      view({
        checked: assignment(),
        refNotice: 'unknown_code',
        form: { ...view().form, ref: 'ZZ99' },
      }),
    )
    expect(html).toContain('data-notice="unknown_code"')
    expect(html).toContain('data-testid="quick-book-confirm"')
    // The button exists AND is not disabled, which are two different claims: a `disabled` attribute would
    // satisfy the first one on its own.
    const button = html.slice(
      html.indexOf('data-testid="quick-book-confirm"') - 80,
      html.indexOf('data-testid="quick-book-confirm"') + 80,
    )
    expect(button).not.toContain('disabled')
    // And the typed code is echoed back rather than cleared, so the desk can see what it typed.
    expect(html).toContain('value="ZZ99"')
  })

  it('says nothing at all when no code was offered', () => {
    const html = renderQuickBookHtml(view({ checked: assignment(), refNotice: null }))
    expect(html).not.toContain('data-testid="quick-book-ref-notice"')
    // A warning for leaving an optional field alone is a screen that cries wolf; the control is that the
    // panel CAN appear, which the case above asserts.
  })
})

describe('the assignment is displayed before the confirm', () => {
  it('names the room and the therapist, and the confirm posts the tuple that was shown', () => {
    const html = renderQuickBookHtml(view({ checked: assignment() }))
    const shown = html.indexOf('data-testid="quick-book-assignment"')
    const confirm = html.indexOf('data-testid="quick-book-confirm-form"')
    expect(shown).toBeGreaterThan(-1)
    expect(confirm).toBeGreaterThan(shown)
    expect(html).toContain(`data-room="${ROOM}"`)
    expect(html).toContain(`data-therapist="${THERAPIST_A}"`)
    // The tuple travels in the confirm form, so the booking is the one the desk read out.
    expect(html).toContain(`<input type="hidden" name="${QUICK_BOOK_FIELDS.room}" value="${ROOM}">`)
    expect(html).toContain(
      `<input type="hidden" name="${QUICK_BOOK_FIELDS.assigned}" value="${THERAPIST_A}">`,
    )
  })

  it('names therapists by their internal reference and never by an invented name', () => {
    const html = renderQuickBookHtml(view({ checked: assignment() }))
    expect(html).toContain('Therapist 07')
    // ADR 0020: a therapist has no display name until an admin sets one, and publishing one needs a
    // recorded photography consent as well. Nothing on this screen composes one.
    expect(html).not.toMatch(/data-therapist="[^"]*">\s*(Mr|Ms|Mrs|Dr)\b/)
  })

  it('hides the entry form once an assignment is on screen, so there is one live form pair', () => {
    const html = renderQuickBookHtml(view({ checked: assignment() }))
    // Two forms exactly: confirm, and the override. The entry form would be a third with the same field
    // names, and a keyboard user tabbing into it would be filling in a form that discards the assignment.
    //
    // Asserted on the phone INPUT and on the form count, not on the entry form's test id: the inline script
    // contains the string `[data-testid="quick-book-form"]` in its own selector, so a `not.toContain` on
    // that id can never pass. It did not, which is how this was found; a looser version of the same check
    // would have passed by accident on the state where the entry form IS present.
    expect(html).not.toContain('id="quick-book-phone"')
    expect(html.split('<form ').length - 1).toBe(2)
    expect(html).toContain('data-testid="quick-book-override-form"')
  })

  it('offers no override at all when the engine found nobody else', () => {
    const html = renderQuickBookHtml(view({ checked: { ...assignment(), alternatives: [] } }))
    // The reasoning B-UI-01's therapist selector and P-HR-04's candidate list both record: a control known
    // to fail is worse than no control.
    expect(html).not.toContain('data-testid="quick-book-override-form"')
    expect(html).toContain('data-testid="quick-book-assignment"')
  })
})

describe('an ineligible therapist is refused by its own reason code', () => {
  it('renders the reason as a data attribute and a sentence, for every reason in the union', () => {
    for (const reason of THERAPIST_REFUSAL_REASONS) {
      const html = renderQuickBookHtml(
        view({
          refusal: {
            name: 'therapist_not_eligible',
            sentence: 'That therapist may not take this treatment.',
            therapistReason: reason,
          },
        }),
      )
      expect(html, reason).toContain('data-quick-book-refusal="therapist_not_eligible"')
      expect(html, reason).toContain(`data-reason="${reason}"`)
      // The sentence, not merely the code: the code is for a test and the sentence is for the desk.
      expect(html, reason).toContain(therapistRefusalSentence(reason).slice(0, 40))
    }
    // The control on the loop: the eight reasons really do produce eight different sentences, so a table
    // that had collapsed to one wording could not satisfy it.
    expect(new Set(THERAPIST_REFUSAL_REASONS.map(therapistRefusalSentence)).size).toBe(
      THERAPIST_REFUSAL_REASONS.length,
    )
  })

  it('says nothing about the therapist for a gender mismatch', () => {
    // It is not a question about them — the same person is eligible for the next client — and there is no
    // renewal, rota edit or training record that answers it.
    const sentence = therapistRefusalSentence('gender_mismatch')
    expect(sentence).toContain('not a fact about the therapist')
    expect(sentence).not.toContain('female')
    expect(sentence).not.toContain('male')
  })

  it('lists who was excluded, with the reason, on the check itself', () => {
    const html = renderQuickBookHtml(view({ checked: assignment() }))
    expect(html).toContain('data-testid="quick-book-excluded"')
    expect(html).toContain('data-reason="credential_expired"')
    expect(html).toContain('Therapist 12')
  })
})

describe('the capture rate is never a bare percentage', () => {
  it('prints the claim, the three counts and the question id', () => {
    const html = renderQuickBookHtml(view())
    expect(html).toContain('data-claim="loop_unconfirmed"')
    expect(html).toContain('data-testid="quick-book-rate-matched"')
    expect(html).toContain('data-testid="quick-book-rate-total"')
    expect(html).toContain('data-testid="quick-book-rate-question"')
    expect(html).toContain('Y12-ref-loop')
  })

  it('cites no question once the loop is confirmed', () => {
    const html = renderQuickBookHtml(
      view({
        rate: { ...view().rate, claim: 'measured', openQuestionId: null, sentence: 'Measured.' },
      }),
    )
    expect(html).toContain('data-claim="measured"')
    expect(html).not.toContain('data-testid="quick-book-rate-question"')
  })
})

describe('the document is an admin document', () => {
  it('carries the Google re-auth banner inside <main>', () => {
    const html = renderQuickBookHtml(view())
    // G-CONN-08: `google-reauth-banner.test.ts` walks the tree for the SOURCE call; this asserts the
    // rendered result, because a call that returned the empty string would satisfy the walk.
    const main = html.indexOf('<main>')
    expect(main).toBeGreaterThan(-1)
    expect(html).toContain('data-testid="quick-book-live"')
    expect(html.indexOf('data-testid="quick-book-live"')).toBeGreaterThan(main)
  })

  it('is noindex in the document as well as in the header', () => {
    const html = renderQuickBookHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
  })

  it('mirrors for `dir=rtl` and names no colour literal', () => {
    expect(renderQuickBookHtml(view({ direction: 'rtl' }))).toContain('<html lang="en" dir="rtl"')
    // `pnpm colours` scans the repository; this is the same claim made where a reader will look for it —
    // and made about THIS page's stylesheet rather than about the rendered document, because the document
    // also embeds `tokensCss()`, which is the token layer and is where the hex literals belong. The first
    // version scanned the whole page and failed on the tokens, which is the check measuring the wrong thing.
    expect(QUICK_BOOK_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // The control: the stylesheet really does set colours, through tokens, so a file with no colour rules
    // at all could not satisfy the assertion above.
    expect(QUICK_BOOK_CSS).toContain('var(--color-ground)')
  })

  it('renders the same bytes twice for the same view', () => {
    // Purity, stated as an assertion: a render that read a clock or a random would differ here, and the
    // screenshot and axe cells both depend on it not doing either.
    expect(renderQuickBookHtml(view())).toBe(renderQuickBookHtml(view()))
  })

  it('names every provisional value it stands on, with its question id', () => {
    const html = renderQuickBookHtml(view())
    expect(html).toContain('data-testid="quick-book-assumptions"')
    expect(html).toContain('data-question="Y9-lead"')
    expect(html).toContain('data-question="Y12-ref-loop"')
  })
})

describe('the confirmation states the attribution, and never leaves it blank', () => {
  it('prints `unknown` in words for a booking with no matched code', () => {
    const html = renderQuickBookHtml(
      view({
        booked: {
          ...assignment(),
          bookingId: '01a00000-0000-7000-8000-0000000000d1',
          captureOutcome: 'not_offered',
          captureLabel: 'Unknown — no ref code was recorded',
        },
      }),
    )
    expect(html).toContain('data-outcome="not_offered"')
    expect(html).toContain('Unknown — no ref code was recorded')
    // A blank cell would read as a field nobody filled rather than as a fact nobody has, which is the
    // distinction Y9-crm-source settles for the whole build.
    expect(html).not.toMatch(/data-testid="quick-book-attribution"[^>]*>\s*</)
  })
})
