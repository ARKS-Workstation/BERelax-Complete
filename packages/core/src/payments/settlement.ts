import { AppError } from '@berelax/shared'
import type { Account, AccountCode } from '../ledger/account.ts'
import { ACCOUNTS, accountFor, type ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import {
  credit,
  debit,
  type EntryId,
  type EntryLineDraft,
  type JournalEntry,
  postEntry,
} from '../ledger/entry.ts'
import { add, filsFrom, type Money, money, subtract, sum } from '../money.ts'
import type { ReverseCharge } from '../tax/reverse-charge.ts'
import {
  REVERSE_CHARGE_INPUT_ACCOUNT,
  REVERSE_CHARGE_OUTPUT_ACCOUNT,
} from '../tax/reverse-charge.ts'
import type { LocalDate } from '../time.ts'

/**
 * The gateway payout file, reconciled to the fils, and the bank receipt it posts.
 *
 * Y-PAY-09. Pure: every figure is an argument, no clock is read, and nothing here knows what a file
 * looks like on disk — {@link SettlementFile} is the PARSED form and the parse is the worker's.
 *
 * ## "To the fils" is an identity, not a tolerance
 *
 * There is no `toleranceFils` parameter in this module and there is deliberately nowhere one could be
 * added. A settlement line either TIES to a figure this build already holds, or it is a NAMED variance,
 * and a difference that belongs to no line at all is {@link SETTLEMENT_VARIANCE_KINDS}' `unattributable`
 * — which refuses the batch rather than posting the residue somewhere (ADR 0070).
 *
 * The reason a tolerance is the dangerous parameter here, rather than a convenience, is what it does to
 * the only error this process can actually make. An acquirer's file disagreeing by a few fils is either
 * a rounding difference somebody has to explain or money that went somewhere — and those two are the
 * same number. A tolerance of five fils reconciles both, silently, on every batch, and the figure it
 * leaves behind is a balance on `1030 Gateway clearing` that grows by a little every payout and ties to
 * nothing. R-REP-04 made the same argument about a cost component (ADR 0070): a zero substituted for an
 * unknown is indistinguishable from a measured zero, and a difference absorbed by a tolerance is
 * indistinguishable from no difference.
 *
 * So {@link reconcileSettlementBatch} returns differences as VALUES, every one of which must be zero, in
 * `reconcileSettlement`'s shape one subject along (`../money/tender.ts`): a failure then says WHICH
 * identity broke instead of that something did.
 *
 * ## What the file states, and what this module refuses to invent
 *
 * No gateway has been chosen (OPEN-QUESTIONS `Y7-gateway`), so nothing here holds a fee rate, an
 * interchange figure, an MCC or a settlement delay. **The fee is whatever the file says it is**, and the
 * only claim made about it is that the lines sum to the net the file itself declares. An "expected fee"
 * computed from a rate would be a rate this build invented, and the check it fed would then fail on every
 * real batch or pass on every wrong one (brief rule 15).
 *
 * The settlement DELAY is the same: a capture on business day D settles whenever the acquirer pays, and
 * this module never derives one date from the other. `settledOn` arrives on the file and the trading date
 * of the capture stays where the capture put it, which is the whole of the acceptance line about D+2 —
 * see "Why a settlement moves no revenue" below.
 *
 * ## Why a settlement moves no revenue, and why the tip is TIED rather than posted
 *
 * A settlement is a CASH movement. The sale was recognised when the invoice was raised, at its own tax
 * point, and the tip became a liability when the till took it. So {@link settlementBatchEntry} posts to
 * `1020`, `1030`, `6080` and the reverse-charge pair, and to nothing else —
 * {@link assertNoRevenueOrTipPosting} is what makes that structural rather than a property of the code as
 * written today. Two acceptance lines are the same claim read from two directions: a capture settling two
 * days later cannot move revenue between business days if the settlement touches no revenue account at
 * all, and a card tip cannot reach revenue for the same reason.
 *
 * The tip is the one line worth explaining, because the obvious implementation double-counts. The till
 * already debited the clearing account for the WHOLE card tender — invoice gross plus tip — and credited
 * `2040 Tips payable` with the tip (`../checkout/posting.ts`). A settlement that credited `2040` again
 * would record the same obligation twice, and the second copy would be indistinguishable from a tip
 * nobody had posted. So the tip line's job here is the TIE: `SETTLEMENT_LINE_TIE_ACCOUNT.tip` is
 * `2040 Tips payable`, the caller supplies the tip figure the checkout recorded, and a tip the acquirer
 * reports that disagrees with it by one fils is a named variance. The money itself is released from the
 * clearing account along with the capture it arrived inside, which is where the till put it.
 *
 * A chargeback line is released from the clearing account too, and NOT from `1045 Disputed card
 * receipts`, which reads backwards until you follow the money: Y-PAY-08's received entry has already
 * moved the amount out of `1030` and into `1045` (ADR 0089), so the clearing balance this batch pays over
 * is already net of it, and `1045` is discharged by the dispute's own resolution rather than by a payout.
 * Crediting `1045` here would unwind the claim the moment the acquirer took the money, which is the one
 * thing a dispute's partition is total in order to prevent.
 */

/**
 * What a line of a payout file can be.
 *
 * Five kinds, and each one is a kind this build can already tie to something: a capture and a refund to
 * `payment_intent`'s own figures, a chargeback to a `chargeback` row, a tip to what the till recorded on
 * `2040`, and a fee to the batch itself. A sixth kind could not be reconciled against anything, which is
 * why the enumeration is closed and why an unrecognised kind is a parse refusal rather than a line the
 * import carries along.
 */
export const SETTLEMENT_LINE_KINDS = ['capture', 'refund', 'chargeback', 'tip', 'fee'] as const
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number]

