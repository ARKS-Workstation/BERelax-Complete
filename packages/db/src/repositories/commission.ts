import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { periodStatusOn } from '../services/period-close.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Commission: the rule versions, the earnings a period recognised, and the runs that record them.
 *
 * The **arithmetic** is `packages/core/src/hr/commission.ts`'s and stays there — `packages/db` must never
 * import `packages/core` — so this module returns ROWS and takes computed lines, never a rate, a band or a
 * figure it worked out itself. `packages/hr/src/commission-run.ts` is where the two halves meet, for the
 * reason `packages/hr`'s own header gives, and `packages/fixtures/src/hr-commission.itest.ts` is where the
 * pair is asserted against a real database.
 *
 * ## The two reads, and why they are separate functions
 *
 * {@link readCommissionRuleVersions} returns EVERY version, oldest first, with its bands. Every version and
 * not the current one, which is the whole point of the table: a run over March must be judged by March's
 * version, and a "current row" read here would undo the versioning one layer up (`readAttendanceGraceRules`
 * says the same thing about the same shape). Unlike that one it returns `[]` rather than throwing on an
 * empty table, because empty is the ORDINARY state: Y9-commission's provisional answer is that no commission
 * structure is configured, so no version is seeded and the caller's job is to report that rather than to
 * treat it as a missing row.
 *
 * {@link readCommissionEarnings} is the figures. It answers "which appointments in this period were
 * completed, and had been paid for, AS AT a given instant" — and the instant is the argument that makes the
 * whole unit reproducible.
 *
 * ## `sourceAsOf`, and the defect it exists to refuse
 *
 * A commission run over a CLOSED month must read what the books said when they were closed. The failure
 * otherwise is silent and arrives later: a payment applied after the close, or a sale backdated into the
 * month, makes "completed and paid in March" a larger set than it was — so a recompute is correct arithmetic
 * over facts that postdate the payslip, and the figure differs from the one that was paid.
 *
 * So every clause of the read filters on `created_at <= sourceAsOf`, and {@link commissionPeriodSource}
 * decides what that instant is: for a period a `period_lock` covers it is the LOCK's own `locked_at`, and
 * for an open period it is the instant the run is computed at, stored on the run so a recompute uses the
 * same one. `assert_commission_run_reads_the_lock` (ZY076) refuses a run that disagrees.
 *
 * ## The period lock is read in ONE place, and that place is not here
 *
 * "Is this date inside a closed accounting period?" is {@link periodStatusOn} (M-VAT-06) over
 * `period_lock_for()`. {@link commissionPeriodSource} calls it and does not re-answer it; the `locked_at` it
 * then reads is a COLUMN of the row `periodStatusOn` has already identified, fetched by primary key, which
 * is not a second answer to which dates are closed. A run permitted by one reading of the lock and refused
 * by another is exactly the defect that arrangement prevents.
 *
 * ## What the database enforces without help from here
 *
 *   1. **A published version is immutable** — `refuse_commission_rule_change` (ZY071) for every role
 *      including the owner. Nothing here issues an UPDATE against a rule table.
 *   2. **A run and its lines are immutable** — `refuse_commission_run_change` (ZY072).
 *   3. **A line's band, rate and figure follow from the version it names** —
 *      `assert_commission_line_follows_its_rule` (ZY077), against `commission_fils_for()`. So a caller that
 *      wrote its own figures could not store them.
 *   4. **The header equals its lines** — `assert_commission_run_matches_its_lines` (ZY074), deferred.
 */

