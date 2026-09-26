import {
  ASIA_DUBAI,
  degradedCauseFor,
  type GoogleCapability,
  grantedScopeLabels,
  type Instant,
  nextDailyHealthCheck,
  recencyPhrase,
  stateShownFor,
  toLocal,
} from '@berelax/core'
import { readSetting, type Sql } from '@berelax/db'
import {
  connectionHealthCards,
  createPostgresConnectionStore,
  type GooglePublishingStatus,
  isGooglePublishingStatus,
  spellDate,
} from '@berelax/google'
import { AppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import type {
  CapabilityRowView,
  ConfirmedListingView,
  ConnectionCardView,
  IntegrationsView,
  PendingApprovalView,
  RoundTripView,
} from './connection-card.ts'

/**
 * Settings → Integrations: the reading half.
 *
 * Everything the card shows is a function of stored rows and four settings, and **no Google call is made
 * here**. That is not a convenience, it is the requirement: the page has to be readable on exactly the day
 * the grant died, and a surface that reached Google to render itself would show nothing precisely then.
 * Running the check is the cron's job and *Test connection*'s — one directory along, one POST, and the
 * same implementation as the cron.
 *
 * The derivation is `connectionHealthCards`, which G-CONN-06 wrote for the health fragment and the daily
 * pass reads too. Re-deriving the state here from the same rows would be a second answer to the question
 * *"is this connection working"*, and docs/10 §2's whole reason for one derivation is that the panel and
 * the email must not be able to disagree. What this handler adds is the things a card needs and a fragment
 * did not: the capability rows in English, the listing the owner confirmed, the permissions as sentences,
 * the next scheduled run, and the two recorded facts the amber state carries.
 *
 * `now` is a parameter, so the page is reproducible at a frozen clock — which is what the DOM assertions,
 * the axe audit and the byte-identical screenshots all depend on.
 *
 * **This route is not authenticated.** There is no admin session for it to use: `principalForRequest`
 * reads Payload's session, and the CMS user table is not the staff table (see
 * `apps/web/src/collections/cms-users.ts`). It is read-only and GET-only, it names a Google account the
 * owner already knows, and it is covered by the `/settings` noindex prefix — exactly as the consent route,
 * the picker and the health fragment beside it record. The POST next door is a different matter and says
 * so in its own file.
 */

const PUBLISHING_STATUS = 'google.consent_screen_publishing_status'
const GBP_ACCESS_GRANTED = 'google.business_profile_access_granted'
const APPLICATION_SUBMITTED_ON = 'google.business_profile_application_submitted_on'
const QUOTA_PAGE_URL = 'google.cloud_quota_page_url'

export const RECONNECT_PATH = '/settings/integrations/google/connect'
export const TEST_CONNECTION_PATH = '/settings/integrations/test-connection'

export interface IntegrationsDeps {
  readonly sql: Sql
  /** The banner and the return path, built by the route from the request (G-CONN-08). */
  readonly chrome: AdminChrome
  /** Injected, so the page is reproducible. */
  readonly now: Instant
  /** One connection only, for a screenshot that must not diff when another suite adds a row. */
  readonly connectionId?: string
  /**
   * The outcome of whatever brought the operator here, read from the query by the route.
   *
   * Optional, and this is the ONE place an optional is right rather than permissive: the absence of a
   * round trip is the ordinary state of this page — somebody opened it from a link — and the default is
   * therefore “nothing happened” rather than a missing fact.
   */
  readonly roundTrip?: RoundTripView
}

/**
 * Reads the publishing status, refusing a value the tripwire cannot interpret.
 *
 * The same refusal the worker and the health fragment make, and for the same reason: coercing an unknown
 * status would coerce it to *something*, and the only two candidates are the value that shows the expiry
 * and the value that hides it. A page that silently chose the second would report a connection with a live
 * seven-day fuse as having none.
 */
async function publishingStatus(sql: Sql): Promise<GooglePublishingStatus> {
  const value = await readSetting(sql, PUBLISHING_STATUS)
  if (!isGooglePublishingStatus(value)) {
    throw new AppError(
      'invariant_violated',
      `${PUBLISHING_STATUS} holds ${JSON.stringify(value)}, which is not a publishing status this ` +
        'system understands. Nothing was rendered rather than rendering a card that silently claims ' +
        'there is no seven-day expiry.',
      { details: { reason: 'google_publishing_status_unknown' } },
    )
  }
  return value
}

/** A recorded string setting, or null when nobody has recorded one. Empty means unanswered. */
async function recorded(sql: Sql, key: string): Promise<string | null> {
  const value = await readSetting(sql, key)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * What a capability points at, read defensively.
 *
 * `parseGbpResourceRef` would be the strict reading and it throws on a half-written row — which is right
 * for a caller about to make a call and wrong here. This page's whole purpose is to be readable when
 * something is broken, and a malformed `resource_ref` is one of the things it has to be able to say.
 */
function resourceLabel(
  capability: GoogleCapability,
  ref: Readonly<Record<string, unknown>> | null,
): string | null {
  if (ref === null) return null
  const value = capability === 'gsc' ? ref['siteUrl'] : ref['placeId']
  return typeof value === 'string' && value !== '' ? value : null
}

/** `2026-09-25T23:00Z` as `26 September 2026 at 03:00 (Asia/Dubai)`. The zone the owner reads in. */
function spellInstant(instant: Instant): string {
  const { date, time } = toLocal(instant, ASIA_DUBAI)
  return `${spellDate(date)} at ${time} (${ASIA_DUBAI})`
}

export async function integrationsView(deps: IntegrationsDeps): Promise<IntegrationsView> {
  const status = await publishingStatus(deps.sql)
  const gbpAccessGranted = (await readSetting(deps.sql, GBP_ACCESS_GRANTED)) === true
  const submittedOn = await recorded(deps.sql, APPLICATION_SUBMITTED_ON)
  const quotaPageUrl = await recorded(deps.sql, QUOTA_PAGE_URL)
  const store = createPostgresConnectionStore(deps.sql)

  const cards = await connectionHealthCards(store, {
    now: deps.now,
    publishingStatus: status,
    gbpAccessGranted,
  })
  // Narrowed by what the page can SEE rather than by deleting rows a foreign key protects: the
  // integration suite runs sequentially against one database and earlier files leave connections behind
  // (brief rule 12), and `google_reviews.connection_id` is ON DELETE RESTRICT.
  const shown =
    deps.connectionId === undefined
      ? cards
      : cards.filter((card) => card.connectionId === deps.connectionId)

  const nextCheck = spellInstant(nextDailyHealthCheck(deps.now))
  const connections: ConnectionCardView[] = []
  for (const card of shown) {
    const connection = await store.load(card.connectionId)
    const rows = (await store.capabilitiesFor(card.connectionId)).filter((row) => row.isPrimary)
    const listing = await store.confirmedListing({
      connectionId: card.connectionId,
      capability: 'gbp_location',
    })
    const capabilities: readonly CapabilityRowView[] = [...rows]
      .sort((a, b) => a.capability.localeCompare(b.capability))
      .map((row) => ({
        capability: row.capability,
        health: row.health,
        resource: resourceLabel(row.capability, row.resourceRef),
      }))
    const confirmed: ConfirmedListingView | null =
      listing === null
        ? null
        : {
            placeId: listing.placeId,
            title: listing.title,
            address: listing.address,
            confirmedOn: spellDate(toLocal(listing.confirmedAt, ASIA_DUBAI).date),
          }
    const state = stateShownFor(card.health)
    // The paragraph exists only in the state it belongs to. A submission date beside a healthy connection
    // is a fact about a form nobody needs to think about any more.
    const pendingApproval: PendingApprovalView | null =
      state === 'pending_gbp_approval' ? { submittedOn, quotaPageUrl } : null
    connections.push({
      connectionId: card.connectionId,
      googleEmail: card.googleEmail,
      state,
      derivedState: card.health.displayState,
      degradedCause: degradedCauseFor(card.health),
      recency: recencyPhrase(card.health.hoursSinceLastSuccess),
      scopes: grantedScopeLabels(connection?.grantedScopes ?? []),
      capabilities,
      listing: confirmed,
      searchConsoleProperty: capabilities.find((row) => row.capability === 'gsc')?.resource ?? null,
      expiry: card.expiry,
      nextCheck,
      pendingApproval,
    })
  }

  return {
    chrome: deps.chrome,
    roundTrip: deps.roundTrip ?? { tested: null, consent: null, warning: null, connectionId: null },
    connections,
    narrowed: deps.connectionId !== undefined,
    reconnectPath: RECONNECT_PATH,
    testConnectionPath: TEST_CONNECTION_PATH,
  }
}
