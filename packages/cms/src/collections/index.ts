import type { ContentCollection } from '../fields.ts'
import { FAQ_ENTRIES } from './faq-entries.ts'
import { JOURNAL_POSTS } from './journal-posts.ts'
import { PAGES } from './pages.ts'
import { SERVICE_NARRATIVE } from './service-narrative.ts'
import { TESTIMONIALS } from './testimonials.ts'
import { THERAPIST_NARRATIVE } from './therapist-narrative.ts'

export { FAQ_ENTRIES } from './faq-entries.ts'
export { JOURNAL_POSTS } from './journal-posts.ts'
export { PAGES } from './pages.ts'
export { SERVICE_NARRATIVE } from './service-narrative.ts'
export { TESTIMONIALS } from './testimonials.ts'
export { THERAPIST_NARRATIVE } from './therapist-narrative.ts'

/**
 * Every content collection, in the order the admin lists them.
 *
 * One file per collection, deliberately: `scripts/check-cms-boundary.mjs` attributes a field to a
 * collection by the file it is declared in, and a rule that is specific to one collection — no
 * name-shaped field on `therapist_narrative` — can only be exact if the attribution is.
 */
export const CONTENT_COLLECTIONS = [
  PAGES,
  JOURNAL_POSTS,
  FAQ_ENTRIES,
  SERVICE_NARRATIVE,
  THERAPIST_NARRATIVE,
  TESTIMONIALS,
] as const satisfies readonly ContentCollection[]

export type ContentCollectionSlug = (typeof CONTENT_COLLECTIONS)[number]['slug']

const BY_SLUG = new Map<string, ContentCollection>(
  CONTENT_COLLECTIONS.map((collection) => [collection.slug, collection]),
)

export function contentCollection(slug: string): ContentCollection | undefined {
  return BY_SLUG.get(slug)
}
