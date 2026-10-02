/**
 * The holiday calendar as the rest of the build reads it, and the report a confirmation produces.
 *
 * Three subjects, and the first one is why the other two are shaped the way they are.
 *
 * ## 1. A date in this calendar is one of two different claims
 *
 * UAE public holidays are lunar and announced at short notice (docs/04 §6, docs/06 B5), so an observance
 * on file is either a date somebody ANNOUNCED or a date somebody PREDICTED. `holiday_observance`
 * (migration 0123) carries that as `confirmation_state`, a column rather than a convention, and this
 * module never collapses the two: {@link holidayPayCalendar} returns the predicted and the confirmed
 * dates separately, and every count this module produces is a {@link HolidayFigure} that says which it
 * rests on.
 *
 * **A figure is never a bare number here**, which is ADR 0073's rule applied to a calendar rather than to
 * cash. "Four appointments affected" and "four appointments affected, on a date nobody has announced" are
 * two different sentences, and a screen handed the number alone has no way to tell them apart — so the
 * only function that yields a printable count, {@link publishHolidayFigure}, returns the qualifier with
 * it. A caveat beside a figure gets separated from it by the first person who copies the number.
 *
 * A figure over several dates is as weak as its weakest date ({@link weakestHolidayBasis}): one predicted
 * date in a range makes the whole count predicted, because a reader cannot act on "mostly announced".
 *
 * ## 2. Confirming a holiday REPORTS and mutates nothing (ADR 0075)
 *
 * {@link holidayConfirmationImpact} takes the two date ranges — the one the observance held and the one
 * the announcement gave it — plus the appointments, shift assignments and approved leave over both, and
 * returns what the move affected. It is a pure function: it moves no appointment, reassigns no shift and
 * withdraws no leave. Those are decisions with their own actors, and a calendar edit that silently
 * rescheduled a customer would be the worst kind of helpful.
 *
 * The report is DERIVED and never stored. `holiday_confirmation` keeps both ranges precisely so the
 * report is reproducible from the row; a stored report would be a second statement of a derived figure,
 * and the first thing to make it wrong is an appointment moved after the confirmation — which leaves it
 * looking authoritative.
 *
 * ## 3. The pay bucket
 *
 * `summariseWorkedHours` (P-HR-05) already counts a public-holiday minute in its own bucket and never in
 * `ordinary`; what it lacked was a calendar, because `premises_closure` is a floor and not one — a public
 * holiday the salon trades through has no closure row at all (`Y9-overtime`). {@link holidayPayCalendar}
 * is that calendar, and **a provisional observance is included**, which is the strict direction rather
 * than an oversight: `publicHolidayTradingDates` in `working-hours.ts` states the reasoning and this
 * module inherits it — of the two possible errors, paying an uplift for a day that turns out not to be a
 * holiday is visible and recoverable, while not paying one is a shortfall on a payslip nobody re-reads.
 * {@link publicHolidayMinutes} is what makes that visible rather than silent: the minutes come back
 * marked `predicted` when any contributing date was.
 *
 * Pure: rows in, counts out, no clock, no database, and the zone is an argument.
 */
import { AppError } from '@berelax/shared'
import { nextDate } from '../business-day/resolve.ts'
import { type LocalDate, localDate } from '../time.ts'
import type { TradingDayHours } from './working-hours.ts'

// --- the calendar row ----------------------------------------------------------------------------

/** `holiday_observance.kind`. The same two words `reporting.calendar_observance` uses. */
export type HolidayObservanceKind = 'public_holiday' | 'ramadan'

/** `holiday_observance.date_basis`. A lunar date is announced at short notice. */
export type HolidayDateBasis = 'gregorian' | 'lunar'

/** `holiday_observance.confirmation_state`. */
export type HolidayConfirmationState = 'provisional' | 'confirmed'

