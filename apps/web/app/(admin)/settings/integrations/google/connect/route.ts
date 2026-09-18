import { type Kek, parseKek } from '@berelax/clinical'
import { type Config, loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import {
  buildAuthorizationRequest,
  CONSENT_WINDOW_MINUTES,
  completeGoogleConsent,
  parsePendingConsent,
  serialisePendingConsent,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, type GoogleOAuthProvider } from '@berelax/providers/google'
import { AppError, isAppError } from '@berelax/shared'

/**
 * The owner's Google consent, start and callback, on one URL.
 *
 * One endpoint for both halves because Google's redirect URI must be registered exactly, and every
 * additional registered URI is another thing to get wrong in the Cloud console during a handover call.
 * A request with no `code` and no `error` starts the consent; a request with either completes it.
 *
 * There is no UI here on purpose. What a human sees — the *Connect* button, the connection card, the
 * re-auth banner — is G-CONN-07 and G-CONN-08, and the `(admin)` route group this lives in has a
 * deliberately minimal root layout until W-SYS-01 builds the real admin shell.
 *
 * **This route is not authenticated yet.** There is no admin session until W-SYS-01, so it must not be
 * deployed to a reachable environment before then: anyone who could reach it could start a consent.
 * Starting one is harmless (it redirects to Google and sets a cookie); completing one requires an
 * authorization code Google only hands to the account that consented.
 */
export const dynamic = 'force-dynamic'

/**
 * HttpOnly, SameSite=Lax, and short-lived. It holds the `state` and the PKCE verifier.
 *
 * Lax rather than Strict: the request arrives as a top-level cross-site redirect from Google, and
 * Strict would withhold the cookie on exactly that navigation, so every consent would fail with a state
 * mismatch. Lax sends it on a top-level GET, which is what this is.
 */
const CONSENT_COOKIE = 'berelax_google_consent'

/** Where the owner lands afterwards. The card that reads the outcome is G-CONN-07. */
const SETTINGS_PATH = '/settings/integrations/google'

/**
 * The real clock, read here because this is an app.
 *
 * `packages/core` may not read a clock — every calculation there takes the instant as an argument, so
 * that a scheduling bug is reproducible. The edge of the system is where an actual `Date.now()` belongs,
 * and a route handler is the edge.
 */
const systemClock: Clock = { now: () => Date.now() as Instant }

function oauthProviderFor(config: Config): GoogleOAuthProvider {
  if (config.GOOGLE_PROVIDER === 'real') {
    // Deliberately not a silent fallback to the fake: a production deploy that looked connected and
    // talked to nothing is worse than one that refuses to start the flow.
    throw new AppError(
      'provider_unavailable',
      'The real Google OAuth adapter is not implemented. It needs an OAuth client and a published ' +
        'consent screen on the owner Google account (docs/10). Set GOOGLE_PROVIDER=fake to walk the ' +
        'flow against the local consent stand-in.',
    )
  }
  // `@berelax/providers/google` rather than the package barrel: the barrel re-exports the SMS and email
  // ports, which `messaging-providers-only-inside-a-transport` forbids outside a transport. The registry
  // lives behind that barrel, so the fake is constructed here instead.
  return createFakeGoogleOAuth({
    log: createCallLog(() => new Date().toISOString()),
    failures: new FailureScript(),
    now: () => new Date().toISOString(),
  })
}

/**
 * The key the refresh token is sealed with.
 *
 * Read from the environment here, and NOT from `@berelax/config`, for one reason: nothing in this system
 * loads a KEK at runtime yet. Naming the app-wide key — one KEK for clinical payloads and Google tokens,
 * or two — is a decision that belongs with the secret store, not with this unit, and a config key
 * invented here would be the wrong name to migrate away from later. Until then the callback refuses
 * loudly rather than storing a token in the clear or inventing a key per process.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so there is nowhere to seal the refresh token. Nothing was ' +
        'stored. A refresh token is a durable bearer credential for control of the business Google ' +
        'presence and is never written unencrypted (docs/10 §4).',
    )
  }
  return parseKek(material, version)
}

/** The exact URI Google redirects back to: this route, with no query string. */
function redirectUriFor(url: URL): string {
  return `${url.origin}${url.pathname}`
}

function consentCookie(value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${CONSENT_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/settings/integrations/google',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${maxAgeSeconds}`,
  ]
  return attributes.join('; ')
}

function readConsentCookie(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === CONSENT_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}

function problem(error: unknown): Response {
  // The reason code, never the message, reaches the browser as a query parameter: messages are prose
  // that changes, and a `reason` is something the settings card can branch on. Nothing here can carry a
  // token — the grant is out of scope by this point — but the status is chosen so a monitor can tell a
  // refused consent (4xx) from a broken deployment (5xx).
  const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
  const status = isAppError(error) && error.kind === 'provider_unavailable' ? 503 : 400
  return new Response(
    JSON.stringify({
      ok: false,
      reason,
      message: isAppError(error) ? error.message : 'Unexpected',
    }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const isCallback = url.searchParams.has('code') || url.searchParams.has('error')

  try {
    const config = loadConfig()
    return isCallback ? await completeConsent(config, request, url) : startConsent(config, url)
  } catch (error) {
    return problem(error)
  }
}

function startConsent(config: Config, url: URL): Response {
  const { url: authorizationUrl, pending } = buildAuthorizationRequest(
    { oauth: oauthProviderFor(config), clock: systemClock },
    {
      // Present when the owner clicked Reconnect on a specific connection. It is what lets a different
      // Google account coming back be reported against the row they were looking at.
      reconnectingConnectionId: url.searchParams.get('connectionId'),
      redirectUri: redirectUriFor(url),
    },
  )
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl,
      'set-cookie': consentCookie(serialisePendingConsent(pending), CONSENT_WINDOW_MINUTES * 60),
      // A consent URL carries a one-time state; a cached redirect would replay a dead one.
      'cache-control': 'no-store',
    },
  })
}

async function completeConsent(config: Config, request: Request, url: URL): Promise<Response> {
  const pending = parsePendingConsent(readConsentCookie(request))
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const outcome = await completeGoogleConsent(
      { oauth: oauthProviderFor(config), clock: systemClock, kek: googleTokenKek, sql },
      pending,
      {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      },
      { redirectUri: redirectUriFor(url) },
    )
    const destination = new URL(SETTINGS_PATH, url.origin)
    destination.searchParams.set('outcome', outcome.kind)
    destination.searchParams.set('connection', outcome.connectionId)
    if (outcome.warning !== null) destination.searchParams.set('warning', outcome.warning.reason)
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.toString(),
        // The consent is spent. Clearing it is what turns a reloaded callback tab into a recognisable
        // replay rather than a second exchange.
        'set-cookie': consentCookie('', 0),
        'cache-control': 'no-store',
      },
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}
