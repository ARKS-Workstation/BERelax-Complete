import { createHash } from 'node:crypto'
import { type Fils, filsFrom, money, toDecimalString } from '@berelax/core'
import type { PremisesFacts } from '@berelax/db'
import {
  AppError,
  addressOneLine,
  directionsLinkFor,
  FACTS_SCHEMA_VERSION,
  type Facts,
  type FactsPhone,
  type FactsWhatsapp,
  factsSchema,
  formatUaePhone,
  mapLinkFor,
  type ProvisionalFact,
  type UnansweredFact,
} from '@berelax/shared'

/**
 * The fact sheet, built from the premises row. Pure.
 *
 * `readPremisesFacts` in `@berelax/db` does the reading and this does the composing, and the split is not
 * decoration: `packages/db` may never import `packages/core` (the dependency runs the other way), and
 * turning integer fils into `200.00` is `@berelax/core`'s to do — `toDecimalString`, the same function the
 * ledger and the tax documents use. So the row crosses the boundary as columns and the money is formatted
 * on this side, once.
 *
 * Pure so that every claim about the payload is a unit test rather than an HTTP round trip: the clock and
 * the origin arrive as arguments, which is also what makes the ETag reproducible.
 *
 * ## What it publishes that is not in the row
 *
 * Nothing that is a fact. Three things that are *derivations* of the row:
 *
 *   - the area aliases, from `areaAliasesFor` — see `packages/db/src/queries/premises-facts.ts`;
 *   - the map and directions URLs, from `@berelax/shared`, which is also where the NAP block gets them;
 *   - the display spelling of each phone number, from its E.164 form. One number, two renderings, no
 *     second stored value.
 *
 * ## And the one thing it refuses to publish
 *
 * A WhatsApp number. docs/13 §3 records two of them — one on the prototype, a different one on the live
 * site — and asks which is canonical (Y1-nap). Neither is spelled here, because the grep gate in
 * `packages/db/src/seed/premises.test.ts` makes the seed the only place either may appear.
 * `premises.phone_whatsapp` therefore holds `WHATSAPP-PENDING-Y1-NAP`, which `is_placeholder_text()`
 * refuses, and this endpoint publishes `{ status: 'unconfirmed', provisional: true, number: null }`.
 *
 * It publishes **neither candidate**, and that is the decision rather than an omission. This is the one
 * endpoint built to end the divergence docs/09 §4 describes — *"Divergence between the site, the schema
 * and GBP is precisely what makes AI assistants state wrong hours and prices with total confidence"* —
 * so serving both numbers from it would be the divergence, with a machine-readable wrapper. Serving one
 * would publish a number that may not reach the business and would be indistinguishable from one the
 * owner had confirmed. The two candidates are recorded in `WHATSAPP_CANDIDATES` for the Unconfirmed
 * Assumptions panel, which is an admin screen for the person who can answer the question.
 */
export interface BuildFactsOptions {
  /** ISO 8601 with a zone. An argument, so a test builds the same payload twice. */
  readonly generatedAt: string
  /** The origin this payload describes, from `siteOrigin()`. */
  readonly origin: string
}

/** The path the fact sheet is served from. One spelling, shared with the registry and `/llms.txt`. */
export const FACTS_PATH = '/api/facts'

/**
 * Integer fils from the `bigint` string the driver hands back, with the round trip checked.
 *
 * `connection.ts` returns bigint as a **string** precisely so nothing rounds a money figure, and
 * `Number(...)` here would put the rounding back. The comparison is what makes that impossible rather
 * than unlikely: a value that does not survive `String(Number(v))` is refused instead of published, and
 * `filsFrom` refuses anything beyond the safe integer range on the way through.
 */
function filsFromDatabase(value: string): Fils {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new AppError(
      'invariant_violated',
      `gross_price_fils '${value}' does not survive a round trip through a JavaScript number, so it ` +
        'cannot be published as a price. Money is integer fils (ADR 0007).',
    )
  }
  return filsFrom(parsed)
}

/** A stored E.164 number in both the form that is dialled and the form that is read out. */
function phoneOf(e164: string | null): FactsPhone | null {
  if (e164 === null || e164.trim() === '') return null
  return { e164, display: formatUaePhone(e164) }
}

