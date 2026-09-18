/**
 * Google ports: OAuth, Business Profile, Search Console.
 *
 * One file because they share an identity. A single owner-consented connection, keyed on the stable
 * `google_sub`, grants access to several APIs — and the failure that matters most is shared too: when
 * the refresh token dies, *everything* Google stops at once. Modelling them separately would hide
 * that. See docs/10.
 */

/** The stable Google account identifier. Never the email address, which a user can change. */
export type GoogleSub = string

export interface GoogleTokens {
  readonly accessToken: string
  readonly expiresAtIso: string
  /** Absent on a refresh: Google returns a new refresh token only on first consent. */
  readonly refreshToken?: string
  readonly scopes: readonly string[]
  readonly sub: GoogleSub
}

export interface GoogleOAuthProvider {
  readonly name: string
  /** The URL a browser is sent to. The real adapter builds it; the fake returns a local stand-in. */
  authorizationUrl(args: { state: string; scopes: readonly string[] }): string
  /** Exchanges the one-time code for tokens. */
  exchangeCode(code: string): Promise<GoogleTokens>
  /**
   * Trades a refresh token for a new access token.
   *
   * This is the call that throws `invalid_grant` — on revocation, on password change, and after
   * seven days for any client still in Testing status. That last one is not an edge case: it is what
   * happens to every connection until the OAuth consent screen is published (docs/10 §4).
   */
  refresh(refreshToken: string): Promise<GoogleTokens>
}

export interface Review {
  readonly reviewId: string
  readonly rating: 1 | 2 | 3 | 4 | 5
  /** Absent for a star-only review, which is most of them and which an autoresponder must handle. */
  readonly comment?: string
  readonly reviewerDisplayName: string
  readonly createdAtIso: string
  readonly reply?: { readonly comment: string; readonly updatedAtIso: string }
}

export interface BusinessProfileProvider {
  readonly name: string
  listReviews(locationId: string): Promise<readonly Review[]>
  /** Replying twice overwrites; there is no separate create and update. */
  updateReply(args: { locationId: string; reviewId: string; comment: string }): Promise<void>
  deleteReply(args: { locationId: string; reviewId: string }): Promise<void>
}

export interface SearchAnalyticsRow {
  readonly query: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  /** Clicks over impressions, as Search Console reports it. */
  readonly ctr: number
  /** Average position, 1-based. */
  readonly position: number
}

export interface SearchConsoleProvider {
  readonly name: string
  /**
   * Search Analytics rows for a date range.
   *
   * The real API withholds rare queries for privacy, so clicks summed over rows is always **less
   * than** the site total. Any report that reconciles the two will disagree with the Search Console
   * UI, and the difference is not a bug — see `totalsFor`.
   */
  queryAnalytics(args: {
    siteUrl: string
    startDate: string
    endDate: string
    rowLimit?: number
  }): Promise<readonly SearchAnalyticsRow[]>
  /** Site-level totals, which include the rare queries the row breakdown omits. */
  totalsFor(args: {
    siteUrl: string
    startDate: string
    endDate: string
  }): Promise<{ clicks: number; impressions: number }>
}
