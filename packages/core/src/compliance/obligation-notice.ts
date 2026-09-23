import {
  AppError,
  MAX_OBLIGATION_NOTICE_OFFSET_DAYS,
  MAX_OBLIGATION_NOTICE_OFFSETS,
} from '@berelax/shared'
import { ROLES, type Role } from '../access/permissions.ts'
import { type LocalDate, localDate } from '../time.ts'

/**
 * The compliance calendar's notices: who is told, when, and what stops a notice that is no longer true.
 *
 * docs/04 §9 asks for "dated instances with **multi-step reminders, escalation if unacknowledged**, and
 * evidence attachment". M-VAT-10 built the dated instances. This module is the rule for the other two,
 * pure: an occurrence and two declared ladders in, a list of notices out, and a verdict on one notice at
 * the moment it would be sent.
 *
 * ## The mechanism is B-MSG-03's, deliberately, and not a second one
 *
 * A reminder about a deadline that has moved is the same bug as a reminder about an appointment that has
 * moved, and `packages/core/src/lifecycle/invalidation-key.ts` already solved it: the schedule is a ROW,
 * the queue carries the row's id and nothing else, every row carries a key derived from the state it is
 * about, and the worker re-derives that key under the row's lock and refuses any notice whose stored key
 * disagrees. Migration 0060 restates 0051's structure for the same reason — a one-way door out of
 * `pending`, a `settled_at` on every terminal state, a closed set of skip reasons.
 *
 * What is NOT reused is the key function itself, and that is a boundary rather than a duplication.
 * `invalidationKeyFor` takes an appointment id, a `reminder_NNNh` label 0051's CHECK accepts and a period
 * of two instants; a compliance notice is about an occurrence id, a `reminder_NNNd` label 0060's CHECK
 * accepts and a DUE DATE. Widening that function to take either shape would give one value two meanings,
 * and the comparison it exists to make is an equality test — the one kind of comparison that fails
 * silently when the two sides were built from different vocabularies.
 *
 * ## Dates, not instants
 *
 * An obligation falls due at the END of a day and `obligation_instance.due_on` is a `date` (0052). A
 * notice about it is therefore dated too: `notify_on` is a `date`, and whether it has arrived is decided
 * against {@link complianceAsOfDate} — the TRADING date while the business is trading — exactly as
 * "overdue" is. A notice timed to the minute would need a zone at every comparison and would buy nothing:
 * the pass that sends it runs once a day.
 *
 * ## Escalation names a role that exists, or it does not escalate
 *
 * An escalation nobody is accountable for is decoration. {@link escalationRoleFor} maps the declared
 * owner of a duty to the role above it in the F07 matrix, and it returns `null` rather than a fallback
 * for the two roles that have nobody above them and the two that could not act on a notice at all. A
 * notice addressed to `auditor` — a role whose definition is "read-only oversight, writes nothing" —
 * would be a message that cannot be answered, which is worse than no message: it reads, on a dashboard,
 * as a duty somebody is dealing with.
 *
 * Pure: dates, records and strings in, plans and verdicts out. No clock, no database, no framework.
 */

/** What a notice is for. Mirrors 0060's `obligation_notice_kind`. */
export const OBLIGATION_NOTICE_KINDS = ['reminder', 'escalation'] as const
export type ObligationNoticeKind = (typeof OBLIGATION_NOTICE_KINDS)[number]

/**
 * A notice step label, as 0060's CHECK constraint accepts it.
 *
 * `reminder_60d`, `escalation_7d`. Derived from the offset rather than drawn from an enum, for the reason
 * 0051's `reminder_24h` is: both ladders are SETTINGS, so a change to either must not be a migration —
 * and the label is part of the key, so moving a reminder from 60 days to 45 changes the key of every
 * pending notice rather than quietly re-pointing one.
 */
export const OBLIGATION_NOTICE_STEP_PATTERN = /^(reminder|escalation)_[1-9][0-9]{0,2}d$/

