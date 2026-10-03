import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import { HUNDREDTHS_PER_DAY, type LeaveEntitlementRules } from './leave-accrual.ts'
import {
  isLeaveRequestKind,
  judgeLeaveSubmission,
  LEAVE_REQUEST_KINDS,
  leaveEntitlementRulesFrom,
  MAX_SUBMITTED_LEAVE_DAYS,
} from './leave-submission.ts'

/**
 * P-HR-14 — the ONE judgement a submitted leave request passes through.
 *
 * Every refusal is paired with the acceptance that differs from it in exactly one input, which is brief
 * rule 3 applied to a validator: a function that refused everything would satisfy the refusal half
 * perfectly, and three of the five refusals here are one day either side of an accepted request.
 *
 * The balance refusal is asserted at the BOUNDARY and not somewhere comfortably inside it. 30 days of
 * balance funds 30 days of leave and not 31, and both are asserted — a comparison written `<` instead of
 * `<=` passes a test that asks for 10 days against 30 and fails only at the edge.
 */

const RULES: LeaveEntitlementRules = leaveEntitlementRulesFrom({
  effectiveFrom: '2000-01-01',
  annualEntitlementDays: 30,
  monthlyAccrualHundredths: 250,
  probationMonths: 6,
  accruesDuringProbation: true,
  carryOverCapHundredths: 3000,
  carryOverExpiresAfterOneLeaveYear: false,
  leaveYearStartsOnAnniversary: false,
  unpaidLeaveReducesAccrual: true,
  absentDayReducesAccrual: true,
  sickFullPayDays: 15,
  sickHalfPayDays: 30,
  sickUnpaidDays: 45,
})

/** Employed long enough to be out of probation, with thirty days on the ledger. */
const SUBJECT = {
  employedFrom: localDate('2024-01-01'),
  balanceHundredths: 30 * HUNDREDTHS_PER_DAY,
}

const SUBMITTED_ON = localDate('2026-06-01')

const judge = (
  overrides: Partial<{
    kind: string
    from: string
    to: string
    employedFrom: string
    balanceHundredths: number
    submittedOn: string
  }> = {},
) =>
  judgeLeaveSubmission({
    request: {
      kind: overrides.kind ?? 'annual',
      from: localDate(overrides.from ?? '2026-07-01'),
      to: localDate(overrides.to ?? '2026-07-05'),
    },
    subject: {
      employedFrom: localDate(overrides.employedFrom ?? '2024-01-01'),
      balanceHundredths: overrides.balanceHundredths ?? SUBJECT.balanceHundredths,
    },
    rules: RULES,
    submittedOn: localDate(overrides.submittedOn ?? SUBMITTED_ON),
  })

describe('the leave kinds', () => {
  it('is the 0030 enum and nothing else', () => {
    expect([...LEAVE_REQUEST_KINDS]).toEqual(['annual', 'sick', 'unpaid', 'other'])
    expect(isLeaveRequestKind('annual')).toBe(true)
    // The control: a value that looks like a kind and is not. A kind the enum does not know would be
    // refused by the database with a message about a cast.
    expect(isLeaveRequestKind('holiday')).toBe(false)
    expect(isLeaveRequestKind('')).toBe(false)
  })
})

describe('an ordinary request', () => {
  it('is accepted with the days and the hundredths the reservation must deduct', () => {
    const verdict = judge()
    expect(verdict.kind).toBe('accepted')
    if (verdict.kind !== 'accepted') return
    // Five calendar days, inclusive of both ends. `calendarLeaveDays` owns that and this asserts the
    // figure reaches the reservation rather than the length of the range.
    expect(verdict.days).toBe(5)
    expect(verdict.hundredths).toBe(5 * HUNDREDTHS_PER_DAY)
    expect(verdict.leaveKind).toBe('annual')
  })

  it('charges the leave year containing the SUBMISSION date and not the leave', () => {
    // 0066's reading of the column: `occurred_on` for a reservation is the day the request was made and
    // `leave_year_start` is the leave year that movement belongs to. A December request for January
    // leave therefore reserves from December's balance, which is also the only reading consistent with
    // "a request reserves when it is made".
    const verdict = judge({ submittedOn: '2026-12-20', from: '2027-01-04', to: '2027-01-06' })
    expect(verdict.kind).toBe('accepted')
    if (verdict.kind !== 'accepted') return
    expect(verdict.leaveYearStart).toBe('2026-01-01')
  })
})

