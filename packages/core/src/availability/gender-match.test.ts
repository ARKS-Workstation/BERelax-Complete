import { type GenderMatchingMode, genderMatchingMode } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import {
  ASIA_DUBAI,
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
  toLocal,
} from '../time.ts'
import { assignShape, MOROCCO_BATH_SHAPE } from './assign-shape.ts'
import {
  assertPoolIsTotal,
  ELIGIBILITY_EXCLUSION_REASONS,
  type EligibleTherapist,
  genderVerdict,
  poolSolverInput,
  sameGenderMatch,
  type TherapistGender,
  type TherapistPool,
} from './eligibility-port.ts'
import {
  type GenderMatchedRequest,
  type GenderMatchedSolution,
  narrowPoolByGender,
  solveGenderMatchedAvailability,
} from './gender-match.ts'
import type { Room } from './room-predicates.ts'
import { type SlotRequest, solveAvailability, type TherapistShift } from './solve.ts'

/**
 * B-AVAIL-05 — same-gender matching as a HARD constraint, default strict.
 *
 * Three claims, and each of them has a control that must fail if the claim is faked:
 *
 *   1. **strict is what you get for saying nothing** — no mode, an unreadable mode, and the `'off'` a
 *      previous registry schema allowed all resolve to strict, and the control is that `'advisory'`
 *      exactly does something different, so "everything is strict" cannot be satisfied by a constant;
 *   2. **hard means never offered** — the ineligible therapist is removed from the pool the solver is
 *      given, proved with a spy on the solver's only access to a therapist's presence: if the solver
 *      ever considered them, it had to read `shift.period`. The control is advisory mode, where the same
 *      therapist IS considered and the same spy fires;
 *   3. **an unknown client gender is a named refusal, not an empty day** — zero slots AND
 *      `requires_client_gender`, with the control that the identical request with a gender returns slots.
 *
 * The property test over randomised genders is `gender-match.property.test.ts`; the database halves —
 * no `app_setting` row at all, and the SQL implementation agreeing field for field — are
 * `packages/db/src/settings/availability.itest.ts` and
 * `packages/fixtures/src/therapist-eligibility.itest.ts`.
 *
 * Therapists are ids. No names, and no style: a style is a property of a treatment (ADR 0021).
 */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const DATE: LocalDate = localDate('2026-10-01')
const NOW: Instant = instantFromIso('2026-10-01T12:00:00+04:00')

const at = (hhmm: string, day = 1): Instant =>
  instantFromIso(`2026-10-0${day}T${hhmm.padStart(5, '0')}:00+04:00`)
const wall = (instant: Instant): string => toLocal(instant, ASIA_DUBAI).time

/** Ids, ordered so that a sort by id is not accidentally the sort by gender. */
const FEMALE_A = '11111111-1111-1111-1111-111111111111'
const MALE_B = '22222222-2222-2222-2222-222222222222'
const UNRECORDED_C = '33333333-3333-3333-3333-333333333333'
const FEMALE_D = '44444444-4444-4444-4444-444444444444'

const ROOM: Room = { id: 'room-1', roomType: 'standard', capacity: 2, isBookable: true }

const therapist = (id: string, gender?: TherapistGender): EligibleTherapist => ({
  therapistId: id,
  skills: ['asian_style'],
  ...(gender === undefined ? {} : { gender }),
})

/** A shift covering the whole trading day, so nothing below is about presence arithmetic. */
const wholeDay = (id: string): TherapistShift => ({
  therapistId: id,
  period: { startsAt: at('11:00'), endsAt: at('02:00', 2) },
})

const pool = (therapists: readonly EligibleTherapist[]): TherapistPool => ({
  therapists,
  shifts: therapists.map((each) => wholeDay(each.therapistId)),
  excluded: [],
})

const FULL_POOL = pool([
  therapist(FEMALE_A, 'female'),
  therapist(MALE_B, 'male'),
  therapist(UNRECORDED_C),
  therapist(FEMALE_D, 'female'),
])