/** `reminder_60d`. The one place the label is spelled, so 0060's pattern has a single counterpart. */
export function obligationNoticeStep(kind: ObligationNoticeKind, offsetDays: number): string {
  if (
    !Number.isInteger(offsetDays) ||
    offsetDays < 1 ||
    offsetDays > MAX_OBLIGATION_NOTICE_OFFSET_DAYS
  ) {
    throw new AppError(
      'validation',
      `A compliance notice offset must be a whole number of days between 1 and ` +
        `${MAX_OBLIGATION_NOTICE_OFFSET_DAYS}, not ${JSON.stringify(offsetDays)}. 0060 refuses a step ` +
        'label outside that range, so an unbounded offset would put a renewal notice in the calendar ' +
        'before the previous renewal.',
      { details: { kind, offsetDays } },
    )
  }
  return `${kind}_${offsetDays}d`
}

/**
 * A stored ladder, validated.
 *
 * Refuses rather than coercing and rather than falling back to the default, exactly as
 * `reminderOffsetsFrom` does: `[]` is a legal ladder meaning "send nothing", so a reader that turned an
 * unreadable value into an empty list would make a corrupt setting indistinguishable from an owner who
 * had deliberately switched the notices off — and switching them off is a decision, not a fault.
 */
export function obligationNoticeOffsetsFrom(value: unknown, settingKey: string): readonly number[] {
  const refuse = (why: string): never => {
    throw new AppError(
      'validation',
      `${settingKey} is not a compliance notice ladder: ${why}. A stored value this rule cannot read is ` +
        'not defaulted away, because a corrupt value and a deliberate empty ladder would then be ' +
        'indistinguishable — and the empty ladder is how an owner turns these notices off.',
      { details: { value } },
    )
  }
  if (!Array.isArray(value)) return refuse('it is not an array')
  if (value.length > MAX_OBLIGATION_NOTICE_OFFSETS) {
    return refuse(
      `it declares ${value.length} rungs and the ceiling is ${MAX_OBLIGATION_NOTICE_OFFSETS}`,
    )
  }
  const offsets: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      return refuse(`${JSON.stringify(entry)} is not a whole number of days`)
    }
    if (entry < 1 || entry > MAX_OBLIGATION_NOTICE_OFFSET_DAYS) {
      return refuse(`${entry} is outside 1 to ${MAX_OBLIGATION_NOTICE_OFFSET_DAYS} days`)
    }
    if (offsets.includes(entry)) return refuse(`${entry} appears twice`)
    offsets.push(entry)
  }
  // Descending, so a reminder ladder reads in the order the owner receives it — 60 days before 30 before
  // 7 — whatever order it was typed in. The stored order is not trusted for that: [7, 60] is the same
  // ladder, and a plan whose row order depended on the typing would make two equivalent settings produce
  // two different tables.
  return Object.freeze([...offsets].sort((left, right) => right - left))
}

/**
 * The role an unacknowledged duty escalates to, or `null` when there is nobody above it.
 *
 * Read off `ROLE_DEFINITIONS` rather than invented. Every value here is a role in `ROLES`, and the map is
 * total over `ROLES` so a role added to the matrix fails to compile until somebody decides where its
 * escalations go — which is the alternative to a `?? 'owner'` that silently makes the proprietor the
 * answer to every question.
 *
 *   - `manager`, `accountant` → `owner`. Both hold `requiresTotp` and report to the proprietor; neither
 *     has a superior inside the business.
 *   - `receptionist`, `therapist`, `marketer` → `manager`. The floor manager holds `employee:write`,
 *     `rota:publish` and `settings:write`, which is what acting on a missed compliance duty needs.
 *   - `owner` → `null`. The proprietor is the top of the ladder: an escalation to oneself is not an
 *     escalation, and a second notice to the same person is the noise that trains somebody to ignore
 *     the first.
 *   - `auditor` → `null`. "Read-only oversight. Writes nothing." A notice it cannot act on would look,
 *     on a dashboard, like a duty somebody is dealing with.
 *   - `system` → `null`. "No interactive login exists for this role." An escalation to a background
 *     worker is decoration in its purest form.
 *
 * `null` is not "no escalation happens": it means the ladder has no rung ABOVE this role, and the caller
 * records that rather than addressing a notice to nobody. {@link obligationNoticePlanFor} plans no
 * escalation at all in that case, and the reason is in the plan's own field.
 */
