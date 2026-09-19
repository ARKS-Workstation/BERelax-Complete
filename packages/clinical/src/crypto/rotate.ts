import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import { type Kek, open, type RecordBinding, rewrap, type SealedPayload } from '../envelope.ts'

/**
 * KEK rotation for clinical data keys.
 *
 * Re-wrapping a DEK rewrites the **wrapped key** and never the ciphertext. That single fact is what
 * makes rotation cheap (a few dozen bytes per record instead of re-encrypting every intake form) and
 * what makes it **resumable**: a record is either on the new version or it is not, so "where did it
 * stop" is a query rather than a bookmark. Migration 0043 enforces the same three rules in the
 * database, because the boundary has to survive a mistake in the code that drives it.
 *
 * ## Deliberate differences from `packages/google/src/rewrap.ts`
 *
 * That job rotates the Google refresh-token data keys and this one follows its shape — a report whose
 * terms add up to `scanned`, a loud stop on a row sealed with a third version, and a refusal to rotate
 * to the same version. They are **not merged**: the Google token path is allow-listed by
 * `scripts/check-google-token-chokepoint.mjs`, and clinical DEKs are a separate boundary with a
 * separate key, so one function reaching both would put the two most sensitive keys in the system in
 * the same process for no reason. Four differences are deliberate:
 *
 *   1. **The identity has two terms, not three.** G-CONN-09 made the Google one
 *      `scanned = rewrapped + alreadyCurrent + zeroised`, because a revoked Google token has its
 *      stored ciphertext zeroised — the right thing for a credential nobody may use again. A clinical
 *      record has no such state, so `scanned = rewrapped + alreadyCurrent` here: ADR 0010 revokes
 *      `DELETE` even from the clinical role, because a record that can be erased is worthless as
 *      evidence in an insurance claim or a safeguarding allegation. A superseded intake submission is
 *      re-wrapped like any other row — it is still evidence, and evidence that cannot be decrypted is
 *      not evidence. A `zeroised` term here would be a column for destroying that evidence.
 *   2. **Batched, with the commit per record.** The Google store loads every connection at once,
 *      which is right for a handful of rows. Clinical records are unbounded, so this reads a batch at
 *      a time and each re-wrap commits on its own. A single transaction would make the rotation
 *      atomic and NOT resumable — a kill would lose all progress, and a job that must start over is a
 *      job that never finishes on a large estate.
 *   3. **The registry is promoted first.** The database refuses to seal or re-wrap onto a version
 *      that is not the active one (0043), so the rotation activates the new version and retires the
 *      old one in one transaction before it touches a record. A resumed run finds that already done.
 *   4. **A progress guard.** With the work queue expressed as "rows not yet on the new version", a
 *      write that silently matched nothing would loop forever. A record seen twice fails the run.
 */

/** The two tables holding sealed payloads. The AAD's `table` field is the qualified name. */
export const CLINICAL_SEALED_TABLES = [
  'clinical.intake_submission',
  'clinical.treatment_note',
] as const
export type ClinicalSealedTable = (typeof CLINICAL_SEALED_TABLES)[number]

/**
 * Error names, shared with migration 0043 so one rule has one name in both layers.
 *
 * The acceptance criterion is that a refused write names its reason: a bare throw, or a bare
 * non-zero exit, is indistinguishable from a typo in a column name, and the operator reading it at
 * 03:00 has to guess which of the two happened.
 */
export const CLINICAL_KEK_ERRORS = {
  /** A version that is not the active one was asked to encrypt. Raised as ZK001 in the database. */
  retiredCannotEncrypt: 'KekRetiredCannotEncrypt',
  /** Rotating to the version already in use changes nothing and records that nothing changed. */
  rotationToSameVersion: 'KekRotationToSameVersion',
  /** A row is sealed with a version that is neither the source nor the target of this rotation. */
  versionNotRetained: 'KekVersionNotRetained',
  /** The wrapped data key would not open. A wrong KEK, or a row whose identity no longer matches. */
  unwrapFailed: 'ClinicalDekUnwrapFailed',
  /** The work queue did not shrink, so a write matched no row. */
  noProgress: 'KekRotationMadeNoProgress',
  /** The registry does not hold the versions this rotation was asked to move between. */
  registryMismatch: 'KekRegistryMismatch',
} as const

