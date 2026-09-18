/**
 * The invoice used for the committed fixture and every rendering assertion.
 *
 * Real business data from docs/13 — legal entity, address, real services at real prices — because a
 * fixture built from `Lorem ipsum` and `Foo Service` proves nothing about column widths, and the
 * Arabic service names are the strings whose shaping actually has to work. The TRN is a placeholder
 * of the correct shape: the real one is an open item (docs/13 §1, `[CONFIRM]`), and a placeholder of
 * the right length is what keeps the layout honest until it arrives.
 *
 * The customer is invented. The customer name deliberately includes a bidi override, so the fixture
 * itself demonstrates that a hostile name cannot reorder the document.
 */
import { aed, localDate, splitGross, UAE_STANDARD_VAT_BP } from '@berelax/core'
import type { TaxInvoice } from '../documents/invoice.ts'

/** A placeholder of the correct shape: a UAE TRN is 15 digits. */
export const PLACEHOLDER_TRN = '100123456700003'

export const SUPPLIER_PHONE = '+971 52 823 9069'

/**
 * The attack specimen embedded in the customer's name.
 *
 * U+202E reverses everything that follows it for the rest of the paragraph. In a document that
 * states an amount, that is enough to make the printed total differ from the stored one.
 */
export const HOSTILE_NAME = 'Ahmed Al Mansoori\u202e'

const GROSS_TOTAL = aed(950)

export const SAMPLE_INVOICE: TaxInvoice = {
  number: 'INV-2026-000123',
  issuedOn: localDate('2026-09-18'),
  suppliedOn: localDate('2026-09-17'),
  supplier: {
    name: 'BE RELAX SPA - L.L.C - O.P.C',
    nameAr: 'بي ريلاكس سبا - ذ.م.م - شخص واحد',
    addressLines: [
      '250 Al Meena Street, Tower Block A/B, M-Floor',
      'Al Zahiyah, E14, Abu Dhabi, UAE',
    ],
    addressLinesAr: [
      '250 شارع الميناء، برج A/B، الطابق الميزانين',
      'الزاهية، أبوظبي، الإمارات العربية المتحدة',
    ],
    trn: PLACEHOLDER_TRN,
    phone: SUPPLIER_PHONE,
  },
  customer: {
    name: HOSTILE_NAME,
    nameAr: 'أحمد المنصوري',
    addressLines: ['Al Zahiyah, Abu Dhabi'],
    addressLinesAr: ['الزاهية، أبوظبي'],
    phone: '+971 56 342 9399',
  },
  lines: [
    {
      descriptionEn: 'Arabic Hot Oil / Balm Massage — 90 minutes',
      descriptionAr: 'مساج الزيت الساخن العربي — 90 دقيقة',
      quantity: 1,
      unitGross: aed(400),
      lineGross: aed(400),
      vatRateBp: UAE_STANDARD_VAT_BP,
    },
    {
      descriptionEn: 'Asian Morocco Bath or Jacuzzi — 90 minutes',
      descriptionAr: 'الحمام المغربي أو الجاكوزي الآسيوي — 90 دقيقة',
      quantity: 1,
      unitGross: aed(440),
      lineGross: aed(440),
      vatRateBp: UAE_STANDARD_VAT_BP,
    },
    {
      descriptionEn: 'Asian Normal Massage — 45 minutes',
      descriptionAr: 'المساج الآسيوي العادي — 45 دقيقة',
      quantity: 1,
      unitGross: aed(170),
      lineGross: aed(110),
      vatRateBp: UAE_STANDARD_VAT_BP,
    },
  ],
  totals: splitGross(GROSS_TOTAL),
  notes: 'Thank you. Prices are VAT-inclusive; no cash refunds after treatment.',
  notesAr: 'شكراً لكم. الأسعار تشمل الضريبة، ولا يوجد استرداد نقدي بعد الجلسة.',
}
