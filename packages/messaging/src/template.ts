/**
 * The template as the send path reads it: per-channel variants, an approval state, and the 24-hour
 * WhatsApp customer-care window as a first-class state rather than a comment.
 *
 * `templates.ts` next door declares the shipped DEFAULTS as data and `render.ts` turns one into bytes.
 * This module answers the question between them — **may this template speak on this channel, right
 * now** — and it answers it with a typed result for every outcome, because every one of them is a
 * different piece of work for whoever reads it.
 *
 * ## Why the variant is resolved and not looked up
 *
 * A template is one row with a class and many variant rows, one per (channel, locale). A send names a
 * channel. The tempting implementation is `variants.find(v => v.channel === channel) ?? variants[0]`,
 * and the `?? variants[0]` is the defect: a template with an SMS variant and no WhatsApp one then sends
 * the SMS body over WhatsApp. It renders, it delivers, and the message is a 160-character SMS pushed
 * down a channel with no length limit and a completely different approval regime — so there is nothing
 * to notice. `no_variant` is the refusal that makes the absence visible.
 *
 * ## The order the whatsapp rules are checked in, and why
 *
 *  1. **No variant for the channel at all → `no_variant`.** There is nothing to say. Whether the care
 *     window is open is irrelevant, because an open window permits free-form *words*, and there are
 *     none. The work is "author a WhatsApp variant".
 *  2. **A variant that is not approved → the care window decides.** The words exist; only the permission
 *     is missing. Inside the 24-hour window WhatsApp permits free-form text, so those words may go as
 *     free-form (`free_form`). Outside it, only an approved template may be sent, and there is not one:
 *     `outside_care_window`. The work is either "get it approved" or "wait for the customer to write
 *     in", and they are different jobs.
 *  3. **An approved variant → sendable, in or out of the window.** That is what approval buys.
 *
 * On `sms` and `email` there is no window: an unapproved variant is `template_not_approved`, full stop.
 * A free-form SMS is not a thing this system has — every SMS comes from a template, which is what makes
 * `message.template_id` a NOT NULL foreign key.
 *
 * ## Why the window's clock is an argument and its last-inbound instant is injected
 *
 * Nothing in this build RECEIVES a WhatsApp message: there is no contracted vendor (`vendorFor` refuses
 * the channel) and therefore no inbound webhook. So "when did this customer last write in?" has no
 * answer here, and the honest shipped answer is `null` — no inbound ever, window shut, free-form
 * refused. Injected rather than defaulted so the open case is reachable under a frozen clock and so the
 * day an inbound path exists it is one implementation rather than a change to this rule. The same seam
 * B-MSG-03 used for the magic link, for the same reason.
 */
import type { Instant } from '@berelax/core'
import {
  AppError,
  isSendableApproval,
  MESSAGE_CHANNELS,
  MESSAGE_CLASSES,
  type MessageClass,
  TEMPLATE_APPROVAL_STATES,
  type TemplateApprovalState,
} from '@berelax/shared'
import type { Channel } from './port.ts'
import type { TemplateDefinition } from './render.ts'

/**
 * WhatsApp's customer-care window, in hours.
 *
 * 24 is Meta's rule and not a setting: outside it a business may send only an approved template, and no
 * amount of configuration changes that. Stated as a named constant because it appears in a comparison,
 * and a bare `24 * 60 * 60 * 1000` in a comparison is how a window becomes 24 minutes.
 */
export const WHATSAPP_CARE_WINDOW_HOURS = 24

const HOUR_MS = 60 * 60 * 1000

/**
 * One channel+locale variant of a template, as the database stores it since migration 0014.
 *
 * `approvalState` is REQUIRED and the other two are optional, and the asymmetry is the rule: an absent
 * approval state must never read as approved, so there is no default for it at all. The two optional
 * fields default to the RESTRICTIVE value — no category, and not marked for out-of-window use — which is
 * also what the columns default to in SQL, so a caller that omits them gets the same answer the database
 * would give.
 *
 * `customerCareWindow` is carried and is deliberately not a second gate. `approval_state = 'approved'` is
 * the permission to send outside the 24-hour window; a flag that had to agree with it would be two
 * readings of one question, and the day they disagreed the send would be decided by whichever one the
 * code path happened to consult. The ZM003 freeze in migration 0061 is what stops the flag being flipped
 * underneath an approval.
 */
