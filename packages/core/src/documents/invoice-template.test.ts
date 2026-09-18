import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_TRN, TrnNotConfigured } from '../money/vat.ts'
import { aed, filsFrom, money } from '../money.ts'
import {
  buildTaxDocument,
  chooseInvoiceForm,
  DOCUMENT_FIELDS,
  DOCUMENT_FORM_FIELDS,
  DOCUMENT_FORMS,
  formStates,
  INVOICE_FORM_RULE,
  invoiceFormRuleKey,
  isAboveSimplifiedThreshold,
  isInvoiceForm,
  requireInvoiceForm,
  SIMPLIFIED_INVOICE_THRESHOLD,
  SIMPLIFIED_INVOICE_THRESHOLD_PROVISIONAL,
  type StoredDocument,
} from './invoice-template.ts'

/** A stored tax invoice with a customer of record, which is what the rule requires of the full form. */
const STORED: StoredDocument = {
  documentKind: 'tax_invoice',
  seriesCode: 'TAX-INV',
  periodKey: '2026',
  displayNumber: 'TI-2026-00001',
  issuerLegalName: 'BE RELAX SPA - L.L.C - O.P.C',
  issuerTradingName: 'BE RELAX - Massage Center and Spa',
  issuerTrn: '100000000000003',
  issuerAddressSnapshot: '250 Al Meena Street\nAbu Dhabi',
  issuerEmirate: 'Abu Dhabi',
  issuerPhone: '+971563429399',
  issuerLicenceNumber: null,
  issuerLegalNameAr: null,
  issuerAddressSnapshotAr: null,
  customerId: '11111111-1111-1111-1111-111111111111',
  customerNameSnapshot: 'Customer 0042',
  customerTrn: null,
  customerAddressSnapshot: 'Al Zahiyah, Abu Dhabi',
  customerPhone: null,
  issueDate: '2026-09-19',
  taxPointDate: '2026-09-18',
  currency: 'AED',
  netTotalFils: 20,
  vatTotalFils: 2,
  grossTotalFils: 22,
  notes: 'Thank you.',
  lines: [
    {
      lineNo: 1,
      descriptionEn: 'Rounding probe, line 1',
      descriptionAr: null,
      quantity: 1,
      unitGrossFils: 11,
      lineGrossFils: 11,
      vatRateBp: 500,
      netFils: 10,
      vatFils: 1,
    },
    {
      lineNo: 2,
      descriptionEn: 'Rounding probe, line 2',
      descriptionAr: null,
      quantity: 1,
      unitGrossFils: 11,
      lineGrossFils: 11,
      vatRateBp: 500,
      netFils: 10,
      vatFils: 1,
    },
  ],
}

const anonymous: StoredDocument = {
  ...STORED,
  documentKind: 'simplified_invoice',
  seriesCode: 'SIMPL-INV',
  displayNumber: 'SI-2026-00001',
  customerId: null,
}

