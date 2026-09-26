import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { serviceVariant } from './catalogue.ts'
import { customer } from './customer.ts'
import { journalEntry } from './ledger.ts'
import { businessDay } from './trading.ts'

/**
 * Versioned package templates and the package sale, mirroring `0078_package.sql`.
 *
 * One file for all five tables, deliberately: `pnpm db:drift` keys its map on the TABLE name, so a second
 * file declaring `package_balance` would silently win, and 0063's NOTE asked for one mirror per unit.
 * M-TILL-10 extends this file rather than shadowing it.
 *
 * ## Editing a template inserts a version; it does not change one
 *
 * `packageTemplateVersion` and `packageTemplateLine` refuse UPDATE and DELETE (ZG001), so the row every
 * outstanding balance points at cannot be reached by an edit at all. The current version of a template is
 * `max(version)` — there is deliberately no `currentVersionId` pointer, because a pointer is a second
 * answer to a question `max()` already answers and its failure mode is a pointer at a version a later
 * insert superseded.
 *
 * ## A sale is a LIABILITY, not a sale
 *
 * **[UNVERIFIED] Y11-vat-package.** A package sale posts `Dr` tender / `Cr 2050 Deferred revenue` at the
 * FULL gross, and nothing to any revenue account and nothing to `2030`: the provisional (and strictest
 * safe) answer puts the date of supply at redemption, so the salon holds the money as a liability until a
 * treatment is delivered against it. `package_sale_posts_deferred_revenue_only` (ZG005) is that rule as a
 * database refusal, measured over TOTAL movement rather than the net — a posting that credited `4010` and
 * debited the contra `4095` by the same figure nets to zero and has recognised revenue on a package sale.
 *
 * Releasing `2050` into `4020` at redemption is M-TILL-10's.
 *
 * Nothing writes through Drizzle. The mirror exists so `pnpm db:drift` can compare the two directions.
 */

/**
 * The identity of a package: a stable key, and nothing else that can be wrong.
 *
 * `retiredAt` withdraws the whole template from sale. Retired rather than deleted, `cashDrawer`'s reason
 * one unit along: every version and every balance sold under one points here, and a package somebody has
 * paid for has to keep resolving.
 */
export const packageTemplate = pgTable(
  'package_template',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Lower snake case, so a display-label change cannot silently become a second package. */
    templateKey: text('template_key').notNull().unique(),
    /** `null` means on sale. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('package_template_key_is_snake_case', sql`${t.templateKey} ~ '^[a-z][a-z0-9_]*$'`)],
)

/**
 * Everything a buyer agrees to, frozen.
 *
 * The three policy columns are Y9-package-policy's, provisionally 6 months / non-transferable /
 * balance retained. The provenance trio is per VERSION and not per column: the three are one decision
 * somebody takes in one sitting, and a separate flag per column would let the Unconfirmed Assumptions
 * panel clear for an answer nobody gave. `working_hours_rule`'s argument (0059), and the same shape —
 * answering the question publishes a NEW version, and the panel row leaves by that version being
 * confirmed rather than by this one being edited.
 *
 * No `updatedAt`, and none is possible: there is no second version of a row here.
 */
export const packageTemplateVersion = pgTable(
  'package_template_version',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    templateId: uuid('template_id')
      .notNull()
      .references(() => packageTemplate.id, { onDelete: 'restrict' }),
    /** 1, 2, 3 … An edit is the next one. Positional, so two reads list the versions in one order. */
    version: smallint('version').notNull(),
    internalName: text('internal_name').notNull(),
    publicDisplayName: text('public_display_name').notNull(),
    /** VAT-inclusive gross in integer fils (ADR 0007). Strictly positive in the database. */
    priceFils: bigint('price_fils', { mode: 'bigint' }).notNull(),
    validityMonths: smallint('validity_months').notNull(),
    transferable: boolean('transferable').notNull(),
    /** `'retained'` or `'forfeited'`. Text plus a CHECK, `cashSession.status`'s reason (0076). */
    unredeemedBalancePolicy: text('unredeemed_balance_policy').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('package_template_version_one_row_per_number').on(t.templateId, t.version),
    index('package_template_version_template_idx').on(t.templateId, t.version),
    check('package_template_version_positive', sql`${t.version} >= 1`),
    check('package_template_version_price_positive', sql`${t.priceFils} > 0`),
    check('package_template_version_validity_bounded', sql`${t.validityMonths} between 1 and 60`),
    check(
      'package_template_version_balance_policy_known',
      sql`${t.unredeemedBalancePolicy} in ('retained', 'forfeited')`,
    ),
    check(
      'package_template_version_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)

/**
 * One entitlement of a version: a catalogue VARIANT and how many sessions of it.
 *
 * A variant and not a service, because duration × price is the only pricing axis (ADR 0021): "six
 * massages" without a duration is six of a price the catalogue does not have.
 *
 * `package_template_line_service_not_archived` (ZG003) refuses a line whose service is archived. Checked
 * at INSERT only — a service archived afterwards does not void a paid-for entitlement, because versions
 * are immutable and the balances sold under one are contracts.
 */
export const packageTemplateLine = pgTable(
  'package_template_line',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => packageTemplateVersion.id, { onDelete: 'restrict' }),
    lineNo: smallint('line_no').notNull(),
    serviceVariantId: uuid('service_variant_id')
      .notNull()
      .references(() => serviceVariant.id, { onDelete: 'restrict' }),
    sessionCount: smallint('session_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('package_template_line_one_row_per_number').on(t.templateVersionId, t.lineNo),
    // One line per variant: two lines for one variant is one entitlement expressed twice, and it would
    // give a redemption two balances to draw down in either order.
    unique('package_template_line_one_row_per_variant').on(t.templateVersionId, t.serviceVariantId),
    index('package_template_line_variant_idx').on(t.serviceVariantId),
    check('package_template_line_no_positive', sql`${t.lineNo} >= 1`),
    check('package_template_line_sessions_positive', sql`${t.sessionCount} >= 1`),
  ],
)

/**
 * The sale: the contract, with the terms snapshotted and held equal to the version it names.
 *
 * Five columns duplicate the version, which is normally the defect this codebase fights, so the reason
 * has to be good: the sale is the CONTRACT, and a contract has to be readable as a document rather than
 * as a join — `invoice`'s reason for snapshotting the issuer's legal name. The two cannot drift, because
 * `package_sale_terms_match_version` (ZG002) holds all five equal at COMMIT, plus `sessionCount` against
 * `sum(packageTemplateLine.sessionCount)`.
 *
 * `expiresOn` is GENERATED — `(trading_date + make_interval(months => validity_months))::date` — so the
 * derivation exists once, in the place the row lives. M-TILL-10 reads this column rather than repeating
 * the arithmetic.
 */
export const packageSale = pgTable(
  'package_sale',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'restrict' }),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => packageTemplateVersion.id, { onDelete: 'restrict' }),
    /**
     * The BUSINESS DAY, a foreign key into `business_day` (0011).
     *
     * Trading runs 11:00–02:00, so a 01:30 sale belongs to the previous trading date and a validity
     * counted from the calendar date would expire a day early.
     */
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    priceFils: bigint('price_fils', { mode: 'bigint' }).notNull(),
    sessionCount: smallint('session_count').notNull(),
    validityMonths: smallint('validity_months').notNull(),
    transferable: boolean('transferable').notNull(),
    unredeemedBalancePolicy: text('unredeemed_balance_policy').notNull(),
    /** Generated in SQL. The one statement of when the customer's money runs out. */
    expiresOn: date('expires_on').notNull(),
    /** Mandatory and a real foreign key: money taken with no entry behind it is unexplainable. */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('package_sale_customer_idx').on(t.customerId, t.tradingDate),
    index('package_sale_version_idx').on(t.templateVersionId),
    index('package_sale_expiry_idx').on(t.expiresOn),
    check('package_sale_price_positive', sql`${t.priceFils} > 0`),
    check('package_sale_sessions_positive', sql`${t.sessionCount} >= 1`),
    check('package_sale_validity_bounded', sql`${t.validityMonths} between 1 and 60`),
    check(
      'package_sale_balance_policy_known',
      sql`${t.unredeemedBalancePolicy} in ('retained', 'forfeited')`,
    ),
  ],
)