/** One `holiday_observance` row. */
export interface HolidayObservance {
  readonly id: string
  readonly kind: HolidayObservanceKind
  /** The observance's name, which is a published fact even when its date is not. */
  readonly name: string
  readonly dateBasis: HolidayDateBasis
  readonly confirmationState: HolidayConfirmationState
  readonly startsOn: LocalDate
  readonly endsOn: LocalDate
  /**
   * The OPEN-QUESTIONS id owning a provisional date, and null on a confirmed one.
   *
   * `holiday_observance_provisional_names_a_question` holds the two to each other at the database, so a
   * provisional observance that names no question is unstorable rather than merely undocumented.
   */
  readonly openQuestionId: string | null
}

/** Every trading date an observance covers, ascending. */
export function observanceDates(observance: HolidayObservance): readonly LocalDate[] {
  if (observance.endsOn < observance.startsOn) {
    throw new AppError(
      'validation',
      `Observance ${observance.name} runs from ${observance.startsOn} to ${observance.endsOn}, ` +
        'which ends before it starts; holiday_observance_range_ordered refuses the row.',
    )
  }
  const dates: LocalDate[] = []
  for (
    let date: LocalDate = observance.startsOn;
    date <= observance.endsOn;
    date = nextDate(localDate(date))
  ) {
    dates.push(date)
  }
  return dates
}

// --- a figure, which is never a bare count -------------------------------------------------------

/**
 * What a count rests on.
 *
 * `predicted` and not `provisional`, deliberately. `provisional` describes the ROW's state; `predicted`
 * describes the CLAIM a figure computed over it is making, and those are two different words because the
 * figure is what somebody reads. A count over one predicted date and nine announced ones is a predicted
 * count, and calling it "provisional" invites the reading that nine tenths of it is settled.
 */
export type HolidayFigureBasis = 'confirmed' | 'predicted'

/**
 * A count, with what it rests on. There is no bare-number constructor.
 *
 * The `predicted` arm carries the OPEN-QUESTIONS ids of the dates it rests on, so a reader can go and
 * find out what is unanswered rather than being told only that something is.
 */
export type HolidayFigure =
  | { readonly basis: 'confirmed'; readonly count: number }
  | {
      readonly basis: 'predicted'
      readonly count: number
      readonly openQuestionIds: readonly string[]
    }

/** The weakest basis in a set: one predicted date makes the figure predicted. */
export function weakestHolidayBasis(bases: readonly HolidayFigureBasis[]): HolidayFigureBasis {
  return bases.includes('predicted') ? 'predicted' : 'confirmed'
}

/** A figure's basis from the observances that contributed to it. */
export function holidayBasisOf(observances: readonly HolidayObservance[]): HolidayFigureBasis {
  return weakestHolidayBasis(
    observances.map((observance) =>
      observance.confirmationState === 'confirmed' ? 'confirmed' : 'predicted',
    ),
  )
}

/** Builds a figure. `openQuestionIds` is deduplicated and sorted, so two runs produce one answer. */
export function holidayFigure(args: {
  readonly count: number
  readonly basis: HolidayFigureBasis
  readonly openQuestionIds?: readonly string[]
}): HolidayFigure {
  if (!Number.isInteger(args.count) || args.count < 0) {
    throw new AppError('validation', `A holiday figure counts whole rows, got ${args.count}`)
  }
  if (args.basis === 'confirmed') return { basis: 'confirmed', count: args.count }
  return {
    basis: 'predicted',
    count: args.count,
    openQuestionIds: [...new Set(args.openQuestionIds ?? [])].sort(),
  }
}

/**
 * The words that must appear with a predicted count, as the figure's own property.
 *
 * Phrased as what the figure IS rather than as advice, for `FORECAST_CAVEAT`'s reason: a caveat that
 * reads as advice gets treated as one.
 */
export const HOLIDAY_PREDICTED_QUALIFIER =
  'on a date nobody has announced. UAE lunar holidays are announced at short notice, so this count ' +
  'will change if the date does; it has not been confirmed and may not be presented as though it had.'

/**
 * The one function that yields a printable count, and it returns the qualifier with it.
 *
 * A confirmed figure's qualifier is the empty string, which is the honest answer rather than a missing
 * field: the caller always prints both, so there is no branch in which the qualifier can be forgotten.
 */
export function publishHolidayFigure(figure: HolidayFigure): {
  readonly count: number
  readonly qualifier: string
} {
  return {
    count: figure.count,
    qualifier: figure.basis === 'predicted' ? HOLIDAY_PREDICTED_QUALIFIER : '',
  }
}

