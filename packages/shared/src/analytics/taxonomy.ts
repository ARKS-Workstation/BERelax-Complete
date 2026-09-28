/**
 * The measurement plan as code (A-FIRST-02): the closed event taxonomy, and the ONE statement of the
 * funnel vocabulary.
 *
 * ## Why this is in `shared` and not in `core`
 *
 * Seven units read this vocabulary and no two of them may import each other. `@berelax/core` maps a
 * domain fact onto a funnel stage (`analytics/funnel.ts`), `@berelax/db` holds the `analytics` schema
 * whose `funnel_step.stage` and `funnel_step.excluded_reason` are these words (A-FIRST-01), the collect
 * route validates what a browser posted before either sees it, and the dashboard groups by them. `db`
 * must never import `core` (ADR 0001), so a vocabulary declared in either of those two would be
 * unreachable from the other. `shared` is the only package all of them may depend on, which is the same
 * argument `schemas/consent.ts` and `schemas/suppression.ts` make about themselves.
 *
 * ## The one rule this file exists to enforce: there is no second list of stage names
 *
 * {@link FUNNEL_STAGES} is a tuple and {@link FunnelStage} is derived from it, so a stage spelled
 * `cta_clicked` in a unit built next month does not typecheck — it is not a near-miss that compiles and
 * then produces a funnel with nine buckets, four of them empty. Everything else about the order is
 * derived from the same tuple as well: {@link FUNNEL_TERMINAL_STAGE} is its last element,
 * {@link funnelStageRank} is its index, and {@link funnelStagesAfter} is a slice. None of those is a
 * second opinion about which stage comes last, which is the shape of defect this build has already paid
 * for twice (`FLOW_END_REASONS` and `TENDER_TYPES` both carry the same note).
 *
 * ## No clock, no I/O, and nothing ambient
 *
 * Every function here is a lookup or a slice over its arguments. There is no `Date`, no `Intl` and no
 * `process`: the instant an event happened at is the CALLER's, because the funnel is bucketed on
 * `business_day` — trading runs 11:00 to 02:00 Asia/Dubai — and a module that read the clock would be
 * re-deriving a trading date its caller already resolved. `scripts/check-core-purity.mjs` scans this
 * directory for exactly that (it is the one tree outside `packages/core` the purity gate reads, and its
 * rules here are the stricter scoped set: no `Date` and no `Intl` at all), and
 * `analytics-taxonomy-must-be-pure` in `.dependency-cruiser.cjs` closes the import half.
 */
import { z } from 'zod'
// `../app-error.ts` and not the barrel: the barrel re-exports this module, so importing it from here
// would close a cycle `no-circular` refuses. That is why AppError is a leaf module at all.
import { AppError } from '../app-error.ts'
import { treatmentKeySchema, treatmentStyleSchema } from '../schemas/catalogue.ts'
import { whatsappRefCodeSchema } from '../whatsapp-ref.ts'

/**
 * The version of the taxonomy as a whole.
 *
 * One number for the whole plan rather than a version per event, because the question it answers is
 * "was this row collected under the vocabulary I am reading it with" — and every raw event is stamped
 * with it (A-FIRST-01 owns the column). Raw events are kept 90 days and the rollups for ever, so a
 * rollup built from a vocabulary that has since changed is the one thing a reader cannot otherwise
 * detect.
 *
 * Bumping it is a deliberate committed diff, exactly as adding a name to {@link ANALYTICS_EVENT_NAMES}
 * is: `taxonomy.test.ts` pins both against literals written out in the test.
 */
export const ANALYTICS_TAXONOMY_VERSION = 1

