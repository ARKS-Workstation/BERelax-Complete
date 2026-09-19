/**
 * `/ar/treatments/<slug>` — one treatment, in Arabic.
 *
 * The same three statuses, the same resolution and the same prerendered slug set as the English page next
 * door; see its header for why the redirect is a 308 and why the build reads the database. What differs is
 * the copy and the document: `(ar)` is a second root layout, and every rule in `theme/arabic.css` is
 * inherited from its `<html>`.
 *
 * The treatment **name** is the catalogue's one value and is not translated here — `src/treatments/copy-ar.ts`
 * records why, and what has to exist before it can be.
 */
import type { Metadata, Route } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { localisedPath } from '../../../../../src/i18n/locales.ts'
import { routeMetadata } from '../../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../../src/seo/structured-data.tsx'
import { MENU_COPY_AR, TREATMENT_COPY_AR } from '../../../../../src/treatments/copy-ar.ts'
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

/** The same eight slugs the English route prerenders: one catalogue, two documents. */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const slugs = await publishedTreatmentSlugs()
  return slugs.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: TreatmentParams): Promise<Metadata> {
  const { slug } = await params
  const { facts } = await treatmentPageData()
  const service = facts.catalogue.services.find((candidate) => candidate.slug === slug)
  const name = service?.name ?? facts.names.display
  return {
    title: `${name} — ${facts.names.display}`,
    description:
      service === undefined
        ? MENU_COPY_AR.lede
        : TREATMENT_COPY_AR.answers['what-is-it']({ facts, service, locale: 'ar' }),
    ...routeMetadata('treatment', 'ar', { slug }),
  }
}

export default async function ArabicTreatmentPage({ params }: TreatmentParams) {
  const { slug } = await params
  const { facts, licenceClass } = await treatmentPageData()
  const resolution = await resolveTreatment(facts, slug)
  if (resolution.kind === 'redirect') {
    // The Arabic prefix is preserved: a reader who followed an Arabic link must land on the Arabic document,
    // and `redirect_map` is locale-agnostic because the slug is. `localisedPath` is the one place a locale
    // becomes a URL, and it is applied here rather than stored per locale in the table.
    // `as Route`: see the English page. The target is a validated `redirect_map` row, not a literal.
    permanentRedirect(localisedPath(resolution.target, 'ar') as Route)
  }
  if (resolution.kind === 'not_found') notFound()

  const service = resolution.service
  const graph = pageGraph({
    id: 'treatment',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: TREATMENT_COPY_AR.home, page: service.name },
    includeCatalogue: true,
    serviceSlugs: [service.slug],
    params: { slug },
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="treatment" locale="ar" params={{ slug }} />
      <TreatmentBody facts={facts} service={service} copy={TREATMENT_COPY_AR} locale="ar" />
    </>
  )
}
