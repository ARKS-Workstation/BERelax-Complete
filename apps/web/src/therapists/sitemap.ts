/**
 * The sitemap's therapist half: one entry per PUBLISHABLE therapist, per locale, with a `lastmod`.
 *
 * `sitemapEntries()` in the registry covers every route whose path is a literal and skips a parameterised
 * one on purpose. `treatments/sitemap.ts` is the catalogue's expansion of `/treatments/[slug]`; this is the
 * roster's expansion of `/therapists/[slug]`, and it is the third consumer of the one publishing guard.
 *
 * ## Why the guard is here rather than in the read
 *
 * `readTherapistPages` returns everybody — it has to, because the index renders an unlinked card for the
 * unpublishable and the route 301s for the retired. So the filter is this module's, and it is
 * `isTherapistPublishable` rather than a `row.isPublishable` test: the generated column answers two of the
 * three questions (a name, a consent) and knows nothing about retirement or about a portrait with no alt
 * text. A sitemap entry for a retired therapist asks Google to index a 301.
 *
 * ## Why `lastmod` is the row's and not the build's
 *
 * `readTreatmentPages` gives the argument and it is the same one: a `lastmod` that moves on every deploy is
 * one Google stops reading, and a `lastmod` that does not move when the page's content did is worse than
 * none. Here it is `greatest(employee.updated_at, the skill rows, the language rows)`, which are the only
 * rows this page publishes anything from.
 */

import { isTherapistPublishable } from '@berelax/core'
import type { TherapistPageRow } from '@berelax/db'
import { LOCALES, type Locale } from '../i18n/locales.ts'
import { type ChangeFrequency, routeById } from '../routes/registry.ts'
import { therapistPath } from './content.ts'
import { candidateFor } from './read.ts'

/** One sitemap entry for a therapist page. */
export interface TherapistSitemapEntry {
  readonly path: string
  readonly locale: Locale
  readonly changefreq: ChangeFrequency
  /** ISO 8601, from the rows. What `<lastmod>` publishes. */
  readonly lastModified: string
  /** The public slug, so a caller can group the locales of one page. */
  readonly slug: string
}

/**
 * Every publishable therapist, in every locale, with its `lastmod`.
 *
 * Empty today, and the emptiness is the data rather than a stub: no therapist has a display name or a
 * recorded photography consent (Y12-names, Y12-consent-photo). `therapists.itest.ts` asserts the count is
 * zero **with the roster size as its control**, so this cannot quietly stay empty after an admin publishes
 * somebody.
 */
export function therapistSitemapEntries(
  therapists: readonly TherapistPageRow[],
): readonly TherapistSitemapEntry[] {
  const route = routeById('therapist')
  const entries: TherapistSitemapEntry[] = []
  for (const row of therapists) {
    if (!isTherapistPublishable(candidateFor(row))) continue
    // `publicSlug` is non-null whenever the guard passes — 0157's
    // `employee_public_slug_with_display_name` is an equivalence, and the guard requires the name — but
    // the narrowing is written out rather than asserted, because a `as string` here would be the one place
    // a schema change could publish `/therapists/undefined`.
    const slug = row.publicSlug
    if (slug === null) continue
    for (const locale of LOCALES) {
      if (!(route.locales as readonly Locale[]).includes(locale)) continue
      entries.push({
        path: therapistPath(locale, slug),
        locale,
        // Never defaulted: `routeById('therapist')` declares `sitemap: true`, and the registry test asserts
        // changefreq is non-null exactly when it is.
        changefreq: route.changefreq as ChangeFrequency,
        lastModified: row.lastModified,
        slug,
      })
    }
  }
  return entries
}