export const OBLIGATION_ESCALATION_LADDER: Readonly<Record<Role, Role | null>> = Object.freeze({
  owner: null,
  manager: 'owner',
  accountant: 'owner',
  receptionist: 'manager',
  therapist: 'manager',
  marketer: 'manager',
  auditor: null,
  system: null,
})

export function escalationRoleFor(ownerRole: Role): Role | null {
  return OBLIGATION_ESCALATION_LADDER[ownerRole]
}

/** Why no escalation is planned for a duty. Reported, never silent. */
export const OBLIGATION_ESCALATION_ABSENCES = [
  /** The declared owner is at the top of the ladder, or holds a role that cannot act on a notice. */
  'no_role_above',
  /** The ladder is empty: the owner switched escalation off, which is a decision and is recorded. */
  'ladder_empty',
] as const
export type ObligationEscalationAbsence = (typeof OBLIGATION_ESCALATION_ABSENCES)[number]

/**
 * `date` plus `days`. Calendar arithmetic in UTC, so no zone is involved.
 *
 * `Date.UTC` rather than an hour-based addition, because a `date` is a calendar date: adding 86,400,000
 * milliseconds is the version that moves a date by two days across a DST boundary in a zone that has
 * one. Asia/Dubai has no DST, which is exactly the reasoning that makes such a bug survive review here
 * and then appear the first time this arithmetic is reused for a zone that does.
 */
export function addDaysToDate(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) {
    throw new AppError('validation', `Days must be an integer, received ${days}`)
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const moved = new Date(Date.UTC(year, month - 1, day + days))
  return localDate(moved.toISOString().slice(0, 10))
}

/** Whole days from `earlier` to `later`, negative when `later` is first. */
export function daysBetweenDates(later: LocalDate, earlier: LocalDate): number {
  const at = (value: LocalDate): number => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((at(later) - at(earlier)) / 86_400_000)
}

export interface ObligationNoticeKeyRequest {
  readonly instanceId: string
  /** `reminder_60d`. Validated: a key over a label 0060 refuses can never match a stored row. */
  readonly step: string
  /** The occurrence's due date, as it is NOW. */
  readonly dueOn: LocalDate
}

/**
 * The key. `reminder_60d:<instance id>:<due date>`.
 *
 * Deterministic in the strong sense: the same three inputs give the same string in any process, on any
 * machine, for ever. Not a hash, for `invalidationKeyFor`'s reason — a sha256 prefix would tell a person
 * reading a log nothing about which deadline fired.
 *
 * The occurrence's STATUS is deliberately not in the key. A completed occurrence is a different fact from
 * a moved deadline, and both have to be reportable: "we did not send that reminder because the renewal
 * was already filed" and "we did not send it because the date changed" are answers to the same question
 * and the counts have to be separable. Status is a skip reason; the key is about the date.
 */
export function obligationNoticeKeyFor(request: ObligationNoticeKeyRequest): string {
  const instanceId = request.instanceId.trim()
  if (instanceId === '') {
    throw new AppError(
      'validation',
      'An obligation notice key needs the occurrence it belongs to. A key with a blank id would be ' +
        'shared by every occurrence with the same due date, which is the opposite of what it is for.',
    )
  }
  if (!OBLIGATION_NOTICE_STEP_PATTERN.test(request.step)) {
    throw new AppError(
      'validation',
      `'${request.step}' is not a notice step (${String(OBLIGATION_NOTICE_STEP_PATTERN)}). 0060 refuses ` +
        'the label, so a key built over one could never match a stored notice and every send would be ' +
        'refused as stale — a silent failure wearing a safe answer.',
      { details: { step: request.step } },
    )
  }
  return `${request.step}:${instanceId}:${request.dueOn}`
}

/** One notice the plan says should exist. */
export interface PlannedObligationNotice {
  readonly step: string
  readonly kind: ObligationNoticeKind
  readonly offsetDays: number
  /** The F07 role the notice is addressed to. Never a person, never a blank. */
  readonly toRole: Role
  /** The date the notice becomes due. Compared against the trading date, never `current_date`. */
  readonly notifyOn: LocalDate
  readonly invalidationKey: string
}

