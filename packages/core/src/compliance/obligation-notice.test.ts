import { MAX_OBLIGATION_NOTICE_OFFSET_DAYS, MAX_OBLIGATION_NOTICE_OFFSETS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { ROLES, type Role } from '../access/permissions.ts'
import { localDate } from '../time.ts'
import {
  addDaysToDate,
  COMPLIANCE_DEADLINE_STATES,
  complianceQuestionCounts,
  complianceQuestionRows,
  complianceQuestionSections,
  daysBetweenDates,
  decideObligationNotice,
  escalationRoleFor,
  OBLIGATION_ESCALATION_LADDER,
  OBLIGATION_NOTICE_LATE_TOLERANCE_DAYS,
  OBLIGATION_NOTICE_STEP_PATTERN,
  obligationNoticeKeyFor,
  obligationNoticeOffsetsFrom,
  obligationNoticePlanFor,
  obligationNoticeStep,
} from './obligation-notice.ts'

/**
 * M-VAT-11's rule, tested without a database, a clock or a queue.
 *
 * Every assertion here is paired with a control that must fail (brief rule 3), because most of the claims
 * in this module are about something NOT happening — a notice not firing twice, an escalation not going to
 * the role that already had the reminder, an unanswered question not being counted as a breach — and a
 * test of an absence passes vacuously the moment the thing it was watching stops being produced at all.
 */

const INSTANCE = '3f6a1c88-0000-4000-8000-00000000c101'
const OTHER_INSTANCE = '3f6a1c88-0000-4000-8000-00000000c102'
const DUE = localDate('2096-06-30')

describe('the step label, and the bound 0060 restates', () => {
  it('spells a rung one way for both ladders', () => {
    expect(obligationNoticeStep('reminder', 60)).toBe('reminder_60d')
    expect(obligationNoticeStep('escalation', 7)).toBe('escalation_7d')
    // Both match the pattern the migration's CHECK holds. A label the database refuses could never match
    // a stored notice, so every send would be refused as stale — a silent failure wearing a safe answer.
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('reminder_60d')).toBe(true)
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('escalation_7d')).toBe(true)
  })

  it('refuses an offset outside the range the registry and the CHECK both declare', () => {
    expect(() => obligationNoticeStep('reminder', 0)).toThrow(
      /whole number of days between 1 and 365/,
    )
    expect(() => obligationNoticeStep('reminder', MAX_OBLIGATION_NOTICE_OFFSET_DAYS + 1)).toThrow(
      /whole number of days/,
    )
    expect(() => obligationNoticeStep('reminder', 1.5)).toThrow(/whole number of days/)
    // The control on the pattern itself: the shapes it must NOT accept. Without these the regex could be
    // `/./` and every assertion above would pass.
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('reminder_0d')).toBe(false)
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('reminder_1000d')).toBe(false)
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('reminder_24h')).toBe(false)
    expect(OBLIGATION_NOTICE_STEP_PATTERN.test('notice_7d')).toBe(false)
  })
})

