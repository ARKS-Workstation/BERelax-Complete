import type { Instant } from '@berelax/core'
import { readSetting, type Sql } from '@berelax/db'
import {
  connectionHealthCards,
  createPostgresConnectionStore,
  type GooglePublishingStatus,
  isGooglePublishingStatus,
  renderConnectionHealth,
} from '@berelax/google'
import { AppError } from '@berelax/shared'

/**
 * The Google connection health fragment: plain-English state, recency, and the Testing-expiry tripwire.
 *
 * ## Why this surface exists now rather than in G-CONN-07
 *
 * docs/10 §4 asks for one specific thing that is not a threshold and not an email: *if the app is in
 * Testing, compute `consent_at + 7 days` and **display that expiry date in settings** — surfacing the
 * bomb rather than waiting for it.* A tripwire that is computed and never rendered is not a tripwire, and
 * the acceptance is asserted against a DOM in both branches: the element is present with a dated string
 * while the consent screen is in Testing, and **absent** once it is published. G-CONN-07 replaces the
 * fragment with the full connection card; the derivation it will read is already the shared one.
 *
 * ## Why a handler and not a page
 *
 * W-SITE-01's registry is in exact bijection with the filesystem and requires every *document* to be
 * served in both locales, so a `page.tsx` here would need an Arabic admin document and the admin shell
 * W-SYS-01 builds — exactly as the consent and picker routes next door record. A handler answering HTML
 * is renderable today, is covered by the `/settings` noindex prefix, and needs no new matrix entry.
 *
 * ## What it deliberately does not do
 *
 * **No Google call, no KEK, no token.** Everything rendered is a function of stored rows and two
 * settings. That is not a convenience: the tripwire has to be readable on exactly the day the grant died,
 * and a surface that had to reach Google to render it would show nothing precisely then. Running the
 * check is the cron's job and *Test connection* is G-CONN-07's; both run `checkConnection`, not a second
 * implementation of it.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, as the two routes beside
 * it record. It is read-only and names the connected Google account, which is a fact the owner already
 * knows — but it must not be deployed to a reachable environment before the shell exists.
 */

export interface HealthFragmentDeps {
  readonly sql: Sql
  /** Injected, so the fragment is reproducible at a frozen clock. */
  readonly now: Instant
}

export interface HealthFragment {
  readonly html: string
  readonly publishingStatus: GooglePublishingStatus
  readonly gbpAccessGranted: boolean
  readonly connections: number
}

/**
 * Reads the publishing status, refusing a value the tripwire cannot interpret.
 *
 * The same refusal the worker makes, and for the same reason: coercing an unknown status would coerce it
 * to *something*, and the only two candidates are the value that shows the expiry and the value that
 * hides it. A surface that silently chose the second would report a connection with a live seven-day fuse
 * as having none.
 */
async function publishingStatus(sql: Sql): Promise<GooglePublishingStatus> {
  const value = await readSetting(sql, 'google.consent_screen_publishing_status')
  if (!isGooglePublishingStatus(value)) {
    throw new AppError(
      'invariant_violated',
      `google.consent_screen_publishing_status holds ${JSON.stringify(value)}, which is not a ` +
        'publishing status this system understands. Nothing was rendered rather than rendering a page ' +
        'that silently claims there is no seven-day expiry.',
      { details: { reason: 'google_publishing_status_unknown' } },
    )
  }
  return value
}

export async function googleHealthFragment(deps: HealthFragmentDeps): Promise<HealthFragment> {
  const status = await publishingStatus(deps.sql)
  const gbpAccessGranted =
    (await readSetting(deps.sql, 'google.business_profile_access_granted')) === true
  const cards = await connectionHealthCards(createPostgresConnectionStore(deps.sql), {
    now: deps.now,
    publishingStatus: status,
    gbpAccessGranted,
  })
  return {
    html: renderConnectionHealth(cards),
    publishingStatus: status,
    gbpAccessGranted,
    connections: cards.length,
  }
}
