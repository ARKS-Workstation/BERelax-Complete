import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { type JournalEntryInput, journalError, postJournalEntry } from './journal.ts'

/**
 * The gratuity repository: the only write path into the end-of-service liability.
 *
 * ## Why the journal entry is posted FIRST, always
 *
 * Every write here posts the journal entry and its lines before inserting the HR row, and the ordering is
 * load-bearing rather than tidy. `assert_gratuity_accrual_is_posted` (ZY173) reads the entry's lines to
 * check that they debit an expense account and credit a liability account for exactly the accrued amount —
 * so an accrual row inserted first would pass a check that could see no lines at all. The trigger is a
 * BEFORE INSERT on `gratuity_accrual` and cannot be deferred, because what it validates is a property of
 * one row and there is nothing to wait for.
 *
 * ## Why every write takes a UnitOfWork
 *
 * The same reason `journal.ts` gives: three things have to be durable together or not at all — the journal
 * rows, the `audit_event` row saying who posted them, and the outbox event telling the rest of the system.
 * An audit row for a posting that rolled back is as bad as a posting with no audit row, and the second is
 * what an investigation cannot recover from. There is no overload taking a pool, because the
 * compiling-but-wrong call is the one worth making impossible.
 *
 * ## Why there is no update, no delete and no recompute
 *
 * `gratuity_accrual`, `gratuity_settlement` and `closed_period_labour_adjustment` are append-only (ZY171).
 * An over-accrual is answered by {@link postGratuityCorrection}: a dated reversal built by
 * `reverseEntry` in `@berelax/core`, then a replacement accrual row naming the one it supersedes. A
 * function called `updateGratuityAccrual` would fail the export-surface assertion in
 * `packages/fixtures/src/hr-gratuity.itest.ts`, which is the point of asserting it.
 *
 * ## Why these types do not use @berelax/core's
 *
 * `packages/db` must never import `packages/core` — the dependency runs the other way (brief rule 4). So
 * the inputs here are structural mirrors: `Money` becomes integer fils, `LocalDate` becomes an ISO
 * `YYYY-MM-DD` string, and the branded `EntryId` becomes a string. A caller holding a core entry draft maps
 * it field for field, and the pair is exercised together in `packages/fixtures`, which is the package
 * allowed to depend on both.
 */

/** The SQLSTATEs `0107_hr_gratuity.sql` raises. */
export const GRATUITY_SQLSTATE = {
  /** An accrual, settlement or adjustment row was UPDATEd or DELETEd. */
  appendOnly: 'ZY171',
  /** A correction named an accrual over another employee or another month. */
  correctionMismatch: 'ZY172',
  /** The named journal entry is not a two-line expense-debit/liability-credit gratuity accrual. */
  notPosted: 'ZY173',
  /** An accrual's dating disagrees with the period locks. */
  periodDating: 'ZY174',
  /** A settlement is not exactly the live accrued liability. */
  settlementMismatch: 'ZY175',
  /** A settlement names an employee who has not left, or snapshots the wrong leaving date. */
  notALeaver: 'ZY176',
  /** A closed-period adjustment's dates disagree with the period locks. */
  adjustmentDating: 'ZY177',
} as const

