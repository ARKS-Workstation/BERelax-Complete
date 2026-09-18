/**
 * The three forms a customer is handed, in either language, on one template.
 *
 * `tax-invoice`, `simplified-invoice` and `receipt`, rendered from a {@link TaxDocumentView} that
 * `@berelax/core` built out of stored columns. This module decides *layout and wording* and nothing
 * else: it performs no arithmetic on money, so there is no path from a template edit to a figure that
 * disagrees with the database. The per-form column set is read from core's field table rather than
 * written here twice, so "a receipt states no VAT" is one fact, not one fact and one stylesheet.
 *
 * ## Locale is a direction, not a translation
 *
 * Every form is bilingual — the Arabic-language requirement (docs/04 §4) is not satisfied by an
 * Arabic-only variant — but one language has to lead, and which one changes the document's *shape*:
 *
 *   - `<html dir>` is `rtl` for `ar`, so the whole page mirrors;
 *   - every horizontal offset is a logical property (`margin-inline-start`, `text-align: start|end`,
 *     `padding-inline`), never `left`/`right`, so mirroring is the browser's job and cannot be half
 *     done. The totals block and the amount column change side, which is the assertion in
 *     `tax-document.itest.ts` — a mirrored document is not one whose text has been translated;
 *   - the secondary language carries its own `dir` and `lang` on every element, so an Arabic run inside
 *     an English document is still shaped and ordered as Arabic, and vice versa.
 *
 * Nothing here uses a direction mark. RTL comes from `dir`, and a Latin run inside Arabic is isolated
 * with `<bdi>` from `@berelax/core` — the markup spelling, which survives into the PDF as ordering
 * rather than as stray control characters a reader would copy out (ADR 0011).
 *
 * ## Numerals, currency and dates, each a decision
 *
 * **Latin numerals in both scripts** (`formatMoney`, docs/08 §7, UAE commercial practice), which is
 * precisely why every figure is isolated at the point of use: a Latin run in an Arabic line reorders
 * without one, and `بنسبة 5%` renders as `%5`.
 *
 * **`AED` before the figure as one isolated run, never `د.إ.`** ADR 0011 records the measurement:
 * `Intl.NumberFormat('ar-AE', { style: 'currency' })` wraps the Arabic abbreviation in U+200F marks to
 * hold it in place, `safeText` strips every bidi control because it cannot tell ICU's marks from an
 * attacker's, and the two remaining letters then reorder inside the isolate — so the document would
 * print the currency backwards. One notation per document is the second reason. In the table the code
 * moves into the column header, because seven columns each carrying `AED` do not fit across A4 and the
 * currency stated once per column is how a printed invoice does it anyway.
 *
 * **Dates as ISO `2026-09-18`,** isolated, in both locales. `18/09/2026` and `09/18/2026` are the same
 * eleven characters and a different date, and a tax point is the one field on the page where a reader
 * must not have to guess which convention was used.
 *
 * ## Arabic weight
 *
 * The Arabic cuts embedded in a PDF are 400 and 600 (`fonts.ts`). Arabic body copy is therefore
 * declared at **400**, not 500: with only 400 and 600 shipped, CSS weight matching resolves a request
 * for 500 *downwards* to 400 — recorded in `apps/web/app/_fonts/index.ts`, where the same mistake made
 * a deliberate recalibration silently do nothing. The compensation for Arabic reading lighter than
 * Latin is made with size (`1.06em`) and line height, which are the levers that do work with the faces
 * this document actually carries. `scripts/check-tax-documents.mjs` fails the build on a weight the
 * Arabic face does not ship.
 */
import {
  bdi,
  type DocumentForm,
  type DocumentLine,
  type DocumentParty,
  formatAmount,
  formatMoney,
  formStates,
  type Money,
  safeText,
  type TaxDocumentView,
  type VatRateBp,
} from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { FONT_STACK, fontFaceCss } from '../fonts.ts'

/**
 * Both locales, as a list.
 *
 * A caller that has to render, review or measure "every locale" reads this rather than writing the two
 * strings out: the fixture script, the geometry measurement and the itest all iterate it, so adding a
 * third language is one edit and six more documents rather than a hunt for the places that said two.
 */
