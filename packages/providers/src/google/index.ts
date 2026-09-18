/**
 * The Google ports, reachable without the package barrel.
 *
 * `@berelax/providers` re-exports every port, which puts the SMS and email ports one hop from anything
 * that imports it — and `messaging-providers-only-inside-a-transport` is a `reachable` rule, so that hop
 * counts. `packages/google` needs the OAuth port and nothing to do with sending a message, so it imports
 * this subpath instead. The rule stays strict and this package still compiles.
 */
export {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  FAKE_GRANTED_SCOPES,
  type FakeGoogleOptions,
  GOOGLE_BUSINESS_PROFILE,
  GOOGLE_OAUTH,
  GOOGLE_SEARCH_CONSOLE,
  REVIEW_FIXTURES,
  TESTING_REFRESH_TOKEN_DAYS,
} from './fake-google.ts'
export type {
  AuthorizationUrlArgs,
  BusinessProfileProvider,
  ExchangeCodeOptions,
  GoogleOAuthProvider,
  GoogleSub,
  GoogleTokens,
  Review,
  SearchAnalyticsRow,
  SearchConsoleProvider,
} from './port.ts'