/** The SQLSTATEs `0097_hr_commission.sql` raises. Subclass range ZY071-ZY077 of the shared 'ZY' class. */
export const COMMISSION_SQLSTATE = {
  /** A published rule version or one of its bands was UPDATEd or DELETEd. */
  ruleImmutable: 'ZY071',
  /** A run or one of its lines was UPDATEd or DELETEd. */
  runImmutable: 'ZY072',
  /** A version's bands do not cover the value range from zero upwards in ascending order. */
  bandsLeaveAGap: 'ZY073',
  /** A run's header total or line count does not equal its lines. */
  headerDisagreesWithLines: 'ZY074',
  /** A run names a rule version that had not commenced when its period began. */
  versionNotYetInForce: 'ZY075',
  /** A run over a locked period does not read the figures as filed, or an open one names a lock. */
  ignoresTheLock: 'ZY076',
  /** A line's band, rate or figure does not follow from the rule version it names. */
  lineDoesNotFollowItsRule: 'ZY077',
} as const

/*
  Every instant parameter in this file is written `${value}::text::timestamptz`, and the `::text` is
  LOAD-BEARING.

  postgres.js infers a parameter's PostgreSQL type from the cast that follows it, so `${iso}::timestamptz`
  is sent as an OID 1184 parameter and serialised by the driver's own date serialiser —
  `new Date(value).toISOString()`, which is MILLISECOND precision. A `timestamptz` column holds
  MICROSECONDS, so `locked_at` of `…:13.123633+00` arrives as `…:13.123+00`: a different instant, three
  digits shorter, and every comparison against the stored value is then false.

  Measured, not reasoned. `select ${s}::timestamptz::text` returns `…677+00` for an `s` of `…677098+00`,
  while `select ${s}::text::timestamptz::text` returns it unchanged — and `psql` with the same literal is
  exact either way, which is why this cannot be found without going through the driver.

  It cost this unit three failing cases that all looked like a trigger bug: `assert_commission_run_reads_the_lock`
  (ZY076) refused every run over the filed month, reporting a `source_as_of` 633 microseconds before the
  `locked_at` the repository had just read out of the same row. `hr-commission.test.ts` scans this file for a
  bare `}::timestamptz`, because the next instant parameter added here would have the same defect and the
  symptom would again name the trigger.
*/

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(value: string, what: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO trading date (YYYY-MM-DD), got "${value}"`,
    )
  }
}

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * A commission refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message. The class no longer identifies a file
 * (0091's header records why), so `startsWith('ZY')` would claim four other units' refusals as this one's.
 */
export function commissionError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = Object.entries(COMMISSION_SQLSTATE).find(([, code]) => code === state)
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    'invariant_violated',
    error instanceof Error ? error.message : `Commission rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

// ---------------------------------------------------------------------------------------------
// The rule versions
// ---------------------------------------------------------------------------------------------

/** One band of a version. Structurally `CommissionBand` in `@berelax/core`. */
export interface CommissionRuleBandRow {
  readonly bandNo: number
  readonly fromFils: number
  readonly rateBp: number
}

/** One version with its bands. Structurally `CommissionRuleVersion` in `@berelax/core`. */
export interface CommissionRuleVersionRow {
  readonly ruleVersionId: string
  readonly version: number
  readonly effectiveFrom: string
  readonly basis: string
  readonly roundingMode: string
  readonly supersedesId: string | null
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
  readonly bands: readonly CommissionRuleBandRow[]
}

interface RuleHeaderRow {
  readonly ruleVersionId: string
  readonly version: number
  readonly effectiveFrom: string
  readonly basis: string
  readonly roundingMode: string
  readonly supersedesId: string | null
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/**
 * Every published version, oldest first, each with its bands in band order.
 *
 * Two statements rather than one join with an aggregate, and the reason is the band ORDER: `json_agg` over a
 * join orders by whatever the plan produced unless told otherwise, which is stable on a small table and
 * stops being stable the first time the planner parallelises — and the bands' order is what `bandNo` means.
 * Two ordered reads cannot have that problem.
 *
 * `[]` for an empty table, deliberately, unlike `readAttendanceGraceRules`: no version is seeded, because
 * Y9-commission's provisional answer is that no structure is configured. The caller reports that the module
 * has nothing to apply — `planCommissionRun` in `@berelax/core` — rather than treating it as a missing row.
 */
export async function readCommissionRuleVersions(
  sql: Sql,
): Promise<readonly CommissionRuleVersionRow[]> {
  const headers = await sql<RuleHeaderRow[]>`
    select id                 as "ruleVersionId",
           version,
           effective_from::text as "effectiveFrom",
           basis,
           rounding_mode      as "roundingMode",
           supersedes_id      as "supersedesId",
           is_provisional     as "isProvisional",
           open_question_id   as "openQuestionId",
           provisional_note   as "provisionalNote",
           source_note        as "sourceNote"
      from commission_rule
     order by effective_from, version
  `
  if (headers.length === 0) return []

  const bands = await sql<
    { ruleVersionId: string; bandNo: number; fromFils: string; rateBp: number }[]
  >`
    select rule_version_id as "ruleVersionId",
           band_no         as "bandNo",
           from_fils::text as "fromFils",
           rate_bp         as "rateBp"
      from commission_rule_band
     order by rule_version_id, band_no
  `
  const byVersion = new Map<string, CommissionRuleBandRow[]>()
  for (const band of bands) {
    const list = byVersion.get(band.ruleVersionId) ?? []
    // `from_fils` is a bigint and the driver returns one as a string precisely so nothing rounds a money
    // figure on the way here. This is the boundary where it becomes a number, and a threshold outside the
    // safe-integer range is refused rather than rounded into a different threshold.
    const fromFils = Number(band.fromFils)
    if (!Number.isSafeInteger(fromFils)) {
      throw new AppError(
        'invariant_violated',
        `commission_rule_band.from_fils is "${band.fromFils}", which does not survive the round trip to ` +
          'a JavaScript number. A threshold that rounds is a different threshold.',
      )
    }
    list.push({ bandNo: band.bandNo, fromFils, rateBp: band.rateBp })
    byVersion.set(band.ruleVersionId, list)
  }

  return headers.map((header) => ({ ...header, bands: byVersion.get(header.ruleVersionId) ?? [] }))
}

export interface PublishCommissionRuleVersionInput {
  readonly effectiveFrom: string
  readonly basis: 'net_of_vat' | 'gross_inclusive'
  readonly roundingMode: 'floor' | 'half_up'
  readonly bands: readonly CommissionRuleBandRow[]
  readonly sourceNote: string
  /**
   * Who published it, in the input rather than read off the unit of work, because `AuditWriter` keeps its
   * `Actor` private — `lockAccountingPeriod` takes `lockedByActorKind` for the same reason and writes the
   * same pair of columns. The audit row carries the actor independently, which is the point: the column is
   * the row's own provenance and the audit trail is the estate's, and they are written from one `Actor` by
   * one caller.
   */
  readonly publishedByActorKind: 'staff' | 'system'
  readonly publishedByActorId?: string | null
  readonly isProvisional?: boolean
  readonly openQuestionId?: string | null
  readonly provisionalNote?: string | null
}

/**
 * Publishes a NEW version, naming the latest existing one as superseded.
 *
 * The version NUMBER and `supersedes_id` are derived here rather than accepted, and that is the difference
 * between a versioned table and a table with a version column: a caller that supplied either could publish
 * version 3 twice, or supersede a version that something else had already superseded. `commission_rule`'s
 * UNIQUE on `version` would catch the first; nothing would catch the second, because superseding is not
 * exclusive in this schema — a version is superseded by a LATER one existing, which is why the column is
 * provenance rather than a lock.
 *
 * There is no `updateCommissionRuleVersion`, and there never will be: `refuse_commission_rule_change`
 * (ZY071) refuses every UPDATE for every role, so an edit is not something a code path can do.
 */
export async function publishCommissionRuleVersion(
  uow: UnitOfWork,
  input: PublishCommissionRuleVersionInput,
): Promise<{ readonly ruleVersionId: string; readonly version: number }> {
  assertIsoDate(input.effectiveFrom, 'effectiveFrom')
  if (input.bands.length === 0) {
    throw new AppError(
      'validation',
      'A commission rule version needs at least one band. An empty version is not a zero-rate policy: ' +
        'it is a version somebody forgot to finish, and ZY073 refuses it at COMMIT anyway.',
    )
  }

  const [latest] = await uow.sql<{ id: string; version: number }[]>`
    select id, version from commission_rule order by version desc limit 1
  `

  const [row] = await uow.sql<{ id: string; version: number }[]>`
    insert into commission_rule (
      version, effective_from, basis, rounding_mode, supersedes_id,
      published_by_actor_kind, published_by_actor_id,
      is_provisional, open_question_id, provisional_note, source_note
    ) values (
      ${(latest?.version ?? 0) + 1}, ${input.effectiveFrom}::date, ${input.basis},
      ${input.roundingMode}, ${latest?.id ?? null},
      ${input.publishedByActorKind}, ${input.publishedByActorId ?? null},
      ${input.isProvisional ?? true}, ${input.openQuestionId ?? null},
      ${input.provisionalNote ?? null}, ${input.sourceNote}
    )
    returning id, version
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'insert into commission_rule returned no row')
  }

  for (const band of input.bands) {
    // One statement per band rather than a multi-row INSERT, for `issueInvoice`'s reason: a multi-row
    // insert hides a per-band failure behind whichever row the planner reached first.
    await uow.sql`
      insert into commission_rule_band (rule_version_id, band_no, from_fils, rate_bp)
      values (${row.id}::uuid, ${band.bandNo}, ${band.fromFils}, ${band.rateBp})
    `
  }

  await uow.audit.record({
    action: 'hr.commission.rule_published',
    entityType: 'commission_rule',
    entityId: row.id,
    operation: 'create',
    // No `before`: a published version has no prior version of ITSELF. The one it supersedes is named in
    // `after`, which is the honest shape — a fabricated `before` would record an edit that never happened.
    after: {
      version: row.version,
      effectiveFrom: input.effectiveFrom,
      basis: input.basis,
      roundingMode: input.roundingMode,
      supersedesId: latest?.id ?? null,
      bands: input.bands,
    },
  })

  return { ruleVersionId: row.id, version: row.version }
}

// ---------------------------------------------------------------------------------------------
// The earnings
// ---------------------------------------------------------------------------------------------

/** The instant a period's figures are read at, and which lock (if any) decided it. */
export interface CommissionPeriodSource {
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly earliestOpenDate: string
}

/**
 * The instant a run over this period must read its source figures at.
 *
 * For a period a lock covers, the lock's own `locked_at`: the books as filed. For an open period, `nowIso` —
 * which the caller supplies rather than this function reading a clock, so that a test can freeze it and a
 * recompute can pass the instant the first run stored.
 *
 * `periodStatusOn` answers whether the end date is closed and which lock covers it; the `locked_at` read
 * below is a column of THAT row, by primary key. Not a second reader of the lock: the predicate is asked
 * once, in the one place that owns it.
 */
export async function commissionPeriodSource(
  sql: Sql,
  args: { readonly periodEndsOn: string; readonly nowIso: string },
): Promise<CommissionPeriodSource> {
  assertIsoDate(args.periodEndsOn, 'periodEndsOn')
  const status = await periodStatusOn(sql, args.periodEndsOn)
  if (!status.closed || status.periodId === null) {
    return {
      sourceAsOf: args.nowIso,
      lockedPeriodId: null,
      earliestOpenDate: status.earliestOpenDate,
    }
  }
  const [row] = await sql<{ lockedAt: string }[]>`
    select locked_at::text as "lockedAt" from period_lock where period_id = ${status.periodId}
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      // Deliberately does NOT spell the lock function's name: `hr-commission.test.ts` scans this file for a
      // second caller of the period-lock predicate over the text with comments stripped and string literals
      // KEPT — it has to keep them, because the SQL it also scans lives in a template literal — so a
      // message naming the function would read as a second call. That calibration is the one
      // `hr-attendance.test.ts` records getting wrong first time, from the other side.
      `The period-lock reader named "${status.periodId}" for ${args.periodEndsOn} and no such lock row ` +
        'exists.',
    )
  }
  return {
    sourceAsOf: row.lockedAt,
    lockedPeriodId: status.periodId,
    earliestOpenDate: status.earliestOpenDate,
  }
}

