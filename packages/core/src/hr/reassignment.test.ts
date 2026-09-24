import { isAppError, type TherapistSkill } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CommittedAppointment } from '../availability/assign-shape.ts'
import {
  ELIGIBILITY_EXCLUSION_REASONS,
  type EligibilityFacts,
  resolveTherapistPool,
  type TherapistGender,
  type TherapistPool,
  type TherapistRecord,
} from '../availability/eligibility-port.ts'
import type { Period } from '../availability/room-predicates.ts'
import type { TherapistShift } from '../availability/solve.ts'
import { type Instant, instantFromIso, type LocalDate, localDate } from '../time.ts'
import {
  assertCandidatesAreTotal,
  compareQueueEntries,
  judgeReassignmentNotice,
  orderReassignmentQueue,
  REASSIGNMENT_NOTICE_CLASS,
  REASSIGNMENT_NOTICE_TEMPLATE_KEY,
  REASSIGNMENT_REASONS,
  REASSIGNMENT_REJECTIONS,
  type ReassignableAppointment,
  reassignmentCandidates,
  reassignmentReason,
} from './reassignment.ts'

/**
 * P-HR-04 — the candidate rule, the vocabularies, and the notice's one class.
 *
 * ## The property, and why the oracle is written from the FACTS
 *
 * The first acceptance line is a property over random rosters: *every candidate returned satisfies
 * required skill, the gender constraint, credential validity, an assigned shift covering the appointment
 * plus buffers, and has no overlapping appointment — and no candidate is ever returned that violates
 * one*. Five of those seven are `resolveTherapistPool`'s answer and two are this module's, so the
 * property drives the **pair** — the pool rule the booking path uses, then the candidate rule — and
 * checks the result against the generated facts with plain comparisons.
 *
 * Plain comparisons is the whole point. An oracle that asked `credentialVerdict` whether a candidate's
 * credentials were valid would prove the two calls agree with each other, which they must, being one
 * call. So the oracle here re-reads the generated roster: "is there a document of this mandatory type
 * whose expiry is not before the trading date", "is the client's gender the same string as this
 * therapist's", "does this single generated shift span contain the buffered interval", "does any of this
 * therapist's other generated appointments overlap it". Nothing it does is imported from the module it
 * checks.
 *
 * ## The converse is asserted too, and it is the half that catches a rule returning nothing
 *
 * "Every candidate satisfies the constraints" is satisfied perfectly by a finder that returns an empty
 * list, and a finder that returns an empty list is exactly what a credential predicate applied twice, or
 * a buffered interval computed with the wrong sign, would produce. So the property also asserts the
 * other direction: any generated therapist who satisfies all seven and is not the incumbent MUST be a
 * candidate. Both halves, every run.
 *
 * ## And the oracle is proved able to fail
 *
 * Two mutants at the bottom — "a shift that OVERLAPS the appointment is enough" and "the incumbent is a
 * candidate too" — are run through the same oracle, which must report violations for both. A property
 * suite whose oracle cannot fail asserts nothing, however many cases it runs (brief rule 3).
 */
const DATE: LocalDate = localDate('2026-10-01')
const OPENS = instantFromIso('2026-10-01T11:00:00+04:00')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The mandatory set the property judges credentials against. Two types, so "one is missing" is reachable. */
const MANDATORY = ['labour_card', 'professional_licence'] as const
const REQUIRED_SKILL: TherapistSkill = 'asian_style'

const at = (hoursFromOpen: number): Instant => (OPENS + hoursFromOpen * HOUR) as Instant
const period = (fromHour: number, toHour: number): Period => ({
  startsAt: at(fromHour),
  endsAt: at(toHour),
})

// --- the shared fixture for the worked examples -------------------------------------------------

/** A therapist who holds everything the pool asks for. The generator below varies each field. */
const wholeRecord = (id: string, gender: TherapistGender = 'female'): TherapistRecord => ({
  therapistId: id,
  gender,
  employedFrom: localDate('2020-01-01'),
  skills: [REQUIRED_SKILL],
  credentials: MANDATORY.map((documentType) => ({
    documentType,
    expiresOn: localDate('2030-12-31'),
  })),
})

