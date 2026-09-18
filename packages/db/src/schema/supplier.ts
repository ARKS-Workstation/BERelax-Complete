import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Suppliers and their tax position — the mirror of the first half of 0028.
 *
 * The tax profile is a separate table because the two halves are asked about differently. The name and
 * the code are administrative and change freely; residency, the place-of-supply rule and the TRN are
 * the facts a VAT return is built on, and keeping them in their own row is what makes "every supplier
 * has an explicit tax position" a constraint rather than a habit — `supplier_has_tax_profile` refuses
 * at COMMIT a supplier with no profile.
 *
 * There is no contact person here and no invented name. Suppliers are companies, the real list is an
 * import (H-MIG), and a fixture that looks like production data eventually gets believed
 * (`packages/fixtures/src/synthetic.ts`).
 */
export const supplier = pgTable(
  'supplier',
  {
    supplierId: uuid('supplier_id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Stable handle for a seed, a recurring-cost definition (M-VAT-04) and a fixture. */
    code: text('code').notNull(),
    legalName: text('legal_name').notNull(),
    /** Null when the supplier trades under its legal name; never an empty string. */
    tradingName: text('trading_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('supplier_code_check', sql`${t.code} ~ '^[a-z0-9][a-z0-9-]*$'`),
    check('supplier_legal_name_check', sql`btrim(${t.legalName}) <> ''`),
    check(
      'supplier_trading_name_check',
      sql`${t.tradingName} is null or btrim(${t.tradingName}) <> ''`,
    ),
  ],
)

/** domestic | offshore. Mirrors the CHECK in 0028; there is no third value and no default. */
export const SUPPLIER_RESIDENCIES = ['domestic', 'offshore'] as const
export type SupplierResidency = (typeof SUPPLIER_RESIDENCIES)[number]

/**
 * How the supply is treated for UAE VAT.
 *
 * Stated rather than derived from residency: an offshore supplier's supply is either an imported
 * service (reverse charge, appearing in both VAT201 boxes) or outside the scope of UAE VAT entirely,
 * and nothing about the supplier's address says which.
 */
export const PLACE_OF_SUPPLY_RULES = [
  'domestic_uae',
  'imported_services_reverse_charge',
  'outside_scope',
] as const
export type PlaceOfSupplyRule = (typeof PLACE_OF_SUPPLY_RULES)[number]

export const supplierTaxProfile = pgTable(
  'supplier_tax_profile',
  {
    /** The primary key IS the foreign key: exactly one profile per supplier, by shape. */
    supplierId: uuid('supplier_id')
      .primaryKey()
      .references(() => supplier.supplierId),
    /**
     * `notNull()` and **no `.default()`**, matching the migration exactly.
     *
     * There is no safe default. Defaulting to domestic silently drops the reverse charge on every
     * offshore bill — the most commonly missed UAE VAT obligation at this size — and defaulting to
     * offshore invents one on the landlord. A mirror that added a default here would make the
     * database and the ORM disagree about whether an omission is an error, and the ORM is what a
     * future caller reads.
     */
    residency: text('residency').notNull(),
    placeOfSupplyRule: text('place_of_supply_rule').notNull(),
    /**
     * The supplier UAE TRN, or null for an unregistered supplier.
     *
     * Null is a decision: below the registration threshold an unregistered supplier is the normal
     * case, and a bill from one is postable but supports no claim. Fifteen digits is the published
     * format; the check-digit rule is [UNVERIFIED], so the pattern validates length and alphabet
     * only — refusing a real TRN would block a legitimate claim, which is worse than accepting a typo
     * the FTA will query.
     */
    trn: text('trn'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('supplier_tax_profile_residency_check', sql`${t.residency} in ('domestic', 'offshore')`),
    check(
      'supplier_tax_profile_place_of_supply_rule_check',
      sql`${t.placeOfSupplyRule} in ('domestic_uae', 'imported_services_reverse_charge', 'outside_scope')`,
    ),
    check('supplier_tax_profile_trn_check', sql`${t.trn} is null or ${t.trn} ~ '^[0-9]{15}$'`),
    // A UAE TRN is what makes a UAE tax invoice valid, and an offshore supplier does not issue one. In
    // practice such a row is a supplier marked offshore by mistake — the same mistake that loses the
    // reverse charge.
    check(
      'supplier_tax_profile_offshore_holds_no_uae_trn',
      sql`${t.residency} <> 'offshore' or ${t.trn} is null`,
    ),
    check(
      'supplier_tax_profile_rule_matches_residency',
      sql`case ${t.residency}
            when 'domestic' then ${t.placeOfSupplyRule} = 'domestic_uae'
            else ${t.placeOfSupplyRule} in ('imported_services_reverse_charge', 'outside_scope')
          end`,
    ),
  ],
)
