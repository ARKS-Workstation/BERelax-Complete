/**
 * The Arabic home route.
 *
 * A separate route rather than a runtime toggle, because the language is part of the URL a crawler
 * indexes and a customer shares. `lang` and `dir` are set by the `(ar)` root layout on `<html>`, not
 * here on a wrapper — `theme/arabic.css` inherits the whole recalibration from the document element,
 * and a wrapper leaves `body` Latin.
 *
 * The locality has left this paragraph for the reason the English route records: `/` and `/ar` are
 * statically prerendered, so their copy is baked at `next build`, and the build has no database. The
 * Arabic spelling of the district was also a NAP literal the grep gate could not see, since its patterns
 * are Latin — the same defect one script further from anything that would catch it.
 *
 * It is the same registry entry as `/`, which is what makes the two documents' `hreflang` sets
 * identical: `routeMetadata('home', 'ar')` and `routeMetadata('home', 'en')` differ only in which URL is
 * canonical. The editorial grid is here rather than on a bare `<main>` because mirroring is a claim about
 * a layout: `route-spine.itest.ts` measures this grid's two asymmetric columns and asserts the 12rem one
 * is on the right.
 */
import { DesignSystemStyles, Grid, Section } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { navLabels } from '../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../src/cms/copy-ar.ts'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'
import { SiteNav } from '../../_routes/site-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'ar')

export default function ArabicHomePage() {
  return (
    <main>
      <DesignSystemStyles />
      <RouteNav id="home" locale="ar" />

      <Section>
        <Grid>
          <h1>بي ريلاكس</h1>
          <p>مركز مساج وسبا.</p>
        </Grid>
      </Section>

      {/* W-SITE-07's site navigation, in Arabic. One graph per locale is what reachability means: an Arabic
          page reachable only by following the locale switch out of an English one is not reachable in
          Arabic, and a reader arriving on `/ar` from a search result would never find it. */}
      <SiteNav
        current="home"
        locale="ar"
        label={CONTENT_COPY_AR.labels.nav}
        labels={navLabels(CONTENT_COPY_AR)}
      />
    </main>
  )
}
