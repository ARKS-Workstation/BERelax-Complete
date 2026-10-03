/**
 * The Google ports, reachable without the package barrel.
 *
 * `@berelax/providers` re-exports every port, which puts the SMS and email ports one hop from anything
 * that imports it — and `messaging-providers-only-inside-a-transport` is a `reachable` rule, so that hop
 * counts. `packages/google` needs the OAuth port and nothing to do with sending a message, so it imports
 * this subpath instead. The rule stays strict and this package still compiles.
 */
export {
  AIRPORT_DECOY_LOCATION,
  AL_ZAHIYAH_LOCATION,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  FAKE_GRANTED_SCOPES,
  type FakeGoogleOptions,
  FIXTURE_ANALYTICS_DATE,
  GBP_ACCOUNT_FIXTURES,
  GBP_LOCATION_FIXTURES,
  GBP_LOCATION_GROUP_ACCOUNT,
  GBP_PERSONAL_ACCOUNT,
  GBP_RAMADAN_SPECIAL_HOURS,
  GBP_REGULAR_PERIODS,
  GOOGLE_BUSINESS_PROFILE,
  GOOGLE_OAUTH,
  GOOGLE_SEARCH_CONSOLE,
  RARE_QUERY_CLICKS,
  RARE_QUERY_IMPRESSIONS,
  REVIEW_FIXTURES,
  SEARCH_ANALYTICS_MAX_ROWS,
  SEARCH_CONSOLE_SITE_FIXTURES,
  TESTING_REFRESH_TOKEN_DAYS,
  URL_INSPECTION_CAP_PER_DAY,
} from './fake-google.ts'
export {
  createFakePlaces,
  type FakePlacesOptions,
  GOOGLE_PLACES,
  PLACES_AGGREGATE_FIELD_MASK,
  PLACES_AGGREGATE_FIXTURE,
  PLACES_FIXTURE_PLACE_ID,
  PLACES_REVIEW_FIXTURES,
} from './fake-places.ts'
export type {
  AuthorizationUrlArgs,
  BusinessProfileProvider,
  ExchangeCodeOptions,
  GbpAccount,
  GbpAccountType,
  GbpBusinessPeriod,
  GbpDate,
  GbpDayOfWeek,
  GbpLocation,
  GbpPostalAddress,
  GbpSpecialHourPeriod,
  GbpTimeOfDay,
  GoogleOAuthProvider,
  GoogleRevocation,
  GoogleSub,
  GoogleTokens,
  LocationsGetRequest,
  LocationsListRequest,
  LocationsPatchRequest,
  PlacesDetails,
  PlacesProvider,
  PlacesReview,
  Review,
  SearchAnalyticsDevice,
  SearchAnalyticsDimension,
  SearchAnalyticsRow,
  SearchConsoleProvider,
  SearchConsoleSite,
  SitePermissionLevel,
  UrlInspectionResult,
  VoiceOfMerchantState,
} from './port.ts'
export { GOOGLE_REVOKE_ENDPOINT } from './port.ts'
