import {
  CAMPAIGN_SPEND_CAP_FILS_SETTING_KEY,
  PROVISIONAL_CAMPAIGN_SPEND_CAP_FILS,
} from '@berelax/config'
import { type Instant, segmentCountFreshness } from '@berelax/core'
import { readSetting, type Sql } from '@berelax/db'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import { type CampaignRowView, renderCampaignsHtml } from './render.ts'

/**
 * `GET /crm/campaigns` — the campaigns screen (C-AUTO-10).
 *
 * The handler rather than the route binding, so a test can drive it against a real PostgreSQL with an
 * injected clock. That is not a convenience here: the staleness of a cached count is a comparison between
 * two instants, and an instant cannot be frozen behind a `next start`.
 *
 * ## One query for every campaign and its counts
 *
 * A query per campaign is the obvious implementation and it is wrong for the reason B-UI-03 proved for
 * the calendar's two axes: separate round trips can disagree with each other, so a recipient settled
 * between the second and the fifth is counted twice or not at all and `held + sent == total` stops adding
 * up on the one screen that reports it.
 *
 * ## Read-only, deliberately
 *
 * There is no POST. Launching a campaign is the sender's, and a screen that could launch one would be a
 * second place the cap and the promotional window are decided — which is what migration 0154's
 * reservation and `promotional-window.ts` exist to stop there being.
 */

/** The OPEN-QUESTIONS id the cap and the sender identities are both tracked under. */
export const CAMPAIGNS_OPEN_QUESTION = 'Y6-sender-ids'

export interface CampaignsDeps {
  readonly sql: Sql
  /** Injected, so a suite can freeze it. The staleness verdict is a comparison between two instants. */
  readonly now: () => Instant
}

interface CampaignsRow {
  readonly campaignKey: string
  readonly title: string
  readonly state: string
  readonly haltedReason: string | null
  readonly capFils: number
  readonly spentFils: number
  readonly estimatedRecipients: number | null
  readonly estimatedSegments: number | null
  readonly estimatedFils: number | null
  readonly scheduledAtIso: string | null
  readonly sent: number
  readonly held: number
  readonly total: number
  readonly segmentKey: string
  readonly segmentCount: number | null
  readonly segmentCountAtIso: string | null
}

/** Every campaign, its segment's dated count and its recipient tallies — in one statement. */
export async function readCampaignsScreen(sql: Sql): Promise<readonly CampaignsRow[]> {
  return sql<CampaignsRow[]>`
    select c.campaign_key as "campaignKey", c.title, c.state::text as state,
           c.halted_reason::text as "haltedReason",
           c.cap_fils as "capFils", c.spent_fils as "spentFils",
           c.estimated_recipients as "estimatedRecipients",
           c.estimated_segments as "estimatedSegments",
           c.estimated_fils as "estimatedFils",
           to_char(c.scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "scheduledAtIso",
           coalesce(count(r.id) filter (where r.state = 'sent'), 0)::int as sent,
           coalesce(count(r.id) filter (where r.state = 'held'), 0)::int as held,
           coalesce(count(r.id), 0)::int as total,
           s.segment_key as "segmentKey",
           s.cached_count as "segmentCount",
           to_char(s.cached_count_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "segmentCountAtIso"
      from campaign c
      join customer_segment s on s.id = c.segment_id
      left join campaign_recipient r on r.campaign_id = c.id
     group by c.id, s.id
     order by c.created_at desc, c.campaign_key
  `
}

export async function handleCampaignsRead(
  request: { readonly chrome: AdminChrome },
  deps: CampaignsDeps,
): Promise<Response> {
  const rows = await readCampaignsScreen(deps.sql)
  const at = deps.now()
  // From the F09 registry, which is where the provisional figure can say it is provisional. The fallback
  // is the registry's own default, so a freshly migrated database shows the same number as a seeded one.
  const stored = await readSetting<unknown>(deps.sql, CAMPAIGN_SPEND_CAP_FILS_SETTING_KEY)
  const defaultCapFils =
    typeof stored === 'number' && Number.isInteger(stored)
      ? stored
      : PROVISIONAL_CAMPAIGN_SPEND_CAP_FILS

  const campaigns: readonly CampaignRowView[] = rows.map((row) => {
    // The count and its age from ONE function, so the screen cannot show the first without the second.
    const freshness = segmentCountFreshness({
      cachedCount: row.segmentCount,
      cachedCountAt:
        row.segmentCountAtIso === null ? null : (Date.parse(row.segmentCountAtIso) as Instant),
      at,
    })
    return {
      ...row,
      segmentCountIsStale: freshness.kind === 'never_counted' ? null : freshness.kind === 'stale',
    }
  })

  return new Response(
    renderCampaignsHtml({
      chrome: request.chrome,
      campaigns,
      openQuestionId: CAMPAIGNS_OPEN_QUESTION,
      defaultCapFils,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow, noarchive',
      },
    },
  )
}