const shiftFor = (id: string, from: number, to: number): TherapistShift => ({
  therapistId: id,
  period: period(from, to),
})

const appointmentOf = (args: {
  readonly id: string
  readonly therapistId: string
  readonly from: number
  readonly to: number
  readonly bufferMinutes?: number
}): CommittedAppointment => ({
  id: args.id,
  roomId: 'room-1',
  therapistIds: [args.therapistId],
  // One delivery of one client place per row. `CommittedAppointment` requires it because a repository
  // always has it (0038), and the room side counts places per delivery rather than per row.
  delivery: { id: `delivery-${args.id}`, places: 1 },
  treatment: period(args.from, args.to),
  turnaroundMinutes: 20,
  therapistBufferMinutes: args.bufferMinutes ?? 10,
})

/** The appointment being reassigned: 19:00–20:00 with a ten-minute buffer either side. */
const TARGET: ReassignableAppointment = {
  appointmentId: 'target',
  therapistId: 'incumbent',
  treatment: period(8, 9),
  therapistBufferMinutes: 10,
}

const poolFor = (
  records: readonly TherapistRecord[],
  shifts: readonly TherapistShift[],
  clientGender?: TherapistGender,
): TherapistPool => {
  const facts: EligibilityFacts = {
    mandatoryDocumentTypes: [...MANDATORY],
    therapists: records,
    shifts,
    approvedLeave: [],
  }
  return resolveTherapistPool(facts, {
    tradingDate: DATE,
    requiredSkill: REQUIRED_SKILL,
    ...(clientGender === undefined ? {} : { clientGender }),
  })
}

describe('the candidate rule consumes the eligibility answer and adds two checks', () => {
  const records = [
    wholeRecord('incumbent'),
    wholeRecord('free'),
    wholeRecord('busy'),
    wholeRecord('half-rostered'),
    { ...wholeRecord('no-skill'), skills: ['arabic_style' as TherapistSkill] },
    {
      ...wholeRecord('lapsed'),
      // Both mandatory types on file and one of them out of date: MISSING is reported ahead of EXPIRED
      // (`CREDENTIAL_STATUSES`), so a record with a type absent would test the other arm.
      credentials: [
        { documentType: 'labour_card', expiresOn: localDate('2026-09-30') },
        { documentType: 'professional_licence', expiresOn: localDate('2030-12-31') },
      ],
    },
  ]
  const shifts = [
    shiftFor('incumbent', 0, 15),
    shiftFor('free', 0, 15),
    shiftFor('busy', 0, 15),
    // Off at 20:00, so the 19:00–20:00 treatment plus its trailing buffer is not covered. The
    // difference between "a shift overlaps it" and "a shift covers it" is exactly this therapist.
    shiftFor('half-rostered', 0, 9),
    shiftFor('no-skill', 0, 15),
    shiftFor('lapsed', 0, 15),
  ]
  const committed = [
    appointmentOf({ id: 'target', therapistId: 'incumbent', from: 8, to: 9 }),
    appointmentOf({ id: 'other', therapistId: 'busy', from: 8.5, to: 9.5 }),
  ]

  const answer = reassignmentCandidates({
    appointment: TARGET,
    pool: poolFor(records, shifts),
    committed,
  })
  const reasonFor = (id: string): string | undefined =>
    answer.rejected.find((entry) => entry.therapistId === id)?.reason

  it('offers the therapist who is free and nobody else', () => {
    expect(answer.candidates).toEqual(['free'])
  })

  it('rejects the incumbent by name rather than dropping them', () => {
    // The whole point of the label: "not offered" and "already has it" are different answers, and only
    // one of them is a reason a screen can print beside the appointment.
    expect(reasonFor('incumbent')).toBe('already_assigned')
  })

  it('separates "not working that day" from "not working at that hour"', () => {
    // `half-rostered` IS rostered on the date, so the pool does not exclude them at all. The rejection
    // is this module's, and it is a different conversation from a rota gap.
    expect(reasonFor('half-rostered')).toBe('not_rostered_for_the_period')
    expect(reasonFor('busy')).toBe('therapist_busy')
  })

  it('reports the pool’s reasons in the pool’s own words', () => {
    // Not re-derived here: these two strings come from `resolveTherapistPool` and are passed through, so
    // a screen showing a credential problem sends somebody to the same renewal the booking page does.
    expect(reasonFor('no-skill')).toBe('missing_skill')
    expect(reasonFor('lapsed')).toBe('credential_expired')
  })

  it('buffers the interval on both sides, from the appointment’s own snapshot', () => {
    expect(answer.buffered).toEqual({
      startsAt: at(8) - 10 * MINUTE,
      endsAt: at(9) + 10 * MINUTE,
    })
  })

  it('accounts for every therapist the pool answered about', () => {
    expect(() => assertCandidatesAreTotal(answer, poolFor(records, shifts))).not.toThrow()
    // The control: an answer with a therapist removed is refused, so the assertion above is a claim
    // about the answer rather than about the function being unable to fail.
    expect(() =>
      assertCandidatesAreTotal(
        { ...answer, rejected: answer.rejected.slice(1) },
        poolFor(records, shifts),
      ),
    ).toThrow(/Unaccounted for/)
    expect(() =>
      assertCandidatesAreTotal(
        { ...answer, candidates: ['free', 'free'] },
        poolFor(records, shifts),
      ),
    ).toThrow(/listed twice/)
    expect(() =>
      assertCandidatesAreTotal({ ...answer, candidates: ['a-stranger'] }, poolFor(records, shifts)),
    ).toThrow(/never asked about/)
  })

  it('applies the gender constraint by consuming the pool, never by re-deciding it', () => {
    const male = { ...wholeRecord('free', 'male'), therapistId: 'free' }
    const narrowed = reassignmentCandidates({
      appointment: TARGET,
      pool: poolFor([records[0] as TherapistRecord, male], shifts, 'female'),
      committed,
    })
    expect(narrowed.candidates).toEqual([])
    expect(narrowed.rejected).toContainEqual({ therapistId: 'free', reason: 'gender_mismatch' })
  })

  it('offers an empty list rather than throwing when the pool is empty', () => {
    // The zero-candidate case is an ANSWER, because the acceptance line says the appointment then stays
    // flagged and on the queue. A throw would make "nobody can take it" indistinguishable from a fault.
    const empty = reassignmentCandidates({
      appointment: TARGET,
      pool: { therapists: [], shifts: [], excluded: [] },
      committed,
    })
    expect(empty.candidates).toEqual([])
    expect(empty.rejected).toEqual([])
  })
})

