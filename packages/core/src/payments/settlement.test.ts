import { describe, expect, it } from 'vitest'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { EntryId } from '../ledger/entry.ts'
import { credit, debit, entryId, imbalanceFils } from '../ledger/entry.ts'
import { aed, filsFrom, type Money, money } from '../money.ts'
import { reverseChargeOn } from '../tax/reverse-charge.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import type {
  SettlementFeeTax,
  SettlementFile,
  SettlementLine,
  SettlementLineKind,
  SettlementTie,
} from './settlement.ts'
import {
  assertNoRevenueOrTipPosting,
  reconcileSettlementBatch,
  SETTLEMENT_LINE_KINDS,
  SETTLEMENT_LINE_MOVES_CLEARING,
  SETTLEMENT_LINE_PAYOUT_SIGN,
  SETTLEMENT_LINE_TIE_ACCOUNT,
  SETTLEMENT_LINE_TIES_LOCALLY,
  SettlementFeeHasNoTaxTreatment,
  SettlementVarianceRefusesToPost,
  SettlementWouldPostOutsideCash,
  settlementBatchEntry,
  settlementIdentitiesBroken,
} from './settlement.ts'

/**
 * Y-PAY-09's arithmetic: the identity, the named variance, and the entry a reconciled batch posts.
 *
 * ## The fixture, and where every figure in it comes from
 *
 * **There is no real settlement file in this build and there cannot be one: no gateway has been chosen
 * (OPEN-QUESTIONS `Y7-gateway`).** So `FIXTURE` is a file this suite writes, and its provenance is
 * stated rather than implied:
 *
 * - the four amounts that tie to something (`capture`, `tip`, `refund`, `chargeback`) are chosen here and
 *   the LOCAL figures are set equal to them, which is the only honest way to assert an identity whose
 *   other side does not exist yet;
 * - the fee is 1,000 fils and is **not** derived from any rate. It is not 2.9% of anything, it is not an
 *   interchange figure and it carries no MCC. A fee computed from a rate would be a rate this build
 *   invented, and the test it fed would then be a test of the invention (brief rule 15);
 * - `settledOn` is two days after the capture's trading day, which is the acceptance line about D+2, and
 *   **no settlement delay is derived anywhere** — the file states its own date and nothing computes one;
 * - the references are this suite's own strings and assert no vendor's format, for
 *   `chargeback.dispute_ref`'s reason.
 *
 * `declaredNetFils` is then the signed sum, written out longhand in {@link FIXTURE} so that the identity
 * has an independently-stated right-hand side rather than one the code under test produced.
 */

const CHART = STANDARD_SPA_CHART
const CAPTURE_DAY: LocalDate = localDate('2099-06-01')
const SETTLED_ON: LocalDate = localDate('2099-06-03')

const CAPTURE_FILS = 31_500
const TIP_FILS = 2_000
const REFUND_FILS = 7_500
const CHARGEBACK_FILS = 4_000
const FEE_FILS = 1_000

/** `+capture +tip -refund -chargeback -fee`, written out rather than summed by the code under test. */
const DECLARED_NET_FILS = CAPTURE_FILS + TIP_FILS - REFUND_FILS - CHARGEBACK_FILS - FEE_FILS

const line = (
  lineNo: number,
  kind: SettlementLineKind,
  reference: string,
  fils: number,
): SettlementLine => ({ lineNo, kind, reference, amount: { fils, currency: 'AED' } as Money })

const FIXTURE: SettlementFile = Object.freeze({
  batchReference: 'batch-fixture-0001',
  contentSha256: 'a'.repeat(64),
  settledOn: SETTLED_ON,
  declaredNetFils: DECLARED_NET_FILS,
  lines: Object.freeze([
    line(1, 'capture', 'intent-aaa', CAPTURE_FILS),
    line(2, 'tip', 'intent-aaa', TIP_FILS),
    line(3, 'refund', 'intent-bbb', REFUND_FILS),
    line(4, 'chargeback', 'dispute-ccc', CHARGEBACK_FILS),
    line(5, 'fee', 'batch-fixture-0001', FEE_FILS),
  ]),
})

const TIES: readonly SettlementTie[] = Object.freeze([
  { kind: 'capture', reference: 'intent-aaa', localFils: CAPTURE_FILS },
  { kind: 'tip', reference: 'intent-aaa', localFils: TIP_FILS },
  { kind: 'refund', reference: 'intent-bbb', localFils: REFUND_FILS },
  { kind: 'chargeback', reference: 'dispute-ccc', localFils: CHARGEBACK_FILS },
])

