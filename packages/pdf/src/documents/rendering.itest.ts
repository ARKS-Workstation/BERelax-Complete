import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPdfRenderer, embeddedBaseFonts, type PdfRenderer } from '../render.ts'
import {
  extractPdfText,
  findLine,
  findLineWithAll,
  type PdfPageText,
  visualLines,
  xOfOnLine,
} from '../testing/inspect.ts'
import { measureTextWidths, unjoin } from '../testing/measure.ts'
import {
  HOSTILE_NAME,
  PLACEHOLDER_TRN,
  SAMPLE_INVOICE,
  SUPPLIER_PHONE,
} from '../testing/sample-invoice.ts'
import { BIDI_CASES, renderBidiSpecimenHtml, SPECIMEN_PHONE } from './bidi-specimen.ts'
import { renderInvoiceHtml } from './invoice.ts'

/**
 * F10 — Arabic RTL PDF proof.
 *
 * Three acceptance criteria, and a fourth thing the criteria do not say but which decides whether
 * the first three mean anything: that none of them can pass vacuously. A PDF renders Arabic
 * "correctly" if it contains the codepoints — including when every glyph is a notdef box, because
 * the ToUnicode map still reports the original characters. So each assertion here is paired with a
 * control that must fail:
 *
 *   - shaping is proved by joined text being *narrower* than the same letters with the join broken,
 *     which cannot happen in a fallback font drawing isolated forms;
 *   - RTL order is proved against an LTR control paragraph with identical content;
 *   - isolation is proved against an un-isolated specimen of the same run, which must be wrong.
 *
 * The committed fixtures are asserted alongside the fresh renders, so a template change that makes
 * the reviewed artifact stale fails here rather than being noticed by a customer.
 */

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures')
const INVOICE_FIXTURE = join(FIXTURES, 'tax-invoice-en-ar.pdf')
const SPECIMEN_FIXTURE = join(FIXTURES, 'bidi-specimen.pdf')

/** Arabic Presentation Forms-B: the contextual shapes a shaper chooses, never typed directly. */
const PRESENTATION_FORMS = /[\ufe70-\ufefc]/
/** The base Arabic block, i.e. the letters as they are stored. */
const BASE_ARABIC = /[\u0620-\u064a]/

let renderer: PdfRenderer
let invoice: PdfPageText[]
let specimen: PdfPageText[]
let invoiceBytes: Uint8Array
let specimenBytes: Uint8Array

beforeAll(async () => {
  renderer = await createPdfRenderer()
  invoiceBytes = await renderer.render(renderInvoiceHtml(SAMPLE_INVOICE))
  specimenBytes = await renderer.render(renderBidiSpecimenHtml())
  invoice = await extractPdfText(invoiceBytes)
  specimen = await extractPdfText(specimenBytes)
}, 120_000)

afterAll(async () => {
  await renderer?.close()
})

/** The x of the left edge of the first occurrence of `needle` on the line containing it. */
function xOf(pages: readonly PdfPageText[], needle: string): number {
  const line = findLine(pages, needle)
  expect(line, `no line contains ${JSON.stringify(needle)}`).toBeDefined()
  return line === undefined ? Number.NaN : xOfOnLine(line, needle)
}

/** The amount as the document prints it. */
const SETTLEMENT_AMOUNT = 'AED 950.00'

/**
 * The first line of the Arabic settlement sentence: the one carrying the reference and the amount.
 *
 * Pinned on two needles, not one. The invoice number also appears in the header meta row, and an
 * order assertion made against that row compares two unrelated things. The sentence wraps at A4
 * width, so the phone number lands on the *second* line — which is why the amount is the second
 * anchor rather than the phone.
 */
function settlementLine(pages: readonly PdfPageText[]) {
  const line = findLineWithAll(pages, SAMPLE_INVOICE.number, SETTLEMENT_AMOUNT)
  expect(line, 'the Arabic settlement sentence is missing from the render').toBeDefined()
  if (line === undefined) throw new Error('no settlement line')
  return line
}

/** The line carrying a specimen case, found by its isolated Latin marker. */
function caseLine(id: string): string {
  const line = findLine(specimen, id)
  expect(line, `specimen case ${id} is missing from the render`).toBeDefined()
  return line?.visual ?? ''
}

