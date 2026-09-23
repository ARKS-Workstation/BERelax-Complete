import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import { ASIA_DUBAI, instantFromIso, localDate, localTime, type TradingHours } from '../time.ts'
import {
  addMonthsToDate,
  assertObligationCompletable,
  assertPublishingNotBlocked,
  complianceAsOfDate,
  isBlockingObligation,
  OBLIGATION_CADENCE_MONTHS,
  OBLIGATION_CADENCES,
  OBLIGATION_CLASSES,
  OBLIGATION_COMPLETION_REFUSALS,
  type ObligationDefinition,
  type ObligationInstanceFacts,
  obligationBreaches,
  obligationCompletionRefusal,
  obligationDueDates,
  obligationInstancePlan,
  PublishingBlocked,
  publishingBlockedObligationsOf,
  publishingBlockers,
  therapistsBlockedByObligations,
} from './obligation.ts'

/**
 * M-VAT-10 — the compliance calendar engine, and the blocking behaviour that gives it its value.
 *
 * Every assertion here is paired with a control that must fail, because the failure mode of a
 * compliance gate is not that it refuses too much: it is that it refuses nothing and looks identical
 * while doing it. So each "this is blocked" is followed by a "this is not", and the determinism claims
 * are followed by a deliberately different input that must produce a different answer — a comparison of
 * two identical runs passes just as well against a function that returns an empty list.
 */

/** Trading 11:00–02:00 every day, which is the real schedule (docs/13 §2). */
const ELEVEN_TO_TWO: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const alwaysTrading: HoursForDate = () => ELEVEN_TO_TWO

const definition = (over: Partial<ObligationDefinition> = {}): ObligationDefinition => ({
  key: 'trade_licence_renewal',
  title: 'Renew the ADDED trade licence',
  obligationClass: 'licence',
  cadence: 'annual',
  subjectScope: 'business',
  ownerRole: 'owner',
  blockingEffect: 'publishing_blocked',
  evidenceRequired: true,
  isUnverified: false,
  ...over,
})

const instance = (over: Partial<ObligationInstanceFacts> = {}): ObligationInstanceFacts => ({
  instanceId: '00000000-0000-7000-8000-000000000001',
  obligationKey: 'trade_licence_renewal',
  title: 'Renew the ADDED trade licence',
  obligationClass: 'licence',
  blockingEffect: 'publishing_blocked',
  dueOn: localDate('2026-09-01'),
  status: 'open',
  ...over,
})

describe('the vocabularies', () => {
  it('pairs every cadence with its interval, and only event_driven has none', () => {
    expect(Object.keys(OBLIGATION_CADENCE_MONTHS).sort()).toEqual([...OBLIGATION_CADENCES].sort())
    const withoutInterval = OBLIGATION_CADENCES.filter(
      (cadence) => OBLIGATION_CADENCE_MONTHS[cadence] === null,
    )
    expect(withoutInterval).toEqual(['event_driven'])
    expect(OBLIGATION_CADENCE_MONTHS.quarterly).toBe(3)
  })

  it('knows the five classes and calls a consequence blocking exactly when there is one', () => {
    expect([...OBLIGATION_CLASSES]).toEqual(['licence', 'credential', 'hygiene', 'tax', 'labour'])
    expect(isBlockingObligation({ blockingEffect: 'publishing_blocked' })).toBe(true)
    expect(isBlockingObligation({ blockingEffect: 'therapist_unbookable' })).toBe(true)
    // The control. Without it, a function that returned `true` unconditionally would pass the two above.
    expect(isBlockingObligation({ blockingEffect: 'none' })).toBe(false)
  })
})

