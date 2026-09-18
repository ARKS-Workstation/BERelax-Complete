import { CONTENT_COLLECTIONS, type ContentCollection, SERVICE_NARRATIVE } from '@berelax/cms'
import type { CollectionConfig } from 'payload'
import { assertMayChangeStatus, collectionAccess } from '../payload/access.ts'
import { auditCollectionChange, auditCollectionDelete } from '../payload/audit.ts'
import { toPayloadField } from '../payload/fields.ts'
import { CMS_USERS } from './cms-users.ts'
import { guardServiceNarrativeDelete, guardServiceNarrativeUnpublish } from './service-narrative.ts'

export { CMS_USERS } from './cms-users.ts'

/**
 * Payload collections, built from the content model in `@berelax/cms`.
 *
 * Generated rather than hand-written, and that is the point: the boundary gate reads the descriptors and
 * the admin serves these, so there is no second field list to keep in step. Six near-identical
 * `CollectionConfig` literals would have been more conventional Payload and would have made the gate a
 * check on a document rather than on the thing that runs.
 *
 * What is NOT generated is the per-collection behaviour: `service_narrative` has a retire guard, and it
 * is attached by slug below rather than declared in the descriptor, because a descriptor that carried
 * Payload hooks would drag Payload into `@berelax/cms`.
 */

/** Hooks that run before every write, in order. The status gate is first: it can refuse the whole save. */
function hooksFor(collection: ContentCollection): NonNullable<CollectionConfig['hooks']> {
  const statusGate: NonNullable<CollectionConfig['hooks']>['beforeChange'] = [
    ({ data, originalDoc, req }) => {
      assertMayChangeStatus({
        slug: collection.slug,
        user: req.user,
        previousStatus: (originalDoc as { readonly _status?: string } | undefined)?._status ?? null,
        nextStatus: (data as { readonly _status?: string })._status ?? null,
      })
      return data
    },
  ]

  return {
    beforeChange:
      collection.slug === SERVICE_NARRATIVE.slug
        ? [...statusGate, guardServiceNarrativeUnpublish]
        : statusGate,
    ...(collection.slug === SERVICE_NARRATIVE.slug
      ? { beforeDelete: [guardServiceNarrativeDelete] }
      : {}),
    afterChange: [auditCollectionChange],
    afterDelete: [auditCollectionDelete],
  }
}

export function toPayloadCollection(collection: ContentCollection): CollectionConfig {
  return {
    slug: collection.slug,
    labels: { singular: collection.label, plural: collection.label },
    admin: {
      useAsTitle: collection.titleField,
      description: collection.purpose,
      defaultColumns: [collection.titleField, 'updatedAt', '_status'],
    },
    // Drafts and versions for every collection, without a flag to turn them off. docs/09 §5 requires a
    // diff before save and a revert to any prior version; "publish straight to live" is not a mode.
    versions: { drafts: true, maxPerDoc: collection.maxVersions },
    ...(collection.orderable === true ? { orderable: true } : {}),
    access: {
      read: collectionAccess('read'),
      create: collectionAccess('create'),
      update: collectionAccess('update'),
      delete: collectionAccess('delete'),
    },
    hooks: hooksFor(collection),
    fields: collection.fields.map(toPayloadField),
  }
}

/** The auth collection first, which is the order Payload's sidebar shows them in. */
export const PAYLOAD_COLLECTIONS: readonly CollectionConfig[] = [
  CMS_USERS,
  ...CONTENT_COLLECTIONS.map(toPayloadCollection),
]
