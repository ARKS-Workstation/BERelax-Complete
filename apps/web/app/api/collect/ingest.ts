import type { Clock } from '@berelax/core'
import { classifyBot, decideCollectRate, resolveOrigination, stitchSession } from '@berelax/core'
import {
  type CollectIngestInput,
  countPreConsentLanding,
  fileUnderTradingDate,
  ingestCollectBatch,
  type Sql,
} from '@berelax/db'
import {
  type AnalyticsEvent,
  analyticsStorageGranted,
  breakpointFor,
  COLLECT_MAX_BATCH_EVENTS,
  COLLECT_MAX_BODY_BYTES,
  type CollectRefusal,
  collectBatchSchema,
  deviceKindFor,
  grantedConsentSignals,
  parseAnalyticsEvent,
  SESSION_INACTIVITY_MS,
  UnknownEventError,
} from '@berelax/shared'

/**
 * `POST /api/collect` — the ingest, with the wiring next door in `route.ts`.
 *
 * Split the way `app/api/v1/payments/intent` splits, so this half can be driven with a frozen clock and a
 * test connection instead of the real environment, and so the rate-limiter's state is a value somebody
 * passes in rather than a module-level global a test cannot reset.
 *
 * ## The one decision this file is about
 *
 * Whether a request may create an identifier. `analyticsStorageGranted` answers it from the consent cookie
 * and everything else follows:
 *
 *   * **Granted** — the visitor, the session, its origination and its events are written in one
 *     transaction, and the response carries a `Set-Cookie` when the visitor row was created.
 *   * **Not granted, in any of its forms** — no cookie, an unreadable cookie, a cookie that grants the
 *     other three Consent Mode signals and not this one — the landing is reduced to `+1` against an
 *     identifier-free counter and NOTHING else is written. No `Set-Cookie`, no visitor, no session, no
 *     event row. ADR 0066 is why that projection is irreversible, and migration 0116's header is the
 *     argument that a holding pen is not available: a staged event you could promote later needs a key,
 *     and a key before consent is the identifier the position withholds.
 *
 * Both answers are 204. That is deliberate: a browser cannot act on the difference and telling it which it
 * got would put a consent state in a response an intermediary caches. What a DEBUGGER gets is the refusal
 * name on the 4xx paths, which is the only place a name changes anybody's behaviour.
 *
 * ## The classifier's verdict changes nothing here
 *
 * `classifyBot` is called and its answer is stored on the session row (A-FIRST-04 deferred exactly that to
 * this unit). It is not read again. ADR 0062 states the rule and this file is the first place it could have
 * been broken: a suspected bot's events are STORED and FLAGGED, never dropped, because the verdict rests on
 * a header the caller controls and an access-control decision may not. There is no `if (bot)` below.
 *
 * ## Nothing is read from the query string
 *
 * Not a visitor, not a session, not a consent state. The batch is a POST body and the identity is a cookie,
 * which is the rule across `apps/web` — and here it has a second reason: a `?visitor=` would put a
 * first-party identifier in every access log, every `Referer` and every forwarded link.
 */

/** The cookie the first-party visitor id travels in. */
export const VISITOR_COOKIE = 'berelax_visitor'

/**
 * How long the visitor cookie lives, in seconds — DERIVED from the raw retention window, not chosen.
 *
 * 90 days, because that is what `analytics.raw_retention_days()` returns and what
 * `analytics.run_retention` purges a visitor row on. A cookie that outlived its own row would present an
 * id naming nothing, so every returning visitor past the window would arrive as a new one anyway and the
 * only difference would be a stale identifier sitting in a browser for no reader. A cookie SHORTER than
 * the window would throw away returning-visitor data the database still holds.
 *
 * It is a second statement of the database's own figure, so it arrives with the check that holds the two
 * equal: `collect.itest.ts` reads `analytics.raw_retention_days()` and asserts this constant is that many
 * days. (ADR 0045 owns the window itself.)
 */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

