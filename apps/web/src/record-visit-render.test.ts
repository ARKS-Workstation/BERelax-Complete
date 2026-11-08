import { adminMain } from '@berelax/fixtures'
import { describe, expect, it } from 'vitest'
import { renderRecordVisitHtml } from '../app/(admin)/record-visit/render.ts'
import {
  RECORD_VISIT_FIELDS,
  RECORD_VISIT_PATH,
  RECORD_VISIT_REFUSALS,
  RECORD_VISIT_SENTENCES,
  type RecordVisitView,
  recordVisitRefused,
} from '../app/(admin)/record-visit/view.ts'

/**
 * `/record-visit` — the DOCUMENT, asserted without a server.
 *
 * The render is pure: a view in, a document out. Everything here is a claim about the bytes, which is the
 * half of this screen that needs no browser and no database. The measured entry, the pointer-free run and
 * axe belong to the integration suite, because a keystroke and a computed style cannot be checked by
 * reading source.
 *
 * Every assertion below is over `adminMain`, the slice between `<main>` and `</main>`, and not over the
 * whole document — for the reason `packages/fixtures/src/admin-document.ts` records: the admin shell's
 * topbar carries a sign-out form, and a claim about what this SCREEN offers measured over the whole page
 * would be measuring the furniture.
 */

const EMPTY_FORM = {
  step: '',
  phone: '',
  variant: '',
  gender: '',
  date: '',
  time: '',
  outcome: '',
  reason: '',
  notes: '',
  therapist: '',
  room: '',
}

const BASE: RecordVisitView = {
  direction: 'ltr',
  chrome: {
    googleReauth: null,
    sendBacklog: null,
    returnTo: '/record-visit',
    role: 'manager',
    staffReference: 'EMP-0001',
  },
  form: EMPTY_FORM,
  variants: [
    { serviceVariantId: 'var-60', label: 'Signature Massage', durationMinutes: 60 },
    { serviceVariantId: 'var-90', label: 'Signature Massage', durationMinutes: 90 },
  ],
  horizonDays: 14,
  announcement: 'Ready.',
  refusal: null,
  checked: null,
  recorded: null,
} as unknown as RecordVisitView

const main = (view: Partial<RecordVisitView> = {}): string =>
  adminMain(renderRecordVisitHtml({ ...BASE, ...view }))

describe('the entry form', () => {
  it('offers every field the first step needs, and each one is a native control', () => {
    const html = main()
    const f = RECORD_VISIT_FIELDS
    // Everything but `therapist` and `room`, which belong to the SECOND step: neither can be chosen until
    // the trading date is resolved, because the list is who was on shift THAT day.
    for (const name of [
      f.step,
      f.phone,
      f.variant,
      f.gender,
      f.date,
      f.time,
      f.outcome,
      f.reason,
      f.notes,
    ]) {
      expect(html, name).toMatch(new RegExp(`name="${name}"`))
    }
    expect(html).not.toMatch(/name="therapist"/)
    expect(html).not.toMatch(/name="room"/)
    // A date and a time input rather than one `datetime-local`: two controls, each with its own label.
    expect(html).toContain('type="date"')
    expect(html).toContain('type="time"')
  })

  it('states the horizon on the form, so the refusal is not the first anybody hears of it', () => {
    // The figure comes from `app_setting` and is read once per request, so the hint and the refusal are
    // one answer. A screen that only mentioned the window when it refused would teach the desk nothing.
    expect(main({ horizonDays: 14 })).toContain('Up to 14 days back')
    expect(main({ horizonDays: 45 })).toContain('Up to 45 days back')
  })

  it('names both outcomes, and says which one puts money in the day', () => {
    const html = main()
    expect(html).toContain('data-testid="record-visit-outcome-completed"')
    expect(html).toContain('data-testid="record-visit-outcome-no_show"')
    expect(html).toContain('takings')
  })

  it('posts to its own path and nowhere else, and never puts the phone in a URL', () => {
    const html = main()
    expect(html).toContain(`action="${RECORD_VISIT_PATH}"`)
    expect(html).toMatch(/<form method="post"/)
    expect(html).not.toMatch(/<form[^>]*method="get"/)
    // ADR 0014: a query string is in every proxy log, and a mobile number is the customer's identity.
    expect(html).not.toContain('?phone=')
  })

  it('needs no JavaScript, and ships none', () => {
    // Quick-book has one inline script, which narrows its start list against the chosen treatment. There
    // is no list to narrow here — the start is typed — so this screen adds nothing.
    expect(renderRecordVisitHtml(BASE)).not.toContain('<script')
  })

  it('keeps what was typed when the entry is refused', () => {
    const filled = {
      ...EMPTY_FORM,
      phone: '+971500000000',
      variant: 'var-90',
      gender: 'female',
      date: '2027-01-15',
      time: '19:00',
      outcome: 'completed',
    }
    const html = main({
      form: filled as RecordVisitView['form'],
      refusal: recordVisitRefused('beyond_the_horizon'),
    })
    expect(html).toContain('value="+971500000000"')
    expect(html).toContain('value="2027-01-15"')
    expect(html).toContain('value="19:00"')
    // The chosen treatment and outcome too: a refusal that emptied the form would make the second attempt
    // as much work as the first, on a screen somebody only reaches because something was already missed.
    expect(html).toContain('value="var-90" selected')
    expect(html).toContain('value="completed" checked')
  })
})

