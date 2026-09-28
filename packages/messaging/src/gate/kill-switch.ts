/**
 * The marketing kill switch, and why it cannot reach a booking confirmation.
 *
 * C-AUTO-05. The acceptance line is not "the switch stops promotional sends" — that is easy and a boolean
 * does it. It is that the switch *"structurally cannot touch transactional traffic"*, and the difference is
 * the whole unit: a switch that merely CHECKS a flag before a promotional send is one edit away from stopping
 * every booking confirmation, reminder and OTP in the system, and the edit that does it looks like a
 * simplification.
 *
 * ## The structure, in one sentence
 *
 * {@link killSwitchVerdict} takes a {@link PromotionalOnly} message. `OutboundMessage`'s `messageClass` is
 * `'transactional' | 'promotional'`, so a transactional message is **not assignable** to that parameter and a
 * caller that tries does not compile. `evaluateGate` returns `allow` for transactional traffic on its first
 * line and only then delegates to `evaluatePromotionalGate`, whose `message` is narrowed to the promotional
 * half — so the switch is read in a function that cannot be handed a transactional message at all.
 *
 * That is three independent layers, which is deliberate, because each is the only one that holds against a
 * different mistake:
 *
 *   1. **The type.** `killSwitchVerdict(engaged, transactionalMessage)` is a compile error, and
 *      `kill-switch.test.ts` asserts it with `@ts-expect-error` — an assertion that fails if the error stops
 *      happening, which is the only kind worth having about a type.
 *   2. **The position.** `scripts/check-send-chokepoint.mjs`'s
 *      `kill-switch-cannot-reach-transactional-traffic` rule reads `decide.ts` and fails if the transactional
 *      return is not before the delegation, or if the switch is read anywhere but inside
 *      `evaluatePromotionalGate`, or if it is read twice. A behavioural test proves it for the cases it
 *      drives; this proves it for every case, including the one nobody wrote a test for.
 *   3. **The behaviour.** `kill-switch.test.ts` engages the switch and drives the WHOLE shipped template
 *      corpus through `sendMessage` in one process: every promotional template is refused by name, and every
 *      transactional one still reaches the transport. Gate case 126c deletes the guard and asserts that suite
 *      goes red.
 *
 * ## Why the state is not stored here
 *
 * `engaged` is an argument to every function in this module. The state's one home is the `messaging_control`
 * row (migration 0098), read by `readMessagingControls` in `@berelax/db`. A module-level
 * `let killSwitchEngaged` here would be a second statement of the fact, and the symptom of a second statement
 * is a console that says "stopped" over a sender that is still sending.
 *
 * ## Why a non-production environment is engaged regardless
 *
 * {@link resolveMarketingKillSwitch} ORs the stored decision with "this is not production". A seeded or
 * imported campaign firing during a staging walkthrough is a real promotional SMS to whatever numbers the
 * fixture holds, and the staging send guard is not the answer: it diverts by RECIPIENT allowlist, so an
 * allowlisted number in a seeded campaign still goes out. The environment's answer is applied on top of the
 * row and cannot be switched off by a row, which is why it is computed rather than stored — a `true` seeded
 * into staging's row would be disengageable by an UPDATE that looks entirely legitimate.
 */
import type { AppEnv } from '@berelax/config'
import { assertCan, ROLES, type Role } from '@berelax/core'
import {
  AppError,
  MESSAGING_CONTROL_KEYS,
  type MessagingControlDirection,
  type MessagingControlKey,
} from '@berelax/shared'

// --- the switch ---------------------------------------------------------------------------------

/**
 * A message the kill switch is permitted to see.
 *
 * The narrowing IS the guard. Structural rather than a nominal brand, so the narrowed `message` inside
 * `evaluatePromotionalGate` satisfies it with no cast — a cast would be the exact hole this closes, because
 * `as PromotionalOnly` is what somebody writes when they want to pass the other class through.
 */
export interface PromotionalOnly {
  readonly messageClass: 'promotional'
}

/** The gate's refusal reason for a stopped campaign. One spelling, imported by `decide.ts`. */
export const MARKETING_KILL_SWITCH_REASON = 'marketing_kill_switch' as const

export type KillSwitchVerdict =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'stop'
      readonly reason: typeof MARKETING_KILL_SWITCH_REASON
      readonly detail: string
    }

/**
 * The only place the switch's value is turned into an answer about a message.
 *
 * `message` is taken and not ignored, although the verdict does not branch on it: the parameter is what makes
 * the promotional-only constraint exist at all. A function of `engaged` alone would be callable from the
 * transactional path, and the comment saying it must not be would be the whole of the protection.
 */
export function killSwitchVerdict(engaged: boolean, message: PromotionalOnly): KillSwitchVerdict {
  if (!engaged) return { kind: 'pass' }
  return {
    kind: 'stop',
    reason: MARKETING_KILL_SWITCH_REASON,
    detail:
      `The marketing kill switch is engaged, so this ${message.messageClass} message is stopped. ` +
      'Transactional traffic — booking confirmations, reminders and OTPs — is unaffected, and cannot be ' +
      'affected: it never reaches this check.',
  }
}

