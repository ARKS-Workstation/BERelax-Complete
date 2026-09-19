import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fingerprint, generateKek, type Kek, open, seal } from '../envelope.ts'
import { createPostgresClinicalKeyStore } from './postgres-key-store.ts'
import {
  bindingFor,
  type ClinicalSealedTable,
  contentChecksum,
  rotationChecksum,
  type SealedRecord,
  sealUnderActiveKek,
  verifyRecord,
} from './rotate.ts'

/**
 * KEK rotation against real PostgreSQL, interrupted by a real SIGKILL.
 *
 * The unit suite proves the algorithm against a store that cannot lose a write. This proves the thing
 * only a real process and a real database can: that a rotation **killed with no unwind at all** — no
 * `finally`, no rollback the process chose, no chance to write a checkpoint — resumes and finishes in
 * the same state as a rotation that was never interrupted.
 *
 * ## How one run gives both halves of the comparison
 *
 * Two estates, the same content, in the two different sealed tables. The store walks
 * `intake_submission` before `treatment_note`, so:
 *
 *   - the **intake** estate is straddled by the kill: part of it moved in the killed run, the rest in
 *     the restarted one;
 *   - the **note** estate is not reached before the kill at all, so the restarted run rotates it in a
 *     single uninterrupted pass.
 *
 * Both end on the same KEK version with the same content per ordinal, so `rotationChecksum` — which
 * covers the label, the final key version and a digest of the decrypted payload — must be equal
 * across the two. That is the acceptance criterion, and it needs no second database: two rotations
 * cannot both target one version label, because retirement is one-way (migration 0043).
 *
 * The control that keeps it from going vacuous is the assertion that the kill landed strictly inside
 * the intake estate. A kill that arrived after the last record would leave a completed rotation and
 * compare a rotation with itself.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

/** The fixture prefix from packages/fixtures, restated because clinical does not depend on it. */
const FIXTURE = 'FIXTURE (not a real record) —'

/**
 * Every fixture row's id starts here, so this file can sweep exactly its own rows out of a database
 * shared with every other integration file — and sweep a previous run's, which matters because a row
 * left on a retired version would stop the next rotation with `KekVersionNotRetained`.
 *
 * Hex, because it is a UUID, and `0dec0de0` reads as what it is.
 */
const ID_PREFIX = '0dec0de0'
const CUSTOMER_PREFIX = '0dec0de1'
const TEMPLATE_ID = '0dec0de2-0000-7000-8000-000000000001'

/** Large enough that the kill lands well inside it even if several progress lines arrive at once. */
const STRADDLED = 120
const UNTOUCHED = 30

const PHRASES = [
  'no contraindications recorded',
  'avoid deep pressure on the left shoulder',
  'pregnancy declared; requires consultation',
  'recent surgery within six weeks',
  'skin condition on both forearms',
  'cardiovascular history; light pressure only',
  'medication declared',
  'no notes recorded at intake',
] as const

/** Ordinal `n` has the same content in both estates, which is what makes the checksums comparable. */
const plaintextFor = (n: number) => `${FIXTURE} ${PHRASES[n % PHRASES.length]} [${n}]`

const idFor = (estate: number, n: number) =>
  `${ID_PREFIX}-0000-7000-8000-${estate}${String(n).padStart(11, '0')}`
const customerFor = (estate: number, n: number) =>
  `${CUSTOMER_PREFIX}-0000-7000-8000-${estate}${String(n).padStart(11, '0')}`

interface Estate {
  readonly table: ClinicalSealedTable
  readonly records: readonly SealedRecord[]
}

let sql: Sql
let baseVersion: string
let baseKek: Kek
let targetVersion: string
let targetKek: Kek
let straddled: Estate
let untouched: Estate

