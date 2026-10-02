import type { Config } from '@berelax/config'

/**
 * Where the card-entry document comes from, and the content-security policy that lets nothing else in.
 *
 * SAQ-A eligibility rests on one sentence: **the merchant's own page never receives cardholder data.** The
 * card fields are a document served by the gateway, from the gateway's own origin, inside an iframe; the
 * browser's same-origin policy is what makes them unreadable to this application, and the policy below is
 * what stops anything else on the page being in a position to try.
 *
 * ## Nothing here names a gateway, and that is deliberate
 *
 * No provider has been chosen and no merchant account exists (OPEN-QUESTIONS `Y7-gateway`, `Y7-mcc`), so
 * there is no script URL, no frame origin and no vendor name this module could hold. Brief rule 15 refuses
 * an invented one outright — a plausible `https://js.<something>.com` is indistinguishable from a configured
 * one, and the day somebody reads it as configured is the day a checkout points at a domain nobody owns.
 *
 * So the origins are CONFIGURATION with no default, and the unconfigured state is a first-class answer:
 * {@link hostedFieldsFrom} returns `not_configured` naming the missing keys, the checkout renders a refusal
 * instead of a frame, and {@link checkoutContentSecurityPolicy} emits `frame-src 'none'; script-src 'none'`.
 * A checkout that cannot take a card is the strictest safe option and it is visibly unanswered, which is what
 * `Y7-hosted-fields` records.
 *
 * ## Why `script-src` does not include `'self'`
 *
 * This is the one line of the policy that is an argument rather than a default. Under SAQ-A the merchant page
 * must hold no script that could reach the card fields, and the way a hosted-fields integration is actually
 * broken in the wild is a first-party script — an analytics snippet, a form helper, a session recorder — that
 * reads or overlays the frame. `'self'` would permit every one of them and each would look like ordinary
 * front-end work. This build is server-rendered with no client JavaScript on any admin screen (ADR 0013), so
 * the strict form costs nothing today and is the thing that fails the day somebody adds a bundle.
 *
 * `style-src` DOES allow `'unsafe-inline'`, because every admin document in this build emits its stylesheet
 * in a `<style>` element and the token layer is delivered that way. The asymmetry is the point: CSS can
 * exfiltrate the value of a SAME-ORIGIN input through attribute selectors, and there is no same-origin card
 * input on this page for it to read — that absence is what `pnpm saq-a` and the Playwright sweep defend —
 * while `img-src 'self'` leaves it nowhere to send anything anyway. A script needs neither.
 */

/** One HTTP origin: scheme, host, optional port, and nothing else. */
export interface HostedFieldsOrigins {
  /** Where the card-entry document itself is served from. Becomes the iframe's origin and `frame-src`. */
  readonly frame: string
  /** Where the gateway's hosted-fields script is served from. Becomes `script-src`. */
  readonly script: string
}

export type HostedFieldsConfiguration =
  | { readonly kind: 'configured'; readonly origins: HostedFieldsOrigins }
  /** `missing` names the configuration keys, so the refusal on the screen says what to set. */
  | { readonly kind: 'not_configured'; readonly missing: readonly string[] }

export const HOSTED_FIELDS_FRAME_ORIGIN_KEY = 'PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN'
export const HOSTED_FIELDS_SCRIPT_ORIGIN_KEY = 'PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN'

/** The open question this build carries instead of a vendor's domain. */
export const HOSTED_FIELDS_OPEN_QUESTION = 'Y7-hosted-fields'

/**
 * An origin and nothing more: no path, no query, no fragment, no credentials, no wildcard.
 *
 * Checked rather than trusted, because a value with a path in it is the mistake somebody makes once and it
 * fails in the direction that matters: `frame-src https://example.test/fields` is a valid CSP source
 * expression that matches a PREFIX, so `https://example.test/fields-anything` is permitted too — a policy
 * that reads tighter than it is. An origin has no such reading.
 *
 * `http:` is permitted alongside `https:` for exactly one reason, stated so nobody reads it as an oversight:
 * the integration suite stands a loopback origin up in front of the checkout to prove the frame is genuinely
 * cross-origin, and it has no certificate. Production is refused an `http:` origin by
 * {@link hostedFieldsFrom}, which is where the environment is known.
 */