/** One appointment that recognised a value. Structurally `CommissionEarning` in `@berelax/core`. */
export interface CommissionEarningRow {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly source: 'invoice_line' | 'package_redemption'
  readonly invoiceId: string | null
  readonly packageRedemptionId: string | null
  readonly grossFils: number
  readonly vatFils: number
}

interface EarningSqlRow {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly source: string
  readonly invoiceId: string | null
  readonly packageRedemptionId: string | null
  readonly grossFils: string
  readonly vatFils: string
}

/**
 * Every appointment in the period that a commission is due on, as the books stood at `sourceAsOf`.
 *
 * ## What "due on" means, clause by clause
 *
 * **COMPLETED.** `appointment.status = 'completed'`. A no-show and a cancellation are not treatments, and
 * neither is a booking still in the diary — `holds_resources` is GENERATED from that enum (0024) and is a
 * different question, so the status is compared directly rather than through it.
 *
 * **PAID.** The applied tenders against the document, counted as at `sourceAsOf`, reach its gross. The
 * comparison is against `invoice.gross_total` and NOT `invoice_payable_fils()`, which adds the gratuity the
 * document's own posting collected: a tip is not consideration for a supply, so a fully paid treatment with
 * an unpaid tip is still a paid treatment, and requiring the tip would withhold commission on a figure the
 * customer was never invoiced for. A partly paid document reaches nothing, which is the acceptance line's
 * "a completed-but-unpaid visit produces zero lines".
 *
 * **NOT CREDITED.** A document with a credit note against it as at `sourceAsOf` is excluded whole. This is
 * the strictest safe reading and it is a judgement rather than a figure: money returned to a customer is
 * not revenue the salon kept, and of the two available errors — paying commission on a refunded treatment,
 * or withholding it until somebody looks — only the second is recoverable. Whether a credit note issued
 * AFTER a commission was paid claws it back is a different question, is nobody's rule yet, and is recorded
 * on Y9-commission.
 *
 * **A REDEMPTION needs no payment test.** The consideration was collected at the SALE, and
 * `package_redemption` exists only because a journal entry released recognised revenue (0083): the row IS
 * the recognition. The value is `released_fils`, the redemption's own recognised figure — never the package
 * sale value, which would pay the whole course on the first visit.
 *
 * ## Every clause is filtered on `created_at <= sourceAsOf`
 *
 * Including the appointment and the link row, not just the payments. A sale backdated into a filed month
 * carries a `trading_date` inside it and a `created_at` after the lock, and filtering only the payments
 * would let the whole appointment in.
 */
