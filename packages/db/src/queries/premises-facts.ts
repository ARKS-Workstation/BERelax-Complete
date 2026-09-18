import type { Sql } from '../connection.ts'
import { areaAliasesFor } from '../seed/premises.ts'

/**
 * The one read path for NAP: the premises singleton and everything derived from it.
 *
 * docs/09 §4 states the rule this function exists to make true — *"one source of truth. No hard-coded
 * address in a template, no hand-written schema block."* That is a claim about the repository, and
 * `packages/db/src/seed/premises.test.ts` greps for violations of it. This is the other half: a consumer
 * that wants the address has somewhere to get it, in one round trip, with the joined facts it always
 * needs beside it.
 *
 * ## Why the query is here and not in `apps/web`
 *
 * `apps/web` may import `@berelax/db` (`.dependency-cruiser.cjs`: `apps/* -> core, db, shared`) but the
 * SQL belongs on this side of that edge. Two reasons, and the second is the one that matters:
 *
 *   - three surfaces need the same read — `/api/facts`, `/llms.txt` and every page that renders the NAP
 *     block — and three copies of a five-table read is three places a joined column can go missing;
 *   - `is_placeholder_text()` is a **database** function (0026). Reading `phone_whatsapp` and deciding in
 *     TypeScript whether it looks like a placeholder would be a second implementation of the predicate
 *     the schema itself uses, and the two would disagree the first time a marker was added to one of
 *     them. `whatsappIsPlaceholder` below is the database's answer, not this module's.
 *
 * ## Why it returns rows rather than the published payload
 *
 * The payload is `@berelax/shared`'s `factsSchema`, and building it needs `formatMoney` from
 * `@berelax/core` — which `packages/db` may never import (the dependency runs the other way). So this
 * returns what the database holds, named as the columns are, and `apps/web/src/facts/build.ts` composes
 * it. That split is also what keeps this function useful to a consumer that wants the row and not a fact
 * sheet.
 */

/** The premises singleton, plus the aliases derived from its `area`. */
export interface PremisesFactsRow {
  readonly displayName: string
  readonly addressLine1: string
  readonly addressLine2: string | null
  readonly floor: string | null
  readonly area: string
  /**
   * Derived from `area` by `areaAliasesFor`, not stored.
   *
   * Here rather than at the edge so that every consumer of the row gets the same three names for the
   * district — docs/09 §4 requires all of them on every citation — and so that an area the mapping does
   * not know yields an empty list rather than the previous district's aliases.
   */
  readonly areaAliases: readonly string[]
  readonly emirate: string
  readonly countryCode: string
  readonly poBox: string | null
  readonly makaniNumber: string | null
  /** `numeric(9,6)` as a string: a coordinate rounded through a float is a pin in the wrong place. */
  readonly latitude: string | null
  readonly longitude: string | null
  readonly plusCode: string | null
  readonly googlePlaceId: string | null
  readonly phoneLandline: string | null
  readonly phoneMobile: string | null
  /** As stored. Today it is `WHATSAPP-PENDING-Y1-NAP`; see `whatsappIsPlaceholder`. */
  readonly phoneWhatsapp: string | null
  /**
   * `is_placeholder_text(phone_whatsapp)`, evaluated by PostgreSQL.
   *
   * The single most consequential field of this read. True means the column is standing in for an answer
   * (Y1-nap) and **no number may be published from it**; the caller decides what to publish instead, and
   * `/api/facts` publishes the open question rather than a digit.
   */
  readonly whatsappIsPlaceholder: boolean
  readonly email: string | null
  readonly parkingNotes: string | null
  readonly directionsNotes: string | null
  readonly timezone: string
}

/** One weekday's session. `HH:MM`, local to `timezone`. */
export interface TradingHoursRow {
  /** 0 = Sunday, as `premises_hours.day_of_week`. */
  readonly dayOfWeek: number
  readonly openTime: string
  readonly closeTime: string
  /** The generated column (0003), never recomputed: `close_time <= open_time`. */
  readonly crossesMidnight: boolean
  readonly isClosed: boolean
}

/** A dated exception: a holiday, Ramadan hours, a maintenance closure. */
export interface HoursExceptionRow {
  readonly startsOn: string
  readonly endsOn: string
  readonly kind: string
  readonly reason: string
  readonly isConfirmed: boolean
  readonly closedFromTime: string | null
  readonly closedUntilTime: string | null
}

