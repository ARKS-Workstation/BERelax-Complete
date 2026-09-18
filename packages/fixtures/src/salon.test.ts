import { businessDayFor, localTime } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_CLOSE,
  FIXTURE_CLOSED_MONTH,
  FIXTURE_NOW_ISO,
  FIXTURE_OPEN,
  FIXTURE_TIMEZONE,
  FIXTURE_TODAY,
} from './clock.ts'
import { salonReport } from './reports.ts'
import { DEFAULT_SEED, type FixtureAppointment, generateSalon, isPublishable } from './salon.ts'
import { digest } from './serialise.ts'
import {
  ALLOCATED_UAE_MOBILE_PREFIXES,
  CLINICAL_FIXTURE_PREFIX,
  REAL_BUSINESS_NUMBERS,
  SYNTHETIC_EMAIL_DOMAIN,
} from './synthetic.ts'

const salon = generateSalon()

describe('acceptance — the salon is reproducible', () => {
  it('produces byte-identical data from the same seed', () => {
    expect(digest(generateSalon())).toBe(digest(generateSalon()))
  })

  it('produces byte-identical reporting output from the same seed', () => {
    // A digest over the dataset would satisfy the criterion literally and prove less. A report is
    // where non-determinism actually shows up: it aggregates, sorts and rounds, and a sort with ties
    // broken by insertion order is the classic way a deterministic pipeline yields two spreadsheets.
    expect(digest(salonReport(generateSalon()))).toBe(digest(salonReport(generateSalon())))
  })

  it('produces different data from a different seed, so the seed is actually being used', () => {
    expect(digest(generateSalon(DEFAULT_SEED + 1))).not.toBe(digest(salon))
  })

  it('freezes the clock, so "today" does not move between runs', () => {
    expect(salon.generatedForIso).toBe(FIXTURE_NOW_ISO)
  })

  it('breaks ties in the utilisation report by id, not by insertion order', () => {
    const rows = salonReport(salon).utilisation
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]
      const current = rows[index]
      if (previous === undefined || current === undefined) continue
      if (previous.gross.fils === current.gross.fils) {
        expect(previous.therapistId < current.therapistId).toBe(true)
      }
    }
  })
})

