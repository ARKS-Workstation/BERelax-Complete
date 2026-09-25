import {
  type Instant,
  pageReauthBanner,
  parseReturnPath,
  type ReauthBannerView,
} from '@berelax/core'
import { readSetting, type Sql } from '@berelax/db'
import {
  connectionHealthCards,
  createPostgresConnectionStore,
  type GooglePublishingStatus,
  isGooglePublishingStatus,
} from '@berelax/google'
import { RECONNECT_SCREEN_PATH } from '@berelax/shared'
import type { AdminChrome } from './google-reauth-banner.ts'

/**
 * The one read every admin document makes to find out whether it must carry the re-auth banner.
 *
 * One function, ten call sites. The alternative — each route deriving the connection's state from the rows
 * it happens to have — is the defect docs/10 §2 arranges everything else to avoid: the calendar and the
 * settings card would be two answers to *"is the Google connection working"*, and the one a person believes
 * would be whichever page they were on.
 *
 * So this goes through `connectionHealthCards`, which G-CONN-06 wrote and which the daily pass, the health
 * fragment and G-CONN-07's card all read, and then through `pageReauthBanner`, which is the only thing that
 * decides whether a banner shows.
 *
 * ## Two failure modes, deliberately different
 *
 * **An unreadable publishing status is assumed to be `testing`** rather than refused. G-CONN-07's card
 * throws on it, correctly: that page's subject IS the expiry, and a card that silently assumed the fuse was
 * gone would be a card lying about the one thing it is for. Here the stakes are reversed. This is chrome on
 * nine pages about something else, and refusing would turn a bad settings row into a 503 on the calendar.
 * Assuming `testing` is also the safe direction and not merely the convenient one: it can only add
 * `expiring_soon`, which carries no banner, so no assumption made here can HIDE one.
 *
 * **A database failure is not caught.** A route that swallowed it would render an admin page with no banner
 * on a deployment where the connection may well be dead, which is the silent failure this unit exists to
 * remove. Every caller already reads from the same connection to build its own page, so a failure here is a
 * failure there.
 */

const PUBLISHING_STATUS = 'google.consent_screen_publishing_status'
const GBP_ACCESS_GRANTED = 'google.business_profile_access_granted'

/** Testing when the row says something this build does not understand. See the header. */
async function publishingStatusOrTesting(sql: Sql): Promise<GooglePublishingStatus> {
  const value = await readSetting(sql, PUBLISHING_STATUS)
  return isGooglePublishingStatus(value) ? value : 'testing'
}

/**
 * The banner for whatever this business has connected, or null.
 *
 * `now` is a parameter, so an admin document renders reproducibly at a frozen clock — which is what the
 * screenshot comparison and the axe audit depend on, and what lets a test ask what the banner says five
 * days after a consent.
 */
export async function googleReauthBannerFor(args: {
  readonly sql: Sql
  readonly now: Instant
}): Promise<ReauthBannerView | null> {
  const cards = await connectionHealthCards(createPostgresConnectionStore(args.sql), {
    now: args.now,
    publishingStatus: await publishingStatusOrTesting(args.sql),
    gbpAccessGranted: (await readSetting(args.sql, GBP_ACCESS_GRANTED)) === true,
  })
  return pageReauthBanner(
    cards.map((card) => ({
      connectionId: card.connectionId,
      googleEmail: card.googleEmail,
      health: card.health,
    })),
  )
}

/**
 * Everything an admin document needs for its chrome: the banner, and where a reconnect comes back to.
 *
 * `request` rather than a path string, so the return path is the URL the operator is actually on — the
 * diary's state is its query string, and a reconnect that came back to a bare `/calendar` would have
 * thrown their day away. `parseReturnPath` is applied HERE as well as in the consent route, which is not
 * belt and braces: this is where an absolute URL becomes a relative one, and a request whose path somehow
 * fails the rule falls back to the settings screen rather than putting an unvalidated value in a link.
 */
export async function adminChromeFor(args: {
  readonly sql: Sql
  readonly now: Instant
  readonly request: Request
}): Promise<AdminChrome> {
  const url = new URL(args.request.url)
  return {
    googleReauth: await googleReauthBannerFor({ sql: args.sql, now: args.now }),
    returnTo: parseReturnPath(`${url.pathname}${url.search}`) ?? RECONNECT_SCREEN_PATH,
  }
}