/** The processor is offshore, so the fee self-accounts. `6080` is a recoverable category (0034). */
const OFFSHORE_FEE_TAX: SettlementFeeTax = {
  treatment: 'imported_services_reverse_charge',
  reverseCharge: reverseChargeOn(money(filsFrom(FEE_FILS)), 'recoverable'),
}

const ENTRY: EntryId = entryId('settlement-fixture-0001')

describe('the line kind tables', () => {
  it('declare a sign, a clearing effect, a tie account and a tie requirement for every kind', () => {
    for (const kind of SETTLEMENT_LINE_KINDS) {
      expect([1, -1]).toContain(SETTLEMENT_LINE_PAYOUT_SIGN[kind])
      expect(typeof SETTLEMENT_LINE_MOVES_CLEARING[kind]).toBe('boolean')
      expect(SETTLEMENT_LINE_TIE_ACCOUNT[kind]).toMatch(/^[0-9]{4}$/)
      expect(typeof SETTLEMENT_LINE_TIES_LOCALLY[kind]).toBe('boolean')
    }
  })

  it('tie a tip to the tips-payable liability and no kind to a revenue account', () => {
    expect(SETTLEMENT_LINE_TIE_ACCOUNT.tip).toBe(ACCOUNTS.tipsPayable)
    for (const kind of SETTLEMENT_LINE_KINDS) {
      const account = CHART.accounts.find((row) => row.code === SETTLEMENT_LINE_TIE_ACCOUNT[kind])
      expect(account, `${kind} ties to an account that is not in the chart`).toBeDefined()
      expect(account?.type, `${kind} ties to revenue`).not.toBe('revenue')
    }
  })

  it('exempt only the fee from tying to a local record', () => {
    const exempt = SETTLEMENT_LINE_KINDS.filter((kind) => !SETTLEMENT_LINE_TIES_LOCALLY[kind])
    expect(exempt).toEqual(['fee'])
  })
})

