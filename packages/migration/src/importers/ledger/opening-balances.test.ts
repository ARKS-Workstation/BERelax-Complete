import { describe, expect, it } from 'vitest'
import { boxesFedByTheChart, chartAttributionGaps } from './coa.ts'
import type { OpeningImporterOptions } from './opening-balances.ts'
import {
  DECLARED_OPENING_PAYLOAD_KEYS,
  OPENING_REJECTION_REASONS,
  OPENING_REJECTIONS,
  openingBalancesImporter,
  statedPositions,
  validateStagedOpening,
} from './opening-balances.ts'
import {
  buildOpeningWorkbook,
  OPENING_COLUMNS,
  OPENING_HEADER,
  parseOpeningWorkbook,
  wholeFilsOrNaN,
} from './workbook.ts'

/**
 * H-MIG-07's pure half: the workbook's shape, every named rejection, and the chart's completeness
 * measurement.
 *
 * What is NOT here: every claim about the database — the boundary lock, the attestation tying to the
 * entry, the append-only attestation, the reconciliation to H-MIG-03's liability and all four refusals —
 * is a claim about PostgreSQL and is proved in `packages/fixtures/src/opening-boundary.itest.ts`. The
 * boundary predicate and the remainder arithmetic are pure and are proved in
 * `packages/core/src/ledger/period-lock.test.ts`, where they live.
 */

/** A remainder calculator that subtracts, which is enough for every case here. */
const OPTIONS: OpeningImporterOptions = {
  remainder: ({ statedDebitFils, statedCreditFils, postedNetFils }) => {
    const net = statedDebitFils - statedCreditFils - postedNetFils
    return { ok: true, debitFils: net > 0 ? net : 0, creditFils: net < 0 ? -net : 0 }
  },
  importedBy: 'H-MIG-07 unit test',
}

const DATE = '2026-10-01'

const fileOf = (rows: readonly (readonly [string, string, string, string])[]): string =>
  [buildOpeningWorkbook(), ...rows.map((row) => row.join('\t')), ''].join('\n')

const balanced = fileOf([
  [DATE, '1010', '4000000', '0'],
  [DATE, '2050', '0', '4000000'],
])

const payloadOf = (
  lines: readonly { accountCode: string; debitFils: number; creditFils: number }[],
  openingDate = DATE,
): Record<string, unknown> => ({ openingDate, lines })