/**
 * Everything the solver needs except the two fields a pool supplies.
 *
 * Shared by `request()` below and by the raw `solveAvailability` controls, so a control is the same day
 * as the case it controls — a control built from different hours proves nothing about either.
 */
const BASE: Omit<SlotRequest, 'therapistIds' | 'shifts'> = {
  now: NOW,
  tradingDate: DATE,
  hoursFor: HOURS_FOR,
  closures: [],
  durationMinutes: 60,
  turnaroundMinutes: 20,
  therapistBufferMinutes: 10,
  minLeadMinutes: 120,
  maxAdvanceDays: 90,
  rooms: [ROOM],
  compatibleRoomTypes: ['standard'],
  appointments: [],
  blocks: [],
  stepMinutes: 60,
}

const request = (overrides: {
  /** Required key, possibly-undefined value — the shape the request type itself insists on. */
  readonly clientGender: TherapistGender | undefined
  readonly pool?: TherapistPool
  readonly genderMatching?: GenderMatchingMode
  readonly stepMinutes?: number
}): GenderMatchedRequest => ({
  ...BASE,
  pool: overrides.pool ?? FULL_POOL,
  clientGender: overrides.clientGender,
  ...(overrides.genderMatching === undefined ? {} : { genderMatching: overrides.genderMatching }),
  ...(overrides.stepMinutes === undefined ? {} : { stepMinutes: overrides.stepMinutes }),
})

const offeredIds = (solution: GenderMatchedSolution): readonly string[] => [
  ...new Set(solution.slots.flatMap((slot) => slot.availableTherapistIds)),
]

describe('sameGenderMatch — the primitive', () => {
  it('is true only when both are on record and equal', () => {
    expect(sameGenderMatch('female', 'female')).toBe(true)
    expect(sameGenderMatch('male', 'male')).toBe(true)
    expect(sameGenderMatch('female', 'male')).toBe(false)
    expect(sameGenderMatch('male', 'female')).toBe(false)
  })

  it('is false when either side is unknown — a pair with a hole in it cannot be claimed', () => {
    // The substance of the rule, not a defensive default. `employee.gender` is nullable because
    // nineteen therapists have photographs and no staff list (Y8-staff), so under strict matching a
    // fresh install offers NOBODY — the loud failure rather than the quiet one.
    expect(sameGenderMatch('female', undefined)).toBe(false)
    expect(sameGenderMatch(undefined, 'female')).toBe(false)
    expect(sameGenderMatch(undefined, undefined)).toBe(false)
  })
})

describe('genderVerdict — the seventh eligibility check', () => {
  it('is the last reason in the applied order, in both implementations', () => {
    expect(ELIGIBILITY_EXCLUSION_REASONS.at(-1)).toBe('gender_mismatch')
  })

  it('excludes a cross-gender therapist and an unrecorded one, under strict', () => {
    expect(genderVerdict({ clientGender: 'female', therapistGender: 'female' })).toBe('ok')
    expect(genderVerdict({ clientGender: 'female', therapistGender: 'male' })).toBe(
      'gender_mismatch',
    )
    expect(genderVerdict({ clientGender: 'female' })).toBe('gender_mismatch')
  })

  it('is strict for every mode that is not exactly advisory, including the removed off', () => {
    for (const stale of [undefined, 'off', 'OFF', '', 'Advisory', 'strict']) {
      expect(
        genderVerdict({
          clientGender: 'female',
          therapistGender: 'male',
          ...(stale === undefined ? {} : { genderMatching: stale as GenderMatchingMode }),
        }),
        `mode ${String(stale)}`,
      ).toBe('gender_mismatch')
    }
    // The control: advisory does not narrow the pool, so "everything is a mismatch" cannot pass.
    expect(
      genderVerdict({
        clientGender: 'female',
        therapistGender: 'male',
        genderMatching: 'advisory',
      }),
    ).toBe('ok')
  })

  it('does not narrow at all when the query names no client', () => {
    // The admin calendar asks who is working on Thursday and has no client. A pool query with no client
    // gender is therefore not a gender question; the BOOKING-level refusal is `requires_client_gender`.
    expect(genderVerdict({ therapistGender: 'male' })).toBe('ok')
    expect(genderVerdict({})).toBe('ok')
  })
})