describe('the refusals, each beside the acceptance it differs from by one input', () => {
  it('refuses a kind the enum does not know', () => {
    const verdict = judge({ kind: 'holiday' })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'unknown_leave_kind' })
    expect(judge({ kind: 'annual' }).kind).toBe('accepted')
  })

  it('refuses an inverted range', () => {
    const verdict = judge({ from: '2026-07-05', to: '2026-07-01' })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'leave_range_not_submittable' })
    // One day the other way is accepted, which is the control.
    expect(judge({ from: '2026-07-05', to: '2026-07-05' }).kind).toBe('accepted')
  })

  it('refuses a range longer than the fence, and accepts one exactly at it', () => {
    // The fence is not a policy about how much leave somebody may take — the balance is that. It is what
    // stops a mistyped year becoming a reservation of a year's leave against a balance that cannot
    // refuse it, because the reservation is written before anybody approves anything.
    const longEnough = judge({
      kind: 'unpaid',
      from: '2026-07-01',
      to: '2027-06-30',
      balanceHundredths: 0,
    })
    expect(longEnough.kind).toBe('accepted')
    if (longEnough.kind === 'accepted') expect(longEnough.days).toBe(MAX_SUBMITTED_LEAVE_DAYS - 1)
    const tooLong = judge({
      kind: 'unpaid',
      from: '2026-07-01',
      to: '2027-07-05',
      balanceHundredths: 0,
    })
    expect(tooLong).toMatchObject({ kind: 'refused', refusal: 'leave_range_not_submittable' })
  })

  it('refuses annual leave inside probation and allows it the day after', () => {
    // Probation is six months from the engagement date, so somebody engaged on 2026-06-01 may not take
    // annual leave until 2026-12-01. Both sides asserted: the day before and the day of.
    const inside = judge({
      employedFrom: '2026-06-01',
      submittedOn: '2026-06-02',
      from: '2026-11-30',
      to: '2026-11-30',
    })
    expect(inside).toMatchObject({ kind: 'refused', refusal: 'within_probation' })
    const after = judge({
      employedFrom: '2026-06-01',
      submittedOn: '2026-06-02',
      from: '2026-12-01',
      to: '2026-12-01',
    })
    expect(after.kind).toBe('accepted')
  })

  it('does NOT refuse sick or unpaid leave inside probation', () => {
    // The separation `leave-accrual.ts` records: accrual runs from day one and TAKING annual leave waits
    // for probation. Sick leave has its own entitlement and unpaid leave is by definition not drawn from
    // an accrual, so neither is refused by the probation rule.
    for (const kind of ['sick', 'unpaid', 'other'] as const) {
      const verdict = judge({
        kind,
        employedFrom: '2026-06-01',
        submittedOn: '2026-06-02',
        from: '2026-06-10',
        to: '2026-06-12',
        balanceHundredths: 0,
      })
      expect(verdict.kind, `${kind} inside probation`).toBe('accepted')
    }
  })

  it('refuses a request starting before the employment did', () => {
    const verdict = judge({ employedFrom: '2026-01-01', from: '2025-12-20', to: '2025-12-22' })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'before_employment' })
  })

  it('refuses a submission dated before the employment did', () => {
    // The other half, and it exists because `leaveYearStart` THROWS for a date before the engagement:
    // without this branch a future hire filing leave would be a 503 rather than a refusal.
    const verdict = judge({
      employedFrom: '2026-01-01',
      submittedOn: '2025-12-01',
      from: '2026-07-01',
      to: '2026-07-02',
    })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'before_employment' })
  })
})

describe('the balance, at the boundary', () => {
  it('funds exactly the balance and not one day more', () => {
    // 30 days on the ledger. 30 days of leave is funded; 31 is not. A comparison written `<` instead of
    // `<=` passes everything except this pair.
    const exact = judge({ from: '2026-07-01', to: '2026-07-30', balanceHundredths: 3000 })
    expect(exact.kind).toBe('accepted')
    if (exact.kind === 'accepted') expect(exact.hundredths).toBe(3000)
    const over = judge({ from: '2026-07-01', to: '2026-07-31', balanceHundredths: 3000 })
    expect(over).toMatchObject({ kind: 'refused', refusal: 'insufficient_balance' })
  })

  it('refuses annual leave against no balance at all', () => {
    const verdict = judge({ balanceHundredths: 0 })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'insufficient_balance' })
  })

  it('treats a NEGATIVE reported balance as nothing rather than as credit', () => {
    // An opening-balance import can be corrected downwards, so a negative balance is reachable. Clamping
    // it to zero can only ever make the engine refuse — never accept — which is what the clamp's comment
    // claims and this is the assertion behind it.
    const verdict = judge({ balanceHundredths: -500 })
    expect(verdict).toMatchObject({ kind: 'refused', refusal: 'insufficient_balance' })
  })

  it('does not charge the balance for anything but annual leave', () => {
    // The control for the three cases above: with no balance at all, unpaid leave is still accepted, so
    // `insufficient_balance` is a claim about ANNUAL leave and not about every request.
    expect(judge({ kind: 'unpaid', balanceHundredths: 0 }).kind).toBe('accepted')
    expect(judge({ kind: 'sick', balanceHundredths: 0 }).kind).toBe('accepted')
  })
})

describe('the rule-row mapping', () => {
  it('carries every field, including the nested sick tiers', () => {
    // The mapping that used to exist twice — here and in `apps/worker/src/jobs/leave-accrual.ts` — and
    // the reason it is one function now: thirteen fields with a nested trio is the shape whose second
    // copy stops matching silently.
    expect(RULES.effectiveFrom).toBe('2000-01-01')
    expect(RULES.probationMonths).toBe(6)
    expect(RULES.sickLeave).toEqual({ fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 })
    expect(RULES.leaveYearStartsOnAnniversary).toBe(false)
  })
})
