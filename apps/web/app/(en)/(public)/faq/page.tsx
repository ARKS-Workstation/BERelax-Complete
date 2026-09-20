/**
 * `/faq` — in English, from `faq_entries`.
 *
 * **One read, one array, two consumers.** `contentPageData()` reads the published rows once; `FaqBody`
 * renders them and `pageGraph({ faq })` publishes them. That is the acceptance criterion — *"/faq and the
 * FAQPage schema derive from the same faq_entries rows: question and answer text and entry count are asserted
 * equal"* — satisfied by construction rather than by two code paths being compared, and
 * `apps/web/src/content.itest.ts` then asserts the equality over the served bytes, where it is a real claim.
 *
 * W-SITE-03 deferred the `FAQPage` node to "the unit that adds /faq" and W-SITE-05 deferred the same node
 * again, both because there was no Payload read path on a rendered route. `src/cms/read.ts` is that path and
 * its header is where the build-time problem is worked out.
 */
import type { Metadata } from 'next'
import { faqSections, publishableFaqEntries, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { FaqBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'Questions and answers — BE RELAX Massage Center and Spa',
  description: 'The questions the desk is asked most often, with the answers it gives.',
  ...routeMetadata('faq', 'en'),
}

export default async function FaqPage() {
  const { facts, licenceClass, policy, faq } = await contentPageData()
  const copy = CONTENT_COPY_EN
  // The entries the page will actually render: the same filter `faqPageNode` applies, so the page and the
  // schema block cannot differ in count. A blank question or answer is a half-finished draft.
  const entries = publishableFaqEntries(faq)
  assertPageCopyCompliant(
    'faq',
    renderedStrings({
      title: copy.faq.title,
      lede: copy.faq.lede,
      sections: faqSections(entries),
      extra: [copy.faq.empty],
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'faq',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.faq.title },
    includeCatalogue: false,
    faq: entries,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="faq" locale="en" />
      <FaqBody copy={copy} locale="en" entries={entries} />
    </>
  )
}
