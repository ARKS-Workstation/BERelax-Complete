import { bdi, filsFrom, formatAmount, type Money, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { FONT_STACK, fontFaceCss } from '../fonts.ts'

/**
 * The bilingual payslip, in either language, on one template.
 *
 * ## Why a payslip is bilingual at all, and why it is not a tax document
 *
 * docs/04 §4's Arabic-language requirement is about tax invoices, and a payslip is not one — a wage is not a
 * supply and carries no VAT (ADR 0007's estate does not apply, and there is no VAT line anywhere below). The
 * reason this document is bilingual is the reader: a therapist disputing a figure has to be able to read the
 * figures, and the workforce this is for reads Arabic and English in unknown proportions (`Y8-staff`). A
 * document somebody cannot read is a document they cannot dispute, which is worse than a wrong one.
 *
 * It follows `tax-document.ts`'s conventions exactly rather than inventing its own, and the conventions are
 * that file's to explain. In brief, and each one has already cost a real defect there:
 *
 *   - **Locale is a DIRECTION, not a translation.** `<html dir>` is `rtl` for `ar` so the whole page mirrors;
 *     every horizontal offset is a logical property or `var(--leading)`, never `left`/`right`.
 *   - **`--leading` is computed from the locale and not `text-align: start`.** A block carrying its own `dir`
 *     resolves `start` against ITS OWN direction, so the Arabic half of a pair flies to the other edge and
 *     the two languages read as two documents. Measured in Chromium, on that template.
 *   - **Latin numerals in both scripts**, every figure isolated with `<bdi>` at the point of use, because a
 *     Latin run in an Arabic line reorders without one.
 *   - **`AED` once per column, never `د.إ.`** ADR 0011 records the measurement: ICU wraps the Arabic
 *     abbreviation in U+200F marks to hold it in place, `safeText` strips every bidi control because it
 *     cannot tell ICU's from an attacker's, and the two remaining letters then reorder inside the isolate —
 *     so the document would print the currency backwards.
 *   - **Arabic body copy at weight 400**, because 400 and 600 are the cuts `fonts.ts` embeds and a request
 *     for 500 resolves DOWNWARDS to 400. `scripts/check-tax-documents.mjs` fails the build on a weight the
 *     Arabic face does not ship, and it scans this directory.
 *   - **No direction marks.** RTL comes from `dir`, isolation from `<bdi>`; a LRM written into a template
 *     survives into the extracted text and a reader copies it out with the amount.
 *
 * ## This module performs no arithmetic, and that is enforced rather than intended
 *
 * Every figure printed is a column of `payslip`, and the gross and the net are GENERATED columns of it
 * (migration 0104). So there is no path from a template edit to a figure that disagrees with the database —
 * the failure `check-tax-documents.mjs`'s first rule exists for, which forbids a document module from
 * importing the tax derivations for the same reason.
 *
 * What it does state, in words, is the PROVENANCE: the commission run and rule version, the timesheet
 * approval, and the rule versions those pinned. That is the difference between a payslip and a printout of a
 * total — a figure somebody can go and check, rather than a figure they can only accept.
 */

/** Both locales, as a list. The fixture script, the geometry measurement and the itest all iterate it. */
export const PAYSLIP_LOCALES = ['en', 'ar'] as const

/** The primary language of a payslip. Both appear on every document; this one leads. */
export type PayslipLocale = (typeof PAYSLIP_LOCALES)[number]

interface Label {
  readonly en: string
  readonly ar: string
}

/**
 * Every string on the page, in both languages, in one object.
 *
 * Exported so a test asserts against the same strings the document renders rather than against its own
 * transcription of them — a test carrying its own copy of a label passes while the document says something
 * else. `tax-document.ts` exports `DOCUMENT_LABELS` for the same reason and its itest depends on it.
 */
export const PAYSLIP_LABELS = {
  payslip: { en: 'Payslip', ar: 'قسيمة الراتب' },
  notATaxInvoice: {
    en: 'This is a statement of wages. It is not a tax invoice and carries no VAT.',
    ar: 'هذا بيان أجور، وليس فاتورة ضريبية ولا يشمل ضريبة القيمة المضافة.',
  },
  employee: { en: 'Employee', ar: 'الموظف' },
  staffReference: { en: 'Staff reference', ar: 'الرقم الوظيفي' },
  period: { en: 'Pay period', ar: 'فترة الأجر' },
  runCompletedOn: { en: 'Payroll completed', ar: 'اكتمال الرواتب' },
  earnings: { en: 'Earnings', ar: 'المستحقات' },
  basic: { en: 'Basic wage', ar: 'الراتب الأساسي' },
  allowances: { en: 'Allowances', ar: 'البدلات' },
  overtime: { en: 'Overtime uplift', ar: 'بدل العمل الإضافي' },
  commission: { en: 'Commission', ar: 'العمولة' },
  tips: { en: 'Tips', ar: 'الإكراميات' },
  grossTotal: { en: 'Total earnings', ar: 'إجمالي المستحقات' },
  deductions: { en: 'Deductions', ar: 'الاستقطاعات' },
  netTotal: { en: 'Net pay', ar: 'صافي الأجر' },
  amount: { en: 'Amount', ar: 'المبلغ' },
  howItWasWorkedOut: { en: 'How this was worked out', ar: 'كيف تم حساب ذلك' },
  payableMinutes: { en: 'Approved payable minutes', ar: 'الدقائق المعتمدة المستحقة' },
  overtimeUplift: { en: 'Uplift basis-point-minutes', ar: 'دقائق العلاوة بنقاط الأساس' },
  commissionRun: { en: 'Commission run', ar: 'دورة العمولة' },
  commissionVersion: { en: 'Commission rule version', ar: 'إصدار قاعدة العمولة' },
  noCommission: { en: 'No commission structure is configured', ar: 'لا يوجد هيكل عمولة مُعد' },
  timesheetApproval: { en: 'Timesheet approval', ar: 'اعتماد سجل الدوام' },
  workingHoursRule: { en: 'Working-hours rule version', ar: 'إصدار قاعدة ساعات العمل' },
  wageDivisorRule: { en: 'Wage divisor version', ar: 'إصدار مُقسِّم الراتب' },
  correctionOf: { en: 'Correction of run', ar: 'تصحيح للدورة' },
  queries: {
    en: 'If any figure here is wrong, raise it before the next payroll: a completed run is never edited, and a correction is a new dated run.',
    ar: 'إذا كان أي رقم هنا غير صحيح، فأبلغ عنه قبل الرواتب القادمة: الدورة المكتملة لا تُعدَّل أبدًا، والتصحيح يكون بدورة جديدة بتاريخ جديد.',
  },
} satisfies Record<string, Label>

/** The currency code, stated once per numeric column. Isolated wherever it appears. */
const CURRENCY_CODE = 'AED'

/**
 * One payslip as the document prints it. Every field is a column of `payslip` or of `payslip_detail`.
 *
 * Figures are `Money` and not raw fils, so the one place a figure becomes a string is `formatAmount` — and
 * there is no division in this module for a reader to check.
 */
export interface PayslipView {
  readonly staffReference: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly runCompletedOn: string | null
  readonly basic: Money
  readonly allowances: Money
  readonly overtime: Money
  readonly commission: Money
  readonly tips: Money
  readonly gross: Money
  readonly deductions: Money
  readonly net: Money
  readonly payableMinutes: number
  readonly overtimeUpliftMinuteBp: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly timesheetApprovalId: string
  readonly workingHoursRuleEffectiveFrom: string
  readonly wageDivisorRuleEffectiveFrom: string
  readonly correctsRunId: string | null
}

/** A payslip row as `payslip_detail` returns it, in fils. Converted here so the view is `Money`. */
export interface PayslipRowLike {
  readonly staffReference: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly runCompletedAt: Date | null
  readonly basicFils: number
  readonly allowancesFils: number
  readonly overtimeFils: number
  readonly commissionFils: number
  readonly tipsFils: number
  readonly grossFils: number
  readonly deductionsFils: number
  readonly netFils: number
  readonly payableMinutes: number
  readonly overtimeUpliftMinuteBp: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly timesheetApprovalId: string
  readonly workingHoursRuleEffectiveFrom: string
  readonly labourCostRuleEffectiveFrom: string
  readonly correctsRunId?: string | null
}

const money = (fils: number): Money => ({ fils: filsFrom(fils), currency: 'AED' })

/**
 * A stored row as the view the template takes.
 *
 * A function and not a spread at the call site, so the fils-to-`Money` conversion happens once. `filsFrom`
 * refuses a non-integer, which is where a figure that had been through a float would stop — and it would stop
 * here rather than printing 749.99500000001 on somebody's payslip.
 */
export function payslipView(row: PayslipRowLike): PayslipView {
  return {
    staffReference: row.staffReference,
    periodStartsOn: row.periodStartsOn,
    periodEndsOn: row.periodEndsOn,
    // ISO, and sliced from the instant rather than formatted: `18/09/2026` and `09/18/2026` are the same
    // eleven characters and a different date, which `tax-document.ts` says about a tax point and is equally
    // true of the day a wage was paid.
    runCompletedOn:
      row.runCompletedAt === null ? null : row.runCompletedAt.toISOString().slice(0, 10),
    basic: money(row.basicFils),
    allowances: money(row.allowancesFils),
    overtime: money(row.overtimeFils),
    commission: money(row.commissionFils),
    tips: money(row.tipsFils),
    gross: money(row.grossFils),
    deductions: money(row.deductionsFils),
    net: money(row.netFils),
    payableMinutes: row.payableMinutes,
    overtimeUpliftMinuteBp: row.overtimeUpliftMinuteBp,
    commissionRunId: row.commissionRunId,
    commissionRuleVersion: row.commissionRuleVersion,
    timesheetApprovalId: row.timesheetApprovalId,
    workingHoursRuleEffectiveFrom: row.workingHoursRuleEffectiveFrom,
    wageDivisorRuleEffectiveFrom: row.labourCostRuleEffectiveFrom,
    correctsRunId: row.correctsRunId ?? null,
  }
}

const other = (locale: PayslipLocale): PayslipLocale => (locale === 'ar' ? 'en' : 'ar')
const dirOf = (locale: PayslipLocale): 'ltr' | 'rtl' => (locale === 'ar' ? 'rtl' : 'ltr')

/**
 * A bilingual pair: the primary language, then the secondary beneath it in its own direction.
 *
 * `dir` and `lang` on BOTH spans unconditionally, including when the secondary is English inside an Arabic
 * document. `tax-document.ts` records what leaving them off the English side did: an RTL document laid a
 * Latin block out right to left — correct per UAX #9, and not what an address or a reference is.
 */
function pair(label: Label, locale: PayslipLocale, className = ''): string {
  const secondary = other(locale)
  const classes = className === '' ? '' : ` ${className}`
  return [
    `<span class="primary lang-${locale}${classes}" dir="${dirOf(locale)}" lang="${locale}">`,
    safeText(label[locale]),
    '</span>',
    `<span class="secondary lang-${secondary}${classes}" dir="${dirOf(secondary)}" lang="${secondary}">`,
    safeText(label[secondary]),
    '</span>',
  ].join('')
}

/** One row of the figures table: a bilingual label and one isolated amount. */
function figureRow(label: Label, locale: PayslipLocale, amount: Money, className = ''): string {
  return [
    `<tr class="${className}">`,
    `<th scope="row">${pair(label, locale)}</th>`,
    `<td class="amount">${bdi(formatAmount(amount), 'ltr')}</td>`,
    '</tr>',
  ].join('')
}

/** One row of the provenance list: a bilingual label and an isolated value, or a bilingual sentence. */
function provenanceRow(label: Label, locale: PayslipLocale, value: string | null): string {
  const rendered =
    value === null
      ? `<span class="absent">${pair(PAYSLIP_LABELS.noCommission, locale)}</span>`
      : bdi(value, 'ltr')
  return `<div class="prov-row"><span class="prov-label">${pair(label, locale)}</span><span class="prov-value">${rendered}</span></div>`
}

function styles(locale: PayslipLocale): string {
  return `
${fontFaceCss()}
${tokensCss()}

@page { size: A4; }

/* A printed document is always light: paper has no dark mode, and a headless renderer's
   prefers-color-scheme follows whatever the container reports. tax-document.ts's words. */
:root {
  color-scheme: light;
  /* The leading edge as a PHYSICAL value, computed from the locale. See the module header for the
     measurement: text-align: start resolves against the element's own dir, which splits a bilingual pair
     across the page. */
  --leading: ${locale === 'ar' ? 'right' : 'left'};
  --trailing: ${locale === 'ar' ? 'left' : 'right'};
}

* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

body {
  /* Zero: the page margins are Chromium's, from A4_DOCUMENT in render.ts, so a body padding here would add
     to them invisibly and the document would print with margins nobody declared. */
  margin: 0;
  font-family: ${FONT_STACK};
  font-size: 9pt;
  line-height: 1.45;
  color: var(--color-ink);
  text-align: var(--leading);
}

/* Arabic reads optically smaller than Latin at the same point size, and is never tracked or uppercased.
   Weight 400 because 400 and 600 are the cuts fonts.ts embeds: a request for 500 resolves DOWNWARDS to 400
   and the declaration would be a lie. check-tax-documents.mjs fails the build on any other weight here. */
[lang='ar'] {
  font-size: 1.06em;
  line-height: 1.6;
  letter-spacing: 0;
  text-transform: none;
  font-weight: 400;
}
[lang='ar'] strong { font-weight: 600; }

.secondary { color: var(--color-ink-2); }
.primary, .secondary { display: block; }

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12pt;
  border-bottom: 1.5pt solid var(--color-ink);
  padding-bottom: 5pt;
  margin-bottom: 9pt;
}
header .what .primary { font-size: 16pt; font-weight: 600; }
header .what .secondary { font-size: 13pt; }
header .who { text-align: var(--trailing); }
header .who .primary { font-size: 11pt; font-weight: 600; }

.meta { display: flex; gap: 16pt; margin-bottom: 10pt; }
.meta-field { flex: 1; min-width: 0; }
.meta-label { display: block; font-size: 7.5pt; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-ink-2); }
.meta-field .meta-label[lang='ar'] { text-transform: none; letter-spacing: 0; font-size: 8pt; }
.meta-value { display: block; font-size: 10pt; }

table { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
caption {
  text-align: var(--leading);
  font-size: 10pt;
  font-weight: 600;
  padding-bottom: 3pt;
}
th, td { padding: 3pt 0; vertical-align: top; }
th[scope='row'] { text-align: var(--leading); font-weight: 400; }
thead th { border-bottom: 0.75pt solid var(--color-ink-2); font-size: 7.5pt; letter-spacing: 0.07em; text-transform: uppercase; }
thead th[lang='ar'] { text-transform: none; letter-spacing: 0; }
/* The amount column changes side with the document, which is the mirroring the itest measures in both
   directions — a mirrored document is not one whose text has been translated. */
.amount { text-align: var(--trailing); font-variant-numeric: tabular-nums; white-space: nowrap; }
thead .amount { text-align: var(--trailing); }
tr.total th, tr.total td { border-top: 0.75pt solid var(--color-ink); font-weight: 600; padding-top: 4pt; }
tr.net th, tr.net td { border-top: 1.5pt solid var(--color-ink); font-size: 11pt; font-weight: 600; padding-top: 5pt; }

.provenance { border-top: 0.75pt solid var(--color-ink-2); padding-top: 6pt; }
.provenance > .caption { font-size: 10pt; font-weight: 600; padding-bottom: 3pt; }
.prov-row { display: flex; gap: 8pt; padding: 1.5pt 0; }
.prov-label { flex: 0 0 45%; font-size: 8pt; color: var(--color-ink-2); }
.prov-value { flex: 1; min-width: 0; font-size: 8pt; word-break: break-all; }
.absent { font-style: normal; }

footer { margin-top: 9pt; border-top: 0.75pt solid var(--color-ink-2); padding-top: 5pt; font-size: 8pt; color: var(--color-ink-2); }
`
}

/**
 * The HTML of one payslip, for a screen preview or for the renderer.
 *
 * Deliberately one payslip per document rather than a run per document. A payslip is a PRIVATE document: it
 * goes to one person, and a run of nineteen in one PDF is nineteen people's pay in one file that anybody
 * with the file has all of. W-SYS-14 owns the storage and the signed URL; this owns the boundary that makes
 * a per-person URL possible at all.
 */
export function renderPayslipHtml(payslip: PayslipView, locale: PayslipLocale = 'en'): string {
  const period = `${payslip.periodStartsOn} — ${payslip.periodEndsOn}`
  const meta = [
    `<div class="meta-field"><span class="meta-label" dir="${dirOf(locale)}" lang="${locale}">${safeText(PAYSLIP_LABELS.period[locale])}</span><span class="meta-label" dir="${dirOf(other(locale))}" lang="${other(locale)}">${safeText(PAYSLIP_LABELS.period[other(locale)])}</span><span class="meta-value">${bdi(period, 'ltr')}</span></div>`,
    `<div class="meta-field"><span class="meta-label" dir="${dirOf(locale)}" lang="${locale}">${safeText(PAYSLIP_LABELS.staffReference[locale])}</span><span class="meta-label" dir="${dirOf(other(locale))}" lang="${other(locale)}">${safeText(PAYSLIP_LABELS.staffReference[other(locale)])}</span><span class="meta-value">${bdi(payslip.staffReference, 'ltr')}</span></div>`,
    ...(payslip.runCompletedOn === null
      ? []
      : [
          `<div class="meta-field"><span class="meta-label" dir="${dirOf(locale)}" lang="${locale}">${safeText(PAYSLIP_LABELS.runCompletedOn[locale])}</span><span class="meta-label" dir="${dirOf(other(locale))}" lang="${other(locale)}">${safeText(PAYSLIP_LABELS.runCompletedOn[other(locale)])}</span><span class="meta-value">${bdi(payslip.runCompletedOn, 'ltr')}</span></div>`,
        ]),
  ].join('')

  const figures = [
    figureRow(PAYSLIP_LABELS.basic, locale, payslip.basic),
    figureRow(PAYSLIP_LABELS.allowances, locale, payslip.allowances),
    figureRow(PAYSLIP_LABELS.overtime, locale, payslip.overtime),
    figureRow(PAYSLIP_LABELS.commission, locale, payslip.commission),
    // Its own line, always, and that is the acceptance criterion: a tip folded into the gross would be
    // indistinguishable from wages, and a tip is somebody else's money the salon is passing on.
    figureRow(PAYSLIP_LABELS.tips, locale, payslip.tips, 'tips'),
    figureRow(PAYSLIP_LABELS.grossTotal, locale, payslip.gross, 'total'),
    figureRow(PAYSLIP_LABELS.deductions, locale, payslip.deductions),
    figureRow(PAYSLIP_LABELS.netTotal, locale, payslip.net, 'net'),
  ].join('')

  const provenance = [
    provenanceRow(PAYSLIP_LABELS.payableMinutes, locale, String(payslip.payableMinutes)),
    provenanceRow(PAYSLIP_LABELS.overtimeUplift, locale, String(payslip.overtimeUpliftMinuteBp)),
    provenanceRow(PAYSLIP_LABELS.timesheetApproval, locale, payslip.timesheetApprovalId),
    provenanceRow(PAYSLIP_LABELS.workingHoursRule, locale, payslip.workingHoursRuleEffectiveFrom),
    provenanceRow(PAYSLIP_LABELS.wageDivisorRule, locale, payslip.wageDivisorRuleEffectiveFrom),
    // Null prints the bilingual "no commission structure is configured" rather than a blank: a blank cell
    // reads as a figure nobody filled in, and the truth is that Y9-commission is unanswered and the module
    // ships disabled. The document says which.
    provenanceRow(PAYSLIP_LABELS.commissionRun, locale, payslip.commissionRunId),
    ...(payslip.commissionRuleVersion === null
      ? []
      : [
          provenanceRow(
            PAYSLIP_LABELS.commissionVersion,
            locale,
            String(payslip.commissionRuleVersion),
          ),
        ]),
    ...(payslip.correctsRunId === null
      ? []
      : [provenanceRow(PAYSLIP_LABELS.correctionOf, locale, payslip.correctsRunId)]),
  ].join('')

  return `<!doctype html>
<html lang="${locale}" dir="${dirOf(locale)}">
<head>
<meta charset="utf-8">
<title>${safeText(PAYSLIP_LABELS.payslip[locale])} ${safeText(payslip.staffReference)} ${safeText(period)}</title>
<style>${styles(locale)}</style>
</head>
<body>
<header>
<div class="what">${pair(PAYSLIP_LABELS.payslip, locale)}</div>
<div class="who">${pair(PAYSLIP_LABELS.employee, locale)}</div>
</header>
<div class="meta">${meta}</div>
<table>
<caption>${pair(PAYSLIP_LABELS.earnings, locale)}</caption>
<thead><tr><th scope="col">${pair(PAYSLIP_LABELS.earnings, locale)}</th><th scope="col" class="amount">${pair(PAYSLIP_LABELS.amount, locale)} ${bdi(CURRENCY_CODE, 'ltr')}</th></tr></thead>
<tbody>${figures}</tbody>
</table>
<section class="provenance">
<div class="caption">${pair(PAYSLIP_LABELS.howItWasWorkedOut, locale)}</div>
${provenance}
</section>
<footer>
<div>${pair(PAYSLIP_LABELS.notATaxInvoice, locale)}</div>
<div>${pair(PAYSLIP_LABELS.queries, locale)}</div>
</footer>
</body>
</html>`
}