/**
 * What each kind does to the money the acquirer pays over. `+1` arrives, `-1` is deducted.
 *
 * Data rather than a `switch`, so the batch total and the clearing release are ONE statement of the signs
 * and a kind added to the tuple fails `tsc` here before any test runs — `TENDER_TYPES`' arrangement in
 * `../money/tender.ts`, for its reason.
 *
 * Every `amount` in this module is POSITIVE and the direction lives here. A signed amount would make
 * `-500` and a refund of `500` two spellings of one fact, and the file's own figures are magnitudes.
 */
export const SETTLEMENT_LINE_PAYOUT_SIGN: Readonly<Record<SettlementLineKind, 1 | -1>> =
  Object.freeze({
    capture: 1,
    tip: 1,
    refund: -1,
    chargeback: -1,
    fee: -1,
  })

/**
 * Which kinds move the gateway clearing balance, and which do not.
 *
 * Every kind but the fee: a capture, a tip and a refund all passed through `1030` at the till, and a
 * chargeback was moved out of it by its own received entry. The FEE never touched it — it is the
 * acquirer's own charge, deducted from the payout and recognised as an expense when this batch posts.
 */
export const SETTLEMENT_LINE_MOVES_CLEARING: Readonly<Record<SettlementLineKind, boolean>> =
  Object.freeze({
    capture: true,
    tip: true,
    refund: true,
    chargeback: true,
    fee: false,
  })

/**
 * The account each kind is RECONCILED AGAINST — where this build already recorded the same fact.
 *
 * Not where the settlement entry posts. The entry posts to `1020`, `1030` and `6080` only; this is the
 * answer to "what does a line of the acquirer's file claim about our books", which is what makes a
 * one-fils disagreement nameable. The tip's entry here is the whole of the acceptance line about tips
 * reaching a liability and never revenue, and {@link assertNoRevenueOrTipPosting} holds the other half.
 */
export const SETTLEMENT_LINE_TIE_ACCOUNT: Readonly<Record<SettlementLineKind, AccountCode>> =
  Object.freeze({
    capture: ACCOUNTS.gatewayClearing,
    refund: ACCOUNTS.gatewayClearing,
    chargeback: ACCOUNTS.disputedCardReceipts,
    tip: ACCOUNTS.tipsPayable,
    fee: ACCOUNTS.paymentProcessingFees,
  })

/**
 * Which kinds must tie to a record this build already holds.
 *
 * Everything but the fee. A fee line has no local counterpart BEFORE the import — nothing in this system
 * knows what an acquirer will charge, and nothing may guess — so it is attributable to the batch by
 * construction and its figure is the file's. That is not a hole in the identity: the fee is still bound
 * by the batch total, so a fee inflated by one fils makes the lines disagree with the declared net and
 * refuses the batch (`unattributable`).
 */
export const SETTLEMENT_LINE_TIES_LOCALLY: Readonly<Record<SettlementLineKind, boolean>> =
  Object.freeze({
    capture: true,
    refund: true,
    chargeback: true,
    tip: true,
    fee: false,
  })