describe('the opening trial balance workbook', () => {
  it('states its columns once: the header is derived and the parser demands exactly it', () => {
    expect(OPENING_HEADER).toBe(OPENING_COLUMNS.map((column) => column.name).join('\t'))
    const generated = buildOpeningWorkbook()
    expect(generated).toContain(OPENING_HEADER)
    const broken = generated.replace(
      OPENING_HEADER,
      OPENING_HEADER.replace('credit_fils', 'credit'),
    )
    expect(() => parseOpeningWorkbook(`${broken}${DATE}\t1010\t1\t0\n`)).toThrow(
      /not the generated one/,
    )
  })

  it('is the same bytes every time, and prints no account code of its own', () => {
    expect(buildOpeningWorkbook()).toBe(buildOpeningWorkbook())
    // It does NOT print the chart into the file, deliberately: printing it would invite somebody to
    // file a balance against the nearest code on the list rather than the one their own books use.
    expect(buildOpeningWorkbook()).not.toMatch(/^# {2}\d{4} /m)
  })

  it('reads a blank side as zero and refuses a decimal', () => {
    // A blank is zero HERE because a line states one side and leaves the other empty. A decimal is NaN,
    // because `Number('250.00')` is 250 and that is how a figure comes to be a hundred times too small.
    expect(wholeFilsOrNaN('')).toBe(0)
    expect(wholeFilsOrNaN('  ')).toBe(0)
    expect(wholeFilsOrNaN('4000000')).toBe(4_000_000)
    expect(Number.isNaN(wholeFilsOrNaN('40000.00'))).toBe(true)
    expect(Number.isNaN(wholeFilsOrNaN('-1'))).toBe(true)
  })

  it('tells the person what must NOT be entered twice', () => {
    expect(buildOpeningWorkbook()).toContain('WHAT IS ALREADY IN THE BOOKS')
    expect(buildOpeningWorkbook()).toContain('refused by name')
  })
})

describe('every named rejection', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    [
      OPENING_REJECTIONS.payloadNotMinimised,
      { ...payloadOf([{ accountCode: '1010', debitFils: 1, creditFils: 0 }]), trn: 'anything' },
    ],
    [
      OPENING_REJECTIONS.openingDateNotADate,
      payloadOf([{ accountCode: '1010', debitFils: 1, creditFils: 0 }], '01/10/2026'),
    ],
    [OPENING_REJECTIONS.noLines, payloadOf([])],
    [
      OPENING_REJECTIONS.accountCodeNotFourDigits,
      payloadOf([{ accountCode: '101', debitFils: 1, creditFils: 0 }]),
    ],
    [
      OPENING_REJECTIONS.accountCodeRepeated,
      payloadOf([
        { accountCode: '1010', debitFils: 1, creditFils: 0 },
        { accountCode: '1010', debitFils: 0, creditFils: 1 },
      ]),
    ],
    [
      OPENING_REJECTIONS.amountNotWholeFils,
      payloadOf([{ accountCode: '1010', debitFils: Number.NaN, creditFils: 0 }]),
    ],
    [
      OPENING_REJECTIONS.notExactlyOneSide,
      payloadOf([{ accountCode: '1010', debitFils: 1, creditFils: 1 }]),
    ],
    [
      OPENING_REJECTIONS.trialBalanceDoesNotBalance,
      payloadOf([
        { accountCode: '1010', debitFils: 4_000_000, creditFils: 0 },
        { accountCode: '2050', debitFils: 0, creditFils: 3_998_750 },
      ]),
    ],
  ]

  for (const [reason, payload] of cases) {
    it(`produces ${reason}`, () => {
      const verdict = validateStagedOpening(payload)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok ? '' : verdict.reason).toBe(reason)
    })
  }

  it('accepts a balanced statement, which is the control', () => {
    expect(
      validateStagedOpening(
        payloadOf([
          { accountCode: '1010', debitFils: 4_000_000, creditFils: 0 },
          { accountCode: '2050', debitFils: 0, creditFils: 4_000_000 },
        ]),
      ),
    ).toEqual({ ok: true })
  })

  it('leaves no reason unreachable and invents none', () => {
    const reached = new Set(cases.map(([reason]) => reason))
    // `openingDateNotTheSameOnEveryLine` is reached in `parse` and not in `validate`: by the time there
    // is one staged payload there is one date, so a payload cannot express the disagreement.
    reached.add(OPENING_REJECTIONS.openingDateNotTheSameOnEveryLine)
    expect([...reached].sort()).toEqual([...OPENING_REJECTION_REASONS].sort())
  })
})

