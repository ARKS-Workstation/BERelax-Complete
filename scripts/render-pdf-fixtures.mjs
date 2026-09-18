#!/usr/bin/env node
/**
 * Regenerates the committed PDF fixtures and their PNG renders.
 *
 * Run it after changing a document template, then look at the PNGs before committing. That looking
 * is the point: the assertions in `rendering.itest.ts` catch shaping, order and isolation, and they
 * cannot catch a column that now wraps badly or a rule that vanished. A rendered document is
 * reviewed by eye or it is not reviewed.
 *
 * Generated PDFs are not byte-reproducible — Chromium writes a creation timestamp — so the tests
 * assert the fixtures structurally rather than diffing them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderBidiSpecimenHtml } from '../packages/pdf/src/documents/bidi-specimen.ts'
import { renderInvoiceHtml } from '../packages/pdf/src/documents/invoice.ts'
import { createPdfRenderer } from '../packages/pdf/src/render.ts'
import { SAMPLE_INVOICE } from '../packages/pdf/src/testing/sample-invoice.ts'

const OUT = join(import.meta.dirname, '..', 'packages', 'pdf', 'fixtures')
mkdirSync(OUT, { recursive: true })

const DOCUMENTS = [
  { name: 'tax-invoice-en-ar', html: renderInvoiceHtml(SAMPLE_INVOICE) },
  { name: 'bidi-specimen', html: renderBidiSpecimenHtml() },
]

const renderer = await createPdfRenderer()
try {
  for (const { name, html } of DOCUMENTS) {
    const pdf = await renderer.render(html)
    const png = await renderer.screenshot(html)
    writeFileSync(join(OUT, `${name}.pdf`), pdf)
    writeFileSync(join(OUT, `${name}.png`), png)
    console.log(`${name}: ${pdf.byteLength} bytes PDF, ${png.byteLength} bytes PNG`)
  }
} finally {
  await renderer.close()
}
