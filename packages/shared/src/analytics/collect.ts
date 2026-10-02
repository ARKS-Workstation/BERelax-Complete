/**
 * The `/api/collect` wire contract (A-FIRST-05): what a batch looks like, what it may not exceed, and
 * the two derived facts the server stores about the client's screen.
 *
 * ## Why this is in `shared` and not in `core`
 *
 * Three packages read it and no two of them may import each other. The **browser collector** is
 * `packages/ui` (A-FIRST-06), which depends on `@berelax/shared` and may not depend on `@berelax/core`
 * at all; the **route** is `apps/web`; the **writer** is `@berelax/db`, which may never import
 * `@berelax/core` (ADR 0001). `shared` is the only package all three may reach, which is the argument
 * `analytics/taxonomy.ts` makes about itself one file over — and this module is the envelope round the
 * events that file validates.
 *
 * Getting this wrong is not a tidiness question. A cap the collector does not know about is a cap that
 * silently drops a browser's whole batch, and a batch shape written twice is the one that stops matching
 * on the day somebody adds a field.
 *
 * ## No clock, and not even the word
 *
 * `scripts/check-core-purity.mjs` scans this directory with the scoped treatment — no `Date` and no
 * `Intl`, not merely no clock read — so an event's instant arrives as an **ISO string** and is validated
 * by pattern. The conversion to a number belongs to whoever has a clock to compare it against, which is
 * the route. A module that parsed the instant here would be the second place in the build that decides
 * what "now" means.
 */
import { z } from 'zod'

/** The one path the collector posts to. Written once, so a rename cannot leave the client behind. */
export const COLLECT_PATH = '/api/collect'

/**
 * The largest body `/api/collect` will read, in bytes.
 *
 * 64 KiB, and the figure is the acceptance line's. It is generous for the shape below — fifty events of
 * a few hundred bytes each — and that headroom is deliberate: the cap exists to bound what an anonymous
 * internet caller can make the server parse, not to be a budget a real page has to fit inside.
 *
 * Enforced on the BYTES rather than on the parsed object, and before the parse: a body is refused for
 * being too large by a check that has not yet allocated anything proportional to it.
 */
export const COLLECT_MAX_BODY_BYTES = 65_536

/**
 * The most events one batch may carry.
 *
 * Fifty, from the acceptance line. The collector batches and flushes on `visibilitychange`, so a queue
 * longer than this is split into more than one request rather than refused — which is why a cap here
 * costs a real client nothing and bounds the work one request can ask for.
 */
export const COLLECT_MAX_BATCH_EVENTS = 50

/**
 * How long a session may be idle before the next event begins a new one, in milliseconds.
 *
 * Thirty minutes, which is the figure the acceptance line names in both directions: 29 minutes apart is
 * one session, 31 minutes apart is two. Stated once, here, because the client shows a session id nowhere
 * and the server is the only thing that can decide it — and because the two assertions in the suite have
 * to be written against the same number the stitcher uses.
 */
export const SESSION_INACTIVITY_MS = 30 * 60 * 1000

/**
 * What kind of device, as `analytics.session.device_kind`'s CHECK spells it (migration 0096).
 *
 * A second statement of the constraint's four words, unavoidably: `db` may not import `core` and SQL
 * cannot import anything, so the vocabulary has to live where all three can reach it and the agreement
 * has to be asserted rather than expressed. Gate case 144 reads the migration, the Drizzle mirror and
 * this tuple and requires the same four words in all three — the arrangement A-FIRST-03 recorded for
 * `attribution_basis_known` and for the same reason.
 *
 * `unknown` is a member and not an absence, because a client that reports no viewport is the ordinary
 * case for a crawler and for a `sendBeacon` from a backgrounded tab. A nullable column would make "we
 * were not told" and "nobody has looked" the same value.
 */
