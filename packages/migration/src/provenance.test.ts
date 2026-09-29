import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { GENERATED_COLUMNS } from './checksum.ts'
import { assertRelationName, canonicalise, contentHash, fileHash } from './provenance.ts'

/**
 * The two hashes every claim in H-MIG-01 rests on, tested where they can be tested: on their own.
 *
 * Idempotence is decided on the row hash and resumability on the file hash, so a hash that answers the same
 * for two different rows produces a MISSING row on a re-import, and a hash that answers differently for the
 * same row produces a duplicate. Neither failure announces itself: the first looks like a file that was
 * already imported, and the second looks like a spreadsheet with a repeated line.
 *
 * Every assertion below is paired with a control that must move, because "the hash is stable" is satisfied by
 * a function that returns a constant.
 */
describe('canonicalise', () => {
  it('is independent of key order and dependent on every value', () => {
    expect(canonicalise({ b: 2, a: 1 })).toBe(canonicalise({ a: 1, b: 2 }))
    // The control. Without it the assertion above is satisfied by a function that ignores its argument,
    // which is exactly the failure that makes two unequal rows hash alike.
    expect(canonicalise({ a: 1, b: 2 })).not.toBe(canonicalise({ a: 1, b: 3 }))
    expect(canonicalise({ a: 1, b: 2 })).not.toBe(canonicalise({ a: 1 }))
  })

  it('keeps array order, because a list of anything in a spreadsheet is ordered', () => {
    expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]))
    expect(canonicalise({ xs: [1, 2] })).toBe(canonicalise({ xs: [1, 2] }))
  })

  it('treats an absent key and a key holding undefined as the same fact', () => {
    // A parser that emits `{ note: undefined }` for a blank cell and one that omits the key entirely
    // describe the same row. Hashing them differently would make idempotence depend on which parser ran.
    expect(canonicalise({ a: 1, note: undefined })).toBe(canonicalise({ a: 1 }))
  })

  it('refuses a non-finite number rather than hashing it as null', () => {
    // `JSON.stringify(NaN)` is `null`, so a cell that arrived as a division by zero would hash exactly like
    // an empty cell — two different rows, one hash, and the second one silently skipped as already
    // imported.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalise({ amount: value })).toThrow(AppError)
    }
    expect(canonicalise({ amount: 0 })).toBe('{"amount":0}')
  })

  it('refuses a value it cannot represent, rather than dropping it', () => {
    // A staged payload is stored as jsonb and read back by a report. A function or a symbol reaching here
    // means the importer's parser produced something the ledger cannot hold, and silently omitting it would
    // hash two different rows alike.
    expect(() => canonicalise({ fn: () => 1 })).toThrow(AppError)
    expect(() => canonicalise({ s: Symbol('x') })).toThrow(AppError)
  })

  it('distinguishes a number from the string of that number', () => {
    // The probe importer stages an amount as the TEXT that was typed, deliberately. If these hashed alike,
    // a corrected file that turned "1000" into 1000 would read as unchanged.
    expect(canonicalise({ a: 1 })).not.toBe(canonicalise({ a: '1' }))
  })
})

describe('contentHash and fileHash', () => {
  it('are sha-256 in lower-case hex', () => {
    // A published vector rather than a self-consistent one: sha-256 of "abc". A hash tested only against
    // itself is a hash that can be silently replaced by a different one.
    expect(fileHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
    expect(contentHash({ a: 1 })).toBe(createHash('sha256').update('{"a":1}', 'utf8').digest('hex'))
  })

  it('hashes the same bytes whether they arrive as a string or a buffer', () => {
    expect(fileHash(new TextEncoder().encode('abc'))).toBe(fileHash('abc'))
    expect(fileHash('abc')).not.toBe(fileHash('abd'))
  })

  it('answers the same for two payloads that differ only in key order', () => {
    expect(contentHash({ probeKey: 'probe-1', label: 'A' })).toBe(
      contentHash({ label: 'A', probeKey: 'probe-1' }),
    )
    expect(contentHash({ probeKey: 'probe-1', label: 'A' })).not.toBe(
      contentHash({ probeKey: 'probe-1', label: 'B' }),
    )
  })
})

describe('assertRelationName', () => {
  it('requires a schema-qualified name', () => {
    expect(assertRelationName('import_staging.import_probe_entity')).toBe(
      'import_staging.import_probe_entity',
    )
    // Unqualified resolves through `search_path`, so a provenance row, a checksum and a coverage read could
    // each be about a different table while all three said `package_sale`.
    expect(() => assertRelationName('package_sale')).toThrow(AppError)
    expect(() => assertRelationName('public.package_sale; drop table x')).toThrow(AppError)
    expect(() => assertRelationName('Public.PackageSale')).toThrow(AppError)
  })
})

describe('GENERATED_COLUMNS', () => {
  it('names the columns a second run of the same rows cannot reproduce', () => {
    // Asserted as a set rather than by length, because the failure worth catching is a NAME going missing:
    // `id` dropping out makes the resumability comparison fail on `uuid_generate_v7()` for a reason that has
    // nothing to do with the claim, and reads as a genuine difference in the data.
    expect([...GENERATED_COLUMNS]).toEqual(
      expect.arrayContaining(['id', 'created_at', 'recorded_at', 'applied_at']),
    )
    // And the control: it must NOT name a content column. A list that had grown to cover the data would
    // make every resumability comparison pass.
    for (const content of ['probe_key', 'label', 'amount_fils', 'row_hash', 'payload', 'state']) {
      expect(GENERATED_COLUMNS).not.toContain(content)
    }
  })
})
