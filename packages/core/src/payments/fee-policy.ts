/**
 * The card-on-file mandate, and the fee path that is provably disabled (Y-PAY-07).
 *
 * Three things live here and they are deliberately separate, because conflating any two of them is how a
 * business that has agreed no fee policy comes to charge somebody:
 *
 *   1. **what a mandate IS** — a record that a mandate exists at a gateway, and never an instrument;
 *   2. **whether a mandate may be charged at all** — on file, unexpired, unrevoked, within its cap;
 *   3. **whether there is a figure to charge** — which is a POLICY question and is answered "no".
 *
 * ## A mandate is a record, not an instrument (ADR 0067)
 *
 * There is no chosen gateway, no merchant account and no MCC (`PENDING['card-gateway']`), so there is no
 * token to hold either. What this module models is the paperwork: the customer was shown a specific
 * disclosure, at a specific instant, agreeing to a specific maximum, and the gateway returned an opaque
 * handle for the instrument IT holds. Nothing here can hold a primary account number, and
 * {@link MANDATE_TOKEN_REFERENCE_RULE} states the one property that makes that checkable from outside —
 * the handle must not be card-shaped, which `is_card_shaped()` in migration 0134 refuses in the database
 * and `packages/fixtures/src/mandate.itest.ts` probes with a Luhn-valid test PAN.
 *
 * ## The figure is an ARGUMENT, and its absence is a refusal (ADR 0070)
 *
 * `cancellationCharge()` in `../lifecycle/cancellation-policy.ts` answers zero for every input, because
 * `Y9-windows` says "24h window; no fee charged, flagged only" and no fee policy has been agreed. This
 * module may not invent one. So {@link assertFeeChargeable} takes the figure as an argument and
 * {@link feeChargePolicy} refuses when no policy is on file — the shape `depositDueFils` uses when its
 * module is off, and for the reason Y9-commission recorded in so many words: a run that produced no lines
 * was reported as "no commission is due". "No fee because nobody has agreed one" and "a fee of zero is
 * due under the policy" are different facts, and only the second one may be posted.
 *
 * A caller that wants to know whether to ask reads `policy.onFile`. A caller that asks for a charge gets
 * one or gets told why not. There is no branch anywhere in this file that returns zero fils as an answer.
 */
import { AppError } from '@berelax/shared'
import type { Fils } from '../money.ts'
import { filsFrom } from '../money.ts'
import type { Instant } from '../time.ts'

/**
 * The open question the whole fee path is provisional against.
 *
 * The same id `cancellationCharge()` carries, deliberately: the window, the fee and this mandate are one
 * unanswered question and not three, and two ids would let half of it be closed while the other half went
 * on reading as settled.
 */
export const FEE_POLICY_OPEN_QUESTION = 'Y9-windows'

/** The open question the gateway itself is provisional against. No gateway, so no token vocabulary. */
export const MANDATE_GATEWAY_OPEN_QUESTION = 'Y7-gateway'

/**
 * The open question the DISCLOSURE is provisional against.
 *
 * Separate from the gateway's, because the two are answered by different people and either can be settled
 * without the other: `Y7-gateway` is a commercial question about an acquirer, and this is a question about
 * what a customer is shown and who approved those words. There is no wording in this build and no
 * constant here holding one — `ZY422` in migration 0134 refuses a mandate recorded against the sha256 of
 * the empty string, so an unwritten disclosure cannot read as agreed (brief rule 15).
 */
export const MANDATE_WORDING_OPEN_QUESTION = 'Y9-mandate-wording'

/**
 * The setting that would have to be changed, with an audit trail, to enable the charge path.
 *
 * Named here rather than read here: `packages/core` holds no settings reader. The point of spelling it is
 * that the charge path is disabled by a STORED decision somebody has to make deliberately, not by this
 * file being absent — an absent mechanism is re-invented by whoever next needs one.
 */
export const FEE_CHARGE_SETTING_KEY = 'payments.cancellation_fee_charging_enabled'

// --- what a mandate is --------------------------------------------------------------------------

/**
 * The one property of a stored token reference that can be checked without knowing the gateway.
 *
 * Stated as a value rather than as prose in a comment so the database rule, the TypeScript guard and the
 * test all quote the same sentence. `packages/fixtures/src/mandate.itest.ts` asserts this string appears
 * in migration 0134's refusal, which is what stops the two statements of the rule drifting apart.
 */
export const MANDATE_TOKEN_REFERENCE_RULE =
  'a mandate token reference is an opaque handle to an instrument the GATEWAY holds, so it may not be ' +
  'card-shaped: a 13-to-19-digit Luhn-valid run is refused'

