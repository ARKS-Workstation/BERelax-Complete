import { describe, expect, it } from 'vitest'
import { ACCOUNTS, accountFor, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { postEntry } from '../ledger/entry.ts'
import { aed, filsFrom, money, vatRateBp } from '../money.ts'
import {
  billCreditTotal,
  billDebitTotal,
  billEntryDraft,
  deriveBill,
  deriveBillLine,
  selfAccountsVat,
} from '../purchases/bill.ts'
import { localDate } from '../time.ts'
import { recoverabilityOf } from './recoverability.ts'
import {
  REVERSE_CHARGE_INPUT_ACCOUNT,
  REVERSE_CHARGE_OUTPUT_ACCOUNT,
  reverseChargeBorneVat,
  reverseChargeBoxes,
  reverseChargeForAccount,
  reverseChargeOn,
  reverseChargeProblems,
} from './reverse-charge.ts'

/**
 * M-VAT-03 — the reverse charge, as arithmetic and as two ledger entries.
 *
 * The property every test here exists for is that a reverse charge is a **pair**. A single figure passes
 * arithmetic (it is the right amount), passes the ledger (the entry balances), and is wrong in the return
 * twice over — nothing declared in the output box, nothing claimed in the input box. So the assertions come
 * in pairs too: what each side is, and that the side that must not be zero is not.
 *
 * Every assertion has a control that must fail, as ADR 0003 requires: the recoverable case is paired with the
 * blocked one, the declared figure with the reclaimed one, and the equal pair with the mixed bill where the
 * two deliberately differ.
 */

const IMPORTED = ACCOUNTS.importedServices
const ENTERTAINMENT = ACCOUNTS.entertainment
const GOVERNMENT_FEES = ACCOUNTS.licenceAndGovernmentFees

const importedAccount = accountFor(STANDARD_SPA_CHART, IMPORTED)
const blockedAccount = accountFor(STANDARD_SPA_CHART, ENTERTAINMENT)
const outOfScopeAccount = accountFor(STANDARD_SPA_CHART, GOVERNMENT_FEES)

describe('the reverse charge is two figures', () => {
  it('declares and reclaims the same amount on a recoverable category, so the net effect is nil', () => {
    const charge = reverseChargeOn(aed(1_000), 'recoverable')
    expect(charge.outputVat.fils).toBe(5_000)
    expect(charge.inputVat.fils).toBe(5_000)
    expect(charge.borneVat.fils).toBe(0)
    // The control: nil is the NET effect, not the figures. A pair of zeroes would satisfy "nets to nothing"
    // and declare nothing, which is precisely the failure this unit exists to prevent.
    expect(charge.outputVat.fils).toBeGreaterThan(0)
  })

  it('declares and reclaims NOTHING on a blocked category, so the tax is a real cost', () => {
    const charge = reverseChargeOn(aed(420), 'blocked')
    expect(charge.outputVat.fils).toBe(2_100)
    expect(charge.inputVat.fils).toBe(0)
    expect(charge.borneVat.fils).toBe(2_100)
    // The contrast that makes the blocked case mean something: the same consideration on a recoverable
    // category bears nothing. Without this, "blocked" could be any classification at all.
    expect(reverseChargeOn(aed(420), 'recoverable').borneVat.fils).toBe(0)
  })

  it('reclaims nothing on an out-of-scope category either, and the two reasons stay distinct', () => {
    const charge = reverseChargeOn(aed(200), 'out_of_scope')
    expect(charge.inputVat.fils).toBe(0)
    expect(charge.borneVat.fils).toBe(1_000)
    // The classification travels with the figures so a working paper can say WHY nothing was claimed: tax
    // borne on a blocked category and tax borne where no input VAT arises are different answers.
    expect(charge.recoverability).toBe('out_of_scope')
    expect(reverseChargeOn(aed(200), 'blocked').recoverability).toBe('blocked')
  })

  it('rounds half-up, and half a fils is where the rule is visible', () => {
    // 4,010 × 5% = 200.5. Half-up gives 201; truncation gives 200, and the difference between them is what
    // `bill_line_reverse_charge_output_matches_the_rate` in 0039 states a second time in SQL.
    expect(reverseChargeOn(money(filsFrom(4_010)), 'recoverable').outputVat.fils).toBe(201)
    expect(reverseChargeOn(money(filsFrom(10_101)), 'recoverable').outputVat.fils).toBe(505)
    // The control: a figure that divides exactly is unaffected by the rounding rule, so a test built only
    // on round numbers would pass under either convention.
    expect(reverseChargeOn(money(filsFrom(10_000)), 'recoverable').outputVat.fils).toBe(500)
  })

  it('takes the rate as data, because a filed line keeps the rate it was filed at', () => {
    const charge = reverseChargeOn(aed(1_000), 'recoverable', vatRateBp(1_000))
    expect(charge.rateBp).toBe(1_000)
    expect(charge.outputVat.fils).toBe(10_000)
  })

  it('refuses a nil consideration and a zero rate rather than declaring nothing', () => {
    expect(() => reverseChargeOn(money(filsFrom(0)), 'recoverable')).toThrow(
      /positive consideration/,
    )
    expect(() => reverseChargeOn(aed(100), 'recoverable', vatRateBp(0))).toThrow(/no VAT at all/)
  })

  it('reads the input side off the account, which is the chart’s answer and not the caller’s', () => {
    expect(reverseChargeForAccount(aed(1_000), importedAccount).inputVat.fils).toBe(5_000)
    expect(reverseChargeForAccount(aed(1_000), blockedAccount).inputVat.fils).toBe(0)
    // And the classification it used is the chart's own, so a re-tagged account moves this answer.
    expect(recoverabilityOf(importedAccount)).toBe('recoverable')
    expect(recoverabilityOf(blockedAccount)).toBe('blocked')
  })
})

describe('the VAT201 groupings come from the chart, not from a constant', () => {
  it('names the reverse-charge grouping for the output side and recoverable input tax for the input', () => {
    const boxes = reverseChargeBoxes(STANDARD_SPA_CHART)
    expect(boxes.output).toBe('reverse_charge')
    expect(boxes.input).toBe('recoverable_input_tax')
    // Read from the accounts rather than asserted: this is what makes the test an assertion about the chart
    // instead of about itself, and what fails if either account is re-tagged.
    expect(accountFor(STANDARD_SPA_CHART, REVERSE_CHARGE_OUTPUT_ACCOUNT).vatBox).toBe(boxes.output)
    expect(accountFor(STANDARD_SPA_CHART, REVERSE_CHARGE_INPUT_ACCOUNT).vatBox).toBe(boxes.input)
    // The two are different groupings. A chart that tagged both the same would put the pair in one box and
    // make the return net to nothing, which is the failure a single figure produces in the ledger.
    expect(boxes.output).not.toBe(boxes.input)
  })

  it('refuses a chart whose reverse-charge account feeds no grouping at all', () => {
    const untagged = {
      ...STANDARD_SPA_CHART,
      accounts: STANDARD_SPA_CHART.accounts.map((account) =>
        account.code === REVERSE_CHARGE_OUTPUT_ACCOUNT ? { ...account, vatBox: null } : account,
      ),
    }
    expect(() => reverseChargeBoxes(untagged)).toThrow(/feeds no VAT201 grouping/)
  })
})

describe('a bill line self-accounts, and its expense carries what it cannot reclaim', () => {
  const recoverableLine = () =>
    deriveBillLine({
      description: 'Cloud hosting',
      account: IMPORTED,
      gross: aed(1_000),
      treatment: 'imported_services_reverse_charge',
      reverseCharge: reverseChargeForAccount(aed(1_000), importedAccount),
    })

  it('leaves the gross alone, because the supplier charged no UAE VAT', () => {
    const line = recoverableLine()
    expect(line.net.fils).toBe(100_000)
    expect(line.gross.fils).toBe(100_000)
    expect(line.vat.fils).toBe(0)
    // Not the ordinary claim, and not the blocked disclosure: the reverse charge has its own two fields
    // because the document behind it is our own self-assessment rather than a supplier's tax invoice.
    expect(line.recoverableInputVat.fils).toBe(0)
    expect(line.blockedInputVat.fils).toBe(0)
    expect(line.reverseChargeOutputVat.fils).toBe(5_000)
    expect(line.reverseChargeInputVat.fils).toBe(5_000)
    expect(line.expenseDebit.fils).toBe(100_000)
    expect(selfAccountsVat(line.treatment)).toBe(true)
  })

  it('debits the expense with the tax it bore on a blocked category', () => {
    const line = deriveBillLine({
      description: 'Customer refreshments sourced abroad',
      account: ENTERTAINMENT,
      gross: aed(420),
      treatment: 'imported_services_reverse_charge',
      reverseCharge: reverseChargeForAccount(aed(420), blockedAccount),
    })
    expect(line.reverseChargeOutputVat.fils).toBe(2_100)
    expect(line.reverseChargeInputVat.fils).toBe(0)
    expect(line.reverseChargeBorneVat.fils).toBe(2_100)
    expect(reverseChargeBorneVat(line).fils).toBe(2_100)
    // 42,000 + 2,100. The control is the recoverable line above, whose expense is its net exactly.
    expect(line.expenseDebit.fils).toBe(44_100)
    expect(recoverableLine().expenseDebit.fils).toBe(100_000)
  })

  it('keeps its rate although it carries no supplier VAT, and refuses a zero one', () => {
    expect(recoverableLine().rateBp).toBe(500)
    expect(() =>
      deriveBillLine({
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
        rateBp: vatRateBp(0),
        reverseCharge: { outputVat: aed(50), inputVat: aed(50) },
      }),
    ).toThrow(/at 0 bp/)
  })

  it('refuses an imported service that states no pair, or one that declares nothing', () => {
    expect(() =>
      deriveBillLine({
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
      }),
    ).toThrow(/states no reverse charge/)
    expect(() =>
      deriveBillLine({
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: { outputVat: money(filsFrom(0)), inputVat: money(filsFrom(0)) },
      }),
    ).toThrow(/declares 0 fils/)
  })

  it('refuses a partial claim, because recovery is a property of the account', () => {
    expect(() =>
      deriveBillLine({
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: { outputVat: money(filsFrom(5_000)), inputVat: money(filsFrom(2_500)) },
      }),
    ).toThrow(/whole of the output or none of it/)
  })

  it('refuses a reverse charge on a line that does not owe one, in both directions', () => {
    // A treatment that carries no VAT at all.
    expect(() =>
      deriveBillLine({
        description: 'Government fee',
        account: GOVERNMENT_FEES,
        gross: aed(200),
        treatment: 'out_of_scope',
        reverseCharge: reverseChargeForAccount(aed(200), outOfScopeAccount),
      }),
    ).toThrow(/Only an imported service self-accounts/)
    // And one where the supplier charged UAE VAT, which means they are registered here.
    expect(() =>
      deriveBillLine({
        description: 'Premises rent',
        account: ACCOUNTS.rent,
        gross: aed(2_100),
        treatment: 'standard_recoverable',
        reverseCharge: { outputVat: aed(100), inputVat: aed(100) },
      }),
    ).toThrow(/nothing to self-account/)
  })
})

describe('the entry a reverse-charge bill posts', () => {
  const mixed = () =>
    deriveBill([
      {
        description: 'Booking platform subscription',
        account: IMPORTED,
        gross: aed(200),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: reverseChargeForAccount(aed(200), importedAccount),
      },
      {
        description: 'Customer hospitality boxes',
        account: ENTERTAINMENT,
        gross: aed(84),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: reverseChargeForAccount(aed(84), blockedAccount),
      },
    ])

  it('posts both sides as separate lines and balances', () => {
    const bill = mixed()
    expect(bill.reverseChargeOutputVat.fils).toBe(1_420)
    expect(bill.reverseChargeInputVat.fils).toBe(1_000)
    expect(bill.reverseChargeBorneVat.fils).toBe(420)

    const draft = billEntryDraft({
      entryId: 'JE-RC-TEST-0001',
      entryDate: localDate('2027-03-15'),
      narrative: 'Imported services, March',
      bill,
    })
    const posted = postEntry(draft, STANDARD_SPA_CHART)
    expect(posted.entryId).toBe('JE-RC-TEST-0001')

    const by = (code: string, side: 'debitFils' | 'creditFils') =>
      posted.lines
        .filter((line) => (line.account as string) === code && line[side] > 0)
        .reduce((total, line) => total + line[side], 0)
    // The declaration, credited whole. Netting it against the claim would leave this at zero.
    expect(by(REVERSE_CHARGE_OUTPUT_ACCOUNT as string, 'creditFils')).toBe(1_420)
    // The claim, debited whole — 1,000, not 1,420: the blocked line reclaims nothing.
    expect(by(REVERSE_CHARGE_INPUT_ACCOUNT as string, 'debitFils')).toBe(1_000)
    // And the blocked line's tax is in the expense: 8,400 + 420.
    expect(by(ENTERTAINMENT as string, 'debitFils')).toBe(8_820)
    expect(by(IMPORTED as string, 'debitFils')).toBe(20_000)
    expect(by(ACCOUNTS.tradePayables as string, 'creditFils')).toBe(28_400)

    // The credit side is the payable PLUS the declaration, which is the one shape where a bill credits
    // something the supplier is not owed.
    expect(billDebitTotal(bill).fils).toBe(billCreditTotal(bill).fils)
    expect(billCreditTotal(bill).fils).toBe(28_400 + 1_420)
    // The control: comparing the debits against the gross alone would find every offshore bill out of
    // balance by exactly the tax it declared, which is the mistake this pair of helpers prevents.
    expect(billDebitTotal(bill).fils).not.toBe(bill.gross.fils)
  })

  it('posts no reverse-charge line at all for a domestic bill', () => {
    const domestic = deriveBill([
      {
        description: 'Premises rent',
        account: ACCOUNTS.rent,
        gross: aed(21_000),
        treatment: 'standard_recoverable',
      },
    ])
    expect(domestic.reverseChargeOutputVat.fils).toBe(0)
    expect(domestic.reverseChargeInputVat.fils).toBe(0)
    const draft = billEntryDraft({
      entryId: 'JE-RC-TEST-0002',
      entryDate: localDate('2027-03-15'),
      narrative: 'Premises rent, March',
      bill: domestic,
    })
    expect(draft.lines.some((line) => line.account === REVERSE_CHARGE_OUTPUT_ACCOUNT)).toBe(false)
    expect(billDebitTotal(domestic).fils).toBe(domestic.gross.fils)
  })
})

describe('reverseChargeProblems states what "the two sides do not agree" means', () => {
  it('finds nothing wrong with a correct pair, and nothing wrong with a domestic bill', () => {
    const correct = deriveBill([
      {
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: reverseChargeForAccount(aed(1_000), importedAccount),
      },
    ])
    expect(reverseChargeProblems(correct)).toEqual([])
    const domestic = deriveBill([
      {
        description: 'Rent',
        account: ACCOUNTS.rent,
        gross: aed(21_000),
        treatment: 'standard_recoverable',
      },
    ])
    expect(reverseChargeProblems(domestic)).toEqual([])
  })

  it('names a line declaring nothing, a partial claim, a charge not owed and a bill over-reclaiming', () => {
    // Built by hand rather than through `deriveBillLine`, which refuses all four: this function exists for
    // the rows that reached the database another way — an import, a psql session, or a bill posted before
    // 0039 — and a test that could only build valid bills could not exercise it at all.
    const line = deriveBillLine({
      description: 'Cloud hosting',
      account: IMPORTED,
      gross: aed(1_000),
      treatment: 'imported_services_reverse_charge',
      reverseCharge: reverseChargeForAccount(aed(1_000), importedAccount),
    })
    const declaresNothing = {
      ...line,
      reverseChargeOutputVat: money(filsFrom(0)),
      reverseChargeInputVat: money(filsFrom(0)),
    }
    const partial = { ...line, reverseChargeInputVat: money(filsFrom(2_500)) }
    const notOwed = { ...line, treatment: 'out_of_scope' as const }
    const base = deriveBill([
      {
        description: 'Cloud hosting',
        account: IMPORTED,
        gross: aed(1_000),
        treatment: 'imported_services_reverse_charge',
        reverseCharge: reverseChargeForAccount(aed(1_000), importedAccount),
      },
    ])
    expect(reverseChargeProblems({ ...base, lines: [declaresNothing] })).toEqual([
      'line 1 ("Cloud hosting") is an imported service and declares no reverse-charge VAT',
    ])
    expect(reverseChargeProblems({ ...base, lines: [partial] })[0]).toMatch(
      /neither all of it nor none/,
    )
    expect(reverseChargeProblems({ ...base, lines: [notOwed] })[0]).toMatch(
      /carries a reverse charge it does not owe/,
    )
    expect(
      reverseChargeProblems({ ...base, reverseChargeInputVat: money(filsFrom(9_999)) })[0],
    ).toMatch(/reclaims 9999 fils of reverse-charge VAT and declares only 5000/)
  })
})
