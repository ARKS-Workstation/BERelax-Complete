import { type GenderMatchingMode, genderMatchingMode } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import {
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
} from '../time.ts'
import { assignShape, MOROCCO_BATH_SHAPE } from './assign-shape.ts'
import {
  assertPoolIsTotal,
  type EligibleTherapist,
  type TherapistGender,
  type TherapistPool,
} from './eligibility-port.ts'
import { narrowPoolByGender, solveGenderMatchedAvailability } from './gender-match.ts'
import type { Room } from './room-predicates.ts'
import type { SlotRequest, TherapistShift } from './solve.ts'

/**
 * B-AVAIL-05 — zero cross-gender assignments, over randomised clients and rosters, with **no setting
 * row present**.
 *
 * The acceptance line asks for at least 5,000 cases; this runs {@link RUNS} of them against the mode a
 * database with no `app_setting` row produces. "No row" is not simulated by passing `'strict'` — that
 * would assert the strict path and prove nothing about the default. It is simulated the way it actually
 * arrives: the generator produces the values a real read can hand back when nothing has been configured,
 * or when what was configured has stopped being legal (an absent row, a `jsonb` null, the `'off'` a
 * previous registry schema allowed, a stale capitalisation, a number), and every one of them goes
 * through `genderMatchingMode` — the same normaliser `readGenderMatching` applies.
 * `packages/db/src/settings/availability.itest.ts` proves the other half against real PostgreSQL: an
 * `app_setting` table with zero rows still reads `'strict'`.
 *
 * ## The oracle is written independently
 *
 * A returned slot is checked by looking every offered therapist id up in the **generated roster** and
 * comparing that gender to the generated client's, with a plain `!==`. It does not call
 * `sameGenderMatch`, `genderVerdict` or anything else the module under test uses to decide, because an
 * oracle expressed in the functions it is checking proves only self-consistency. The assignment layer is
 * driven for the same reason: `assignShape` sorts therapists by id, so an id that reached the slot would
 * reach the booking.
 *
 * ## The checker is proved able to fail
 *
 * Two mutants at the bottom — a rule that merely *sorts* the cross-gender therapist lower, and one that
 * treats an unrecorded gender as a wildcard — are run through the same oracle, which must report
 * violations. A property suite whose oracle cannot fail asserts nothing, however many cases it runs.
 *
 * ## Cost
 *
 * The hours are a constant and nothing inside the property touches a date library: a previous unit's
 * property test built its trading windows inside the property, called `Intl` four million times and
 * timed out. Only the roster, the genders, the client and the raw setting value vary.
 */
const RUNS = 5_200

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const DATE: LocalDate = localDate('2026-10-01')
const NOW: Instant = instantFromIso('2026-10-01T11:00:00+04:00')
const OPENS: Instant = instantFromIso('2026-10-01T11:00:00+04:00')
const CLOSES: Instant = instantFromIso('2026-10-02T02:00:00+04:00')

const ROOMS: readonly Room[] = [
  { id: 'room-1', roomType: 'standard', capacity: 2, isBookable: true },
  { id: 'room-2', roomType: 'wet', capacity: 1, isBookable: true },
]

/**
 * What a setting read can hand back when nobody has configured anything.
 *
 * `undefined` is the missing row — the state of every freshly migrated database, since 0010 creates the
 * tables and seeds no values. Every member of this list must mean strict.
 */
const UNSET_VALUES: readonly unknown[] = [
  undefined,
  null,
  '',
  'off',
  'OFF',
  'Strict',
  'STRICT',
  'Advisory',
  'advisory ',
  0,
  1,
  true,
  {},
  [],
]

const genderArb: fc.Arbitrary<TherapistGender | undefined> = fc.constantFrom(
  'female',
  'male',
  undefined,
)

interface Roster {
  readonly pool: TherapistPool
  readonly genderOf: ReadonlyMap<string, TherapistGender | undefined>
}

/**
 * A roster of between one and six therapists, each with a gender or none, each rostered for a
 * randomised span of the day.
 *
 * The spans vary so that the therapists a slot has available differ from slot to slot — with one span
 * for everybody, every slot would offer the same list and the property would be one case repeated.
 */