describe('a stored ladder is validated, never coerced', () => {
  const KEY = 'compliance.obligation_reminder_offsets_days'

  it('accepts a ladder and sorts it descending whatever order it was typed in', () => {
    expect(obligationNoticeOffsetsFrom([7, 60, 30], KEY)).toEqual([60, 30, 7])
    // Two equivalent settings must produce identical tables: a plan whose row order depended on the
    // typing would make one owner's [7, 60] a different calendar from another's [60, 7].
    expect(obligationNoticeOffsetsFrom([60, 7], KEY)).toEqual(
      obligationNoticeOffsetsFrom([7, 60], KEY),
    )
  })

  it('accepts the EMPTY ladder, which is how an owner turns the notices off', () => {
    expect(obligationNoticeOffsetsFrom([], KEY)).toEqual([])
  })

  it('refuses every malformed value rather than defaulting it away', () => {
    // The whole reason the reader returns `unknown`: a corrupt value and a deliberate empty ladder must
    // not read the same, because the empty ladder is a decision.
    expect(() => obligationNoticeOffsetsFrom(null, KEY)).toThrow(/not an array/)
    expect(() => obligationNoticeOffsetsFrom('60,30', KEY)).toThrow(/not an array/)
    expect(() => obligationNoticeOffsetsFrom([60, '30'], KEY)).toThrow(/whole number of days/)
    expect(() => obligationNoticeOffsetsFrom([60, 30.5], KEY)).toThrow(/whole number of days/)
    expect(() => obligationNoticeOffsetsFrom([60, 400], KEY)).toThrow(/outside 1 to 365/)
    expect(() => obligationNoticeOffsetsFrom([60, 60], KEY)).toThrow(/appears twice/)
    expect(() =>
      obligationNoticeOffsetsFrom(
        Array.from({ length: MAX_OBLIGATION_NOTICE_OFFSETS + 1 }, (_, index) => index + 1),
        KEY,
      ),
    ).toThrow(/ceiling is 4/)
  })
})

describe('the escalation ladder names a role that can act, or it does not escalate', () => {
  it('is total over ROLES, so a role added to the matrix cannot be silently defaulted', () => {
    expect(Object.keys(OBLIGATION_ESCALATION_LADDER).sort()).toEqual([...ROLES].sort())
  })

  it('never escalates to a role that is not in the matrix, and never to itself', () => {
    for (const role of ROLES) {
      const next = escalationRoleFor(role)
      if (next === null) continue
      expect(ROLES, `${role} escalates to a role the matrix knows`).toContain(next)
      // The collapse a `?? ownerRole` fallback produces, and it looks correct in review: an escalation to
      // the role that already receives the reminders is decoration, and 0060 refuses it outright.
      expect(next, `${role} does not escalate to itself`).not.toBe(role)
    }
  })

  it('stops at the roles with nobody above them and at the two that could not act', () => {
    expect(escalationRoleFor('manager')).toBe('owner')
    expect(escalationRoleFor('accountant')).toBe('owner')
    expect(escalationRoleFor('receptionist')).toBe('manager')
    expect(escalationRoleFor('therapist')).toBe('manager')
    expect(escalationRoleFor('marketer')).toBe('manager')
    // The proprietor is the top. `auditor` writes nothing by definition and `system` has no interactive
    // login, so a notice to either is a message that cannot be answered — which reads on a dashboard as a
    // duty somebody is dealing with, and that is worse than no message at all.
    expect(escalationRoleFor('owner')).toBeNull()
    expect(escalationRoleFor('auditor')).toBeNull()
    expect(escalationRoleFor('system')).toBeNull()
  })
})

describe('the invalidation key', () => {
  it('names the step, the occurrence and the due date, in one comparable value', () => {
    expect(obligationNoticeKeyFor({ instanceId: INSTANCE, step: 'reminder_60d', dueOn: DUE })).toBe(
      `reminder_60d:${INSTANCE}:2096-06-30`,
    )
  })

  it('changes when the deadline moves, when the occurrence differs, and when the rung differs', () => {
    const base = obligationNoticeKeyFor({ instanceId: INSTANCE, step: 'reminder_60d', dueOn: DUE })
    // Each of these is the case the key exists to catch. Without all three, a key made only of the
    // occurrence id would compare equal after a due-date correction and the notice would still fire.
    expect(
      obligationNoticeKeyFor({
        instanceId: INSTANCE,
        step: 'reminder_60d',
        dueOn: localDate('2096-07-31'),
      }),
    ).not.toBe(base)
    expect(
      obligationNoticeKeyFor({ instanceId: OTHER_INSTANCE, step: 'reminder_60d', dueOn: DUE }),
    ).not.toBe(base)
    expect(
      obligationNoticeKeyFor({ instanceId: INSTANCE, step: 'reminder_30d', dueOn: DUE }),
    ).not.toBe(base)
  })

  it('refuses a blank occurrence and a label 0060 would not store', () => {
    expect(() =>
      obligationNoticeKeyFor({ instanceId: '  ', step: 'reminder_60d', dueOn: DUE }),
    ).toThrow(/needs the occurrence/)
    expect(() =>
      obligationNoticeKeyFor({ instanceId: INSTANCE, step: 'reminder_24h', dueOn: DUE }),
    ).toThrow(/is not a notice step/)
  })
})

