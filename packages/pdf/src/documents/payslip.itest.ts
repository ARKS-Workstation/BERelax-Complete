import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatAmount } from '@berelax/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPdfRenderer, type PdfRenderer } from '../render.ts'
import {
  arabicVisualLines,
  COMMITTED_PAYSLIP,
  CORRECTION_PAYSLIP,
  extractPdfText,
  findLine,
  findLineWithAll,
  measurePrintMargins,
  type PdfPageText,
  UNCONFIGURED_COMMISSION_PAYSLIP,
  visualLines,
  xOfOnLine,
} from '../testing/index.ts'
import {
  PAYSLIP_LABELS,
  PAYSLIP_LOCALES,
  type PayslipLocale,
  renderPayslipHtml,
} from './payslip.ts'

/**
 * P-HR-12 — the bilingual payslip, asserted on its BYTES.
 *
 * "A PDF was produced" proves nothing, and for Arabic it proves less than nothing: a document can contain
 * every correct codepoint while every glyph is a notdef box, and it can contain correctly shaped Arabic laid
 * out left to right. So every claim here is made about text extracted from the rendered PDF or about its
 * geometry, and each is paired with a control that must fail.
 *
 * ## The golden, and what one committed array pins
 *
 * `packages/pdf/fixtures/payslip-golden.json` carries, per locale, every Arabic line **as displayed** —
 * Arabic Presentation Forms-B, in the geometric order a reader's eye takes — and the measured print margins.
 * Presentation forms are the contextual shapes a shaper chooses and are never typed, so a document whose
 * Arabic was not shaped produces different strings; and the order is geometric, so a document laid out
 * left to right produces different strings too. One array, both claims, and a template change that broke
 * either shows up in the diff of that file rather than in somebody's payslip.
 *
 * It is a SEPARATE file from `tax-document-golden.json` because that one is M-TILL-12's and its itest walks
 * the documents that unit committed. Two goldens, two itests, and a template change in either diffs only its
 * own.
 *
 * ## Why an itest and not a unit test
 *
 * Shaping and bidi are Chromium's, and the whole point of ADR 0011 is that this build does not implement
 * either. A test that asserted against the HTML would assert that the template contains the right Arabic
 * STRING, which is the one thing that was never in doubt.
 */

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures')

interface Golden {
  readonly payslips: Record<
    string,
    {
      readonly arabicLines: readonly string[]
      readonly margins: {
        readonly leftMm: number
        readonly rightMm: number
        readonly topMm: number
        readonly bottomMm: number
      }
    }
  >
}

const golden = JSON.parse(readFileSync(join(FIXTURES, 'payslip-golden.json'), 'utf8')) as Golden

let renderer: PdfRenderer
/** One render per locale, reused by every case: Chromium is the slow part, not the assertions. */
const rendered = new Map<PayslipLocale, PdfPageText[]>()

beforeAll(async () => {
  renderer = await createPdfRenderer()
  for (const locale of PAYSLIP_LOCALES) {
    const pdf = await renderer.render(renderPayslipHtml(COMMITTED_PAYSLIP, locale))
    rendered.set(locale, await extractPdfText(pdf))
  }
}, 180_000)

afterAll(async () => {
  await renderer?.close()
})

const pagesFor = (locale: PayslipLocale): PdfPageText[] => {
  const pages = rendered.get(locale)
  if (pages === undefined) throw new Error(`no render for ${locale}`)
  return pages
}

