/**
 * What a campaign will cost before it runs, and when it may run at all.
 *
 * C-AUTO-10. Three of the unit's acceptance lines meet here, and none of them is arithmetic this module
 * invents:
 *
 *   - the pre-launch estimate is {@link estimateCampaign}, over `messaging/segments.ts`'s segmentation
 *     and price table — the SAME functions the choke point costs a message with, so "the estimate equals
 *     the outcome to the fils" is a property of one calculation rather than an agreement between two;
 *   - the authoring-time refusal is {@link scheduleCampaign}, over
 *     `messaging/promotional-window.ts`'s {@link decidePromotionalWindow} — because *"window-aware"*
 *     means the promotional window already exists, and a second window is a second answer to when a
 *     message may be sent;
 *   - the 21:00 boundary is {@link campaignSendWindowVerdict}, which is the same decision taken again per
 *     message. A campaign scheduled at 20:55 is inside the window when it starts and outside it five
 *     minutes later, and nothing about the schedule can say that: only the instant each message is about
 *     to leave at can.
 *
 * ## Why the estimate is a COUNT times a per-message cost and not a sum over recipients
 *
 * One campaign is one body, so every recipient's message segments identically and costs identically.
 * Summing per recipient would be the same number reached in a way that invites a per-recipient
 * adjustment, and a per-recipient adjustment is what makes an estimate unreconcilable: the acceptance
 * line asks for equality to the fils against the fake provider's own outcome, and equality holds only
 * while there is one multiplication to check.
 *
 * `smsCampaignCost` already refuses a fractional recipient count through `multiply`, which is the right
 * failure: a fractional count means the caller handed over an average rather than a row count.
 *
 * ## Pure
 *
 * No clock and no `Date`. Every instant is an argument, and the window ceiling is an argument for
 * `promotional-window.ts`'s stated reason: the figure is `messaging.promotional_window`'s registry
 * default and a copy of it here would be a second ceiling for the gate and the admin panel to disagree
 * over.
 */
import { AppError } from '@berelax/shared'
import {
  type DatedPromotionalOverride,
  decidePromotionalWindow,
  nextPromotionalOpen,
  type PromotionalHours,
} from '../messaging/promotional-window.ts'
import {
  type SmsPriceProvider,
  segmentSms,
  smsCampaignCost,
  smsCost,
} from '../messaging/segments.ts'
import { type Money, money } from '../money.ts'
import { type Instant, instantToIso, type LocalDateTime, type TimeZone } from '../time.ts'

/**
 * What a campaign will cost, stated the way the acceptance line asks it to be stated.
 *
 * All four figures, because a total on its own cannot be checked. *"Recipients after consent,
 * suppression and cap filtering; segments per message; total fils"* is three numbers and a
 * multiplication, and a screen showing only the third states a cost nobody can reconcile against an
 * invoice.
 */
export interface CampaignEstimate {
  /** After consent, suppression and the cap — the count the SEND will enumerate, not the segment's. */
  readonly recipients: number
  /** Segments ONE message breaks into. The same for every recipient: one campaign is one body. */
  readonly segmentsPerMessage: number
  /** What one message costs. */
  readonly perMessage: Money
  /** `perMessage * recipients`, exactly. Integer fils, so there is nothing to round. */
  readonly total: Money
  /** Which encoding the body forced, and what forced it. The figure that changes a decision. */
  readonly encoding: 'GSM-7' | 'UCS-2'
  readonly forcedBy: readonly string[]
  /** The OPEN-QUESTIONS id the per-segment price is provisional until. */
  readonly provisionalUntil: string
}

/** The two encodings, as `segments.ts` names them, re-stated for the estimate's own field type. */
type CampaignEncoding = CampaignEstimate['encoding']

/**
 * What a campaign will cost before anybody presses send.
 *
 * `recipients` is the count AFTER consent, suppression and the cap have been applied — this function
 * does not apply them and must not, because consent and suppression are stored state and this package
 * may not read a database. A caller handing over a segment's raw count would get an estimate for a send
 * that will not happen, which is the one way this figure can be wrong without being arithmetic.
 */
