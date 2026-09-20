import {
  CONTENT_COLLECTIONS,
  type ContentCollection,
  JOURNAL_POSTS,
  SERVICE_NARRATIVE,
} from '@berelax/cms'
import type { CollectionConfig } from 'payload'
import { assertMayChangeStatus, collectionAccess } from '../payload/access.ts'
import { auditCollectionChange, auditCollectionDelete } from '../payload/audit.ts'
import { toPayloadField } from '../payload/fields.ts'
import { CMS_USERS } from './cms-users.ts'
import { guardJournalPostPublication } from './journal-posts.ts'
import { MEDIA } from './media.ts'
import { guardServiceNarrativeDelete, guardServiceNarrativeUnpublish } from './service-narrative.ts'

export { CMS_USERS } from './cms-users.ts'
export { MEDIA } from './media.ts'

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

  /**
   * The per-collection publication guards, attached by slug.
   *
   * `service_narrative` may not be unpublished while a guest has a future booking against the treatment it
   * describes (W-SYS-08); `journal_posts` may not be *published* without an author byline, a reviewer byline
   * and a date, or with copy the banned-claims lexicon refuses (W-SITE-07). Both run after the status gate,
   * which can refuse the whole save on authorisation grounds — an editor told "you may not publish" and then
   * told which field is missing has been told two things, and the first is the one that matters.
   */
  const publicationGuards: NonNullable<CollectionConfig['hooks']>['beforeChange'] =
    collection.slug === SERVICE_NARRATIVE.slug
      ? [guardServiceNarrativeUnpublish]
      : collection.slug === JOURNAL_POSTS.slug
        ? [guardJournalPostPublication]
        : []

  return {
    beforeChange: [...statusGate, ...(publicationGuards ?? [])],
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

/**
 * The auth collection first, which is the order Payload's sidebar shows them in, then the narrative
 * collections, then media.
 *
 * `CMS_USERS` and `MEDIA` are hand-written rather than generated for the same kind of reason and for
 * different specifics: an auth collection is Payload's own mechanism, and an upload collection's fields
 * come from the file rather than from an editorial model. Both files say so at the top. Everything in
 * between is generated from the one field list in `@berelax/cms`.
 */
export const PAYLOAD_COLLECTIONS: readonly CollectionConfig[] = [
  CMS_USERS,
  ...CONTENT_COLLECTIONS.map(toPayloadCollection),
  MEDIA,
]
