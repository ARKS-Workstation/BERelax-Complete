import { AppError } from '@berelax/shared'
import type { Role } from '../access/permissions.ts'
import { type HoursForDate, resolveTradingDate } from '../business-day/resolve.ts'
import { type Instant, type LocalDate, localDate, type TimeZone } from '../time.ts'

/**
 * The compliance calendar: what is owed, when it falls due, and what stops working when it is overdue.
 *
 * docs/04 §9 is the specification. *"Obligation definitions (statutory, recurring or event-driven)
 * generate dated instances with multi-step reminders, escalation if unacknowledged, and evidence
 * attachment. Some obligations are blocking: an overdue blocking obligation changes system behaviour —
 * a therapist leaves bookable availability, publishing is blocked, the owner sees a banner. This is the
 * cheapest high-value feature in the whole plan."*
 *
 * This module is the **rule**, pure: definitions and dated occurrences in, due dates and named
 * consequences out. The rows live in PostgreSQL (`0052_obligation.sql`) and the writes are
 * `packages/db/src/services/obligation.ts`. That division is `pnpm boundaries`' — `packages/db` may
 * never import `packages/core` — and it is the same one `business-day/horizon.ts` has with the business
 * day generator: the arithmetic is here, the INSERT is there, and neither is a second answer to the
 * other's question.
 *
 * ## Determinism is the property the generator is judged on
 *
 * {@link obligationInstancePlan} is a function of its arguments and nothing else: no clock, no
 * iteration order over a Map, no `Date.now()` anywhere beneath it. Two calls with the same arguments
 * return the same list in the same order, which is what makes "two runs under the frozen clock produce
 * identical rows" a property of this module rather than a hope about the database. The database's half
 * is `obligation_instance_one_per_due_date`, UNIQUE NULLS NOT DISTINCT, so the second run inserts
 * nothing and the rows — ids and creation instants included — are the first run's.
 *
 * ## Overdue is decided against the business day, never the calendar date
 *
 * Trading runs 11:00–02:00, so at 01:30 the business is still working the previous trading date
 * (`resolveTradingDate`, 0011). An obligation due that date is therefore **not yet overdue** at 01:30,
 * and a blocking one must not take a therapist out of a shift they are halfway through. The calendar
 * comparison is the version that does, and it takes the last two hours of every trading day with it.
 * {@link complianceAsOfDate} is the one place that decision is made; every other function here takes a
 * date and the zone is always an argument.
 *
 * ## A blocking flag with no writer
 *
 * There is no `setBlocking`, no `disableBlocking` and no argument anywhere in this module that relaxes
 * a blocking consequence. `obligation.is_blocking` is GENERATED in the database from
 * `blocking_effect`, and `refuse_obligation_shape_change()` refuses an UPDATE to anything but the due
 * date — so the only settable thing about an obligation is **when it is next due**. That is deliberate
 * and it is the unit's value: a compliance control with an off switch is one that is switched off at
 * 23:00 to take a booking, and the next person to learn about it is an inspector.
 *
 * Pure: dates, records and instants in, verdicts out. No clock, no database, no framework.
 */

/** What kind of duty an obligation is. Mirrors the `obligation_class` enum of 0052. */
export const OBLIGATION_CLASSES = ['licence', 'credential', 'hygiene', 'tax', 'labour'] as const
export type ObligationClass = (typeof OBLIGATION_CLASSES)[number]

/**
 * How the next occurrence is dated. Mirrors `obligation_cadence`.
 *
 * `event_driven` is a cadence that generates **nothing**: the due date arrives with the event — a
 * renewal notice, a document expiry — and stepping a guessed interval would put a date in the calendar
 * that nothing on file supports. It is a value rather than an absence because every obligation must
 * declare how it is dated, and a NULL cadence would read as "nobody said".
 */
export const OBLIGATION_CADENCES = ['monthly', 'quarterly', 'annual', 'event_driven'] as const
export type ObligationCadence = (typeof OBLIGATION_CADENCES)[number]

/** Months between occurrences, or `null` for a cadence that is not an interval. */
export const OBLIGATION_CADENCE_MONTHS: Readonly<Record<ObligationCadence, number | null>> =
  Object.freeze({
    monthly: 1,
    quarterly: 3,
    annual: 12,
    event_driven: null,
  })

/**
 * What changes when the obligation is overdue. Mirrors `obligation_blocking_effect`.
 *
 * Two consequences and not one boolean, because they are enforced in two different code paths — the
 * availability read and the publication guard — and "blocking" alone cannot say which.
 */
