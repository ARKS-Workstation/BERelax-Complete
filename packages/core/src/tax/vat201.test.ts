import { describe, expect, it } from 'vitest'
import { accountCode } from '../ledger/account.ts'
import type { Vat201Attribution, Vat201Line } from './vat201.ts'
import {
  NO_ARITHMETIC_BEYOND_ADDITION,
  summariseVat201,
  VAT201_CONTRIBUTIONS,
  VAT201_DISPOSITIONS,
  VAT201_MEASURES,
  VAT201_OPEN_QUESTIONS,
  vat201PartitionCensus,
  vat201SignedFils,
} from './vat201.ts'

/**
 * The pure half of the VAT201 return: the sign rule, the summation and the partition census.
 *
 * The authoritative summation is in SQL (`vat201_box_total()` over `vat201_box_line()`, migration 0089) and
 * the two are held equal in `packages/fixtures/src/vat201.itest.ts`, which is the only place both halves can
 * be imported. What is checked here is what needs no database, and every case is paired with a control that
 * must fail — brief rule 3, and the reason M-TILL-11's `expectedFloat` control reported PASS while
 * comparing a value to itself.
 *
 * The SOURCE-level claims — that no box number is written into this module, and that nothing in it divides,
 * rounds or applies a rate — are gate block 116's, not this file's. They need to read a file, and
 * `core-must-be-pure` forbids `node:fs` here for a reason worth more than the convenience.
 */

const line = (
  account: string,
  debitFils: number,
  creditFils: number,
  lineNo = 1,
  entryId = 'JE-1',
): Vat201Line => ({
  entryId,
  lineNo,
  accountCode: accountCode(account),
  debitFils: BigInt(debitFils),
  creditFils: BigInt(creditFils),
})

const boxed = (
  account: string,
  boxNo: number,
  measure: 'net_supplies' | 'tax',
  contribution: 'credit_less_debit' | 'debit_less_credit',
): Vat201Attribution => ({
  accountCode: accountCode(account),
  disposition: 'box',
  boxNo,
  measure,
  contribution,
})

const outOfScope = (account: string): Vat201Attribution => ({
  accountCode: accountCode(account),
  disposition: 'out_of_scope',
  boxNo: null,
  measure: null,
  contribution: null,
})

describe('the sign rule', () => {
  it('reads the output side as credit less debit and the input side as debit less credit', () => {
    expect(vat201SignedFils(line('4010', 0, 21_000), 'credit_less_debit')).toBe(21_000n)
    expect(vat201SignedFils(line('6010', 100_000, 0), 'debit_less_credit')).toBe(100_000n)
  })

  it('makes a discount REDUCE the output box, which is the contra account the rule exists for', () => {
    // 4095 Discounts and allowances is a contra revenue account sitting on the DEBIT side. Its
    // contribution is credit_less_debit all the same, because it belongs to the output side of the
    // return: a 500-fils discount reduces the supplies by 500.
    expect(vat201SignedFils(line('4095', 500, 0), 'credit_less_debit')).toBe(-500n)
    // The control, and the whole reason the direction is not derived from normalBalance: deriving it from
    // the account's own side gets this exactly backwards, on a return that still balances.
    expect(vat201SignedFils(line('4095', 500, 0), 'debit_less_credit')).toBe(500n)
  })

  it('reverses every sign when a reversal swaps the sides, and the pair nets to zero', () => {
    const sale = line('2030', 0, 3_333)
    const reversal = line('2030', 3_333, 0)
    expect(vat201SignedFils(sale, 'credit_less_debit')).toBe(3_333n)
    expect(vat201SignedFils(reversal, 'credit_less_debit')).toBe(-3_333n)
    expect(
      vat201SignedFils(sale, 'credit_less_debit') + vat201SignedFils(reversal, 'credit_less_debit'),
    ).toBe(0n)
  })

  it('contributes zero for an unattributed or out-of-scope line, never null', () => {
    expect(vat201SignedFils(line('1010', 21_000, 0), null)).toBe(0n)
  })

  it('refuses a negative side, because direction is the side and never the sign', () => {
    expect(() => vat201SignedFils(line('4010', 0, -1), 'credit_less_debit')).toThrow(
      /negative side/,
    )
  })

  it('offers exactly the vocabulary the mapping rows may hold', () => {
    // A vocabulary that drifted from the migration's CHECK would make a valid mapping row unreadable here
    // while remaining perfectly valid in the database. `unattributed` is in the dispositions and NOT in
    // the migration's CHECK on purpose: ZY001 makes it unreachable as a row, and the partition proof needs
    // to be able to represent its own failing case.
    expect([...VAT201_MEASURES]).toEqual(['net_supplies', 'tax'])
    expect([...VAT201_CONTRIBUTIONS]).toEqual(['credit_less_debit', 'debit_less_credit'])
    expect([...VAT201_DISPOSITIONS]).toEqual(['box', 'unallocated', 'out_of_scope', 'unattributed'])
  })
})

