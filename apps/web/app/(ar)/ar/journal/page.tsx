/**
 * `/ar/journal` — the index, in Arabic. The same registry entry as `/journal`; see `/ar/spa/page.tsx`.
 */
import type { Metadata } from 'next'
import { journalSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { JournalBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'المدونة — BE RELAX Massage Center and Spa',
  description: 'ملاحظات عن الزيارة والحجز وما يحدث في الغرفة.',
  ...routeMetadata('journal', 'ar'),
}

export default async function ArabicJournalPage() {
  const { facts, licenceClass, policy, posts, disclaimer } = await contentPageData()
  const copy = CONTENT_COPY_AR
  assertPageCopyCompliant(
    'journal',
    renderedStrings({
      title: copy.journal.title,
      lede: copy.journal.lede,
      sections: journalSections(copy, { facts, locale: 'ar', posts }),
      // Only what this page actually renders, and never the disclaimer; see the English page and
      // `src/cms/page-data.ts`.
      extra: posts.length === 0 ? [copy.labels.journalEmpty] : [],
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'journal',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.journal.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="journal" locale="ar" />
      <JournalBody facts={facts} copy={copy} locale="ar" posts={posts} disclaimer={disclaimer} />
    </>
  )
}
