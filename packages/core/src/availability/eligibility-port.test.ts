import { describe, expect, it } from 'vitest'
import { type ClosedInterval, tradingWindowsFor } from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
} from '../time.ts'
import {
  type ApprovedLeave,
  assertPoolIsTotal,
  credentialVerdict,
  ELIGIBILITY_EXCLUSION_REASONS,
  type EligibilityExclusionReason,
  type EligibilityFacts,
  type EligibilityQuery,
  employedOn,
  poolSolverInput,
  resolveTherapistPool,
  rosteredPresence,
  staticEligibilityProvider,
  subtractPeriods,
  type TherapistEligibilityProvider,
  type TherapistPool,
  type TherapistRecord,
} from './eligibility-port.ts'
import { therapistOccupancy } from './intervals.ts'
import type { Period } from './room-predicates.ts'
import { type TherapistShift, therapistsFreeFor } from './solve.ts'

/**
 * B-AVAIL-04 — the eligibility port, the rule behind it, and the presence arithmetic.
 *
 * The figures here are the acceptance list's own: a shift ending at 22:00, a 90-minute treatment with
 * a 10-minute buffer excluded at 21:00 and included at 20:20, a mandatory credential expiring either
 * side of the trading date, and approved leave that excludes where a pending request does not.
 *
 * Every positive assertion is paired with the control that must fail, because each of these rules has
 * a shape that passes the positive case while doing nothing: a credential check that ignores the
 * mandatory list passes "expired is excluded" by excluding everybody, and a leave rule that reads
 * `leave_request` rather than the approved view passes "approved excludes" by excluding pending too.
 *
 * Therapists are ids. `THERAPIST_A` is `therapist-a`, and there is no name anywhere in this file.
 */

/** 2026-09-18, a Friday, with the real 11:00–02:00 session. Trading dates, never calendar dates. */
const TRADING_DATE = localDate('2026-09-18')
const at = (hhmm: string, day = 18): Instant => instantFromIso(`2026-09-${day}T${hhmm}:00+04:00`)

const THERAPIST_A = 'therapist-a'
const THERAPIST_B = 'therapist-b'

const period = (from: Instant, to: Instant): Period => ({ startsAt: from, endsAt: to })

/** A fully eligible therapist: employed, both skills, both mandatory credentials well in date. */
const eligibleRecord = (therapistId: string, overrides: Partial<TherapistRecord> = {}) =>
  ({
    therapistId,
    gender: 'female',
    employedFrom: localDate('2026-01-01'),
    skills: ['asian_style', 'arabic_style'],
    credentials: [
      { documentType: 'professional_licence', expiresOn: localDate('2027-01-31') },
      { documentType: 'health_certificate', expiresOn: localDate('2027-01-31') },
    ],
    ...overrides,
  }) satisfies TherapistRecord

const MANDATORY = ['professional_licence', 'health_certificate'] as const

/** The evening shift: 17:00 to close. Crosses midnight, which is the normal case here. */
const eveningShift = (therapistId: string): TherapistShift => ({
  therapistId,
  period: period(at('17'), at('02', 19)),
})

const facts = (overrides: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  mandatoryDocumentTypes: [...MANDATORY],
  therapists: [eligibleRecord(THERAPIST_A)],
  shifts: [eveningShift(THERAPIST_A)],
  approvedLeave: [],
  ...overrides,
})

const query = (overrides: Partial<EligibilityQuery> = {}): EligibilityQuery => ({
  tradingDate: TRADING_DATE,
  requiredSkill: 'asian_style',
  ...overrides,
})

const reasonsOf = (pool: TherapistPool): readonly EligibilityExclusionReason[] =>
  pool.excluded.map((therapist) => therapist.reason)

const idsOf = (pool: TherapistPool): readonly string[] =>
  pool.therapists.map((therapist) => therapist.therapistId)

