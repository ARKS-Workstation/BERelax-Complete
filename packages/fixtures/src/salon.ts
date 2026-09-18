/**
 * The fixture salon: docs/12 §5, generated deterministically.
 *
 * 12 services, 5 rooms, 8 therapists with skills, genders and languages, a published rota, ~200
 * historical and 40 forward bookings, packages at several drawdown states, invoices, one closed
 * month.
 *
 * ## Why this is a generator rather than a SQL file
 *
 * The product schema does not exist yet — services, rooms, appointments and invoices are built by
 * `B-CAT`, `B-AVAIL`, `B-LIFE` and `M-VAT`, all of which come after this unit. Writing INSERTs now
 * would mean writing them against a schema that has not been designed, and rewriting them when it is.
 *
 * So the durable artifact is the **dataset**, as plain values. Later units add loaders that write it
 * to their own tables; the shape, the volumes, the edge cases and the determinism are settled here
 * and do not move. `load.ts` carries the loaders for the tables that exist today.
 *
 * ## The invariants the generator respects
 *
 * A seed that violates a database constraint cannot be loaded, so the generator obeys the rules the
 * schema will enforce rather than discovering them later:
 *
 * - **No therapist is in two places.** The scheduler places appointments into per-therapist
 *   timelines and never overlaps them, which is the `btree_gist` exclusion constraint of ADR 0015
 *   satisfied in advance.
 * - **No room exceeds its capacity.** A couples room holds two concurrent appointments; a single
 *   room holds one.
 * - **Every appointment sits inside trading hours**, including the ones after midnight, which belong
 *   to the previous business day.
 */
import {
  addMinutes,
  aedFrom,
  businessDayFor,
  fromLocal,
  type Instant,
  instantToIso,
  type LocalDate,
  localDate,
  localTime,
  type Money,
  splitGross,
  type VatBreakdown,
} from '@berelax/core'
import {
  FIXTURE_CLOSE,
  FIXTURE_CLOSED_MONTH,
  FIXTURE_FORWARD_DAYS,
  FIXTURE_HISTORY_DAYS,
  FIXTURE_NOW,
  FIXTURE_OPEN,
  FIXTURE_TIMEZONE,
  FIXTURE_TODAY,
} from './clock.ts'
import { assetsForSlot, type MediaAsset } from './media.ts'
import { createRng, type Rng } from './rng.ts'
import {
  assertSynthetic,
  customerLabel,
  syntheticClinicalNote,
  syntheticPerson,
  therapistReference,
} from './synthetic.ts'

export const DEFAULT_SEED = 20260918

export type TreatmentStyle = 'asian' | 'arabic'
export type Gender = 'female' | 'male'

export interface FixtureService {
  readonly id: string
  readonly style: TreatmentStyle
  readonly treatment: string
  readonly treatmentAr: string
  readonly durationMinutes: 45 | 60 | 90 | 120
  /** VAT-inclusive, as decision 7 requires. */
  readonly priceGross: Money
  /** True for Morocco Bath and Jacuzzi, which need a wet room and a longer turnaround. */
  readonly wet: boolean
}

export interface FixtureRoom {
  readonly id: string
  readonly name: string
  readonly capacity: 1 | 2
  readonly wet: boolean
}

export interface FixtureTherapist {
  readonly id: string
  /**
   * An internal reference for the rota and the scheduler. Never shown to a customer.
   *
   * A therapist is identified in the back office long before anybody decides what name goes on the
   * website, and conflating the two is how an internal label ends up published.
   */
  readonly reference: string
  /**
   * The public name, set by the admin. **Absent for every therapist in this fixture**, because the
   * business's site has nineteen photographs and no names, and the build does not invent them.
   */
  readonly displayName?: string
  readonly displayNameAr?: string
  readonly gender: Gender
  readonly skills: readonly TreatmentStyle[]
  readonly languages: readonly ('en' | 'ar' | 'tl' | 'th')[]
  /** ADR 0020: publishing needs a name AND a recorded consent. Neither is assumed. */
  readonly photographyConsent: boolean
  /** The real photograph from the business's own site. Never a placeholder, never stock. */
  readonly portrait: MediaAsset
}

