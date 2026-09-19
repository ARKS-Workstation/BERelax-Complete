import {
  ASIA_DUBAI,
  CONNECTION_STALE_AFTER_HOURS,
  type ConnectionSnapshot,
  capabilityStatesForDisplay,
  deriveConnectionHealth,
  type GoogleCapability,
  type GoogleCapabilityHealth,
  type GoogleConnectionHealth,
  hoursBetween,
  type Instant,
  type LocalDate,
  TESTING_REFRESH_TOKEN_DAYS,
  testingRefreshTokenExpiry,
  toLocal,
} from '@berelax/core'
import type { GoogleConnectionRecord, GoogleHealthStore } from '../connection-store.ts'
import { declaredCapabilities } from '../consumers.ts'

/**
 * The Testing-expiry tripwire: the date the bomb goes off, on the screen, before it does.
 *
 * ## What is actually being defused
 *
 * An OAuth client left in **Testing** publishing status issues refresh tokens that expire seven days
 * after consent (docs/10 §3, fact 3). Nothing warns, nothing logs, and both agents run on a weekly-ish
 * cadence — so the failure presents as *"it worked when we tested it and stopped the following week"*,
 * repeatedly, with no correlated deploy. Testing is the **default state of every Cloud project**, so
 * this is the normal case until somebody decides otherwise, which is why the publishing status defaults
 * to `testing`: assuming Production would silence the one tripwire that catches the launch blocker.
 *
 * ## Why this is a rendered date and not an alert threshold
 *
 * docs/10 §4 asks for the expiry date **displayed in settings** — *"surfacing the bomb rather than
 * waiting for it"* — and that is a different thing from the predictive email at T-48h that
 * `deriveConnectionHealth` already decides. The date is visible on day one, before any threshold is
 * crossed, which is the only form of warning that is useful while there is still time to publish the
 * consent screen. The email is G-CONN-08's.
 *
 * ## The part that makes it a check rather than a decoration (ADR 0003)
 *
 * A tripwire that can only ever be present is not a tripwire. So the renderer returns an **empty
 * string** for a published consent screen, and the element is absent from the DOM rather than present
 * and empty — `google-health.itest.ts` asserts both branches against a real DOM, and the fake OAuth
 * provider simulates the day-seven `invalid_grant` so the outage this warns about genuinely happens in
 * a test and genuinely happens *after* the warning.
 */

/**
 * The consent screen's publishing status, as Google's own console names it.
 *
 * Two values, not three. Google's console also offers an **Internal** audience inside a Workspace
 * organisation, which docs/10 §3 recommends — but Internal is not a *publishing status*: it is an
 * audience whose effect on this question is the same as Production's, and the whole point of the
 * question is *"does this grant carry a seven-day fuse"*. A third value would need a third answer, and
 * there are only two.
 */
export type GooglePublishingStatus = 'testing' | 'production'

export const GOOGLE_PUBLISHING_STATUSES: readonly GooglePublishingStatus[] = [
  'testing',
  'production',
]

/** The `data-tripwire` value the settings fragment marks the expiry with. */
export const TESTING_EXPIRY_TRIPWIRE = 'google-testing-expiry'

/** True for a value the tripwire understands. For a status that arrived as data from a settings row. */
export function isGooglePublishingStatus(value: unknown): value is GooglePublishingStatus {
  return typeof value === 'string' && GOOGLE_PUBLISHING_STATUSES.includes(value as never)
}

/**
 * Month names, spelled out.
 *
 * A twelve-element constant rather than `Intl.DateTimeFormat(…, { month: 'long' })`, for a reason this
 * repository has already paid for once: `Intl` month names depend on the ICU data the runtime shipped
 * with, so the string an admin sees would differ between a container and a laptop and the test would be
 * asserting against whichever one ran it. The expiry date is a claim about a deadline, and a deadline
 * rendered differently in two places is a deadline two people disagree about.
 *
 * English only, and deliberately: this is the admin settings surface, which has no Arabic document
 * (see the picker route's note on W-SITE-01), and an Arabic month name nobody has reviewed is worse
 * than an English one everybody can read.
 */
const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `2026-09-25` as `25 September 2026`. The order a person in Abu Dhabi reads a date in. */
export function spellDate(date: LocalDate): string {
  const [year = '', month = '01', day = '01'] = date.split('-')
  const name = MONTH_NAMES[Number(month) - 1] ?? month
  return `${Number(day)} ${name} ${year}`
}

export interface TestingExpiryView {
  /** The instant the refresh token dies. */
  readonly expiresAt: Instant
  /** The trading-zone date it falls on. Asia/Dubai, because that is where the owner reads it. */
  readonly expiresOn: LocalDate
  /** `25 September 2026 at 14:00 (Asia/Dubai)` — the string the surface renders. */
  readonly label: string
  /** Negative once it has passed, which is the case the surface must not render as a future date. */
  readonly hoursRemaining: number
  readonly expired: boolean
  /** True inside the 48-hour window docs/10 §4 sends the predictive email in. */
  readonly warningDue: boolean
}

