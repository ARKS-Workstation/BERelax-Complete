import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_FORM_FIELDS,
  type DocumentFieldKey,
  type DocumentForm,
  filsFrom,
  formatAmount,
  formatMoney,
  formStates,
  money,
  PLACEHOLDER_TRN,
  SIMPLIFIED_INVOICE_THRESHOLD,
  type StoredDocument,
  type StoredDocumentLine,
  TrnNotConfigured,
  vatIfReDerivedFromTotal,
} from '@berelax/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPdfRenderer, embeddedBaseFonts, type PdfRenderer } from '../render.ts'
import { renderTaxDocumentPdf, taxDocumentHtml, writeTaxDocumentPdf } from '../render-document.ts'
import {
  arabicFallbacksFor,
  arabicVisualLines,
  COMMITTED_DOCUMENTS,
  ELEVEN_FILS_DOCUMENT,
  extractPdfText,
  findLine,
  findLineWithAll,
  isInk,
  MIXED_RATE_DOCUMENT,
  measurePrintMargins,
  measureTextWidths,
  OVERFLOW_PROBE_DOCUMENT,
  type PdfPageText,
  RECEIPT_DOCUMENT,
  SHAPED_FIXTURE_TRN,
  SIMPLIFIED_INVOICE_DOCUMENT,
  TAX_INVOICE_DOCUMENT,
  unjoin,
  visualLines,
  xOfOnLine,
} from '../testing/index.ts'
import { DOCUMENT_LABELS, DOCUMENT_LOCALES, type DocumentLocale } from './tax-document.ts'

/**
 * M-TILL-12 — the three forms, in both locales, asserted on their contents.
 *
 * "A PDF was produced" proves nothing. A document that renders is not a document that says the right
 * thing, and for Arabic it can contain every correct codepoint while every glyph is a notdef box. So each
 * claim here is made about extracted text or PDF geometry, and paired with a control that must fail:
 *
 *   - the mandatory fields are asserted present **and** the fields a form must not state are asserted
 *     absent, per form — a template that printed the superset on every form would satisfy the first half;
 *   - printed figures are compared against the stored columns, and a figure one fils out is looked for
 *     and must not be found;
 *   - the eleven-fils document is rendered, where a renderer that re-derived VAT from the document total
 *     would print 0.01 in the totals block instead of the stored 0.02;
 *   - mirroring is asserted in both directions, so each locale is the other's control;
 *   - the margins are measured in millimetres at print size, and the measurement is then shown to catch
 *     an overflow once the layout rule that prevents one is removed.
 *
 * Every amount is compared after normalising U+00A0 to a space: `formatMoney` writes a no-break space
 * between the code and the figure, and pdf.js hands it back as a plain space. Comparing the raw strings
 * would fail on whitespace while reporting a figure mismatch.
 */

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures')
const GOLDEN = join(FIXTURES, 'tax-document-golden.json')

interface GoldenMargins {
  readonly leftMm: number
  readonly rightMm: number
  readonly topMm: number
  readonly bottomMm: number
}
interface Golden {
  readonly documents: Readonly<
    Record<string, { readonly arabicLines: readonly string[]; readonly margins: GoldenMargins }>
  >
}

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden

/** The declared print margins, from `A4_DOCUMENT` in render.ts. What the measurements are held to. */
const DECLARED = { side: 18, top: 18, bottom: 20 }

const spaces = (text: string): string => text.replace(/\u00a0/g, ' ')
const amountOf = (fils: number): string => spaces(formatMoney(money(filsFrom(fils))))
const bareOf = (fils: number): string => formatAmount(money(filsFrom(fils)))

function firstLine(stored: StoredDocument): StoredDocumentLine {
  const line = stored.lines[0]
  if (line === undefined) throw new Error(`${stored.displayNumber} has no lines`)
  return line
}

let renderer: PdfRenderer
let scratch: string

interface Rendered {
  readonly key: string
  readonly form: DocumentForm
  readonly locale: DocumentLocale
  readonly stored: StoredDocument
  readonly bytes: Uint8Array
  readonly pages: PdfPageText[]
  readonly page: PdfPageText
  /** Every visual line, joined, with no-break spaces normalised. */
  readonly text: string
}

const rendered = new Map<string, Rendered>()

async function render(
  key: string,
  stored: StoredDocument,
  form: DocumentForm,
  locale: DocumentLocale,
): Promise<void> {
  const bytes = await renderTaxDocumentPdf(renderer, {
    stored,
    form,
    locale,
    arabic: arabicFallbacksFor(stored),
  })
  const pages = await extractPdfText(bytes)
  const page = pages[0]
  if (page === undefined) throw new Error(`${key} rendered no page`)
  rendered.set(key, {
    key,
    form,
    locale,
    stored,
    bytes,
    pages,
    page,
    text: spaces(visualLines(pages).join('\n')),
  })
}

const at = (key: string): Rendered => {
  const entry = rendered.get(key)
  if (entry === undefined) throw new Error(`nothing was rendered for ${key}`)
  return entry
}

/** The line a needle sits on, with no-break spaces normalised, or `''`. */
const lineWith = (entry: Rendered, needle: string): string =>
  spaces(findLine(entry.pages, needle)?.visual ?? '')

