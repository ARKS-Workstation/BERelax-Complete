import type { Sql } from '../connection.ts'

/**
 * The premises and the legal entity, seeded from docs/13 §1–§3.
 *
 * **This module is the only place in non-test source that may spell the address or a phone number.**
 * docs/09 §4 and the comment on `premises` in 0003 both say the row is the single source of truth for
 * NAP: every footer, schema block, map embed, sitemap entry and facts endpoint derives from it. A second
 * literal anywhere else is the divergence docs/13 §3 is about — two published WhatsApp numbers is
 * already one real instance of it, and the consequence is an AI assistant confidently stating the wrong
 * one. `packages/db/src/seed/premises.test.ts` greps for that and fails naming the file.
 *
 * ## What is transcribed and what is refused
 *
 * Every value below comes off docs/13. Where docs/13 marks a field **[CONFIRM]**, or where its two
 * sources disagree, nothing is chosen:
 *
 *   - **`phone_whatsapp`** is {@link WHATSAPP_PENDING}, not a number. docs/13 §3 records `052 510 8633`
 *     on the prototype and `+971 52 823 9069` on the live site and asks which is canonical (Y1-nap).
 *     Picking one would publish a number that may not reach the business, and — worse — would be
 *     indistinguishable from a number the owner had confirmed. The placeholder carries a marker
 *     `is_placeholder_text()` (0026) recognises, so a consumer that snapshots it onto a document is
 *     refused rather than quietly printing it.
 *   - **`latitude`, `longitude`, `plus_code`, `google_place_id`, `po_box`, `makani_number`, `email`**
 *     are NULL. docs/13 states none of them. A plausible coordinate for "Al Meena Street" would put a
 *     map pin on the wrong building, and nothing on the page would say it was a guess.
 *   - **`trade_licence_number`** is left as 0026 left it. docs/13 §1 marks it [CONFIRM]; see
 *     {@link ensureLegalEntity}.
 *
 * The landline and the mobile are NOT in that category. docs/13 §3 lists the mobile in two formats that
 * normalise to the same number, and the landline on one source with no contradicting value, so both are
 * facts rather than choices. They are stored in E.164 because that is the identity ADR 0014 keys on.
 */

/** The singleton ids. Both tables are `check (id = 1)`. */
export const PREMISES_ID = 1
export const LEGAL_ENTITY_ID = 1

/**
 * What stands in for the canonical WhatsApp number until Y1-nap is answered.
 *
 * Chosen to fail, the same way `PLACEHOLDER_TRN` is: it says what it is in words, it names its open
 * question, and `is_placeholder_text()` matches it on `pending`. A value that *looked* like a phone
 * number would be rendered in a footer and dialled.
 */
export const WHATSAPP_PENDING = 'WHATSAPP-PENDING-Y1-NAP'

/**
 * The two numbers docs/13 §3 found, so the owner can be shown both when Y1-nap is asked.
 *
 * Kept as the record of the conflict rather than as a candidate to promote silently. They are equal
 * here on purpose: nothing in this module ranks them, because nothing in docs/13 does.
 */
export const WHATSAPP_CANDIDATES = Object.freeze([
  { value: '+971525108633', source: 'berelax.netlify.app prototype (docs/13 §3)' },
  { value: '+971528239069', source: 'berelaxmassage.com live site (docs/13 §3)' },
])

/**
 * The other names the district is known by, keyed on the name the row holds.
 *
 * docs/13 §2: "Al Zahiyah — also known as Al Mina / Tourist Club Area". docs/09 §4 needs all three on
 * every citation, because the locality is what tells a machine this business apart from the airport-spa
 * chain of the same name, and a customer searching "massage tourist club area" is searching for this
 * street.
 *
 * ## Why a mapping and not a list
 *
 * `premises` has no column for an alias and this unit adds no migration, so the aliases cannot be in the
 * row. Keyed on the area rather than listed beside it, they still cannot contradict it:
 * {@link areaAliasesFor} returns **nothing** for an area this mapping does not know, so an owner who
 * corrects `premises.area` gets no aliases rather than the previous district's. A bare
 * `AREA_ALIASES: string[]` would have gone on publishing "Tourist Club Area" for a business that had
 * moved to Khalifa City.
 */
