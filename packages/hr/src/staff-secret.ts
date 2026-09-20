import { type Kek, open, parseKek, type RecordBinding, rewrap, seal } from '@berelax/clinical'
import { AppError } from '@berelax/shared'

/**
 * Envelope encryption for staff PII: bank accounts and identity-document numbers.
 *
 * docs/04 §7: "field-level encryption plus separate access control on identity document numbers and
 * bank details, with every read audited." Volume encryption on the managed database protects a stolen
 * disk and nothing else; the realistic breach is somebody holding a valid database credential, and an
 * IBAN or an Emirates ID in a plaintext column is in every backup, every CSV export and every log line
 * that ever echoed a row.
 *
 * ## It does NOT invent a second scheme
 *
 * The primitives come from `@berelax/clinical` — AES-256-GCM under a fresh per-record data key, that key
 * wrapped by a KEK held outside the database, the key version stored alongside so rotation is a re-wrap,
 * and AAD binding each ciphertext to its own row. This is exactly what `packages/google/src/token-store.ts`
 * did for refresh tokens and for the reason it states: "two encryption schemes in one codebase means two
 * key hierarchies to rotate and two chances to get the AAD wrong; one scheme reviewed twice is strictly
 * better than two reviewed once."
 *
 * `RecordBinding`'s third field is the identity the row belongs to. For clinical data that is the
 * customer, for a Google connection the `google_sub`, and here the **employee id** — never the staff
 * reference, which is an editable label, and never the document type, which does not distinguish two
 * passports.
 *
 * ## A THIRD key, and why
 *
 * `STAFF_PII_KEK`, not `CLINICAL_KEK`. H-HARD-03 settled the principle when it chose two keys over one:
 * the clinical store is designed to relocate to a UAE-hosted database and takes its key with it (ADR
 * 0010, Y5-residency), and an employment record does not move with it. Sealing staff PII under the
 * clinical key would either strand this estate at relocation or require that key to exist in two places.
 *
 * ## What this means for rotation, stated rather than implied
 *
 * `rewrapStaffSecret` is the per-row primitive, the same shape `packages/google/src/rewrap.ts` has, and
 * like that one it has **no command driving it yet**. `scripts/rotate-kek.mjs` cannot be pointed at this
 * estate: its table list is a literal union of the two clinical tables, every query in
 * `packages/clinical/src/crypto/postgres-key-store.ts` names `customer_id`, and its registry is
 * `clinical.kek_version`, which lives in the clinical schema precisely so that it relocates with the
 * store. Widening it would also put two of the three most sensitive keys in this system into one
 * process, which H-HARD-03 declined to do for the Google key. What this module guarantees is that the
 * estate is *rotatable*: the five sealed columns have the shape the rotation reads, the re-wrap never
 * touches a ciphertext, and migration 0050's ZS002/ZS003 triggers hold that at the database.
 */

/** The tables holding sealed staff PII. The AAD's `table` field is this exact string. */
export const STAFF_SEALED_TABLES = ['employee_bank_detail', 'employee_document'] as const
export type StaffSealedTable = (typeof STAFF_SEALED_TABLES)[number]

/**
 * Error names, shared with migration 0050 so one rule has one name in both layers.
 *
 * ZS002 and ZS003 are raised by the database; the rest by this module. A refused operation names its
 * reason because a bare throw is indistinguishable from a typo in a column name, and the person reading
 * it is usually reading it at the wrong end of the day.
 */
export const STAFF_SECRET_ERRORS = Object.freeze({
  /** The binding was incomplete, so the ciphertext would not be bound to a row at all. */
  bindingIncomplete: 'StaffSecretBindingIncomplete',
  /** Decryption failed: a wrong key, a tampered ciphertext, or a payload moved to another row. */
  openFailed: 'StaffSecretOpenFailed',
  /** The sealed payload is not the JSON object this module wrote. */
  payloadNotUnderstood: 'StaffSecretPayloadNotUnderstood',
  /** A bank payload with no IBAN. A blank number decrypts cleanly and pays nobody. */
  bankDetailIncomplete: 'StaffBankDetailIncomplete',
})

/** Identifies the row a staff ciphertext belongs to. Every field participates in the AAD. */
export interface StaffSecretBinding {
  readonly table: StaffSealedTable
  /** The row's own primary key. */
  readonly recordId: string
  /** The employee the row belongs to — the subject, and the half of the AAD that a swap changes. */
  readonly employeeId: string
}

/**
 * The AAD binding, as `@berelax/clinical` expresses one.
 *
 * Refuses a blank id rather than sealing against `'undefined'`: an unbound ciphertext can be moved
 * between employees, which is the single failure the AAD exists to prevent, and a binding assembled from
 * a row that had not been inserted yet is how it happens.
 */
export function staffSecretBinding(binding: StaffSecretBinding): RecordBinding {
  if (!binding.recordId || !binding.employeeId) {
    throw new AppError(
      'validation',
      `${STAFF_SECRET_ERRORS.bindingIncomplete}: a staff secret binding needs both the row id and the ` +
        'employee id. An unbound ciphertext can be moved between employees and will still decrypt.',
      { details: { table: binding.table, hasRecordId: Boolean(binding.recordId) } },
    )
  }
  return {
    table: binding.table,
    recordId: binding.recordId,
    customerId: binding.employeeId,
  }
}

/** One sealed staff secret, as the five columns it occupies. */
export interface SealedStaffSecret {
  readonly ct: Buffer
  readonly nonce: Buffer
  readonly wrappedKey: Buffer
  /** The KEK version. `kid` follows migration 0016's spelling for the same estate shape. */
  readonly kid: string
  readonly aadFp: string
}

