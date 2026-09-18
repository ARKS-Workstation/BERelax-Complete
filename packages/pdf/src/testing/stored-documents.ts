/**
 * The stored documents the committed fixtures are rendered from, and the probes the itest needs.
 *
 * Each one is a {@link StoredDocument} — the shape `readInvoice` in `@berelax/db` returns — written out
 * as data rather than fetched, for two reasons. The fixture script has no database, and a committed
 * fixture whose input came from a query is a fixture nobody can reproduce. That the shape really is the
 * one the repository returns is not assumed: `packages/fixtures/src/tax-document.itest.ts` assigns a
 * genuine `IssuedInvoice` to this type and renders that too, in the one package allowed to see both.
 *
 * The figures are the real ones. Every per-line net and VAT here is what `splitGross` produces for that
 * line's own gross — computed once, written down, and *never recomputed at render time*, which is the
 * point: if the renderer derived anything, these columns would be redundant and the eleven-fils probe
 * below would not be able to catch it.
 *
 * Prices and Arabic service names come from docs/13 §4, so the column widths are exercised by the
 * strings the business actually prints.
 */

import type { ArabicFallbacks, StoredDocument } from '@berelax/core'
import { PLACEHOLDER_TRN } from '@berelax/core'
import { HOSTILE_NAME, PLACEHOLDER_TRN as SHAPED_TRN } from './sample-invoice.ts'

/**
 * A fifteen-digit TRN, for the documents that need a configured issuer to exist at all.
 *
 * The real one is unknown (OPEN-QUESTIONS Y1-trn) and the seeded value is refused by the schema and by
 * `requireIssuerTrn`, so a fixture proving a tax invoice *can* be laid out needs a value of the right
 * shape. This is the one already carried by `sample-invoice.ts` for the F10 proof rather than a second
 * invented number, and it reaches nothing but a fixture: only `legal_entity.trn` reaches a real
 * document, and until an owner sets it, it holds {@link PLACEHOLDER_TRN}.
 */
export { PLACEHOLDER_TRN as SHAPED_FIXTURE_TRN } from './sample-invoice.ts'

/** The real issuer, from docs/13 §1 and §2 and the row `0026_invoice.sql` seeds. */
const ISSUER = {
  issuerLegalName: 'BE RELAX SPA - L.L.C - O.P.C',
  issuerTradingName: 'BE RELAX - Massage Center and Spa',
  issuerAddressSnapshot: [
    '250 Al Meena Street',
    'Tower Block A/B, M-Floor',
    'Al Zahiyah (Al Mina), E14',
    'Abu Dhabi',
  ].join('\n'),
  issuerEmirate: 'Abu Dhabi',
  issuerPhone: '+971 56 342 9399',
  issuerLicenceNumber: null,
  // Null, both of them, because `legal_entity` and `premises` carry no Arabic columns to snapshot from
  // (the NOTE on M-TILL-04). Every document issued today has these null, so the fixtures have them null
  // too and the Arabic side of the page comes from the caller's fallbacks — which is the state B-CAT-06
  // ends.
  issuerLegalNameAr: null,
  issuerAddressSnapshotAr: null,
} as const

/**
 * The Arabic a caller supplies, because the source tables cannot.
 *
 * Keyed by the English service name rather than by line number. A line number is a position on one
 * document and a translation is a property of the *service*, so keying by position gives the wrong
 * Arabic the first time two documents list the same treatments in a different order — which is exactly
 * what the simplified fixture below does.
 */
const SERVICE_ARABIC: Readonly<Record<string, string>> = {
  'Arabic Hot Oil / Balm Massage — 90 minutes': 'مساج الزيت الساخن العربي — 90 دقيقة',
  'Asian Normal Massage — 45 minutes': 'المساج الآسيوي العادي — 45 دقيقة',
  'Asian Morocco Bath or Jacuzzi — 90 minutes': 'الحمام المغربي أو الجاكوزي الآسيوي — 90 دقيقة',
  'Gift voucher, zero-rated': 'قسيمة هدية، معفاة من الضريبة',
  'Rounding probe, line 1': 'اختبار التدوير، السطر 1',
  'Rounding probe, line 2': 'اختبار التدوير، السطر 2',
}

const ISSUER_ARABIC = {
  issuerLegalName: 'بي ريلاكس سبا - ذ.م.م - شخص واحد',
  issuerAddressLines: ['250 شارع الميناء', 'برج A/B، الطابق الميزانين', 'الزاهية، E14', 'أبوظبي'],
  customerName: 'أحمد المنصوري',
  customerAddressLines: ['الزاهية، أبوظبي'],
  notes: 'شكراً لكم. الأسعار تشمل الضريبة، ولا يوجد استرداد نقدي بعد الجلسة.',
} as const

