import { describe, expect, it } from 'vitest'
import {
  buildAppointmentIcs,
  escapeIcsText,
  foldIcsLine,
  ICS_PRODUCT_ID,
  type IcsAppointment,
  icsDiscretionBreaches,
  icsInstant,
} from './ics.ts'

/**
 * The calendar file: the wire format, and the discretion rule the writer enforces.
 *
 * Every assertion about "the file is discreet" is paired with the file that is not, because a discretion
 * check has one obvious failure mode: the caller passes an empty withhold list, the check finds nothing,
 * and the gate reports a clean file for ever. So the leak is produced on purpose in three places — the
 * summary, the description and the location — and each is asserted to be REFUSED by name.
 */

const START = Date.parse('2026-09-24T15:45:00.000Z')
const END = Date.parse('2026-09-24T16:45:00.000Z')
const STAMPED = Date.parse('2026-09-23T09:00:00.000Z')

/** A discreet file: the time, the place, a link, and nothing about what was booked or with whom. */
const discreet = (over: Partial<IcsAppointment> = {}): IcsAppointment => ({
  uid: '0199aa00-0000-7000-8000-000000000001',
  dtstampAt: STAMPED,
  startsAt: START,
  endsAt: END,
  summary: 'BE RELAX appointment',
  description: 'Your appointment. Details and changes are on the booking page.',
  location: 'Al Barsha 1, Dubai',
  url: 'https://berelax.example/book',
  withhold: ['Normal Massage (Asian)', 'asian_style', 'Therapist 07'],
  ...over,
})

const ok = (input: IcsAppointment): string => {
  const result = buildAppointmentIcs(input)
  if (!result.ok) throw new Error(`expected a file, got a refusal: ${result.leaked.join(', ')}`)
  return result.ics
}

describe('the wire format', () => {
  it('writes UTC instants in RFC 5545s basic form', () => {
    expect(icsInstant(START)).toBe('20260924T154500Z')
    // The milliseconds are gone and the separators are gone. A value that kept either is rejected by
    // some clients and silently reinterpreted by others.
    expect(icsInstant(START)).not.toContain('.')
    expect(icsInstant(START)).not.toContain(':')
    expect(icsInstant(START)).not.toContain('-')
  })

  it('escapes backslash before the characters whose escapes contain one', () => {
    // The order is the correctness. Escaping the comma first and the backslash afterwards produces
    // `a\\,b`, which is a literal backslash followed by an unescaped comma — and the value truncates.
    expect(escapeIcsText('a\\b')).toBe('a\\\\b')
    expect(escapeIcsText('Dubai, UAE')).toBe('Dubai\\, UAE')
    expect(escapeIcsText('a;b')).toBe('a\\;b')
    expect(escapeIcsText('one\r\ntwo\nthree')).toBe('one\\ntwo\\nthree')
    expect(escapeIcsText('a\\,b')).toBe('a\\\\\\,b')
  })

  it('folds at 75 octets and counts octets rather than characters', () => {
    const short = 'SUMMARY:short'
    expect(foldIcsLine(short)).toBe(short)

    const long = `DESCRIPTION:${'x'.repeat(200)}`
    const folded = foldIcsLine(long)
    expect(folded).toContain('\r\n ')
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length, line).toBeLessThanOrEqual(75)
    }
    // Unfolding restores the original exactly, which is the property a reader depends on.
    expect(folded.split('\r\n ').join('')).toBe(long)

    // Arabic: 40 characters that are 80 octets. A fold that counted characters would leave this
    // unfolded, and a client that enforces the limit truncates the line.
    const arabic = `DESCRIPTION:${'ش'.repeat(40)}`
    expect(arabic.length).toBeLessThan(75)
    expect(new TextEncoder().encode(arabic).length).toBeGreaterThan(75)
    const foldedArabic = foldIcsLine(arabic)
    expect(foldedArabic).toContain('\r\n ')
    for (const line of foldedArabic.split('\r\n')) {
      expect(new TextEncoder().encode(line).length, line).toBeLessThanOrEqual(75)
    }
    // And no code point was split: every fragment round-trips through the encoder unchanged.
    expect(foldedArabic.split('\r\n ').join('')).toBe(arabic)
    expect(foldedArabic).not.toContain('�')
  })

  it('produces a complete VCALENDAR with CRLF line endings', () => {
    const ics = ok(discreet())
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain(`PRODID:${ICS_PRODUCT_ID}`)
    expect(ics).toContain('VERSION:2.0')
    expect(ics).toContain('METHOD:PUBLISH')
    expect(ics).toContain(`DTSTART:${icsInstant(START)}`)
    expect(ics).toContain(`DTEND:${icsInstant(END)}`)
    expect(ics).toContain(`DTSTAMP:${icsInstant(STAMPED)}`)
    expect(ics).toContain('TRANSP:OPAQUE')
    // No ORGANIZER: this is a file the customer adds to their own calendar, not an invitation from the
    // salon that puts the premises' mailbox in their diary and invites a reply nobody reads.
    expect(ics).not.toContain('ORGANIZER')
    // Every line ends CRLF. A file with bare newlines imports in some clients and not others.
    expect(ics.split('\r\n').every((line) => !line.includes('\n'))).toBe(true)
  })

  it('carries the booking id as the UID so a second download is not a second appointment', () => {
    const ics = ok(discreet())
    expect(ics).toContain('UID:0199aa00-0000-7000-8000-000000000001')
    // The same appointment produced twice at two DTSTAMPs keeps one UID, which is what makes the second
    // download an UPDATE in the reader's calendar rather than a duplicate that fires its own reminder.
    const again = ok(discreet({ dtstampAt: STAMPED + 3_600_000 }))
    expect(again).toContain('UID:0199aa00-0000-7000-8000-000000000001')
    expect(again).not.toBe(ics)
  })

  it('omits URL entirely when there is nowhere to send the reader', () => {
    // Rather than an empty value. `URL:` with nothing after it is a property a client may render as a
    // broken link, and this build has no manage-booking page to point at yet (B-UI-05).
    const ics = ok(discreet({ url: null }))
    expect(ics).not.toContain('URL:')
    expect(ok(discreet())).toContain('URL:https://berelax.example/book')
  })
})

