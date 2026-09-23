/**
 * The publish loop: what a catalogue change has to invalidate, and the proof that it did.
 *
 * docs/09 §"The interconnection map" is the specification, one row of it: *"Service price → Treatment page ·
 * `Offer` schema · pricing page · booking flow"*. The acceptance criterion turns that into a test —
 * *"changing a price or display name in admin causes, within one job run, revalidation of the treatment page,
 * the index, /pricing, the Offer JSON-LD and the sitemap lastmod — one integration test asserting all five
 * artefacts changed"* — and **four out of five is a failure**, because the artefact nobody remembers is the
 * one a customer compares against the page they were quoted from.
 *
 * ## Why the five artefacts are a declared list and not a set of paths
 *
 * Three of the five are paths, and two are not: the `Offer` JSON-LD lives *inside* the treatment page and the
 * sitemap's `lastmod` comes from `updated_at` on the rows. Revalidating a path is what makes all five move,
 * but "the paths I revalidated" is not the claim — a page can be revalidated and still carry a stale schema
 * block if the block were built anywhere but from the same read. So the artefacts are named, each one says
 * which path carries it, and `treatments.itest.ts` asserts every one of them changed after one run. A list of
 * three paths would have passed on a page whose JSON-LD was baked at build time.
 *
 * ## Why this takes `revalidatePath` rather than importing it
 *
 * `next/cache`'s `revalidatePath` only works inside a request or a server action, and a unit test is neither.
 * Injecting it keeps the decision — *which* paths, in *which* locales, and the retired path after a rename —
 * testable without a server, which is where the mistake would be: forgetting `/ar`, forgetting `/pricing`, or
 * forgetting that a renamed treatment has a cached copy at its old URL that now has to 301.
 */
import { LOCALES, type Locale, localisedPath } from '../i18n/locales.ts'
import { fillParams, pathFor, routeById } from '../routes/registry.ts'

/**
 * Everything one catalogue change has to move.
 *
 * Named rather than counted: the integration test asserts a change in each, by name, so a missing one fails
 * with the artefact's name instead of an off-by-one.
 */
export const CATALOGUE_ARTEFACTS = [
  'treatment-page',
  'treatments-index',
  'pricing-page',
  'offer-json-ld',
  'sitemap-lastmod',
] as const
export type CatalogueArtefact = (typeof CATALOGUE_ARTEFACTS)[number]

/** What changed in the catalogue. Each kind moves the same five artefacts, for different reasons. */
export const CATALOGUE_CHANGE_KINDS = ['price', 'display_name', 'slug', 'archive'] as const
export type CatalogueChangeKind = (typeof CATALOGUE_CHANGE_KINDS)[number]

export interface CatalogueChange {
  readonly kind: CatalogueChangeKind
  /** The slug the service answers on **after** the change. For an archival, the retired one. */
  readonly slug: string
  /**
   * The slug it answered on before, for a rename.
   *
   * Its cached copy is a 200 with the old name and price. Left alone, a crawler and every browser that has
   * it keep being served a page that should now be a 301 — which is the rename silently not happening for
   * exactly the visitors who had the old URL.
   */
  readonly previousSlug?: string
}

/** The paths one change invalidates, in both locales, deduplicated and in a stable order. */
export function revalidationPathsFor(change: CatalogueChange): readonly string[] {
  const treatment = routeById('treatment')
  // The route's own pattern with the slug substituted, per locale — never a hand-built `/treatments/<slug>`.
  // The registry is where the prefix lives, `localisedPath` is the one place a locale becomes a URL, and
  // `fillParams` throws on a segment nobody filled, so `/ar` cannot be forgotten by a caller who only
  // thought about English and a typo cannot invalidate a path nothing serves.
  const treatmentPath = (slug: string, locale: Locale): string =>
    fillParams(localisedPath(treatment.path, locale), { slug })
  const paths = new Set<string>()
  for (const locale of LOCALES) {
    paths.add(treatmentPath(change.slug, locale))
    if (change.previousSlug !== undefined && change.previousSlug !== change.slug) {
      paths.add(treatmentPath(change.previousSlug, locale))
    }
    paths.add(pathFor(routeById('treatments'), locale))
    paths.add(pathFor(routeById('pricing'), locale))
    // The home page, added by W-SITE-04. Its treatments overview is one card per published service with the
    // service's own name on it, so a rename or an archival changes what `/` says — and `/` is the page a
    // crawler fetches first. It is not in `CATALOGUE_ARTEFACTS`, because that list is the five artefacts the
    // criterion names and this is a sixth surface rather than a sixth artefact: what changes on it is the
    // treatment page's own name, already asserted.
    paths.add(pathFor(routeById('home'), locale))
  }
  return [...paths]
}

/** What one job run did, for the caller that has to prove it. */
export interface CatalogueRevalidationReport {
  readonly change: CatalogueChange
  readonly paths: readonly string[]
  /** Every artefact this run claims to have moved. Always all five; see the header. */
  readonly artefacts: readonly CatalogueArtefact[]
}

export interface RevalidateDeps {
  /** `revalidatePath` from `next/cache`, injected. */
  readonly revalidatePath: (path: string) => void
}

/**
 * One job run: invalidate every path the change touches, and report what moved.
 *
 * Synchronous work behind an async signature on purpose — `revalidatePath` is synchronous today and the
 * caller is a route handler that awaits everything else it does, so the day this has to write a row (an
 * audit of what was republished, which is the obvious next requirement) no call site changes.
 */
export async function runCatalogueRevalidation(
  change: CatalogueChange,
  deps: RevalidateDeps,
): Promise<CatalogueRevalidationReport> {
  const paths = revalidationPathsFor(change)
  for (const path of paths) deps.revalidatePath(path)
  return await Promise.resolve({ change, paths, artefacts: [...CATALOGUE_ARTEFACTS] })
}