/** Rows this file owns, read back from the database. */
async function readEstate(table: ClinicalSealedTable, estate: number): Promise<SealedRecord[]> {
  const ciphertext =
    table === 'clinical.intake_submission' ? 'payload_ciphertext' : 'body_ciphertext'
  const nonce = table === 'clinical.intake_submission' ? 'payload_nonce' : 'body_nonce'
  const rows = await sql<
    {
      id: string
      customer_id: string
      ct: Buffer
      nonce: Buffer
      wrapped_data_key: Buffer
      kek_version: string
      aad_fingerprint: string
    }[]
  >`
    select id, customer_id, ${sql(ciphertext)} as ct, ${sql(nonce)} as nonce,
           wrapped_data_key, kek_version, aad_fingerprint
      from ${sql(table)}
     where id::text like ${`${ID_PREFIX}-0000-7000-8000-${estate}%`}
     order by id
  `
  return rows.map((row) => ({
    table,
    recordId: row.id,
    customerId: row.customer_id,
    sealed: {
      ciphertext: row.ct,
      nonce: row.nonce,
      wrappedDataKey: row.wrapped_data_key,
      kekVersion: row.kek_version,
      aadFingerprint: row.aad_fingerprint,
    },
  }))
}

/** Digests of the stored ciphertext, in SQL, so "no ciphertext was rewritten" is read from the heap. */
async function ciphertextDigests(): Promise<Map<string, string>> {
  const intake = await sql<{ id: string; d: string }[]>`
    select id, md5(payload_ciphertext) as d from clinical.intake_submission
     where id::text like ${`${ID_PREFIX}%`}
  `
  const notes = await sql<{ id: string; d: string }[]>`
    select id, md5(body_ciphertext) as d from clinical.treatment_note
     where id::text like ${`${ID_PREFIX}%`}
  `
  return new Map([...intake, ...notes].map((row) => [row.id, row.d]))
}

const sweep = async () => {
  await sql`delete from clinical.intake_submission where id::text like ${`${ID_PREFIX}%`}`
  await sql`delete from clinical.treatment_note where id::text like ${`${ID_PREFIX}%`}`
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await sweep()

  const [active] = await sql<{ v: string | null }[]>`select clinical.active_kek_version() as v`
  if (!active?.v) throw new Error('no active KEK version; migration 0043 seeds one')
  baseVersion = active.v
  // The key MATERIAL is this process's own and is never written anywhere. Only the version label is
  // shared with the database, which is the whole arrangement: the label says which externally held
  // key opens a row.
  baseKek = generateKek(baseVersion)
  targetVersion = `h3-${Date.now().toString(36)}`
  targetKek = generateKek(targetVersion)

  await sql`
    insert into clinical.intake_form_template
      (id, version, locale, title, definition, consent_text, consent_hash, is_current, created_at)
    values (${TEMPLATE_ID}, 10043, 'en', ${`${FIXTURE} rotation fixture`}, '{}'::jsonb,
            ${`${FIXTURE} consent`}, 'fixture-consent-hash', false, now())
    on conflict do nothing
  `

  const build = (table: ClinicalSealedTable, estate: number, count: number): Estate => ({
    table,
    records: Array.from({ length: count }, (_unused, n) => {
      const identity = { table, recordId: idFor(estate, n), customerId: customerFor(estate, n) }
      return { ...identity, sealed: seal(baseKek, bindingFor(identity), plaintextFor(n)) }
    }),
  })
  straddled = build('clinical.intake_submission', 1, STRADDLED)
  untouched = build('clinical.treatment_note', 2, UNTOUCHED)

  for (const record of straddled.records) {
    await sql`
      insert into clinical.intake_submission
        (id, customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
         kek_version, aad_fingerprint, submitted_at, submitted_via)
      values (${record.recordId}, ${record.customerId}, ${TEMPLATE_ID}, ${record.sealed.ciphertext},
              ${record.sealed.nonce}, ${record.sealed.wrappedDataKey}, ${record.sealed.kekVersion},
              ${record.sealed.aadFingerprint}, now(), 'online')
    `
  }
  for (const record of untouched.records) {
    await sql`
      insert into clinical.treatment_note
        (id, customer_id, appointment_id, author_employee_id, body_ciphertext, body_nonce,
         wrapped_data_key, kek_version, aad_fingerprint, created_at)
      values (${record.recordId}, ${record.customerId}, ${customerFor(9, 1)}, ${customerFor(9, 2)},
              ${record.sealed.ciphertext}, ${record.sealed.nonce}, ${record.sealed.wrappedDataKey},
              ${record.sealed.kekVersion}, ${record.sealed.aadFingerprint}, now())
    `
  }
}, 180_000)

afterAll(async () => {
  // The version rows stay: retirement is one-way, so removing the active one would leave a database
  // nothing may seal into. They cost one row per run and name the run that made them.
  await sweep().catch(() => {})
  await sql?.end({ timeout: 5 })
})

