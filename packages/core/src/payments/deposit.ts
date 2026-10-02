/**
 * A deposit: money received against ONE appointment, before the treatment it pays for is delivered.
 *
 * Y-PAY-06. Migration 0124 is the database half and ADR 0077 is the decision. Everything here is pure
 * arithmetic over integer fils plus the two refusals that make the word "deposit" mean what docs/01
 * decision 19b says it means and nothing wider.
 *
 * ## It is a LIABILITY, and the account is not a revenue account
 *
 * docs/03 §7: *"A deposit is a liability."* So receiving one credits `2045 Customer deposits held` at the
 * whole consideration and moves nothing on any revenue account and nothing on `2030 Output VAT payable`.
 * Revenue — and the output VAT on it — arrives when the invoice is issued, once, in the sale's own entry.
 * {@link depositReceiptEntry} is that posting and `deposit_receipt_posts_liability_only` (ZY302, DEFERRED)
 * is the same rule as a database refusal, so a hand-written entry at a `psql` prompt cannot recognise
 * revenue on a deposit either.
 *
 * **The VAT treatment is `Y11-vat-deposit`, open, and no rate is applied here.** A payment received before
 * a supply can be a date of supply in its own right, and whether it is, is a tax-agent question — the same
 * question `Y11-vat-package` asks one subject along for a prepaid package, where the provisional answer on
 * file is *"at redemption; deferred-revenue liability on sale"*. This unit takes that answer's SHAPE and
 * not its words: the deposit is held as a liability at its whole gross, UNSPLIT, and the invoice carries
 * the entire net/VAT split when the treatment is delivered. Holding the gross unsplit is what makes the
 * other answer a settings change and a new entry rather than a restatement — there is no net and no VAT
 * figure on a deposit row to have been wrong. A rate chosen here would be indistinguishable from a
 * configured one (brief rule 15), and it would be wrong in the only direction that matters: understating
 * an output-VAT box that has already been filed.
 *
 * ## The cumulative figure is the primitive (ADR 0057)
 *
 * The liability held against an appointment is the quantity; a movement is its DIFFERENCE. That is ADR
 * 0057's decision about the gratuity liability, inherited here for the reason that ADR gives: a running
 * total assembled from independently-rounded increments drifts, permanently, in an append-only journal
 * with no edit. Nothing here rounds at all — a deposit is a figure somebody keyed in and an application is
 * a `min` — so there is no residue to accumulate, and the shape is still worth keeping because it is what
 * makes {@link applyDepositToInvoice} answer in terms of a balance rather than of a history.
 *
 * ## Appointment-scoped, which is a refusal and not a convention
 *
 * {@link assertDepositRedeemable} refuses a release against a document that does not bill the appointment
 * the money was taken for ({@link DepositIsAppointmentScoped}) and refuses a release into a package sale
 * ({@link DepositIsNotAPrepaidProduct}). Both are `ZY304` and `ZY305` in the database as well, because a
 * TypeScript refusal protects the one path that goes through this module and the trigger protects every
 * path there is.
 *
 * The scope is the whole of why this unit is cheap. A payment on account that could be applied to any
 * invoice would make three questions unanswerable that are answerable here: how much of the balance is
 * refundable on a cancellation (all of the appointment's, and the appointment is named), which document
 * released it (the one that bills the appointment), and what happens when the customer never comes back
 * (nothing — there is no balance with no appointment behind it). Decision 19b says the same thing from the
 * other end: packages are the only prepaid product, and a deposit that could move between appointments or
 * become a package would be a second one.
 */
