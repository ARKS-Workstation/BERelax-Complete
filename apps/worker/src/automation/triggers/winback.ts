import {
  type HoursForDate,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  STOCK_JOURNEY_KEYS,
  winbackDue,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { enrolAll, type TriggerOutcome } from './shared.ts'

/**
 * Who is due a win-back, measured on BUSINESS DAYS.
 *
 * C-AUTO-11. The arithmetic is `packages/core/src/automation/winback.ts` and nothing here repeats it:
 * this module reads each contact's last completed visit as an INSTANT and hands it to {@link winbackDue}
 * with the trading hours, which is what makes a visit that ended at 01:30 measure from the previous
 * business day rather than from the calendar date.
 *
 * ## Why the instant and not the trading date
 *
 * `appointment.trading_date` is already the business day, so reading it would make this module's answer
 * correct and its claim untestable: the one thing the acceptance line asks to be proved is that the
 * BUSINESS day is used, and a column that already holds it proves nothing about the arithmetic. More
 * importantly it would be the wrong reading for a visit the till backdated, and
 * `appointment_trading_date_fkey` does not stop that. So the end instant is read from the appointment's
 * period and resolved here, through the same `resolveTradingDate` everything else in this build uses —
 * and an instant in no session at all is a REFUSAL rather than a date (ADR 0070).
 *
 * ## Why the interval is an argument
 *
 * 90 days is C-AUTO-11's provisional value and lives in the F09 settings registry. Nothing in this file
 * or in `winback.ts` holds the figure.
 */

/** One contact and when their last completed visit ENDED. */
export interface WinbackCandidate {
  readonly customerId: string
  /** `upper(appointment.period)` as epoch milliseconds, or null for a contact who never visited. */
  readonly lastVisitEndedAt: Instant | null
}

/**
 * Every consented contact and the instant their last completed visit ended, as ONE query.
 *
 * The consent filter is in SQL and is also a condition node inside the journey. Not redundant: consent
 * can be withdrawn between this pass and the tag, and the journey's `not_eligible` exit is what records
 * that we identified somebody and did not act. Here it is an optimisation; there it is the rule.
 */
export async function readWinbackCandidates(sql: Sql): Promise<readonly WinbackCandidate[]> {
  const rows = await sql<{ customerId: string; endedAtMs: string | null }[]>`
    select c.id as "customerId",
           (extract(epoch from max(upper(a.period))) * 1000)::bigint::text as "endedAtMs"
      from customer c
      left join booking b on b.customer_id = c.id
      left join appointment a on a.booking_id = b.id and a.status = 'completed'
     where c.erased_at is null
       and (
         -- The LATEST record's kind, not the existence of a record: a contact who granted and then
         -- withdrew has two rows, and exists would pass them. This is a PRE-FILTER and not the
         -- authority — resolveConsent in @berelax/core is, and the gate runs it per message — but a
         -- pre-filter that let a withdrawn contact through would enrol them, and an enrolment is a thing
         -- somebody can see on a client record.
         select k.kind from consent k
          where k.contact_customer_id = c.id and k.channel = 'sms' and k.purpose = 'marketing'
          order by k.recorded_at desc, k.id desc
          limit 1
       ) = 'granted'
     group by c.id
  `
  return rows.map((row) => ({
    customerId: row.customerId,
    lastVisitEndedAt: row.endedAtMs === null ? null : (Number(row.endedAtMs) as Instant),
  }))
}

/** Enrol every contact whose win-back is due today, measured from their last visit's business day. */
export async function runWinbackTrigger(
  sql: Sql,
  args: {
    readonly today: LocalDate
    readonly hoursFor: HoursForDate
    readonly intervalDays: number
    readonly at: Date
  },
): Promise<TriggerOutcome & { readonly notMeasurable: number }> {
  const candidates = await readWinbackCandidates(sql)
  const due: string[] = []
  let notMeasurable = 0

  for (const candidate of candidates) {
    const decision = winbackDue({
      lastVisitEndedAt: candidate.lastVisitEndedAt,
      hoursFor: args.hoursFor,
      today: args.today,
      intervalDays: args.intervalDays,
    })
    // Counted rather than silently skipped: a contact whose last visit cannot be dated is a fact
    // somebody should be able to see, and a zero that hides them reads as "nobody is due".
    if (decision.kind === 'not_measurable') notMeasurable += 1
    if (decision.kind === 'due') due.push(candidate.customerId)
  }

  const outcome = await enrolAll(sql, {
    flowKey: STOCK_JOURNEY_KEYS.winback,
    customerIds: due,
    at: args.at,
  })
  return { ...outcome, notMeasurable }
}

/** The fixture salon's hours, as a `HoursForDate`. Trading 11:00-02:00, which crosses midnight. */
export function hoursFromPremises(
  rows: readonly { readonly dayOfWeek: number; readonly open: string; readonly close: string }[],
): HoursForDate {
  const byDay = new Map(rows.map((row) => [row.dayOfWeek, row]))
  return (date) => {
    // `LocalDate` is `YYYY-MM-DD`, so the day of week comes from a UTC midnight: the calendar date is
    // the same in every zone at that instant, and the day of week is a property of the date rather than
    // of a moment inside it.
    const day = new Date(`${date}T00:00:00Z`).getUTCDay()
    const row = byDay.get(day)
    return row === undefined
      ? undefined
      : { open: localTime(row.open), close: localTime(row.close) }
  }
}

/** `LocalDate` of an ISO instant's calendar date, for a caller that has one already. */
export const calendarDateOf = (iso: string): LocalDate => localDate(iso.slice(0, 10))
