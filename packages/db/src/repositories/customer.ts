import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The customer record: one row per phone number, created by whatever touched the number first.
 *
 * ## Why this is an upsert and not an insert
 *
 * There is no sign-up. A guest booking, a front-desk walk-in and an OTP request all arrive with a
 * phone number and no idea whether it has been seen before, and every one of them needs the same
 * answer: the `customer_id` for this number, creating it if it is new. An insert that assumes new
 * makes the second booking from one customer fail; a select-then-insert races itself on a Saturday
 * evening when the front desk and the website take the same number seconds apart. `on conflict do
 * nothing` plus a read is the only shape with neither problem.
 *
 * The UNIQUE index on `phone_e164` is what makes it work, and it only works on a canonical number:
 * every caller must normalise with `normalisePhone` from `@berelax/core` first. This package cannot do
 * it for them — `packages/db` must not import `packages/core`, the dependency runs the other way — so
 * the constraint in migration 0019 checks the shape of what arrives and refuses an un-normalised
 * value rather than storing a second row for the same person.
 *
 * ## Why a guest booking creates no credential
 *
 * There is nothing to create. ADR 0014: no accounts, no passwords, no password resets, no credential
 * stuffing surface and no customer-side hash to breach. `phone_verified_at` is null until an OTP
 * proves the number, and it stays null for a customer who books and never reads anything back — which
 * is most of them. Verification gates *reading* data, never taking a booking, exactly as the paper
 * diary did.
 */

export const CUSTOMER_ORIGINS = [
  'guest_booking',
  'front_desk',
  'otp_verification',
  'import',
] as const
export type CustomerOrigin = (typeof CUSTOMER_ORIGINS)[number]

export interface CustomerIdentityInput {
  /** Canonical E.164 from `normalisePhone`. The identity. */
  readonly phoneE164: string
  /**
   * What the customer called themselves, or null.
   *
   * Null is ordinary and is the default everywhere in this system: no name is invented for anybody,
   * and a record with no name is labelled `Customer 0042` (ADR 0020, packages/fixtures).
   */
  readonly displayName: string | null
  /** `nameMatchKey(displayName, phoneE164)` from `@berelax/core`, or null with no name. */
  readonly nameMatchKey: string | null
  readonly locale: 'en' | 'ar'
  readonly createdVia: CustomerOrigin
}

export interface CustomerRecord {
  readonly id: string
  readonly phoneE164: string
  /** Generated in the database from `phone_e164`: the trailing nine digits. */
  readonly phoneMatchKey: string
  readonly displayName: string | null
  readonly nameMatchKey: string | null
  readonly locale: string
  readonly phoneVerifiedAtIso: string | null
  readonly createdVia: string
}

interface CustomerRow {
  readonly id: string
  readonly phone_e164: string
  readonly phone_match_key: string
  readonly display_name: string | null
  readonly name_match_key: string | null
  readonly locale: string
  readonly phone_verified_at: Date | null
  readonly created_via: string
}

const toRecord = (row: CustomerRow): CustomerRecord => ({
  id: row.id,
  phoneE164: row.phone_e164,
  phoneMatchKey: row.phone_match_key,
  displayName: row.display_name,
  nameMatchKey: row.name_match_key,
  locale: row.locale,
  phoneVerifiedAtIso: row.phone_verified_at === null ? null : row.phone_verified_at.toISOString(),
  createdVia: row.created_via,
})

/** Reads a customer by canonical number. Null when the number is not a customer yet. */
export async function findCustomerByPhone(
  sql: Sql,
  phoneE164: string,
): Promise<CustomerRecord | null> {
  const rows = await sql<CustomerRow[]>`
    select id, phone_e164, phone_match_key, display_name, name_match_key, locale,
           phone_verified_at, created_via
    from customer
    where phone_e164 = ${phoneE164}
  `
  const row = rows[0]
  return row === undefined ? null : toRecord(row)
}

export interface EnsureCustomerResult {
  readonly customer: CustomerRecord
  /** False when the number was already a customer — which is the case this function exists for. */
  readonly created: boolean
}

/**
 * Returns the customer for a number, creating the row if the number is new.
 *
 * A name is filled in when the record has none and one is supplied, and **never overwritten**: the
 * front desk correcting a spelling must not be undone by the customer's next booking form, and a
 * guest booking that arrives with a nickname must not rename a record somebody curated.
 */