describe('the box summation', () => {
  const attributions = [
    boxed('4020', 1, 'net_supplies', 'credit_less_debit'),
    boxed('2030', 1, 'tax', 'credit_less_debit'),
    boxed('6075', 3, 'net_supplies', 'debit_less_credit'),
    boxed('2035', 3, 'tax', 'credit_less_debit'),
    outOfScope('2050'),
  ]
  const lines = [
    line('2050', 70_000, 0, 1),
    line('4020', 0, 66_667, 2),
    line('2030', 0, 3_333, 3),
    line('6075', 200_000, 0, 1, 'JE-2'),
    line('2035', 0, 10_000, 2, 'JE-2'),
  ]

  it('puts the value in the value column and the tax in the tax column, per box', () => {
    const { boxes } = summariseVat201(lines, attributions, [1, 3])
    expect(boxes).toEqual([
      { boxNo: 1, netSuppliesFils: 66_667n, taxFils: 3_333n, lineCount: 2 },
      { boxNo: 3, netSuppliesFils: 200_000n, taxFils: 10_000n, lineCount: 2 },
    ])
  })

  it('reports a box nobody posted to as a ZERO row and never as an absent one', () => {
    const { boxes } = summariseVat201(lines, attributions, [1, 3, 10])
    expect(boxes.map((box) => box.boxNo)).toEqual([1, 3, 10])
    expect(boxes.at(-1)).toEqual({ boxNo: 10, netSuppliesFils: 0n, taxFils: 0n, lineCount: 0 })
  })

  it('measures the out-of-scope bucket as debits PLUS credits, never the net', () => {
    // The measurement M-TILL-09's probePackageSalePosting got wrong: 4010 credited against the contra
    // 4095 by the same figure nets to zero and HAS recognised revenue.
    const contra = [line('4010', 0, 21_000, 1, 'JE-3'), line('4095', 21_000, 0, 2, 'JE-3')]
    const { unboxed } = summariseVat201(contra, [outOfScope('4010'), outOfScope('4095')], [1])
    expect(unboxed.map((row) => row.movementFils)).toEqual([21_000n, 21_000n])
    // The control: the same two lines measured as a net read as nothing having happened.
    expect(contra.reduce((total, l) => total + l.creditFils - l.debitFils, 0n)).toBe(0n)
  })

  it('refuses two attributions for one account, which would double every line on it', () => {
    expect(() =>
      summariseVat201(
        lines,
        [...attributions, boxed('4020', 3, 'net_supplies', 'credit_less_debit')],
        [1, 3],
      ),
    ).toThrow(/two VAT201 attributions/)
  })

  it('refuses a figure attributed to a box the return was not asked for', () => {
    // A line mapped to a box nobody is reporting disappears without reducing any total, which is what a
    // silent skip would do.
    expect(() => summariseVat201(lines, attributions, [1])).toThrow(/not one of the boxes/)
  })

  it('moves a figure to a different box when the ATTRIBUTION changes and nothing else does', () => {
    // The data-not-code claim in the pure half; the itest proves the same thing over real rows. The lines
    // are byte-identical between the two calls and only the attribution row moved.
    const before = summariseVat201(lines, attributions, [1, 3])
    // The CONTROL first: the figure was in box 1 to begin with, so the assertion below is about a move
    // and not about a box that was always empty.
    expect(before.boxes.find((box) => box.boxNo === 1)?.netSuppliesFils).toBe(66_667n)
    expect(before.boxes.find((box) => box.boxNo === 3)?.netSuppliesFils).toBe(200_000n)

    const moved = attributions.map((a) => (a.accountCode === '4020' ? { ...a, boxNo: 3 } : a))
    const after = summariseVat201(lines, moved, [1, 3])
    expect(after.boxes.find((box) => box.boxNo === 1)?.netSuppliesFils).toBe(0n)
    expect(after.boxes.find((box) => box.boxNo === 3)?.netSuppliesFils).toBe(266_667n)
    // And the total across the boxes is unchanged, which is what says a figure MOVED rather than
    // appeared: a mapping edit that doubled the line would satisfy both assertions above.
    const total = (summary: ReturnType<typeof summariseVat201>) =>
      summary.boxes.reduce((sum, box) => sum + box.netSuppliesFils + box.taxFils, 0n)
    expect(total(after)).toBe(total(before))
  })
})

