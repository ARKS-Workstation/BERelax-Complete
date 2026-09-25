import { AppError } from '@berelax/shared'
import {
  MalformedTender,
  TENDER_ACCOUNT,
  TENDER_KINDS,
  type TenderKind,
} from '../checkout/posting.ts'
import type { AccountCode } from '../ledger/account.ts'
import type { Money } from '../money.ts'
import { filsFrom, money, subtract, sum } from '../money.ts'

/**
 * The tender-type registry, and the arithmetic of applying tenders to an amount due.
 *
 * Pure, like everything under `packages/core`: no clock, no I/O. Every figure is integer fils, and the
 * one subtraction that matters — what a tender settled, as against what was handed over — happens in
 * exactly one place here and in exactly one place in the database (`payment.applied_fils`, generated).
 *
 * ## Why the posting account is imported rather than restated
 *
 * `TENDER_ACCOUNT` in `../checkout/posting.ts` is where the posting rule reads the account each tender
 * is debited to, and it is the map `payment.posting_account_code` is snapshotted from. This module adds
 * the facts a *till* needs and a posting rule does not — whether a type gives change, whether it
 * requires a reference, whether it has settled — and it takes the account **from** that map rather than
 * spelling it again. A second list of accounts would be a second answer to "where does card money go",
 * and the first symptom of a disagreement is a bank reconciliation that is out by every unsettled batch.
 *
 * The import therefore runs `money/` → `checkout/`, which is the opposite of the usual direction inside
 * this package and is deliberate: the alternative is moving `TENDER_ACCOUNT` here, and the posting rule
 * is the thing that has to be right about it.
 *
 * ## What makes "a tender type without a posting account" a build failure
 *
 * {@link TENDER_TYPES} is a `Record<TenderKind, TenderTypeSpec>`, and `TenderKind` is derived from
 * `TENDER_KINDS`. Adding a kind to that tuple and stopping there fails `tsc` twice — once here and once
 * on `TENDER_ACCOUNT` — before any test runs. `tender.test.ts` then enumerates the tuple at runtime and
 * asserts every entry resolves to an account the chart contains, which is the half a type-level
 * exhaustiveness check cannot make: a `Record` is satisfied by an account code that is a plausible
 * string and names nothing.
 *
 * ## What is NOT here
 *
 * The **posting** of a payment or a refund. That is two journal lines and it is built where the write
 * happens (`packages/db/src/adapters/manual-payment.ts`), exactly as `postBill` builds its own: there is
 * no rate, no rounding and no derivation in it, so a mapping layer through this package would add a
 * second place for a line to be spelled and nothing else.
 *
 * The **overpayment refusal**. It is a statement about the total already recorded against a document,
 * which only the database knows, and it is `ZT001` plus `Overpayment` in the adapter. What is here is
 * the refusal that can be decided from the arguments alone: a surplus on a tender type that gives no
 * change ({@link ChangeNotAvailable}).
 */

/** The adapters a tender type can be served by. `gateway` is Y-PAY's, and nothing declares it yet. */
export const TENDER_ADAPTERS = ['manual', 'gateway'] as const
export type TenderAdapterName = (typeof TENDER_ADAPTERS)[number]

/** Everything the business knows about one way of taking money. */
export interface TenderTypeSpec {
  readonly code: TenderKind
  /** What a till shows. Not a key: renaming it must not become a new tender type. */
  readonly label: string
  /** Where a tender of this type is debited. Read from `TENDER_ACCOUNT`, never restated. */
  readonly account: AccountCode
  /**
   * May a customer hand over more than is due in this form?
   *
   * Cash only. A card is authorised for an amount and a transfer arrives for an amount, so a surplus on
   * either is a mis-keyed figure rather than a twenty-dirham note — and handing back "change" against
   * one takes real money out of the drawer that nobody over-paid.
   */
  readonly givesChange: boolean
  /**
   * Must the tender carry the terminal's approval code or the transfer reference?
   *
   * `0063_checkout.sql` could refuse a *blank* reference and had no way to refuse a **missing** one, so
   * a card payment with nothing to settle a dispute with was a storable row.
   */
  readonly requiresReference: boolean
  /**
   * Is the money in hand?
   *
   * Cash is in the drawer. A card batch settles days later, net of fees, and a transfer arrives when the
   * bank says so — which is why `card_in_salon` debits `1040 Card terminal clearing` and not the bank.
   * It is also why only an immediately-settled type may give change: change cannot be handed back out
   * of money that has not arrived.
   */
  readonly settlesImmediately: boolean
  /** Which adapter takes this form of money. */
  readonly adapter: TenderAdapterName
  /** The order a till offers the types in. Unique across the registry. */
  readonly sortOrder: number
}

