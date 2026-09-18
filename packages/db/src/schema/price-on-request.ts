import { sql } from 'drizzle-orm'
import { boolean, check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { serviceShape } from './catalogue.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0032_price_on_request.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * `serviceShape` is **imported** from `./catalogue.ts` rather than redeclared, for the same reason 0017
 * imports `treatmentStyle` from `./rooms.ts`: a second `pgEnum` with the same labels compiles, reads
 * identically and is a different Postgres type.
 */

/** How a price-on-request offering is expressed in the catalogue, if at all. */
export const priceOnRequestModelling = pgEnum('price_on_request_modelling', [
  'service_resource_shape',
  'not_modelled',
])

/**
 * The three offerings docs/13 §4 lists under "price on request" — **with no price column**.
 *
 * The absence is the content. docs/13 states what Four Hands, Couple Massage and Full Body Shaving each
 * need and states no figure for any of them, because the business quotes them at the desk (Y9-poa-prices).
 * Deriving one — the 1.8× multiplier this unit's manifest entry proposed — would put an invented price in
 * front of a customer and on a tax invoice, where nothing distinguishes it from a price the owner set.
 *
 * There is also nowhere to put it: `serviceVariant` is `(service × duration)` and duration is the only
 * pricing axis (ADR 0021), so a figure for a *shape* needs a third axis that 0017 and 0025 both refused.
 *
 * A row therefore means "quoted by hand, no figure in the system". The answer arrives as ordinary
 * catalogue data and **deletes** the row — it is never a cleared flag, which is what
 * `price_on_request_row_is_always_unanswered` pins.
 */
export const priceOnRequest = pgTable(
  'price_on_request',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The label as docs/13 §4 prints it. Public-facing, so B-CAT-05's lexicon lints it. */
    menuLabel: text('menu_label').notNull().unique(),
    /** The resource requirement, transcribed from the same table's second column. */
    resourceRequirement: text('resource_requirement').notNull(),
    modelledAs: priceOnRequestModelling('modelled_as').notNull(),
    /** Which footprint delivers it; null for a row docs/13 lists but the catalogue cannot express. */
    shape: serviceShape('shape'),
    /** The provenance trio, as on `app_setting` (0010) and the catalogue (0017). */
    isProvisional: boolean('is_provisional').notNull(),
    /** NOT NULL here, unlike on `service`: every row is an unanswered price, so every row has a reason. */
    provisionalNote: text('provisional_note').notNull(),
    openQuestionId: text('open_question_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('price_on_request_open_question_idx').on(t.openQuestionId),
    check('price_on_request_row_is_always_unanswered', sql`${t.isProvisional}`),
    check('price_on_request_menu_label_nonempty', sql`btrim(${t.menuLabel}) <> ''`),
    check(
      'price_on_request_menu_label_not_placeholder',
      sql`not is_placeholder_text(${t.menuLabel})`,
    ),
    check('price_on_request_requirement_nonempty', sql`btrim(${t.resourceRequirement}) <> ''`),
    check(
      'price_on_request_shape_matches_modelling',
      sql`(${t.modelledAs} = 'service_resource_shape') = (${t.shape} is not null)`,
    ),
    check(
      'price_on_request_names_an_open_question',
      sql`${t.openQuestionId} ~ '^Y[0-9]+-[a-z][a-z0-9-]*$'`,
    ),
    check('price_on_request_note_nonempty', sql`btrim(${t.provisionalNote}) <> ''`),
  ],
)
