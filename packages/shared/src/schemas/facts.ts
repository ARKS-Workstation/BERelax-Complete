/**
 * The `/api/facts` contract: what the machine-readable fact sheet publishes, as zod.
 *
 * docs/09 §4 makes `/api/facts` one of the derived consumers of the `premises` row and docs/09
 * §"LLM SEO" makes it *the* canonical machine-readable fact sheet. The reason it exists is stated there
 * too, and it is not tidiness: "AI answers synthesise across sources; disagreement yields a confident
 * wrong answer about your prices." One endpoint, generated from the database, is what a citation can be
 * checked against.
 *
 * ## Why a schema and not an interface
 *
 * The same argument `schemas/catalogue.ts` makes for the catalogue. A type is erased at run time, and
 * this payload is assembled from eleven nullable columns, two joined tables and a price grid: the
 * failure mode is not a wrong type, it is a field that quietly became `undefined` and an endpoint that
 * publishes an address with no street. `factsSchema.parse` is run on every response **before** it is
 * served, so a missing field is a 500 in the logs rather than a fact sheet an assistant repeats.
 *
 * ## The three things this schema refuses to express
 *
 * 1. **A bare WhatsApp string.** docs/13 §3 records two numbers and asks which is canonical (Y1-nap), so
 *    `premises.phone_whatsapp` holds a placeholder `is_placeholder_text()` refuses. {@link whatsappSchema}
 *    is therefore a discriminated union: either a confirmed number, or an `unconfirmed` object that
 *    carries no digits at all. A `string | null` would have let the placeholder through as a number.
 * 2. **A number as a JSON number, for money.** Prices are integer fils (ADR 0007) and cross the wire as
 *    decimal strings. `20000` in JSON is a `double` to most consumers, and a fact sheet whose whole
 *    purpose is that a third party quotes the price correctly must not hand them a float.
 * 3. **A pre-rendered sentence about the hours.** The hours are structured — one row per day, with the
 *    next-day close stated as a flag — because 11:00–02:00 crosses midnight and *every* consumer gets
 *    that wrong when it is handed a string (docs/13 §2).
 */
import { z } from 'zod'

/**
 * The payload's own version, bumped when a field changes meaning.
 *
 * Not `SCHEMA_VERSION` from `@berelax/db`, which counts migrations: a consumer of this endpoint cannot
 * see the database and does not care how many times it changed. It is here so an assistant's cached copy
 * can be told it is reading an older contract.
 */
export const FACTS_SCHEMA_VERSION = 1

/** `HH:MM`, 24-hour, local to `hours.timezone`. Seconds are not a fact about opening hours. */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a local time is HH:MM in 24-hour form')

/** `YYYY-MM-DD`. A calendar date, never an instant: a closure is a date, not a moment. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')

/** A gross amount in integer fils, as a decimal string. See the header's point 2. */
export const filsStringSchema = z
  .string()
  .regex(/^\d+$/, 'fils is a non-negative integer, as digits')

export const phoneSchema = z.object({
  /** E.164, exactly as the row stores it. The only form anything compares or dials. */
  e164: z.string().regex(/^\+\d{7,15}$/),
  /** The same number spaced the way this market reads it. Display only. */
  display: z.string().min(1),
})

/**
 * The WhatsApp channel, which has no answer yet.
 *
 * `status` is the discriminant and `provisional` is redundant with it on purpose: the acceptance
 * criterion asks for `provisional: true` on every provisional value, and a consumer scanning the payload
 * for that key should not have to know that `unconfirmed` implies it.
 */