describe('calendar arithmetic', () => {
  it('adds and subtracts whole days across a month and a leap February', () => {
    expect(addDaysToDate(localDate('2096-06-30'), -60)).toBe('2096-05-01')
    expect(addDaysToDate(localDate('2096-03-01'), -1)).toBe('2096-02-29')
    expect(addDaysToDate(localDate('2096-12-31'), 1)).toBe('2097-01-01')
    expect(daysBetweenDates(localDate('2096-06-30'), localDate('2096-05-01'))).toBe(60)
    expect(daysBetweenDates(localDate('2096-05-01'), localDate('2096-06-30'))).toBe(-60)
    expect(() => addDaysToDate(DUE, 1.5)).toThrow(/integer/)
  })
})

const LADDER = { reminderOffsetsDays: [60, 30, 7], escalationOffsetsDays: [7, 21] } as const

describe('the notice plan', () => {
  it('addresses reminders to the declared owner and escalations to the role above it', () => {
    const plan = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: DUE,
      ownerRole: 'manager',
      ...LADDER,
    })
    expect(plan.escalationRole).toBe('owner')
    expect(plan.escalationAbsence).toBeNull()
    expect(
      plan.notices.map((notice) => `${notice.step} ${notice.toRole} ${notice.notifyOn}`),
    ).toEqual([
      'reminder_60d manager 2096-05-01',
      'reminder_30d manager 2096-05-31',
      'reminder_7d manager 2096-06-23',
      'escalation_7d owner 2096-07-07',
      'escalation_21d owner 2096-07-21',
    ])
    // The control on the addressing: no notice is addressed to the owner's own role by accident, and no
    // reminder is addressed to the escalation role. Without this, a plan that sent every notice to the
    // owner would satisfy the count and the dates.
    expect(
      plan.notices.filter((n) => n.kind === 'reminder').every((n) => n.toRole === 'manager'),
    ).toBe(true)
    expect(
      plan.notices.filter((n) => n.kind === 'escalation').every((n) => n.toRole === 'owner'),
    ).toBe(true)
  })

  it('plans no escalation for a duty with nobody above it, and says why', () => {
    const plan = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: DUE,
      ownerRole: 'owner',
      ...LADDER,
    })
    expect(plan.escalationRole).toBeNull()
    expect(plan.escalationAbsence).toBe('no_role_above')
    expect(plan.notices.every((notice) => notice.kind === 'reminder')).toBe(true)
    // Reported and not silent. An escalation addressed to whoever is left would be the decoration the
    // unit exists to refuse; an absence with no reason would be indistinguishable from a defect.
    expect(plan.notices).toHaveLength(3)
  })

  it('reports an empty escalation ladder as a decision rather than as an absent role', () => {
    const plan = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: DUE,
      ownerRole: 'manager',
      reminderOffsetsDays: [30],
      escalationOffsetsDays: [],
    })
    // Two different absences, distinguished: the owner switched escalation off, which is not the same
    // fact as there being nobody to escalate to.
    expect(plan.escalationAbsence).toBe('ladder_empty')
    expect(plan.escalationRole).toBe('owner')
  })

  it('is in a total order, so two runs over one occurrence produce identical rows', () => {
    const first = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: DUE,
      ownerRole: 'accountant',
      reminderOffsetsDays: [7, 60],
      escalationOffsetsDays: [21, 7],
    })
    const second = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: DUE,
      ownerRole: 'accountant',
      reminderOffsetsDays: [60, 7],
      escalationOffsetsDays: [7, 21],
    })
    expect(first.notices).toEqual(second.notices)
    const dates = first.notices.map((notice) => notice.notifyOn)
    expect([...dates]).toEqual([...dates].sort())
  })

  it('leaves a notify date already in the past in the plan rather than dropping it', () => {
    // A row for a missed notice is what makes the miss countable: "no row" and "a row that says why it
    // went out late" are different facts and only the second can be reported on.
    const plan = obligationNoticePlanFor({
      instanceId: INSTANCE,
      dueOn: localDate('2096-01-05'),
      ownerRole: 'manager',
      reminderOffsetsDays: [60],
      escalationOffsetsDays: [],
    })
    expect(plan.notices.map((notice) => notice.notifyOn)).toEqual(['2095-11-06'])
  })

  it('refuses an owner role the F07 matrix has never heard of', () => {
    expect(() =>
      obligationNoticePlanFor({
        instanceId: INSTANCE,
        dueOn: DUE,
        ownerRole: 'compliance_officer' as Role,
        ...LADDER,
      }),
    ).toThrow(/not a role in the F07 matrix/)
  })
})