describe('the two vocabularies', () => {
  it('names the four reassignment reasons the database also names', () => {
    expect([...REASSIGNMENT_REASONS]).toEqual([
      'credential_expiry',
      'leave_approved',
      'therapist_archived',
      'manual',
    ])
    expect(reassignmentReason('leave_approved')).toBe('leave_approved')
  })

  it('refuses a reason outside the four rather than passing it to the database', () => {
    try {
      reassignmentReason('because the manager said so')
      expect.unreachable('a reason outside the four must be refused')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      expect(String(error)).toContain('credential_expiry')
    }
  })

  it('adds two rejection labels and collides with none of the port’s seven', () => {
    // The same claim `composedExclusions` makes at runtime for a composed exclusion's reason, made here
    // at authoring time: a label that collided would send a caller to the wrong screen — "renew a
    // credential" for a therapist who is merely busy at 19:00.
    const added = REASSIGNMENT_REJECTIONS.filter(
      (reason) => !(ELIGIBILITY_EXCLUSION_REASONS as readonly string[]).includes(reason),
    )
    expect(added).toEqual(['already_assigned', 'not_rostered_for_the_period', 'therapist_busy'])
    // And in the other direction: the seven are all still in the list, in their own order, so a
    // rejection the pool reports can always be printed.
    expect(REASSIGNMENT_REJECTIONS.slice(0, ELIGIBILITY_EXCLUSION_REASONS.length)).toEqual(
      ELIGIBILITY_EXCLUSION_REASONS,
    )
  })
})