describe('reconcileSettlementBatch', () => {
  it('reconciles the seeded settlement to the fils with no variance', () => {
    const result = reconcileSettlementBatch(FIXTURE, TIES)

    expect(result.variances).toEqual([])
    expect(settlementIdentitiesBroken(result)).toEqual([])
    expect(result.reconciled).toBe(true)
    // Every identity, individually and to the fils, rather than only the boolean they fold into.
    expect(result.identities).toEqual({
      declaredVersusLinesFils: 0,
      linesVersusLocalFils: 0,
      quarantinedFils: 0,
      malformedFils: 0,
    })
    expect(result.totals.captures.fils).toBe(CAPTURE_FILS)
    expect(result.totals.tips.fils).toBe(TIP_FILS)
    expect(result.totals.fees.fils).toBe(FEE_FILS)
    expect(result.totals.clearingReleasedFils).toBe(
      CAPTURE_FILS + TIP_FILS - REFUND_FILS - CHARGEBACK_FILS,
    )
    expect(result.totals.netPayoutFils).toBe(DECLARED_NET_FILS)
  })

  it('is a function of the SET of lines, not of their order in the file', () => {
    const reversed: SettlementFile = { ...FIXTURE, lines: [...FIXTURE.lines].reverse() }
    const forwards = reconcileSettlementBatch(FIXTURE, TIES)
    const backwards = reconcileSettlementBatch(reversed, TIES)
    expect(backwards.identities).toEqual(forwards.identities)
    expect(backwards.totals).toEqual(forwards.totals)
    expect(backwards.reconciled).toBe(true)
  })

  /**
   * The acceptance line, and the control that stops it passing vacuously: the SAME file reconciles when
   * the fils is put back. Without that half, a reconciler that refused everything would pass this case.
   */
  it.each(SETTLEMENT_LINE_KINDS.filter((kind) => SETTLEMENT_LINE_TIES_LOCALLY[kind]))(
    'names a variance when a %s line is altered by one fils, and reconciles when it is not',
    (kind) => {
      const index = FIXTURE.lines.findIndex((row) => row.kind === kind)
      const original = FIXTURE.lines[index]
      expect(original).toBeDefined()
      if (original === undefined) return
      const altered: SettlementFile = {
        ...FIXTURE,
        // The DECLARED net is left alone, so the one-fils change shows up twice: as the line's own
        // disagreement with the local figure, and as a residue belonging to no line. Both are real and a
        // report that named only one would hide half the problem.
        lines: FIXTURE.lines.map((row, at) =>
          at === index ? line(row.lineNo, row.kind, row.reference, row.amount.fils + 1) : row,
        ),
      }

      const result = reconcileSettlementBatch(altered, TIES)
      expect(result.reconciled).toBe(false)
      const named = result.variances.find((variance) => variance.lineKind === kind)
      expect(named, `no variance named the ${kind} line`).toBeDefined()
      expect(named?.kind).toBe('amount_disagrees')
      expect(named?.lineNo).toBe(original.lineNo)
      expect(named?.reference).toBe(original.reference)
      expect(named?.differenceFils).toBe(1)
      expect(named?.explanation).toContain(original.reference)
      expect(result.identities.linesVersusLocalFils).toBe(1)

      expect(reconcileSettlementBatch(FIXTURE, TIES).reconciled).toBe(true)
    },
  )

  it('quarantines a line nothing local answers to rather than force-matching it', () => {
    // The tie for the capture is removed and NOTHING else changes, so the only way this can be detected
    // is by the absence of a local record — not by an amount.
    const withoutCapture = TIES.filter((tie) => tie.kind !== 'capture')
    const result = reconcileSettlementBatch(FIXTURE, withoutCapture)

    expect(result.reconciled).toBe(false)
    expect(result.identities.quarantinedFils).toBe(CAPTURE_FILS)
    // And the batch total is untouched, which is why a quarantine needs its own identity: a file whose
    // lines sum perfectly can still carry a line that belongs to nobody.
    expect(result.identities.declaredVersusLinesFils).toBe(0)
    const quarantined = result.variances.filter((variance) => variance.kind === 'no_local_record')
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.lineNo).toBe(1)
    expect(quarantined[0]?.localFils).toBeNull()
  })

  it('distinguishes a missing local record from a local figure of nought', () => {
    const zeroed = TIES.map((tie) => (tie.kind === 'capture' ? { ...tie, localFils: 0 } : tie))
    const result = reconcileSettlementBatch(FIXTURE, zeroed)
    // A local nought is a DISAGREEMENT of the whole amount, not a quarantine. The two states take
    // different actions — one alerts an operator to an unmatched payout line, the other says our own
    // figure is wrong — and a reconciler that collapsed them would route both to the same queue.
    expect(result.identities.quarantinedFils).toBe(0)
    expect(result.identities.linesVersusLocalFils).toBe(CAPTURE_FILS)
    expect(result.variances[0]?.kind).toBe('amount_disagrees')
    expect(result.variances[0]?.localFils).toBe(0)
  })

  it('refuses a residue that belongs to no line as unattributable, never as a zero', () => {
    const result = reconcileSettlementBatch(
      { ...FIXTURE, declaredNetFils: DECLARED_NET_FILS + 1 },
      TIES,
    )
    expect(result.reconciled).toBe(false)
    const residue = result.variances.find((variance) => variance.kind === 'unattributable')
    expect(residue).toBeDefined()
    expect(residue?.lineNo).toBeNull()
    expect(residue?.differenceFils).toBe(1)
    expect(result.identities.declaredVersusLinesFils).toBe(1)
    // Every LINE still ties, which is the whole point of the case: the difference cannot be attributed.
    expect(result.identities.linesVersusLocalFils).toBe(0)
  })

  it('names a duplicated line rather than summing both copies', () => {
    const doubled: SettlementFile = {
      ...FIXTURE,
      lines: [...FIXTURE.lines, line(6, 'capture', 'intent-aaa', CAPTURE_FILS)],
    }
    const result = reconcileSettlementBatch(doubled, TIES)
    expect(result.variances.map((variance) => variance.kind)).toContain('duplicate_line')
    // The second copy contributes to no total, so the batch total identity still holds — which is what
    // makes the duplicate detectable at all rather than showing up as an unattributable residue.
    expect(result.identities.declaredVersusLinesFils).toBe(0)
    expect(result.totals.captures.fils).toBe(CAPTURE_FILS)
    expect(result.identities.malformedFils).toBe(CAPTURE_FILS)
  })

  it.each([0, -1, 1.5])(
    'names a malformed amount of %s rather than folding it into a total',
    (bad) => {
      const broken: SettlementFile = {
        ...FIXTURE,
        lines: FIXTURE.lines.map((row, at) =>
          at === 0 ? line(1, 'capture', 'intent-aaa', bad) : row,
        ),
      }
      const result = reconcileSettlementBatch(broken, TIES)
      expect(result.variances[0]?.kind).toBe('amount_malformed')
      expect(result.totals.captures.fils).toBe(0)
      expect(result.reconciled).toBe(false)
    },
  )
})

