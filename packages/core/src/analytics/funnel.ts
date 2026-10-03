/**
 * The funnel contract (A-FIRST-02): which facts advance the funnel, which end it, and which trading day
 * each one lands on.
 *
 * Pure, like everything in `packages/core`: every input is an argument, including the instant. There is
 * no `Date`, no `Intl` and no `process` here — `scripts/check-core-purity.mjs` proves it, and
 * `.dependency-cruiser.cjs`'s `core-must-be-pure` and `analytics-taxonomy-must-be-pure` close the import
 * half.
 *
 * ## Where the vocabulary comes from, and why none of it is written here
 *
 * The stage names, the exclusion reasons and the collected event names are all in
 * `@berelax/shared`'s `analytics/taxonomy.ts`, because `packages/db` holds the `analytics` schema whose
 * columns are those words and `db` must never import `core` (ADR 0001). This module states the MAPPING
 * and nothing about the vocabulary, so a stage spelled differently here does not typecheck.
 *
 * The appointment half of the mapping is keyed on `AppointmentStatus`, which means the lifecycle table in
 * `../lifecycle/transitions.ts` is the source for the domain side too. {@link APPOINTMENT_STATUS_FUNNEL}
 * is a `Record` over that union, so a tenth status fails `pnpm typecheck` naming this file rather than
 * silently falling into a default branch — there is no default here, for the reason `transitions.ts`
 * gives: "a default in a state machine is a default-allow with better manners".
 *
 * ## Why the exclusion reasons are the terminal statuses
 *
 * `FUNNEL_EXCLUSION_REASONS` in `shared` is exactly `TERMINAL_APPOINTMENT_STATUSES` with `completed`
 * removed, because `completed` is the one terminal state that ADVANCES the funnel. The two lists cannot
 * be one — `shared` may not import `core` — so `funnel.test.ts` holds them equal in both directions. It
 * is the one file that can see both.
 *
 * ## Why a no-show is a REASON on a row and not a missing row
 *
 * docs/03 §6: "roughly 5-15% of bookings do not turn up, so any funnel ending at 'booking created'
 * overstates itself and any ad platform optimising on that signal is optimising for no-shows too." A
 * journey that simply stopped producing rows is indistinguishable from one still in flight, so a
 * no-show is recorded as a step with `excluded_reason` set and no stage. ADR 0018 makes the same argument
 * one layer up about ref-capture rate: a dashboard that cannot tell "no conversions" from "conversions
 * we failed to attribute" is worse than no dashboard.
 *
 * ## The bucket is a trading date, never a calendar date
 *
 * Trading runs 11:00 to 02:00 Asia/Dubai, so a treatment paid for at 01:30 on the 3rd belongs to the
 * **2nd's** business day (ADR 0007, `../business-day/resolve.ts`). A daily funnel cut on the calendar
 * date splits every night's takings across two rows and disagrees with cash-up, the rota and the
 * journal, all of which cut on `business_day`. {@link funnelBucketFor} therefore resolves through
 * `resolveTradingDate` and takes the instant and the hours as arguments.
 *
 * It also refuses to guess. Between 02:00 and 11:00 the premises is shut and an instant in that gap
 * belongs to NO trading date, while web traffic continues all night — so {@link FunnelBucket} carries
 * either a trading date or the named `OutsideTradingReason` plus the calendar date the instant fell on,
 * and the calendar date is explicitly not a trading date. Which trading date the gap should roll into is
 * `Y5-funnel-gap-bucket` in `docs/OPEN-QUESTIONS.md`: answering it is a business decision, and inventing
 * one here would put morning traffic on a day whose session had not begun with nothing saying so.
 */
import {
  type AnalyticsEvent,
  type AnalyticsEventName,
  FUNNEL_STAGES,
  type FunnelExclusionReason,
  type FunnelStage,
} from '@berelax/shared'
import { assertNever } from '../assert-never.ts'
import type { HoursForDate, OutsideTradingReason } from '../business-day/resolve.ts'
import { resolveTradingDate } from '../business-day/resolve.ts'
import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  eventTypeFor,
} from '../lifecycle/transitions.ts'
import type { Instant, LocalDate, TimeZone } from '../time.ts'
import { ASIA_DUBAI } from '../time.ts'

/**
 * What one fact does to the funnel. Three answers, and every one of them is a value a caller branches
 * on rather than a `null` it has to interpret.
 *
 * `no_step` carries a `why` for the same reason `OutsideTradingReason` is named: "this produced no funnel
 * step" and "this produced no funnel step because the treatment has merely started" are different facts,
 * and a reader looking at a gap in the funnel needs the second one.
 */
