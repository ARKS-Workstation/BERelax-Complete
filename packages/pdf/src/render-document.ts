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
import { AppError } from '@berelax/shared'
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
 * A byte store this module can hand a rendered document to, structurally.
 *
 * Declared here as the narrowest shape rather than imported from `@berelax/media`, and that is deliberate:
 * `@berelax/pdf` drives a browser and must not acquire a dependency on the media package to hand over an
 * array of bytes. `MediaStorage` satisfies it; so does a test double. It is the same argument
 * `PdfRenderer` makes one file along.
 */
export interface DocumentByteStore {
  put(request: {
    readonly bucket: 'private'
    readonly key: string
    readonly body: Uint8Array
    readonly contentType: string
    readonly cacheControl: string
  }): Promise<{ readonly sha256: string; readonly bytes: number }>
}

/** What a stored document is, in the terms the private-document register needs to be given. */
export interface StoredTaxDocument {
  readonly storageKey: string
  readonly contentSha256: string
  readonly bytes: number
  readonly contentType: string
}

/** Where a filed document lives inside the private bucket. One prefix, so the bucket is browsable. */
export const PRIVATE_DOCUMENTS_PREFIX = 'documents'

/**
 * The private-bucket key for one filed document.
 *
 * The display number and not the row id, because the bucket is a thing a person occasionally looks at and
 * `documents/tax_invoice/INV-2026-000123.pdf` is answerable where a uuid is not. Slashes and dots in a
 * display number are refused rather than escaped: a document number containing a path separator would write
 * outside its own prefix, and the store's own `[unsafe-object-key]` check is the second layer.
 */
export function privateDocumentKey(documentClass: string, displayNumber: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  if (!safe.test(documentClass) || !safe.test(displayNumber)) {
    throw new AppError(
      'validation',
      `[unsafe-document-key] '${documentClass}/${displayNumber}' is not a usable private-document key. A ` +
        'document number carrying a path separator would write outside its own prefix.',
      { details: { documentClass, displayNumber } },
    )
  }
  return `${PRIVATE_DOCUMENTS_PREFIX}/${documentClass}/${displayNumber}.pdf`
}

/**
 * Renders a document and puts it in the PRIVATE bucket. **This is the sanctioned producer path** (W-SYS-14).
 *
 * `writeTaxDocumentPdf` below writes to a path a caller chooses, which is the hole this unit exists to
 * close: a filed tax invoice on a filesystem path is readable by anybody who learns it, and nothing audits a
 * read. So production code takes this function, and
 * `scripts/check-private-documents.mjs` (`[private-document-must-not-be-written-to-a-caller-path]`) refuses
 * a call to `writeTaxDocumentPdf` from anywhere but a script or a test.
 *
 * It returns the receipt and registers NOTHING, and that split is on purpose. Registering means a row and an
 * `audit_event`, which means a transaction, which means `@berelax/db` — and `@berelax/pdf` driving a browser
 * has no business holding a connection. The caller does the two steps in order: this, then
 * `registerPrivateDocument`. A producer that stops after this one has written an unreachable document rather
 * than an unprotected one, which is the failure mode worth having.
 */
export async function storeTaxDocumentPdf(
  renderer: PdfRenderer,
  request: TaxDocumentRequest,
  store: DocumentByteStore,
  location: { readonly documentClass: string; readonly displayNumber: string },
): Promise<StoredTaxDocument> {
  const bytes = await renderTaxDocumentPdf(renderer, request)
  const key = privateDocumentKey(location.documentClass, location.displayNumber)
  const contentType = 'application/pdf'
  const receipt = await store.put({
    bucket: 'private',
    key,
    body: bytes,
    contentType,
    // `private, no-store`: a filed document is never cached by anything, because a cached copy is a copy
    // outside the register and therefore one no download is recorded for.
    cacheControl: 'private, no-store',
  })
  return {
    storageKey: key,
    contentSha256: receipt.sha256,
    bytes: receipt.bytes,
    contentType,
  }
}

/**
 * The PDF bytes, written to `path`.
 *
 * Returns the bytes as well as writing them, so a caller that also has to store or hash the document
 * does not read its own write back. A refusal throws with nothing written at all.
 *
 * ## For a fixture or a script, NOT for production (W-SYS-14)
 *
 * A document on a filesystem path is readable by anybody who learns the path and nothing records a read —
 * which is the hole W-SYS-14 was added for, and it is this function. It survives because
 * `scripts/render-pdf-fixtures.mjs` and the golden-comparison suite legitimately want bytes in a file they
 * can diff, and `scripts/check-private-documents.mjs` confines it to exactly those callers by rule
 * (`[private-document-must-not-be-written-to-a-caller-path]`). Production code takes
 * {@link storeTaxDocumentPdf}.
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