/** The two names a tax document and a citation need, from the `legal_entity` singleton. */
export interface LegalNamesRow {
  readonly legalName: string
  readonly tradingName: string
}

/** One price point: a published service at one duration. 32 of these for the seeded menu. */
export interface CataloguePriceRow {
  readonly style: string
  readonly treatmentKey: string
  readonly slug: string
  readonly publicDisplayName: string
  readonly durationMinutes: number
  /** Integer fils as a string — the `fils` domain is `bigint` and the driver never parses it. */
  readonly grossPriceFils: string
}

/** An offering docs/13 §4 lists with no figure (0032: a table with no price column). */
export interface PriceOnRequestRow {
  readonly menuLabel: string
  readonly resourceRequirement: string
  readonly openQuestionId: string
  readonly provisionalNote: string | null
}

export interface PremisesFacts {
  readonly premises: PremisesFactsRow
  /** Null when `legal_entity` has no row. 0026 seeds it, so this is a migration that did not run. */
  readonly legal: LegalNamesRow | null
  readonly hours: readonly TradingHoursRow[]
  readonly exceptions: readonly HoursExceptionRow[]
  readonly prices: readonly CataloguePriceRow[]
  readonly onRequest: readonly PriceOnRequestRow[]
}

/**
 * The `premises` row and everything a fact sheet derives from it, or `null`.
 *
 * `null` when the singleton is absent, which means `pnpm seed` has not run against this database. A throw
 * would be wrong for the two callers that exist: `/api/facts` turns it into a 503 with a message naming
 * the seed, and a page that renders the NAP block renders its "not recorded yet" state. Both are better
 * than a 500 stack, and neither is a made-up address.
 *
 * ## The reads, and why they are five statements rather than one
 *
 * One join across `premises`, `premises_hours`, `premises_closure`, `service_variant` and
 * `price_on_request` would multiply seven hour rows by thirty-two prices, and the caller would be
 * de-duplicating a 224-row product to recover five lists. The five statements are issued on one
 * connection inside a single `Promise.all`, which is one round trip's worth of latency and no
 * reassembly. Nothing here writes, so there is no transaction to hold them together: a fact sheet built
 * from a premises row and a price list a millisecond apart is not a fact sheet with a defect.
 *
 * `times` are formatted in SQL with `to_char(..., 'HH24:MI')` rather than by trimming a driver string:
 * `time` arrives as `11:00:00` and a substring of it is a parse nobody wrote down. Seconds are not a fact
 * about opening hours.
 *
 * Exceptions are limited to those that have not finished. A fact sheet publishing last Ramadan's hours is
 * worse than one publishing none: a consumer cannot tell a stale exception from a current one, and this
 * is the endpoint whose whole purpose is that a third party may quote it.
 */
