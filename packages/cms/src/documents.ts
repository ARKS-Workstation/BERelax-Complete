import type { FAQ_ENTRIES } from './collections/faq-entries.ts'
import type { JOURNAL_POSTS } from './collections/journal-posts.ts'
import type { PAGES } from './collections/pages.ts'
import type { SERVICE_NARRATIVE } from './collections/service-narrative.ts'
import type { TESTIMONIALS } from './collections/testimonials.ts'
import type { THERAPIST_NARRATIVE } from './collections/therapist-narrative.ts'
import type { ContentCollection, ContentField, ContentGlobal } from './fields.ts'
import type { COMPLIANCE_NOTICES } from './globals/compliance-notices.ts'
import type { EDITORIAL_DEFAULTS } from './globals/editorial-defaults.ts'

/**
 * The rendered document types, DERIVED from the field descriptors.
 *
 * This is the half of the catalogue boundary that the type system holds. `ServiceNarrativeDocument` has
 * exactly the properties `SERVICE_NARRATIVE.fields` declares — so a page that reads `doc.price` does
 * not compile, and it stops compiling for the right reason: there is no such field, not because someone
 * remembered to leave it out of a hand-written interface.
 *
 * Hand-writing the interfaces was the obvious alternative and it is the wrong one: two lists drift, and
 * the one that drifts is the type, because the field list is the one an editor's bug report points at.
 * `boundary.test.ts` pins the derivation with a `@ts-expect-error` on `doc.price` — add a `price` field
 * to the descriptor and that directive becomes unused, which is `TS2578` and a failed `pnpm typecheck`.
 */

/**
 * A Lexical editor state. Opaque on purpose.
 *
 * The renderer is `@payloadcms/richtext-lexical`'s and lives in `apps/web`; nothing in a package needs
 * to know the node shape, and typing it here would put a Payload type in the root typecheck project.
 */
export interface RichTextValue {
  readonly root: {
    readonly type: string
    readonly children: readonly unknown[]
  }
}

/** One row of an `array` field. Its own fields are typed where the row is consumed. */
export type ArrayRowValue = readonly Readonly<Record<string, unknown>>[]

type FieldValue<F extends ContentField> = F['type'] extends 'checkbox'
  ? boolean
  : F['type'] extends 'richText'
    ? RichTextValue
    : F['type'] extends 'array'
      ? ArrayRowValue
      : string

/**
 * What Payload adds to every document.
 *
 * `id` is `number` for the Postgres adapter and `string` for Mongo; typed as the union so no renderer
 * can quietly depend on it being arithmetic.
 */
export interface DocumentMeta {
  readonly id: string | number
  readonly createdAt: string
  readonly updatedAt: string
  readonly _status: 'draft' | 'published'
}

/**
 * A document of a collection, from its descriptor.
 *
 * Non-required fields are `| null` rather than optional: Payload returns `null` for an unset column, and
 * an optional property would let `doc.aftercare` be silently `undefined` in a template that forgot it.
 */
export type DocumentOf<C extends ContentCollection> = DocumentMeta & {
  readonly [F in C['fields'][number] as F['name']]: F extends { readonly required: true }
    ? FieldValue<F>
    : FieldValue<F> | null
}

/** A global has no `_status` of its own until it is versioned; Payload adds the same shape otherwise. */
export type GlobalOf<G extends ContentGlobal> = Omit<DocumentMeta, 'id'> & {
  readonly [F in G['fields'][number] as F['name']]: F extends { readonly required: true }
    ? FieldValue<F>
    : FieldValue<F> | null
}

export type PageDocument = DocumentOf<typeof PAGES>
export type JournalPostDocument = DocumentOf<typeof JOURNAL_POSTS>
export type FaqEntryDocument = DocumentOf<typeof FAQ_ENTRIES>
export type ServiceNarrativeDocument = DocumentOf<typeof SERVICE_NARRATIVE>
export type TherapistNarrativeDocument = DocumentOf<typeof THERAPIST_NARRATIVE>
export type TestimonialDocument = DocumentOf<typeof TESTIMONIALS>

export type ComplianceNoticesGlobal = GlobalOf<typeof COMPLIANCE_NOTICES>
export type EditorialDefaultsGlobal = GlobalOf<typeof EDITORIAL_DEFAULTS>