describe('narrowPoolByGender — the hard constraint on the pool', () => {
  it('removes the ineligible therapists and their presence, and accounts for every candidate', () => {
    const narrowed = narrowPoolByGender({ pool: FULL_POOL, clientGender: 'female' })
    expect(narrowed.mode).toBe('strict')
    expect(narrowed.refusal).toBeNull()
    expect(narrowed.pool.therapists.map((each) => each.therapistId)).toEqual([FEMALE_A, FEMALE_D])
    expect(narrowed.excludedByGender.map((each) => each.therapistId)).toEqual([
      MALE_B,
      UNRECORDED_C,
    ])
    expect(new Set(narrowed.excludedByGender.map((each) => each.reason))).toEqual(
      new Set(['gender_mismatch']),
    )
    // Presence goes with the therapist: handing the solver shifts for an id it was not given makes its
    // two inputs disagree about who the query was about.
    expect(narrowed.pool.shifts.map((shift) => shift.therapistId)).toEqual([FEMALE_A, FEMALE_D])
    // Still total. A therapist in neither list is invisible from the outside — the pool just reads as a
    // shorter roster — which is exactly what `assertPoolIsTotal` exists to catch.
    expect(() =>
      assertPoolIsTotal(narrowed.pool, [FEMALE_A, MALE_B, UNRECORDED_C, FEMALE_D]),
    ).not.toThrow()
    expect(narrowed.sameGenderTherapistIds).toEqual([FEMALE_A, FEMALE_D])
  })

  it('keeps the earlier exclusions rather than replacing them', () => {
    // The six reasons before this one are the pool's, and a gender rule that returned only its own
    // exclusions would lose the answer for the therapist who left in March.
    const withEarlier: TherapistPool = {
      ...FULL_POOL,
      excluded: [{ therapistId: 'gone', reason: 'not_employed' }],
    }
    const narrowed = narrowPoolByGender({ pool: withEarlier, clientGender: 'female' })
    expect(narrowed.pool.excluded).toEqual([
      { therapistId: 'gone', reason: 'not_employed' },
      { therapistId: MALE_B, reason: 'gender_mismatch' },
      { therapistId: UNRECORDED_C, reason: 'gender_mismatch' },
    ])
  })

  it('refuses the whole request when the client gender is unknown, and empties the pool with it', () => {
    const narrowed = narrowPoolByGender({ pool: FULL_POOL, clientGender: undefined })
    expect(narrowed.refusal).toBe('requires_client_gender')
    // Emptied, not merely flagged. A refusal a caller can ignore is a refusal somebody books through.
    expect(narrowed.pool.therapists).toEqual([])
    expect(narrowed.pool.shifts).toEqual([])
    expect(narrowed.excludedByGender).toHaveLength(4)
    expect(narrowed.sameGenderTherapistIds).toEqual([])
  })

  it('does not narrow under advisory, and proves nothing without a client gender', () => {
    const advisory = narrowPoolByGender({
      pool: FULL_POOL,
      clientGender: 'female',
      genderMatching: 'advisory',
    })
    expect(advisory.mode).toBe('advisory')
    expect(advisory.refusal).toBeNull()
    expect(advisory.pool.therapists).toHaveLength(4)
    expect(advisory.excludedByGender).toEqual([])
    // The same-gender ones are still NAMED, which is what lets the slot layer label a cross-gender slot
    // rather than guess.
    expect(advisory.sameGenderTherapistIds).toEqual([FEMALE_A, FEMALE_D])

    const noClient = narrowPoolByGender({
      pool: FULL_POOL,
      clientGender: undefined,
      genderMatching: 'advisory',
    })
    expect(noClient.refusal).toBeNull()
    expect(noClient.pool.therapists).toHaveLength(4)
    expect(noClient.sameGenderTherapistIds).toEqual([])
  })

  it('treats an unreadable mode as strict, and the exact string advisory as advisory', () => {
    for (const stale of [undefined, 'off', '', 'STRICT', 'advisory '] as const) {
      const narrowed = narrowPoolByGender({
        pool: FULL_POOL,
        clientGender: 'female',
        ...(stale === undefined ? {} : { genderMatching: stale as GenderMatchingMode }),
      })
      expect(narrowed.mode, `mode ${String(stale)}`).toBe('strict')
      expect(narrowed.pool.therapists.map((each) => each.therapistId)).toEqual([FEMALE_A, FEMALE_D])
    }
    // The control, again: without it every assertion above is satisfied by a function that ignores the
    // mode entirely.
    expect(
      narrowPoolByGender({ pool: FULL_POOL, clientGender: 'female', genderMatching: 'advisory' })
        .pool.therapists,
    ).toHaveLength(4)
  })
})