export const OBLIGATION_BLOCKING_EFFECTS = [
  'none',
  'therapist_unbookable',
  'publishing_blocked',
] as const
export type ObligationBlockingEffect = (typeof OBLIGATION_BLOCKING_EFFECTS)[number]

/** Whether one occurrence covers the business or one covers each therapist. */
export const OBLIGATION_SUBJECT_SCOPES = ['business', 'therapist'] as const
export type ObligationSubjectScope = (typeof OBLIGATION_SUBJECT_SCOPES)[number]

/**
 * An obligation definition, as this module reads it.
 *
 * Field for field the shape `readObligationDefinitions` returns from `@berelax/db`, which is asserted
 * structurally assignable in `packages/fixtures/src/obligation-calendar.itest.ts` — the same
 * arrangement `TherapistPoolRead` has with `TherapistPool`, and for the same reason: the two packages
 * may not import each other, so the agreement is a `satisfies` in the one package that may import both.
 */
export interface ObligationDefinition {
  readonly key: string
  readonly title: string
  readonly obligationClass: ObligationClass
  readonly cadence: ObligationCadence
  readonly subjectScope: ObligationSubjectScope
  /** The F07 role that owes it, and the only role (besides `owner`) that may complete an occurrence. */
  readonly ownerRole: Role
  readonly blockingEffect: ObligationBlockingEffect
  readonly evidenceRequired: boolean
  /** The duty is our reading of a secondary source. docs/04's `[UNVERIFIED]` items. */
  readonly isUnverified: boolean
  /** Absent until somebody reads the first due date off the document. Absence generates nothing. */
  readonly anchorOn?: LocalDate
  /** Required when `isUnverified`; the id in docs/OPEN-QUESTIONS.md. */
  readonly openQuestionId?: string
}

/**
 * Does this obligation block when overdue?
 *
 * A function of the consequence rather than a stored flag, mirroring the GENERATED column. There is
 * deliberately no setter and no override argument: see the module header.
 */
export function isBlockingObligation(
  definition: Pick<ObligationDefinition, 'blockingEffect'>,
): boolean {
  return definition.blockingEffect !== 'none'
}

/**
 * `date` plus `months`, with the day clamped to the end of the target month.
 *
 * Clamping rather than overflowing, because an obligation anchored on the 31st falls due on the 28th of
 * February and not on the 3rd of March: the roll-over version silently walks the due date forward a day
 * or three every year, and the drift is invisible until a renewal is a week late. `Date.UTC` arithmetic,
 * so no timezone is involved — these are calendar dates, and a zone would only give the day a chance to
 * move.
 */
function addMonths(date: LocalDate, months: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const zeroBased = month - 1 + months
  const targetYear = year + Math.floor(zeroBased / 12)
  const targetMonth = ((zeroBased % 12) + 12) % 12
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const clamped = Math.min(day, lastDay)
  const value = new Date(Date.UTC(targetYear, targetMonth, clamped))
  return localDate(value.toISOString().slice(0, 10))
}

/** `date` plus `months`, exposed for the callers that date a horizon. Clamps; see {@link addMonths}. */
export function addMonthsToDate(date: LocalDate, months: number): LocalDate {
  if (!Number.isInteger(months)) {
    throw new AppError('validation', `Months must be an integer, received ${months}`)
  }
  return addMonths(date, months)
}

export interface ObligationDueDatesInput {
  readonly cadence: ObligationCadence
  /** The first due date ever. Absent means the document has not been read; nothing is generated. */
  readonly anchorOn?: LocalDate
  /** The first date of the horizon, inclusive. */
  readonly from: LocalDate
  /** How many months forward, exclusive of the end. 12 for the calendar the acceptance asks for. */
  readonly months: number
}

/**
 * Every date this obligation falls due inside the horizon, ascending.
 *
 * Stepped from the **anchor** rather than from `from`, and that is the load-bearing detail: stepping
 * from the horizon's start would move every due date whenever the generator happened to run, so the
 * same obligation would fall due on the 3rd this month and the 17th next month and the calendar would
 * be a function of the job schedule. Stepping from the anchor makes the sequence a property of the
 * obligation, so a run in the middle of a period produces exactly the occurrences that period already
 * had.
 *
 * An anchor in the past is walked forward with arithmetic rather than with a loop from the anchor,
 * which matters for an obligation anchored years ago: the number of steps is computed, so a monthly
 * obligation anchored in 2019 costs the same as one anchored last week.
 *
 * Returns an empty list for `event_driven` (no interval to step) and for a missing anchor (nothing on
 * file to step from). Both are honest empties and neither is an error: an obligation whose first due
 * date nobody has entered yet is the normal state of this table on the day it is created.
 */