describe('the full-versus-simplified rule', () => {
  /** The table, read as a table. Both sides of the threshold, both answers about the customer. */
  const CASES = [
    { gross: aed(1), customerIdentified: false, expected: 'simplified_invoice' },
    { gross: aed(1), customerIdentified: true, expected: 'tax_invoice' },
    // Exactly ON the threshold is still below it: the concession applies up to and including the value.
    {
      gross: SIMPLIFIED_INVOICE_THRESHOLD,
      customerIdentified: false,
      expected: 'simplified_invoice',
    },
    { gross: SIMPLIFIED_INVOICE_THRESHOLD, customerIdentified: true, expected: 'tax_invoice' },
    // One fils over, which is the smallest step that changes the answer.
    {
      gross: money(filsFrom(SIMPLIFIED_INVOICE_THRESHOLD.fils + 1)),
      customerIdentified: false,
      expected: 'CustomerDetailsRequired',
    },
    {
      gross: money(filsFrom(SIMPLIFIED_INVOICE_THRESHOLD.fils + 1)),
      customerIdentified: true,
      expected: 'tax_invoice',
    },
  ] as const

  for (const { gross, customerIdentified, expected } of CASES) {
    it(`${gross.fils} fils, customer ${customerIdentified ? 'named' : 'anonymous'} -> ${expected}`, () => {
      const decision = chooseInvoiceForm({ gross, customerIdentified })
      if (expected === 'CustomerDetailsRequired') {
        expect(decision).toEqual({
          kind: 'refused',
          code: 'CustomerDetailsRequired',
          reason: expect.stringContaining('identify the customer'),
        })
      } else {
        expect(decision).toEqual({
          kind: 'form',
          form: expected,
          reason: expect.any(String),
        })
      }
    })
  }

  it('is the table, not a second copy of the table', () => {
    // Four keys, one per combination, and every one of them reachable from a pair of booleans.
    expect(Object.keys(INVOICE_FORM_RULE)).toHaveLength(4)
    for (const above of [false, true]) {
      for (const identified of [false, true]) {
        const row = INVOICE_FORM_RULE[invoiceFormRuleKey(above, identified)]
        expect(row.aboveThreshold).toBe(above)
        expect(row.customerIdentified).toBe(identified)
        expect(row.reason.length).toBeGreaterThan(20)
      }
    }
  })

  it('never answers "receipt", because a receipt is not a tax invoice', () => {
    const outcomes = Object.values(INVOICE_FORM_RULE).map((row) => row.outcome)
    expect(outcomes).not.toContain('receipt')
    expect(new Set(outcomes)).toEqual(
      new Set(['simplified_invoice', 'tax_invoice', 'CustomerDetailsRequired']),
    )
  })

  it('cannot be told which form to use — a form is not an input', () => {
    chooseInvoiceForm({
      gross: aed(100),
      customerIdentified: false,
      // @ts-expect-error — the whole point: no caller, and therefore no screen, can pass a form. If this
      // line ever compiles, the rule has become a default rather than a rule.
      form: 'tax_invoice',
    })
    expect(Object.keys(chooseInvoiceForm({ gross: aed(100), customerIdentified: true }))).toEqual([
      'kind',
      'form',
      'reason',
    ])
  })

  it('requireInvoiceForm throws with the refusal code and both figures', () => {
    expect(() =>
      requireInvoiceForm({
        gross: money(filsFrom(SIMPLIFIED_INVOICE_THRESHOLD.fils + 1)),
        customerIdentified: false,
      }),
    ).toThrow(/CustomerDetailsRequired.*1000001 fils, threshold 1000000 fils/s)
    expect(requireInvoiceForm({ gross: aed(10), customerIdentified: false })).toBe(
      'simplified_invoice',
    )
  })

  it('carries the threshold as a flagged provisional value', () => {
    expect(SIMPLIFIED_INVOICE_THRESHOLD).toEqual(aed(10_000))
    expect(SIMPLIFIED_INVOICE_THRESHOLD_PROVISIONAL.provisional).toBe(true)
    expect(SIMPLIFIED_INVOICE_THRESHOLD_PROVISIONAL.openQuestionId).toBe('Y11-vat-invoice')
    expect(isAboveSimplifiedThreshold(aed(10_000))).toBe(false)
    expect(isAboveSimplifiedThreshold(money(filsFrom(1_000_001)))).toBe(true)
  })
})