beforeAll(async () => {
  renderer = await createPdfRenderer()
  scratch = mkdtempSync(join(tmpdir(), 'mtill12-'))
  for (const document of COMMITTED_DOCUMENTS) {
    for (const locale of DOCUMENT_LOCALES) {
      await render(`${document.name}-${locale}`, document.stored, document.form, locale)
    }
  }
  await render('eleven-fils-en', ELEVEN_FILS_DOCUMENT, 'tax_invoice', 'en')
  await render('mixed-rate-en', MIXED_RATE_DOCUMENT, 'simplified_invoice', 'en')
  await render('overflow-en', OVERFLOW_PROBE_DOCUMENT, 'tax_invoice', 'en')
  await render('overflow-ar', OVERFLOW_PROBE_DOCUMENT, 'tax_invoice', 'ar')
}, 240_000)

afterAll(async () => {
  await renderer?.close()
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
})

/** The six committed documents: three forms in two locales. */
const EVERY_KEY = COMMITTED_DOCUMENTS.flatMap((document) =>
  DOCUMENT_LOCALES.map((locale) => `${document.name}-${locale}`),
)

describe('every form renders one A4 page carrying both scripts', () => {
  for (const key of EVERY_KEY) {
    it(`${key} is a one-page PDF with all four faces embedded`, () => {
      const entry = at(key)
      expect(Buffer.from(entry.bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
      expect(entry.pages).toHaveLength(1)
      const fonts = embeddedBaseFonts(entry.bytes).map((name) => name.split('+').at(-1))
      // A document carrying no Arabic face would still contain Arabic codepoints, drawn as boxes, and
      // every text assertion below would pass against them.
      expect(fonts).toContain('IBMPlexSansArabic-Regular')
      expect(fonts).toContain('IBMPlexSansArabic-SemiBold')
      expect(fonts).toContain('IBMPlexSans-Regular')
      expect(fonts).toContain('IBMPlexSans-SemiBold')
    })

    it(`${key} writes Arabic as contextual presentation forms, which only a shaper produces`, () => {
      const shaped = [...at(key).text].filter((char) => /[\ufe70-\ufefc]/.test(char)).length
      expect(shaped).toBeGreaterThan(40)
    })
  }

  it('shapes Arabic rather than drawing isolated forms — proved by width', async () => {
    // Breaking the cursive join with U+200C changes the advance widths by about a fifth. A fallback font
    // drawing isolated forms, or notdef boxes, would show no difference at all.
    const word = 'مساج الزيت الساخن'
    const [joined, broken] = await measureTextWidths(renderer.browser(), [
      { label: 'joined', text: word },
      { label: 'unjoined', text: unjoin(word) },
    ])
    expect(joined?.widthPx).toBeGreaterThan(0)
    expect(broken?.widthPx).toBeGreaterThan((joined?.widthPx ?? 0) * 1.05)
  })
})

/**
 * A needle, and which artifact it is looked for in.
 *
 * Latin needles — every figure, date, number, name and the English labels — are asserted against the
 * **PDF's extracted text**, because that is the document the customer holds and it is where a dropped or
 * clipped field would actually be missing.
 *
 * Arabic needles are asserted against the **HTML**, and the reason is worth recording rather than
 * working around. Chromium draws Arabic as Presentation Forms-B glyphs and inspect.ts reconstructs lines
 * geometrically, left to right, so an Arabic phrase comes back as shaped glyphs in the reverse of its
 * logical order — measured on this fixture: the supplier label matches the extraction only after NFKC
 * normalisation AND reversal, and the two-word title matches neither way because the inter-word spacing
 * differs. Any "does the PDF contain this Arabic string" check is therefore either false or accidental.
 * What proves the Arabic reached the PDF is the committed golden — every Arabic line, byte for byte, in
 * visual order — with the presentation-form count and the geometric right-to-left assertions. Between
 * them the claim is stronger than a substring search, and it is honest about which artifact answers
 * which question.
 */
interface Needle {
  readonly text: string
  readonly where: 'pdf' | 'html'
}

const latin = (text: string): Needle => ({ text, where: 'pdf' })
const arabic = (text: string): Needle => ({ text, where: 'html' })

/**
 * What each declared field looks like, as needles.
 *
 * Read twice: once for "every field this form states is present", once for "every field it does not
 * state is absent". A field whose data is null on the fixture yields no needle — the field list says
 * what a form states *when there is one*, and the customer TRN has its own case below rather than an
 * assertion that would pass on an absent value.
 *
 * Both halves of every bilingual label are asserted, not just the leading locale's: every form carries
 * both languages, so a document missing the Arabic half of a label is missing a field whichever locale
 * leads.
 */
function expectedNeedles(entry: Rendered, field: DocumentFieldKey): readonly Needle[] {
  const { stored } = entry
  const label = (pair: { en: string; ar: string }): Needle[] => [latin(pair.en), arabic(pair.ar)]
  const line = firstLine(stored)
  switch (field) {
    case 'documentTitle': {
      const titles = {
        tax_invoice: DOCUMENT_LABELS.taxInvoice,
        simplified_invoice: DOCUMENT_LABELS.simplifiedInvoice,
        receipt: DOCUMENT_LABELS.receipt,
      }
      return label(titles[entry.form])
    }
    case 'issuerLegalName':
      return [latin(stored.issuerLegalName)]
    case 'issuerTradingName':
      return [latin(stored.issuerTradingName)]
    case 'issuerAddress':
      return stored.issuerAddressSnapshot.split('\n').map(latin)
    case 'issuerEmirate':
      return [latin(stored.issuerEmirate), ...label(DOCUMENT_LABELS.emirate)]
    case 'issuerTrn':
      return [latin(stored.issuerTrn), ...label(DOCUMENT_LABELS.trn)]
    case 'issuerPhone':
      return stored.issuerPhone === null
        ? []
        : [latin(stored.issuerPhone), ...label(DOCUMENT_LABELS.phone)]
    case 'documentNumber':
      return [latin(stored.displayNumber), ...label(DOCUMENT_LABELS.documentNumber)]
    case 'documentSeries':
      return [
        latin(stored.seriesCode),
        latin(stored.periodKey),
        ...label(DOCUMENT_LABELS.series),
        ...label(DOCUMENT_LABELS.period),
      ]
    case 'issueDate':
      return [latin(stored.issueDate), ...label(DOCUMENT_LABELS.issuedOn)]
    case 'taxPointDate':
      return [latin(stored.taxPointDate), ...label(DOCUMENT_LABELS.suppliedOn)]
    case 'customerName':
      // The stored name carries a bidi override; what must appear is the name with it stripped.
      return [
        latin(stored.customerNameSnapshot.replace(/[\u202a-\u202e]/g, '')),
        ...label(DOCUMENT_LABELS.customer),
      ]
    case 'customerAddress':
      return stored.customerAddressSnapshot === null ? [] : [latin(stored.customerAddressSnapshot)]
    case 'customerTrn':
      return stored.customerTrn === null ? [] : [latin(stored.customerTrn)]
    case 'lineDescription':
      // Word by word against the PDF, whole against the HTML. A treatment name is longer than its
      // column and wraps, and the extraction reconstructs lines geometrically — so the row's first
      // visual line reads "...Massage \u2014 901 400.00 380.95" with the quantity butted against the
      // wrapped word and "minutes" on a line of its own. The words are what the document states; where
      // the column broke them is not a fact about the document.
      return [
        ...line.descriptionEn
          .split(' ')
          .filter((word) => word.length > 2)
          .map(latin),
        arabic(line.descriptionEn),
      ]
    case 'lineQuantity':
      return [latin(String(line.quantity)), ...label(DOCUMENT_LABELS.quantity)]
    case 'lineUnitGross':
      return [latin(bareOf(line.unitGrossFils)), ...label(DOCUMENT_LABELS.unitPrice)]
    case 'lineNet':
      return [latin(bareOf(line.netFils)), ...label(DOCUMENT_LABELS.lineNet)]
    case 'lineVatRate':
      return [latin('5%'), ...label(DOCUMENT_LABELS.vatRate)]
    case 'lineVat':
      return [latin(bareOf(line.vatFils)), ...label(DOCUMENT_LABELS.lineVat)]
    case 'lineGross':
      return [latin(bareOf(line.lineGrossFils)), ...label(DOCUMENT_LABELS.lineAmount)]
    case 'netTotal':
      return [latin(amountOf(stored.netTotalFils)), ...label(DOCUMENT_LABELS.netTotal)]
    case 'vatTotal':
      return [latin(amountOf(stored.vatTotalFils)), ...label(DOCUMENT_LABELS.vatTotal)]
    case 'grossTotal':
      return [
        latin(amountOf(stored.grossTotalFils)),
        ...label(entry.form === 'receipt' ? DOCUMENT_LABELS.totalPaid : DOCUMENT_LABELS.grossTotal),
      ]
    case 'currency':
      return [latin('AED')]
    case 'arabicText':
      return [arabic(DOCUMENT_LABELS.supplier.ar)]
    case 'notATaxInvoice':
      return label(DOCUMENT_LABELS.notATaxInvoice)
  }
}

/** The artifact a needle is looked for in, normalised by {@link collapse}. */
function haystack(entry: Rendered, where: 'pdf' | 'html'): string {
  return collapse(
    where === 'pdf'
      ? entry.text
      : taxDocumentHtml({
          stored: entry.stored,
          form: entry.form,
          locale: entry.locale,
          arabic: arabicFallbacksFor(entry.stored),
        }),
  )
}

/**
 * Lower-cased, with every run of whitespace reduced to one space.
 *
 * Both halves earn their place. The stylesheet uppercases every label, so the PDF carries PHONE where
 * the label object says Phone. And a treatment name is longer than its column, so it WRAPS: the
 * extraction returns "Arabic Hot Oil / Balm Massage — 90" and "minutes" as two lines, and a needle
 * carrying the whole name matches neither. Collapsing is what makes the assertion about the words the
 * document states rather than about where the column happened to break them.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase()
}

/** True when the document states `needle`, looked for in the artifact that can answer for it. */
function states(entry: Rendered, needle: Needle): boolean {
  return haystack(entry, needle.where).includes(collapse(needle.text))
}

describe('acceptance 1 — every field the form must state is on the page, named on failure', () => {
  for (const key of EVERY_KEY) {
    it(`${key} states every field its form declares`, () => {
      const entry = at(key)
      const missing: string[] = []
      const haystacks = { pdf: haystack(entry, 'pdf'), html: haystack(entry, 'html') }
      for (const field of DOCUMENT_FORM_FIELDS[entry.form]) {
        for (const needle of expectedNeedles(entry, field)) {
          if (needle.text === '') continue
          if (!haystacks[needle.where].includes(collapse(needle.text))) {
            missing.push(`${field} (${needle.where}): ${JSON.stringify(needle.text)}`)
          }
        }
      }
      expect(missing.join('\n')).toBe('')
    })
  }

  it('the tax invoice declares a superset of the other two forms', () => {
    // The control on the list rather than on the render: if a field were dropped from the tax invoice's
    // declaration, every per-form assertion above would still pass while the full form lost a mandatory
    // field. `notATaxInvoice` is the one field the superset must NOT contain.
    const declared = new Set(DOCUMENT_FORM_FIELDS.tax_invoice)
    for (const form of ['simplified_invoice', 'receipt'] as const) {
      for (const field of DOCUMENT_FORM_FIELDS[form]) {
        if (field === 'notATaxInvoice') continue
        expect(declared.has(field), `${field} is on the ${form} but not on the tax invoice`).toBe(
          true,
        )
      }
    }
    expect(declared.has('notATaxInvoice')).toBe(false)
  })

  it('prints a customer TRN when the stored document carries one', () => {
    const stored: StoredDocument = { ...TAX_INVOICE_DOCUMENT, customerTrn: SHAPED_FIXTURE_TRN }
    const html = taxDocumentHtml({ stored, form: 'tax_invoice', locale: 'en' })
    // Twice: once in the supplier block, once in the customer block. A template that printed the
    // issuer's TRN and silently dropped the customer's would still contain the digits once.
    expect(html.split(SHAPED_FIXTURE_TRN).length - 1).toBe(2)
    expect(
      taxDocumentHtml({ stored: TAX_INVOICE_DOCUMENT, form: 'tax_invoice', locale: 'en' }).split(
        SHAPED_FIXTURE_TRN,
      ).length - 1,
    ).toBe(1)
  })
})

describe('acceptance 1, the control — a form does not state what it must not', () => {
  it('the receipt states no TRN, no VAT, no net total and no series', () => {
    expect(formStates('receipt', 'issuerTrn')).toBe(false)
    for (const locale of DOCUMENT_LOCALES) {
      const entry = at(`receipt-${locale}`)
      // Each label is looked for in the artifact where it could appear at all: an Arabic label absent
      // from the extracted PDF text proves nothing, because no Arabic label matches there (see the note
      // on Needle). Asserting the Arabic against the HTML is what makes these absences real.
      expect(states(entry, latin('TRN'))).toBe(false)
      expect(states(entry, arabic(DOCUMENT_LABELS.trn.ar))).toBe(false)
      expect(states(entry, latin(DOCUMENT_LABELS.netTotal.en))).toBe(false)
      expect(states(entry, arabic(DOCUMENT_LABELS.netTotal.ar))).toBe(false)
      expect(states(entry, latin(DOCUMENT_LABELS.vatRate.en))).toBe(false)
      expect(states(entry, arabic(DOCUMENT_LABELS.vatRate.ar))).toBe(false)
      expect(states(entry, latin(DOCUMENT_LABELS.series.en))).toBe(false)
      expect(states(entry, latin('5%'))).toBe(false)
      // This fixture's stored TRN IS the Y1-trn placeholder, so this is also the assertion that says
      // nothing provisional reached the page.
      expect(entry.stored.issuerTrn).toBe(PLACEHOLDER_TRN)
      expect(states(entry, latin(PLACEHOLDER_TRN))).toBe(false)
      // And what it does state instead, in both languages.
      expect(states(entry, latin(DOCUMENT_LABELS.notATaxInvoice.en))).toBe(true)
      expect(states(entry, arabic(DOCUMENT_LABELS.notATaxInvoice.ar))).toBe(true)
    }
  })

  it('the simplified invoice states no customer block, and does state the tax figures', () => {
    for (const locale of DOCUMENT_LOCALES) {
      const entry = at(`simplified-invoice-${locale}`)
      expect(states(entry, latin(DOCUMENT_LABELS.customer.en))).toBe(false)
      expect(states(entry, arabic(DOCUMENT_LABELS.customer.ar))).toBe(false)
      // What distinguishes it from the receipt: the TRN and the tax figures.
      expect(states(entry, latin(entry.stored.issuerTrn))).toBe(true)
      expect(states(entry, latin(DOCUMENT_LABELS.vatTotal.en))).toBe(true)
      expect(states(entry, arabic(DOCUMENT_LABELS.vatTotal.ar))).toBe(true)
    }
  })

  it('only the tax invoice names a customer', () => {
    expect(at('tax-invoice-en').text).toContain('Ahmed Al Mansoori')
    expect(at('receipt-en').text).not.toContain('Ahmed Al Mansoori')
    expect(at('simplified-invoice-en').text).not.toContain('Ahmed Al Mansoori')
  })

  it('strips the bidi override out of the hostile customer name', () => {
    expect(TAX_INVOICE_DOCUMENT.customerNameSnapshot).toContain('\u202e')
    for (const locale of DOCUMENT_LOCALES) {
      expect(at(`tax-invoice-${locale}`).text).not.toContain('\u202e')
    }
  })
})

describe('acceptance — the figures printed are the figures stored', () => {
  for (const key of EVERY_KEY) {
    it(`${key} prints the stored totals, and no figure one fils out`, () => {
      const entry = at(key)
      const stored = entry.stored
      expect(entry.text).toContain(amountOf(stored.grossTotalFils))
      if (formStates(entry.form, 'vatTotal')) {
        expect(entry.text).toContain(amountOf(stored.vatTotalFils))
        expect(entry.text).toContain(amountOf(stored.netTotalFils))
      }
      // The control for the search itself: a figure one fils from the stored gross is NOT on the page,
      // which is what makes the assertion above one about the figure rather than about some number.
      expect(entry.text).not.toContain(amountOf(stored.grossTotalFils + 1))
    })

    it(`${key} prints every stored per-line figure on that line's own row`, () => {
      const entry = at(key)
      for (const line of entry.stored.lines) {
        // Located by the line's own amount rather than by its description, because in the Arabic
        // document the row's first visual line carries the ARABIC description and the English one sits
        // beneath it — so a row found by the English description is the row's second line, which holds
        // no figures at all. The amount is on the row's first line in both directions.
        const amount = findLine(entry.pages, bareOf(line.lineGrossFils))
        expect(amount, `no row carrying ${bareOf(line.lineGrossFils)}`).toBeDefined()
        if (amount === undefined) continue
        const row = spaces(amount.visual)
        expect(row).toContain(String(line.quantity))
        if (formStates(entry.form, 'lineUnitGross')) {
          expect(row).toContain(bareOf(line.unitGrossFils))
        }
        if (formStates(entry.form, 'lineNet')) {
          expect(row).toContain(bareOf(line.netFils))
          expect(row).toContain(bareOf(line.vatFils))
        } else {
          // The control on the suppression: a form that states no per-line VAT does not state it.
          expect(row).not.toContain(bareOf(line.netFils))
        }
        // And the figures belong to THIS item: the English description of the same table row sits
        // within a line or two of the figures vertically. Without this the assertions above would hold
        // for a document that printed every figure against the wrong treatment.
        const description = findLine(entry.pages, line.descriptionEn.slice(0, 24))
        expect(description, `no line for ${line.descriptionEn}`).toBeDefined()
        if (description !== undefined) {
          // At or below the figures, never above: the amount sits on the row's first line
          // (vertical-align: top), and in the Arabic document the English description is the row's
          // second or third line because the Arabic one leads and wraps. 40pt is a three-line row at
          // this type size; the row above ends further away than that.
          expect(description.y - amount.y).toBeGreaterThanOrEqual(0)
          expect(description.y - amount.y).toBeLessThan(40)
        }
      }
    })
  }

  it('prints the summed VAT of the eleven-fils document, never the re-derived one', () => {
    const entry = at('eleven-fils-en')
    const summed = amountOf(entry.stored.vatTotalFils)
    const reDerived = spaces(
      formatMoney(vatIfReDerivedFromTotal(money(filsFrom(entry.stored.grossTotalFils)))),
    )
    expect(summed).toBe('AED 0.02')
    expect(reDerived).toBe('AED 0.01')

    // The totals row, found by the figure it states: the stored vat_total appears in the totals block
    // and nowhere else, because the line rows print bare figures with the currency in the column head.
    const totalsRow = lineWith(entry, summed)
    expect(totalsRow).not.toBe('')
    expect(totalsRow).toContain(summed)

    // The claim: the figure a re-derivation from the 22-fils document total would produce is stated as a
    // total nowhere on the document.
    expect(entry.text).not.toContain(reDerived)

    // And the control, which is what stops that being vacuous: 1 fils IS on the page, twice, as each
    // line's own VAT — so the scan is looking at a document that contains the digits and distinguishing
    // where they legitimately appear. Same reasoning as the header-scoped scan in
    // invoice-document.itest.ts.
    expect(entry.text.split(bareOf(1)).length - 1).toBe(2)
  })

  it('states each rate separately on a mixed-rate document and claims no single rate', () => {
    const entry = at('mixed-rate-en')
    expect(entry.text).toContain('VAT at 5%')
    expect(entry.text).toContain('VAT at 0%')
    // The inclusive-pricing footnote names one rate, so a mixed-rate document must not carry it.
    expect(entry.text).not.toContain('All prices are inclusive of')
    // And the control: a single-rate document does carry it.
    expect(at('tax-invoice-en').text).toContain('All prices are inclusive of 5% VAT.')
  })
})

describe('acceptance — the document is mirrored, not merely translated', () => {
  it('the totals block changes side with the direction', () => {
    const sideOf = (key: string): { x: number; middle: number } => {
      const entry = at(key)
      const needle = amountOf(entry.stored.grossTotalFils)
      const line = findLine(entry.pages, needle)
      expect(line, `no total line in ${key}`).toBeDefined()
      return {
        x: line === undefined ? Number.NaN : xOfOnLine(line, needle),
        middle: entry.page.width / 2,
      }
    }
    const en = sideOf('tax-invoice-en')
    const ar = sideOf('tax-invoice-ar')
    // Right of centre in English, left of centre in Arabic. Each is the other's control: a renderer that
    // ignored `dir` would put both on the same side, and one that reversed everything would fail the
    // English case.
    expect(en.x).toBeGreaterThan(en.middle)
    expect(ar.x).toBeLessThan(ar.middle)
  })

  it('the description column changes side with the direction', () => {
    const description = 'Arabic Hot Oil'
    const en = at('tax-invoice-en')
    const ar = at('tax-invoice-ar')
    const enLine = findLine(en.pages, description)
    const arLine = findLine(ar.pages, description)
    expect(enLine).toBeDefined()
    expect(arLine).toBeDefined()
    if (enLine === undefined || arLine === undefined) return
    // The description column is the widest one, so in English it starts at the leading (left) edge and in
    // Arabic it ends at the leading (right) edge — which puts its text past the middle of the page.
    expect(xOfOnLine(enLine, description)).toBeLessThan(en.page.width / 3)
    expect(xOfOnLine(arLine, description)).toBeGreaterThan(ar.page.width / 3)
  })

  it('orders the Arabic settlement sentence right to left', () => {
    const entry = at('tax-invoice-ar')
    const amount = amountOf(entry.stored.grossTotalFils)
    // Pinned on two needles, because the reference and the amount each appear elsewhere on the page: the
    // number in the meta row, the amount in the totals block. Requiring BOTH on one line is what makes
    // this the sentence.
    const sentence = findLineWithAll(entry.pages, entry.stored.displayNumber, amount)
    expect(
      sentence,
      'the Arabic settlement sentence did not keep its reference and its amount on one line',
    ).toBeDefined()
    if (sentence === undefined) return
    const numberX = xOfOnLine(sentence, entry.stored.displayNumber)
    const amountX = xOfOnLine(sentence, amount)
    // Both finite, asserted rather than guarded: a wrap that separated them would otherwise turn the
    // order assertion below into a silent skip, which is the vacuous pass this whole file is written
    // against.
    expect(Number.isFinite(numberX) && Number.isFinite(amountX)).toBe(true)
    // Logically the number precedes the amount in the Arabic sentence, so a reader finds the number to
    // the RIGHT of the amount.
    expect(numberX).toBeGreaterThan(amountX)
  })

  it('never lets the percent sign land on the wrong side of the rate', () => {
    for (const locale of DOCUMENT_LOCALES) {
      const entry = at(`tax-invoice-${locale}`)
      expect(entry.text).toContain('5%')
      expect(entry.text).not.toContain('%5')
    }
  })

  it('keeps the phone number diallable inside the Arabic sentence', () => {
    const phone = RECEIPT_DOCUMENT.issuerPhone ?? ''
    expect(phone).not.toBe('')
    // Isolated, so the dialling code stays first, and nowrap, so it is not split across lines — the same
    // failure by a different route.
    expect(lineWith(at('receipt-ar'), phone)).toContain(phone)
  })
})

describe('acceptance — the Arabic run matches the committed golden fixture', () => {
  for (const key of EVERY_KEY) {
    it(`${key} shapes and orders Arabic exactly as the golden records`, () => {
      const expected = golden.documents[key]
      expect(expected, `no golden entry for ${key} — run pnpm pdf:fixtures`).toBeDefined()
      expect(arabicVisualLines(at(key).pages)).toEqual(expected?.arabicLines)
      expect((expected?.arabicLines ?? []).length).toBeGreaterThan(5)
    })
  }

  it('the golden distinguishes one document from another — the control', () => {
    // Two different documents must not share an Arabic run list, or "equal to the golden" would be a
    // claim any document could satisfy.
    expect(golden.documents['tax-invoice-ar']?.arabicLines).not.toEqual(
      golden.documents['receipt-ar']?.arabicLines,
    )
    expect(golden.documents['tax-invoice-ar']?.arabicLines).not.toEqual(
      golden.documents['tax-invoice-en']?.arabicLines,
    )
  })
})

describe('acceptance — padding, measured in millimetres at print size', () => {
  for (const key of [...EVERY_KEY, 'overflow-en', 'overflow-ar']) {
    it(`${key} keeps its ink inside the declared print margins`, () => {
      const margins = measurePrintMargins(at(key).page)
      expect(margins.pageWidthMm).toBeCloseTo(210, 0)
      expect(margins.inkItems).toBeGreaterThan(40)
      expect(margins.leftMm).toBeGreaterThanOrEqual(DECLARED.side - 0.3)
      expect(margins.rightMm).toBeGreaterThanOrEqual(DECLARED.side - 0.3)
      // Not so far inside that a column has collapsed or a block has stopped filling the measure.
      expect(margins.leftMm).toBeLessThan(DECLARED.side + 6)
      expect(margins.rightMm).toBeLessThan(DECLARED.side + 6)
      // The top is measured to the top of the em box rather than to the baseline, so it reads a little
      // over the declared margin; the band is what that ascent costs at 9.5pt.
      expect(margins.topMm).toBeGreaterThanOrEqual(DECLARED.top - 0.3)
      expect(margins.topMm).toBeLessThan(DECLARED.top + 4)
      expect(margins.bottomMm).toBeGreaterThanOrEqual(DECLARED.bottom - 0.3)
    })
  }

  it('the committed golden records the margins that were just measured', () => {
    for (const key of EVERY_KEY) {
      const measured = measurePrintMargins(at(key).page)
      expect({
        leftMm: measured.leftMm,
        rightMm: measured.rightMm,
        topMm: measured.topMm,
        bottomMm: measured.bottomMm,
      }).toEqual(golden.documents[key]?.margins)
    }
  })

  it('the measurement catches an overflow once the rule preventing it is removed', async () => {
    // The known-bad, and it is the shape the defect actually arrives in: one description with no place
    // to break. `overflow-wrap: break-word` on the description cell is what lets Chromium break inside
    // it; without that rule the run is unbreakable, it spills out of its column and off the right of the
    // page, and the document prints with no right-hand margin at all. Rendering it both ways proves two
    // things at once — that the measurement can fail, which is what gives every margin assertion above
    // its meaning, and that this one declaration is what prevents the failure.
    const base = firstLine(OVERFLOW_PROBE_DOCUMENT)
    const unbreakable: StoredDocument = {
      ...OVERFLOW_PROBE_DOCUMENT,
      lines: [{ ...base, descriptionEn: `Treatment${'x'.repeat(160)}` }],
    }
    const html = taxDocumentHtml({
      stored: unbreakable,
      form: 'tax_invoice',
      locale: 'en',
      arabic: arabicFallbacksFor(unbreakable),
    })
    expect(html).toContain('overflow-wrap: break-word;')

    const good = (await extractPdfText(await renderer.render(html)))[0]
    const broken = (
      await extractPdfText(await renderer.render(html.replace('overflow-wrap: break-word;', '')))
    )[0]
    expect(good).toBeDefined()
    expect(broken).toBeDefined()
    if (good === undefined || broken === undefined) return
    expect(measurePrintMargins(good).rightMm).toBeGreaterThanOrEqual(DECLARED.side - 0.3)
    expect(measurePrintMargins(broken).rightMm).toBeLessThan(DECLARED.side - 1)
  }, 90_000)

  it('a whitespace-only run is not ink — the method, measured on the F10 fixture', async () => {
    // Recorded because it is how this measurement came to be right. The naive bounding box of every text
    // item on the committed F10 invoice reports a right margin of 5.58mm against a declared 18mm: two
    // space-only runs, 79mm and 147mm wide, that put no marks on the page. Excluding them gives 17.8mm,
    // and the document is fine.
    const page = (await extractPdfText(readFileSync(join(FIXTURES, 'tax-invoice-en-ar.pdf'))))[0]
    expect(page).toBeDefined()
    if (page === undefined) return
    const naiveRight = Math.max(...page.items.map((item) => item.x + item.width))
    const inkRight = Math.max(...page.items.filter(isInk).map((item) => item.x + item.width))
    expect(naiveRight).toBeGreaterThan(inkRight)
    expect(measurePrintMargins(page).rightMm).toBeGreaterThan(17)
  })
})

describe('acceptance — two renders of one document differ only in the timestamp Skia writes', () => {
  const mask = (bytes: Uint8Array): string =>
    Buffer.from(bytes)
      .toString('latin1')
      .replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, '/$1 (D:MASKED)')

  const request = (stored: StoredDocument, form: DocumentForm) =>
    ({ stored, form, locale: 'en' as const, arabic: arabicFallbacksFor(stored) }) as const

  it('is byte-identical once the two timestamps are masked, and the mask is that narrow', async () => {
    const first = await renderTaxDocumentPdf(renderer, request(TAX_INVOICE_DOCUMENT, 'tax_invoice'))
    // Chromium writes the wall clock into /CreationDate and /ModDate and Playwright exposes no way to fix
    // it, so the interesting case is two renders in *different* seconds. Waiting for the second to tick
    // is what exercises the mask instead of passing by coincidence.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const second = await renderTaxDocumentPdf(
      renderer,
      request(TAX_INVOICE_DOCUMENT, 'tax_invoice'),
    )

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
    expect(mask(first)).toBe(mask(second))
    expect(mask(first)).toContain('/CreationDate (D:MASKED)')

    // How wide the exception is, as a number rather than as a claim.
    const a = Buffer.from(first).toString('latin1')
    const b = Buffer.from(second).toString('latin1')
    expect(first.byteLength).toBe(second.byteLength)
    let differing = 0
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) differing += 1
    expect(differing).toBeGreaterThan(0)
    expect(differing).toBeLessThanOrEqual(30)
  }, 90_000)

  it('the control: a different document differs after masking too', async () => {
    const one = await renderTaxDocumentPdf(renderer, request(TAX_INVOICE_DOCUMENT, 'tax_invoice'))
    const other = await renderTaxDocumentPdf(
      renderer,
      request(SIMPLIFIED_INVOICE_DOCUMENT, 'simplified_invoice'),
    )
    expect(mask(one)).not.toBe(mask(other))
  }, 90_000)

  it('the HTML itself is byte-identical, which is the part this code owns', () => {
    const receipt = request(RECEIPT_DOCUMENT, 'receipt')
    expect(taxDocumentHtml({ ...receipt, locale: 'ar' })).toBe(
      taxDocumentHtml({ ...receipt, locale: 'ar' }),
    )
  })
})

