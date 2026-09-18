/**
 * The public home route, in English.
 *
 * A server component, rendering complete HTML. The real page — hero, proof, treatments overview,
 * therapists, booking CTA — is W-SITE-04's; what W-SITE-01 adds to it is the spine: the editorial grid,
 * the locale switch, and the canonical and `hreflang` block that `routeMetadata` builds from the route
 * registry. `/` and `/ar` are one registry entry, so the alternate set is reciprocal by construction
 * rather than by two pages agreeing.
 */
import { DesignSystemStyles, Grid, Section } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'en')

export default function HomePage() {
  return (
    <main>
      <DesignSystemStyles />
      <RouteNav id="home" locale="en" />

      <Section>
        <Grid>
          <h1>BE RELAX</h1>
          <p>Massage Center and Spa, Al Zahiyah, Abu Dhabi.</p>
        </Grid>
      </Section>
    </main>
  )
}