export const whatsappSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'),
    provisional: z.literal(false),
    e164: phoneSchema.shape.e164,
    display: phoneSchema.shape.display,
  }),
  z.object({
    status: z.literal('unconfirmed'),
    provisional: z.literal(true),
    /** The id in docs/OPEN-QUESTIONS.md, so a reader can look up what is being waited on. */
    openQuestionId: z.string().min(1),
    why: z.string().min(1),
    /**
     * No digits, asserted by the schema and not only by the builder.
     *
     * The failure this refuses is the plausible one: somebody promotes a candidate, the field carries
     * digits, `status` still says `unconfirmed`, and every consumer that reads the number ignores the
     * status. A number that cannot be here cannot be dialled.
     */
    number: z.null(),
  }),
])

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().nullable(),
  floor: z.string().nullable(),
  area: z.string().min(1),
  /**
   * The other names for the same district, and why they are published.
   *
   * docs/09 §4 and §"The brand collision" both require the locality on every citation, and this district
   * has three names in use — docs/13 §2 lists them, and the repository's grep gate keeps them spelled in
   * the seed alone. An assistant that only knows one of them cannot match a query using another to this
   * business, which is exactly the collision the airport spa of the same name wins by default. Derived
   * from the row's `area`, never listed beside it: see `areaAliasesFor` in
   * `packages/db/src/seed/premises.ts`.
   */
  areaAliases: z.array(z.string().min(1)).readonly(),
  emirate: z.string().min(1),
  countryCode: z.string().length(2),
  poBox: z.string().nullable(),
  makaniNumber: z.string().nullable(),
  /** Every line above joined, which is what a map query and a citation both quote. */
  oneLine: z.string().min(1),
})

/**
 * Where the premises is, to a machine.
 *
 * Every field is nullable and every one of them is currently null, which is a fact about what is known
 * rather than a gap in this endpoint: docs/13 states no coordinate, no Plus Code and no `place_id`, and
 * `premises` holds NULL for all three. A plausible coordinate would put a pin on the wrong building.
 * The nulls are enumerated in {@link factsSchema}'s `unanswered` so a consumer is told, rather than
 * left to notice.
 */
export const geoSchema = z.object({
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  plusCode: z.string().nullable(),
  placeId: z.string().nullable(),
  mapUrl: z.string().url(),
  directionsUrl: z.string().url(),
})

export const openingHoursDaySchema = z.object({
  /** 0 = Sunday, matching `premises_hours.day_of_week` and `Date#getDay`. */
  dayOfWeek: z.number().int().min(0).max(6),
  opens: localTimeSchema,
  closes: localTimeSchema,
  /**
   * True when `closes` is on the **next** calendar day: 11:00 → 02:00.
   *
   * Read from the generated column, never recomputed here (`premises_hours.crosses_midnight`, 0003), so
   * no consumer can disagree with the database about it. This is the one field of this payload that a
   * naive reader gets wrong: `opens <= now <= closes` is false for every minute the premises is open
   * after midnight.
   */
  closesNextDay: z.boolean(),
  isClosed: z.boolean(),
})

export const hoursExceptionSchema = z.object({
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  /** `public_holiday`, `ramadan_hours`, `maintenance` or `other` (0003). */
  kind: z.string().min(1),
  reason: z.string().min(1),
  /**
   * False for a UAE public holiday that has been predicted rather than announced.
   *
   * The holidays are lunar and announced at short notice (0003), so an exception a consumer treats as
   * settled may still move. Published rather than filtered out: an assistant telling a customer the
   * premises *might* be closed is right, and telling them nothing is wrong.
   */
  isConfirmed: z.boolean(),
  closedFromTime: localTimeSchema.nullable(),
  closedUntilTime: localTimeSchema.nullable(),
})

export const hoursSchema = z.object({
  /** IANA, from the row. The zone is always an argument (ADR 0009); this is the business's. */
  timezone: z.string().min(1),
  weekly: z.array(openingHoursDaySchema).readonly(),
  /** True when any day's session runs past midnight, which is what makes `business_day` first-class. */
  crossesMidnight: z.boolean(),
  exceptions: z.array(hoursExceptionSchema).readonly(),
  /**
   * The Ramadan rows of `exceptions`, listed again under the name a consumer will look for.
   *
   * An empty array, today, and that is the honest answer: docs/13 states no Ramadan hours and Y8-hours
   * is resolved only for the ordinary week. An invented Ramadan closing time would be quoted by an
   * assistant to a customer standing outside the door.
   */
  ramadan: z.array(hoursExceptionSchema).readonly(),
})

export const priceVariantSchema = z.object({
  durationMinutes: z.number().int().positive(),
  /** VAT-inclusive gross, integer fils, as digits. Never a JSON number; see the header. */
  grossFils: filsStringSchema,
  /** The same amount in AED with two decimals, so a citation quotes the figure a customer sees. */
  grossAed: z.string().regex(/^\d+\.\d{2}$/),
})

export const priceServiceSchema = z.object({
  style: z.string().min(1),
  treatmentKey: z.string().min(1),
  slug: z.string().min(1),
  /** The linted public display name. Nothing here is a name this endpoint composes. */
  name: z.string().min(1),
  variants: z.array(priceVariantSchema).readonly(),
})