describe('refusals', () => {
  it('has a sentence for every refusal, and renders it with its own name attached', () => {
    for (const name of RECORD_VISIT_REFUSALS) {
      const html = renderRecordVisitHtml({ ...BASE, refusal: recordVisitRefused(name) })
      expect(html, name).toContain(`data-record-visit-refusal="${name}"`)
      expect(adminMain(html), name).toContain(`data-refusal="${name}"`)
      // The sentence itself, not a code. Asserted over a slice of it, because the full text contains
      // typographic apostrophes that `safeText` escapes.
      expect(adminMain(html), name).toContain(RECORD_VISIT_SENTENCES[name].slice(0, 20))
    }
  })

  it('says a closed month was NOT written, and where the entry may go instead', () => {
    const html = main({
      refusal: recordVisitRefused(
        'period_closed',
        '2026-10-30 is inside a closed period. The earliest date still open is 2026-11-01.',
      ),
    })
    // The two facts the desk needs: nothing happened, and somebody else can do it. A refusal that only
    // said "closed" would send them to try again with a different date, which is a false entry.
    expect(html).toContain('has NOT been recorded')
    expect(html).toContain('accounts team')
    expect(html).toContain('2026-11-01')
  })

  it('shows the database’s own words beneath the sentence, never instead of it', () => {
    const html = main({
      refusal: recordVisitRefused('write_refused', 'therapist_not_eligible: not_rostered'),
    })
    expect(html).toContain(RECORD_VISIT_SENTENCES.write_refused.slice(0, 20))
    expect(html).toContain('therapist_not_eligible: not_rostered')
  })
})

describe('the check step', () => {
  const checked = {
    tradingDate: '2027-01-15',
    startLabel: '19:00',
    endLabel: '20:00',
    priceLabel: 'AED 350.00',
    outcome: 'completed' as const,
    therapists: [
      { therapistId: 'aaaaaaaa-0000-4000-8000-000000000001', reference: 'EMP-0007' },
      { therapistId: 'aaaaaaaa-0000-4000-8000-000000000002', reference: 'EMP-0003' },
    ],
    excluded: [{ reference: 'EMP-0011', reason: 'not_rostered' }],
    rooms: [
      { roomId: 'bbbbbbbb-0000-4000-8000-000000000001', label: 'Room 1 (room-1)', capacity: 1 },
    ],
  }

  it('shows the trading date and the figure before anything is written', () => {
    const html = main({ checked })
    expect(html).toContain('data-trading-date="2027-01-15"')
    expect(html).toContain('AED 350.00')
    expect(html).toContain('19:00')
  })

  it('offers only the therapists it was given, and says why the others are missing', () => {
    const html = main({ checked })
    expect(html).toContain('EMP-0007')
    expect(html).toContain('EMP-0003')
    // The excluded list is shown, because "they are not in the dropdown" is not an answer somebody at a
    // desk can act on. The reason is the read model's own vocabulary.
    expect(html).toContain('data-reason="not_rostered"')
    expect(html).toContain('EMP-0011')
  })

  it('is the only step that offers a therapist and a room', () => {
    const html = main({ checked })
    expect(html).toMatch(new RegExp(`name="${RECORD_VISIT_FIELDS.therapist}"`))
    expect(html).toMatch(new RegExp(`name="${RECORD_VISIT_FIELDS.room}"`))
  })

  it('carries the whole entry into the confirm POST, in the body', () => {
    const filled = {
      ...EMPTY_FORM,
      phone: '+971500000000',
      variant: 'var-60',
      outcome: 'completed',
    }
    const html = main({ form: filled as RecordVisitView['form'], checked })
    expect(html).toContain('data-testid="record-visit-confirm-form"')
    expect(html).toContain('<input type="hidden" name="step" value="record">')
    expect(html).toContain('<input type="hidden" name="phone" value="+971500000000">')
  })

  it('labels the figure by outcome, because a no-show is not money taken', () => {
    expect(main({ checked })).toContain('Into the takings')
    expect(main({ checked: { ...checked, outcome: 'no_show' } })).toContain('Not charged')
  })
})

describe('the recorded panel', () => {
  const recorded = {
    bookingId: 'cccccccc-0000-4000-8000-000000000001',
    appointmentIds: ['dddddddd-0000-4000-8000-000000000001'],
    tradingDate: '2027-01-15',
    outcome: 'completed' as const,
    startLabel: '19:00',
    priceLabel: 'AED 350.00',
    walked: ['confirmed', 'checked_in', 'in_progress', 'completed'],
  }

  it('lists the lifecycle it walked, rather than claiming the end state', () => {
    // The walk IS the point: the entry went through the same transition machine a live visit uses, so it
    // has the same history rows, audit rows and outbox events. A panel that said only "completed" would
    // be indistinguishable from an insert at the final status, which is the shortcut this unit refuses.
    const html = main({ recorded })
    expect(html).toContain('data-testid="record-visit-walked"')
    expect(html).toContain('confirmed → checked_in → in_progress → completed')
  })

  it('names the appointment, so the entry can be found in the diary', () => {
    const html = main({ recorded })
    expect(html).toContain('dddddddd-0000-4000-8000-000000000001')
    expect(html).toContain('data-booking="cccccccc-0000-4000-8000-000000000001"')
  })

  it('offers no way to record the same visit twice', () => {
    // The entry form is gone once something has been written. A reloaded confirmation that still carried a
    // filled-in form is how one treatment becomes two — and the second would be refused by the exclusion
    // constraint, which is the right backstop and the wrong thing for the desk to meet.
    const html = main({ recorded })
    expect(html).not.toContain('data-testid="record-visit-form"')
    expect(html).not.toContain('data-testid="record-visit-check"')
  })

  it('says a no-show was recorded without claiming money was taken', () => {
    const html = main({
      recorded: { ...recorded, outcome: 'no_show', walked: ['confirmed', 'no_show'] },
    })
    expect(html).toContain('No-show recorded')
    expect(html).not.toContain('Into the takings')
  })
})
