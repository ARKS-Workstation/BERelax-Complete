import { describe, expect, it } from 'vitest'
import { MalformedTender, TENDER_ACCOUNT, TENDER_KINDS } from '../checkout/posting.ts'
import { accountFor, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { aed, filsFrom, money } from '../money.ts'
import type { TenderTypeSpec } from './tender.ts'
import {
  ChangeNotAvailable,
  reconcileSettlement,
  settleTenders,
  TENDER_ADAPTERS,
  TENDER_TYPES,
  TENDER_TYPES_IN_ORDER,
  TenderReferenceMissing,
  tenderTypeOf,
  UnknownTenderType,
} from './tender.ts'

/**
 * The tender-type registry and the arithmetic of applying tenders.
 *
 * Every figure below is written out with its arithmetic beside it. A test that compared a settlement
 * against `settleTenders`' own idea of the total would pass against an implementation that netted the
 * change into the payment, which is the one thing the acceptance asks this module to prove it does not.
 *
 * The controls that cannot be written as assertions — breaking this module and watching this file go red
 * — are known-bad fixtures in `scripts/test-gates.mjs`, block 92.
 */

const CHART = STANDARD_SPA_CHART

describe('the tender-type registry', () => {
  /**
   * The table-driven half of the first acceptance line.
   *
   * It enumerates `TENDER_KINDS` rather than `Object.keys(TENDER_TYPES)`, which is the whole point: the
   * tuple is the closed list the posting rule and the database both derive from, so a kind added there
   * and forgotten here fails HERE rather than in whichever code path first needed it. The type system
   * fails first — `TENDER_TYPES` is a `Record<TenderKind, …>` — and gate case 92m proves that by adding a
   * kind and requiring `tsc` to refuse it.
   */
  it.each(TENDER_KINDS)('%s declares a posting account the chart contains', (kind) => {
    const spec: TenderTypeSpec = TENDER_TYPES[kind]
    expect(spec.code).toBe(kind)
    expect(spec.label.trim()).not.toBe('')
    // Resolved through the chart, not merely present as a string. A `Record` is satisfied by an account
    // code that looks plausible and names nothing, and `accountFor` throws on one.
    const account = accountFor(CHART, spec.account)
    expect(account.code).toBe(spec.account)
    expect(account.type).toBe('asset')
    // Read from the posting rule rather than restated, so this asserts the two are the SAME map.
    expect(spec.account).toBe(TENDER_ACCOUNT[kind])
    expect(TENDER_ADAPTERS).toContain(spec.adapter)
    expect(spec.sortOrder).toBeGreaterThanOrEqual(1)
  })

  it('the control: the chart lookup this test relies on does reject an account that is not in it', () => {
    // Without this, "declares a posting account the chart contains" would pass for any string if
    // `accountFor` happened to return undefined instead of throwing.
    expect(() => accountFor(CHART, '9999' as (typeof TENDER_KINDS)[number] as never)).toThrow()
  })

  it('names every kind exactly once, and holds a unique position for each', () => {
    expect(Object.keys(TENDER_TYPES).sort()).toEqual([...TENDER_KINDS].sort())
    const positions = TENDER_TYPES_IN_ORDER.map((spec) => spec.sortOrder)
    expect(new Set(positions).size).toBe(positions.length)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('gives change only where the money has already arrived', () => {
    for (const kind of TENDER_KINDS) {
      const spec = TENDER_TYPES[kind]
      // The registry's own CHECK, as a claim about the data: change cannot be handed back out of money
      // that has not arrived. `tender_type_change_needs_immediate_settlement` in 0068 refuses the row.
      if (spec.givesChange) expect(spec.settlesImmediately).toBe(true)
    }
    // And the control that stops the loop above passing vacuously: at least one type gives change and at
    // least one does not, so the implication is exercised in both directions.
    expect(TENDER_KINDS.filter((kind) => TENDER_TYPES[kind].givesChange)).toEqual(['cash'])
    expect(TENDER_KINDS.filter((kind) => !TENDER_TYPES[kind].givesChange).length).toBeGreaterThan(0)
  })

  it('requires a reference for exactly the types that have one', () => {
    // Cash has no approval code and no transfer reference; a card and a transfer both do, and it is the
    // field a disputed payment is settled with.
    expect(TENDER_TYPES.cash.requiresReference).toBe(false)
    expect(TENDER_TYPES.card_in_salon.requiresReference).toBe(true)
    expect(TENDER_TYPES.bank_transfer.requiresReference).toBe(true)
  })

  it('puts card money in the terminal clearing account and not in the bank', () => {
    // The same claim posting.test.ts makes from the other end, and it is worth making twice because the
    // failure is invisible: the entry balances, and the bank reconciliation is permanently out by every
    // unsettled batch and every processing fee.
    expect(TENDER_TYPES.card_in_salon.account).toBe('1040')
    expect(TENDER_TYPES.card_in_salon.account).not.toBe('1020')
    expect(TENDER_TYPES.card_in_salon.settlesImmediately).toBe(false)
    expect(TENDER_TYPES.bank_transfer.account).toBe('1020')
    expect(TENDER_TYPES.cash.account).toBe('1010')
  })

  it('refuses a tender type the registry does not hold', () => {
    expect(() => tenderTypeOf('gift_card')).toThrow(UnknownTenderType)
    // The control: the accessor is not simply throwing for everything.
    expect(tenderTypeOf('cash').code).toBe('cash')
  })
})

describe('settleTenders', () => {
  // AED 262.50 gross, settled with a 300-dirham note. Every figure written out:
  //   due       26_250
  //   tendered  30_000
  //   applied   26_250  (min(30_000, 26_250))
  //   change     3_750  (30_000 - 26_250)
  const DUE = 26_250
  const NOTE = 30_000

  it('records change beside the payment rather than inside it', () => {
    const settlement = settleTenders({
      due: money(filsFrom(DUE)),
      tenders: [{ kind: 'cash', amount: money(filsFrom(NOTE)) }],
    })

    expect(settlement.tendered.fils).toBe(NOTE)
    expect(settlement.applied.fils).toBe(DUE)
    expect(settlement.changeGiven.fils).toBe(NOTE - DUE)
    expect(settlement.outstanding.fils).toBe(0)
    expect(settlement.fullySettled).toBe(true)

    const tender = settlement.tenders[0]
    // THE assertion of this module. `tendered` is untouched by the change: the drawer is reconciled
    // against the notes that went in and the notes that came out, and a single net figure reconciles
    // against neither.
    expect(tender?.tendered.fils).toBe(NOTE)
    expect(tender?.applied.fils).toBe(DUE)
    expect(tender?.changeGiven.fils).toBe(NOTE - DUE)
    // And the control that makes the previous line mean something: the netted figure is a DIFFERENT
    // number, so an implementation that stored `amount - change` as the tender would fail above.
    expect(tender?.tendered.fils).not.toBe(tender?.applied.fils)
  })

  it('leaves a receivable equal to the shortfall, to the fils', () => {
    //   due       26_250
    //   tendered  10_000
    //   applied   10_000
    //   left      16_250
    const settlement = settleTenders({
      due: money(filsFrom(DUE)),
      tenders: [{ kind: 'cash', amount: money(filsFrom(10_000)) }],
    })
    expect(settlement.applied.fils).toBe(10_000)
    expect(settlement.changeGiven.fils).toBe(0)
    expect(settlement.outstanding.fils).toBe(16_250)
    expect(settlement.fullySettled).toBe(false)
    // Exact, not "about": 26_250 - 10_000.
    expect(settlement.outstanding.fils).toBe(DUE - 10_000)
  })

  it('applies tenders in the order they were taken, each one at most the balance', () => {
    //   due       26_250
    //   cash       5_000 -> applied 5_000, outstanding 21_250
    //   card      21_250 -> applied 21_250, outstanding 0
    const settlement = settleTenders({
      due: money(filsFrom(DUE)),
      tenders: [
        { kind: 'cash', amount: money(filsFrom(5_000)) },
        { kind: 'card_in_salon', amount: money(filsFrom(21_250)), reference: 'APPROVAL-1' },
      ],
    })
    expect(settlement.tenders.map((tender) => tender.applied.fils)).toEqual([5_000, 21_250])
    expect(settlement.tenders.map((tender) => tender.account)).toEqual(['1010', '1040'])
    expect(settlement.outstanding.fils).toBe(0)
  })

  it('refuses a surplus on a tender type that gives no change', () => {
    // A card authorised for 300 against a 262.50 balance is a mis-keyed amount. The answer is to
    // authorise 262.50, not to open the drawer — which would take money nobody over-paid.
    expect(() =>
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [
          { kind: 'card_in_salon', amount: money(filsFrom(NOTE)), reference: 'APPROVAL-1' },
        ],
      }),
    ).toThrow(ChangeNotAvailable)

    // The control: the same surplus in cash is accepted, so the refusal is about the tender TYPE and not
    // about surpluses in general.
    expect(
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [{ kind: 'cash', amount: money(filsFrom(NOTE)) }],
      }).changeGiven.fils,
    ).toBe(NOTE - DUE)
  })

  it('refuses a second tender once the balance is settled, when it cannot give change', () => {
    // The consequence of applying in order, and the right answer: the card has nothing left to pay.
    expect(() =>
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [
          { kind: 'cash', amount: money(filsFrom(DUE)) },
          { kind: 'card_in_salon', amount: money(filsFrom(1)), reference: 'APPROVAL-1' },
        ],
      }),
    ).toThrow(ChangeNotAvailable)
  })

  it('refuses a tender of a referenced type that carries no reference', () => {
    expect(() =>
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [{ kind: 'card_in_salon', amount: money(filsFrom(DUE)) }],
      }),
    ).toThrow(TenderReferenceMissing)
    // The control: with the reference, the same tender is accepted.
    expect(
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [{ kind: 'card_in_salon', amount: money(filsFrom(DUE)), reference: 'APPROVAL-1' }],
      }).fullySettled,
    ).toBe(true)
  })

  it('refuses a tender that is not a payment', () => {
    for (const fils of [0, -1, 1.5]) {
      expect(() =>
        settleTenders({
          due: money(filsFrom(DUE)),
          tenders: [{ kind: 'cash', amount: money(fils as never) }],
        }),
      ).toThrow(MalformedTender)
    }
    expect(() => settleTenders({ due: money(filsFrom(DUE)), tenders: [] })).toThrow(MalformedTender)
  })

  it('refuses an amount due that is not a whole non-negative figure', () => {
    // A negative balance is a credit note, not a payment, and a fractional fils reconciles to nothing.
    expect(() =>
      settleTenders({ due: money(-1 as never), tenders: [{ kind: 'cash', amount: aed(1) }] }),
    ).toThrow(/amount due is -1 fils/)
    expect(() =>
      settleTenders({ due: money(1.5 as never), tenders: [{ kind: 'cash', amount: aed(1) }] }),
    ).toThrow(/amount due is 1.5 fils/)
  })

  it('refuses a tender in a currency the balance is not in', () => {
    expect(() =>
      settleTenders({
        due: money(filsFrom(DUE)),
        tenders: [{ kind: 'cash', amount: { fils: filsFrom(DUE), currency: 'USD' as never } }],
      }),
    ).toThrow(MalformedTender)
  })

  it('settles a zero balance by applying nothing and giving it all back', () => {
    // Reachable: a document already paid in full, tendered against again. Nothing is applied, so
    // nothing is recorded against the document — and the whole note is change, which is what the
    // operator hands back.
    const settlement = settleTenders({
      due: money(filsFrom(0)),
      tenders: [{ kind: 'cash', amount: money(filsFrom(NOTE)) }],
    })
    expect(settlement.applied.fils).toBe(0)
    expect(settlement.changeGiven.fils).toBe(NOTE)
    expect(settlement.fullySettled).toBe(true)
  })
})