/** One line of the acquirer's payout file, parsed. `amount` is positive; the sign is the kind's. */
export interface SettlementLine {
  /**
   * The line's position in the file, 1-based. Carried so a variance can NAME the offending line, which
   * is what the acceptance line asks for — a reference alone cannot, because one reference legitimately
   * appears on a capture line and a tip line of the same file.
   */
  readonly lineNo: number
  readonly kind: SettlementLineKind
  /**
   * What the acquirer calls the thing this line is about: the gateway intent id for a capture, a tip or
   * a refund, the dispute reference for a chargeback, the batch reference for a fee.
   *
   * Free text and no shape asserted, for `chargeback.dispute_ref`'s reason (0135): no gateway has been
   * chosen and the format of a reference a vendor nobody picked will mint is not this build's to assume.
   */
  readonly reference: string
  readonly amount: Money
}

/** A parsed payout file, as the worker read it. */
export interface SettlementFile {
  readonly batchReference: string
  /**
   * The digest of the BYTES, computed by the caller.
   *
   * Here rather than computed in this module because `packages/core` may not hash — `node:crypto` is I/O
   * surface the purity gate forbids — and because the hash has to be of what arrived, not of a
   * re-serialisation of what was parsed. Two files that parse to the same lines in a different order are
   * the same settlement and must be the same no-op; two files whose bytes differ by a line nobody parsed
   * are not, and only the bytes can say so.
   */
  readonly contentSha256: string
  /** The date the acquirer paid. The file's own, never derived from a capture's trading date. */
  readonly settledOn: LocalDate
  /**
   * The net bank receipt the file itself declares.
   *
   * Signed, because an acquirer bills the business in a period of heavy chargebacks and a payout can be
   * negative. The whole point of carrying the file's own declaration beside the lines is that the two can
   * DISAGREE, and a difference belonging to no line is the `unattributable` refusal.
   */
  readonly declaredNetFils: number
  readonly lines: readonly SettlementLine[]
}

/**
 * What this build already holds for one (kind, reference) pair, supplied by the caller from SQL.
 *
 * `localFils` is `null` for "no such record", which is NOT zero: a capture the acquirer reports and this
 * build has never heard of is a line to quarantine and alert on, and a capture of nought fils is a
 * malformed line. ADR 0070's distinction, one subject along.
 */
export interface SettlementTie {
  readonly kind: SettlementLineKind
  readonly reference: string
  readonly localFils: number | null
}

export const SETTLEMENT_VARIANCE_KINDS = [
  /** The file's figure and this build's figure differ. The one-fils case. */
  'amount_disagrees',
  /** Nothing local answers to this (kind, reference). Quarantined, never force-matched. */
  'no_local_record',
  /** One (kind, reference) appears twice in one file. */
  'duplicate_line',
  /** The amount is not a positive whole number of fils. */
  'amount_malformed',
  /** The lines do not sum to the net the file declares, so the difference belongs to no line. */
  'unattributable',
] as const
export type SettlementVarianceKind = (typeof SETTLEMENT_VARIANCE_KINDS)[number]

/** One named variance. Every field is what a report prints; nothing has to be re-derived to read it. */
export interface SettlementVariance {
  readonly kind: SettlementVarianceKind
  /** `null` only for `unattributable`, which is a fact about the batch rather than about a line. */
  readonly lineNo: number | null
  readonly lineKind: SettlementLineKind | null
  readonly reference: string
  readonly fileFils: number
  /** `null` when there is no local figure at all, which is a different claim from a local nought. */
  readonly localFils: number | null
  /** `fileFils - (localFils ?? 0)` where that is meaningful; the residue for `unattributable`. */
  readonly differenceFils: number
  /** Why, in the words a report shows an operator. */
  readonly explanation: string
}

/** The totals the batch's entry is built from. Derived, so nothing can disagree with the lines. */
export interface SettlementTotals {
  readonly captures: Money
  readonly refunds: Money
  readonly chargebacks: Money
  readonly tips: Money
  readonly fees: Money
  /**
   * `captures + tips - refunds - chargebacks`, signed. What leaves `1030 Gateway clearing`.
   *
   * A number rather than `Money`, because `Money.fils` is non-negative by construction and this quantity
   * is legitimately negative in a batch whose chargebacks exceed its captures.
   */
  readonly clearingReleasedFils: number
  /** `clearingReleased - fees`, signed. What the bank receives, or is billed. */
  readonly netPayoutFils: number
}