export interface ObligationNoticePlanRequest {
  readonly instanceId: string
  readonly dueOn: LocalDate
  /** `obligation.owner_role`: who owes the duty, and who the reminders are addressed to. */
  readonly ownerRole: Role
  /** Days BEFORE the due date, from {@link obligationNoticeOffsetsFrom}. */
  readonly reminderOffsetsDays: readonly number[]
  /** Days AFTER the due date, if it is still unacknowledged. */
  readonly escalationOffsetsDays: readonly number[]
}

export interface ObligationNoticePlan {
  readonly notices: readonly PlannedObligationNotice[]
  /** Set when no escalation rung was planned, and why. Never silent. */
  readonly escalationAbsence: ObligationEscalationAbsence | null
  /** The role escalations were addressed to, or null when there is nobody above the owner. */
  readonly escalationRole: Role | null
}

/**
 * Every notice one occurrence should have, in the order they fall due.
 *
 * Reminders are addressed to the duty's DECLARED OWNER and escalations to the role above it. Neither is
 * a choice made here per call: the owner comes from the obligation row, and the rung above comes from
 * {@link OBLIGATION_ESCALATION_LADDER}. A `toRole` argument would be the seam through which a caller
 * addressed a licence renewal to whoever happened to be on shift.
 *
 * A notify date in the past is left in the plan rather than filtered out, for the reason
 * `reminderPlanFor` leaves a missed reminder in: an occurrence entered today for a deadline three weeks
 * away really has missed its 60-day notice, and the ROW is what makes the miss countable. It is answered
 * by {@link decideObligationNotice} — sent with a recorded note if the deadline has not passed,
 * `notice_window_missed` if it has.
 */
export function obligationNoticePlanFor(
  request: ObligationNoticePlanRequest,
): ObligationNoticePlan {
  if (!ROLES.includes(request.ownerRole)) {
    throw new AppError(
      'validation',
      `'${request.ownerRole}' is not a role in the F07 matrix, so a notice addressed to it names ` +
        'nobody accountable. An escalation nobody is accountable for is decoration.',
      { details: { ownerRole: request.ownerRole } },
    )
  }
  const escalationRole = escalationRoleFor(request.ownerRole)
  const notices: PlannedObligationNotice[] = []

  const push = (kind: ObligationNoticeKind, offsetDays: number, toRole: Role): void => {
    const step = obligationNoticeStep(kind, offsetDays)
    const notifyOn = addDaysToDate(request.dueOn, kind === 'reminder' ? -offsetDays : offsetDays)
    notices.push({
      step,
      kind,
      offsetDays,
      toRole,
      notifyOn,
      invalidationKey: obligationNoticeKeyFor({
        instanceId: request.instanceId,
        step,
        dueOn: request.dueOn,
      }),
    })
  }

  for (const offsetDays of request.reminderOffsetsDays) {
    push('reminder', offsetDays, request.ownerRole)
  }
  if (escalationRole !== null) {
    for (const offsetDays of request.escalationOffsetsDays) {
      push('escalation', offsetDays, escalationRole)
    }
  }

  const escalationAbsence: ObligationEscalationAbsence | null =
    escalationRole === null
      ? 'no_role_above'
      : request.escalationOffsetsDays.length === 0
        ? 'ladder_empty'
        : null

  return Object.freeze({
    // Sorted by the date the notice falls due, then by the label, so two runs over one occurrence
    // produce identical rows in identical order. The ladders are already sorted; this makes the
    // combination of the two a total order rather than reminders-then-escalations by construction.
    notices: Object.freeze(
      notices.sort((left, right) => {
        if (left.notifyOn !== right.notifyOn) return left.notifyOn < right.notifyOn ? -1 : 1
        return left.step < right.step ? -1 : 1
      }),
    ),
    escalationAbsence,
    escalationRole,
  })
}

/**
 * Every reason a notice is settled without a message.
 *
 * A CLOSED set, and 0060's CHECK holds the same list, because this column is what a report groups by:
 * "how many renewal notices did we not send last quarter, and why" is answerable over a vocabulary and
 * unanswerable over free text.
 */