describe('the Arabic is shaped and ordered, and the committed fixture says so', () => {
  it.each(PAYSLIP_LOCALES)('%s matches the committed Arabic lines exactly', (locale) => {
    const expected = golden.payslips[`payslip-${locale}`]
    expect(expected, `payslip-${locale} is missing from the golden`).toBeDefined()
    const lines = arabicVisualLines(pagesFor(locale))
    expect(lines).toEqual(expected?.arabicLines)
    // Vacuity: a document that rendered no Arabic at all would satisfy `toEqual([])` against an empty
    // golden, and a golden regenerated from a broken template would agree with itself.
    expect(lines.length).toBeGreaterThanOrEqual(20)
  })

  it('carries PRESENTATION FORMS and not the typed letters, which is what shaping means', () => {
    const lines = arabicVisualLines(pagesFor('ar'))
    const all = lines.join('')
    // Presentation Forms-B: the contextual shapes a shaper chooses. Never typed by a human, never present
    // in the template source.
    expect(/[ﹰ-ﻼ]/.test(all)).toBe(true)
    /*
      The control, and the assertion that actually catches an unshaped render: the template's own Arabic, in
      its typed form, must NOT appear. A renderer that drew the codepoints it was handed — which is what a
      pdfkit-class library does — would put this exact string in the output.
    */
    expect(all).not.toContain(PAYSLIP_LABELS.payslip.ar)
    expect(all).not.toContain(PAYSLIP_LABELS.netTotal.ar)
  })

  it('renders the Arabic title, in visual order, on the Arabic document', () => {
    // `قسيمة الراتب` shaped and reversed. Asserted against the GOLDEN's own first matching line rather than
    // against a transcription here, so this case cannot drift from the file that is reviewed by eye.
    const lines = arabicVisualLines(pagesFor('ar'))
    const fromGolden = golden.payslips['payslip-ar']?.arabicLines ?? []
    expect(lines[0]).toBe(fromGolden[0])
    expect(lines[0]).not.toBe('')
  })
})

describe('the document mirrors, in both directions — each locale is the other’s control', () => {
  it('puts the amount column on the trailing edge, which changes side with the language', () => {
    const en = findLineWithAll(pagesFor('en'), 'Net pay')
    const ar = findLineWithAll(pagesFor('ar'), formatAmount(COMMITTED_PAYSLIP.net))
    expect(en, 'the English net line was not found').toBeDefined()
    expect(ar, 'the Arabic net line was not found').toBeDefined()

    const netText = formatAmount(COMMITTED_PAYSLIP.net)
    const enLabelX = xOfOnLine(en as never, 'Net pay')
    const enAmountX = xOfOnLine(en as never, netText)
    // English: the label leads, the amount trails — so the amount is to the RIGHT of the label.
    expect(enAmountX).toBeGreaterThan(enLabelX)

    const arAmountX = xOfOnLine(ar as never, netText)
    // Arabic: the amount trails on the LEFT, so it sits in the left half of the page.
    const page = pagesFor('ar')[0]
    expect(page).toBeDefined()
    expect(arAmountX).toBeLessThan((page as PdfPageText).width / 2)
    // And the control in the other direction: in English the same amount is in the RIGHT half.
    expect(enAmountX).toBeGreaterThan((pagesFor('en')[0] as PdfPageText).width / 2)
  })

  it('leads with the Arabic title on the Arabic document and the English on the English one', () => {
    // A mirrored document is not one whose text has been translated. The heading swaps SIDE, which the
    // extracted geometry can see and a content assertion cannot.
    const enTitle = findLine(pagesFor('en'), 'Payslip')
    expect(enTitle).toBeDefined()
    const enX = xOfOnLine(enTitle as never, 'Payslip')
    const enWidth = (pagesFor('en')[0] as PdfPageText).width
    expect(enX).toBeLessThan(enWidth / 2)

    const arTitleLine = findLine(pagesFor('ar'), 'Payslip')
    expect(
      arTitleLine,
      'the English title should still appear as the secondary language',
    ).toBeDefined()
    const arX = xOfOnLine(arTitleLine as never, 'Payslip')
    expect(arX).toBeGreaterThan((pagesFor('ar')[0] as PdfPageText).width / 2)
  })
})