export async function readCommissionEarnings(
  sql: Sql,
  args: {
    readonly periodStartsOn: string
    readonly periodEndsOn: string
    readonly sourceAsOf: string
  },
): Promise<readonly CommissionEarningRow[]> {
  assertIsoDate(args.periodStartsOn, 'periodStartsOn')
  assertIsoDate(args.periodEndsOn, 'periodEndsOn')

  const rows = await sql<EarningSqlRow[]>`
    select a.id                     as "appointmentId",
           a.therapist_id           as "employeeId",
           a.trading_date::text     as "tradingDate",
           'invoice_line'           as source,
           i.id                     as "invoiceId",
           null::uuid               as "packageRedemptionId",
           il.line_gross_fils::text as "grossFils",
           il.line_vat_fils::text   as "vatFils"
      from appointment a
      join invoice_appointment ia on ia.appointment_id = a.id
      join invoice i on i.id = ia.invoice_id
      join invoice_line il on il.invoice_id = i.id and il.line_no = ia.line_no
     where a.status = 'completed'
       and a.trading_date between ${args.periodStartsOn}::date and ${args.periodEndsOn}::date
       and a.created_at  <= ${args.sourceAsOf}::text::timestamptz
       and ia.created_at <= ${args.sourceAsOf}::text::timestamptz
       and i.created_at  <= ${args.sourceAsOf}::text::timestamptz
       and coalesce((
             select sum(p.applied_fils)
               from payment p
              where p.invoice_id = i.id
                and p.created_at <= ${args.sourceAsOf}::text::timestamptz
           ), 0) >= i.gross_total
       and not exists (
             select 1 from credit_note cn
              where cn.invoice_id = i.id
                and cn.created_at <= ${args.sourceAsOf}::text::timestamptz
           )
    union all
    select a.id                   as "appointmentId",
           a.therapist_id         as "employeeId",
           a.trading_date::text   as "tradingDate",
           'package_redemption'   as source,
           null::uuid             as "invoiceId",
           pr.id                  as "packageRedemptionId",
           pr.released_fils::text as "grossFils",
           pr.vat_fils::text      as "vatFils"
      from appointment a
      join package_redemption pr on pr.appointment_id = a.id
     where a.status = 'completed'
       and a.trading_date between ${args.periodStartsOn}::date and ${args.periodEndsOn}::date
       and a.created_at  <= ${args.sourceAsOf}::text::timestamptz
       and pr.created_at <= ${args.sourceAsOf}::text::timestamptz
    order by "tradingDate", "appointmentId"
  `

  return rows.map((row) => ({
    appointmentId: row.appointmentId,
    employeeId: row.employeeId,
    tradingDate: row.tradingDate,
    // The union's literal is a `text` to PostgreSQL, so it arrives as a string and is narrowed here. A cast
    // would have been enough for the compiler and would not have caught a third source added to one branch
    // of the union and not to this map.
    source: row.source === 'package_redemption' ? 'package_redemption' : 'invoice_line',
    invoiceId: row.invoiceId,
    packageRedemptionId: row.packageRedemptionId,
    grossFils: storedFils(row.grossFils, 'grossFils'),
    vatFils: storedFils(row.vatFils, 'vatFils'),
  }))
}

