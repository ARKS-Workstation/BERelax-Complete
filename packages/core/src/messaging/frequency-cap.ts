/**
 * The global frequency cap: one rolling-window count per contact, shared by every flow and campaign.
 *
 * ## What the cap is for, and why it cannot be per campaign
 *
 * Three unrelated journeys — a win-back sequence, a birthday greeting and a February campaign — each
 * sending "only one message" collectively spam one person, and each of the three is individually
 * defensible. So the count is per CONTACT and the caps are read from one place: a per-campaign cap may
 * only ever be stricter (C-AUTO-10 owns that), and there is no arrangement of per-campaign caps that
 * adds up to this one.
 *
 * ## Why this module holds no clock and no ledger
 *
 * `packages/core` is pure (module boundary rule 4), so the instants come in as arguments and the ledger
 * rows come in as a list of instants. That is not a purity ritual: the rolling window has to be asserted
 * TO THE SECOND against a frozen clock, and a module that read the clock could only be tested to the
 * day. The instants a caller passes are the ones `frequency_ledger.counted_at` holds, which is the
 * column a refused attempt leaves NULL — see `packages/db/src/repositories/frequency-ledger.ts`.
 *
 * Every instant is rendered for a message through `instantToIso` rather than `new Date(...)`, because
 * `scripts/check-core-purity.mjs` bans the `Date` token throughout `packages/core/src/messaging`. That
 * scope was written for the authoring-time cost figures, whose whole point is that they take no
 * instant, and the ban is worth respecting here anyway: one converter means an instant cannot come to
 * be formatted two ways, and the only reason this module renders one at all is a refusal message.
 *
 * ## The window is rolling, and both ends of that matter
 *
 * "2 per week" is **not** two per calendar week. A calendar week resets at midnight on a chosen day, so
 * a contact messaged twice on Sunday evening can be messaged twice more on Monday morning — four
 * messages in twelve hours, every one of them inside the cap. The window is therefore the half-open
 * interval `(now - windowSeconds, now]`: a send at exactly `now - windowSeconds` has aged out, and a
 * send one second later has not. {@link countInWindow} is where that boundary lives, once.
 *
 * ## The caps are provisional (`Y9-frequency-cap`) and cannot be switched off
 *
 * Nobody has stated this business's marketing frequency. `PROVISIONAL_FREQUENCY_CAPS` carries the
 * OPEN-QUESTIONS provisional value — 2 per rolling 7 days and 6 per rolling 30 days — and both figures
 * reach the database as `app_setting` rows flagged `is_provisional` with that question id, so they
 * appear in the Unconfirmed Assumptions panel and leave it by being confirmed.
 *
 * What is NOT configurable is the existence of the cap. {@link assertFrequencyCapLimit} refuses `0`,
 * `null` and `'unlimited'`, and migration 0080 refuses the same three in the database. A cap of `0`
 * looks like the strictest possible setting and is in fact the ambiguous one: in every system that has
 * ever had a `max_` setting, `0` has also meant "no limit", and a reader that treats it as falsy
 * ("no cap configured, so allow") turns the strictest value into the switched-off one. Stopping
 * promotional traffic altogether is the marketing kill switch's job (C-AUTO-05), which says so on its
 * face and writes an audit row naming who engaged it.
 */
import type { MessageClass } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { type Instant, instantToIso } from '../time.ts'

/** The OPEN-QUESTIONS id every cap figure in this module is provisional until. */
export const FREQUENCY_CAP_OPEN_QUESTION = 'Y9-frequency-cap'

export const FREQUENCY_CAP_KEYS = ['week', 'month'] as const
export type FrequencyCapKey = (typeof FREQUENCY_CAP_KEYS)[number]