export function estimateCampaign(args: {
  readonly provider: SmsPriceProvider
  readonly body: string
  readonly recipients: number
}): CampaignEstimate {
  const preview = smsCost(args.provider, args.body)
  const segmentation = segmentSms(args.body)
  return {
    recipients: args.recipients,
    segmentsPerMessage: segmentation.segments,
    perMessage: preview.total,
    total: smsCampaignCost(args.provider, args.body, args.recipients),
    encoding: segmentation.encoding as CampaignEncoding,
    forcedBy: segmentation.forcedBy,
    provisionalUntil: preview.provisionalUntil,
  }
}

/** The estimate's total in fils, which is what `campaign.estimated_fils` stores. */
export const estimateTotalFils = (estimate: CampaignEstimate): number => estimate.total.fils

/** Zero fils of a campaign's currency, for the estimate of a campaign with no recipients. */
export const noCampaignSpend = (): Money => money(0 as Money['fils'])

export type CampaignScheduleDecision =
  | { readonly kind: 'accepted'; readonly scheduledAt: Instant; readonly hours: PromotionalHours }
  | {
      readonly kind: 'refused'
      readonly rule: 'campaign-scheduled-outside-the-promotional-window'
      /** The instant the window next opens. The thing an author needs and would otherwise guess. */
      readonly nextValidInstant: Instant
      readonly hours: PromotionalHours
      readonly detail: string
    }

/**
 * Whether a campaign may be scheduled at this instant, and if not, when it may.
 *
 * ## Why the refusal carries the next valid instant rather than the hours
 *
 * An author who is told "07:00–21:00" at 22:30 on the night before a narrowed day will schedule 07:00
 * and be refused again — because the narrowing is a dated row and the opening that night is 10:00.
 * `nextPromotionalOpen` already resolves the overrides on every day it looks at, which is precisely why
 * the answer here is an INSTANT: a rule stated as hours is a rule the author has to apply, and the
 * override is the part they cannot see.
 *
 * ## Why the decision is a value and the throw is a separate function
 *
 * The admin screen needs the refusal as data — it renders the next opening as a button that fills the
 * field in. A route handler needs it as a throw. {@link scheduleCampaignOrThrow} is the second, over the
 * first, so there is one reading of the rule and two shapes of answer.
 *
 * A TRANSACTIONAL campaign is not a thing: the class comes from the template and
 * `decidePromotionalWindow` answers `not_applicable` for one. That answer is refused here rather than
 * passed through, because a campaign is promotional by definition — it is a message to a list, aimed at
 * selling something — and a transactional template on a campaign is a routing mistake the choke point
 * would catch later and a scheduling screen should not have accepted.
 */
export function scheduleCampaign(args: {
  readonly at: Instant
  /** `at` in the business zone, read by the caller so one clock reader serves the whole decision. */
  readonly local: LocalDateTime
  readonly zone: TimeZone
  /** The regulator's hours. Never a copy — see the header. */
  readonly ceiling: PromotionalHours
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
}): CampaignScheduleDecision {
  const decision = decidePromotionalWindow({
    messageClass: 'promotional',
    at: args.at,
    local: args.local,
    zone: args.zone,
    ceiling: args.ceiling,
    ...(args.overrides === undefined ? {} : { overrides: args.overrides }),
  })

  if (decision.kind === 'open') {
    return { kind: 'accepted', scheduledAt: args.at, hours: decision.hours }
  }

  if (decision.kind === 'queue') {
    return {
      kind: 'refused',
      rule: 'campaign-scheduled-outside-the-promotional-window',
      nextValidInstant: decision.releaseAt,
      hours: decision.hours,
      detail:
        `${instantToIso(args.at)} is outside the promotional window ` +
        `(${String(decision.hours.startHour).padStart(2, '0')}:00–` +
        `${String(decision.hours.endHour).padStart(2, '0')}:00 in ${args.zone}). The next instant this ` +
        `campaign may be scheduled for is ${instantToIso(decision.releaseAt)}. Refused at authoring ` +
        'time rather than held at send time: a campaign is a decision somebody makes once, and a held ' +
        'campaign is indistinguishable from a campaign nobody scheduled.',
    }
  }

  // `not_applicable` (a transactional class) and `expire` (a staleness age) are both unreachable here:
  // the class is fixed at 'promotional' above and no `queuedSince` is passed, so there is nothing to have
  // gone stale. Refusing rather than defaulting, because a scheduling screen that accepted an answer this
  // function cannot have asked for would be accepting whatever the window module grows next.
  throw new AppError(
    'invariant_violated',
    `decidePromotionalWindow answered "${decision.kind}" for a promotional campaign with no held ` +
      'instant, and this function has no reading of that. A schedule accepted on an answer nobody ' +
      'designed for is the campaign that goes out at 21:30.',
    { details: { at: instantToIso(args.at), decision: decision.kind } },
  )
}