export async function ensureCustomer(
  uow: UnitOfWork,
  identity: CustomerIdentityInput,
): Promise<EnsureCustomerResult> {
  assertConsistentName(identity)

  const inserted = await uow.sql<CustomerRow[]>`
    insert into customer (phone_e164, display_name, name_match_key, locale, created_via)
    values (
      ${identity.phoneE164},
      ${identity.displayName},
      ${identity.nameMatchKey},
      ${identity.locale},
      ${identity.createdVia}
    )
    on conflict (phone_e164) do nothing
    returning id, phone_e164, phone_match_key, display_name, name_match_key, locale,
              phone_verified_at, created_via
  `
  const created = inserted[0]
  if (created !== undefined) {
    await uow.audit.record({
      action: 'customer.created',
      entityType: 'customer',
      entityId: created.id,
      operation: 'create',
      after: {
        phone_e164: created.phone_e164,
        created_via: created.created_via,
        has_display_name: created.display_name !== null,
      },
    })
    return { customer: toRecord(created), created: true }
  }

  const existing = await findCustomerByPhone(uow.sql, identity.phoneE164)
  if (existing === null) {
    // `do nothing` fired, so a row exists — unless somebody deleted it inside this transaction, which
    // would be a bug worth stopping rather than papering over with a retry loop.
    throw new AppError(
      'invariant_violated',
      `customer ${identity.phoneE164} conflicted on insert but could not be read back.`,
    )
  }

  if (existing.displayName === null && identity.displayName !== null) {
    await uow.sql`
      update customer
      set display_name = ${identity.displayName}, name_match_key = ${identity.nameMatchKey}
      where id = ${existing.id}
    `
    await uow.audit.record({
      action: 'customer.named',
      entityType: 'customer',
      entityId: existing.id,
      operation: 'update',
      before: { display_name: null },
      after: { display_name: identity.displayName },
    })
    return {
      customer: {
        ...existing,
        displayName: identity.displayName,
        nameMatchKey: identity.nameMatchKey,
      },
      created: false,
    }
  }

  return { customer: existing, created: false }
}

/**
 * Records that an OTP proved the number.
 *
 * Separate from `verifyOtpCode` on purpose: the OTP module knows nothing about customers and does not
 * read that table, which is what keeps a request for an unknown number indistinguishable from a
 * request for a known one. Joining the two is the caller's decision, after the code checked out.
 */
export async function markPhoneVerified(
  uow: UnitOfWork,
  phoneE164: string,
  verifiedAtIso: string,
): Promise<CustomerRecord> {
  const existing = await findCustomerByPhone(uow.sql, phoneE164)
  if (existing === null) {
    throw new AppError(
      'not_found',
      `No customer for ${phoneE164}. Create the record first: a verification with nothing to attach ` +
        'to would be a proof of possession nobody can use.',
    )
  }
  await uow.sql`
    update customer set phone_verified_at = ${verifiedAtIso} where id = ${existing.id}
  `
  await uow.audit.record({
    action: 'customer.phone_verified',
    entityType: 'customer',
    entityId: existing.id,
    operation: 'update',
    before: { phone_verified_at: existing.phoneVerifiedAtIso },
    after: { phone_verified_at: verifiedAtIso },
  })
  return { ...existing, phoneVerifiedAtIso: verifiedAtIso }
}

/**
 * Refuses a name and a key that disagree.
 *
 * The key is computed in `packages/core` and passed in, because this package may not import core and
 * the normalisation behind the key folds Arabic orthography and sorts words — a plpgsql
 * re-implementation would give one match key two definitions. The cost of that decision is that a
 * caller could pass a key belonging to a different name, and the merge would then miss the duplicate
 * with nothing reporting a fault. This catches the two cases that are certainly wrong.
 */
function assertConsistentName(identity: CustomerIdentityInput): void {
  const hasName = identity.displayName !== null && identity.displayName.trim().length > 0
  if (!hasName && identity.nameMatchKey !== null) {
    throw new AppError(
      'validation',
      'A name match key was supplied with no display name. The key is derived from the name; one ' +
        'without the other means they came from different places.',
      { details: { nameMatchKey: identity.nameMatchKey } },
    )
  }
  if (hasName && identity.nameMatchKey === null) {
    throw new AppError(
      'validation',
      `Customer ${identity.phoneE164} has a display name and no match key. Compute it with ` +
        'nameMatchKey() from @berelax/core — an unkeyed name is invisible to the duplicate merge.',
      { details: { displayName: identity.displayName } },
    )
  }
}
