/**
 * The Google fakes: OAuth, Business Profile, Search Console.
 *
 * Together they make the Google integration buildable and demoable **with no Google account**, which
 * matters more here than for the other providers: Business Profile API access is granted by
 * application review rather than by enabling an API, and the wait is measured in weeks. Building
 * against the real thing is not an option that exists yet.
 *
 * Each fake reproduces the failure that shapes the code around it:
 *
 * - **OAuth** — `invalid_grant`, and the seven-day refresh-token expiry that applies to every
 *   connection while the consent screen is in Testing status. The re-auth banner and the connection
 *   health panel are built against this, not against a hypothetical.
 * - **Business Profile** — `access_not_granted` (the allowlist), `quota_exhausted` (a daily quota at
 *   zero), and review fixtures at every star rating **including star-only with no text**, which is
 *   the majority case and the one an autoresponder handles worst.
 * - **Search Console** — realistic click, impression and position distributions, and the rare-query
 *   gap: summed rows deliberately total less than `totalsFor`, so a report that reconciles them
 *   finds the discrepancy here rather than in a meeting.
 */
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type {
  BusinessProfileProvider,
  GoogleOAuthProvider,
  GoogleTokens,
  Review,
  SearchAnalyticsRow,
  SearchConsoleProvider,
} from './port.ts'

export const GOOGLE_OAUTH = 'google-oauth'
export const GOOGLE_BUSINESS_PROFILE = 'google-business-profile'
export const GOOGLE_SEARCH_CONSOLE = 'google-search-console'

/**
 * Refresh-token lifetime while the OAuth consent screen is in Testing status.
 *
 * Seven days, after which every connection dies with `invalid_grant`. Publishing the consent screen
 * removes it; until then this is the normal case, not the exception (docs/10 §4).
 */
export const TESTING_REFRESH_TOKEN_DAYS = 7

const ACCESS_TOKEN_SECONDS = 3600

export interface FakeGoogleOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
  /** The account the fake consents as. One account, many APIs — see docs/10. */
  readonly sub?: string
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

export function createFakeGoogleOAuth(options: FakeGoogleOptions): GoogleOAuthProvider {
  const { log, failures, now, sub = '104729518362094771533' } = options
  let issuedRefreshTokens = 0

  const issue = (scopes: readonly string[], withRefresh: boolean): GoogleTokens => {
    const base: GoogleTokens = {
      accessToken: `fake-access-${Date.parse(now())}`,
      expiresAtIso: addSeconds(now(), ACCESS_TOKEN_SECONDS),
      scopes,
      sub,
    }
    if (!withRefresh) return base
    issuedRefreshTokens += 1
    return { ...base, refreshToken: `fake-refresh-${issuedRefreshTokens}` }
  }

  return {
    name: GOOGLE_OAUTH,

    authorizationUrl({ state, scopes }) {
      // Local stand-in for accounts.google.com. The consent screen is part of the fake so the whole
      // connect flow is walkable without a Google account.
      const params = new URLSearchParams({
        state,
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
      })
      return `/dev/google/consent?${params.toString()}`
    },

    async exchangeCode(code: string): Promise<GoogleTokens> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: GOOGLE_OAUTH,
          operation: 'exchangeCode',
          outcome: 'failure',
          summary: `Code exchange failed: ${armed}`,
          detail: { failureMode: armed },
        })
        throw failureError(GOOGLE_OAUTH, armed)
      }
      // Only the first consent returns a refresh token; a second one without prompt=consent does not.
      const tokens = issue(
        ['openid', 'email', 'https://www.googleapis.com/auth/business.manage'],
        true,
      )
      log.record({
        provider: GOOGLE_OAUTH,
        operation: 'exchangeCode',
        outcome: 'success',
        summary: `Consent granted for sub ${sub}; refresh token issued`,
        detail: { code, sub, scopes: tokens.scopes, expiresAtIso: tokens.expiresAtIso },
      })
      return tokens
    },

    async refresh(refreshToken: string): Promise<GoogleTokens> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: GOOGLE_OAUTH,
          operation: 'refresh',
          outcome: 'failure',
          summary:
            armed === 'invalid_grant'
              ? 'Refresh rejected: invalid_grant. The connection is dead until someone re-consents'
              : `Refresh failed: ${armed}`,
          detail: { failureMode: armed },
        })
        throw failureError(GOOGLE_OAUTH, armed)
      }
      const tokens = issue(
        ['openid', 'email', 'https://www.googleapis.com/auth/business.manage'],
        false,
      )
      log.record({
        provider: GOOGLE_OAUTH,
        operation: 'refresh',
        outcome: 'success',
        summary: `Access token refreshed for sub ${sub}`,
        detail: { refreshToken, expiresAtIso: tokens.expiresAtIso },
      })
      return tokens
    },
  }
}