describe('acceptance — the shape docs/12 section 5 describes', () => {
  it('has 12 services across both treatment styles', () => {
    expect(salon.services).toHaveLength(12)
    expect(new Set(salon.services.map((service) => service.style))).toEqual(
      new Set(['asian', 'arabic']),
    )
  })

  it('has 5 rooms, including a couples room and a wet room', () => {
    expect(salon.rooms).toHaveLength(5)
    expect(salon.rooms.filter((room) => room.capacity === 2)).toHaveLength(1)
    expect(salon.rooms.filter((room) => room.wet).length).toBeGreaterThan(0)
  })

  it('has 8 therapists with skills, genders and languages', () => {
    expect(salon.therapists).toHaveLength(8)
    for (const therapist of salon.therapists) {
      expect(therapist.skills.length).toBeGreaterThan(0)
      expect(therapist.languages.length).toBeGreaterThan(0)
    }
    expect(new Set(salon.therapists.map((t) => t.gender)).size).toBe(2)
  })

  it('covers both treatment styles in the roster, or half the catalogue is unbookable', () => {
    const skills = new Set(salon.therapists.flatMap((therapist) => therapist.skills))
    expect(skills).toEqual(new Set(['asian', 'arabic']))
  })

  it('gives every therapist a real portrait from the business\u2019s own site', () => {
    for (const therapist of salon.therapists) {
      expect(therapist.portrait.slot).toBe('therapist-portrait')
      expect(therapist.portrait.width).toBeGreaterThan(600)
      // Full-length shots with the face near the top: a centre crop would remove it.
      expect(therapist.portrait.focalY ?? 50).toBeLessThan(30)
    }
  })

  it('invents no names, so every therapist is unpublishable until an admin sets one', () => {
    // Nineteen photographs and zero names is the real launch state. ADR 0020's guard is only
    // exercised if the fixture is actually in it.
    for (const therapist of salon.therapists) {
      expect(therapist.displayName).toBeUndefined()
      expect(isPublishable(therapist)).toBe(false)
    }
  })

  it('records consent for some and not others, so the second half of the guard is exercised', () => {
    const consented = salon.therapists.filter((therapist) => therapist.photographyConsent)
    expect(consented.length).toBeGreaterThan(0)
    expect(consented.length).toBeLessThan(salon.therapists.length)
  })

  it('labels customers by record number rather than by an invented name', () => {
    for (const customer of salon.customers) {
      expect(customer.label).toMatch(/^Customer \d{4}$/)
    }
  })

  it('has a published rota covering every therapist', () => {
    const rostered = new Set(salon.shifts.map((shift) => shift.therapistId))
    expect(rostered.size).toBe(salon.therapists.length)
  })

  it('has roughly 200 historical and 40 forward bookings', () => {
    const historical = salon.appointments.filter((a) => a.state !== 'booked')
    const forward = salon.appointments.filter((a) => a.state === 'booked')
    expect(historical.length).toBeGreaterThan(150)
    expect(historical.length).toBeLessThan(260)
    expect(forward.length).toBeGreaterThan(25)
    expect(forward.length).toBeLessThan(60)
  })

  it('includes no-shows and cancellations, not only completions', () => {
    const states = new Set(salon.appointments.map((a) => a.state))
    expect(states).toContain('no_show')
    expect(states).toContain('cancelled')
    expect(states).toContain('completed')
  })

  it('has packages at four distinct drawdown states, including expired with a balance', () => {
    const states = new Set(
      salon.packages.map((pack) => `${pack.sessionsUsed}/${pack.sessionsTotal}`),
    )
    expect(states.size).toBeGreaterThanOrEqual(4)
    // Unredeemed sessions on an expired package are revenue that must be recognised. A fixture
    // without one leaves that path untested.
    const expired = salon.packages.filter(
      (pack) => pack.expiresOn < FIXTURE_TODAY && pack.sessionsUsed < pack.sessionsTotal,
    )
    expect(expired.length).toBeGreaterThan(0)
  })

  it('has one closed month, with its invoices locked', () => {
    const locked = salon.invoices.filter((invoice) => invoice.locked)
    expect(locked.length).toBeGreaterThan(0)
    for (const invoice of locked) {
      const [year, month] = invoice.businessDay.split('-')
      expect(Number(year)).toBe(FIXTURE_CLOSED_MONTH.year)
      expect(Number(month)).toBe(FIXTURE_CLOSED_MONTH.month)
    }
  })

  it('numbers invoices gap-free, which is what a tax authority looks for', () => {
    const serials = salon.invoices.map((invoice) => Number(invoice.number.split('-').at(-1)))
    expect(serials).toEqual(serials.map((_, index) => index + 1))
  })

  it('derives VAT so that net plus VAT is exactly gross, with no drift to explain', () => {
    for (const invoice of salon.invoices) {
      expect(invoice.totals.net.fils + invoice.totals.vat.fils).toBe(invoice.totals.gross.fils)
    }
  })
})

