/**
 * `/journal` — the index, in English.
 *
 * Empty, and the emptiness is the publication lint working rather than a gap: a post is published only with
 * the name of the person who wrote it, the name of the person who checked it and a date
 * (`assertJournalPostPublishable`), and this build does not invent a name. The page says so in the answer to
 * "Who writes it?" rather than rendering an empty region — docs/09 §3's rule that an empty state is a
 * designed state.
 *
 * `/journal/[slug]` is not a route yet, for the same reason; the manifest NOTE records it and names what
 * would unblock it. A post's title is therefore not a link on this page: there is nothing to link to, and a
 * link to a 404 is the first thing the link-graph invariant refuses.
 */
import type { Metadata } from 'next'
import { journalSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { JournalBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'Journal — BE RELAX Massage Center and Spa',
  description: 'Notes on visiting, booking and what happens in the room.',
  ...routeMetadata('journal', 'en'),
}

export default async function JournalPage() {
  const { facts, licenceClass, policy, posts, disclaimer } = await contentPageData()
  const copy = CONTENT_COPY_EN
  assertPageCopyCompliant(
    'journal',
    renderedStrings({
      title: copy.journal.title,
      lede: copy.journal.lede,
      sections: journalSections(copy, { facts, locale: 'en', posts }),
      // Only what this page actually renders, and the disclaimer is deliberately NOT in it: see
      // `src/cms/page-data.ts`, which is where that exemption is argued.
      extra: posts.length === 0 ? [copy.labels.journalEmpty] : [],
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'journal',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.journal.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="journal" locale="en" />
      <JournalBody facts={facts} copy={copy} locale="en" posts={posts} disclaimer={disclaimer} />
    </>
  )
}
