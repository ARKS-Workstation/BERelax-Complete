#!/usr/bin/env node
/**
 * Regenerates the committed PDF fixtures, their PNG renders and the document golden.
 *
 * Run it after changing a document template, then look at the PNGs before committing. That looking is
 * the point: the assertions in `rendering.itest.ts` and `tax-document.itest.ts` catch shaping, order,
 * isolation, the mandatory fields, the figures and the margins in millimetres, and they cannot catch a
 * column that now wraps badly or a rule that vanished. A rendered document is reviewed by eye or it is
 * not reviewed.
 *
 * The golden — `tax-document-golden.json` — carries two things per document: every Arabic line as
 * displayed, which pins shaping and right-to-left order in one committed array, and the measured print
 * margins in millimetres. Both are asserted by the itest against a fresh render, so a template change
 * that moves either shows up in the diff of this file rather than in a customer's inbox.
 *
 * Generated PDFs are byte-reproducible apart from the `/CreationDate` and `/ModDate` Skia writes, which
 * is why the fixtures are asserted structurally rather than diffed byte for byte; the itest measures how
 * narrow that exception is.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderBidiSpecimenHtml } from '../packages/pdf/src/documents/bidi-specimen.ts'
import { renderInvoiceHtml } from '../packages/pdf/src/documents/invoice.ts'
import { PAYSLIP_LOCALES, renderPayslipHtml } from '../packages/pdf/src/documents/payslip.ts'
import { DOCUMENT_LOCALES } from '../packages/pdf/src/documents/tax-document.ts'
import { createPdfRenderer } from '../packages/pdf/src/render.ts'
import { taxDocumentHtml } from '../packages/pdf/src/render-document.ts'
import { arabicVisualLines, measurePrintMargins } from '../packages/pdf/src/testing/geometry.ts'
import { extractPdfText } from '../packages/pdf/src/testing/inspect.ts'
import { COMMITTED_PAYSLIP } from '../packages/pdf/src/testing/payslips.ts'
import { SAMPLE_INVOICE } from '../packages/pdf/src/testing/sample-invoice.ts'
import {
  arabicFallbacksFor,
  COMMITTED_DOCUMENTS,
} from '../packages/pdf/src/testing/stored-documents.ts'

const OUT = join(import.meta.dirname, '..', 'packages', 'pdf', 'fixtures')
mkdirSync(OUT, { recursive: true })

/** The F10 proof documents, unchanged: the RTL specimen and the template it was proved on. */
const SPECIMENS = [
  { name: 'tax-invoice-en-ar', html: renderInvoiceHtml(SAMPLE_INVOICE) },
  { name: 'bidi-specimen', html: renderBidiSpecimenHtml() },
]

/** M-TILL-12: three forms, two locales, one bilingual template. */
const DOCUMENTS = COMMITTED_DOCUMENTS.flatMap((document) =>
  DOCUMENT_LOCALES.map((locale) => ({
    name: `${document.name}-${locale}`,
    html: taxDocumentHtml({
      stored: document.stored,
      form: document.form,
      locale,
      arabic: arabicFallbacksFor(document.stored),
    }),
    golden: true,
  })),
)

/**
 * P-HR-12: one payslip, both locales.
 *
 * A SEPARATE golden file rather than more entries in `tax-document-golden.json`, and the reason is ownership
 * rather than tidiness: that file is asserted by `tax-document.itest.ts` over the documents M-TILL-12
 * committed, and adding to it would make this unit's fixture a thing that file's assertions walk. Two
 * goldens, two itests, and a template change in either unit diffs only its own.
 */
const PAYSLIPS = PAYSLIP_LOCALES.map((locale) => ({
  name: `payslip-${locale}`,
  html: renderPayslipHtml(COMMITTED_PAYSLIP, locale),
  payslipGolden: true,
}))

const renderer = await createPdfRenderer()
const golden = {}
const payslipGolden = {}
try {
  for (const { name, html, golden: record, payslipGolden: payslipRecord } of [
    ...SPECIMENS,
    ...DOCUMENTS,
    ...PAYSLIPS,
  ]) {
    const pdf = await renderer.render(html)
    const png = await renderer.screenshot(html)
    writeFileSync(join(OUT, `${name}.pdf`), pdf)
    writeFileSync(join(OUT, `${name}.png`), png)
    let note = ''
    if (payslipRecord === true) {
      const pages = await extractPdfText(pdf)
      const [page] = pages
      if (page === undefined) throw new Error(`${name} rendered no page`)
      const { leftMm, rightMm, topMm, bottomMm } = measurePrintMargins(page)
      payslipGolden[name] = {
        arabicLines: arabicVisualLines(pages),
        margins: { leftMm, rightMm, topMm, bottomMm },
      }
      note = ` — margins L${leftMm} R${rightMm} T${topMm} B${bottomMm} mm, ${payslipGolden[name].arabicLines.length} Arabic lines`
    }
    if (record === true) {
      const pages = await extractPdfText(pdf)
      const [page] = pages
      if (page === undefined) throw new Error(`${name} rendered no page`)
      const { leftMm, rightMm, topMm, bottomMm } = measurePrintMargins(page)
      golden[name] = {
        arabicLines: arabicVisualLines(pages),
        margins: { leftMm, rightMm, topMm, bottomMm },
      }
      note = ` — margins L${leftMm} R${rightMm} T${topMm} B${bottomMm} mm, ${golden[name].arabicLines.length} Arabic lines`
    }
    console.log(`${name}: ${pdf.byteLength} bytes PDF, ${png.byteLength} bytes PNG${note}`)
  }
} finally {
  await renderer.close()
}

writeFileSync(
  join(OUT, 'tax-document-golden.json'),
  `${JSON.stringify(
    {
      note:
        'Generated by scripts/render-pdf-fixtures.mjs. Per document: every Arabic line as displayed ' +
        '(Arabic Presentation Forms-B, in visual order, so the array pins shaping AND right-to-left ' +
        'order) and the measured print margins in millimetres. Asserted against a fresh render by ' +
        'packages/pdf/src/documents/tax-document.itest.ts.',
      documents: golden,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote tax-document-golden.json — ${Object.keys(golden).length} documents`)

writeFileSync(
  join(OUT, 'payslip-golden.json'),
  `${JSON.stringify(
    {
      note:
        'Generated by scripts/render-pdf-fixtures.mjs. Per payslip locale: every Arabic line as displayed ' +
        '(Arabic Presentation Forms-B, in visual order, so the array pins shaping AND right-to-left order) ' +
        'and the measured print margins in millimetres. Asserted against a fresh render by ' +
        'packages/pdf/src/documents/payslip.itest.ts. A separate file from tax-document-golden.json so a ' +
        'template change in either unit diffs only its own.',
      payslips: payslipGolden,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote payslip-golden.json — ${Object.keys(payslipGolden).length} payslips`)