/**
 * Every tender type, with its declared posting account.
 *
 * `Record<TenderKind, …>` is the build failure the acceptance asks for: a kind added to `TENDER_KINDS`
 * with no entry here does not compile. `0068_payment_tender.sql` seeds `tender_type` with exactly these
 * rows, and `packages/fixtures/src/payment.itest.ts` holds the two equal in both directions — the one
 * package allowed to depend on `@berelax/core` and `@berelax/db` at once.
 */
export const TENDER_TYPES: Readonly<Record<TenderKind, TenderTypeSpec>> = Object.freeze({
  cash: Object.freeze({
    code: 'cash',
    label: 'Cash',
    account: TENDER_ACCOUNT.cash,
    givesChange: true,
    requiresReference: false,
    settlesImmediately: true,
    adapter: 'manual',
    sortOrder: 1,
  }),
  card_in_salon: Object.freeze({
    code: 'card_in_salon',
    label: 'Card — in-salon terminal',
    account: TENDER_ACCOUNT.card_in_salon,
    givesChange: false,
    requiresReference: true,
    settlesImmediately: false,
    adapter: 'manual',
    sortOrder: 2,
  }),
  bank_transfer: Object.freeze({
    code: 'bank_transfer',
    label: 'Bank transfer',
    account: TENDER_ACCOUNT.bank_transfer,
    givesChange: false,
    requiresReference: true,
    settlesImmediately: false,
    adapter: 'manual',
    sortOrder: 3,
  }),
})

/** The registry in the order a till offers it, which is `sortOrder` and not insertion order. */
export const TENDER_TYPES_IN_ORDER: readonly TenderTypeSpec[] = Object.freeze(
  TENDER_KINDS.map((kind) => TENDER_TYPES[kind]).sort((a, b) => a.sortOrder - b.sortOrder),
)

/** Raised when a tender names a type the registry does not hold. */
export class UnknownTenderType extends AppError {
  constructor(kind: string) {
    super(
      'validation',
      `UnknownTenderType: "${kind}" is not a tender type this business takes. The registry holds ` +
        `${TENDER_KINDS.join(', ')}; adding one is a migration, because it needs a posting account ` +
        'chosen by somebody who knows what a clearing account is for.',
      { details: { kind, known: TENDER_KINDS } },
    )
    this.name = 'UnknownTenderType'
  }
}

/**
 * Raised when a tender is over what is due in a form that cannot give change back.
 *
 * Not the same refusal as an overpayment. An overpayment is a statement about what a document has
 * already been paid; this is a statement about the tender in hand: a card authorised for 120 against an
 * 80 balance is a mis-keyed amount, and the answer is to authorise 80, not to open the drawer.
 */
export class ChangeNotAvailable extends AppError {
  readonly surplusFils: number
  constructor(kind: TenderKind, surplusFils: number, dueFils: number) {
    super(
      'validation',
      `ChangeNotAvailable: a "${kind}" tender is over by ${surplusFils} fils against ${dueFils} fils ` +
        'outstanding, and that form gives no change. A card is authorised for an amount and a ' +
        'transfer arrives for one, so a surplus is a mis-keyed figure — paying it back out of the ' +
        'drawer would take money nobody over-paid.',
      { details: { kind, surplusFils, dueFils } },
    )
    this.name = 'ChangeNotAvailable'
    this.surplusFils = surplusFils
  }
}