export function isHostedFieldsOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return false
  /*
    A WILDCARD host has to be refused explicitly, and the first version of this function did not.

    `new URL('https://*.example.test')` parses, its `pathname` is `/`, and its `origin` round-trips exactly —
    so every check above passed it and `frame-src https://*.example.test` is a legal CSP source expression
    that matches every subdomain. A setting that widened the policy to a whole DNS tree would have been
    accepted as a bare origin. Found by the test written to assert it was refused, which is why the case is
    there rather than being obvious.

    So the hostname is checked positively: DNS labels, or a bracketed IPv6 literal. Anything a host may not
    contain — `*`, a space, a comma, a quote — is refused whatever `URL` made of it.
  */
  if (!HOST.test(url.hostname)) return false
  // `new URL('https://x')` normalises to `https://x/`, so the only faithful comparison is against `origin`.
  return value === url.origin
}

/** DNS labels separated by dots, or a bracketed IPv6 literal. An IPv4 address is a case of the first. */
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/

/**
 * The hosted-fields origins this deployment is configured with, or the keys it is missing.
 *
 * Both keys are required together and neither defaults to the other. A gateway that serves its script and its
 * frame from one origin will set the same value twice, which is two lines of configuration; deriving one from
 * the other would be a guess about a vendor's topology, and the guess is wrong for every integration that
 * splits them — at which point the CSP silently permits the wrong origin and the frame fails to load with no
 * explanation on the page.
 *
 * A malformed value is treated as MISSING rather than thrown, and the key is named twice over in the
 * `missing` list — once for absent and once for unusable — because the screen has to be able to say which. A
 * throw here would take the whole checkout to a 503 that says nothing about the setting.
 */
export function hostedFieldsFrom(
  config: Pick<
    Config,
    'APP_ENV' | 'PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN' | 'PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN'
  >,
): HostedFieldsConfiguration {
  const frame = config.PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN
  const script = config.PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN
  const missing: string[] = []
  const usable = (value: string | undefined, key: string): string | null => {
    if (value === undefined || value.trim() === '') {
      missing.push(`${key} is not set`)
      return null
    }
    if (!isHostedFieldsOrigin(value)) {
      missing.push(`${key} is not a bare origin (scheme://host[:port], no path)`)
      return null
    }
    if (config.APP_ENV === 'production' && value.startsWith('http://')) {
      // Production only. A loopback origin with no certificate is how the integration suite proves the frame
      // is cross-origin; a plaintext origin in production would carry the card-entry document over the wire.
      missing.push(`${key} must be https in production`)
      return null
    }
    return value
  }
  const frameOrigin = usable(frame, HOSTED_FIELDS_FRAME_ORIGIN_KEY)
  const scriptOrigin = usable(script, HOSTED_FIELDS_SCRIPT_ORIGIN_KEY)
  if (frameOrigin === null || scriptOrigin === null) {
    return { kind: 'not_configured', missing: Object.freeze(missing) }
  }
  return {
    kind: 'configured',
    origins: Object.freeze({ frame: frameOrigin, script: scriptOrigin }),
  }
}

/**
 * The checkout route's `Content-Security-Policy`, in one place.
 *
 * Built here rather than in the route so that it is a pure function of the configuration and can be asserted
 * exactly — `apps/web/src/checkout-csp.test.ts` compares the whole string, and gate block 145 adds an origin
 * to a directive and requires that comparison to fail. A policy assembled inline in a route handler is a
 * policy nothing can state the expected value of, which is how a directive comes to be widened by a line of
 * code that looks like configuration.
 *
 * Every directive is present even when it could be inherited from `default-src`, and that is deliberate:
 * `frame-src` and `script-src` are the two the acceptance line is about, and a reader has to be able to see
 * that `object-src`, `base-uri` and `form-action` were decided rather than defaulted. `form-action 'self'`
 * because the checkout posts to our own token endpoint; `frame-ancestors 'none'` because an admin checkout
 * inside somebody else's page is a clickjacking surface and nothing in this build frames it.
 */
export function checkoutContentSecurityPolicy(hosted: HostedFieldsConfiguration): string {
  const frame = hosted.kind === 'configured' ? hosted.origins.frame : "'none'"
  const script = hosted.kind === 'configured' ? hosted.origins.script : "'none'"
  return [
    "default-src 'none'",
    `frame-src ${frame}`,
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * Every origin the policy permits, for a test that wants to count them rather than read the string.
 *
 * Two when configured and zero when not. The acceptance line is *"allows only the gateway's frame-src and
 * script-src origins"*, and a count is how that is asserted without restating the policy: a third origin
 * anywhere in it changes this list, wherever it was added and whatever directive it was added to.
 */
export function permittedOrigins(policy: string): readonly string[] {
  return [...new Set([...policy.matchAll(/https?:\/\/[^\s;]+/g)].map((match) => match[0]))].sort()
}