export interface FixtureShift {
  readonly therapistId: string
  readonly businessDay: LocalDate
  readonly startsAt: Instant
  readonly endsAt: Instant
}

export type AppointmentState = 'completed' | 'no_show' | 'cancelled' | 'booked'

export interface FixtureAppointment {
  readonly id: string
  readonly customerId: string
  readonly therapistId: string
  readonly roomId: string
  readonly serviceId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  /** The trading day it belongs to, which for an 01:30 appointment is the day before. */
  readonly businessDay: LocalDate
  readonly state: AppointmentState
  readonly priceGross: Money
  /** Set when the appointment drew down a package rather than being paid for. */
  readonly packageId?: string
}

export interface FixtureCustomer {
  readonly id: string
  /** A record label such as `Customer 0042`. Not a name; see `synthetic.ts`. */
  readonly label: string
  readonly labelAr: string
  readonly phone: string
  readonly email: string
  readonly gender: Gender
  /** Marketing consent defaults false; the fixture gives it to a minority, as reality does. */
  readonly marketingConsent: boolean
  readonly preferredLocale: 'en' | 'ar'
  /** Obviously synthetic, and only on the minority of customers who would really have one. */
  readonly clinicalNote?: string
}

export interface FixturePackage {
  readonly id: string
  readonly customerId: string
  readonly templateName: string
  readonly sessionsTotal: number
  readonly sessionsUsed: number
  readonly purchasedGross: Money
  readonly purchasedOn: LocalDate
  readonly expiresOn: LocalDate
}

export interface FixtureInvoice {
  readonly id: string
  readonly number: string
  readonly customerId: string
  readonly businessDay: LocalDate
  readonly totals: VatBreakdown
  readonly appointmentIds: readonly string[]
  /** True for an invoice in the closed month, which may no longer be amended. */
  readonly locked: boolean
}

export interface FixtureSalon {
  readonly seed: number
  readonly generatedForIso: string
  readonly services: readonly FixtureService[]
  readonly rooms: readonly FixtureRoom[]
  readonly therapists: readonly FixtureTherapist[]
  readonly customers: readonly FixtureCustomer[]
  readonly shifts: readonly FixtureShift[]
  readonly appointments: readonly FixtureAppointment[]
  readonly packages: readonly FixturePackage[]
  readonly invoices: readonly FixtureInvoice[]
}

/**
 * The catalogue: 12 services from the real menu in docs/13 §4.
 *
 * Not the full 32 price points. Twelve is what docs/12 §5 asks for, and it is the right number for a
 * fixture: enough to fill a menu, exercise both styles, cover every duration and include the wet
 * treatments that need a different room and a longer turnaround. The full catalogue is real data and
 * belongs to `B-CAT`'s seed, not to the demo salon.
 */
const CATALOGUE: readonly {
  style: TreatmentStyle
  treatment: string
  treatmentAr: string
  wet: boolean
  prices: readonly { minutes: 45 | 60 | 90 | 120; aed: number }[]
}[] = [
  {
    style: 'asian',
    treatment: 'Normal Massage',
    treatmentAr: 'المساج العادي',
    wet: false,
    prices: [
      { minutes: 45, aed: 170 },
      { minutes: 60, aed: 200 },
      { minutes: 90, aed: 300 },
    ],
  },
  {
    style: 'asian',
    treatment: 'Hot Oil / Balm Massage',
    treatmentAr: 'مساج الزيت الساخن',
    wet: false,
    prices: [
      { minutes: 60, aed: 250 },
      { minutes: 90, aed: 350 },
    ],
  },
  {
    style: 'asian',
    treatment: 'Morocco Bath or Jacuzzi',
    treatmentAr: 'الحمام المغربي أو الجاكوزي',
    wet: true,
    prices: [
      { minutes: 60, aed: 300 },
      { minutes: 90, aed: 440 },
    ],
  },
  {
    style: 'arabic',
    treatment: 'Normal Massage',
    treatmentAr: 'المساج العادي',
    wet: false,
    prices: [
      { minutes: 60, aed: 250 },
      { minutes: 90, aed: 350 },
    ],
  },
  {
    style: 'arabic',
    treatment: 'Hot Oil / Balm Massage',
    treatmentAr: 'مساج الزيت الساخن',
    wet: false,
    prices: [
      { minutes: 90, aed: 400 },
      { minutes: 120, aed: 500 },
    ],
  },
  {
    style: 'arabic',
    treatment: 'Morocco Bath or Jacuzzi',
    treatmentAr: 'الحمام المغربي أو الجاكوزي',
    wet: true,
    prices: [{ minutes: 90, aed: 520 }],
  },
]