describe('reconcileSettlement', () => {
  it('reports every difference as zero for a settlement that holds', () => {
    const settlement = settleTenders({
      due: money(filsFrom(26_250)),
      tenders: [
        { kind: 'card_in_salon', amount: money(filsFrom(20_000)), reference: 'APPROVAL-1' },
        { kind: 'cash', amount: money(filsFrom(10_000)) },
      ],
    })
    expect(reconcileSettlement(settlement)).toEqual({
      tenderedVersusAppliedAndChangeFils: 0,
      dueVersusAppliedAndOutstandingFils: 0,
      appliedAboveDueFils: 0,
      changeOnATypeThatGivesNoneFils: 0,
    })
  })

  it('the control: it reports a non-zero difference for a settlement that does not', () => {
    // Hand-built rather than produced by `settleTenders`, because the point is that the reconciliation
    // would CATCH an implementation that netted the change into the payment or applied more than was
    // due. Four zeroes over inputs that can only ever be zero is not a check.
    const broken = {
      due: money(filsFrom(100)),
      tendered: money(filsFrom(120)),
      // Netted: applied is the whole tender and the change is claimed as well.
      applied: money(filsFrom(120)),
      changeGiven: money(filsFrom(20)),
      outstanding: money(filsFrom(0)),
      tenders: [
        {
          kind: 'card_in_salon' as const,
          account: TENDER_ACCOUNT.card_in_salon,
          tendered: money(filsFrom(120)),
          applied: money(filsFrom(120)),
          changeGiven: money(filsFrom(20)),
        },
      ],
      fullySettled: true,
    }
    const reconciliation = reconcileSettlement(broken)
    expect(reconciliation.tenderedVersusAppliedAndChangeFils).toBe(-20)
    expect(reconciliation.dueVersusAppliedAndOutstandingFils).toBe(-20)
    expect(reconciliation.appliedAboveDueFils).toBe(20)
    expect(reconciliation.changeOnATypeThatGivesNoneFils).toBe(20)
  })
})