/**
 * A bigint money column as a number, refusing a value that does not survive the round trip.
 *
 * The driver returns a bigint as a STRING precisely so nothing rounds a money figure on the way here, and
 * this is the boundary where a value that cannot be represented exactly has to be refused rather than
 * billed. `filsFromStoredDigits` in `@berelax/core` is the same guard, and this package may not import it.
 */
function storedFils(value: string, what: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(
      'invariant_violated',
      `${what} is "${value}", which does not survive the round trip to a JavaScript number. A money ` +
        'figure that rounds is a different figure (ADR 0007).',
    )
  }
  return parsed
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/** A computed line, exactly as `commission_line` stores it. Structurally `CommissionLine` in core. */
export interface CommissionLineToRecord {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly source: 'invoice_line' | 'package_redemption'
  readonly invoiceId: string | null
  readonly packageRedemptionId: string | null
  readonly basisFils: number
  readonly bandNo: number
  readonly rateBp: number
  readonly commissionFils: number
}

export interface RecordCommissionRunInput {
  readonly ruleVersionId: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly moduleEnabled: boolean
  readonly lines: readonly CommissionLineToRecord[]
  /** The total the caller computed. NOT summed here — see below. */
  readonly totalFils: number
  /** Who ran it. In the input for {@link PublishCommissionRuleVersionInput}'s recorded reason. */
  readonly computedByActorKind: 'staff' | 'system'
  readonly computedByActorId?: string | null
}