/** The Arabic fallbacks for one stored document, with each line's translation on its own line number. */
export function arabicFallbacksFor(stored: StoredDocument): ArabicFallbacks {
  const lineDescriptions: Record<number, string> = {}
  for (const line of stored.lines) {
    const translated = SERVICE_ARABIC[line.descriptionEn]
    if (translated !== undefined) lineDescriptions[line.lineNo] = translated
  }
  return { ...ISSUER_ARABIC, lineDescriptions }
}

const HOT_OIL_90 = {
  lineNo: 1,
  descriptionEn: 'Arabic Hot Oil / Balm Massage — 90 minutes',
  descriptionAr: null,
  quantity: 1,
  unitGrossFils: 40_000,
  lineGrossFils: 40_000,
  vatRateBp: 500,
  netFils: 38_095,
  vatFils: 1_905,
} as const

const NORMAL_45 = {
  lineNo: 2,
  descriptionEn: 'Asian Normal Massage — 45 minutes',
  descriptionAr: null,
  quantity: 1,
  unitGrossFils: 17_000,
  lineGrossFils: 17_000,
  vatRateBp: 500,
  netFils: 16_190,
  vatFils: 810,
} as const

const MOROCCO_90 = {
  lineNo: 3,
  descriptionEn: 'Asian Morocco Bath or Jacuzzi — 90 minutes',
  descriptionAr: null,
  quantity: 1,
  unitGrossFils: 44_000,
  lineGrossFils: 44_000,
  vatRateBp: 500,
  netFils: 41_905,
  vatFils: 2_095,
} as const

const COMMON = {
  seriesCode: 'TAX-INV',
  periodKey: '2026',
  issueDate: '2026-09-19',
  // Not the issue date. A 01:30 treatment belongs to the previous trading date, and the invoice was
  // written at noon the next day — which is the pair `resolveTaxPoint` returns and the pair
  // `invoice-document.itest.ts` stores.
  taxPointDate: '2026-09-18',
  currency: 'AED',
  customerId: null,
  customerTrn: null,
  customerAddressSnapshot: null,
  customerPhone: null,
  notes: 'Thank you. Prices are VAT-inclusive; no cash refunds after treatment.',
  ...ISSUER,
} as const

/**
 * The receipt, and the only form of these three the business can issue **today**.
 *
 * `documentKind` is `receipt`, which is not one of the two values `invoice.document_kind` admits — and
 * that is the honest spelling, because a receipt has no row in that table at all (`RECEIPT_SOURCE`).
 * The issuer's TRN is the Y1-trn placeholder, exactly as `legal_entity` holds it, and the document
 * renders anyway: a receipt states no TRN, so nothing provisional reaches the page.
 */
export const RECEIPT_DOCUMENT: StoredDocument = {
  ...COMMON,
  documentKind: 'receipt',
  displayNumber: 'RC-2026-00042',
  issuerTrn: PLACEHOLDER_TRN,
  customerNameSnapshot: 'Customer 0042',
  netTotalFils: 54_285,
  vatTotalFils: 2_715,
  grossTotalFils: 57_000,
  lines: [HOT_OIL_90, NORMAL_45],
}

/**
 * The simplified tax invoice: below the threshold, no customer of record, so no customer block.
 *
 * Needs a configured TRN and therefore cannot be issued from the real business profile until Y1-trn is
 * answered — the layout is proved with {@link SHAPED_FIXTURE_TRN} in its place.
 */
export const SIMPLIFIED_INVOICE_DOCUMENT: StoredDocument = {
  ...COMMON,
  documentKind: 'simplified_invoice',
  displayNumber: 'SI-2026-00017',
  seriesCode: 'SIMPL-INV',
  issuerTrn: SHAPED_TRN,
  customerNameSnapshot: 'Customer 0042',
  netTotalFils: 58_095,
  vatTotalFils: 2_905,
  grossTotalFils: 61_000,
  lines: [
    { ...MOROCCO_90, lineNo: 1 },
    { ...NORMAL_45, lineNo: 2 },
  ],
}

/**
 * The full tax invoice: a customer of record, so the rule requires the full form.
 *
 * The customer's name carries U+202E, a right-to-left override, which reverses everything after it for
 * the rest of the paragraph. On a document that states an amount that is enough to make the printed
 * total differ from the stored one, so the fixture itself is the proof that `safeText` strips it.
 */
