import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { serviceVariant } from './catalogue.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0025_price_list.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 */

/**
 * The `fils` domain from `0002_conventions.sql`: AED minor units as `bigint`.
 *
 * Declared here as it is in `./catalogue.ts` and carried as the string Postgres sends rather than a JS
 * `number`, because `int8` does not fit in a double and a silent precision loss in a money column is
 * discovered during a VAT reconciliation. The arithmetic lives in `@berelax/core`; `packages/db` must
 * never import it (the dependency runs the other way), so this layer moves the digits.
 */
const fils = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'fils'
  },
})

/**
 * An effective-dated gross price for one `service_variant`.
 *
 * Layer 3 of the resolution chain in `packages/core/src/pricing/resolve-price.ts`:
 * `base → variant → price_list → promotion`. The variant's own `gross_price_fils` is the fallback; a
 * row here overrides it for a stated period, so a price rise is a new row rather than an UPDATE that
 * rewrites what last month's bookings were worth.
 *
 * ## The constraint that is not expressible here
 *
 * `price_list_no_overlap` — `EXCLUDE USING gist (service_variant_id WITH =, daterange(valid_from,
 * valid_to, '[]') WITH &&)` — lives in the migration. It is what makes "the price on the 3rd" a question
 * with one answer, and it cannot be an application check: two concurrent inserts each see no conflict
 * and both commit. `packages/db/src/schema/price-list.itest.ts` asserts a second overlapping row is
 * refused with SQLSTATE 23P01, and `scripts/test-gates.mjs` asserts the same by the constraint's name.
 */
export const priceList = pgTable(
  'price_list',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    serviceVariantId: uuid('service_variant_id')
      .notNull()
      .references(() => serviceVariant.id, { onDelete: 'cascade' }),
    /** VAT-inclusive gross in integer fils. Net and VAT are derived in core, never stored here. */
    grossPriceFils: fils('gross_price_fils').notNull(),
    /** 'Ramadan 2027 menu'. What appears beside the figure when somebody asks why a booking cost this. */
    label: text('label').notNull(),
    validFrom: date('valid_from').notNull(),
    /** The **last** day the price applies, not the first day after it. `null` is open-ended. */
    validTo: date('valid_to'),
    /** The same provenance trio as `app_setting` and the catalogue, for the assumptions panel. */
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('price_list_variant_valid_from_idx').on(t.serviceVariantId, t.validFrom),
    // Strictly positive, as on service_variant: zero is a missing price, not a free treatment.
    check('price_list_gross_positive', sql`${t.grossPriceFils} > 0`),
    check('price_list_label_nonempty', sql`btrim(${t.label}) <> ''`),
    // A one-day price list is legitimate; a window that ends before it starts matches no date at all.
    check(
      'price_list_valid_to_not_before_from',
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
    check(
      'price_list_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)