describe('the customer notice may only be transactional', () => {
  const approved = {
    templateKey: REASSIGNMENT_NOTICE_TEMPLATE_KEY,
    messageClass: REASSIGNMENT_NOTICE_CLASS,
    approvalState: 'approved',
  }

  it('accepts the shipped template', () => {
    expect(judgeReassignmentNotice(approved)).toEqual({
      kind: 'sendable',
      templateKey: REASSIGNMENT_NOTICE_TEMPLATE_KEY,
    })
  })

  it('refuses a missing row rather than treating it as nothing to send', () => {
    expect(judgeReassignmentNotice(undefined)).toMatchObject({
      kind: 'refused',
      refusal: 'notice_template_missing',
    })
  })

  it('refuses a promotional class, which is the reclassification C-AUTO-01 made possible', () => {
    expect(judgeReassignmentNotice({ ...approved, messageClass: 'promotional' })).toMatchObject({
      kind: 'refused',
      refusal: 'notice_not_transactional',
    })
  })

  it('refuses words nobody has approved, which the send path would refuse anyway', () => {
    expect(judgeReassignmentNotice({ ...approved, approvalState: 'draft' })).toMatchObject({
      kind: 'refused',
      refusal: 'notice_not_approved',
    })
  })

  it('refuses a row read for another purpose', () => {
    expect(judgeReassignmentNotice({ ...approved, templateKey: 'review.request' })).toMatchObject({
      kind: 'refused',
      refusal: 'notice_template_wrong',
    })
  })
})

describe('the queue is ordered by when the appointment starts', () => {
  const entry = (appointmentId: string, startsAt: number) => ({
    appointmentId,
    startsAt,
    reason: 'credential_expired',
    documentType: 'labour_card',
  })

  it('puts the soonest appointment first, whatever order the flags arrived in', () => {
    const ordered = orderReassignmentQueue([
      entry('later', at(10)),
      entry('soonest', at(1)),
      entry('middle', at(5)),
    ])
    expect(ordered.map((row) => row.appointmentId)).toEqual(['soonest', 'middle', 'later'])
  })

  it('breaks a tie on the appointment id, so a couple booking has one order', () => {
    // Two rows of one delivery start at the same minute. A comparator returning 0 would leave their
    // order to the sort's stability, which is a property of the input rather than of the queue.
    expect(compareQueueEntries(entry('b', at(3)), entry('a', at(3)))).toBeGreaterThan(0)
    expect(compareQueueEntries(entry('a', at(3)), entry('b', at(3)))).toBeLessThan(0)
    expect(compareQueueEntries(entry('a', at(3)), entry('a', at(3)))).toBe(0)
  })

  it('does not sort its argument in place', () => {
    const input = [entry('later', at(10)), entry('soonest', at(1))]
    orderReassignmentQueue(input)
    expect(input.map((row) => row.appointmentId)).toEqual(['later', 'soonest'])
  })
})

// --- the property ------------------------------------------------------------------------------

/**
 * 900 rosters. Small on purpose: the unit config declares no `testTimeout`, so every test in this suite
 * inherits vitest's 5,000 ms, and three correctness tests in this repository have already failed under
 * load rather than on their own merits. The rosters vary in every field the seven checks read, which is
 * what makes a case interesting — not how many of them there are.
 */
const RUNS = 900

interface GeneratedTherapist {
  readonly id: string
  readonly gender: TherapistGender
  readonly skill: TherapistSkill
  /** Which mandatory types are on file, and whether each is current. */
  readonly documents: readonly { readonly documentType: string; readonly expiresOn: string }[]
  /** One span, so the oracle's containment check is a comparison rather than a second interval algebra. */
  readonly shift: { readonly fromHour: number; readonly toHour: number } | null
  /** Their own other appointment, if any. */
  readonly holds: { readonly fromHour: number; readonly toHour: number } | null
}

const therapistArb = (index: number): fc.Arbitrary<GeneratedTherapist> =>
  fc.record({
    id: fc.constant(`t${index}`),
    gender: fc.constantFrom<TherapistGender>('female', 'male'),
    skill: fc.constantFrom<TherapistSkill>('asian_style', 'arabic_style'),
    documents: fc.uniqueArray(
      fc.record({
        documentType: fc.constantFrom(...MANDATORY),
        // Before the trading date, on it, or long after: expired, valid to the last minute, valid.
        expiresOn: fc.constantFrom('2026-09-30', '2026-10-01', '2030-12-31'),
      }),
      { selector: (document) => document.documentType, maxLength: 2 },
    ),
    shift: fc.option(
      fc
        .tuple(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 1, max: 15 }))
        .map(([fromHour, span]) => ({ fromHour, toHour: fromHour + span })),
      { nil: null },
    ),
    holds: fc.option(
      fc
        .tuple(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 1, max: 3 }))
        .map(([fromHour, span]) => ({ fromHour, toHour: fromHour + span })),
      { nil: null },
    ),
  })