describe('acceptance — the constraint is inside the solver, not a post-filter on results', () => {
  /**
   * A pool whose shifts report when the solver asked about them.
   *
   * `therapistsFreeFor` is the solver's only route to a therapist's presence, and it reaches it as
   * `shifts.filter(…).map(shift => shift.period)` — so `period` is read if and only if that therapist
   * was a candidate for some start. A getter is therefore a spy on "was this person considered for
   * assignment", which is the acceptance line's own wording, and it can tell the difference between a
   * therapist the solver never saw and one it saw and rejected.
   */
  const spyingPool = (): { readonly pool: TherapistPool; readonly reads: Map<string, number> } => {
    const reads = new Map<string, number>()
    const shifts = FULL_POOL.therapists.map((each) => {
      const plain = wholeDay(each.therapistId)
      return {
        therapistId: each.therapistId,
        get period() {
          reads.set(each.therapistId, (reads.get(each.therapistId) ?? 0) + 1)
          return plain.period
        },
      } as TherapistShift
    })
    return { pool: { ...FULL_POOL, shifts }, reads }
  }

  it('never asks the solver about a cross-gender therapist, and does ask under advisory', () => {
    const strict = spyingPool()
    const strictSolution = solveGenderMatchedAvailability(
      request({ clientGender: 'female', pool: strict.pool }),
    )
    expect(strictSolution.slots.length).toBeGreaterThan(0)
    // The claim: the solver never read the excluded therapists' presence, because they were not in the
    // list it was given. A post-filter over `slots` would have read it for every candidate start.
    expect(strict.reads.get(MALE_B)).toBeUndefined()
    expect(strict.reads.get(UNRECORDED_C)).toBeUndefined()
    // …and it did read the eligible ones, so "nothing was read" cannot pass.
    expect(strict.reads.get(FEMALE_A)).toBeGreaterThan(0)
    expect(strict.reads.get(FEMALE_D)).toBeGreaterThan(0)

    // The control. Under advisory the same therapist IS a candidate and the same spy fires, so the
    // assertion above is about the rule rather than about a spy that never triggers.
    const advisory = spyingPool()
    solveGenderMatchedAvailability(
      request({ clientGender: 'female', pool: advisory.pool, genderMatching: 'advisory' }),
    )
    expect(advisory.reads.get(MALE_B)).toBeGreaterThan(0)
    expect(advisory.reads.get(UNRECORDED_C)).toBeGreaterThan(0)
  })

  it('never offers the ineligible id, and never lets assignShape choose one', () => {
    const solution = solveGenderMatchedAvailability(request({ clientGender: 'male' }))
    expect(offeredIds(solution)).toEqual([MALE_B])
    // Assignment, which is where "not merely sorted lower" is decided: `assignShape` sorts by id and
    // would pick FEMALE_A first out of any list it contained, because that id sorts first.
    for (const slot of solution.slots) {
      const assigned = assignShape({
        shape: MOROCCO_BATH_SHAPE,
        rooms: [{ ...ROOM, roomType: 'wet' }],
        therapistIds: slot.availableTherapistIds,
        treatment: slot.treatment,
        appointments: [],
      })
      expect(assigned.kind).toBe('assigned')
      if (assigned.kind === 'assigned') expect(assigned.assignment.therapistIds).toEqual([MALE_B])
    }
    // And the same solver, handed the unnarrowed pool, WOULD have offered the id that sorts first —
    // which is what makes the assertion above about the gender rule and not about the fixture.
    const unfiltered = solveAvailability({ ...BASE, ...poolSolverInput(FULL_POOL) })
    expect(unfiltered.slots[0]?.availableTherapistIds).toContain(FEMALE_A)
  })
})