/**
 * Review fixtures, one per star rating plus the cases an autoresponder gets wrong.
 *
 * A star-only one-star review has nothing to respond to and is the most common negative review
 * there is. A five-star review in Arabic must be answered in Arabic. A review naming a therapist is
 * the one that must never be auto-sent — it needs a human, and the routing that decides so is tested
 * against this row.
 */
export const REVIEW_FIXTURES: readonly Review[] = [
  {
    reviewId: 'rev-5-en',
    rating: 5,
    comment: 'Best massage in Abu Dhabi. Very professional and the place is spotless.',
    reviewerDisplayName: 'Omar K.',
    createdAtIso: '2026-09-10T18:22:00.000Z',
  },
  {
    reviewId: 'rev-5-ar',
    rating: 5,
    comment: 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.',
    reviewerDisplayName: 'سارة',
    createdAtIso: '2026-09-11T09:05:00.000Z',
  },
  {
    reviewId: 'rev-4-star-only',
    rating: 4,
    reviewerDisplayName: 'A Google user',
    createdAtIso: '2026-09-12T20:41:00.000Z',
  },
  {
    reviewId: 'rev-3-mixed',
    rating: 3,
    comment: 'Massage was good but I waited 25 minutes past my booking time.',
    reviewerDisplayName: 'James P.',
    createdAtIso: '2026-09-13T15:10:00.000Z',
  },
  {
    reviewId: 'rev-2-names-staff',
    rating: 2,
    comment: 'Reception was rude. The therapist Mina was fine but the front desk ruined it.',
    reviewerDisplayName: 'Hala M.',
    createdAtIso: '2026-09-14T12:30:00.000Z',
  },
  {
    reviewId: 'rev-1-star-only',
    rating: 1,
    reviewerDisplayName: 'A Google user',
    createdAtIso: '2026-09-15T23:58:00.000Z',
  },
  {
    reviewId: 'rev-1-allegation',
    rating: 1,
    comment: 'They charged my card twice and refused to refund. Avoid.',
    reviewerDisplayName: 'Daniel R.',
    createdAtIso: '2026-09-16T11:02:00.000Z',
  },
]

export function createFakeBusinessProfile(options: FakeGoogleOptions): BusinessProfileProvider {
  const { log, failures, now } = options
  const reviews = new Map(REVIEW_FIXTURES.map((review) => [review.reviewId, { ...review }]))

  const guard = (operation: string, summary: string): void => {
    const armed = failures.take()
    if (armed === undefined) return
    log.record({
      provider: GOOGLE_BUSINESS_PROFILE,
      operation,
      outcome: 'failure',
      summary: `${summary}: ${armed}`,
      detail: { failureMode: armed },
    })
    throw failureError(GOOGLE_BUSINESS_PROFILE, armed)
  }

  return {
    name: GOOGLE_BUSINESS_PROFILE,

    async listReviews(locationId: string) {
      guard('listReviews', `Listing reviews for ${locationId} failed`)
      const all = [...reviews.values()]
      log.record({
        provider: GOOGLE_BUSINESS_PROFILE,
        operation: 'listReviews',
        outcome: 'success',
        summary: `${all.length} review(s) for ${locationId}, ${all.filter((r) => r.comment === undefined).length} star-only`,
        detail: { locationId, ratings: all.map((r) => r.rating) },
      })
      return all
    },

    async updateReply({ locationId, reviewId, comment }) {
      guard('updateReply', `Replying to ${reviewId} failed`)
      const review = reviews.get(reviewId)
      if (review === undefined) {
        log.record({
          provider: GOOGLE_BUSINESS_PROFILE,
          operation: 'updateReply',
          outcome: 'failure',
          summary: `Reply rejected: no review ${reviewId}`,
          detail: { locationId, reviewId },
        })
        throw failureError(GOOGLE_BUSINESS_PROFILE, 'rejected')
      }
      // The real API has no separate create; a second call overwrites the first.
      reviews.set(reviewId, { ...review, reply: { comment, updatedAtIso: now() } })
      log.record({
        provider: GOOGLE_BUSINESS_PROFILE,
        operation: 'updateReply',
        outcome: 'success',
        summary:
          `Replied to ${review.rating}-star review ${reviewId}` +
          (review.reply === undefined ? '' : ' (overwrote an existing reply)'),
        detail: { locationId, reviewId, characters: comment.length },
      })
    },

    async deleteReply({ locationId, reviewId }) {
      guard('deleteReply', `Deleting the reply to ${reviewId} failed`)
      const review = reviews.get(reviewId)
      if (review !== undefined) {
        const { reply, ...rest } = review
        void reply
        reviews.set(reviewId, rest)
      }
      log.record({
        provider: GOOGLE_BUSINESS_PROFILE,
        operation: 'deleteReply',
        outcome: 'success',
        summary: `Reply to ${reviewId} removed`,
        detail: { locationId, reviewId },
      })
    },
  }
}