export async function readPremisesFacts(sql: Sql): Promise<PremisesFacts | null> {
  const [premisesRows, legalRows, hourRows, exceptionRows, priceRows, onRequestRows] =
    await Promise.all([
      sql<
        {
          display_name: string
          address_line_1: string
          address_line_2: string | null
          floor: string | null
          area: string
          emirate: string
          country_code: string
          po_box: string | null
          makani_number: string | null
          latitude: string | null
          longitude: string | null
          plus_code: string | null
          google_place_id: string | null
          phone_landline: string | null
          phone_mobile: string | null
          phone_whatsapp: string | null
          whatsapp_is_placeholder: boolean
          email: string | null
          parking_notes: string | null
          directions_notes: string | null
          timezone: string
        }[]
      >`
        select display_name, address_line_1, address_line_2, floor, area, emirate, country_code,
               po_box, makani_number, latitude::text, longitude::text, plus_code, google_place_id,
               phone_landline, phone_mobile, phone_whatsapp,
               -- The schema's own predicate (0026), not a second implementation of it at the edge.
               is_placeholder_text(phone_whatsapp) as whatsapp_is_placeholder,
               email, parking_notes, directions_notes, timezone
          from premises
         where id = 1
      `,
      sql<{ legal_name: string; trading_name: string }[]>`
        select legal_name, trading_name from legal_entity where id = 1
      `,
      sql<
        {
          day_of_week: number
          open_time: string
          close_time: string
          crosses_midnight: boolean
          is_closed: boolean
        }[]
      >`
        select day_of_week,
               to_char(open_time, 'HH24:MI')  as open_time,
               to_char(close_time, 'HH24:MI') as close_time,
               crosses_midnight, is_closed
          from premises_hours
         order by day_of_week
      `,
      sql<
        {
          starts_on: string
          ends_on: string
          kind: string
          reason: string
          is_confirmed: boolean
          closed_from_time: string | null
          closed_until_time: string | null
        }[]
      >`
        select to_char(starts_on, 'YYYY-MM-DD') as starts_on,
               to_char(ends_on, 'YYYY-MM-DD')   as ends_on,
               kind, reason, is_confirmed,
               to_char(closed_from_time, 'HH24:MI')  as closed_from_time,
               to_char(closed_until_time, 'HH24:MI') as closed_until_time
          from premises_closure
         where ends_on >= current_date
         order by starts_on, kind
      `,
      sql<
        {
          style: string
          treatment_key: string
          slug: string
          public_display_name: string
          duration_minutes: number
          gross_price_fils: string
        }[]
      >`
        select s.style::text as style, s.treatment_key, s.slug, s.public_display_name,
               v.duration_minutes, v.gross_price_fils::text as gross_price_fils
          from service_variant v
          join service s on s.id = v.service_id
         -- The one definition of bookable, the same predicate listBookableServices uses: a service
         -- withdrawn from the menu must leave the published price list on the same request.
         where s.published_at is not null and s.archived_at is null
         order by s.display_order, s.id, v.duration_minutes
      `,
      sql<
        {
          menu_label: string
          resource_requirement: string
          open_question_id: string
          provisional_note: string | null
        }[]
      >`
        select menu_label, resource_requirement, open_question_id, provisional_note
          from price_on_request
         order by menu_label
      `,
    ])

  const row = premisesRows[0]
  if (row === undefined) return null
  const legalRow = legalRows[0]

  return {
    premises: {
      displayName: row.display_name,
      addressLine1: row.address_line_1,
      addressLine2: row.address_line_2,
      floor: row.floor,
      area: row.area,
      areaAliases: areaAliasesFor(row.area),
      emirate: row.emirate,
      countryCode: row.country_code,
      poBox: row.po_box,
      makaniNumber: row.makani_number,
      latitude: row.latitude,
      longitude: row.longitude,
      plusCode: row.plus_code,
      googlePlaceId: row.google_place_id,
      phoneLandline: row.phone_landline,
      phoneMobile: row.phone_mobile,
      phoneWhatsapp: row.phone_whatsapp,
      whatsappIsPlaceholder: row.whatsapp_is_placeholder,
      email: row.email,
      parkingNotes: row.parking_notes,
      directionsNotes: row.directions_notes,
      timezone: row.timezone,
    },
    legal:
      legalRow === undefined
        ? null
        : { legalName: legalRow.legal_name, tradingName: legalRow.trading_name },
    hours: hourRows.map((hour) => ({
      dayOfWeek: Number(hour.day_of_week),
      openTime: hour.open_time,
      closeTime: hour.close_time,
      crossesMidnight: hour.crosses_midnight,
      isClosed: hour.is_closed,
    })),
    exceptions: exceptionRows.map((exception) => ({
      startsOn: exception.starts_on,
      endsOn: exception.ends_on,
      kind: exception.kind,
      reason: exception.reason,
      isConfirmed: exception.is_confirmed,
      closedFromTime: exception.closed_from_time,
      closedUntilTime: exception.closed_until_time,
    })),
    prices: priceRows.map((price) => ({
      style: price.style,
      treatmentKey: price.treatment_key,
      slug: price.slug,
      publicDisplayName: price.public_display_name,
      durationMinutes: Number(price.duration_minutes),
      grossPriceFils: price.gross_price_fils,
    })),
    onRequest: onRequestRows.map((offering) => ({
      menuLabel: offering.menu_label,
      resourceRequirement: offering.resource_requirement,
      openQuestionId: offering.open_question_id,
      provisionalNote: offering.provisional_note,
    })),
  }
}