describe('acceptance — an unknown client gender is a named refusal, not an empty day', () => {
  it('returns zero slots and requires_client_gender in strict mode', () => {
    const refused = solveGenderMatchedAvailability(request({ clientGender: undefined }))
    expect(refused.slots).toEqual([])
    expect(refused.refusal).toBe('requires_client_gender')
    expect(refused.mode).toBe('strict')
    // No rejected starts and no windows: nothing was examined, and a list of rejections would say the
    // day had been looked at and found full.
    expect(refused.rejected).toEqual([])
    expect(refused.windows).toEqual([])
    expect(refused.excludedByGender).toHaveLength(4)
  })

  it('returns slots for the identical request once the gender is collected', () => {
    // The control. Without it, "zero slots" is satisfied by a request that had no availability anyway.
    const collected = solveGenderMatchedAvailability(request({ clientGender: 'female' }))
    expect(collected.refusal).toBeNull()
    expect(collected.slots.length).toBeGreaterThan(0)
  })

  it('does not refuse under advisory, because advisory is what proceeding without one means', () => {
    const advisory = solveGenderMatchedAvailability(
      request({ clientGender: undefined, genderMatching: 'advisory' }),
    )
    expect(advisory.refusal).toBeNull()
    expect(advisory.slots.length).toBeGreaterThan(0)
    // Nothing is proved, so every slot says so. `false` is a claim; `true` needs no evidence.
    expect(advisory.slots.every((slot) => slot.genderMismatch)).toBe(true)
  })
})