/** Raised when a tender of a type that requires a reference carries none. */
export class TenderReferenceMissing extends AppError {
  constructor(kind: TenderKind) {
    super(
      'validation',
      `TenderReferenceMissing: a "${kind}" tender carries no reference. It is the field a disputed ` +
        'card payment is settled with, and absent is not the same as blank: an empty string reads as ' +
        'a reference that was not captured.',
      { details: { kind } },
    )
    this.name = 'TenderReferenceMissing'
  }
}

/** One tender offered against an amount due, before anything is decided about it. */
export interface TenderToApply {
  readonly kind: TenderKind
  /** Strictly positive. What the customer is handing over in this form. */
  readonly amount: Money
  /** The terminal's approval code or the transfer reference. Absent for cash, which has none. */
  readonly reference?: string
}

/** One tender, with what it settled and what was handed back separated. */
export interface AppliedTender {
  readonly kind: TenderKind
  readonly account: AccountCode
  /** What the customer handed over. Never reduced by the change. */
  readonly tendered: Money
  /** What it settled against the amount due. */
  readonly applied: Money
  /** What was handed back. `tendered - applied`, and zero unless the type gives change. */
  readonly changeGiven: Money
  readonly reference?: string
}

/** What a set of tenders did to an amount due. Every figure integer fils. */
export interface TenderSettlement {
  /** What was outstanding before these tenders. */
  readonly due: Money
  /** The sum of what was handed over, change included. */
  readonly tendered: Money
  /** The sum of what was applied. Never more than {@link due}. */
  readonly applied: Money
  /** The sum of what was handed back. */
  readonly changeGiven: Money
  /** `due - applied`. Zero or positive, and the receivable a partial payment leaves. */
  readonly outstanding: Money
  readonly tenders: readonly AppliedTender[]
  /** True when nothing is left outstanding. Not a success flag: a partial payment is a success. */
  readonly fullySettled: boolean
}

/** The spec for `kind`, or {@link UnknownTenderType} for a value cast past `TenderKind`. */
export function tenderTypeOf(kind: string): TenderTypeSpec {
  const spec = (TENDER_TYPES as Readonly<Record<string, TenderTypeSpec | undefined>>)[kind]
  if (spec === undefined) throw new UnknownTenderType(kind)
  return spec
}

/**
 * Applies tenders, in the order given, to an amount due.
 *
 * Each tender settles **at most** what is still outstanding, and the surplus is `changeGiven` rather
 * than a larger `applied` — which is the whole of the acceptance line "change given is recorded
 * separately rather than netted into the payment". Netting it the other way (a single figure of what
 * stayed in the drawer) loses the only record a counted drawer can be reconciled against: the notes
 * that went in and the notes that came out are two facts, and their difference is one.
 *
 * In order, and not proportionally or largest-first. The order is the order the operator took the money
 * in, and a rule that reallocated it would produce a `payment` row that disagrees with what happened at
 * the counter. It also means a surplus on an early tender is refused when a later one gives no change,
 * which is correct: the second card has nothing left to pay.
 *
 * Throws rather than returning a result union, for `checkoutPosting`'s reason: the caller's only useful
 * response to any of these refusals is to stop, and an ignored result union records whatever the
 * variable was initialised to.
 */