/** A mandate's state at an instant. Exhaustive, so a caller cannot forget one. */
export const MANDATE_STATES = ['active', 'expired', 'revoked'] as const
export type MandateState = (typeof MANDATE_STATES)[number]

/**
 * A mandate, as the database holds it.
 *
 * Every field is evidence of something a person did, which is why there is no `enabled` flag and no
 * `state` column: the state is DERIVED from the dates (see {@link mandateStateAt}), because a stored
 * state is a second statement of what the dates already say and the two go out of step the moment an
 * expiry passes with nothing running.
 */
export interface MandateRecord {
  readonly mandateId: string
  readonly customerId: string
  /** The gateway that holds the instrument. Unknown today; `Y7-gateway`. */
  readonly gateway: string
  /** The gateway's opaque handle. Never an instrument. See {@link MANDATE_TOKEN_REFERENCE_RULE}. */
  readonly tokenReference: string
  /** WHICH disclosure the customer was shown. A version, not the words. */
  readonly wordingVersion: string
  /** The sha256 of the words that were shown, lowercase hex. The words themselves are not in this build. */
  readonly wordingSha256: string
  /** The maximum this mandate authorises, in fils. A mandate with no cap is not a mandate. */
  readonly capFils: number
  /** When the customer agreed. */
  readonly agreedAt: Instant
  /** When the authority lapses. Mandates do not last for ever and an open-ended one is not consent. */
  readonly expiresAt: Instant
  /** When the customer took it back, if they did. Recorded as its own row; see migration 0134. */
  readonly revokedAt: Instant | null
}

/** Whether a fee policy exists, and the question it is provisional against. */
export interface FeeChargePolicy {
  /**
   * Whether a fee policy is ON FILE. `false` for this build.
   *
   * Not `enabled`: a disabled policy is one somebody agreed and then switched off, and that is a
   * different fact from nobody ever having agreed one. The second is what is true here.
   */
  readonly onFile: boolean
  readonly openQuestionId: string
  /** Why, in the words the admin panel shows. */
  readonly why: string
}

// --- the refusals -------------------------------------------------------------------------------

/**
 * No mandate on file for this customer.
 *
 * `operation` rather than `validation`: the request was well-formed and the system is refusing it, which
 * is a different thing from a malformed figure and reads differently in the audit trail.
 */
export class NoMandateOnFile extends AppError {
  constructor(customerId: string) {
    super(
      // `conflict` and not `validation`: the request was well-formed and the RECORDED STATE refuses it.
      // The distinction is what an audit trail needs — "the figure was wrong" and "there was no authority"
      // are answered to a customer in completely different words.
      'conflict',
      `No card-on-file mandate exists for customer "${customerId}", so there is nothing to charge. A ` +
        'mandate is a RECORD that the customer was shown a disclosure and agreed to a maximum; without ' +
        'one there is no authority, and a charge made anyway is a charge nobody consented to.',
      { details: { customerId } },
    )
  }
}

/** The mandate lapsed before the attempt. */
export class MandateExpired extends AppError {
  constructor(mandateId: string, expiresAtMs: number, atMs: number) {
    super(
      'conflict',
      `Mandate "${mandateId}" lapsed at ${new Date(expiresAtMs).toISOString()} and the charge was ` +
        `attempted at ${new Date(atMs).toISOString()}. An expired mandate is refused rather than ` +
        'renewed: the authority was given for a period, and extending it here would extend it without ' +
        'anybody being asked.',
      { details: { mandateId, expiresAtMs, atMs } },
    )
  }
}

/**
 * The customer took the authority back.
 *
 * Separate from {@link MandateExpired} although both mean "not active now", because the remedy differs and
 * so does what may be said to the customer: a lapsed mandate may be asked for again, and a revoked one
 * may not be asked for again on the same visit.
 */
export class MandateRevoked extends AppError {
  constructor(mandateId: string, revokedAtMs: number) {
    super(
      'conflict',
      `Mandate "${mandateId}" was revoked at ${new Date(revokedAtMs).toISOString()} and is refused for ` +
        'every later attempt. A revocation takes effect on the NEXT charge attempt and is never applied ' +
        'retrospectively to one that already succeeded — that would be a refund, with its own document.',
      { details: { mandateId, revokedAtMs } },
    )
  }
}