function buildServices(): FixtureService[] {
  const services: FixtureService[] = []
  for (const entry of CATALOGUE) {
    for (const price of entry.prices) {
      services.push({
        id: `svc-${entry.style}-${slug(entry.treatment)}-${price.minutes}`,
        style: entry.style,
        treatment: entry.treatment,
        treatmentAr: entry.treatmentAr,
        durationMinutes: price.minutes,
        priceGross: aedFrom(price.aed),
        wet: entry.wet,
      })
    }
  }
  return services
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Five rooms, and the two that are not ordinary.
 *
 * One couples room at capacity 2, which is the only reason the room-capacity trigger exists rather
 * than another exclusion constraint. Two wet rooms, because the Morocco Bath cannot be delivered in a
 * dry room and a scheduler that ignores that produces a rota nobody can work.
 */
const ROOMS: readonly FixtureRoom[] = [
  { id: 'room-1', name: 'Room 1', capacity: 1, wet: false },
  { id: 'room-2', name: 'Room 2', capacity: 1, wet: false },
  { id: 'room-3', name: 'Room 3', capacity: 1, wet: false },
  { id: 'room-couples', name: 'Couples Room', capacity: 2, wet: false },
  { id: 'room-wet-1', name: 'Wet Room 1', capacity: 1, wet: true },
]

/**
 * Whether a therapist page may be published.
 *
 * Derived, never stored as a flag. ADR 0020 requires a display name and a recorded photography
 * consent; a boolean somebody sets is a boolean somebody sets wrongly, and the guard then exists in
 * the data model and nowhere on screen.
 */
export function isPublishable(therapist: FixtureTherapist): boolean {
  return therapist.displayName !== undefined && therapist.photographyConsent
}

/**
 * Eight therapists, each carrying a real portrait from the business's own site and no name.
 *
 * No name is the point. Nineteen photographs and zero names is the actual launch state, so every
 * therapist here is unpublishable until an admin supplies one — which means every screen that lists
 * therapists has to handle that case, rather than handling it in theory.
 */
function buildTherapists(rng: Rng): FixtureTherapist[] {
  const roster = rng.fork('therapists')
  const portraits = assetsForSlot('therapist-portrait')
  const therapists: FixtureTherapist[] = []
  for (let index = 0; index < 8; index += 1) {
    const portrait = portraits[index % portraits.length]
    if (portrait === undefined) throw new Error('the media library has no therapist portraits')
    // Style is a treatment attribute, not a therapist one (ADR 0021) — but it maps to a required
    // skill, so the roster must cover both or half the catalogue is unbookable.
    const skills: TreatmentStyle[] =
      index % 3 === 0 ? ['asian', 'arabic'] : index % 2 === 0 ? ['asian'] : ['arabic']
    therapists.push({
      id: `thr-${index + 1}`,
      reference: therapistReference(index + 1),
      gender: index % 4 === 3 ? 'male' : 'female',
      skills,
      languages: index % 3 === 1 ? ['ar', 'en'] : index % 3 === 2 ? ['en', 'tl'] : ['en', 'th'],
      // Consent is recorded for some and not others, because that is the state a real consent
      // register is in partway through collecting it. It is the second half of the publish guard,
      // and without the variation the guard is never exercised in both directions.
      photographyConsent: index % 3 !== 2,
      portrait,
    })
    void roster
  }
  return therapists
}

function buildCustomers(rng: Rng, count: number): FixtureCustomer[] {
  const people = rng.fork('customers')
  const customers: FixtureCustomer[] = []
  for (let index = 0; index < count; index += 1) {
    const person = syntheticPerson(index + 1)
    assertSynthetic(person)
    // Marketing consent defaults false and is the minority, because that is what a consent record
    // built honestly looks like. A fixture where everyone consented makes the frequency cap and the
    // suppression path unreachable.
    const marketingConsent = people.chance(0.35)
    const hasNote = people.chance(0.18)
    customers.push({
      id: `cus-${String(index + 1).padStart(4, '0')}`,
      label: person.label,
      labelAr: customerLabel(index + 1, 'ar'),
      phone: person.phone,
      email: person.email,
      gender: people.chance(0.72) ? 'female' : 'male',
      marketingConsent,
      preferredLocale: people.chance(0.4) ? 'ar' : 'en',
      ...(hasNote
        ? {
            clinicalNote: syntheticClinicalNote(
              people.pick([
                'avoid deep pressure on the lower back',
                'mild sensitivity to almond oil',
                'prefers no scalp work',
                'recent shoulder strain, keep pressure light',
              ]),
            ),
          }
        : {}),
    })
  }
  return customers
}

/** Days, oldest first, spanning the fixture's history and its forward book. */
function tradingDays(): LocalDate[] {
  const days: LocalDate[] = []
  const start = new Date(`${FIXTURE_TODAY}T00:00:00Z`).getTime()
  for (let offset = -FIXTURE_HISTORY_DAYS; offset <= FIXTURE_FORWARD_DAYS; offset += 1) {
    const day = new Date(start + offset * 86_400_000)
    days.push(localDate(day.toISOString().slice(0, 10)))
  }
  return days
}

/**
 * The published rota.
 *
 * Every therapist works most days, and the shift runs the full trading window. A more elaborate rota
 * would be more realistic and would make the fixture harder to read; what matters here is that the
 * availability engine has coverage to work with and that `HR` has shifts to accrue leave against.
 */
function buildShifts(
  rng: Rng,
  therapists: readonly FixtureTherapist[],
  days: readonly LocalDate[],
): FixtureShift[] {
  const rota = rng.fork('rota')
  const shifts: FixtureShift[] = []
  for (const day of days) {
    for (const therapist of therapists) {
      // One day off a week each, drawn deterministically.
      if (rota.chance(1 / 7)) continue
      const startsAt = fromLocal(day, localTime(FIXTURE_OPEN), FIXTURE_TIMEZONE)
      // The close is the next calendar day, which is the whole point of business_day.
      const closeOnNextDay = localDate(
        new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10),
      )
      const endsAt = fromLocal(closeOnNextDay, localTime(FIXTURE_CLOSE), FIXTURE_TIMEZONE)
      shifts.push({ therapistId: therapist.id, businessDay: day, startsAt, endsAt })
    }
  }
  return shifts
}