export type FunnelOutcome =
  | { readonly kind: 'stage'; readonly stage: FunnelStage }
  | { readonly kind: 'excluded'; readonly reason: FunnelExclusionReason }
  | { readonly kind: 'no_step'; readonly why: string }

/** What a collected event contributes, as data rather than as control flow. */
export interface CollectedEventFunnelRule {
  /** The stage it contributes, or `null` for traffic that advances nothing. */
  readonly stage: FunnelStage | null
  /**
   * True when only the session's ENTRY page view contributes the stage.
   *
   * Set on `page_view` alone, and the resolver reads the `entry` field of the validated payload rather
   * than trusting the flag — so a rule that set this on an event with no such field contributes nothing
   * instead of contributing on every occurrence. `funnel.test.ts` asserts `page_view` is the only rule
   * carrying it.
   */
  readonly entryPageViewOnly: boolean
  /** Why this event maps the way it does. Read by a human, not by code. */
  readonly why: string
}

/**
 * Every collected event, and the funnel stage it contributes.
 *
 * `Record<AnalyticsEventName, …>` is the build failure: a sixth event name added to the taxonomy with no
 * entry here does not compile, so the taxonomy and the funnel cannot come apart in the direction that
 * matters (an event nobody decided anything about, quietly collected and never counted).
 */
export const COLLECTED_EVENT_FUNNEL: Readonly<
  Record<AnalyticsEventName, CollectedEventFunnelRule>
> = Object.freeze({
  page_view: Object.freeze({
    stage: 'landing',
    entryPageViewOnly: true,
    why:
      'The landing stage is the session ENTRY, so one session contributes exactly one landing and the ' +
      "funnel's first bucket is a count of sessions. Counting every page view would make the first " +
      'bucket a count of pages and every conversion rate below it meaningless.',
  }),
  service_viewed: Object.freeze({
    stage: 'service_viewed',
    entryPageViewOnly: false,
    why: 'A service page was read. A service is (style x treatment) — ADR 0021.',
  }),
  price_viewed: Object.freeze({
    stage: 'price_viewed',
    entryPageViewOnly: false,
    why:
      'Distinct from the service page on purpose: three services are price-on-request (Y9-poa-prices) ' +
      'and have no price to view, so folding the two would report a drop-off that is a catalogue fact.',
  }),
  cta_click: Object.freeze({
    stage: 'cta_click',
    entryPageViewOnly: false,
    why:
      'WhatsApp, Call or Book. For WhatsApp this is the last thing the system sees: the conversation ' +
      'moves into an app it has no access to (ADR 0018), which is what the ref code exists to bridge.',
  }),
  whatsapp_ref_shown: Object.freeze({
    stage: null,
    entryPageViewOnly: false,
    why:
      'Not a stage. It is the DENOMINATOR of ref-capture rate, which ADR 0018 requires be reported so ' +
      'that an unattributed booking is distinguishable from no booking. Counting it as a stage of its ' +
      'own would insert a step between the click and the booking that no customer performs.',
  }),
  web_vitals: Object.freeze({
    stage: null,
    entryPageViewOnly: false,
    why:
      'Not a stage, and not a thing a visitor did. A-MEAS-04 reports how fast the page was and what the ' +
      'slow part was attributed to; a reader who waited four seconds for the largest element has taken ' +
      'no step through the funnel, and counting it as one would put a bucket between the landing and the ' +
      'service page that nobody passes through. The reason it is collected at all is the other half of ' +
      'the same question the funnel asks: a drop-off between two stages and an INP of 600 ms on the ' +
      'route between them are the same finding read twice.',
  }),
})

/**
 * Every appointment status, and what a move into it does to the funnel.
 *
 * Read the `no_step` entries as carefully as the stages: each is a decision about what the funnel
 * measures, not an omission.
 */
