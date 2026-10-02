import { type Clock, stitchSession } from '@berelax/core'
import {
  issueWhatsappRef,
  newestSessionForUpdate,
  readWhatsappNumber,
  readWhatsappRefTtlDays,
  rollUpDailyRefCapture,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { analyticsStorageGranted, whatsappLinkFor, whatsappRefMessage } from '@berelax/shared'
import { visitorIdFrom } from '../collect/ingest.ts'

/**
 * `GET /api/whatsapp` — mint a reference code for this browser session and send the customer to WhatsApp.
 *
 * This is the half of the ref loop that happens in a browser, and the acceptance line is the shape:
 * *session → whatsapp CTA click → generated code → `wa.me` URL whose text begins `Ref: <code>`*. The desk
 * side is `app/(admin)/quick-book`, which claims the code back.
 *
 * ## Why minting is a server round trip rather than a link on the page
 *
 * A code has to be unguessable, unique and bound to a session, and none of those is available to a static
 * link: a code drawn in the browser could collide with an issued one, could be enumerated, and would not
 * be on disk when the desk typed it in. So the CTA points HERE, this handler writes the row, and the
 * response is a 303 to the composed `wa.me` URL. The cost is one redirect before WhatsApp opens, and the
 * thing bought is that every code the desk can type is a row that exists.
 *
 * A 303 and not a 307: the method must become GET for the hand-off, and 303 is the status that says so.
 * A 302 would be read as 307 by some clients for a POST, which is why the method here is GET in the first
 * place — a `<a href>` is what a customer taps.
 *
 * ## The three refusals, and why each of them declines to mint a code
 *
 * This endpoint can fail to produce a link, and in every case it writes NOTHING. That is deliberate, and
 * it is the reason the capture rate is worth reading at all: `codes_issued` is the denominator, so a code
 * minted into a message that was never sendable would lower the rate for ever and the 0% would read as a
 * front-desk failure rather than as our own missing configuration.
 *
 *   * **`whatsapp_number_unanswered`** — `premises.phone_whatsapp` is not a dialable number. Today it is
 *     the Y1-nap placeholder, which is the state this build is actually in: docs/13 §3 records two
 *     candidate numbers and nothing ranks them. 503, because it is our configuration and not the caller's
 *     request, and a retry after somebody answers Y1-nap will succeed unchanged.
 *   * **`analytics_not_consented`** — the visitor has not granted analytics storage. There is no session
 *     row before consent (ADR 0066) and therefore nothing to bind a code to; a code bound to nothing would
 *     be a denominator with no numerator possible. 409.
 *   * **`no_live_session`** — consent is granted and either the visitor has no session or their newest one
 *     has been idle past `SESSION_INACTIVITY_MS`, so the next collected event will start a different
 *     session from the one this code would name. 409. A-FIRST-06's collector posts the `cta_click` event
 *     to `/api/collect` before following this link, which is what makes the session live; the ordering is
 *     the collector's responsibility and this handler refuses rather than guessing.
 *
 * No refusal is a 400, because none of them is a malformed request.
 *
 * ## What is deliberately NOT written here
 *
 * **No `analytics.event` row.** `whatsapp_ref_shown` is in the taxonomy and A-FIRST-06's collector is what
 * emits it, from the browser, through the one ingest that owns the consent gate. Writing it here as well
 * would be a second statement of the same fact — `whatsapp_ref` already holds the code, the session and
 * the instant — and would mean re-implementing the consent gate, the partition routing and the
 * client-event-id idempotency in a second place. The two that must agree are held equal by
 * `packages/fixtures/src/ref-loop.itest.ts` rather than by both writes being here.
 *
 * **No sender id, no credential and no provider.** The message is composed as a URL and sent by the
 * customer's own WhatsApp client, so there is no outbound call to make and nothing to authenticate. The
 * server-side WhatsApp send stays `unregistered` in `SENDER_IDENTITY_ROUTES` (ADR 0016) and this file does
 * not touch the messaging choke point at all.
 */

/** Why no link could be produced. Named values, never prose: the caller and the tests branch on these. */
export const WHATSAPP_ISSUE_REFUSALS = [
  'whatsapp_number_unanswered',
  'analytics_not_consented',
  'no_live_session',
] as const
export type WhatsappIssueRefusal = (typeof WHATSAPP_ISSUE_REFUSALS)[number]

/**
 * The sentence each refusal answers with.
 *
 * `Record<WhatsappIssueRefusal, string>` and not `Record<string, string>` with a `??` behind it: a fourth
 * refusal with no sentence is a compile error rather than a blank body.
 */
const REFUSAL_SENTENCES: Readonly<Record<WhatsappIssueRefusal, string>> = {
  whatsapp_number_unanswered:
    'No WhatsApp number is configured for the premises, so no conversation can be opened and no ' +
    'reference code has been issued. This is an unanswered question about the business rather than a ' +
    'fault in the request (Y1-nap).',
  analytics_not_consented:
    'A reference code ties a WhatsApp conversation to this browser session, and there is no session ' +
    'before an analytics consent decision. Nothing has been issued and nothing has been stored.',
  no_live_session:
    'This browser has no live measurement session to tie a reference code to. The call-to-action event ' +
    'is collected first; the code is issued against the session that event belongs to.',
}

export const whatsappIssueRefusalSentence = (refusal: WhatsappIssueRefusal): string =>
  REFUSAL_SENTENCES[refusal]

export interface WhatsappIssueDeps {
  readonly sql: Sql
  readonly clock: Clock
}

/** What the handler did, so a test can assert the code without parsing a `Location` header. */
export type WhatsappIssueOutcome =
  | {
      readonly kind: 'issued'
      readonly refCode: string
      readonly sessionId: string
      readonly href: string
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused'; readonly refusal: WhatsappIssueRefusal }

/** The HTTP status each refusal answers with. 503 for ours, 409 for a state the caller can reach. */
const REFUSAL_STATUS: Readonly<Record<WhatsappIssueRefusal, number>> = {
  whatsapp_number_unanswered: 503,
  analytics_not_consented: 409,
  no_live_session: 409,
}

const ACTOR = { kind: 'system', label: 'whatsapp ref issue' } as const

/**
 * Mints a code for this request's session and composes the link, or refuses.
 *
 * Separated from {@link whatsappIssueResponse} so the integration suite can assert the OUTCOME — which
 * code was issued, against which session — rather than parse a redirect. The two are not two paths: the
 * response is built from this answer and nothing else.
 *
 * ## Why the premises row is read BEFORE the session is locked
 *
 * The commonest refusal in this build is the missing number, and it has nothing to do with the visitor. A
 * handler that locked the session first would take a row lock on every CTA click in order to discover a
 * configuration fault, which is a lock held for no reason on the one path a campaign makes busy.
 */
export async function issueWhatsappRefForRequest(
  deps: WhatsappIssueDeps,
  request: Request,
): Promise<WhatsappIssueOutcome> {
  // ONE column of the premises singleton, not `readPremisesFacts`' six statements: this is the path a
  // campaign makes busy, and reading the price list to decide whether a phone number is dialable is work
  // nobody asked for. `whatsappLinkFor` answers a union, so there is no value here that could be rendered
  // as a link by accident — see its own header for why that is stronger than this file having no builder.
  const stored = await readWhatsappNumber(deps.sql)
  const probe = whatsappLinkFor({ phoneWhatsapp: stored?.phoneWhatsapp ?? null })
  if (probe.kind === 'unavailable') {
    return { kind: 'refused', refusal: 'whatsapp_number_unanswered' }
  }

  const cookieHeader = request.headers.get('cookie')
  if (!analyticsStorageGranted(cookieHeader)) {
    return { kind: 'refused', refusal: 'analytics_not_consented' }
  }
  const visitorId = visitorIdFrom(cookieHeader)
  if (visitorId === null) return { kind: 'refused', refusal: 'no_live_session' }

  const at = deps.clock.now()
  const ttlDays = await readWhatsappRefTtlDays(deps.sql)

  return await withUnitOfWork(deps.sql, ACTOR, async (uow) => {
    // The same lock the ingest takes, for the same reason: without it a collect batch arriving between
    // this read and the insert could start a new session, and the code would name a session that had
    // already been superseded by the time the customer sent the message.
    const newest = await newestSessionForUpdate(uow.sql, visitorId)
    if (newest === null) return { kind: 'refused' as const, refusal: 'no_live_session' as const }
    // `stitchSession` is the ONE statement of the thirty-minute window (A-FIRST-05), and it is asked the
    // same question the ingest asks it. A second comparison here would be a second window to drift.
    if (stitchSession({ lastEventAtMs: newest.lastEventAtMs, atMs: at }).kind === 'new') {
      return { kind: 'refused' as const, refusal: 'no_live_session' as const }
    }
    const issued = await issueWhatsappRef(uow, {
      sessionReference: newest.sessionId,
      ttlDays,
    })
    // The denominator, maintained in the same transaction as the row it counts. Recomputed rather than
    // incremented, so this cannot double-count a retry and cannot lose a rolled-back issue — see
    // `rollUpDailyRefCapture`.
    await rollUpDailyRefCapture(uow, { atIso: issued.issuedAtIso })
    const link = whatsappLinkFor({
      phoneWhatsapp: stored?.phoneWhatsapp ?? null,
      text: whatsappRefMessage(issued.refCode),
    })
    if (link.kind === 'unavailable') {
      // Unreachable: the same number was dialable a few statements ago and the row is not re-read. Stated
      // as a refusal rather than a throw because the transaction has already written the code — rolling it
      // back for a value that cannot have changed would be inventing a failure, and the refusal is the one
      // the caller already handles.
      return { kind: 'refused' as const, refusal: 'whatsapp_number_unanswered' as const }
    }
    return {
      kind: 'issued' as const,
      refCode: issued.refCode,
      sessionId: issued.sessionReference,
      href: link.href,
      expiresAtIso: issued.expiresAtIso,
    }
  })
}

/**
 * The outcome as a response: a 303 to WhatsApp, or a named refusal.
 *
 * `text/plain` and not JSON, and not HTML. This endpoint is followed by a browser navigation, so the body
 * is only ever read by a person looking at a failed tap or by a test; JSON would invite a client to
 * consume it as an API, which it is not (it is under `/api` and not `/api/v1` for that reason, exactly as
 * `/api/collect` is). `no-store` on every answer: a cached 303 would send a second customer to the first
 * one's conversation code.
 */
export function whatsappIssueResponse(outcome: WhatsappIssueOutcome): Response {
  if (outcome.kind === 'issued') {
    return new Response(null, {
      status: 303,
      headers: {
        location: outcome.href,
        'cache-control': 'no-store',
        // The code is in the `Location` header of a response that must not be indexed, logged as a page or
        // shared. There is no document here to index, and the header says so for the crawler that follows
        // a redirect anyway.
        'x-robots-tag': 'noindex, nofollow',
      },
    })
  }
  return new Response(whatsappIssueRefusalSentence(outcome.refusal), {
    status: REFUSAL_STATUS[outcome.refusal],
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      // The reason as a header as well as a sentence, so the collector and the integration suite branch on
      // a value rather than on wording. The sentence is for a person; this is for a program.
      'x-berelax-refusal': outcome.refusal,
    },
  })
}

export async function handleWhatsappIssueRequest(
  deps: WhatsappIssueDeps,
  request: Request,
): Promise<Response> {
  return whatsappIssueResponse(await issueWhatsappRefForRequest(deps, request))
}
