import { generateKek } from '@berelax/clinical'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  openBankDetail,
  openDocumentNumber,
  rewrapStaffSecret,
  STAFF_SEALED_TABLES,
  STAFF_SECRET_ERRORS,
  type StaffSecretBinding,
  sealBankDetail,
  sealDocumentNumber,
  staffKek,
  staffSecretBinding,
} from './staff-secret.ts'

/**
 * The staff envelope, with no database.
 *
 * Every key here is 32 random bytes generated in this process and never written to a file, and every
 * fixture value fails its own check digit — `AE00…` cannot be a real IBAN, because `00` is not a
 * producible mod-97 residue. `pnpm pii` is the gate that makes that a rule rather than an intention.
 */

const BINDING: StaffSecretBinding = {
  table: 'employee_bank_detail',
  recordId: '01a00000-0000-7000-8000-000000000001',
  employeeId: '01a00000-0000-7000-8000-000000000002',
}

const OTHER_EMPLOYEE: StaffSecretBinding = {
  ...BINDING,
  employeeId: '01a00000-0000-7000-8000-000000000003',
}

const DETAIL = { iban: 'AE000000000000000000000', accountHolder: 'FIXTURE HOLDER (not real)' }

describe('the AAD binds a ciphertext to its row', () => {
  it('opens under the same binding and refuses another employee', () => {
    const kek = generateKek('v1')
    const sealed = sealBankDetail(kek, BINDING, DETAIL)
    // The control first: without it, a test asserting only the refusal passes against a seal that never
    // produced anything openable.
    expect(openBankDetail(kek, BINDING, sealed)).toEqual(DETAIL)
    expect(() => openBankDetail(kek, OTHER_EMPLOYEE, sealed)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.openFailed),
    )
  })

  it('refuses another row of the same employee, and another table', () => {
    const kek = generateKek('v1')
    const sealed = sealBankDetail(kek, BINDING, DETAIL)
    expect(() =>
      openBankDetail(kek, { ...BINDING, recordId: '01a00000-0000-7000-8000-00000000000f' }, sealed),
    ).toThrow(new RegExp(STAFF_SECRET_ERRORS.openFailed))
    expect(() => openBankDetail(kek, { ...BINDING, table: 'employee_document' }, sealed)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.openFailed),
    )
  })

  it('refuses a binding with a missing id rather than sealing against nothing', () => {
    // An unbound ciphertext can be moved between employees and will still decrypt, which is the single
    // failure the AAD exists to prevent. A binding assembled from a row that had not been inserted yet
    // is how it happens.
    for (const broken of [
      { ...BINDING, recordId: '' },
      { ...BINDING, employeeId: '' },
    ]) {
      expect(() => staffSecretBinding(broken)).toThrow(
        new RegExp(STAFF_SECRET_ERRORS.bindingIncomplete),
      )
    }
    expect(staffSecretBinding(BINDING)).toEqual({
      table: BINDING.table,
      recordId: BINDING.recordId,
      // The third field of a `RecordBinding` is the subject: the customer for clinical data, the
      // google_sub for a connection, the EMPLOYEE here.
      customerId: BINDING.employeeId,
    })
  })

  it('refuses a tampered ciphertext', () => {
    const kek = generateKek('v1')
    const sealed = sealBankDetail(kek, BINDING, DETAIL)
    const tampered = { ...sealed, ct: Buffer.concat([sealed.ct.subarray(0, -1), Buffer.from([0])]) }
    expect(() => openBankDetail(kek, BINDING, tampered)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.openFailed),
    )
  })

  it('refuses the wrong key, and says which version was tried without naming the payload', () => {
    const sealed = sealBankDetail(generateKek('v1'), BINDING, DETAIL)
    try {
      openBankDetail(generateKek('v2'), BINDING, sealed)
      expect.unreachable('the wrong key must not open a payload')
    } catch (error) {
      const message = (error as AppError).message
      expect(message).toContain(STAFF_SECRET_ERRORS.openFailed)
      expect(message).toContain(BINDING.recordId)
      // Never any part of the plaintext, and not its length either: for an IBAN the length narrows the
      // country.
      expect(message).not.toContain(DETAIL.iban)
      expect(message).not.toContain(DETAIL.accountHolder)
    }
  })
})