// --- the pay calendar ----------------------------------------------------------------------------

/**
 * The public-holiday dates P-HR-05's maths reads, split by what each one rests on.
 *
 * `dates` is the union and is what `summariseWorkedHours({ publicHolidays })` takes — the strict
 * direction, for the reason the module header gives. The split is what makes the resulting figure able
 * to say so.
 *
 * `ramadan` observances are excluded from `dates` and that is not an omission: Ramadan changes the HOURS
 * (a `premises_hours_override` row, 0011) and not the pay bucket. There is no Ramadan multiplier in
 * `working_hours_rule` and inventing one would be `Y9-overtime` answered rather than recorded.
 */
export interface HolidayPayCalendar {
  /** Every public-holiday trading date, announced or predicted. */
  readonly dates: ReadonlySet<LocalDate>
  readonly confirmedDates: ReadonlySet<LocalDate>
  readonly predictedDates: ReadonlySet<LocalDate>
  /** The OPEN-QUESTIONS ids owning the predicted dates, deduplicated and sorted. */
  readonly openQuestionIds: readonly string[]
  /** The Ramadan dates, kept separately because they change hours rather than pay. */
  readonly ramadanDates: ReadonlySet<LocalDate>
}

export function holidayPayCalendar(observances: readonly HolidayObservance[]): HolidayPayCalendar {
  const confirmed = new Set<LocalDate>()
  const predicted = new Set<LocalDate>()
  const ramadan = new Set<LocalDate>()
  const questions = new Set<string>()
  for (const observance of observances) {
    const dates = observanceDates(observance)
    if (observance.kind === 'ramadan') {
      for (const date of dates) ramadan.add(date)
      continue
    }
    for (const date of dates) {
      if (observance.confirmationState === 'confirmed') confirmed.add(date)
      else predicted.add(date)
    }
    if (observance.confirmationState === 'provisional' && observance.openQuestionId !== null) {
      questions.add(observance.openQuestionId)
    }
  }
  // A date covered by both a confirmed and a predicted observance is PREDICTED, which is the weakest-part
  // rule applied one level down: two observances on one date is legitimate (dim_date aggregates their
  // names) and the pay figure has to be as weak as the weaker of them.
  for (const date of predicted) confirmed.delete(date)
  return {
    dates: new Set<LocalDate>([...confirmed, ...predicted]),
    confirmedDates: confirmed,
    predictedDates: predicted,
    openQuestionIds: [...questions].sort(),
    ramadanDates: ramadan,
  }
}

/**
 * The public-holiday minutes P-HR-05 counted, as a figure that says what they rest on.
 *
 * The minutes themselves are NOT computed here. They come out of `summariseWorkedHours(...).days`, where
 * each minute is counted once in the dearest bucket that applies — so the equality "the buckets sum to
 * the total" holds by construction in that module and a second sum here would be the reading that drifts.
 * What this adds is the one thing that module cannot know: whether the dates it was told were holidays
 * were announced or predicted.
 */
export function publicHolidayMinutes(args: {
  readonly days: readonly TradingDayHours[]
  readonly calendar: HolidayPayCalendar
}): HolidayFigure {
  let minutes = 0
  const bases: HolidayFigureBasis[] = []
  for (const day of args.days) {
    const contributed = day.minutes.publicHoliday
    if (contributed === 0) continue
    minutes += contributed
    bases.push(args.calendar.predictedDates.has(day.tradingDate) ? 'predicted' : 'confirmed')
  }
  const basis = weakestHolidayBasis(bases)
  return holidayFigure(
    basis === 'predicted'
      ? { count: minutes, basis, openQuestionIds: args.calendar.openQuestionIds }
      : { count: minutes, basis },
  )
}

// --- the impact report ---------------------------------------------------------------------------

/** An appointment over one of the two ranges. Identified by id; a customer is never named here. */
export interface ImpactedAppointment {
  readonly appointmentId: string
  /** `appointment.trading_date`, never re-derived from the period. */
  readonly tradingDate: LocalDate
}

