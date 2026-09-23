/**
 * What `/book` reads, and the one rule it injects.
 *
 * `packages/db` may never import `packages/core`, so `queryAvailability` takes the rule that turns rows into
 * offerable starts as an argument — `solveAvailabilityQuery`, from `@berelax/core`. This module is the one
 * place in the application that supplies it, with `satisfies` rather than a cast, exactly as
 * `packages/fixtures/src/availability-query.itest.ts` does: `AvailabilitySolve` (db) and
 * `AvailabilityQueryFacts` (core) are two declarations of one shape, and that one line is what makes a field
 * added to one and not the other a `pnpm typecheck` failure rather than a slot list nobody computed.
 *
 * ## The memo
 *
 * One `AvailabilityCache` per process, at module scope. That is B-AVAIL-07's design rather than a shortcut:
 * the memo is validated against `availability_epoch`, which the database advances on every write that can
 * change an answer, so a stale entry is dropped on the primary-key lookup rather than served. The cache is
 * an optimisation; the database is the authority, and `bookSlot` re-reads the committed rows under the room
 * lock before it writes — which is why a page holding a list that has gone stale receives a named
 * `slot_taken` refusal instead of double-booking a room.
 *
 * ## Why every failure is a state and not a throw
 *
 * This is a public URL anything may link to, including a crawler following a mangled query string. The
 * structural refusals (`not_a_trading_date`, `variant_not_found`, `shape_not_offered`,
 * `no_compatible_room_type`, `requires_client_gender`) already arrive as an *answer* with zero slots and a
 * named reason, because "no availability" is what a booking page renders and a thrown error there is a 500
 * where a sentence belongs. This module keeps that property for the reads around them: an unreachable
 * database renders a named state and a telephone number, not a stack trace.
 */

import { solveAvailabilityQuery } from '@berelax/core'
import {
  type AlternativeTherapist,
  type AvailabilityAnswer,
  type AvailabilityDeps,
  type AvailabilityRequest,
  type AvailabilitySolve,
  type BookableVariantRow,
  createAvailabilityCache,
  type NearestDay,
  noAvailabilityAlternatives,
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readGenderMatching,
  readOpenTradingDays,
  readPublishableTherapists,
  readTherapistLabels,
  type TherapistLabelRow,
  type TradingDayRow,
  type WaitlistEligibility,
} from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { readFactsForPage } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'
import { type BookingParams, DAY_STRIP_DAYS, dayStrip } from './state.ts'

/**
 * Core's rule, as the query's injected solver.
 *
 * `satisfies` and not a cast. See the module header: this is the assignability check that keeps the two
 * sides of the `core`/`db` boundary describing one shape.
 */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/**
 * The in-process memo, shared by every request this process serves.
 *
 * Module scope rather than per-request, which is the whole point of it: a day strip is seven days and a
 * reader moving along it asks the same question about the same date twice within seconds. The default TTL
 * is the shorter end of B-AVAIL-07's 30–60 s band, and `createAvailabilityCache` refuses a longer one by
 * name.
 */
const cache = createAvailabilityCache()

/**
 * The strip is read **anchored at the day asked about**, not at the first open day.
 *
 * `readOpenTradingDays` takes the requested date as its `from`, so the strip's first day is the day the
 * URL names and the next six are the ones after it. A window that always started at today would put any
 * date further out than seven trading days outside the strip — and `dayStrip` would then silently fall
 * back to the first day, so a reader following *"Thursday has six times free"* out of the no-availability
 * state would arrive on a different day's list. That defect reads like a caching bug and is an
 * off-by-window, which is why the anchor is the request rather than the clock.
 *
 * `closes_at > now` still applies, so a bookmark from last week anchors nothing: the read answers with the
 * days it can offer now, which is what a reader arriving on a stale URL should see.
 */
const TRADING_DAYS_READ = DAY_STRIP_DAYS

/** One priced duration, as the page offers it. */
export type BookableVariant = BookableVariantRow

/** A therapist, labelled the only way ADR 0020 allows: a name when one is published, or neither. */
export interface TherapistLabel {
  readonly therapistId: string
  /** `Therapist 07`. An internal handle — never rendered as a display name; see `TherapistCard`. */
  readonly reference: string
  readonly displayName: string | null
}

/** A nearer day with space, plus the therapist labels its own answer needed. */
export interface NoAvailability {
  readonly nearestDays: readonly NearestDay[]
  readonly alternativeTherapists: readonly (AlternativeTherapist & {
    readonly label: TherapistLabel | null
  })[]
  readonly waitlist: WaitlistEligibility
}

/** Everything the page renders from, already read and already solved. */
export interface BookingPageData {
  /** Null when the database could not be read at all. The page then renders a named state. */
  readonly reachable: boolean
  readonly facts: Facts | null
  readonly variants: readonly BookableVariant[]
  /** The open trading dates the strip is cut from, earliest first. */
  readonly tradingDays: readonly TradingDayRow[]
  /** The day strip, and the date it resolved to. */
  readonly days: readonly { readonly tradingDate: string; readonly selected: boolean }[]
  readonly selectedDate: string | null
  readonly variant: BookableVariant | null
  /** The therapist the URL named, labelled. Null when none was named or the id names nobody. */
  readonly therapist: TherapistLabel | null
  /** The therapists a public page may offer by name. Empty until an admin publishes one (ADR 0020). */
  readonly publishable: readonly TherapistLabel[]
  /** Null until a treatment and a client gender have both been stated. */
  readonly answer: AvailabilityAnswer | null
  /** Present exactly when the answer offered nothing. Never a bare empty list. */
  readonly none: NoAvailability | null
  /** `booking.same_gender_matching`, so the page can say why it is asking. */
  readonly strictGenderMatching: boolean
}