/**
 * Search Analytics fixtures.
 *
 * Shaped like a real local-services profile: a handful of brand queries with high CTR and good
 * position, a long tail of `{treatment} in {area}` queries with poor position and low CTR, and one
 * query ranking on page two, which is where the SEO agent's recommendations should concentrate.
 */
const ANALYTICS_FIXTURES: readonly SearchAnalyticsRow[] = [
  {
    query: 'be relax abu dhabi',
    page: '/',
    clicks: 142,
    impressions: 310,
    ctr: 0.458,
    position: 1.2,
  },
  { query: 'be relax massage', page: '/', clicks: 97, impressions: 248, ctr: 0.391, position: 1.4 },
  {
    query: 'massage al zahiyah',
    page: '/',
    clicks: 54,
    impressions: 890,
    ctr: 0.061,
    position: 6.8,
  },
  {
    query: 'arabic massage abu dhabi',
    page: '/treatments/arabic-massage',
    clicks: 31,
    impressions: 1240,
    ctr: 0.025,
    position: 9.4,
  },
  {
    query: 'moroccan bath abu dhabi',
    page: '/treatments/morocco-bath',
    clicks: 18,
    impressions: 1580,
    ctr: 0.011,
    position: 12.7,
  },
  {
    query: 'massage tourist club area',
    page: '/',
    clicks: 12,
    impressions: 460,
    ctr: 0.026,
    position: 8.1,
  },
  {
    query: 'spa near corniche abu dhabi',
    page: '/',
    clicks: 4,
    impressions: 720,
    ctr: 0.006,
    position: 18.3,
  },
]

/**
 * Clicks and impressions the row breakdown does not show.
 *
 * Search Console withholds queries too rare to be anonymous, so the rows never sum to the site
 * total. Roughly a fifth of clicks live here for a profile this size.
 */
const RARE_QUERY_CLICKS = 71
const RARE_QUERY_IMPRESSIONS = 2140

export function createFakeSearchConsole(options: FakeGoogleOptions): SearchConsoleProvider {
  const { log, failures } = options

  const guard = (operation: string, summary: string): void => {
    const armed = failures.take()
    if (armed === undefined) return
    log.record({
      provider: GOOGLE_SEARCH_CONSOLE,
      operation,
      outcome: 'failure',
      summary: `${summary}: ${armed}`,
      detail: { failureMode: armed },
    })
    throw failureError(GOOGLE_SEARCH_CONSOLE, armed)
  }

  return {
    name: GOOGLE_SEARCH_CONSOLE,

    async queryAnalytics({ siteUrl, startDate, endDate, rowLimit }) {
      guard('queryAnalytics', `Search analytics for ${siteUrl} failed`)
      const rows = ANALYTICS_FIXTURES.slice(0, rowLimit ?? ANALYTICS_FIXTURES.length)
      log.record({
        provider: GOOGLE_SEARCH_CONSOLE,
        operation: 'queryAnalytics',
        outcome: 'success',
        summary: `${rows.length} row(s) for ${siteUrl}, ${startDate} to ${endDate}`,
        detail: {
          siteUrl,
          startDate,
          endDate,
          clicksInRows: rows.reduce((total, row) => total + row.clicks, 0),
        },
      })
      return rows
    },

    async totalsFor({ siteUrl, startDate, endDate }) {
      guard('totalsFor', `Totals for ${siteUrl} failed`)
      const totals = {
        clicks:
          ANALYTICS_FIXTURES.reduce((total, row) => total + row.clicks, 0) + RARE_QUERY_CLICKS,
        impressions:
          ANALYTICS_FIXTURES.reduce((total, row) => total + row.impressions, 0) +
          RARE_QUERY_IMPRESSIONS,
      }
      log.record({
        provider: GOOGLE_SEARCH_CONSOLE,
        operation: 'totalsFor',
        outcome: 'success',
        summary: `${totals.clicks} clicks, ${totals.impressions} impressions for ${siteUrl}`,
        detail: { siteUrl, startDate, endDate, rareQueryClicks: RARE_QUERY_CLICKS },
      })
      return totals
    },
  }
}
