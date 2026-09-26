import {
  CONTRAINDICATION_FALSE_MEANING,
  CONTRAINDICATION_FLAG_LABELS,
  resolveContraindicationAccess,
} from '@berelax/core'
import { CONTRAINDICATION_FLAG_KEYS, type ContraindicationFlagSet } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type FlagsPageView,
  renderFlagsPageHtml,
} from '../app/(admin)/clients/[id]/flags/render.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * The screen the boolean-only crossing ends at (C-CRM-09).
 *
 * Asserted on the BYTES of the document and not on the return value of a function, which is the whole point:
 * a round-trip test proves a flag came back, and only the bytes prove that an answer, a question label and a
 * date did not come with it. `renderFlagsPageHtml` is pure — a view in, a string out — so this needs no
 * server, no database and no port band.
 *
 * Every case here drives the view through `resolveContraindicationAccess`, not through a hand-made `access`
 * object. A hand-made one would let this file describe a screen the policy layer never produces, which is
 * how a render test comes to pass about a reader that cannot exist.
 */

const CUSTOMER = 'c0ffee00-0000-7000-8000-000000000001'
const THERAPIST = 'e1111111-1111-7111-8111-111111111111'
const OTHER = 'e2222222-2222-7222-8222-222222222222'

const CHROME: AdminChrome = {
  googleReauth: null,
  returnTo: `/clients/${CUSTOMER}/flags`,
}

/** Answers a client is imagined to have given, and the questions they were asked. Never on this page. */
const QUESTION_LABEL = 'Any surgery in the last six months?'
const ANSWER_VALUE = 'SYNTHETIC-ANSWER-ONLY-4QK7'

const flagSet = (over: Partial<ContraindicationFlagSet> = {}): ContraindicationFlagSet =>
  Object.freeze({
    ...(Object.fromEntries(
      CONTRAINDICATION_FLAG_KEYS.map((key) => [key, false]),
    ) as ContraindicationFlagSet),
    ...over,
  })

const view = (over: Partial<FlagsPageView> = {}): FlagsPageView => ({
  chrome: CHROME,
  customerId: CUSTOMER,
  direction: 'ltr',
  role: 'receptionist',
  employeeId: OTHER,
  access: resolveContraindicationAccess({
    role: 'receptionist',
    employeeId: OTHER,
    assignedTherapistIds: [THERAPIST],
  }),
  outcome: { kind: 'flags', flags: flagSet({ recent_surgery: true }) },
  ...over,
})