/** The figure asked for is larger than the maximum the customer agreed to. */
export class FeeExceedsMandateCap extends AppError {
  readonly capFils: number
  readonly requestedFils: number
  constructor(mandateId: string, capFils: number, requestedFils: number) {
    super(
      // `validation` here and `conflict` above, and the split is the honest one: a figure outside the
      // agreed bound is something the caller can ask differently, and an absent or withdrawn authority
      // is not.
      'validation',
      `Mandate "${mandateId}" authorises at most ${capFils} fils and ${requestedFils} fils was ` +
        "requested. The cap is the whole content of the customer's agreement, so a charge above it is " +
        'refused rather than clamped: a silently reduced charge would be a figure nobody decided, posted ' +
        'against a document that claims the customer agreed to it.',
      { details: { mandateId, capFils, requestedFils } },
    )
    // Assigned AFTER `super`, which is the only legal order, and carried as fields rather than left in
    // `details` because the screen that shows "you authorised AED 50 and this is AED 70" reads them and a
    // `details` bag is `unknown` to a caller.
    this.capFils = capFils
    this.requestedFils = requestedFils
  }
}

/**
 * No fee policy is on file, so no figure may be charged. **The refusal that must not become a zero.**
 *
 * This is the one that carries the unit. The provisional position is "flagged only, no fee" and the
 * dangerous implementation of it is a function that returns 0 fils — because 0 fils posts, balances, and
 * reports as a fee that was correctly calculated to be nothing. ADR 0070's subject exactly.
 */
export class NoFeePolicyOnFile extends AppError {
  constructor(what: string, policy: FeeChargePolicy) {
    super(
      // `validation`, which is what `DepositsAreDisabled` uses one subject along for the same shape of
      // refusal: a module that has not been turned on, asked for a figure.
      'validation',
      `${what} is refused: no cancellation or no-show fee policy is on file. ${policy.why} This is a ` +
        'REFUSAL and not a charge of zero fils, because a zero would post, balance and report as a fee ' +
        'that had been correctly worked out — and the figure would then be in the books as a decision ' +
        `nobody made. Answer ${policy.openQuestionId} and change ${FEE_CHARGE_SETTING_KEY}, with the ` +
        'audit trail that setting carries, and this path starts refusing for a different reason.',
      { details: { what, openQuestionId: policy.openQuestionId } },
    )
  }
}

// --- the policy ---------------------------------------------------------------------------------

/**
 * The stored fee policy, normalised — or the provisional "nothing on file".
 *
 * Normalising rather than throwing, which is `cancellationWindowHours`'s choice, and here the safe
 * direction is unambiguous: both fallbacks are the OFF reading, so a corrupt row leaves the business
 * charging nobody rather than charging somebody a figure derived from a corrupt value. `Boolean('false')`
 * is `true`, which is why nothing is coerced and the accepted shape is named.
 */
export function feeChargePolicy(stored: { readonly onFile: unknown }): FeeChargePolicy {
  const onFile = stored.onFile === true
  return Object.freeze({
    onFile,
    openQuestionId: FEE_POLICY_OPEN_QUESTION,
    why: onFile
      ? 'A fee policy is recorded against this business.'
      : 'The cancellation window is provisional (Y9-windows), the owner has agreed no fee policy, and ' +
        'the business holds no merchant account — so a late cancellation or a no-show is recorded as a ' +
        'flag and posts nothing at all.',
  })
}

/** The provisional policy. A value, so a caller cannot forget which way round the default is. */
export const PROVISIONAL_FEE_POLICY: FeeChargePolicy = feeChargePolicy({ onFile: false })

// --- what a mandate's state is ------------------------------------------------------------------

/**
 * A mandate's state at an instant, from its dates alone.
 *
 * Revocation beats expiry when both apply, and the order is not arbitrary: the customer's own act is the
 * stronger fact, and reporting a revoked mandate as merely "expired" would lose the one piece of
 * information that changes what may be said to them next.
 *
 * The boundary at `expiresAt` is EXCLUSIVE — `at >= expiresAt` is expired — which is the opposite of the
 * cancellation window's inclusive boundary and deliberately so. There the boundary favours the customer
 * who complied; here it favours the customer by ending the authority the instant it is due to end.
 */
export function mandateStateAt(mandate: MandateRecord, at: Instant): MandateState {
  if (mandate.revokedAt !== null && at >= mandate.revokedAt) return 'revoked'
  if (at >= mandate.expiresAt) return 'expired'
  return 'active'
}

// --- the gate -----------------------------------------------------------------------------------

export interface FeeChargeRequest {
  /** The mandate to charge, or `null` when the customer has none. */
  readonly mandate: MandateRecord | null
  readonly customerId: string
  /**
   * The figure, in fils. **An ARGUMENT, and never derived here.**
   *
   * The caller got it from `cancellationCharge()`, which answers zero, or from a policy that does not
   * exist. Either way this module does not compute it, and that is the point: a fee figure invented in
   * the one place a fee is charged is a fee policy written where nobody would look for one.
   */
  readonly requestedFils: number
  /** When the charge is being attempted. An ARGUMENT: core reads no clock. */
  readonly at: Instant
  readonly policy: FeeChargePolicy
}