/** One rolling-window cap. `windowSeconds` is the window, not a calendar period — see the header. */
export interface FrequencyCap {
  readonly key: FrequencyCapKey
  /** The `app_setting` key the limit is read from, so a refusal can name where to change it. */
  readonly settingKey: string
  /** Promotional sends permitted inside the window. At least 1; see {@link assertFrequencyCapLimit}. */
  readonly limit: number
  readonly windowSeconds: number
}

const DAY_SECONDS = 86_400

/**
 * The window lengths, in seconds, and why they are 7 and 30 days rather than "a week" and "a month".
 *
 * A month is not a duration — February and August differ by three days — so a cap expressed as "per
 * month" has to be pinned to a number before anything can count it. 30 days is the shorter reading of
 * the two obvious ones (30 versus 31), which makes it the stricter, which is what a provisional value
 * has to be (docs/12 §2).
 */
export const FREQUENCY_CAP_WINDOW_SECONDS: Readonly<Record<FrequencyCapKey, number>> =
  Object.freeze({
    week: 7 * DAY_SECONDS,
    month: 30 * DAY_SECONDS,
  })

export const FREQUENCY_CAP_SETTING_KEYS: Readonly<Record<FrequencyCapKey, string>> = Object.freeze({
  week: 'messaging.frequency_cap_per_week',
  month: 'messaging.frequency_cap_per_month',
})

/**
 * The provisional caps, ordered LONGEST WINDOW FIRST.
 *
 * The order is what a reader of a refusal sees first and nothing depends on it for correctness:
 * {@link boundBreachOf} computes the bound cap rather than taking the front of the list, so a reorder here
 * changes which breach is listed first and not which one is named.
 */
export const PROVISIONAL_FREQUENCY_CAPS: readonly FrequencyCap[] = Object.freeze([
  Object.freeze({
    key: 'month' as const,
    settingKey: FREQUENCY_CAP_SETTING_KEYS.month,
    limit: 6,
    windowSeconds: FREQUENCY_CAP_WINDOW_SECONDS.month,
  }),
  Object.freeze({
    key: 'week' as const,
    settingKey: FREQUENCY_CAP_SETTING_KEYS.week,
    limit: 2,
    windowSeconds: FREQUENCY_CAP_WINDOW_SECONDS.week,
  }),
])

/**
 * Refuses a limit that is not a cap, by the same three spellings migration 0080 refuses.
 *
 * `unknown` rather than `number` on purpose: the value arrives from `app_setting.value`, which is
 * `jsonb`, and the whole point is to refuse what a `number` signature would never see. `0`, `null` and
 * `'unlimited'` are the three ways "switch the cap off" is actually written in a change request, and the
 * message says where the off switch really is so that the refusal is answerable rather than annoying.
 */
export function assertFrequencyCapLimit(settingKey: string, value: unknown): number {
  const problem = limitProblem(value)
  if (problem === null) return value as number
  throw new AppError(
    'validation',
    `"${settingKey}" is ${describeLimit(value)}, which is not a cap: ${problem}. The frequency cap ` +
      'cannot be switched off, set to zero, set to null or set to "unlimited" — three unrelated ' +
      'journeys each sending "only one message" is how one contact is spammed inside every rule. To ' +
      'stop promotional traffic, engage the marketing kill switch, which says so on its face and ' +
      'records who engaged it.',
    {
      userFacing: true,
      details: { settingKey, value, openQuestionId: FREQUENCY_CAP_OPEN_QUESTION },
    },
  )
}

function limitProblem(value: unknown): string | null {
  if (typeof value !== 'number') {
    return `a cap is a whole number of messages and this is ${value === null ? 'null' : typeof value}`
  }
  if (!Number.isInteger(value)) return 'a fractional cap cannot be compared against a count of rows'
  if (value < 1) {
    return value === 0
      ? 'zero reads as "no limit" in every other max_ setting anybody has met, so it is refused here ' +
          'rather than left to mean two opposite things'
      : 'a negative cap has no meaning'
  }
  return null
}