export const OBLIGATION_NOTICE_SKIP_REASONS = [
  /** The stored key disagrees with the key the occurrence's CURRENT due date derives. THE case. */
  'invalidation_key_stale',
  /** The occurrence is completed: the renewal was filed, so there is nothing to chase. */
  'obligation_completed',
  /** An escalation for an occurrence somebody has acknowledged. This is what stops escalation. */
  'obligation_acknowledged',
  /** The deadline itself has passed by more than the ladder reaches. A late notice is not a notice. */
  'notice_window_missed',
  /**
   * There is no contact detail on file for the role this notice names.
   *
   * The honest shipped state, and it is a blank rather than a guess: no table in this build holds a
   * staff phone number or address, `compliance.notice_recipients` is an empty setting by default, and a
   * plausible UAE mobile typed here would be indistinguishable from a configured one (brief rule 15).
   * Recorded on the row so an unsent notice is visible and countable rather than absent.
   */
  'no_recipient_on_file',
  /** The message could not be built: no template approved in that locale, or a declared variable blank. */
  'content_unavailable',
  /**
   * The message was built and the choke point did not hand it to a vendor.
   *
   * A gate refusal, or F03's staging guard diverting it to the local outbox because `APP_ENV` is not
   * production and the recipient is not allowlisted. Neither writes a `message` row, so the notice has
   * nothing to point at — and the second is the ORDINARY case on every staging worker, which is why
   * recording it as `content_unavailable` would send somebody to look at the template.
   */
  'send_refused',
] as const
export type ObligationNoticeSkipReason = (typeof OBLIGATION_NOTICE_SKIP_REASONS)[number]

/** The four states 0060 declares. `pending` is the only one that is not terminal. */
export const OBLIGATION_NOTICE_STATES = ['pending', 'sent', 'skipped', 'superseded'] as const
export type ObligationNoticeState = (typeof OBLIGATION_NOTICE_STATES)[number]

/**
 * How many days past a deadline a notice is still worth sending.
 *
 * The longest escalation rung the ceiling allows, so the tolerance is derived from the ladder rather than
 * chosen: an escalation declared at 21 days is a notice the owner asked for 21 days late, and a tolerance
 * shorter than the ladder would make the pass refuse to send the very notice the setting declares. Beyond
 * the ceiling there is no rung that could have produced the notice, so it is a row about a deadline
 * nothing is still chasing.
 */
export const OBLIGATION_NOTICE_LATE_TOLERANCE_DAYS = MAX_OBLIGATION_NOTICE_OFFSET_DAYS

/** The notice, as much of it as the verdict needs. */
export interface ObligationNoticeFacts {
  readonly instanceId: string
  readonly step: string
  readonly kind: ObligationNoticeKind
  readonly invalidationKey: string
  readonly notifyOn: LocalDate
}

/** The occurrence, as it is NOW — read under the notice's row lock, never remembered from earlier. */
export interface ObligationNoticeOccurrenceFacts {
  readonly dueOn: LocalDate
  readonly status: 'open' | 'completed'
  /** Whether somebody has acknowledged the occurrence. What stops escalation. */
  readonly acknowledged: boolean
}

export interface ObligationNoticeVerdictRequest {
  readonly notice: ObligationNoticeFacts
  readonly occurrence: ObligationNoticeOccurrenceFacts
  /** The date the calendar is judged against: {@link complianceAsOfDate} of the clock. */
  readonly asOf: LocalDate
  /**
   * Whether the message can actually be built: a recipient for the role, a template, every variable.
   *
   * An argument rather than something decided here, because it is a fact about the runtime and not a
   * rule. It is false in the shipped worker for every role today, and the reason is recorded on
   * `no_recipient_on_file` above.
   */
  readonly contentAvailable: boolean
  /** Why the content is unavailable, so the skip reason distinguishes a blank contact from a template. */
  readonly missing?: 'recipient' | 'content'
}