/**
 * Refuses every fee charge this build can be asked to make, naming which reason applies.
 *
 * The order of the checks is load-bearing and is the reverse of the obvious one. The policy gate fires
 * LAST, after the mandate has been found, read and measured against its cap — so the acceptance lines
 * "a fee charge with no mandate, an expired mandate or a revoked mandate is refused with a named error"
 * and "a charge above the recorded cap is refused" are reachable and testable TODAY, rather than all
 * five collapsing into one `NoFeePolicyOnFile` the moment the first check runs. A guard that is
 * unreachable until a policy exists is a guard nobody has seen work, which is ADR 0003's whole subject.
 *
 * Throws, rather than returning a verdict, because there is no success value to return: today every
 * input is refused, and a function returning `{ ok: false }` invites a caller to carry on past it.
 */
export function assertFeeChargeable(request: FeeChargeRequest): void {
  const { mandate, customerId, requestedFils, at, policy } = request

  if (!Number.isInteger(requestedFils) || requestedFils <= 0) {
    throw new AppError(
      'validation',
      `assertFeeChargeable: ${requestedFils} fils is not a chargeable figure. Money is integer fils ` +
        '(ADR 0007), and a charge of zero or less is not a charge — it is the absence of one, which is ' +
        'a refusal rather than a posting.',
      { details: { customerId, requestedFils } },
    )
  }

  if (mandate === null) throw new NoMandateOnFile(customerId)

  const state = mandateStateAt(mandate, at)
  if (state === 'revoked') {
    // Non-null by construction: `mandateStateAt` answers `revoked` only when `revokedAt` is set.
    throw new MandateRevoked(mandate.mandateId, (mandate.revokedAt ?? 0) as number)
  }
  if (state === 'expired') {
    throw new MandateExpired(mandate.mandateId, mandate.expiresAt as number, at as number)
  }

  if (requestedFils > mandate.capFils) {
    throw new FeeExceedsMandateCap(mandate.mandateId, mandate.capFils, requestedFils)
  }

  if (!policy.onFile) {
    throw new NoFeePolicyOnFile(
      `a fee charge of ${requestedFils} fils against this mandate`,
      policy,
    )
  }
}

// --- what a no-show actually produces -----------------------------------------------------------

/**
 * What a no-show does under the provisional policy: a flag, and nothing else.
 *
 * The counts are in the RETURN VALUE rather than being left implicit in what the caller did or did not
 * write, because the acceptance line is "creates zero payment intents and zero journal entries, asserted
 * by row counts" and a figure a caller can assert is one a caller can be held to. The integration suite
 * asserts these three against the rows PostgreSQL actually holds, which is what makes the claim about the
 * database rather than about this object.
 */
export interface NoShowOutcome {
  readonly appointmentId: string
  /** The flag. The whole of what this build does about a no-show. */
  readonly flagged: true
  readonly paymentIntentsCreated: 0
  readonly journalEntriesCreated: 0
  /** The figure that was considered, and `null` when no policy made one. Never 0. */
  readonly feeFils: null
  readonly why: string
  readonly openQuestionId: string
}

/**
 * The no-show outcome, which is a flag.
 *
 * `feeFils: null` and not `0`, which is the same decision ADR 0070 made for an unattributable cost one
 * subject along: zero is a figure and this is the absence of one. A `0` here would be summed into a
 * "fees charged" total and reported as a measured nothing.
 */
export function noShowOutcome(input: {
  readonly appointmentId: string
  readonly policy: FeeChargePolicy
}): NoShowOutcome {
  return Object.freeze({
    appointmentId: input.appointmentId,
    flagged: true as const,
    paymentIntentsCreated: 0 as const,
    journalEntriesCreated: 0 as const,
    feeFils: null,
    why: input.policy.why,
    openQuestionId: input.policy.openQuestionId,
  })
}

/**
 * The cap, as the amount a mandate has left. Exported for the screen that shows it.
 *
 * A mandate's cap is a per-charge maximum and not a running budget — one charge of the cap is authorised,
 * and so is a second — which is why this is `capFils` and not `capFils - chargedSoFar`. Stated as a
 * function so the day somebody decides it IS a budget, there is one place to change and one test to
 * update rather than a subtraction to find in a screen.
 */
export function mandateHeadroomFils(mandate: MandateRecord): Fils {
  return filsFrom(mandate.capFils)
}