export const DOCUMENT_LOCALES = ['en', 'ar'] as const

/** The primary language of a document. Both languages appear on every form; this one leads. */
export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number]

/** A label in both scripts. */
interface Label {
  readonly en: string
  readonly ar: string
}

/**
 * Every string on the page, in both languages, in one object.
 *
 * Exported so a test asserts against the same strings the document renders rather than against its own
 * transcription of them — a test carrying its own copy of a label passes while the document says
 * something else.
 */
export const DOCUMENT_LABELS = {
  taxInvoice: { en: 'Tax Invoice', ar: 'فاتورة ضريبية' },
  simplifiedInvoice: { en: 'Simplified Tax Invoice', ar: 'فاتورة ضريبية مبسطة' },
  receipt: { en: 'Receipt', ar: 'إيصال' },
  documentNumber: { en: 'Document number', ar: 'رقم المستند' },
  issuedOn: { en: 'Date of issue', ar: 'تاريخ الإصدار' },
  suppliedOn: { en: 'Date of supply', ar: 'تاريخ التوريد' },
  supplier: { en: 'Supplier', ar: 'المورّد' },
  customer: { en: 'Customer', ar: 'العميل' },
  trn: { en: 'TRN', ar: 'الرقم الضريبي' },
  phone: { en: 'Phone', ar: 'هاتف' },
  emirate: { en: 'Emirate', ar: 'الإمارة' },
  description: { en: 'Description', ar: 'الوصف' },
  quantity: { en: 'Qty', ar: 'الكمية' },
  unitPrice: { en: 'Unit price', ar: 'سعر الوحدة' },
  lineNet: { en: 'Excl. VAT', ar: 'بدون ضريبة' },
  vatRate: { en: 'VAT rate', ar: 'نسبة الضريبة' },
  lineVat: { en: 'VAT', ar: 'الضريبة' },
  lineAmount: { en: 'Amount', ar: 'المبلغ' },
  netTotal: { en: 'Total excluding VAT', ar: 'المجموع بدون ضريبة' },
  vatTotal: { en: 'VAT', ar: 'ضريبة القيمة المضافة' },
  grossTotal: { en: 'Total payable', ar: 'المجموع المستحق' },
  totalPaid: { en: 'Total paid', ar: 'المبلغ المدفوع' },
  atRate: { en: 'VAT at {rate}', ar: 'الضريبة بنسبة {rate}' },
  series: { en: 'Series', ar: 'السلسلة' },
  period: { en: 'Period', ar: 'الفترة' },
  inclusive: {
    en: 'All prices are inclusive of {rate} VAT.',
    ar: 'جميع الأسعار تشمل ضريبة القيمة المضافة بنسبة {rate}.',
  },
  /**
   * The sentence that keeps a receipt from reading as a tax invoice.
   *
   * A receipt states no TRN and no VAT, and a reader who does not know that a document with neither is
   * not a tax invoice is exactly the reader this line is for. It is also the line that stops the short
   * form being filed as though it discharged the obligation to issue one.
   */
  notATaxInvoice: {
    en: 'This is a receipt for payment. It is not a tax invoice.',
    ar: 'هذا إيصال بالدفع وليس فاتورة ضريبية.',
  },
  settlement: {
    en: 'The amount payable on invoice {number} is {amount}. For queries call {phone}.',
    ar: 'المبلغ المستحق على الفاتورة رقم {number} هو {amount}. للاستفسار اتصل على {phone}.',
  },
  paid: {
    en: 'Payment of {amount} received with thanks against receipt {number}. For queries call {phone}.',
    ar: 'تم استلام مبلغ {amount} مع الشكر بموجب الإيصال رقم {number}. للاستفسار اتصل على {phone}.',
  },
} satisfies Record<string, Label>

