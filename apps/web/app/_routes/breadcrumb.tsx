/**
 * The visible trail, matching the `BreadcrumbList` in the JSON-LD.
 *
 * Both are built from the same labels, because a trail a reader can click and a trail a crawler reads that
 * disagree is worse than either alone: the schema block would claim a hierarchy the page does not have.
 * `breadcrumbTrailFor` in `src/seo/graph-input.ts` builds the machine-readable half from the registry, and
 * every route passes the same labels to both.
 *
 * It lived inside `app/_treatments/pages.tsx` until W-SITE-07, which needed it on five more routes. One
 * component rather than two copies, for the reason above and one more: the acceptance criterion is that every
 * one of these routes *"carr[ies] a BreadcrumbList matching their path segments (enumerated test)"*, and
 * matching a trail against a path is only a property of the site if there is one trail.
 */
import type { Locale } from '../../src/i18n/locales.ts'

/** One step a reader can click: where it goes, and what this locale calls it. */
export interface TrailStep {
  readonly label: string
  readonly href: string
}

export interface BreadcrumbProps {
  readonly locale: Locale
  /** The accessible name of the nav, in this locale. */
  readonly label: string
  /** Every step above the current page, in order, starting at home. */
  readonly trail: readonly TrailStep[]
  /** The current page, which is text rather than a link: it is where the reader already is. */
  readonly currentLabel: string
}

export function Breadcrumb({ locale, label, trail, currentLabel }: BreadcrumbProps) {
  return (
    <nav aria-label={label}>
      <ol className="be-actions">
        {trail.map((step) => (
          <li key={step.href}>
            <a href={step.href} lang={locale}>
              {step.label}
            </a>
          </li>
        ))}
        <li aria-current="page">{currentLabel}</li>
      </ol>
    </nav>
  )
}
