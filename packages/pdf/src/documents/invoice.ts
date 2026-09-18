/**
 * Bilingual EN/AR tax invoice.
 *
 * The layout is the one a UAE business actually issues: an English column and an Arabic column
 * sharing one table, party blocks in both scripts, and a bilingual totals block. Arabic is not a
 * translation pass bolted on at the end — it is the harder of the two directions and it sets the
 * table's column order, so it is built in from the first line of markup.
 *
 * Scope. This unit proves the *rendering*: shaping, bidi, isolation, embedded fonts. The
 * authoritative field list, the gap-free numbering and the VAT arithmetic belong to the accounting
 * workstream (docs/03 §7, units M-VAT-*), which renders through this template rather than replacing
 * it. The fields present here are the FTA tax-invoice fields, so that hand-off is a wiring job.
 *
 * Every interpolated value goes through `safeText` or `bdi` from `@berelax/core`. Nothing reaches the
 * markup raw, including values that "cannot" contain markup: a therapist's name typed by a
 * receptionist is untrusted input like any other, and a bidi override in a customer name is a real
 * attack on a document that states an amount.
 */
import {
  bdi,
  formatMoney,
  type LocalDate,
  type Money,
  safeText,
  type VatBreakdown,
  type VatRateBp,
} from '@berelax/core'
import { FONT_STACK, fontFaceCss } from '../fonts.ts'

export interface InvoiceParty {
  readonly name: string
  readonly nameAr: string
  readonly addressLines: readonly string[]
  readonly addressLinesAr: readonly string[]
  /** UAE Tax Registration Number. Absent for a customer who is not VAT-registered. */
  readonly trn?: string
  readonly phone?: string
}

export interface InvoiceLine {
  readonly descriptionEn: string
  readonly descriptionAr: string
  readonly quantity: number
  /** VAT-inclusive unit price. Gross is authoritative; see decision 7 in docs/01. */
  readonly unitGross: Money
  readonly lineGross: Money
  readonly vatRateBp: VatRateBp
}

export interface TaxInvoice {
  /** Sequential, gap-free. The series and counter live in the accounting schema. */
  readonly number: string
  readonly issuedOn: LocalDate
  /** Date of supply, which for a treatment is the appointment date. */
  readonly suppliedOn: LocalDate
  readonly supplier: InvoiceParty
  readonly customer: InvoiceParty
  readonly lines: readonly InvoiceLine[]
  readonly totals: VatBreakdown
  readonly notes?: string
  readonly notesAr?: string
}

/** A label in both scripts. English is the primary; Arabic sits beneath it at a smaller size. */
interface Label {
  readonly en: string
  readonly ar: string
}

const LABELS = {
  title: { en: 'Tax Invoice', ar: 'فاتورة ضريبية' },
  invoiceNumber: { en: 'Invoice number', ar: 'رقم الفاتورة' },
  issuedOn: { en: 'Date of issue', ar: 'تاريخ الإصدار' },
  suppliedOn: { en: 'Date of supply', ar: 'تاريخ التوريد' },
  supplier: { en: 'Supplier', ar: 'المورّد' },
  customer: { en: 'Customer', ar: 'العميل' },
  trn: { en: 'TRN', ar: 'الرقم الضريبي' },
  description: { en: 'Description', ar: 'الوصف' },
  quantity: { en: 'Qty', ar: 'الكمية' },
  unitPrice: { en: 'Unit price', ar: 'سعر الوحدة' },
  vatRate: { en: 'VAT rate', ar: 'نسبة الضريبة' },
  amount: { en: 'Amount', ar: 'المبلغ' },
  netTotal: { en: 'Total excluding VAT', ar: 'المجموع بدون ضريبة' },
  vatTotal: { en: 'VAT', ar: 'ضريبة القيمة المضافة' },
  grossTotal: { en: 'Total payable', ar: 'المجموع المستحق' },
  phone: { en: 'Phone', ar: 'هاتف' },
  /**
   * The rate is a placeholder because it must be isolated, and an isolate is markup.
   *
   * Written inline as `5%` this sentence renders the percent sign to the *left* of the figure —
   * measured, not assumed: see `bidi-specimen.ts`. The table's VAT RATE column gets it right
   * because a cell is its own left-to-right scope, so the same document would show the rate two
   * different ways. Splitting the sentence at the rate is what makes both agree.
   */
  inclusive: {
    en: 'All prices are inclusive of {rate} VAT.',
    ar: 'جميع الأسعار تشمل ضريبة القيمة المضافة بنسبة {rate}.',
  },
} satisfies Record<string, Label>