export type ObligationNoticeVerdict =
  | {
      readonly kind: 'send'
      /** Set only when the notice is later than its own notify date. Recorded on the row. */
      readonly stalenessNote: string | null
      readonly lateByDays: number
    }
  | { readonly kind: 'skip'; readonly reason: ObligationNoticeSkipReason; readonly why: string }
  | { readonly kind: 'defer'; readonly why: string }

/**
 * What to do with one notice, today. The key is checked FIRST, and the order is the point.
 *
 * A notice carrying a stale key is about a deadline that has moved, and it is the damaging case: it
 * passes every other test in this function and it tells the owner a licence expires on a date nothing on
 * file says. Checking it first also means `defer` cannot mask it — a stale notice that is not yet due is
 * still refused rather than left to be refused later.
 *
 * Then, in this order: the occurrence must still be open; an ESCALATION must not be acknowledged; the
 * deadline must not be further past than the ladder reaches; the notice must actually be due, which is
 * the one outcome that writes nothing; and the message must be buildable.
 *
 * Acknowledgement stops ESCALATION and not reminders, and that asymmetry is the feature. A reminder is
 * "this falls due on the 14th" and stays true however many people have read it; an escalation is "nobody
 * has picked this up", which acknowledgement makes false. Suppressing reminders on acknowledgement would
 * let one click at 60 days silence the 7-day notice, which is the notice that matters.
 */
export function decideObligationNotice(
  request: ObligationNoticeVerdictRequest,
): ObligationNoticeVerdict {
  const { notice, occurrence, asOf } = request
  const expected = obligationNoticeKeyFor({
    instanceId: notice.instanceId,
    step: notice.step,
    dueOn: occurrence.dueOn,
  })
  if (notice.invalidationKey !== expected) {
    return {
      kind: 'skip',
      reason: 'invalidation_key_stale',
      why:
        `the notice was built for a different deadline: it carries '${notice.invalidationKey}' and the ` +
        `occurrence's current due date derives '${expected}'. Sending it would name a date nothing on ` +
        'file supports.',
    }
  }
  if (occurrence.status === 'completed') {
    return {
      kind: 'skip',
      reason: 'obligation_completed',
      why:
        'the occurrence is completed, so the renewal was filed and its evidence is on the record. ' +
        'There is nothing to chase.',
    }
  }
  if (notice.kind === 'escalation' && occurrence.acknowledged) {
    return {
      kind: 'skip',
      reason: 'obligation_acknowledged',
      why:
        'somebody has acknowledged the occurrence, so the escalation has nothing to report: it exists ' +
        'to say that nobody has picked this up. The reminders are unaffected — an acknowledgement at ' +
        '60 days must not silence the notice at 7.',
    }
  }
  const lateByDays = daysBetweenDates(asOf, notice.notifyOn)
  if (daysBetweenDates(asOf, occurrence.dueOn) > OBLIGATION_NOTICE_LATE_TOLERANCE_DAYS) {
    return {
      kind: 'skip',
      reason: 'notice_window_missed',
      why:
        `the deadline passed ${daysBetweenDates(asOf, occurrence.dueOn)} days ago, which is beyond the ` +
        `${OBLIGATION_NOTICE_LATE_TOLERANCE_DAYS}-day ceiling any declared rung can reach. A notice ` +
        'this late is a row about a deadline nothing is still chasing, and it is recorded rather than ' +
        'sent — the overdue occurrence itself is what a reader acts on.',
    }
  }
  if (lateByDays < 0) {
    return {
      kind: 'defer',
      why:
        `the notice is due on ${notice.notifyOn} and the calendar is at ${asOf}. It stays pending, ` +
        'which is the record of that.',
    }
  }
  if (!request.contentAvailable) {
    return {
      kind: 'skip',
      reason: request.missing === 'recipient' ? 'no_recipient_on_file' : 'content_unavailable',
      why:
        request.missing === 'recipient'
          ? `no contact detail is on file for the ${notice.kind === 'escalation' ? 'escalation' : 'owning'} ` +
            'role, so there is nobody to send this to. Recorded rather than guessed at: a plausible ' +
            'number is indistinguishable from a configured one.'
          : 'the message could not be built — no approved template in that locale, or a declared ' +
            'variable is blank. Recorded rather than sent half-rendered: a body with a blank in it ' +
            'sends successfully and is reported as delivered.',
    }
  }
  const late = lateByDays > 0
  return {
    kind: 'send',
    lateByDays,
    stalenessNote: late
      ? `sent ${lateByDays} day(s) after ${notice.notifyOn}, the date it was due. The notice was still ` +
        "about the occurrence's current deadline, so it was sent rather than dropped — a dropped " +
        'notice is indistinguishable from one that was never scheduled.'
      : null,
  }
}