const describeLimit = (value: unknown): string =>
  value === null
    ? 'null'
    : typeof value === 'string'
      ? `the string ${JSON.stringify(value)}`
      : `${String(value)}`

/** Builds the cap set from values read out of storage, refusing any that is not a cap. */
export function frequencyCapsFrom(
  limits: Readonly<Record<FrequencyCapKey, unknown>>,
): readonly FrequencyCap[] {
  // Built from PROVISIONAL_FREQUENCY_CAPS so the ORDER and the window lengths come from one place: a
  // caller that assembled its own array could reorder the breaches and change which cap is reported.
  return Object.freeze(
    PROVISIONAL_FREQUENCY_CAPS.map((cap) =>
      Object.freeze({
        ...cap,
        limit: assertFrequencyCapLimit(cap.settingKey, limits[cap.key]),
      }),
    ),
  )
}

/** The earliest instant a send still counts at. Exclusive: a send exactly here has aged out. */
export function frequencyWindowStart(now: Instant, cap: FrequencyCap): Instant {
  return (now - cap.windowSeconds * 1000) as Instant
}

/**
 * How many of `countedAt` fall inside the cap's window at `now`.
 *
 * The comparison is `>` and not `>=`, which is the whole of the boundary assertion: with the cap spent
 * at day 0, an attempt at day 7 minus one second is refused and an attempt at day 7 exactly is
 * permitted. `>=` would hold the contact one second longer than the rule says, every time, for ever —
 * a defect no calendar-week test could see.
 */
export function countInWindow(
  countedAt: readonly Instant[],
  now: Instant,
  cap: FrequencyCap,
): number {
  const start = frequencyWindowStart(now, cap)
  // A send in the FUTURE is not counted either. It cannot happen from the send path — the ledger is
  // written from the same clock the decision uses — but it can happen from a backfill with a wrong
  // instant, and counting it would refuse sends for a month over one bad row.
  return countedAt.filter((instant) => instant > start && instant <= now).length
}

export interface FrequencyCapBreach {
  readonly cap: FrequencyCap
  /** Sends already counted inside this cap's window. At or above `cap.limit` for a breach. */
  readonly countInWindow: number
}

export interface FrequencyCapHeadroom {
  readonly cap: FrequencyCap
  readonly countInWindow: number
  readonly remaining: number
}

export type FrequencyCapDecision =
  /**
   * Transactional. Permitted in every cap state, and — this is the half that is not about permission —
   * NOT counted, so it must never be written to the ledger. A booking confirmation that spent a
   * marketing allowance would silence the marketing this business is allowed to do, and an OTP that
   * did it would make the cap a function of how often somebody logs in.
   */
  | { readonly kind: 'not_counted'; readonly reason: 'transactional' }
  | { readonly kind: 'permitted'; readonly headroom: readonly FrequencyCapHeadroom[] }
  | {
      readonly kind: 'capped'
      /**
       * Every cap that refuses, in the order the cap SET was given. Never empty.
       *
       * The order is the caller's and not a property of this type: `frequencyCapsFrom` fixes it to
       * longest-window-first, and a caller that assembles its own array in another order gets that order
       * back. Which is why {@link bound} is computed rather than being `breaches[0]`.
       */
      readonly breaches: readonly FrequencyCapBreach[]
      /** The one recorded on the ledger row and shown to a human. Computed; see `boundBreachOf`. */
      readonly bound: FrequencyCapBreach
    }