/** A `shift_assignment` joined to its shift's trading date. Identified by both halves of its key. */
export interface ImpactedShiftAssignment {
  readonly shiftId: string
  readonly employeeId: string
  readonly tradingDate: LocalDate
}

/** One approved leave day, from `employee_approved_leave`. One row per DATE, not per request. */
export interface ImpactedLeaveDay {
  readonly leaveRequestId: string
  readonly employeeId: string
  readonly tradingDate: LocalDate
}

/** Which side of the move a row is on. */
export type HolidayImpactSide =
  /** The holiday was on this date and is not any more. */
  | 'released'
  /** The holiday is on this date and was not before. */
  | 'acquired'

export interface HolidayImpactRow {
  readonly reference: string
  readonly tradingDate: LocalDate
  readonly side: HolidayImpactSide
}

export interface HolidayImpactReport {
  /** Pinned so a reader comparing two reports can tell a format change from a figure change. */
  readonly formatVersion: typeof HOLIDAY_IMPACT_FORMAT_VERSION
  readonly observanceId: string
  readonly observanceName: string
  readonly dateBasis: HolidayDateBasis
  readonly previousStartsOn: LocalDate
  readonly previousEndsOn: LocalDate
  readonly confirmedStartsOn: LocalDate
  readonly confirmedEndsOn: LocalDate
  /** Dates the holiday left, ascending. */
  readonly releasedDates: readonly LocalDate[]
  /** Dates the holiday arrived on, ascending. */
  readonly acquiredDates: readonly LocalDate[]
  /** Dates it was on before and remains on. Nothing on these is affected. */
  readonly retainedDates: readonly LocalDate[]
  readonly appointments: readonly HolidayImpactRow[]
  readonly shiftAssignments: readonly HolidayImpactRow[]
  readonly approvedLeave: readonly HolidayImpactRow[]
  readonly figures: {
    readonly appointments: HolidayFigure
    readonly shiftAssignments: HolidayFigure
    readonly approvedLeave: HolidayFigure
  }
}

export const HOLIDAY_IMPACT_FORMAT_VERSION = 'holiday-impact-1'

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function rangeDates(startsOn: LocalDate, endsOn: LocalDate, what: string): LocalDate[] {
  if (endsOn < startsOn) {
    throw new AppError(
      'validation',
      `The ${what} range ${startsOn}..${endsOn} ends before it starts`,
    )
  }
  const dates: LocalDate[] = []
  for (let date: LocalDate = startsOn; date <= endsOn; date = nextDate(localDate(date))) {
    dates.push(date)
  }
  return dates
}

/**
 * What confirming a provisional holiday onto a different date affected.
 *
 * **Only the released and acquired dates are affected**, and a row on a retained date is deliberately
 * absent. The holiday was on that date before the announcement and is on it after, so nothing about the
 * appointment, the shift or the leave day has changed — listing it would put rows in the report that
 * nobody has to do anything about, and a report whose rows are mostly noise is a report nobody reads to
 * the end. The retained dates are returned as DATES so the omission is visible rather than silent.
 *
 * **The basis of every figure is the observance's own**, after the confirmation: a confirmed observance
 * yields confirmed counts, and a report produced while the date is still predicted says so in the figure.
 * That second case is reachable — the admin surface shows the impact a confirmation WOULD have before it
 * is recorded — and it is the case the marking exists for.
 */