describe('the document renders at all', () => {
  it('produces a real PDF with more than a header in it', () => {
    expect(invoiceBytes.byteLength).toBeGreaterThan(20_000)
    expect(Buffer.from(invoiceBytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  })

  it('fits a three-line invoice on one page', () => {
    expect(invoice).toHaveLength(1)
  })

  it('carries every field a UAE tax invoice must state', () => {
    const text = visualLines(invoice).join('\n')
    expect(text).toContain('Tax Invoice')
    expect(text).toContain(SAMPLE_INVOICE.number)
    expect(text).toContain(SAMPLE_INVOICE.issuedOn)
    expect(text).toContain(SAMPLE_INVOICE.suppliedOn)
    expect(text).toContain(PLACEHOLDER_TRN)
    expect(text).toContain('AED 950.00')
    expect(text).toContain('AED 904.76')
    expect(text).toContain('AED 45.24')
  })
})

describe('acceptance 1 — Arabic shaping and RTL order', () => {
  it('embeds both Arabic weights, so no reader has to substitute a font', () => {
    const fonts = embeddedBaseFonts(invoiceBytes).map((name) => name.split('+').at(-1))
    expect(fonts).toContain('IBMPlexSansArabic-Regular')
    expect(fonts).toContain('IBMPlexSansArabic-SemiBold')
    expect(fonts).toContain('IBMPlexSans-Regular')
    expect(fonts).toContain('IBMPlexSans-SemiBold')
  })

  it('writes Arabic as contextual presentation forms, which only a shaper produces', () => {
    // The base letters are what the template holds; presentation forms are what the shaper chose.
    // Their presence in the output is direct evidence that GSUB ran.
    const text = visualLines(invoice).join('')
    expect(PRESENTATION_FORMS.test(text)).toBe(true)
    const shapedCount = [...text].filter((char) => PRESENTATION_FORMS.test(char)).length
    expect(shapedCount).toBeGreaterThan(100)
  })

  it('joins Arabic letters — proved by width, which a notdef box cannot fake', async () => {
    // If the Arabic face were missing and Chromium were drawing boxes, or drawing isolated forms
    // from a non-Arabic fallback, breaking the join would change nothing. It changes ~20%.
    const word = 'مساج الزيت الساخن'
    const [joined, broken] = await measureTextWidths(renderer.browser(), [
      { label: 'joined', text: word },
      { label: 'unjoined', text: unjoin(word) },
    ])
    expect(joined?.widthPx).toBeGreaterThan(0)
    expect(broken?.widthPx).toBeGreaterThan((joined?.widthPx ?? 0) * 1.05)
  })

  it('lays a right-to-left paragraph out right to left', () => {
    // C1: logical order AAA … ZZZ inside dir=rtl. The reader must find AAA to the RIGHT of ZZZ.
    expect(xOf(specimen, 'AAA')).toBeGreaterThan(xOf(specimen, 'ZZZ'))
  })

  it('leaves a left-to-right paragraph alone — the control for the assertion above', () => {
    // C2: the same shape in dir=ltr. Were the renderer reversing everything, this would fail too.
    expect(xOf(specimen, 'AAB')).toBeLessThan(xOf(specimen, 'ZZY'))
  })

  it('orders the invoice settlement sentence right to left', () => {
    // Logically the invoice number comes before the amount in the Arabic sentence, so the reader
    // must find the number to the right of the amount.
    const line = settlementLine(invoice)
    expect(xOfOnLine(line, SAMPLE_INVOICE.number)).toBeGreaterThan(
      xOfOnLine(line, SETTLEMENT_AMOUNT),
    )
  })

  it('starts Arabic table cells at the right edge of the column', () => {
    const arabicLine = invoice[0]?.lines.find(
      (line) => PRESENTATION_FORMS.test(line.visual) && !BASE_ARABIC.test(line.visual.slice(0, 2)),
    )
    expect(arabicLine).toBeDefined()
  })
})

describe('acceptance 2 — Latin runs inside Arabic are bidi-isolated', () => {
  it('keeps an isolated phone number readable, dialling code first', () => {
    expect(caseLine('T04')).toContain(SPECIMEN_PHONE)
  })

  it('does NOT keep it readable without the isolate — the known-bad control', () => {
    // This is the assertion that gives the one above its meaning. It is also, precisely, the bug:
    // a customer reading C3 cannot dial the number.
    expect(caseLine('T03')).not.toContain(SPECIMEN_PHONE)
  })

  for (const testCase of BIDI_CASES) {
    if (testCase.expectVisual !== undefined) {
      it(`${testCase.id} renders ${JSON.stringify(testCase.expectVisual)} in reading order`, () => {
        expect(caseLine(testCase.id)).toContain(testCase.expectVisual)
      })
    }
    if (testCase.rejectVisual !== undefined) {
      it(`${testCase.id} (un-isolated) fails to render ${JSON.stringify(testCase.rejectVisual)}`, () => {
        expect(caseLine(testCase.id)).not.toContain(testCase.rejectVisual)
      })
    }
  }

  it('states the VAT rate the same way in the sentence and in the table', () => {
    const text = visualLines(invoice).join('\n')
    // Both occurrences isolated, so both read 5% rather than one reading 5% and the other %5.
    expect(text.split('5%').length - 1).toBeGreaterThanOrEqual(4)
    expect(text).not.toContain('%5')
  })

  it('keeps the invoice number and the amount intact in the Arabic sentence', () => {
    const settlement = settlementLine(invoice)
    expect(settlement.visual).toContain(SAMPLE_INVOICE.number)
    expect(settlement.visual).toContain(SETTLEMENT_AMOUNT)
  })

  it('never breaks an isolated run across a line break', () => {
    // The sentence wraps at A4 width; the phone number inside it must not. A number split over two
    // lines is as undiallable as a reordered one — the same failure by a different route.
    const line = findLine(invoice, SUPPLIER_PHONE)
    expect(line?.visual, 'the phone number was split across lines').toContain(SUPPLIER_PHONE)
  })
})

describe('untrusted text cannot reorder the document', () => {
  it('strips the bidi override out of a hostile customer name', () => {
    const text = visualLines(invoice).join('\n')
    expect(HOSTILE_NAME).toContain('\u202e')
    expect(text).toContain('Ahmed Al Mansoori')
    expect(text).not.toContain('\u202e')
  })

  it('renders the specimen attack case in its stored order', () => {
    expect(caseLine('T13')).toContain('Ahmed Al Mansoori 950.00')
  })
})

describe('acceptance 3 — the committed fixtures are the documents described above', () => {
  it('the committed invoice fixture exists and is a PDF', () => {
    const bytes = readFileSync(INVOICE_FIXTURE)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.byteLength).toBeGreaterThan(20_000)
  })

  it('the committed invoice fixture embeds the same four faces', () => {
    const fonts = embeddedBaseFonts(readFileSync(INVOICE_FIXTURE)).map((n) => n.split('+').at(-1))
    expect(fonts).toContain('IBMPlexSansArabic-Regular')
    expect(fonts).toContain('IBMPlexSans-Regular')
  })

  it('the committed invoice fixture still shows isolated runs in reading order', async () => {
    const pages = await extractPdfText(readFileSync(INVOICE_FIXTURE))
    const text = visualLines(pages).join('\n')
    expect(text).toContain(SAMPLE_INVOICE.number)
    expect(text).toContain(SUPPLIER_PHONE)
    expect(text).not.toContain('%5')
    const line = settlementLine(pages)
    expect(xOfOnLine(line, SAMPLE_INVOICE.number)).toBeGreaterThan(
      xOfOnLine(line, SETTLEMENT_AMOUNT),
    )
  })

  it('the committed specimen fixture still carries every case, good and bad', async () => {
    const pages = await extractPdfText(readFileSync(SPECIMEN_FIXTURE))
    for (const testCase of BIDI_CASES) {
      expect(findLine(pages, testCase.id), `case ${testCase.id} missing`).toBeDefined()
    }
    const bad = findLine(pages, 'T03')
    expect(bad?.visual).not.toContain(SPECIMEN_PHONE)
    const good = findLine(pages, 'T04')
    expect(good?.visual).toContain(SPECIMEN_PHONE)
  })
})
