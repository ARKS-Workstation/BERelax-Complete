import type { Sql } from '../connection.ts'

/**
 * What the public booking page needs to render its first three steps, and nothing more.
 *
 * `queryAvailability` (B-AVAIL-07) answers *which starts are offerable*, and it is answered about a
 * concrete `(trading date, service variant, therapist?)`. A booking page cannot ask that question until it
 * knows which variants exist, which trading dates are open, and what to call a therapist somebody arrived
 * with — three reads that are not availability and that nothing else in this package exposes:
 *
 *   - **the priced variants, with their ids.** `/api/facts` publishes the menu with prices and *no ids*
 *     (`priceVariantSchema`: a duration and an amount), which is right for a citation and useless for a
 *     request: `AvailabilityRequest.serviceVariantId` is a uuid. So the page reads the ids here rather
 *     than matching a name back to a row, which is the lookup that eventually matches the wrong one.
 *   - **the open trading dates from an instant.** A day strip is the next few *trading* dates, and a
 *     closed date is ABSENT from `business_day` rather than present with a flag — so the strip is a read
 *     of that table and cannot be arithmetic over a calendar. `closes_at > now` rather than
 *     `trading_date >= today`, because the session that is still running at 01:30 belongs to the
 *     previous trading date and is still bookable (ADR 0007).
 *   - **what to call one therapist.** ADR 0020: a therapist has no display name until an admin sets one
 *     and records a photography consent, and `employee.is_publishable` is GENERATED from exactly those
 *     two columns. The page renders the name when there is one and an unnamed label when there is not;
 *     `staff_reference` comes back so the label can be *disambiguated* for assistive technology without
 *     being published as a name, which is the arrangement `TherapistCard` already uses.
 *
 * Reads only. Everything here is `select`, and the booking write is `createBooking`'s (B-AVAIL-06).
 */

/** One priced duration of one published treatment, as a booking request needs it. */
export interface BookableVariantRow {
  readonly serviceVariantId: string
  readonly serviceId: string
  readonly style: string
  readonly treatmentKey: string
  readonly slug: string
  /** The linted public display name. Never composed here; `setPublicDisplayName` owns it. */
  readonly publicDisplayName: string
  readonly durationMinutes: number
  /**
   * VAT-inclusive gross in integer fils, as a **string**.
   *
   * `fils_nonneg` is a `bigint` domain and `createConnection` maps `bigint` to a string rather than to a
   * lossy JS number. A price is money, and money is never a float (ADR 0007) — the caller formats it
   * through `@berelax/core`'s money helpers.
   */
  readonly grossFils: string
}

/**
 * Every published treatment's priced durations, in menu order then ascending duration.
 *
 * The bookable predicate is `listBookableServices`' — `published_at is not null and archived_at is null`,
 * the predicate of `service_bookable_idx` — so an archived treatment disappears from the booking page the
 * moment it is archived, with no second definition of "bookable" to keep in step.
 *
 * `service_variant.gross_price_fils` and **not** the effective-dated `price_list` row, deliberately. The
 * page shows a price to orient a reader between four durations; the authority for what a booking is worth
 * is the snapshot `createBooking` takes inside the transaction, and `readPremisesFacts` is the read that
 * publishes the effective price to `/api/facts` and the menu pages. A third opinion here would be a
 * fourth place the figure could be wrong.
 */
export async function readBookableVariants(sql: Sql): Promise<readonly BookableVariantRow[]> {
  const rows = await sql<
    {
      service_variant_id: string
      service_id: string
      style: string
      treatment_key: string
      slug: string
      public_display_name: string
      duration_minutes: number
      gross_fils: string
    }[]
  >`
    select v.id as service_variant_id,
           s.id as service_id,
           s.style::text as style,
           s.treatment_key::text as treatment_key,
           s.slug,
           s.public_display_name,
           v.duration_minutes,
           v.gross_price_fils::text as gross_fils
      from service s
      join service_variant v on v.service_id = s.id
     where s.published_at is not null
       and s.archived_at is null
       and s.public_display_name is not null
     order by s.display_order, s.id, v.duration_minutes
  `
  return rows.map((row) => ({
    serviceVariantId: row.service_variant_id,
    serviceId: row.service_id,
    style: row.style,
    treatmentKey: row.treatment_key,
    slug: row.slug,
    publicDisplayName: row.public_display_name,
    durationMinutes: Number(row.duration_minutes),
    grossFils: row.gross_fils,
  }))
}

/** One open trading date, with the session's own instants. */
export interface TradingDayRow {
  /** `YYYY-MM-DD`. A trading date, never a calendar date. */
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
}

