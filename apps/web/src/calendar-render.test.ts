import {
  type CalendarAppointmentFacts,
  type CalendarDayFacts,
  calendarAxes,
  type Instant,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  type CalendarView,
  calendarAnnouncement,
  renderCalendarGridFragment,
  renderCalendarHtml,
  renderClosedDayHtml,
} from '../app/(admin)/calendar/render.ts'

/**
 * B-UI-03 — everything about the diary's markup that needs no database and no browser.
 *
 * The rendering is pure, so the escaping, the closed set of refusal words, which axis is a drop target and
 * which bands belong to which axis are all decidable here, in milliseconds, on every commit.
 * `apps/web/src/admin-calendar.itest.ts` holds what is not: the rows, the frozen clock, the transaction and
 * the four browser claims.
 */

const OPENS_AT = Date.parse('2099-06-17T07:00:00.000Z')
const CLOSES_AT = Date.parse('2099-06-17T22:00:00.000Z')
const ROOM = '00000000-0000-4000-8000-0000000000a1'
const THERAPIST = '00000000-0000-4000-8000-0000000000b1'
const APPOINTMENT = '00000000-0000-4000-8000-0000000000c1'

function appointment(overrides: Partial<CalendarAppointmentFacts> = {}): CalendarAppointmentFacts {
  return {
    id: APPOINTMENT,
    bookingId: '00000000-0000-4000-8000-0000000000d1',
    roomId: ROOM,
    therapistIds: [THERAPIST],
    delivery: { id: '00000000-0000-4000-8000-0000000000e1', places: 1 },
    treatment: {
      startsAt: Date.parse('2099-06-17T15:00:00.000Z') as Instant,
      endsAt: Date.parse('2099-06-17T15:45:00.000Z') as Instant,
    },
    turnaroundMinutes: 20,
    therapistBufferMinutes: 10,
    status: 'confirmed',
    shape: 'solo',
    serviceLabel: 'Normal Massage (Asian)',
    ...overrides,
  }
}

function view(overrides: Partial<CalendarDayFacts> = {}): CalendarView {
  const facts: CalendarDayFacts = {
    tradingDate: '2099-06-17',
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    rooms: [{ roomId: ROOM, code: 'R1', name: 'Room One', capacity: 1 }],
    therapists: [{ therapistId: THERAPIST, reference: 'Therapist 07' }],
    appointments: [appointment()],
    ...overrides,
  }
  return {
    // No banner, which is the state of a business whose Google connection is fine. The banner's own
    // branches are asserted in `google-reauth-banner.test.ts`; here it must not change the diary.
    chrome: { googleReauth: null, returnTo: '/calendar' },
    axes: calendarAxes(facts),
    currentTradingDate: '2099-06-17',
    previousTradingDate: '2099-06-16',
    nextTradingDate: '2099-06-18',
    opensAtLabel: '11:00',
    closesAtLabel: '02:00',
    outcome: { kind: 'none' },
  }
}

describe('the live region says what happened, in a closed set of words', () => {
  it('names the new time for a move and claims nothing for an unknown refusal', () => {
    expect(calendarAnnouncement({ kind: 'none' })).toBe('Nothing has been moved.')
    expect(
      calendarAnnouncement({ kind: 'moved', startsAtLabel: '19:15', roomLabel: 'R1 · Room One' }),
    ).toBe('Moved to 19:15 in R1 · Room One.')
    expect(calendarAnnouncement({ kind: 'refused', refusal: 'slot_taken' })).toContain(
      'already taken',
    )
    // A refusal name nobody wrote words for reaches the reader as words that claim nothing — and never as
    // the name itself, which would put a constraint in front of a receptionist.
    const unknown = calendarAnnouncement({ kind: 'refused', refusal: 'zb001_whatever' })
    expect(unknown).toContain('refused')
    expect(unknown).not.toContain('zb001')
    // The control: a refusal the table DOES know reads differently, so the fallback is a fallback.
    expect(unknown).not.toBe(calendarAnnouncement({ kind: 'refused', refusal: 'slot_taken' }))
  })
})