/** `23505`: a second original accrual for one employee-month, or a second correction of one accrual. */
const UNIQUE_VIOLATION = '23505'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error raised by the gratuity schema into an `AppError`, or `null`.
 *
 * The match is on SQLSTATE only. Matching on the message would make the translation depend on wording, and
 * a wording change would silently stop it working — after which the code that treats a locked period as an
 * unknown failure is the code that retries it (0018's own recorded reason).
 *
 * `journalError` is tried first and its result returned when it matches, so a caller wrapping one
 * transaction gets one translator rather than having to know which layer refused. That matters because the
 * UNBALANCED case arrives from COMMIT, outside every function in this module.
 */
export function gratuityError(err: unknown): AppError | null {
  const fromJournal = journalError(err)
  if (fromJournal !== null) return fromJournal
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case GRATUITY_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case GRATUITY_SQLSTATE.correctionMismatch:
    case GRATUITY_SQLSTATE.notPosted:
    case GRATUITY_SQLSTATE.settlementMismatch:
    case GRATUITY_SQLSTATE.notALeaver:
      return new AppError('validation', message, { details: { sqlState: code } })
    case GRATUITY_SQLSTATE.periodDating:
    case GRATUITY_SQLSTATE.adjustmentDating:
      // `conflict` and not `validation`: the caller's figures are fine and the PERIOD moved under them.
      // The answer is to re-date the entry into the open period, which is a different thing to do from
      // correcting a number, and a caller that cannot tell them apart will report the wrong one.
      return new AppError('conflict', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      // The idempotency index. A pass that raced itself, which is not an error for the CALLER — the second
      // insert simply lost — so it is reported as a conflict rather than as a validation failure.
      return new AppError('conflict', message, { details: { sqlState: code } })
    default:
      return null
  }
}

export function isGratuityAppendOnlyViolation(err: unknown): boolean {
  return sqlState(err) === GRATUITY_SQLSTATE.appendOnly
}

export function isGratuityPeriodDatingRefusal(err: unknown): boolean {
  return sqlState(err) === GRATUITY_SQLSTATE.periodDating
}

// --- reads ---------------------------------------------------------------------------------------

/** One version of `gratuity_rule`, in the shape the pure engine takes. */
export interface GratuityRuleRow {
  readonly effectiveFrom: string
  readonly daysPerYearFirstBand: number
  readonly daysPerYearAfterBand: number
  readonly bandBoundaryYears: number
  readonly dailyWageDaysDivisor: number
  readonly wageBasis: string
  readonly probationMonths: number
  readonly accruesDuringProbation: boolean
  readonly unpaidLeaveDaysExcluded: boolean
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/**
 * Every policy version, oldest first.
 *
 * All of them and not "the current one", because the engine picks the version governing each accrual month:
 * a month recomputed after a rate change must use the rate that applied then. A read per month would also
 * let the first half of a catch-up be judged against one version and the second half against another, with
 * nothing in the row saying which.
 */
export async function readGratuityRules(sql: Sql): Promise<readonly GratuityRuleRow[]> {
  return sql<GratuityRuleRow[]>`
    select effective_from::text                as "effectiveFrom",
           days_per_year_first_band            as "daysPerYearFirstBand",
           days_per_year_after_band            as "daysPerYearAfterBand",
           band_boundary_years                 as "bandBoundaryYears",
           daily_wage_days_divisor             as "dailyWageDaysDivisor",
           wage_basis                          as "wageBasis",
           probation_months                    as "probationMonths",
           accrues_during_probation            as "accruesDuringProbation",
           unpaid_leave_days_excluded          as "unpaidLeaveDaysExcluded",
           is_provisional                      as "isProvisional",
           open_question_id                    as "openQuestionId",
           provisional_note                    as "provisionalNote",
           source_note                         as "sourceNote"
      from gratuity_rule
     order by effective_from
  `
}

/** An employee the gratuity pass considers, with everything it needs to decide whether to accrue. */
export interface GratuityEmployeeRow {
  readonly employeeId: string
  readonly staffReference: string
  readonly employedFrom: string
  readonly employedUntil: string | null
  /**
   * The wage under the rule's basis, or `null`.
   *
   * Null is NOT zero. All nineteen seeded therapists carry a null `basic_wage_fils`, because a wage is a
   * fact about a person and the build does not invent one (brief rule 15) — so an engine treating null as
   * zero would report a roster of nineteen unpriced people as owing nothing, and nothing about the figure
   * would look wrong. The pass counts and names them instead.
   */
  readonly wageFils: number | null
  /**
   * Whether the employment RECORD is still provisional (`employee.is_provisional`).
   *
   * Carried because service length is a MULTIPLIER on the whole liability, not an addend. The nineteen
   * seeded rows have `employed_from = 1970-01-01`, an epoch placeholder chosen to be visibly implausible,
   * so accruing against one would owe fifty-six years of gratuity rather than a slightly wrong figure. The
   * pass refuses these and names them, which is a different exclusion from being unpriced and is reported
   * separately.
   */
  readonly isProvisional: boolean
}

/**
 * Everybody engaged by a date, with the wage the rule's basis names.
 *
 * `wageBasis` picks the column: `basic` reads `basic_wage_fils` and `gross` the generated
 * `total_wage_fils` (0050 sums basic plus the three allowances into it). Chosen in SQL rather than by
 * reading both and letting the caller pick, so there is exactly one place that knows what the basis means.
 *
 * A leaver's final month still accrues, so the filter is on engagement and never on `employed_until`.
 */
export async function readGratuityEmployees(
  sql: Sql,
  args: {
    readonly engagedOnOrBefore: string
    readonly wageBasis: string
    /**
     * Narrows the pass to these employees. Omitted means the whole roster, which is what the cron asks.
     *
     * The narrowed form is what lets the integration suite isolate itself against a shared database (brief
     * rule 12): the pass reads the whole roster in production, so an unnarrowed run from a test would
     * accrue for every other file's fixture employees into an append-only table. `[]` is refused rather
     * than silently meaning "everybody", because an empty array is what an unfiltered variable looks like.
     */
    readonly employeeIds?: readonly string[]
  },
): Promise<readonly GratuityEmployeeRow[]> {
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readGratuityEmployees was given an empty employee list; an empty array is what an unfiltered ' +
        'variable looks like, and reading it as "everybody" would accrue against the whole roster.',
    )
  }
  if (args.wageBasis !== 'basic' && args.wageBasis !== 'gross') {
    throw new AppError(
      'validation',
      `readGratuityEmployees was asked for wage basis "${args.wageBasis}". The basis comes from a ` +
        'gratuity_rule version and the column CHECK allows only basic or gross, so anything else means a ' +
        'row reached here another way.',
    )
  }
  const ids = args.employeeIds ?? null
  const rows = await sql<Record<string, string | boolean | null>[]>`
    select e.id                       as "employeeId",
           e.staff_reference           as "staffReference",
           e.employed_from::text       as "employedFrom",
           e.employed_until::text      as "employedUntil",
           case when ${args.wageBasis} = 'gross'
                then e.total_wage_fils::bigint
                else e.basic_wage_fils::bigint
           end                         as "wageFils",
           e.is_provisional            as "isProvisional"
      from employee e
     where e.employed_from <= ${args.engagedOnOrBefore}::date
       and (${ids}::uuid[] is null or e.id = any (${ids}::uuid[]))
     order by e.staff_reference
  `
  return rows.map((row) => ({
    employeeId: row['employeeId'] as string,
    staffReference: row['staffReference'] as string,
    employedFrom: row['employedFrom'] as string,
    employedUntil: (row['employedUntil'] as string | null) ?? null,
    // `null` stays null and never becomes 0: an unpriced employee is NAMED by the pass, and `Number(null)`
    // is 0, which would silently price them at nothing — the failure this column exists to avoid.
    wageFils: row['wageFils'] === null ? null : Number(row['wageFils']),
    isProvisional: row['isProvisional'] === true,
  }))
}