/**
 * The differences a settlement must satisfy. Every field is a figure that must be ZERO.
 *
 * Returned rather than asserted, which is `reconcileSettlement`'s arrangement in `../money/tender.ts` and
 * is what makes a failure say which identity broke. Naming them individually is the point: "the batch did
 * not reconcile" is not a report somebody can act on.
 */
export interface SettlementIdentities {
  /** `declaredNet - Σ(sign × amount)`. Non-zero means the residue belongs to no line. */
  readonly declaredVersusLinesFils: number
  /** `Σ |file - local|` over the lines that tie. Non-zero names the lines. */
  readonly linesVersusLocalFils: number
  /** `Σ amount` over lines with no local record at all. Non-zero means something is quarantined. */
  readonly quarantinedFils: number
  /** `Σ amount` over malformed and duplicated lines. */
  readonly malformedFils: number
}

/**
 * The whole answer for one file.
 *
 * `SettlementBatchReconciliation` and not `SettlementReconciliation`, because `../money/tender.ts`
 * already exports that name for the till's own identity set — cash tendered against what was due — and
 * `packages/core/src/index.ts` re-exports both modules flat, so the second spelling is a `tsc` failure
 * (TS2308) rather than a style question. The two really are different subjects: one is the drawer at the
 * end of a shift, the other is the acquirer's payout days later.
 */
export interface SettlementBatchReconciliation {
  readonly batchReference: string
  readonly contentSha256: string
  readonly settledOn: LocalDate
  readonly totals: SettlementTotals
  readonly identities: SettlementIdentities
  /** In line order, and batch-level variances last. Empty exactly when the batch reconciles. */
  readonly variances: readonly SettlementVariance[]
  /**
   * Every identity zero AND no variance.
   *
   * Both halves, because they are different claims and neither implies the other: a file whose lines sum
   * to its declared net can still carry a capture that ties to nothing, and a quarantined line leaves
   * every total intact.
   */
  readonly reconciled: boolean
}

/** Raised when a batch that did not reconcile is asked to post. */
export class SettlementVarianceRefusesToPost extends AppError {
  constructor(reconciliation: SettlementBatchReconciliation) {
    const named = reconciliation.variances
      .map((variance) =>
        variance.lineNo === null
          ? `${variance.kind} (${variance.differenceFils} fils, no line)`
          : `line ${variance.lineNo} ${variance.lineKind} ${variance.reference}: ${variance.kind} ` +
            `(${variance.differenceFils} fils)`,
      )
      .join('; ')
    super(
      'invariant_violated',
      `SettlementVarianceRefusesToPost: batch ${reconciliation.batchReference} carries ` +
        `${reconciliation.variances.length} variance(s) and may not post. ${named}. Reconciliation is ` +
        'to the fils and there is no tolerance to widen: a difference absorbed here is a balance on the ' +
        'clearing account that ties to nothing and grows by a little every payout (ADR 0070, ADR 0090).',
      {
        details: {
          batchReference: reconciliation.batchReference,
          identities: reconciliation.identities,
          variances: reconciliation.variances,
        },
      },
    )
    this.name = 'SettlementVarianceRefusesToPost'
  }
}

/** Raised when a settlement entry would touch an account a settlement has no business touching. */
export class SettlementWouldPostOutsideCash extends AppError {
  constructor(account: Account) {
    super(
      'invariant_violated',
      `SettlementWouldPostOutsideCash: a settlement entry names ${account.code} ` +
        `(${account.name}, ${account.type}). A payout is a CASH movement: the sale was recognised at ` +
        'its own tax point and the tip became a liability when the till took it, so an entry here that ' +
        'reached revenue would move a sale into the month the acquirer happened to pay, and one that ' +
        'reached tips payable would record the same obligation twice.',
      { details: { account: account.code, type: account.type } },
    )
    this.name = 'SettlementWouldPostOutsideCash'
  }
}

/** Raised when a fee line exists and the caller supplied no tax treatment for the processor. */
export class SettlementFeeHasNoTaxTreatment extends AppError {
  constructor(feeFils: number) {
    super(
      'validation',
      `SettlementFeeHasNoTaxTreatment: the batch deducts ${feeFils} fils of processor fee and no ` +
        'supplier tax treatment was supplied. Whether that fee carries UAE VAT, self-accounts under the ' +
        'imported-services reverse charge, or is outside the scope entirely is a fact about the ' +
        "processor's residency in `supplier_tax_profile`, and it is a REFUSAL rather than a default: " +
        'defaulting to domestic drops the reverse charge on every offshore batch, and the return still ' +
        'balances (ADR 0088, docs/04 §4).',
      { details: { feeFils } },
    )
    this.name = 'SettlementFeeHasNoTaxTreatment'
  }
}