export interface KekVersionRow {
  readonly version: string
  readonly status: 'active' | 'retired'
}

/** A sealed row, with the identity its AAD binds it to. */
export interface SealedRecord {
  readonly table: ClinicalSealedTable
  readonly recordId: string
  readonly customerId: string
  readonly sealed: SealedPayload
}

export interface RewrapWrite {
  readonly table: ClinicalSealedTable
  readonly recordId: string
  readonly wrappedDataKey: Buffer
  readonly fromVersion: string
  readonly toVersion: string
}

export interface KekRotationReport {
  readonly fromVersion: string
  readonly toVersion: string
  /** `scanned === rewrapped + alreadyCurrent`, always. Asserted by the test. */
  readonly scanned: number
  readonly rewrapped: number
  /** Already on the target version when this run started — an earlier run's committed progress. */
  readonly alreadyCurrent: number
}

/**
 * The seam the rotation drives.
 *
 * An interface rather than a class for the same reason `ClinicalStore` is one: the clinical store is
 * designed to move to a different database (ADR 0010), and every method here is narrow enough that
 * it cannot express anything but a re-wrap. There is deliberately no `delete`, no `updatePayload`
 * and no method that returns a plaintext.
 */
export interface ClinicalKeyStore {
  readKekVersions(): Promise<readonly KekVersionRow[]>
  /** Retires `from` and activates `to`, in ONE transaction. Both halves or neither. */
  promoteKekVersion(args: { readonly from: string; readonly to: string }): Promise<void>
  countSealedOn(version: string): Promise<number>
  /** Rows not yet on `version`, at most `limit`. This query IS the resume point. */
  listSealedNotOn(version: string, limit: number): Promise<readonly SealedRecord[]>
  /**
   * Rows sealed with `version`, in `table` then `recordId` order, after the cursor.
   *
   * Only verification needs this. The rotation itself never pages forwards — its queue is the
   * predicate "not on the target version", which shrinks as it works, and a cursor there could
   * disagree with the rows and skip one.
   */
  listSealedOn(args: {
    readonly version: string
    readonly limit: number
    readonly after?: { readonly table: ClinicalSealedTable; readonly recordId: string }
  }): Promise<readonly SealedRecord[]>
  /** One record, one transaction, so progress is durable before the next record is read. */
  rewrapOne(write: RewrapWrite): Promise<void>
  recordRotationStarted(args: {
    readonly fromVersion: string
    readonly toVersion: string
    readonly pending: number
  }): Promise<void>
  recordRotationCompleted(report: KekRotationReport): Promise<void>
}

export const bindingFor = (record: {
  readonly table: string
  readonly recordId: string
  readonly customerId: string
}): RecordBinding => ({
  table: record.table,
  recordId: record.recordId,
  customerId: record.customerId,
})

/**
 * Seals a payload, refusing a KEK that is not the active one.
 *
 * The application-layer half of "a retired KEK may decrypt but never encrypt". Migration 0043 is the
 * other half, and neither makes the other redundant: this one names the record before it is built,
 * and the trigger catches the write that never came through here at all.
 */
export function sealUnderActiveKek(
  registry: readonly KekVersionRow[],
  kek: Kek,
  seal: (kek: Kek) => SealedPayload,
): SealedPayload {
  const active = registry.find((row) => row.status === 'active')
  if (active === undefined) {
    throw new AppError(
      'invariant_violated',
      `${CLINICAL_KEK_ERRORS.retiredCannotEncrypt}: no KEK version is active, so nothing may be ` +
        'sealed. Register the current KEK version before writing a clinical record.',
      { details: { supplied: kek.version } },
    )
  }
  if (active.version !== kek.version) {
    throw new AppError(
      'forbidden',
      `${CLINICAL_KEK_ERRORS.retiredCannotEncrypt}: KEK version "${kek.version}" may not encrypt; ` +
        `"${active.version}" is the active version. A retired KEK is retained so that rows still ` +
        'sealed with it can be DECRYPTED and re-wrapped.',
      { details: { supplied: kek.version, active: active.version } },
    )
  }
  return seal(kek)
}

function assertRotationVersions(oldKek: Kek, newKek: Kek): void {
  if (oldKek.version === newKek.version) {
    throw new AppError(
      'validation',
      `${CLINICAL_KEK_ERRORS.rotationToSameVersion}: refusing to re-wrap from KEK ` +
        `"${oldKek.version}" to itself. A rotation that changes no version number leaves no evidence ` +
        'it ran, and the next rotation cannot tell what is pending.',
    )
  }
}