describe('the importer', () => {
  it('stages ONE row for the whole statement, at the first data line', () => {
    const rows = openingBalancesImporter(OPTIONS).parse(balanced)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual(
      [...DECLARED_OPENING_PAYLOAD_KEYS].sort(),
    )
    /*
      The line number is the first DATA line, which is the line a person opens the spreadsheet at.

      Derived from the file rather than written as `headerAt + 2`, which is what this case said first and
      was wrong by one: the generated workbook ends with a newline, so joining it to the data rows leaves
      a BLANK line between the header and the first of them. The parser skips it, as it skips any spacer
      a spreadsheet leaves behind, and the line number is still the real line in the file — which is the
      whole reason it is 1-based and read off the file rather than counted.
    */
    const lines = balanced.split('\n')
    const headerAt = lines.findIndex((line) => line === OPENING_HEADER)
    const firstDataAt = lines.findIndex(
      (line, index) => index > headerAt && line.trim().length > 0 && !line.startsWith('#'),
    )
    expect(rows[0]?.lineNumber).toBe(firstDataAt + 1)
    expect(firstDataAt).toBeGreaterThan(headerAt + 1)
  })

  it('declares every table it writes, and not journal_line', () => {
    expect([...openingBalancesImporter(OPTIONS).targetTables]).toEqual([
      'public.journal_entry',
      'public.opening_balance_import',
    ])
    // `journal_line`'s primary key is (entry_id, line_no), and ZY199 refuses a provenance coverage read
    // over a relation without a single-column one.
    expect(openingBalancesImporter(OPTIONS).targetTables).not.toContain('public.journal_line')
  })

  it('refuses a file whose lines disagree about the opening date', () => {
    const mixed = fileOf([
      [DATE, '1010', '4000000', '0'],
      ['2026-10-02', '2050', '0', '4000000'],
    ])
    expect(() => openingBalancesImporter(OPTIONS).parse(mixed)).toThrow(
      /names 2 different opening dates/,
    )
  })

  it('refuses a file with a header and no lines', () => {
    expect(() => openingBalancesImporter(OPTIONS).parse(buildOpeningWorkbook())).toThrow(
      /header and no lines/,
    )
  })

  it('refuses to be built without a remainder calculator', () => {
    expect(() =>
      openingBalancesImporter({ remainder: undefined as never, importedBy: 'x' }),
    ).toThrow(/No remainder calculator was injected/)
  })

  it('states each account signed, for the reconciliation read', () => {
    expect([...statedPositions(parseOpeningWorkbook(balanced))]).toEqual([
      { accountCode: '1010', netFils: 4_000_000 },
      { accountCode: '2050', netFils: -4_000_000 },
    ])
  })
})

describe("the chart's VAT201 completeness, measured", () => {
  it('names an account with no attribution at all', () => {
    expect([
      ...chartAttributionGaps([
        { accountCode: '1010', disposition: 'out_of_scope', boxNo: null, openQuestionId: null },
        { accountCode: '4010', disposition: null as never, boxNo: null, openQuestionId: null },
      ]),
    ]).toEqual([{ accountCode: '4010', reason: 'no_attribution' }])
  })

  it('names a box attribution with no box number, and an unallocated one with no question', () => {
    expect([
      ...chartAttributionGaps([
        { accountCode: '4010', disposition: 'box', boxNo: null, openQuestionId: null },
        { accountCode: '4020', disposition: 'unallocated', boxNo: null, openQuestionId: '  ' },
      ]),
    ]).toEqual([
      { accountCode: '4010', reason: 'box_without_a_number' },
      { accountCode: '4020', reason: 'unallocated_without_a_question' },
    ])
  })

  it('names nothing for a complete chart, which is the control', () => {
    expect([
      ...chartAttributionGaps([
        { accountCode: '1010', disposition: 'out_of_scope', boxNo: null, openQuestionId: null },
        { accountCode: '4010', disposition: 'box', boxNo: 1, openQuestionId: null },
        { accountCode: '4020', disposition: 'unallocated', boxNo: null, openQuestionId: 'Y11-vat' },
      ]),
    ]).toEqual([])
  })

  it('derives the boxes the chart feeds rather than stating them', () => {
    expect([
      ...boxesFedByTheChart([
        { accountCode: '4010', disposition: 'box', boxNo: 3, openQuestionId: null },
        { accountCode: '4020', disposition: 'box', boxNo: 1, openQuestionId: null },
        { accountCode: '2110', disposition: 'box', boxNo: 1, openQuestionId: null },
        { accountCode: '1010', disposition: 'out_of_scope', boxNo: null, openQuestionId: null },
      ]),
    ]).toEqual([1, 3])
  })
})