const tieKey = (kind: SettlementLineKind, reference: string): string => `${kind}\u0000${reference}`

/**
 * The reconciliation of one parsed file against the figures this build holds.
 *
 * Order-independent: the lines are summed and matched by (kind, reference), never by position, so a file
 * whose lines arrive in another order reconciles identically. `lineNo` is carried for the REPORT and is
 * not part of the matching, which is the distinction a settlement file invites getting wrong — an
 * acquirer's ordering is its own and changes without notice.
 */
export function reconcileSettlementBatch(
  file: SettlementFile,
  ties: readonly SettlementTie[],
): SettlementBatchReconciliation {
  const byKey = new Map(ties.map((tie) => [tieKey(tie.kind, tie.reference), tie]))
  const variances: SettlementVariance[] = []
  const seen = new Set<string>()

  let signedTotal = 0
  let linesVersusLocal = 0
  let quarantined = 0
  let malformed = 0
  const perKind: Record<SettlementLineKind, number> = {
    capture: 0,
    refund: 0,
    chargeback: 0,
    tip: 0,
    fee: 0,
  }

  for (const line of file.lines) {
    const fileFils = line.amount.fils
    const key = tieKey(line.kind, line.reference)

    // Malformed first, and the line then contributes to NO total. A zero or fractional amount folded
    // into the batch sum would make the declared-net identity fail as well, and the report would name
    // two problems for one line — the second of which nobody can act on.
    if (!Number.isInteger(fileFils) || fileFils <= 0) {
      malformed += Math.abs(fileFils)
      variances.push({
        kind: 'amount_malformed',
        lineNo: line.lineNo,
        lineKind: line.kind,
        reference: line.reference,
        fileFils,
        localFils: null,
        differenceFils: fileFils,
        explanation:
          `Line ${line.lineNo} carries ${fileFils} fils. Every figure in a payout file is a positive ` +
          'whole number of fils and the direction is the line KIND, so a nought is a missing amount and ' +
          'a fraction is a figure that cannot have come from a ledger.',
      })
      continue
    }

    if (seen.has(key)) {
      malformed += fileFils
      variances.push({
        kind: 'duplicate_line',
        lineNo: line.lineNo,
        lineKind: line.kind,
        reference: line.reference,
        fileFils,
        localFils: byKey.get(key)?.localFils ?? null,
        differenceFils: fileFils,
        explanation:
          `Line ${line.lineNo} repeats ${line.kind} ${line.reference}, which an earlier line of this ` +
          'file already claims. Two lines about one movement cannot both be matched and summing both ' +
          'would double the amount; neither is force-matched.',
      })
      continue
    }
    seen.add(key)

    signedTotal += SETTLEMENT_LINE_PAYOUT_SIGN[line.kind] * fileFils
    perKind[line.kind] += fileFils

    if (!SETTLEMENT_LINE_TIES_LOCALLY[line.kind]) continue

    const tie = byKey.get(key)
    if (tie === undefined || tie.localFils === null) {
      quarantined += fileFils
      variances.push({
        kind: 'no_local_record',
        lineNo: line.lineNo,
        lineKind: line.kind,
        reference: line.reference,
        fileFils,
        localFils: null,
        differenceFils: fileFils,
        explanation:
          `Line ${line.lineNo} is a ${line.kind} of ${fileFils} fils against ${line.reference}, and ` +
          `nothing in this build answers to it on ${SETTLEMENT_LINE_TIE_ACCOUNT[line.kind]}. It is ` +
          'quarantined: a line matched to the nearest payment of the same amount is a guess that posts ' +
          'perfectly and reconciles against the wrong invoice for ever.',
      })
      continue
    }

    if (tie.localFils !== fileFils) {
      linesVersusLocal += Math.abs(fileFils - tie.localFils)
      variances.push({
        kind: 'amount_disagrees',
        lineNo: line.lineNo,
        lineKind: line.kind,
        reference: line.reference,
        fileFils,
        localFils: tie.localFils,
        differenceFils: fileFils - tie.localFils,
        explanation:
          `Line ${line.lineNo} is a ${line.kind} of ${fileFils} fils against ${line.reference}, and ` +
          `this build holds ${tie.localFils} fils on ${SETTLEMENT_LINE_TIE_ACCOUNT[line.kind]} — a ` +
          `difference of ${fileFils - tie.localFils} fils. There is no rounding allowance: the two ` +
          'figures are integer fils from two systems and one of them is wrong.',
      })
    }
  }

  const declaredVersusLines = file.declaredNetFils - signedTotal
  if (declaredVersusLines !== 0) {
    variances.push({
      kind: 'unattributable',
      lineNo: null,
      lineKind: null,
      reference: file.batchReference,
      fileFils: file.declaredNetFils,
      localFils: signedTotal,
      differenceFils: declaredVersusLines,
      explanation:
        `Batch ${file.batchReference} declares a net of ${file.declaredNetFils} fils and its lines sum ` +
        `to ${signedTotal}, leaving ${declaredVersusLines} fils that belongs to no line. An ` +
        'unattributable difference is a refusal and never a zero: posted as a balancing figure it would ' +
        'be indistinguishable from a batch that reconciled (ADR 0070).',
    })
  }

  const clearingReleasedFils = SETTLEMENT_LINE_KINDS.filter(
    (kind) => SETTLEMENT_LINE_MOVES_CLEARING[kind],
  ).reduce((total, kind) => total + SETTLEMENT_LINE_PAYOUT_SIGN[kind] * perKind[kind], 0)

  const identities: SettlementIdentities = {
    declaredVersusLinesFils: declaredVersusLines,
    linesVersusLocalFils: linesVersusLocal,
    quarantinedFils: quarantined,
    malformedFils: malformed,
  }

  return Object.freeze({
    batchReference: file.batchReference,
    contentSha256: file.contentSha256,
    settledOn: file.settledOn,
    totals: Object.freeze({
      captures: money(filsFrom(perKind.capture)),
      refunds: money(filsFrom(perKind.refund)),
      chargebacks: money(filsFrom(perKind.chargeback)),
      tips: money(filsFrom(perKind.tip)),
      fees: money(filsFrom(perKind.fee)),
      clearingReleasedFils,
      netPayoutFils: clearingReleasedFils - perKind.fee,
    }),
    identities,
    variances: Object.freeze([...variances]),
    reconciled:
      variances.length === 0 &&
      identities.declaredVersusLinesFils === 0 &&
      identities.linesVersusLocalFils === 0 &&
      identities.quarantinedFils === 0 &&
      identities.malformedFils === 0,
  })
}