export const DEVICE_KINDS = ['mobile', 'tablet', 'desktop', 'unknown'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

/**
 * The layout breakpoint a viewport width falls in, by name.
 *
 * The names and the widths are `BREAKPOINTS` in `@berelax/ui` — the design tokens, which are where a
 * breakpoint comes into existence (ADR 0012) — and this is a second statement of them for the reason
 * {@link DEVICE_KINDS} is: `packages/ui` is a React package that an API route has no business importing,
 * and `packages/shared` may not import it either. So the equality is a CHECK rather than a derivation:
 * `apps/web/src/breakpoint-capture.test.ts` is the only place both are reachable and holds the two equal
 * in both directions, which is the arrangement A-FIRST-04 used for the crawler table.
 *
 * `base` is the band BELOW the smallest declared breakpoint. It is named rather than left as a gap
 * because 360 is a floor and not a target — a 320px viewport is a real phone, and a device reporting one
 * must land in a named bucket rather than in whichever branch a comparison fell through to.
 */
export const ANALYTICS_BREAKPOINT_BANDS = [
  { name: 'xxl', minWidth: 1600 },
  { name: 'xl', minWidth: 1280 },
  { name: 'lg', minWidth: 1024 },
  { name: 'md', minWidth: 768 },
  { name: 'sm', minWidth: 480 },
  { name: 'xs', minWidth: 360 },
  { name: 'base', minWidth: 0 },
] as const

/** What the client did not tell us. Stored as a value, for {@link DEVICE_KINDS}'s reason. */
export const BREAKPOINT_UNKNOWN = 'unknown'

export type AnalyticsBreakpoint =
  | (typeof ANALYTICS_BREAKPOINT_BANDS)[number]['name']
  | typeof BREAKPOINT_UNKNOWN

/** Every breakpoint a session row may carry, widest first, with `unknown` last. */
export const ANALYTICS_BREAKPOINTS: readonly AnalyticsBreakpoint[] = [
  ...ANALYTICS_BREAKPOINT_BANDS.map((band) => band.name),
  BREAKPOINT_UNKNOWN,
]

/**
 * The two breakpoints the device bands are cut at, BY NAME rather than by a width written again.
 *
 * Where the line between a tablet and a desktop falls is a judgement, and it is the token layer's
 * judgement: a device that gets the desktop layout is a desktop for the purposes of a report about
 * layout. Naming the band rather than repeating 1024 means a change to the ramp moves both functions
 * together, and the drift test that holds the ramp equal to `@berelax/ui` covers both at once. Splitting
 * "device" off from "breakpoint" with thresholds of its own would give the analytics page two different
 * answers to one question.
 */
const DESKTOP_FROM_BAND = 'lg'
const TABLET_FROM_BAND = 'md'

const minWidthOf = (name: string): number | undefined =>
  ANALYTICS_BREAKPOINT_BANDS.find((band) => band.name === name)?.minWidth

/** A width the client did not report, or reported as something that cannot be a viewport. */
const unusableWidth = (viewportWidth: number | null): boolean =>
  viewportWidth === null || !Number.isFinite(viewportWidth) || viewportWidth <= 0

/** The breakpoint a width falls in, or {@link BREAKPOINT_UNKNOWN} when none was reported. */
export function breakpointFor(viewportWidth: number | null): AnalyticsBreakpoint {
  if (unusableWidth(viewportWidth)) return BREAKPOINT_UNKNOWN
  for (const band of ANALYTICS_BREAKPOINT_BANDS) {
    if ((viewportWidth as number) >= band.minWidth) return band.name
  }
  return BREAKPOINT_UNKNOWN
}

/**
 * The device kind a width falls in, or `unknown`.
 *
 * Three bands from two boundaries: below `md` is a phone, `md` up to `lg` is a tablet, `lg` and above is
 * a desktop. Both boundaries are read out of the band table, so neither number appears here.
 */
export function deviceKindFor(viewportWidth: number | null): DeviceKind {
  if (unusableWidth(viewportWidth)) return 'unknown'
  const desktopFrom = minWidthOf(DESKTOP_FROM_BAND)
  const tabletFrom = minWidthOf(TABLET_FROM_BAND)
  if (desktopFrom === undefined || tabletFrom === undefined) return 'unknown'
  const width = viewportWidth as number
  if (width >= desktopFrom) return 'desktop'
  return width >= tabletFrom ? 'tablet' : 'mobile'
}

/** The longest referrer, query string and client event id the envelope will accept. */
export const COLLECT_MAX_REFERRER_LENGTH = 2048
export const COLLECT_MAX_QUERY_LENGTH = 2048
export const COLLECT_MAX_CLIENT_EVENT_ID_LENGTH = 64

/**
 * One event on the wire: the name, when the CLIENT says it happened, its idempotency key, and the
 * payload that name's own schema will validate.
 *
 * `strictObject`, so an unknown extra property is a refusal and not a field silently dropped. That is
 * the acceptance line — "any unknown extra property is rejected 400" — and the reason it is worth a cap
 * of its own is that a payload the server ignores is a payload a later unit will believe is stored.
 *
 * `payload` is `unknown` here on purpose. The name decides the shape, and only
 * `parseAnalyticsEvent` in `analytics/taxonomy.ts` knows the registry — validating it twice, once
 * loosely here and once properly there, is how a shape comes to be enforced in two places that disagree.
 *
 * ## And `name` is a bounded STRING, not the taxonomy's enum
 *
 * It was the enum first, and `collect.itest.ts` caught what that cost: a name outside the taxonomy was
 * refused by the envelope as `invalid_envelope`, so the route's `unknown_event` refusal became unreachable
 * — a named refusal nothing could raise, which is the shape the brief refuses in both directions. Worse,
 * the useful answer was the one that got lost: "you deployed a tag the taxonomy does not hold, and here is
 * the list" became "your batch is unreadable".
 *
 * So membership is decided in exactly ONE place, which is `parseAnalyticsEvent` — A-FIRST-02's own
 * argument about its registry, one level up. The envelope's job here is to bound the string so a megabyte
 * of Unicode cannot reach the error message that quotes it back.
 */
export const collectEventSchema = z.strictObject({
  name: z.string().min(1).max(64),
  /** The client's own instant, ISO 8601 with an offset. Validated by pattern; never parsed here. */
  occurredAt: z.iso.datetime({ offset: true }),
  /**
   * The collector's id for this event, which is what makes an offline flush idempotent (A-FIRST-06).
   *
   * Bounded and pattern-checked because it reaches a UNIQUE constraint: a 10 MB "id" would be refused by
   * the body cap, and an id carrying arbitrary bytes would make the index unreadable to anybody
   * debugging a duplicate.
   */
  clientEventId: z
    .string()
    .min(1)
    .max(COLLECT_MAX_CLIENT_EVENT_ID_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message: 'A client event id is URL-safe base64 characters only.',
    }),
  payload: z.unknown(),
})