/**
 * An offering docs/13 §4 lists with no figure.
 *
 * A table with no price column (0032), so there is nothing here to publish as a price. It is in the
 * payload because omitting it would make the menu look shorter than it is, and an assistant asked about
 * a couple's massage should be able to say "priced on request" rather than "not offered".
 */
export const priceOnRequestSchema = z.object({
  label: z.string().min(1),
  requirement: z.string().min(1),
  provisional: z.literal(true),
  openQuestionId: z.string().min(1),
})

export const catalogueSchema = z.object({
  currency: z.literal('AED'),
  /** VAT-inclusive, always, and stated rather than implied (docs/01 decision 7). */
  vatInclusive: z.literal(true),
  /** 32 for the seeded menu: 8 services x 4 durations (docs/13 §4). Counted, not asserted. */
  pricePointCount: z.number().int().nonnegative(),
  services: z.array(priceServiceSchema).readonly(),
  onRequest: z.array(priceOnRequestSchema).readonly(),
})

/**
 * One value in this payload that nobody has confirmed.
 *
 * Machine-readable because the alternative is prose in a `note` field that no consumer parses. Every
 * entry's `openQuestionId` is a row of the Unconfirmed Assumptions panel — `unconfirmedAssumptionRows()`
 * in `@berelax/db` — and `apps/web/src/facts.itest.ts` asserts that correspondence in both directions,
 * so a provisional value cannot be published here and be invisible on the one screen built to show it.
 */
export const provisionalFactSchema = z.object({
  /** Dotted path into this payload: `contact.whatsapp`, `catalogue.onRequest`. */
  field: z.string().min(1),
  openQuestionId: z.string().min(1),
  note: z.string().min(1),
})

/** A field that is null because nothing states it, with what it would take to fill it. */
export const unansweredFactSchema = z.object({
  field: z.string().min(1),
  why: z.string().min(1),
})

export const factsSchema = z.object({
  schemaVersion: z.literal(FACTS_SCHEMA_VERSION),
  /**
   * When this payload was built, ISO 8601 with a zone.
   *
   * Deliberately **not** part of the ETag: an ETag that changed every second would make conditional
   * revalidation useless, which is the opposite of what it is for. The hash covers the facts; this
   * covers the response. See `factsEtag` in `apps/web/src/facts/build.ts`.
   */
  generatedAt: z.string().min(1),
  /** The origin this payload describes, so a copy of it says where it came from. */
  canonicalUrl: z.string().url(),
  names: z.object({
    /** `legal_entity.legal_name` — the name on every tax invoice. */
    legal: z.string().min(1),
    /** `legal_entity.trading_name`. */
    trading: z.string().min(1),
    /**
     * `premises.display_name`.
     *
     * Published beside the trading name rather than instead of it because docs/09's entity strategy
     * turns on using the **full** name everywhere — `berelax.com` is an international airport-spa chain
     * with an outlet in the same city, and a bare brand is unwinnable.
     */
    display: z.string().min(1),
  }),
  address: addressSchema,
  geo: geoSchema,
  contact: z.object({
    landline: phoneSchema.nullable(),
    mobile: phoneSchema.nullable(),
    whatsapp: whatsappSchema,
    email: z.string().nullable(),
  }),
  hours: hoursSchema,
  /** `premises.parking_notes`, verbatim from the row. Free text the owner controls. */
  parkingNotes: z.string().nullable(),
  directionsNotes: z.string().nullable(),
  catalogue: catalogueSchema,
  provisional: z.array(provisionalFactSchema).readonly(),
  unanswered: z.array(unansweredFactSchema).readonly(),
})

export type Facts = z.infer<typeof factsSchema>
export type FactsPhone = z.infer<typeof phoneSchema>
export type FactsWhatsapp = z.infer<typeof whatsappSchema>
export type FactsAddress = z.infer<typeof addressSchema>
export type FactsHours = z.infer<typeof hoursSchema>
export type FactsOpeningHoursDay = z.infer<typeof openingHoursDaySchema>
export type FactsHoursException = z.infer<typeof hoursExceptionSchema>
export type FactsCatalogue = z.infer<typeof catalogueSchema>
export type ProvisionalFact = z.infer<typeof provisionalFactSchema>
export type UnansweredFact = z.infer<typeof unansweredFactSchema>