/**
 * The entitlement, and the share of the sale price it carries.
 *
 * `valueFils` is allocated largest-remainder across the version's lines in proportion to what each would
 * have cost at the version's own prices, so the shares sum to the price EXACTLY
 * (`package_balance_shares_sum_to_the_price`, ZG006). Without it a redemption has no figure to release:
 * "the package cost 3,000" does not say what one facial out of it was worth, and re-deriving the share at
 * redemption time would give a different answer the moment the catalogue's prices moved.
 *
 * `sessionsRedeemed` and `releasedFils` are M-TILL-10's to move. Their ceilings are declared HERE, with
 * the columns, because a ceiling added later is a ceiling that was absent while rows were being written.
 */
export const packageBalance = pgTable(
  'package_balance',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    packageSaleId: uuid('package_sale_id')
      .notNull()
      .references(() => packageSale.id, { onDelete: 'restrict' }),
    /** The version's line number, carried so a balance reads as "line 2 of what you bought". */
    lineNo: smallint('line_no').notNull(),
    serviceVariantId: uuid('service_variant_id')
      .notNull()
      .references(() => serviceVariant.id, { onDelete: 'restrict' }),
    sessionsTotal: smallint('sessions_total').notNull(),
    sessionsRedeemed: smallint('sessions_redeemed').notNull(),
    valueFils: bigint('value_fils', { mode: 'bigint' }).notNull(),
    releasedFils: bigint('released_fils', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('package_balance_one_row_per_line').on(t.packageSaleId, t.lineNo),
    unique('package_balance_one_row_per_variant').on(t.packageSaleId, t.serviceVariantId),
    index('package_balance_sale_idx').on(t.packageSaleId, t.lineNo),
    index('package_balance_variant_idx').on(t.serviceVariantId),
    check('package_balance_line_no_positive', sql`${t.lineNo} >= 1`),
    check('package_balance_sessions_positive', sql`${t.sessionsTotal} >= 1`),
    check('package_balance_redeemed_nonneg', sql`${t.sessionsRedeemed} >= 0`),
    check('package_balance_value_positive', sql`${t.valueFils} > 0`),
    // Two ceilings and not one: a drawdown moves both, and a redemption that moved only the money would
    // leave an entitlement nobody can count.
    check('package_balance_cannot_overdraw', sql`${t.sessionsRedeemed} <= ${t.sessionsTotal}`),
    check('package_balance_cannot_overrelease', sql`${t.releasedFils} <= ${t.valueFils}`),
  ],
)
