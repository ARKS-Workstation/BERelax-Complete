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
  /**
   * What Google **granted**, which is not what was requested.
   *
   * A consent screen where the owner unticks one product returns fewer scopes with an otherwise
   * successful exchange, so this is the only honest source for `granted_scopes` (docs/10 §3).
   */
  readonly scopes: readonly string[]
  readonly sub: GoogleSub
  /**
   * The OIDC id_token, present on a code exchange when `openid` was granted.
   *
   * It is the only place the exchange carries the account's **email**, and it carries `sub` a second
   * time — which is worth cross-checking, because `sub` is the identity every stored token is bound
   * to and a mismatch between the two means the response was assembled from two accounts.
   */
  readonly idToken?: string
}

/** What a caller sends to the authorization endpoint. PKCE is not optional: see `codeChallenge`. */
export interface AuthorizationUrlArgs {
  readonly state: string
  readonly scopes: readonly string[]
  /**
   * The S256 PKCE challenge. Optional on the port only because the *shape* is shared with the
   * refresh path; `packages/google` always sends one, and the fake refuses an exchange whose
   * verifier does not hash to the challenge it issued the code against.
   */
  readonly codeChallenge?: string
  readonly codeChallengeMethod?: 'S256'
  /** Where Google sends the browser back. Derived from the request, never configured per environment. */
  readonly redirectUri?: string
}

export interface ExchangeCodeOptions {
  /** The PKCE verifier whose S256 hash must equal the challenge the code was issued against. */
  readonly codeVerifier?: string
  readonly redirectUri?: string
}