describe('the exhaustive partition census', () => {
  it('counts every line into exactly one bucket and reports none unattributed', () => {
    const attributions = [boxed('4010', 1, 'net_supplies', 'credit_less_debit'), outOfScope('1010')]
    const lines = [line('1010', 21_000, 0, 1), line('4010', 0, 21_000, 2)]
    const census = vat201PartitionCensus(lines, attributions)
    expect(census.linesInPeriod).toBe(2)
    expect(census.linesDistinct).toBe(2)
    expect(census.boxed + census.unallocated + census.outOfScope).toBe(2)
    expect(census.unattributed).toEqual([])
    expect(census.duplicated).toEqual([])
  })

  it('names the line whose account carries no attribution at all', () => {
    const lines = [line('1010', 21_000, 0, 1), line('4010', 0, 21_000, 2)]
    const census = vat201PartitionCensus(lines, [outOfScope('1010')])
    expect(census.unattributed).toEqual(['JE-1/2'])
    // And the buckets no longer add up to the population, which is the other half of the same failure.
    expect(census.boxed + census.unallocated + census.outOfScope).toBe(1)
  })

  it('names a line counted twice, which is a box total silently too large', () => {
    const duplicated = [line('4010', 0, 21_000, 2), line('4010', 0, 21_000, 2)]
    const census = vat201PartitionCensus(duplicated, [
      boxed('4010', 1, 'net_supplies', 'credit_less_debit'),
    ])
    expect(census.duplicated).toEqual(['JE-1/2'])
    expect(census.linesDistinct).toBe(1)
    expect(census.linesInPeriod).toBe(2)
  })
})

describe('what is unconfirmed, and what each answer changes', () => {
  it('names all four questions this return stands on, each with what its answer moves', () => {
    expect(VAT201_OPEN_QUESTIONS.map((question) => question.questionId)).toEqual([
      'Y11-vat201-boxes',
      'Y11-tax-agent',
      'Y11-vat-package',
      'Y11-rounding',
    ])
    for (const question of VAT201_OPEN_QUESTIONS) {
      // A "revisit this" entry is what this list exists instead of. Both floors are well under the
      // shortest real entry and far above an empty string, so a truncated one fails here.
      expect(question.provisionalAnswer.length, question.questionId).toBeGreaterThan(40)
      expect(question.whatChanges.length, question.questionId).toBeGreaterThan(80)
    }
  })

  it('states the no-arithmetic claim as a value, so deleting it is a visible edit', () => {
    // Gate block 116 asserts this claim against the source of vat201.ts and of 0089_vat201_mapping.sql.
    // Holding the sentence here rather than in the gate file is what stops the check quietly measuring
    // nothing when somebody rewords it.
    expect(NO_ARITHMETIC_BEYOND_ADDITION).toContain('No division')
    expect(NO_ARITHMETIC_BEYOND_ADDITION).toContain('Y11-rounding')
  })

  it('says what Y11-vat-package moves, which is a PERIOD and not a box', () => {
    // The fact M-TILL-10's commit records and this unit's mapping has to get right: under the provisional
    // answer a package's VAT lands in the redemption period's box 1 and nothing from the sale period.
    const answer = VAT201_OPEN_QUESTIONS.find((q) => q.questionId === 'Y11-vat-package')
    expect(answer?.provisionalAnswer).toContain('REDEMPTION')
    expect(answer?.whatChanges).toContain('PERIOD')
  })
})
