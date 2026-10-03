/**
 * `/therapists` — the trust layer, in English.
 *
 * DYNAMIC rather than ISR, and the registry entry carries the argument: this page IS the publication
 * state, so a withdrawn photography consent has to stop showing a name on the next request rather than on
 * the next revalidation. `route-spine.itest.ts` checks that claim against `.next/prerender-manifest.json`.
 */
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { qualificationPhrase, therapistIndexCards } from '../../../../src/therapists/content.ts'
import { THERAPISTS_COPY_EN } from '../../../../src/therapists/copy-en.ts'
import {
  candidateFor,
  publishableTherapists,
  therapistPageData,
} from '../../../../src/therapists/read.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { TherapistsIndexBody } from '../../../_therapists/pages.tsx'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'The therapists — BE RELAX Massage Center and Spa',
  description:
    'Every therapist on the floor, and the two things that have to be on file before one of them has a ' +
    'page: the name they want published and their consent to be photographed.',
  ...routeMetadata('therapists', 'en'),
}

export default async function TherapistsIndexPage() {
  const { facts, licenceClass, therapists } = await therapistPageData()
  const graph = pageGraph({
    id: 'therapists',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: THERAPISTS_COPY_EN.home, page: THERAPISTS_COPY_EN.index.title },
    includeCatalogue: false,
    // Only the therapists who pass the guard reach the graph, and `personNodesFor` filters on the same
    // predicate again — so a row that slipped through here would still contribute no `Person` node. Two
    // layers of one guard rather than two guards: both call `isTherapistPublishable`.
    therapists: publishableTherapists(therapists).map((row) => candidateFor(row)),
  })
  const cards = therapistIndexCards(therapists, 'en', (skills) =>
    qualificationPhrase(skills, THERAPISTS_COPY_EN.skills, THERAPISTS_COPY_EN.skillJoin),
  )
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="therapists" locale="en" />
      <TherapistsIndexBody cards={cards} copy={THERAPISTS_COPY_EN} locale="en" />
    </>
  )
}