/**
 * One unverified obligation, as the open-compliance-questions dashboard reads it.
 *
 * `openQuestionId` and `unverifiedNote` are not optional: 0052's
 * `obligation_unverified_names_a_question` refuses an unverified row without both, because an unresolved
 * legal question with no id and no note is invisible on the dashboard that exists to show it.
 */
export interface UnverifiedObligation {
  readonly key: string
  readonly title: string
  readonly obligationClass: string
  readonly ownerRole: Role
  readonly openQuestionId: string
  readonly unverifiedNote: string
  readonly sourceReference: string
  readonly authority: string | null
  /** Absent when no due date has been read off the document. This is NOT the same as overdue. */
  readonly anchorOn?: LocalDate
}

/**
 * Where an obligation's DEADLINE stands. Exactly one of three, by construction.
 *
 * This is the distinction the unit is judged on, and it is expressed as an exclusive state rather than as
 * three filters because three filters over one list is three filters that overlap the first time somebody
 * edits one. `overdue` and `no_deadline_on_file` cannot both hold: an overdue occurrence IS a deadline on
 * file, so the second is reachable only when there is no dated occurrence at all.
 *
 * "This obligation has no confirmed deadline" and "this obligation is overdue" are different facts with
 * different remedies — the first is answered by somebody opening a licence and typing a date, the second
 * by a renewal — and a dashboard that showed them as one row would turn every blank into a false alarm.
 * A fortnight of false alarms is what trains whoever reads the screen to ignore the real one.
 */
export const COMPLIANCE_DEADLINE_STATES = [
  /** An open dated occurrence whose due date is before the trading date. A breach. */
  'overdue',
  /** No due date has been read off the document, so the calendar generates nothing. A blank. */
  'no_deadline_on_file',
  /** Dated, and nothing has passed. The calendar working. */
  'scheduled',
] as const
export type ComplianceDeadlineState = (typeof COMPLIANCE_DEADLINE_STATES)[number]

/**
 * One obligation's standing on the dashboard: an independent flag and an exclusive deadline state.
 *
 * Two facts and not one enumeration, because they are INDEPENDENT and the temptation is to collapse them.
 * `isUnconfirmedDuty` is `obligation.is_unverified`: this build's reading of a secondary source, answered
 * by a lawyer. `deadlineState` is about dates, answered by a renewal or by reading a document. An
 * obligation can be both — an unconfirmed duty for which somebody has nevertheless entered a real renewal
 * date that has since lapsed is a real breach AND an open legal question — and an enumeration would have
 * to drop one of the two.
 *
 * Which one it would drop is the defect. Ordering "unconfirmed first" hides a genuine overdue licence
 * behind an unanswered question; ordering "overdue first" removes the question from the screen that
 * exists to hold it. Reporting both is the only answer that loses nothing.
 */
export interface ComplianceQuestionRow {
  readonly key: string
  /** `obligation.is_unverified`. Independent of {@link deadlineState}. */
  readonly isUnconfirmedDuty: boolean
  readonly deadlineState: ComplianceDeadlineState
  /** Present when `isUnconfirmedDuty`: the id in docs/OPEN-QUESTIONS.md that would settle it. */
  readonly openQuestionId?: string
  /** Present when `deadlineState` is `overdue`: the earliest date that passed. */
  readonly dueOn?: LocalDate
}

export interface ComplianceQuestionInput {
  readonly key: string
  readonly isUnverified: boolean
  readonly openQuestionId?: string
  /** The first due date on file, if any. */
  readonly anchorOn?: LocalDate
  /** The open occurrences of this obligation, with their due dates. */
  readonly openDueDates: readonly LocalDate[]
}

