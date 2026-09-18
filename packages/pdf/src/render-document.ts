/**
 * Issuing a document as bytes: build the view, render it, and — where a caller asks for a file — write
 * one only if both succeeded.
 *
 * The order is the whole content of this module. `buildTaxDocument` performs every refusal
 * (`TrnNotConfigured`, `DocumentFiguresDisagree`, `DocumentFormNotPermitted`) *before* Chromium is asked
 * for anything, so a refused document has no bytes and therefore cannot leave a partial file behind. A
 * renderer that wrote first and validated after would leave a document on disk carrying the Y1-trn
 * placeholder, and a file on disk is a file somebody emails.
 */

import { writeFileSync } from 'node:fs'
import {
  type ArabicFallbacks,
  buildTaxDocument,
  type DocumentForm,
  type StoredDocument,
  type TaxDocumentView,
} from '@berelax/core'
import { type DocumentLocale, renderTaxDocumentHtml } from './documents/tax-document.ts'
import { assertPdfWellFormed, type PageSetup, type PdfRenderer } from './render.ts'

export interface TaxDocumentRequest {
  /** The document as the repository returned it. Every printed figure is one of these columns. */
  readonly stored: StoredDocument
  readonly form: DocumentForm
  readonly locale: DocumentLocale
  /** Arabic the source tables cannot supply yet; see `ArabicFallbacks` in `@berelax/core`. */
  readonly arabic?: ArabicFallbacks
  readonly page?: PageSetup
}

/** The view a request resolves to, without rendering it. Used by the fixture script and the tests. */
export function taxDocumentView(request: TaxDocumentRequest): TaxDocumentView {
  return buildTaxDocument(request.stored, {
    form: request.form,
    ...(request.arabic === undefined ? {} : { arabic: request.arabic }),
  })
}

/** The HTML of one document, for a screen preview or for a renderer. */
export function taxDocumentHtml(request: TaxDocumentRequest): string {
  return renderTaxDocumentHtml(taxDocumentView(request), request.locale)
}

/** The PDF bytes of one document. Refuses before rendering; see the note at the top of this file. */
export async function renderTaxDocumentPdf(
  renderer: PdfRenderer,
  request: TaxDocumentRequest,
): Promise<Uint8Array> {
  const html = taxDocumentHtml(request)
  const bytes = await renderer.render(html, request.page)
  assertPdfWellFormed(bytes)
  return bytes
}

/**
 * The PDF bytes, written to `path`.
 *
 * Returns the bytes as well as writing them, so a caller that also has to store or hash the document
 * does not read its own write back. A refusal throws with nothing written at all.
 */
export async function writeTaxDocumentPdf(
  renderer: PdfRenderer,
  request: TaxDocumentRequest,
  path: string,
): Promise<Uint8Array> {
  const bytes = await renderTaxDocumentPdf(renderer, request)
  writeFileSync(path, bytes)
  return bytes
}