describe('month arithmetic', () => {
  it('clamps to the end of the target month rather than rolling into the next one', () => {
    // The defect this prevents: 31 January + 1 month as a naive day-of-month copy is 31 February, which
    // Date rolls to 3 March — so a monthly obligation anchored on the 31st walks forward every year.
    expect(addMonthsToDate(localDate('2026-01-31'), 1)).toBe('2026-02-28')
    expect(addMonthsToDate(localDate('2028-01-31'), 1)).toBe('2028-02-29')
    expect(addMonthsToDate(localDate('2026-10-15'), 3)).toBe('2027-01-15')
    expect(addMonthsToDate(localDate('2026-03-15'), -4)).toBe('2025-11-15')
  })

  it('refuses a fractional number of months', () => {
    expect(() => addMonthsToDate(localDate('2026-01-31'), 1.5)).toThrow(/whole|integer/i)
  })
})

describe('obligationDueDates', () => {
  const from = localDate('2026-10-01')

  it('generates twelve monthly, four quarterly and one annual occurrence over twelve months', () => {
    const monthly = obligationDueDates({
      cadence: 'monthly',
      anchorOn: localDate('2026-10-05'),
      from,
      months: 12,
    })
    expect(monthly).toHaveLength(12)
    expect(monthly[0]).toBe('2026-10-05')
    expect(monthly.at(-1)).toBe('2027-09-05')

    const quarterly = obligationDueDates({
      cadence: 'quarterly',
      anchorOn: localDate('2026-10-31'),
      from,
      months: 12,
    })
    expect([...quarterly]).toEqual(['2026-10-31', '2027-01-31', '2027-04-30', '2027-07-31'])

    const annual = obligationDueDates({
      cadence: 'annual',
      anchorOn: localDate('2027-03-01'),
      from,
      months: 12,
    })
    expect([...annual]).toEqual(['2027-03-01'])
  })

  it('steps from the anchor and not from the horizon, so the sequence belongs to the obligation', () => {
    // Anchored years before the horizon. The occurrences must fall on the anchor's day of the month —
    // the 17th — and not on the day the generator happened to run.
    const dates = obligationDueDates({
      cadence: 'quarterly',
      anchorOn: localDate('2019-01-17'),
      from,
      months: 12,
    })
    expect([...dates]).toEqual(['2026-10-17', '2027-01-17', '2027-04-17', '2027-07-17'])
    // The control: stepping from `from` would have produced the 1st of the month, four times.
    expect(dates.some((date) => date.endsWith('-01'))).toBe(false)
  })

  it('generates nothing for an event-driven cadence or an obligation with no date on file', () => {
    expect(
      obligationDueDates({
        cadence: 'event_driven',
        anchorOn: localDate('2026-10-05'),
        from,
        months: 12,
      }),
    ).toEqual([])
    expect(obligationDueDates({ cadence: 'monthly', from, months: 12 })).toEqual([])
    // The control on both empties: the same call WITH an interval and an anchor is not empty, so the
    // two above are answers and not a function that returns nothing.
    expect(
      obligationDueDates({
        cadence: 'monthly',
        anchorOn: localDate('2026-10-05'),
        from,
        months: 12,
      }),
    ).not.toEqual([])
  })

  it('refuses a horizon that is not a positive whole number of months', () => {
    expect(() => obligationDueDates({ cadence: 'monthly', from, months: 0 })).toThrow(/positive/)
    expect(() => obligationDueDates({ cadence: 'monthly', from, months: -12 })).toThrow(/positive/)
    expect(() => obligationDueDates({ cadence: 'monthly', from, months: 1.5 })).toThrow(/whole/)
  })
})