/**
 * A rate in basis points as a percentage string.
 *
 * Latin numerals in Arabic — decided in docs/08 §7 and matching UAE commercial practice — which is
 * exactly why every occurrence is isolated at the point of use.
 */
function ratePercent(rateBp: VatRateBp): string {
  const percent = rateBp / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/** A bilingual table header cell: English, then Arabic beneath in its own direction. */
function headerCell(label: Label, align: 'start' | 'end'): string {
  return [
    `<th class="align-${align}">`,
    `<span class="en">${safeText(label.en)}</span>`,
    `<span class="ar" dir="rtl" lang="ar">${safeText(label.ar)}</span>`,
    '</th>',
  ].join('')
}

/**
 * A bilingual label followed by one left-to-right value.
 *
 * Used for a TRN and a phone number: figures that belong to the document, not to either language,
 * and that must keep their internal order whichever column they sit beside.
 */
function labelledValue(label: Label, value: string): string {
  return [
    '<div class="labelled">',
    `<span class="en">${safeText(label.en)}</span>`,
    `<span class="ar" dir="rtl" lang="ar">${safeText(label.ar)}</span>`,
    `<span class="figure">${bdi(value, 'ltr')}</span>`,
    '</div>',
  ].join('')
}

function partyBlock(label: Label, party: InvoiceParty): string {
  const lines = party.addressLines.map((line) => `<div>${safeText(line)}</div>`).join('')
  const linesAr = party.addressLinesAr.map((line) => `<div>${safeText(line)}</div>`).join('')
  // Bilingual label, single value. Printing the number once in each column, as an earlier draft
  // did, gave every invoice two copies of the same TRN and two copies of the same phone number —
  // which is not bilingualism, it is duplication a reader has to check against itself.
  const trn = party.trn === undefined ? '' : labelledValue(LABELS.trn, party.trn)
  const phone = party.phone === undefined ? '' : labelledValue(LABELS.phone, party.phone)
  return [
    '<section class="party">',
    '<h2>',
    `<span class="en">${safeText(label.en)}</span>`,
    `<span class="ar" dir="rtl" lang="ar">${safeText(label.ar)}</span>`,
    '</h2>',
    `<div class="party-body"><div class="en"><strong>${safeText(party.name)}</strong>${lines}</div>`,
    `<div class="ar" dir="rtl" lang="ar"><strong>${safeText(party.nameAr)}</strong>${linesAr}</div></div>`,
    trn,
    phone,
    '</section>',
  ].join('')
}

function lineRow(line: InvoiceLine): string {
  return [
    '<tr>',
    '<td class="align-start description">',
    `<div class="en">${safeText(line.descriptionEn)}</div>`,
    `<div class="ar" dir="rtl" lang="ar">${safeText(line.descriptionAr)}</div>`,
    '</td>',
    `<td class="align-end figure">${bdi(String(line.quantity), 'ltr')}</td>`,
    `<td class="align-end figure">${bdi(formatMoney(line.unitGross), 'ltr')}</td>`,
    `<td class="align-end figure">${bdi(ratePercent(line.vatRateBp), 'ltr')}</td>`,
    `<td class="align-end figure">${bdi(formatMoney(line.lineGross), 'ltr')}</td>`,
    '</tr>',
  ].join('')
}

function totalRow(label: Label, amount: Money, emphasis = false): string {
  return [
    `<tr${emphasis ? ' class="emphasis"' : ''}>`,
    '<th class="align-start label-pair">',
    `<span class="en">${safeText(label.en)}</span>`,
    `<span class="ar" dir="rtl" lang="ar">${safeText(label.ar)}</span>`,
    '</th>',
    `<td class="align-end figure">${bdi(formatMoney(amount), 'ltr')}</td>`,
    '</tr>',
  ].join('')
}

/**
 * The Arabic settlement sentence.
 *
 * This single paragraph is the whole bidi problem in miniature: a right-to-left sentence carrying an
 * invoice reference, an amount and a dialling code, each of which must read left-to-right and keep
 * its internal order. It is also the line a customer reads first, so it is the line worth getting
 * right.
 */
function settlementSentenceAr(invoice: TaxInvoice): string {
  // Deliberately the English currency form, `AED 950.00`, not the Arabic `د.إ.`.
  //
  // Two reasons. The document states every other amount as AED, and one invoice should not carry two
  // currency notations. And `Intl.NumberFormat('ar-AE')` returns the Arabic abbreviation wrapped in
  // U+200F marks that `safeText` strips as untrusted-input hygiene, which leaves the abbreviation's
  // two letters free to reorder inside the isolate — so the sentence would print the currency
  // backwards. See the note in packages/core/src/text/html.test.ts.
  const amount = formatMoney(invoice.totals.gross)
  const parts = [
    'المبلغ المستحق على الفاتورة رقم',
    bdi(invoice.number, 'ltr'),
    'هو',
    `${bdi(amount, 'ltr')}.`,
    'للاستفسار اتصل على',
    bdi(invoice.supplier.phone ?? '', 'ltr'),
  ]
  return `<p class="settlement ar" dir="rtl" lang="ar">${parts.join(' ')}</p>`
}

function styles(): string {
  return `
${fontFaceCss()}

@page { size: A4; }

:root {
  --ink: #1b1a18;
  --ink-muted: #5f5b55;
  --rule: #d8d3cb;
  --surface-sunken: #f6f3ee;
}

* { box-sizing: border-box; }

html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

body {
  margin: 0;
  font-family: ${FONT_STACK};
  font-size: 10pt;
  line-height: 1.5;
  color: var(--ink);
}

/* Arabic is optically smaller at the same point size and never tracked or uppercased.
   docs/08 §3 records the recalibration; this is its print form. */
.ar, [lang='ar'] {
  font-size: 1.06em;
  line-height: 1.85;
  letter-spacing: 0;
  text-transform: none;
  font-weight: 500;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1.5pt solid var(--ink);
  padding-bottom: 6pt;
  margin-bottom: 12pt;
}

header .title-en { font-size: 17pt; font-weight: 600; letter-spacing: 0.02em; }
header .title-ar { font-size: 17pt; font-weight: 600; }

.meta { display: flex; gap: 18pt; margin-bottom: 14pt; }
.meta > div { flex: 1; }
.meta .label { color: var(--ink-muted); font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; }
.meta .label-ar { color: var(--ink-muted); font-size: 8.5pt; }

.parties { display: flex; gap: 18pt; margin-bottom: 16pt; }
.party { flex: 1; }
.party h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin: 0 0 4pt; display: flex; justify-content: space-between; }
.party h2 .ar { text-transform: none; font-size: 8.5pt; }
.party-body { display: flex; justify-content: space-between; gap: 10pt; }
.party-body > div { flex: 1; }
.party .labelled { display: flex; align-items: baseline; gap: 8pt; margin-top: 3pt; color: var(--ink-muted); }
.party .labelled .en { text-transform: uppercase; letter-spacing: 0.06em; font-size: 8pt; }
.party .labelled .ar { font-size: 8.5pt; }
.party .labelled .figure { color: var(--ink); }

table { width: 100%; border-collapse: collapse; }
.lines thead th { border-bottom: 1pt solid var(--ink); padding: 4pt 5pt; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted); vertical-align: bottom; }
.lines thead th span { display: block; }
.lines thead th .ar { text-transform: none; letter-spacing: 0; font-size: 8.5pt; }
/* Scoped to .lines deliberately. An unscoped tbody-td rule also matched the totals table, where the
   label is a th — so each totals row grew a rule under the amount only, and the block looked like a
   table with half its lines missing. */
.lines tbody td { border-bottom: 0.5pt solid var(--rule); padding: 6pt 5pt; vertical-align: top; }
.align-start { text-align: start; }
.align-end { text-align: end; }
/* Tabular figures keep the amount column aligned on the decimal point. */
.figure { font-variant-numeric: tabular-nums; white-space: nowrap; }
.description .ar { color: var(--ink-muted); }

.totals { margin-top: 10pt; margin-inline-start: auto; width: 62%; }
.totals th { font-weight: 400; padding: 3pt 5pt; }
.totals td { padding: 3pt 5pt; }
/* English label, Arabic label, then the figure — one row, three columns, so the eye can run down
   either language without the labels stacking away from their amount. */
.totals .label-pair { display: flex; justify-content: space-between; gap: 12pt; }
.totals .label-pair .ar { color: var(--ink-muted); font-size: 9pt; }
.totals .emphasis th, .totals .emphasis td { border-top: 1pt solid var(--ink); font-weight: 600; font-size: 11.5pt; padding-top: 5pt; }
.totals .emphasis .label-pair .ar { font-size: 10pt; font-weight: 500; color: var(--ink); }

.inclusive { display: flex; justify-content: space-between; gap: 14pt; margin-top: 8pt; color: var(--ink-muted); font-size: 9pt; }

.settlement { background: var(--surface-sunken); padding: 8pt 10pt; margin-top: 16pt; }
footer { margin-top: 14pt; display: flex; justify-content: space-between; color: var(--ink-muted); font-size: 8.5pt; border-top: 0.5pt solid var(--rule); padding-top: 6pt; }
`
}

/**
 * The single VAT rate the invoice carries, or undefined when the lines disagree.
 *
 * A mixed-rate invoice cannot claim one rate in a footnote, so the sentence changes rather than
 * quietly naming the first line's rate.
 */
function singleRate(lines: readonly InvoiceLine[]): VatRateBp | undefined {
  const rates = new Set(lines.map((line) => line.vatRateBp))
  if (rates.size !== 1) return undefined
  return [...rates][0]
}

/** The inclusive-pricing footnote, with the rate isolated so it reads the same in both scripts. */
function inclusiveNote(lines: readonly InvoiceLine[]): string {
  const rate = singleRate(lines)
  const fill = (template: string): string =>
    rate === undefined
      ? safeText(template.replace('{rate}', '')).replace('  ', ' ')
      : safeText(template)
          .split('{rate}')
          .join(bdi(ratePercent(rate), 'ltr'))
  return [
    '<p class="inclusive">',
    `<span class="en">${fill(LABELS.inclusive.en)}</span>`,
    `<span class="ar" dir="rtl" lang="ar">${fill(LABELS.inclusive.ar)}</span>`,
    '</p>',
  ].join('')
}

/** Renders the invoice to a complete, self-contained HTML document. */
export function renderInvoiceHtml(invoice: TaxInvoice): string {
  const metaField = (label: Label, value: string): string =>
    [
      '<div>',
      `<div class="label">${safeText(label.en)}</div>`,
      `<div class="label-ar ar" dir="rtl" lang="ar">${safeText(label.ar)}</div>`,
      `<div class="figure">${bdi(value, 'ltr')}</div>`,
      '</div>',
    ].join('')

  const notes =
    invoice.notes === undefined && invoice.notesAr === undefined
      ? ''
      : [
          '<footer>',
          `<span class="en">${safeText(invoice.notes ?? '')}</span>`,
          `<span class="ar" dir="rtl" lang="ar">${safeText(invoice.notesAr ?? '')}</span>`,
          '</footer>',
        ].join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeText(LABELS.title.en)} ${safeText(invoice.number)}</title>
<style>${styles()}</style>
</head>
<body>
<header>
  <div class="title-en">${safeText(LABELS.title.en)}</div>
  <div class="title-ar ar" dir="rtl" lang="ar">${safeText(LABELS.title.ar)}</div>
</header>

<div class="meta">
  ${metaField(LABELS.invoiceNumber, invoice.number)}
  ${metaField(LABELS.issuedOn, invoice.issuedOn)}
  ${metaField(LABELS.suppliedOn, invoice.suppliedOn)}
</div>

<div class="parties">
  ${partyBlock(LABELS.supplier, invoice.supplier)}
  ${partyBlock(LABELS.customer, invoice.customer)}
</div>

<table class="lines">
  <thead>
    <tr>
      ${headerCell(LABELS.description, 'start')}
      ${headerCell(LABELS.quantity, 'end')}
      ${headerCell(LABELS.unitPrice, 'end')}
      ${headerCell(LABELS.vatRate, 'end')}
      ${headerCell(LABELS.amount, 'end')}
    </tr>
  </thead>
  <tbody>
    ${invoice.lines.map(lineRow).join('\n    ')}
  </tbody>
</table>

<table class="totals">
  <tbody>
    ${totalRow(LABELS.netTotal, invoice.totals.net)}
    ${totalRow(LABELS.vatTotal, invoice.totals.vat)}
    ${totalRow(LABELS.grossTotal, invoice.totals.gross, true)}
  </tbody>
</table>

${settlementSentenceAr(invoice)}
${inclusiveNote(invoice.lines)}
${notes}
</body>
</html>`
}

/** The bilingual labels, exported so tests assert against the same strings the document renders. */
export { LABELS as INVOICE_LABELS }