export interface TemplateVariant extends TemplateDefinition {
  readonly approvalState: TemplateApprovalState
  /** WhatsApp's own category taxonomy. Absent or null for channels that have none. */
  readonly category?: string | null
  /** Whether this variant is one somebody intends to send OUTSIDE the care window. Descriptive. */
  readonly customerCareWindow?: boolean
}

/**
 * A template: one immutable class, many variants.
 *
 * `messageClass` sits here and not on a variant, and the database agrees — it is a column on
 * `message_template` with a trigger (ZM001) refusing to change it. A class per variant would be a
 * template that is transactional in English and promotional in Arabic, which is not a thing that can be
 * true, and `seedMessageTemplates` refuses a definition set that says otherwise.
 */
export interface MessageTemplate {
  /** The database id of the version. A `message` row points at it, so it survives a reclassification. */
  readonly templateId: string
  readonly key: string
  readonly messageClass: MessageClass
  readonly variants: readonly TemplateVariant[]
}

/** What the caller knows about the customer's last inbound WhatsApp message. */
export interface CareWindowState {
  /**
   * The instant the customer last wrote in, or `null` when they never have — which is every customer in
   * this build, because nothing receives an inbound message yet.
   */
  readonly lastInboundAt: Instant | null
}

export type CareWindow = 'open' | 'closed'

/**
 * Whether the 24-hour window is open at `at`.
 *
 * Half-open on purpose: exactly 24 hours after the last inbound message the window is SHUT. A boundary
 * that counted the 24-hour mark as open would put the decision on the wrong side of the rule for every
 * message sent by a job that runs on the hour, which is most of them.
 */
export function careWindow(state: CareWindowState, at: Instant): CareWindow {
  if (state.lastInboundAt === null) return 'closed'
  const elapsed = at - state.lastInboundAt
  return elapsed >= 0 && elapsed < WHATSAPP_CARE_WINDOW_HOURS * HOUR_MS ? 'open' : 'closed'
}

/** Why a template could not produce a sendable body on a channel. */
export type VariantRefusal =
  /** The template has no variant for this channel. The SMS body is NOT reused. */
  | 'no_variant'
  /** The variant exists and is in draft, pending or rejected. Not sendable, on any channel. */
  | 'template_not_approved'
  /** WhatsApp only: no approved template and the 24-hour free-form window is shut. */
  | 'outside_care_window'
  /** A channel that admits no free-form message was asked for one. */
  | 'no_template'

export type VariantResolution =
  | { readonly kind: 'variant'; readonly variant: TemplateVariant }
  /**
   * WhatsApp, inside the care window: a free-form reply is permitted, so the words need no approval.
   * `variant` is the body to send when the request named a template, and `null` for a bare reply.
   */
  | {
      readonly kind: 'free_form'
      readonly variant: TemplateVariant | null
      readonly careWindowClosesAtIso: string
    }
  | {
      readonly kind: 'refused'
      readonly reason: VariantRefusal
      readonly channel: Channel
      /** The approval state the variant was in, when there was one. Null when there was no variant. */
      readonly approvalState: TemplateApprovalState | null
      readonly detail: string
    }

export interface VariantRequest {
  /** The template, or `null` for a free-form WhatsApp reply, which has none. */
  readonly template: MessageTemplate | null
  readonly channel: Channel
  readonly locale: 'en' | 'ar'
  readonly at: Instant
  /** WhatsApp only. Supplied for every channel so the caller cannot forget it on the one that needs it. */
  readonly care: CareWindowState
}

/**
 * When an OPEN window shuts.
 *
 * Only ever called on the free-form paths, where {@link careWindow} has already answered `open` and the
 * last inbound instant is therefore not null. A `?? at` fallback here would hand a caller a plausible
 * instant for a window that was never open, which is the kind of value brief rule 15 is about.
 */
