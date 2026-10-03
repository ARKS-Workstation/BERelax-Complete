import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The till facts an offline conversion is built from (A-MEAS-05).
 *
 * ## Facts and not statements, because `packages/db` may not import `packages/core`
 *
 * ADR 0001 runs the dependency the other way, so the arithmetic — which figure is pushed, what a void is
 * worth, how a correction is signed — is `conversionStatements` in `@berelax/core` and this module reads
 * the numbers it needs. That is not a formality: a second derivation of the conversion value here would be
 * the thing A-MEAS-07 then reports a variance about, with both sides internally consistent.
 *
 * ## Why an invoice is the conversion and an appointment is only one when there is no invoice
 *
 * An invoice may cover several appointments, so attributing its gross to each one would report the same
 * money two or three times — and the figure that matters is the DOCUMENT'S, because VAT-inclusive gross is
 * authoritative (ADR 0007) and the journal is keyed on the document. So the conversion is the invoice.
 *
 * A no-show has no invoice and is still a conversion that was already announced: the booking happened, and
 * what has to be pushed is the pair that sums to nothing. That is the second query, and it is deliberately
 * restricted to appointments with no invoice — a no-show that WAS invoiced is a late-cancellation charge
 * (0120's `late_cancellation`), which is money the salon kept and a conversion worth its gross rather than
 * one to void.
 *
 * ## What "offline" means here, and the one thing it cannot yet say
 *
 * `booking.source <> 'online'` — a front-desk, phone or walk-in booking, which is what
 * `BOOKING_SOURCE_ACTION_SOURCE` maps onto `physical_store` and `phone_call`. None of them had a browser
 * session, which is exactly why they need an offline upload.
 *
 * **It cannot say WHICH analytics session the conversion belongs to**, because nothing in this schema joins
 * one to a booking: A-FIRST-08 owns first- and last-touch attribution and is not built. So this module
 * returns the facts and the booking source, the pass takes the session from an injected resolver, and the
 * production resolver REFUSES by name rather than choosing a session — a confident answer derived from
 * nothing is worse than a counted refusal.
 */

/** One conversion's facts, as the till holds them. Every figure is integer fils (ADR 0007). */
export interface OfflineConversionFacts {
  /** `invoice`, `booking` or `package` — the aggregate kind the event id is derived over. */
  readonly aggregate: 'invoice' | 'booking' | 'package'
  readonly aggregateId: string
  readonly bookingId: string | null
  /** `front_desk`, `phone` or `walk_in`. Mapped onto an action source by the caller. */
  readonly bookingSource: string | null
  /** The authoritative gross for this conversion: the document's, or the estimate for a no-show. */
  readonly grossFils: number
  /** When the treatment, the payment or the sale HAPPENED. Days before the pass, for an upload. */
  readonly occurredAtIso: string
  /** When the appointment became a no-show, or null. A void is owed exactly when this is set. */
  readonly noShowAtIso: string | null
  /** The total credited against this document, as a POSITIVE figure. The caller applies the sign. */
  readonly creditedFils: number
  readonly creditedAtIso: string | null
  /** What a package redemption released, and when. Null for everything that is not a redeemed package. */
  readonly releasedFils: number | null
  readonly releasedAtIso: string | null
}

const assertTradingDate = (tradingDate: string): void => {
  // A date and not an instant, because `trading_date` is a `date` and 01:30 belongs to the previous
  // trading day (ADR 0007's sibling rule). A timestamp cast here would silently move a late sale.
  if (/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) return
  throw new AppError(
    'validation',
    `An offline conversion pass was asked for trading date ${JSON.stringify(tradingDate)}, which is not ` +
      'a YYYY-MM-DD date. Trading runs 11:00-02:00, so an instant cast to a date here moves every sale ' +
      'after midnight onto the wrong day and the conversions with it.',
    { details: { tradingDate } },
  )
}

/**
 * Invoiced conversions for one trading date, for bookings that were not made online.
 *
 * `min(lower(a.period))` is the conversion's instant: the earliest treatment the document covers, which is
 * when the visit began. NOT `issued_at`, which is when the till printed the document — usually the same
 * evening and not always, and a platform dates every attribution window on this value.
 *
 * The credit total is summed over `credit_note` rather than read off `invoice_settlement.credited_fils`,
 * and the reason is the second column: a correction needs the INSTANT it was raised as well as the amount,
 * and the settlement view carries no instant. One source for both keeps them from disagreeing.
 */
export async function offlineInvoiceConversions(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<readonly OfflineConversionFacts[]> {
  assertTradingDate(query.tradingDate)
  const rows = await sql<
    {
      invoice_id: string
      booking_id: string | null
      booking_source: string | null
      gross_total: string
      occurred_at: Date
      credited_fils: string
      credited_at: Date | null
    }[]
  >`
    select i.id                       as invoice_id,
           i.booking_id,
           b.source                   as booking_source,
           i.gross_total::text        as gross_total,
           min(lower(a.period))       as occurred_at,
           coalesce(max(cn.credited_fils), 0)::text as credited_fils,
           max(cn.credited_at)        as credited_at
      from invoice i
      join booking b              on b.id = i.booking_id
      join invoice_appointment ia on ia.invoice_id = i.id
      join appointment a          on a.id = ia.appointment_id
      left join (
        select invoice_id,
               sum(gross_total) as credited_fils,
               max(issued_at)   as credited_at
          from credit_note
         group by invoice_id
      ) cn on cn.invoice_id = i.id
     where a.trading_date = ${query.tradingDate}::date
       and b.source <> 'online'
     group by i.id, i.booking_id, b.source, i.gross_total
     order by i.id
  `
  return rows.map((row) => ({
    aggregate: 'invoice' as const,
    aggregateId: row.invoice_id,
    bookingId: row.booking_id,
    bookingSource: row.booking_source,
    grossFils: Number(row.gross_total),
    occurredAtIso: row.occurred_at.toISOString(),
    noShowAtIso: null,
    creditedFils: Number(row.credited_fils),
    creditedAtIso: row.credited_at === null ? null : row.credited_at.toISOString(),
    releasedFils: null,
    releasedAtIso: null,
  }))
}

/**
 * No-shows with no invoice, for one trading date, for bookings that were not made online.
 *
 * The conversion is the BOOKING here and not a document, because there is no document: the aggregate id is
 * the booking's, which is what the on-page tag would have derived its id from, so the void lands on the
 * same conversion the announcement did.
 *
 * `appointment_status_history` supplies the instant the no-show was recorded. It is append-only (ADR 0008),
 * so `max(occurred_at)` over the transitions INTO `no_show` is the last word rather than a column somebody
 * may have overwritten — and a no-show that was later reversed shows as a further transition OUT, which is
 * why the status on the row is what decides whether a void is owed at all.
 */
export async function offlineNoShowConversions(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<readonly OfflineConversionFacts[]> {
  assertTradingDate(query.tradingDate)
  const rows = await sql<
    {
      booking_id: string
      booking_source: string | null
      gross_price_fils: string
      occurred_at: Date
      no_show_at: Date | null
    }[]
  >`
    select b.id                 as booking_id,
           b.source             as booking_source,
           a.gross_price_fils::text as gross_price_fils,
           lower(a.period)      as occurred_at,
           (select max(h.occurred_at)
              from appointment_status_history h
             where h.appointment_id = a.id
               and h.to_status = 'no_show') as no_show_at
      from appointment a
      join booking b on b.id = a.booking_id
     where a.trading_date = ${query.tradingDate}::date
       and b.source <> 'online'
       and a.status = 'no_show'
       and not exists (select 1 from invoice_appointment ia where ia.appointment_id = a.id)
     order by a.id
  `
  return rows.map((row) => ({
    aggregate: 'booking' as const,
    aggregateId: row.booking_id,
    bookingId: row.booking_id,
    bookingSource: row.booking_source,
    grossFils: Number(row.gross_price_fils),
    occurredAtIso: row.occurred_at.toISOString(),
    /*
     * The visit instant stands in when no transition is on file. A no-show with no history row is a row
     * whose status was set by a path that did not write one, and the alternative — leaving the instant
     * null and the void unpushed — would leave the original conversion standing at its full value, which
     * is the one outcome this whole unit exists to prevent.
     */
    noShowAtIso: (row.no_show_at ?? row.occurred_at).toISOString(),
    creditedFils: 0,
    creditedAtIso: null,
    releasedFils: null,
    releasedAtIso: null,
  }))
}

/**
 * Package sales and their redemptions for one trading date.
 *
 * Both halves, because the provisional `Y11-vat-package` position values the conversion at REDEMPTION and
 * pushes zero at the sale — so a sale and a redemption on the same day are two statements about one
 * package, and a pass that read only one of them would report the wrong half. The aggregate is the SALE,
 * so a redemption months later corrects the conversion the sale announced rather than opening a new one.
 *
 * A sale with several redemptions sums them: the liability is released a session at a time, and the
 * conversion the platform holds is the total released so far.
 */
export async function offlinePackageConversions(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<readonly OfflineConversionFacts[]> {
  assertTradingDate(query.tradingDate)
  const rows = await sql<
    {
      package_sale_id: string
      sold_at: Date
      price_fils: string
      released_fils: string | null
      released_at: Date | null
    }[]
  >`
    select s.id                 as package_sale_id,
           s.sold_at,
           s.price_fils::text   as price_fils,
           sum(r.released_fils)::text as released_fils,
           max(r.redeemed_at)   as released_at
      from package_sale s
      left join package_balance pb on pb.package_sale_id = s.id
      left join package_redemption r on r.package_balance_id = pb.id
     where s.trading_date = ${query.tradingDate}::date
        or r.trading_date = ${query.tradingDate}::date
     group by s.id, s.sold_at, s.price_fils
     order by s.id
  `
  return rows.map((row) => ({
    aggregate: 'package' as const,
    aggregateId: row.package_sale_id,
    bookingId: null,
    /*
     * A package sale has no booking and therefore no booking source. The caller refuses rather than
     * defaulting: the value a default would reach is `website`, and a package sold at the counter is not a
     * web order. A-MEAS-05's NOTE on the manifest hands the channel to A-FIRST-08 with the attribution.
     */
    bookingSource: null,
    grossFils: Number(row.price_fils),
    occurredAtIso: row.sold_at.toISOString(),
    noShowAtIso: null,
    creditedFils: 0,
    creditedAtIso: null,
    releasedFils: row.released_fils === null ? null : Number(row.released_fils),
    releasedAtIso: row.released_at === null ? null : row.released_at.toISOString(),
  }))
}