describe('acceptance — a provisional TRN cannot reach a tax document, and no file is written', () => {
  const path = () => join(scratch, 'refused.pdf')

  it('refuses a tax invoice whose issuer TRN is the Y1-trn placeholder, writing nothing', async () => {
    const stored: StoredDocument = { ...TAX_INVOICE_DOCUMENT, issuerTrn: PLACEHOLDER_TRN }
    expect(existsSync(path())).toBe(false)
    await expect(
      writeTaxDocumentPdf(
        renderer,
        { stored, form: 'tax_invoice', locale: 'en', arabic: arabicFallbacksFor(stored) },
        path(),
      ),
    ).rejects.toThrow(TrnNotConfigured)
    // The refusal happens before Chromium is asked for anything, so there are no bytes to have written.
    expect(existsSync(path())).toBe(false)
  })

  it('refuses a simplified invoice for the same reason — it is a tax document too', async () => {
    const stored: StoredDocument = { ...SIMPLIFIED_INVOICE_DOCUMENT, issuerTrn: PLACEHOLDER_TRN }
    await expect(
      writeTaxDocumentPdf(
        renderer,
        { stored, form: 'simplified_invoice', locale: 'en', arabic: arabicFallbacksFor(stored) },
        path(),
      ),
    ).rejects.toThrow(TrnNotConfigured)
    expect(existsSync(path())).toBe(false)
  })

  it('names which of the three kinds of unusable TRN it is', async () => {
    for (const [trn, reason] of [
      ['', 'missing'],
      [PLACEHOLDER_TRN, 'placeholder'],
      ['12345', 'malformed'],
    ] as const) {
      const stored: StoredDocument = { ...TAX_INVOICE_DOCUMENT, issuerTrn: trn }
      await expect(
        renderTaxDocumentPdf(renderer, { stored, form: 'tax_invoice', locale: 'en' }),
      ).rejects.toMatchObject({ reason })
    }
  })

  it('the control: the receipt renders from that same row, because it states no TRN', async () => {
    // Without this the two refusals above are indistinguishable from "no document ever renders", which is
    // a system with no output rather than one that refuses a specific misrepresentation.
    const bytes = await writeTaxDocumentPdf(
      renderer,
      {
        stored: RECEIPT_DOCUMENT,
        form: 'receipt',
        locale: 'en',
        arabic: arabicFallbacksFor(RECEIPT_DOCUMENT),
      },
      path(),
    )
    expect(RECEIPT_DOCUMENT.issuerTrn).toBe(PLACEHOLDER_TRN)
    expect(existsSync(path())).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(20_000)
    rmSync(path(), { force: true })
  })
})

