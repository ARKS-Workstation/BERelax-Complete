import {
  evaluateAlert,
  type Instant,
  pageReauthBanner,
  parseReturnPath,
  type ReauthBannerView,
} from '@berelax/core'
import { ALERT_OBSERVERS, readAlertThresholdSettings, readSetting, type Sql } from '@berelax/db'
import {
  connectionHealthCards,
  createPostgresConnectionStore,
  type GooglePublishingStatus,
  isGooglePublishingStatus,
} from '@berelax/google'
import { alertDefinition, RECONNECT_SCREEN_PATH } from '@berelax/shared'
import type { AdminChrome } from './google-reauth-banner.ts'
import type { SendBacklogView } from './messages-delayed-banner.ts'

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
 * The send-backlog banner, decided by the alert registry rather than by this file.
 *
 * `evaluateAlert` over the `send_backlog` entry, the same observer the worker's pass uses and the same
 * threshold setting — so the banner is up exactly when the alert is firing. The alternative, a
 * `queued > 20` here, is two statements of one fact: the banner would still be showing after somebody
 * raised the threshold and absent after they lowered it, and nothing would say which of the two screens
 * was right.
 *
 * A `threshold_unreadable` verdict renders NO banner, and that is a deliberate difference from the
 * worker's pass. The worker raises a configuration fault, because answering "is this condition true" is
 * its whole job; a page cannot — this is chrome on ten documents about something else, and a corrupt
 * setting row must not turn the diary into a 503. The fault is still reported, by the pass, which is the
 * thing whose job it is.
 */
export async function sendBacklogBannerFor(args: {
  readonly sql: Sql
  readonly now: Instant
  readonly tradingDate: string
}): Promise<SendBacklogView | null> {
  const entry = alertDefinition('send_backlog')
  const settings = await readAlertThresholdSettings(args.sql)
  const observation = await ALERT_OBSERVERS.send_backlog(args.sql, {
    nowIso: new Date(args.now).toISOString(),
    tradingDate: args.tradingDate,
  })
  const verdict = evaluateAlert(entry, observation, settings)
  if (verdict.kind !== 'firing') return null
  return { queued: verdict.observed, threshold: verdict.threshold }
}

/**
 * Everything an admin document needs for its chrome: the banners, and where a reconnect comes back to.
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
    // The trading date is not needed by this observer and is still supplied rather than faked, because
    // `AlertObservationContext` is one shape for six observers and a call site that invented a value for
    // the field it does not use is the call site that gets copied to one that does. The calendar date of
    // `now` is the honest answer here: the send backlog is a count of rows with no date in it at all.
    sendBacklog: await sendBacklogBannerFor({
      sql: args.sql,
      now: args.now,
      tradingDate: new Date(args.now).toISOString().slice(0, 10),
    }),
    returnTo: parseReturnPath(`${url.pathname}${url.search}`) ?? RECONNECT_SCREEN_PATH,
  }
}
