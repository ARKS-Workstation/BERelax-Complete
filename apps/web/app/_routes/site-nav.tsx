/**
 * Every public page, linked from every public page. The reachability half of the link-graph invariant.
 *
 * ## Why this had to exist before the invariant could hold
 *
 * The acceptance criterion is *"every public route is reachable from `/` within 3 clicks; zero orphan
 * routes"* — and the site as W-SITE-05 left it satisfied neither. `app/(en)/(public)/page.tsx` renders a
 * heading and a paragraph; `RouteNav` contributes a link home and a link to the other locale. So nothing on
 * the home page linked to `/treatments` or `/pricing`, and both were orphans: reachable only from the
 * sitemap, which W-SITE-08 has not built yet, and from `/llms.txt`. That is not a gap in the pages — it is
 * what an invariant catches and a convention does not, which is the whole argument of this unit.
 *
 * The real header, the sticky book bar and the footer are W-SITE-04's and W-SITE-06's. This is not them: it
 * is one list of links, derived from the route registry, with no styling decisions of its own beyond the
 * `be-actions` row every other nav on the site uses. When W-SITE-04 lands a header, the right move is to
 * delete this and let that header carry the same list — and the link-graph test is what will say so if it
 * carries a shorter one.
 *
 * ## Why the list is declared and asserted rather than derived
 *
 * `NAV_ROUTE_IDS` (in `src/routes/nav.ts`, because a unit test and a copy module both need it and neither can
 * import a `.tsx` from this application) could be computed from the registry — every indexable document with
 * no dynamic segment — and then a new route would appear in the nav with no label to render. So it is
 * declared, the labels are total over it (a `Record<NavRouteId, string>`, so a missing one does not compile),
 * and `registry.test.ts` asserts the list equals the registry's own answer. A route added without a nav label
 * therefore fails a unit test naming it, rather than appearing as an untranslated label or silently not
 * appearing at all.
 */
import { Grid, GridCell, Section } from '@berelax/ui/layout'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import { NAV_ROUTE_IDS, type NavRouteId } from '../../src/routes/nav.ts'
import { routeById } from '../../src/routes/registry.ts'

export interface SiteNavProps {
  /** The page being rendered. It is omitted from the list: a reader is already there. */
  readonly current: NavRouteId
  readonly locale: Locale
  /** The accessible name of the nav, in this locale. */
  readonly label: string
  /** One label per page, in this locale. Total over the id list, so a new page needs copy to compile. */
  readonly labels: Readonly<Record<NavRouteId, string>>
}

export function SiteNav({ current, locale, label, labels }: SiteNavProps) {
  return (
    <Section as="div">
      <Grid>
        <GridCell span="wide">
          <nav aria-label={label} className="be-actions">
            {NAV_ROUTE_IDS.filter((id) => id !== current).map((id) => (
              <a
                key={id}
                className="be-action be-action--quiet"
                // `localisedPath` over the registry's own path: the one place a locale becomes a URL, so the
                // Arabic nav cannot point at the English document and a moved route moves here with it.
                href={localisedPath(routeById(id).path, locale)}
              >
                {labels[id]}
              </a>
            ))}
          </nav>
        </GridCell>
      </Grid>
    </Section>
  )
}