describe('the room axis is the drop target and the therapist axis is not', () => {
  it('marks every room card draggable and every therapist card not', () => {
    // Counted over the GRID rather than the document, because the stylesheet and the inline script both
    // mention `data-draggable="true"` — a count over the whole page would read three where one card exists,
    // and would go on passing if the card lost the attribute and the CSS kept it.
    const html = renderCalendarGridFragment(view())
    // One card per axis for one appointment, and only the room one may be moved: a therapist change needs
    // the client gender no table holds (B-AVAIL-05).
    expect(html.split(`data-testid="appointment-${APPOINTMENT}"`).length - 1).toBe(2)
    expect(html.split('data-draggable="true"').length - 1).toBe(1)
    expect(html.split('data-draggable="false"').length - 1).toBe(1)
    // `aria-pressed` only on the one a keyboard can pick up, because a button that is never pressed must not
    // claim a pressed state.
    expect(html.split('aria-pressed="false"').length - 1).toBe(1)
  })

  it('draws a completed treatment and does not offer it as a move', () => {
    // `completed` still HOLDS its resources, so the room really was occupied and the card belongs on the
    // grid — and it is terminal in the lifecycle, so every move from it is refused. A draggable card there
    // would be a control known to fail.
    const html = renderCalendarHtml(view({ appointments: [appointment({ status: 'completed' })] }))
    expect(html).toContain(`data-testid="appointment-${APPOINTMENT}"`)
    expect(html).toContain('data-status="completed"')
    expect(
      renderCalendarGridFragment(view({ appointments: [appointment({ status: 'completed' })] })),
    ).not.toContain('data-draggable="true"')
    // Nor through the no-JavaScript form, which would otherwise be the one route to that refusal.
    expect(html).not.toContain('<form class="move"')
    // The control: the same card `confirmed` IS movable both ways, so the exclusion is about the status.
    const confirmed = renderCalendarHtml(view())
    expect(renderCalendarGridFragment(view())).toContain('data-draggable="true"')
    expect(confirmed).toContain('<form class="move"')
  })

  it('draws the turnaround on the room axis and the buffer on the therapist axis', () => {
    const html = renderCalendarGridFragment(view())
    expect(html).toContain(
      'data-testid="room-turnaround-band" data-band="turnaround" data-axis="room"',
    )
    expect(html).toContain(
      'data-testid="therapist-buffer-band" data-band="therapist_buffer" data-axis="therapist"',
    )
    // One turnaround, two buffer halves: the therapist is held either side of the treatment.
    expect(html.split('data-testid="room-turnaround-band"').length - 1).toBe(1)
    expect(html.split('data-testid="therapist-buffer-band"').length - 1).toBe(2)
    // The control: configured zeroes draw no bands at all rather than empty ones a test would still find.
    const flat = renderCalendarGridFragment(
      view({ appointments: [appointment({ turnaroundMinutes: 0, therapistBufferMinutes: 0 })] }),
    )
    expect(flat).not.toContain('data-testid="room-turnaround-band"')
    expect(flat).not.toContain('data-testid="therapist-buffer-band"')
  })

  it('reads a card as a time range and the minutes each resource is held for', () => {
    const html = renderCalendarGridFragment(view())
    // 19:00–19:45 Dubai, and the held minutes in WORDS beside it: a band told only by colour cannot be read
    // by a colour-blind operator, which docs/08 treats as a defect.
    expect(html).toContain('19:00–19:45')
    expect(html).toContain('room held 20 min after')
    expect(html).toContain('therapist held 10 min either side')
  })
})