const labelOf = (row: TherapistLabelRow): TherapistLabel => ({
  therapistId: row.therapistId,
  reference: row.staffReference,
  // `is_publishable` is GENERATED from `display_name is not null and photo_consent`, so a name set
  // without a recorded consent is deliberately not published here — ADR 0020 requires both.
  displayName: row.isPublishable ? row.displayName : null,
})

/**
 * The page's data, for one URL, at one instant.
 *
 * `now` is an argument rather than a call to the clock, which is what makes the whole render reproducible:
 * the screenshot matrix pins a trading date and the only other thing the page reads the clock for is where
 * the day strip starts. `apps/web/src/book.itest.ts` drives this function directly with a frozen instant as
 * well as through a real server.
 */
export async function bookingPageData(
  params: BookingParams,
  options: { readonly now: number },
): Promise<BookingPageData> {
  const facts = await readFactsForPage()
  const empty: BookingPageData = {
    reachable: false,
    facts,
    variants: [],
    tradingDays: [],
    days: [],
    selectedDate: null,
    variant: null,
    therapist: null,
    publishable: [],
    answer: null,
    none: null,
    strictGenderMatching: true,
  }
  try {
    const sql = factsRuntime().sql
    const [variants, tradingDays, limits, genderMatching] = await Promise.all([
      readBookableVariants(sql),
      readOpenTradingDays(sql, {
        now: options.now,
        from: params.date,
        limit: TRADING_DAYS_READ,
      }),
      readAvailabilityLimits(sql),
      readGenderMatching(sql),
    ])

    // The strip starts at the day asked for when that day is open, and at the first open day otherwise —
    // and it is cut from the read rather than generated, so a closed date is skipped by the database.
    const strip = dayStrip(
      tradingDays.map((day) => day.tradingDate),
      params.date,
    )

    const variant = variants.find((row) => row.serviceVariantId === params.variant) ?? null
    const [therapistRows, publishableRows] = await Promise.all([
      params.therapist === null
        ? Promise.resolve([])
        : readTherapistLabels(sql, [params.therapist]),
      // Scoped to the selected day so a therapist who leaves stops being offered, and to *today* when no
      // day is selected — the same employment predicate either way.
      readPublishableTherapists(sql, {
        onDate: strip.selected ?? new Date(options.now).toISOString().slice(0, 10),
      }),
    ])

    const base: BookingPageData = {
      ...empty,
      reachable: true,
      variants,
      tradingDays,
      days: strip.days,
      selectedDate: strip.selected,
      variant,
      therapist: therapistRows[0] === undefined ? null : labelOf(therapistRows[0]),
      publishable: publishableRows.map(labelOf),
      strictGenderMatching: genderMatching === 'strict',
    }

    // Nothing is asked of the availability engine until the request can be formed. A query with no
    // variant has nothing to be about, and one with no client gender is answered with
    // `requires_client_gender` under the strict default — the page says what it needs instead.
    if (variant === null || strip.selected === null) return base
    if (params.gender === null && base.strictGenderMatching) return base

    const request: AvailabilityRequest = {
      tradingDate: strip.selected,
      serviceVariantId: variant.serviceVariantId,
      minLeadMinutes: limits.minLeadMinutes,
      maxAdvanceDays: limits.maxAdvanceDays,
      ...(params.gender === null ? {} : { clientGender: params.gender }),
      ...(params.therapist === null ? {} : { therapistIds: [params.therapist] }),
      genderMatching,
    }
    const deps: AvailabilityDeps = { solve, cache, now: options.now }
    const answer = await queryAvailability(sql, request, deps)
    if (answer.slots.length > 0) return { ...base, answer }

    // The cold path, and deliberately more round trips than the warm one: it runs only when a day came
    // back empty. Each nearby date is its own request under its own cache tag.
    const alternatives = await noAvailabilityAlternatives(sql, request, deps)
    const labels = await readTherapistLabels(
      sql,
      alternatives.alternativeTherapists.map((row) => row.therapistId),
    )
    const byId = new Map(labels.map((row) => [row.therapistId, labelOf(row)]))
    return {
      ...base,
      answer,
      none: {
        nearestDays: alternatives.nearestDays,
        alternativeTherapists: alternatives.alternativeTherapists.map((row) => ({
          ...row,
          label: byId.get(row.therapistId) ?? null,
        })),
        waitlist: alternatives.waitlistEligible,
      },
    }
  } catch {
    // Fail-soft, for the reason `readPageFacts` gives: a page has other content, and a 500 on the one
    // route that takes a booking is worse than a page that says to call the desk. The error is not logged
    // here — the connection layer already does, and a rendered page is not the place to decide.
    return empty
  }
}