export interface GratuityAccrualRow {
  readonly accrualId: string
  readonly employeeId: string
  readonly accrualMonth: string
  readonly accruedTo: string
  readonly accruedFils: number
  readonly cumulativeFils: number
  readonly wageFils: number
  /** The basis the wage was read under, pinned. A later version changing it cannot restate this row. */
  readonly wageBasis: string
  readonly entryId: string
  readonly entryDate: string
  readonly lockedPeriodId: string | null
  readonly correctsAccrualId: string | null
  readonly ruleEffectiveFrom: string
}

/**
 * The accrual rows for these employees in a month window.
 *
 * Returns SUPERSEDED rows too, deliberately: the pass needs to know a month has an ORIGINAL row so it does
 * not accrue it twice, and the liability figure comes from {@link readGratuityLiabilities} which excludes
 * the superseded ones. One read answering both questions would have to answer one of them wrongly.
 */
export async function readGratuityAccruals(
  sql: Sql,
  args: {
    readonly employeeIds: readonly string[]
    readonly fromMonth: string
    readonly toMonth: string
  },
): Promise<readonly GratuityAccrualRow[]> {
  if (args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readGratuityAccruals was given an empty employee list; an empty array is what an unfiltered ' +
        'variable looks like.',
    )
  }
  /*
   * `bigint` comes back from postgres.js as a STRING, so every money column is mapped through `Number`
   * rather than declared as one and hoped for. The first version of these functions did the latter, and
   * the row type said `number` while the value was a string — which compares unequal to every integer and
   * sums by concatenation. The compiler cannot see it, because a row type is an assertion ABOUT a query
   * rather than a derivation FROM it, so the integration suite is the only thing that can.
   */
  const rows = await sql<Record<string, string | null>[]>`
    select accrual_id::text           as "accrualId",
           employee_id::text          as "employeeId",
           accrual_month::text        as "accrualMonth",
           accrued_to::text           as "accruedTo",
           accrued_fils::bigint       as "accruedFils",
           cumulative_fils::bigint    as "cumulativeFils",
           wage_fils::bigint          as "wageFils",
           wage_basis                 as "wageBasis",
           entry_id                   as "entryId",
           entry_date::text           as "entryDate",
           locked_period_id           as "lockedPeriodId",
           corrects_accrual_id::text  as "correctsAccrualId",
           rule_effective_from::text  as "ruleEffectiveFrom"
      from gratuity_accrual
     where employee_id = any (${[...args.employeeIds]}::uuid[])
       and accrual_month between ${args.fromMonth}::date and ${args.toMonth}::date
     order by employee_id, accrual_month, created_at
  `
  return rows.map((row) => ({
    accrualId: row['accrualId'] as string,
    employeeId: row['employeeId'] as string,
    accrualMonth: row['accrualMonth'] as string,
    accruedTo: row['accruedTo'] as string,
    accruedFils: Number(row['accruedFils']),
    cumulativeFils: Number(row['cumulativeFils']),
    wageFils: Number(row['wageFils']),
    wageBasis: row['wageBasis'] as string,
    entryId: row['entryId'] as string,
    entryDate: row['entryDate'] as string,
    lockedPeriodId: row['lockedPeriodId'] ?? null,
    correctsAccrualId: row['correctsAccrualId'] ?? null,
    ruleEffectiveFrom: row['ruleEffectiveFrom'] as string,
  }))
}