export const AREA_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Al Zahiyah': Object.freeze(['Al Mina', 'Tourist Club Area']),
})

/**
 * Every other name for the district the row names, or an empty list.
 *
 * Case-insensitive on the key, because the alias set is a fact about a place and not about a spelling,
 * and an owner retyping the area with different capitalisation should not silently lose two of the three
 * names docs/09 §4 requires on every citation.
 */
export function areaAliasesFor(area: string): readonly string[] {
  const wanted = area.trim().toLowerCase()
  for (const [key, aliases] of Object.entries(AREA_ALIASES)) {
    if (key.toLowerCase() === wanted) return aliases
  }
  return Object.freeze([])
}

/**
 * Trading hours, docs/13 §2: **daily 11:00–02:00**.
 *
 * The close is less than the open, which is the whole reason `premises_hours.crosses_midnight` is a
 * generated column and `business_day` is first-class. Seeding 09:00–17:00 would leave every
 * after-midnight path untested while every test still passed.
 */
export const TRADING_OPEN_TIME = '11:00'
export const TRADING_CLOSE_TIME = '02:00'
/** Sunday through Saturday: docs/13 §2 says daily, with no closed day. */
export const TRADING_DAYS_OF_WEEK = Object.freeze([0, 1, 2, 3, 4, 5, 6])

/**
 * The premises, field by field, with the docs/13 line each value came from.
 *
 * `addressLine2` carries `E14` alongside the tower block because docs/13 §2 prints it as part of the
 * address and no column holds an Abu Dhabi sector code. Dropping it would lose a token of a published
 * address, and inventing a column for one token is worse.
 */
export const PREMISES_NAP = Object.freeze({
  /** docs/13 §1, trading name. The same spelling `legal_entity.trading_name` carries (0026). */
  displayName: 'BE RELAX - Massage Center and Spa',
  /** docs/13 §2 */
  addressLine1: '250 Al Meena Street',
  /** docs/13 §2 */
  addressLine2: 'Tower Block A/B, E14',
  /** docs/13 §2 — the M-Floor, which is the mezzanine and not floor 0 or 1. */
  floor: 'M-Floor',
  /** docs/13 §2. Also known as Al Mina / Tourist Club Area; the aliases are W-SITE-02's payload. */
  area: 'Al Zahiyah',
  /** docs/13 §1 — Abu Dhabi, so the authority is ADDED and the health regulator is DoH Abu Dhabi. */
  emirate: 'Abu Dhabi',
  countryCode: 'AE',
  /** docs/13 §3, prototype `02 557 6533`, in E.164. One source, nothing contradicting it. */
  phoneLandline: '+97125576533',
  /** docs/13 §3: `056 342 9399` and `+971 56 342 9399` are the same number in two formats. */
  phoneMobile: '+971563429399',
  /** Y1-nap. See {@link WHATSAPP_PENDING}. */
  phoneWhatsapp: WHATSAPP_PENDING,
  /** docs/13 §2, verbatim. */
  parkingNotes: 'Large public parking available at the back of the building',
  /** docs/13 §2 says Abu Dhabi; the zone is always an argument, and this is the business one. */
  timezone: 'Asia/Dubai',
})

/**
 * Writes the premises singleton and its seven trading-hour rows.
 *
 * Idempotent, and idempotent in the stronger sense the acceptance asks for: the second run produces the
 * same rows rather than merely not failing. The hours are replaced rather than upserted because they are
 * a **set** — a day removed from the schedule has to leave the table, and an upsert would leave it
 * behind reading as a day the premises still opens.
 *
 * Returns the number of rows written, for `pnpm seed`'s output.
 */
