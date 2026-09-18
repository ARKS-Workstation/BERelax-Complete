/**
 * Test support for generated documents, behind one subpath.
 *
 * `@berelax/pdf/testing` rather than the package entry point, because none of it ships: it reads PDFs
 * back with `pdfjs-dist` (a devDependency), measures text in a live page, and carries fixture data.
 * Exposed at all because `packages/fixtures` is the package allowed to depend on both `@berelax/db` and
 * `@berelax/pdf`, which makes it the only place a test can prove that what the repository stored is what
 * the document prints — and it cannot do that without reading the PDF back.
 */

export type { PrintMargins } from './geometry.ts'
export { arabicVisualLines, isInk, measurePrintMargins } from './geometry.ts'
export type { PdfLine, PdfPageText, PdfTextItem } from './inspect.ts'
export {
  extractPdfText,
  findLine,
  findLineWithAll,
  visualLines,
  xOfOnLine,
} from './inspect.ts'
export type { Measurement } from './measure.ts'
export { measureTextWidths, unjoin, ZWNJ } from './measure.ts'
export {
  arabicFallbacksFor,
  COMMITTED_DOCUMENTS,
  ELEVEN_FILS_DOCUMENT,
  MIXED_RATE_DOCUMENT,
  OVERFLOW_PROBE_DOCUMENT,
  RECEIPT_DOCUMENT,
  SHAPED_FIXTURE_TRN,
  SIMPLIFIED_INVOICE_DOCUMENT,
  TAX_INVOICE_DOCUMENT,
} from './stored-documents.ts'