export interface GratuityLiabilityRow {
  readonly employeeId: string
  readonly accruedFils: number
  readonly latestAccrualMonth: string
  readonly accrualCount: number
}

/**
 * The LIVE accrued liability per employee, from the `employee_gratuity_liability` view.
 *
 * The view excludes any accrual a correction supersedes, so this is the figure a settlement must discharge
 * (ZY175) and the figure the reconciliation compares against the liability account. Read from the view
 * rather than summed here, because the database enforces the settlement against that same view and two
 * expressions of one sum is one opportunity to disagree about somebody's entitlement.
 */
export async function readGratuityLiabilities(
  sql: Sql,
  employeeIds: readonly string[],
): Promise<readonly GratuityLiabilityRow[]> {
  if (employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readGratuityLiabilities was given an empty employee list; an empty array is what an unfiltered ' +
        'variable looks like.',
    )
  }
  const rows = await sql<Record<string, string | number | null>[]>`
    select employee_id::text        as "employeeId",
           accrued_fils::bigint     as "accruedFils",
           latest_accrual_month::text as "latestAccrualMonth",
           accrual_count            as "accrualCount"
      from employee_gratuity_liability
     where employee_id = any (${[...employeeIds]}::uuid[])
     order by employee_id
  `
  return rows.map((row) => ({
    employeeId: row['employeeId'] as string,
    accruedFils: Number(row['accruedFils']),
    latestAccrualMonth: row['latestAccrualMonth'] as string,
    accrualCount: Number(row['accrualCount']),
  }))
}

/**
 * The gratuity accrued for a MONTH across everybody, for the reconciliation.
 *
 * Grouped by the month the accrual was FOR and not by the date its entry carries, because those differ for
 * every catch-up and for every locked period — and the acceptance line ties the liability account balance
 * for a period to the accrual rows "for the same period", which is a claim about the entry dates. So both
 * are returned and the caller states which it is reconciling.
 */
export interface GratuityMonthTotalRow {
  readonly accrualMonth: string
  readonly entryDate: string
  readonly accruedFils: number
  readonly rows: number
}

export async function readGratuityTotalsByMonth(
  sql: Sql,
  args: { readonly fromEntryDate: string; readonly toEntryDate: string },
): Promise<readonly GratuityMonthTotalRow[]> {
  const rows = await sql<Record<string, string | number | null>[]>`
    select accrual_month::text  as "accrualMonth",
           entry_date::text     as "entryDate",
           sum(accrued_fils)::bigint as "accruedFils",
           count(*)::integer    as "rows"
      from gratuity_accrual
     where entry_date between ${args.fromEntryDate}::date and ${args.toEntryDate}::date
     group by accrual_month, entry_date
     order by entry_date, accrual_month
  `
  return rows.map((row) => ({
    accrualMonth: row['accrualMonth'] as string,
    entryDate: row['entryDate'] as string,
    accruedFils: Number(row['accruedFils']),
    rows: Number(row['rows']),
  }))
}

// --- writes --------------------------------------------------------------------------------------

