/**
 * @berelax/pdf — generated documents.
 *
 * Renders HTML in headless Chromium so Arabic shaping and bidirectional layout are done by an
 * engine that already gets them right. See `render.ts` for why, and docs/adr/0011.
 */

export type { BidiCase } from './documents/bidi-specimen.ts'
export { BIDI_CASES, renderBidiSpecimenHtml } from './documents/bidi-specimen.ts'
export type { InvoiceLine, InvoiceParty, TaxInvoice } from './documents/invoice.ts'
export { INVOICE_LABELS, renderInvoiceHtml } from './documents/invoice.ts'
export { ARABIC_FAMILY, embeddedFontBytes, FONT_STACK, fontFaceCss, LATIN_FAMILY } from './fonts.ts'
export type { PageSetup, PdfRenderer } from './render.ts'
export { A4_DOCUMENT, assertPdfWellFormed, createPdfRenderer, embeddedBaseFonts } from './render.ts'