describe('obligationInstancePlan', () => {
  const definitions = [
    definition({ key: 'trade_licence_renewal', anchorOn: localDate('2026-11-20') }),
    definition({
      key: 'therapist_health_certificate_renewal',
      obligationClass: 'credential',
      cadence: 'annual',
      subjectScope: 'therapist',
      ownerRole: 'manager',
      blockingEffect: 'therapist_unbookable',
      anchorOn: localDate('2026-12-01'),
    }),
    // No anchor: the document has not been read, so nothing is generated for it.
    definition({ key: 'municipality_health_permit_renewal' }),
    definition({
      key: 'therapist_work_permit_renewal',
      obligationClass: 'credential',
      cadence: 'event_driven',
      subjectScope: 'therapist',
      ownerRole: 'manager',
      blockingEffect: 'therapist_unbookable',
      anchorOn: localDate('2026-11-01'),
    }),
  ]
  const therapistIds = ['emp-b', 'emp-a']
  const input = { definitions, from: localDate('2026-10-01'), months: 12, therapistIds }

  it('is deterministic: two runs produce identical rows, in one total order', () => {
    const first = obligationInstancePlan(input)
    const second = obligationInstancePlan(input)
    expect(second).toEqual(first)
    // Sorted, so a caller handing the therapists over in another order still writes the same rows.
    const reordered = obligationInstancePlan({ ...input, therapistIds: ['emp-a', 'emp-b'] })
    expect(reordered).toEqual(first)
    expect([...first]).toEqual([
      {
        obligationKey: 'therapist_health_certificate_renewal',
        dueOn: '2026-12-01',
        subjectEmployeeId: 'emp-a',
      },
      {
        obligationKey: 'therapist_health_certificate_renewal',
        dueOn: '2026-12-01',
        subjectEmployeeId: 'emp-b',
      },
      { obligationKey: 'trade_licence_renewal', dueOn: '2026-11-20' },
    ])
  })

  it('and the control: a different horizon produces a different plan', () => {
    // Without this, "two runs are identical" would pass against a function that returns nothing at all.
    const shifted = obligationInstancePlan({ ...input, from: localDate('2027-01-01') })
    expect(shifted).not.toEqual(obligationInstancePlan(input))
    expect(shifted.map((row) => row.dueOn)).not.toContain('2026-11-20')
  })

  it('generates nothing for a per-therapist obligation when no therapist was supplied', () => {
    const withoutTherapists = obligationInstancePlan({ ...input, therapistIds: [] })
    expect(withoutTherapists.map((row) => row.obligationKey)).toEqual(['trade_licence_renewal'])
    // A business-wide row for a per-therapist duty would be an occurrence nobody owes.
    expect(withoutTherapists.every((row) => row.subjectEmployeeId === undefined)).toBe(true)
  })
})

describe('complianceAsOfDate', () => {
  it('puts 01:30 in the previous trading date and 11:30 in the current one', () => {
    // The whole reason business_day is first class. At 01:30 on the 19th the salon is still working the
    // 18th, so an obligation due on the 18th is not overdue and a blocking one must not take a therapist
    // off a shift they are halfway through.
    const lateNight = instantFromIso('2026-10-18T21:30:00Z') // 01:30 on the 19th in Asia/Dubai
    expect(complianceAsOfDate(lateNight, alwaysTrading, ASIA_DUBAI)).toBe('2026-10-18')

    const nextMorning = instantFromIso('2026-10-19T07:30:00Z') // 11:30 on the 19th
    expect(complianceAsOfDate(nextMorning, alwaysTrading, ASIA_DUBAI)).toBe('2026-10-19')

    const due = instance({ dueOn: localDate('2026-10-18') })
    expect(
      obligationBreaches([due], complianceAsOfDate(lateNight, alwaysTrading, ASIA_DUBAI)),
    ).toEqual([])
    expect(
      obligationBreaches([due], complianceAsOfDate(nextMorning, alwaysTrading, ASIA_DUBAI)),
    ).toHaveLength(1)
  })

  it('falls back to the calendar date in the daytime gap, when the trading date has ended', () => {
    // 09:00, before opening: the 18th's trading date closed at 02:00 and the 19th has not opened, so an
    // obligation due on the 18th really is overdue. The zone defaults to Asia/Dubai.
    const gap = instantFromIso('2026-10-19T05:00:00Z')
    expect(complianceAsOfDate(gap, alwaysTrading)).toBe('2026-10-19')
    // And a date the premises does not trade at all resolves the same way rather than throwing.
    expect(complianceAsOfDate(gap, () => undefined, ASIA_DUBAI)).toBe('2026-10-19')
  })
})