/** The title each form carries. The words that identify the document are a mandatory field. */
const TITLES: Record<DocumentForm, Label> = {
  tax_invoice: DOCUMENT_LABELS.taxInvoice,
  simplified_invoice: DOCUMENT_LABELS.simplifiedInvoice,
  receipt: DOCUMENT_LABELS.receipt,
}

/** The currency code, stated once per numeric column. Isolated wherever it appears. */
const CURRENCY_CODE = 'AED'

/**
 * The numeric columns, in printing order, each tied to the core field that decides whether it appears.
 *
 * Width is a percentage of the table, and the description column takes whatever is left — which is how
 * the receipt's two columns give the description four fifths of the page while the tax invoice's six
 * leave it a third, from one table rather than three stylesheets.
 */
const NUMERIC_COLUMNS = [
  {
    field: 'lineQuantity',
    label: DOCUMENT_LABELS.quantity,
    width: 6,
    value: (line: DocumentLine) => String(line.quantity),
  },
  {
    field: 'lineUnitGross',
    label: DOCUMENT_LABELS.unitPrice,
    width: 12,
    value: (line: DocumentLine) => formatAmount(line.unitGross),
  },
  {
    field: 'lineNet',
    label: DOCUMENT_LABELS.lineNet,
    width: 12,
    value: (line: DocumentLine) => formatAmount(line.net),
  },
  {
    field: 'lineVatRate',
    label: DOCUMENT_LABELS.vatRate,
    width: 11,
    value: (line: DocumentLine) => ratePercent(line.rateBp),
  },
  {
    field: 'lineVat',
    label: DOCUMENT_LABELS.lineVat,
    width: 11,
    value: (line: DocumentLine) => formatAmount(line.vat),
  },
  {
    field: 'lineGross',
    label: DOCUMENT_LABELS.lineAmount,
    width: 14,
    value: (line: DocumentLine) => formatAmount(line.gross),
  },
] as const

