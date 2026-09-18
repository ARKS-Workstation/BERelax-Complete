import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { type BillToPost, type PostedBill, postBill, purchaseError } from './post-bill.ts'

/**
 * The recurring cost register: the writes.
 *
 * ## What this unit is for
 *
 * A salon's cost base is mostly the same handful of invoices every month, and two things go wrong with
 * that list without either showing up in the ledger. A cost **stops arriving** and the month closes
 * understating the cost base — which surfaces when the arrears letter does, after the VAT return for the
 * period has been filed. Or a cost **changes**: rent up 4% because an escalation clause fired, laundry
 * now billing a collection charge that used to be included. Each individual invoice looks ordinary
 * because nobody compares it with anything.
 *
 * So the register holds what the business expects, period by period, and everything here exists to turn
 * those two failures into rows somebody reads.
 *
 * ## The variance definition lives in the database, not here
 *
 * `recurring_cost_variance()` in `0031_recurring_cost.sql` computes the signed delta, the tolerance in
 * fils and whether it was breached; `packages/core/src/money/recurring-schedule.ts` states the same rule
 * for pure callers, and `packages/fixtures/src/recurring-costs.itest.ts` asserts the two agree. This
 * package may not import `packages/core` (the dependency runs core ← db), so a *third* statement here
 * would be a third thing to keep in agreement — and the day two of them disagree is the day a variance
 * report and a variance alert say different numbers about the same bill.
 *
 * In one sentence, the definition is: **a variance is the difference between what the bill charged and
 * what the register said to expect for that period** — the contracted amount for a fixed cost, and the
 * distance outside the declared band for a variable one. Never last period, and never a rolling mean:
 * a last-period baseline is silent on the second month of a wrong amount, and a mean absorbs the error
 * it exists to detect.
 *
 * ## One occurrence generator, used twice
 *
 * `generateRecurringInstances` enumerates periods through the *same* SQL function the forecast reads,
 * `recurring_cost_forward_schedule()`. Deliberately: a second enumeration would allow a period that is
 * forecast but never generated (so it can never raise a missing-cost alert) or generated but never
 * forecast (so the cash-flow line is short by one rent), and neither would be visible from either side.
 *
 * ## Matching is recorded, never guessed
 *
 * Nothing here infers which bill satisfies which period. `postRecurringBill` records the match at the
 * moment the bill is entered, because whoever is holding the invoice knows what it is for, and
 * `matchBillToRecurringCost` attaches one entered earlier. Auto-matching on supplier and amount is
 * deliberately absent: a landlord bills rent *and* a service charge, so "the supplier's other invoice"
 * is not a unique answer, and one wrong attachment reports a false variance, silences a real
 * missing-cost alert and leaves another cost looking unbilled — three wrong answers from one row.
 */

/** The SQLSTATEs `0031_recurring_cost.sql` raises. Matched on the code, never on the message. */
export const RECURRING_COST_SQLSTATE = {
  /** An instance, a match or an alert was UPDATEd or DELETEd. */
  appendOnly: 'ZR001',
  /** A bill matched to a cost that somebody else bills. */
  matchedBillFromAnotherSupplier: 'ZR002',
  /** A cadence the schedule cannot step. */
  unknownCadence: 'ZR003',
} as const

/** `23505`: a unique constraint refused the row. Which one is read from the constraint name. */
const UNIQUE_VIOLATION = '23505'

export const RECURRING_CADENCES = ['monthly', 'quarterly', 'annual'] as const
export type RecurringCadence = (typeof RECURRING_CADENCES)[number]

export const RECURRING_COST_KINDS = ['fixed', 'variable'] as const
export type RecurringCostKind = (typeof RECURRING_COST_KINDS)[number]

export const RECURRING_COST_ALERT_KINDS = ['variance_over_tolerance', 'missing_cost'] as const
export type RecurringCostAlertKind = (typeof RECURRING_COST_ALERT_KINDS)[number]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const constraintName = (err: unknown): string | undefined => {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name
  return typeof name === 'string' ? name : undefined
}

