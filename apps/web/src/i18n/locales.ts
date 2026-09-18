/**
 * The locale set, and the one place a locale becomes a URL.
 *
 * Two locales, two documents: English is served unprefixed at `/` and Arabic under `/ar`. The prefix
 * is a *subpath* rather than a subdomain or a query parameter because it is the only one of the three
 * that a crawler treats as a separate document without extra configuration, and the only one a
 * customer can share by copying the address bar.
 *
 * ## Why there is no `[locale]` segment
 *
 * The obvious spelling — `app/[locale]/page.tsx` with one layout reading the param — is the one
 * W-SYS-01 rejected, and the reason is in `app/_document/shell.tsx`: `lang` and `dir` belong to
 * `<html>`, every rule in `theme/arabic.css` is inherited from the document element, and a single root
 * layout cannot render two different documents. So there are two root layouts, `(en)` and `(ar)`, and
 * the locale of a request is decided from its path by `localeOf` rather than from a route parameter.
 *
 * That makes this module the seam: the registry, the canonical redirect, the `hreflang` set and the
 * screenshot matrix all ask *this* file what a locale's URL looks like, so the prefix is written down
 * once. An earlier `/ar` existed as a hand-written route with the prefix spelled in the folder name
 * and nowhere else, which is fine until something has to enumerate both locales of one route.
 *
 * `Locale` and `directionFor` are re-exported from `@berelax/ui` rather than redeclared: the direction
 * is already a decision that package owns (`theme/theme.ts`), and a second `'en' | 'ar'` here is the
 * one that would still say `'en' | 'ar'` on the day a third locale is added.
 */
import { type Direction, directionFor, type Locale } from '@berelax/ui'

export type { Direction, Locale }
export { directionFor }

/** Every locale this site serves, in the order the `hreflang` set and the capture matrix enumerate them. */
export const LOCALES = ['en', 'ar'] as const satisfies readonly Locale[]

/**
 * The locale a path with no prefix belongs to, and the target of `hreflang="x-default"`.
 *
 * English rather than Arabic because the existing site ranks in English and the prefixless URLs are the
 * ones with inbound links (docs/13 §4). `x-default` points here too: it is the answer to "a reader
 * whose language we do not serve", not a third document.
 */
export const DEFAULT_LOCALE: Locale = 'en'

/** The `hreflang` value for "no language matched". */
export const HREFLANG_DEFAULT = 'x-default'

/**
 * The URL prefix per locale. The default locale has none.
 *
 * `Record<Locale, string>` rather than a lookup with a fallback, so adding a locale to `Locale` in
 * `@berelax/ui` fails to compile here until its prefix is decided — which is the only moment anybody
 * will think about whether it is `/fr` or `/fr-AE`.
 */
export const LOCALE_PREFIX: Readonly<Record<Locale, string>> = { en: '', ar: '/ar' }

/**
 * The `hreflang` code for a locale.
 *
 * Deliberately the same string as `<html lang>`, which the shell sets from the locale: a page that
 * declares `lang="ar"` and an alternate that declares `hreflang="ar-AE"` are two claims about the same
 * document that a validator will not reconcile for you. `apps/web/src/route-spine.itest.ts` asserts the
 * two are equal on the rendered page rather than trusting this comment.
 */
export function hreflangFor(locale: Locale): string {
  return locale
}

/** The locale-prefixed path for a route path written in the default locale. */
export function localisedPath(path: string, locale: Locale): string {
  const prefix = LOCALE_PREFIX[locale]
  if (prefix === '') return path
  return path === '/' ? prefix : `${prefix}${path}`
}

/**
 * Which locale a pathname belongs to.
 *
 * Exact segment matching, not `startsWith('/ar')`: `/arabic-massage-abu-dhabi` is an English URL that
 * already ranks on the live site (docs/13 §4), and a prefix test that swallowed it would serve it the
 * Arabic document and canonicalise it into the Arabic tree.
 */
export function localeOf(pathname: string): Locale {
  for (const locale of LOCALES) {
    const prefix = LOCALE_PREFIX[locale]
    if (prefix === '') continue
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return locale
  }
  return DEFAULT_LOCALE
}

/** A pathname with its locale prefix removed, so `/ar/kitchen-sink` and `/kitchen-sink` are one route. */
export function neutralPath(pathname: string): string {
  const prefix = LOCALE_PREFIX[localeOf(pathname)]
  if (prefix === '') return pathname
  const rest = pathname.slice(prefix.length)
  return rest === '' ? '/' : rest
}
