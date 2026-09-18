/**
 * The margins a rendered page actually has, measured from the PDF rather than declared in CSS.
 *
 * A declared margin is an intention. What a reader sees is where the ink stops, and the two part company
 * the moment a table column, a flex row or an unbreakable figure is wider than the space left for it —
 * which is the failure this module exists to catch, because it is the first thing anybody notices about
 * a printed document and the last thing a content assertion can see.
 *
 * ## Whitespace-only runs are not ink, and ignoring them is the whole trick
 *
 * Measured on the committed F10 invoice, the naive bounding box of every text item reports a right
 * margin of **5.58mm** against a declared 18mm — and the document is fine. The two offending items are
 * space-only runs 79mm and 147mm wide that Chromium emits at the end of flex content: they position
 * nothing a reader can see. Excluding them gives 17.80mm, which is the real figure and matches the
 * declaration. A measurement that counted them would have condemned a correct document, and a
 * measurement that trimmed the bounding box some other way would have hidden a real overflow.
 *
 * Test support. Not part of the package's runtime surface.
 */
import type { PdfPageText, PdfTextItem } from './inspect.ts'

const PT_PER_MM = 72 / 25.4

/** Millimetres, to two decimals — a tenth of a millimetre is below what a printer can hold anyway. */
const mm = (points: number): number => Math.round((points / PT_PER_MM) * 100) / 100

/** True when the item puts marks on the page. A run of spaces does not. */
export function isInk(item: PdfTextItem): boolean {
  return item.text.trim() !== ''
}

export interface PrintMargins {
  readonly pageWidthMm: number
  readonly pageHeightMm: number
  /** Distance from the left trim to the leftmost ink. */
  readonly leftMm: number
  readonly rightMm: number
  readonly topMm: number
  readonly bottomMm: number
  /** How many items were measured, so a page that lost its content cannot report perfect margins. */
  readonly inkItems: number
}

/**
 * The ink box of one page, as margins in millimetres.
 *
 * `top` is measured to the top of the first line's em box (`y - height`) rather than to its baseline,
 * because a baseline is not where a reader sees the text start. That makes the top figure about a
 * millimetre and a half larger than the declared margin for 9.5pt text, which is the ascent the em box
 * carries above the cap height — expected, and why the assertions check a band rather than an equality.
 */
export function measurePrintMargins(page: PdfPageText): PrintMargins {
  const items = page.items.filter(isInk)
  if (items.length === 0) {
    throw new Error('measurePrintMargins: the page carries no ink, so it has no margins to measure')
  }
  let left = Number.POSITIVE_INFINITY
  let right = 0
  let top = Number.POSITIVE_INFINITY
  let bottom = 0
  for (const item of items) {
    left = Math.min(left, item.x)
    right = Math.max(right, item.x + item.width)
    top = Math.min(top, item.y - item.height)
    bottom = Math.max(bottom, item.y)
  }
  return {
    pageWidthMm: mm(page.width),
    pageHeightMm: mm(page.height),
    leftMm: mm(left),
    rightMm: mm(page.width - right),
    topMm: mm(top),
    bottomMm: mm(page.height - bottom),
    inkItems: items.length,
  }
}

/**
 * Every Arabic line of a document, as displayed.
 *
 * The strings carry Arabic Presentation Forms-B — the contextual shapes a shaper chooses, never typed
 * directly — in the geometric order a reader's eye takes, so one committed array pins both shaping and
 * right-to-left order. A template change that broke either produces a different array.
 */
const PRESENTATION_FORMS = /[\ufe70-\ufefc]/

export function arabicVisualLines(pages: readonly PdfPageText[]): string[] {
  return pages
    .flatMap((page) => page.lines)
    .map((line) => line.visual)
    .filter((visual) => PRESENTATION_FORMS.test(visual))
}
