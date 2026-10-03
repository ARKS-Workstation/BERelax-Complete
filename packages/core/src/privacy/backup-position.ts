import { type DataClass, ERASURE_RULES } from './rights-policy.ts'

/**
 * Where each data class stands in a backup, and what a restore brings back.
 *
 * H-HARD-04. `rights_resolution.backup_position` (migration 0085) already makes every completed erasure
 * state, in its own row, that a row-level erasure does not reach a backup — ADR 0034's first limitation.
 * That sentence is the SUBJECT's answer and it is one sentence for every class. This table is the
 * operator's answer and it is per class, because the four questions a restore actually raises have four
 * different answers depending on the class:
 *
 *   * is the data in the backup at all?
 *   * is it readable once restored, or does it need a key that is not in the dump?
 *   * what does restoring it UNDO — and this is the one nobody writes down;
 *   * and does the erasure somebody already performed come back?
 *
 * ## Why this is beside `ERASURE_RULES` and not in `packages/db`
 *
 * The declared file for this was `packages/db/src/data-classes.ts`, and it cannot live there:
 * {@link DataClass} is defined in `packages/core/src/privacy/rights-policy.ts` and `packages/db` must
 * never import `packages/core` (ADR 0001, brief rule 4). A registry keyed by a core type belongs beside
 * the type, so the compiler refuses a key that is not a data class rather than a gate noticing later.
 *
 * ## Why `erasureReachesBackup` is typed `false`
 *
 * `AlertSlo.target`'s trick, for the same reason: the field is not `boolean`, so "this class's erasure
 * does reach the backup" is **inexpressible** rather than discouraged. No backup in this build can have
 * an individual row removed from it — a `pg_dump` is one file, the restore is all of it or none of it —
 * and a `true` here would be a claim an operator would act on by telling a data subject their data is
 * gone from every copy. The day a backup store with per-row redaction exists, widening this type is the
 * deliberate edit in the commit that provides it.
 *
 * ## The completeness claim, and what holds it
 *
 * Every data class that carries at least one erasure rule states its backup position, and no position
 * exists for a class no rule carries. Both directions, in `backup-position.test.ts`, derived from
 * {@link ERASURE_RULES} rather than from a second list — a hand-kept list of classes is exactly how a
 * class comes to have an erasure rule and no backup position, which is the gap this unit was asked to
 * close.
 */

/**
 * What the backup holds for a class.
 *
 * Three values and deliberately no `unknown`: a class whose position nobody has worked out is the state
 * this table exists to make impossible, and a label for it would be the one every new class got.
 */
export const BACKUP_FORMS = ['present_in_full', 'present_as_ciphertext', 'not_in_backup'] as const
export type BackupForm = (typeof BACKUP_FORMS)[number]

export interface BackupPosition {
  readonly dataClass: DataClass
  readonly form: BackupForm
  /**
   * What restoring the backup DOES, in the operator's words.
   *
   * Required, and the most load-bearing field here: three of these classes make a restore an action
   * with a consequence somebody has to be told about, and none of those consequences is visible from
   * the words "restore the database".
   */
  readonly onRestore: string
  /** Typed `false`. See the module header. */
  readonly erasureReachesBackup: false
  /** Why this form and not the obvious alternative, for whoever maintains it. */
  readonly why: string
  /** Where the unanswered backup figures are recorded. */
  readonly openQuestionId: string
}

const BACKUP_OPEN_QUESTION_ID = 'Y13-rpo-rto'

const position = (entry: BackupPosition): BackupPosition => Object.freeze(entry)

/**
 * One entry per data class, in {@link ERASURE_RULES}'s own order: identity first, then the channels
 * that could reach the person, then the credentials, then what is held FOR them, then the records a
 * regulator reads, then the logs.
 */