/**
 * The `Set-Cookie` for a newly created visitor.
 *
 * `HttpOnly`, which the acceptance line does not ask for and which is right anyway: the collector never
 * reads this value — the server sets it and the server reads it — so hiding it from the page costs nothing
 * and removes a first-party identifier from everything a cross-site scripting hole can reach.
 *
 * `Secure` unconditionally and with NO parameter to turn it off, for the reason `adminSessionCookie`
 * records at length: a `secure: boolean` is a switch somebody eventually defaults the wrong way. The
 * integration suite presents the cookie through an explicit `fetch` header rather than a browser jar, so
 * nothing needs the attribute dropped for `http://127.0.0.1`.
 *
 * `SameSite=Lax` and not `Strict`, so a visitor arriving from a Google result or a Meta ad — a cross-site
 * top-level GET, which is every paid click this business pays for — still presents the cookie. `Strict`
 * would make every ad click a new visitor and the origination resolver would re-attribute a returning
 * visitor on every campaign.
 *
 * And **no `Domain` attribute at all**, which is what host-only means. A leading-dot domain would send this
 * identifier to every subdomain, including any future one this repository does not control; the acceptance
 * line asks for its absence, and the absence is the whole of it — there is no attribute to spell correctly,
 * only one not to write.
 */
export function visitorCookie(visitorId: string): string {
  return [
    `${VISITOR_COOKIE}=${visitorId}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ')
}

/**
 * A `uuid` version of the visitor cookie's value, or null.
 *
 * Read and shape-checked here so a value that is not a uuid never reaches a `::uuid` cast — the difference
 * between a 400 and a named refusal this route does not have, and the reason is that a malformed cookie is
 * not the caller's fault to report: it is treated as no cookie, so the visitor gets a fresh id. Compared by
 * EQUALITY on the name and not by prefix, for `adminSessionTokenFrom`'s reason: `berelax_visitor_theme`
 * must not be read as this cookie.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function visitorIdFrom(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    if (pair.slice(0, index).trim() !== VISITOR_COOKIE) continue
    const value = pair.slice(index + 1).trim()
    return UUID.test(value) ? value : null
  }
  return null
}

/**
 * The rate limiter's state: recent request instants per key.
 *
 * ## What the key is, and the one case where it cannot be a person
 *
 * A visitor's cookie value where there is one. Where there is not — every pre-consent request, and the
 * first request of a consented visitor — there is no identifier, so there is nothing to key on and every
 * such request shares {@link ANONYMOUS_BUCKET}. That is not a shortcut, it is the position's consequence
 * stated out loud: you cannot rate-limit per person without an identifier per person, and an identifier
 * before consent is the thing this unit refuses to create. An IP address would be one — and an IP is
 * personal data under the PDPL (docs/04 §8), so keeping one per request in order to protect a store that
 * holds no identifiers would be the wrong trade in the wrong direction.
 *
 * ## Why the state is passed in
 *
 * A module-level map cannot be reset between tests and is shared by every request in the process. Holding
 * it on the runtime object makes it the route's, so `route.ts` has exactly one and a test has its own.
 */
export const ANONYMOUS_BUCKET = '\u0000anonymous'

/** How many keys the limiter will track before it prunes. Bounded, because the keys come from strangers. */
export const RATE_LIMIT_MAX_KEYS = 20_000

export interface CollectEndpointDeps {
  readonly sql: Sql
  readonly clock: Clock
  /** Recent request instants per key, mutated in place by {@link handleCollectRequest}. */
  readonly rateLimitHits: Map<string, readonly number[]>
  /** Every host that IS this site, so an internal navigation is not read as a referral (A-FIRST-03). */
  readonly ownHosts: readonly string[]
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/**
 * A refusal, by name, with the detail a tag author needs.
 *
 * The NAME is what the suite asserts on, never the status alone. A 400 is also what a malformed body, an
 * oversized batch and a typo'd event name all produce, and a case asserting only the status would pass for
 * any of the three — which is the failure mode the brief names: a check must measure what its name claims.
 */
function refuse(
  refusal: CollectRefusal,
  detail: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({ refusal, detail }, status, headers)
}

/** A 204 with no body, and never a cached one. */
function accepted(setCookie: string | null): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (setCookie !== null) headers['set-cookie'] = setCookie
  return new Response(null, { status: 204, headers })
}

/** Drop keys whose every hit has aged out, so a flood of one-shot keys cannot grow the map for ever. */
function pruneRateLimitHits(hits: Map<string, readonly number[]>, nowMs: number): void {
  if (hits.size <= RATE_LIMIT_MAX_KEYS) return
  for (const [key, instants] of hits) {
    if (instants.every((instant) => nowMs - instant >= 1_000)) hits.delete(key)
  }
}

/** One validated event, ready for the writer. */
interface ValidatedEvent {
  readonly event: AnalyticsEvent
  readonly occurredAtIso: string
  readonly clientEventId: string
  readonly path: string
}

export async function handleCollectRequest(
  deps: CollectEndpointDeps,
  request: Request,
): Promise<Response> {
  const nowMs = deps.clock.now()
  const receivedAtIso = new Date(nowMs).toISOString()
  const cookieHeader = request.headers.get('cookie')
  const presentedVisitorId = visitorIdFrom(cookieHeader)

  /*
   * The byte cap, enforced on the bytes and BEFORE the parse.
   *
   * `Content-Length` is a claim and is checked first only because it is free; the real gate is the length
   * of what actually arrived, because a chunked body carries no length header at all. Refusing after
   * `JSON.parse` would mean an anonymous internet caller decides how much the server allocates, which is
   * the thing a body cap exists to stop.
   */
  const declaredLength = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > COLLECT_MAX_BODY_BYTES) {
    return refuse(
      'body_too_large',
      `A collect batch may be at most ${COLLECT_MAX_BODY_BYTES} bytes; this one declared ${declaredLength}.`,
      400,
    )
  }
  const raw = await request.text()
  // Bytes, not characters. A body of 40,000 astral-plane characters is 160,000 bytes and would pass a
  // `.length` check — which is how a cap in characters becomes four times the cap somebody wrote down.
  const byteLength = new TextEncoder().encode(raw).length
  if (byteLength > COLLECT_MAX_BODY_BYTES) {
    return refuse(
      'body_too_large',
      `A collect batch may be at most ${COLLECT_MAX_BODY_BYTES} bytes; this one was ${byteLength}.`,
      400,
    )
  }

  /*
   * The rate limit, before any validation and before any read.
   *
   * Early because a refused request should cost as little as possible, and that is the whole point of a
   * limiter: one that validated first would let a flood pay for a Zod parse per request. The refusal
   * writes nothing — there is no statement between here and the 429.
   */
  const bucket = presentedVisitorId ?? ANONYMOUS_BUCKET
  const rate = decideCollectRate({ hitsMs: deps.rateLimitHits.get(bucket) ?? [], atMs: nowMs })
  deps.rateLimitHits.set(bucket, rate.hitsMs)
  pruneRateLimitHits(deps.rateLimitHits, nowMs)
  if (!rate.allowed) {
    return refuse('rate_limited', 'Too many collect requests from this visitor.', 429, {
      'retry-after': String(rate.retryAfterSeconds),
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return refuse('malformed_json', 'A collect batch is a JSON object.', 400)
  }

  /*
   * The batch size, named before the envelope is validated.
   *
   * `collectBatchSchema` would refuse an over-long array too, as `invalid_envelope`, and that answer is
   * true and useless: a collector whose queue is not being split needs to be told which cap it hit. So the
   * length is read off the parsed object first, and the schema is what catches everything else — including
   * an unknown extra property, which is `strictObject`'s doing and is the acceptance line's third cap.
   */
  const eventCount = Array.isArray((parsed as { events?: unknown })?.events)
    ? ((parsed as { events: unknown[] }).events.length as number)
    : null
  if (eventCount !== null && eventCount > COLLECT_MAX_BATCH_EVENTS) {
    return refuse(
      'batch_too_large',
      `A collect batch may carry at most ${COLLECT_MAX_BATCH_EVENTS} events; this one carried ${eventCount}. ` +
        'Split the queue rather than growing the batch.',
      400,
    )
  }

  const envelope = collectBatchSchema.safeParse(parsed)
  if (!envelope.success) {
    return refuse('invalid_envelope', envelope.error.issues[0]?.message ?? 'Unreadable batch.', 400)
  }
  const batch = envelope.data

  /*
   * Every event validated before ANY row is written, which is the acceptance line's first claim.
   *
   * The whole batch is validated up front rather than event by event inside the transaction, and the
   * difference matters even though both roll back: a loop that validated as it inserted would report the
   * first four events as written in its own logs and would make the failure depend on the order the
   * browser happened to queue them in. Here a batch is either entirely valid or entirely refused, and
   * nothing has opened a transaction yet when it is refused.
   */
  const validated: ValidatedEvent[] = []
  for (const item of batch.events) {
    try {
      const event = parseAnalyticsEvent(item.name, item.payload)
      const payloadPath = (item.payload as { path?: unknown })?.path
      validated.push({
        event,
        occurredAtIso: item.occurredAt,
        clientEventId: item.clientEventId,
        // `whatsapp_ref_shown` carries no path of its own — it is a fact about the message, not the page —
        // so it is filed under the path the batch landed on. The column is NOT NULL and `like '/%'`.
        path: typeof payloadPath === 'string' ? payloadPath : landingPathOf(batch),
      })
    } catch (error) {
      if (error instanceof UnknownEventError) {
        return refuse('unknown_event', error.message, 400)
      }
      return refuse(
        'invalid_event_payload',
        `Event "${item.name}" failed its own schema: ${error instanceof Error ? error.message : 'unknown'}`,
        400,
      )
    }
  }

  const landingPath = landingPathOf(batch)

  /* ------------------------------------------------------------------------------------------------
   * Pre-consent: one counter, and nothing else at all
   * ------------------------------------------------------------------------------------------------ */
  if (!analyticsStorageGranted(cookieHeader)) {
    /*
     * The bucket's date comes from the same resolution a session would get, so a pre-consent landing and a
     * consented one on the same evening land on the same business day — which is what makes the consented
     * SHARE a figure A-FIRST-10 can compute at all. `fileUnderTradingDate` is a read; nothing else here
     * touches the database except the counter's own upsert.
     */
    const filing = await fileUnderTradingDate(deps.sql, receivedAtIso)
    for (const item of validated) {
      /*
       * Only an ENTRY page view counts, and pre-consent that is the CLIENT's claim about its own first
       * page view rather than something the server checked. It has to be: a session row is what "first
       * page view of a session" is measured against, and there is no session — creating one is the thing
       * consent gates. The limitation is real and is the price of the position, and it is bounded: no
       * cookie is ever set on this path, so a returning visitor's second visit reports an entry again,
       * which makes this a count of ARRIVALS and not of people. That is exactly what a funnel's first
       * bucket is.
       */
      if (item.event.name !== 'page_view' || !item.event.payload.entry) continue
      await countPreConsentLanding(deps.sql, {
        bucketDate: filing.tradingDate,
        basis: filing.basis,
        path: item.path,
      })
    }
    // No `Set-Cookie`. The absence is the acceptance line, and it is expressed as passing `null` to the
    // one function that can produce one rather than as a branch that forgets to call it.
    return accepted(null)
  }

  /* ------------------------------------------------------------------------------------------------
   * Consented: the identified write
   * ------------------------------------------------------------------------------------------------ */
  const resolution = resolveOrigination({
    query: batch.query,
    referrer: batch.referrer,
    ownHosts: deps.ownHosts,
  })
  const classification = classifyBot({
    userAgent: request.headers.get('user-agent'),
    signals: {
      viewportWidth: batch.viewportWidth,
      interactionCount: batch.interactionCount,
      interEventGapsMs: batch.interEventGapsMs,
    },
  })

  const origination = resolution.decision
  const input: CollectIngestInput = {
    visitorId: presentedVisitorId,
    receivedAtIso,
    landingPath,
    referrerUrl: batch.referrer,
    utm:
      origination.kind === 'origination'
        ? {
            source: origination.origination.basis === 'utm' ? origination.origination.source : null,
            medium: origination.origination.basis === 'utm' ? origination.origination.medium : null,
            campaign: emptyToNull(origination.origination.campaign),
            term: emptyToNull(origination.origination.term),
            content: emptyToNull(origination.origination.content),
          }
        : { source: null, medium: null, campaign: null, term: null, content: null },
    clickIds: resolution.clickIds,
    deviceKind: deviceKindFor(batch.viewportWidth),
    breakpoint: breakpointFor(batch.viewportWidth),
    bot: classification.bot,
    botKind: classification.botKind,
    origination:
      origination.kind === 'origination'
        ? {
            basis: origination.origination.basis,
            source: origination.origination.source,
            medium: origination.origination.medium,
            campaign: origination.origination.campaign,
            term: origination.origination.term,
            content: origination.origination.content,
            resolverVersion: resolution.resolverVersion,
          }
        : null,
    /*
     * The four Consent Mode v2 signals this request's cookie claimed (A-MEAS-02, migration 0125).
     *
     * `grantedConsentSignals` and NOT a second read of the cookie: `analyticsStorageGranted` above is the
     * same parse asking about one of the four, and A-MEAS-02's whole subject is that a consent decision
     * asked in two places gets two answers. The session row then carries the state the dispatch gate
     * reads, because a dispatch is enqueued server-side where there is no cookie at all.
     */
    consentSignals: [...grantedConsentSignals(cookieHeader)],
    events: validated,
  }

  const result = await ingestCollectBatch(deps.sql, input, (existing) => {
    if (existing === null) return { continueSessionId: null }
    const stitch = stitchSession({ lastEventAtMs: existing.lastEventAtMs, atMs: nowMs })
    return { continueSessionId: stitch.kind === 'continue' ? existing.sessionId : null }
  })

  return accepted(result.visitorCreated ? visitorCookie(result.visitorId) : null)
}

/**
 * The path the batch landed on: the first event that carries one.
 *
 * `analytics.session.landing_path` is NOT NULL and `like '/%'`, and every event schema but
 * `whatsapp_ref_shown` carries a path — so the fallback is the root rather than a blank, because a blank
 * would be refused by the constraint and an invented path would be worse than the truth being coarse.
 */
function landingPathOf(batch: {
  readonly events: readonly { readonly payload: unknown }[]
}): string {
  for (const item of batch.events) {
    const path = (item.payload as { path?: unknown })?.path
    if (typeof path === 'string' && path.startsWith('/')) return path
  }
  return '/'
}

/**
 * `''` becomes null on the session's UTM columns, which are nullable, and stays `''` on the attribution
 * row, whose dimensions are NOT NULL with an empty default.
 *
 * Two representations for one absence, and they are not a slip: a nullable session column says "the
 * landing URL carried no `utm_campaign`", while `attribution.campaign` is part of a rollup key where a
 * null never equals a null — 0096's own note on the three rollups. Collapsing them either way would break
 * one of the two.
 */
const emptyToNull = (value: string): string | null => (value === '' ? null : value)

/** Re-exported so `route.ts` and the suite agree on the window without either restating it. */
export { SESSION_INACTIVITY_MS }
