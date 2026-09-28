import type { Sql } from '../connection.ts'

/**
 * What the till screen reads (M-TILL-13).
 *
 * Four readers, each answering one question the screens ask on every load: who the issuer is, which
 * delivered treatments are still unbilled, which package entitlements can still be drawn on, and what the
 * package catalogue currently holds. Nothing here writes, derives a price or decides an account — the
 * writers are `finaliseCheckout`, `sellPackage`, `redeemPackage` and `closeCashSession`, and the arithmetic
 * is `@berelax/core`'s.
 *
 * Every money column comes back as a **string**, because `fils_nonneg` is a `bigint` domain and
 * `createConnection` maps `bigint` to a string rather than to a lossy JS number (ADR 0007). The caller turns
 * it into `Money` through `filsFromStoredDigits`, which is the boundary where a figure that does not survive
 * the round trip is refused rather than published.
 */

/**
 * The issuer, exactly as `legal_entity` and `premises` hold it — placeholder TRN included.
 *
 * **Deliberately not validated here.** `requireIssuerTrn` in `@berelax/core` is "the only way to get a TRN
 * onto a document", and a reader that threw would make the till unable to draw the screen that explains why
 * it cannot issue one. Today `trn` is `TRN-PENDING-Y1-TRN` (Y1-trn), which fails
 * `invoice_issuer_trn_is_fifteen_digits`, `invoice_issuer_trn_not_placeholder` and `requireIssuerTrn` — so
 * the screen renders the absence and the ISSUE path refuses. Structurally a mirror of
 * `@berelax/core`'s `IssuerSnapshot`, because `packages/db` may never import `packages/core`.
 */
export interface TillIssuerRow {
  readonly legalName: string
  readonly tradingName: string
  /** Null when nobody has entered one; the placeholder string when somebody has entered the stand-in. */
  readonly trn: string | null
  readonly addressLines: readonly string[]
  readonly emirate: string
  readonly phone?: string
  readonly licenceNumber?: string
  /** `is_placeholder_text(trn)`, evaluated by PostgreSQL so one function decides it (0026). */
  readonly trnIsPlaceholder: boolean
}

/** The issuer, or null when `legal_entity` has no row — which means a migration did not run. */
export async function readTillIssuer(sql: Sql): Promise<TillIssuerRow | null> {
  const [row] = await sql<
    {
      legal_name: string
      trading_name: string
      trn: string | null
      trade_licence_number: string | null
      emirate: string
      address_line_1: string
      address_line_2: string | null
      floor: string | null
      area: string
      phone_landline: string | null
      trn_is_placeholder: boolean
    }[]
  >`
    select e.legal_name, e.trading_name, e.trn, e.trade_licence_number, e.emirate,
           p.address_line_1, p.address_line_2, p.floor, p.area, p.phone_landline,
           is_placeholder_text(e.trn) as trn_is_placeholder
      from legal_entity e
      cross join premises p
     where e.id = 1 and p.id = 1
  `
  if (row === undefined) return null
  // Assembled in issue order and blank lines dropped, so an absent `address_line_2` does not become an
  // empty line on a document. The joining is `issuerAddressSnapshot`'s in `@berelax/core`; this only
  // decides which fields are lines.
  const addressLines = [row.address_line_1, row.address_line_2, row.floor, row.area, row.emirate]
    .filter((line): line is string => line !== null && line.trim() !== '')
    .map((line) => line.trim())
  return {
    legalName: row.legal_name,
    tradingName: row.trading_name,
    trn: row.trn,
    addressLines,
    emirate: row.emirate,
    ...(row.phone_landline === null ? {} : { phone: row.phone_landline }),
    ...(row.trade_licence_number === null ? {} : { licenceNumber: row.trade_licence_number }),
    trnIsPlaceholder: row.trn_is_placeholder,
  }
}

/** One delivered treatment the till may still bill, with the price snapshotted onto the appointment. */
export interface TillBillableAppointmentRow {
  readonly appointmentId: string
  readonly serviceVariantId: string
  readonly tradingDate: string
  /** Composed from the catalogue for the screen. Never a person's name (brief rule 10). */
  readonly description: string
  readonly grossFils: string
  readonly netFils: string
  readonly vatFils: string
  readonly vatRateBp: number
  readonly customerId: string | null
  /** `Customer 0042` style, or null for a walk-in with no record (ADR 0014). */
  readonly customerLabel: string | null
  readonly startsAt: Date
}