/** One month's accrual to write. Every figure was computed by `accrueGratuityMonth` in `@berelax/core`. */
export interface GratuityAccrualInput {
  readonly employeeId: string
  readonly staffReference: string
  readonly accrualMonth: string
  readonly accruedTo: string
  readonly wageFils: number
  readonly wageBasis: string
  readonly employedDays: number
  readonly unpaidLeaveDays: number
  readonly cumulativeFils: number
  readonly accruedFils: number
  readonly ruleEffectiveFrom: string
  readonly lockedPeriodId?: string | null
  readonly correctsAccrualId?: string | null
  readonly createdBy: string
  /** The entry, already built by `gratuityAccrualEntry` in `@berelax/core`. */
  readonly entry: JournalEntryInput
}

export interface WrittenGratuityAccrual {
  readonly accrualId: string
  readonly employeeId: string
  readonly accrualMonth: string
  readonly accruedFils: number
  readonly entryId: string
  readonly entryDate: string
}

/**
 * Posts one month's accrual: the journal entry, its two lines, then the accrual row.
 *
 * Returns `null` when the month already has an original accrual row, rather than throwing. That is the
 * idempotency contract the acceptance line asks for — *"a second run posts no additional journal lines and
 * no additional accrual rows"* — and it is checked BEFORE the entry is posted, because an `on conflict do
 * nothing` on the accrual row alone would leave the journal entry behind: a balanced entry crediting the
 * liability with no HR row attributing it to anybody, which is worse than the duplicate it prevented.
 *
 * The check and the insert are not atomic against a concurrent pass, and they do not need to be: the
 * partial unique index `gratuity_accrual_one_original_per_month` is what actually refuses the second row,
 * and the loser's transaction rolls back — taking its journal entry with it. The pre-check is there to make
 * the ORDINARY second run cheap and silent, not to make the concurrent one safe; the index does that.
 */
export async function postGratuityAccrual(
  uow: UnitOfWork,
  input: GratuityAccrualInput,
): Promise<WrittenGratuityAccrual | null> {
  if (input.correctsAccrualId === undefined || input.correctsAccrualId === null) {
    const existing = await uow.sql<{ accrual_id: string }[]>`
      select accrual_id from gratuity_accrual
       where employee_id = ${input.employeeId}::uuid
         and accrual_month = ${input.accrualMonth}::date
         and corrects_accrual_id is null
    `
    if (existing.length > 0) return null
  }

  try {
    // The entry FIRST. ZY173 reads its lines, so an accrual row inserted before them would pass a check
    // that could see nothing.
    await postJournalEntry(uow, input.entry)

    const [row] = await uow.sql<{ accrual_id: string }[]>`
      insert into gratuity_accrual (
        employee_id, accrual_month, accrued_to, wage_fils, wage_basis, employed_days,
        unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from, entry_id, entry_date,
        locked_period_id, corrects_accrual_id, created_by
      ) values (
        ${input.employeeId}::uuid,
        ${input.accrualMonth}::date,
        ${input.accruedTo}::date,
        ${input.wageFils},
        ${input.wageBasis},
        ${input.employedDays},
        ${input.unpaidLeaveDays},
        ${input.cumulativeFils},
        ${input.accruedFils},
        ${input.ruleEffectiveFrom}::date,
        ${input.entry.entryId},
        ${input.entry.entryDate}::date,
        ${input.lockedPeriodId ?? null},
        ${input.correctsAccrualId ?? null},
        ${input.createdBy}
      )
      returning accrual_id::text as accrual_id
    `
    if (!row) {
      throw new AppError(
        'invariant_violated',
        `gratuity_accrual insert returned no row for employee ${input.employeeId} month ` +
          `${input.accrualMonth}`,
      )
    }
    return {
      accrualId: row.accrual_id,
      employeeId: input.employeeId,
      accrualMonth: input.accrualMonth,
      accruedFils: input.accruedFils,
      entryId: input.entry.entryId,
      entryDate: input.entry.entryDate,
    }
  } catch (err) {
    throw gratuityError(err) ?? err
  }
}

/**
 * Corrects an over-accrual: the dated reversal, then the replacement accrual row.
 *
 * Two entries and never an edit (ADR 0017), in this order. `reversal` is built by `reverseEntry` in
 * `@berelax/core` from the entry being corrected, so its amounts are the original's swapped rather than
 * recomputed — a re-derived reversal could round differently and leave a residue nobody can trace back.
 *
 * `replacement` is omitted when the corrected figure is zero: the reversal alone is the whole correction,
 * and a zero-fils replacement entry would balance perfectly while posting nothing.
 */