/** A staff bank account, as it exists in memory and never in a column. */
export interface BankDetail {
  readonly iban: string
  readonly accountHolder: string
}

/** Reads the staff KEK from an already-resolved pair of values. Never reads the environment itself. */
export function staffKek(material: string, version: string): Kek {
  return parseKek(material, version)
}

function sealString(kek: Kek, binding: StaffSecretBinding, plaintext: string): SealedStaffSecret {
  const sealed = seal(kek, staffSecretBinding(binding), plaintext)
  return {
    ct: sealed.ciphertext,
    nonce: sealed.nonce,
    wrappedKey: sealed.wrappedDataKey,
    kid: sealed.kekVersion,
    aadFp: sealed.aadFingerprint,
  }
}

function openString(kek: Kek, binding: StaffSecretBinding, sealed: SealedStaffSecret): string {
  try {
    return open(kek, staffSecretBinding(binding), {
      ciphertext: sealed.ct,
      nonce: sealed.nonce,
      wrappedDataKey: sealed.wrappedKey,
      kekVersion: sealed.kid,
      aadFingerprint: sealed.aadFp,
    })
  } catch (error) {
    // Deliberately says which row and which key version, and never any part of the payload — including
    // its length, which for an IBAN narrows the country.
    throw new AppError(
      'forbidden',
      `${STAFF_SECRET_ERRORS.openFailed}: ${binding.table} ${binding.recordId} could not be decrypted ` +
        `under key version "${sealed.kid}" for employee ${binding.employeeId}. Either the key is wrong, ` +
        'or the row identity no longer matches the AAD the ciphertext is bound to — which is what a ' +
        "ciphertext moved onto another employee's row looks like.",
      {
        cause: error,
        details: { table: binding.table, recordId: binding.recordId, kid: sealed.kid },
      },
    )
  }
}

/**
 * Seals a bank account as one JSON payload.
 *
 * One payload rather than a column per field, so there is nothing left in the row to read: a bank name
 * or a last-four column would make a raw `select *` informative again, which is the property 0050's
 * table comment claims.
 */
export function sealBankDetail(
  kek: Kek,
  binding: StaffSecretBinding,
  detail: BankDetail,
): SealedStaffSecret {
  if (!detail.iban.trim() || !detail.accountHolder.trim()) {
    throw new AppError(
      'validation',
      `${STAFF_SECRET_ERRORS.bankDetailIncomplete}: refusing to seal a bank account without both an ` +
        'IBAN and an account holder. A blank number decrypts cleanly and pays nobody, and the failure ' +
        'surfaces as an unexplained rejected salary file weeks later.',
    )
  }
  // Keys in a fixed order, so the same account seals to the same plaintext bytes and a content
  // comparison between two rows means something.
  return sealString(
    kek,
    binding,
    JSON.stringify({ iban: detail.iban.trim(), accountHolder: detail.accountHolder.trim() }),
  )
}

/** Opens a bank account. The plaintext exists only in the caller's frame. */
export function openBankDetail(
  kek: Kek,
  binding: StaffSecretBinding,
  sealed: SealedStaffSecret,
): BankDetail {
  const plaintext = openString(kek, binding, sealed)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch (error) {
    throw new AppError(
      'invariant_violated',
      `${STAFF_SECRET_ERRORS.payloadNotUnderstood}: ${binding.table} ${binding.recordId} decrypted to ` +
        'something that is not the JSON object this module seals.',
      { cause: error },
    )
  }
  const record = parsed as Partial<BankDetail>
  if (typeof record.iban !== 'string' || typeof record.accountHolder !== 'string') {
    throw new AppError(
      'invariant_violated',
      `${STAFF_SECRET_ERRORS.payloadNotUnderstood}: ${binding.table} ${binding.recordId} decrypted to a ` +
        'payload without both an iban and an accountHolder.',
    )
  }
  return { iban: record.iban, accountHolder: record.accountHolder }
}

/** Seals a document number. Emirates ID, passport, labour card: whatever the type, a string. */
export function sealDocumentNumber(
  kek: Kek,
  binding: StaffSecretBinding,
  number: string,
): SealedStaffSecret {
  if (!number.trim()) {
    throw new AppError(
      'validation',
      'Refusing to seal an empty document number. A blank ciphertext decrypts to a blank number and ' +
        'reads as a credential that was checked.',
    )
  }
  return sealString(kek, binding, number.trim())
}

/** Opens a document number. */
export function openDocumentNumber(
  kek: Kek,
  binding: StaffSecretBinding,
  sealed: SealedStaffSecret,
): string {
  return openString(kek, binding, sealed)
}

/**
 * Re-wraps a staff secret's data key under a new KEK **without decrypting the payload**.
 *
 * The per-row primitive a rotation is made of, and the reason the envelope exists: rotating the key
 * touches a few dozen bytes per row rather than re-encrypting anything. Returns only the two columns
 * that change, because those are the only two migration 0050 permits an UPDATE to touch — a function
 * returning all five would invite an UPDATE that writes all five and is refused as `StaffSealedRowImmutable`.
 */
export function rewrapStaffSecret(
  oldKek: Kek,
  newKek: Kek,
  binding: StaffSecretBinding,
  sealed: SealedStaffSecret,
): { readonly wrappedKey: Buffer; readonly kid: string } {
  const rewrapped = rewrap(oldKek, newKek, staffSecretBinding(binding), {
    ciphertext: sealed.ct,
    nonce: sealed.nonce,
    wrappedDataKey: sealed.wrappedKey,
    kekVersion: sealed.kid,
    aadFingerprint: sealed.aadFp,
  })
  return { wrappedKey: rewrapped.wrappedDataKey, kid: rewrapped.kekVersion }
}