export interface FrequencyCapInput {
  readonly messageClass: MessageClass
  readonly now: Instant
  /** The `counted_at` of every promotional send already recorded against this contact. */
  readonly countedAt: readonly Instant[]
  readonly caps: readonly FrequencyCap[]
  /**
   * The earliest instant `countedAt` was fetched from, when the caller fetched rather than enumerated.
   *
   * This is the guard against the one silent way a correct cap under-counts. The ledger read has a
   * horizon — `where counted_at > $since` — and if that horizon is NEWER than a cap's window start, every
   * send between the two is missing from `countedAt` and that cap counts too few. Nothing about the
   * answer looks wrong: the decision is `permitted` with a plausible count, and an under-counted cap is
   * indistinguishable from not having one.
   *
   * So a caller that fetched states its horizon and {@link decideFrequencyCap} refuses one that does not
   * reach far enough back. Optional only because a pure caller that passes a literal list of instants has
   * no horizon to state — `frequencyCapGateEvaluator` requires it, which is the path every real send
   * takes.
   */
  readonly countedSince?: Instant
}

/**
 * How far back a ledger read has to reach for these caps: the widest window.
 *
 * Derived rather than written down, so a third cap added to the set cannot leave the read fetching the
 * old horizon — which is exactly the under-count `countedSince` exists to refuse, arriving as a
 * refusal at the next send instead of as a quietly wrong count.
 */
export function frequencyLedgerHorizonSeconds(caps: readonly FrequencyCap[]): number {
  return caps.reduce((widest, cap) => Math.max(widest, cap.windowSeconds), 0)
}

/**
 * Whether one promotional send is permitted, and if not, which cap refused it.
 *
 * Transactional traffic returns `not_counted` on the first line, before any cap is consulted. That is
 * the same shape `evaluateGate` uses for the same reason (ADR 0016): a marketing rule that can stop an
 * OTP is a marketing decision that has become an operational outage.
 */
export function decideFrequencyCap(input: FrequencyCapInput): FrequencyCapDecision {
  if (input.messageClass === 'transactional') {
    return { kind: 'not_counted', reason: 'transactional' }
  }
  if (input.caps.length === 0) {
    // An empty cap set is not "no cap configured, so allow": it is a caller that read no settings, and
    // allowing on it is precisely the switched-off state this module refuses to be able to reach.
    throw new AppError(
      'invariant_violated',
      'decideFrequencyCap was given no caps at all. An unread cap is not an allowance — the send stops ' +
        'until the settings are readable.',
      { details: { openQuestionId: FREQUENCY_CAP_OPEN_QUESTION } },
    )
  }

  assertHorizonReachesEveryWindow(input)

  const measured = input.caps.map(
    (cap): FrequencyCapBreach => ({
      cap,
      countInWindow: countInWindow(input.countedAt, input.now, cap),
    }),
  )
  const breaches = measured.filter((m) => m.countInWindow >= m.cap.limit)
  const bound = boundBreachOf(breaches)
  if (bound !== null) return { kind: 'capped', breaches, bound }

  return {
    kind: 'permitted',
    headroom: measured.map((m) => ({ ...m, remaining: m.cap.limit - m.countInWindow })),
  }
}

/** Refuses a ledger read that does not reach as far back as the widest cap's window. See `countedSince`. */
function assertHorizonReachesEveryWindow(input: FrequencyCapInput): void {
  const since = input.countedSince
  if (since === undefined) return
  for (const cap of input.caps) {
    const start = frequencyWindowStart(input.now, cap)
    if (since > start) {
      throw new AppError(
        'invariant_violated',
        `The frequency ledger was read from ${instantToIso(since)}, which is after the start ` +
          `of the ${cap.key} cap's window (${instantToIso(start)}). Every send between those ` +
          'two instants is missing from the count, so the cap would permit a send it should refuse — and ' +
          'nothing about the answer would look wrong. Read from frequencyLedgerHorizonSeconds().',
        {
          details: {
            cap: cap.key,
            windowSeconds: cap.windowSeconds,
            readFrom: instantToIso(since),
            windowStart: instantToIso(start),
          },
        },
      )
    }
  }
}