export interface RecordedCommissionRun {
  readonly runId: string
  readonly totalFils: number
  readonly lineCount: number
}

/**
 * Records one run and its lines.
 *
 * ## Why the total ARRIVES rather than being summed here
 *
 * A PORT, exactly as `approveTimesheet`'s payable minutes are one. The total is `computeCommission`'s, from
 * `@berelax/core`, and this package may not import it — so the figure arrives typed and the row records it.
 * The reason that is better than summing the lines is the check it makes possible:
 * `assert_commission_run_matches_its_lines` (ZY074) compares the header to the rows at COMMIT, and a header
 * summed from the same rows could not disagree with them. Two independent figures, held equal by the
 * database, is what makes the derivation view's "sums exactly to the header total" a claim about anything.
 *
 * ## There is no `deleteCommissionRun`
 *
 * `refuse_commission_run_change` (ZY072) refuses every DELETE for every role. A run that is wrong is
 * corrected by running the period again, which is a new run whose whole purpose is to be compared with the
 * first — and the two being comparable is the acceptance criterion.
 */
export async function recordCommissionRun(
  uow: UnitOfWork,
  input: RecordCommissionRunInput,
): Promise<RecordedCommissionRun> {
  assertIsoDate(input.periodStartsOn, 'periodStartsOn')
  assertIsoDate(input.periodEndsOn, 'periodEndsOn')

  const [run] = await uow.sql<{ id: string }[]>`
    insert into commission_run (
      rule_version_id, period_starts_on, period_ends_on, source_as_of, locked_period_id,
      module_enabled, total_fils, line_count, computed_by_actor_kind, computed_by_actor_id
    ) values (
      ${input.ruleVersionId}::uuid, ${input.periodStartsOn}::date, ${input.periodEndsOn}::date,
      ${input.sourceAsOf}::text::timestamptz, ${input.lockedPeriodId},
      ${input.moduleEnabled}, ${input.totalFils}, ${input.lines.length},
      ${input.computedByActorKind}, ${input.computedByActorId ?? null}
    )
    returning id
  `
  if (run === undefined) {
    throw new AppError('invariant_violated', 'insert into commission_run returned no row')
  }

  for (const line of input.lines) {
    // `rule_version_id` is written from the RUN's input and not from the line, because the composite
    // foreign key makes them one fact: a line carrying its own version would be a second copy for the two
    // to disagree about, and the whole point of the pin is that they cannot.
    await uow.sql`
      insert into commission_line (
        run_id, rule_version_id, employee_id, appointment_id, source, invoice_id,
        package_redemption_id, trading_date, basis_fils, band_no, rate_bp, commission_fils
      ) values (
        ${run.id}::uuid, ${input.ruleVersionId}::uuid, ${line.employeeId}::uuid,
        ${line.appointmentId}::uuid, ${line.source}, ${line.invoiceId},
        ${line.packageRedemptionId}, ${line.tradingDate}::date, ${line.basisFils},
        ${line.bandNo}, ${line.rateBp}, ${line.commissionFils}
      )
    `
  }

  await uow.audit.record({
    action: 'hr.commission.run_computed',
    entityType: 'commission_run',
    entityId: run.id,
    operation: 'create',
    after: {
      ruleVersionId: input.ruleVersionId,
      periodStartsOn: input.periodStartsOn,
      periodEndsOn: input.periodEndsOn,
      sourceAsOf: input.sourceAsOf,
      lockedPeriodId: input.lockedPeriodId,
      moduleEnabled: input.moduleEnabled,
      totalFils: input.totalFils,
      lineCount: input.lines.length,
    },
  })

  return { runId: run.id, totalFils: input.totalFils, lineCount: input.lines.length }
}