export async function seedPremises(sql: Sql): Promise<number> {
  const nap = PREMISES_NAP
  await sql`
    insert into premises (
      id, display_name, address_line_1, address_line_2, floor, area, emirate, country_code,
      phone_landline, phone_mobile, phone_whatsapp, parking_notes, timezone
    )
    values (
      ${PREMISES_ID}, ${nap.displayName}, ${nap.addressLine1}, ${nap.addressLine2}, ${nap.floor},
      ${nap.area}, ${nap.emirate}, ${nap.countryCode}, ${nap.phoneLandline}, ${nap.phoneMobile},
      ${nap.phoneWhatsapp}, ${nap.parkingNotes}, ${nap.timezone}
    )
    on conflict (id) do update set
      display_name   = excluded.display_name,
      address_line_1 = excluded.address_line_1,
      address_line_2 = excluded.address_line_2,
      floor          = excluded.floor,
      area           = excluded.area,
      emirate        = excluded.emirate,
      country_code   = excluded.country_code,
      phone_landline = excluded.phone_landline,
      phone_mobile   = excluded.phone_mobile,
      phone_whatsapp = excluded.phone_whatsapp,
      parking_notes  = excluded.parking_notes,
      timezone       = excluded.timezone
  `
  // Deliberately NOT in the column list above: po_box, makani_number, latitude, longitude, plus_code,
  // google_place_id, email and directions_notes. docs/13 states none of them, so they stay NULL rather
  // than being filled with something that would render on a map or in a footer as though it were known.
  await sql`delete from premises_hours`
  await sql`
    insert into premises_hours (day_of_week, open_time, close_time)
    select d, ${TRADING_OPEN_TIME}::time, ${TRADING_CLOSE_TIME}::time
      from unnest(${TRADING_DAYS_OF_WEEK as unknown as number[]}::smallint[]) as d
  `
  return 1 + TRADING_DAYS_OF_WEEK.length
}

/**
 * Ensures the `legal_entity` singleton **with the values 0026_invoice.sql seeds**, and nothing else.
 *
 * `on conflict (id) do nothing`, so this neither fights the migration nor reverts an owner's entry. Two
 * things about that are not stylistic:
 *
 *   - the legal name is snapshotted onto every tax invoice, so a seed that "ensured" the singleton with
 *     its own spelling would leave the wrong registered name in the row for every later suite. That has
 *     happened here once already — `opening-balances.itest.ts` did it, reasoning that `do nothing` would
 *     discard its version against a seeded database, and then ran against a database that predated the
 *     seed and won the race.
 *   - `trn` stays `TRN-PENDING-Y1-TRN` and `trade_licence_number` stays NULL. Both are Y1-trn, and the
 *     TRN placeholder fails `invoice_issuer_trn_is_fifteen_digits`, `invoice_issuer_trn_not_placeholder`
 *     and `requireIssuerTrn()` in `@berelax/core`. A tax invoice therefore cannot be issued at all until
 *     the real fifteen digits are entered, which is the intended state and not a gap.
 */
export const LEGAL_ENTITY_SEED = Object.freeze({
  /** docs/13 §1, legal entity. Goes on every tax invoice. */
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  /** docs/13 §1, trading name. */
  tradingName: 'BE RELAX - Massage Center and Spa',
  /** Y1-trn. Chosen to fail every TRN validation there is; see 0026_invoice.sql. */
  trn: 'TRN-PENDING-Y1-TRN',
  /** docs/13 §1: Abu Dhabi, so ADDED and not Dubai DET. */
  licensingAuthority: 'ADDED',
  emirate: 'Abu Dhabi',
})

export async function ensureLegalEntity(sql: Sql): Promise<number> {
  const entity = LEGAL_ENTITY_SEED
  const rows = await sql`
    insert into legal_entity (id, legal_name, trading_name, trn, licensing_authority, emirate)
    values (
      ${LEGAL_ENTITY_ID}, ${entity.legalName}, ${entity.tradingName}, ${entity.trn},
      ${entity.licensingAuthority}, ${entity.emirate}
    )
    on conflict (id) do nothing
    returning id
  `
  return rows.length
}