const NOTICE = {
  instanceId: INSTANCE,
  step: 'reminder_30d',
  kind: 'reminder' as const,
  invalidationKey: obligationNoticeKeyFor({
    instanceId: INSTANCE,
    step: 'reminder_30d',
    dueOn: DUE,
  }),
  notifyOn: localDate('2096-05-31'),
}
const OPEN = { dueOn: DUE, status: 'open' as const, acknowledged: false }

describe('the verdict on one notice', () => {
  it('sends a notice that is due, about the current deadline, with content', () => {
    const verdict = decideObligationNotice({
      notice: NOTICE,
      occurrence: OPEN,
      asOf: localDate('2096-05-31'),
      contentAvailable: true,
    })
    expect(verdict).toEqual({ kind: 'send', lateByDays: 0, stalenessNote: null })
  })

  it('defers one that is not due yet, which is what the pending row records', () => {
    const verdict = decideObligationNotice({
      notice: NOTICE,
      occurrence: OPEN,
      asOf: localDate('2096-05-30'),
      contentAvailable: true,
    })
    expect(verdict.kind).toBe('defer')
  })

  it('refuses a notice whose deadline has moved, BEFORE anything else gets to decide', () => {
    // The damaging case, and the reason the key is checked first: this notice is live, due today and
    // perfectly renderable, and sending it would name a date nothing on file supports.
    const moved = { ...OPEN, dueOn: localDate('2096-07-31') }
    const verdict = decideObligationNotice({
      notice: NOTICE,
      occurrence: moved,
      asOf: localDate('2096-05-31'),
      contentAvailable: true,
    })
    expect(verdict).toMatchObject({ kind: 'skip', reason: 'invalidation_key_stale' })
    // And it is still refused when it is NOT yet due, so `defer` cannot mask it.
    expect(
      decideObligationNotice({
        notice: NOTICE,
        occurrence: moved,
        asOf: localDate('2096-01-01'),
        contentAvailable: true,
      }),
    ).toMatchObject({ kind: 'skip', reason: 'invalidation_key_stale' })
  })

  it('skips a completed occurrence with its own reason', () => {
    expect(
      decideObligationNotice({
        notice: NOTICE,
        occurrence: { ...OPEN, status: 'completed' },
        asOf: localDate('2096-05-31'),
        contentAvailable: true,
      }),
    ).toMatchObject({ kind: 'skip', reason: 'obligation_completed' })
  })

  it('stops ESCALATION on acknowledgement and deliberately does not stop the reminders', () => {
    const escalation = {
      ...NOTICE,
      step: 'escalation_7d',
      kind: 'escalation' as const,
      invalidationKey: obligationNoticeKeyFor({
        instanceId: INSTANCE,
        step: 'escalation_7d',
        dueOn: DUE,
      }),
      notifyOn: localDate('2096-07-07'),
    }
    const acknowledged = { ...OPEN, acknowledged: true }
    expect(
      decideObligationNotice({
        notice: escalation,
        occurrence: acknowledged,
        asOf: localDate('2096-07-07'),
        contentAvailable: true,
      }),
    ).toMatchObject({ kind: 'skip', reason: 'obligation_acknowledged' })
    // The asymmetry, asserted rather than assumed: an acknowledgement at 60 days must not silence the
    // notice at 7, and a rule that suppressed both on acknowledgement would pass the assertion above.
    expect(
      decideObligationNotice({
        notice: NOTICE,
        occurrence: acknowledged,
        asOf: localDate('2096-05-31'),
        contentAvailable: true,
      }),
    ).toMatchObject({ kind: 'send' })
  })

  it('records a late send rather than dropping it, and refuses one past the ladder ceiling', () => {
    const late = decideObligationNotice({
      notice: NOTICE,
      occurrence: OPEN,
      asOf: localDate('2096-06-10'),
      contentAvailable: true,
    })
    expect(late).toMatchObject({ kind: 'send', lateByDays: 10 })
    expect(late.kind === 'send' ? late.stalenessNote : null).toContain('10 day(s) after 2096-05-31')

    // Beyond the ceiling any declared rung can reach there is no rung that could have produced the
    // notice, so it is a row about a deadline nothing is still chasing.
    const ancient = decideObligationNotice({
      notice: NOTICE,
      occurrence: OPEN,
      asOf: addDaysToDate(DUE, OBLIGATION_NOTICE_LATE_TOLERANCE_DAYS + 1),
      contentAvailable: true,
    })
    expect(ancient).toMatchObject({ kind: 'skip', reason: 'notice_window_missed' })
  })

  it('distinguishes a role with no contact detail from a message it could not build', () => {
    // Two reasons and not one, because they send somebody to two different places: the first is a blank
    // in the contact details and the second is a template nobody approved.
    expect(
      decideObligationNotice({
        notice: NOTICE,
        occurrence: OPEN,
        asOf: localDate('2096-05-31'),
        contentAvailable: false,
        missing: 'recipient',
      }),
    ).toMatchObject({ kind: 'skip', reason: 'no_recipient_on_file' })
    expect(
      decideObligationNotice({
        notice: NOTICE,
        occurrence: OPEN,
        asOf: localDate('2096-05-31'),
        contentAvailable: false,
        missing: 'content',
      }),
    ).toMatchObject({ kind: 'skip', reason: 'content_unavailable' })
  })
})