export const TAX_INVOICE_DOCUMENT: StoredDocument = {
  ...COMMON,
  documentKind: 'tax_invoice',
  displayNumber: 'TI-2026-00001',
  issuerTrn: SHAPED_TRN,
  customerId: '11111111-1111-1111-1111-111111111111',
  customerNameSnapshot: HOSTILE_NAME,
  customerAddressSnapshot: 'Al Zahiyah, Abu Dhabi',
  customerPhone: '+971 52 823 9069',
  netTotalFils: 96_190,
  vatTotalFils: 4_810,
  grossTotalFils: 101_000,
  lines: [HOT_OIL_90, NORMAL_45, MOROCCO_90],
}

/**
 * Two lines at 11 fils gross. The document that catches a renderer which re-derives.
 *
 * Per line the VAT is 1 fils — `11 - round(11 * 20 / 21) = 1` — so the document's VAT is **2**. Split
 * the 22-fils total instead and the answer is **1**. The itest asserts the totals block prints AED 0.02
 * and that AED 0.01 appears only on the lines, where it belongs.
 */
export const ELEVEN_FILS_DOCUMENT: StoredDocument = {
  ...COMMON,
  // The FULL form, and it has to be: the simplified form states no per-line VAT, so the one figure this
  // document exists to prove would not be printed on it. A customer of record is what makes the rule
  // choose the full form for a 22-fils sale.
  documentKind: 'tax_invoice',
  displayNumber: 'TI-2026-00011',
  customerId: '33333333-3333-3333-3333-333333333333',
  issuerTrn: SHAPED_TRN,
  customerNameSnapshot: 'Customer 0011',
  netTotalFils: 20,
  vatTotalFils: 2,
  grossTotalFils: 22,
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

/**
 * One standard-rated line beside a zero-rated one.
 *
 * `VatBreakdown` carries a single `rateBp` and cannot express this document, which is why the totals
 * block takes per-rate subtotals and why the inclusive-pricing footnote disappears rather than naming
 * one of the two rates.
 */
export const MIXED_RATE_DOCUMENT: StoredDocument = {
  ...COMMON,
  documentKind: 'simplified_invoice',
  displayNumber: 'SI-2026-00023',
  seriesCode: 'SIMPL-INV',
  issuerTrn: SHAPED_TRN,
  customerNameSnapshot: 'Customer 0042',
  netTotalFils: 48_095,
  vatTotalFils: 1_905,
  grossTotalFils: 50_000,
  lines: [
    HOT_OIL_90,
    {
      lineNo: 2,
      descriptionEn: 'Gift voucher, zero-rated',
      descriptionAr: null,
      quantity: 1,
      unitGrossFils: 10_000,
      lineGrossFils: 10_000,
      vatRateBp: 0,
      netFils: 10_000,
      vatFils: 0,
    },
  ],
}

/**
 * The padding probe: the longest description and the largest figures the layout has to take.
 *
 * A previous document overflowed its right margin, and the cause is always this shape — a description
 * long enough to push the amount column past the print margin. Quantity 3 also exercises the rule that
 * per-line tax is rounded on the LINE gross, not per unit.
 */
export const OVERFLOW_PROBE_DOCUMENT: StoredDocument = {
  ...COMMON,
  documentKind: 'tax_invoice',
  displayNumber: 'TI-2026-00099',
  issuerTrn: SHAPED_TRN,
  customerId: '22222222-2222-2222-2222-222222222222',
  customerNameSnapshot: 'Customer 0099',
  customerAddressSnapshot: 'Tower Block A/B, M-Floor, 250 Al Meena Street, Al Zahiyah, Abu Dhabi',
  netTotalFils: 952_286,
  vatTotalFils: 47_614,
  grossTotalFils: 999_900,
  lines: [
    {
      lineNo: 1,
      descriptionEn:
        'Arabic Morocco Bath or Jacuzzi with Hot Oil and Balm Massage, 120 minutes, private ' +
        'wet-room with temperature control, complimentary herbal tea and shower, package of three',
      descriptionAr: null,
      quantity: 3,
      unitGrossFils: 333_300,
      lineGrossFils: 999_900,
      vatRateBp: 500,
      netFils: 952_286,
      vatFils: 47_614,
    },
  ],
}

/** Every document that has a committed PDF and PNG, with the form each is rendered as. */
export const COMMITTED_DOCUMENTS = [
  { name: 'tax-invoice', form: 'tax_invoice', stored: TAX_INVOICE_DOCUMENT },
  { name: 'simplified-invoice', form: 'simplified_invoice', stored: SIMPLIFIED_INVOICE_DOCUMENT },
  { name: 'receipt', form: 'receipt', stored: RECEIPT_DOCUMENT },
] as const
