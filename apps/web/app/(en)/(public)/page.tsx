/**
 * The public home route, in English.
 *
 * A server component, rendering complete HTML. The real page — hero, proof, treatments overview,
 * therapists, booking CTA — is W-SITE-04's; what W-SITE-01 adds to it is the spine: the editorial grid,
 * the locale switch, and the canonical and `hreflang` block that `routeMetadata` builds from the route
 * registry. `/` and `/ar` are one registry entry, so the alternate set is reciprocal by construction
 * rather than by two pages agreeing.
 *
 * ## Why the locality is no longer in the copy
 *
 * This paragraph named the district and the emirate after the trading name, and
 * `packages/db/src/seed/premises.test.ts` exempted this file for it. W-SITE-02 retired that exemption by
 * deleting the literal rather than by reading the row, and the reason is the registry entry beside it: this
 * route is `rendering: 'static'`, so everything on it is evaluated during `next build`, and the build has
 * no database by design (`app/api/v1/otp/route.ts` records why). A build-time read would bake an address
 * that nothing could then correct — a hard-coded address with extra steps.
 *
 * It is a deferral and not a loss. docs/09 §"The brand collision" wants the name paired with the locality
 * on this page, and W-SITE-04 renders it under ISR from the catalogue and the premises row, where a
 * revalidation propagates a correction. Until then the address is published where it can be kept true:
 * `/api/facts`, `/llms.txt`, and `@berelax/ui`'s NAP block on any route that reads the row per request.
 */
import { DesignSystemStyles, Grid, Section } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { navLabels } from '../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../src/cms/copy-en.ts'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'
import { SiteNav } from '../../_routes/site-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'en')

export default function HomePage() {
  return (
    <main>
      <DesignSystemStyles />
      <RouteNav id="home" locale="en" />

      <Section>
        <Grid>
          <h1>BE RELAX</h1>
          <p>Massage Center and Spa.</p>
        </Grid>
      </Section>

      {/* W-SITE-07. Until this landed the home page linked to nothing, so `/treatments` and `/pricing` were
          orphans — reachable only from a sitemap W-SITE-08 has not built and from `/llms.txt`. That is what
          the link-graph invariant catches and a convention does not. It is a list of links derived from the
          route registry and needs no database, which is what lets it sit on a `rendering: 'static'` page:
          the copy is per-locale and the paths are the registry's. W-SITE-04's header replaces it, and the
          invariant is what will say so if that header carries a shorter list. */}
      <SiteNav
        current="home"
        locale="en"
        label={CONTENT_COPY_EN.labels.nav}
        labels={navLabels(CONTENT_COPY_EN)}
      />
    </main>
  )
}