/**
 * The funnel, in order, ending at money. docs/03 §6 draws it:
 *
 *     landing -> service viewed -> price viewed -> CTA click (WhatsApp | Call | Book)
 *             -> booking created -> confirmed -> attended -> PAID
 *
 * The order is load-bearing, and the last three stages are the reason the funnel is worth building:
 * "roughly 5-15% of bookings do not turn up, so any funnel ending at 'booking created' overstates
 * itself and any ad platform optimising on that signal is optimising for no-shows too". A funnel whose
 * terminal stage were `booking_created` would report intent and call it business.
 *
 * `paid` is terminal because it is the only stage that is a statement about MONEY RECEIVED, and the
 * journal is where revenue truth lives (ADR 0017, ADR 0018). Nothing comes after it: a refund or a
 * credit note is a correction to a document and not a ninth stage — the funnel would otherwise have to
 * un-count a conversion, and `paid` is what the ad platforms are pushed.
 */
export const FUNNEL_STAGES = [
  /** The session's first page view. One session contributes exactly one landing. */
  'landing',
  /** A service page was read. A service is (style x treatment) — ADR 0021. */
  'service_viewed',
  /** The price block for a service was read. Distinct from the page: a price-on-request service has none. */
  'price_viewed',
  /** WhatsApp, Call or Book was clicked. See {@link CTA_TARGETS}. */
  'cta_click',
  /** A booking row exists. NOT terminal: it is a promise, and 5-15% of them do not arrive. */
  'booking_created',
  /** The salon accepted it. */
  'confirmed',
  /** The treatment was delivered — `completed` in the appointment lifecycle. */
  'attended',
  /** The document it produced is settled in full. The terminal stage. */
  'paid',
] as const

export type FunnelStage = (typeof FUNNEL_STAGES)[number]

/**
 * The last stage, DERIVED from the tuple rather than written again.
 *
 * `as const` makes the tuple's length known, so this is typed `'paid'` and not `FunnelStage | undefined`
 * — which means a stage appended to {@link FUNNEL_STAGES} moves this constant with no further edit, and
 * every `isTerminal` answer in the build moves with it. Writing `'paid'` here instead would be the
 * second statement of the order this whole module exists to prevent.
 */
export const FUNNEL_TERMINAL_STAGE = FUNNEL_STAGES[FUNNEL_STAGES.length - 1]

/** Where a stage sits in the order. `-1` is impossible for a `FunnelStage` and is asserted to be. */
export const funnelStageRank = (stage: FunnelStage): number => FUNNEL_STAGES.indexOf(stage)

/** The stages strictly after this one, in order. Empty for the terminal stage, by construction. */
export const funnelStagesAfter = (stage: FunnelStage): readonly FunnelStage[] =>
  FUNNEL_STAGES.slice(funnelStageRank(stage) + 1)

/**
 * True for the stage nothing follows. Derived from {@link funnelStagesAfter} and not from a comparison
 * against a literal, so "terminal" and "has nothing after it" cannot come apart.
 */
export const isTerminalFunnelStage = (stage: FunnelStage): boolean =>
  funnelStagesAfter(stage).length === 0

export const isFunnelStage = (value: string): value is FunnelStage =>
  (FUNNEL_STAGES as readonly string[]).includes(value)

export const funnelStageSchema = z.enum(FUNNEL_STAGES)

/**
 * Why a journey ended without reaching {@link FUNNEL_TERMINAL_STAGE}, as a value on the row.
 *
 * Every label is an appointment status: these are exactly `TERMINAL_APPOINTMENT_STATUSES` from
 * `@berelax/core`'s lifecycle table with `completed` removed, because `completed` is the one terminal
 * state that ADVANCES the funnel (to `attended`). `packages/core/src/analytics/funnel.test.ts` holds
 * the two equal in both directions — it is the one place that may import both — so a tenth appointment
 * status, or a member removed from either list, fails the build rather than producing a funnel that
 * silently drops a cohort.
 *
 * ## Why this list is repeated here at all
 *
 * `shared` cannot import `core`, and `db` must not either, yet `funnel_step.excluded_reason` is a
 * column in the `analytics` schema. So the words have to live where all three can reach them, and the
 * derivation is asserted rather than expressed. That is the same trade `TENDER_TYPES` makes against the
 * `tender_type` table and `FLOW_RUN_STATUSES` makes against `flow_run_status`.
 *
 * ## Why an exclusion is a REASON and not the absence of a row
 *
 * "No conversions" and "conversions we could not attribute" must be distinguishable — ADR 0018 states
 * it as the whole point of reporting ref-capture rate, and the same argument holds one stage earlier. A
 * no-show that produced no row at all reads as a customer who is still on their way to paying, for
 * ever.
 */