export function obligationDueDates(input: ObligationDueDatesInput): readonly LocalDate[] {
  const { cadence, anchorOn, from, months } = input
  if (!Number.isInteger(months) || months <= 0) {
    throw new AppError(
      'validation',
      `An obligation horizon must be a positive whole number of months, received ${months}`,
    )
  }
  const step = OBLIGATION_CADENCE_MONTHS[cadence]
  if (step === null || anchorOn === undefined) return Object.freeze([])

  const until = addMonths(from, months)
  // The whole number of steps from the anchor to the horizon's start, floored at zero: an anchor in the
  // future starts at itself.
  const monthsFromAnchor =
    (Number(from.slice(0, 4)) - Number(anchorOn.slice(0, 4))) * 12 +
    (Number(from.slice(5, 7)) - Number(anchorOn.slice(5, 7)))
  const skipped = Math.max(0, Math.floor(monthsFromAnchor / step))

  const dates: LocalDate[] = []
  let index = skipped
  let due = addMonths(anchorOn, index * step)
  // The computed start can land one step early (the day of the month makes the difference), so the
  // loop advances past anything before the horizon rather than trusting the arithmetic alone.
  while (due < from) {
    index += 1
    due = addMonths(anchorOn, index * step)
  }
  while (due < until) {
    dates.push(due)
    index += 1
    due = addMonths(anchorOn, index * step)
  }
  return Object.freeze(dates)
}

/** One occurrence the generator intends to write. */
export interface PlannedObligationInstance {
  readonly obligationKey: string
  readonly dueOn: LocalDate
  /** The therapist this occurrence is about. Absent for a business-scoped obligation. */
  readonly subjectEmployeeId?: string
}

export interface ObligationPlanInput {
  readonly definitions: readonly ObligationDefinition[]
  /** The first date of the horizon, inclusive. Usually {@link complianceAsOfDate} of the clock. */
  readonly from: LocalDate
  /** 12 for "the next 12 months". */
  readonly months: number
  /**
   * The therapists a per-therapist obligation generates an occurrence for, each.
   *
   * An argument rather than a read, because this module performs no I/O — and because it is what makes
   * the plan deterministic: the caller decides the set and its order, and the plan is sorted below so
   * two callers with the same set in different orders still produce identical rows.
   */
  readonly therapistIds?: readonly string[]
}

/**
 * Every occurrence to write for the horizon, in a total order.
 *
 * Sorted by `(key, subject, dueOn)` and not by iteration order, because "identical rows" is the
 * property this function exists to have: a plan whose order came from the caller's array would produce
 * the same SET of rows in a different sequence, and a test comparing two runs row by row would then
 * fail for a reason that has nothing to do with the calendar. The database's uniqueness constraint
 * makes a re-run a no-op; this makes the two runs comparable in the first place.
 *
 * A per-therapist obligation with no therapists produces nothing rather than a business-wide
 * occurrence. A business-wide row for a per-therapist duty would be an occurrence nobody owes and — for
 * a blocking one — an occurrence whose overdue state names no therapist to exclude.
 */
export function obligationInstancePlan(
  input: ObligationPlanInput,
): readonly PlannedObligationInstance[] {
  const therapistIds = input.therapistIds ?? []
  const planned: PlannedObligationInstance[] = []

  for (const definition of input.definitions) {
    const dates = obligationDueDates({
      cadence: definition.cadence,
      ...(definition.anchorOn === undefined ? {} : { anchorOn: definition.anchorOn }),
      from: input.from,
      months: input.months,
    })
    for (const dueOn of dates) {
      if (definition.subjectScope === 'business') {
        planned.push({ obligationKey: definition.key, dueOn })
        continue
      }
      for (const therapistId of therapistIds) {
        planned.push({ obligationKey: definition.key, dueOn, subjectEmployeeId: therapistId })
      }
    }
  }

  return Object.freeze(
    planned.sort((left, right) => {
      if (left.obligationKey !== right.obligationKey) {
        return left.obligationKey < right.obligationKey ? -1 : 1
      }
      const leftSubject = left.subjectEmployeeId ?? ''
      const rightSubject = right.subjectEmployeeId ?? ''
      if (leftSubject !== rightSubject) return leftSubject < rightSubject ? -1 : 1
      if (left.dueOn === right.dueOn) return 0
      return left.dueOn < right.dueOn ? -1 : 1
    }),
  )
}

