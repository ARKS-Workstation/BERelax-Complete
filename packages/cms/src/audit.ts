import { contentCollection } from './collections/index.ts'
import { contentGlobal } from './globals/index.ts'

/**
 * What a CMS mutation looks like in the audit trail.
 *
 * F06 records reads as well as writes and is append-only in the database (migration 0005). What this
 * module adds is the classification: Payload reports every publish, unpublish and version revert as an
 * `update`, and an audit trail in which those three are indistinguishable cannot answer the only
 * questions anybody asks of it — who put that wording live, and who took it down.
 *
 * `isRestoringVersion` comes from Payload's own `req.context`, which `collections/operations/
 * restoreVersion.js` sets before running the `afterChange` hooks. It is the only signal that separates
 * a revert from somebody retyping the old text.
 */

export const CMS_MUTATIONS = [
  'create',
  'update',
  'publish',
  'unpublish',
  'delete',
  'version_revert',
] as const
export type CmsMutation = (typeof CMS_MUTATIONS)[number]

export type DocumentStatus = 'draft' | 'published'

export interface MutationSignals {
  /** What Payload called it. */
  readonly operation: 'create' | 'update' | 'delete'
  /** `req.context.isRestoringVersion`. */
  readonly restoringVersion: boolean
  readonly previousStatus: DocumentStatus | null
  readonly nextStatus: DocumentStatus | null
}

export function classifyMutation(signals: MutationSignals): CmsMutation {
  if (signals.operation === 'delete') return 'delete'
  // Checked before the status transition: a revert can itself change the status, and recording it as a
  // publish would lose the fact that the wording came from a prior version rather than from an editor.
  if (signals.restoringVersion) return 'version_revert'
  if (signals.operation === 'create') return 'create'
  if (signals.previousStatus !== 'published' && signals.nextStatus === 'published') return 'publish'
  if (signals.previousStatus === 'published' && signals.nextStatus !== 'published') {
    return 'unpublish'
  }
  return 'update'
}

/**
 * The audit `operation` column's value for a CMS mutation.
 *
 * Publishing is an `update` in F06's taxonomy, not a verb of its own — the taxonomy is fixed by a CHECK
 * constraint in migration 0005 and it is shared with bookings, money and clinical notes. The CMS verb
 * lives in `action`, which is where the namespaced detail belongs.
 */
export function auditOperationFor(mutation: CmsMutation): 'create' | 'update' | 'delete' {
  if (mutation === 'create') return 'create'
  if (mutation === 'delete') return 'delete'
  return 'update'
}

/** Structurally identical to `AuditRecord` in `@berelax/db`, without importing it into this package. */
export interface CmsAuditEntry {
  readonly action: string
  readonly entityType: string
  readonly entityId: string
  readonly operation: 'create' | 'update' | 'delete'
  readonly before: Readonly<Record<string, unknown>> | undefined
  readonly after: Readonly<Record<string, unknown>> | undefined
}

/**
 * The declared fields of a document, and nothing else.
 *
 * Not the whole document: Payload's own columns change between releases, and an audit row whose shape
 * follows a dependency's internals is one whose before/after stop being comparable across an upgrade.
 * Restricting it to the model's own field names also means a field that is not in the content model
 * cannot reach the audit table, which is the same fence the rest of this unit is built from.
 */
export function auditStateOf(
  slug: string,
  document: Readonly<Record<string, unknown>> | null | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (document === null || document === undefined) return undefined
  const declared = contentCollection(slug)?.fields ?? contentGlobal(slug)?.fields
  if (declared === undefined) return undefined
  const state: Record<string, unknown> = {}
  for (const field of declared) {
    if (Object.hasOwn(document, field.name)) state[field.name] = document[field.name]
  }
  const status = document['_status']
  if (status === 'draft' || status === 'published') state['_status'] = status
  // An empty result is `undefined`, not `{}`. Payload passes `previousDoc: {}` on a create rather than
  // omitting it, and `before_state: {}` in the audit table reads as "every field was cleared" — the
  // opposite of "there was nothing there". The distinction is the whole value of a before/after pair.
  return Object.keys(state).length === 0 ? undefined : state
}

/**
 * The audit entry for a CMS mutation.
 *
 * `before` is undefined on a create and `after` is undefined on a delete, because there is nothing to
 * record — not an empty object, which reads as "every field was cleared".
 */
export function cmsAuditEntry(input: {
  readonly slug: string
  readonly entityId: string
  readonly mutation: CmsMutation
  readonly before: Readonly<Record<string, unknown>> | null | undefined
  readonly after: Readonly<Record<string, unknown>> | null | undefined
}): CmsAuditEntry {
  return {
    action: `cms.${input.slug}.${input.mutation}`,
    entityType: input.slug,
    entityId: input.entityId,
    operation: auditOperationFor(input.mutation),
    before: auditStateOf(input.slug, input.before),
    after: auditStateOf(input.slug, input.after),
  }
}