describe('what each form states', () => {
  it('names every form, and a receipt is not an invoice form', () => {
    expect(DOCUMENT_FORMS).toEqual(['tax_invoice', 'simplified_invoice', 'receipt'])
    expect(isInvoiceForm('tax_invoice')).toBe(true)
    expect(isInvoiceForm('simplified_invoice')).toBe(true)
    expect(isInvoiceForm('receipt')).toBe(false)
  })

  it('declares a field list for every form, drawn from the closed field set', () => {
    for (const form of DOCUMENT_FORMS) {
      const fields = DOCUMENT_FORM_FIELDS[form]
      expect(fields.length).toBeGreaterThan(5)
      for (const field of fields) expect(DOCUMENT_FIELDS).toContain(field)
      // No duplicates: a list read twice would make a missing field look present.
      expect(new Set(fields).size).toBe(fields.length)
    }
  })

  it('the tax invoice is the superset, and only the receipt disclaims being one', () => {
    for (const form of ['simplified_invoice', 'receipt'] as const) {
      for (const field of DOCUMENT_FORM_FIELDS[form]) {
        if (field === 'notATaxInvoice') continue
        expect(formStates('tax_invoice', field)).toBe(true)
      }
    }
    expect(formStates('receipt', 'notATaxInvoice')).toBe(true)
    expect(formStates('tax_invoice', 'notATaxInvoice')).toBe(false)
    expect(formStates('simplified_invoice', 'notATaxInvoice')).toBe(false)
  })

  it('the simplified invoice drops the customer block and keeps the tax figures', () => {
    for (const field of ['customerName', 'customerAddress', 'customerTrn'] as const) {
      expect(formStates('simplified_invoice', field)).toBe(false)
      expect(formStates('tax_invoice', field)).toBe(true)
    }
    expect(formStates('simplified_invoice', 'issuerTrn')).toBe(true)
    expect(formStates('simplified_invoice', 'vatTotal')).toBe(true)
  })

  it('the receipt states no TRN and no tax figures at all', () => {
    for (const field of [
      'issuerTrn',
      'lineNet',
      'lineVat',
      'lineVatRate',
      'netTotal',
      'vatTotal',
    ] as const) {
      expect(formStates('receipt', field)).toBe(false)
    }
    // And it does state what a proof of payment needs.
    for (const field of [
      'documentTitle',
      'grossTotal',
      'lineGross',
      'issuerTradingName',
    ] as const) {
      expect(formStates('receipt', field)).toBe(true)
    }
  })

  it('every form carries Arabic, which is the language requirement', () => {
    for (const form of DOCUMENT_FORMS) expect(formStates(form, 'arabicText')).toBe(true)
  })
})