/**
 * Classifies every obligation, in key order. One row each, whatever its standing.
 *
 * A row for every obligation rather than only for the ones with something wrong, because the caller has
 * to be able to count BOTH totals — how many duties are unconfirmed, and how many deadlines have passed —
 * and a list that had already dropped the healthy ones would make the denominator unknowable.
 * {@link complianceQuestionSections} is what turns the rows into the three lists a screen shows.
 *
 * `overdue` is decided strictly: `dueOn < asOf`, exactly as `obligationBreaches` decides it. An obligation
 * due today is due today and not late today, and the inclusive comparison would report every renewal as a
 * breach on its own due date.
 */
export function complianceQuestionRows(
  obligations: readonly ComplianceQuestionInput[],
  asOf: LocalDate,
): readonly ComplianceQuestionRow[] {
  const rows: ComplianceQuestionRow[] = []
  for (const obligation of obligations) {
    const overdue = [...obligation.openDueDates].filter((dueOn) => dueOn < asOf).sort()
    const earliest = overdue[0]
    // The exclusivity, in one expression so the three cannot drift apart. `no_deadline_on_file` is
    // reachable only when there is no dated occurrence AND no anchor: an occurrence exists because a date
    // was entered, so a dashboard reporting "no deadline on file" beside one would be contradicting
    // itself.
    const deadlineState: ComplianceDeadlineState =
      earliest !== undefined
        ? 'overdue'
        : obligation.anchorOn === undefined && obligation.openDueDates.length === 0
          ? 'no_deadline_on_file'
          : 'scheduled'
    rows.push({
      key: obligation.key,
      isUnconfirmedDuty: obligation.isUnverified,
      deadlineState,
      ...(obligation.isUnverified && obligation.openQuestionId !== undefined
        ? { openQuestionId: obligation.openQuestionId }
        : {}),
      ...(earliest === undefined ? {} : { dueOn: earliest }),
    })
  }
  return Object.freeze(rows.sort((left, right) => (left.key < right.key ? -1 : 1)))
}

/** The three lists a dashboard shows, and the one rule that decides which list a row appears in. */
export interface ComplianceQuestionSections {
  /** Every unconfirmed duty. This list IS "the obligations flagged unverified", and nothing else. */
  readonly unconfirmed: readonly ComplianceQuestionRow[]
  /**
   * CONFIRMED duties with no deadline on file.
   *
   * Confirmed, deliberately: an unconfirmed duty with no date is not a missing deadline, because nobody
   * has confirmed there is a deadline to miss. Listing it here would say "somebody should type a date in"
   * about a duty that may not exist, and it would count the same blank twice on one screen.
   */
  readonly noDeadline: readonly ComplianceQuestionRow[]
  /**
   * Every overdue obligation, confirmed or not.
   *
   * NOT filtered by the unverified flag, and that is the other half of the same decision. A dated
   * occurrence exists because somebody entered a real renewal date; if it has lapsed, the licence has
   * lapsed whatever the state of the legal question behind it. Dropping it because the duty is
   * unconfirmed would hide a real breach behind an unanswered question.
   */
  readonly overdue: readonly ComplianceQuestionRow[]
}

export function complianceQuestionSections(
  rows: readonly ComplianceQuestionRow[],
): ComplianceQuestionSections {
  return Object.freeze({
    unconfirmed: Object.freeze(rows.filter((row) => row.isUnconfirmedDuty)),
    noDeadline: Object.freeze(
      rows.filter((row) => !row.isUnconfirmedDuty && row.deadlineState === 'no_deadline_on_file'),
    ),
    overdue: Object.freeze(rows.filter((row) => row.deadlineState === 'overdue')),
  })
}

/** How many rows are in each section. The counts the acceptance criterion names. */
export function complianceQuestionCounts(rows: readonly ComplianceQuestionRow[]): {
  readonly unconfirmed: number
  readonly noDeadline: number
  readonly overdue: number
} {
  const sections = complianceQuestionSections(rows)
  return Object.freeze({
    unconfirmed: sections.unconfirmed.length,
    noDeadline: sections.noDeadline.length,
    overdue: sections.overdue.length,
  })
}