/**
 * Translates a refusal raised by the register, the purchases schema, the ledger or the opening-date
 * guard into an `AppError`, or returns `null` if it is none of ours.
 *
 * Applied by the caller around its own `withUnitOfWork`, because a recurring bill posts a journal entry
 * and the two refusals that matter most there arrive from **COMMIT** — the deferred balance trigger and
 * the deferred bill-totals trigger — and no function in this module executes the COMMIT. Falls through
 * to `purchaseError`, which already covers ZV*, ZL* and the ZL004 opening-date guard that `journalError`
 * does not: restating any of them here would be a second sentence to keep in agreement.
 */
export function recurringCostError(err: unknown): AppError | null {
  // Idempotent, for the reason `purchaseError` documents: these are translated twice on the one path
  // that counts — once where they are raised and once around the transaction — and without this guard
  // the sentence a bookkeeper reads arrives with its explanation duplicated.
  if (err instanceof AppError && typeof err.details['sqlState'] === 'string') return err

  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case RECURRING_COST_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case RECURRING_COST_SQLSTATE.matchedBillFromAnotherSupplier:
      return new AppError(
        'validation',
        `${message} — match the bill to the cost its own supplier bills. A mis-keyed match reports a ` +
          'variance that did not happen, silences the missing-cost alert for the period it took, and ' +
          'leaves the cost it belonged to looking unbilled.',
        { details: { sqlState: code } },
      )
    case RECURRING_COST_SQLSTATE.unknownCadence:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION: {
      const constraint = constraintName(err)
      if (constraint === 'recurring_cost_match_one_per_period') {
        return new AppError(
          'conflict',
          `This period has already been matched to a bill (${message}). Two bills against one period ` +
            'is either a duplicate invoice or a period somebody mis-keyed, and both need a person.',
          { details: { sqlState: code, constraint } },
        )
      }
      if (constraint === 'recurring_cost_match_one_per_bill') {
        return new AppError(
          'conflict',
          `This bill is already matched to a recurring cost period (${message}). One invoice cannot ` +
            'satisfy two expected periods, or it would silence two missing-cost alerts.',
          { details: { sqlState: code, constraint } },
        )
      }
      return purchaseError(err)
    }
    default:
      return purchaseError(err)
  }
}

/** True when `err` is the second match on a period the acceptance asks to be refused. */
export function isDuplicateRecurringCostMatch(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION &&
    constraintName(err) === 'recurring_cost_match_one_per_period'
  )
}

export interface RecurringCostInput {
  readonly code: string
  readonly description: string
  readonly supplierId: string
  readonly expenseAccountCode: string
  /** From `bill_line.tax_treatment`'s vocabulary. What the register expects, not what it decides. */
  readonly taxTreatment: string
  readonly cadence: RecurringCadence
  /** The anchor. Its day must be 1..28 — see the CHECK, and `recurringDueDate` in `@berelax/core`. */
  readonly firstDueDate: string
  readonly finalDueDate?: string | null
  readonly costKind: RecurringCostKind
  /** A fixed cost's contracted amount, in integer fils. */
  readonly expectedAmountFils?: number | null
  /** A variable cost's normal band, in integer fils. */
  readonly expectedMinFils?: number | null
  readonly expectedMaxFils?: number | null
  /** Basis points of the breached expectation. Stated explicitly: there is no default anywhere. */
  readonly varianceToleranceBp: number
}

export interface RecurringCostRecord {
  readonly recurringCostId: string
  readonly code: string
  readonly description: string
  readonly supplierId: string
  readonly expenseAccountCode: string
  readonly taxTreatment: string
  readonly cadence: RecurringCadence
  readonly firstDueDate: string
  readonly finalDueDate: string | null
  readonly costKind: RecurringCostKind
  readonly expectedAmountFils: number | null
  readonly expectedMinFils: number | null
  readonly expectedMaxFils: number | null
  readonly varianceToleranceBp: number
}