export const BACKUP_POSITIONS: ReadonlyMap<DataClass, BackupPosition> = new Map(
  [
    position({
      dataClass: 'identity',
      form: 'present_in_full',
      onRestore:
        'The phone number, the name and the notes come back exactly as they were when the dump was ' +
        'taken. A customer pseudonymised by an erasure after that instant is readable again.',
      erasureReachesBackup: false,
      why:
        'A `pg_dump` is a copy of the rows, not a copy of the current state: there is no redaction ' +
        'pass and nothing in the dump knows an erasure happened later. ADR 0034 limitation 1 is this ' +
        'fact, and the reason the resolution row has to say so to the subject.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'contact_channel',
      form: 'present_in_full',
      onRestore:
        'Every address a message could be sent to comes back, including the ones an erasure redacted. ' +
        'Restoring and then running the outbox is how a restored copy messages somebody who is gone.',
      erasureReachesBackup: false,
      why:
        '`message.recipient` and the three phone columns hold the address in plain text because that ' +
        'is what a transport needs at send time; nothing about the dump changes that.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'credential',
      form: 'present_in_full',
      onRestore:
        'A credential REVOKED after the dump was taken works again. `staff_credential` holds the hash ' +
        'a sign-in is checked against and `booking_manage_grant` holds a live bearer token; restoring ' +
        'either re-arms it, and the runbook step that follows a restore is to revoke again.',
      erasureReachesBackup: false,
      why:
        'The hashes and the grant tokens are ordinary rows. This is the class where the restore is ' +
        'itself a security event rather than a recovery, which is why it is called out in ' +
        'docs/runbooks/restore.md rather than left to be worked out at 2am.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'consent_record',
      form: 'present_in_full',
      onRestore:
        'Consent returns to what it was at the dump, so a consent WITHDRAWN after that instant reads ' +
        'as given. The messaging gate reads these rows, so a restore can make a refusal into a send.',
      erasureReachesBackup: false,
      why:
        '`consent_record` is append-only (ADR 0008), which makes the restored history self-consistent ' +
        'and still wrong about the present: append-only protects a row from being edited, not from ' +
        'being absent because it was written after the backup.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'suppression_record',
      form: 'present_in_full',
      onRestore:
        'A suppression added after the dump is NOT in the restored copy, so somebody who asked never ' +
        'to be contacted again becomes contactable. This is the one class where the restore loses a ' +
        'protection rather than recovering data, and the loss is silent.',
      erasureReachesBackup: false,
      why:
        'Its own class and not part of `contact_channel` for `DATA_CLASSES`’ stated reason — it is ' +
        'data held FOR the subject rather than about them — and the backup position is where that ' +
        'distinction has its sharpest consequence.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'operational',
      form: 'present_in_full',
      onRestore:
        'Appointments, rooms, shifts and the outbox come back as at the dump. The outbox is the part ' +
        'that acts: restored `outbox_event` rows are undelivered again, and a worker pointed at a ' +
        'restored database re-sends everything the dump had not yet published.',
      erasureReachesBackup: false,
      why:
        'The outbox is deduplicated by `idempotency_key` WITHIN a database, so a restored copy ' +
        'carries no memory of a delivery made from the original. Stopping the worker before a restore ' +
        'is therefore a step in the runbook and not a precaution.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'clinical',
      form: 'present_as_ciphertext',
      onRestore:
        'The submissions come back as ciphertext with their wrapped data keys. They are readable only ' +
        'if the KEK that wrapped them is still available — the KEK is not in the dump — and a ' +
        'crypto-erasure performed after the dump is UNDONE, because the dump holds the old wrapped key.',
      erasureReachesBackup: false,
      why:
        'Envelope encryption puts the content beyond the dump and the wrapped key inside it, which is ' +
        'the only class where restoring data and being able to read it are different questions. It is ' +
        'also why the KEK rotation runbook and this one have to be read together: a restore of an old ' +
        'dump after a rotation needs the retired KEK version, which `docs/runbooks/key-rotation.md` ' +
        'is the authority on.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'financial',
      form: 'present_in_full',
      onRestore:
        'Invoices, credit notes, payments and journal lines come back whole, which is the one class ' +
        'where that is simply the point: these are the rows a tax authority asks about and the ones ' +
        'the drill reads back to prove the restore is usable.',
      erasureReachesBackup: false,
      why:
        'They are statutorily retained anyway (ADR 0034 limitation 3), so there is no erasure for the ' +
        'backup to miss. The risk here is the opposite one — a restore to a point before an issued ' +
        'document would make an invoice number reusable — and the sequence is in the dump with it.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'audit',
      form: 'present_in_full',
      onRestore:
        'The trail comes back as at the dump and every row written since is gone. A restore therefore ' +
        'erases the evidence of the window it rolls back, including the audit rows for the incident ' +
        'that caused the restore.',
      erasureReachesBackup: false,
      why:
        'Append-only in the database (ADR 0008) and append-only in a dump for a different reason: the ' +
        'dump is a point in time and nothing appends to it. This is why an incident record is kept ' +
        'outside the window being restored — H-HARD-07 owns that register.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
    position({
      dataClass: 'not_customer_data',
      form: 'present_in_full',
      onRestore:
        'The catalogue, the settings and the schema come back. Settings are the ones to check by hand ' +
        'after a restore: an audited settings change made after the dump is reverted with no record ' +
        'in the restored copy that it ever happened.',
      erasureReachesBackup: false,
      why:
        'Carried here rather than left out, because "it is not personal data" is an answer about ' +
        'erasure and not an answer about recovery, and the class with no erasure obligation is exactly ' +
        'the one nobody would think to check.',
      openQuestionId: BACKUP_OPEN_QUESTION_ID,
    }),
  ].map((entry) => [entry.dataClass, entry] as const),
)

/** The classes at least one erasure rule carries. Derived, never listed. */
export function dataClassesWithErasureRules(): ReadonlySet<DataClass> {
  return new Set([...ERASURE_RULES.values()].map((rule) => rule.dataClass))
}

/** The two-way completeness answer: a class with no position, and a position with no class. */
export interface BackupPositionGaps {
  readonly classesWithoutPosition: readonly DataClass[]
  readonly positionsWithoutRule: readonly DataClass[]
}

export function backupPositionGaps(): BackupPositionGaps {
  const classed = dataClassesWithErasureRules()
  return {
    classesWithoutPosition: [...classed].filter((entry) => !BACKUP_POSITIONS.has(entry)).sort(),
    positionsWithoutRule: [...BACKUP_POSITIONS.keys()]
      .filter((entry) => !classed.has(entry))
      .sort(),
  }
}
