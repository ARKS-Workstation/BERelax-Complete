/**
 * Which pages the site navigation offers, and the registry's own answer to compare it with.
 *
 * A `.ts` module rather than part of `app/_routes/site-nav.tsx`, and the reason is mechanical:
 * `apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application at
 * all — and both the unit test that asserts this list against the registry and `src/cms/content.ts`, which
 * needs a label per entry, are `.ts`. Anything a unit test or a copy module must reach lives here;
 * `site-nav.tsx` is the component that renders it.
 */
import { isParameterised, ROUTES, type RouteId } from './registry.ts'

/**
 * The public pages, in the order a reader is offered them.
 *
 * Not path order: the nav is read top to bottom by a person, and the commercial pages come first because
 * they are what the site is for. `registry.test.ts` asserts this is the same *set* the registry declares, so
 * a route added by another unit fails a test naming it rather than appearing with no label — or, worse, not
 * appearing at all and becoming the orphan the link-graph invariant then reports.
 */
export const NAV_ROUTE_IDS = [
  'home',
  'treatments',
  'pricing',
  // B-UI-01. Second only to the menu on purpose: the site exists to take a booking, and docs/09 §3
  // lists the nav among the flow's entry points beside the hero CTA and the sticky book bar.
  'book',
  'spa',
  'faq',
  'journal',
  'about',
  'contact',
] as const satisfies readonly RouteId[]

export type NavRouteId = (typeof NAV_ROUTE_IDS)[number]

/**
 * Every indexable document a navigation can link to, from the registry.
 *
 * A parameterised route is excluded because it is a pattern: `/treatments/[slug]` is not a URL, and a nav
 * entry for it would publish the pattern — the failure `fillParams` exists to refuse. Its pages are reached
 * from the index, which is one click further and is what a hub is.
 */
export function navigableRouteIds(): readonly RouteId[] {
  return ROUTES.filter(
    (route) => route.kind === 'document' && route.indexable && !isParameterised(route.path),
  ).map((route) => route.id)
}
