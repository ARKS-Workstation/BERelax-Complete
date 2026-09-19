import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { generateKek, type Kek, open, seal } from '../envelope.ts'
import { createMemoryClinicalKeyStore } from './memory-key-store.ts'
import {
  bindingFor,
  CLINICAL_KEK_ERRORS,
  type ClinicalKeyStore,
  type ClinicalSealedTable,
  contentChecksum,
  rotateClinicalKek,
  rotationChecksum,
  type SealedRecord,
  sealUnderActiveKek,
  verifyRecord,
} from './rotate.ts'

/**
 * The KEK rotation job, against an in-memory store.
 *
 * The resumability property is proved twice, and neither is redundant. Here it is proved against a
 * store that cannot lose a write, which isolates the *algorithm*: a run that stops part-way and a run
 * that does not must reach the same state. `rotation.itest.ts` proves it against real PostgreSQL by
 * SIGKILLing the CLI, which is the only way to test what happens to a transaction nobody unwound.
 */

/** The fixture prefix from packages/fixtures, restated because clinical does not depend on it. */
const FIXTURE = 'FIXTURE (not a real record) —'

const PLAINTEXTS = [
  `${FIXTURE} no contraindications recorded`,
  `${FIXTURE} avoid deep pressure on the left shoulder`,
  `${FIXTURE} pregnancy declared; requires consultation`,
  `${FIXTURE} recent surgery within six weeks`,
  `${FIXTURE} skin condition on both forearms`,
  `${FIXTURE} cardiovascular history; light pressure only`,
  `${FIXTURE} medication declared`,
  `${FIXTURE} no notes`,
  `${FIXTURE} superseded by a later submission`,
] as const

const TABLES: readonly ClinicalSealedTable[] = [
  'clinical.intake_submission',
  'clinical.treatment_note',
]

/**
 * One estate of sealed records.
 *
 * `set` distinguishes two estates with the SAME content under DIFFERENT identities, which is what
 * makes the interrupted and uninterrupted runs comparable: the checksum is keyed by the fixture
 * ordinal, and the AAD binds each record to its own identity, so the two estates cannot share ids.
 */
