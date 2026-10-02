import { describe, expect, it } from 'vitest'
import type { StaffImporterOptions } from './import.ts'
import {
  DECLARED_STAFF_PAYLOAD_KEYS,
  planStaffImport,
  STAFF_REJECTION_REASONS,
  STAFF_REJECTIONS,
  staffImporter,
  stageStaffCell,
  validateStagedStaff,
} from './import.ts'
import { isIsoDate, LEAVE_BASES, readCredentialCell } from './leave-opening.ts'
import type { StaffCell } from './workbook.ts'
import {
  buildStaffWorkbook,
  parseStaffWorkbook,
  SEPARATOR,
  STAFF_COLUMNS,
  STAFF_HEADER,
} from './workbook.ts'

/**
 * H-MIG-06's pure half: the workbook's shape, every named rejection, and the one file-scoped claim.
 *
 * What is NOT here, deliberately: every claim about the database — the five quarantines, the credential
 * expiry that removes a therapist from availability, the field-level policy over the sealed columns, the
 * publishability generation and all four refusals — is a claim about PostgreSQL and is proved in
 * `packages/fixtures/src/staff-import.itest.ts` against a real one. The worked examples the first
 * acceptance line asks for are in `packages/core/src/hr/accrual.worked-examples.test.ts`, which is where
 * the arithmetic lives.
 */

/** A leave-year anchor that is not the real one and does not need to be — see the module note. */
const OPTIONS: StaffImporterOptions = {
  leaveYearStart: ({ startsOnAnniversary, employedFrom, on }) =>
    startsOnAnniversary ? `${on.slice(0, 4)}${employedFrom.slice(4)}` : `${on.slice(0, 4)}-01-01`,
  importedBy: 'H-MIG-06 unit test',
}

const CELL: StaffCell = {
  lineNumber: 2,
  staffReference: 'THP-0001',
  gender: 'female',
  employedFrom: '2024-03-01',
  employedUntil: '',
  styleSkills: ['asian_style'],
  languages: ['english'],
  credentialExpiries: ['labour_card=2027-03-31'],
  leaveOpeningDayHundredths: '1400',
  leaveOpeningBasis: LEAVE_BASES.tradingSessionDay,
  leaveBalanceAsAt: '2026-09-30',
}

const cell = (overrides: Partial<StaffCell>): StaffCell => ({ ...CELL, ...overrides })
const payloadOf = (overrides: Partial<StaffCell>): Record<string, unknown> => ({
  ...stageStaffCell(cell(overrides)),
})

const lineOf = (over: Partial<StaffCell>): string => {
  const row = cell(over)
  return [
    row.staffReference,
    row.gender,
    row.employedFrom,
    row.employedUntil,
    row.styleSkills.join(SEPARATOR),
    row.languages.join(SEPARATOR),
    row.credentialExpiries.join(SEPARATOR),
    row.leaveOpeningDayHundredths,
    row.leaveOpeningBasis,
    row.leaveBalanceAsAt,
  ].join('\t')
}

const fileOf = (rows: readonly Partial<StaffCell>[]): string =>
  [buildStaffWorkbook(), ...rows.map(lineOf), ''].join('\n')