describe('subtractPeriods', () => {
  it('leaves a period whole when the hole does not touch it', () => {
    expect(subtractPeriods([period(at('17'), at('20'))], [period(at('21'), at('22'))])).toEqual([
      period(at('17'), at('20')),
    ])
  })

  it('splits a period a hole falls strictly inside', () => {
    expect(subtractPeriods([period(at('17'), at('22'))], [period(at('19'), at('20'))])).toEqual([
      period(at('17'), at('19')),
      period(at('20'), at('22')),
    ])
  })

  it('removes a period a hole covers entirely, rather than returning an empty one', () => {
    // An empty period overlaps nothing (`isEmptyPeriod`), so returning `[17:00, 17:00)` would read as
    // presence and provide none — the therapist would be in the pool with no minutes in it.
    expect(subtractPeriods([period(at('17'), at('20'))], [period(at('16'), at('21'))])).toEqual([])
  })

  it('does not remove the boundary instant: a hole ending where a period starts touches nothing', () => {
    // Half-open, everywhere. A closure or a leave period ending at 17:00 does not consume 17:00.
    expect(subtractPeriods([period(at('17'), at('20'))], [period(at('15'), at('17'))])).toEqual([
      period(at('17'), at('20')),
    ])
    // And the control in the other direction: one minute of overlap does remove one minute.
    expect(
      subtractPeriods([period(at('17'), at('20'))], [period(at('15'), addMinutes(at('17'), 1))]),
    ).toEqual([period(addMinutes(at('17'), 1), at('20'))])
  })

  it('merges abutting inputs first, so a roster written in two halves is one presence', () => {
    expect(
      subtractPeriods(
        [period(at('11'), at('18')), period(at('18'), at('02', 19))],
        [period(at('19'), at('20'))],
      ),
    ).toEqual([period(at('11'), at('19')), period(at('20'), at('02', 19))])
  })

  it('agrees with tradingWindowsFor, which subtracts closures from the premises window', () => {
    // The checked mirror. `business-day/windows.ts` cannot import this function — `intervals.ts`
    // already imports `latestStartIn` from it, so the dependency would be circular — so the
    // arithmetic is stated once on each side of that seam and asserted equal here. Without this, the
    // two could drift at exactly the boundary minute and only one of them would be wrong.
    const closure: ClosedInterval = {
      startsAt: at('19'),
      endsAt: at('20'),
      reason: 'Staff meeting',
    }
    const windows = tradingWindowsFor({
      date: TRADING_DATE,
      hours: { open: localTime('11:00'), close: localTime('02:00') },
      closures: [closure],
      zone: ASIA_DUBAI,
    })
    const subtracted = subtractPeriods(
      [period(at('11'), at('02', 19))],
      [period(closure.startsAt, closure.endsAt)],
    )
    expect(subtracted).toEqual(windows.map((window) => period(window.startsAt, window.endsAt)))
    // The control: a deliberately wrong subtraction is detected. An inclusive-upper reading would keep
    // 20:00 out of the second window, and the assertion above would then be comparing two wrong
    // answers if this one were absent.
    expect(subtracted[1]?.startsAt).toBe(at('20'))
  })
})

describe('rosteredPresence', () => {
  const leave = (therapistId: string, from: Instant, to: Instant): ApprovedLeave => ({
    therapistId,
    period: period(from, to),
  })

  it('subtracts only the leave belonging to that therapist', () => {
    const shifts = [eveningShift(THERAPIST_A), eveningShift(THERAPIST_B)]
    const approvedLeave = [leave(THERAPIST_B, at('19'), at('20'))]
    expect(rosteredPresence({ therapistId: THERAPIST_A, shifts, approvedLeave })).toEqual([
      period(at('17'), at('02', 19)),
    ])
    // The control. Without it, a rule that subtracted every leave row from everybody would pass the
    // assertion above by producing the same shape for the wrong reason.
    expect(rosteredPresence({ therapistId: THERAPIST_B, shifts, approvedLeave })).toEqual([
      period(at('17'), at('19')),
      period(at('20'), at('02', 19)),
    ])
  })

  it('returns nothing when leave covers the whole roster', () => {
    expect(
      rosteredPresence({
        therapistId: THERAPIST_A,
        shifts: [eveningShift(THERAPIST_A)],
        approvedLeave: [leave(THERAPIST_A, at('11'), at('02', 19))],
      }),
    ).toEqual([])
  })
})