/** The WhatsApp channel, decided by the database's own placeholder predicate. */
function whatsappOf(read: PremisesFacts): FactsWhatsapp {
  const { phoneWhatsapp, whatsappIsPlaceholder } = read.premises
  if (whatsappIsPlaceholder || phoneWhatsapp === null) {
    return {
      status: 'unconfirmed',
      provisional: true,
      openQuestionId: 'Y1-nap',
      why:
        'docs/13 §3 records two WhatsApp numbers for this business, one on the prototype and one on ' +
        'the live site, and neither has been confirmed. Publishing either would put a number in front ' +
        'of a customer that may not reach the business, and would be indistinguishable from a ' +
        'confirmed one. Use the landline or the mobile, which both sources agree on.',
      number: null,
    }
  }
  return {
    status: 'confirmed',
    provisional: false,
    e164: phoneWhatsapp,
    display: formatUaePhone(phoneWhatsapp),
  }
}

export function buildFacts(read: PremisesFacts, options: BuildFactsOptions): Facts {
  const { premises, legal, hours, exceptions, prices, onRequest } = read
  if (legal === null) {
    // The singleton 0026 seeds. Absent means the migration did not run, and a fact sheet with no legal
    // name is not a smaller problem than no fact sheet: the legal name is what a tax invoice and a
    // citation are checked against.
    throw new AppError(
      'invariant_violated',
      'legal_entity has no row, so the fact sheet has no legal or trading name to publish. ' +
        '0026_invoice.sql seeds it.',
    )
  }

  const postal = {
    addressLine1: premises.addressLine1,
    addressLine2: premises.addressLine2,
    floor: premises.floor,
    area: premises.area,
    emirate: premises.emirate,
    countryCode: premises.countryCode,
  }
  const mapTarget = { ...postal, googlePlaceId: premises.googlePlaceId }

  // Grouped by service, in the order the query returned them (display_order, then duration), so the
  // payload's shape is the menu's shape rather than a flat list a consumer has to pivot.
  const services: Facts['catalogue']['services'][number][] = []
  for (const price of prices) {
    const variant = {
      durationMinutes: price.durationMinutes,
      grossFils: price.grossPriceFils,
      grossAed: toDecimalString(money(filsFromDatabase(price.grossPriceFils))),
    }
    const last = services[services.length - 1]
    if (last !== undefined && last.slug === price.slug) {
      services[services.length - 1] = { ...last, variants: [...last.variants, variant] }
      continue
    }
    services.push({
      style: price.style,
      treatmentKey: price.treatmentKey,
      slug: price.slug,
      name: price.publicDisplayName,
      variants: [variant],
    })
  }

  const whatsapp = whatsappOf(read)
  const provisional: ProvisionalFact[] = []
  if (whatsapp.status === 'unconfirmed') {
    provisional.push({
      field: 'contact.whatsapp',
      openQuestionId: whatsapp.openQuestionId,
      // The stored value, which says what it is in words. Quoted rather than paraphrased so a reader of
      // this payload and a reader of the Unconfirmed Assumptions panel are looking at the same string.
      note: premises.phoneWhatsapp ?? '(not set)',
    })
  }
  for (const offering of onRequest) {
    provisional.push({
      field: `catalogue.onRequest.${offering.menuLabel}`,
      openQuestionId: offering.openQuestionId,
      note: offering.provisionalNote ?? offering.resourceRequirement,
    })
  }

  // The nulls, enumerated. A consumer told that `geo.latitude` is null because docs/13 states no
  // coordinate can decide what to do about it; one that finds the key missing concludes the endpoint is
  // incomplete, and one that finds a plausible number concludes nothing at all.
  const unanswered: UnansweredFact[] = []
  const absences: readonly (readonly [string, string | null, string])[] = [
    [
      'geo.latitude',
      premises.latitude,
      'no coordinate is recorded. docs/13 states none, and a plausible one would put a map pin on the wrong building',
    ],
    ['geo.longitude', premises.longitude, 'no coordinate is recorded; see geo.latitude'],
    ['geo.plusCode', premises.plusCode, 'no Plus Code is recorded. docs/13 states none'],
    [
      'geo.placeId',
      premises.googlePlaceId,
      'the Google Business Profile status is unknown (Y2-gbp-status), so there is no place_id to publish',
    ],
    [
      'contact.email',
      premises.email,
      'no email address is published by either source (docs/13 §3)',
    ],
    ['address.poBox', premises.poBox, 'no PO box is recorded. docs/13 states none'],
    [
      'address.makaniNumber',
      premises.makaniNumber,
      'no Makani or building reference is recorded. docs/13 states none',
    ],
    [
      'directionsNotes',
      premises.directionsNotes,
      'no arrival or transport note is recorded beyond the parking one',
    ],
  ]
  for (const [field, value, why] of absences) {
    if (value === null) unanswered.push({ field, why })
  }
  if (exceptions.filter((exception) => exception.kind === 'ramadan_hours').length === 0) {
    unanswered.push({
      field: 'hours.ramadan',
      why:
        'no Ramadan hours are recorded. docs/13 states none, and inventing a closing time would be ' +
        'quoted to a customer standing outside the door',
    })
  }

  const payload: Facts = {
    schemaVersion: FACTS_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    canonicalUrl: `${options.origin}${FACTS_PATH}`,
    names: {
      legal: legal.legalName,
      trading: legal.tradingName,
      display: premises.displayName,
    },
    address: {
      line1: premises.addressLine1,
      line2: premises.addressLine2,
      floor: premises.floor,
      area: premises.area,
      areaAliases: premises.areaAliases,
      emirate: premises.emirate,
      countryCode: premises.countryCode,
      poBox: premises.poBox,
      makaniNumber: premises.makaniNumber,
      oneLine: addressOneLine(postal),
    },
    geo: {
      latitude: premises.latitude,
      longitude: premises.longitude,
      plusCode: premises.plusCode,
      placeId: premises.googlePlaceId,
      mapUrl: mapLinkFor(mapTarget),
      directionsUrl: directionsLinkFor(mapTarget),
    },
    contact: {
      landline: phoneOf(premises.phoneLandline),
      mobile: phoneOf(premises.phoneMobile),
      whatsapp,
      email: premises.email,
    },
    hours: {
      timezone: premises.timezone,
      weekly: hours.map((day) => ({
        dayOfWeek: day.dayOfWeek,
        opens: day.openTime,
        closes: day.closeTime,
        // The generated column, carried across rather than recomputed. `close <= open` is the database's
        // answer (0003) and a second implementation of it here is a second thing to be wrong.
        closesNextDay: day.crossesMidnight,
        isClosed: day.isClosed,
      })),
      crossesMidnight: hours.some((day) => day.crossesMidnight && !day.isClosed),
      exceptions: exceptions.map((exception) => ({ ...exception })),
      ramadan: exceptions
        .filter((exception) => exception.kind === 'ramadan_hours')
        .map((exception) => ({ ...exception })),
    },
    parkingNotes: premises.parkingNotes,
    directionsNotes: premises.directionsNotes,
    catalogue: {
      currency: 'AED',
      vatInclusive: true,
      pricePointCount: prices.length,
      services,
      onRequest: onRequest.map((offering) => ({
        label: offering.menuLabel,
        requirement: offering.resourceRequirement,
        provisional: true,
        openQuestionId: offering.openQuestionId,
      })),
    },
    provisional,
    unanswered,
  }

  // Parsed on the way out, not merely typed. Eleven of these fields are nullable columns and two are
  // joined tables: the failure this catches is a field that quietly became `undefined` and an endpoint
  // that publishes an address with no street to a consumer that will repeat it.
  return factsSchema.parse(payload)
}

/**
 * The ETag: a hash of the facts, and deliberately not of the response.
 *
 * `generatedAt` is excluded. An ETag that changed on every request is a cache validator that never
 * validates, which is the opposite of what the acceptance criterion asks for — "carries a content-hash
 * ETag and returns 304 on conditional revalidation". With the timestamp out, the tag changes when a fact
 * changes and only then, so a crawler revalidating hourly gets a 304 until the owner corrects a field.
 *
 * `canonicalUrl` stays in, because a payload that described a different origin is a different payload: a
 * staging deployment and production must not hand out the same validator.
 *
 * Weak (`W/"…"`) because the bytes are not guaranteed identical for one tag — `generatedAt` differs
 * between two responses that carry it — and a strong validator promises byte equality. A weak one is
 * what HTTP has for "semantically the same", which is exactly the claim here.
 */
export function factsEtag(facts: Facts): string {
  const { generatedAt: _ignored, ...stable } = facts
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex')
  return `W/"${digest.slice(0, 32)}"`
}