export async function postGratuityCorrection(
  uow: UnitOfWork,
  args: {
    readonly reversal: JournalEntryInput
    readonly replacement?: GratuityAccrualInput
  },
): Promise<WrittenGratuityAccrual | null> {
  try {
    await postJournalEntry(uow, args.reversal)
  } catch (err) {
    throw gratuityError(err) ?? err
  }
  if (args.replacement === undefined) return null
  if (
    args.replacement.correctsAccrualId === undefined ||
    args.replacement.correctsAccrualId === null
  ) {
    throw new AppError(
      'validation',
      'A gratuity correction posted a replacement accrual that names no accrual to supersede. The ' +
        'liability view excludes a superseded row, so a replacement that names nothing is counted ' +
        'ALONGSIDE the figure it was meant to replace rather than instead of it.',
    )
  }
  return postGratuityAccrual(uow, args.replacement)
}

export interface GratuitySettlementInput {
  readonly employeeId: string
  readonly employedUntil: string
  readonly settledFils: number
  readonly createdBy: string
  readonly entry: JournalEntryInput
}

/**
 * Settles a leaver: the entry discharging the liability, then the settlement row.
 *
 * The amount is NOT recomputed here. It is compared by the database against
 * `employee_gratuity_liability` (ZY175) and refused unless it is exactly equal, so "the liability nets to
 * zero fils" is a fact the schema enforces rather than one this function hopes for. A recomputation here
 * would be a second opinion about a sum the view already states, and the two could disagree about
 * somebody's final pay.
 */
export async function postGratuitySettlement(
  uow: UnitOfWork,
  input: GratuitySettlementInput,
): Promise<{ readonly settlementId: string }> {
  try {
    await postJournalEntry(uow, input.entry)
    const [row] = await uow.sql<{ settlement_id: string }[]>`
      insert into gratuity_settlement (
        employee_id, employed_until, settled_fils, entry_id, entry_date, created_by
      ) values (
        ${input.employeeId}::uuid,
        ${input.employedUntil}::date,
        ${input.settledFils},
        ${input.entry.entryId},
        ${input.entry.entryDate}::date,
        ${input.createdBy}
      )
      returning settlement_id::text as settlement_id
    `
    if (!row) {
      throw new AppError(
        'invariant_violated',
        `gratuity_settlement insert returned no row for employee ${input.employeeId}`,
      )
    }
    return { settlementId: row.settlement_id }
  } catch (err) {
    throw gratuityError(err) ?? err
  }
}

export interface ClosedPeriodLabourAdjustmentInput {
  readonly employeeId: string
  readonly workedOn: string
  readonly lockedPeriodId: string
  readonly amountFils: number
  readonly reason: string
  readonly authorisedBy: string
  readonly recordedBy: string
  readonly entry: JournalEntryInput
}

/**
 * Records work done in a closed accounting period that no punch ever captured (P-HR-07's re-pointed gap).
 *
 * Nothing is computed. The amount arrives from whoever authorised it, because deriving it means deciding
 * what a day of a monthly salary is worth — which `Y9-deductions` records as unanswered — and a derived
 * figure would be indistinguishable on the ledger from an authorised one.
 *
 * It credits a PAYABLE. Reaching into a payroll run is impossible by design: a completed run is immutable
 * (ZY141) and its header figures may only be written by the statement that completes it (ZY142), so the
 * next run discharges the payable instead and no completed run is ever rewritten.
 */
export async function postClosedPeriodLabourAdjustment(
  uow: UnitOfWork,
  input: ClosedPeriodLabourAdjustmentInput,
): Promise<{ readonly adjustmentId: string }> {
  try {
    await postJournalEntry(uow, input.entry)
    const [row] = await uow.sql<{ adjustment_id: string }[]>`
      insert into closed_period_labour_adjustment (
        employee_id, worked_on, locked_period_id, amount_fils, reason, authorised_by, recorded_by,
        entry_id, entry_date
      ) values (
        ${input.employeeId}::uuid,
        ${input.workedOn}::date,
        ${input.lockedPeriodId},
        ${input.amountFils},
        ${input.reason},
        ${input.authorisedBy},
        ${input.recordedBy},
        ${input.entry.entryId},
        ${input.entry.entryDate}::date
      )
      returning adjustment_id::text as adjustment_id
    `
    if (!row) {
      throw new AppError(
        'invariant_violated',
        `closed_period_labour_adjustment insert returned no row for employee ${input.employeeId}`,
      )
    }
    return { adjustmentId: row.adjustment_id }
  } catch (err) {
    throw gratuityError(err) ?? err
  }
}