describe('acceptance — every returned slot carries the flag, in either mode', () => {
  const flagIsPresent = (solution: GenderMatchedSolution): boolean =>
    solution.slots.every(
      (slot) => 'genderMismatch' in slot && typeof slot.genderMismatch === 'boolean',
    )

  it('is a boolean on every slot, never absent and never undefined', () => {
    const strict = solveGenderMatchedAvailability(request({ clientGender: 'female' }))
    const advisory = solveGenderMatchedAvailability(
      request({ clientGender: 'female', genderMatching: 'advisory' }),
    )
    expect(strict.slots.length).toBeGreaterThan(0)
    expect(advisory.slots.length).toBeGreaterThan(0)
    expect(flagIsPresent(strict)).toBe(true)
    expect(flagIsPresent(advisory)).toBe(true)
    for (const slot of [...strict.slots, ...advisory.slots]) {
      expect(slot.genderMismatch).not.toBeUndefined()
      expect(Object.hasOwn(slot, 'genderMismatch')).toBe(true)
    }
  })

  it('is always false in strict mode, because a cross-gender slot is not offered at all', () => {
    const strict = solveGenderMatchedAvailability(request({ clientGender: 'female' }))
    expect(strict.slots.every((slot) => slot.genderMismatch === false)).toBe(true)
    expect(strict.slots.every((slot) => slot.crossGenderTherapistIds.length === 0)).toBe(true)
  })

  it('is true in advisory mode exactly when no same-gender therapist is free', () => {
    // One male therapist on the floor and a female client: nothing can be delivered compliantly, so
    // every slot is flagged and the cross-gender ids are named rather than hidden.
    const maleOnly = pool([therapist(MALE_B, 'male')])
    const flagged = solveGenderMatchedAvailability(
      request({ clientGender: 'female', pool: maleOnly, genderMatching: 'advisory' }),
    )
    expect(flagged.slots.length).toBeGreaterThan(0)
    expect(flagged.slots.every((slot) => slot.genderMismatch)).toBe(true)
    expect(flagged.slots.every((slot) => slot.availableTherapistIds.includes(MALE_B))).toBe(true)
    expect(flagged.slots.every((slot) => slot.crossGenderTherapistIds.includes(MALE_B))).toBe(true)

    // The control, and the invariant a caller relies on: where a same-gender therapist IS free,
    // advisory offers only them and the flag is false. So `genderMismatch === false` means every id in
    // `availableTherapistIds` is a proved match — in either mode.
    const both = solveGenderMatchedAvailability(
      request({ clientGender: 'female', genderMatching: 'advisory' }),
    )
    expect(both.slots.every((slot) => slot.genderMismatch === false)).toBe(true)
    expect(both.slots.every((slot) => slot.availableTherapistIds.includes(MALE_B))).toBe(false)
    expect(both.slots.every((slot) => slot.crossGenderTherapistIds.includes(MALE_B))).toBe(true)
  })
})

describe('the rest of the solver is untouched', () => {
  it('reports the same starts and rejections as solveAvailability over the narrowed pool', () => {
    // This module adds a constraint; it does not re-derive a window, a lead boundary or a turnaround.
    // If it did, the two would drift at the boundary minute and only one of them would be tested.
    const narrowed = narrowPoolByGender({ pool: FULL_POOL, clientGender: 'female' })
    const direct = solveAvailability({ ...BASE, ...poolSolverInput(narrowed.pool) })
    const matched = solveGenderMatchedAvailability(request({ clientGender: 'female' }))
    expect(matched.slots.map((slot) => wall(slot.startsAt))).toEqual(
      direct.slots.map((slot) => wall(slot.startsAt)),
    )
    expect(matched.rejected).toEqual(direct.rejected)
    expect(matched.windows).toEqual(direct.windows)
    // And the lead boundary still bites, so the day above is a real day rather than everything.
    expect(matched.rejected.some((each) => each.reason === 'before_minimum_lead')).toBe(true)
  })

  it('still refuses a start whose therapist has gone home, on the narrowed pool', () => {
    // The gender rule must not resurrect a therapist by supplying presence of its own. A female
    // therapist rostered only to 22:00 cannot take a 21:00 sixty-minute treatment with a 10-minute
    // buffer either side — 20:50 to 22:10.
    const early: TherapistPool = {
      therapists: [therapist(FEMALE_A, 'female')],
      shifts: [{ therapistId: FEMALE_A, period: { startsAt: at('17:00'), endsAt: at('22:00') } }],
      excluded: [],
    }
    const solution = solveGenderMatchedAvailability(
      request({ clientGender: 'female', pool: early, stepMinutes: 60 }),
    )
    const starts = solution.slots.map((slot) => wall(slot.startsAt))
    expect(starts).toContain('20:00')
    expect(starts).not.toContain('21:00')
  })

  it('normalises the mode through the one function the database reader also uses', () => {
    // Not a second opinion about what an unreadable setting means. The same call, so a change to the
    // fail-safe is a change in one place.
    expect(solveGenderMatchedAvailability(request({ clientGender: 'female' })).mode).toBe(
      genderMatchingMode(undefined),
    )
  })
})