/**
 * The date dated obligations are judged against, for an instant.
 *
 * The **trading date** while the business is trading, so an obligation due today is not overdue at
 * 01:30 tonight — the business is still working today's trading date and a blocking obligation must not
 * take a therapist off the floor mid-shift. The **calendar date** in the daytime gap, because the
 * previous trading date has ended by then and an obligation due on it really is overdue.
 *
 * `resolveTradingDate`'s own header says the calendar date it returns is "not a trading date, and never
 * to be used as one". That holds here: this function does not return a trading date either. It returns
 * the date the compliance calendar compares a due date against, which is a different question, and the
 * two answers differ for exactly the two hours after midnight that make `business_day` first class.
 */
export function complianceAsOfDate(
  now: Instant,
  hoursFor: HoursForDate,
  zone?: TimeZone,
): LocalDate {
  const resolved =
    zone === undefined ? resolveTradingDate(now, hoursFor) : resolveTradingDate(now, hoursFor, zone)
  return resolved.kind === 'trading' ? resolved.date : resolved.calendarDate
}

/** One dated occurrence, as the blocking rules read it. The shape `@berelax/db` returns. */
export interface ObligationInstanceFacts {
  readonly instanceId: string
  readonly obligationKey: string
  readonly title: string
  readonly obligationClass: ObligationClass
  readonly blockingEffect: ObligationBlockingEffect
  readonly dueOn: LocalDate
  readonly status: 'open' | 'completed'
  /** The therapist the occurrence is about, for a per-therapist obligation. */
  readonly subjectEmployeeId?: string
}

/** An overdue blocking occurrence, named. Ids and keys, never a person's name (ADR 0020). */
export interface ObligationBreach {
  readonly instanceId: string
  readonly obligationKey: string
  readonly title: string
  readonly dueOn: LocalDate
  readonly blockingEffect: Exclude<ObligationBlockingEffect, 'none'>
  readonly subjectEmployeeId?: string
}

/**
 * The overdue blocking occurrences, in a stable order.
 *
 * `status === 'open'` and `dueOn < asOf`. Strictly less than, because an obligation due today is due
 * today and not late today — the inclusive comparison makes every obligation blocking on its own due
 * date, which is a day of blocked bookings nobody agreed to.
 *
 * A non-blocking obligation is never a breach here however overdue it is. That is not leniency: the VAT
 * return being late is a serious matter and it does not make a therapist unbookable, and a function
 * that conflated the two would take the floor down for a filing deadline.
 */
export function obligationBreaches(
  instances: readonly ObligationInstanceFacts[],
  asOf: LocalDate,
): readonly ObligationBreach[] {
  const breaches: ObligationBreach[] = []
  for (const instance of instances) {
    if (instance.status !== 'open') continue
    if (instance.blockingEffect === 'none') continue
    if (!(instance.dueOn < asOf)) continue
    breaches.push({
      instanceId: instance.instanceId,
      obligationKey: instance.obligationKey,
      title: instance.title,
      dueOn: instance.dueOn,
      blockingEffect: instance.blockingEffect,
      ...(instance.subjectEmployeeId === undefined
        ? {}
        : { subjectEmployeeId: instance.subjectEmployeeId }),
    })
  }
  return Object.freeze(
    breaches.sort((left, right) => {
      if (left.dueOn !== right.dueOn) return left.dueOn < right.dueOn ? -1 : 1
      return left.obligationKey < right.obligationKey ? -1 : 1
    }),
  )
}

/**
 * The therapists an overdue blocking credential obligation takes out of availability.
 *
 * The pure statement of what `overdueBlockingObligationExclusion` computes in SQL inside the
 * availability read. Two implementations of one rule, asserted to agree in `packages/fixtures`, for the
 * reason `resolveTherapistPool` and `therapistPoolCtes` are two: the availability read has to answer in
 * one round trip, and this has to be checkable without a database.
 *
 * A breach with no subject is skipped rather than applied to everybody. `therapist_unbookable` is
 * constrained to a per-therapist obligation in the schema, so a subjectless one cannot exist — and if
 * it did, excluding every therapist on the strength of it would close the salon on a data defect.
 */
export function therapistsBlockedByObligations(
  instances: readonly ObligationInstanceFacts[],
  asOf: LocalDate,
): readonly string[] {
  const blocked = new Set<string>()
  for (const breach of obligationBreaches(instances, asOf)) {
    if (breach.blockingEffect !== 'therapist_unbookable') continue
    if (breach.subjectEmployeeId === undefined) continue
    blocked.add(breach.subjectEmployeeId)
  }
  return Object.freeze([...blocked].sort())
}