function careWindowClosesAt(state: CareWindowState): string {
  const lastInboundAt = state.lastInboundAt
  if (lastInboundAt === null) {
    throw new AppError(
      'invariant_violated',
      'The care window was reported open for a contact with no inbound message. careWindow() cannot ' +
        'answer open without one, so this is a defect in resolveVariant rather than in its input.',
    )
  }
  return new Date(lastInboundAt + WHATSAPP_CARE_WINDOW_HOURS * HOUR_MS).toISOString()
}

/**
 * The one variant a send may use, or a typed refusal.
 *
 * Never returns a variant for another channel and never returns one that is not approved unless the
 * WhatsApp care window explicitly permits free-form words. Those two sentences are the whole module.
 */
export function resolveVariant(request: VariantRequest): VariantResolution {
  const { template, channel, locale, at, care } = request
  const window = channel === 'whatsapp' ? careWindow(care, at) : 'closed'

  if (template === null) {
    if (channel === 'whatsapp' && window === 'open') {
      return { kind: 'free_form', variant: null, careWindowClosesAtIso: careWindowClosesAt(care) }
    }
    return {
      kind: 'refused',
      reason: channel === 'whatsapp' ? 'outside_care_window' : 'no_template',
      channel,
      approvalState: null,
      detail:
        channel === 'whatsapp'
          ? `A free-form WhatsApp message needs the ${WHATSAPP_CARE_WINDOW_HOURS}-hour customer-care ` +
            'window to be open, and the customer has not written in inside it. Outside the window only ' +
            'an approved template may be sent.'
          : `A ${channel} message has no free-form path in this system: every one comes from a ` +
            'template, which is why message.template_id is a NOT NULL foreign key.',
    }
  }

  // Exact (channel, locale), never a nearest match. `message_template_variant` is UNIQUE on the pair, so
  // at most one can answer, and a locale fallback would remind an Arabic-speaking customer in English.
  const variant = template.variants.find(
    (candidate) => candidate.channel === channel && candidate.locale === locale,
  )

  if (variant === undefined) {
    return {
      kind: 'refused',
      reason: 'no_variant',
      channel,
      approvalState: null,
      detail:
        `Template '${template.key}' has no ${channel}/${locale} variant. Refusing rather than reusing ` +
        `another channel's body: an SMS body pushed down WhatsApp renders, delivers and is reported as ` +
        'a success, so nothing would notice. Author the variant.',
    }
  }

  return judgeVariant({ templateKey: template.key, variant, at, care })
}

/**
 * The same judgement over a variant that has already been selected.
 *
 * Exported for the send choke point, which is handed ONE resolved variant rather than a template and a
 * channel: `SendRequest.template` is the variant the caller resolved, because the choke point's other
 * decisions — the class, the identity, the gate — are made from it and from nothing else. Calling this
 * from there rather than re-deriving the rule is what keeps one reading of "may these words be sent":
 * the refusal a caller sees from `resolveVariant` and the refusal `sendMessage` returns are the same
 * function, with the same reason and the same words.
 */
export function judgeVariant(args: {
  readonly templateKey: string
  readonly variant: TemplateVariant
  readonly at: Instant
  readonly care: CareWindowState
}): VariantResolution {
  const { templateKey, variant, at, care } = args
  const channel = variant.channel
  const window = channel === 'whatsapp' ? careWindow(care, at) : 'closed'

  if (isSendableApproval(variant.approvalState)) return { kind: 'variant', variant }

  if (channel === 'whatsapp' && window === 'open') {
    // The words exist and are unapproved, and inside the window WhatsApp permits free-form text — so
    // they may go as free-form. Reported as `free_form` rather than as `variant` because it is a
    // different permission, and the `message` row and the inbox should say which one was used.
    return { kind: 'free_form', variant, careWindowClosesAtIso: careWindowClosesAt(care) }
  }

  if (channel === 'whatsapp') {
    return {
      kind: 'refused',
      reason: 'outside_care_window',
      channel,
      approvalState: variant.approvalState,
      detail:
        `Template '${templateKey}' has a whatsapp/${variant.locale} variant in ` +
        `'${variant.approvalState}' and the ${WHATSAPP_CARE_WINDOW_HOURS}-hour customer-care window is ` +
        'shut. Outside the window only an approved template may be sent; inside it these words could ' +
        'have gone as free-form.',
    }
  }

  return {
    kind: 'refused',
    reason: 'template_not_approved',
    channel,
    approvalState: variant.approvalState,
    detail:
      `Template '${templateKey}' (${channel}/${variant.locale}) is in '${variant.approvalState}', not ` +
      "'approved'. A template nobody has approved is a message nobody has read, and the class it would " +
      'leave under decides which registered identity it leaves from.',
  }
}