export const FUNNEL_EXCLUSION_REASONS = [
  /** The slot was promised and held, and nobody arrived. The acceptance line's reason. */
  'no_show',
  /** The customer withdrew. */
  'cancelled_by_customer',
  /** The salon could not deliver. Distinct from the customer's cancellation: ADR 0024, migration 0024. */
  'cancelled_by_salon',
  /**
   * This row was superseded by a successor (B-LIFE-03).
   *
   * Excluded rather than ignored, and that is a decision: the journey through THIS appointment stopped
   * here, and the successor is a different row with a lifecycle of its own. Treating a reschedule as
   * nothing would leave a row sitting at `confirmed` for ever, which reads as a booking that was never
   * resolved.
   */
  'rescheduled',
] as const

export type FunnelExclusionReason = (typeof FUNNEL_EXCLUSION_REASONS)[number]

export const isFunnelExclusionReason = (value: string): value is FunnelExclusionReason =>
  (FUNNEL_EXCLUSION_REASONS as readonly string[]).includes(value)

export const funnelExclusionReasonSchema = z.enum(FUNNEL_EXCLUSION_REASONS)

/**
 * The three things a call to action can be, in the words docs/03 §6 uses: "CTA click (WhatsApp | Call |
 * Book)".
 *
 * Closed, because each names a mechanism that exists on the site and a fourth would be new code rather
 * than a new opinion. `whatsapp` is the one that matters: it is the last thing the system sees before
 * the conversation moves into an app it has no access to, which is why the ref code exists.
 */
export const CTA_TARGETS = ['whatsapp', 'call', 'book'] as const
export type CtaTarget = (typeof CTA_TARGETS)[number]

/**
 * A first-party path, as posted by the browser. Query and fragment are deliberately NOT part of it.
 *
 * Origination — the UTM set and the click ids — is resolved once per session by A-FIRST-03 and stored on
 * the session row. Keeping the query string on every page view as well would put `gclid` in the raw
 * event payload of every hit, which is a second copy of an identifier with a shorter retention and no
 * reader.
 */
const pathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.startsWith('/'), {
    message: 'A collected path is site-relative and begins with "/".',
  })
  .refine((value) => !value.includes('?') && !value.includes('#'), {
    message:
      'A collected path carries no query or fragment; origination is resolved on the session.',
  })

/**
 * Which service a view was of, as (style x treatment) and never as a free-text name.
 *
 * Reuses the catalogue's own vocabulary (ADR 0021: a service IS style x treatment), so a funnel cannot
 * be grouped by a service spelling the catalogue does not have. It is also the reason no service NAME
 * reaches the store: docs/03 §6's egress guard maps services to opaque codes before anything leaves for
 * Google or Meta, and a name in the raw payload is the thing that later gets copied into a push.
 */
const serviceRefShape = {
  style: treatmentStyleSchema,
  treatment: treatmentKeySchema,
} as const

/**
 * Every collected event, and the payload each one carries.
 *
 * ## What is deliberately NOT in any payload
 *
 * The envelope. Visitor id, session id and the instant are columns A-FIRST-01 owns, and the instant in
 * particular is passed to {@link funnelStageRank}'s neighbours in `@berelax/core` as an ARGUMENT — this
 * package reads no clock. A payload that repeated any of the three would be a second copy of a fact the
 * row already states, differing from it whenever a client's clock is wrong.
 *
 * ## Why the set is closed at five
 *
 * docs/03 §6 warns that "every interaction" is unbounded and that the volume discipline is what keeps
 * the event table from becoming the largest object in the database. Each of these five is named by a
 * document: `page_view` by docs/02 §4 in so many words, the three middle stages by the funnel drawing
 * in docs/03 §6, and `whatsapp_ref_shown` by ADR 0018's requirement that ref-capture rate be reported —
 * a rate needs a denominator, and this is it. A sixth is a deliberate committed diff with a schema.
 */