describe('the staff workbook', () => {
  it('states its columns once: the header is derived and the parser demands exactly it', () => {
    expect(STAFF_HEADER).toBe(STAFF_COLUMNS.map((column) => column.name).join('\t'))
    const generated = buildStaffWorkbook()
    expect(generated).toContain(STAFF_HEADER)
    // Anchored on the HEADER LINE and not on the column name, which also appears in the preamble.
    const broken = generated.replace(STAFF_HEADER, STAFF_HEADER.replace('gender', 'sex'))
    expect(() => parseStaffWorkbook(`${broken}${lineOf({})}\n`)).toThrow(/not the generated one/)
  })

  it('is the same bytes every time, because a source file is identified by its hash', () => {
    expect(buildStaffWorkbook()).toBe(buildStaffWorkbook())
  })

  it('has no cell for a bank account, an identity number or a wage', () => {
    const names = STAFF_COLUMNS.map((column) => column.name).join(' ')
    // The structural half of this unit's answer to ADR 0072: the ledger keeps every payload for ever,
    // so a column that could hold an IBAN is an IBAN nothing can erase. Asserted over the COLUMN LIST
    // and over the staged payload's key set, because either one growing is the defect.
    for (const forbidden of [
      'iban',
      'bank',
      'account',
      'emirates',
      'passport',
      'visa',
      'wage',
      'salary',
    ]) {
      expect(names).not.toContain(forbidden)
      expect([...DECLARED_STAFF_PAYLOAD_KEYS].join(' ').toLowerCase()).not.toContain(forbidden)
    }
    // And the file SAYS so, in words, to whoever fills it in.
    expect(buildStaffWorkbook()).toContain('No bank account or IBAN')
  })

  it('tells the person that a blank gender is the right answer when they do not know', () => {
    expect(buildStaffWorkbook()).toContain('LEAVE IT BLANK IF YOU DO NOT KNOW')
  })

  it('splits every multi-valued cell on one separator and drops the empties', () => {
    const file = fileOf([
      {
        styleSkills: ['asian_style', 'arabic_style'],
        languages: ['english', 'arabic'],
        credentialExpiries: ['labour_card=2027-03-31', 'emirates_id=2028-01-15'],
      },
    ])
    const [parsed] = parseStaffWorkbook(file)
    expect(parsed?.styleSkills).toEqual(['asian_style', 'arabic_style'])
    expect(parsed?.languages).toEqual(['english', 'arabic'])
    expect(parsed?.credentialExpiries).toEqual(['labour_card=2027-03-31', 'emirates_id=2028-01-15'])
    // A trailing separator is what a spreadsheet leaves behind, and it must not become an empty value.
    const trailing = parseStaffWorkbook(
      [buildStaffWorkbook(), lineOf({}).replace('asian_style', 'asian_style;'), ''].join('\n'),
    )
    expect(trailing[0]?.styleSkills).toEqual(['asian_style'])
  })

  it('refuses a file nobody filled in rather than importing nothing', () => {
    expect(() => parseStaffWorkbook('# only comments\n\n')).toThrow(/no header row/)
  })
})

describe('a credential cell', () => {
  it('reads a type and a date and nothing else', () => {
    expect(readCredentialCell('labour_card=2027-03-31')).toEqual({
      ok: true,
      documentType: 'labour_card',
      expiresOn: '2027-03-31',
    })
  })

  it('refuses a pair with no date, no type, or a date that is not a day', () => {
    expect(readCredentialCell('labour_card').ok).toBe(false)
    expect(readCredentialCell('=2027-03-31').ok).toBe(false)
    // The shape matches and the day does not exist. `isIsoDate` is what separates the two.
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(readCredentialCell('labour_card=2026-02-30').ok).toBe(false)
  })
})