/** Every identity that is not zero, named, for a message. Empty exactly when the batch reconciles. */
export function settlementIdentitiesBroken(
  reconciliation: SettlementBatchReconciliation,
): readonly string[] {
  const { identities } = reconciliation
  return (
    [
      ['declaredVersusLinesFils', identities.declaredVersusLinesFils],
      ['linesVersusLocalFils', identities.linesVersusLocalFils],
      ['quarantinedFils', identities.quarantinedFils],
      ['malformedFils', identities.malformedFils],
    ] as const
  )
    .filter(([, value]) => value !== 0)
    .map(([name, value]) => `${name}=${value}`)
}

/**
 * The tax treatment of the processor's fee, as the caller read it from `supplier_tax_profile`.
 *
 * Three states and no default. `imported_services_reverse_charge` carries the pair from
 * `reverseChargeOn` — supplied rather than computed here, so there is ONE implementation of the rounding
 * (`../tax/reverse-charge.ts`) and the settlement cannot round a half fils differently from a bill.
 */
export interface SettlementFeeTax {
  readonly treatment: 'domestic_uae' | 'imported_services_reverse_charge' | 'outside_scope'
  /** Required for the reverse-charge treatment and refused for the other two. */
  readonly reverseCharge?: ReverseCharge
}

/**
 * Refuses an entry line that reaches an account a settlement may not touch.
 *
 * Two classes, and both are an acceptance line. Any `revenue` account, because a payout is not a sale and
 * a settlement that touched one would move a sale into whatever month the acquirer paid in. And `2040
 * Tips payable` specifically, because the till already credited it and a second credit records the same
 * obligation twice.
 *
 * Read off the CHART rather than from a list of codes, so an account added to the revenue group is covered
 * the day it is added. A list here would be right today and would be the thing nobody updated.
 */
