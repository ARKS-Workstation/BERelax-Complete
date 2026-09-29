import { AppError } from '@berelax/shared'
import type { Actor } from '../audit.ts'
import type { Sql } from '../connection.ts'
import { type UnitOfWork, withUnitOfWork } from '../tx.ts'

/**
 * The register of private documents, and the one function that authorises a fetch of one (W-SYS-14).
 *
 * Migration 0101's two tables, read and written here and nowhere else — which is not a style preference:
 * `scripts/check-private-documents.mjs` refuses an `insert into private_document` or an
 * `insert into private_document_fetch` anywhere but this module, because a second writer is a document with
 * no audit row or a fetch with no replay check, and both look exactly like working code.
 *
 * ## Why this module knows nothing about permissions
 *
 * `packages/db` must never import `packages/core` (ADR 0001), so the permission decision cannot be made
 * here — and that turns out to be the right shape rather than a constraint to work around. The caller does
 * three things in order and this module makes the third refuse if the second was skipped: resolve the
 * signature, ask `documentReadRefusal` from `@berelax/core`, and then call
 * {@link authoriseAndRecordDocumentFetch}, which requires the role it is to record. There is no way to write
 * the fetch row without naming a role, so a caller who forgot the matrix has still written down whose
 * permission it was relying on — which is what makes a missed check findable afterwards instead of
 * invisible.
 *
 * ## Why the audit row and the fetch row are in one transaction
 *
 * The acceptance line asks for the audit row "in the same transaction as the fetch is authorised", and the
 * reason is the order the alternative would force. Stream the bytes and record afterwards, and the record
 * is lost for exactly the requests that mattered most — the ones where something went wrong after the
 * bytes left. Record first in a separate transaction, and a rolled-back authorisation leaves an audit row
 * for a download that never happened. One transaction containing the replay burn and the audit row means
 * the trail and the permission are the same fact: if `ZY111` fires, neither exists.
 */

/** The classes are `@berelax/core`'s; this module treats one as text, because `db` may not import `core`. */
export interface RegisterPrivateDocumentArgs {
  readonly documentClass: string
  /** Key inside the private bucket, as the storage adapter wrote it. */
  readonly storageKey: string
  readonly contentSha256: string
  readonly bytes: number
  readonly contentType: string
  /** `replayable` or `single_use`, resolved from the class by `documentUsePolicy` in `@berelax/core`. */
  readonly usePolicy: string
  /** What the document is about — `invoice`, `employee`, `customer`, `obligation_evidence`, `vat_return`. */
  readonly subjectKind: string
  readonly subjectId: string
  /** Who or what wrote it. A label, not a credential reference (0075's reason). */
  readonly registeredBy: string
}

export interface RegisteredPrivateDocument {
  readonly documentId: string
  readonly documentClass: string
  readonly usePolicy: string
  readonly storageKey: string
  readonly contentSha256: string
  readonly bytes: number
  readonly contentType: string
}

/**
 * Registers one document, audited.
 *
 * Audited at REGISTRATION and not only at download, because "when did this business start holding a copy of
 * this" is a different question from "who took one", and both have answers. The `after` payload names the
 * content hash and never the storage key: the hash says which bytes exist and the key is a path into the
 * private bucket, which must not appear in a table several roles may read.
 */
export async function registerPrivateDocument(
  uow: UnitOfWork,
  args: RegisterPrivateDocumentArgs,
): Promise<RegisteredPrivateDocument> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into private_document
      (document_class, storage_key, content_sha256, bytes, content_type, use_policy,
       subject_kind, subject_id, registered_by)
    values (${args.documentClass}, ${args.storageKey}, ${args.contentSha256}, ${args.bytes},
            ${args.contentType}, ${args.usePolicy}, ${args.subjectKind}, ${args.subjectId},
            ${args.registeredBy})
    returning id::text as id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'A private document row was not written and the statement did not raise, so nothing can say where ' +
        'the bytes went.',
      { details: { storageKey: args.storageKey } },
    )
  }
  await uow.audit.record({
    action: 'document.private_document.registered',
    entityType: 'private_document',
    entityId: row.id,
    operation: 'create',
    after: {
      documentClass: args.documentClass,
      usePolicy: args.usePolicy,
      // The hash and not the storage key. See the note on this function.
      contentSha256: args.contentSha256,
      bytes: args.bytes,
      subjectKind: args.subjectKind,
      subjectId: args.subjectId,
    },
  })
  return {
    documentId: row.id,
    documentClass: args.documentClass,
    usePolicy: args.usePolicy,
    storageKey: args.storageKey,
    contentSha256: args.contentSha256,
    bytes: args.bytes,
    contentType: args.contentType,
  }
}

export interface PrivateDocumentRecord {
  readonly documentId: string
  readonly documentClass: string
  readonly usePolicy: string
  readonly storageKey: string
  readonly contentSha256: string
  readonly bytes: number
  readonly contentType: string
  readonly subjectKind: string
  readonly subjectId: string
}

/**
 * One register row, or `undefined`.
 *
 * `undefined` rather than a throw, because the route has to answer 403 for an unknown id and not 404: a 404
 * for an id that does not exist and a 403 for one that does is an oracle — it answers "does this business
 * hold a payslip for employee X" to anybody who can guess a uuid. That is M-VAT-11's argument for its
 * evidence route, and it applies unchanged here.
 */