describe('building the view from a stored document', () => {
  it('prints the stored totals, not a re-derivation', () => {
    const view = buildTaxDocument(STORED, { form: 'tax_invoice' })
    expect(view.totals.net.fils).toBe(20)
    // The whole point of the unit: the SUM of two 1-fils lines, not the 1 fils a split of 22 gives.
    expect(view.totals.vat.fils).toBe(2)
    expect(view.totals.gross.fils).toBe(22)
    expect(view.lines.map((line) => line.vat.fils)).toEqual([1, 1])
    expect(view.documentNumber).toBe('TI-2026-00001')
    expect(view.issueDate).toBe('2026-09-19')
    expect(view.taxPointDate).toBe('2026-09-18')
  })

  it('gives a single-rate document one subtotal and a nameable rate', () => {
    const view = buildTaxDocument(STORED, { form: 'tax_invoice' })
    expect(view.totals.byRate).toEqual([
      {
        rateBp: 500,
        net: money(filsFrom(20)),
        vat: money(filsFrom(2)),
        gross: money(filsFrom(22)),
      },
    ])
    expect(view.singleRateBp).toBe(500)
  })

  it('gives a mixed-rate document one subtotal per rate and no single rate', () => {
    const mixed: StoredDocument = {
      ...STORED,
      netTotalFils: 110,
      vatTotalFils: 1,
      grossTotalFils: 111,
      lines: [
        { ...(STORED.lines[0] as (typeof STORED.lines)[number]) },
        {
          lineNo: 2,
          descriptionEn: 'Gift voucher, zero-rated',
          descriptionAr: null,
          quantity: 1,
          unitGrossFils: 100,
          lineGrossFils: 100,
          vatRateBp: 0,
          netFils: 100,
          vatFils: 0,
        },
      ],
    }
    const view = buildTaxDocument(mixed, { form: 'tax_invoice' })
    expect(view.totals.byRate.map((subtotal) => subtotal.rateBp)).toEqual([0, 500])
    expect(view.singleRateBp).toBeUndefined()
  })

  it('leads with the trading name on a receipt and the legal name on an invoice', () => {
    expect(buildTaxDocument(STORED, { form: 'receipt' }).issuer.name).toBe(STORED.issuerTradingName)
    expect(buildTaxDocument(STORED, { form: 'tax_invoice' }).issuer.name).toBe(
      STORED.issuerLegalName,
    )
    // Both names are available either way: the masthead needs one and the supplier block the other.
    expect(buildTaxDocument(STORED, { form: 'tax_invoice' }).issuer.tradingName).toBe(
      STORED.issuerTradingName,
    )
  })

  it('suppresses the TRN, the customer and the emirate on a receipt', () => {
    const view = buildTaxDocument(STORED, { form: 'receipt' })
    expect(view.issuer.trn).toBeUndefined()
    expect(view.issuer.emirate).toBeUndefined()
    expect(view.customer).toBeUndefined()
    // The control: the same stored row states all three on the full form.
    const full = buildTaxDocument(STORED, { form: 'tax_invoice' })
    expect(full.issuer.trn).toBe(STORED.issuerTrn)
    expect(full.issuer.emirate).toBe('Abu Dhabi')
    expect(full.customer?.name).toBe('Customer 0042')
  })

  it('splits the stored address block into printable lines', () => {
    const view = buildTaxDocument(STORED, { form: 'tax_invoice' })
    expect(view.issuer.addressLines).toEqual(['250 Al Meena Street', 'Abu Dhabi'])
    expect(view.customer?.addressLines).toEqual(['Al Zahiyah, Abu Dhabi'])
    expect(view.issuer.addressLinesAr).toEqual([])
  })

  it('uses a caller Arabic fallback only where the stored column is null', () => {
    const withArabic = buildTaxDocument(STORED, {
      form: 'tax_invoice',
      arabic: {
        issuerLegalName: 'شركة',
        issuerAddressLines: ['أبوظبي'],
        lineDescriptions: { 2: 'السطر الثاني' },
        customerName: 'عميل',
        notes: 'شكراً',
      },
    })
    expect(withArabic.issuer.nameAr).toBe('شركة')
    expect(withArabic.issuer.addressLinesAr).toEqual(['أبوظبي'])
    expect(withArabic.lines[0]?.descriptionAr).toBeUndefined()
    expect(withArabic.lines[1]?.descriptionAr).toBe('السطر الثاني')
    expect(withArabic.customer?.nameAr).toBe('عميل')
    expect(withArabic.notesAr).toBe('شكراً')

    // The stored column wins when it has a value: B-CAT-06 seeds the source tables, and after that a
    // fallback must not shadow the snapshot.
    const snapshotted = buildTaxDocument(
      {
        ...STORED,
        issuerLegalNameAr: 'الاسم المسجل',
        issuerAddressSnapshotAr: 'العنوان المسجل',
        lines: [{ ...(STORED.lines[0] as (typeof STORED.lines)[number]), descriptionAr: 'مخزّن' }],
        netTotalFils: 10,
        vatTotalFils: 1,
        grossTotalFils: 11,
      },
      { form: 'tax_invoice', arabic: { issuerLegalName: 'شركة', lineDescriptions: { 1: 'بديل' } } },
    )
    expect(snapshotted.issuer.nameAr).toBe('الاسم المسجل')
    expect(snapshotted.issuer.addressLinesAr).toEqual(['العنوان المسجل'])
    expect(snapshotted.lines[0]?.descriptionAr).toBe('مخزّن')
  })
})