const rosterArb: fc.Arbitrary<Roster> = fc
  .array(
    fc.record({
      gender: genderArb,
      /** Minutes after opening that the shift starts, and how long it runs. */
      startOffset: fc.integer({ min: 0, max: 8 * 60 }),
      lengthMinutes: fc.integer({ min: 60, max: 15 * 60 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((entries) => {
    const therapists: EligibleTherapist[] = []
    const shifts: TherapistShift[] = []
    const genderOf = new Map<string, TherapistGender | undefined>()
    entries.forEach((entry, index) => {
      // Ids are `t0`…`t5` and deliberately ascending, so `assignShape`'s sort by id picks the lowest
      // index: if the rule merely reordered a list instead of narrowing it, the first therapist would
      // win and the oracle below would see it.
      const therapistId = `t${index}`
      therapists.push({
        therapistId,
        skills: ['asian_style'],
        ...(entry.gender === undefined ? {} : { gender: entry.gender }),
      })
      const startsAt = (OPENS + entry.startOffset * 60_000) as Instant
      const endsAt = Math.min(startsAt + entry.lengthMinutes * 60_000, CLOSES) as Instant
      shifts.push({ therapistId, period: { startsAt, endsAt } })
      genderOf.set(therapistId, entry.gender)
    })
    return { pool: { therapists, shifts, excluded: [] }, genderOf }
  })

const baseRequest = (rooms: readonly Room[]): Omit<SlotRequest, 'therapistIds' | 'shifts'> => ({
  now: NOW,
  tradingDate: DATE,
  hoursFor: HOURS_FOR,
  closures: [],
  durationMinutes: 60,
  turnaroundMinutes: 20,
  therapistBufferMinutes: 10,
  minLeadMinutes: 0,
  maxAdvanceDays: 90,
  rooms,
  compatibleRoomTypes: ['standard', 'wet'],
  appointments: [],
  blocks: [],
  stepMinutes: 60,
})

/** One case's input. */
interface Case {
  readonly roster: Roster
  readonly clientGender: TherapistGender | undefined
  readonly storedValue: unknown
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  roster: rosterArb,
  clientGender: genderArb,
  storedValue: fc.constantFrom(...UNSET_VALUES),
})

/**
 * Every offered therapist whose gender is not, independently, the client's.
 *
 * The oracle. A plain lookup and a `!==`, over the generated roster — no call into the module under
 * test, and `undefined !== 'female'` covers the unrecorded-gender case without a special branch.
 */
function crossGenderOffers(args: {
  readonly roster: Roster
  readonly clientGender: TherapistGender | undefined
  readonly offered: readonly (readonly string[])[]
}): readonly string[] {
  const { roster, clientGender, offered } = args
  const wrong: string[] = []
  for (const ids of offered) {
    for (const id of ids) {
      if (roster.genderOf.get(id) !== clientGender) wrong.push(id)
    }
  }
  return wrong
}

/**
 * How much the run actually exercised.
 *
 * A property over an empty result set passes without asserting anything, and a generator that refused
 * every case — a third of generated clients have no gender — would do exactly that. Counted rather
 * than sampled, and asserted after the run.
 */
interface Exercised {
  slots: number
  ids: number
  assignments: number
  refusals: number
}

/** The therapists `assignShape` would actually book for each offered start. */
function assignedPerSlot(solution: {
  readonly slots: readonly {
    readonly availableRoomIds: readonly string[]
    readonly availableTherapistIds: readonly string[]
    readonly treatment: { readonly startsAt: Instant; readonly endsAt: Instant }
  }[]
}): readonly (readonly string[])[] {
  return solution.slots.flatMap((slot) => {
    const result = assignShape({
      shape: MOROCCO_BATH_SHAPE,
      rooms: ROOMS.filter((room) => slot.availableRoomIds.includes(room.id)),
      therapistIds: slot.availableTherapistIds,
      treatment: slot.treatment,
      appointments: [],
    })
    return result.kind === 'assigned' ? [result.assignment.therapistIds] : []
  })
}

/**
 * Everything wrong with one case, as sentences. Empty is a pass.
 *
 * Collected rather than thrown one at a time so the message beside fast-check's shrunk counterexample
 * says everything that was wrong with it: "a slot was wrong" without saying who is a day's work to
 * reproduce.
 */
function violationsFor(input: Case, exercised: Exercised): readonly string[] {
  const { roster, clientGender, storedValue } = input
  const faults: string[] = []
  // Exactly what the database reader does: whatever came out of the row, through the normaliser.
  const mode = genderMatchingMode(storedValue)
  if (mode !== 'strict') {
    faults.push(`an unset setting resolved to ${mode} for ${JSON.stringify(storedValue)}`)
  }

  const solution = solveGenderMatchedAvailability({
    ...baseRequest(ROOMS),
    pool: roster.pool,
    clientGender,
    genderMatching: mode,
  })

  if (clientGender === undefined) {
    exercised.refusals += 1
    // Unknown client gender is a NAMED refusal, never a permissive day and never a bare empty list.
    if (solution.refusal !== 'requires_client_gender') {
      faults.push(`an unknown client gender was answered with refusal ${String(solution.refusal)}`)
    }
    if (solution.slots.length > 0) {
      faults.push(`an unknown client gender produced ${solution.slots.length} slots`)
    }
    return faults
  }

  if (solution.refusal !== null) {
    faults.push(`a known client gender was refused with ${solution.refusal}`)
  }
  exercised.slots += solution.slots.length
  exercised.ids += solution.slots.reduce((n, slot) => n + slot.availableTherapistIds.length, 0)

  const wrong = crossGenderOffers({
    roster,
    clientGender,
    offered: solution.slots.map((slot) => slot.availableTherapistIds),
  })
  if (wrong.length > 0) {
    const roles = [...roster.genderOf].map(([id, gender]) => `${id}=${String(gender)}`).join(' ')
    faults.push(
      `offered ${[...new Set(wrong)].join(', ')} to a ${clientGender} client; genders were ${roles}`,
    )
  }
  // Every slot claims compliance, and in strict mode there is nothing else it could claim.
  const flagged = solution.slots.filter(
    (slot) => slot.genderMismatch !== false || slot.crossGenderTherapistIds.length > 0,
  )
  if (flagged.length > 0) {
    faults.push(`strict mode returned ${flagged.length} slots flagged as cross-gender`)
  }

  // And the assignment layer, because "never offered" and "never assigned" are two claims.
  const assigned = assignedPerSlot(solution)
  exercised.assignments += assigned.length
  const misassigned = crossGenderOffers({ roster, clientGender, offered: assigned })
  if (misassigned.length > 0) {
    faults.push(`assigned ${misassigned.join(', ')} to a ${clientGender} client`)
  }

  // The pool still accounts for every candidate it was asked about: a therapist in neither list reads
  // as a shorter roster, which is the one failure invisible from outside.
  const narrowed = narrowPoolByGender({ pool: roster.pool, clientGender, genderMatching: mode })
  assertPoolIsTotal(
    narrowed.pool,
    roster.pool.therapists.map((each) => each.therapistId),
  )
  return faults
}

describe('acceptance — with no setting row present, zero cross-gender assignments', () => {
  it(`offers and assigns nobody of the wrong gender across ${RUNS} randomised cases`, () => {
    const exercised: Exercised = { slots: 0, ids: 0, assignments: 0, refusals: 0 }

    fc.assert(
      fc.property(caseArb, (input) => {
        const faults = violationsFor(input, exercised)
        // Thrown rather than returned false: fast-check prints the message beside the shrunk
        // counterexample, and a bare `false` says only that something was wrong.
        if (faults.length > 0) throw new Error(faults.join('; '))
        return true
      }),
      { numRuns: RUNS },
    )

    // The cases really ran, in both directions: slots were offered in bulk, therapists were assigned,
    // and the refusal branch was exercised rather than merely available.
    expect(exercised.slots).toBeGreaterThan(RUNS)
    expect(exercised.ids).toBeGreaterThan(RUNS)
    expect(exercised.assignments).toBeGreaterThan(RUNS / 4)
    expect(exercised.refusals).toBeGreaterThan(RUNS / 10)
    // 30 seconds, not vitest's default 5.
    //
    // This is a CORRECTNESS property, not a performance one: ~5,200 generated cases through the solver,
    // asserting that nobody of the wrong gender is ever offered or assigned. On an idle box it takes about
    // two seconds, which sounds like plenty of margin and is not — under four concurrent verify runs it was
    // measured at 5,677ms and failed outright, and it is the most likely identity of the 1-in-3,784 failure
    // inside the "coverage thresholds reject an uncovered file" gate, whose own comment already blames a
    // load timeout for sending two earlier units hunting the fixture's size.
    //
    // The case count stays at RUNS because the acceptance line names it; the timeout moves instead. Third
    // instance of this shape in one session — see `search-analytics.test.ts`'s 60,000-row paging case and
    // `availability-perf.itest.ts`'s p95 budget — which is why it is written out rather than just widened:
    // a correctness test with an implicit performance budget fails for a reason its own name does not
    // mention, and somebody then goes looking in the wrong place.
  }, 30_000)

  it('is not vacuous: the same day DOES return slots once a gender is on both sides', () => {
    // Without this, "no cross-gender offers" is satisfied by a rule that offers nothing at all.
    const matching: TherapistPool = {
      therapists: [{ therapistId: 't0', skills: ['asian_style'], gender: 'female' }],
      shifts: [{ therapistId: 't0', period: { startsAt: OPENS, endsAt: CLOSES } }],
      excluded: [],
    }
    const solution = solveGenderMatchedAvailability({
      ...baseRequest(ROOMS),
      pool: matching,
      clientGender: 'female',
      genderMatching: genderMatchingMode(undefined),
    })
    expect(solution.slots.length).toBeGreaterThan(5)
    expect(solution.slots.every((slot) => slot.availableTherapistIds.includes('t0'))).toBe(true)
  })
})

describe('the oracle can fail', () => {
  /** One therapist of each gender and one with none, all present all day. */
  const mixed: Roster = {
    pool: {
      therapists: [
        { therapistId: 't0', skills: ['asian_style'], gender: 'male' },
        { therapistId: 't1', skills: ['asian_style'], gender: 'female' },
        { therapistId: 't2', skills: ['asian_style'] },
      ],
      shifts: ['t0', 't1', 't2'].map((therapistId) => ({
        therapistId,
        period: { startsAt: OPENS, endsAt: CLOSES },
      })),
      excluded: [],
    },
    genderOf: new Map([
      ['t0', 'male'],
      ['t1', 'female'],
      ['t2', undefined],
    ]),
  }

  it('catches a rule that names the cross-gender therapist instead of removing them', () => {
    // The mutant is the failure the acceptance line names: an ineligible therapist must not be offered,
    // not merely sorted lower. Advisory is the shipped mode that does not narrow the pool, so reading
    // its slots as though the flag were not there produces exactly the list such a strict rule would.
    const notRemoved = solveGenderMatchedAvailability({
      ...baseRequest(ROOMS),
      pool: mixed.pool,
      clientGender: 'female',
      genderMatching: 'advisory',
    })
    const offered = notRemoved.slots.map((slot) => [
      ...slot.availableTherapistIds,
      ...slot.crossGenderTherapistIds,
    ])
    expect(
      crossGenderOffers({ roster: mixed, clientGender: 'female', offered }).length,
    ).toBeGreaterThan(0)
  })

  it('catches a rule that treats an unrecorded gender as a wildcard', () => {
    // `t2` has no gender on record. A permissive rule keeps them for every client, and the oracle sees
    // it because `undefined !== 'female'`.
    const wildcard = [mixed.pool.therapists.map((each) => each.therapistId)]
    const wrong = crossGenderOffers({ roster: mixed, clientGender: 'female', offered: wildcard })
    expect(wrong).toContain('t2')
    expect(wrong).toContain('t0')
    expect(wrong).not.toContain('t1')
  })

  it('and the shipped rule removes both of them', () => {
    const shipped = solveGenderMatchedAvailability({
      ...baseRequest(ROOMS),
      pool: mixed.pool,
      clientGender: 'female',
      // `'off'` normalises to strict, which is the whole fail-safe in one argument.
      genderMatching: genderMatchingMode('off') satisfies GenderMatchingMode,
    })
    expect(shipped.slots.length).toBeGreaterThan(0)
    for (const slot of shipped.slots) expect(slot.availableTherapistIds).toEqual(['t1'])
  })
})
