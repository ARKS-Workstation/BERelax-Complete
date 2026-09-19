import {
  type Actor,
  type ReverseChargeException,
  reverseChargeExceptions,
  type Sql,
  tradingDateAt,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The nightly reverse-charge exception report.
 *
 * docs/04 §4 asks for it by name: "flag suppliers offshore and run a nightly exception report on bills
 * lacking the reverse-charge pair". It exists because the failure is silent in a way nothing else in this
 * system is — a bill with no reverse charge posts, balances, reconciles to the supplier's invoice to the
 * fils and ages correctly in the payables report. The only thing wrong with it is a figure missing from a
 * return nobody has filed yet, and the report's whole job is to put that in front of somebody **before**
 * the return rather than during it.
 *
 * ## It never reports success silently
 *
 * An outbox event is written on **every** pass, including the passes that find nothing. A job that
 * published only on failure is indistinguishable from a job that has stopped running, which is the failure
 * docs/10 §6 describes and the reason `agent_heartbeat` exists at all. So an empty report is a row saying
 * "0 exceptions over 2026-09-19..2027-09-18" — evidence, not silence.
 *
 * ## Idempotent, because the report is derived and the event is keyed
 *
 * It accumulates nothing. The exceptions are a query over `bill`, `bill_line`, `journal_line` and the
 * supplier's current place-of-supply rule, ordered by business day and then by our own gapless reference —
 * so two passes over the same period return byte-identical rows. The outbox event's idempotency key is the
 * business day, so the second pass of a day publishes nothing new rather than a duplicate: the *database*
 * is what makes a repeated pass report once, exactly as `recurring_cost_alert`'s unique constraint is for
 * M-VAT-04. A job remembering "already reported" in its own state would publish a second copy the first
 * time that state was lost.
 *
 * ## What it deliberately does not do
 *
 * **It does not correct anything.** `bill` and `bill_line` are append-only (ADR 0017) and a missing reverse
 * charge is answered by a dated adjustment somebody prepares, not by a job rewriting a posted document. A
 * pass that "fixed" a pair would be a pass that restated a filed period with no trace, which is precisely
 * what the append-only ledger exists to prevent.
 *
 * ## The date is the business day, and it is refused rather than guessed
 *
 * Trading runs 11:00-02:00, so a pass at 04:15 belongs to the session that opened the previous morning.
 * `tradingDateAt` reads that from `business_day`, the materialised calendar generated from the same rule
 * `resolveTradingDate` states. If the calendar holds nothing this job **throws**: a window dated by
 * truncating a timestamp would be a day out, and at a month boundary it would scan a period that has
 * already been filed while missing the one that has not.
 */

/**
 * How far back a pass looks, in months.
 *
 * One full VAT year. Long enough that a bill inside any period anybody can still amend is seen — the point
 * of the report is to catch the figure before the return, and a return filed last quarter can still be
 * corrected — and short enough that the scan does not grow without bound over the life of the business. A
 * bill older than this is a matter for the tax agent rather than for a nightly job, and reporting it every
 * night for ever would be the 96-alerts-per-broken-agent failure that `0021_agent_registry.sql` describes.
 *
 * The same reasoning, and the same figure, as `RECURRING_COST_LOOK_BACK_MONTHS`.
 */
export const REVERSE_CHARGE_LOOK_BACK_MONTHS = 12

export interface ReverseChargeReportResult {
  /** The business day the pass was made for: the end of the window. */
  readonly asOf: string
  /** The start of the window, `REVERSE_CHARGE_LOOK_BACK_MONTHS` before `asOf`. */
  readonly from: string
  /** Every exception found, oldest first. Empty is the healthy answer and still an event. */
  readonly exceptions: readonly ReverseChargeException[]
  /**
   * The outbox row this pass wrote, or `null` when the day's event was already published.
   *
   * `null` is the idempotency working rather than a failure: the report itself is identical either way,
   * which is what the second run of a day asserts.
   */
  readonly eventId: string | null
}

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR: Actor = { kind: 'system', label: 'vat.reverse-charge-exceptions' }

/** The event type a consumer subscribes to. Stable: renaming it makes every past event undelivered. */
export const REVERSE_CHARGE_REPORT_EVENT = 'vat.reverse_charge.exceptions_reported'

/**
 * One pass, for the business day containing `atIso`.
 *
 * `atIso` is injected rather than read here, so the pass is reproducible: the integration test drives it at
 * a frozen clock and asserts that the second run returns identical rows and publishes nothing, which is
 * exactly what a job reading `new Date()` could not be asked.
 */
export async function runReverseChargeExceptionReport(
  sql: Sql,
  atIso: string,
): Promise<ReverseChargeReportResult> {
  const asOf = await tradingDateAt(sql, atIso)
  if (asOf === null) {
    throw new AppError(
      'invariant_violated',
      `The reverse-charge exception report ran at ${atIso} and business_day holds no trading session at ` +
        'or before it, so there is no business day to scan up to. Generate the trading calendar ' +
        '(generateBusinessDays) first: a window dated by truncating the timestamp would be a day out, ' +
        'and at a month boundary would scan a period that has already been filed.',
    )
  }
  const from = monthsBefore(asOf, REVERSE_CHARGE_LOOK_BACK_MONTHS)

  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const exceptions = await reverseChargeExceptions(uow.sql, { from, to: asOf })
    const eventId = await uow.publish({
      eventType: REVERSE_CHARGE_REPORT_EVENT,
      aggregateType: 'vat_period',
      aggregateId: asOf,
      payload: {
        from,
        to: asOf,
        // Published whether or not it is zero. A payload that omitted the count on a clean pass would make
        // "nothing was wrong" and "nothing ran" the same row.
        exceptionCount: exceptions.length,
        bills: exceptions.map((exception) => ({
          kind: exception.kind,
          reference: exception.reference,
          supplierCode: exception.supplierCode,
          supplierReference: exception.supplierReference,
          entryDate: exception.entryDate,
          // Strings: the driver returns the `fils` domain as a string and these are bigints in TypeScript,
          // which `JSON.stringify` refuses outright. `../../../packages/db/src/queries/trial-balance.ts`
          // documents why they are bigints in the first place.
          declaredFils: exception.declaredFils.toString(),
          reclaimedFils: exception.reclaimedFils.toString(),
          detail: exception.detail,
        })),
      },
      // The business day, so the second pass of a day publishes nothing rather than a duplicate. Derived
      // from the business fact and not from a random value, which is what makes a retry safe.
      idempotencyKey: `${REVERSE_CHARGE_REPORT_EVENT}:${asOf}`,
    })
    return { asOf, from, exceptions, eventId }
  })
}

/**
 * `date` minus whole months, clamped to the end of the target month.
 *
 * Spelled here rather than imported from `@berelax/core`'s `addMonths` for the reason
 * `recurring-cost-check.ts` gives for its own copy: this is the only date arithmetic in the module, and the
 * window's length is an operational choice of this job rather than part of any rule about when tax is due.
 */
function monthsBefore(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  const index = month - 1 - months
  const targetYear = year + Math.floor(index / 12)
  const targetMonth = (((index % 12) + 12) % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(Math.min(day, lastDay), 2)}`
}
