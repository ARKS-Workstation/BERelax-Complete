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
import { createHash } from 'node:crypto'
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

/**
 * What the fake consent screen grants when nobody says otherwise.
 *
 * The two product scopes from docs/10 §3, plus the two OIDC scopes every Google consent returns.
 * `openid` is what makes the id_token — and therefore the email — arrive at all.
 */
export const FAKE_GRANTED_SCOPES: readonly string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

/** The account the fake consents as when the caller names no other. A role address, not a person. */
const DEFAULT_FAKE_EMAIL = 'google-admin@berelax.ae'

export interface FakeGoogleOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
  /** The account the fake consents as. One account, many APIs — see docs/10. */
  readonly sub?: string
  /** The address in the fake id_token. Display only; `sub` is the identity. */
  readonly email?: string
  /**
   * What the fake consent screen GRANTS, which the caller sets independently of what it requests.
   *
   * This is the whole point of a fake here: the interesting case is the owner unticking one product,
   * which returns an otherwise successful exchange with a scope missing. A fake that always granted
   * everything requested would leave that path unbuilt until launch day.
   */
  readonly grantedScopes?: readonly string[]
  /**
   * Whether `refresh` returns a **new** refresh token alongside the access token.
   *
   * Default false, because that is Google's ordinary behaviour: a refresh returns the same refresh
   * token and the response omits the field. But it is not a guarantee, and docs/10 §4 is explicit that
   * a rotated token must be persisted — *"silently discarding a rotated token is a time bomb"*: the old
   * one stops working at a moment nothing in the deploy log explains. Until this option existed the
   * rotation branch in `refreshAccessToken` was unreachable from any test, and an unreachable branch is
   * one nobody has seen work.
   */
  readonly rotatesRefreshToken?: boolean
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

const base64url = (input: Buffer): string => input.toString('base64url')

/** S256, as RFC 7636 defines it: base64url of the SHA-256 of the verifier's ASCII bytes. */
function s256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

/**
 * A short, non-reversible label for a secret, so a log line can say *which* token without carrying it.
 *
 * Twelve hex characters of a SHA-256: enough to tell two tokens apart in a support conversation, far too
 * few to brute-force back to a bearer credential.
 */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)
}

/** One authorization the fake consent screen has issued but not yet exchanged. */
interface PendingConsent {
  readonly codeChallenge: string | undefined
  readonly scopes: readonly string[]
}

