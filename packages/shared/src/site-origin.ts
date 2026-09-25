/**
 * The origin the site is served from, and the one link built from it outside the site itself.
 *
 * ## Why this moved here (B-UI-05)
 *
 * `apps/web/src/routes/alternates.ts` has owned the fallback, the environment variable and the validation
 * since W-SITE-01, and it still exports all three — it delegates to this file. The move is the same
 * argument `premises-links.ts` next door makes about a map link: two packages need the same answer and
 * neither may import the other.
 *
 * `apps/worker` mints the magic link a reminder carries, and the link needs an absolute origin because it
 * goes in an SMS. `.dependency-cruiser.cjs`'s `nothing-imports-an-app` forbids the worker importing
 * `apps/web`, so the alternatives were a second reader of `SITE_ORIGIN` with its own fallback — two
 * spellings of the live domain, and the one that is wrong is the one in the message a customer taps — or a
 * key in `@berelax/config`, which `alternates.ts` cannot use: it is imported by `registry.test.ts` and by
 * page metadata, and `loadConfig()` throws without a validated `APP_ENV`. So it lives in the leaf.
 *
 * ## Why the reader takes the raw value instead of reading the environment
 *
 * `packages/shared` reads no environment and no clock, and this file does not start it doing so. The
 * caller passes `process.env['SITE_ORIGIN']`; the validation, the fallback and the trimming are here, which
 * is the part that has to be identical in both places. One rule, two call sites, and the call sites are two
 * lines each.
 */

/**
 * The origin the site is served from, when the environment does not say.
 *
 * `berelaxmassage.com` is the live domain (docs/13 §5): it is the one with the ranking category pages and
 * the inbound links, and the relaunch takes it over rather than moving to a new name — moving would throw
 * away the only SEO asset this business already has. It is a fallback rather than a constant because a
 * preview deployment that announced this origin as canonical would ask Google to index production copies of
 * unreviewed pages.
 */
export const SITE_ORIGIN_FALLBACK = 'https://berelaxmassage.com'

/** The environment variable that overrides it. Read at render time, so a build can be promoted. */
export const SITE_ORIGIN_ENV = 'SITE_ORIGIN'

/**
 * The origin, validated.
 *
 * It throws rather than falling back on a malformed value, for the reason `@berelax/config` gives: a
 * canonical URL built from `https:/berelax` is not a smaller problem than no canonical URL, it is the same
 * problem with nothing to alert on. Statically rendered routes read this at build, so a typo fails the
 * build — which is where it should surface. A magic link built from one would reach a customer.
 */
export function siteOriginFrom(configured: string | undefined): string {
  if (configured === undefined || configured.trim() === '') return SITE_ORIGIN_FALLBACK
  const trimmed = configured.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${SITE_ORIGIN_ENV} is not an absolute URL: '${configured}'`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${SITE_ORIGIN_ENV} must be http or https: '${configured}'`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`${SITE_ORIGIN_ENV} must be an origin with no path: '${configured}'`)
  }
  return `${url.protocol}//${url.host}`
}

/**
 * The path the manage-booking page is served at, for one token.
 *
 * Spelled once. `apps/web/src/routes/registry.ts` declares the PATTERN — `/booking/[token]` — and a
 * pattern cannot be fetched; every caller that needs a real URL would otherwise interpolate its own, and
 * the one that gets the prefix wrong sends a customer to a 404 from inside an SMS. The registry's entry and
 * this builder are asserted against each other by `apps/web/src/manage-booking.itest.ts`.
 *
 * No trailing slash and no query: `apps/web/src/routes/canonical.ts` would 301 a trailing slash away, and
 * a redirect in a link a customer taps is a request they pay for twice.
 */
export const MANAGE_BOOKING_PATH_PREFIX = '/booking/'

export function manageBookingPath(token: string): string {
  return `${MANAGE_BOOKING_PATH_PREFIX}${token}`
}

/** The absolute link a reminder carries. The origin is the caller's, validated by {@link siteOriginFrom}. */
export function manageBookingLink(origin: string, token: string): string {
  return `${origin}${manageBookingPath(token)}`
}
