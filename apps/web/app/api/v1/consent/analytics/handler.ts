import type { Clock } from '@berelax/core'
import {
  analyticsConsentStoreRefusalOf,
  recordAnalyticsConsent,
  type Sql,
  withdrawAnalyticsConsent,
} from '@berelax/db'
import {
  ANALYTICS_CONSENT_COOKIE,
  type AnalyticsConsentRefusal,
  analyticsConsentDecisionSchema,
  analyticsConsentShapeRefusal,
  CONSENT_SIGNAL_SEPARATOR,
  type ConsentModeSignal,
} from '@berelax/shared'
import { CONSENT_NO_SIGNALS_TOKEN } from '../../../../(public)/_components/consent-banner.tsx'
import { VISITOR_COOKIE_MAX_AGE_SECONDS, visitorIdFrom } from '../../../collect/ingest.ts'

/**
 * `POST /api/v1/consent/analytics` — the handler, with the wiring next door in `route.ts`.
 *
 * Split the way `/api/collect` splits, and for the same reason: this half can be driven with a frozen
 * clock and a test connection instead of the real environment.
 *
 * ## What this endpoint is, and the one thing it refuses to be
 *
 * It records a decision and sets the cookie that carries it. It does **not** create an identifier. That
 * matters because the obvious implementation does: a grant looks like the moment to mint
 * `analytics.visitor`, and `ingestCollectBatch` is already "the ONE place the server decides who owns an
 * identifier" (A-FIRST-05). Two minting sites would be two answers to who owns an identifier, so the
 * visitor row still arrives at the first `/api/collect` call that carries the consent cookie — which is
 * what ADR 0066's "created AT consent" has meant since A-FIRST-05, and what makes
 * `analytics.consent_record` a record with no subject in it (0125's header).
 *
 * ## Three decisions, three different shapes of work
 *
 *   * **`granted`** — one INSERT, and a `Set-Cookie` carrying the signals granted.
 *   * **`denied`** — one INSERT, and a `Set-Cookie` carrying {@link CONSENT_NO_SIGNALS_TOKEN}, which is
 *     not the name of any signal, so the shared parse grants nothing while the banner can still see that
 *     a decision was made.
 *   * **`withdrawn`** — the INSERT, plus the two UPDATEs that make a withdrawal mean something:
 *     every `queued` dispatch for this visitor's sessions becomes `cancelled_consent_withdrawn`, and
 *     every one of those sessions has its four consent columns cleared, which is what blocks the next
 *     one. The cookie is overwritten with the no-signals token rather than deleted, for the reason a
 *     denial writes one.
 *
 * ## No query parameter decides anything
 *
 * Not the decision, not the visitor, not the locale. The decision is a POST body and the visitor is a
 * cookie, which is the rule across `apps/web` and which a repository-wide scan refuses — and here it has
 * the second reason `/api/collect` gives: a `?visitor=` would put a first-party identifier in every
 * access log and every forwarded link.
 *
 * ## No consent SETTING, no flag, no environment branch
 *
 * There is no `loadConfig()` read on this path and no `process.env`. The gate is code (ADR 0076), and
 * `packages/fixtures/src/consent-gate-arch.test.ts` enumerates every setting key and every environment
 * variable this build has and asserts none of them appears in this estate.
 */

export interface ConsentEndpointDeps {
  readonly sql: Sql
  readonly clock: Clock
}

/** A JSON answer that is never cached: a consent state in a cached response is somebody else's consent. */
function json(body: unknown, status: number, setCookie: string | null): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (setCookie !== null) headers['set-cookie'] = setCookie
  return new Response(`${JSON.stringify(body)}\n`, { status, headers })
}

/**
 * A refusal, by name.
 *
 * The NAME is what the suite asserts on, never the status alone — a 400 is also what a malformed body and
 * an unreadable decision both produce, and a case asserting only the status would pass for any of them.
 */
function refuse(refusal: AnalyticsConsentRefusal, detail: string, status: number): Response {
  return json({ refusal, detail }, status, null)
}