describe('every printed figure is the stored one, and a figure one fil out is not there', () => {
  it.each(PAYSLIP_LOCALES)('%s prints each component and the two totals', (locale) => {
    const text = visualLines(pagesFor(locale)).join('\n')
    for (const [name, amount] of [
      ['basic', COMMITTED_PAYSLIP.basic],
      ['allowances', COMMITTED_PAYSLIP.allowances],
      ['overtime', COMMITTED_PAYSLIP.overtime],
      ['commission', COMMITTED_PAYSLIP.commission],
      ['tips', COMMITTED_PAYSLIP.tips],
      ['gross', COMMITTED_PAYSLIP.gross],
      ['deductions', COMMITTED_PAYSLIP.deductions],
      ['net', COMMITTED_PAYSLIP.net],
    ] as const) {
      expect(text, `${name} is missing from the ${locale} payslip`).toContain(formatAmount(amount))
    }
  })

  it.each(PAYSLIP_LOCALES)('%s does NOT print a net one fil out, in either direction', (locale) => {
    // The control. `toContain` on the right figure would pass for a document that printed both.
    const text = visualLines(pagesFor(locale)).join('\n')
    const net = COMMITTED_PAYSLIP.net
    expect(text).not.toContain(formatAmount({ fils: (net.fils + 1) as never, currency: 'AED' }))
    expect(text).not.toContain(formatAmount({ fils: (net.fils - 1) as never, currency: 'AED' }))
  })

  it('states the currency once per column and never the Arabic abbreviation', () => {
    for (const locale of PAYSLIP_LOCALES) {
      const text = visualLines(pagesFor(locale)).join('\n')
      expect(text).toContain('AED')
      /*
        ADR 0011's measurement: `Intl.NumberFormat('ar-AE', { style: 'currency' })` wraps `د.إ.` in U+200F
        marks to hold it in place, `safeText` strips every bidi control because it cannot tell ICU's from an
        attacker's, and the two remaining letters then reorder inside the isolate — so the document would
        print the currency backwards. One notation per document, and it is the code.
      */
      expect(text).not.toContain('د.إ')
    }
  })

  it('carries NO VAT line, because a wage is not a supply', () => {
    for (const locale of PAYSLIP_LOCALES) {
      const text = visualLines(pagesFor(locale)).join('\n')
      // The sentence that says so is present, in both languages.
      expect(text).toContain('not a tax invoice')
      // And the control: nothing that reads as a VAT figure. `VAT` appears only inside that sentence.
      const vatMentions = text.split('\n').filter((line) => line.includes('VAT'))
      expect(vatMentions.length).toBeGreaterThan(0)
      for (const line of vatMentions) expect(line).toContain('not a tax invoice')
    }
  })
})

describe('the tip is a line of its own, which is the acceptance criterion', () => {
  it.each(PAYSLIP_LOCALES)(
    '%s prints tips beside its own amount, not folded into gross',
    (locale) => {
      const tips = formatAmount(COMMITTED_PAYSLIP.tips)
      const line = findLineWithAll(pagesFor(locale), tips)
      expect(line, `no line carries the tip amount in ${locale}`).toBeDefined()
      /*
        The line carrying the tip figure also carries the tip LABEL of that document's primary language.

        Per locale, and not one regex for both, because the first version of this case matched the TYPED
        Arabic and failed — correctly, and for the reason the shaping case above exists: the rendered line
        carries Presentation Forms-B, so the typed string is exactly what must NOT be there. The English
        document is asserted on the word; the Arabic on the presence of shaped Arabic plus the ABSENCE of
        the typed form, which is the strongest thing that can be said about a label without transcribing
        its shaped form into a second place that would then drift from the golden.
      */
      const visual = (line as never as { visual: string }).visual
      if (locale === 'en') {
        expect(visual).toContain('Tips')
      } else {
        expect(visual).toMatch(/[ﹰ-ﻼ]/u)
        expect(visual).not.toContain(PAYSLIP_LABELS.tips.ar)
      }
      /*
      The control that matters: tips folded into another line would still put the figure on the page. So the
      gross is asserted to be on a DIFFERENT line from the tip.
    */
      const grossLine = findLineWithAll(pagesFor(locale), formatAmount(COMMITTED_PAYSLIP.gross))
      expect(grossLine).toBeDefined()
      expect((grossLine as never as { y: number }).y).not.toBe((line as never as { y: number }).y)
    },
  )
})