describe('what it refuses to print', () => {
  it('a tax document whose issuer TRN is the Y1-trn placeholder', () => {
    const stored: StoredDocument = { ...STORED, issuerTrn: PLACEHOLDER_TRN }
    expect(() => buildTaxDocument(stored, { form: 'tax_invoice' })).toThrow(TrnNotConfigured)
    expect(() =>
      buildTaxDocument(
        { ...anonymous, issuerTrn: PLACEHOLDER_TRN },
        { form: 'simplified_invoice' },
      ),
    ).toThrow(TrnNotConfigured)
    // The control: the receipt states no TRN, so the same row renders.
    expect(() => buildTaxDocument(stored, { form: 'receipt' })).not.toThrow()
  })

  it('a document whose issuer name or address is a placeholder', () => {
    expect(() =>
      buildTaxDocument({ ...STORED, issuerLegalName: 'TBC' }, { form: 'tax_invoice' }),
    ).toThrow(/IssuerNotConfigured.*legal name/s)
    expect(() =>
      buildTaxDocument({ ...STORED, issuerAddressSnapshot: '   ' }, { form: 'tax_invoice' }),
    ).toThrow(/IssuerNotConfigured.*address/s)
    // A receipt is refused too: a document that cannot say who supplied the service is no document.
    expect(() =>
      buildTaxDocument({ ...STORED, issuerLegalName: '[CONFIRM]' }, { form: 'receipt' }),
    ).toThrow(/IssuerNotConfigured/)
  })

  it('a currency that is not AED, and a document with no lines', () => {
    expect(() => buildTaxDocument({ ...STORED, currency: 'USD' }, { form: 'tax_invoice' })).toThrow(
      /states AED/,
    )
    expect(() => buildTaxDocument({ ...STORED, lines: [] }, { form: 'tax_invoice' })).toThrow(
      /has no lines/,
    )
  })

  it('a header whose totals disagree with its own lines — each of the four ways', () => {
    const cases: readonly [Partial<StoredDocument>, RegExp][] = [
      [{ netTotalFils: 19, grossTotalFils: 21 }, /net_total 19 against lines summing to 20/],
      [{ vatTotalFils: 1, grossTotalFils: 21 }, /vat_total 1 against lines summing to 2/],
      [{ grossTotalFils: 23, vatTotalFils: 3 }, /gross_total 23 against lines summing to 22/],
      [{ netTotalFils: 21 }, /net_total 21 \+ vat_total 2 is not gross_total 22/],
    ]
    for (const [patch, message] of cases) {
      expect(() => buildTaxDocument({ ...STORED, ...patch }, { form: 'tax_invoice' })).toThrow(
        message,
      )
      expect(() => buildTaxDocument({ ...STORED, ...patch }, { form: 'tax_invoice' })).toThrow(
        /DocumentFiguresDisagree/,
      )
    }
    // The control: the untouched document passes the same check.
    expect(() => buildTaxDocument(STORED, { form: 'tax_invoice' })).not.toThrow()
  })

  it('a stored kind printed as the other kind', () => {
    expect(() => buildTaxDocument(anonymous, { form: 'tax_invoice' })).toThrow(
      /DocumentKindMismatch/,
    )
    expect(() => buildTaxDocument(STORED, { form: 'simplified_invoice' })).toThrow(
      /DocumentKindMismatch/,
    )
    // A receipt may be raised against any stored document: it is an acknowledgement of payment, not a
    // second copy of the tax document.
    expect(() => buildTaxDocument(anonymous, { form: 'receipt' })).not.toThrow()
  })

  it('a form the rule would not have chosen for those figures', () => {
    // A simplified invoice above the threshold. The rule says no compliant form exists without a
    // customer, and rendering re-applies it — which is what makes the rule unoverridable from a screen.
    const above = SIMPLIFIED_INVOICE_THRESHOLD.fils + 100
    const stored: StoredDocument = {
      ...anonymous,
      netTotalFils: above - 100,
      vatTotalFils: 100,
      grossTotalFils: above,
      lines: [
        {
          ...(anonymous.lines[0] as (typeof anonymous.lines)[number]),
          unitGrossFils: above,
          lineGrossFils: above,
          netFils: above - 100,
          vatFils: 100,
        },
      ],
    }
    expect(() => buildTaxDocument(stored, { form: 'simplified_invoice' })).toThrow(
      /CustomerDetailsRequired/,
    )

    // And the shape where a form IS permitted but not the one stored: a named customer below the
    // threshold must be given the full form, so the simplified one is refused.
    const named: StoredDocument = {
      ...anonymous,
      customerId: '22222222-2222-2222-2222-222222222222',
    }
    expect(() => buildTaxDocument(named, { form: 'simplified_invoice' })).toThrow(
      /DocumentFormNotPermitted.*requires tax_invoice/s,
    )
  })
})