/** {@link scheduleCampaign}, as a throw. One reading of the rule, two shapes of answer. */
export function scheduleCampaignOrThrow(args: Parameters<typeof scheduleCampaign>[0]): Instant {
  const decision = scheduleCampaign(args)
  if (decision.kind === 'accepted') return decision.scheduledAt
  throw new AppError('validation', decision.detail, {
    userFacing: true,
    details: {
      rule: decision.rule,
      nextValidInstant: instantToIso(decision.nextValidInstant),
      hours: decision.hours,
    },
  })
}

export type CampaignSendWindowVerdict =
  | { readonly kind: 'open'; readonly hours: PromotionalHours }
  /** The window closed under a running campaign. The remainder is HELD, never sent late. */
  | {
      readonly kind: 'halt'
      readonly reason: 'promotional_window_closed'
      readonly reopensAt: Instant
      readonly hours: PromotionalHours
      readonly detail: string
    }

/**
 * Whether the message about to leave may leave — asked per message, not per campaign.
 *
 * This is the 21:00 boundary, and it is a separate function from {@link scheduleCampaign} for a reason
 * that is the whole acceptance line: *"a campaign scheduled at 20:55 against a throttled fake provider
 * records zero sends after 21:00 and holds the remainder rather than running past the boundary"*. The
 * schedule was legitimate. Nothing about it is wrong at 21:00. What is wrong is the next send, and only
 * an instant taken immediately before that send can know.
 *
 * The answer is a HALT and not a queue, and that is the one decision in this module that is not simply
 * the window module's. `decidePromotionalWindow` holds a single message with a release instant, which is
 * right for a message: a promotional message at 01:00 is early, not wrong. A campaign is different.
 * Releasing the remainder at 07:00 tomorrow would send a list half today and half tomorrow under one
 * campaign id, with one cap, one estimate and one report — and the half that went out tomorrow would be
 * advertising whatever the copy said yesterday, which is `Y9-queued-staleness`'s own argument against a
 * late send. So the remainder is held against the campaign, visibly, and resuming it is a decision
 * somebody makes.
 */
export function campaignSendWindowVerdict(args: {
  readonly at: Instant
  readonly local: LocalDateTime
  readonly zone: TimeZone
  readonly ceiling: PromotionalHours
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
}): CampaignSendWindowVerdict {
  const decision = decidePromotionalWindow({
    messageClass: 'promotional',
    at: args.at,
    local: args.local,
    zone: args.zone,
    ceiling: args.ceiling,
    ...(args.overrides === undefined ? {} : { overrides: args.overrides }),
  })

  if (decision.kind === 'open') return { kind: 'open', hours: decision.hours }

  const reopensAt =
    decision.kind === 'queue'
      ? decision.releaseAt
      : nextPromotionalOpen({
          local: args.local,
          ceiling: args.ceiling,
          ...(args.overrides === undefined ? {} : { overrides: args.overrides }),
          zone: args.zone,
        })
  const hours = decision.kind === 'queue' ? decision.hours : args.ceiling

  return {
    kind: 'halt',
    reason: 'promotional_window_closed',
    reopensAt,
    hours,
    detail:
      `The promotional window closed at ${String(hours.endHour).padStart(2, '0')}:00 and it is now ` +
      `${instantToIso(args.at)}. The remainder of this campaign is HELD rather than released at ` +
      `${instantToIso(reopensAt)}: a list sent half today and half tomorrow under one campaign id ` +
      'advertises yesterday to the second half, and spends their frequency allowance doing it. Resuming ' +
      'is a decision somebody makes.',
  }
}