/**
 * Makes `newKek.version` the active one, if it is not already.
 *
 * Idempotent, because this is the first thing a resumed run does. Three states are acceptable: the
 * old version active (promote), the new version already active (an earlier run got this far), or a
 * registry that holds neither (fail, naming what it does hold).
 */
async function promoteIfNeeded(
  store: ClinicalKeyStore,
  oldVersion: string,
  newVersion: string,
): Promise<void> {
  const registry = await store.readKekVersions()
  const active = registry.find((row) => row.status === 'active')
  if (active?.version === newVersion) return
  if (active?.version === oldVersion) {
    await store.promoteKekVersion({ from: oldVersion, to: newVersion })
    return
  }
  throw new AppError(
    'invariant_violated',
    `${CLINICAL_KEK_ERRORS.registryMismatch}: rotation from "${oldVersion}" to "${newVersion}" ` +
      `needs one of them to be the active version; the active version is ` +
      `"${active?.version ?? '(none)'}". Rotations run one at a time and in order.`,
    { details: { registry: registry.map((row) => `${row.version}:${row.status}`) } },
  )
}

/**
 * Moves every clinical DEK from `oldKek` to `newKek`.
 *
 * Resumable: killed at any point, a second run re-reads "rows not on the new version" and continues.
 * Nothing about the process's own state is needed to resume, which is why there is no checkpoint file
 * and no cursor — both of which can disagree with the database, and a cursor that disagrees with the
 * database is how a rotation comes to skip a record.
 *
 * The payload plaintext never exists in this process: only the data key is unwrapped and re-wrapped.
 */
export async function rotateClinicalKek(deps: {
  readonly store: ClinicalKeyStore
  readonly oldKek: Kek
  readonly newKek: Kek
  readonly batchSize?: number
  /** Called after each record's re-wrap has committed. The CLI prints one line per call. */
  readonly onRecord?: (record: { readonly table: string; readonly recordId: string }) => void
}): Promise<KekRotationReport> {
  assertRotationVersions(deps.oldKek, deps.newKek)
  const batchSize = deps.batchSize ?? 200
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new AppError('validation', `batchSize must be a positive integer, received ${batchSize}`)
  }

  const { store, oldKek, newKek } = deps
  await promoteIfNeeded(store, oldKek.version, newKek.version)

  const alreadyCurrent = await store.countSealedOn(newKek.version)
  const pending = await store.countSealedOn(oldKek.version)
  await store.recordRotationStarted({
    fromVersion: oldKek.version,
    toVersion: newKek.version,
    pending,
  })

  const seen = new Set<string>()
  let rewrapped = 0
  for (;;) {
    const batch = await store.listSealedNotOn(newKek.version, batchSize)
    if (batch.length === 0) break
    for (const record of batch) {
      const key = `${record.table}#${record.recordId}`
      if (seen.has(key)) {
        // The work queue is a predicate, not a cursor, so a write that matched no row would hand the
        // same record back for ever. Failing on the second sighting turns an infinite loop into a
        // message naming the record.
        throw new AppError(
          'invariant_violated',
          `${CLINICAL_KEK_ERRORS.noProgress}: ${key} was returned twice as pending, so its re-wrap ` +
            'did not persist. Nothing further was attempted.',
          { details: { record: key, rewrapped } },
        )
      }
      seen.add(key)

      if (record.sealed.kekVersion !== oldKek.version) {
        // A third version means a retired KEK was discarded before every row had moved off it.
        // Failing loudly beats leaving one undecryptable record for a cron job to find at 03:00.
        throw new AppError(
          'invariant_violated',
          `${CLINICAL_KEK_ERRORS.versionNotRetained}: ${key} is sealed with KEK ` +
            `"${record.sealed.kekVersion}", which is neither "${oldKek.version}" nor ` +
            `"${newKek.version}". Retain retired KEKs until every row has been re-wrapped.`,
          { details: { record: key, sealedWith: record.sealed.kekVersion, rewrapped } },
        )
      }

      const binding = bindingFor(record)
      let resealed: SealedPayload
      try {
        resealed = rewrap(oldKek, newKek, binding, record.sealed)
      } catch (error) {
        // Either the supplied KEK is wrong, or the row's identity no longer matches the AAD the
        // payload was sealed under — a payload copied onto another customer's row, for instance. The
        // record is named so the run can be resumed after it is dealt with; the rows already
        // re-wrapped are committed and are not redone.
        throw new AppError(
          'forbidden',
          `${CLINICAL_KEK_ERRORS.unwrapFailed}: ${key} could not be unwrapped with KEK ` +
            `"${oldKek.version}". Either the supplied key is wrong, or the row identity no longer ` +
            'matches the AAD its data key is bound to. Nothing further was attempted.',
          { cause: error, details: { record: key, rewrapped } },
        )
      }

      await store.rewrapOne({
        table: record.table,
        recordId: record.recordId,
        wrappedDataKey: resealed.wrappedDataKey,
        fromVersion: oldKek.version,
        toVersion: newKek.version,
      })
      rewrapped += 1
      deps.onRecord?.({ table: record.table, recordId: record.recordId })
    }
  }

  const report: KekRotationReport = {
    fromVersion: oldKek.version,
    toVersion: newKek.version,
    scanned: alreadyCurrent + rewrapped,
    rewrapped,
    alreadyCurrent,
  }
  await store.recordRotationCompleted(report)
  return report
}