describe('obligationBreaches', () => {
  const asOf = localDate('2026-10-01')

  it('is strictly overdue, open, and blocking — with a control on each', () => {
    const breaches = obligationBreaches(
      [
        instance({ instanceId: 'overdue', dueOn: localDate('2026-09-30') }),
        // Due today is not late today.
        instance({ instanceId: 'due-today', dueOn: localDate('2026-10-01') }),
        // Completed, however late.
        instance({ instanceId: 'done', dueOn: localDate('2026-01-01'), status: 'completed' }),
        // Overdue and not blocking: the VAT return being late does not stop the salon working.
        instance({
          instanceId: 'vat',
          obligationKey: 'vat_return_filing',
          obligationClass: 'tax',
          blockingEffect: 'none',
          dueOn: localDate('2026-01-01'),
        }),
      ],
      asOf,
    )
    expect(breaches.map((breach) => breach.instanceId)).toEqual(['overdue'])
  })

  it('orders by due date then key, so two readers report one order', () => {
    const breaches = obligationBreaches(
      [
        instance({
          instanceId: 'b',
          obligationKey: 'municipality_health_permit_renewal',
          dueOn: localDate('2026-02-01'),
        }),
        instance({
          instanceId: 'a',
          obligationKey: 'trade_licence_renewal',
          dueOn: localDate('2026-01-01'),
        }),
        instance({
          instanceId: 'c',
          obligationKey: 'a_licence_renewal',
          dueOn: localDate('2026-02-01'),
        }),
      ],
      asOf,
    )
    expect(breaches.map((breach) => breach.instanceId)).toEqual(['a', 'c', 'b'])
  })
})

describe('the availability consequence', () => {
  const asOf = localDate('2026-10-01')
  const credential = (over: Partial<ObligationInstanceFacts>): ObligationInstanceFacts =>
    instance({
      obligationKey: 'therapist_health_certificate_renewal',
      obligationClass: 'credential',
      blockingEffect: 'therapist_unbookable',
      ...over,
    })

  it('names the therapists an overdue blocking credential obligation takes out, and nobody else', () => {
    const blocked = therapistsBlockedByObligations(
      [
        credential({
          instanceId: '1',
          subjectEmployeeId: 'emp-lapsed',
          dueOn: localDate('2026-09-01'),
        }),
        // Same therapist, a second overdue obligation: one entry, not two.
        credential({
          instanceId: '2',
          obligationKey: 'therapist_professional_licence_renewal',
          subjectEmployeeId: 'emp-lapsed',
          dueOn: localDate('2026-08-01'),
        }),
        // Not yet due.
        credential({
          instanceId: '3',
          subjectEmployeeId: 'emp-current',
          dueOn: localDate('2026-12-01'),
        }),
        // Overdue, completed.
        credential({
          instanceId: '4',
          subjectEmployeeId: 'emp-renewed',
          dueOn: localDate('2026-01-01'),
          status: 'completed',
        }),
        // Overdue, blocking, and publishing rather than availability: a different code path entirely.
        instance({ instanceId: '5', dueOn: localDate('2026-01-01') }),
      ],
      asOf,
    )
    expect([...blocked]).toEqual(['emp-lapsed'])
  })

  it('ignores a subjectless therapist_unbookable breach rather than excluding everybody', () => {
    // The schema cannot produce this row (therapist_unbookable implies subject_scope = therapist), and
    // if it did, the permissive reading would close the salon on a data defect.
    const blocked = therapistsBlockedByObligations(
      [credential({ instanceId: '6', dueOn: localDate('2026-01-01') })],
      asOf,
    )
    expect([...blocked]).toEqual([])
  })
})