describe('settlementBatchEntry', () => {
  it('posts the net receipt, releases the clearing account and balances', () => {
    const entry = settlementBatchEntry({
      reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
      entryId: ENTRY,
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: OFFSHORE_FEE_TAX,
    })

    expect(imbalanceFils(entry.lines)).toBe(0)
    expect(entry.source).toBe('payout')
    expect(entry.entryDate).toBe(SETTLED_ON)
    const bank = entry.lines.find((row) => row.account === ACCOUNTS.bankCurrent)
    expect(bank?.debitFils).toBe(DECLARED_NET_FILS)
    const clearing = entry.lines.find((row) => row.account === ACCOUNTS.gatewayClearing)
    expect(clearing?.creditFils).toBe(CAPTURE_FILS + TIP_FILS - REFUND_FILS - CHARGEBACK_FILS)
  })

  it('touches no revenue account and no tips-payable account', () => {
    const entry = settlementBatchEntry({
      reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
      entryId: ENTRY,
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: OFFSHORE_FEE_TAX,
    })
    const revenueCodes = CHART.accounts.filter((row) => row.type === 'revenue').map((r) => r.code)
    expect(revenueCodes.length).toBeGreaterThan(0)
    for (const row of entry.lines) {
      expect(revenueCodes, `${row.account} is a revenue account`).not.toContain(row.account)
      expect(row.account).not.toBe(ACCOUNTS.tipsPayable)
    }
  })

  /**
   * The control for the case above, in its two halves: the guard must actually FIRE, or the assertion
   * that no line reaches revenue is an assertion about nothing.
   *
   * The revenue half re-codes the clearing account in the CHART the builder checks against, which is the
   * only way to reach the guard through `settlementBatchEntry` — the builder reads `ACCOUNTS`, so a
   * forbidden account cannot be injected as a line. The tips half calls the guard directly, because no
   * re-coding makes the builder emit a `2040` line at all.
   */
  it('refuses a line that reaches a revenue account', () => {
    expect(() =>
      settlementBatchEntry({
        reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
        entryId: ENTRY,
        entryDate: SETTLED_ON,
        chart: {
          ...CHART,
          accounts: CHART.accounts.map((row) =>
            row.code === ACCOUNTS.gatewayClearing ? { ...row, type: 'revenue' as const } : row,
          ),
        },
        feeTax: OFFSHORE_FEE_TAX,
      }),
    ).toThrow(SettlementWouldPostOutsideCash)
  })

  it('refuses a line that reaches tips payable, which the till already credited', () => {
    expect(() =>
      assertNoRevenueOrTipPosting([credit(ACCOUNTS.tipsPayable, aed(20), 'tip')], CHART),
    ).toThrow(SettlementWouldPostOutsideCash)
    // And the control: an account a settlement legitimately reaches passes.
    expect(() =>
      assertNoRevenueOrTipPosting([debit(ACCOUNTS.bankCurrent, aed(20), 'payout')], CHART),
    ).not.toThrow()
  })

  it('generates the reverse-charge pair for an offshore processor', () => {
    const entry = settlementBatchEntry({
      reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
      entryId: ENTRY,
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: OFFSHORE_FEE_TAX,
    })
    const output = entry.lines.find((row) => row.account === ACCOUNTS.reverseChargeVatPayable)
    const input = entry.lines.find((row) => row.account === ACCOUNTS.recoverableInputVat)
    // 5% of 1,000 fils, stated INDEPENDENTLY of the pair the fixture built. The first version of this
    // case read the expected figure off `OFFSHORE_FEE_TAX.reverseCharge` and was therefore `x === x`: it
    // passed while the fixture was handing `reverseChargeOn` a hundred times the fee, because `aed` takes
    // major units. Brief rule 3, and the sibling property suite is what found it.
    const EXPECTED_RC_FILS = 50
    expect(OFFSHORE_FEE_TAX.reverseCharge?.outputVat.fils).toBe(EXPECTED_RC_FILS)
    expect(output?.creditFils).toBe(EXPECTED_RC_FILS)
    expect(input?.debitFils).toBe(EXPECTED_RC_FILS)
    const fee = entry.lines.find((row) => row.account === ACCOUNTS.paymentProcessingFees)
    // Borne VAT is nought on a recoverable category, so the expense is the fee itself.
    expect(fee?.debitFils).toBe(FEE_FILS)
    expect(imbalanceFils(entry.lines)).toBe(0)
  })

  it('debits the fee whole, and declares nothing, for a domestic processor', () => {
    const entry = settlementBatchEntry({
      reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
      entryId: ENTRY,
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: { treatment: 'domestic_uae' },
    })
    expect(
      entry.lines.find((row) => row.account === ACCOUNTS.reverseChargeVatPayable),
    ).toBeUndefined()
    expect(
      entry.lines.find((row) => row.account === ACCOUNTS.paymentProcessingFees)?.debitFils,
    ).toBe(FEE_FILS)
  })

  it('refuses a fee with no tax treatment rather than defaulting to domestic', () => {
    expect(() =>
      settlementBatchEntry({
        reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
        entryId: ENTRY,
        entryDate: SETTLED_ON,
        chart: CHART,
      }),
    ).toThrow(SettlementFeeHasNoTaxTreatment)
  })

  it('refuses to post a batch that carries a variance, naming the offending line', () => {
    const altered: SettlementFile = {
      ...FIXTURE,
      lines: FIXTURE.lines.map((row, at) =>
        at === 0 ? line(1, 'capture', 'intent-aaa', CAPTURE_FILS + 1) : row,
      ),
    }
    let thrown: unknown
    try {
      settlementBatchEntry({
        reconciliation: reconcileSettlementBatch(altered, TIES),
        entryId: ENTRY,
        entryDate: SETTLED_ON,
        chart: CHART,
        feeTax: OFFSHORE_FEE_TAX,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SettlementVarianceRefusesToPost)
    expect((thrown as Error).message).toContain('intent-aaa')
    expect((thrown as Error).message).toContain('line 1')
  })

  it('credits the bank when the acquirer bills the business', () => {
    // Chargebacks exceeding captures is the case a builder that always debited the bank would post
    // backwards while balancing perfectly.
    const billed: SettlementFile = {
      batchReference: 'batch-fixture-0002',
      contentSha256: 'b'.repeat(64),
      settledOn: SETTLED_ON,
      declaredNetFils: 1_000 - 50_000 - FEE_FILS,
      lines: [
        line(1, 'capture', 'intent-ddd', 1_000),
        line(2, 'chargeback', 'dispute-eee', 50_000),
        line(3, 'fee', 'batch-fixture-0002', FEE_FILS),
      ],
    }
    const result = reconcileSettlementBatch(billed, [
      { kind: 'capture', reference: 'intent-ddd', localFils: 1_000 },
      { kind: 'chargeback', reference: 'dispute-eee', localFils: 50_000 },
    ])
    expect(result.reconciled).toBe(true)
    const entry = settlementBatchEntry({
      reconciliation: result,
      entryId: entryId('settlement-fixture-0002'),
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: OFFSHORE_FEE_TAX,
    })
    expect(entry.lines.find((row) => row.account === ACCOUNTS.bankCurrent)?.creditFils).toBe(
      50_000 + FEE_FILS - 1_000,
    )
    expect(entry.lines.find((row) => row.account === ACCOUNTS.gatewayClearing)?.debitFils).toBe(
      50_000 - 1_000,
    )
    expect(imbalanceFils(entry.lines)).toBe(0)
  })

  it('moves no revenue between business days: the entry is dated by the payout, not by the capture', () => {
    const entry = settlementBatchEntry({
      reconciliation: reconcileSettlementBatch(FIXTURE, TIES),
      entryId: ENTRY,
      entryDate: SETTLED_ON,
      chart: CHART,
      feeTax: OFFSHORE_FEE_TAX,
    })
    expect(entry.entryDate).toBe(SETTLED_ON)
    expect(SETTLED_ON).not.toBe(CAPTURE_DAY)
    // And the only accounts it reaches are cash, clearing, the expense and the two VAT accounts — so
    // dating it on D+2 cannot move a sale, because no sale is in it.
    expect([...new Set(entry.lines.map((row) => row.account))].sort()).toEqual(
      [
        ACCOUNTS.bankCurrent,
        ACCOUNTS.gatewayClearing,
        ACCOUNTS.recoverableInputVat,
        ACCOUNTS.reverseChargeVatPayable,
        ACCOUNTS.paymentProcessingFees,
      ].sort(),
    )
  })
})