/**
 * The delivered treatments on one business day that no document and no redemption has settled.
 *
 * "Settled" is read from BOTH tables, because there are two ways an appointment stops being billable and
 * `ZG011` exists precisely because they live apart: `invoice_appointment` says a document charged it, and
 * `package_redemption` says an entitlement covered it. A reader that consulted only the first would offer
 * the desk an appointment the customer has already paid for in advance, and the till's insert would then be
 * refused by a trigger — telling the operator about a constraint instead of not offering the row.
 *
 * `status = 'completed'` and not "not cancelled": `BILLABLE_APPOINTMENT_STATUSES` in `@berelax/core` is
 * derived from B-LIFE-01's table and is exactly `['completed']`, because "booking value is a guess, the till
 * knows the truth" (docs/03 §2). The literal is spelled here because `packages/db` may never import
 * `packages/core`; `apps/web/src/till-render.test.ts` holds the two equal.
 */
export async function readBillableAppointments(
  sql: Sql,
  tradingDate: string,
): Promise<readonly TillBillableAppointmentRow[]> {
  return sql<TillBillableAppointmentRow[]>`
    select a.id                                as "appointmentId",
           a.service_variant_id                as "serviceVariantId",
           a.trading_date::text                as "tradingDate",
           s.style::text || ' ' || s.treatment_key || ', '
             || v.duration_minutes::text || ' min'
                                               as description,
           a.gross_price_fils                  as "grossFils",
           a.net_fils                          as "netFils",
           a.vat_fils                          as "vatFils",
           a.vat_rate_bp                       as "vatRateBp",
           b.customer_id                       as "customerId",
           c.display_name                      as "customerLabel",
           lower(a.period)                     as "startsAt"
      from appointment a
      join service_variant v on v.id = a.service_variant_id
      join service s on s.id = v.service_id
      left join booking b on b.id = a.booking_id
      left join customer c on c.id = b.customer_id
     where a.trading_date = ${tradingDate}::date
       and a.status = 'completed'
       and not exists (
             select 1 from invoice_appointment ia
              where ia.appointment_id = a.id and ia.line_no is not null
           )
       and not exists (
             select 1 from package_redemption pr where pr.appointment_id = a.id
           )
     order by lower(a.period), a.id
  `
}

/** An entitlement the desk may draw a treatment against today. */
export interface TillRedeemableBalanceRow {
  readonly balanceId: string
  readonly packageSaleId: string
  readonly serviceVariantId: string
  readonly sessionsTotal: number
  readonly sessionsRedeemed: number
  readonly valueFils: string
  readonly releasedFils: string
  readonly expiresOn: string
  readonly customerId: string
  readonly customerLabel: string | null
  /** The template version's internal name, which is what a posting's memo carries. */
  readonly packageLabel: string
  readonly publicDisplayName: string
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
}

/**
 * EVERY balance — expired ones and fully drawn ones included — with what it has released.
 *
 * Deliberately unfiltered, and the two exclusions a "redeemable" reader would make are both wrong here:
 *
 *   - an EXPIRED balance still shows, because under the provisional retained-balance policy
 *     (Y9-package-policy) the customer is still owed the treatments. A balance that vanished the day it
 *     expired would leave the desk unable to see the thing it has to explain, and `redeemPackage` refuses the
 *     redemption anyway — with `PackageExpired`, and ZG010 refuses it again in SQL;
 *   - a FULLY DRAWN balance still shows, because `fully used` is one of the four drawdown states docs/12 §5
 *     asks the fixture salon to hold, and filtering it out makes that state invisible on the one screen built
 *     to display it. The first version of this reader filtered `sessions_redeemed < sessions_total` and the
 *     browser suite caught it: the state was seeded, correct in the rows, and unreachable on the page.
 *
 * Which of them the REDEEM control may offer is the caller's decision, not this reader's: `/packages` narrows
 * the select to the ones a redemption would be accepted for, because offering a control known to fail is
 * worse than not offering it.
 */