export function holidayConfirmationImpact(args: {
  readonly observance: HolidayObservance
  readonly previousStartsOn: LocalDate
  readonly previousEndsOn: LocalDate
  readonly appointments: readonly ImpactedAppointment[]
  readonly shiftAssignments: readonly ImpactedShiftAssignment[]
  readonly approvedLeave: readonly ImpactedLeaveDay[]
}): HolidayImpactReport {
  const { observance } = args
  const previous = rangeDates(args.previousStartsOn, args.previousEndsOn, 'previous')
  const confirmed = observanceDates(observance)
  const previousSet = new Set<string>(previous)
  const confirmedSet = new Set<string>(confirmed)

  const releasedDates = previous.filter((date) => !confirmedSet.has(date))
  const acquiredDates = confirmed.filter((date) => !previousSet.has(date))
  const retainedDates = confirmed.filter((date) => previousSet.has(date))

  const sideOf = (date: LocalDate): HolidayImpactSide | undefined => {
    if (!confirmedSet.has(date) && previousSet.has(date)) return 'released'
    if (confirmedSet.has(date) && !previousSet.has(date)) return 'acquired'
    return undefined
  }

  const collect = (
    rows: readonly { readonly reference: string; readonly tradingDate: LocalDate }[],
  ): readonly HolidayImpactRow[] =>
    rows
      .flatMap((row): HolidayImpactRow[] => {
        const side = sideOf(row.tradingDate)
        return side === undefined ? [] : [{ ...row, side }]
      })
      // Sorted on BOTH keys and in one place, because the golden file is bytes: a sort on the date alone
      // leaves two rows on one date in whatever order the caller read them in, and the suite that proves
      // determinism would then be proving the repository's `order by` instead of this function.
      .sort(
        (a, b) => ascending(a.tradingDate, b.tradingDate) || ascending(a.reference, b.reference),
      )

  const basis = holidayBasisOf([observance])
  const questions = observance.openQuestionId === null ? [] : [observance.openQuestionId]
  const figureFor = (rows: readonly HolidayImpactRow[]): HolidayFigure =>
    holidayFigure(
      basis === 'predicted'
        ? { count: rows.length, basis, openQuestionIds: questions }
        : { count: rows.length, basis },
    )

  const appointments = collect(
    args.appointments.map((row) => ({
      reference: row.appointmentId,
      tradingDate: row.tradingDate,
    })),
  )
  const shiftAssignments = collect(
    // `shift_assignment`'s key is the PAIR, so the reference is the pair: two employees on one shift are
    // two rows somebody has to act on, and a reference of the shift id alone would collapse them.
    args.shiftAssignments.map((row) => ({
      reference: `${row.shiftId}/${row.employeeId}`,
      tradingDate: row.tradingDate,
    })),
  )
  const approvedLeave = collect(
    args.approvedLeave.map((row) => ({
      reference: `${row.leaveRequestId}/${row.tradingDate}`,
      tradingDate: row.tradingDate,
    })),
  )

  return {
    formatVersion: HOLIDAY_IMPACT_FORMAT_VERSION,
    observanceId: observance.id,
    observanceName: observance.name,
    dateBasis: observance.dateBasis,
    previousStartsOn: args.previousStartsOn,
    previousEndsOn: args.previousEndsOn,
    confirmedStartsOn: observance.startsOn,
    confirmedEndsOn: observance.endsOn,
    releasedDates,
    acquiredDates,
    retainedDates,
    appointments,
    shiftAssignments,
    approvedLeave,
    figures: {
      appointments: figureFor(appointments),
      shiftAssignments: figureFor(shiftAssignments),
      approvedLeave: figureFor(approvedLeave),
    },
  }
}

/**
 * The report as bytes, deterministically: keys sorted recursively.
 *
 * The acceptance line is "the same inputs produce byte-identical output under the frozen clock", and that
 * needs a canonical form — `JSON.stringify` preserves INSERTION order, so the bytes would otherwise
 * depend on the order this module happened to build an object in, which no test could detect and any
 * refactor could change.
 *
 * **There is no instant in the report at all**, which is what makes "under the frozen clock" cost
 * nothing: a `generatedAt` field would make two runs differ by construction, and freezing the clock to
 * hide that would be a test asserting the frozen clock rather than the report. The instant a
 * confirmation was recorded at lives on `holiday_confirmation.recorded_at`, where it belongs.
 *
 * The same canonical form as `forecastBytes` and `statementBytes`, which is a third statement of one
 * function. Unavoidable for the same reason R-REP-06 recorded: that one lives beside the forecast and
 * moving it into `@berelax/shared` would be editing two other units' modules to no purpose of this one's.
 * It arrives with the check that holds them equal — `packages/fixtures/src/hr-holiday-calendar.itest.ts`
 * asserts `holidayImpactBytes(r) === forecastBytes(r)` over a real report, in a package that may import
 * both.
 */
export function holidayImpactBytes(report: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => ascending(a, b))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(report))
}