export function assertNoRevenueOrTipPosting(
  lines: readonly EntryLineDraft[],
  chart: ChartOfAccounts,
): void {
  for (const line of lines) {
    const account = accountFor(chart, line.account)
    if (account.type === 'revenue' || account.code === ACCOUNTS.tipsPayable) {
      throw new SettlementWouldPostOutsideCash(account)
    }
  }
}

/**
 * The bank receipt, as a journal entry.
 *
 * Refuses unless the batch reconciled, which is the acceptance line "zero variance or it refuses to
 * post" expressed as a precondition rather than as a check somebody remembers to make. The alternative —
 * posting and recording the variance beside it — is the arrangement that leaves a clearing balance
 * nobody can explain, because the entry is then evidence that the batch was accepted.
 *
 * `source: 'payout'`, which `journal_entry_source_check` already allows and which is the one source that
 * says "money moved between our own accounts because a third party settled", as distinct from `'payment'`
 * (a customer paid) and `'refund'` (we gave money back).
 */
/**
 * One line of the entry, with the SIDE chosen by the sign.
 *
 * Extracted because both the bank and the clearing account take a figure that is legitimately negative,
 * and an acquirer that bills the business in a period of heavy chargebacks is the case a builder which
 * always debited the bank would post backwards while balancing perfectly.
 */
function sidedLine(
  account: AccountCode,
  signedFils: number,
  memo: string,
): readonly EntryLineDraft[] {
  if (signedFils === 0) return []
  const amount = money(filsFrom(Math.abs(signedFils)))
  return [signedFils > 0 ? debit(account, amount, memo) : credit(account, amount, memo)]
}

/**
 * The fee's own lines, by treatment. Three states, no default.
 *
 * Separate from {@link settlementBatchEntry} so the cash half of the entry stays readable, and because
 * this is the half a tax agent reads: everything about which VAT201 boxes a processor fee reaches is in
 * one place rather than interleaved with the bank movement.
 */
function processorFeeLines(feeFils: number, feeTax: SettlementFeeTax): readonly EntryLineDraft[] {
  const fee = money(filsFrom(feeFils))
  if (feeTax.treatment !== 'imported_services_reverse_charge') {
    if (feeTax.reverseCharge !== undefined) {
      throw new AppError(
        'validation',
        `A fee treated as "${feeTax.treatment}" was given a reverse-charge pair. A supply outside the ` +
          'scope of UAE VAT, or one a domestic supplier charged VAT on, self-accounts for nothing.',
      )
    }
    // Domestic and out-of-scope both debit the fee whole. A domestic processor's own VAT invoice is a
    // `bill` and M-VAT's to post; this entry records what the acquirer DEDUCTED, and splitting a VAT
    // remainder out of it here would be a second answer to a figure `splitGross` already owns.
    return [debit(ACCOUNTS.paymentProcessingFees, fee, 'Processor fee')]
  }

  const pair = feeTax.reverseCharge
  if (pair === undefined) {
    throw new AppError(
      'validation',
      'A fee treated as an imported service needs the reverse-charge pair from `reverseChargeOn`. ' +
        'Both sides are declared on the return and a single net figure declares neither (docs/04 §4).',
    )
  }
  // Checked BEFORE any line is built, because an inconsistent pair produces an entry that BALANCES — the
  // borne VAT is inside the expense debit — while the return it feeds does not.
  if (subtract(pair.outputVat, pair.inputVat).fils !== pair.borneVat.fils) {
    throw new AppError(
      'invariant_violated',
      `A reverse-charge pair whose borne VAT (${pair.borneVat.fils}) is not output minus input ` +
        `(${pair.outputVat.fils} - ${pair.inputVat.fils}) cannot be posted: the entry would balance ` +
        'and the return would not.',
    )
  }
  // The expense bears the tax the input side does not reclaim, which is `borneVat` and is nought on a
  // recoverable category. Added to the expense rather than left on a VAT account, because blocked input
  // VAT is a cost of the thing it was incurred on (0034) and `6080` is that thing here.
  //
  // Three VAT-bearing lines and not four: `borneVat` is already inside the expense debit, which is what
  // makes the entry balance. Stated because the obvious reading of three is that one is missing.
  //
  // Both VAT lines are omitted when the figure is NOUGHT, and that is a real case rather than defensive
  // code: 5% of a fee under ten fils rounds to nothing, so there is no tax to declare and a zero-amount
  // line is refused by `postEntry` anyway ("a line must carry a non-zero amount on exactly one side").
  // The property suite found this on a one-fil fee; the fixture suite's fee is large enough never to.
  return [
    debit(ACCOUNTS.paymentProcessingFees, add(fee, pair.borneVat), 'Processor fee'),
    ...(pair.outputVat.fils > 0
      ? [credit(REVERSE_CHARGE_OUTPUT_ACCOUNT, pair.outputVat, 'Reverse charge on processor fee')]
      : []),
    ...(pair.inputVat.fils > 0
      ? [debit(REVERSE_CHARGE_INPUT_ACCOUNT, pair.inputVat, 'Reverse charge reclaimed')]
      : []),
  ]
}