describe('every named rejection', () => {
  /** One payload per reason, producing exactly it (ADR 0003 and ADR 0065). */
  const cases: readonly [string, Record<string, unknown>][] = [
    [STAFF_REJECTIONS.payloadNotMinimised, { ...payloadOf({}), bankIban: 'anything' }],
    [STAFF_REJECTIONS.staffReferenceMissing, payloadOf({ staffReference: '' })],
    [STAFF_REJECTIONS.genderNotAKnownValue, payloadOf({ gender: 'f' })],
    [STAFF_REJECTIONS.employedFromNotADate, payloadOf({ employedFrom: '01/03/2024' })],
    [STAFF_REJECTIONS.employedUntilNotADate, payloadOf({ employedUntil: 'still here' })],
    [STAFF_REJECTIONS.employmentPeriodNotOrdered, payloadOf({ employedUntil: '2023-01-01' })],
    [STAFF_REJECTIONS.skillNotAKnownStyle, payloadOf({ styleSkills: ['thai_style'] })],
    [STAFF_REJECTIONS.languageNotAKnownLanguage, payloadOf({ languages: ['tagalog'] })],
    [
      STAFF_REJECTIONS.credentialNotATypeAndADate,
      payloadOf({ credentialExpiries: ['labour_card'] }),
    ],
    [
      STAFF_REJECTIONS.credentialTypeRepeated,
      payloadOf({ credentialExpiries: ['labour_card=2027-03-31', 'labour_card=2026-01-01'] }),
    ],
    // `Number('14.00')` is 14, an integer — so a decimal cell would import fourteen HUNDREDTHS instead
    // of fourteen hundred, a hundred times too small. `wholeOrNaN` is what refuses it.
    [
      STAFF_REJECTIONS.leaveBalanceNotWholeHundredths,
      payloadOf({ leaveOpeningDayHundredths: '14.00' }),
    ],
    [STAFF_REJECTIONS.leaveBalanceNotWholeHundredths, payloadOf({ leaveOpeningDayHundredths: '' })],
    [STAFF_REJECTIONS.leaveBalanceNegative, { ...payloadOf({}), leaveOpeningHundredths: -1 }],
    [STAFF_REJECTIONS.leaveBasisNotAKnownValue, payloadOf({ leaveOpeningBasis: 'days' })],
    [STAFF_REJECTIONS.leaveAsAtNotADate, payloadOf({ leaveBalanceAsAt: '30-09-2026' })],
    [STAFF_REJECTIONS.leaveAsAtBeforeEmployment, payloadOf({ leaveBalanceAsAt: '2023-12-31' })],
  ]

  for (const [index, [reason, payload]] of cases.entries()) {
    it(`case ${index + 1} produces ${reason}`, () => {
      const verdict = validateStagedStaff(payload)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok ? '' : verdict.reason).toBe(reason)
    })
  }

  it('accepts the well-formed payload the cases above are built from', () => {
    // The control. Every case above is satisfied by a FAILURE, so one has to be satisfied by a pass.
    expect(validateStagedStaff(payloadOf({}))).toEqual({ ok: true })
  })

  it('accepts a BLANK gender, because an unrecorded one is a quarantine and not a bad cell', () => {
    // The acceptance line's own split, asserted as a pass: a blank gender must reach apply, where it
    // quarantines by name. Refusing it here would fail the whole file and import nobody.
    expect(validateStagedStaff(payloadOf({ gender: '' }))).toEqual({ ok: true })
  })

  it('accepts a calendar-day basis, for the same reason', () => {
    // It quarantines at apply (and ZY371 is the refusal behind it). Refusing it at staging would fail
    // the file, and the claim would not be on the record.
    expect(validateStagedStaff(payloadOf({ leaveOpeningBasis: LEAVE_BASES.calendarDay }))).toEqual({
      ok: true,
    })
  })

  it('leaves no reason unreachable and invents none', () => {
    const reached = new Set(cases.map(([reason]) => reason))
    // `staffReferenceRepeated` is the one reason no single payload can produce: it is a claim about the
    // FILE, reached through the importer's own `validate` below.
    reached.add(STAFF_REJECTIONS.staffReferenceRepeated)
    expect([...reached].sort()).toEqual([...STAFF_REJECTION_REASONS].sort())
  })
})

describe('the file-scoped claim', () => {
  it('refuses BOTH lines that name one staff reference', () => {
    const importer = staffImporter(OPTIONS)
    const rows = importer.parse(
      fileOf([{ staffReference: 'THP-0001' }, { staffReference: 'THP-0001', gender: 'male' }]),
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const verdict = importer.validate(row.payload)
      expect(verdict.ok ? '' : verdict.reason).toBe(STAFF_REJECTIONS.staffReferenceRepeated)
    }
  })

  it('leaves two different references alone, which is the control', () => {
    const importer = staffImporter(OPTIONS)
    const rows = importer.parse(
      fileOf([{ staffReference: 'THP-0001' }, { staffReference: 'THP-0002' }]),
    )
    expect(rows.map((row) => importer.validate(row.payload))).toEqual([{ ok: true }, { ok: true }])
  })

  it('names the repeated references in the plan, for the report', () => {
    const plan = planStaffImport(OPTIONS, [
      cell({ lineNumber: 2, staffReference: 'THP-0001' }),
      cell({ lineNumber: 3, staffReference: 'THP-0001' }),
      cell({ lineNumber: 4, staffReference: 'THP-0002' }),
    ])
    expect([...plan.repeatedReferences]).toEqual(['THP-0001'])
    expect(plan.rejections.map((rejection) => rejection.lineNumber)).toEqual([2, 3])
  })
})

describe('the importer', () => {
  it('declares every table it writes, so provenance is not refused by ZY194', () => {
    expect([...staffImporter(OPTIONS).targetTables]).toEqual([
      'public.imported_staff_row',
      'public.employee',
      'public.employee_document',
      'public.leave_movement',
    ])
  })

  it('refuses to be built without a leave-year anchor', () => {
    expect(() =>
      planStaffImport({ leaveYearStart: undefined as never, importedBy: 'test' }, [CELL]),
    ).toThrow(/No leave-year anchor was injected/)
  })
})