/** One row of `commission_derivation`. */
export interface CommissionDerivationRow {
  readonly lineId: string
  readonly employeeId: string
  /** The employment record's internal handle. Never a display name (ADR 0020). */
  readonly staffReference: string
  readonly appointmentId: string
  readonly tradingDate: string
  readonly source: string
  readonly basisFils: number
  readonly bandNo: number
  readonly rateBp: number
  readonly commissionFils: number
  readonly ruleVersionId: string
  readonly ruleVersion: number
  readonly ruleBasis: string
  readonly ruleRoundingMode: string
  readonly runTotalFils: number
  readonly runLineCount: number
}

/**
 * One run's derivation, optionally for one employee, in the run's own order.
 *
 * `order by trading_date, appointment_id` — the same total order `computeCommission` produces, so a stored
 * run read back is comparable to a recomputed one line for line without either side sorting first.
 *
 * The RBAC decision is NOT made here. `mayReadCommissionDerivation` in `@berelax/core` owns it, because it
 * is a question about a role and an id and needs no I/O, and `packages/db` may not import the matrix at all
 * (brief rule 4). This function takes an employee filter and applies it; the caller is what refuses.
 */
export async function readCommissionDerivation(
  sql: Sql,
  args: { readonly runId: string; readonly employeeId?: string },
): Promise<readonly CommissionDerivationRow[]> {
  const rows = await sql<
    (Omit<
      CommissionDerivationRow,
      'basisFils' | 'commissionFils' | 'runTotalFils' | 'runLineCount'
    > & {
      basisFils: string
      commissionFils: string
      runTotalFils: string
      runLineCount: number
    })[]
  >`
    select line_id            as "lineId",
           employee_id        as "employeeId",
           staff_reference    as "staffReference",
           appointment_id     as "appointmentId",
           trading_date::text as "tradingDate",
           source,
           basis_fils::text   as "basisFils",
           band_no            as "bandNo",
           rate_bp            as "rateBp",
           commission_fils::text as "commissionFils",
           rule_version_id    as "ruleVersionId",
           rule_version       as "ruleVersion",
           rule_basis         as "ruleBasis",
           rule_rounding_mode as "ruleRoundingMode",
           run_total_fils::text  as "runTotalFils",
           run_line_count     as "runLineCount"
      from commission_derivation
     where run_id = ${args.runId}::uuid
       and (${args.employeeId ?? null}::uuid is null or employee_id = ${args.employeeId ?? null}::uuid)
     order by trading_date, appointment_id
  `
  return rows.map((row) => ({
    ...row,
    basisFils: storedFils(row.basisFils, 'basisFils'),
    commissionFils: storedFils(row.commissionFils, 'commissionFils'),
    runTotalFils: storedFils(row.runTotalFils, 'runTotalFils'),
  }))
}