const rosterArb = fc.tuple(
  therapistArb(1),
  therapistArb(2),
  therapistArb(3),
  therapistArb(4),
  fc.constantFrom<TherapistGender | undefined>('female', 'male', undefined),
)

/** The incumbent, generated as a whole therapist so they are never excluded by the pool itself. */
const INCUMBENT = 'incumbent'
const TARGET_FROM = 8
const TARGET_TO = 9
const TARGET_BUFFER = 10

const factsFrom = (roster: readonly GeneratedTherapist[]): EligibilityFacts => ({
  mandatoryDocumentTypes: [...MANDATORY],
  therapists: [
    wholeRecord(INCUMBENT),
    ...roster.map((therapist) => ({
      therapistId: therapist.id,
      gender: therapist.gender,
      employedFrom: localDate('2020-01-01'),
      skills: [therapist.skill],
      credentials: therapist.documents.map((document) => ({
        documentType: document.documentType,
        expiresOn: localDate(document.expiresOn),
      })),
    })),
  ],
  shifts: [
    shiftFor(INCUMBENT, 0, 15),
    ...roster.flatMap((therapist) =>
      therapist.shift === null
        ? []
        : [shiftFor(therapist.id, therapist.shift.fromHour, therapist.shift.toHour)],
    ),
  ],
  approvedLeave: [],
})

const committedFrom = (roster: readonly GeneratedTherapist[]): readonly CommittedAppointment[] => [
  appointmentOf({ id: 'target', therapistId: INCUMBENT, from: TARGET_FROM, to: TARGET_TO }),
  ...roster.flatMap((therapist) =>
    therapist.holds === null
      ? []
      : [
          appointmentOf({
            id: `held-${therapist.id}`,
            therapistId: therapist.id,
            from: therapist.holds.fromHour,
            to: therapist.holds.toHour,
            bufferMinutes: 15,
          }),
        ],
  ),
]

/**
 * The oracle. Every clause is a plain comparison over the GENERATED roster; nothing here calls the
 * module under test or the pool rule it consumes.
 */
const oracleSaysDeliverable = (
  therapist: GeneratedTherapist,
  clientGender: TherapistGender | undefined,
): boolean => {
  if (therapist.skill !== REQUIRED_SKILL) return false
  // Credential validity: every mandatory type on file, and none of them expiring before the date.
  for (const documentType of MANDATORY) {
    const held = therapist.documents.find((document) => document.documentType === documentType)
    if (held === undefined) return false
    if (held.expiresOn < '2026-10-01') return false
  }
  // The gender constraint, under strict matching, which is what an absent mode means everywhere.
  if (clientGender !== undefined && therapist.gender !== clientGender) return false
  // A shift covering the treatment plus its buffers, with the buffer written in hours so the comparison
  // stays arithmetic: ten minutes is a sixth of an hour.
  if (therapist.shift === null) return false
  const bufferHours = TARGET_BUFFER / 60
  if (therapist.shift.fromHour > TARGET_FROM - bufferHours) return false
  if (therapist.shift.toHour < TARGET_TO + bufferHours) return false
  // No overlapping appointment of their own, counted with that appointment's 15-minute buffer.
  if (therapist.holds !== null) {
    const heldFrom = therapist.holds.fromHour - 15 / 60
    const heldTo = therapist.holds.toHour + 15 / 60
    if (heldFrom < TARGET_TO + bufferHours && heldTo > TARGET_FROM - bufferHours) return false
  }
  return true
}