const pageViewPayloadSchema = z.strictObject({
  path: pathSchema,
  /**
   * Was this the page the session ENTERED on?
   *
   * The `landing` stage is the session's first page view and not every page view, so one session
   * contributes exactly one landing and the funnel's first bucket is a count of sessions. The collect
   * route knows this because it is what creates the session row (`session.entry_page`, docs/02 §4); it
   * is a field on the event rather than something derived downstream so that the stage can be decided
   * by a pure function of what arrived.
   */
  entry: z.boolean(),
})

const serviceViewedPayloadSchema = z.strictObject({ ...serviceRefShape, path: pathSchema })

const priceViewedPayloadSchema = z.strictObject({ ...serviceRefShape, path: pathSchema })

const ctaClickPayloadSchema = z.strictObject({
  target: z.enum(CTA_TARGETS),
  path: pathSchema,
})

const whatsappRefShownPayloadSchema = z.strictObject({
  /**
   * The code that went into the prefilled message, validated by the ONE pattern that defines a ref code
   * (`whatsapp-ref.ts`). Reused rather than re-expressed: the quick-book field, the HTML pattern, the
   * normaliser and this schema all read `WHATSAPP_REF_CODE_PATTERN`.
   */
  refCode: whatsappRefCodeSchema,
})

/** The closed set of collected event names. A tuple, so {@link AnalyticsEventName} is derived from it. */
export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'service_viewed',
  'price_viewed',
  'cta_click',
  'whatsapp_ref_shown',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export const analyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES)

/**
 * The registry: one Zod schema per event name.
 *
 * `satisfies Record<AnalyticsEventName, z.ZodType>` is the build failure the acceptance asks for in both
 * directions — a name added to {@link ANALYTICS_EVENT_NAMES} with no schema here does not compile, and a
 * schema here under a name the tuple does not hold is an excess property. `as const satisfies` rather
 * than an annotation, because an annotation would widen every value to `z.ZodType` and
 * {@link AnalyticsEventPayload} would infer `unknown` for every event — a payload type that accepts
 * anything, which is the vacuous version of this whole file.
 */
export const ANALYTICS_EVENT_SCHEMAS = {
  page_view: pageViewPayloadSchema,
  service_viewed: serviceViewedPayloadSchema,
  price_viewed: priceViewedPayloadSchema,
  cta_click: ctaClickPayloadSchema,
  whatsapp_ref_shown: whatsappRefShownPayloadSchema,
} as const satisfies Readonly<Record<AnalyticsEventName, z.ZodType>>

/** The validated payload of one named event, derived from that event's own schema. */
export type AnalyticsEventPayload<N extends AnalyticsEventName> = z.infer<
  (typeof ANALYTICS_EVENT_SCHEMAS)[N]
>

/**
 * A validated event: the name and the payload that name's schema produced.
 *
 * A discriminated union DERIVED from the name tuple by a mapped type, so it cannot fall out of step with
 * the registry. Written out by hand it would be a sixth statement of the name list.
 */
export type AnalyticsEvent = {
  [N in AnalyticsEventName]: { readonly name: N; readonly payload: AnalyticsEventPayload<N> }
}[AnalyticsEventName]

export const isAnalyticsEventName = (value: string): value is AnalyticsEventName =>
  (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value)

/**
 * Raised when a name the registry does not hold reaches the collector.
 *
 * ## Why a named error and not a `null` or a `false`
 *
 * `/api/collect` is a write path exposed to the internet (ADR 0018), so the caller is a browser, a bot,
 * or somebody probing. Every one of those sends a name nobody defined, and the two wrong answers are
 * symmetrical: storing it produces a raw partition full of vocabulary no reporting query knows, and
 * silently dropping it makes a typo in a real tag indistinguishable from an attack. A named error is
 * what lets the route answer 422 and the dashboard count the refusals.
 *
 * `AppError` with kind `validation` for the reason every other refusal in this repository is one: the
 * error taxonomy is what the route layer translates, and a bare `Error` reaches a visitor as a 500.
 */
