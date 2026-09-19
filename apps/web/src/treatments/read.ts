/**
 * What the three catalogue-derived routes read, and what they refuse to render without.
 *
 * `readPageFacts` is the shared read — the premises row, the price grid and the licence class on one
 * connection — and this adds the three things a *catalogue* route needs beyond it:
 *
 *   1. **the slug set**, for `generateStaticParams`;
 *   2. **the compliance policy**, because the acceptance criterion is that a non-compliant public display
 *      name *fails the build*, and the only moment the build sees all eight names is when it prerenders
 *      them;
 *   3. **the path resolution** for one slug: render, 301, or 404.
 *
 * ## Why this read is NOT fail-soft, where `readPageFacts` is
 *
 * `readPageFacts` swallows its failure and returns `null` so that a route whose database has not been
 * seeded renders the rest of itself — right for the kitchen sink, whose subject is the design system. It is
 * wrong here: a treatment page with no facts has no name, no price and no reason to exist, and a 200 that
 * renders an empty menu is worse than a build that fails, because a crawler will index it. So
 * `treatmentPageData` throws, and the message names the step that was skipped.
 *
 * ## Why the build reads the database at all
 *
 * Because `generateStaticParams` over the catalogue is the acceptance criterion, and the reason it is the
 * criterion rather than a dynamic render is what these pages are: eight documents whose content changes a
 * few times a year, are the most valuable pages on the site, and must be served as complete HTML to a
 * crawler that will not run JavaScript (docs/09). Prerendering them is the point.
 *
 * It has a consequence this repository had not met before, recorded here because it is a deployment fact
 * rather than a code one: **`next build` now needs a migrated and seeded database.** Every other route was
 * built without one on purpose (`app/api/v1/otp/route.ts` and `src/facts/runtime.ts` both record it), and
 * `.github/workflows/ci.yml` therefore applies the migrations and seeds *before* the build step — the order it
 * used to have the other way round.
 *
 * The failure without them is loud, which is the point of the throw below: an empty schema fails in
 * `readTreatmentPages` on "relation service does not exist", and a migrated-but-unseeded database fails here,
 * naming the seed. 0017 inserts the eight services as DRAFTS, so an unseeded build would otherwise prerender
 * zero treatment pages and report success.
 */
import { assertPublicDisplayNameCompliant, type CompliancePolicy } from '@berelax/core'
import {
  readCompliancePolicy,
  readTreatmentPages,
  resolveServicePath,
  servicePath,
  TREATMENTS_INDEX_PATH,
} from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { readPageFacts } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'
import type { CatalogueService } from './content.ts'

/** The fact sheet, the licence class and the policy the names are linted against. */
export interface TreatmentPageData {
  readonly facts: Facts
  readonly licenceClass: string
  readonly policy: CompliancePolicy
}

/**
 * Everything the catalogue pages render from, or a throw naming what is missing.
 *
 * The lint runs **here**, over every published name, on every one of these pages — not only in
 * `generateStaticParams`. The reason is the shape of the failure it catches: a name is linted when it is
 * written (`setPublicDisplayName` and `seedCatalogue` both refuse an unlinted one), so a non-compliant name
 * can only reach the catalogue through a path that bypassed the repository — a `psql` session, a restored
 * dump, a migration. The pages are where such a row becomes published copy, so the pages are where it is
 * refused.
 */
export async function treatmentPageData(): Promise<TreatmentPageData> {
  const source = await readPageFacts()
  if (source === null) {
    throw new Error(
      'The catalogue pages have no facts to render: `premises` has no row, or the connection could not ' +
        'be built. Apply the migrations and run `pnpm seed` before `next build` — these routes prerender ' +
        'from the catalogue, so the database is a build dependency (see this module’s header).',
    )
  }
  const row = await readCompliancePolicy(factsRuntime().sql)
  const policy: CompliancePolicy = {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
  for (const service of source.facts.catalogue.services) {
    assertPublicDisplayNameCompliant(service.name, policy)
  }
  for (const offering of source.facts.catalogue.onRequest) {
    // `price_on_request.menu_label` is public copy on `/pricing` (0032 says so in the column comment), so
    // it goes through the same lint as a service name. It is not a `service` row and nothing else lints it.
    assertPublicDisplayNameCompliant(offering.label, policy)
  }
  return { facts: source.facts, licenceClass: source.licenceClass, policy }
}

/** The service one slug names, or `undefined`. */
export function serviceBySlug(facts: Facts, slug: string): CatalogueService | undefined {
  return facts.catalogue.services.find((service) => service.slug === slug)
}

/**
 * The slugs `generateStaticParams` prerenders: every published, unarchived service, in menu order.
 *
 * Read on its own rather than off the fact sheet, because the build needs eight strings and this is the one
 * read that has to work before anything else on the page does — including in a build where the fact sheet
 * would fail for an unrelated reason. It is the same predicate: `readTreatmentPages` selects
 * `published_at is not null and archived_at is null`, which is what makes an archived service disappear from
 * the prerendered set and from the sitemap at once.
 */
export async function publishedTreatmentSlugs(): Promise<readonly string[]> {
  const pages = await readTreatmentPages(factsRuntime().sql)
  return pages.map((page) => page.slug)
}

/** What a request for `/treatments/<slug>` resolves to. */
export type TreatmentResolution =
  | { readonly kind: 'render'; readonly service: CatalogueService }
  /** A 301, to a renamed treatment or to the index. `status` is the row's, never invented. */
  | { readonly kind: 'redirect'; readonly target: string; readonly status: number }
  | { readonly kind: 'not_found' }

/**
 * Resolves one slug against the catalogue and the redirect map.
 *
 * The order is `resolveServicePath`'s and it matters: a slug that still resolves wins over a redirect that
 * names it, so a treatment renamed away and back does not 301 to itself. The archived case needs nothing
 * here — `archiveService` writes the 301 from the retired page to the treatments index in the same
 * transaction that archives it (0029, `redirect_source_still_live` is what makes the order forced), so it
 * arrives as an ordinary redirect row. A page-level fallback would be a second answer to "where does this
 * path go", resolved by whichever ran first.
 *
 * The redirect target is not verified here. It cannot point at a dead page: `redirect_map_one_hop` refuses a
 * row whose treatment target no live service answers on, and the deferred trigger on `service` refuses a
 * rename or archival that would leave one behind.
 */
export async function resolveTreatment(facts: Facts, slug: string): Promise<TreatmentResolution> {
  const service = serviceBySlug(facts, slug)
  if (service !== undefined) return { kind: 'render', service }
  // `servicePath` rather than a second spelling of the prefix: it is the TypeScript half of 0029's
  // `treatment_path()`, and the two are asserted against each other in `catalogue.itest.ts`.
  const resolution = await resolveServicePath(factsRuntime().sql, servicePath(slug))
  if (resolution.kind === 'redirect') {
    return { kind: 'redirect', target: resolution.target, status: resolution.status }
  }
  // `kind: 'service'` here would mean the catalogue holds a live service the fact sheet does not publish,
  // which is possible for exactly one reason: the fact sheet was built from a read taken before it was
  // published. Rendering nothing is wrong and inventing a page is worse, so it is a redirect to the index —
  // the same answer an archived page gives, and the one that never 404s a path that resolves.
  if (resolution.kind === 'service') {
    return { kind: 'redirect', target: TREATMENTS_INDEX_PATH, status: 301 }
  }
  return { kind: 'not_found' }
}