/**
 * The expiry view for a connection, or null when there is no fuse to show.
 *
 * Null for a published consent screen — there is no seven-day expiry, so there is no date, and a
 * surface handed a view it must decide whether to render is a surface that renders it by accident.
 */
export function testingExpiryFor(args: {
  readonly publishingStatus: GooglePublishingStatus
  readonly consentAt: Instant
  readonly now: Instant
}): TestingExpiryView | null {
  if (args.publishingStatus !== 'testing') return null
  const expiresAt = testingRefreshTokenExpiry(args.consentAt)
  const { date, time } = toLocal(expiresAt, ASIA_DUBAI)
  const hoursRemaining = hoursBetween(args.now, expiresAt)
  return {
    expiresAt,
    expiresOn: date,
    label: `${spellDate(date)} at ${time} (${ASIA_DUBAI})`,
    hoursRemaining,
    expired: hoursRemaining < 0,
    // The same threshold `deriveConnectionHealth` uses for `expiringSoon`, read from the constant
    // rather than restated: two copies of 48 would eventually disagree, and the direction they would
    // disagree in is a banner that appears after the email.
    warningDue: hoursRemaining <= CONNECTION_STALE_AFTER_HOURS,
  }
}

/**
 * Escapes text for an HTML attribute or text node.
 *
 * Needed because the Google account's email address and the listing's title are attacker-adjacent
 * values: the title is whatever the account that manages the listing typed into the Business Profile,
 * and this surface renders it. Escaping the five characters rather than stripping them keeps the value
 * readable — an apostrophe in a business name is ordinary — while making it inert.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The tripwire element, or the empty string.
 *
 * The empty string, not an element with `hidden` on it. A hidden element is still in the DOM, still
 * read by a screen reader that ignores the attribute in some configurations, and — the reason that
 * matters here — it makes the acceptance assertion untestable: *"the tripwire element is absent"*
 * cannot be asserted against a surface that always renders it.
 */
export function renderTestingExpiry(view: TestingExpiryView | null): string {
  if (view === null) return ''
  const sentence = view.expired
    ? `This Google connection's access expired on ${view.label}. The OAuth consent screen is still ` +
      'in Testing, which gives every grant a seven-day life, so reconnecting now buys another seven ' +
      'days. Publishing the consent screen is what removes the limit.'
    : `This Google connection stops working on ${view.label} — ${view.hoursRemaining} hour(s) from ` +
      `now. The OAuth consent screen is in Testing, and a Testing client's access lasts ` +
      `${TESTING_REFRESH_TOKEN_DAYS} days from the moment the owner consented. Nothing is wrong yet: ` +
      'publish the consent screen, or reconnect before that date.'
  return (
    `<p data-tripwire="${TESTING_EXPIRY_TRIPWIRE}" data-expires-on="${escapeHtml(view.expiresOn)}"` +
    `${view.warningDue ? ' data-warning-due="true"' : ''}>${escapeHtml(sentence)}</p>`
  )
}

/**
 * One sentence per presentation state, in plain English and never a scope string (docs/10 §4).
 *
 * Deliberately terse, and deliberately here rather than a second copy of G-CONN-07's card: that unit
 * owns the rendered connection card and the full docs/10 §4 string set. What this surface has to be
 * able to say today is which state the connection is in, so the tripwire has somewhere to live and so
 * a reader of this route can tell a pending approval from a dead grant. The states themselves come
 * from `deriveConnectionHealth`, which is the one derivation everything reads.
 */
const STATE_SENTENCE: Readonly<Record<GoogleConnectionHealth['displayState'], string>> = {
  never_connected: 'No Google account is connected.',
  healthy: 'Connected.',
  expiring_soon: 'Connected, and due to expire.',
  degraded: 'Connected, but something it needs is not working.',
  broken: 'Needs re-authorising. Review replies are still being drafted for you to post by hand.',
  pending_gbp_approval:
    'Connected. Business Profile access is still pending Google approval, which is expected and is ' +
    'not something to act on.',
}

/**
 * The snapshot `deriveConnectionHealth` reads, assembled from a stored connection and its capabilities.
 *
 * Here rather than beside the daily check, because the settings surface and the cron **must** derive the
 * connection's state from the same function. Two assemblies of this one argument is how a panel comes to
 * say *Connected* while the email says *Needs re-authorising*, and docs/10 §2's whole reason for one
 * derivation is that they cannot be allowed to disagree.
 *
 * `lastOkAt` is a parameter rather than read off the connection, because the daily check has just
 * established a newer one and has not re-read the row.
 */