/** One run header. */
export interface CommissionRunRow {
  readonly runId: string
  readonly ruleVersionId: string
  readonly ruleVersion: number
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly moduleEnabled: boolean
  readonly totalFils: number
  readonly lineCount: number
  readonly computedAt: string
}

/** The runs over a period, newest first. Several are expected: a recompute is a new run. */
export async function readCommissionRuns(
  sql: Sql,
  args: { readonly periodStartsOn: string; readonly periodEndsOn: string },
): Promise<readonly CommissionRunRow[]> {
  assertIsoDate(args.periodStartsOn, 'periodStartsOn')
  assertIsoDate(args.periodEndsOn, 'periodEndsOn')
  const rows = await sql<(Omit<CommissionRunRow, 'totalFils'> & { totalFils: string })[]>`
    select r.id                      as "runId",
           r.rule_version_id         as "ruleVersionId",
           v.version                 as "ruleVersion",
           r.period_starts_on::text  as "periodStartsOn",
           r.period_ends_on::text    as "periodEndsOn",
           r.source_as_of::text      as "sourceAsOf",
           r.locked_period_id        as "lockedPeriodId",
           r.module_enabled          as "moduleEnabled",
           r.total_fils::text        as "totalFils",
           r.line_count              as "lineCount",
           r.computed_at::text       as "computedAt"
      from commission_run r
      join commission_rule v on v.id = r.rule_version_id
     where r.period_starts_on = ${args.periodStartsOn}::date
       and r.period_ends_on   = ${args.periodEndsOn}::date
     order by r.computed_at desc, r.id desc
  `
  return rows.map((row) => ({ ...row, totalFils: storedFils(row.totalFils, 'totalFils') }))
}