/** Runs the real CLI, optionally SIGKILLing it once `killAfter` progress lines have been seen. */
function runRotation(options: { readonly killAfter?: number }): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly lines: number
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'scripts/rotate-kek.mjs', '--batch-size=25'], {
      cwd: REPO_ROOT,
      // Its own process group, so the SIGKILL reaches the loader and the script together. tsx may run
      // the script in a child of its own, and killing only the parent would leave the rotation
      // running while this test believed it had stopped it.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: url,
        APP_ENV: process.env['APP_ENV'] ?? 'test',
        CLINICAL_KEK: targetKek.key.toString('base64'),
        CLINICAL_KEK_VERSION: targetVersion,
        CLINICAL_KEK_PREVIOUS: baseKek.key.toString('base64'),
        CLINICAL_KEK_PREVIOUS_VERSION: baseVersion,
      },
    })
    let stdout = ''
    let stderr = ''
    let lines = 0
    let killed = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      lines = (stdout.match(/^rewrapped /gm) ?? []).length
      if (options.killAfter !== undefined && !killed && lines >= options.killAfter) {
        killed = true
        // No unwind at all: no `finally`, no `sql.end`, no chance to write a checkpoint. PostgreSQL
        // rolls back whatever statement was in flight and keeps every committed re-wrap.
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal, lines }))
  })
}