export const APPOINTMENT_STATUS_FUNNEL: Readonly<Record<AppointmentStatus, FunnelOutcome>> =
  Object.freeze({
    requested: Object.freeze({
      kind: 'no_step',
      why:
        'Nothing transitions INTO requested — `APPOINTMENT_STATUS_ACTIONS.requested` is unreachable — ' +
        'so the booking_created stage is contributed by the `booking.created` event instead. Mapping ' +
        'this as well would count every booking twice.',
    }),
    confirmed: Object.freeze({ kind: 'stage', stage: 'confirmed' }),
    checked_in: Object.freeze({
      kind: 'no_step',
      why:
        'Arrival is recorded, and the funnel stage for arrival is `attended`, which is the treatment ' +
        'DELIVERED. A client who checked in and left before the treatment began is reachable from here ' +
        'to `no_show`, so counting check-in as attendance would count an attendance that did not happen.',
    }),
    in_progress: Object.freeze({
      kind: 'no_step',
      why:
        'A treatment that has begun is not yet delivered. Its only exit is `completed`, which is the ' +
        'stage, so a step here would be the same journey counted twice a few minutes apart.',
    }),
    completed: Object.freeze({ kind: 'stage', stage: 'attended' }),
    no_show: Object.freeze({ kind: 'excluded', reason: 'no_show' }),
    cancelled_by_customer: Object.freeze({ kind: 'excluded', reason: 'cancelled_by_customer' }),
    cancelled_by_salon: Object.freeze({ kind: 'excluded', reason: 'cancelled_by_salon' }),
    rescheduled: Object.freeze({ kind: 'excluded', reason: 'rescheduled' }),
  })

/**
 * The outbox event types the funnel reads that are NOT appointment lifecycle events.
 *
 * Spelled to match the two writers exactly — `packages/db/src/repositories/create-booking.ts` emits
 * `booking.created` and `packages/db/src/adapters/manual-payment.ts` emits `payment.recorded`. They are
 * literals here because there is no derivable source for them on this side of the boundary: both are
 * written in `packages/db`, which `core` may not import. `funnel.test.ts` pins both strings, so a rename
 * in either writer is a failing test rather than a funnel that silently stops at `confirmed`.
 */
export const FUNNEL_NON_LIFECYCLE_EVENT_TYPES = Object.freeze({
  booking_created: 'booking.created',
  payment_recorded: 'payment.recorded',
} as const)

/**
 * Every outbox event type a funnel collector needs to subscribe to, DERIVED.
 *
 * The appointment half comes from `eventTypeFor` over `APPOINTMENT_STATUSES` — the lifecycle table's own
 * event names, never restated here — narrowed to the statuses that actually produce a step. A subscriber
 * built from a hand-written list would either miss one (a stage that never appears) or carry a spare (a
 * handler that fires on `appointment.started` and decides nothing, which is the cost nobody notices).
 */
export const FUNNEL_DOMAIN_EVENT_TYPES: readonly string[] = Object.freeze([
  ...APPOINTMENT_STATUSES.flatMap((status) => {
    if (APPOINTMENT_STATUS_FUNNEL[status].kind === 'no_step') return []
    const eventType = eventTypeFor(status)
    return eventType === null ? [] : [eventType]
  }),
  FUNNEL_NON_LIFECYCLE_EVENT_TYPES.booking_created,
  FUNNEL_NON_LIFECYCLE_EVENT_TYPES.payment_recorded,
])

/**
 * One fact the funnel can be advanced by.
 *
 * Four sources, and the payment one carries a boolean rather than an amount because the stage is a
 * statement about a DOCUMENT being settled, not about money arriving: `payment.recorded` fires for a
 * partial payment too, and `settleTenders` already computes `fullySettled` in exactly one place
 * (`../money/tender.ts`). Re-deciding it here from figures would be a second answer to "is this invoice
 * paid", and the first symptom of a disagreement is a funnel that converts on a deposit.
 */
export type FunnelSignal =
  | { readonly source: 'collected'; readonly event: AnalyticsEvent }
  | { readonly source: 'appointment'; readonly status: AppointmentStatus }
  | { readonly source: 'booking_created' }
  | { readonly source: 'payment'; readonly settlesDocumentInFull: boolean }

/** What a collected event contributes, decided from the event and nothing else. */
export function funnelOutcomeForEvent(event: AnalyticsEvent): FunnelOutcome {
  const rule = COLLECTED_EVENT_FUNNEL[event.name]
  if (rule.stage === null) return { kind: 'no_step', why: rule.why }
  if (rule.entryPageViewOnly) {
    // The flag is not trusted on its own: the `entry` field is read off the validated payload, so a rule
    // that carried this flag on an event without one contributes nothing rather than contributing always.
    if (event.name !== 'page_view') {
      return {
        kind: 'no_step',
        why: `${event.name} is marked entry-page-only and carries no entry field, so it contributes nothing`,
      }
    }
    if (!event.payload.entry) {
      return {
        kind: 'no_step',
        why: 'a page view that is not the session entry contributes no landing; one session, one landing',
      }
    }
  }
  return { kind: 'stage', stage: rule.stage }
}