export function connectionSnapshot(args: {
  readonly connection: GoogleConnectionRecord
  readonly capabilities: readonly {
    readonly capability: GoogleCapability
    readonly health: GoogleCapabilityHealth
  }[]
  readonly publishingStatus: GooglePublishingStatus
  readonly gbpAccessGranted: boolean
  readonly lastOkAt: Instant | null
}): ConnectionSnapshot {
  return {
    status: args.connection.status,
    consentAt: args.connection.consentAt,
    lastOkAt: args.lastOkAt,
    grantedScopes: args.connection.grantedScopes,
    // Declared capabilities only. A consent registers a row for `gbp_performance`, which no consumer
    // declares and no client can read, so counting its permanent `unknown` would paint every connection
    // in the system amber for ever — see `capabilityStatesForDisplay`.
    capabilities: capabilityStatesForDisplay({
      rows: args.capabilities.map((c) => ({ capability: c.capability, health: c.health })),
      declared: declaredCapabilities(),
    }),
    consentScreenInTesting: args.publishingStatus === 'testing',
    gbpAccessGranted: args.gbpAccessGranted,
  }
}

export interface ConnectionHealthCard {
  readonly connectionId: string
  readonly googleEmail: string
  readonly health: GoogleConnectionHealth
  readonly expiry: TestingExpiryView | null
}

/**
 * The settings surface's data: every connection, its derived state, and its tripwire.
 *
 * Reads through the same narrow `GoogleHealthStore` seam the cron uses, and makes **no Google call** — so
 * the settings page needs no KEK, no token and no network. That matters more than it looks: the tripwire
 * is a function of `consent_at` and a setting, and a surface that had to reach Google to render it would
 * be a surface that shows nothing on exactly the day the grant has died.
 */
export async function connectionHealthCards(
  store: Pick<GoogleHealthStore, 'listAll' | 'capabilitiesFor'>,
  options: {
    readonly now: Instant
    readonly publishingStatus: GooglePublishingStatus
    readonly gbpAccessGranted: boolean
  },
): Promise<readonly ConnectionHealthCard[]> {
  const cards: ConnectionHealthCard[] = []
  for (const connection of await store.listAll()) {
    const capabilities = (await store.capabilitiesFor(connection.id)).filter((row) => row.isPrimary)
    const health = deriveConnectionHealth(
      connectionSnapshot({
        connection,
        capabilities,
        publishingStatus: options.publishingStatus,
        gbpAccessGranted: options.gbpAccessGranted,
        lastOkAt: connection.lastOkAt,
      }),
      options.now,
    )
    cards.push({
      connectionId: connection.id,
      googleEmail: connection.googleEmail,
      health,
      // `disconnected` derives `never_connected` and has no fuse worth showing: the owner revoked it on
      // purpose, and a date telling them when a token they destroyed would have expired is noise.
      expiry:
        connection.status === 'disconnected'
          ? null
          : testingExpiryFor({
              publishingStatus: options.publishingStatus,
              consentAt: connection.consentAt,
              now: options.now,
            }),
    })
  }
  return cards
}

/**
 * The settings fragment: one block per connection, with the tripwire where it applies.
 *
 * A fragment of HTML rather than a React page, because W-SITE-01's registry is in exact bijection with
 * the filesystem and requires every *document* to be served in both locales — a `page.tsx` here would
 * need an Arabic admin document and the admin shell W-SYS-01 builds, exactly as the picker route
 * records next door. A handler that answers HTML is renderable today and is what G-CONN-07's card
 * replaces.
 *
 * No colours, no classes and no inline styles: `pnpm colours` owns the token layer and an admin
 * stylesheet that nothing else uses would be a second design system. Every fact is carried in a
 * `data-` attribute as well as in the sentence, so a test asserts on structure rather than on prose
 * somebody will improve.
 */
export function renderConnectionHealth(cards: readonly ConnectionHealthCard[]): string {
  if (cards.length === 0) {
    return '<section data-google-connections="0"><p>No Google account is connected yet.</p></section>'
  }
  const blocks = cards.map((card) => {
    const recency =
      card.health.hoursSinceLastSuccess === null
        ? // "Connected" with no recency is exactly how silent failure hides (docs/10 §4), so the
          // absence is stated rather than omitted.
          'No successful call has been made yet.'
        : `Last verified ${card.health.hoursSinceLastSuccess} hour(s) ago.`
    return (
      `<section data-google-connection="${escapeHtml(card.connectionId)}" ` +
      `data-connection-state="${escapeHtml(card.health.displayState)}">` +
      `<h3>${escapeHtml(card.googleEmail)}</h3>` +
      `<p data-connection-recency="${card.health.hoursSinceLastSuccess ?? 'never'}">` +
      `${escapeHtml(`${STATE_SENTENCE[card.health.displayState]} ${recency}`)}</p>` +
      `${renderTestingExpiry(card.expiry)}` +
      '</section>'
    )
  })
  return `<section data-google-connections="${cards.length}">${blocks.join('')}</section>`
}