export async function readPackageBalances(
  sql: Sql,
  onDate: string,
): Promise<readonly TillRedeemableBalanceRow[]> {
  return sql<TillRedeemableBalanceRow[]>`
    select pb.id                          as "balanceId",
           ps.id                          as "packageSaleId",
           pb.service_variant_id          as "serviceVariantId",
           pb.sessions_total              as "sessionsTotal",
           pb.sessions_redeemed           as "sessionsRedeemed",
           pb.value_fils                  as "valueFils",
           pb.released_fils               as "releasedFils",
           ps.expires_on::text            as "expiresOn",
           ps.customer_id                 as "customerId",
           c.display_name                 as "customerLabel",
           tv.internal_name               as "packageLabel",
           tv.public_display_name         as "publicDisplayName",
           tv.is_provisional              as "isProvisional",
           tv.open_question_id            as "openQuestionId"
      from package_balance pb
      join package_sale ps on ps.id = pb.package_sale_id
      join package_template_version tv on tv.id = ps.template_version_id
      left join customer c on c.id = ps.customer_id
     order by (ps.expires_on < ${onDate}::date), ps.expires_on, pb.id
  `
}

/** A package the desk may sell, at its current version. */
export interface TillPackageTemplateRow {
  readonly templateId: string
  readonly templateKey: string
  readonly versionId: string
  readonly version: number
  readonly internalName: string
  readonly publicDisplayName: string
  readonly priceFils: string
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly sessionCount: number
  /** How many sales of this template exist, and how far through them the customers are. */
  readonly salesCount: number
  readonly sessionsRedeemed: number
  readonly sessionsSold: number
}

/**
 * Every live template at `max(version)`, with the drawdown its sales have reached.
 *
 * `max(version)` rather than a `current_version_id` pointer, for `currentPackageTemplateVersion`'s reason: a
 * pointer is a second answer to a question `max()` already answers, and its failure mode is a pointer at a
 * version a later insert superseded. `retired_at is null` filters a retired template out of the sell list
 * while its existing balances stay redeemable, which is what retirement means.
 */
export async function readPackageTemplates(sql: Sql): Promise<readonly TillPackageTemplateRow[]> {
  return sql<TillPackageTemplateRow[]>`
    with head as (
      select distinct on (tv.template_id)
             tv.id, tv.template_id, tv.version, tv.internal_name, tv.public_display_name,
             tv.price_fils, tv.validity_months, tv.transferable, tv.unredeemed_balance_policy,
             tv.is_provisional, tv.open_question_id
        from package_template_version tv
        join package_template t on t.id = tv.template_id
       where t.retired_at is null
       order by tv.template_id, tv.version desc
    )
    select t.id                                   as "templateId",
           t.template_key                         as "templateKey",
           h.id                                   as "versionId",
           h.version                              as version,
           h.internal_name                        as "internalName",
           h.public_display_name                  as "publicDisplayName",
           h.price_fils                           as "priceFils",
           h.validity_months                      as "validityMonths",
           h.transferable                         as transferable,
           h.unredeemed_balance_policy            as "unredeemedBalancePolicy",
           h.is_provisional                       as "isProvisional",
           h.open_question_id                     as "openQuestionId",
           coalesce(lines.sessions, 0)::int       as "sessionCount",
           coalesce(sales.sales, 0)::int          as "salesCount",
           coalesce(drawn.redeemed, 0)::int       as "sessionsRedeemed",
           coalesce(drawn.total, 0)::int          as "sessionsSold"
      from head h
      join package_template t on t.id = h.template_id
      left join (
        select template_version_id, sum(session_count) as sessions
          from package_template_line group by template_version_id
      ) lines on lines.template_version_id = h.id
      left join (
        select template_version_id, count(*) as sales
          from package_sale group by template_version_id
      ) sales on sales.template_version_id = h.id
      left join (
        select ps.template_version_id,
               sum(pb.sessions_redeemed) as redeemed,
               sum(pb.sessions_total)    as total
          from package_balance pb
          join package_sale ps on ps.id = pb.package_sale_id
         group by ps.template_version_id
      ) drawn on drawn.template_version_id = h.id
     order by t.template_key
  `
}