/** What any funnel signal does to the funnel. The whole mapping table, through one door. */
export function funnelOutcomeFor(signal: FunnelSignal): FunnelOutcome {
  switch (signal.source) {
    case 'collected':
      return funnelOutcomeForEvent(signal.event)
    case 'appointment':
      return APPOINTMENT_STATUS_FUNNEL[signal.status]
    case 'booking_created':
      return { kind: 'stage', stage: 'booking_created' }
    case 'payment':
      return signal.settlesDocumentInFull
        ? { kind: 'stage', stage: 'paid' }
        : {
            kind: 'no_step',
            why:
              'a payment that leaves the document outstanding is not the paid stage; a deposit is not a ' +
              'conversion, and `paid` is what the ad platforms are pushed',
          }
    default:
      return assertNever(signal, 'funnelOutcomeFor')
  }
}

/**
 * Which business day a funnel step lands on.
 *
 * `trading` carries the trading date; `outside_trading` carries the named reason and the calendar date
 * the instant fell on locally. The calendar date is deliberately NOT a trading date and must never be
 * used as one — it is here so a report can say *"09:14, before opening"* without re-deriving it.
 */
export type FunnelBucket =
  | { readonly kind: 'trading'; readonly tradingDate: LocalDate }
  | {
      readonly kind: 'outside_trading'
      readonly reason: OutsideTradingReason
      readonly calendarDate: LocalDate
    }

/** The instant and the trading calendar, both as arguments. There is no clock in this package. */
export interface FunnelBucketInput {
  readonly occurredAt: Instant
  readonly hoursFor: HoursForDate
  readonly zone?: TimeZone
}

export function funnelBucketFor(input: FunnelBucketInput): FunnelBucket {
  const resolution = resolveTradingDate(input.occurredAt, input.hoursFor, input.zone ?? ASIA_DUBAI)
  return resolution.kind === 'trading'
    ? { kind: 'trading', tradingDate: resolution.date }
    : {
        kind: 'outside_trading',
        reason: resolution.reason,
        calendarDate: resolution.calendarDate,
      }
}

/**
 * One funnel step, ready for the row A-FIRST-01's schema holds: a stage or an exclusion reason, and the
 * business day it is counted on.
 *
 * A `no_step` answer carries no bucket, which is the point of the shape rather than an omission: there is
 * no row to date.
 */
export type FunnelStep =
  | { readonly kind: 'stage'; readonly stage: FunnelStage; readonly bucket: FunnelBucket }
  | {
      readonly kind: 'excluded'
      readonly reason: FunnelExclusionReason
      readonly bucket: FunnelBucket
    }
  | { readonly kind: 'no_step'; readonly why: string }

export function funnelStepFor(
  input: FunnelBucketInput & { readonly signal: FunnelSignal },
): FunnelStep {
  const outcome = funnelOutcomeFor(input.signal)
  if (outcome.kind === 'no_step') return outcome
  const bucket = funnelBucketFor(input)
  return outcome.kind === 'stage'
    ? { kind: 'stage', stage: outcome.stage, bucket }
    : { kind: 'excluded', reason: outcome.reason, bucket }
}

/**
 * The stages this mapping can actually produce, in funnel order.
 *
 * Derived by walking the two tables plus the two signals that carry no table, and it is what
 * `funnel.test.ts` holds equal to `FUNNEL_STAGES`: a stage in the vocabulary that nothing maps to is a
 * bucket that is empty for ever, and nothing else in the build would say so.
 */
export const REACHABLE_FUNNEL_STAGES: readonly FunnelStage[] = Object.freeze(
  FUNNEL_STAGES.filter((stage) => {
    const fromEvents = Object.values(COLLECTED_EVENT_FUNNEL).some((rule) => rule.stage === stage)
    const fromStatuses = Object.values(APPOINTMENT_STATUS_FUNNEL).some(
      (outcome) => outcome.kind === 'stage' && outcome.stage === stage,
    )
    const fromBookingCreated = stage === 'booking_created'
    const fromPayment = stage === 'paid'
    return fromEvents || fromStatuses || fromBookingCreated || fromPayment
  }),
)

/**
 * The exclusion reasons this mapping can produce.
 *
 * Held equal to `FUNNEL_EXCLUSION_REASONS` by `funnel.test.ts`, and that equality is the only thing
 * standing between the vocabulary `packages/db` writes and the set of statuses that can end a journey.
 */
export const REACHABLE_FUNNEL_EXCLUSION_REASONS: readonly FunnelExclusionReason[] = Object.freeze(
  APPOINTMENT_STATUSES.flatMap((status) => {
    const outcome = APPOINTMENT_STATUS_FUNNEL[status]
    return outcome.kind === 'excluded' ? [outcome.reason] : []
  }),
)