describe('employedOn', () => {
  it('includes both bounds and excludes either side of them', () => {
    const record = eligibleRecord(THERAPIST_A, {
      employedFrom: localDate('2026-09-18'),
      employedUntil: localDate('2026-09-20'),
    })
    expect(employedOn(record, localDate('2026-09-17'))).toBe(false)
    expect(employedOn(record, localDate('2026-09-18'))).toBe(true)
    expect(employedOn(record, localDate('2026-09-20'))).toBe(true)
    expect(employedOn(record, localDate('2026-09-21'))).toBe(false)
  })

  it('treats an absent end date as open-ended employment', () => {
    const record = eligibleRecord(THERAPIST_A, { employedFrom: localDate('2026-01-01') })
    expect(employedOn(record, localDate('2099-12-31'))).toBe(true)
  })
})

describe('credentialVerdict', () => {
  const credential = (documentType: string, expiresOn: string) => ({
    documentType,
    expiresOn: localDate(expiresOn),
  })

  it('accepts a mandatory credential expiring ON the trading date, and refuses the day before', () => {
    // The whole reason the comparison is against the trading date. 2026-09-18's session runs to 02:00
    // on the 19th, so a licence valid through the 18th covers the 01:30 appointment that belongs to
    // it — and a comparison against the slot's calendar date would take those two hours away from a
    // therapist who is licensed for all of them.
    const held = [
      credential('professional_licence', '2026-09-18'),
      credential('health_certificate', '2027-01-31'),
    ]
    expect(
      credentialVerdict({
        credentials: held,
        mandatoryDocumentTypes: [...MANDATORY],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('ok')
    expect(
      credentialVerdict({
        credentials: [
          credential('professional_licence', '2026-09-17'),
          credential('health_certificate', '2027-01-31'),
        ],
        mandatoryDocumentTypes: [...MANDATORY],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('credential_expired')
  })

  it('takes the latest expiry per type, because a renewal is a new row', () => {
    // `employee_document_one_row_per_expiry` (0030) makes a renewal a second row rather than an edit,
    // so the file still shows what was valid last March. Reading the first or the earliest row reports
    // a therapist as expired on the strength of the licence they have already replaced.
    const renewed = [
      credential('professional_licence', '2026-03-31'),
      credential('professional_licence', '2027-03-31'),
      credential('health_certificate', '2027-01-31'),
    ]
    expect(
      credentialVerdict({
        credentials: renewed,
        mandatoryDocumentTypes: [...MANDATORY],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('ok')
    // The control: with the renewal removed, the same therapist is expired. Without this, the
    // assertion above is satisfied by a rule that ignores expiry altogether.
    expect(
      credentialVerdict({
        credentials: [
          renewed[0] as { documentType: string; expiresOn: ReturnType<typeof localDate> },
        ],
        mandatoryDocumentTypes: ['professional_licence'],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('credential_expired')
  })

  it('refuses a mandatory type with no row at all: absence is not permission', () => {
    expect(
      credentialVerdict({
        credentials: [credential('professional_licence', '2027-01-31')],
        mandatoryDocumentTypes: [...MANDATORY],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('credential_missing')
  })

  it('reads its list from the mandatory types, so an empty list gates nothing', () => {
    // An empty array is a legitimate value — no credential gate — and it is what makes the profile the
    // source of truth rather than this function. A therapist with an expired licence passes when the
    // profile in force does not require one, and the same therapist fails when it does.
    const expired = [credential('professional_licence', '2020-01-01')]
    expect(
      credentialVerdict({
        credentials: expired,
        mandatoryDocumentTypes: [],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('ok')
    expect(
      credentialVerdict({
        credentials: expired,
        mandatoryDocumentTypes: ['professional_licence'],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('credential_expired')
    // And a type nobody holds is refused rather than ignored, which is the other half of "data".
    expect(
      credentialVerdict({
        credentials: expired,
        mandatoryDocumentTypes: ['work_permit'],
        tradingDate: TRADING_DATE,
      }),
    ).toBe('credential_missing')
  })
})

describe('resolveTherapistPool', () => {
  it('puts a fully eligible therapist in the pool with their presence and their gender', () => {
    const pool = resolveTherapistPool(facts(), query())
    expect(idsOf(pool)).toEqual([THERAPIST_A])
    expect(pool.therapists[0]?.gender).toBe('female')
    expect(pool.shifts).toEqual([
      { therapistId: THERAPIST_A, period: period(at('17'), at('02', 19)) },
    ])
    expect(pool.excluded).toEqual([])
  })

  it('omits gender entirely when it is not on record, rather than inventing one', () => {
    // Built by OMITTING the key rather than by setting it to `undefined`. `exactOptionalPropertyTypes`
    // is on, so the two are different types here — and they are different rows too: absent is "nobody
    // has told the build" (Y8-staff), while an explicit undefined is a value somebody chose.
    const { gender: _unknownGender, ...anonymous } = eligibleRecord(THERAPIST_A)
    const pool = resolveTherapistPool(facts({ therapists: [anonymous] }), query())
    expect(pool.therapists[0]).toEqual({
      therapistId: THERAPIST_A,
      skills: ['asian_style', 'arabic_style'],
    })
    expect('gender' in (pool.therapists[0] as object)).toBe(false)
  })

  it('excludes on skill by SET MEMBERSHIP, so one therapist can hold both styles or one', () => {
    const asianOnly = eligibleRecord(THERAPIST_A, { skills: ['asian_style'] })
    const arabicOnly = eligibleRecord(THERAPIST_B, { skills: ['arabic_style'] })
    const both = facts({
      therapists: [asianOnly, arabicOnly],
      shifts: [eveningShift(THERAPIST_A), eveningShift(THERAPIST_B)],
    })
    // Style is an attribute of the TREATMENT (ADR 0021): the query carries a required SKILL, and the
    // same therapist list answers both styles differently. A `style` column on the person could not
    // express a therapist who holds both, which the third case below is.
    expect(idsOf(resolveTherapistPool(both, query({ requiredSkill: 'asian_style' })))).toEqual([
      THERAPIST_A,
    ])
    expect(idsOf(resolveTherapistPool(both, query({ requiredSkill: 'arabic_style' })))).toEqual([
      THERAPIST_B,
    ])
    expect(reasonsOf(resolveTherapistPool(both, query({ requiredSkill: 'arabic_style' })))).toEqual(
      ['missing_skill'],
    )
    const dual = facts()
    expect(idsOf(resolveTherapistPool(dual, query({ requiredSkill: 'asian_style' })))).toEqual([
      THERAPIST_A,
    ])
    expect(idsOf(resolveTherapistPool(dual, query({ requiredSkill: 'arabic_style' })))).toEqual([
      THERAPIST_A,
    ])
  })

  it('excludes an unrostered therapist as not_rostered and one on full leave as on_approved_leave', () => {
    // Two different conversations: one is a rota edit, the other is not. A rule that reported both as
    // "unavailable" would send the front desk to change a roster that is already correct.
    expect(reasonsOf(resolveTherapistPool(facts({ shifts: [] }), query()))).toEqual([
      'not_rostered',
    ])
    expect(
      reasonsOf(
        resolveTherapistPool(
          facts({
            approvedLeave: [{ therapistId: THERAPIST_A, period: period(at('11'), at('02', 19)) }],
          }),
          query(),
        ),
      ),
    ).toEqual(['on_approved_leave'])
  })

  it('shortens presence for part-day leave rather than removing the therapist', () => {
    const pool = resolveTherapistPool(
      facts({
        approvedLeave: [{ therapistId: THERAPIST_A, period: period(at('19'), at('21')) }],
      }),
      query(),
    )
    expect(idsOf(pool)).toEqual([THERAPIST_A])
    expect(pool.shifts).toEqual([
      { therapistId: THERAPIST_A, period: period(at('17'), at('19')) },
      { therapistId: THERAPIST_A, period: period(at('21'), at('02', 19)) },
    ])
  })

  it('applies the exclusion reasons in the documented order', () => {
    // A therapist who fails several checks is reported by the FIRST reason in
    // ELIGIBILITY_EXCLUSION_REASONS, because the SQL implementation mirrors that order in a CASE and
    // the two must answer identically — `packages/fixtures` asserts they do, and this is the order it
    // asserts against.
    const ended = eligibleRecord(THERAPIST_A, {
      employedUntil: localDate('2026-01-31'),
      skills: [],
      credentials: [],
    })
    // The same therapist with the end date OMITTED, so each case below removes exactly one reason.
    const { employedUntil: _stillEmployed, ...current } = ended
    expect(
      reasonsOf(resolveTherapistPool(facts({ therapists: [ended], shifts: [] }), query())),
    ).toEqual(['not_employed'])
    expect(
      reasonsOf(resolveTherapistPool(facts({ therapists: [current], shifts: [] }), query())),
    ).toEqual(['missing_skill'])
    expect(
      reasonsOf(
        resolveTherapistPool(
          facts({
            therapists: [{ ...current, skills: ['asian_style'] }],
            shifts: [],
          }),
          query(),
        ),
      ),
    ).toEqual(['credential_missing'])
    expect(ELIGIBILITY_EXCLUSION_REASONS).toEqual([
      'not_employed',
      'missing_skill',
      'credential_missing',
      'credential_expired',
      'not_rostered',
      'on_approved_leave',
    ])
  })

  it('narrows to the candidate ids it is given, and answers for every one of them', () => {
    const both = facts({
      therapists: [eligibleRecord(THERAPIST_A), eligibleRecord(THERAPIST_B)],
      shifts: [eveningShift(THERAPIST_A), eveningShift(THERAPIST_B)],
    })
    const narrowed = resolveTherapistPool(both, query({ therapistIds: [THERAPIST_B] }))
    expect(idsOf(narrowed)).toEqual([THERAPIST_B])
    expect(() => {
      assertPoolIsTotal(narrowed, [THERAPIST_B])
    }).not.toThrow()
    // Narrowing is what a db-backed provider isolates with, so the ids it does NOT name must be
    // absent from BOTH lists rather than merely absent from the eligible one.
    expect(narrowed.excluded).toEqual([])
    expect(idsOf(resolveTherapistPool(both, query()))).toEqual([THERAPIST_A, THERAPIST_B])
  })

  it('places every candidate in exactly one list, and assertPoolIsTotal says so', () => {
    const mixed = facts({
      therapists: [eligibleRecord(THERAPIST_A), eligibleRecord(THERAPIST_B, { skills: [] })],
      shifts: [eveningShift(THERAPIST_A)],
    })
    const pool = resolveTherapistPool(mixed, query())
    expect(() => {
      assertPoolIsTotal(pool, [THERAPIST_A, THERAPIST_B])
    }).not.toThrow()
    // The control, and it is the whole point of exporting the assertion: a pool that silently drops a
    // candidate reads as a shorter roster with nothing saying who vanished.
    expect(() => {
      assertPoolIsTotal({ ...pool, excluded: [] }, [THERAPIST_A, THERAPIST_B])
    }).toThrow(/Unaccounted for: \[therapist-b\]/)
    expect(() => {
      assertPoolIsTotal(
        { ...pool, excluded: [{ therapistId: THERAPIST_A, reason: 'not_rostered' }] },
        [THERAPIST_A],
      )
    }).toThrow(/listed twice: \[therapist-a\]/)
  })

  it('returns ascending ids whatever order the facts arrive in', () => {
    const shuffled = facts({
      therapists: [eligibleRecord(THERAPIST_B), eligibleRecord(THERAPIST_A)],
      shifts: [eveningShift(THERAPIST_B), eveningShift(THERAPIST_A)],
    })
    expect(idsOf(resolveTherapistPool(shuffled, query()))).toEqual([THERAPIST_A, THERAPIST_B])
  })
})

describe('the shift boundary, as the acceptance list states it', () => {
  /**
   * Shift ends 22:00. A 90-minute treatment with a 10-minute therapist buffer either side is excluded
   * at 21:00 and included at 20:20 — 20:20 + 90 + 10 lands exactly on 22:00, and the interval is
   * half-open, so ending at shift end is inside the shift.
   *
   * Asserted through `therapistsFreeFor`, the solver's own predicate, over the presence this module
   * produces: the claim is that the two compose, not that either is right alone. "A shift overlaps the
   * treatment" is the wrong question and the easy one to ask — it would send the therapist home at
   * 22:00 halfway through the 21:00 treatment.
   */
  const BUFFER = 10
  const DURATION = 90
  const shortShift: TherapistShift = {
    therapistId: THERAPIST_A,
    period: period(at('17'), at('22')),
  }

  const freeAt = (startsAt: Instant, shifts: readonly TherapistShift[]): readonly string[] =>
    therapistsFreeFor({
      therapistIds: [THERAPIST_A],
      period: therapistOccupancy({ startsAt, durationMinutes: DURATION, bufferMinutes: BUFFER }),
      shifts,
      appointments: [],
    })

  it('excludes 21:00 and includes 20:20 against a shift that ends at 22:00', () => {
    const pool = resolveTherapistPool(facts({ shifts: [shortShift] }), query())
    expect(pool.shifts).toEqual([shortShift])
    expect(freeAt(at('21'), pool.shifts)).toEqual([])
    expect(freeAt(at('20:20'), pool.shifts)).toEqual([THERAPIST_A])
    // One minute later is the boundary in the other direction: 20:21 + 90 + 10 = 22:01.
    expect(freeAt(addMinutes(at('20:20'), 1), pool.shifts)).toEqual([])
  })

  it('includes 21:00 once the roster is extended, so the exclusion is the shift and not the hour', () => {
    // The control. Without it, "21:00 is excluded" is satisfied by a rule that excludes 21:00 always.
    const pool = resolveTherapistPool(facts({ shifts: [eveningShift(THERAPIST_A)] }), query())
    expect(freeAt(at('21'), pool.shifts)).toEqual([THERAPIST_A])
  })

  it('refuses the treatment that runs into leave, even though the shift covers it', () => {
    // Leave is subtracted into the presence, so the solver's single predicate catches it. A 21:00 start
    // needs 20:50–22:40; leave from 22:00 leaves a gap inside that interval, and `coveredWithoutGap`
    // is what makes a gap different from an overlap.
    const pool = resolveTherapistPool(
      facts({
        shifts: [eveningShift(THERAPIST_A)],
        approvedLeave: [{ therapistId: THERAPIST_A, period: period(at('22'), at('02', 19)) }],
      }),
      query(),
    )
    expect(pool.shifts).toEqual([{ therapistId: THERAPIST_A, period: period(at('17'), at('22')) }])
    expect(freeAt(at('21'), pool.shifts)).toEqual([])
    expect(freeAt(at('20:20'), pool.shifts)).toEqual([THERAPIST_A])
  })
})

describe('poolSolverInput', () => {
  it('produces exactly the two SlotRequest fields, so the solver is unchanged by this unit', () => {
    const pool = resolveTherapistPool(facts(), query())
    const input = poolSolverInput(pool)
    expect(Object.keys(input).sort()).toEqual(['shifts', 'therapistIds'])
    expect(input.therapistIds).toEqual([THERAPIST_A])
    expect(input.shifts).toBe(pool.shifts)
  })
})

describe('staticEligibilityProvider', () => {
  it('answers the port with the rule, not with a fixed pool', async () => {
    const provider = staticEligibilityProvider(
      facts({
        therapists: [eligibleRecord(THERAPIST_A, { skills: ['asian_style'] })],
      }),
    )
    await expect(provider.eligibleTherapists(query())).resolves.toMatchObject({
      therapists: [{ therapistId: THERAPIST_A }],
    })
    // The same provider, a different query, a different answer. A stub returning a fixed pool would
    // satisfy the first assertion and let the solver be wired to a shape nothing ever computed.
    await expect(
      provider.eligibleTherapists(query({ requiredSkill: 'arabic_style' })),
    ).resolves.toMatchObject({ therapists: [], excluded: [{ reason: 'missing_skill' }] })
  })
})

/**
 * The type-level half of acceptance line 1: **the port's signature is pinned, so a P-HR extension that
 * changes it fails `pnpm typecheck`.**
 *
 * `@ts-expect-error` rather than a note in a review checklist, because that is the durable form: if the
 * port stops rejecting the shape below — a widened answer type, an `unknown[]`, a `Partial<>` — the
 * directive becomes unused and the typechecker fails with `TS2578: Unused '@ts-expect-error'
 * directive`. `scripts/test-gates.mjs` performs exactly that mutation on the shipped port, which is the
 * only way to prove the assertion is still asserting something.
 */
describe('the port refuses an implementation that has lost part of the answer', () => {
  it('rejects bare ids, a synchronous answer, and an extra required argument', () => {
    const pool = resolveTherapistPool(facts(), query())

    const bareIds = { therapists: [THERAPIST_A], shifts: [], excluded: [] }
    const idsOnly: TherapistEligibilityProvider = {
      // @ts-expect-error — bare ids lose the gender B-AVAIL-05 reads and the named reasons the front
      // desk needs, and P-HR has ids to hand. If `TherapistPool.therapists` is ever widened, this
      // directive goes unused and TS2578 fails the build.
      eligibleTherapists: () => Promise.resolve(bareIds),
    }
    const synchronous: TherapistEligibilityProvider = {
      // @ts-expect-error — the port is asynchronous because the real implementation reads a database.
      // A synchronous one compiles only if the return type stops being a Promise.
      eligibleTherapists: () => pool,
    }
    const extraArgument: TherapistEligibilityProvider = {
      // @ts-expect-error — a second required argument is how a provider smuggles in a dependency the
      // caller has to know about. `EligibilityQuery` is the whole of the input.
      eligibleTherapists: (_query: EligibilityQuery, _sql: unknown) => Promise.resolve(pool),
    }

    // Read, so deleting the assertions also fails the linter's unused-local rule rather than silently
    // leaving three declarations nothing checks.
    expect([idsOnly, synchronous, extraArgument].every((p) => typeof p === 'object')).toBe(true)
  })

  it('accepts the two shapes that do answer it, which is what says it is not refusing everything', () => {
    const provider = staticEligibilityProvider(facts()) satisfies TherapistEligibilityProvider
    const widerQuery: TherapistEligibilityProvider = {
      // Accepting a narrower parameter type than the port declares is not allowed; accepting the
      // declared one and ignoring a field is. This is the shape P-HR will actually write.
      eligibleTherapists: async (q) => resolveTherapistPool(facts(), q),
    }
    expect(typeof provider.eligibleTherapists).toBe('function')
    expect(typeof widerQuery.eligibleTherapists).toBe('function')
  })
})