function assertIsoDate(label: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${label} must be an ISO date (YYYY-MM-DD), received "${value}"`,
    )
  }
}

function assertPeriodKey(value: string): void {
  if (!PERIOD_KEY.test(value)) {
    throw new AppError(
      'validation',
      `A recurring cost period is YYYY-MM, received "${value}". The key is the calendar month of the ` +
        'due date for every cadence, which is what lets a quarterly and a monthly cost be summed into ' +
        'one cash-flow line.',
    )
  }
}

/**
 * Records one recurring cost definition.
 *
 * The shape rules — a fixed cost is an amount, a variable cost is a band — are enforced by
 * `recurring_cost_fixed_needs_an_expected_amount` and
 * `recurring_cost_variable_needs_an_expected_range`, and explained by `validateRecurringCost` in
 * `@berelax/core`, which is the layer a person filling in a form reads. Neither is restated here: a
 * third copy of a rule is a third thing to keep in agreement.
 */
export async function recordRecurringCost(
  uow: UnitOfWork,
  input: RecurringCostInput,
): Promise<RecurringCostRecord> {
  assertIsoDate('firstDueDate', input.firstDueDate)
  if (input.finalDueDate != null) assertIsoDate('finalDueDate', input.finalDueDate)
  for (const [label, value] of [
    ['expectedAmountFils', input.expectedAmountFils],
    ['expectedMinFils', input.expectedMinFils],
    ['expectedMaxFils', input.expectedMaxFils],
  ] as const) {
    if (value != null && !Number.isInteger(value)) {
      // The `fils` domain is bigint, so PostgreSQL would ROUND a fractional numeric literal rather than
      // refuse it. Half a fils in an expectation surfaces as a one-fils variance every single period.
      throw new AppError('validation', `${label} is ${value}, which is not a whole number of fils`)
    }
  }

  const [row] = await uow.sql<{ recurring_cost_id: string }[]>`
    insert into recurring_cost (
      code, description, supplier_id, expense_account_code, tax_treatment, cadence,
      first_due_date, final_due_date, cost_kind,
      expected_amount_fils, expected_min_fils, expected_max_fils, variance_tolerance_bp
    ) values (
      ${input.code}, ${input.description}, ${input.supplierId}::uuid, ${input.expenseAccountCode},
      ${input.taxTreatment}, ${input.cadence},
      ${input.firstDueDate}::date, ${input.finalDueDate ?? null}::date, ${input.costKind},
      ${input.expectedAmountFils ?? null}, ${input.expectedMinFils ?? null},
      ${input.expectedMaxFils ?? null}, ${input.varianceToleranceBp}
    )
    returning recurring_cost_id::text as recurring_cost_id
  `
  if (!row) {
    throw new AppError(
      'invariant_violated',
      `The recurring cost insert returned no row for "${input.code}"`,
    )
  }

  await uow.audit.record({
    action: 'purchases.recurring_cost.recorded',
    entityType: 'recurring_cost',
    entityId: row.recurring_cost_id,
    operation: 'create',
    after: {
      code: input.code,
      supplierId: input.supplierId,
      cadence: input.cadence,
      costKind: input.costKind,
      firstDueDate: input.firstDueDate,
      expectedAmountFils: input.expectedAmountFils ?? null,
      expectedMinFils: input.expectedMinFils ?? null,
      expectedMaxFils: input.expectedMaxFils ?? null,
      varianceToleranceBp: input.varianceToleranceBp,
    },
  })

  return {
    recurringCostId: row.recurring_cost_id,
    code: input.code,
    description: input.description,
    supplierId: input.supplierId,
    expenseAccountCode: input.expenseAccountCode,
    taxTreatment: input.taxTreatment,
    cadence: input.cadence,
    firstDueDate: input.firstDueDate,
    finalDueDate: input.finalDueDate ?? null,
    costKind: input.costKind,
    expectedAmountFils: input.expectedAmountFils ?? null,
    expectedMinFils: input.expectedMinFils ?? null,
    expectedMaxFils: input.expectedMaxFils ?? null,
    varianceToleranceBp: input.varianceToleranceBp,
  }
}

interface RecurringCostRow {
  recurring_cost_id: string
  code: string
  description: string
  supplier_id: string
  expense_account_code: string
  tax_treatment: string
  cadence: string
  first_due_date: string
  final_due_date: string | null
  cost_kind: string
  expected_amount_fils: string | null
  expected_min_fils: string | null
  expected_max_fils: string | null
  variance_tolerance_bp: number
}

function shapeCost(row: RecurringCostRow): RecurringCostRecord {
  return {
    recurringCostId: row.recurring_cost_id,
    code: row.code,
    description: row.description,
    supplierId: row.supplier_id,
    expenseAccountCode: row.expense_account_code,
    taxTreatment: row.tax_treatment,
    cadence: row.cadence as RecurringCadence,
    firstDueDate: row.first_due_date,
    finalDueDate: row.final_due_date,
    costKind: row.cost_kind as RecurringCostKind,
    // The driver returns the `fils` domain as a string so nothing rounds in transit; `Number()` is
    // applied once, here, where a single row's figure re-enters TypeScript. Aggregates over many rows
    // stay bigint — see ../queries/recurring-cost-forecast.ts.
    expectedAmountFils: row.expected_amount_fils === null ? null : Number(row.expected_amount_fils),
    expectedMinFils: row.expected_min_fils === null ? null : Number(row.expected_min_fils),
    expectedMaxFils: row.expected_max_fils === null ? null : Number(row.expected_max_fils),
    varianceToleranceBp: row.variance_tolerance_bp,
  }
}

/** One recurring cost by its stable handle, or `null`. */
export async function findRecurringCostByCode(
  sql: Sql,
  code: string,
): Promise<RecurringCostRecord | null> {
  const [row] = await sql<RecurringCostRow[]>`
    select recurring_cost_id::text as recurring_cost_id, code, description,
           supplier_id::text as supplier_id, expense_account_code, tax_treatment, cadence,
           first_due_date::text as first_due_date, final_due_date::text as final_due_date,
           cost_kind,
           expected_amount_fils::text as expected_amount_fils,
           expected_min_fils::text  as expected_min_fils,
           expected_max_fils::text  as expected_max_fils,
           variance_tolerance_bp
      from recurring_cost where code = ${code}
  `
  return row === undefined ? null : shapeCost(row)
}

export interface GeneratedInstance {
  readonly recurringCostId: string
  readonly periodKey: string
  readonly dueDate: string
}

export interface GenerateWindow {
  /** Inclusive, and a business day the caller resolved. */
  readonly from: string
  /** How many calendar months the window covers. The window is `[from, from + months)`. */
  readonly months: number
  /** Narrows the generation to one cost. Absent means every cost in the register. */
  readonly recurringCostId?: string
}

/**
 * Writes the expected periods of every recurring cost whose due date falls in the window.
 *
 * Idempotent by construction: `recurring_cost_instance_one_per_period` is the primary key, and the
 * insert is `on conflict do nothing`. So a job that runs twice a day for a year produces one September,
 * which is the acceptance's "no duplicates" — a property of the table rather than of this function.
 *
 * The expectation is copied onto each period as it stands **now**. That is the snapshot the variance is
 * later measured against, and it is why a rent renegotiated in June cannot change what March was told.
 *
 * The occurrences come from `recurring_cost_forward_schedule()` — the same function the forecast reads.
 * See the module header for why there is deliberately not a second enumeration.
 */
export async function generateRecurringInstances(
  uow: UnitOfWork,
  window: GenerateWindow,
): Promise<readonly GeneratedInstance[]> {
  assertIsoDate('from', window.from)
  if (!Number.isInteger(window.months) || window.months < 1) {
    throw new AppError(
      'validation',
      `A generation window covers at least one month; received ${window.months}`,
    )
  }

  const rows = await uow.sql<{ recurring_cost_id: string; period_key: string; due_date: string }[]>`
    insert into recurring_cost_instance (
      recurring_cost_id, period_key, due_date, cost_kind,
      expected_amount_fils, expected_min_fils, expected_max_fils, variance_tolerance_bp
    )
    select s.recurring_cost_id, s.period_key, s.due_date, c.cost_kind,
           c.expected_amount_fils, c.expected_min_fils, c.expected_max_fils,
           c.variance_tolerance_bp
      from recurring_cost_forward_schedule(${window.from}::date, ${window.months}::integer) s
      join recurring_cost c on c.recurring_cost_id = s.recurring_cost_id
     where (${window.recurringCostId ?? null}::uuid is null
            or s.recurring_cost_id = ${window.recurringCostId ?? null}::uuid)
    on conflict (recurring_cost_id, period_key) do nothing
    returning recurring_cost_id::text as recurring_cost_id, period_key,
              due_date::text as due_date
  `

  return rows.map((row) => ({
    recurringCostId: row.recurring_cost_id,
    periodKey: row.period_key,
    dueDate: row.due_date,
  }))
}

export interface PeriodStatus {
  readonly recurringCostId: string
  readonly code: string
  readonly periodKey: string
  readonly dueDate: string
  readonly costKind: RecurringCostKind
  readonly billId: string | null
  readonly supplierReference: string | null
  readonly actualGrossFils: bigint | null
  /** Signed. Null when nothing has been matched, because nothing arrived to differ. */
  readonly deltaFils: bigint | null
  readonly toleranceFils: bigint | null
  readonly overTolerance: boolean | null
  /** Past its due date as at the as-of business day. Due today is not late. */
  readonly isOverdue: boolean
}

/**
 * Every generated period as at a business day, with the bill matched to it and its variance.
 *
 * Read through `recurring_cost_period_status()` rather than by joining the tables here, so the job, this
 * package's sweep and any later report agree about which periods are a problem instead of each writing
 * the comparison again. Every money figure is a `bigint`: the driver returns the `fils` domain as a
 * string precisely so nothing rounds, and `trial-balance.ts` records the four-fils difference `Number`
 * produced out of nothing.
 */
export async function recurringCostPeriodStatus(
  sql: Sql,
  asOf: string,
  options: { readonly recurringCostId?: string } = {},
): Promise<readonly PeriodStatus[]> {
  assertIsoDate('asOf', asOf)
  const costId = options.recurringCostId ?? null
  const rows = await sql<
    {
      recurring_cost_id: string
      code: string
      period_key: string
      due_date: string
      cost_kind: string
      bill_id: string | null
      supplier_reference: string | null
      actual_gross_fils: string | null
      delta_fils: string | null
      tolerance_fils: string | null
      over_tolerance: boolean | null
      is_overdue: boolean
    }[]
  >`
    select recurring_cost_id::text as recurring_cost_id, code, period_key,
           due_date::text          as due_date,
           cost_kind,
           bill_id::text           as bill_id,
           supplier_reference,
           actual_gross_fils::text as actual_gross_fils,
           delta_fils::text        as delta_fils,
           tolerance_fils::text    as tolerance_fils,
           over_tolerance, is_overdue
      from recurring_cost_period_status(${asOf}::date)
     where (${costId}::uuid is null or recurring_cost_id = ${costId}::uuid)
  `
  return rows.map((row) => ({
    recurringCostId: row.recurring_cost_id,
    code: row.code,
    periodKey: row.period_key,
    dueDate: row.due_date,
    costKind: row.cost_kind as RecurringCostKind,
    billId: row.bill_id,
    supplierReference: row.supplier_reference,
    actualGrossFils: row.actual_gross_fils === null ? null : BigInt(row.actual_gross_fils),
    deltaFils: row.delta_fils === null ? null : BigInt(row.delta_fils),
    toleranceFils: row.tolerance_fils === null ? null : BigInt(row.tolerance_fils),
    overTolerance: row.over_tolerance,
    isOverdue: row.is_overdue,
  }))
}

export interface RaisedAlert {
  readonly alertId: string
  readonly recurringCostId: string
  readonly periodKey: string
  readonly alertKind: RecurringCostAlertKind
  /** Signed, and null for a missing cost: nothing arrived, so there is nothing to differ. */
  readonly deltaFils: number | null
  readonly toleranceFils: number | null
}

/**
 * Raises every alert the register owes as at `asOf`, and nothing it has raised before.
 *
 * One function, two callers — the nightly pass over every cost, and `matchBillToRecurringCost` over the
 * one period it just matched. A second implementation for the immediate case is how a variance comes to
 * be reported differently depending on whether a human or the cron noticed it first.
 *
 * "Exactly once across repeated runs" is `recurring_cost_alert_once_per_period_and_kind` plus
 * `on conflict do nothing`: the constraint, not the query, is what makes a daily job raise once per
 * incident. The returned rows are what this call actually inserted, so a caller can report "nothing new"
 * as a fact rather than as an absence of output.
 */
export async function sweepRecurringCostAlerts(
  uow: UnitOfWork,
  options: { readonly asOf: string; readonly recurringCostId?: string },
): Promise<readonly RaisedAlert[]> {
  assertIsoDate('asOf', options.asOf)
  const costId = options.recurringCostId ?? null

  const variance = await uow.sql<AlertRow[]>`
    insert into recurring_cost_alert (
      recurring_cost_id, period_key, alert_kind, delta_fils, tolerance_fils, detail, raised_for_date
    )
    select p.recurring_cost_id, p.period_key, 'variance_over_tolerance',
           p.delta_fils, p.tolerance_fils,
           -- Every figure as TEXT, deliberately. A jsonb number becomes a double the moment
           -- JSON.parse reads it, and this payload is what a person is shown about a money difference.
           jsonb_build_object(
             'code', p.code,
             'dueDate', p.due_date::text,
             'costKind', p.cost_kind,
             'expectedAmountFils', p.expected_amount_fils::text,
             'expectedMinFils', p.expected_min_fils::text,
             'expectedMaxFils', p.expected_max_fils::text,
             'varianceToleranceBp', p.variance_tolerance_bp,
             'actualGrossFils', p.actual_gross_fils::text,
             'supplierReference', p.supplier_reference
           ),
           ${options.asOf}::date
      from recurring_cost_period_status(${options.asOf}::date) p
     where p.over_tolerance
       -- The CHECK refuses a zero-delta variance alert. over_tolerance already implies a non-zero
       -- delta, because a tolerance is never negative; saying so here means a future change to the
       -- variance rule fails this insert rather than the constraint at 3am.
       and p.delta_fils <> 0
       and (${costId}::uuid is null or p.recurring_cost_id = ${costId}::uuid)
    on conflict (recurring_cost_id, period_key, alert_kind) do nothing
    returning alert_id::text as alert_id, recurring_cost_id::text as recurring_cost_id,
              period_key, alert_kind, delta_fils::text as delta_fils,
              tolerance_fils::text as tolerance_fils
  `

  const missing = await uow.sql<AlertRow[]>`
    insert into recurring_cost_alert (
      recurring_cost_id, period_key, alert_kind, detail, raised_for_date
    )
    select p.recurring_cost_id, p.period_key, 'missing_cost',
           jsonb_build_object(
             'code', p.code,
             'dueDate', p.due_date::text,
             'costKind', p.cost_kind,
             'expectedAmountFils', p.expected_amount_fils::text,
             'expectedMinFils', p.expected_min_fils::text,
             'expectedMaxFils', p.expected_max_fils::text
           ),
           ${options.asOf}::date
      from recurring_cost_period_status(${options.asOf}::date) p
     where p.is_overdue
       and p.bill_id is null
       and (${costId}::uuid is null or p.recurring_cost_id = ${costId}::uuid)
    on conflict (recurring_cost_id, period_key, alert_kind) do nothing
    returning alert_id::text as alert_id, recurring_cost_id::text as recurring_cost_id,
              period_key, alert_kind, null::text as delta_fils, null::text as tolerance_fils
  `

  return [...variance, ...missing].map(shapeAlert)
}

interface AlertRow {
  alert_id: string
  recurring_cost_id: string
  period_key: string
  alert_kind: string
  delta_fils: string | null
  tolerance_fils: string | null
}

function shapeAlert(row: AlertRow): RaisedAlert {
  return {
    alertId: row.alert_id,
    recurringCostId: row.recurring_cost_id,
    periodKey: row.period_key,
    alertKind: row.alert_kind as RecurringCostAlertKind,
    deltaFils: row.delta_fils === null ? null : Number(row.delta_fils),
    toleranceFils: row.tolerance_fils === null ? null : Number(row.tolerance_fils),
  }
}

export interface MatchInput {
  readonly recurringCostId: string
  readonly periodKey: string
  readonly billId: string
  readonly matchedBy: string
  /** The business day the match is being made on, used to date any alert it raises. */
  readonly asOf: string
}

export interface MatchResult {
  readonly matchId: string
  readonly recurringCostId: string
  readonly periodKey: string
  readonly billId: string
  /** The alerts this match raised. Empty when the bill landed inside tolerance. */
  readonly alerts: readonly RaisedAlert[]
}

/**
 * Attaches one bill to one expected period, and raises the variance alert if it earned one.
 *
 * In the same transaction, because an alert raised in a later pass is an alert that can be lost between
 * the two — and because the unique constraint is what makes the *second* attempt raise rather than
 * quietly overwrite the first.
 *
 * The bill's supplier must be the cost's supplier; `recurring_cost_match_supplier_agrees` refuses
 * otherwise with ZR002. That is the mis-keystroke this guard exists for: the laundry invoice matched to
 * the rent reports a large false variance, silences the rent's missing-cost alert and leaves the laundry
 * looking unbilled.
 */
export async function matchBillToRecurringCost(
  uow: UnitOfWork,
  input: MatchInput,
): Promise<MatchResult> {
  assertPeriodKey(input.periodKey)
  assertIsoDate('asOf', input.asOf)

  let matchId: string
  try {
    const [row] = await uow.sql<{ match_id: string }[]>`
      insert into recurring_cost_match (recurring_cost_id, period_key, bill_id, matched_by)
      values (
        ${input.recurringCostId}::uuid, ${input.periodKey}, ${input.billId}::uuid, ${input.matchedBy}
      )
      returning match_id::text as match_id
    `
    if (!row) {
      throw new AppError(
        'invariant_violated',
        `The match insert returned no row for ${input.recurringCostId} ${input.periodKey}`,
      )
    }
    matchId = row.match_id
  } catch (err) {
    throw recurringCostError(err) ?? err
  }

  const alerts = await sweepRecurringCostAlerts(uow, {
    asOf: input.asOf,
    recurringCostId: input.recurringCostId,
  })

  await uow.audit.record({
    action: 'purchases.recurring_cost.matched',
    entityType: 'recurring_cost_match',
    entityId: matchId,
    operation: 'create',
    after: {
      recurringCostId: input.recurringCostId,
      periodKey: input.periodKey,
      billId: input.billId,
      alerts: alerts.map((alert) => ({ kind: alert.alertKind, deltaFils: alert.deltaFils })),
    },
  })

  return {
    matchId,
    recurringCostId: input.recurringCostId,
    periodKey: input.periodKey,
    billId: input.billId,
    alerts,
  }
}

export interface RecurringBillToPost {
  /** The stable handle of the cost this invoice satisfies. */
  readonly recurringCostCode: string
  /** Which expected period it satisfies, as `YYYY-MM`. */
  readonly periodKey: string
  readonly supplierReference: string
  readonly billDate: string
  readonly dueDate: string
  /**
   * The **business day** the entry belongs to, already resolved with `resolveTradingDate` from
   * `@berelax/core`. Trading runs 11:00–02:00, so a bill entered at 01:30 belongs to the previous
   * trading date.
   */
  readonly entryDate: string
  readonly receivedBy: string
  /** VAT-inclusive and authoritative (ADR 0007): what the supplier actually charged. */
  readonly grossFils: number
  /** Derived from the gross by `deriveBillLine` in `@berelax/core`, never re-derived here. */
  readonly netFils: number
  /** The business day the match and any alert are dated on. Defaults to `entryDate`. */
  readonly asOf?: string
}

export interface PostedRecurringBill {
  readonly bill: PostedBill
  readonly match: MatchResult
}

/**
 * Posts the bill a recurring cost produced, and matches it to its period, in one transaction.
 *
 * **`postBill` does the posting.** This function builds the `BillToPost` from the definition and hands
 * it over; it does not write a journal entry, a bill or a bill line itself. Two ways to post a purchase
 * would be two answers to "what did we spend", and the register is not the place to introduce the
 * second one — which also means every guard `postBill` holds (the no-TRN refusal, the period lock, the
 * opening-date guard, the duplicate supplier reference) applies here unchanged.
 *
 * The line comes from the definition: its description, its expense account, its expected tax treatment.
 * The amounts come from the invoice, because what the register expected and what the supplier charged
 * are exactly the two numbers a variance is the difference between.
 */
export async function postRecurringBill(
  uow: UnitOfWork,
  input: RecurringBillToPost,
): Promise<PostedRecurringBill> {
  assertPeriodKey(input.periodKey)
  const cost = await findRecurringCostByCode(uow.sql, input.recurringCostCode)
  if (cost === null) {
    throw new AppError('not_found', `No recurring cost with code "${input.recurringCostCode}"`)
  }

  const bill: BillToPost = {
    supplierId: cost.supplierId,
    supplierReference: input.supplierReference,
    billDate: input.billDate,
    dueDate: input.dueDate,
    entryDate: input.entryDate,
    receivedBy: input.receivedBy,
    narrative: `${cost.description} — ${input.periodKey} (${cost.code})`,
    lines: [
      {
        description: cost.description,
        expenseAccountCode: cost.expenseAccountCode,
        taxTreatment: cost.taxTreatment as BillToPost['lines'][number]['taxTreatment'],
        grossFils: input.grossFils,
        netFils: input.netFils,
      },
    ],
  }

  const posted = await postBill(uow, bill)
  const match = await matchBillToRecurringCost(uow, {
    recurringCostId: cost.recurringCostId,
    periodKey: input.periodKey,
    billId: posted.billId,
    matchedBy: input.receivedBy,
    asOf: input.asOf ?? input.entryDate,
  })

  return { bill: posted, match }
}

/**
 * The trading date a pass run at `atIso` belongs to.
 *
 * Read from `business_day` — the materialised trading calendar, generated from the same rule
 * `resolveTradingDate` states — rather than by truncating the instant. Trading runs 11:00–02:00, so a
 * pass at 03:30 belongs to the session that opened the previous morning, and a calendar truncation would
 * date its alerts a day late and, at a month boundary, into a period that has already been filed.
 *
 * Returns `null` when the calendar holds nothing at or before the instant. The caller must refuse rather
 * than substitute a calendar date: an alert dated by a guess is an alert nobody can reconcile.
 */
export async function tradingDateAt(sql: Sql, atIso: string): Promise<string | null> {
  const [row] = await sql<{ trading_date: string }[]>`
    select trading_date::text as trading_date
      from business_day
     where opens_at <= ${atIso}::timestamptz
     order by opens_at desc
     limit 1
  `
  return row?.trading_date ?? null
}