export function settleTenders(input: {
  readonly due: Money
  readonly tenders: readonly TenderToApply[]
}): TenderSettlement {
  const dueFils = input.due.fils
  if (!Number.isInteger(dueFils) || dueFils < 0) {
    throw new AppError(
      'validation',
      `settleTenders: the amount due is ${dueFils} fils. A negative balance is a credit note, not a ` +
        'payment, and a fractional fils reconciles against nothing.',
      { details: { dueFils } },
    )
  }
  if (input.tenders.length === 0) {
    throw new MalformedTender('no tender was offered', { tenders: 0 })
  }

  const currency = input.due.currency
  // Annotated `number` and not left to inference: `Fils` is a branded number, so `remaining -=` on an
  // inferred `Fils` does not typecheck. The brand is re-applied through `filsFrom` at the two points a
  // figure becomes `Money` again, which is where it belongs.
  let remaining: number = dueFils
  const applied: AppliedTender[] = []

  for (const [index, tender] of input.tenders.entries()) {
    const spec = tenderTypeOf(tender.kind)
    if (!Number.isInteger(tender.amount.fils) || tender.amount.fils <= 0) {
      // Zero is a tender somebody started and did not fill in; negative is a refund, which is a
      // different document with a different posting.
      throw new MalformedTender(
        `tender ${index + 1} (${tender.kind}) carries ${tender.amount.fils} fils`,
        { index: index + 1, kind: tender.kind, fils: tender.amount.fils },
      )
    }
    if (tender.amount.currency !== currency) {
      throw new MalformedTender(
        `tender ${index + 1} is in ${tender.amount.currency} against an amount due in ${currency}`,
        { index: index + 1, kind: tender.kind },
      )
    }
    if (spec.requiresReference && tender.reference === undefined) {
      throw new TenderReferenceMissing(tender.kind)
    }
    const appliedFils = Math.min(tender.amount.fils, remaining)
    const changeFils = tender.amount.fils - appliedFils
    if (changeFils > 0 && !spec.givesChange) {
      throw new ChangeNotAvailable(tender.kind, changeFils, remaining)
    }
    remaining -= appliedFils
    applied.push(
      Object.freeze({
        kind: tender.kind,
        account: spec.account,
        tendered: tender.amount,
        applied: money(filsFrom(appliedFils), currency),
        changeGiven: money(filsFrom(changeFils), currency),
        ...(tender.reference === undefined ? {} : { reference: tender.reference }),
      }),
    )
  }

  const tendered = sum(
    applied.map((tender) => tender.tendered),
    currency,
  )
  const appliedTotal = sum(
    applied.map((tender) => tender.applied),
    currency,
  )
  const changeTotal = sum(
    applied.map((tender) => tender.changeGiven),
    currency,
  )

  return Object.freeze({
    due: input.due,
    tendered,
    applied: appliedTotal,
    changeGiven: changeTotal,
    // Subtracted rather than read off `remaining`, so the returned figure is derived from the same two
    // totals the caller can check for itself.
    outstanding: subtract(input.due, appliedTotal),
    tenders: Object.freeze(applied),
    fullySettled: appliedTotal.fils === dueFils,
  })
}

/**
 * The identities a settlement must satisfy, as values.
 *
 * Returned rather than asserted, for `reconcilePosting`'s reason: a test and a runtime guard then read
 * one piece of arithmetic instead of two spellings of it. Every field is a difference that must be
 * **zero**, and naming them individually is what makes a failure say which one broke.
 */
export interface SettlementReconciliation {
  /** `tendered - (applied + changeGiven)`. Change is beside the payment, never inside it. */
  readonly tenderedVersusAppliedAndChangeFils: number
  /** `due - (applied + outstanding)`. */
  readonly dueVersusAppliedAndOutstandingFils: number
  /** `applied - due` where positive: how much was applied ABOVE what was owed. Must never be > 0. */
  readonly appliedAboveDueFils: number
  /** Change recorded against a tender type that gives none. Must be zero. */
  readonly changeOnATypeThatGivesNoneFils: number
}

export function reconcileSettlement(settlement: TenderSettlement): SettlementReconciliation {
  const perTenderTotal = settlement.tenders.reduce(
    (total, tender) => total + tender.applied.fils + tender.changeGiven.fils,
    0,
  )
  const illegalChange = settlement.tenders.reduce(
    (total, tender) =>
      TENDER_TYPES[tender.kind].givesChange ? total : total + tender.changeGiven.fils,
    0,
  )
  return {
    tenderedVersusAppliedAndChangeFils: settlement.tendered.fils - perTenderTotal,
    dueVersusAppliedAndOutstandingFils:
      settlement.due.fils - (settlement.applied.fils + settlement.outstanding.fils),
    appliedAboveDueFils: Math.max(0, settlement.applied.fils - settlement.due.fils),
    changeOnATypeThatGivesNoneFils: illegalChange,
  }
}