describe('rotating the clinical KEK against real PostgreSQL', () => {
  it('killed at a random record and restarted, it matches an uninterrupted run by checksum', async () => {
    const store = createPostgresClinicalKeyStore(sql)
    const digestsBefore = await ciphertextDigests()
    const [auditBefore] = await sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action in ('clinical.kek_rotation.started', 'clinical.kek_rotation.completed')
      `

    // A genuinely random point in the first quarter of the straddled estate, which leaves ample
    // room for the kill to arrive a few records late and still land inside it.
    const killAfter = 1 + Math.floor(Math.random() * (STRADDLED / 4))
    const first = await runRotation({ killAfter })
    expect(
      first.signal,
      `the rotation exited on its own after ${first.lines} line(s) instead of being killed:\n` +
        `${first.stdout.slice(-400)}${first.stderr}`,
    ).toBe('SIGKILL')

    const committed = await store.countSealedOn(targetVersion)
    // The control. Without it this test could compare a completed rotation with itself.
    expect(
      committed,
      `the kill at line ${killAfter} left ${committed} of ${STRADDLED + UNTOUCHED} re-wrapped; it ` +
        'must land strictly inside the straddled estate',
    ).toBeGreaterThan(0)
    expect(committed).toBeLessThan(STRADDLED)
    // The untouched estate must still be entirely on the old version, so the restarted run rotates
    // it in one uninterrupted pass.
    const untouchedMoved = await sql<{ n: string }[]>`
        select count(*)::text as n from clinical.treatment_note
         where id::text like ${`${ID_PREFIX}-0000-7000-8000-2%`} and kek_version = ${targetVersion}
      `
    expect(untouchedMoved[0]?.n).toBe('0')

    // Note what the restarted run is doing: `baseVersion` was RETIRED by the first run's promotion,
    // and every remaining record is unwrapped with it. "A retired KEK may still decrypt" is not a
    // separate test here — it is the only way this rotation can work at all.
    const second = await runRotation({})
    expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0)
    expect(second.stdout).toContain(`Rotated ${baseVersion} -> ${targetVersion}`)
    expect(second.stdout).toContain(`${STRADDLED + UNTOUCHED} record(s) scanned`)
    expect(second.stdout).toContain(`${committed} already current`)

    const finalStraddled = await readEstate('clinical.intake_submission', 1)
    const finalUntouched = await readEstate('clinical.treatment_note', 2)
    expect(finalStraddled).toHaveLength(STRADDLED)
    expect(finalUntouched).toHaveLength(UNTOUCHED)

    // Every record decryptable, on the same final key version, with the same content per ordinal.
    const ordinal = (record: SealedRecord) => String(Number(record.recordId.slice(-11)))
    const straddledVerified = finalStraddled
      .slice(0, UNTOUCHED)
      .map((record) => verifyRecord(targetKek, record, ordinal(record)))
    const untouchedVerified = finalUntouched.map((record) =>
      verifyRecord(targetKek, record, ordinal(record)),
    )
    expect(rotationChecksum(straddledVerified)).toBe(rotationChecksum(untouchedVerified))
    expect(straddledVerified.every((record) => record.kekVersion === targetVersion)).toBe(true)

    // The whole estate is on the target version, and NOT on the old one.
    expect(await store.countSealedOn(targetVersion)).toBe(STRADDLED + UNTOUCHED)
    expect(await store.countSealedOn(baseVersion)).toBe(0)

    // No ciphertext was rewritten. Read from the heap in SQL, not from what the code returned.
    const digestsAfter = await ciphertextDigests()
    expect([...digestsAfter.keys()].sort()).toEqual([...digestsBefore.keys()].sort())
    for (const [id, digest] of digestsBefore) {
      expect(digestsAfter.get(id), `ciphertext of ${id} changed`).toBe(digest)
    }

    // The content checksum is invariant across a rotation; the rotation checksum is not. Neither
    // alone would catch a rotation that lost a record.
    const beforeVerified = straddled.records
      .slice(0, UNTOUCHED)
      .map((record) => verifyRecord(baseKek, record, ordinal(record)))
    expect(contentChecksum(straddledVerified)).toBe(contentChecksum(beforeVerified))
    expect(rotationChecksum(straddledVerified)).not.toBe(rotationChecksum(beforeVerified))

    // audit_event is append-only (ADR 0008), so this is a DELTA counted in SQL, and it is also a
    // key set: `entity_id` is this run's target version and nothing else writes it.
    const [auditAfter] = await sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action in ('clinical.kek_rotation.started', 'clinical.kek_rotation.completed')
      `
    expect(Number(auditAfter?.n) - Number(auditBefore?.n)).toBe(3)
    const events = await sql<{ action: string; after_state: Record<string, unknown> | null }[]>`
        select action, after_state from audit_event
         where entity_id = ${targetVersion} order by occurred_at, action
      `
    // Two starts and one completion: the killed run recorded that it began and never finished, which
    // is the only thing that distinguishes an interrupted rotation from one nobody ran.
    expect(events.map((event) => event.action)).toEqual([
      'clinical.kek_rotation.started',
      'clinical.kek_rotation.started',
      'clinical.kek_rotation.completed',
    ])
    expect(events[2]?.after_state).toEqual({
      fromVersion: baseVersion,
      toVersion: targetVersion,
      recordCount: STRADDLED + UNTOUCHED,
      rewrapped: STRADDLED + UNTOUCHED - committed,
      alreadyCurrent: committed,
    })
  }, 120_000)

  it('a third run is a no-op that still records that it ran', async () => {
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where entity_id = ${targetVersion}
    `
    const third = await runRotation({})
    expect(third.code, third.stderr).toBe(0)
    expect(third.stdout).toContain(`0 re-wrapped, ${STRADDLED + UNTOUCHED} already current`)
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where entity_id = ${targetVersion}
    `
    expect(Number(after?.n) - Number(before?.n)).toBe(2)
  })

  it('the registry retired the old version and retains it for decryption', async () => {
    const rows = await sql<{ version: string; status: string; retired_at: Date | null }[]>`
      select version, status, retired_at from clinical.kek_version
       where version in (${baseVersion}, ${targetVersion})
    `
    const byVersion = new Map(rows.map((row) => [row.version, row]))
    expect(byVersion.get(baseVersion)?.status).toBe('retired')
    expect(byVersion.get(baseVersion)?.retired_at).not.toBeNull()
    expect(byVersion.get(targetVersion)?.status).toBe('active')
    expect(byVersion.get(targetVersion)?.retired_at).toBeNull()
  })

  it('--verify reports every record readable under the new key', async () => {
    const verify = await new Promise<{ out: string; code: number | null }>((resolve, reject) => {
      const child = spawn('node', ['--import', 'tsx', 'scripts/rotate-kek.mjs', '--verify'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: url,
          APP_ENV: process.env['APP_ENV'] ?? 'test',
          CLINICAL_KEK: targetKek.key.toString('base64'),
          CLINICAL_KEK_VERSION: targetVersion,
        },
      })
      let out = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        out += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ out, code }))
    })
    expect(verify.code, verify.out).toBe(0)
    expect(verify.out).toContain(`records:          ${STRADDLED + UNTOUCHED}`)
    expect(verify.out).toMatch(/rotationChecksum: [0-9a-f]{64}/)
  })
})

