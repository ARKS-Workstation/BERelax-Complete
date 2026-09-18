import {
  type IssuerSnapshot,
  instantFromIso,
  PLACEHOLDER_TRN,
  TrnNotConfigured,
  vatIfReDerivedFromTotal,
  vatRateBp,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  ELEVEN_FILS_EXPECTED,
  FIXTURE_ISSUER,
  FIXTURE_TRN,
  invoiceFixture,
  TWO_LINES_AT_ELEVEN_FILS,
} from './invoice.ts'

/** A supply at 01:30 on the 19th belongs to the 18th's trading date; the invoice is raised at noon. */
const SUPPLY_AT_0130 = instantFromIso('2026-09-19T01:30:00+04:00')
const ISSUED_AT_NOON = instantFromIso('2026-09-19T12:00:00+04:00')

const fixture = (options: Partial<Parameters<typeof invoiceFixture>[0]> = {}) =>
  invoiceFixture({ supplyAt: SUPPLY_AT_0130, issuedAt: ISSUED_AT_NOON, ...options })

describe('the committed two-lines-at-11-fils fixture', () => {
  it('derives VAT of 2, which is the sum of the lines and not the split of the total', () => {
    const { input, tax } = fixture()
    expect(TWO_LINES_AT_ELEVEN_FILS.map((l) => l.unitGrossFils)).toEqual([11, 11])

    expect(tax.lines.map((l) => l.vat.fils)).toEqual([
      ELEVEN_FILS_EXPECTED.vatPerLineFils,
      ELEVEN_FILS_EXPECTED.vatPerLineFils,
    ])
    expect(input.vatTotalFils).toBe(ELEVEN_FILS_EXPECTED.documentVatFils)
    expect(input.netTotalFils).toBe(ELEVEN_FILS_EXPECTED.netTotalFils)
    expect(input.grossTotalFils).toBe(ELEVEN_FILS_EXPECTED.grossTotalFils)
    expect(input.netTotalFils + input.vatTotalFils).toBe(input.grossTotalFils)

    // The totals handed to the database are the SUM of the per-line figures, field for field.
    expect(input.vatTotalFils).toBe(input.lines.reduce((total, l) => total + l.vatFils, 0))
    expect(input.netTotalFils).toBe(input.lines.reduce((total, l) => total + l.netFils, 0))
  })

  it('and the re-derivation from the 22-fils total gives 1, so the two methods really differ', () => {
    // The control the whole fixture exists to provide. If splitting the total agreed with summing the
    // lines, "stores 2" would be satisfied by the implementation this unit rejects.
    const { input, tax } = fixture()
    expect(vatIfReDerivedFromTotal(tax.gross).fils).toBe(ELEVEN_FILS_EXPECTED.reDerivedVatFils)
    expect(input.vatTotalFils).not.toBe(ELEVEN_FILS_EXPECTED.reDerivedVatFils)
  })

  it('states the line total nowhere, because the database generates it', () => {
    // `unitGrossFils * quantity` has one correct value, so the input carries no line total at all and
    // there is nothing for a caller to get wrong.
    for (const line of fixture().input.lines) {
      expect(Object.keys(line)).not.toContain('lineGrossFils')
    }
  })
})

