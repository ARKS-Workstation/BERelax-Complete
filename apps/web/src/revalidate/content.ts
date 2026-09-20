/**
 * The publish loop for the CMS-and-premises routes: what each kind of change has to invalidate.
 *
 * The sibling of `src/revalidate/catalogue.ts`, deliberately in the same shape — a pure decision with
 * `revalidatePath` injected, so the mistake that actually happens is catchable by a unit test. That mistake
 * is a forgotten locale: `/faq` revalidated and `/ar/faq` left serving yesterday's answer is invisible to
 * anybody reading English, and an integration test that fetched the paths the report named could not see it
 * either, because it would fetch the ones that were revalidated.
 *
 * ## The four kinds, and why `premises` is one of them
 *
 * docs/09 §"The interconnection map" has the row: *"Address → LocalBusiness JSON-LD · footer NAP ·
 * `/contact` · `/spa` · map embed · sitemap · OG image · /api/facts"*. Until this unit every surface that
 * read the premises row was dynamic, which is exactly what W-SITE-02 recorded when it said "cache-tag
 * revalidation belongs to the first ISR route that renders NAP". `/spa` and `/contact` are those routes, so a
 * premises change now has cached copies to invalidate and this is where that is written down.
 */
import { LOCALES, localisedPath } from '../i18n/locales.ts'
import { pathFor, type RouteId, routeById } from '../routes/registry.ts'

/** What changed. Each kind moves a different set of pages, for a different reason. */
export const CONTENT_CHANGE_KINDS = ['faq', 'journal', 'page', 'premises'] as const
export type ContentChangeKind = (typeof CONTENT_CHANGE_KINDS)[number]

/**
 * The routes each kind of change invalidates, by registry id.
 *
 * Ids rather than paths, so `localisedPath` is still the one place a locale becomes a URL and a route that
 * moves moves here with it. Declared per kind rather than "everything, always": revalidating eighteen
 * documents to publish one FAQ answer would make the loop's cost proportional to the size of the site
 * instead of to the change.
 */
export const CONTENT_ROUTES_BY_KIND: Readonly<Record<ContentChangeKind, readonly RouteId[]>> = {
  // The FAQ rows are on `/faq` and nowhere else — but the `FAQPage` node is on the same page, which is the
  // point of the criterion this unit satisfies: one page, two artefacts, one invalidation.
  faq: ['faq'],
  journal: ['journal'],
  // A `pages` document is `/about` today. When the legal set exists it joins this list, which is why the
  // value is an array for a single route rather than a route.
  page: ['about'],
  // Everything that renders the premises row. `/about` is here because its answers name the address and the
  // district; `/faq` and `/journal` are not, because nothing on them comes from that row.
  premises: ['spa', 'contact', 'about'],
}

/** Every path one change invalidates, in both locales, deduplicated and in a stable order. */
export function contentRevalidationPathsFor(kind: ContentChangeKind): readonly string[] {
  const paths = new Set<string>()
  for (const id of CONTENT_ROUTES_BY_KIND[kind]) {
    for (const locale of LOCALES) paths.add(pathFor(routeById(id), locale))
  }
  return [...paths]
}

/** What one run did, for a caller that has to prove it. */
export interface ContentRevalidationReport {
  readonly kind: ContentChangeKind
  readonly paths: readonly string[]
}

export interface RevalidateDeps {
  /** `revalidatePath` from `next/cache`, injected: it only works inside a request or a server action. */
  readonly revalidatePath: (path: string) => void
}

export async function runContentRevalidation(
  kind: ContentChangeKind,
  deps: RevalidateDeps,
): Promise<ContentRevalidationReport> {
  const paths = contentRevalidationPathsFor(kind)
  for (const path of paths) deps.revalidatePath(path)
  return await Promise.resolve({ kind, paths })
}

/** Every path any kind of content change can invalidate. For a caller that changed several things at once. */
export function allContentPaths(): readonly string[] {
  const paths = new Set<string>()
  for (const kind of CONTENT_CHANGE_KINDS) {
    for (const path of contentRevalidationPathsFor(kind)) paths.add(path)
  }
  return [...paths]
}

/** The Arabic path of a route, for a test that has to name one without spelling a prefix. */
export function arabicPathOf(id: RouteId): string {
  return localisedPath(routeById(id).path, 'ar')
}