export type CollectEvent = z.infer<typeof collectEventSchema>

/**
 * One posted batch.
 *
 * ## What is here because the SERVER cannot know it
 *
 * `viewportWidth`, `interactionCount` and `interEventGapsMs` are the three signals A-FIRST-04's headless
 * heuristic reads, and none of them is visible from a request. They are the client's claims about itself
 * and are treated as such: ADR 0062 forbids any verdict drawn from them refusing, gating or authorising
 * anything, and the only thing this build does with them is write a flag beside the row.
 *
 * `query` and `referrer` are the origination signals A-FIRST-03's resolver takes. They come from the
 * client rather than from the `Referer` header because the header is absent on a `sendBeacon` from a page
 * the visitor has already left — which is exactly the flush the landing event arrives in.
 *
 * ## What is deliberately NOT here
 *
 * No visitor id, no session id and no consent claim inside the body. All three travel as cookies, and
 * the reason is that a body field is something a page's own JavaScript composes: an identity the
 * collector could compose is an identity a third-party script on the page could compose too.
 */
export const collectBatchSchema = z.strictObject({
  /** The layout viewport width in CSS pixels, or null when the client reported none. */
  viewportWidth: z.number().int().positive().max(100_000).nullable(),
  /** How many interaction events this client has produced in this session so far. */
  interactionCount: z.number().int().min(0).max(1_000_000),
  /** Milliseconds between consecutive events, in arrival order. Gaps, never instants (A-FIRST-04). */
  interEventGapsMs: z.array(z.number().int().min(0).max(86_400_000)).max(COLLECT_MAX_BATCH_EVENTS),
  /** The landing URL's query string, with or without its leading `?`. */
  query: z.string().max(COLLECT_MAX_QUERY_LENGTH).nullable(),
  /** The referrer as the page saw it. */
  referrer: z.string().max(COLLECT_MAX_REFERRER_LENGTH).nullable(),
  events: z.array(collectEventSchema).min(1).max(COLLECT_MAX_BATCH_EVENTS),
})