describe('acceptance — what a reader who may NOT see the detail receives', () => {
  const html = renderFlagsPageHtml(view())

  it('shows that there is something to check, by marker and not by answer', () => {
    expect(html).toContain('data-outcome="flags"')
    expect(html).toContain('data-flag="recent_surgery" data-set="true"')
    expect(html).toContain(CONTRAINDICATION_FLAG_LABELS.recent_surgery)
    expect(html).toContain('To check before the appointment')
  })

  it('is refused the detail BY NAME, and offers no link to it', () => {
    expect(html).toContain('data-refusal="note_not_permitted_for_role"')
    // The absence that matters: no route to the page that holds the answers.
    expect(html).not.toContain('data-detail-href')
    expect(html).not.toContain('/intake')
  })

  it('contains no answer, no question label, no count and no date', () => {
    // The four things the crossing is defined by the absence of, asserted on the response body.
    expect(html).not.toContain(ANSWER_VALUE)
    expect(html).not.toContain(QUESTION_LABEL)
    expect(html.toLowerCase()).not.toContain('surgery in the last')
    // No count of set flags anywhere. `1 of 8`, `1 marker`, a badge — each one is a measure of how ill
    // somebody is, and each would travel through a heading into a log line.
    expect(html).not.toMatch(/\b\d+\s*(of|\/)\s*8\b/)
    expect(html).not.toMatch(/\b\d+ (marker|flag)s?\b/i)
    // No instant. The crossing carries none (migration 0084 drops `updated_at` from the view), so an
    // ISO-8601 date or time on this page could only have been invented here.
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(html).not.toMatch(/\d{2}:\d{2}/)
  })

  it('lists EVERY flag of the closed set, so an empty page cannot mean two things', () => {
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      expect(html, `${key} is not on the page`).toContain(`data-flag="${key}"`)
    }
    expect((html.match(/data-flag="/g) ?? []).length).toBe(CONTRAINDICATION_FLAG_KEYS.length)
  })

  it('words a false flag as "not affirmed" and never as cleared', () => {
    expect(html).toContain('Not flagged')
    expect(html).toContain(CONTRAINDICATION_FALSE_MEANING)
    // The control on the wording, and it is not pedantry: "no contraindications" is what a reader assumes,
    // and the form may never have asked.
    for (const wrong of ['all clear', 'no contraindications', 'none recorded', 'cleared for']) {
      expect(html.toLowerCase(), `the page says "${wrong}"`).not.toContain(wrong)
    }
  })

  it('names nobody — the client is an id and the reader is their own employee id', () => {
    expect(html).toContain(`data-customer="${CUSTOMER}"`)
    expect(html).toContain(OTHER)
    expect(html).not.toMatch(/Customer \d{4}/)
  })
})

describe('acceptance — the assigned therapist, and the unassigned one', () => {
  const assigned = renderFlagsPageHtml(
    view({
      role: 'therapist',
      employeeId: THERAPIST,
      access: resolveContraindicationAccess({
        role: 'therapist',
        employeeId: THERAPIST,
        assignedTherapistIds: [THERAPIST],
      }),
    }),
  )
  const unassigned = renderFlagsPageHtml(
    view({
      role: 'therapist',
      employeeId: OTHER,
      access: resolveContraindicationAccess({
        role: 'therapist',
        employeeId: OTHER,
        assignedTherapistIds: [THERAPIST],
      }),
    }),
  )

  it('tells the assigned therapist where the detail is, and still prints no answer here', () => {
    expect(assigned).toContain('data-detail-href')
    expect(assigned).toContain(`/clients/${CUSTOMER}/intake`)
    // NOT an anchor. That page refuses a request with no stated reason, so every link this one could emit
    // lands on a 400 — and filling in a reason here would be this page inventing why somebody opened a
    // health record, which is the one value on that audit row that must be committed to beforehand.
    expect(assigned).not.toMatch(/<a[^>]*\/intake/)
    // The path is a route to a page with its own step-up gate, not a render of the answers.
    expect(assigned).not.toContain(ANSWER_VALUE)
    expect(assigned).not.toContain(QUESTION_LABEL)
  })

  it('refuses the unassigned therapist BOTH, and tells them nothing about the client', () => {
    expect(unassigned).toContain('data-refusal="therapist_not_assigned"')
    expect(unassigned).toContain('data-scope="flags"')
    // Not one marker, not the closed set, not even the fact that a note exists. A reader who may not know
    // that a marker is set must not learn which second rule would also have refused them.
    expect(unassigned).not.toContain('data-flag=')
    expect(unassigned).not.toContain('data-outcome="flags"')
    expect(unassigned).not.toContain('data-scope="note"')
    expect(unassigned).not.toContain('data-detail-href')
  })

  it('refuses a role that holds neither permission, without mentioning the client at all', () => {
    const marketer = renderFlagsPageHtml(
      view({
        role: 'marketer',
        access: resolveContraindicationAccess({
          role: 'marketer',
          employeeId: OTHER,
          assignedTherapistIds: [THERAPIST],
        }),
      }),
    )
    expect(marketer).toContain('data-refusal="flags_not_permitted_for_role"')
    expect(marketer).not.toContain('data-flag=')
  })
})

describe('acceptance — "nothing derived" is not "nothing to flag"', () => {
  const notDerived = renderFlagsPageHtml(view({ outcome: { kind: 'not_derived' } }))
  const allFalse = renderFlagsPageHtml(view({ outcome: { kind: 'flags', flags: flagSet() } }))

  it('renders the two as different pages', () => {
    expect(notDerived).toContain('data-outcome="not_derived"')
    expect(notDerived).not.toContain('data-flag=')
    expect(notDerived).toContain('not the same as having none')
    // The control, and the reason this test exists: eight falses is a page that says "not flagged" eight
    // times, and a derivation that has never run would look identical if it reused it.
    expect(allFalse).toContain('data-outcome="flags"')
    expect(allFalse).not.toContain('data-outcome="not_derived"')
    expect(notDerived).not.toBe(allFalse)
  })
})

describe('the document itself', () => {
  it('is noindex, mirrors on ?dir=rtl, and emits the admin banner inside the landmark', () => {
    const html = renderFlagsPageHtml(view())
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).toContain('dir="ltr"')
    expect(renderFlagsPageHtml(view({ direction: 'rtl' }))).toContain('dir="rtl"')
    // The banner is emitted after `<main>` and never before it: a region outside every landmark is
    // reachable by a screen reader only through "all content", which for a warning is not good enough.
    expect(html.indexOf('<main>')).toBeLessThan(html.indexOf('</main>'))
    expect(html.indexOf('<main>')).toBeGreaterThan(-1)
  })

  it('escapes what it prints, and the escaping is observable', () => {
    // A customer id arrives from a URL segment. It is a uuid in every real case and it is not validated as
    // one here, so the page has to escape it — and the assertion is on the escaped BYTES rather than on the
    // absence of a tag, which a stripped value would also satisfy.
    const html = renderFlagsPageHtml(view({ customerId: '<script>x</script>' }))
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('uses no literal colour, so `pnpm colours` has nothing to find', () => {
    // The tokens layer is the only place a hex may appear. Asserted here as well as by the gate, because a
    // clinical marker rendered in a hand-picked red is the one place somebody reaches for a literal.
    const source = renderFlagsPageHtml(view())
    const own = source.slice(source.indexOf('ul.flags'))
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