describe('the payslip names what produced each figure, and says when nothing did', () => {
  it('prints the commission run and its rule version when one is pinned', () => {
    for (const locale of PAYSLIP_LOCALES) {
      const text = visualLines(pagesFor(locale)).join('\n')
      expect(text).toContain(COMMITTED_PAYSLIP.commissionRunId as string)
      expect(text).toContain(String(COMMITTED_PAYSLIP.commissionRuleVersion))
      expect(text).toContain(COMMITTED_PAYSLIP.timesheetApprovalId)
      expect(text).toContain(COMMITTED_PAYSLIP.workingHoursRuleEffectiveFrom)
    }
  })

  it('prints a SENTENCE and not a blank when no commission structure is configured', async () => {
    // The state the build actually ships in (Y9-commission). A blank cell reads as a figure nobody filled
    // in; the truth is that nothing is configured, and the document says which.
    const pdf = await renderer.render(renderPayslipHtml(UNCONFIGURED_COMMISSION_PAYSLIP, 'en'))
    const text = visualLines(await extractPdfText(pdf)).join('\n')
    expect(text).toContain('No commission structure is configured')
    // And the control: the pinned identifiers are absent, so this really is the other branch.
    expect(text).not.toContain(COMMITTED_PAYSLIP.commissionRunId as string)
    /*
      The version row is ABSENT rather than blank, which is the template's other branch and worth asserting
      separately: a label with nothing beside it reads as a field somebody failed to fill in, and there is
      no version to state when no run produced the figure.

      The first version of this case asserted the label PRESENT and its occurrences to be zero, which cannot
      both hold — a contradiction that only showed up when the case ran. Brief rule 3 from the other side: a
      control written without checking what the code actually does.
    */
    expect(text).not.toContain('Commission rule version')
    // And the label that IS there, so this is not passing because the provenance list vanished.
    expect(text).toContain('Commission run')
  }, 60_000)

  it('names the run it corrects, when it is a correction', async () => {
    const pdf = await renderer.render(renderPayslipHtml(CORRECTION_PAYSLIP, 'en'))
    const text = visualLines(await extractPdfText(pdf)).join('\n')
    expect(text).toContain('Correction of run')
    expect(text).toContain(CORRECTION_PAYSLIP.correctsRunId as string)
    // The control: the ordinary payslip does not claim to correct anything.
    expect(visualLines(pagesFor('en')).join('\n')).not.toContain('Correction of run')
  }, 60_000)
})

describe('the printed page has the margins it declares', () => {
  it.each(PAYSLIP_LOCALES)('%s matches the committed margins', (locale) => {
    const page = pagesFor(locale)[0]
    expect(page).toBeDefined()
    const measured = measurePrintMargins(page as PdfPageText)
    const expected = golden.payslips[`payslip-${locale}`]?.margins
    expect(expected).toBeDefined()
    for (const edge of ['leftMm', 'rightMm', 'topMm', 'bottomMm'] as const) {
      // A tenth of a millimetre is below what a printer can hold, and the measurement is to two decimals.
      expect(measured[edge], `${edge} on ${locale}`).toBeCloseTo(expected?.[edge] as number, 1)
    }
    // And the declared side margins are actually held: A4_DOCUMENT declares 18mm, the ink stops within a
    // fifth of a millimetre of it, and a column that overflowed would be the first thing anybody noticed.
    expect(measured.leftMm).toBeGreaterThan(17.5)
    expect(measured.rightMm).toBeGreaterThan(17.5)
    // Vacuity: a page that lost its content would report perfect margins over no ink at all.
    expect(measured.inkItems).toBeGreaterThan(50)
  })
})