/** Where an engaged switch's answer came from, so a screen can say whether an operator did it. */
export type MarketingKillSwitchSource =
  /** An operator engaged it, and `messaging_control` records who and why. */
  | 'operator'
  /** `APP_ENV` is not production. Not disengageable, by design. */
  | 'non_production_default'
  /** Nobody engaged it and this is production. */
  | 'disengaged'

export interface MarketingKillSwitchState {
  readonly engaged: boolean
  readonly source: MarketingKillSwitchSource
}

/**
 * The switch as the gate must see it: the operator's decision, plus the environment's.
 *
 * `stored` is `messaging_control.engaged`. The OR is not a convenience — see the header on why the
 * non-production answer is computed rather than seeded.
 */
export function resolveMarketingKillSwitch(input: {
  readonly stored: boolean
  readonly appEnv: AppEnv
}): MarketingKillSwitchState {
  if (input.stored) return { engaged: true, source: 'operator' }
  if (input.appEnv !== 'production') return { engaged: true, source: 'non_production_default' }
  return { engaged: false, source: 'disengaged' }
}

// --- who may move it ----------------------------------------------------------------------------

/**
 * The refusal a person sees when they may not toggle a control.
 *
 * `settings:write`, which owner and manager hold and receptionist, marketer, therapist, accountant, auditor
 * and `system` do not. Not `settings:write_compliance`: that permission is the owner's alone, and a floor
 * manager who cannot stop marketing at 22:00 without fetching the proprietor is a kill switch nobody pulls.
 * Not a new permission either — a permission held by exactly the two roles that already hold `settings:write`
 * is a second name for it, and the matrix test would then assert the same grant twice.
 *
 * This is the first of two layers. The second is `messaging_control_role_may_toggle()` in migration 0098,
 * which raises `ZY082` and is the one that holds for a `psql` session, a seed, or an import of another
 * environment's rows. The pair is asserted equal behaviourally by gate case 126d rather than trusted.
 */
export function assertMayToggleMessagingControl(input: {
  readonly controlKey: MessagingControlKey
  readonly direction: MessagingControlDirection
  readonly role: string
  readonly reason: string
}): void {
  if (!(MESSAGING_CONTROL_KEYS as readonly string[]).includes(input.controlKey)) {
    throw new AppError(
      'validation',
      `'${input.controlKey}' is not a messaging control. The two are ` +
        `${MESSAGING_CONTROL_KEYS.join(' and ')}, and there is deliberately none naming transactional ` +
        'traffic: a control that could name it would be one edit away from stopping booking confirmations.',
      { details: { controlKey: input.controlKey } },
    )
  }
  // The ROLE before the reason, which is the opposite order to the database trigger's, and both are right.
  // Here the role arrives from a live session and is a fact about the caller, so "not you" is the honest
  // first answer; the trigger sees a row that may have come from a script with no session at all, where a
  // blank reason is the more likely fault and the more actionable sentence.
  if (!(ROLES as readonly string[]).includes(input.role)) {
    throw new AppError(
      'forbidden',
      `'${input.role}' is not a role in this system, so it may not toggle ${input.controlKey}. Deny by ` +
        'default: an unknown role is refused rather than treated as ungated.',
      { details: { role: input.role, controlKey: input.controlKey } },
    )
  }
  assertCan(input.role as Role, 'settings:write')
  if (input.reason.trim() === '') {
    throw new AppError(
      'validation',
      `A ${input.direction} of ${input.controlKey} needs a reason. It is what the next person reads before ` +
        'deciding whether the switch can come back off, and the audit row carries it.',
      { userFacing: true, details: { controlKey: input.controlKey, direction: input.direction } },
    )
  }
}

// --- what became of each recipient --------------------------------------------------------------

/**
 * What one promotional send attempt did, in the vocabulary a recipient list is counted in.
 *
 * `held` and `refused` are the distinction this type exists for, and folding them together is the defect it
 * prevents. A kill-switch stop and a window queue are the same fact about a recipient — *not yet*, and the
 * message is still owed to them — while a missing consent record is *no*, and reads the same tomorrow. A
 * campaign that counted a kill-switch stop as a refusal would report those recipients as dealt with, and the
 * release C-AUTO-10 owes them would have nothing to release.
 */
export type PromotionalSendDisposition =
  | 'sent'
  /** Not yet: the switch is engaged, or the window is shut. Owed a release. */
  | 'held'
  /** No: consent, suppression or the frequency cap. The same answer tomorrow. */
  | 'refused'
  /** The vendor was reached and said no — including a suspended sender ID. */
  | 'failed'
  /** Outside production and not allowlisted. In the local outbox. */
  | 'diverted'
  /** Held past the staleness ceiling, so it will never be sent. */
  | 'expired'

/**
 * The reasons that mean *not yet* rather than *no*.
 *
 * `marketing_kill_switch` is here and `refused_no_consent` is not, and that is the one classification in this
 * module worth a case of its own — gate case 126f moves the kill switch to the other list and the
 * conservation assertion goes red, because `held + sent == total` stops holding the moment a stopped
 * recipient is counted as dealt with.
 */