/**
 * The `Set-Cookie` the decision travels back in.
 *
 * `HttpOnly` is deliberately ABSENT and it is the one attribute worth arguing about, which
 * `consent-signal.ts` already argues: the banner and the gate both run in the browser and both have to
 * read this, and nothing is protected by hiding a value that carries no credential and no identifier —
 * only which of four named signals its own owner agreed to.
 *
 * `Max-Age` is `VISITOR_COOKIE_MAX_AGE_SECONDS`, imported rather than chosen. That constant is already
 * DERIVED from `analytics.raw_retention_days()` with a test holding the two equal, and the argument
 * carries over exactly: a consent that outlived every measurement it permitted would be consent for
 * nothing, and being asked again at the point the data is gone is the honest prompt. Inventing a figure
 * here — six months, thirteen months, whatever the last site did — would be inventing a policy nobody has
 * stated (brief rule 15).
 *
 * `Secure` unconditionally and with no parameter to turn it off, for the reason `visitorCookie` and
 * `adminSessionCookie` both record: a `secure: boolean` is a switch somebody eventually defaults the
 * wrong way. Browsers treat `127.0.0.1` as a secure context, so the integration suite needs nothing
 * dropped.
 *
 * `SameSite=Lax` and no `Domain` attribute, which is what host-only means — the same pair, for the same
 * reasons, as the visitor cookie beside it.
 */
export function analyticsConsentCookie(granted: readonly ConsentModeSignal[]): string {
  const value =
    granted.length === 0 ? CONSENT_NO_SIGNALS_TOKEN : [...granted].join(CONSENT_SIGNAL_SEPARATOR)
  return [
    `${ANALYTICS_CONSENT_COOKIE}=${value}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ')
}

export async function handleConsentRequest(
  deps: ConsentEndpointDeps,
  request: Request,
): Promise<Response> {
  const decidedAtIso = new Date(deps.clock.now()).toISOString()

  let parsed: unknown
  try {
    parsed = JSON.parse(await request.text())
  } catch {
    return refuse('invalid_decision', 'A consent decision is a JSON object.', 400)
  }

  const envelope = analyticsConsentDecisionSchema.safeParse(parsed)
  if (!envelope.success) {
    return refuse(
      'invalid_decision',
      envelope.error.issues[0]?.message ?? 'Unreadable consent decision.',
      400,
    )
  }
  const body = envelope.data

  /*
   * The shape rule, before anything is written.
   *
   * A grant of nothing and a refusal that keeps a signal are both refused, and both are also refused by a
   * CHECK on `analytics.consent_record`. That duplication is deliberate and `repositories/consent.ts`
   * states why: the schema gives a caller a readable message at the edge, and the constraint is what holds
   * when the write arrives from a psql session or a call site that forgot this module exists.
   */
  const shape = analyticsConsentShapeRefusal(body)
  if (shape !== null) {
    return refuse(
      shape,
      shape === 'granted_without_a_signal'
        ? 'A grant that grants no signal is a denial; post decision="denied" instead.'
        : `A ${body.decision} decision may not claim a granted signal: keeping one is a new grant of it.`,
      400,
    )
  }

  const granted = body.granted
  try {
    if (body.decision === 'withdrawn') {
      /*
       * The visitor this device presents, matched and never minted.
       *
       * `visitorIdFrom` shape-checks the cookie so a value that is not a uuid never reaches a `::uuid`
       * cast; a forged or long-purged id simply names no sessions, so the withdrawal is recorded and
       * nothing is cancelled. That is not a hole: a dispatch exists only for a session, a session only for
       * a visitor row, so an id naming no row has nothing queued under it.
       */
      await withdrawAnalyticsConsent(deps.sql, {
        visitorId: visitorIdFrom(request.headers.get('cookie')),
        locale: body.locale,
        surface: body.surface,
        decidedAtIso,
      })
    } else {
      await recordAnalyticsConsent(deps.sql, {
        decision: body.decision,
        granted,
        locale: body.locale,
        surface: body.surface,
        decidedAtIso,
      })
    }
  } catch (error) {
    if (analyticsConsentStoreRefusalOf(error) === 'wording_not_published') {
      /*
       * 409 and not 500. The banner is rendering words no published version hashes to, which is a
       * deployment fault rather than this visitor's — and the decision is deliberately NOT recorded and NO
       * cookie is set, so the banner stays up and the gate stays closed. Recording it against some other
       * version would be the only worse answer.
       */
      return refuse(
        'wording_not_published',
        'The consent statement this page rendered has no published wording version, so the decision ' +
          'cannot be recorded against the words that were shown.',
        409,
      )
    }
    throw error
  }

  /*
   * 204 with the cookie, and the same status for all three decisions.
   *
   * A browser cannot act on the difference and telling it which it got would put a consent state in a
   * response an intermediary might cache — `/api/collect`'s own argument, and the `no-store` above is the
   * other half of it.
   */
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'set-cookie': analyticsConsentCookie(body.decision === 'granted' ? granted : []),
    },
  })
}