export class UnknownEventError extends AppError {
  readonly eventName: string

  constructor(eventName: string) {
    super(
      'validation',
      `UnknownEventError: "${eventName}" is not an event in the taxonomy. It holds ` +
        `${ANALYTICS_EVENT_NAMES.join(', ')} at version ${ANALYTICS_TAXONOMY_VERSION}; adding one is a ` +
        'committed diff carrying a Zod schema, because an event nothing validates is a partition of ' +
        'rows no reporting query can read.',
      { details: { eventName, known: ANALYTICS_EVENT_NAMES } },
    )
    this.name = 'UnknownEventError'
    this.eventName = eventName
  }
}

/**
 * The schema for a name that arrived as a `string`, or {@link UnknownEventError}.
 *
 * ## Membership is decided by the TUPLE, never by indexing the registry
 *
 * The obvious implementation reads the registry through a `Record<string, …|undefined>` view and treats
 * `undefined` as unknown. It is wrong, and this file's own suite caught it: the registry is an ordinary
 * object literal, so `ANALYTICS_EVENT_SCHEMAS['constructor']` resolves to `Object` through the prototype
 * chain and `['toString']` to a function. A browser posting `{"name":"constructor"}` to `/api/collect`
 * — a write path exposed to the internet (ADR 0018) — therefore got a "schema" with no `.parse`, and the
 * route answered 500 on a `TypeError` instead of 422 on a named refusal. `toString`, `valueOf`,
 * `hasOwnProperty` and `__proto__` are the same hole.
 *
 * So the closed list is the authority: {@link isAnalyticsEventName} tests membership of
 * {@link ANALYTICS_EVENT_NAMES}, which inherits nothing, and only a name that passed is indexed. That is
 * also the derivation this whole module is about — one source for what an event name is.
 */
export function analyticsEventSchemaFor(name: string): z.ZodType {
  if (!isAnalyticsEventName(name)) throw new UnknownEventError(name)
  return ANALYTICS_EVENT_SCHEMAS[name]
}

/**
 * Validates one collected event.
 *
 * Throws {@link UnknownEventError} for a name outside the taxonomy and Zod's own `ZodError` for a
 * payload that fails its schema — two different faults with two different answers, which is why they
 * are not folded into one refusal: an unknown name is a tag nobody deployed, and a bad payload is a tag
 * that was deployed wrongly.
 *
 * The return is cast once, here, and the cast is what the `satisfies` above earns: `name` has been
 * proved to be an `AnalyticsEventName` and `payload` is what that name's own schema produced, but
 * TypeScript cannot carry the correlation between two separately-narrowed values into the union.
 */
export function parseAnalyticsEvent(name: string, payload: unknown): AnalyticsEvent {
  const parsed = analyticsEventSchemaFor(name).parse(payload)
  return { name, payload: parsed } as AnalyticsEvent
}

/**
 * The questions this taxonomy stands on, by their `docs/OPEN-QUESTIONS.md` id.
 *
 * Named rather than described, so the gate can assert each one is a row in that document and a reader
 * can see which part of the plan is a decision and which is a placeholder (brief rule 15).
 */
export const ANALYTICS_OPEN_QUESTIONS = {
  /** The lawful basis for the internal store. Blocks `A-FIRST` go-live, not the taxonomy. */
  basis: 'Y5-analytics-basis',
  /** Whether the desk pastes the ref code. It is why `whatsapp_ref_shown` is collected at all. */
  refLoop: 'Y12-ref-loop',
  /**
   * Which trading date an event in the daytime gap belongs to. Trading runs 11:00-02:00, so an event at
   * 09:00 falls inside no session, and this unit refuses to guess: `funnelStepFor` returns the named
   * `OutsideTradingReason` instead of quietly bucketing on the calendar date.
   */
  gapBucket: 'Y5-funnel-gap-bucket',
} as const