describe('the document carries one live region, one grid and the script', () => {
  it('renders the region as a status with a polite live setting', () => {
    const html = renderCalendarHtml(view())
    expect(html.split('data-testid="calendar-live"').length - 1).toBe(1)
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toContain('data-calendar-moves="0"')
    expect(html).toContain('<script>')
    // The no-JavaScript path: a POST form, never a GET, because a GET that moved an appointment would be a
    // write on a link a crawler could follow.
    expect(html).toContain('<form class="move" method="post" action="/calendar?date=2099-06-17"')
    expect(html).toContain('<button type="submit">Move it</button>')
  })

  it('puts the room axis FIRST, because rooms are the scarce resource', () => {
    // The primary axis, asserted as ORDER rather than as presence: both sections exist in either
    // arrangement, and a diary whose first grid is the therapists is a different screen — the one this unit
    // deliberately did not build. docs/09 §2 and the unit's own summary say which way round it goes.
    const html = renderCalendarGridFragment(view())
    expect(html.indexOf('data-testid="axis-room"')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('data-testid="axis-room"')).toBeLessThan(
      html.indexOf('data-testid="axis-therapist"'),
    )
    // And the room grid is the one a drop can land on, which is the other half of "primary".
    const therapistsFrom = html.indexOf('data-testid="axis-therapist"')
    expect(html.slice(therapistsFrom)).not.toContain('data-draggable="true"')
  })

  it('renders the grid fragment without the document around it', () => {
    const fragment = renderCalendarGridFragment(view())
    expect(fragment).toContain('data-testid="axis-room"')
    expect(fragment).toContain('data-testid="axis-therapist"')
    // The fragment is what the script paints into the page, so it must not carry a second <html>, a second
    // live region or a second copy of the script.
    expect(fragment).not.toContain('<!doctype html>')
    expect(fragment).not.toContain('data-testid="calendar-live"')
    expect(fragment).not.toContain('<script>')
    // And it is a SUBSTRING of the document, which is what "one renderer, no second opinion" means.
    expect(renderCalendarHtml(view())).toContain(fragment)
  })

  it('renders an empty day as lanes with no cards, not as a missing grid', () => {
    const html = renderCalendarHtml(view({ appointments: [], therapists: [] }))
    // A room lane for every room, even with nothing in it: an empty room is what a receptionist is looking
    // for. The therapist axis, with nobody working, says so instead of drawing an empty frame.
    expect(html).toContain('data-testid="axis-room"')
    expect(html).toContain(`data-lane-id="${ROOM}"`)
    expect(html).toContain('The same appointments, read a second way')
    // No cards, because there is nothing on the day. The CSS still mentions `data-draggable`, so what is
    // asserted is the absence of the ELEMENTS rather than of the string.
    expect(html).not.toContain('class="card"')
    // With no appointment there is nothing to move, so the form is absent rather than offering an empty
    // select — a control whose only option is nothing is a control that cannot be used.
    expect(html).not.toContain('<form class="move"')
  })

  it('names a closed date and offers the way back, with no grid and no script', () => {
    const html = renderClosedDayHtml({
      tradingDate: '2099-06-20',
      currentTradingDate: '2099-06-17',
      chrome: { googleReauth: null, returnTo: '/calendar' },
    })
    expect(html).toContain('data-testid="calendar-closed"')
    expect(html).toContain('2099-06-20')
    expect(html).toContain('/calendar?date=2099-06-17')
    expect(html).not.toContain('data-testid="axis-room"')
    expect(html).not.toContain('<script>')
  })
})

describe('nothing a row carries can become markup', () => {
  it('escapes a room name, a therapist handle and a service label', () => {
    const nasty = '<script>alert(1)</script>'
    const html = renderCalendarHtml(
      view({
        rooms: [{ roomId: ROOM, code: nasty, name: nasty, capacity: 1 }],
        therapists: [{ therapistId: THERAPIST, reference: nasty }],
        appointments: [appointment({ serviceLabel: nasty })],
      }),
    )
    // The page has exactly one script element — its own — and the injected one is text.
    expect(html.split('<script>').length - 1).toBe(1)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The control on the assertion: the same value unescaped WOULD be markup, so the escaping is doing the
    // work rather than the value being harmless.
    expect(nasty).toContain('<script>')
  })

  it('identifies no customer, in any field the grid could have carried one in', () => {
    // A diary answers "what is in which room when". The grid is the screen most likely to be left open on a
    // desk where anybody in the reception area can read it, and `readCalendarDay` selects no customer column
    // at all — this is the second layer of the same rule. The prose on the page does use the word
    // "customer", which is why what is asserted is the VALUES: no booking id, no telephone number, no
    // electronic address, nowhere.
    const html = renderCalendarHtml(view())
    const facts = appointment()
    expect(html).not.toContain(facts.bookingId)
    expect(html).not.toContain(facts.delivery?.id ?? 'no delivery')
    expect(html).not.toMatch(/\+9715\d{8}/)
    // The control: the appointment id IS there, because a card has to name the row a move is about — so the
    // assertions above are about which ids reach the page rather than about ids in general.
    expect(html).toContain(facts.id)
  })
})