/**
 * Which of several simultaneous breaches is "the cap that bound them": the LONGEST window.
 *
 * Both readings are defensible and one of them is wrong in the way that matters. Reporting the shortest
 * window would name the cap that frees up soonest, so a contact who has spent both the 7-day and the
 * 30-day allowance would be told "you can message them again in two days" when the real answer is three
 * weeks — an under-statement, which is the direction that produces a second refused attempt and a
 * support ticket. Every cap in `breaches` is a true refusal; naming the widest one cannot under-state.
 *
 * `breaches` arrives in whatever order the cap set was given, which for a `frequencyCapsFrom` set is
 * longest-window first — so for every real send this IS `breaches[0]`. It is computed rather than read off
 * the front for exactly that reason: the guarantee would then belong to the array, and a reorder of
 * `PROVISIONAL_FREQUENCY_CAPS` would silently start naming the week cap. `frequency-cap.test.ts` drives
 * the caps in the reverse order and asserts the same answer.
 */
function boundBreachOf(breaches: readonly FrequencyCapBreach[]): FrequencyCapBreach | null {
  let widest: FrequencyCapBreach | null = null
  for (const breach of breaches) {
    if (widest === null || breach.cap.windowSeconds > widest.cap.windowSeconds) widest = breach
  }
  return widest
}

// ------------------------------------------------------------------------------------------------
// The gate's evaluator
// ------------------------------------------------------------------------------------------------

/** What the gate asks about. The gate's `OutboundMessage` satisfies it structurally. */
export interface FrequencyCapAskedOf {
  readonly messageClass: MessageClass
  /** E.164 for sms and whatsapp, an address for email. The key the prefetched map is built on. */
  readonly recipient: string
}

export interface FrequencyCapEvaluatorInput {
  /**
   * One cap state per recipient, keyed exactly as `message.recipient` spells it.
   *
   * A `Map` rather than a record, for `suppressionGateEvaluator`'s reason: the keys are E.164 numbers
   * and addresses, and a plain object would answer for `__proto__` and `constructor`.
   */
  readonly countedAt: ReadonlyMap<string, readonly Instant[]>
  readonly at: Instant
  readonly caps: readonly FrequencyCap[]
  /** The ledger read's horizon. REQUIRED here: every real send goes through this path. */
  readonly countedSince: Instant
}

/**
 * Builds the gate's `frequencyCapReached` evaluator over a prefetched ledger read.
 *
 * A recipient with no entry **throws**, exactly as `suppressionGateEvaluator` does, and `evaluateGate`
 * records that as `blocked_unevaluable` with `evaluator: 'frequency_cap'`. The distinction is the one
 * that decides whether an unreadable ledger is a stopped campaign or an uncapped one: `false` means the
 * ledger was read and this contact has headroom, and a throw means the ledger was not read about this
 * contact at all. A campaign that answered `false` for every recipient its prefetch missed would report
 * a clean run having sent past the cap to exactly the contacts it knew least about.
 *
 * A TRANSACTIONAL message answers `false` without consulting the map, and does so deliberately even
 * though `evaluateGate` returns `allow` before ever calling this: a missing prefetch entry must not be
 * able to turn an OTP into a refusal through a path nobody exercises.
 */
export function frequencyCapGateEvaluator(
  input: FrequencyCapEvaluatorInput,
): (message: FrequencyCapAskedOf) => boolean {
  return (message) => {
    if (message.messageClass === 'transactional') return false
    const countedAt = input.countedAt.get(message.recipient)
    if (countedAt === undefined) {
      throw new AppError(
        'invariant_violated',
        'No frequency-ledger state was prefetched for the recipient of this promotional message. An ' +
          'unread ledger is not an allowance: the recipient list and the ledger prefetch have drifted ' +
          'apart, and the send stops until they agree.',
        { details: { messageClass: message.messageClass } },
      )
    }
    return (
      decideFrequencyCap({
        messageClass: message.messageClass,
        now: input.at,
        countedAt,
        caps: input.caps,
        countedSince: input.countedSince,
      }).kind === 'capped'
    )
  }
}