describe('the publishing consequence', () => {
  const asOf = localDate('2026-10-01')

  it('refuses publication with PublishingBlocked, naming the obligation', () => {
    const overdue = instance({ dueOn: localDate('2026-09-01') })
    expect(publishingBlockers([overdue], asOf).map((breach) => breach.obligationKey)).toEqual([
      'trade_licence_renewal',
    ])

    let caught: unknown
    try {
      assertPublishingNotBlocked([overdue], asOf)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PublishingBlocked)
    const error = caught as PublishingBlocked
    expect(error.message).toContain('trade_licence_renewal')
    expect(error.message).toContain('2026-09-01')
    expect(error.details['code']).toBe('publishing_blocked')
    expect(error.details['obligations']).toEqual(['trade_licence_renewal'])
    expect(error.kind).toBe('forbidden')
    expect(publishingBlockedObligationsOf(error)).toEqual(['trade_licence_renewal'])
  })

  it('and the controls: nothing overdue publishes, and an unrelated error is not a block', () => {
    expect(() =>
      assertPublishingNotBlocked([instance({ dueOn: localDate('2026-12-01') })], asOf),
    ).not.toThrow()
    expect(() => assertPublishingNotBlocked([], asOf)).not.toThrow()
    // An overdue therapist credential does NOT block publishing: the two consequences are separate.
    expect(() =>
      assertPublishingNotBlocked(
        [
          instance({
            obligationKey: 'therapist_health_certificate_renewal',
            obligationClass: 'credential',
            blockingEffect: 'therapist_unbookable',
            subjectEmployeeId: 'emp-lapsed',
            dueOn: localDate('2026-01-01'),
          }),
        ],
        asOf,
      ),
    ).not.toThrow()
    expect(publishingBlockedObligationsOf(new Error('something else'))).toBeNull()
  })
})

describe('completing an occurrence', () => {
  const owed = definition({
    ownerRole: 'manager',
    evidenceRequired: true,
    key: 'hygiene_inspection_log_review',
  })

  it('requires the declared role, and reports the role before the evidence', () => {
    expect(
      obligationCompletionRefusal({ definition: owed, role: 'receptionist', hasEvidence: true }),
    ).toBe('RoleNotPermitted')
    // Wrong role AND no evidence: one order, reported the same way as the database's trigger reports it.
    expect(
      obligationCompletionRefusal({ definition: owed, role: 'receptionist', hasEvidence: false }),
    ).toBe('RoleNotPermitted')
    expect(
      obligationCompletionRefusal({ definition: owed, role: 'manager', hasEvidence: false }),
    ).toBe('EvidenceRequired')
    // The controls. The declared role with evidence passes, and so does the owner, who holds every
    // permission by definition.
    expect(
      obligationCompletionRefusal({ definition: owed, role: 'manager', hasEvidence: true }),
    ).toBeNull()
    expect(
      obligationCompletionRefusal({ definition: owed, role: 'owner', hasEvidence: true }),
    ).toBeNull()
    // And an obligation that requires no evidence completes without one.
    expect(
      obligationCompletionRefusal({
        definition: definition({ ownerRole: 'manager', evidenceRequired: false }),
        role: 'manager',
        hasEvidence: false,
      }),
    ).toBeNull()
  })

  it('throws with the refusal named in details, so a caller branches without reading prose', () => {
    expect(() =>
      assertObligationCompletable({ definition: owed, role: 'manager', hasEvidence: true }),
    ).not.toThrow()

    for (const [role, hasEvidence, expected] of [
      ['receptionist', true, 'RoleNotPermitted'],
      ['manager', false, 'EvidenceRequired'],
    ] as const) {
      let caught: unknown
      try {
        assertObligationCompletable({ definition: owed, role, hasEvidence })
      } catch (error) {
        caught = error
      }
      expect((caught as { details: Record<string, unknown> }).details['code']).toBe(expected)
      expect((caught as Error).message).toContain('hygiene_inspection_log_review')
      expect(OBLIGATION_COMPLETION_REFUSALS).toContain(expected)
    }
  })
})
