/**
 * Reads a generated PDF back with a second, independent implementation.
 *
 * Chromium wrote the document; pdf.js reads it. Using the same engine to check its own output would
 * prove nothing about the bytes, only about the object graph in memory. Two implementations
 * disagreeing is a finding; two implementations agreeing on shaped Arabic glyphs and their positions
 * is as close to "this document is correct" as an automated check gets.
 *
 * ## Visual order is the ground truth
 *
 * A PDF content stream positions glyph runs; it has no notion of logical order. Reading the strings
 * in stream order and concatenating them gives roughly what the eye sees, but only roughly, because
 * a renderer is free to emit runs in any order it likes. So this module sorts the extracted items
 * geometrically — down the page, then left to right — and that reconstruction is what the RTL and
 * isolation assertions are made against. It is the one representation that cannot be argued with:
 * if the reconstruction says the `+` is to the right of the digits, that is what a reader sees.
 *
 * Test support. Not exported from the package, and `pdfjs-dist` is a devDependency.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfTextItem {
  readonly text: string
  /** Page coordinates: x increases rightwards, y increases downwards from the top edge. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fontName: string
}

export interface PdfLine {
  /** Items on this line, ordered left to right — the order a reader's eye takes. */
  readonly items: readonly PdfTextItem[]
  /** Those items concatenated, i.e. the line as displayed. */
  readonly visual: string
  readonly y: number
}

export interface PdfPageText {
  readonly items: readonly PdfTextItem[]
  readonly lines: readonly PdfLine[]
  readonly width: number
  readonly height: number
}

/** Items within this many points of each other vertically are on the same line. */
const LINE_TOLERANCE = 3

interface RawItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
}

function toItem(raw: RawItem, pageHeight: number): PdfTextItem | undefined {
  const text = raw.str
  const transform = raw.transform
  if (text === undefined || text === '' || transform === undefined) return undefined
  const x = transform[4]
  const yFromBottom = transform[5]
  if (x === undefined || yFromBottom === undefined) return undefined
  return {
    text,
    x,
    // PDF user space has its origin at the bottom-left. Flip it so "first line" means smallest y,
    // which is what every sort below assumes.
    y: pageHeight - yFromBottom,
    width: raw.width ?? 0,
    height: raw.height ?? 0,
    fontName: raw.fontName ?? '',
  }
}

function groupIntoLines(items: readonly PdfTextItem[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: PdfTextItem[][] = []
  for (const item of sorted) {
    const last = lines.at(-1)
    const anchor = last?.[0]
    if (
      last !== undefined &&
      anchor !== undefined &&
      Math.abs(item.y - anchor.y) <= LINE_TOLERANCE
    ) {
      last.push(item)
    } else {
      lines.push([item])
    }
  }
  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x - b.x)
    return {
      items: ordered,
      visual: ordered.map((item) => item.text).join(''),
      y: ordered[0]?.y ?? 0,
    }
  })
}

/** Extracts every page's text items and their geometric reconstruction. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfPageText[]> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
  const document = await task.promise
  try {
    const pages: PdfPageText[] = []
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items = (content.items as RawItem[])
        .map((raw) => toItem(raw, viewport.height))
        .filter((item): item is PdfTextItem => item !== undefined)
      pages.push({
        items,
        lines: groupIntoLines(items),
        width: viewport.width,
        height: viewport.height,
      })
    }
    return pages
  } finally {
    // The loading task owns the worker; destroying the document alone leaks it and vitest hangs.
    await task.destroy()
  }
}

/** The visual text of every line on every page, in reading order. */
export function visualLines(pages: readonly PdfPageText[]): string[] {
  return pages.flatMap((page) => page.lines.map((line) => line.visual))
}

/** The first line whose visual text contains `needle`, or undefined. */
export function findLine(pages: readonly PdfPageText[], needle: string): PdfLine | undefined {
  return findLineWithAll(pages, needle)
}

/**
 * The first line whose visual text contains every needle.
 *
 * Needed because one string is often not a unique address in a real document: an invoice number
 * appears in the header field *and* in the settlement sentence, and asserting the reading order of
 * the sentence against the header row compares two unrelated things. Two needles pin the line.
 */
export function findLineWithAll(
  pages: readonly PdfPageText[],
  ...needles: readonly string[]
): PdfLine | undefined {
  for (const page of pages) {
    for (const line of page.lines) {
      if (needles.every((needle) => line.visual.includes(needle))) return line
    }
  }
  return undefined
}

/**
 * The left edge at which a reader first finds `needle` on this line.
 *
 * The line's items are already in visual order, so this walks them accumulating text and returns the
 * x of the item that first completes the needle.
 */
export function xOfOnLine(line: PdfLine, needle: string): number {
  let accumulated = ''
  for (const item of line.items) {
    accumulated += item.text
    if (accumulated.includes(needle)) return item.x
  }
  return Number.NaN
}