interface Placement {
  readonly therapistId: string
  readonly roomId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
}

/** Minutes between one appointment ending and the next starting in the same room or therapist. */
const TURNAROUND_MINUTES = 15
const WET_TURNAROUND_MINUTES = 30

/**
 * Places appointments without ever double-booking a therapist or over-filling a room.
 *
 * This is the part of the generator that is real work rather than data entry. The database will
 * refuse an overlap (ADR 0015), so a seed that produces one cannot be loaded — and finding that out
 * from a constraint violation during `B-AVAIL` would be a bad day. Doing it here also settles the
 * turnaround question: a wet treatment needs the room cleaned, so its successor starts later.
 */
class Scheduler {
  private readonly byTherapist = new Map<string, Placement[]>()
  private readonly byRoom = new Map<string, Placement[]>()

  fits(placement: Placement, roomCapacity: number, wet: boolean): boolean {
    const gap = wet ? WET_TURNAROUND_MINUTES : TURNAROUND_MINUTES
    const therapistBusy = this.byTherapist.get(placement.therapistId) ?? []
    if (therapistBusy.some((existing) => overlaps(existing, placement, gap))) return false
    const roomBusy = this.byRoom.get(placement.roomId) ?? []
    const concurrent = roomBusy.filter((existing) => overlaps(existing, placement, gap)).length
    return concurrent < roomCapacity
  }

