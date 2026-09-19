/**
 * `/treatments/<slug>` — one treatment, in English. The commercial core of the site.
 *
 * It replaces B-CAT-05's `route.ts`, which answered `text/plain` and existed to prove the redirect pair
 * against a real database; a `page.tsx` and a `route.ts` cannot share a segment, so this file is that
 * supersession. The resolution it performed lives in `src/treatments/read.ts`, where the integration suite
 * still drives it directly.
 *
 * ## Three statuses from one segment
 *
 * - **200** for a published treatment, prerendered by `generateStaticParams` — eight paths today.
 * - **A permanent redirect** for a slug that moved or a service that was archived. The row is
 *   `redirect_map`'s, written by `renameServiceSlug` and `archiveService` inside the transaction that
 *   changed the slug, so there is no second place a redirect can be forgotten.
 * - **404** for a slug that never existed. Not a redirect to the index: a 301 from every mistyped URL to
 *   `/treatments` tells a crawler those URLs are real pages that moved.
 *
 * `permanentRedirect` is Next's 308 rather than the 301 the row records, and the difference is the
 * framework's: `redirect()` answers **307**, which is *temporary* — the one thing 0029 refuses in so many
 * words ("a 302 on a permanent rename asks every crawler to keep the old URL"). 308 and 301 are the same
 * signal to every search engine, and differ only in whether a non-GET method survives, which for a page is
 * moot. The stored `status_code` stays 301 because that is what a CDN rule or a proxy would serve if one
 * ever took this over; `treatments.itest.ts` asserts the shape that is actually served — one permanent hop
 * to a 200, no chain — rather than a digit the framework does not offer. W-SITE-01 recorded the same
 * distinction for Next's own doubled-slash 308.
 *
 * ## Why the redirect drops the query string, and where that has to be fixed
 *
 * B-CAT-05's handler carried `?utm_source=…` across the 301, because a campaign parameter is how traffic
 * arriving on a retired URL is attributed and dropping it turns a tracked visit into direct traffic silently.
 * This page cannot: reading `searchParams` is a dynamic API, and a route with `generateStaticParams` renders
 * an unlisted param **as a static render at request time** — the redirect branch then fails with
 * `DYNAMIC_SERVER_USAGE` and answers 500, which was measured here rather than assumed. The choice is
 * therefore between prerendering the eight pages, which is this unit's acceptance criterion and the reason
 * the route exists in this shape, and preserving a query string on a redirect from a slug that no longer
 * resolves. Prerendering wins, and the loss is recorded rather than hidden: `treatments.itest.ts` asserts the
 * redirect target is the bare canonical path, so the day it carries the query again that test fails and is
 * updated deliberately.
 *
 * The fix is not in this file. A redirect that has to see the request belongs in a layer that always does —
 * `proxy.ts` with a snapshot of `redirect_map`, or a CDN rule generated from the same table, both of which
 * preserve the query by default. W-SITE-09 imports the legacy WooCommerce URLs into that table and is where
 * that layer belongs.
 *
 * ## Why this reads the database during `next build`
 *
 * Because `generateStaticParams` over the catalogue is the point (see `src/treatments/read.ts`). The
 * consequence for CI is real and is recorded there: the migrations and the seed now run **before** the
 * build.
 */
import type { Metadata, Route } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { routeMetadata } from '../../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../../src/seo/structured-data.tsx'
import { MENU_COPY_EN, TREATMENT_COPY_EN } from '../../../../../src/treatments/copy-en.ts'
import {
  publishedTreatmentSlugs,
  resolveTreatment,
  treatmentPageData,
} from '../../../../../src/treatments/read.ts'
import { RouteNav } from '../../../../_routes/route-nav.tsx'
import { TreatmentBody } from '../../../../_treatments/pages.tsx'

interface TreatmentParams {
  readonly params: Promise<{ readonly slug: string }>
}

/**
 * One prerendered path per published treatment.
 *
 * `dynamicParams` is left at its default (true), which is what makes a treatment published after the build
 * reachable immediately — rendered on demand, then cached — instead of 404ing until the next deploy. The
 * retired slugs are not listed here and must not be: a prerendered 301 is a page in the cache whose only
 * content is a redirect.
 */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const slugs = await publishedTreatmentSlugs()
  return slugs.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: TreatmentParams): Promise<Metadata> {
  const { slug } = await params
  const { facts } = await treatmentPageData()
  const service = facts.catalogue.services.find((candidate) => candidate.slug === slug)
  // A title for a page that is about to 301 or 404 is never read by anybody. The name is the catalogue's,
  // and the qualified trading name comes from the row rather than from a literal, because
  // `premises.display_name` is the one place it is spelled (docs/09 §4).
  const name = service?.name ?? facts.names.display
  return {
    title: `${name} — ${facts.names.display}`,
    // No answer to compose for a slug that resolves to nothing: the page redirects or 404s before anything
    // is rendered, and a description built from an empty service would be a sentence about no treatment.
    description:
      service === undefined
        ? MENU_COPY_EN.lede
        : TREATMENT_COPY_EN.answers['what-is-it']({ facts, service, locale: 'en' }),
    ...routeMetadata('treatment', 'en', { slug }),
  }
}

export default async function TreatmentPage({ params }: TreatmentParams) {
  const { slug } = await params
  const { facts, licenceClass } = await treatmentPageData()
  const resolution = await resolveTreatment(facts, slug)
  // `as Route` is `typedRoutes`: Next types a redirect target as a known route literal, and this one comes
  // from `redirect_map` — a row, not a literal. The row is validated by the schema: the path shape by
  // `redirect_map_source_path_absolute` and the treatment target by `redirect_map_one_hop` (0029).
  if (resolution.kind === 'redirect') permanentRedirect(resolution.target as Route)
  if (resolution.kind === 'not_found') notFound()

  const service = resolution.service
  const graph = pageGraph({
    id: 'treatment',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: TREATMENT_COPY_EN.home, page: service.name },
    includeCatalogue: true,
    // This page's subject is one treatment: one `Service` node, its four `Offer`s, and none of the other
    // seven services. See `serviceNodes`.
    serviceSlugs: [service.slug],
    params: { slug },
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="treatment" locale="en" params={{ slug }} />
      <TreatmentBody facts={facts} service={service} copy={TREATMENT_COPY_EN} locale="en" />
    </>
  )
}
