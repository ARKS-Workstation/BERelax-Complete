import type { Sql } from '../connection.ts'
import {
  assertPublicDisplayNameLinted,
  type PublicDisplayNameLint,
} from '../repositories/catalogue.ts'
import { DOCS_13_PRICE_POINT_COUNT, docs13PriceCells } from './fixtures/prices-docs-13.ts'

/**
 * The real catalogue: the 32 prices of docs/13 §4, the publication of the 8 services 0017 drafted, and
 * the three offerings docs/13 lists with no price at all.
 *
 * ## Why this is a seed and not a migration
 *
 * 0017_catalogue.sql seeds the 8 `service` rows because `service_room_type_compat` already held 12 rows
 * keyed on their natural key and the composite foreign key needed a parent. It deliberately stops there
 * and says why: prices are business data, a migration cannot be re-run when one changes, and "two
 * sources for the same 32 numbers is one source too many". So the numbers arrive through `pnpm seed`,
 * from the single transcription in `./fixtures/prices-docs-13.ts`.
 *
 * `price_on_request` is the one structural piece this unit did add (0032), because the fact "docs/13
 * lists three offerings and prices none of them" had nowhere to live. Its rows are seeded here for the
 * same reason the prices are: they are data.
 *
 * ## The order is a precondition, not a preference
 *
 * 0029's `assert_service_publishable()` refuses to set `published_at` unless the service has a
 * compatibility row (ZC001), a resource shape (ZC002) **and** at least one priced variant (ZC003). 0012
 * and 0017 supplied the first two; the third is the 32 rows written below. So the variants go in first
 * and the publication follows, and a seed that published first would be refused by the database with
 * ZC003 rather than producing a half-built menu.
 *
 * ## Publication is what makes these names public
 *
 * 0017 inserted the eight `public_display_name` values as drafts — `published_at` was null, so nothing
 * rendered them. This function is the write that puts them in front of a customer, so it is the write
 * that has to lint them. `packages/db` may not import `packages/core`, so the lint arrives as a
 * function and is **required**: `assertPublicDisplayNameLinted` refuses to publish at all without one,
 * exactly as `setPublicDisplayName` refuses to rename without one. A default no-op here would be the one
 * write path on which a name the licence does not permit could reach the site, and the seed is the path
 * nobody reviews twice.
 */

/**
 * The three rows of docs/13 §4's "Price on request" table.
 *
 * Transcribed, including the resource requirements, and carrying **no figure**. The manifest entry for
 * this unit proposed deriving one as 1.8× the single-therapist equivalent; that is an invented fact
 * about this business, it would be quoted to a customer and printed on a tax invoice, and nothing on
 * either surface would distinguish it from a price the owner set. See the header of 0032 for the full
 * argument, including why there is no column to put such a figure in.
 */
export const PRICE_ON_REQUEST_SEED = Object.freeze([
  {
    /** docs/13 §4, "Price on request" table, row 1. */
    menuLabel: 'Four Hands Massage',
    resourceRequirement: '2 therapists, 1 standard room, 1 client',
    modelledAs: 'service_resource_shape' as const,
    shape: 'four_hands' as const,
    provisionalNote:
      'docs/13 §4 lists this under "price on request" and states no figure. Quoted at the desk; no ' +
      'price is seeded, because a derived one would be indistinguishable from a price the owner set. ' +
      'The resource footprint IS known and is the four_hands rows of service_resource_shape (0017).',
    openQuestionId: 'Y9-poa-prices',
  },
  {
    /** docs/13 §4, "Price on request" table, row 2. */
    menuLabel: 'Couple Massage',
    resourceRequirement: '2 therapists, 1 double-capacity room, 2 clients',
    modelledAs: 'service_resource_shape' as const,
    shape: 'couple' as const,
    provisionalNote:
      'docs/13 §4 lists this under "price on request" and states no figure. Quoted at the desk; no ' +
      'price is seeded. The resource footprint IS known and is the couple rows of ' +
      'service_resource_shape (0017), which is why the capacity-2 room exists.',
    openQuestionId: 'Y9-poa-prices',
  },
  {
    /** docs/13 §4, "Price on request" table, row 3. */
    menuLabel: 'Full Body Shaving',
    resourceRequirement:
      'Consumables and hygiene protocol; whether a specific room is required is unconfirmed',
    modelledAs: 'not_modelled' as const,
    shape: null,
    provisionalNote:
      'docs/13 §4 lists this under "price on request" and states no figure, and marks its room ' +
      'requirement [CONFIRM] (Y9-shaving-room). It is also not expressible in the catalogue: it is ' +
      'not one of the four treatment keys, not a shape of one, and docs/13 names it once with no ' +
      'style, so a (style x treatment) row would invent an Asian and an Arabic version of it.',
    openQuestionId: 'Y9-poa-prices',
  },
])