  place(placement: Placement): void {
    push(this.byTherapist, placement.therapistId, placement)
    push(this.byRoom, placement.roomId, placement)
  }
}

function push(map: Map<string, Placement[]>, key: string, value: Placement): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, [value])
  else existing.push(value)
}

function overlaps(a: Placement, b: Placement, gapMinutes: number): boolean {
  const gap = gapMinutes * 60_000
  return a.startsAt - gap < b.endsAt && b.startsAt - gap < a.endsAt
}

function buildAppointments(
  rng: Rng,
  services: readonly FixtureService[],
  therapists: readonly FixtureTherapist[],
  customers: readonly FixtureCustomer[],
  days: readonly LocalDate[],
): FixtureAppointment[] {
  const book = rng.fork('appointments')
  const scheduler = new Scheduler()
  const appointments: FixtureAppointment[] = []
  const workable = therapists.filter((therapist) => therapist.skills.length > 0)
  let serial = 0

  for (const day of days) {
    const isFuture = day > FIXTURE_TODAY
    // Friday and Saturday are the busy nights here; a flat distribution makes every day view look
    // the same and hides the capacity problem the rota screen exists to show.
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    const busy = weekday === 5 || weekday === 6
    // Tuned to the volumes docs/12 section 5 asks for: roughly 200 behind and 40 ahead. The forward
    // book is thinner than the history on purpose — a spa four weeks out is mostly empty, and a
    // fixture that fills it hides the very thing the availability screen exists to show.
    const target = isFuture ? (busy ? 3 : 1) : busy ? 3 : 1

    for (
      let attempt = 0;
      attempt < target * 3 && countForDay(appointments, day) < target;
      attempt += 1
    ) {
      const service = book.pick(services)
      const eligible = workable.filter((therapist) => therapist.skills.includes(service.style))
      if (eligible.length === 0) continue
      const therapist = book.pick(eligible)
      const room = book.pick(ROOMS.filter((candidate) => candidate.wet === service.wet))
      const customer = book.pick(customers)

      // Start on a quarter hour between 11:00 and the last start that still fits before close.
      const latestStartMinute = 15 * 60 - service.durationMinutes
      const startMinute =
        11 * 60 + book.int(0, Math.max(0, Math.floor(latestStartMinute / 15))) * 15
      const startsAt = fromLocal(day, minutesToLocalTime(startMinute), FIXTURE_TIMEZONE)
      const endsAt = addMinutes(startsAt, service.durationMinutes)
      const placement = { therapistId: therapist.id, roomId: room.id, startsAt, endsAt }
      if (!scheduler.fits(placement, room.capacity, service.wet)) continue
      scheduler.place(placement)

      serial += 1
      const state: AppointmentState = isFuture
        ? 'booked'
        : book.chance(0.05)
          ? 'no_show'
          : book.chance(0.04)
            ? 'cancelled'
            : 'completed'

      appointments.push({
        id: `apt-${String(serial).padStart(5, '0')}`,
        customerId: customer.id,
        therapistId: therapist.id,
        roomId: room.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        businessDay: businessDayFor(
          startsAt,
          { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) },
          FIXTURE_TIMEZONE,
        ),
        state,
        priceGross: service.priceGross,
      })
    }
  }

  return appointments
}

function countForDay(appointments: readonly FixtureAppointment[], day: LocalDate): number {
  return appointments.filter((appointment) => appointment.businessDay === day).length
}

