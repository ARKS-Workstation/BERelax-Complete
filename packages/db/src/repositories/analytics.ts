import {
  type AnalyticsBreakpoint,
  type AnalyticsEvent,
  AppError,
  type DeviceKind,
  type TradingDateBasis,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The `/api/collect` writer (A-FIRST-05): the only thing in this build that puts a row into the
 * `analytics` schema's raw tables.
 *
 * Migration 0096 is the authority for the shape and 0116 for the two things this unit added. What this
 * module owns is the ORDER of the statements and the fact that there is exactly ONE transaction per
 * request — which is the acceptance list's first line and is not a performance choice:
 *
 *   * **A batch is all-or-nothing.** One invalid event rejects the whole batch with zero rows written.
 *     The validation happens before the transaction opens, so the usual failure — a loop that inserted
 *     four events and then threw — cannot arise; and the transaction is still what makes the visitor, the
 *     session, the attribution row and the events one durable fact rather than four.
 *   * **Two requests for one visitor cannot both create a session.** The stitch reads the visitor's
 *     newest session `for update`, so the second request waits for the first rather than deciding from a
 *     snapshot that predates it. A batched beacon flushing twice in the same second is the ordinary case
 *     for this, not an edge one.
 *
 * ## Why the pre-consent path is a different function and not a flag
 *
 * {@link countPreConsentLanding} writes one statement against one table and takes no visitor, no session
 * and no event body — it cannot write an identifier because it is handed none. {@link ingestCollectBatch}
 * takes the visitor. Reading a boolean inside one function would make "did we store an identifier" a
 * question about a branch; two functions with different parameters make it a question about the type, and
 * ADR 0066 is why that is worth a second exported name.
 *
 * ## No audit row per event, deliberately
 *
 * Every other write path in this build records one. Measurement does not, and the reason is arithmetic
 * rather than taste: an audit row per collected event would make `audit_event` — the append-only table an
 * inspection reads — mostly page views, and would double the write volume of the highest-volume path in
 * the system to record that a browser reported a page view. What the analytics estate has instead is its
 * own retention pass and an append-only raw `event` table (ZY065), which is the audit trail for this data.
 *
 * ## No clock
 *
 * Every instant is an argument, as an ISO string, because the acceptance claims are made under a frozen
 * one — "two events 29 minutes apart", "200 requests inside a frozen second". The route reads the clock
 * once per request and passes it down. `now()` appears nowhere in this file.
 */

/** Every refusal this module raises by name, and each one is raised below. */
export const ANALYTICS_INGEST_REFUSALS = [
  /**
   * The trading calendar does not cover this instant, so no session row could name a trading date.
   *
   * A refusal and not a guess. `analytics.session.trading_date` has a real foreign key to
   * `public.business_day`, which is generated ahead of the clock; a request past the end of it is an
   * operational fault with a runbook answer, and inventing a date would file measurement on a day the
   * calendar does not agree exists.
   */
  'analytics_no_trading_calendar',
] as const
export type AnalyticsIngestRefusal = (typeof ANALYTICS_INGEST_REFUSALS)[number]

/** The SQLSTATEs migration 0116 raises, so a caller tells these two refusals from any other conflict. */
export const ANALYTICS_SQLSTATE = {
  /** A pre-consent landing count deleted, lowered, or moved onto another key. */
  preConsentLandingLoss: 'ZY221',
  /** A session whose `trading_date_basis` disagrees with the business day it names. */
  sessionTradingBasis: 'ZY222',
} as const

function refuse(refusal: AnalyticsIngestRefusal, message: string, details: object = {}): never {
  throw new AppError('invariant_violated', message, { details: { ...details, refusal } })
}

/** The named refusal carried on an error this module raised, or null. */
export function analyticsIngestRefusal(error: unknown): AnalyticsIngestRefusal | null {
  if (!(error instanceof AppError)) return null
  const named = (error.details as { refusal?: unknown } | undefined)?.refusal
  return typeof named === 'string' &&
    (ANALYTICS_INGEST_REFUSALS as readonly string[]).includes(named)
    ? (named as AnalyticsIngestRefusal)
    : null
}

// ------------------------------------------------------------------------------------------------
// Resolving the trading date a row is filed under, and why
// ------------------------------------------------------------------------------------------------

/** Which business day a session instant is filed under, and whether that day genuinely contains it. */
export interface TradingDateFiling {
  /** A date `public.business_day` holds, so `session_trading_date_fk` is satisfied by construction. */
  readonly tradingDate: string
  readonly basis: TradingDateBasis
}

/**
 * The business day a session that started at `atIso` is filed under.
 *
 * ## Why this is a query and not `resolveTradingDate`
 *
 * `resolveTradingDate` in `@berelax/core` is the authority on what a trading date IS, and this package may
 * never import it (ADR 0001). That is not a workaround here, it is the right shape: the answer has to be a
 * date `public.business_day` actually holds, because `analytics.session.trading_date` has a foreign key to
 * it and the ZY222 trigger compares `started_at` against that row's own `opens_at` and `closes_at`. A
 * resolution computed from an 11:00-02:00 rule in TypeScript would be a second opinion that disagreed with
 * the calendar on exactly the dates somebody had overridden the hours for.
 *
 * ## The two answers, and why the second one is not a guess
 *
 * The first candidate is the day whose `[opens_at, closes_at)` window CONTAINS the instant — the ordinary
 * case, including 01:30 belonging to the previous date, because that day's window reaches past midnight.
 * When no day contains it the instant fell in the daytime gap, and the row is filed under the next day the
 * calendar opens with a basis that says which reason applied. Nothing is invented: `Y5-funnel-gap-bucket`
 * is still open, and what this does is make the cohort visible and re-bucketable rather than answer it.
 *
 * The three gap reasons are distinguished by the calendar and not by a clock: `before_opening` when the
 * instant is on the same calendar date as the day it is filed under (the salon opens later today),
 * `premises_closed` when the calendar has no row for that date at all, and `after_closing` otherwise.
 */
export async function fileUnderTradingDate(sql: Sql, atIso: string): Promise<TradingDateFiling> {
  const [containing] = await sql<{ trading_date: string }[]>`
    select b.trading_date::text as trading_date
      from public.business_day b
     where ${atIso}::timestamptz >= b.opens_at and ${atIso}::timestamptz < b.closes_at
     order by b.trading_date
     limit 1
  `
  if (containing !== undefined) {
    return { tradingDate: containing.trading_date, basis: 'trading' }
  }

  const [next] = await sql<
    { trading_date: string; same_calendar_date: boolean; calendar_date_open: boolean }[]
  >`
    with local as (
      select (${atIso}::timestamptz at time zone 'Asia/Dubai')::date as calendar_date
    )
    select b.trading_date::text                              as trading_date,
           b.trading_date = local.calendar_date              as same_calendar_date,
           exists (
             select 1 from public.business_day d where d.trading_date = local.calendar_date
           )                                                 as calendar_date_open
      from public.business_day b, local
     where b.trading_date >= local.calendar_date
     order by b.trading_date
     limit 1
  `
  if (next === undefined) {
    refuse(
      'analytics_no_trading_calendar',
      `public.business_day holds no trading date at or after ${atIso}, so a session starting then cannot ` +
        'name one. The calendar is generated ahead of the clock; extend it rather than filing measurement ' +
        'under a date it does not hold.',
      { atIso },
    )
  }
  return {
    tradingDate: next.trading_date,
    basis: next.same_calendar_date
      ? 'before_opening'
      : next.calendar_date_open
        ? 'after_closing'
        : 'premises_closed',
  }
}

// ------------------------------------------------------------------------------------------------
// Pre-consent: one statement, one table, no identifier
// ------------------------------------------------------------------------------------------------

/** How many landings the pre-consent counter holds for one bucket, or null when it holds no row. */
export async function readPreConsentLandings(
  sql: Sql,
  bucket: { readonly bucketDate: string; readonly basis: TradingDateBasis; readonly path: string },
): Promise<number | null> {
  const [row] = await sql<{ landings: string }[]>`
    select landings::text as landings
      from analytics.pre_consent_landing
     where bucket_date = ${bucket.bucketDate}::date
       and bucket_basis = ${bucket.basis}
       and path = ${bucket.path}
  `
  return row === undefined ? null : Number(row.landings)
}

/**
 * Count one pre-consent landing, and write nothing else anywhere.
 *
 * ## The signature is the guarantee
 *
 * It takes a date, a basis and a path. It cannot store a visitor id, a session id, an event body, a user
 * agent or an instant, because it is handed none of them — which is what makes "no identifier is created
 * before consent" a property a reader can check by looking at the parameters rather than a claim about
 * what the body happens to do. ADR 0066.
 *
 * ## Why the increment is `+1` in SQL and not a read-then-write
 *
 * `on conflict … do update set landings = landings + 1` is one statement, so two concurrent landings on
 * the same route cannot both read 4 and both write 5. A read-then-write would lose one landing per race,
 * and this counter is the only surviving record that the visit happened at all — the event itself was
 * never stored, so there is nothing to recount from.
 *
 * Returns the count after the increment, so a caller can assert a DELTA rather than a total. The suite
 * runs twice in a row against the same database and the table is kept indefinitely; an assertion on a
 * total would pass once.
 */
export async function countPreConsentLanding(
  sql: Sql,
  landing: { readonly bucketDate: string; readonly basis: TradingDateBasis; readonly path: string },
): Promise<number> {
  const [row] = await sql<{ landings: string }[]>`
    insert into analytics.pre_consent_landing (bucket_date, bucket_basis, path, landings)
    values (${landing.bucketDate}::date, ${landing.basis}, ${landing.path}, 1)
    on conflict (bucket_date, bucket_basis, path)
      do update set landings = analytics.pre_consent_landing.landings + 1
    returning landings::text as landings
  `
  if (row === undefined) {
    // Unreachable: the upsert always returns a row. Raised rather than coerced, because a `?? 0` here
    // would report a landing that was counted as a landing that was not.
    throw new AppError(
      'invariant_violated',
      'analytics.pre_consent_landing upsert returned no row, so the landing count is unknown.',
    )
  }
  return Number(row.landings)
}

// ------------------------------------------------------------------------------------------------
// Consented: the visitor, the session, its origination and its events, in one transaction
// ------------------------------------------------------------------------------------------------

/** The origination A-FIRST-03's resolver produced, as this module stores it. */
export interface SessionOrigination {
  readonly basis: string
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly term: string
  readonly content: string
  readonly resolverVersion: string
}

/** Everything one consented batch needs, with every instant already resolved by the caller. */
export interface CollectIngestInput {
  /**
   * The visitor this request presented, or null for one that presented none.
   *
   * A visitor id the route could not match to a row is passed as null rather than trusted: the route
   * generates a fresh id instead, so the server owns the identifier space and a forged or long-purged
   * cookie value becomes a new visitor rather than joining somebody else's.
   */
  readonly visitorId: string | null
  /** The instant the request arrived, which is what the stitcher measures idleness against. */
  readonly receivedAtIso: string
  readonly landingPath: string
  readonly referrerUrl: string | null
  readonly utm: {
    readonly source: string | null
    readonly medium: string | null
    readonly campaign: string | null
    readonly term: string | null
    readonly content: string | null
  }
  /** Every click id found, verbatim and never case-folded (A-FIRST-03). */
  readonly clickIds: Readonly<Record<string, string>>
  readonly deviceKind: DeviceKind
  readonly breakpoint: AnalyticsBreakpoint
  /**
   * A-FIRST-04's verdict, stored and never acted on.
   *
   * ADR 0062: the classifier's answer may not refuse, gate or authorise anything, so a suspected bot's
   * events are written exactly like anybody else's and the flag is what lets A-FIRST-09 exclude them from
   * a funnel later. There is no branch on `bot` in this file, which is the point.
   */
  readonly bot: boolean
  readonly botKind: string | null
  readonly origination: SessionOrigination | null
  /** The validated events, in the order they arrived, each with the client's own instant. */
  readonly events: readonly {
    readonly event: AnalyticsEvent
    readonly occurredAtIso: string
    readonly clientEventId: string
    readonly path: string
  }[]
}

/** What one consented batch did. */
export interface CollectIngestResult {
  readonly visitorId: string
  readonly sessionId: string
  /** True when this request created the visitor row, which is when the route issues the cookie. */
  readonly visitorCreated: boolean
  /** True when the 30-minute idle window had elapsed, so this batch began a new session. */
  readonly sessionStarted: boolean
  readonly tradingDate: string
  readonly tradingDateBasis: TradingDateBasis
  /** How many event rows were written. Equal to `events.length` unless a client id was a replay. */
  readonly eventsWritten: number
}

/**
 * Which session a batch belongs to, decided by the CALLER.
 *
 * The thirty-minute window is a constant in `@berelax/shared` and the comparison is `stitchSession` in
 * `@berelax/core`, and this package may import neither the second nor reach the clock the first is measured
 * against (ADR 0001). So the decision arrives as an answer rather than as inputs, which is what stops this
 * file having an opinion of its own about the window — and is why `decide` is a parameter of
 * {@link ingestCollectBatch} rather than a branch inside it.
 */
export interface SessionStitchDecision {
  /** The session to continue, or null to start one. Decided by `stitchSession` in `@berelax/core`. */
  readonly continueSessionId: string | null
}

/**
 * The visitor's newest session, locked, or null when they have none.
 *
 * `for update` is what makes the stitch correct under concurrency, and the batched beacon makes that the
 * ordinary case: two flushes in the same second would otherwise both read "no session in the last thirty
 * minutes" and both insert one, giving one visitor two sessions and the funnel two landings. The lock is
 * taken on the session row rather than on the visitor because that is the row the decision reads, and it is
 * released by the transaction the caller already has open.
 *
 * Exported so the route can make the pure stitch decision on real values rather than this module making it
 * on borrowed ones: the window is A-FIRST-05's constant and the comparison is `@berelax/core`'s function,
 * and `packages/db` may reach neither.
 */
export interface NewestSession {
  readonly sessionId: string
  /**
   * Milliseconds since the epoch, not an ISO string.
   *
   * The stitcher subtracts two instants, so it needs a number; rendering one as text here and parsing it
   * back at the call site would be two conversions to get wrong, and `to_char(…, 'OF')` in particular
   * emits an hour-only offset (`+04`) that not every JavaScript runtime parses.
   */
  readonly lastEventAtMs: number
}

export async function newestSessionForUpdate(
  tx: Sql,
  visitorId: string,
): Promise<NewestSession | null> {
  const [row] = await tx<{ session_id: string; last_event_ms: string }[]>`
    select session_id,
           (extract(epoch from last_event_at) * 1000)::bigint::text as last_event_ms
      from analytics.session
     where visitor_id = ${visitorId}::uuid
     order by started_at desc
     limit 1
     for update
  `
  return row === undefined
    ? null
    : { sessionId: row.session_id, lastEventAtMs: Number(row.last_event_ms) }
}

/**
 * Write one consented batch: the visitor, the session it belongs to, its origination and its events.
 *
 * `decide` is called INSIDE the transaction, after the visitor's newest session has been locked, and is
 * handed that session. That is the only arrangement in which the pure 30-minute decision and the lock that
 * makes it safe are the same read — a caller that decided first and then opened a transaction would be
 * deciding from a snapshot the lock was supposed to prevent.
 */
export async function ingestCollectBatch(
  sql: Sql,
  input: CollectIngestInput,
  decide: (existing: NewestSession | null) => SessionStitchDecision,
): Promise<CollectIngestResult> {
  return (await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql

    /*
     * The visitor, and the ONE place the server decides who owns an identifier.
     *
     * An UPDATE ... RETURNING rather than an upsert on the presented id, deliberately. It answers both
     * questions in one statement — does this visitor exist, and advance its `last_seen_at` — and, more
     * importantly, it makes a presented id that names NO row fall through to a server-generated one. An
     * `insert … on conflict` would have accepted a client-chosen uuid and created a visitor under it.
     *
     * Two cases reach that fall-through and both are right to become a new visitor: a cookie whose row
     * retention purged after 90 days, and a forged value. A forged id that happens to name a live visitor
     * can still add events to that visitor's measurement, and that is stated rather than hidden — the
     * cookie authorises no read, names no principal and reaches no other subject's data, so the cost is
     * one polluted session's figures and never a disclosure. Signing it would need a secret and would
     * protect a measurement store against an attack whose whole payoff is a wrong page-view count.
     *
     * `greatest` and not a bare assignment: a late flush can arrive carrying an older instant than one
     * already stored, and `visitor_last_seen_not_before_first` would refuse a row that moved backwards
     * past `first_seen_at`. `first_seen_at` itself is never touched, which is the acceptance line's claim
     * about a stitched-apart pair — the second session must leave first touch alone.
     */
    const presented = input.visitorId
    const [known] =
      presented === null
        ? []
        : await tx<{ visitor_id: string }[]>`
            update analytics.visitor
               set last_seen_at = greatest(last_seen_at, ${input.receivedAtIso}::timestamptz)
             where visitor_id = ${presented}::uuid
            returning visitor_id
          `
    let resolvedVisitorId = known?.visitor_id ?? null
    const visitorCreated = resolvedVisitorId === null
    if (resolvedVisitorId === null) {
      const [created] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at)
        values (${input.receivedAtIso}::timestamptz, ${input.receivedAtIso}::timestamptz)
        returning visitor_id
      `
      if (created === undefined) {
        throw new AppError('invariant_violated', 'analytics.visitor insert returned no row.')
      }
      resolvedVisitorId = created.visitor_id
    }

    const existing = visitorCreated ? null : await newestSessionForUpdate(tx, resolvedVisitorId)
    const decision = decide(existing)

    let sessionId = decision.continueSessionId
    let filing: TradingDateFiling
    const sessionStarted = sessionId === null

    if (sessionId === null) {
      // A new session is filed under the business day its FIRST event belongs to, and the basis is what
      // says whether that day really contains it. The instant is the request's, not the client's: the
      // client's clock is what A-FIRST-06 batches against and is not something a trading date may depend
      // on — a browser an hour fast would otherwise file a session on tomorrow's day.
      filing = await fileUnderTradingDate(tx, input.receivedAtIso)
      const [created] = await tx<{ session_id: string }[]>`
        insert into analytics.session (
          visitor_id, started_at, last_event_at, trading_date, trading_date_basis,
          landing_path, referrer_url,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          click_ids, device_kind, breakpoint, bot, bot_kind
        ) values (
          ${resolvedVisitorId}::uuid,
          ${input.receivedAtIso}::timestamptz,
          ${input.receivedAtIso}::timestamptz,
          ${filing.tradingDate}::date,
          ${filing.basis},
          ${input.landingPath},
          ${input.referrerUrl},
          ${input.utm.source},
          ${input.utm.medium},
          ${input.utm.campaign},
          ${input.utm.term},
          ${input.utm.content},
          ${tx.json({ ...input.clickIds })},
          ${input.deviceKind},
          ${input.breakpoint},
          ${input.bot},
          ${input.botKind}
        )
        returning session_id
      `
      if (created === undefined) {
        throw new AppError('invariant_violated', 'analytics.session insert returned no row.')
      }
      sessionId = created.session_id

      // The origination row, written once with the session and never re-resolved here. A-FIRST-03's
      // resolver is a pure function of the session's own signals, so a second resolution for the same
      // session could only differ by having a different resolver version — which is what
      // `resolver_version` is for and is A-FIRST-08's to use, not this module's.
      if (input.origination !== null) {
        const origination = input.origination
        await tx`
          insert into analytics.attribution (
            session_id, basis, source, medium, campaign, term_value, content_value,
            resolver_version, resolved_at
          ) values (
            ${sessionId}::uuid,
            ${origination.basis},
            ${origination.source},
            ${origination.medium},
            ${origination.campaign},
            ${origination.term},
            ${origination.content},
            ${origination.resolverVersion},
            ${input.receivedAtIso}::timestamptz
          )
          on conflict (session_id) do nothing
        `
      }
    } else {
      // A continued session advances only `last_event_at`, and `greatest` keeps it monotonic so a late
      // flush cannot move it backwards past `session_last_event_not_before_start`. `trading_date` and
      // `trading_date_basis` are left alone: the session is filed under the day it STARTED on, and a
      // visit that runs past close belongs to the session it began in.
      const [advanced] = await tx<{ trading_date: string; trading_date_basis: string }[]>`
        update analytics.session
           set last_event_at = greatest(last_event_at, ${input.receivedAtIso}::timestamptz)
         where session_id = ${sessionId}::uuid
        returning trading_date::text as trading_date, trading_date_basis
      `
      if (advanced === undefined) {
        throw new AppError(
          'invariant_violated',
          `analytics.session ${sessionId} vanished between the lock and the update.`,
        )
      }
      filing = {
        tradingDate: advanced.trading_date,
        basis: advanced.trading_date_basis as TradingDateBasis,
      }
    }

    /*
     * Whether this session still has its `landing` to give.
     *
     * A-FIRST-02 deferred this here in so many words: "the collect route must set the page_view payload's
     * `entry` flag on the session's FIRST page view only, because the landing stage is one per session".
     * The taxonomy REQUIRES the field so the collector's payload is complete and typed; the value the
     * client sent is then **overwritten**, because a browser cannot know whether its page view is a
     * session's first — it has never been told which session it is in, and the thirty-minute stitch is the
     * server's. A client claiming `entry: true` on its fourth page view would otherwise give one session
     * four landings, and the funnel's first bucket is the denominator every rate on the analytics page
     * divides by.
     *
     * Read from the stored rows and not from `sessionStarted`, which would be the obvious shortcut and is
     * wrong in one real case: a batch whose only events are CTA clicks creates the session, and the page
     * view that arrives in the next batch is still that session's first.
     */
    const [priorLanding] = await tx<{ present: boolean }[]>`
      select exists (
        select 1 from analytics.event
         where session_id = ${sessionId}::uuid
           and event_name = 'page_view'
           and (properties ->> 'entry') = 'true'
      ) as present
    `
    let entryStillAvailable = priorLanding?.present !== true

    // One row per event, and `on conflict do nothing` on the collector's own id — which is what makes an
    // offline flush idempotent (A-FIRST-06) without the route having to ask first. The count that comes
    // back is the count WRITTEN, so a replayed batch reports what it actually did rather than what it was
    // handed.
    let eventsWritten = 0
    for (const item of input.events) {
      let properties: object = item.event.payload as object
      if (item.event.name === 'page_view') {
        properties = { ...item.event.payload, entry: entryStillAvailable }
        entryStillAvailable = false
      }
      const [written] = await tx<{ event_id: string }[]>`
        insert into analytics.event (
          session_id, occurred_at, received_at, event_name, path, properties, client_event_id
        ) values (
          ${sessionId}::uuid,
          ${item.occurredAtIso}::timestamptz,
          ${input.receivedAtIso}::timestamptz,
          ${item.event.name},
          ${item.path},
          ${tx.json(properties as never)},
          ${item.clientEventId}
        )
        on conflict (client_event_id, occurred_at) do nothing
        returning event_id
      `
      if (written !== undefined) eventsWritten += 1
    }

    return {
      visitorId: resolvedVisitorId,
      sessionId,
      visitorCreated,
      sessionStarted,
      tradingDate: filing.tradingDate,
      tradingDateBasis: filing.basis,
      eventsWritten,
    }
  })) as CollectIngestResult
}