describe('the open-compliance-questions classification', () => {
  const asOf = localDate('2096-06-30')
  const input = [
    // An unconfirmed duty with no date on file. The row the whole distinction is about.
    {
      key: 'a_unconfirmed_no_date',
      isUnverified: true,
      openQuestionId: 'Y1-licence',
      openDueDates: [],
    },
    // A confirmed duty with no date on file. A blank somebody has to fill in, not a breach.
    { key: 'b_confirmed_no_date', isUnverified: false, openDueDates: [] },
    // A confirmed duty, dated, and lapsed. The only real breach here.
    {
      key: 'c_confirmed_overdue',
      isUnverified: false,
      anchorOn: localDate('2096-01-31'),
      openDueDates: [localDate('2096-01-31'), localDate('2097-01-31')],
    },
    // Confirmed, dated, nothing passed. The calendar working.
    {
      key: 'd_confirmed_scheduled',
      isUnverified: false,
      anchorOn: localDate('2096-12-31'),
      openDueDates: [localDate('2096-12-31')],
    },
    // Unconfirmed AND lapsed: somebody entered a real date against a duty nobody has confirmed.
    {
      key: 'e_unconfirmed_overdue',
      isUnverified: true,
      openQuestionId: 'Y11-tax-agent',
      anchorOn: localDate('2096-03-31'),
      openDueDates: [localDate('2096-03-31')],
    },
  ]

  it('never reports a duty with no deadline on file as overdue', () => {
    // THE assertion. Conflating these two turns every unanswered question into a false alarm, and a
    // fortnight of false alarms is what trains somebody to ignore the real one.
    const rows = complianceQuestionRows(input, asOf)
    const byKey = new Map(rows.map((row) => [row.key, row]))
    expect(byKey.get('a_unconfirmed_no_date')?.deadlineState).toBe('no_deadline_on_file')
    expect(byKey.get('a_unconfirmed_no_date')?.dueOn).toBeUndefined()
    expect(byKey.get('b_confirmed_no_date')?.deadlineState).toBe('no_deadline_on_file')
    // The control: the row that IS overdue really is reported as overdue, so the assertion above is not
    // passing because nothing is ever overdue.
    expect(byKey.get('c_confirmed_overdue')?.deadlineState).toBe('overdue')
    expect(byKey.get('c_confirmed_overdue')?.dueOn).toBe('2096-01-31')
  })

  it('reports the two facts independently, so neither hides the other', () => {
    const rows = complianceQuestionRows(input, asOf)
    const sections = complianceQuestionSections(rows)
    // Every unverified duty is listed, which is what the acceptance criterion asks of this screen.
    expect(sections.unconfirmed.map((row) => row.key)).toEqual([
      'a_unconfirmed_no_date',
      'e_unconfirmed_overdue',
    ])
    // The no-deadline section is CONFIRMED duties only: an unconfirmed duty with no date is not a missing
    // deadline, because nobody has confirmed there is a deadline to miss.
    expect(sections.noDeadline.map((row) => row.key)).toEqual(['b_confirmed_no_date'])
    // And the overdue section is NOT filtered by the flag: a lapsed date is a lapsed date whatever the
    // state of the question behind it, and dropping it would hide a breach behind a question.
    expect(sections.overdue.map((row) => row.key)).toEqual([
      'c_confirmed_overdue',
      'e_unconfirmed_overdue',
    ])
    expect(complianceQuestionCounts(rows)).toEqual({ unconfirmed: 2, noDeadline: 1, overdue: 2 })
  })

  it('gives every obligation exactly one deadline state, and the healthy one no section', () => {
    const rows = complianceQuestionRows(input, asOf)
    expect(rows).toHaveLength(input.length)
    for (const row of rows) {
      expect(COMPLIANCE_DEADLINE_STATES).toContain(row.deadlineState)
    }
    // `no_deadline_on_file` and `overdue` cannot both hold: an overdue occurrence IS a deadline on file,
    // and a screen saying both would be contradicting itself.
    const sections = complianceQuestionSections(rows)
    const both = sections.noDeadline.filter((row) =>
      sections.overdue.some((other) => other.key === row.key),
    )
    expect(both).toEqual([])
    // The healthy obligation appears in no section at all: a dashboard of open questions that listed it
    // would list everything.
    for (const section of [sections.unconfirmed, sections.noDeadline, sections.overdue]) {
      expect(section.map((row) => row.key)).not.toContain('d_confirmed_scheduled')
    }
  })

  it('treats a due date of today as due and not late, in key order', () => {
    const rows = complianceQuestionRows(
      [
        {
          key: 'today',
          isUnverified: false,
          anchorOn: asOf,
          openDueDates: [asOf],
        },
      ],
      asOf,
    )
    // Strictly before, exactly as `obligationBreaches` decides it. The inclusive comparison would report
    // every renewal as a breach on its own due date, which is a red banner nobody agreed to.
    expect(rows[0]?.deadlineState).toBe('scheduled')
    expect(complianceQuestionCounts(rows).overdue).toBe(0)
    // The control: one day later it IS overdue.
    expect(
      complianceQuestionCounts(
        complianceQuestionRows(
          [{ key: 'today', isUnverified: false, anchorOn: asOf, openDueDates: [asOf] }],
          addDaysToDate(asOf, 1),
        ),
      ).overdue,
    ).toBe(1)
  })
})