/**
 * The bank receipt, as a journal entry.
 *
 * Refuses unless the batch reconciled, which is the acceptance line "zero variance or it refuses to
 * post" expressed as a precondition rather than as a check somebody remembers to make. The alternative —
 * posting and recording the variance beside it — is the arrangement that leaves a clearing balance
 * nobody can explain, because the entry is then evidence that the batch was accepted.
 *
 * `source: 'payout'`, which `journal_entry_source_check` already allows and which is the one source that
 * says "money moved between our own accounts because a third party settled", as distinct from `'payment'`
 * (a customer paid) and `'refund'` (we gave money back).
 */
export function settlementBatchEntry(input: {
  readonly reconciliation: SettlementBatchReconciliation
  readonly entryId: EntryId
  /** The day the acquirer paid. `journal_entry.entry_date`, and the file's own `settledOn`. */
  readonly entryDate: LocalDate
  readonly chart: ChartOfAccounts
  /** Required when the batch carries a fee, and refused when it does not. */
  readonly feeTax?: SettlementFeeTax
}): JournalEntry {
  const { reconciliation, chart } = input
  if (!reconciliation.reconciled) throw new SettlementVarianceRefusesToPost(reconciliation)

  const { totals } = reconciliation
  if (totals.clearingReleasedFils === 0 && totals.netPayoutFils === 0 && totals.fees.fils === 0) {
    throw new AppError(
      'validation',
      `Batch ${reconciliation.batchReference} moves nothing: no capture, tip, refund, chargeback or fee. ` +
        'A payout file with nothing in it is an empty file rather than a settlement, and recording it as ' +
        'a batch would put a payout that did not happen on the bank reconciliation.',
    )
  }
  const feeFils = totals.fees.fils
  if (feeFils > 0 && input.feeTax === undefined) throw new SettlementFeeHasNoTaxTreatment(feeFils)
  if (feeFils === 0 && input.feeTax !== undefined) {
    throw new AppError(
      'validation',
      'A settlement with no fee line was given a fee tax treatment. A treatment with no consideration ' +
        'behind it declares nothing and would put an empty reverse-charge pair on the return.',
    )
  }

  const reference = reconciliation.batchReference
  const lines: EntryLineDraft[] = [
    ...sidedLine(
      ACCOUNTS.bankCurrent,
      totals.netPayoutFils,
      totals.netPayoutFils >= 0 ? `Payout ${reference}` : `Payout ${reference} (billed)`,
    ),
    // Negated, because the clearing account is RELEASED by a payout: a positive release is a credit.
    ...sidedLine(ACCOUNTS.gatewayClearing, -totals.clearingReleasedFils, `Settled ${reference}`),
    ...(feeFils > 0 && input.feeTax !== undefined ? processorFeeLines(feeFils, input.feeTax) : []),
  ]

  assertNoRevenueOrTipPosting(lines, chart)

  return postEntry(
    {
      entryId: input.entryId,
      entryDate: input.entryDate,
      narrative:
        `Gateway settlement ${reference}: ${formatFils(totals.captures.fils)} captured, ` +
        `${formatFils(totals.tips.fils)} tips, ${formatFils(totals.refunds.fils)} refunded, ` +
        `${formatFils(totals.chargebacks.fils)} charged back, ${formatFils(totals.fees.fils)} ` +
        'processor fee. Reconciled to the fils, with no variance.',
      source: 'payout',
      lines,
    },
    chart,
  )
}

const formatFils = (value: number): string => `${value} fils`

/**
 * The sum of a settlement's lines of one kind. Exported because a report prints it and a test asserts it,
 * and a second loop over the lines is a second answer.
 */
export function settlementLineTotal(
  lines: readonly SettlementLine[],
  kind: SettlementLineKind,
): Money {
  return sum(lines.filter((line) => line.kind === kind).map((line) => line.amount))
}