export interface GoogleOAuthProvider {
  readonly name: string
  /** The URL a browser is sent to. The real adapter builds it; the fake returns a local stand-in. */
  authorizationUrl(args: AuthorizationUrlArgs): string
  /** Exchanges the one-time code for tokens. A code may be exchanged exactly once. */
  exchangeCode(code: string, options?: ExchangeCodeOptions): Promise<GoogleTokens>
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

/**
 * What kind of Google account this is, and why the distinction is load-bearing.
 *
 * `LOCATION_GROUP` is the one that matters. An account of that type **holds locations the `PERSONAL`
 * account does not return**, so a client that enumerates only the personal account finds nothing and
 * reports it as *"no locations"* — which is indistinguishable, on a screen, from a business whose
 * listing somebody else owns (docs/10 §7). The picker therefore enumerates under every account.
 *
 * `ORGANIZATION` and `USER_GROUP` are here because they are values the real API returns; nothing
 * branches on them, and a union that omitted them would make an ordinary response unparseable.
 */
export type GbpAccountType = 'PERSONAL' | 'LOCATION_GROUP' | 'ORGANIZATION' | 'USER_GROUP'

export interface GbpAccount {
  /** The resource name, `accounts/{account}`. Persisted with a selection: the v4 reviews path needs it. */
  readonly name: string
  /** What a human sees in the Business Profile UI. Display only. */
  readonly accountName: string
  readonly type: GbpAccountType
}

/**
 * A postal address as Business Information v1 returns it: structured, never one string.
 *
 * `postalCode` is optional and absent in the fixtures, because Abu Dhabi addresses do not carry one
 * and an invented postcode is worse than a blank field (the brief's rule 15).
 */
export interface GbpPostalAddress {
  readonly addressLines: readonly string[]
  readonly locality: string
  readonly administrativeArea: string
  /** CLDR region code, `AE` here. */
  readonly regionCode: string
  readonly postalCode?: string
}

export interface GbpLocation {
  /** `locations/{location}` — v1 returns the location WITHOUT its account (docs/10 §7). */
  readonly name: string
  readonly title: string
  readonly storefrontAddress: GbpPostalAddress
  /**
   * Where the `placeId` actually lives on the real API: under `metadata`, not at the top level.
   *
   * Modelled faithfully because it changes the client: `readMask` is per field, so a mask that omits
   * `metadata` returns locations with no `placeId` at all — and `placeId` is the key the picker dedupes
   * by and the value a Maps deep link is built from. A flattened shape would have hidden that.
   */
  readonly metadata: { readonly placeId: string; readonly mapsUri?: string }
  readonly websiteUri?: string
}

/**
 * `locations.list`, as the adapter constructs it.
 *
 * `readMask` is **mandatory on the real API** and optional here, deliberately: the acceptance criterion
 * is that the adapter refuses a call without one *before it reaches the transport*, and a required field
 * would make that refusal unreachable from a test — the compiler would refuse the fixture instead, which
 * proves nothing about the adapter. The fake refuses it too, the way Google does, so a caller that
 * bypassed the adapter would still not get away with it.
 */
export interface LocationsListRequest {
  /** `accounts/{account}` — every account, including the LOCATION_GROUP ones. */
  readonly parent: string
  readonly readMask?: readonly string[]
  readonly pageSize?: number
}

export interface LocationsGetRequest {
  /** `locations/{location}`. */
  readonly name: string
  readonly readMask?: readonly string[]
}

/**
 * Verifications v1 — what Google will let this listing actually do.
 *
 * *"Voice of Merchant"* is Google's own name for the state, and reading it is the only clean
 * programmatic answer to the question docs/10 §7 says most implementations cannot answer: **why are my
 * writes failing when my token is fine.** A suspended or unverified listing accepts the OAuth grant,
 * accepts the read, and refuses the reply — and every other signal available is a 403 indistinguishable
 * from a quota of zero.
 *
 * Two booleans rather than one, because they fail differently. `hasVoiceOfMerchant` false means the
 * listing is not verified or is suspended, which is something the owner fixes in the Business Profile
 * and no approval from Google will change. `hasBusinessAuthority` false means the *connected account*
 * is not trusted to act for the business, which is fixed by a role change on the listing. Collapsing
 * them would send the owner to verify a listing that is already verified.
 */
export interface VoiceOfMerchantState {
  readonly hasVoiceOfMerchant: boolean
  readonly hasBusinessAuthority: boolean
}

export interface BusinessProfileProvider {
  readonly name: string
  /**
   * Account Management v1 `accounts.list`.
   *
   * Returns an empty list with **HTTP 200** when the account genuinely administers no profiles. That is
   * not a gating error and must not be reported as one (docs/10 §7), which is why it is an empty array
   * here rather than a thrown `access_not_granted`.
   */
  listAccounts(): Promise<readonly GbpAccount[]>
  /** Business Information v1 `locations.list`. Rejects a request with no `readMask`, as Google does. */
  listLocations(request: LocationsListRequest): Promise<readonly GbpLocation[]>
  /** Business Information v1 `locations.get`. Also `readMask`-mandatory. */
  getLocation(request: LocationsGetRequest): Promise<GbpLocation>
  /** Verifications v1 `locations.getVoiceOfMerchantState`. Cheap, and in MVP (docs/10 §7). */
  getVoiceOfMerchantState(locationName: string): Promise<VoiceOfMerchantState>
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

/**
 * What the consenting account may do with a Search Console property.
 *
 * `siteUnverifiedUser` is the value that matters: the property is *listed* for the account and carries no
 * data access at all. A picker that offered it would let the owner select a property that returns nothing,
 * and the SEO agent would then read zero rows and report a site with no traffic — which looks like a
 * finding rather than like a misconfiguration.
 */
export type SitePermissionLevel =
  | 'siteOwner'
  | 'siteFullUser'
  | 'siteRestrictedUser'
  | 'siteUnverifiedUser'

export interface SearchConsoleSite {
  /**
   * A **domain** property (`sc-domain:example.com`) or a **URL-prefix** property
   * (`https://example.com/`). Two different identifiers for what a human calls one website, and the API
   * treats them as separate properties — which is why this is the Search Console resource identifier and
   * cannot be derived from a Business Profile listing.
   */
  readonly siteUrl: string
  readonly permissionLevel: SitePermissionLevel
}

export interface SearchConsoleProvider {
  readonly name: string
  /**
   * `sites.list` — the properties the consenting account can see, with its permission on each.
   *
   * The whole basis of *"GSC is selected independently"*: this list comes from the Search Console account,
   * has no connection to which Business Profile listing was picked, and is often verified on a different
   * Google account entirely (docs/10 §2).
   */
  listSites(): Promise<readonly SearchConsoleSite[]>
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