/** One record's contribution to a rotation checksum. */
export interface VerifiedRecord {
  /** Stable across two comparable estates. Defaults to `table#recordId`. */
  readonly label: string
  readonly kekVersion: string
  readonly plaintextSha256: string
  readonly ciphertextSha256: string
}

/**
 * Decrypts one record and returns digests of what came out, never the plaintext itself.
 *
 * Verification is the one operation here that must decrypt: AES-GCM authenticates by producing the
 * plaintext, so "is this record still readable" cannot be answered without briefly holding it. It is
 * therefore a separate, opt-in pass and not part of the rotation, which never sees a payload.
 */
export function verifyRecord(kek: Kek, record: SealedRecord, label?: string): VerifiedRecord {
  const plaintext = open(kek, bindingFor(record), record.sealed)
  return {
    label: label ?? `${record.table}#${record.recordId}`,
    kekVersion: record.sealed.kekVersion,
    plaintextSha256: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    ciphertextSha256: createHash('sha256').update(record.sealed.ciphertext).digest('hex'),
  }
}

function digestOf(records: readonly VerifiedRecord[], line: (r: VerifiedRecord) => string): string {
  if (new Set(records.map((record) => record.label)).size !== records.length) {
    // Two records sharing a label would let a missing record hide behind a duplicated one, and the
    // checksum would match while the estate did not.
    throw new AppError(
      'invariant_violated',
      'Checksum labels must be unique; a duplicate label lets a missing record hide.',
      { details: { count: records.length } },
    )
  }
  return createHash('sha256').update(records.map(line).sort().join('\n'), 'utf8').digest('hex')
}

/**
 * A checksum over the final state of a rotated estate: label, final KEK version, plaintext digest.
 *
 * One comparison answers all three of "every record decryptable", "the same final key version" and
 * "the same content", which is what the resumability criterion asks for — an interrupted-and-restarted
 * run must produce this same value as an uninterrupted run over a comparable estate.
 *
 * The **ciphertext** digest is deliberately NOT in it. Two estates seeded with the same content still
 * hold different ciphertext, because `seal` draws a fresh nonce and a fresh data key per record, so a
 * checksum including it could only ever compare an estate with itself. Ciphertext immutability across
 * a rotation is asserted directly instead, per record, and enforced by migration 0043's ZK002.
 */
export const rotationChecksum = (records: readonly VerifiedRecord[]): string =>
  digestOf(records, (r) => `${r.label}|${r.kekVersion}|${r.plaintextSha256}`)

/**
 * The same checksum with the key version left out, so it is invariant across a rotation.
 *
 * This is the one the runbook takes before a rotation and compares afterwards: it must be UNCHANGED,
 * because a rotation re-wraps keys and changes no content. `rotationChecksum` must have changed over
 * the same rotation, because the version did. Neither alone would catch a rotation that quietly lost
 * a record — the pair does.
 */
export const contentChecksum = (records: readonly VerifiedRecord[]): string =>
  digestOf(records, (r) => `${r.label}|${r.plaintextSha256}`)