/** A rate in basis points as a percentage. Isolated by every caller; see the note on numerals. */
function ratePercent(rateBp: VatRateBp): string {
  const percent = rateBp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

const other = (locale: DocumentLocale): DocumentLocale => (locale === 'ar' ? 'en' : 'ar')
const dirOf = (locale: DocumentLocale): 'ltr' | 'rtl' => (locale === 'ar' ? 'rtl' : 'ltr')

/**
 * A bilingual pair: the primary language, then the secondary beneath it in its own direction.
 *
 * `dir` and `lang` are on the secondary span unconditionally, including when the secondary language is
 * English inside an Arabic document. Leaving them off on the English side is the asymmetry that
 * an RTL document lay a Latin address block out right to left: correct per UAX #9, and not what an
 * address is.
 */
function pair(label: Label, locale: DocumentLocale, className = ''): string {
  const secondary = other(locale)
  const classes = className === '' ? '' : ` ${className}`
  return [
    `<span class="primary lang-${locale}${classes}" dir="${dirOf(locale)}" lang="${locale}">`,
    safeText(label[locale]),
    '</span>',
    `<span class="secondary lang-${secondary}${classes}" dir="${dirOf(secondary)}" lang="${secondary}">`,
    safeText(label[secondary]),
    '</span>',
  ].join('')
}

/**
 * Fills a bilingual template, isolating each interpolated run.
 *
 * The template is escaped once and the already-escaped, already-isolated `<bdi>` markup is spliced into
 * it, which is why the values are inserted after the escape rather than before: escaping the markup
 * would print the tags.
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  let out = safeText(template)
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(bdi(value, 'ltr'))
  }
  return out
}

/** A figure, isolated, so it keeps its internal order whichever direction the line runs. */
const figure = (text: string): string => `<span class="figure">${bdi(text, 'ltr')}</span>`

/** A bilingual label with one left-to-right value: a TRN, a phone number, an emirate. */
function labelledValue(label: Label, locale: DocumentLocale, value: string): string {
  return ['<div class="labelled">', pair(label, locale), figure(value), '</div>'].join('')
}

function metaField(label: Label, locale: DocumentLocale, value: string): string {
  return [
    '<div class="meta-field">',
    pair(label, locale, 'meta-label'),
    figure(value),
    '</div>',
  ].join('')
}

function partyBlock(
  label: Label,
  locale: DocumentLocale,
  party: DocumentParty,
  showTrn: boolean,
): string {
  const secondary = other(locale)
  const names: Record<DocumentLocale, string> = {
    en: party.name,
    ar: party.nameAr ?? party.name,
  }
  const addresses: Record<DocumentLocale, readonly string[]> = {
    en: party.addressLines,
    ar: party.addressLinesAr.length > 0 ? party.addressLinesAr : party.addressLines,
  }
  const block = (which: DocumentLocale, role: 'primary' | 'secondary'): string =>
    [
      `<div class="${role} lang-${which}" dir="${dirOf(which)}" lang="${which}">`,
      `<strong>${safeText(names[which])}</strong>`,
      addresses[which].map((line) => `<div>${safeText(line)}</div>`).join(''),
      '</div>',
    ].join('')
  // One TRN and one phone number for the pair, not one per language. Printing each twice — which an
  // earlier bilingual draft did — gives every document two copies of the same digits for a reader to
  // check against each other.
  const trn =
    showTrn && party.trn !== undefined ? labelledValue(DOCUMENT_LABELS.trn, locale, party.trn) : ''
  const phone =
    party.phone === undefined ? '' : labelledValue(DOCUMENT_LABELS.phone, locale, party.phone)
  return [
    '<section class="party">',
    `<h2>${pair(label, locale, 'party-label')}</h2>`,
    '<div class="party-body">',
    block(locale, 'primary'),
    block(secondary, 'secondary'),
    '</div>',
    trn,
    phone,
    // The emirate, on the issuer block only. It is a column of its own on the stored document and the
    // licensing authority follows from it (ADDED and Abu Dhabi Municipality, docs/04 §1), so it is
    // stated rather than left to be read off the end of the address — which is the same string only for
    // as long as the premises stays in the emirate it trades in.
    party.emirate === undefined
      ? ''
      : labelledValue(DOCUMENT_LABELS.emirate, locale, party.emirate),
    '</section>',
  ].join('')
}

function linesTable(doc: TaxDocumentView, locale: DocumentLocale): string {
  const columns = NUMERIC_COLUMNS.filter((column) => formStates(doc.form, column.field))
  const numericWidth = columns.reduce((total, column) => total + column.width, 0)
  const cols = [
    `<col style="width:${100 - numericWidth}%">`,
    ...columns.map((column) => `<col style="width:${column.width}%">`),
  ].join('')
  const header = [
    `<th class="align-start description">${pair(DOCUMENT_LABELS.description, locale, 'column-label')}</th>`,
    ...columns.map(
      (column) =>
        `<th class="align-end">${pair(column.label, locale, 'column-label')}${
          // The currency, once per money column. `Qty` and `VAT rate` are not money.
          column.field === 'lineQuantity' || column.field === 'lineVatRate'
            ? ''
            : `<span class="unit">${bdi(`(${CURRENCY_CODE})`, 'ltr')}</span>`
        }</th>`,
    ),
  ].join('')
  const rows = doc.lines
    .map((line) => {
      const secondary = other(locale)
      const descriptions: Record<DocumentLocale, string | undefined> = {
        en: line.descriptionEn,
        ar: line.descriptionAr,
      }
      const describe = (which: DocumentLocale, role: 'primary' | 'secondary'): string => {
        const text = descriptions[which]
        if (text === undefined) return ''
        return `<div class="${role} lang-${which}" dir="${dirOf(which)}" lang="${which}">${safeText(text)}</div>`
      }
      return [
        '<tr>',
        '<td class="align-start description">',
        describe(locale, 'primary'),
        describe(secondary, 'secondary'),
        '</td>',
        ...columns.map((column) => `<td class="align-end">${figure(column.value(line))}</td>`),
        '</tr>',
      ].join('')
    })
    .join('')
  return `<table class="lines"><colgroup>${cols}</colgroup><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`
}

function totalRow(label: Label, locale: DocumentLocale, amount: Money, emphasis = false): string {
  return [
    `<tr${emphasis ? ' class="emphasis"' : ''}>`,
    `<th class="align-start"><span class="label-pair">${pair(label, locale, 'total-label')}</span></th>`,
    `<td class="align-end">${figure(formatMoney(amount))}</td>`,
    '</tr>',
  ].join('')
}

/**
 * The totals block.
 *
 * A mixed-rate document gets one row per rate before the totals, because `VatBreakdown`'s single
 * `rateBp` cannot express a document carrying a zero-rated line beside a standard-rated one, and a
 * footnote naming one rate for such a document would be false. The subtotals are sums of stored
 * per-line figures; the three totals are the stored header columns.
 */
function totalsTable(doc: TaxDocumentView, locale: DocumentLocale): string {
  const rows: string[] = []
  if (formStates(doc.form, 'netTotal')) {
    rows.push(totalRow(DOCUMENT_LABELS.netTotal, locale, doc.totals.net))
  }
  if (formStates(doc.form, 'vatTotal')) {
    if (doc.totals.byRate.length > 1) {
      for (const subtotal of doc.totals.byRate) {
        const label: Label = {
          en: DOCUMENT_LABELS.atRate.en.replace('{rate}', ratePercent(subtotal.rateBp)),
          ar: DOCUMENT_LABELS.atRate.ar.replace('{rate}', ratePercent(subtotal.rateBp)),
        }
        rows.push(totalRow(label, locale, subtotal.vat))
      }
    }
    rows.push(totalRow(DOCUMENT_LABELS.vatTotal, locale, doc.totals.vat))
  }
  rows.push(
    totalRow(
      doc.form === 'receipt' ? DOCUMENT_LABELS.totalPaid : DOCUMENT_LABELS.grossTotal,
      locale,
      doc.totals.gross,
      true,
    ),
  )
  return `<table class="totals"><tbody>${rows.join('')}</tbody></table>`
}

/** The settlement sentence, in both languages, every run inside it isolated. */
function sentence(doc: TaxDocumentView, locale: DocumentLocale): string {
  const template = doc.form === 'receipt' ? DOCUMENT_LABELS.paid : DOCUMENT_LABELS.settlement
  const values = {
    number: doc.documentNumber,
    amount: formatMoney(doc.totals.gross),
    phone: doc.issuer.phone ?? '',
  }
  const secondary = other(locale)
  return [
    '<section class="sentence">',
    `<p class="primary lang-${locale}" dir="${dirOf(locale)}" lang="${locale}">`,
    fill(template[locale], values),
    '</p>',
    `<p class="secondary lang-${secondary}" dir="${dirOf(secondary)}" lang="${secondary}">`,
    fill(template[secondary], values),
    '</p>',
    '</section>',
  ].join('')
}

/** The footnote a form carries: the inclusive-pricing note, or the one saying this is not an invoice. */
function footnote(doc: TaxDocumentView, locale: DocumentLocale): string {
  if (formStates(doc.form, 'notATaxInvoice')) {
    return `<p class="footnote strong">${pair(DOCUMENT_LABELS.notATaxInvoice, locale)}</p>`
  }
  if (!formStates(doc.form, 'lineVatRate') && !formStates(doc.form, 'vatTotal')) return ''
  const rate = doc.singleRateBp
  if (rate === undefined) {
    // A mixed-rate document cannot claim one rate, and the per-rate subtotals in the totals block are
    // what state the rates instead. Saying nothing is correct; naming the first line's rate is not.
    return ''
  }
  const values = { rate: ratePercent(rate) }
  const secondary = other(locale)
  return [
    '<p class="footnote">',
    `<span class="primary lang-${locale}" dir="${dirOf(locale)}" lang="${locale}">`,
    fill(DOCUMENT_LABELS.inclusive[locale], values),
    '</span>',
    `<span class="secondary lang-${secondary}" dir="${dirOf(secondary)}" lang="${secondary}">`,
    fill(DOCUMENT_LABELS.inclusive[secondary], values),
    '</span>',
    '</p>',
  ].join('')
}

/**
 * The foot of the page: the operator's note, and which statutory series numbered the document.
 *
 * The series and its reset period are printed because they are two of the fields the Y11 superset
 * enumerates, and a document that states its number without stating the range that number came from
 * cannot be tied to a gap report by the person holding the paper. Small, and in the secondary ink.
 */
function documentFooter(doc: TaxDocumentView, locale: DocumentLocale): string {
  const parts: string[] = []
  if (doc.notes !== undefined || doc.notesAr !== undefined) {
    const notes: Record<DocumentLocale, string | undefined> = {
      en: doc.notes,
      ar: doc.notesAr,
    }
    const secondary = other(locale)
    const note = (which: DocumentLocale, role: 'primary' | 'secondary'): string =>
      notes[which] === undefined
        ? ''
        : `<div class="${role} lang-${which}" dir="${dirOf(which)}" lang="${which}">${safeText(notes[which] ?? '')}</div>`
    parts.push(`<div class="notes">${note(locale, 'primary')}${note(secondary, 'secondary')}</div>`)
  }
  if (formStates(doc.form, 'documentSeries')) {
    parts.push(
      [
        '<div class="series">',
        labelledValue(DOCUMENT_LABELS.series, locale, doc.seriesCode),
        labelledValue(DOCUMENT_LABELS.period, locale, doc.periodKey),
        '</div>',
      ].join(''),
    )
  }
  return parts.length === 0 ? '' : `<footer>${parts.join('')}</footer>`
}

function styles(locale: DocumentLocale): string {
  return `
${fontFaceCss()}
${tokensCss()}

@page { size: A4; }

/* A printed document is always light: paper has no dark mode, and a headless renderer's
   prefers-color-scheme follows whatever the container reports. */
:root {
  color-scheme: light;
  /*
   * The document's leading edge, as a physical value, computed once from the locale.
   *
   * text-align: start cannot express this, and neither does match-parent — measured, in Chromium, on
   * this template: a block carrying its own dir attribute resolves start against ITS OWN direction,
   * so in an English document the Arabic half of a party block flew to the right edge while the English
   * half sat at the left, and the two languages of one supplier read as two suppliers. The dir
   * attribute has to stay — it is what makes the shaper and the bidi algorithm treat each run as its
   * own language — so the alignment is the part that has to come from the document instead of from the
   * element. One declaration, one comment, and every block that pairs the two languages uses it.
   */
  --leading: ${locale === 'ar' ? 'right' : 'left'};
  --trailing: ${locale === 'ar' ? 'left' : 'right'};
}

* { box-sizing: border-box; }

html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

body {
  /* Zero, deliberately. The page margins are Chromium's, from A4_DOCUMENT in render.ts — 18mm at the
     sides and 20mm at the foot — so a body padding here would add to them invisibly and the document
     would print with margins nobody declared. Measured per form and per locale in the itest. */
  margin: 0;
  font-family: ${FONT_STACK};
  font-size: 9pt;
  line-height: 1.45;
  color: var(--color-ink);
}

/* Arabic reads optically smaller than Latin at the same point size, and is never tracked or
   uppercased. Weight 400 because 400 and 600 are the cuts fonts.ts embeds: a request for 500 resolves
   downwards to 400 and the declaration would be a lie. docs/08 §3 records the recalibration. */
[lang='ar'] {
  font-size: 1.06em;
  line-height: 1.6;
  letter-spacing: 0;
  text-transform: none;
  font-weight: 400;
}
[lang='ar'] strong { font-weight: 600; }

.secondary { color: var(--color-ink-2); }

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12pt;
  border-bottom: 1.5pt solid var(--color-ink);
  padding-bottom: 5pt;
  margin-bottom: 9pt;
}
header .who { min-width: 0; }
header .who .primary { font-size: 11pt; font-weight: 600; }
header .who .secondary { font-size: 10pt; }
header .what { flex: 0 0 auto; }
header .what .primary { font-size: 16pt; font-weight: 600; letter-spacing: 0.01em; display: block; }
header .what .secondary { font-size: 13pt; display: block; }

.meta { display: flex; gap: 16pt; margin-bottom: 9pt; }
.meta-field { flex: 1; min-width: 0; }
.meta-label { display: block; font-size: 7.5pt; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-ink-2); }
.meta-field .meta-label[lang='ar'] { text-transform: none; letter-spacing: 0; font-size: 8pt; }

.parties { display: flex; gap: 20pt; margin-bottom: 10pt; }
.party { flex: 1; min-width: 0; }
.party h2 { margin: 0 0 3pt; font-size: 7.5pt; display: flex; gap: 6pt; }
.party-label { text-transform: uppercase; letter-spacing: 0.07em; color: var(--color-ink-2); }
.party-label[lang='ar'] { text-transform: none; letter-spacing: 0; font-size: 8pt; }
/* Each language gets the full column width, stacked, rather than half of it side by side. The legal
   entity name wraps to three lines at half width and the address to four, on a document whose job is
   to be read at a glance. */
.party-body .primary { margin-bottom: 3pt; }
.labelled { display: flex; align-items: baseline; gap: 6pt; margin-top: 2pt; font-size: 7.5pt; }
.labelled .primary, .labelled .secondary { text-transform: uppercase; letter-spacing: 0.06em; }
.labelled .primary[lang='ar'], .labelled .secondary[lang='ar'] { text-transform: none; letter-spacing: 0; font-size: 8pt; }
.labelled .figure { color: var(--color-ink); font-size: 9pt; }

table { width: 100%; border-collapse: collapse; }
/* Fixed, so the declared column widths hold. Automatic layout lets a long treatment name push the
   amount column past the print margin, which is a document with no right-hand padding — and it is the
   one layout failure a reader notices before anything else. */
.lines { table-layout: fixed; }
.lines th { border-bottom: 1pt solid var(--color-ink); padding: 4pt 4pt; vertical-align: bottom; font-size: 7.5pt; }
.lines .column-label { display: block; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-ink-2); }
.lines .column-label[lang='ar'] { text-transform: none; letter-spacing: 0; font-size: 8pt; }
.lines .unit { display: block; color: var(--color-ink-3); font-size: 7pt; }
.lines td { border-bottom: 0.5pt solid var(--color-hairline); padding: 4pt; vertical-align: top; }
.lines .description { overflow-wrap: break-word; }
.lines .description .secondary { font-size: 9pt; }

.align-start { text-align: start; }
.align-end { text-align: end; }
/* Tabular figures keep a column aligned on the decimal point; nowrap keeps an amount whole. */
.figure { font-variant-numeric: tabular-nums; white-space: nowrap; }

/* margin-inline-start: auto — so the block sits at the trailing edge, which is the right in an English
   document and the LEFT in an Arabic one. This single declaration is what mirrors the totals. */
.totals { margin-top: 9pt; margin-inline-start: auto; width: 58%; }
.totals th { font-weight: 400; padding: 2.5pt 4pt; }
.totals td { padding: 2.5pt 4pt; }
.label-pair { display: flex; justify-content: space-between; gap: 10pt; }
.totals .total-label { font-size: 9pt; }
.totals .total-label.secondary { font-size: 8.5pt; }
.totals .emphasis th, .totals .emphasis td { border-top: 1pt solid var(--color-ink); font-weight: 600; font-size: 11pt; padding-top: 4pt; }
.totals .emphasis .total-label.secondary { color: var(--color-ink); }

.sentence { background: var(--color-ground-sunk); padding: 7pt 10pt; margin-top: 10pt; }
.sentence p { margin: 0; }
.sentence .secondary { margin-top: 3pt; font-size: 8.5pt; }
/* An isolated run is one thing to the reader, so it must not be two to the line breaker: a phone
   number split across lines is as undiallable as a reordered one. */
.sentence bdi, .figure bdi { white-space: nowrap; }

.footnote { display: flex; justify-content: space-between; gap: 12pt; margin: 6pt 0 0; color: var(--color-ink-2); font-size: 8pt; }
.footnote.strong { color: var(--color-ink); font-weight: 600; }

footer { margin-top: 8pt; border-top: 0.5pt solid var(--color-hairline); padding-top: 5pt; display: flex; justify-content: space-between; gap: 12pt; color: var(--color-ink-2); font-size: 8pt; }
footer .notes { min-width: 0; }
footer .series { display: flex; gap: 12pt; flex: 0 0 auto; }
footer .series .labelled { margin-top: 0; }
footer .series .figure { font-size: 8pt; }

/*
 * Every bilingual block, aligned from the DOCUMENT's direction rather than its own.
 *
 * Leading edge for the blocks that read as prose, trailing edge for the things that head a column of
 * figures or sit at the far side of the masthead. Both lists are explicit because the failure is silent:
 * a label whose alignment came from its own dir attribute lands at the opposite end of its cell from the
 * label it is translating, which was measured on this template — the Arabic column headings sat under
 * the wrong columns and the description heading flew to the far side of the widest cell on the page.
 */
.who, .who [lang], .meta-field, .meta-field [lang],
.party-body [lang], .lines .description, .lines .description [lang],
.sentence [lang], footer .notes [lang] { text-align: var(--leading); }

.what, .what [lang], .lines th [lang] { text-align: var(--trailing); }
`
}

/**
 * Renders one form, in one locale, to a complete self-contained HTML document.
 *
 * Deterministic: no clock, no random, no network. The same view and locale produce the same bytes, and
 * the fonts are embedded from pinned packages, so the only thing that differs between two renders of
 * one document is the timestamp Skia writes into the PDF — measured, and masked, in the itest.
 */
export function renderTaxDocumentHtml(doc: TaxDocumentView, locale: DocumentLocale = 'en'): string {
  const title = TITLES[doc.form]
  const showTrn = formStates(doc.form, 'issuerTrn')
  const meta = [
    metaField(DOCUMENT_LABELS.documentNumber, locale, doc.documentNumber),
    metaField(DOCUMENT_LABELS.issuedOn, locale, doc.issueDate),
    ...(formStates(doc.form, 'taxPointDate')
      ? [metaField(DOCUMENT_LABELS.suppliedOn, locale, doc.taxPointDate)]
      : []),
  ].join('')

  const parties = [
    partyBlock(DOCUMENT_LABELS.supplier, locale, doc.issuer, showTrn),
    ...(doc.customer === undefined
      ? []
      : [partyBlock(DOCUMENT_LABELS.customer, locale, doc.customer, true)]),
  ].join('')

  return `<!doctype html>
<html lang="${locale}" dir="${dirOf(locale)}">
<head>
<meta charset="utf-8">
<title>${safeText(title[locale])} ${safeText(doc.documentNumber)}</title>
<style>${styles(locale)}</style>
</head>
<body>
<header>
<div class="who">${partyName(doc.issuer, locale)}</div>
<div class="what">${pair(title, locale)}</div>
</header>
<div class="meta">${meta}</div>
<div class="parties">${parties}</div>
${linesTable(doc, locale)}
${totalsTable(doc, locale)}
${sentence(doc, locale)}
${footnote(doc, locale)}
${documentFooter(doc, locale)}
</body>
</html>`
}

/** The masthead name: the issuer in both scripts, with the emirate where the form states one. */
function partyName(issuer: DocumentParty, locale: DocumentLocale): string {
  const secondary = other(locale)
  const names: Record<DocumentLocale, string> = {
    // The trading name, not the legal one: it is what the customer walked into. The supplier block
    // below carries the legal entity, which is the name the TRN belongs to, and a document that stated
    // only one of the two would be missing a field the Y11 superset enumerates.
    en: issuer.tradingName ?? issuer.name,
    ar: issuer.nameAr ?? issuer.tradingName ?? issuer.name,
  }
  return [
    `<div class="primary lang-${locale}" dir="${dirOf(locale)}" lang="${locale}">${safeText(names[locale])}</div>`,
    `<div class="secondary lang-${secondary}" dir="${dirOf(secondary)}" lang="${secondary}">${safeText(names[secondary])}</div>`,
  ].join('')
}