// --- from a database row to a template the choke point can decide about ---------------------------

/**
 * A `message_template_variant` row joined to its template, as `@berelax/db` returns it.
 *
 * Every vocabulary column is a plain `string` here, and that is not laziness: `packages/db` may import
 * `@berelax/shared` and `@berelax/config` and nothing else, and its job is to return what the column
 * said. Narrowing is this module's job, because this module is where the consequence of an unrecognised
 * label is decided.
 */
export interface TemplateVariantRow {
  readonly templateKey: string
  readonly messageClass: string
  readonly channel: string
  readonly locale: string
  readonly subject: string | null
  readonly body: string
  readonly variables: readonly string[]
  readonly approvalState: string
  readonly customerCareWindow: boolean
  readonly category: string | null
}

export type ClassifiedTemplateRow =
  | {
      readonly kind: 'template'
      readonly template: TemplateVariant & { readonly messageClass: MessageClass }
    }
  /** A column held a label this build does not know. Named, so a caller can record WHY it stopped. */
  | {
      readonly kind: 'unreadable'
      readonly column: string
      readonly value: string
      readonly detail: string
    }

/**
 * Narrows a row into something the send path may decide about, or refuses.
 *
 * ## Why this exists rather than four casts at the call site
 *
 * The reminder worker used to build its send request with the literal `messageClass: 'transactional'`.
 * That was TRUE of `booking.reminder` and it was a hole all the same: `reclassify_template` can make any
 * template promotional, and a call site that restates the class sends promotional content from the
 * transactional sender ID **with every gate skipped** — because `evaluateGate` returns `allow` on its
 * first line for a message that says it is transactional. One pure function, called from every reader, is
 * what makes "the class comes from the template" a fact rather than a habit.
 *
 * ## Why an unrecognised label refuses instead of falling back
 *
 * A strict fallback was the first version of this: an unknown class read as `promotional` and an unknown
 * approval state as `draft`, on the grounds that both are the more restricted reading. They are the more
 * restricted reading, and it is still the wrong answer, because it is SILENT — the caller records a
 * perfectly ordinary refusal and nobody ever learns that a column holds a label this build cannot read.
 * `unreadable` names the column and the value, so the recorded reason says what to look at.
 */
export function classifyTemplateRow(row: TemplateVariantRow): ClassifiedTemplateRow {
  const unreadable = (column: string, value: string, what: string): ClassifiedTemplateRow => ({
    kind: 'unreadable',
    column,
    value,
    detail:
      `Template '${row.templateKey}' has ${column} = '${value}', which is not ${what}. Refusing to ` +
      'send rather than guessing: a label this build cannot read is a label whose permissions it does ' +
      'not know.',
  })

  if (!(MESSAGE_CLASSES as readonly string[]).includes(row.messageClass)) {
    return unreadable('message_class', row.messageClass, 'a message class')
  }
  if (!(MESSAGE_CHANNELS as readonly string[]).includes(row.channel)) {
    return unreadable('channel', row.channel, 'a channel')
  }
  if (!(TEMPLATE_APPROVAL_STATES as readonly string[]).includes(row.approvalState)) {
    return unreadable('approval_state', row.approvalState, 'an approval state')
  }
  if (row.locale !== 'en' && row.locale !== 'ar') {
    return unreadable('locale', row.locale, 'a locale this build renders')
  }

  return {
    kind: 'template',
    template: {
      key: row.templateKey,
      messageClass: row.messageClass as MessageClass,
      channel: row.channel as Channel,
      locale: row.locale,
      ...(row.subject === null ? {} : { subject: row.subject }),
      body: row.body,
      variables: row.variables,
      approvalState: row.approvalState as TemplateApprovalState,
      category: row.category,
      customerCareWindow: row.customerCareWindow,
    },
  }
}