function minutesToLocalTime(minutes: number) {
  const hour = Math.floor(minutes / 60) % 24
  const minute = minutes % 60
  return localTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
}

/**
 * Packages at several drawdown states.
 *
 * Deliberately one of each interesting case rather than a random spread: untouched, part-used,
 * fully used, and expired-with-balance. The last one is the case that matters to the accounts —
 * unredeemed sessions on an expired package are revenue that must be recognised, and a fixture
 * without one leaves that path untested.
 */
function buildPackages(rng: Rng, customers: readonly FixtureCustomer[]): FixturePackage[] {
  const packs = rng.fork('packages')
  const chosen = packs.shuffle([...customers]).slice(0, 12)
  const states = [
    { total: 5, used: 0, label: 'untouched' },
    { total: 5, used: 2, label: 'part-used' },
    { total: 5, used: 5, label: 'fully used' },
    { total: 10, used: 3, label: 'expired with balance' },
  ]
  return chosen.map((customer, index) => {
    const state = states[index % states.length] ?? states[0]
    const expired = state?.label === 'expired with balance'
    const purchasedOn = shiftDay(FIXTURE_TODAY, expired ? -200 : -packs.int(10, 90))
    return {
      id: `pkg-${String(index + 1).padStart(3, '0')}`,
      customerId: customer.id,
      templateName: `${state?.total ?? 5}-session package`,
      sessionsTotal: state?.total ?? 5,
      sessionsUsed: state?.used ?? 0,
      purchasedGross: aedFrom((state?.total ?? 5) * 250),
      purchasedOn,
      expiresOn: shiftDay(purchasedOn, 180),
    }
  })
}

function shiftDay(day: LocalDate, offsetDays: number): LocalDate {
  const shifted = new Date(new Date(`${day}T00:00:00Z`).getTime() + offsetDays * 86_400_000)
  return localDate(shifted.toISOString().slice(0, 10))
}

/**
 * One invoice per completed appointment, numbered gap-free.
 *
 * Gap-free is not decoration: a missing number is the first thing a tax authority asks about, and a
 * PostgreSQL sequence cannot provide it because `nextval` is non-transactional (ADR 0017). The
 * fixture numbers them by position so the property is visible in the data rather than asserted about
 * a mechanism that is not built yet.
 */
function buildInvoices(appointments: readonly FixtureAppointment[]): FixtureInvoice[] {
  const billable = appointments.filter((appointment) => appointment.state === 'completed')
  return billable.map((appointment, index) => {
    const locked = isInClosedMonth(appointment.businessDay)
    return {
      id: `inv-${String(index + 1).padStart(5, '0')}`,
      number: `INV-2026-${String(index + 1).padStart(6, '0')}`,
      customerId: appointment.customerId,
      businessDay: appointment.businessDay,
      totals: splitGross(appointment.priceGross),
      appointmentIds: [appointment.id],
      locked,
    }
  })
}

function isInClosedMonth(day: LocalDate): boolean {
  const [year, month] = day.split('-')
  return Number(year) === FIXTURE_CLOSED_MONTH.year && Number(month) === FIXTURE_CLOSED_MONTH.month
}

/** Generates the whole salon. Same seed, same bytes, every time, on every machine. */
export function generateSalon(seed: number = DEFAULT_SEED): FixtureSalon {
  const rng = createRng(seed)
  const services = buildServices()
  const therapists = buildTherapists(rng)
  const customers = buildCustomers(rng, 140)
  const days = tradingDays()
  const shifts = buildShifts(rng, therapists, days)
  const appointments = buildAppointments(rng, services, therapists, customers, days)
  const packages = buildPackages(rng, customers)
  const invoices = buildInvoices(appointments)

  return {
    seed,
    generatedForIso: instantToIso(FIXTURE_NOW),
    services,
    rooms: ROOMS,
    therapists,
    customers,
    shifts,
    appointments,
    packages,
    invoices,
  }
}