export function createFakeGoogleOAuth(options: FakeGoogleOptions): GoogleOAuthProvider {
  const {
    log,
    failures,
    now,
    sub = '104729518362094771533',
    email = DEFAULT_FAKE_EMAIL,
    grantedScopes = FAKE_GRANTED_SCOPES,
    rotatesRefreshToken = false,
  } = options
  let issuedRefreshTokens = 0
  let issuedCodes = 0
  /** Codes the fake itself minted, and the PKCE challenge each was issued against. */
  const pending = new Map<string, PendingConsent>()
  /** Codes already exchanged. A Google authorization code is single-use; so is this one. */
  const spent = new Set<string>()

  /**
   * A stand-in id_token: a real JWT's three dot-separated segments, with an unverifiable signature.
   *
   * Not signed, and deliberately so. A consumer that verified this signature would be testing the
   * fake's key handling rather than its own, and the real flow does not verify it either: the token
   * arrives over TLS directly from Google's token endpoint in response to a request carrying the
   * client secret, which is exactly the case Google's own documentation says needs no verification.
   */
  const idTokenFor = (scopes: readonly string[]): string | undefined => {
    if (!scopes.includes('openid')) return undefined
    const issuedAt = Math.floor(Date.parse(now()) / 1000)
    const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8'))
    const payload = base64url(
      Buffer.from(
        JSON.stringify({
          iss: 'https://accounts.google.com',
          aud: 'fake-oauth-client.apps.googleusercontent.com',
          sub,
          email,
          email_verified: true,
          iat: issuedAt,
          exp: issuedAt + ACCESS_TOKEN_SECONDS,
        }),
        'utf8',
      ),
    )
    return `${header}.${payload}.fake-unverifiable-signature`
  }

  const issue = (scopes: readonly string[], withRefresh: boolean): GoogleTokens => {
    const idToken = idTokenFor(scopes)
    const base: GoogleTokens = {
      accessToken: `fake-access-${Date.parse(now())}`,
      expiresAtIso: addSeconds(now(), ACCESS_TOKEN_SECONDS),
      scopes,
      sub,
      ...(idToken === undefined ? {} : { idToken }),
    }
    if (!withRefresh) return base
    issuedRefreshTokens += 1
    return { ...base, refreshToken: `fake-refresh-${issuedRefreshTokens}` }
  }

  return {
    name: GOOGLE_OAUTH,

    authorizationUrl({ state, scopes, codeChallenge, codeChallengeMethod, redirectUri }) {
      // Local stand-in for accounts.google.com. The consent screen is part of the fake so the whole
      // connect flow is walkable without a Google account.
      //
      // `dev_code` is the one parameter a real authorization URL does not carry, and it is here
      // because there is no consent server to mint a code later: binding the code to this
      // authorization at issue time is what lets the fake reject a wrong PKCE verifier and a replayed
      // code the way Google does. A fake that accepted any code would leave both paths unproven.
      issuedCodes += 1
      // The state is in the code because a real authorization code is unique across every consent ever
      // issued, and a bare counter is only unique within one fake instance. Two instances — two
      // accounts in one test, or two requests in one process — would otherwise mint the same code, and
      // the replay check that keys on the code would refuse a legitimate second consent.
      const code = `fake-auth-code-${issuedCodes}-${state}`
      pending.set(code, { codeChallenge, scopes: grantedScopes })
      const params = new URLSearchParams({
        state,
        scope: scopes.join(' '),
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        dev_code: code,
      })
      if (codeChallenge !== undefined) {
        params.set('code_challenge', codeChallenge)
        params.set('code_challenge_method', codeChallengeMethod ?? 'S256')
      }
      if (redirectUri !== undefined) params.set('redirect_uri', redirectUri)
      return `/dev/google/consent?${params.toString()}`
    },

    async exchangeCode(code: string, exchangeOptions): Promise<GoogleTokens> {
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

      // Only codes this fake minted are tracked. A caller that made one up — every conformance
      // exercise does — still gets a successful exchange, because the alternative is a fake that only
      // works for callers who walked the whole browser flow.
      const authorization = pending.get(code)
      const reject = (reason: string): never => {
        log.record({
          provider: GOOGLE_OAUTH,
          operation: 'exchangeCode',
          outcome: 'failure',
          summary: `Code exchange rejected: ${reason}`,
          detail: { failureMode: 'invalid_grant', reason },
        })
        throw failureError(GOOGLE_OAUTH, 'invalid_grant')
      }
      if (spent.has(code)) {
        reject('the authorization code has already been exchanged')
      }
      if (authorization?.codeChallenge !== undefined) {
        const verifier = exchangeOptions?.codeVerifier
        if (verifier === undefined || s256(verifier) !== authorization.codeChallenge) {
          reject('the PKCE verifier does not match the challenge the code was issued against')
        }
      }

      // Only the first consent returns a refresh token; a second one without prompt=consent does not.
      const tokens = issue(authorization?.scopes ?? grantedScopes, true)
      if (authorization !== undefined) {
        pending.delete(code)
        spent.add(code)
      }
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
      // Rotation off by default: Google normally returns the same refresh token and omits the field,
      // and a fake that rotated on every call would make "the stored ciphertext changed" true whatever
      // the code did with the response.
      const tokens = issue(grantedScopes, rotatesRefreshToken)
      log.record({
        provider: GOOGLE_OAUTH,
        operation: 'refresh',
        outcome: 'success',
        summary: `Access token refreshed for sub ${sub}`,
        // A FINGERPRINT, never the token. This log is rendered in the admin call-log pane and in the
        // screenshot harness, and docs/10 §4 is explicit that the refresh token appears in no log line at
        // any level. It recorded the token itself until G-CONN-03's leak detector was pointed at the
        // provider log as well as at the application logger — which is exactly the place a detector
        // looking only at its own logger would never have looked.
        detail: {
          refreshTokenFingerprint: fingerprint(refreshToken),
          expiresAtIso: tokens.expiresAtIso,
        },
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