describe('sealing refuses an empty secret', () => {
  it('refuses a bank account with a blank IBAN or a blank holder', () => {
    const kek = generateKek('v1')
    for (const detail of [
      { iban: '', accountHolder: 'x' },
      { iban: '   ', accountHolder: 'x' },
      { iban: 'AE000000000000000000000', accountHolder: ' ' },
    ]) {
      expect(() => sealBankDetail(kek, BINDING, detail)).toThrow(
        new RegExp(STAFF_SECRET_ERRORS.bankDetailIncomplete),
      )
    }
  })

  it('refuses a blank document number, which would read as a credential that was checked', () => {
    expect(() =>
      sealDocumentNumber(generateKek('v1'), { ...BINDING, table: 'employee_document' }, '  '),
    ).toThrow(/empty document number/)
  })

  it('trims what it seals, so two spellings of one account are one ciphertext content', () => {
    const kek = generateKek('v1')
    const padded = sealBankDetail(kek, BINDING, {
      iban: ' AE000000000000000000000 ',
      accountHolder: ' FIXTURE HOLDER (not real) ',
    })
    expect(openBankDetail(kek, BINDING, padded)).toEqual(DETAIL)
  })
})

describe('re-wrapping never touches the ciphertext', () => {
  it('returns only the two columns migration 0050 lets an UPDATE change', () => {
    const oldKek = generateKek('v1')
    const newKek = generateKek('v2')
    const sealed = sealDocumentNumber(
      oldKek,
      { ...BINDING, table: 'employee_document' },
      '784-0000-0000000-0',
    )
    const binding: StaffSecretBinding = { ...BINDING, table: 'employee_document' }
    const rewrapped = rewrapStaffSecret(oldKek, newKek, binding, sealed)
    // Two keys only. A function returning all five would invite an UPDATE writing all five, which the
    // database refuses as `StaffSealedRowImmutable` — so the shape of the return value is the guard.
    expect(Object.keys(rewrapped).sort()).toEqual(['kid', 'wrappedKey'])
    expect(rewrapped.kid).toBe('v2')
    expect(rewrapped.wrappedKey.equals(sealed.wrappedKey)).toBe(false)

    const moved = { ...sealed, wrappedKey: rewrapped.wrappedKey, kid: rewrapped.kid }
    expect(moved.ct.equals(sealed.ct)).toBe(true)
    expect(moved.nonce.equals(sealed.nonce)).toBe(true)
    expect(openDocumentNumber(newKek, binding, moved)).toBe('784-0000-0000000-0')
    // The retired key no longer opens it, which is what makes the re-wrap real rather than a label change.
    expect(() => openDocumentNumber(oldKek, binding, moved)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.openFailed),
    )
  })

  it('refuses to re-wrap a payload bound to a different row', () => {
    const oldKek = generateKek('v1')
    const sealed = sealBankDetail(oldKek, BINDING, DETAIL)
    expect(() => rewrapStaffSecret(oldKek, generateKek('v2'), OTHER_EMPLOYEE, sealed)).toThrow(
      AppError,
    )
  })
})

describe('the estate declares what it seals', () => {
  it('names both sealed tables, and the AAD uses the exact strings', () => {
    expect([...STAFF_SEALED_TABLES]).toEqual(['employee_bank_detail', 'employee_document'])
    for (const table of STAFF_SEALED_TABLES) {
      expect(staffSecretBinding({ ...BINDING, table }).table).toBe(table)
    }
  })

  it('refuses a key that is not 32 bytes, or a version label that is missing', () => {
    const material = Buffer.alloc(32, 7).toString('base64')
    expect(staffKek(material, 'v1').version).toBe('v1')
    expect(() => staffKek(Buffer.alloc(16, 7).toString('base64'), 'v1')).toThrow(/32 bytes/)
    expect(() => staffKek(material, '')).toThrow(/version is required/)
  })

  it('refuses a payload that decrypts to something other than a bank account', () => {
    const kek = generateKek('v1')
    // A document number sealed under a bank binding: the AAD is satisfied, the bytes open, and the JSON
    // is not there. The failure has to be named rather than surfacing as `undefined.iban` two layers up.
    const sealed = sealDocumentNumber(kek, BINDING, '784-0000-0000000-0')
    expect(() => openBankDetail(kek, BINDING, sealed)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.payloadNotUnderstood),
    )
    const partial = sealDocumentNumber(kek, BINDING, JSON.stringify({ iban: 'x' }))
    expect(() => openBankDetail(kek, BINDING, partial)).toThrow(
      new RegExp(STAFF_SECRET_ERRORS.payloadNotUnderstood),
    )
  })
})