/**
 * The open trading dates whose session has not finished at `now`, earliest first.
 *
 * Three properties a calendar walk does not have, and each of them is why this is a read:
 *
 *   1. **A closed date is absent.** `business_day` holds only the dates the premises trades, so a holiday
 *      is skipped by the query rather than by a filter somebody has to remember.
 *   2. **`closes_at > now`, not `trading_date >= today`.** Trading runs 11:00–02:00, so at 01:30 the
 *      current business day is *yesterday's* date and it is still bookable. Comparing the date would drop
 *      the day a reader is standing in.
 *   3. **`from` anchors the window without weakening (2).** A day strip is read starting at the date a
 *      URL names, so a link to a day further out than the strip is wide lands on a strip that contains it.
 *      A past `from` anchors nothing, because `closes_at > now` still applies and wins.
 *
 * `limit` is bounded by the caller and by this function, because a day strip is a handful of days and an
 * unbounded read here would return the whole generated horizon.
 */
export async function readOpenTradingDays(
  sql: Sql,
  options: {
    readonly now: number
    /** The earliest trading date to include, as `YYYY-MM-DD`. Null starts at the current session. */
    readonly from?: string | null
    readonly limit: number
  },
): Promise<readonly TradingDayRow[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 60) {
    throw new Error(
      `A day strip spans between 1 and 60 trading dates, got ${options.limit}. An unbounded read here ` +
        'returns the whole generated horizon, which is 149 rows in the seeded fixture.',
    )
  }
  const from = options.from ?? null
  const rows = await sql<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select trading_date::text as trading_date, opens_at, closes_at
      from business_day
     where closes_at > ${new Date(options.now)}
       -- An absent anchor is not a filter. Written as one predicate rather than as two branches of a
       -- query builder, so the two forms cannot drift into two orderings or two limits.
       and (${from}::date is null or trading_date >= ${from}::date)
     order by trading_date
     limit ${options.limit}
  `
  return rows.map((row) => ({
    tradingDate: row.trading_date,
    opensAt: row.opens_at.getTime(),
    closesAt: row.closes_at.getTime(),
  }))
}

/**
 * What a therapist may be called on a public page.
 *
 * `displayName` is null for every therapist in this business today (ADR 0020, `Y12-names`), which is not a
 * gap to fill in: the page renders the unnamed label, and `staffReference` is carried so two unnamed
 * therapists are distinguishable to a screen reader without either being published under a name.
 */
export interface TherapistLabelRow {
  readonly therapistId: string
  readonly staffReference: string
  readonly displayName: string | null
  /** `employee.is_publishable`, GENERATED from `display_name is not null and photo_consent`. */
  readonly isPublishable: boolean
}

/** Labels for a set of therapist ids, in reference order. An unknown id is simply absent. */
export async function readTherapistLabels(
  sql: Sql,
  therapistIds: readonly string[],
): Promise<readonly TherapistLabelRow[]> {
  if (therapistIds.length === 0) return []
  const rows = await sql<
    {
      id: string
      staff_reference: string
      display_name: string | null
      is_publishable: boolean
    }[]
  >`
    select id, staff_reference, display_name, is_publishable
      from employee
     where id = any(${[...new Set(therapistIds)]}::uuid[])
     order by staff_reference
  `
  return rows.map((row) => ({
    therapistId: row.id,
    staffReference: row.staff_reference,
    displayName: row.display_name,
    isPublishable: row.is_publishable,
  }))
}

/**
 * The therapists a public page may offer **by name**: publishable, and employed on the date asked about.
 *
 * Empty today, and that emptiness is the launch state rather than a failure — nineteen photographs and no
 * names. The booking page therefore offers "any therapist" and says so, instead of listing nineteen
 * options all reading *"name not yet published"*, which is a control a reader cannot use. A therapist a
 * reader arrived with (from a therapist page, a link, a previous visit) is honoured by id whether or not
 * they are publishable — that request already names one person, so nothing is being published by
 * answering it.
 */
export async function readPublishableTherapists(
  sql: Sql,
  options: { readonly onDate: string },
): Promise<readonly TherapistLabelRow[]> {
  const rows = await sql<
    { id: string; staff_reference: string; display_name: string; is_publishable: boolean }[]
  >`
    select id, staff_reference, display_name, is_publishable
      from employee
     where is_publishable
       and employed_from <= ${options.onDate}::date
       and (employed_until is null or employed_until >= ${options.onDate}::date)
     order by display_name
  `
  return rows.map((row) => ({
    therapistId: row.id,
    staffReference: row.staff_reference,
    displayName: row.display_name,
    isPublishable: row.is_publishable,
  }))
}
