#!/usr/bin/env node
/**
 * Rotates the clinical key-encrypting key.
 *
 * ## The operational contract
 *
 * The environment always describes two keys, and which is which never changes:
 *
 *   - `CLINICAL_KEK` / `CLINICAL_KEK_VERSION` — the key that ENCRYPTS. The rotation's target.
 *   - `CLINICAL_KEK_PREVIOUS` / `CLINICAL_KEK_PREVIOUS_VERSION` — the retired key, RETAINED so that
 *     rows that have not moved yet can still be decrypted. The rotation's source.
 *
 * So a rotation is: generate a new key, move the old pair to `…_PREVIOUS`, set the new pair as
 * `CLINICAL_KEK`, run this. The previous key may be removed from the secret store only once this
 * reports nothing left on it — see `docs/runbooks/key-rotation.md`, which is the procedure, not a
 * summary of one.
 *
 * ## Why it is safe to kill
 *
 * Every record's re-wrap commits on its own, and the work queue is the query "rows not yet on the
 * target version". There is no cursor file and no in-process checkpoint, so killing this at any point
 * and running it again resumes: the records already moved are counted as `alreadyCurrent` and are not
 * touched. `packages/clinical/src/crypto/rotation.itest.ts` proves it by SIGKILLing this script at a
 * random record and comparing a checksum of the finished estate against an uninterrupted run.
 *
 * Run through tsx (`pnpm rotate:kek`), because it imports the TypeScript source directly.
 *
 * Modes: `--plan` (no writes), `--verify` (decrypts, prints checksums), default (rotate).
 */
import { createPostgresClinicalKeyStore } from '../packages/clinical/src/crypto/postgres-key-store.ts'
import {
  contentChecksum,
  rotateClinicalKek,
  rotationChecksum,
  verifyRecord,
} from '../packages/clinical/src/crypto/rotate.ts'
import { parseKek } from '../packages/clinical/src/envelope.ts'
import { createConnection } from '../packages/db/src/connection.ts'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(`--${flag}`)
const flagValue = (flag, fallback) => {
  const prefixed = argv.find((arg) => arg.startsWith(`--${flag}=`))
  return prefixed === undefined ? fallback : prefixed.slice(flag.length + 3)
}

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}

/** Reads a KEK pair, failing with the name of what is missing rather than a stack trace. */
const kekFrom = (materialVar, versionVar) => {
  const material = process.env[materialVar]
  if (!material) {
    console.error(
      `${materialVar} is not set. A rotation needs the key that encrypts and the retired key it ` +
        'moves rows off; neither is ever stored in the database, which holds only version labels.',
    )
    process.exit(1)
  }
  const version = process.env[versionVar]
  if (!version) {
    console.error(
      `${versionVar} is not set. A KEK with no version label cannot be rotated: nothing could say ` +
        'which rows are still on it.',
    )
    process.exit(1)
  }
  return parseKek(material, version)
}

const sql = createConnection({ url, max: 2 })
const store = createPostgresClinicalKeyStore(sql)
const batchSize = Number(flagValue('batch-size', '200'))

/** Walks every record on `version`, in pages, and returns the verification rows. */
const verifyAll = async (kek) => {
  const verified = []
  let after
  for (;;) {
    const page = await store.listSealedOn({ version: kek.version, limit: batchSize, after })
    if (page.length === 0) break
    for (const record of page) verified.push(verifyRecord(kek, record))
    const last = page[page.length - 1]
    after = { table: last.table, recordId: last.recordId }
  }
  return verified
}

let exitCode = 0
try {
  if (has('plan')) {
    const registry = await store.readKekVersions()
    console.log('clinical.kek_version:')
    for (const row of registry) console.log(`  ${row.version}  ${row.status}`)
    for (const row of registry) {
      console.log(`  ${row.version}: ${await store.countSealedOn(row.version)} sealed record(s)`)
    }
  } else if (has('verify')) {
    const kek = kekFrom('CLINICAL_KEK', 'CLINICAL_KEK_VERSION')
    // Verification is the one operation that decrypts: AES-GCM authenticates by producing the
    // plaintext, so "is this still readable" cannot be answered without briefly holding it. Say so,
    // because it means this command is not one to leave running in a shared terminal.
    console.log(`Verifying under KEK "${kek.version}". This DECRYPTS every record in memory.`)
    const stranded = await store.listSealedNotOn(kek.version, 1)
    if (stranded.length > 0) {
      const count = await store.countSealedOn(kek.version)
      console.error(
        `Records remain on another KEK version (first: ${stranded[0].table} ` +
          `${stranded[0].recordId} on "${stranded[0].sealed.kekVersion}"); ${count} are on ` +
          `"${kek.version}". Finish the rotation before verifying.`,
      )
      exitCode = 1
    } else {
      const verified = await verifyAll(kek)
      console.log(`records:          ${verified.length}`)
      console.log(`rotationChecksum: ${rotationChecksum(verified)}`)
      console.log(`contentChecksum:  ${contentChecksum(verified)}`)
    }
  } else {
    const newKek = kekFrom('CLINICAL_KEK', 'CLINICAL_KEK_VERSION')
    const oldKek = kekFrom('CLINICAL_KEK_PREVIOUS', 'CLINICAL_KEK_PREVIOUS_VERSION')
    const report = await rotateClinicalKek({
      store,
      oldKek,
      newKek,
      batchSize,
      // One line per committed record, unbuffered. It is what an operator watches, and it is also
      // what makes the interruption test honest: the test kills this process after a line it has
      // actually seen, so the kill lands at a record whose re-wrap really did commit.
      onRecord: ({ table, recordId }) => {
        process.stdout.write(`rewrapped ${table} ${recordId}\n`)
      },
    })
    console.log(
      `Rotated ${report.fromVersion} -> ${report.toVersion}: ${report.scanned} record(s) scanned, ` +
        `${report.rewrapped} re-wrapped, ${report.alreadyCurrent} already current.`,
    )
    console.log(
      `Keep ${oldKek.version} in the secret store until a --verify pass under ${newKek.version} ` +
        'succeeds. Backups and WAL written before this rotation are still sealed with the old key.',
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}

process.exit(exitCode)