export async function readPrivateDocument(
  sql: Sql,
  documentId: string,
): Promise<PrivateDocumentRecord | undefined> {
  // A malformed id is not found rather than a 500. `${x}::uuid` on 'not-a-uuid' raises 22P02, and a
  // route that let that through would answer 503 to a typo — which reads as an outage.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
    return undefined
  }
  const [row] = await sql<
    {
      id: string
      document_class: string
      use_policy: string
      storage_key: string
      content_sha256: string
      bytes: number
      content_type: string
      subject_kind: string
      subject_id: string
    }[]
  >`
    select id::text as id, document_class, use_policy, storage_key, content_sha256, bytes,
           content_type, subject_kind, subject_id
      from private_document
     where id = ${documentId}::uuid
  `
  if (row === undefined) return undefined
  return {
    documentId: row.id,
    documentClass: row.document_class,
    usePolicy: row.use_policy,
    storageKey: row.storage_key,
    contentSha256: row.content_sha256,
    bytes: row.bytes,
    contentType: row.content_type,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
  }
}

/** The one refusal this layer owns. The signature's refusals and the matrix's are the caller's. */
export type DocumentFetchRefusal = 'signature_already_used'

export interface DocumentFetchArgs {
  readonly document: PrivateDocumentRecord
  readonly signatureNonce: string
  readonly signatureKeyVersion: string
  /** The AUTHENTICATED role, and the reference the session resolved to. Never a claimed one. */
  readonly role: string
  readonly actorLabel: string
}

/**
 * Burns the link and records the download, in ONE transaction, and translates `ZY111` outside it.
 *
 * ## Why the translation is out here and not around the INSERT
 *
 * The first version caught `ZY111` inside the `withUnitOfWork` callback and returned a refusal from there.
 * It was wrong, and the integration suite is what said so — a replayed link answered **503** instead of
 * 403. Once a statement raises, PostgreSQL aborts the whole transaction: every later statement gets
 * `25P02 current transaction is aborted`, and the COMMIT the unit of work then attempts fails too. So the
 * refusal was swallowed, the transaction died anyway, and the route's catch turned a named refusal into
 * "we are broken".
 *
 * Letting it propagate and catching it here is not a workaround, it is the correct semantics: a replay
 * rolls the transaction back, so NEITHER the fetch row nor the audit row exists — which is exactly what
 * this function's contract claims. A savepoint would have preserved the partial transaction, and there is
 * nothing in it worth preserving.
 *
 * ## Why the audit row is inside
 *
 * There is no ordering in which one of the two exists without the other. It is written for EVERY fetch,
 * including a repeat of a replayable link, because a second download is a second copy of a statutory
 * document leaving the business and a trail that recorded only the first would answer the question wrongly.
 */
export async function authoriseDocumentFetch(
  sql: Sql,
  actor: Actor,
  args: DocumentFetchArgs,
): Promise<
  | { readonly kind: 'authorised' }
  | { readonly kind: 'refused'; readonly reason: DocumentFetchRefusal }
> {
  try {
    await withUnitOfWork(sql, actor, (uow) => recordDocumentFetch(uow, args))
    return { kind: 'authorised' }
  } catch (cause) {
    if (isSqlState(cause, 'ZY111')) return { kind: 'refused', reason: 'signature_already_used' }
    throw cause
  }
}

/**
 * The two writes, inside a transaction the caller owns.
 *
 * The INSERT is the authorisation: migration 0101's `assert_single_use_document_not_replayed` takes
 * `for update` on the register row and refuses a second row for one nonce against a `single_use` document,
 * so the check and the write are one critical section rather than a read followed by a write.
 *
 * Exported so a caller that already holds a unit of work — a batch, a job — can compose it, and because
 * `authoriseDocumentFetch` above must be the only place `ZY111` is turned into a refusal: two translators
 * for one code is how one file's refusal comes to be reported as another's.
 */
export async function recordDocumentFetch(uow: UnitOfWork, args: DocumentFetchArgs): Promise<void> {
  await uow.sql`
    insert into private_document_fetch
      (private_document_id, signature_nonce, signature_key_version, fetched_by_role, fetched_by, bytes)
    values (${args.document.documentId}::uuid, ${args.signatureNonce}, ${args.signatureKeyVersion},
            ${args.role}, ${args.actorLabel}, ${args.document.bytes})
  `
  await uow.audit.record({
    action: 'document.private_document.fetched',
    entityType: 'private_document',
    entityId: args.document.documentId,
    operation: 'read',
    after: {
      documentClass: args.document.documentClass,
      usePolicy: args.document.usePolicy,
      // The content hash says WHICH bytes were served, which is the claim a substituted file would break.
      // The storage key is deliberately absent: it is a path into the private bucket.
      contentSha256: args.document.contentSha256,
      bytes: args.document.bytes,
      subjectKind: args.document.subjectKind,
      subjectId: args.document.subjectId,
      role: args.role,
      signatureKeyVersion: args.signatureKeyVersion,
      // The nonce, so two downloads of one replayable link are distinguishable from one download of two
      // links. It is not a credential — see the column comment in 0101.
      signatureNonce: args.signatureNonce,
    },
  })
}

/**
 * Whether an error is a `postgres.js` refusal carrying this exact five-character SQLSTATE.
 *
 * All FIVE characters (ADR 0043). A match on the class alone is how one file's translator came to report
 * another file's refusal, with a plausible message and the wrong cause, thirteen times over.
 */
function isSqlState(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