export interface CatalogueSeedResult {
  /** Variants inserted or repriced. Zero on a second run, which is what idempotent means here. */
  readonly variantsWritten: number
  /** Services that moved from draft to published. Zero once they are published. */
  readonly servicesPublished: number
  /** Price-on-request rows inserted or corrected. Zero on a second run. */
  readonly priceOnRequestWritten: number
  /** Every public display name that went through the lint, for the caller to assert against. */
  readonly lintedNames: readonly string[]
}

interface ServiceNameRow {
  readonly id: string
  readonly style: string
  readonly treatment_key: string
  readonly public_display_name: string
}

/**
 * Seeds the prices, publishes the services and records the price-on-request items.
 *
 * Idempotent in the strong sense: the `on conflict … do update … where` clauses write nothing when the
 * stored value already equals the seed, so a second run touches no row, fires no `updated_at` trigger
 * and leaves `published_at` at the instant of the first run. "Seeding twice yields identical output" is
 * therefore a property of the statements rather than of a snapshot that happens to ignore timestamps.
 */
export async function seedCatalogue(
  sql: Sql,
  options: { readonly lint: PublicDisplayNameLint },
): Promise<CatalogueSeedResult> {
  const cells = docs13PriceCells()
  if (cells.length !== DOCS_13_PRICE_POINT_COUNT) {
    // The nested Record in the fixture is total over three enums, so this is unreachable by
    // construction — and it is checked anyway, because "unreachable by construction" stops being true
    // the moment somebody widens one of those enums without widening the table.
    throw new Error(
      `docs/13 §4 states ${DOCS_13_PRICE_POINT_COUNT} price points but the transcription yields ` +
        `${cells.length}. One of the three enums and the price table disagree.`,
    )
  }

  let variantsWritten = 0
  for (const cell of cells) {
    const written = await sql`
      insert into service_variant
        (service_id, duration_minutes, gross_price_fils, is_provisional, provisional_note,
         open_question_id)
      select s.id, ${cell.durationMinutes}, ${cell.grossPriceFils}, false, null, null
        from service s
       where s.style = ${cell.style}::treatment_style
         and s.treatment_key = ${cell.treatmentKey}
      on conflict (service_id, duration_minutes) do update
         set gross_price_fils = excluded.gross_price_fils,
             is_provisional   = false,
             provisional_note = null,
             open_question_id = null
       where service_variant.gross_price_fils <> excluded.gross_price_fils
          or service_variant.is_provisional
      returning id
    `
    if (written.length === 0) {
      // Either the row was already correct, or no `service` row matched. The two are worth telling
      // apart: the second means 0017 has not been applied, and a seed that reported success would
      // leave a menu with fewer than 32 prices and nothing saying so.
      const [present] = await sql<{ n: string }[]>`
        select count(*)::text as n from service
         where style = ${cell.style}::treatment_style and treatment_key = ${cell.treatmentKey}
      `
      if (present?.n === '0') {
        throw new Error(
          `docs/13 §4 prices ${cell.style}/${cell.treatmentKey}, which has no service row. ` +
            'Apply 0017_catalogue.sql before seeding the catalogue.',
        )
      }
    }
    variantsWritten += written.length
  }

  // Lint every public name before publishing any of them. All eight, not the first failure's worth: an
  // owner told about one name fixes that one and runs the seed again.
  const names = await sql<ServiceNameRow[]>`
    select id, style::text as style, treatment_key, public_display_name
      from service
     where archived_at is null
     order by display_order, id
  `
  for (const row of names) assertPublicDisplayNameLinted(row.public_display_name, options.lint)

  const published = await sql`
    update service set published_at = now()
     where published_at is null
       and archived_at is null
    returning id
  `

  let priceOnRequestWritten = 0
  for (const item of PRICE_ON_REQUEST_SEED) {
    assertPublicDisplayNameLinted(item.menuLabel, options.lint)
    const written = await sql`
      insert into price_on_request
        (menu_label, resource_requirement, modelled_as, shape, is_provisional, provisional_note,
         open_question_id)
      values (
        ${item.menuLabel}, ${item.resourceRequirement},
        ${item.modelledAs}::price_on_request_modelling,
        ${item.shape}::service_shape, true, ${item.provisionalNote}, ${item.openQuestionId}
      )
      on conflict (menu_label) do update
         set resource_requirement = excluded.resource_requirement,
             modelled_as          = excluded.modelled_as,
             shape                = excluded.shape,
             provisional_note     = excluded.provisional_note,
             open_question_id     = excluded.open_question_id
       where price_on_request.resource_requirement is distinct from excluded.resource_requirement
          or price_on_request.modelled_as        is distinct from excluded.modelled_as
          or price_on_request.shape              is distinct from excluded.shape
          or price_on_request.provisional_note   is distinct from excluded.provisional_note
          or price_on_request.open_question_id   is distinct from excluded.open_question_id
      returning id
    `
    priceOnRequestWritten += written.length
  }

  return {
    variantsWritten,
    servicesPublished: published.length,
    priceOnRequestWritten,
    lintedNames: Object.freeze([
      ...names.map((row) => row.public_display_name),
      ...PRICE_ON_REQUEST_SEED.map((item) => item.menuLabel),
    ]),
  }
}