describe('the mapping from core to db', () => {
  it('keeps the tax point on the supply trading date and the issue date on the calendar date', () => {
    const { input, taxPoint } = fixture()
    expect(input.taxPointDate).toBe('2026-09-18')
    expect(input.issueDate).toBe('2026-09-19')
    expect(input.issueTradingDate).toBe('2026-09-19')
    expect(taxPoint.taxPointDate).toBe(input.taxPointDate)
    // The control: the two dates differ, which is the only reason storing both is worth anything.
    expect(input.taxPointDate).not.toBe(input.issueDate)
  })

  it('omits the trading date of issue when the document is raised while the premises is shut', () => {
    const { input } = fixture({ issuedAt: instantFromIso('2026-09-19T10:00:00+04:00') })
    expect('issueTradingDate' in input).toBe(false)
    expect(input.issueDate).toBe('2026-09-19')
  })

  it('labels the customer by record number and carries an id only when there is one', () => {
    expect(fixture().input.customer.nameSnapshot).toBe('Customer 0042')
    expect(fixture({ customerIndex: 7 }).input.customer.nameSnapshot).toBe('Customer 0007')
    expect('customerId' in fixture().input.customer).toBe(false)
    const withId = fixture({ customerId: '00000000-0000-7000-8000-00000000002a' })
    expect(withId.input.customer.customerId).toBe('00000000-0000-7000-8000-00000000002a')
  })

  it('flattens the issuer address into the snapshot the document stores', () => {
    const { input } = fixture()
    expect(input.issuer.addressSnapshot.split('\n')).toEqual(FIXTURE_ISSUER.addressLines)
    expect(input.issuer.trn).toBe(FIXTURE_TRN)
    expect(input.issuer.phone).toBe('+971525108633')
    // Absent, not empty: neither legal_entity nor premises carries an Arabic column to snapshot from.
    expect('legalNameAr' in input.issuer).toBe(false)
    expect('addressSnapshotAr' in input.issuer).toBe(false)
    expect('licenceNumber' in input.issuer).toBe(false)
  })

  it('carries the Arabic fields and the licence number when the issuer has them', () => {
    // The other side of every optional above. When Y1-trn and the Arabic source columns are answered,
    // this is the shape that reaches the document.
    const bilingual: IssuerSnapshot = {
      ...FIXTURE_ISSUER,
      legalNameAr: 'شركة بي ريلاكس سبا',
      addressLinesAr: ['شارع الميناء 250', 'أبو ظبي'],
      licenceNumber: 'CN-0000000',
    }
    const { input } = fixture({ issuer: bilingual })
    expect(input.issuer.legalNameAr).toBe('شركة بي ريلاكس سبا')
    expect(input.issuer.addressSnapshotAr).toBe('شارع الميناء 250\nأبو ظبي')
    expect(input.issuer.licenceNumber).toBe('CN-0000000')
  })

  it('carries the per-line Arabic description when a line has one, and omits it when not', () => {
    const { input } = fixture({
      lines: [
        {
          descriptionEn: 'Moroccan Bath',
          descriptionAr: 'الحمام المغربي',
          quantity: 1,
          unitGrossFils: 35_000,
        },
        { descriptionEn: 'Jacuzzi', quantity: 2, unitGrossFils: 5_000 },
      ],
    })
    expect(input.lines[0]?.descriptionAr).toBe('الحمام المغربي')
    expect('descriptionAr' in (input.lines[1] ?? {})).toBe(false)
    // Quantity 2 at 5,000 fils: the line total is 10,000 and its VAT is rounded on that, not per unit.
    expect(input.lines[1]?.netFils).toBe(9_524)
    expect(input.lines[1]?.vatFils).toBe(476)
  })

  it('marks the document provisional against the open question it stands in for', () => {
    const { input } = fixture()
    expect(input.provisionalOpenQuestionId).toBe('Y11-vat-invoice')
    expect(input.provisionalNote).toContain('tax agent')
  })

  it('honours a non-standard rate and a simplified-invoice series', () => {
    const { input } = fixture({
      documentKind: 'simplified_invoice',
      seriesCode: 'SIMPL-INV',
      lines: [
        { descriptionEn: 'Zero rated', quantity: 1, unitGrossFils: 10_000, rateBp: vatRateBp(0) },
      ],
    })
    expect(input.documentKind).toBe('simplified_invoice')
    expect(input.seriesCode).toBe('SIMPL-INV')
    expect(input.lines[0]?.vatRateBp).toBe(0)
    expect(input.vatTotalFils).toBe(0)
  })
})

describe('the fixture refuses what the document refuses', () => {
  it('refuses the placeholder TRN with TrnNotConfigured', () => {
    // The fixture builder validates the issuer before it builds anything, so a caller cannot construct
    // an input the database would reject for a reason that arrives as SQLSTATE 23514.
    expect(() => fixture({ issuer: { ...FIXTURE_ISSUER, trn: PLACEHOLDER_TRN } })).toThrow(
      TrnNotConfigured,
    )
    expect(() => fixture({ issuer: { ...FIXTURE_ISSUER, legalName: '[CONFIRM]' } })).toThrow(
      /IssuerNotConfigured/,
    )
    // The control: the fixture TRN passes, so the refusals are not "no invoice ever validates".
    expect(fixture().input.issuer.trn).toBe(FIXTURE_TRN)
  })

  it('refuses a supply instant that belongs to no trading date', () => {
    // 09:00 is in the daytime gap: the previous session closed at 02:00 and today opens at 11:00.
    expect(() => fixture({ supplyAt: instantFromIso('2026-09-19T09:00:00+04:00') })).toThrow(
      /belongs to no trading date \(before_opening on 2026-09-19\)/,
    )
  })
})
