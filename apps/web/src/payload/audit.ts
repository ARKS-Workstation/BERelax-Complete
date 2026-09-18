import {
  type CmsMutation,
  classifyMutation,
  cmsAuditEntry,
  type DocumentStatus,
} from '@berelax/cms'
import type { AuditRecord } from '@berelax/db'
import { sql } from 'drizzle-orm'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  GlobalAfterChangeHook,
  PayloadRequest,
} from 'payload'
import { principalFrom } from './principal.ts'

/**
 * Every CMS mutation writes an audit_event row — **inside Payload's own transaction.**
 *
 * ## Why not AuditWriter
 *
 * `@berelax/db`'s `AuditWriter` is F06's writer and it holds a `postgres` connection of its own. Used
 * here it would write the audit row on a different connection from the one Payload's operation is
 * running on, and Payload's Local API wraps each operation in a transaction. A rollback after the
 * `afterChange` hook — a failing `afterOperation`, a constraint on a later write, a dropped connection —
 * would then leave an audit row describing a change that never happened. F06's own module comment names
 * that as being as bad as a change with no audit row, and it is worse in one respect: it is evidence.
 *
 * So the row goes through `req.payload.db`'s drizzle session for `req.transactionID`, which is the same
 * transaction. `apps/web/src/payload.itest.ts` proves it by rolling a transaction back and asserting the
 * audit row went with it — which is a test that fails if this file ever goes back to a second connection.
 *
 * The record half is still F06's: `cmsAuditEntry` produces the shape and it is assigned to `AuditRecord`
 * below, so a change to F06's record type is a compile error here rather than a column that stops being
 * written.
 */

/** The adapter surface this needs, structurally, so `@payloadcms/drizzle` is not a dependency of the app. */
interface DrizzleSessionAdapter {
  readonly drizzle: unknown
  readonly sessions: Readonly<Record<string, { readonly db: unknown } | undefined>>
  readonly execute: (args: {
    db?: unknown
    drizzle?: unknown
    sql?: unknown
    raw?: string
  }) => Promise<unknown>
}

function adapterOf(req: PayloadRequest): DrizzleSessionAdapter | null {
  const candidate = req.payload.db as unknown as Partial<DrizzleSessionAdapter>
  if (typeof candidate.execute !== 'function' || candidate.sessions === undefined) return null
  return candidate as DrizzleSessionAdapter
}

/** An IPv4 or IPv6 literal. `inet` rejects anything else and would fail the whole mutation. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i

function clientIp(req: PayloadRequest): string | null {
  const forwarded = req.headers?.get('x-forwarded-for') ?? ''
  const first = forwarded.split(',')[0]?.trim() ?? ''
  return first !== '' && IP_LITERAL.test(first) ? first : null
}

function statusOf(document: unknown): DocumentStatus | null {
  if (document === null || typeof document !== 'object') return null
  const status = (document as { readonly _status?: unknown })._status
  return status === 'draft' || status === 'published' ? status : null
}

function documentIdOf(document: unknown, fallback: string): string {
  if (document === null || typeof document !== 'object') return fallback
  const id = (document as { readonly id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : fallback
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object'
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

async function writeAuditRow(req: PayloadRequest, entry: AuditRecord): Promise<void> {
  const adapter = adapterOf(req)
  if (adapter === null) {
    // Not a silent skip: an audit trail that quietly stops recording is the failure this whole table
    // exists against, so a database adapter this hook cannot reach fails the mutation.
    throw new Error(
      'CMS audit: the database adapter exposes no drizzle session, so the audit row cannot be written ' +
        'in the same transaction as the change. Refusing the mutation rather than losing the trail.',
    )
  }

  const transaction =
    req.transactionID === undefined ? undefined : adapter.sessions[String(req.transactionID)]?.db
  const db = transaction ?? adapter.drizzle

  const principal = principalFrom(req.user)
  // The role, not a name or an email. `actor_id` is who; `actor_label` is what they were acting as, which
  // is the question asked of an audit row six months later, and it puts no personal data in an
  // append-only table nobody can redact.
  //
  // No principal means an `overrideAccess: true` caller with no user — a seed, a data migration, this
  // app's own tests. `'system'` rather than `'unauthenticated'`, because the row was not written on
  // behalf of somebody who failed to log in; it was written by the application, and `actor_kind` says so.
  const actorLabel = principal?.role ?? 'system'

  await adapter.execute({
    db,
    drizzle: db,
    sql: sql`
      insert into audit_event (
        actor_kind, actor_id, actor_label, action, entity_type, entity_id, operation,
        before_state, after_state, request_id, ip_address, user_agent
      ) values (
        ${principal === null ? 'system' : 'staff'},
        ${principal?.id ?? null}::uuid,
        ${actorLabel},
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId ?? null},
        ${entry.operation},
        ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
        ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
        ${req.headers?.get('x-request-id') ?? null},
        ${clientIp(req)}::inet,
        ${req.headers?.get('user-agent') ?? null}
      )
    `,
  })
}

function recordFor(input: {
  readonly slug: string
  readonly entityId: string
  readonly mutation: CmsMutation
  readonly before: unknown
  readonly after: unknown
}): AuditRecord {
  // The assignment is the check: `cmsAuditEntry` returns `@berelax/cms`'s own shape, and if F06's
  // `AuditRecord` grows a required field this line stops compiling instead of the column silently
  // never being written.
  const entry: AuditRecord = cmsAuditEntry({
    slug: input.slug,
    entityId: input.entityId,
    mutation: input.mutation,
    before: asRecord(input.before),
    after: asRecord(input.after),
  })
  return entry
}

export const auditCollectionChange: CollectionAfterChangeHook = async ({
  collection,
  context,
  doc,
  operation,
  previousDoc,
  req,
}) => {
  const mutation = classifyMutation({
    operation,
    // Payload's restoreVersion sets this before running these hooks; it is the only signal that
    // separates a revert from an editor retyping the old wording.
    restoringVersion: context['isRestoringVersion'] === true,
    previousStatus: statusOf(previousDoc),
    nextStatus: statusOf(doc),
  })
  await writeAuditRow(
    req,
    recordFor({
      slug: collection.slug,
      entityId: documentIdOf(doc, 'unknown'),
      mutation,
      before: previousDoc,
      after: doc,
    }),
  )
  return doc
}

export const auditCollectionDelete: CollectionAfterDeleteHook = async ({
  collection,
  doc,
  id,
  req,
}) => {
  await writeAuditRow(
    req,
    recordFor({
      slug: collection.slug,
      entityId: documentIdOf(doc, String(id)),
      mutation: 'delete',
      before: doc,
      after: null,
    }),
  )
  return doc
}

export const auditGlobalChange: GlobalAfterChangeHook = async ({
  context,
  doc,
  global,
  previousDoc,
  req,
}) => {
  const mutation = classifyMutation({
    operation: 'update',
    restoringVersion: context['isRestoringVersion'] === true,
    previousStatus: statusOf(previousDoc),
    nextStatus: statusOf(doc),
  })
  await writeAuditRow(
    req,
    recordFor({
      slug: global.slug,
      // A global is a singleton, so its slug IS its identity; there is no row id worth recording and
      // Payload's internal one changes if the table is ever rebuilt.
      entityId: global.slug,
      mutation,
      before: previousDoc,
      after: doc,
    }),
  )
  return doc
}