function estate(kek: Kek, set: string, count: number = PLAINTEXTS.length): readonly SealedRecord[] {
  return Array.from({ length: count }, (_unused, index) => {
    const table = TABLES[index % TABLES.length] as ClinicalSealedTable
    const record = {
      table,
      recordId: `0193${set}000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      customerId: `0193${set}111-0000-7000-8000-${String(index).padStart(12, '0')}`,
    }
    const plaintext = PLAINTEXTS[index % PLAINTEXTS.length] as string
    return { ...record, sealed: seal(kek, bindingFor(record), plaintext) }
  })
}

/** The fixture ordinal, so two estates of the same content produce the same checksum. */
const labelOf = (record: SealedRecord) => record.recordId.slice(-12).replace(/^0+(?=\d)/, '')

const verifyAll = (kek: Kek, records: readonly SealedRecord[]) =>
  records.map((record) => verifyRecord(kek, record, labelOf(record)))

describe('rotating the clinical KEK', () => {
  it('re-wraps every DEK, rewrites no ciphertext, and everything still decrypts', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const before = estate(v1, 'a')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: before })

    const report = await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    expect(report).toEqual({
      fromVersion: 'v1',
      toVersion: 'v2',
      scanned: before.length,
      rewrapped: before.length,
      alreadyCurrent: 0,
    })
    // The identity the Google job established, minus its `zeroised` term. See the comment in
    // rotate.ts: a clinical record has no state in which it may be destroyed.
    expect(report.scanned).toBe(report.rewrapped + report.alreadyCurrent)

    for (const after of store.records()) {
      const original = before.find((record) => record.recordId === after.recordId)
      if (original === undefined) throw new Error(`missing ${after.recordId}`)
      expect(after.sealed.kekVersion).toBe('v2')
      // The whole reason rotation is cheap: the payload is untouched, only the wrapper moved.
      expect(after.sealed.ciphertext.equals(original.sealed.ciphertext)).toBe(true)
      expect(after.sealed.nonce.equals(original.sealed.nonce)).toBe(true)
      expect(after.sealed.aadFingerprint).toBe(original.sealed.aadFingerprint)
      expect(after.sealed.wrappedDataKey.equals(original.sealed.wrappedDataKey)).toBe(false)
      expect(open(v2, bindingFor(after), after.sealed)).toBe(
        open(v1, bindingFor(original), original.sealed),
      )
    }
  })

  it('promotes the registry: the new version is active and the old one retired but retained', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })

    await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    expect([...store.registry()].sort((a, b) => a.version.localeCompare(b.version))).toEqual([
      { version: 'v1', status: 'retired' },
      { version: 'v2', status: 'active' },
    ])
  })

  it('records written before AND after the rotation both decrypt', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })
    await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    // A record sealed AFTER the rotation, under the new active version.
    const fresh = {
      table: 'clinical.treatment_note' as const,
      recordId: '0193a000-0000-7000-8000-000000009999',
      customerId: '0193a111-0000-7000-8000-000000009999',
    }
    const plaintext = `${FIXTURE} sealed after the rotation`
    store.put({
      ...fresh,
      sealed: sealUnderActiveKek(await store.readKekVersions(), v2, (kek) =>
        seal(kek, bindingFor(fresh), plaintext),
      ),
    })

    for (const record of store.records()) {
      expect(record.sealed.kekVersion).toBe('v2')
      expect(() => open(v2, bindingFor(record), record.sealed)).not.toThrow()
    }
    const after = store.records().find((record) => record.recordId === fresh.recordId)
    expect(after === undefined ? null : open(v2, bindingFor(after), after.sealed)).toBe(plaintext)
  })

  it('re-wraps a superseded record rather than skipping it', async () => {
    // A superseded intake submission is still evidence (ADR 0010: corrections supersede, they never
    // overwrite, and DELETE is revoked even for the clinical role). Evidence that cannot be decrypted
    // is not evidence, so rotation has no concept of a record it may leave behind.
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const records = estate(v1, 'a')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records })

    const report = await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    expect(report.rewrapped).toBe(records.length)
    expect(store.records().every((record) => record.sealed.kekVersion === 'v2')).toBe(true)
  })

  it('writes one started and one completed event, naming both versions and the record count', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const records = estate(v1, 'a')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records })

    await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    expect(store.events().map((event) => event.kind)).toEqual(['started', 'completed'])
    expect(store.events()[0]?.detail).toEqual({
      fromVersion: 'v1',
      toVersion: 'v2',
      pending: records.length,
    })
    expect(store.events()[1]?.detail).toEqual({
      fromVersion: 'v1',
      toVersion: 'v2',
      scanned: records.length,
      rewrapped: records.length,
      alreadyCurrent: 0,
    })
  })

  it('is a no-op on a second run', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const records = estate(v1, 'a')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records })

    await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })
    const second = await rotateClinicalKek({ store, oldKek: v1, newKek: v2 })

    expect(second).toEqual({
      fromVersion: 'v1',
      toVersion: 'v2',
      scanned: records.length,
      rewrapped: 0,
      alreadyCurrent: records.length,
    })
  })

  it('reaches the same state whatever the batch size, so batching cannot skip a record', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const wide = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })
    const narrow = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })

    await rotateClinicalKek({ store: wide, oldKek: v1, newKek: v2, batchSize: 500 })
    await rotateClinicalKek({ store: narrow, oldKek: v1, newKek: v2, batchSize: 1 })

    expect(rotationChecksum(verifyAll(v2, narrow.records()))).toBe(
      rotationChecksum(verifyAll(v2, wide.records())),
    )
  })
})

describe('resumability', () => {
  it('killed at a random record and restarted, it reaches the uninterrupted run’s checksum', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')

    // Two estates, same content, different identities. The interrupted run walks one, the
    // uninterrupted run walks the other, and the checksum is keyed by the fixture ordinal.
    const interrupted = createMemoryClinicalKeyStore({
      activeVersion: 'v1',
      records: estate(v1, 'b'),
    })
    const uninterrupted = createMemoryClinicalKeyStore({
      activeVersion: 'v1',
      records: estate(v1, 'c'),
    })

    await rotateClinicalKek({ store: uninterrupted, oldKek: v1, newKek: v2 })

    // A genuinely random point, printed so a failure is reproducible. Between 1 and n-1, so the run
    // is neither a no-op nor a completed rotation — either would make this test vacuous.
    const killAt = 1 + Math.floor(Math.random() * (PLAINTEXTS.length - 1))
    let moved = 0
    const dies: ClinicalKeyStore = {
      ...interrupted,
      rewrapOne: async (write) => {
        if (moved === killAt) throw new Error(`killed after ${moved} record(s)`)
        await interrupted.rewrapOne(write)
        moved += 1
      },
    }
    await expect(rotateClinicalKek({ store: dies, oldKek: v1, newKek: v2 })).rejects.toThrow(
      /killed after/,
    )

    // The control: the interruption must have left the estate PART-WAY through. A kill that landed
    // after the last record would leave a completed rotation and prove nothing.
    const half = interrupted.records().filter((record) => record.sealed.kekVersion === 'v2').length
    expect(half, `kill point ${killAt} left ${half} of ${PLAINTEXTS.length} moved`).toBe(killAt)
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(PLAINTEXTS.length)

    const resumed = await rotateClinicalKek({ store: interrupted, oldKek: v1, newKek: v2 })
    expect(resumed.alreadyCurrent).toBe(killAt)
    expect(resumed.rewrapped).toBe(PLAINTEXTS.length - killAt)
    expect(resumed.scanned).toBe(PLAINTEXTS.length)

    expect(rotationChecksum(verifyAll(v2, interrupted.records()))).toBe(
      rotationChecksum(verifyAll(v2, uninterrupted.records())),
    )
  })

  it('a checksum over the wrong final version does NOT match — the control', async () => {
    // Without this, the assertion above would pass on a checksum that ignored the key version, which
    // is the one thing the acceptance criterion names.
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const rotated = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'b') })
    const untouched = createMemoryClinicalKeyStore({
      activeVersion: 'v1',
      records: estate(v1, 'c'),
    })
    await rotateClinicalKek({ store: rotated, oldKek: v1, newKek: v2 })

    expect(rotationChecksum(verifyAll(v2, rotated.records()))).not.toBe(
      rotationChecksum(verifyAll(v1, untouched.records())),
    )
    // …and the content checksum is the one that must be equal across a rotation.
    expect(contentChecksum(verifyAll(v2, rotated.records()))).toBe(
      contentChecksum(verifyAll(v1, untouched.records())),
    )
  })

  it('a lost record changes both checksums', async () => {
    const v1 = generateKek('v1')
    const full = verifyAll(v1, estate(v1, 'b'))
    const short = full.slice(0, full.length - 1)
    expect(rotationChecksum(short)).not.toBe(rotationChecksum(full))
    expect(contentChecksum(short)).not.toBe(contentChecksum(full))
  })

  it('refuses a checksum over duplicate labels, which would let a missing record hide', async () => {
    const v1 = generateKek('v1')
    const records = verifyAll(v1, estate(v1, 'b'))
    const first = records[0]
    if (first === undefined) throw new Error('fixture')
    expect(() => rotationChecksum([...records, first])).toThrow(/labels must be unique/)
  })
})

describe('the refusals, each named', () => {
  it('refuses a rotation to the same version', async () => {
    const v1 = generateKek('v1')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })
    await expect(
      rotateClinicalKek({ store, oldKek: v1, newKek: generateKek('v1') }),
    ).rejects.toThrow(new RegExp(CLINICAL_KEK_ERRORS.rotationToSameVersion))
  })

  it('stops loudly on a record sealed with a third, unavailable version', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const v3 = generateKek('v3')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })
    const stranded = estate(v3, 'a', 1)[0]
    if (stranded === undefined) throw new Error('fixture')
    store.put(stranded)

    await expect(rotateClinicalKek({ store, oldKek: v1, newKek: v2 })).rejects.toThrow(
      new RegExp(`${CLINICAL_KEK_ERRORS.versionNotRetained}.*neither "v1" nor "v2"`, 's'),
    )
  })

  it('names the record whose identity no longer matches its AAD', async () => {
    // The copy attack: someone with INSERT puts one client's payload on another client's row. The
    // data key is wrapped under the same AAD as the payload, so it will not unwrap either.
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const original = estate(v1, 'a', 1)[0]
    if (original === undefined) throw new Error('fixture')
    const forged: SealedRecord = {
      ...original,
      recordId: '0193a000-0000-7000-8000-000000008888',
      customerId: '0193a111-0000-7000-8000-000000008888',
    }
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: [forged] })

    await expect(rotateClinicalKek({ store, oldKek: v1, newKek: v2 })).rejects.toThrow(
      new RegExp(`${CLINICAL_KEK_ERRORS.unwrapFailed}.*000000008888`, 's'),
    )
  })

  it('fails rather than looping when a re-wrap does not persist', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1', records: estate(v1, 'a') })
    const silent: ClinicalKeyStore = { ...store, rewrapOne: async () => {} }

    await expect(rotateClinicalKek({ store: silent, oldKek: v1, newKek: v2 })).rejects.toThrow(
      new RegExp(CLINICAL_KEK_ERRORS.noProgress),
    )
  })

  it('refuses a rotation whose registry holds neither version', async () => {
    const v2 = generateKek('v2')
    const v3 = generateKek('v3')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1' })
    await expect(rotateClinicalKek({ store, oldKek: v2, newKek: v3 })).rejects.toThrow(
      new RegExp(CLINICAL_KEK_ERRORS.registryMismatch),
    )
  })

  it('refuses a batch size that is not a positive integer', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const store = createMemoryClinicalKeyStore({ activeVersion: 'v1' })
    await expect(
      rotateClinicalKek({ store, oldKek: v1, newKek: v2, batchSize: 0 }),
    ).rejects.toThrow(AppError)
  })
})

describe('a retired KEK may decrypt and may never encrypt', () => {
  const record = {
    table: 'clinical.intake_submission' as const,
    recordId: '0193d000-0000-7000-8000-000000000001',
    customerId: '0193d111-0000-7000-8000-000000000001',
  }
  const plaintext = `${FIXTURE} sealed under the active version`

  it('seals under the active version', async () => {
    const v2 = generateKek('v2')
    const registry = [
      { version: 'v1', status: 'retired' as const },
      { version: 'v2', status: 'active' as const },
    ]
    const sealed = sealUnderActiveKek(registry, v2, (kek) =>
      seal(kek, bindingFor(record), plaintext),
    )
    expect(open(v2, bindingFor(record), sealed)).toBe(plaintext)
  })

  it('refuses to seal under a retired version, by name', async () => {
    const v1 = generateKek('v1')
    const registry = [
      { version: 'v1', status: 'retired' as const },
      { version: 'v2', status: 'active' as const },
    ]
    expect(() =>
      sealUnderActiveKek(registry, v1, (kek) => seal(kek, bindingFor(record), plaintext)),
    ).toThrow(new RegExp(`${CLINICAL_KEK_ERRORS.retiredCannotEncrypt}.*"v1" may not encrypt`, 's'))
  })

  it('still DECRYPTS under the retired version — the half that must keep working', async () => {
    // The opposite mistake is as bad: refusing the retired key for reads makes a half-rotated estate
    // unreadable, which is the outage rotation exists to avoid.
    const v1 = generateKek('v1')
    const sealed = seal(v1, bindingFor(record), plaintext)
    expect(open(v1, bindingFor(record), sealed)).toBe(plaintext)
  })

  it('refuses to seal when no version is active at all', async () => {
    const v1 = generateKek('v1')
    expect(() =>
      sealUnderActiveKek([{ version: 'v1', status: 'retired' }], v1, (kek) =>
        seal(kek, bindingFor(record), plaintext),
      ),
    ).toThrow(/no KEK version is active/)
  })
})

describe('verifyRecord', () => {
  it('refuses a record sealed under a different version, naming the retention rule', async () => {
    const v1 = generateKek('v1')
    const v2 = generateKek('v2')
    const record = estate(v1, 'a', 1)[0]
    if (record === undefined) throw new Error('fixture')
    expect(() => verifyRecord(v2, record)).toThrow(
      /Retain retired KEKs until every payload has been re-wrapped/,
    )
  })

  it('labels a record by table and id when no label is supplied', async () => {
    const v1 = generateKek('v1')
    const record = estate(v1, 'a', 1)[0]
    if (record === undefined) throw new Error('fixture')
    expect(verifyRecord(v1, record).label).toBe(`${record.table}#${record.recordId}`)
  })
})