describe('records written before and after the rotation', () => {
  it('both decrypt under the new key', async () => {
    // The acceptance criterion's second half, against real rows. The "before" records are the estate
    // the rotation moved; the "after" record is sealed under the new active version, which the database
    // accepts only BECAUSE it is the active one — the same INSERT carrying the retired label is refused
    // with KekRetiredCannotEncrypt, probed in scripts/test-gates.mjs.
    const freshId = `${ID_PREFIX}-0000-7000-8000-700000000001`
    const freshCustomer = `${CUSTOMER_PREFIX}-0000-7000-8000-700000000001`
    const identity = {
      table: 'clinical.intake_submission' as const,
      recordId: freshId,
      customerId: freshCustomer,
    }
    const plaintext = `${FIXTURE} sealed after the rotation`
    const registry = await createPostgresClinicalKeyStore(sql).readKekVersions()
    const sealed = sealUnderActiveKek(registry, targetKek, (kek) =>
      seal(kek, bindingFor(identity), plaintext),
    )
    await sql`
      insert into clinical.intake_submission
        (id, customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
         kek_version, aad_fingerprint, submitted_at, submitted_via)
      values (${freshId}, ${freshCustomer}, ${TEMPLATE_ID}, ${sealed.ciphertext}, ${sealed.nonce},
              ${sealed.wrappedDataKey}, ${sealed.kekVersion}, ${sealed.aadFingerprint}, now(),
              'staff_entry')
    `

    const [row] = await readEstate('clinical.intake_submission', 7)
    if (row === undefined) throw new Error('the record sealed after the rotation was not stored')
    expect(open(targetKek, bindingFor(row), row.sealed)).toBe(plaintext)

    // And a record written BEFORE the rotation, read back from the database, under the same key.
    const [moved] = await readEstate('clinical.intake_submission', 1)
    if (moved === undefined) throw new Error('fixture')
    expect(open(targetKek, bindingFor(moved), moved.sealed)).toContain(FIXTURE)

    await sql`delete from clinical.intake_submission where id = ${freshId}`
  })
})

describe('the AAD row binding survives the rotation', () => {
  it('a payload copied onto another customer’s row will not decrypt, by name', async () => {
    // The attack the AAD exists to stop, and the one the UPDATE rules cannot: migration 0043 refuses
    // to let an UPDATE move a payload between rows, so an attacker with write access has to INSERT a
    // copy instead. The AAD is `table | record id | customer id`, so the copy is unreadable — and the
    // data key is wrapped under the same AAD, so it cannot be unwrapped either.
    const source = await readEstate('clinical.intake_submission', 1)
    const original = source[0]
    if (original === undefined) throw new Error('fixture')
    const copyId = `${ID_PREFIX}-0000-7000-8000-800000000001`
    const otherCustomer = `${CUSTOMER_PREFIX}-0000-7000-8000-800000000001`
    await sql`
      insert into clinical.intake_submission
        (id, customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
         kek_version, aad_fingerprint, submitted_at, submitted_via)
      values (${copyId}, ${otherCustomer}, ${TEMPLATE_ID}, ${original.sealed.ciphertext},
              ${original.sealed.nonce}, ${original.sealed.wrappedDataKey}, ${targetVersion},
              ${original.sealed.aadFingerprint}, now(), 'staff_entry')
    `
    const copy: SealedRecord = {
      table: 'clinical.intake_submission',
      recordId: copyId,
      customerId: otherCustomer,
      sealed: original.sealed,
    }
    expect(() => open(targetKek, bindingFor(copy), copy.sealed)).toThrow(
      /Record binding does not match the sealed payload/,
    )
    // And still fails when the stored fingerprint is rewritten to match the forged binding, because
    // the AAD itself is part of the GCM tag.
    expect(() =>
      open(targetKek, bindingFor(copy), {
        ...copy.sealed,
        aadFingerprint: fingerprint(bindingFor(copy)),
      }),
    ).toThrow(/failed authentication/)

    // Reading the row under its REAL identity is the control: it is only the copy that is unreadable.
    expect(open(targetKek, bindingFor(original), original.sealed)).toContain(FIXTURE)
    await sql`delete from clinical.intake_submission where id = ${copyId}`
  })
})