export const PROMOTIONAL_HOLD_REASONS: readonly string[] = Object.freeze([
  MARKETING_KILL_SWITCH_REASON,
  'queued_for_window',
])

/**
 * Classifies one `SendResult`.
 *
 * Takes the result STRUCTURALLY — `{ kind, reason? }` — rather than importing `SendResult` from `../send.ts`,
 * because `send.ts` imports this module through the gate barrel and a cycle between them is one
 * `pnpm boundaries` would be right to refuse. Every field it reads is one the union declares.
 */
export function promotionalSendDisposition(result: {
  readonly kind: string
  readonly reason?: string
}): PromotionalSendDisposition {
  switch (result.kind) {
    case 'sent':
      return 'sent'
    case 'queued':
      return 'held'
    case 'expired':
      return 'expired'
    case 'diverted':
      return 'diverted'
    case 'failed':
      return 'failed'
    case 'blocked':
      return PROMOTIONAL_HOLD_REASONS.includes(result.reason ?? '') ? 'held' : 'refused'
    default:
      throw new AppError(
        'invariant_violated',
        `'${result.kind}' is not a send outcome this classifier knows. A new SendResult kind must be ` +
          'classified deliberately: defaulting it to "refused" would silently stop owing the recipient a ' +
          'release, and defaulting it to "sent" would report a send that did not happen.',
        { details: { kind: result.kind } },
      )
  }
}

// --- the suspended promotional identity ---------------------------------------------------------

/**
 * True when this outcome is what a suspended promotional sender ID looks like.
 *
 * TDRA suspends an IDENTITY, and the system finds out the same way anybody does: the vendor starts rejecting
 * sends from it. So the evidence is a promotional send that reached SMSala and came back `provider_rejected`,
 * which is exactly what `failures.promotional.failAlways('rejected')` produces in the fake (H02).
 *
 * Recognising it is the difference between the acceptance line and a system that fails silently: without
 * this, a suspension is a rising count of failed promotional messages in a table nobody is watching, and the
 * first evidence is somebody asking why the campaign did nothing. With it, the operator records the
 * suspension on the `promotional_sender_suspended` control and {@link promotionalSendingBanner} puts it on
 * every admin screen — while transactional traffic, which leaves from the OTHER registered identity with its
 * own failure script, carries on. That separation is the whole reason there are two registrations (ADR 0016).
 */
export function promotionalSenderSuspensionSuspected(input: {
  readonly messageClass: string
  readonly result: { readonly kind: string; readonly reason?: string }
}): boolean {
  return (
    input.messageClass === 'promotional' &&
    input.result.kind === 'failed' &&
    input.result.reason === 'provider_rejected'
  )
}

/** What staff are shown about promotional sending. One home, read by every admin surface. */
export type PromotionalSendingBannerState =
  /** The vendor is rejecting the promotional identity. The operational half is still running. */
  | 'sender_suspended'
  /** An operator stopped marketing. */
  | 'stopped_by_kill_switch'
  /** Both, which is a different sentence from either. */
  | 'suspended_and_stopped'
  /** Nothing is stopping promotional sending. */
  | 'sending'

export interface PromotionalSendingBanner {
  readonly state: PromotionalSendingBannerState
  readonly headline: string
  /** Always says that transactional traffic is unaffected, because that is the question staff ask first. */
  readonly detail: string
}

const TRANSACTIONAL_IS_FINE =
  'Booking confirmations, reminders and OTPs are unaffected: they leave from the separate transactional ' +
  'sender identity, which is why two are registered.'

export function promotionalSendingBanner(input: {
  readonly killSwitchEngaged: boolean
  readonly senderSuspended: boolean
}): PromotionalSendingBanner {
  if (input.senderSuspended && input.killSwitchEngaged) {
    return {
      state: 'suspended_and_stopped',
      headline: 'Promotional sending suspended, and stopped by the kill switch',
      detail:
        'The promotional sender ID is suspended AND the marketing kill switch is engaged. Both have to be ' +
        'cleared before a campaign can send, and they are cleared by different people. ' +
        TRANSACTIONAL_IS_FINE,
    }
  }
  if (input.senderSuspended) {
    return {
      state: 'sender_suspended',
      headline: 'Promotional sending suspended',
      detail:
        'The promotional sender ID is suspended, so the vendor is rejecting every promotional send. This ' +
        'is not something the kill switch can clear. ' +
        TRANSACTIONAL_IS_FINE,
    }
  }
  if (input.killSwitchEngaged) {
    return {
      state: 'stopped_by_kill_switch',
      headline: 'Promotional sending stopped by the marketing kill switch',
      detail: `Every promotional send is refused while the switch is engaged. ${TRANSACTIONAL_IS_FINE}`,
    }
  }
  return {
    state: 'sending',
    headline: 'Promotional sending is live',
    detail:
      'Neither the marketing kill switch nor a sender-ID suspension is stopping promotional traffic. The ' +
      'consent, suppression, frequency-cap and quiet-hours rules still decide every individual send.',
  }
}