describe('the invariants the database will enforce', () => {
  const overlapping = (a: FixtureAppointment, b: FixtureAppointment): boolean =>
    a.startsAt < b.endsAt && b.startsAt < a.endsAt

  it('never puts a therapist in two places at once', () => {
    // The exclusion constraint of ADR 0015 would refuse this, so a seed that produced it could not
    // be loaded — and finding that out from a constraint violation during B-AVAIL is a bad day.
    const byTherapist = new Map<string, FixtureAppointment[]>()
    for (const appointment of salon.appointments) {
      const existing = byTherapist.get(appointment.therapistId) ?? []
      existing.push(appointment)
      byTherapist.set(appointment.therapistId, existing)
    }
    for (const [therapistId, appointments] of byTherapist) {
      const sorted = [...appointments].sort((a, b) => a.startsAt - b.startsAt)
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]
        const current = sorted[index]
        if (previous === undefined || current === undefined) continue
        expect(
          overlapping(previous, current),
          `${therapistId}: ${previous.id} overlaps ${current.id}`,
        ).toBe(false)
      }
    }
  })

  it('never exceeds a room’s capacity', () => {
    const capacity = new Map(salon.rooms.map((room) => [room.id, room.capacity]))
    for (const appointment of salon.appointments) {
      const concurrent = salon.appointments.filter(
        (other) => other.roomId === appointment.roomId && overlapping(appointment, other),
      ).length
      expect(concurrent).toBeLessThanOrEqual(capacity.get(appointment.roomId) ?? 1)
    }
  })

  it('puts a wet treatment in a wet room', () => {
    const wetRooms = new Set(salon.rooms.filter((room) => room.wet).map((room) => room.id))
    const wetServices = new Set(salon.services.filter((s) => s.wet).map((s) => s.id))
    for (const appointment of salon.appointments) {
      if (!wetServices.has(appointment.serviceId)) continue
      expect(wetRooms.has(appointment.roomId)).toBe(true)
    }
  })

  it('assigns a therapist who has the skill the treatment needs', () => {
    const styleOf = new Map(salon.services.map((service) => [service.id, service.style]))
    const skillsOf = new Map(salon.therapists.map((t) => [t.id, new Set(t.skills)]))
    for (const appointment of salon.appointments) {
      const style = styleOf.get(appointment.serviceId)
      expect(skillsOf.get(appointment.therapistId)?.has(style ?? 'asian')).toBe(true)
    }
  })
})

describe('business day, which is why the fixture trades past midnight', () => {
  const hours = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }

  it('assigns every appointment the business day its start falls in', () => {
    for (const appointment of salon.appointments) {
      expect(appointment.businessDay).toBe(
        businessDayFor(appointment.startsAt, hours, FIXTURE_TIMEZONE),
      )
    }
  })

  it('actually contains after-midnight appointments, or the concept is untested', () => {
    // A fixture trading 09:00 to 17:00 would leave the whole after-midnight path unexercised while
    // every test still passed.
    const afterMidnight = salon.appointments.filter((appointment) => {
      const local = new Date(appointment.startsAt + 4 * 3_600_000).toISOString().slice(0, 10)
      return local !== appointment.businessDay
    })
    expect(afterMidnight.length).toBeGreaterThan(0)
  })

  it('cuts the daily report on the business day, so takings after midnight land on the right night', () => {
    const rows = salonReport(salon).daily
    const days = rows.map((row) => row.businessDay)
    expect([...days].sort()).toEqual(days)
    expect(new Set(days).size).toBe(days.length)
  })
})

describe('no real personal data', () => {
  it('puts every phone number on an unallocated prefix, so none can ring a real handset', () => {
    for (const customer of salon.customers) {
      const prefix = customer.phone.replace('+971', '').slice(0, 2)
      expect(ALLOCATED_UAE_MOBILE_PREFIXES).not.toContain(prefix)
    }
  })

  it('collides with none of the business’s own numbers', () => {
    const numbers = new Set(salon.customers.map((customer) => customer.phone))
    for (const real of REAL_BUSINESS_NUMBERS) expect(numbers.has(real)).toBe(false)
  })

  it('gives every customer a unique number, because phone is the identity', () => {
    // Two customers sharing a number would merge under ADR 0014, and the fixture would silently
    // have one fewer customer than it claims.
    const numbers = salon.customers.map((customer) => customer.phone)
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  it('puts every email on a domain that cannot receive mail', () => {
    for (const customer of salon.customers) {
      expect(customer.email.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)).toBe(true)
    }
  })

  it('marks every clinical note as a fixture, so a screenshot cannot be mistaken for a record', () => {
    const withNotes = salon.customers.filter((customer) => customer.clinicalNote !== undefined)
    expect(withNotes.length).toBeGreaterThan(0)
    for (const customer of withNotes) {
      expect(customer.clinicalNote).toContain(CLINICAL_FIXTURE_PREFIX)
    }
  })

  it('leaves marketing consent off for most customers, as an honest consent record looks', () => {
    // A fixture where everyone consented makes the frequency cap and the suppression path
    // unreachable, and makes the marketing screens look better than they will.
    const consented = salon.customers.filter((customer) => customer.marketingConsent)
    expect(consented.length).toBeLessThan(salon.customers.length / 2)
    expect(consented.length).toBeGreaterThan(0)
  })
})
