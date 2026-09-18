/**
 * The Arabic home route.
 *
 * A separate route rather than a runtime toggle, because the language is part of the URL a crawler
 * indexes and a customer shares. `lang` and `dir` are set by the `(ar)` root layout on `<html>`, not
 * here on a wrapper — `theme/arabic.css` inherits the whole recalibration from the document element,
 * and a wrapper leaves `body` Latin.
 *
 * It is the same registry entry as `/`, which is what makes the two documents' `hreflang` sets
 * identical: `routeMetadata('home', 'ar')` and `routeMetadata('home', 'en')` differ only in which URL is
 * canonical. The editorial grid is here rather than on a bare `<main>` because mirroring is a claim about
 * a layout: `route-spine.itest.ts` measures this grid's two asymmetric columns and asserts the 12rem one
 * is on the right.
 */
import { DesignSystemStyles, Grid, Section } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'ar')

export default function ArabicHomePage() {
  return (
    <main>
      <DesignSystemStyles />
      <RouteNav id="home" locale="ar" />

      <Section>
        <Grid>
          <h1>بي ريلاكس</h1>
          <p>مركز مساج في الزاهية، أبوظبي.</p>
        </Grid>
      </Section>
    </main>
  )
}