export type CollectBatch = z.infer<typeof collectBatchSchema>

/**
 * Every way `/api/collect` refuses, by name.
 *
 * Named rather than numbered, and returned in the body, because the callers that see them are a browser
 * and whoever is debugging one. "400" tells a tag author nothing; `unknown_event` tells them they
 * deployed a name the taxonomy does not hold, and `batch_too_large` tells them their queue is not being
 * split. The closed tuple is what lets the suite assert the reason rather than the status — a status that
 * is right for the wrong reason is the failure this repository has paid for most.
 */
export const COLLECT_REFUSALS = [
  /** The body was larger than {@link COLLECT_MAX_BODY_BYTES}. */
  'body_too_large',
  /** The bytes were not JSON. */
  'malformed_json',
  /** The envelope failed {@link collectBatchSchema} — a missing field, or an unknown extra property. */
  'invalid_envelope',
  /** More than {@link COLLECT_MAX_BATCH_EVENTS} events. */
  'batch_too_large',
  /** A name outside the taxonomy — A-FIRST-02's `UnknownEventError`. */
  'unknown_event',
  /** A payload that failed its own event's schema. */
  'invalid_event_payload',
  /** The per-visitor request budget was exceeded. The only refusal that is a 429. */
  'rate_limited',
  /**
   * The trading calendar does not reach this instant, so no session row could name a trading date.
   *
   * A refusal and not a guess. `business_day` is generated ahead of the clock; a request past the end of
   * it is an operational fault with a runbook answer, and inventing a date would put measurement on a
   * day the calendar does not agree exists.
   */
  'no_trading_calendar',
] as const

export type CollectRefusal = (typeof COLLECT_REFUSALS)[number]

/**
 * Why a session's `trading_date` is the date it is (migration 0116).
 *
 * `trading` plus the three reasons `resolveTradingDate` gives for an instant that belongs to no trading
 * date at all. Trading runs 11:00-02:00, so between 02:00 and 11:00 there IS no trading date while web
 * traffic carries on — and `analytics.session.trading_date` is `not null` with a foreign key, so the row
 * has to name one. It names the next date the calendar opens and carries the reason beside it, which is
 * what keeps the gap cohort visible instead of counted as daytime trade (`Y5-funnel-gap-bucket`).
 *
 * ## Three statements of these four words, and what holds them together
 *
 * The tuple is here because `@berelax/db` writes the column and may not import `@berelax/core` (ADR
 * 0001), and `@berelax/shared` may not import core either — so this cannot BE `OutsideTradingReason`,
 * which is a type in `packages/core/src/business-day/resolve.ts`. It is checked against it instead, and
 * in the strongest available way: `packages/core/src/analytics/ingest.ts` carries a two-way TYPE
 * assertion, so a reason added to the resolver and not to this tuple does not compile. Migration 0116's
 * two CHECK constraints are the third statement, unavoidably, and gate case 144 reads the migration, the
 * Drizzle mirror and this tuple and requires the same four words in all three — the arrangement
 * A-FIRST-03 recorded for `attribution_basis_known`.
 */
export const TRADING_DATE_BASES = [
  'trading',
  'before_opening',
  'after_closing',
  'premises_closed',
] as const

export type TradingDateBasis = (typeof TRADING_DATE_BASES)[number]

export const isTradingDateBasis = (value: string): value is TradingDateBasis =>
  (TRADING_DATE_BASES as readonly string[]).includes(value)