import { AppError } from '@berelax/shared'
import type { TenderKind, TenderLine } from '../checkout/posting.ts'
import { TENDER_ACCOUNT } from '../checkout/posting.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { EntryId, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { CancellationVerdict } from '../lifecycle/cancellation-policy.ts'
import type { Fils, Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'

/**
 * `2045 Customer deposits held`. Read from the chart, never spelled as a code.
 *
 * `customer_deposit_account_code()` in 0124 is the SQL statement of the same figure — `packages/db` may
 * not import `packages/core`, so a snapshot has to be taken from something — and
 * `packages/fixtures/src/deposit.itest.ts` holds the two equal. That is `tips_payable_account_code()`'s
 * arrangement (0068) one account along.
 */
export const DEPOSIT_LIABILITY_ACCOUNT = ACCOUNTS.customerDepositsHeld

/** The tender kind a release is recorded as. One spelling, read by the posting rule and the registry. */
export const DEPOSIT_TENDER_KIND: TenderKind = 'deposit_on_account'

/** Which services require a deposit, at what percentage, and whether first-timers prepay. Open. */
export const DEPOSIT_POLICY_OPEN_QUESTION = 'Y9-deposits'

/** Whether receiving a deposit is itself a date of supply. Open; see the module note. */
export const DEPOSIT_VAT_OPEN_QUESTION = 'Y11-vat-deposit'

/**
 * What a movement of the liability is.
 *
 * Three kinds and no `transferred`: there is no appointment a deposit may move to. The absence is the
 * decision — a vocabulary with a member nothing may write is a member somebody will later assume is in
 * use, which is C-AUTO-04's argument and brief rule 15's shape for an enum.
 */
export const DEPOSIT_MOVEMENT_KINDS = ['received', 'applied', 'refunded'] as const
export type DepositMovementKind = (typeof DEPOSIT_MOVEMENT_KINDS)[number]

/** Whether a movement adds to the liability or discharges it. The sign, stated once. */
export function movementIncreasesLiability(kind: DepositMovementKind): boolean {
  return kind === 'received'
}

// --- the refusals -------------------------------------------------------------------------------

/**
 * Raised when a deposit is offered against a document that does not bill the appointment it was taken
 * for.
 *
 * `validation` rather than `invariant_violated`: the operator CAN fix it, by billing the right
 * appointment or by refunding the deposit and taking a new one. `ZY304` is the same refusal in the
 * database, which is what covers the paths that do not come through here.
 */
export class DepositIsAppointmentScoped extends AppError {
  constructor(appointmentId: string, detail: string) {
    super(
      'validation',
      `DepositIsAppointmentScoped: the deposit held against appointment "${appointmentId}" ${detail}. ` +
        'A deposit is a part-payment against ONE booking (docs/01 decision 19b) — it has no balance, no ' +
        'expiry and no redemption schedule, and applying it elsewhere would make it a payment on ' +
        'account whose refund and cancellation questions nothing can answer.',
      { details: { appointmentId, openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION } },
    )
    this.name = 'DepositIsAppointmentScoped'
  }
}

/**
 * Raised when a deposit is offered towards a package.
 *
 * The conversion is the one that would undo decision 19b rather than bend it: it moves money out of
 * `2045` and into `2050 Deferred revenue — packages`, which is a second deferred-revenue path, a second
 * liability account on the same money and a second VAT date-of-supply question. `ZY305` refuses the
 * JOURNAL ENTRY that would do it, in either direction, so the conversion is unreachable from any caller
 * and not only from this one.
 */
export class DepositIsNotAPrepaidProduct extends AppError {
  constructor(appointmentId: string, packageSaleId: string) {
    super(
      'validation',
      `DepositIsNotAPrepaidProduct: the deposit held against appointment "${appointmentId}" may not be ` +
        `put towards package sale "${packageSaleId}". docs/01 decision 19b: packages are the only ` +
        'prepaid product, and a deposit "is not a prepaid product — it is a part-payment against one ' +
        'specific booking". Converting one would be a second deferred-revenue path on the same money, ' +
        'under a second answer to Y11-vat-package.',
      { details: { appointmentId, packageSaleId, openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION } },
    )
    this.name = 'DepositIsNotAPrepaidProduct'
  }
}

/** Raised when the deposit module is off and something tried to take one anyway. */
export class DepositsAreDisabled extends AppError {
  constructor(appointmentId: string) {
    super(
      'validation',
      `DepositsAreDisabled: no deposit may be taken for appointment "${appointmentId}". ` +
        `payments.deposit_enabled is false — ${DEPOSIT_POLICY_OPEN_QUESTION} in ` +
        'docs/OPEN-QUESTIONS.md asks which services require a deposit and at what percentage, and the ' +
        'provisional answer on file is "Deposits DISABLED. No service requires one". Answering it is ' +
        'one audited settings change.',
      { details: { appointmentId, openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION } },
    )
    this.name = 'DepositsAreDisabled'
  }
}

/** Raised when a movement would discharge more than is held. The database refuses it too (ZY303). */
export class DepositBalanceWouldGoNegative extends AppError {
  constructor(appointmentId: string, heldFils: number, dischargeFils: number) {
    super(
      'invariant_violated',
      `DepositBalanceWouldGoNegative: appointment "${appointmentId}" holds ${heldFils} fils of deposit ` +
        `and something tried to discharge ${dischargeFils}. A liability that can go negative is an ` +
        'asset nobody recorded.',
      { details: { appointmentId, heldFils, dischargeFils } },
    )
    this.name = 'DepositBalanceWouldGoNegative'
  }
}

// --- the policy ---------------------------------------------------------------------------------

/**
 * 10,000 basis points is the whole. A THIRD statement of a figure core already exports twice.
 *
 * `BASIS_POINTS` in `../seo/query-rows.ts` is a `number` about a click-through rate and
 * `WHOLE_IN_BASIS_POINTS` in `../reporting/operational-kpis.ts` is a `bigint` about a margin; neither is
 * about money a customer is asked for, and importing one of them would make a deposit figure depend on a
 * constant that belongs to a report. It arrives with the check that holds all three equal in the same
 * commit: `deposit.test.ts` asserts this constant equals both of the others.
 */
export const DEPOSIT_PERCENT_WHOLE_BP = 10_000

/** The deposit policy, normalised. The one answer to "may a deposit be taken, and how much". */
export interface DepositPolicy {
  readonly enabled: boolean
  /** Basis points of the booking's gross. Zero means no deposit on anything. */
  readonly percentBp: number
  readonly openQuestionId: string
}

/**
 * The stored policy, normalised — or the provisional default for anything that is not a policy.
 *
 * Normalising rather than throwing, which is `cancellationWindowHours`'s choice and here it is the only
 * safe one in the available direction: both fallbacks are the OFF reading, so a corrupt row leaves the
 * business asking nobody for money rather than asking somebody for a figure derived from a corrupt value.
 * `Number(null)` is 0 and `Boolean('false')` is true, which is why neither is coerced — the accepted
 * shapes are named.
 */
export function depositPolicy(stored: {
  readonly enabled: unknown
  readonly percentBp: unknown
}): DepositPolicy {
  const enabled = stored.enabled === true
  const raw =
    typeof stored.percentBp === 'number'
      ? stored.percentBp
      : typeof stored.percentBp === 'string' && stored.percentBp.trim() !== ''
        ? Number(stored.percentBp)
        : Number.NaN
  const percentBp = Number.isInteger(raw) && raw >= 0 && raw <= DEPOSIT_PERCENT_WHOLE_BP ? raw : 0
  return Object.freeze({ enabled, percentBp, openQuestionId: DEPOSIT_POLICY_OPEN_QUESTION })
}

/**
 * What deposit to ask for on a booking worth `grossFils`, or a refusal.
 *
 * **Refuses when the module is off rather than answering zero.** "No deposit because the module is
 * disabled" and "no deposit is due under the policy" are different facts, and Y9-commission records in so
 * many words what conflating them costs: a run that produced no lines was reported as no commission being
 * due. A caller that wants to know whether to ask reads `policy.enabled`; a caller that asks for a figure
 * gets one or gets told why not.
 *
 * **Rounded DOWN, and the direction is this build's reading on Y9-deposits.** Of the two available errors
 * only one is the business's to make: a fil too little costs the salon a fil, and a fil too much is money
 * taken from a customer that no agreed policy asked for. Nothing turns on it while the percentage is zero,
 * and the argument is written down so the day a rate is agreed the direction is a decision somebody can
 * disagree with rather than an artefact of whichever helper was to hand.
 */
export function depositDueFils(input: {
  readonly appointmentId: string
  readonly grossFils: number
  readonly policy: DepositPolicy
}): Fils {
  if (!input.policy.enabled) {
    throw new DepositsAreDisabled(input.appointmentId)
  }
  if (!Number.isInteger(input.grossFils) || input.grossFils < 0) {
    throw new AppError(
      'validation',
      `depositDueFils: a booking gross of ${input.grossFils} fils is not a figure. Money is integer ` +
        'fils (ADR 0007).',
      { details: { appointmentId: input.appointmentId, grossFils: input.grossFils } },
    )
  }
  // `BigInt` for the multiplication, not because the product overflows a safe integer at any realistic
  // price but because the alternative invites `grossFils * (percentBp / 10_000)` — a float, and a float
  // in a money figure is ADR 0007's whole subject.
  const product =
    (BigInt(input.grossFils) * BigInt(input.policy.percentBp)) / BigInt(DEPOSIT_PERCENT_WHOLE_BP)
  return filsFrom(Number(product))
}

// --- the balance --------------------------------------------------------------------------------

/** The WHOLE liability held against one appointment. ADR 0057's primitive, one subject along. */
export interface DepositBalance {
  readonly appointmentId: string
  /** Credit balance on 2045 attributable to this appointment. Never negative. */
  readonly heldFils: Fils
}

/** A movement, as a difference of cumulative balances. `heldAfterFils - heldBeforeFils`, signed. */
export interface DepositMovement {
  readonly kind: DepositMovementKind
  readonly heldBeforeFils: Fils
  readonly heldAfterFils: Fils
  /** Positive for a receipt, negative for an application or a refund. */
  readonly movementFils: number
}

/**
 * The movement a kind and an amount make against a balance.
 *
 * The caller states the AMOUNT and this states the balance either side of it, which is the direction ADR
 * 0057 argues for: the cumulative figure is the thing, and `movementFils` is derived from the two so the
 * two cannot disagree with it. 0124's ZY303 asserts the same identity over the stored rows.
 */
export function depositMovement(
  balance: DepositBalance,
  kind: DepositMovementKind,
  amountFils: number,
): DepositMovement {
  if (!Number.isInteger(amountFils) || amountFils <= 0) {
    throw new AppError(
      'validation',
      `depositMovement: a ${kind} movement of ${amountFils} fils is not a movement. Money is integer ` +
        'fils (ADR 0007) and direction is the kind, not the sign.',
      { details: { kind, amountFils } },
    )
  }
  const before = balance.heldFils
  if (movementIncreasesLiability(kind)) {
    return Object.freeze({
      kind,
      heldBeforeFils: before,
      heldAfterFils: filsFrom(before + amountFils),
      movementFils: amountFils,
    })
  }
  if (amountFils > before) {
    throw new DepositBalanceWouldGoNegative(balance.appointmentId, before, amountFils)
  }
  return Object.freeze({
    kind,
    heldBeforeFils: before,
    heldAfterFils: filsFrom(before - amountFils),
    movementFils: -amountFils,
  })
}

// --- receiving one ------------------------------------------------------------------------------

export interface DepositReceiptInput {
  readonly entryId: EntryId
  /** The business day, already resolved with `resolveTradingDate`. Never a calendar date. */
  readonly entryDate: LocalDate
  readonly appointmentId: string
  /** The whole consideration received, VAT-inclusive and UNSPLIT. See the module note. */
  readonly amount: Money
  /** How the money actually arrived. Never `deposit_on_account`: that kind releases, it does not take. */
  readonly tenderKind: TenderKind
}

/**
 * The receipt posting: debit where the money landed, credit `2045` by the whole amount.
 *
 * Two lines and no third. A rate applied here would produce a credit to `2030` for an output VAT
 * liability nobody has established arises (`Y11-vat-deposit`), and the figure would be on a filed return
 * before the question was asked.
 */
export function depositReceiptEntry(
  input: DepositReceiptInput,
  chart: ChartOfAccounts,
): JournalEntry {
  if (input.tenderKind === DEPOSIT_TENDER_KIND) {
    // A deposit received "as a deposit" would debit 2045 and credit 2045: the liability unchanged, the
    // movement row written, and the money never collected at all.
    throw new AppError(
      'validation',
      `depositReceiptEntry: a deposit cannot be RECEIVED as "${DEPOSIT_TENDER_KIND}". That kind is how ` +
        'a deposit already held is released against a document; receiving one takes cash, a card or a ' +
        'transfer.',
      { details: { appointmentId: input.appointmentId, tenderKind: input.tenderKind } },
    )
  }
  const landed = TENDER_ACCOUNT[input.tenderKind]
  return postEntry(
    {
      entryId: input.entryId,
      entryDate: input.entryDate,
      // `payment` and not `sale`: no supply has been made. 0018's `source` column exists because "a
      // refund and a cancelled sale produce identical lines and are answered differently when a
      // customer asks", and the same is true of a deposit against a sale.
      source: 'payment',
      narrative: `Deposit received for appointment ${input.appointmentId}`,
      lines: [
        debit(landed, input.amount, `Deposit received (${input.tenderKind})`),
        credit(
          DEPOSIT_LIABILITY_ACCOUNT,
          input.amount,
          `Held for appointment ${input.appointmentId}`,
        ),
      ],
    },
    chart,
  )
}

// --- applying one at checkout -------------------------------------------------------------------

/** What a document's deposit settles, what is still due, and what stays held. */
export interface DepositApplication {
  /** `min(heldFils, invoiceGrossFils)`. What the release tender carries. */
  readonly appliedFils: Fils
  /** `invoiceGrossFils - appliedFils`. What the customer still hands over. */
  readonly amountDueFils: Fils
  /** `heldFils - appliedFils`. Non-zero only when the deposit exceeds the document. */
  readonly remainingHeldFils: Fils
}

/**
 * What a held deposit settles against a document, and what is left to collect.
 *
 * `min` and not an assertion that the deposit fits, because it legitimately may not: a customer who put
 * down a deposit for a 90-minute treatment and took a 60-minute one has more held than the document is
 * worth. The excess stays on `2045` as `remainingHeldFils` — it is still the customer's money and the
 * appointment it belongs to is still named — and what happens to it is a refund, never a balance that
 * floats free of an appointment.
 *
 * Two identities hold for every input and are what the property suite generates against:
 * `appliedFils + amountDueFils === invoiceGrossFils` and `appliedFils + remainingHeldFils === heldFils`.
 * Nothing is created and nothing is destroyed on either side of the release.
 */
export function applyDepositToInvoice(input: {
  readonly invoiceGrossFils: number
  readonly heldFils: number
}): DepositApplication {
  const { invoiceGrossFils, heldFils } = input
  if (!Number.isInteger(invoiceGrossFils) || invoiceGrossFils < 0) {
    throw new AppError(
      'validation',
      `applyDepositToInvoice: an invoice gross of ${invoiceGrossFils} fils is not a figure. Money is ` +
        'integer fils (ADR 0007).',
      { details: { invoiceGrossFils } },
    )
  }
  if (!Number.isInteger(heldFils) || heldFils < 0) {
    throw new AppError(
      'validation',
      `applyDepositToInvoice: a held balance of ${heldFils} fils is not a liability. Money is integer ` +
        'fils (ADR 0007) and a liability does not go negative.',
      { details: { heldFils } },
    )
  }
  const applied = heldFils < invoiceGrossFils ? heldFils : invoiceGrossFils
  return Object.freeze({
    appliedFils: filsFrom(applied),
    amountDueFils: filsFrom(invoiceGrossFils - applied),
    remainingHeldFils: filsFrom(heldFils - applied),
  })
}

/**
 * The tender line the checkout presents for the applied part, or `null` when nothing is held.
 *
 * `null` rather than a zero tender: `checkoutPosting` refuses a non-positive tender by name, and a
 * zero-fils release would write a `payment` row for a settlement that settled nothing.
 */
export function depositReleaseTender(
  application: DepositApplication,
  reference: string,
): TenderLine | null {
  if (application.appliedFils === 0) return null
  return Object.freeze({
    kind: DEPOSIT_TENDER_KIND,
    amount: money(application.appliedFils),
    reference,
  })
}

// --- what a deposit may be redeemed against -----------------------------------------------------

/**
 * Everything the system can name as a target for a deposit.
 *
 * `package_sale` is a member although it is ALWAYS refused, and that is deliberate: it makes
 * {@link assertDepositRedeemable} total over the targets that exist, so the refusal is reachable without
 * a cast past the type and a sixth target added later cannot be silently accepted. `cancellationCharge`
 * in `../lifecycle/cancellation-policy.ts` is a function rather than an absence for the same reason —
 * the seam is the thing that makes the decision findable.
 */
export type DepositRedemptionTarget =
  | {
      readonly kind: 'appointment_invoice'
      readonly invoiceId: string
      /** From `invoice_appointment`. The appointments this document actually bills. */
      readonly billedAppointmentIds: readonly string[]
    }
  | { readonly kind: 'package_sale'; readonly packageSaleId: string }

/**
 * Refuses every target but a document that bills this appointment.
 *
 * Both refusals are the acceptance line *"redeeming a deposit against a different appointment, or
 * converting it to a package, is refused with a named error, asserted for both"*, and both are asserted
 * from outside as well: `ZY304` and `ZY305` in migration 0124.
 */
export function assertDepositRedeemable(
  appointmentId: string,
  target: DepositRedemptionTarget,
): void {
  if (target.kind === 'package_sale') {
    throw new DepositIsNotAPrepaidProduct(appointmentId, target.packageSaleId)
  }
  if (!target.billedAppointmentIds.includes(appointmentId)) {
    throw new DepositIsAppointmentScoped(
      appointmentId,
      `cannot settle document "${target.invoiceId}", which bills ` +
        (target.billedAppointmentIds.length === 0
          ? 'no appointment'
          : `appointment(s) ${target.billedAppointmentIds.join(', ')}`),
    )
  }
}

// --- refunding one on a cancellation ------------------------------------------------------------

/** What a cancellation returns, what it keeps, and the figure that decided it. */
export interface DepositRefund {
  /** What goes back to the customer. */
  readonly refundFils: Fils
  /** What the business keeps. `cancellationCharge()`, capped at what is held. */
  readonly retainedFils: Fils
  /** True when the cancellation arrived INSIDE the window, which is what `late` means (B-LIFE-03). */
  readonly insideWindow: boolean
  /** The window that judged it, in whole hours, carried so the figure can be accounted for. */
  readonly windowHours: number
  /** Why the business kept what it kept, in the words the admin panel shows. */
  readonly why: string
  readonly openQuestionId: string
}

/**
 * The deposit a cancellation returns. **In full, today, on either side of the window.**
 *
 * The retention is `verdict.chargeFils` and nothing else, which is the seam B-LIFE-03 built:
 * `cancellationCharge()` answers zero for every input, `Y9-windows` says *"24h window; no fee charged,
 * flagged only"*, and the day a fee is agreed that function is the one place that changes. So the
 * subtraction here is real arithmetic over a figure that is currently zero — not a branch that returns
 * the balance, which would be a retention policy of "never" written where a later reader would have to
 * find it to change it.
 *
 * The acceptance line is *"cancelling inside the provisional 24h window refunds the deposit in full and
 * returns that appointment's liability balance to zero"*, and `insideWindow` is carried rather than
 * assumed: it is `verdict.late`, and Y-PAY-07 — which owns the no-show and late-cancellation fee path —
 * needs the fact recorded on the row rather than re-derived from two timestamps and a setting that may
 * have moved since.
 *
 * The cap matters and is not defensive clutter. If a fee is ever agreed and exceeds the deposit, an
 * uncapped subtraction returns a NEGATIVE refund, which posts as money arriving from a cancellation.
 */
export function depositRefundOnCancellation(input: {
  readonly heldFils: number
  readonly verdict: CancellationVerdict
}): DepositRefund {
  const { heldFils, verdict } = input
  if (!Number.isInteger(heldFils) || heldFils < 0) {
    throw new AppError(
      'validation',
      `depositRefundOnCancellation: a held balance of ${heldFils} fils is not a liability.`,
      { details: { heldFils } },
    )
  }
  const retained = verdict.chargeFils > heldFils ? heldFils : verdict.chargeFils
  return Object.freeze({
    refundFils: filsFrom(heldFils - retained),
    retainedFils: filsFrom(retained),
    insideWindow: verdict.late,
    windowHours: verdict.windowHours,
    why: verdict.chargeWhy,
    openQuestionId: verdict.openQuestionId,
  })
}

export interface DepositRefundInput {
  readonly entryId: EntryId
  readonly entryDate: LocalDate
  readonly appointmentId: string
  readonly refund: DepositRefund
  /** How the money goes back. Never `deposit_on_account` — that kind releases against a document. */
  readonly tenderKind: TenderKind
}

/**
 * The refund posting: debit `2045` by what goes back, credit where the money leaves from.
 *
 * A NEW entry and never an edit of the receipt's (ADR 0017, and `refund`'s own note in 0068: "its posting
 * is a new journal entry, never an edit of the sale's"). `source` is `refund`, so the two sides of a
 * deposit that was taken and returned read as two events in the journal rather than as one that never
 * happened.
 *
 * The retained part is deliberately NOT posted here. Today it is always zero; the day a fee exists it is
 * revenue or other income under a classification `Y9-windows` has not been asked for, and crediting
 * `4090` on this build's own reading would be a figure nobody approved landing in a VAT box.
 */
export function depositRefundEntry(
  input: DepositRefundInput,
  chart: ChartOfAccounts,
): JournalEntry {
  if (input.refund.refundFils === 0) {
    throw new AppError(
      'validation',
      `depositRefundEntry: appointment "${input.appointmentId}" has nothing to refund. An entry with ` +
        'two zero lines is not evidence that money moved.',
      { details: { appointmentId: input.appointmentId } },
    )
  }
  if (input.tenderKind === DEPOSIT_TENDER_KIND) {
    throw new AppError(
      'validation',
      `depositRefundEntry: a deposit cannot be refunded as "${DEPOSIT_TENDER_KIND}". That kind debits ` +
        '2045, so the entry would credit and debit the same liability and return nothing.',
      { details: { appointmentId: input.appointmentId, tenderKind: input.tenderKind } },
    )
  }
  const amount = money(input.refund.refundFils)
  return postEntry(
    {
      entryId: input.entryId,
      entryDate: input.entryDate,
      source: 'refund',
      narrative: `Deposit refunded on cancellation of appointment ${input.appointmentId}`,
      lines: [
        debit(DEPOSIT_LIABILITY_ACCOUNT, amount, `Released for appointment ${input.appointmentId}`),
        credit(TENDER_ACCOUNT[input.tenderKind], amount, `Deposit refunded (${input.tenderKind})`),
      ],
    },
    chart,
  )
}