describe('acceptance — the form is a rule, and rendering re-applies it', () => {
  it('refuses a simplified invoice above the threshold', async () => {
    const above = SIMPLIFIED_INVOICE_THRESHOLD.fils + 100
    const base = firstLine(SIMPLIFIED_INVOICE_DOCUMENT)
    const stored: StoredDocument = {
      ...SIMPLIFIED_INVOICE_DOCUMENT,
      netTotalFils: above - 100,
      vatTotalFils: 100,
      grossTotalFils: above,
      lines: [
        {
          ...base,
          quantity: 1,
          unitGrossFils: above,
          lineGrossFils: above,
          netFils: above - 100,
          vatFils: 100,
        },
      ],
    }
    // Above the threshold with no customer of record there is no compliant form at all: the desk has to
    // identify the customer first. That refusal is the rule's, not the template's.
    await expect(
      renderTaxDocumentPdf(renderer, { stored, form: 'simplified_invoice', locale: 'en' }),
    ).rejects.toThrow(/CustomerDetailsRequired/)
  })

  it('refuses to print a stored simplified invoice as a tax invoice', async () => {
    await expect(
      renderTaxDocumentPdf(renderer, {
        stored: SIMPLIFIED_INVOICE_DOCUMENT,
        form: 'tax_invoice',
        locale: 'en',
      }),
    ).rejects.toThrow(/DocumentKindMismatch/)
  })

  it('refuses a document whose header disagrees with its own lines', async () => {
    const stored: StoredDocument = {
      ...TAX_INVOICE_DOCUMENT,
      // One fils moved from VAT to net: the shape a re-derivation from the document gross produces, and
      // the shape the deferred constraint trigger raises ZI001 for at COMMIT.
      vatTotalFils: TAX_INVOICE_DOCUMENT.vatTotalFils - 1,
      netTotalFils: TAX_INVOICE_DOCUMENT.netTotalFils + 1,
    }
    await expect(
      renderTaxDocumentPdf(renderer, { stored, form: 'tax_invoice', locale: 'en' }),
    ).rejects.toThrow(/DocumentFiguresDisagree/)
  })
})

describe('the committed fixtures are the documents described above', () => {
  for (const document of COMMITTED_DOCUMENTS) {
    for (const locale of DOCUMENT_LOCALES) {
      const name = `${document.name}-${locale}`
      it(`${name}.pdf is committed and still says what a fresh render says`, async () => {
        const bytes = readFileSync(join(FIXTURES, `${name}.pdf`))
        expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
        expect(bytes.byteLength).toBeGreaterThan(20_000)
        const pages = await extractPdfText(bytes)
        expect(arabicVisualLines(pages)).toEqual(golden.documents[name]?.arabicLines)
        expect(spaces(visualLines(pages).join('\n'))).toContain(document.stored.displayNumber)
      })

      it(`${name}.png is committed, so the layout was reviewed by eye`, () => {
        const png = readFileSync(join(FIXTURES, `${name}.png`))
        expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
      })
    }
  }
})
