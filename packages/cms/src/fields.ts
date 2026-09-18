import type { Permission } from '@berelax/core'

/**
 * The content model, as data.
 *
 * Payload's collection configuration is executable TypeScript that imports Payload, so it can only
 * live in `apps/web` — and `apps/web` is not in the root typecheck project (it has its own, with `jsx`
 * and the DOM lib). That matters here more than it looks: the whole point of this unit is that the
 * catalogue/CMS boundary is a *mechanical* fact, and one of the mechanisms is a compile error. A
 * compile error in a project `pnpm typecheck` does not compile is a compile error nobody sees.
 *
 * So the model is declared here, framework-free, and `apps/web/src/collections` turns each descriptor
 * into a Payload `CollectionConfig`. Three things then derive from ONE declaration:
 *
 *   1. the Payload collections the admin actually serves;
 *   2. the document TYPES the site renders (`documents.ts`), so a field that does not exist in the
 *      model cannot be read from a document;
 *   3. the boundary gate (`boundary.ts`, `scripts/check-cms-boundary.mjs`), which rejects a
 *      catalogue-owned field by name.
 *
 * Adding `price` to a descriptor therefore breaks all three at once, which is the difference between
 * a boundary and a note in a document.
 */

/**
 * The field types the CMS has.
 *
 * There is deliberately **no numeric type**. Every number this business cares about is money in
 * integer fils (ADR 0007), a duration in minutes, or a count — and each of those has an owner that is
 * not the CMS: the catalogue, the ledger, the availability engine. A `number` field is the shape a
 * second copy of one of them arrives in, and the second copy is the one that goes stale. If a future
 * unit genuinely needs one, adding it here is a deliberate act with this paragraph to read first.
 *
 * `uuidRef` is the cross-boundary reference: a UUID in a plain text column, no foreign key. See
 * `boundary.ts` for why it cannot be a Payload `relationship`.
 */
export const CONTENT_FIELD_TYPES = [
  'text',
  'textarea',
  'richText',
  'slug',
  'uuidRef',
  'checkbox',
  'date',
  'select',
  'array',
] as const

export type ContentFieldType = (typeof CONTENT_FIELD_TYPES)[number]

export interface ContentField {
  readonly name: string
  readonly type: ContentFieldType
  /** Shown in the admin. Plain language; an editor reads this, not the field name. */
  readonly label: string
  readonly help?: string
  readonly required?: boolean
  /** `select` only. */
  readonly options?: readonly string[]
  /** `array` only: the fields of one row. */
  readonly of?: readonly ContentField[]
}

/**
 * A collection of narrative documents.
 *
 * `drafts` is always true and `maxVersions` is always set: docs/09 §5 requires a diff before save and
 * a revert to any prior version, and a collection without drafts cannot offer either. There is no
 * flag to turn it off, because "publish straight to live" is not a mode this system has.
 */
export interface ContentCollection {
  readonly slug: string
  readonly label: string
  /** Why the collection exists, in one sentence. Read by the admin and by the next person here. */
  readonly purpose: string
  /** The field the admin lists documents by. */
  readonly titleField: string
  readonly fields: readonly ContentField[]
  /** How many versions are retained. Beyond this the oldest is pruned by Payload. */
  readonly maxVersions: number
  /** True when the editorial order of the rows is itself content, e.g. an FAQ list. */
  readonly orderable?: boolean
}

/**
 * A singleton document.
 *
 * `writePermission` is the whole reason globals are modelled separately here: the compliance notices
 * are content, written in the same admin by the same people, and they must NOT be editable by
 * everybody who holds `content:write`. Declaring the permission per global is what makes the
 * difference checkable rather than remembered.
 */
export interface ContentGlobal {
  readonly slug: string
  readonly label: string
  readonly purpose: string
  readonly fields: readonly ContentField[]
  readonly maxVersions: number
  readonly writePermission: Permission
}

/** Collections are written by anybody who holds this; publishing needs `content:publish` as well. */
export const COLLECTION_WRITE_PERMISSION = 'content:write' as const satisfies Permission

/** Publishing, unpublishing and reverting a version. Held by the owner alone in the F07 matrix. */
export const PUBLISH_PERMISSION = 'content:publish' as const satisfies Permission