/** The overdue blocking obligations that stop anything being published. */
export function publishingBlockers(
  instances: readonly ObligationInstanceFacts[],
  asOf: LocalDate,
): readonly ObligationBreach[] {
  return obligationBreaches(instances, asOf).filter(
    (breach) => breach.blockingEffect === 'publishing_blocked',
  )
}

/**
 * The publish path's refusal, naming the obligation.
 *
 * Named after the rule and not after the field, the way `JournalPostRefused` and `CmsCopyRefused` are:
 * the admin has to be told *which obligation* is overdue, because the fix is a renewal and not an edit
 * to the copy. The keys are carried in `details` as well as in the message so the CMS hook can turn it
 * into a 409 without parsing prose.
 */
export class PublishingBlocked extends AppError {
  readonly breaches: readonly ObligationBreach[]
  constructor(breaches: readonly ObligationBreach[]) {
    super(
      'forbidden',
      `PublishingBlocked: ${breaches
        .map((breach) => `${breach.obligationKey} was due ${breach.dueOn} and is not completed`)
        .join(
          '; ',
        )}. Publishing is blocked while a blocking licence obligation is overdue (docs/04 §9).`,
      {
        userFacing: true,
        details: {
          code: 'publishing_blocked',
          obligations: breaches.map((breach) => breach.obligationKey),
          instanceIds: breaches.map((breach) => breach.instanceId),
          dueOn: breaches.map((breach) => breach.dueOn),
        },
      },
    )
    this.name = 'PublishingBlocked'
    this.breaches = Object.freeze([...breaches])
  }
}

/**
 * Throws {@link PublishingBlocked} when a blocking licence obligation is overdue.
 *
 * Called from the CMS publish guard with rows read by `readObligationInstances`. It takes the
 * occurrences rather than reading them, because this package performs no I/O — and because the hook has
 * to read the database anyway to get the disclaimer and the compliance policy, so the read is one
 * caller's and the rule is one module's.
 */
export function assertPublishingNotBlocked(
  instances: readonly ObligationInstanceFacts[],
  asOf: LocalDate,
): void {
  const breaches = publishingBlockers(instances, asOf)
  if (breaches.length > 0) throw new PublishingBlocked(breaches)
}

/** The obligations an overdue blocking one carries, or null — so a caller branches without a match. */
export function publishingBlockedObligationsOf(error: unknown): readonly string[] | null {
  return error instanceof PublishingBlocked
    ? error.breaches.map((breach) => breach.obligationKey)
    : null
}

/** Why a completion was refused. Named, because the two refusals have two different remedies. */
export const OBLIGATION_COMPLETION_REFUSALS = ['RoleNotPermitted', 'EvidenceRequired'] as const
export type ObligationCompletionRefusal = (typeof OBLIGATION_COMPLETION_REFUSALS)[number]

/**
 * Why this actor may not complete this occurrence, or `null`.
 *
 * The pure statement of what `assert_obligation_completion_is_permitted()` enforces in 0052, in the
 * same order: the role first, then the evidence. The order is reported and therefore has to be one
 * order — an actor who is both the wrong role and empty-handed must be told the same thing by both
 * implementations, or the two are answering different questions.
 *
 * `owner` is permitted alongside the declared role because `ROLE_DEFINITIONS` gives the proprietor every
 * permission by definition. A rule that locked them out of their own compliance calendar would be
 * worked around by reassigning the obligation, which loses the declared owner as well as the refusal.
 */
export function obligationCompletionRefusal(args: {
  readonly definition: Pick<ObligationDefinition, 'ownerRole' | 'evidenceRequired'>
  readonly role: Role
  readonly hasEvidence: boolean
}): ObligationCompletionRefusal | null {
  if (args.role !== args.definition.ownerRole && args.role !== 'owner') return 'RoleNotPermitted'
  if (args.definition.evidenceRequired && !args.hasEvidence) return 'EvidenceRequired'
  return null
}

/** Throws unless this actor may complete this occurrence. The refusal is named in `details.code`. */
export function assertObligationCompletable(args: {
  readonly definition: Pick<ObligationDefinition, 'key' | 'ownerRole' | 'evidenceRequired'>
  readonly role: Role
  readonly hasEvidence: boolean
}): void {
  const refusal = obligationCompletionRefusal(args)
  if (refusal === null) return
  const why =
    refusal === 'RoleNotPermitted'
      ? `is owed by the ${args.definition.ownerRole} and cannot be completed as ${args.role}`
      : 'requires an attachment and none is filed against this occurrence'
  throw new AppError('forbidden', `${refusal}: "${args.definition.key}" ${why}.`, {
    userFacing: true,
    details: { code: refusal, obligation: args.definition.key, role: args.role },
  })
}