describe('property: a candidate is always deliverable, and every deliverable therapist is a candidate', () => {
  it(`holds over ${RUNS} random rosters, in both directions`, () => {
    // The non-vacuity counters. Both directions of the property are satisfied by a generator that never
    // produces a deliverable therapist — "every candidate is deliverable" over an empty list, and "every
    // deliverable therapist is a candidate" over an empty set of them — so the run is only evidence if
    // it reached both states. Counted rather than assumed, because a change to the arbitraries above
    // could quietly make one of them unreachable (brief rule 3).
    let runsWithACandidate = 0
    let runsWithNone = 0
    fc.assert(
      fc.property(rosterArb, ([t1, t2, t3, t4, clientGender]) => {
        const roster = [t1, t2, t3, t4]
        const pool = resolveTherapistPool(factsFrom(roster), {
          tradingDate: DATE,
          requiredSkill: REQUIRED_SKILL,
          ...(clientGender === undefined ? {} : { clientGender }),
        })
        const answer = reassignmentCandidates({
          appointment: { ...TARGET, therapistId: INCUMBENT },
          pool,
          committed: committedFrom(roster),
        })
        // Totality first: a therapist in neither list would make both directions below vacuous for them.
        assertCandidatesAreTotal(answer, pool)

        for (const id of answer.candidates) {
          const generated = roster.find((therapist) => therapist.id === id)
          expect(generated, `candidate ${id} is not in the generated roster`).toBeDefined()
          expect(
            oracleSaysDeliverable(generated as GeneratedTherapist, clientGender),
            `offered ${id}, who the facts say may not take it`,
          ).toBe(true)
        }
        // The converse, which is what stops an over-strict rule passing by returning nothing.
        for (const generated of roster) {
          if (!oracleSaysDeliverable(generated, clientGender)) continue
          expect(
            answer.candidates,
            `${generated.id} satisfies every constraint and was not offered`,
          ).toContain(generated.id)
        }
        // And the incumbent is never offered, whatever the roster says about them.
        expect(answer.candidates).not.toContain(INCUMBENT)
        if (answer.candidates.length > 0) runsWithACandidate += 1
        else runsWithNone += 1
      }),
      { numRuns: RUNS },
    )
    expect(runsWithACandidate).toBeGreaterThan(0)
    // And the zero-candidate case, which is the one the fifth acceptance line is about: the appointment
    // stays flagged. A generator that always found somebody would never exercise it.
    expect(runsWithNone).toBeGreaterThan(0)
  })

  it('the oracle rejects a rule that treats an OVERLAPPING shift as enough', () => {
    // The mutant, written out: presence that merely intersects the buffered interval. It is the mistake
    // `therapistsFreeFor`'s own comment warns about — a therapist sent home at 20:00 in the middle of a
    // treatment that started at 19:00 — and a property whose oracle could not see it would pass.
    const generated: GeneratedTherapist = {
      id: 't1',
      gender: 'female',
      skill: REQUIRED_SKILL,
      documents: MANDATORY.map((documentType) => ({ documentType, expiresOn: '2030-12-31' })),
      shift: { fromHour: 0, toHour: TARGET_TO },
      holds: null,
    }
    const overlapIsEnough =
      generated.shift !== null &&
      generated.shift.fromHour < TARGET_TO &&
      generated.shift.toHour > TARGET_FROM
    expect(overlapIsEnough).toBe(true)
    expect(oracleSaysDeliverable(generated, undefined)).toBe(false)
  })

  it('the oracle would not excuse offering the incumbent', () => {
    // The second mutant: a finder that forgot to remove the therapist who already holds the appointment.
    // The oracle above cannot see it — the incumbent satisfies every constraint — which is why the
    // property asserts `not.toContain(INCUMBENT)` separately rather than relying on it.
    const pool = resolveTherapistPool(factsFrom([]), {
      tradingDate: DATE,
      requiredSkill: REQUIRED_SKILL,
    })
    expect(pool.therapists.map((therapist) => therapist.therapistId)).toEqual([INCUMBENT])
    const answer = reassignmentCandidates({
      appointment: { ...TARGET, therapistId: INCUMBENT },
      pool,
      committed: committedFrom([]),
    })
    expect(answer.candidates).toEqual([])
    expect(answer.rejected).toEqual([{ therapistId: INCUMBENT, reason: 'already_assigned' }])
  })
})