describe('the discretion rule (docs/06 D2)', () => {
  it('produces a file naming neither the treatment, the style nor the therapist', () => {
    const ics = ok(discreet())
    for (const withheld of discreet().withhold) {
      expect(ics.toLowerCase(), withheld).not.toContain(withheld.toLowerCase())
    }
    // And the SUMMARY specifically, which is the line a lock screen shows.
    const summary = ics.split('\r\n').find((line) => line.startsWith('SUMMARY:')) ?? ''
    expect(summary).toBe('SUMMARY:BE RELAX appointment')
  })

  it('refuses a file whose SUMMARY names the treatment, and says which value leaked', () => {
    // The control, and the real defect: a well-meaning "make the calendar entry useful" change to one
    // copy string. Without this the assertion above is satisfied by a summary nobody ever changed.
    const result = buildAppointmentIcs(discreet({ summary: 'Normal Massage (Asian) — 60 minutes' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.leaked).toEqual(['Normal Massage (Asian)'])
  })

  it('refuses a leak in the DESCRIPTION and in the LOCATION, not only in the SUMMARY', () => {
    // A check scoped to the summary passes on both of these, and a calendar syncs the description to the
    // same devices. This is why the check is over the produced file rather than over one field.
    const inDescription = buildAppointmentIcs(
      discreet({ description: 'With Therapist 07. Please arrive ten minutes early.' }),
    )
    expect(inDescription.ok).toBe(false)
    if (!inDescription.ok) expect(inDescription.leaked).toEqual(['Therapist 07'])

    const inLocation = buildAppointmentIcs(
      discreet({ location: 'Al Barsha 1, Dubai (asian_style room)' }),
    )
    expect(inLocation.ok).toBe(false)
    if (!inLocation.ok) expect(inLocation.leaked).toEqual(['asian_style'])
  })

  it('reports every leaked value rather than the first', () => {
    const result = buildAppointmentIcs(
      discreet({
        summary: 'Normal Massage (Asian)',
        description: 'Therapist 07 will look after you.',
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.leaked).toEqual(['Normal Massage (Asian)', 'Therapist 07'])
  })

  it('matches case-insensitively and ignores a blank withheld value', () => {
    // Case, because a copy string that lower-cased the treatment name would otherwise pass. Blank,
    // because a therapist with no published name has nothing to withhold and `''` matches every file —
    // which would refuse every single download.
    expect(
      icsDiscretionBreaches('SUMMARY:normal massage (asian)', ['Normal Massage (Asian)']),
    ).toEqual(['Normal Massage (Asian)'])
    expect(icsDiscretionBreaches('SUMMARY:BE RELAX appointment', ['', '   '])).toEqual([])
    expect(ok(discreet({ withhold: [''] }))).toContain('SUMMARY:')
  })

  it('finds a leak that only exists after escaping', () => {
    // The escape is applied before the check for exactly this: a value containing a comma is written as
    // `Deep\, Tissue`, so a check on the INPUT string would look for `Deep, Tissue` in a file that does
    // not contain it — and a check on the input would therefore miss the half a comma splits.
    const result = buildAppointmentIcs(
      discreet({ summary: 'Deep Tissue, 60 minutes', withhold: ['Deep Tissue'] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.leaked).toEqual(['Deep Tissue'])
  })
})
