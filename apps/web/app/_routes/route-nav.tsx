/**
 * The route spine's one piece of visible chrome: where you are, and the other language.
 *
 * Every route in the registry renders this, and it is deliberately two links rather than a navigation
 * bar — the real header, the sticky book bar and the footer are W-SITE-04's and W-SITE-06's. What it
 * exists for now is the part of the spine that has to be *rendered* to be true:
 *
 * - **The locale switch is the visible half of the `hreflang` set.** A reciprocal alternate set that no
 *   reader can follow is a machine-readable claim with no human counterpart; both are built from the same
 *   registry entry, so they cannot disagree about where the Arabic document is.
 * - **The back link is a directional affordance**, and direction is the thing an RTL layout gets wrong.
 *   `Icon name="back"` is the one glyph in the set that means "where you came from", so it mirrors: in an
 *   Arabic document it must point right, drawn by `scaleX(-1)` from `ICON_CSS`, not by a nudge.
 *   `route-spine.itest.ts` reads the computed transform matrix on `/ar/kitchen-sink` and asserts the
 *   sign, with the English route as the control.
 *
 * ## Why plain anchors
 *
 * `next/link` cannot be used for either of these. The locale switch crosses from one root layout to
 * another — `(en)` to `(ar)`, two different `<html>` elements — which Next serves as a full document load
 * whatever the link component does, and `typedRoutes` types `href` as a known route literal, which a path
 * computed from the registry is not. An anchor is what this actually is.
 *
 * ## Why the copy is here
 *
 * Elsewhere in this application copy belongs to the route, because the route is the locale. Two labels
 * shared by every route are the exception: four copies of the word "English" is four places to spell it,
 * and the spine is the one component that by definition renders in both documents.
 */
import { Icon } from '@berelax/ui/icon'
import { Grid, GridCell, Section } from '@berelax/ui/layout'
import { hreflangFor, type Locale, localisedPath } from '../../src/i18n/locales.ts'
import { fillParams, type RouteId, routeById } from '../../src/routes/registry.ts'

interface SpineCopy {
  /** The accessible name of the nav. Distinct from the gallery's "On this page" in both languages. */
  readonly navLabel: string
  /** The back link's label — the name of the locale's own home page. */
  readonly home: string
  /** How this locale names itself, for the switch that leads *to* it. */
  readonly language: string
}

/** A language is named in its own language on the link that leads to it: an Arabic reader looks for العربية. */
const SPINE_COPY: Readonly<Record<Locale, SpineCopy>> = {
  en: { navLabel: 'Site and language', home: 'Home', language: 'English' },
  ar: { navLabel: 'الموقع واللغة', home: 'الصفحة الرئيسية', language: 'العربية' },
}

export interface RouteNavProps {
  readonly id: RouteId
  readonly locale: Locale
  /**
   * The params of the page being rendered, for a route with a dynamic segment.
   *
   * The locale switch is the visible half of the `hreflang` set, so it has to point at the *same document*
   * in the other language: without the params it would point at `/ar/treatments/[slug]`, which is a link
   * every reader on all eight treatment pages would follow to a 404. `fillParams` throws rather than
   * publishing the pattern.
   */
  readonly params?: Readonly<Record<string, string>>
}

export function RouteNav({ id, locale, params = {} }: RouteNavProps) {
  const route = routeById(id)
  const copy = SPINE_COPY[locale]
  const isLocaleRoot = route.path === '/'
  const others = route.locales.filter((served) => served !== locale)

  return (
    <Section as="div">
      <Grid>
        <GridCell span="wide">
          <nav aria-label={copy.navLabel} className="be-actions">
            {isLocaleRoot ? null : (
              <a className="be-action be-action--quiet" href={localisedPath('/', locale)}>
                <Icon name="back" />
                {copy.home}
              </a>
            )}
            {others.map((target) => (
              <a
                key={target}
                className="be-action be-action--quiet"
                href={fillParams(localisedPath(route.path, target), params)}
                // Both attributes, and they are not the same claim: `hreflang` tells a crawler what is at
                // the other end, `lang` tells a screen reader which voice to say this label in. Without
                // the second, "العربية" is announced by an English synthesiser.
                hrefLang={hreflangFor(target)}
                lang={target}
              >
                {SPINE_COPY[target].language}
              </a>
            ))}
          </nav>
        </GridCell>
      </Grid>
    </Section>
  )
}
